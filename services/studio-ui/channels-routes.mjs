// SPDX-License-Identifier: GPL-3.0-or-later
// YM6: Settings > Posting & growth > YouTube channels (plan docs/plan/2026-11-25-youtube-multi-account.md). Routes (studio UI
// server; POSTs pass its Origin + CSRF checks first):
//   GET  /ui/api/posts/channels         -> { channels: [row], adding, lastError, limits: { postsPerDayLimit, maxChannels } }
//        row: { id, label, main, enabled, signedIn, title, postsPerDay, shortsOnly, doneToday, todayCap, waiting, nextAt,
//               paused: { until, reason } | null, statusText }
//   POST /ui/api/posts/channels/add     { label? } -> opens Google sign-in in the browser (202); the answer comes later (GET).
//        After sign-in the channel is read (channels.list mine=true, 1 quota unit, counted in the shared budget); a channel
//        already in the list is refused and its new sign-in removed again.
//   POST /ui/api/posts/channels/set     { id, enabled?, min?, max?, label? } -> posting on/off, the posts-a-day range, the label
//   POST /ui/api/posts/channels/remove  { id } -> signs that channel out (its token leaves Credential Manager) and takes it off
//        the list; its videos already on YouTube stay; its clips waiting to upload go back to the pool on the chain's next pass.
// Tokens never reach the page. Each action runs on its own click (D332): no typed phrase, no "are you sure".
import path from 'node:path';
import { systemBrowserOpen } from '../platform-connect/index.mjs';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';
import { CAPTIONS_SCOPE, READONLY_SCOPE, SCOPE, ANALYTICS_SCOPE, createYoutubeAuth, joinScopes } from '../posting/oauth.mjs';
import { MAIN, ID_RE, accountOf, dayCap, doneToday, loadChannelDefaults, newChannelId, pausedNow, readAccounts, readChannelState, refreshTargetFor, updateAccounts, utcDay } from '../posting/accounts.mjs';
import { QUEUE_NAME, createUploadQueue, shownPublishAt } from '../posting/auto-chain.mjs';
import { createQuotaBudget } from '../posting/quota-budget.mjs';
import { GROWTH_FLAG } from '../analytics/index.mjs';

const API = 'https://www.googleapis.com/youtube/v3';
const PLAIN_ERR = {
  'oauth-no-client': 'The Google sign-in client is not set up yet (the same one the main channel uses).',
  'oauth-timeout': 'No answer from Google within 3 minutes; click Add channel again.',
  'oauth-denied': 'The sign-in was not allowed in the browser.',
  'oauth-state-mismatch': 'The sign-in answer did not match; click Add channel again.',
  'oauth-no-refresh-token': 'Google did not give a lasting sign-in; remove Ujwalam in your Google Account settings, then click Add channel again.',
  'channel-already-added': 'That channel is already in the list. On Google\'s page, pick the other channel (for a Brand Account, choose it in the channel list).',
  'channel-read-failed': 'Signed in, but the channel could not be read; click Add channel again.',
  'no-channel': 'That Google account has no YouTube channel yet. Make one in YouTube first.',
  'too-many': 'The list is full. Remove a channel first.',
  'channels-config-bad': 'The channel settings file (data/posting/channels.json) is not valid.',
};
export const plainError = (code) => PLAIN_ERR[code] ?? `Adding the channel failed (${String(code ?? 'error').slice(0, 40)})`;
const PAUSE_TEXT = { 'upload-limit': 'YouTube says this channel reached its upload limit for today', 'not-signed-in': 'its sign-in did not work', 'credentials-unreadable': 'its saved sign-in could not be read', 'no-oauth-client': 'the Google sign-in client is not set up' };
const clean = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');

/** opts: { dataDir, flags, authFor?(id) (test seam), browserOpen?, fetchImpl?, nowMs?, newId? } */
export function createChannelRoutes(opts) {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;
  const scope = () => joinScopes(SCOPE, CAPTIONS_SCOPE, READONLY_SCOPE, opts.flags?.isOn?.(GROWTH_FLAG) && ANALYTICS_SCOPE);
  const authFor = (id) => {
    const a = typeof opts.authFor === 'function' ? opts.authFor(id) : null;
    if (a) return a;
    return createYoutubeAuth({ refreshStore: createCredentialStore(refreshTargetFor(id)), browserOpen: opts.browserOpen ?? systemBrowserOpen, scope });
  };
  let adding = null; let lastError = null;

  /** channels.list mine=true for this sign-in: { channelId, title, handle }. 1 quota unit, counted in the shared budget. */
  async function readMine(auth) {
    const token = await auth.accessToken();
    const f = createQuotaBudget({ dataDir: opts.dataDir, nowMs }).meter(fetchImpl);
    let res;
    try { res = await f(`${API}/channels?part=snippet&mine=true`, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }); } catch { throw Object.assign(new Error('read failed'), { code: 'channel-read-failed' }); }
    let body = null; try { body = await res.json(); } catch { body = null; }
    if (!res.ok || !body) throw Object.assign(new Error('read failed'), { code: 'channel-read-failed' });
    const it = Array.isArray(body.items) ? body.items[0] : null;
    if (!it || typeof it.id !== 'string') throw Object.assign(new Error('no channel'), { code: 'no-channel' });
    return { channelId: it.id, title: clean(it.snippet?.title, 120), handle: clean(it.snippet?.customUrl, 120) };
  }

  async function addChannel(label) {
    const cfg = loadChannelDefaults();
    if (readAccounts(opts.dataDir).accounts.length >= cfg.maxChannels) throw Object.assign(new Error('full'), { code: 'too-many' });
    const id = (opts.newId ?? newChannelId)();
    const auth = authFor(id);
    await auth.signIn();
    let me;
    try { me = await readMine(auth); } catch (e) { try { await auth.signOut(); } catch { /* nothing saved to remove */ } throw e; }
    // The main channel's id is learned once (from its own sign-in) so the same channel is never added twice.
    let doc = readAccounts(opts.dataDir);
    let mainId = doc.accounts[0].channelId ?? null;
    if (!mainId) {
      try { const m = await readMine(authFor(MAIN)); mainId = m.channelId; updateAccounts(opts.dataDir, (d) => { Object.assign(d.accounts[0], m); }); } catch { /* main not signed in: nothing to compare with */ }
      doc = readAccounts(opts.dataDir);
    }
    if (doc.accounts.some((a) => a.channelId === me.channelId)) {
      try { await auth.signOut(); } catch { /* the token stays unused under a target no channel names */ }
      throw Object.assign(new Error('duplicate'), { code: 'channel-already-added' });
    }
    updateAccounts(opts.dataDir, (d) => {
      d.accounts.push({ id, label: clean(label, 40) || me.title || 'YouTube channel', enabled: true, addedAt: new Date(nowMs()).toISOString(),
        channelId: me.channelId, title: me.title, handle: me.handle, postsPerDay: { ...cfg.postsPerDay }, shortsOnly: cfg.shortsOnly });
    });
    return id;
  }

  async function view() {
    let cfg = null; try { cfg = loadChannelDefaults(); } catch { lastError ??= plainError('channels-config-bad'); }
    const t = nowMs();
    const accounts = readAccounts(opts.dataDir).accounts;
    const state = readChannelState(opts.dataDir);
    let items = []; try { items = createUploadQueue(path.join(opts.dataDir, 'posting', QUEUE_NAME)).items(); } catch { items = []; }
    const rows = [];
    for (const a of accounts) {
      let st = { signedIn: false, hasClient: false };
      try { st = await authFor(a.id).status(); } catch { /* shown as not signed in */ }
      const paused = pausedNow(state, a.id, t);
      const mine = items.filter((i) => accountOf(i) === a.id);
      const next = mine.filter((i) => i.state === 'queued' || i.state === 'done').map(shownPublishAt).filter((p) => typeof p === 'string' && Date.parse(p) > t).sort()[0] ?? null;
      const cap = dayCap(a, utcDay(t));
      const statusText = a.enabled === false ? 'Posting off'
        : !st.signedIn ? 'Not signed in'
        : paused ? `Paused until ${paused.until.slice(11, 16)} UTC: ${PAUSE_TEXT[paused.reason] ?? paused.reason}`
        : 'Signed in, posting on';
      rows.push({ id: a.id, label: a.label, main: a.id === MAIN, enabled: a.enabled !== false, signedIn: st.signedIn === true, title: a.title ?? '',
        postsPerDay: a.postsPerDay ?? null, shortsOnly: a.shortsOnly === true, doneToday: doneToday(items, a.id, t), todayCap: cap,
        waiting: mine.filter((i) => i.state === 'queued').length, nextAt: next, paused: paused ? { until: paused.until, reason: paused.reason } : null, statusText });
    }
    return { channels: rows, pool: items.filter((i) => accountOf(i) === null && i.state === 'queued').length, adding: adding !== null, lastError,
      limits: cfg ? { postsPerDayLimit: cfg.postsPerDayLimit, maxChannels: cfg.maxChannels } : null };
  }

  const bad = (res, json, code, text, status = 400) => { json(res, status, { error: code, text }); return true; };
  return {
    async handle(method, route, body, res, json) {
      if (!route.startsWith('/ui/api/posts/channels')) return false;
      if (typeof opts.dataDir !== 'string') return bad(res, json, 'no-data-dir', 'The data folder is not known.', 503);
      if (method === 'GET' && route === '/ui/api/posts/channels') { json(res, 200, await view()); return true; }
      if (method !== 'POST') return false;
      if (route === '/ui/api/posts/channels/add') {
        if (adding) { json(res, 200, await view()); return true; }
        lastError = null;
        adding = addChannel(body?.label).then(() => { lastError = null; }, (e) => { lastError = plainError(e?.code); }).finally(() => { adding = null; });
        json(res, 202, await view()); return true;
      }
      const id = typeof body?.id === 'string' ? body.id : '';
      const acct = readAccounts(opts.dataDir).accounts.find((a) => a.id === id);
      if (!acct || !(id === MAIN || ID_RE.test(id))) return bad(res, json, 'unknown-channel', 'That channel is not in the list.', 404);
      if (route === '/ui/api/posts/channels/set') {
        let cfg; try { cfg = loadChannelDefaults(); } catch { return bad(res, json, 'channels-config-bad', plainError('channels-config-bad'), 500); }
        const ch = {};
        if (body.enabled !== undefined) { if (typeof body.enabled !== 'boolean') return bad(res, json, 'bad-value', 'Posting on or off only.'); ch.enabled = body.enabled; }
        if (body.label !== undefined) { const l = clean(body.label, 40); if (!l) return bad(res, json, 'bad-value', 'Type a name for the channel.'); ch.label = l; }
        if (body.min !== undefined || body.max !== undefined) {
          if (id === MAIN) return bad(res, json, 'bad-value', 'The main channel follows Uploads per day in the Auto-post card.');
          const min = body.min ?? acct.postsPerDay?.min; const max = body.max ?? acct.postsPerDay?.max;
          if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > cfg.postsPerDayLimit || min > max) return bad(res, json, 'bad-value', `Posts a day: whole numbers from 1 to ${cfg.postsPerDayLimit}, the first not above the second.`);
          ch.postsPerDay = { min, max };
        }
        updateAccounts(opts.dataDir, (d) => { Object.assign(d.accounts.find((a) => a.id === id), ch); });
        json(res, 200, await view()); return true;
      }
      if (route === '/ui/api/posts/channels/remove') {
        if (id === MAIN) return bad(res, json, 'main-stays', 'The main channel stays in the list; switch its posting off instead.');
        try { await authFor(id).signOut(); } catch { return bad(res, json, 'signout-failed', 'The saved sign-in could not be removed; nothing was changed.', 502); }
        updateAccounts(opts.dataDir, (d) => { d.accounts = d.accounts.filter((a) => a.id !== id); });
        json(res, 200, await view()); return true;
      }
      return false;
    },
  };
}
