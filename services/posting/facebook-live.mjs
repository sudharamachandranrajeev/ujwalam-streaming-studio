// SPDX-License-Identifier: GPL-3.0-or-later
// Facebook Live to a Facebook Page (flag facebook-live; docs/plan/2026-11-27-facebook-live-ig-live-x-posting.md section 1).
// Node stdlib only (`fetch`, through the Instagram module's checked Graph request).
//
// Sign-in: the Meta Connect of Instagram posting (services/posting/instagram.mjs) asks for the Page Live permissions too
// (pages_manage_posts, pages_read_engagement, pages_show_list; data/posting/instagram.json scopes). Its long-lived user
// token (Credential Manager, Ujwalam/posting/instagram-token) lists the user's Pages (GET /me/accounts); the Page the
// user picks is saved with its Page access token as one small JSON value in Credential Manager (PAGE_TARGET). Never in
// a file, a log or argv.
// Each Go live with Facebook ticked: POST /{page-id}/live_videos (status LIVE_NOW, title, description) answers with the
// live video id and secure_stream_url. The URL is split into the server address and the key, which go to the Credential
// Manager targets the facebook sink names (Ujwalam/stream/facebook-server, Ujwalam/stream/facebook): the host reads
// them itself at start, as for every other stream. They are deleted again when the stream ends. Only the live video
// ids (not secret) are kept in <dataDir>/outputs/facebook-live-state.json, so a crash leaves a list of left-overs that
// the next start ends (POST /{live-video-id} end_live_video=true).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';
import { DEFAULT_ENDPOINTS, graphBase, graphRequest, loadIgConfig, TOKEN_TARGET } from './instagram.mjs';
import { splitStreamUrl } from '../outputs/stream-url.mjs';

export const FACEBOOK_FLAG = 'facebook-live';
export const PAGE_TARGET = 'Ujwalam/posting/facebook-page';
export const SERVER_REF = 'Ujwalam/stream/facebook-server';
export const KEY_REF = 'Ujwalam/stream/facebook';
export const STATE_NAME = 'facebook-live-state.json';
/** The permissions a Page live video needs (Live Video API streaming guide, "Broadcast on a Page", checked 2026-11-27). */
export const LIVE_SCOPES = Object.freeze(['pages_manage_posts', 'pages_read_engagement', 'pages_show_list']);
const TITLE_MAX = 254; // Graph reference, Page live_videos: "Maximum 254 characters" (checked 2026-11-27)
const DESC_MAX = 5000; // UNVERIFIED: the reference gives no limit; kept short on purpose
const ID_RE = /^\d{1,30}$/;

export class FacebookLiveError extends Error {
  constructor(code, message) { super(message); this.name = 'FacebookLiveError'; this.code = code; }
}

/** Plain words for each error code (the Go live card and the stream start refusal show them). */
export const FACEBOOK_TEXT = Object.freeze({
  'not-connected': 'Facebook is not connected. Open Settings > Posting & growth > Instagram and click Connect (it also connects Facebook).',
  'reauth-needed': 'The Facebook sign-in expired or is missing a permission. Click Connect again in Settings > Posting & growth > Instagram.',
  'no-page': 'No Facebook Page is picked for live streams yet. Pick one in the Facebook card of the Go live window.',
  'page-not-found': 'That Facebook Page is not in your sign-in any more. Pick a Page again.',
  'not-permitted': 'Facebook refused to start a live video on this Page. Click Connect again and allow the Page permissions; the Page also needs at least 100 followers and an account at least 60 days old.',
  'rate-limited': 'Facebook says too many requests. Wait a minute and try again.',
  'no-stream-url': 'Facebook made the live video but sent no stream address. Try Go live again.',
  'network-error': 'Facebook could not be reached. Check the internet connection.',
  'request-timeout': 'Facebook did not answer in time. Try again.',
});
export const facebookText = (code) => FACEBOOK_TEXT[code] ?? 'Facebook did not answer as expected. Try again later.';

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/**
 * opts: { dataDir, userTokenStore?, pageStore?, serverStore?, keyStore? (get/set/delete), fetchImpl?, endpoints?, cfg?,
 *         now?() } - every one a test seam; the defaults are Credential Manager, fetch and the real Meta hosts.
 */
export function createFacebookLive(opts = {}) {
  const userTokenStore = opts.userTokenStore ?? createCredentialStore(TOKEN_TARGET);
  const pageStore = opts.pageStore ?? createCredentialStore(PAGE_TARGET);
  const serverStore = opts.serverStore ?? createCredentialStore(SERVER_REF);
  const keyStore = opts.keyStore ?? createCredentialStore(KEY_REF);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints ?? {}) };
  const cfgOf = () => opts.cfg ?? loadIgConfig();
  const now = opts.now ?? (() => Date.now());
  const g = () => graphBase(endpoints, cfgOf());
  const call = async (method, url, params) => {
    try { return await graphRequest(fetchImpl, method, url, { params }); } catch (e) {
      const code = ['reauth-needed', 'rate-limited', 'not-permitted', 'network-error', 'request-timeout'].includes(e?.code) ? e.code : 'graph-error';
      const err = new FacebookLiveError(code, facebookText(code));
      err.status = e?.status; err.metaCode = e?.metaCode;
      throw err;
    }
  };

  // ---- left-over bookkeeping: live video ids only (not secret) ----
  const stateFile = () => (opts.dataDir ? path.join(opts.dataDir, 'outputs', STATE_NAME) : null);
  function readState() {
    const f = stateFile();
    if (!f) return { live: [] };
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      return { live: (Array.isArray(j?.live) ? j.live : []).filter((x) => x && ID_RE.test(String(x.id))).map((x) => ({ id: String(x.id), startedAt: typeof x.startedAt === 'string' ? x.startedAt : null })) };
    } catch { return { live: [] }; }
  }
  function writeState(st) {
    const f = stateFile();
    if (!f) return;
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(`${f}.tmp`, `${JSON.stringify({ version: 1, live: st.live }, null, 2)}\n`);
    renameSync(`${f}.tmp`, f);
  }

  async function userToken() {
    const raw = await userTokenStore.get();
    let t = null;
    try { t = raw ? JSON.parse(raw) : null; } catch { t = null; }
    if (!t || typeof t.token !== 'string') throw new FacebookLiveError('not-connected', facebookText('not-connected'));
    if (Number.isFinite(t.expiresAt) && t.expiresAt <= now()) throw new FacebookLiveError('reauth-needed', facebookText('reauth-needed'));
    return t;
  }
  async function readPage() {
    const raw = await pageStore.get();
    try {
      const p = raw ? JSON.parse(raw) : null;
      return p && ID_RE.test(String(p.pageId)) && typeof p.token === 'string' && p.token ? p : null;
    } catch { return null; }
  }

  /** The user's Pages that can go live: [{ id, name, canLive }] (never a token). */
  async function listPages() {
    const t = await userToken();
    const j = await call('GET', `${g()}/me/accounts`, { fields: 'id,name,tasks', access_token: t.token, limit: 100 });
    return (Array.isArray(j?.data) ? j.data : []).filter((p) => ID_RE.test(String(p?.id))).map((p) => ({
      id: String(p.id), name: clip(p.name, 100) || 'Page',
      // CREATE_CONTENT is the Page task that allows posting (and live videos); a missing tasks list is not held against it.
      canLive: !Array.isArray(p.tasks) || p.tasks.includes('CREATE_CONTENT'),
    }));
  }

  /** Saves the Page to stream to, with its Page token (Credential Manager only). -> { pageId, name } */
  async function choosePage(pageId) {
    if (!ID_RE.test(String(pageId ?? ''))) throw new FacebookLiveError('page-not-found', facebookText('page-not-found'));
    const t = await userToken();
    const j = await call('GET', `${g()}/me/accounts`, { fields: 'id,name,access_token', access_token: t.token, limit: 100 });
    const p = (Array.isArray(j?.data) ? j.data : []).find((x) => String(x?.id) === String(pageId));
    if (!p || typeof p.access_token !== 'string' || !p.access_token) throw new FacebookLiveError('page-not-found', facebookText('page-not-found'));
    await pageStore.set(JSON.stringify({ pageId: String(p.id), name: clip(p.name, 100), token: p.access_token, savedAt: now() }));
    return { pageId: String(p.id), name: clip(p.name, 100) };
  }

  /** { connected, scopesOk, missing, page: { id, name } | null } - read only, for the card. */
  async function status() {
    let t = null;
    try { t = await userToken(); } catch { t = null; }
    const granted = Array.isArray(t?.scopes) ? t.scopes : null;
    const missing = granted ? LIVE_SCOPES.filter((s) => !granted.includes(s)) : [];
    const p = await readPage();
    return { connected: !!t, scopesOk: granted ? missing.length === 0 : null, missing, page: p ? { id: p.pageId, name: p.name ?? '' } : null, leftovers: readState().live.length };
  }

  /** Ends one live video (end_live_video=true; the broadcast stays on the Page as a video). Gone already counts as ended. */
  async function endLive(id, token) {
    if (!ID_RE.test(String(id))) return false;
    try { await call('POST', `${g()}/${id}`, { end_live_video: 'true', access_token: token }); } catch (e) {
      const gone = e.status === 404 || (e.status === 400 && e.metaCode === 100);
      if (!gone) throw e;
    }
    writeState({ live: readState().live.filter((x) => x.id !== String(id)) });
    return true;
  }

  /** Ends every live video a stream before this one left behind (crash). -> { ended, failed } */
  async function endLeftovers() {
    const st = readState();
    if (!st.live.length) return { ended: 0, failed: 0 };
    const p = await readPage();
    if (!p) return { ended: 0, failed: st.live.length };
    let ended = 0; let failed = 0;
    for (const x of st.live) { try { await endLive(x.id, p.token); ended++; } catch { failed++; } }
    return { ended, failed };
  }

  /**
   * Go live: ends left-overs, creates the live video (LIVE_NOW) and puts its server address and key in the facebook
   * sink's Credential Manager targets. -> { id } (never the URL or key).
   */
  async function startLive({ title, description } = {}) {
    const p = await readPage();
    if (!p) throw new FacebookLiveError('no-page', facebookText('no-page'));
    await endLeftovers().catch(() => null);
    const params = { status: 'LIVE_NOW', access_token: p.token };
    const tt = clip(title, TITLE_MAX); const dd = clip(description, DESC_MAX);
    if (tt) params.title = tt;
    if (dd) params.description = dd;
    const j = await call('POST', `${g()}/${p.pageId}/live_videos`, params);
    const id = String(j?.id ?? '');
    if (!ID_RE.test(id)) throw new FacebookLiveError('graph-error', facebookText('graph-error'));
    writeState({ live: [...readState().live.filter((x) => x.id !== id), { id, startedAt: new Date(now()).toISOString() }] });
    let full = typeof j.secure_stream_url === 'string' ? j.secure_stream_url : null;
    if (!full) {
      // The create answer normally has it (Getting started guide); otherwise it is read once from the live video.
      const r = await call('GET', `${g()}/${id}`, { fields: 'secure_stream_url', access_token: p.token }).catch(() => null);
      full = typeof r?.secure_stream_url === 'string' ? r.secure_stream_url : null;
    }
    try {
      if (!full) throw new FacebookLiveError('no-stream-url', facebookText('no-stream-url'));
      let parts;
      try { parts = splitStreamUrl(full); } catch { throw new FacebookLiveError('no-stream-url', facebookText('no-stream-url')); }
      await serverStore.set(parts.server);
      await keyStore.set(parts.key);
      full = null; parts = null;
    } catch (e) {
      await endLive(id, p.token).catch(() => null);
      throw e;
    }
    return { id };
  }

  /** Stream end: ends the live videos of this run and deletes the server address and key. -> { ended, failed } */
  async function stopLive() {
    const r = await endLeftovers().catch(() => ({ ended: 0, failed: 1 }));
    await clearStreamCredentials();
    return r;
  }

  async function clearStreamCredentials() {
    await Promise.allSettled([serverStore.delete(), keyStore.delete()]);
  }

  /** Read-only live status of the newest live video of this run: 'LIVE' | 'LIVE_STOPPED' | ... | null. */
  async function liveStatus() {
    const st = readState();
    const last = st.live[st.live.length - 1];
    const p = await readPage();
    if (!last || !p) return null;
    const j = await call('GET', `${g()}/${last.id}`, { fields: 'status', access_token: p.token }).catch(() => null);
    return typeof j?.status === 'string' ? clip(j.status, 40) : null;
  }

  return { listPages, choosePage, status, startLive, stopLive, endLeftovers, clearStreamCredentials, liveStatus, readState };
}
