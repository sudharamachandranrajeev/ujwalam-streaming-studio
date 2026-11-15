// SPDX-License-Identifier: GPL-3.0-or-later
// Go live chooser routes (D389, track A). Contract: docs/plan/2026-11-15-go-live-chooser.md sections 1 and 2. No flag.
//
//   GET  /ui/api/youtube/golive/options[?refresh=1]
//        -> { signedIn, outputs: [{ id, label, orientation, on, sizes: [{ size, key, bitrateKbps }], size }],
//             existing: [{ id, title, lifeCycle, when, boundToOther }], past: [{ id, title, when }], last: { <output>: { id, title, when } | null },
//             choice: { mode, outputs } | null, setupInUse, autoEvent }
//   POST /ui/api/youtube/golive/prepare { mode, outputs: { <output>: { size?, broadcastId?, templateId?, fields? } } }
//        -> { ok, appliesAt: 'now'|'next-go-live'|'next-start'|'not-used'|'unchanged', missingKeys: ['<output> <size>'], ready, detail? }
//   POST /ui/api/youtube/golive/suggest { output?, hint? } -> { title, description, tags, source: 'local-model'|'smart-fill' }
// Errors: { error: <code>, message: <plain sentence> }.
//
// Nothing on YouTube is written here: prepare only saves the choice (youtube-events.json) and the quality (the shared
// saveSetup path in youtube-quality.mjs); the Go live hook in server.mjs makes or binds the events on the Go live click.
// Quota: options costs 4 units (liveBroadcasts.list upcoming, active, completed; liveStreams.list) per refresh, cached
// 60 s; suggest may cost 3 (the past list, when not cached) + 2 (the last stream's text for a smart fill).
//
// "Help me write it": a local model only, through an OpenAI-compatible server on 127.0.0.1 / localhost / ::1 (LM Studio's
// local server by default; <dataDir>/ai-writer.json { url, model } may change the address or model, never to another
// host). Refused while anything is live or recording (6 GB VRAM, D1). The request carries only: the game name from the
// profile, the user's last 5 stream titles, the date and the user's hint. Never chat text, viewer names or memory.
// UNVERIFIED: that every LM Studio version honours `ttl` (unload the model soon after); that it serves the loaded model
// when no model name is given.
// Logs: counts and codes only, never a title, a hint, a key or a token.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ERROR_TEXT } from '../platform-connect/index.mjs';
import { ID_RE, MODES, cleanDescription, cleanFields, cleanTags, cleanTitle, readAutoEvent, readChoices, readMode, writeChoices } from '../platform-connect/youtube-events.mjs';
import { readThumbnailFile } from '../platform-connect/youtube-control.mjs';
import { OUTPUT_IDS } from './youtube-quality.mjs';

export const GOLIVE_ROUTES = Object.freeze(['/ui/api/youtube/golive/options', '/ui/api/youtube/golive/prepare', '/ui/api/youtube/golive/suggest']);
export const AI_WRITER_FILE = 'ai-writer.json';
export const DEFAULT_AI_URL = 'http://127.0.0.1:1234/v1/chat/completions';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const OPTIONS_CACHE_MS = 60_000;
const AI_TIMEOUT_MS = 20_000;
const AI_TTL_S = 300;
const MAX_PAST = 15;
const MAX_TAGS = 15;
const IDLE = ['idle', 'stopped', 'failed'];
const OUTPUT_RE = /^[a-z0-9-]{1,32}$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const only = (o, keys) => isPlain(o) && Object.keys(o).every((k) => keys.includes(k));

const STATUS = {
  'youtube-unauthorized': 401, 'oauth-reauth-needed': 401, 'youtube-not-signed-in': 401, 'youtube-quota': 429,
  'youtube-live-not-enabled': 409, 'oauth-no-client': 409, 'youtube-events-off': 404,
};
const TEXT = {
  'bad-params': 'That request was not understood.',
  'bad-mode': 'Pick one of the four ways to go live.',
  'unknown-output': 'That YouTube output is not set up; add it in Settings > Stream.',
  'bad-size': 'That quality is not offered for this output.',
  'need-event': 'Pick one of your events for each YouTube output.',
  'need-template': 'Pick a past stream for each YouTube output.',
  'need-fields': 'Give each YouTube output a title (1 to 100 characters, without < or >).',
  'bad-fields': 'One of the details is not valid: the title is 1 to 100 characters, the description at most 5000, and neither may contain < or >.',
  'same-event': 'One YouTube event can go live on one output only. Pick a different event for YouTube landscape and YouTube portrait.',
  'setup-unreadable': 'The stream settings file could not be read, so the quality was not changed.',
  'youtube-output-missing': 'Settings > Stream has no YouTube output for this; add it there first.',
  refused: 'The stream settings were refused, so the quality was not changed.',
  'output-busy': 'Help me write it is not available while a stream or recording runs: the graphics card memory is kept for the stream. Try it again after the stream.',
  'state-unknown': 'Help me write it could not check whether a stream or recording runs, so it did not start. Try again in a moment.',
  'ai-not-local': 'Help me write it only talks to a model on this PC (127.0.0.1, localhost or ::1). Change the address in ai-writer.json in the data folder.',
  'bad-hint': 'The hint is at most 200 characters of plain text.',
};

/** A model's title made plain: no control characters, no < or >, at most 100 characters; null when nothing is left. */
function plainTitle(v) {
  if (typeof v !== 'string') return null;
  return cleanTitle(v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100).trim());
}
function plainDescription(v) {
  if (typeof v !== 'string') return '';
  const d = v.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').replace(/[<>]/g, '').trim().slice(0, 5000);
  return d ? (cleanDescription(d) ?? '') : '';
}
function plainTags(v) {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out = []; let total = 0;
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const x = t.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[<>#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
    if (!x || out.some((o) => o.toLowerCase() === x.toLowerCase())) continue;
    if (total + x.length > 500 || out.length >= MAX_TAGS) break;
    out.push(x); total += x.length;
  }
  return out.length ? (cleanTags(out) ?? []) : [];
}
/** The JSON object in a model's answer (it may wrap it in prose or a code fence), or null. */
function jsonIn(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(text.slice(a, b + 1)); return isPlain(j) ? j : null; } catch { return null; }
}

/**
 * The smart fill (no model): the last stream's title with today's date and the next stream number, its description and
 * its tags. Exported for tests.
 */
export function smartFill({ last, game, date }) {
  let title = null;
  if (last?.title) {
    let t = last.title.replace(/\b\d{4}-\d{2}-\d{2}\b/g, date);
    t = t.replace(/(#\s*|\b(?:stream|day|ep|episode|part)\s*#?\s*)(\d{1,5})\b/i, (m, pre, n) => `${pre}${Number(n) + 1}`);
    title = plainTitle(t);
  }
  title ??= plainTitle(`${game ? `${game} ` : ''}live ${date}`) ?? `Live ${date}`;
  return { title, description: plainDescription(last?.description ?? ''), tags: plainTags(last?.tags ?? []) };
}

/**
 * deps: { dataDir, json(res, status, body), log(msg), quality: createYoutubeQuality(...), ytOutputs() -> plan rows
 *         [{ id, label, canvas, quality, keyRef }], signedIn() -> Promise<boolean>, events() -> youtube-events service,
 *         outputsStatus() -> Promise<{ sinks }>, gameName?() -> string|null, aiFetch?, aiTimeoutMs?, now? }
 */
export function createGoLiveRoutes(deps) {
  const { dataDir, json } = deps;
  const q = deps.quality;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  let cache = null; // { at, value: { existing, past, last } }

  const fail = (res, status, code, extra = {}) => json(res, status, { error: code, message: TEXT[code] ?? ERROR_TEXT[code] ?? 'Not done.', ...extra });
  const failYt = (res, e) => {
    const code = typeof e?.code === 'string' ? e.code : 'youtube-api-failed';
    return json(res, STATUS[code] ?? 502, { error: code, message: ERROR_TEXT[code] ?? 'YouTube did not answer as expected; try again later.' });
  };
  const signedIn = async () => { try { return (await deps.signedIn()) === true; } catch { return false; } };
  const keyRefOf = (rowId) => `Ujwalam/stream/${rowId}`;

  // The YouTube outputs the chooser shows: one per canvas that has a YouTube output in the setup or the live plan.
  function outputsNow() {
    const r = q.loadSetup();
    const setup = r?.setup ?? null;
    const inUse = q.inUse();
    let plan = [];
    try { plan = deps.ytOutputs(); } catch { plan = []; }
    const list = [];
    for (const logical of OUTPUT_IDS) {
      const canvas = logical === 'youtube-v' ? 'V' : 'H';
      const t = setup ? q.targetOf(setup, logical) : null;
      const p = plan.find((o) => o.canvas === canvas && o.id === (t?.id ?? logical)) ?? plan.find((o) => o.canvas === canvas) ?? null;
      if (!(inUse ? t : (p ?? null))) continue;
      const id = (inUse ? t?.id : p?.id) ?? logical;
      const size = (inUse ? q.currentSize(setup, logical) : p?.quality) ?? q.currentSize(setup, logical) ?? q.sizes[logical][0]?.id ?? null;
      list.push({ logical, id, on: inUse ? t.enabled === true : true, size, setup });
    }
    return { list, setup, inUse };
  }

  async function youtubePart(outs, refresh) {
    if (!refresh && cache && now() - cache.at < OPTIONS_CACHE_MS) return cache.value;
    const svc = deps.events();
    const lists = await svc.chooserLists();
    // Every stored YouTube key slot (presence only), matched once against the channel's streams.
    const rows = await q.presence();
    const refs = new Map(); // output id -> keyRef of its current size
    const all = [];
    for (const o of outs) {
      for (const s of q.sizes[o.logical]) {
        if (!q.hasKey(rows, o.setup, o.logical, s.id)) continue;
        const ref = keyRefOf(q.rowIdOf(o.id, s));
        all.push(ref);
        if (s.id === o.size) refs.set(o.id, ref);
      }
    }
    let ids = new Map();
    try { ids = await svc.streamIdsFor(all); } catch (e) { if (['youtube-unauthorized', 'youtube-quota', 'oauth-reauth-needed'].includes(e?.code)) throw e; ids = new Map(); }
    const ours = new Set([...ids.values()].filter(Boolean));
    const LIVE_NOW = new Set(['live', 'liveStarting', 'testing', 'testStarting']);
    const existing = lists.existing.map((b) => ({ id: b.id, title: b.title, lifeCycle: b.lifeCycle, when: b.when, boundToOther: LIVE_NOW.has(b.lifeCycle) && !!b.boundStreamId && !ours.has(b.boundStreamId) }));
    const past = lists.past.slice(0, MAX_PAST).map((b) => ({ id: b.id, title: b.title, when: b.when }));
    const last = {};
    for (const o of outs) {
      const sid = ids.get(refs.get(o.id)) ?? null;
      const b = (sid && lists.past.find((x) => x.boundStreamId === sid)) || lists.past[0] || null;
      last[o.id] = b ? { id: b.id, title: b.title, when: b.when } : null;
    }
    const value = { existing, past, last };
    cache = { at: now(), value };
    return value;
  }
  function savedChoice() {
    const outputs = readChoices(dataDir);
    return Object.keys(outputs).length ? { mode: readMode(dataDir), outputs } : null;
  }

  async function options(res, url) {
    const keys = [...url.searchParams.keys()];
    if (!keys.every((k) => k === 'refresh') || keys.length > 1 || !['0', '1', null].includes(url.searchParams.get('refresh'))) return fail(res, 400, 'bad-params');
    const { list, setup, inUse } = outputsNow();
    const rows = await q.presence();
    const outputs = list.map((o) => ({
      id: o.id, label: o.logical === 'youtube-v' ? 'YouTube portrait' : 'YouTube landscape', orientation: o.logical === 'youtube-v' ? 'portrait' : 'landscape', on: o.on,
      sizes: q.sizes[o.logical].map((s) => ({ size: s.id, key: q.hasKey(rows, setup, o.logical, s.id), bitrateKbps: q.limits[o.logical][s.id].default })),
      size: o.size,
    }));
    const isIn = await signedIn();
    let yt = { existing: [], past: [], last: Object.fromEntries(outputs.map((o) => [o.id, null])) };
    if (isIn) {
      try { yt = await youtubePart(list, url.searchParams.get('refresh') === '1'); } catch (e) { return failYt(res, e); }
    }
    return json(res, 200, { signedIn: isIn, outputs, existing: yt.existing, past: yt.past, last: yt.last, choice: savedChoice(), setupInUse: inUse, autoEvent: readAutoEvent(dataDir) });
  }

  async function prepare(res, body) {
    if (!only(body, ['mode', 'outputs']) || !isPlain(body.outputs)) return fail(res, 400, 'bad-params');
    if (!MODES.includes(body.mode)) return fail(res, 400, 'bad-mode');
    const { list, setup, inUse } = outputsNow();
    const names = Object.keys(body.outputs);
    if (!names.length) return fail(res, 400, 'bad-params');
    const picked = [];
    for (const name of names) {
      const o = list.find((x) => x.id === name);
      if (!OUTPUT_RE.test(name) || !o) return fail(res, 404, 'unknown-output');
      const w = body.outputs[name];
      if (!only(w, ['size', 'broadcastId', 'templateId', 'fields'])) return fail(res, 400, 'bad-params');
      if (w.size !== undefined && !(typeof w.size === 'string' && q.sizeOf(o.logical, w.size))) return fail(res, 400, 'bad-size');
      for (const k of ['broadcastId', 'templateId']) if (w[k] !== undefined && !(typeof w[k] === 'string' && ID_RE.test(w[k]))) return fail(res, 400, 'bad-params');
      let fields;
      if (w.fields !== undefined) {
        fields = cleanFields(w.fields);
        if (!fields) return fail(res, 400, 'bad-fields');
        if (fields.thumbnail) { try { await readThumbnailFile(fields.thumbnail); } catch { return fail(res, 400, 'youtube-bad-thumbnail'); } }
      }
      if (body.mode === 'existing' && !w.broadcastId) return fail(res, 400, 'need-event');
      if (body.mode === 'copy' && !w.templateId) return fail(res, 400, 'need-template');
      if (body.mode === 'new' && !fields) return fail(res, 400, 'need-fields');
      picked.push({ o, w, fields });
    }
    if (body.mode === 'existing' && new Set(picked.map((p) => p.w.broadcastId)).size !== picked.length) return fail(res, 400, 'same-event');

    // The quality: only an output whose size changes is touched (its bitrate becomes the platform default for that size).
    const wants = {};
    for (const p of picked) {
      if (p.w.size && p.w.size !== q.currentSize(setup, p.o.logical)) wants[p.o.logical] = { size: p.w.size, bitrateKbps: q.limits[p.o.logical][p.w.size].default };
    }
    let appliesAt = 'unchanged'; let detail = null; let used = false;
    if (Object.keys(wants).length) {
      const a = await q.apply(wants);
      if (a.error === 'shared-rung') return json(res, 409, { error: 'shared-rung', message: `${a.name} streams from the same encoder as YouTube, so changing the YouTube quality would change ${a.name} too. Give ${a.name} its own size in Settings > Stream (Edit output), or keep the current quality.` });
      if (a.error === 'refused') return fail(res, 422, 'refused', { problems: a.problems });
      if (a.error) return fail(res, 409, a.error);
      if (!a.used) {
        appliesAt = 'not-used';
        detail = 'The quality was not changed, because Settings > Stream is off: Go live streams at the current size. Turn on Settings > Stream to pick the quality here.';
      } else {
        used = true;
        appliesAt = a.saved.appliesAt;
        if (!a.saved.applied && a.saved.detail) detail = a.saved.detail;
      }
    }

    // The choice (merged: other outputs and the other modes' picks are kept as the next pre-selection). The chooser's
    // click turns "New YouTube event at every Go live" on: the user just picked the event to go live with.
    const titleOf = (id) => cache?.value.existing.find((b) => b.id === id)?.title ?? cache?.value.past.find((b) => b.id === id)?.title ?? '';
    const choices = readChoices(dataDir);
    for (const p of picked) {
      const prev = choices[p.o.id] ?? {};
      const next = { ...prev };
      if (p.w.size) next.size = p.w.size;
      if (p.w.broadcastId) { next.broadcastId = p.w.broadcastId; next.broadcastTitle = titleOf(p.w.broadcastId); }
      if (p.w.templateId && p.w.templateId !== prev.templateId) {
        for (const k of ['description', 'privacy', 'tags', 'categoryId']) delete next[k];
        Object.assign(next, { templateId: p.w.templateId, templateTitle: titleOf(p.w.templateId), title: null });
      }
      if (p.fields) next.fields = p.fields;
      choices[p.o.id] = next;
    }
    writeChoices(dataDir, choices, { mode: body.mode, autoEvent: true });

    // Keys: the size each switched-on output will stream at (the picked one when applied, else the current one).
    const rows = await q.presence();
    const base = used ? (q.loadSetup()?.setup ?? setup) : setup;
    const missingKeys = [];
    for (const p of picked) {
      if (!p.o.on) continue;
      const size = used && wants[p.o.logical] ? p.w.size : (p.o.size ?? p.w.size);
      if (size && !q.hasKey(rows, base, p.o.logical, size)) missingKeys.push(`${p.o.id} ${size}`);
    }
    log(`[studio-ui] golive: prepared (${body.mode}, ${picked.length} output(s), ${appliesAt}, ${missingKeys.length} key(s) missing)`);
    return json(res, 200, { ok: true, appliesAt, missingKeys, ready: missingKeys.length === 0, ...(detail ? { detail } : {}) });
  }

  // ---- "Help me write it" ----
  function writerConfig() {
    let cfg = {};
    try { const j = JSON.parse(readFileSync(path.join(dataDir, AI_WRITER_FILE), 'utf8')); cfg = isPlain(j) ? j : {}; } catch { cfg = {}; }
    const url = typeof cfg.url === 'string' && cfg.url ? cfg.url : DEFAULT_AI_URL;
    const model = typeof cfg.model === 'string' && /^[\w.:/@-]{1,200}$/.test(cfg.model) ? cfg.model : null;
    let u = null;
    try { u = new URL(url); } catch { u = null; }
    const local = !!u && (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
    return { url: local ? u.href : null, model };
  }
  async function busyNow() {
    let st;
    try { st = await deps.outputsStatus(); } catch { return 'state-unknown'; }
    if (!Array.isArray(st?.sinks)) return 'state-unknown';
    return st.sinks.some((s) => !s || s.active === true || !IDLE.includes(s.state)) ? 'output-busy' : null;
  }
  async function pastNow() {
    if (!(await signedIn())) return { titles: [], lastId: null, svc: null };
    const svc = deps.events();
    let past = cache?.value.past ?? null;
    if (!past) {
      try { const l = await svc.chooserLists(); past = l.past.map((b) => ({ id: b.id, title: b.title, when: b.when })); } catch { past = []; }
    }
    return { titles: past.slice(0, 5).map((b) => b.title).filter(Boolean), past, svc };
  }

  async function suggest(res, body) {
    if (!only(body, ['output', 'hint'])) return fail(res, 400, 'bad-params');
    if (body.output !== undefined && !(typeof body.output === 'string' && OUTPUT_RE.test(body.output))) return fail(res, 400, 'bad-params');
    let hint = '';
    if (body.hint !== undefined) {
      if (typeof body.hint !== 'string' || /[\x00-\x1f\x7f<>]/.test(body.hint) || body.hint.trim().length > 200) return fail(res, 400, 'bad-hint');
      hint = body.hint.trim();
    }
    const busy = await busyNow();
    if (busy) return fail(res, 409, busy);
    const cfg = writerConfig();
    if (!cfg.url) return fail(res, 409, 'ai-not-local');
    const date = new Date(now()).toISOString().slice(0, 10);
    let game = null;
    try { const g = deps.gameName?.(); game = typeof g === 'string' && g.trim() ? g.trim().slice(0, 80) : null; } catch { game = null; }
    const p = await pastNow();

    let out = null;
    try {
      const user = [
        game ? `Game: ${game}` : null,
        p.titles.length ? `My last stream titles (newest first):\n${p.titles.map((t) => `- ${t}`).join('\n')}` : null,
        `Date: ${date}`,
        hint ? `What this stream is about: ${hint}` : null,
      ].filter(Boolean).join('\n');
      const reqBody = {
        ...(cfg.model ? { model: cfg.model } : {}),
        messages: [
          { role: 'system', content: 'You write YouTube live stream details for a gaming streamer. Answer with one JSON object only: {"title": string of at most 90 characters, "description": string of at most 600 characters, "tags": array of at most 15 short strings}. Plain text, no HTML, no < or >, no emoji.' },
          { role: 'user', content: user },
        ],
        temperature: 0.7, max_tokens: 700, stream: false,
        ttl: AI_TTL_S, // LM Studio: unload the model soon after (UNVERIFIED for every version)
      };
      const r = await (deps.aiFetch ?? globalThis.fetch)(cfg.url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), redirect: 'error', signal: AbortSignal.timeout(deps.aiTimeoutMs ?? AI_TIMEOUT_MS),
      });
      if (r.status === 200) {
        const j = jsonIn((await r.json())?.choices?.[0]?.message?.content);
        const title = plainTitle(j?.title);
        if (title) out = { title, description: plainDescription(j.description), tags: plainTags(j.tags), source: 'local-model' };
      } else { try { await r.text(); } catch { /* body not used */ } }
    } catch { out = null; }

    if (!out) {
      let last = null;
      const lastId = (body.output && cache?.value.last?.[body.output]?.id) || p.past?.[0]?.id || null;
      if (p.svc && lastId) { try { last = await p.svc.broadcastText(lastId); } catch { last = null; } }
      out = { ...smartFill({ last, game, date }), source: 'smart-fill' };
    }
    log(`[studio-ui] golive: suggestion (${out.source}, ${out.tags.length} tag(s))`);
    return json(res, 200, out);
  }

  /** -> true when the route is one of GOLIVE_ROUTES (answered), else false. */
  async function handle(method, route, body, res, url) {
    if (!GOLIVE_ROUTES.includes(route)) return false;
    if (typeof dataDir !== 'string') return json(res, 404, { error: 'youtube-events-off', message: ERROR_TEXT['youtube-events-off'] }), true;
    const isGet = route === '/ui/api/youtube/golive/options';
    if ((method === 'GET') !== isGet) return json(res, 405, { error: 'method-not-allowed' }), true;
    try {
      if (isGet) await options(res, url);
      else if (route === '/ui/api/youtube/golive/prepare') await prepare(res, body);
      else await suggest(res, body);
    } catch (e) { failYt(res, e); }
    return true;
  }

  return { handle, _clearCache: () => { cache = null; } };
}
