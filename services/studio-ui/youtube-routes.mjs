// SPDX-License-Identifier: GPL-3.0-or-later
// In-app YouTube control routes (D388 part B), JSON over the local UI API. No feature flag.
// Contract: docs/plan/2026-11-15-youtube-control.md. Service: services/platform-connect/youtube-control.mjs.
//
// Every body / query is checked against an allow-list of keys; ids match ID_RE. Errors are { error: <code>, message }.
// Chat text and author names pass through the response only: this module logs counts and codes, never text, titles or names.
// End and Delete of the current event of an output that may be streaming are refused ('output-live', 409): the output
// must be listed with a known stopped state in a fresh outputs status (unknown = refuse, same rule as the D386 cleanup).

import { ERROR_TEXT } from '../platform-connect/index.mjs';
import { ID_RE, cleanCategoryId, cleanDescription, cleanPrivacy, cleanTags, cleanTitle } from '../platform-connect/youtube-events.mjs';
import { clearLive, readLive } from '../platform-connect/youtube-control.mjs';

export const GET_ROUTES = Object.freeze(['/ui/api/youtube/account', '/ui/api/youtube/live', '/ui/api/youtube/categories', '/ui/api/youtube/chat', '/ui/api/youtube/broadcasts']);
export const POST_ROUTES = Object.freeze(['/ui/api/youtube/signin', '/ui/api/youtube/details', '/ui/api/youtube/thumbnail', '/ui/api/youtube/chat/send', '/ui/api/youtube/broadcast/end', '/ui/api/youtube/broadcast/delete']);

const STATUS = {
  'youtube-unauthorized': 401, 'oauth-reauth-needed': 401, 'youtube-not-signed-in': 401,
  'oauth-no-client': 409, 'youtube-live-not-enabled': 409, 'youtube-chat-unavailable': 409, 'output-live': 409, 'live-unknown': 409, 'output-starting': 409, 'sign-in-busy': 409,
  'youtube-quota': 429, 'unknown-output': 404, 'unknown-broadcast': 404, 'youtube-events-off': 404,
  'bad-params': 400, 'youtube-bad-title': 400, 'youtube-bad-thumbnail': 400, 'youtube-bad-choice': 400, 'sign-in-not-offered': 400,
};
const IDLE = ['idle', 'stopped', 'failed'];
const IDLE_GRACE_MS = 120_000; // an entry is dropped for an idle output only after this long (a start may still be on its way)
const ENDED = new Set(['complete', 'revoked']);
const OUTPUT_RE = /^[a-z0-9-]{1,32}$/;
const only = (obj, keys) => !!obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every((k) => keys.includes(k));

/**
 * deps: { dataDir, json(res, code, obj), text(res, code, msg), control() -> service, connect() -> platform-connect service,
 *         signedIn() -> Promise<boolean>, ytOutputs() -> [{ id, label, ... }], outputsStatus() -> Promise<{ sinks }>,
 *         now(), log(msg) }
 */
export function createYoutubeRoutes(deps) {
  const { dataDir, json, text } = deps;
  const now = deps.now ?? Date.now;
  let signinJob = null;

  const fail = (res, e, message) => {
    const code = typeof e?.code === 'string' ? e.code : 'youtube-api-failed';
    return json(res, STATUS[code] ?? 502, { error: code, message: message ?? ERROR_TEXT[code] ?? 'Not done.' });
  };
  const bad = (res) => json(res, 400, { error: 'bad-params', message: ERROR_TEXT['bad-params'] });
  const needSignIn = async () => { if ((await deps.signedIn()) !== true) throw Object.assign(new Error('youtube-not-signed-in'), { code: 'youtube-not-signed-in' }); };
  const surelyIdle = (sinks, id) => Array.isArray(sinks)
    && sinks.some((s) => s && s.id === id && s.active !== true && IDLE.includes(s.state))
    && !sinks.some((s) => s && s.id === id && (s.active === true || !IDLE.includes(s.state)));
  async function sinksNow() { try { const st = await deps.outputsStatus(); return Array.isArray(st?.sinks) ? st.sinks : null; } catch { return null; } }
  // The live entries of the outputs the plan has (label from the plan).
  function entries() {
    const live = readLive(dataDir);
    return deps.ytOutputs().filter((o) => live[o.id]).map((o) => ({ output: o.id, label: o.label, broadcastId: live[o.id].broadcastId, title: live[o.id].title, madeAt: live[o.id].madeAt }));
  }
  const entryFor = (output) => entries().find((e) => e.output === output) ?? null;

  async function account(res) {
    let signedIn = false;
    try { signedIn = (await deps.signedIn()) === true; } catch { signedIn = false; }
    let channelTitle = null;
    if (signedIn) {
      try { channelTitle = (await deps.control().account()).channelTitle; } catch (e) { if (e?.code === 'youtube-unauthorized' || e?.code === 'oauth-reauth-needed') signedIn = false; }
    }
    let canSignIn = signedIn;
    if (!signedIn) { try { canSignIn = (await deps.connect().status()).accounts?.youtube?.clientSet === true; } catch { canSignIn = false; } }
    return json(res, 200, { signedIn, canSignIn, channelTitle });
  }

  // The existing platform-connect YouTube sign-in (same client, same scope), started for the first YouTube output that is
  // not streaming. The browser opens from there; the answer is the job's id and state.
  async function signin(res, body) {
    if (!only(body, [])) return bad(res);
    const c = deps.connect();
    const outs = deps.ytOutputs();
    if (!outs.length) return fail(res, { code: 'unknown-output' });
    let last = null;
    for (const o of outs) {
      try {
        const job = await c.startSignIn('youtube', o.id);
        signinJob = job?.id ?? null;
        return json(res, 200, { started: true, job: { id: job?.id ?? null, state: job?.state ?? null } });
      } catch (e) { last = e; if (e?.code !== 'output-live' && e?.code !== 'live-unknown') break; }
    }
    return fail(res, last);
  }

  async function live(res, url) {
    if (![...url.searchParams.keys()].every((k) => k === 'refresh') || !['0', '1', null].includes(url.searchParams.get('refresh'))) return bad(res);
    const list = entries();
    if (!list.length) return json(res, 200, { at: new Date(now()).toISOString(), outputs: [] });
    await needSignIn();
    const st = await deps.control().liveStatus(list, { refresh: url.searchParams.get('refresh') === '1' });
    // Dropped: events that are complete (or gone), and events of an output that a fresh status shows stopped long enough ago.
    const ended = new Set(st.outputs.filter((o) => ENDED.has(o.lifeCycle)).map((o) => o.broadcastId));
    for (const g of st.gone) ended.add(g);
    const sinks = list.some((e) => !ended.has(e.broadcastId)) ? await sinksNow() : null;
    const stale = new Set(list.filter((e) => surelyIdle(sinks, e.output) && now() - (Date.parse(e.madeAt) || 0) > IDLE_GRACE_MS).map((e) => e.output));
    const dropped = clearLive(dataDir, (k, v) => ended.has(v.broadcastId) || stale.has(k));
    if (dropped.length) deps.log(`[studio-ui] youtube: ${dropped.length} finished event(s) dropped from the current list`);
    return json(res, 200, { at: st.at, outputs: st.outputs });
  }

  async function details(res, body) {
    if (!only(body, ['broadcastId', 'title', 'description', 'privacy', 'tags', 'categoryId']) || typeof body.broadcastId !== 'string' || !ID_RE.test(body.broadcastId)) return bad(res);
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 400)) return bad(res);
    if (body.title !== undefined && !cleanTitle(body.title)) return fail(res, { code: 'youtube-bad-title' });
    if (body.description !== undefined && !(typeof body.description === 'string' && (body.description === '' || cleanDescription(body.description)))) return bad(res);
    if (body.privacy !== undefined && !cleanPrivacy(body.privacy)) return bad(res);
    if (body.tags !== undefined && !(Array.isArray(body.tags) && (body.tags.length === 0 || cleanTags(body.tags)))) return bad(res);
    if (body.categoryId !== undefined && !cleanCategoryId(body.categoryId)) return bad(res);
    if (Object.keys(body).length < 2) return bad(res);
    await needSignIn();
    const r = await deps.control().updateDetails(body);
    deps.log(`[studio-ui] youtube: event details saved, ${r.warnings.length} warning(s)`);
    return json(res, 200, { ok: true, warnings: r.warnings });
  }

  async function thumbnail(res, body) {
    if (!only(body, ['broadcastId', 'path']) || typeof body.broadcastId !== 'string' || !ID_RE.test(body.broadcastId) || typeof body.path !== 'string' || !body.path || body.path.length > 1024) return bad(res);
    await needSignIn();
    await deps.control().setThumbnail({ broadcastId: body.broadcastId, path: body.path });
    deps.log('[studio-ui] youtube: thumbnail set');
    return json(res, 200, { ok: true });
  }

  async function categories(res) {
    await needSignIn();
    return json(res, 200, { categories: await deps.control().categories() });
  }

  async function chat(res, url) {
    const keys = [...url.searchParams.keys()];
    const output = url.searchParams.get('output');
    const after = url.searchParams.get('after');
    if (!keys.every((k) => k === 'output' || k === 'after') || keys.length !== new Set(keys).size || !output || !OUTPUT_RE.test(output) || (after !== null && !/^[0-9]{1,12}$/.test(after))) return bad(res);
    await needSignIn();
    const e = entryFor(output);
    if (!e) return json(res, 200, { messages: [], cursor: after ?? '0', live: false });
    return json(res, 200, await deps.control().chatRead({ output, broadcastId: e.broadcastId, after: after === null ? 0 : Number(after) }));
  }

  async function chatSend(res, body) {
    if (!only(body, ['output', 'text']) || typeof body.output !== 'string' || !OUTPUT_RE.test(body.output) || typeof body.text !== 'string' || body.text.length > 400) return bad(res);
    const t = body.text.trim();
    if (!t || t.length > 200 || /[\x00-\x1f\x7f]/.test(t)) return bad(res);
    await needSignIn();
    const e = entryFor(body.output);
    if (!e) return fail(res, { code: 'youtube-chat-unavailable' });
    await deps.control().chatSend({ broadcastId: e.broadcastId, text: t });
    deps.log('[studio-ui] youtube: chat message sent');
    return json(res, 200, { ok: true });
  }

  async function broadcasts(res, url) {
    const keys = [...url.searchParams.keys()];
    const status = url.searchParams.get('status') ?? 'all';
    const page = url.searchParams.get('page');
    const refresh = url.searchParams.get('refresh');
    if (!keys.every((k) => ['status', 'page', 'refresh'].includes(k)) || keys.length !== new Set(keys).size || !['all', 'upcoming', 'active', 'completed'].includes(status)
      || (page !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(page)) || !['0', '1', null].includes(refresh)) return bad(res);
    await needSignIn();
    const r = await deps.control().listBroadcasts({ status, page, refresh: refresh === '1' });
    const current = new Set(Object.values(readLive(dataDir)).map((v) => v.broadcastId));
    return json(res, 200, { items: r.items.map((i) => ({ ...i, current: current.has(i.id) })), next: r.next });
  }

  // End / Delete: refused while the event is the current one of an output that is not shown stopped.
  async function endOrDelete(res, body, verb) {
    if (!only(body, ['id']) || typeof body.id !== 'string' || !ID_RE.test(body.id)) return bad(res);
    await needSignIn();
    const mine = Object.entries(readLive(dataDir)).filter(([, v]) => v.broadcastId === body.id);
    if (mine.length) {
      const sinks = await sinksNow();
      if (!mine.every(([k]) => surelyIdle(sinks, k))) return fail(res, { code: 'output-live' }, 'This event belongs to a stream that is on air (or its state is not clear). End the stream instead.');
    }
    if (verb === 'end') await deps.control().endBroadcast(body.id); else await deps.control().deleteBroadcast(body.id);
    if (mine.length) clearLive(dataDir, (k, v) => v.broadcastId === body.id);
    deps.log(`[studio-ui] youtube: event ${verb === 'end' ? 'ended' : 'deleted'}`);
    return json(res, 200, { ok: true });
  }

  /** route: one of GET_ROUTES / POST_ROUTES. body: the parsed JSON object of a POST, null for a GET. */
  async function handle(req, res, route, body, url) {
    if (typeof dataDir !== 'string') return json(res, 404, { error: 'youtube-events-off' });
    const isGet = GET_ROUTES.includes(route);
    if ((req.method === 'GET') !== isGet) return text(res, 405, 'method-not-allowed');
    try {
      switch (route) {
        case '/ui/api/youtube/account': return await account(res);
        case '/ui/api/youtube/signin': return await signin(res, body);
        case '/ui/api/youtube/live': return await live(res, url);
        case '/ui/api/youtube/details': return await details(res, body);
        case '/ui/api/youtube/thumbnail': return await thumbnail(res, body);
        case '/ui/api/youtube/categories': return await categories(res);
        case '/ui/api/youtube/chat': return await chat(res, url);
        case '/ui/api/youtube/chat/send': return await chatSend(res, body);
        case '/ui/api/youtube/broadcasts': return await broadcasts(res, url);
        case '/ui/api/youtube/broadcast/end': return await endOrDelete(res, body, 'end');
        case '/ui/api/youtube/broadcast/delete': return await endOrDelete(res, body, 'delete');
        default: return text(res, 404, 'not-found');
      }
    } catch (e) { return fail(res, e); }
  }

  return { handle, owns: (route) => GET_ROUTES.includes(route) || POST_ROUTES.includes(route), _signinJob: () => signinJob };
}
