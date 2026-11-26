// SPDX-License-Identifier: GPL-3.0-or-later
// D444 IP1: Instagram Reels publishing through the Instagram Graph API with Facebook Login. Node stdlib only (`fetch`).
// Plan: docs/plan/2026-11-24-instagram-autopost.md. Nothing here runs by itself; the auto-post chain (instagram-queue.mjs)
// and `node services/posting/cli.mjs instagram signin|status|post <package>` call it.
//
// Sign-in (createInstagramAuth):
//   1. The user's Meta app id and app secret are saved to Windows Credential Manager (APP_ID_TARGET / APP_SECRET_TARGET)
//      from Settings > Posting & growth or the CLI. Never in a file, log or argv.
//   2. signIn(): a one-shot loopback listener (oauth.mjs loopbackListener, fixed port from data/posting/instagram.json)
//      receives Facebook's redirect with `code` and a random `state`; the code is exchanged for a short-lived user token,
//      that one for a long-lived token (about 60 days), and the Instagram professional account is found through the
//      user's Pages (me/accounts?fields=instagram_business_account). The token, its expiry, the IG user id and the
//      account's @name go to Credential Manager (TOKEN_TARGET) as one small JSON value. Memory and Credential Manager only.
//   3. accessToken(): the stored token; fewer than renewDaysBefore days left -> exchanged for a new long-lived one (at most
//      once a day; a failed renewal keeps the old token while it is valid). Expired or refused -> 'reauth-needed'.
// Publishing (publishReel), in this order:
//   content_publishing_limit (refuse when none left) -> POST /<ig-user>/media (REELS, resumable, caption) ->
//   POST rupload.facebook.com/ig-api-upload/<version>/<container> (Authorization: OAuth <token>, offset 0, file_size, the
//   bytes) -> poll the container's status_code (FINISHED / ERROR / EXPIRED / IN_PROGRESS, ceiling pollMaxMs) ->
//   POST /<ig-user>/media_publish creation_id. The caller's guard (beforeStep) runs before every request that changes
//   something, so a stream that starts mid-way stops it before the publish.
// HTTPS only: every URL must be https:, except 127.0.0.1 (the tests' fake Graph/rupload server; never a Meta host).
// Tokens never appear in an error message, a log line or a URL that is logged (Graph errors are reduced to HTTP status
// and Meta's numeric error code).

import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';
import { checkLimits, composeField } from './index.mjs';
import { loopbackListener } from './oauth.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const IG_TARGET = 'instagram-reels';
export const IG_FLAG = 'instagram-autopost';
export const APP_ID_TARGET = 'Ujwalam/posting/instagram-app-id';
export const APP_SECRET_TARGET = 'Ujwalam/posting/instagram-app-secret';
export const TOKEN_TARGET = 'Ujwalam/posting/instagram-token';
export const DEFAULT_IG_CONFIG = path.join(REPO, 'data', 'posting', 'instagram.json');
export const DEFAULT_ENDPOINTS = Object.freeze({ graph: 'https://graph.facebook.com', dialog: 'https://www.facebook.com', rupload: 'https://rupload.facebook.com' });
export const REQUEST_MS = 60 * 1000;
const UPLOAD_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class InstagramError extends Error {
  constructor(code, message, extra = {}) { super(message ?? code); this.name = 'InstagramError'; this.code = code; Object.assign(this, extra); }
}

/** data/posting/instagram.json, checked. Throws InstagramError 'bad-config'. */
export function loadIgConfig(file = DEFAULT_IG_CONFIG) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new InstagramError('bad-config', 'data/posting/instagram.json could not be read'); }
  const okInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (typeof j?.graphVersion !== 'string' || !/^v\d{1,3}\.\d{1,2}$/.test(j.graphVersion)) throw new InstagramError('bad-config', 'graphVersion must look like v24.0');
  if (j.redirectHost !== 'localhost' && j.redirectHost !== '127.0.0.1') throw new InstagramError('bad-config', 'redirectHost must be localhost or 127.0.0.1');
  if (!Array.isArray(j.scopes) || !j.scopes.length || !j.scopes.every((s) => typeof s === 'string' && /^[a-z_]+$/.test(s))) throw new InstagramError('bad-config', 'scopes must be a list of permission names');
  for (const [k, lo, hi] of [['redirectPort', 1024, 65535], ['pollEveryMs', 100, 600000], ['pollMaxMs', 1000, 3600000], ['renewDaysBefore', 1, 50], ['retryMinutes', 1, 1440], ['maxAttempts', 1, 50]]) {
    if (!okInt(j[k], lo, hi)) throw new InstagramError('bad-config', `${k} must be a whole number from ${lo} to ${hi}`);
  }
  return j;
}

/** HTTPS only; 127.0.0.1 (a test's fake server) is the one exception and is never a Meta host. Returns the URL. */
export function safeUrl(u) {
  const url = new URL(u);
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url;
  throw new InstagramError('insecure-url', 'only https addresses are used');
}

const base = (endpoints, cfg, kind) => `${(endpoints?.[kind] ?? DEFAULT_ENDPOINTS[kind]).replace(/\/+$/, '')}/${kind === 'rupload' ? 'ig-api-upload/' : ''}${cfg.graphVersion}`;

/** One Graph request with a deadline. -> parsed JSON. Errors carry only the HTTP status and Meta's numeric code. */
async function graph(fetchImpl, method, url, { params = null, headers = {}, body = null, ms = REQUEST_MS } = {}) {
  const u = safeUrl(url);
  if (params && method === 'GET') for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  const init = { method, headers: { ...headers } };
  if (body !== null) init.body = body;
  else if (params && method !== 'GET') { init.body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(); init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  let res; let json = null;
  try {
    res = await fetchImpl(u.href, { ...init, signal: ctl.signal });
    try { json = await res.json(); } catch { json = null; }
  } catch {
    throw new InstagramError(ctl.signal.aborted ? 'request-timeout' : 'network-error', ctl.signal.aborted ? 'Instagram did not answer in time' : 'could not reach Instagram');
  } finally { clearTimeout(timer); }
  if (res.ok && json && !json.error) return json;
  const code = Number(json?.error?.code);
  const sub = Number(json?.error?.error_subcode);
  // 190 = the token is invalid or expired (Graph API error codes); 4/17/32/613 and 9 = rate or publishing limits.
  if (code === 190 || res.status === 401) throw new InstagramError('reauth-needed', 'the Instagram sign-in expired or was removed; connect again');
  if ([4, 9, 17, 32, 613].includes(code)) throw new InstagramError('rate-limited', `Instagram says too many requests (code ${code})`);
  if (code === 10 || code === 200) throw new InstagramError('not-permitted', `Instagram refused: a permission is missing (code ${code})`);
  throw new InstagramError('graph-error', `Instagram answered HTTP ${res.status}${Number.isFinite(code) ? ` (code ${code}${Number.isFinite(sub) ? `/${sub}` : ''})` : ''}`,
    { status: res.status, metaCode: Number.isFinite(code) ? code : null });
}

/** The redirect URI the user adds to the Meta app (Valid OAuth Redirect URIs). Pure. The listener binds 127.0.0.1 and ::1;
 *  `localhost` is the host Meta allows over plain http for apps in development (UNVERIFIED, data/posting/instagram.json). */
export const redirectUriFor = (cfg, port = cfg.redirectPort) => `http://${cfg.redirectHost}:${port}/`;

/** The Facebook Login dialog URL. Pure. */
export function dialogUrl({ appId, redirectUri, state, cfg, endpoints = DEFAULT_ENDPOINTS }) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state, response_type: 'code', scope: cfg.scopes.join(',') });
  return `${base(endpoints, cfg, 'dialog')}/dialog/oauth?${q}`;
}

/** The first Page with an Instagram professional account: { igUserId, username } or null. */
export function pickAccount(pages) {
  for (const p of Array.isArray(pages?.data) ? pages.data : []) {
    const ig = p?.instagram_business_account;
    if (ig && typeof ig.id === 'string' && /^\d{1,30}$/.test(ig.id)) return { igUserId: ig.id, username: typeof ig.username === 'string' ? ig.username.slice(0, 60) : null };
  }
  return null;
}

/**
 * opts: { appIdStore?, appSecretStore?, tokenStore? (get/set/delete), browserOpen(url), fetchImpl?, endpoints?, cfg?,
 *         now?() } — every one a test seam; the defaults are Credential Manager, fetch and the real Meta hosts.
 */
export function createInstagramAuth(opts = {}) {
  const appIdStore = opts.appIdStore ?? createCredentialStore(APP_ID_TARGET);
  const appSecretStore = opts.appSecretStore ?? createCredentialStore(APP_SECRET_TARGET);
  const tokenStore = opts.tokenStore ?? createCredentialStore(TOKEN_TARGET);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints ?? {}) };
  const cfgOf = () => opts.cfg ?? loadIgConfig();
  const now = opts.now ?? (() => Date.now());

  async function client() {
    const [id, secret] = await Promise.all([appIdStore.get(), appSecretStore.get()]);
    if (!id || !secret) throw new InstagramError('no-app', 'the Meta app id and app secret are not saved yet');
    return { id, secret };
  }
  async function readToken() {
    const raw = await tokenStore.get();
    if (!raw) return null;
    try {
      const t = JSON.parse(raw);
      return typeof t?.token === 'string' && typeof t.igUserId === 'string' && Number.isFinite(t.expiresAt) ? t : null;
    } catch { return null; }
  }
  const writeToken = (t) => tokenStore.set(JSON.stringify(t));
  const longLived = async (c, cfg, shortToken) => {
    const j = await graph(fetchImpl, 'GET', `${base(endpoints, cfg, 'graph')}/oauth/access_token`, { params: { grant_type: 'fb_exchange_token', client_id: c.id, client_secret: c.secret, fb_exchange_token: shortToken } });
    if (typeof j.access_token !== 'string' || !j.access_token) throw new InstagramError('token-exchange-failed', 'no long-lived token in the answer');
    // expires_in may be missing for a token that does not expire (UNVERIFIED); 60 days is then assumed.
    return { token: j.access_token, expiresAt: now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) : 60 * 24 * 3600) * 1000 };
  };

  /** Saves the app id and secret (Credential Manager only). Empty values keep the stored one. */
  async function setApp({ appId, appSecret }) {
    if (appId !== undefined && appId !== '') {
      if (typeof appId !== 'string' || !/^\d{5,25}$/.test(appId)) throw new InstagramError('bad-app-id', 'the App ID is a number of 5 to 25 digits');
      await appIdStore.set(appId);
    }
    if (appSecret !== undefined && appSecret !== '') {
      if (typeof appSecret !== 'string' || !/^[A-Za-z0-9]{16,64}$/.test(appSecret)) throw new InstagramError('bad-app-secret', 'the App Secret is 16 to 64 letters and digits');
      await appSecretStore.set(appSecret);
    }
  }

  async function signIn({ signal } = {}) {
    const cfg = cfgOf();
    const c = await client();
    if (typeof opts.browserOpen !== 'function') throw new InstagramError('no-browser-opener', 'opts.browserOpen is required');
    const { port, result } = await loopbackListener({ signal, port: opts.port ?? cfg.redirectPort, alsoV6: true });
    const redirectUri = redirectUriFor(cfg, port);
    const state = randomBytes(16).toString('hex');
    await opts.browserOpen(dialogUrl({ appId: c.id, redirectUri, state, cfg, endpoints }));
    const got = await result;
    if (got.state !== state) throw new InstagramError('state-mismatch', 'the redirect state did not match (possible interference)');
    const short = await graph(fetchImpl, 'GET', `${base(endpoints, cfg, 'graph')}/oauth/access_token`, { params: { client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri, code: got.code } });
    if (typeof short.access_token !== 'string' || !short.access_token) throw new InstagramError('token-exchange-failed', 'no token in the answer');
    const ll = await longLived(c, cfg, short.access_token);
    const pages = await graph(fetchImpl, 'GET', `${base(endpoints, cfg, 'graph')}/me/accounts`, { params: { fields: 'name,instagram_business_account{id,username}', access_token: ll.token } });
    const acct = pickAccount(pages);
    // no Page at all = the Page was not ticked in Facebook's dialog (or sits in a business portfolio); a Page with no
    // Instagram = the account is not professional or not linked to that Page. Different fixes, so different codes.
    if (!acct && !(Array.isArray(pages?.data) && pages.data.length)) throw new InstagramError('no-fb-page', 'no Facebook Page was shared with the app');
    if (!acct) throw new InstagramError('no-ig-account', 'no Instagram professional account is linked to your Facebook Pages');
    await writeToken({ ...ll, ...acct, renewedAt: now() });
    return { username: acct.username, expiresAt: ll.expiresAt };
  }

  /** The stored token (renewed when it is close to expiry). -> { token, igUserId }. Throws 'reauth-needed'. */
  async function session() {
    const t = await readToken();
    if (!t) throw new InstagramError('reauth-needed', 'Instagram is not connected');
    if (t.expiresAt <= now()) throw new InstagramError('reauth-needed', 'the Instagram sign-in expired; connect again');
    const cfg = cfgOf();
    if (t.expiresAt - now() < cfg.renewDaysBefore * DAY_MS && !(now() - (t.renewedAt ?? 0) < DAY_MS)) {
      try {
        const ll = await longLived(await client(), cfg, t.token);
        const next = { ...t, ...ll, renewedAt: now() };
        await writeToken(next);
        return { token: next.token, igUserId: next.igUserId };
      } catch (e) {
        if (e?.code === 'reauth-needed') throw e;
        await writeToken({ ...t, renewedAt: now() }); // tried today; the old token still works until it expires
      }
    }
    return { token: t.token, igUserId: t.igUserId };
  }

  async function status() {
    const [id, secret, t] = await Promise.all([appIdStore.get(), appSecretStore.get(), readToken()]);
    const connected = !!t && t.expiresAt > now();
    return { hasApp: !!(id && secret), connected, username: connected ? (t.username ?? null) : null, expiresAt: connected ? new Date(t.expiresAt).toISOString() : null };
  }

  async function signOut() { await tokenStore.delete(); }

  return { setApp, signIn, session, status, signOut };
}

/** The Reel caption from a post package (description + hashtags), checked against the instagram-reels limits.
 *  -> { ok, caption, checks }. Pure (given limits). */
export function reelCaption(post, limits) {
  const p = { ...post, target: IG_TARGET };
  const r = checkLimits(p, limits);
  return { ok: r.ok, caption: composeField(p, ['description', 'hashtags']), checks: r.checks };
}

/** content_publishing_limit -> { used, total, left } (left null when the answer has no numbers). */
export async function publishingLimit({ fetchImpl = fetch, endpoints = DEFAULT_ENDPOINTS, cfg, token, igUserId }) {
  const j = await graph(fetchImpl, 'GET', `${base(endpoints, cfg, 'graph')}/${igUserId}/content_publishing_limit`, { params: { fields: 'quota_usage,config', access_token: token } });
  const d = Array.isArray(j?.data) ? j.data[0] : null;
  const used = Number(d?.quota_usage); const total = Number(d?.config?.quota_total);
  if (!Number.isFinite(used) || !Number.isFinite(total)) return { used: null, total: null, left: null };
  return { used, total, left: Math.max(0, total - used) };
}

/** A container's status_code (FINISHED | ERROR | EXPIRED | IN_PROGRESS | PUBLISHED | null). */
export async function containerStatus({ fetchImpl = fetch, endpoints = DEFAULT_ENDPOINTS, cfg, token, containerId }) {
  const j = await graph(fetchImpl, 'GET', `${base(endpoints, cfg, 'graph')}/${containerId}`, { params: { fields: 'status_code', access_token: token } });
  return typeof j?.status_code === 'string' ? j.status_code : null;
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes one Reel. opts: { auth (createInstagramAuth), videoPath, caption, cfg?, fetchImpl?, endpoints?, sleep?,
 *   now?, beforeStep?: async (step) => void (throws to stop: the live guard), onContainer?: (id) => void,
 *   resumeContainer?: id (a container made before a restart: FINISHED is published, IN_PROGRESS is polled again,
 *   PUBLISHED is reported done (no second post); only ERROR, EXPIRED or not found start a new container; a failed or
 *   unclear read throws 'container-unknown' (retryable, nothing new is made) }
 * -> { mediaId, containerId, left } | throws InstagramError.
 */
export async function publishReel(opts) {
  const cfg = opts.cfg ?? loadIgConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const endpoints = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints ?? {}) };
  const sleep = opts.sleep ?? sleepMs;
  const now = opts.now ?? (() => Date.now());
  const guard = async (step) => { if (opts.beforeStep) await opts.beforeStep(step); };
  if (typeof opts.caption !== 'string') throw new InstagramError('no-caption', 'no caption');
  const { token, igUserId } = await opts.auth.session();
  const g = base(endpoints, cfg, 'graph');
  const ctx = { fetchImpl, endpoints, cfg, token };

  let containerId = null; let uploaded = false;
  if (typeof opts.resumeContainer === 'string' && /^\d{1,30}$/.test(opts.resumeContainer)) {
    // Review (D444): only a definite answer may lead to a new container. A failed read (network, timeout, 5xx, rate limit,
    // anything unclear) is retryable and makes nothing new: the saved container may still be published.
    let st = null;
    try { st = await containerStatus({ ...ctx, containerId: opts.resumeContainer }); } catch (e) {
      if (e?.code === 'reauth-needed') throw e;
      // "not found": HTTP 404, or Graph's 400 with code 100 (unknown object)
      const gone = e?.code === 'graph-error' && (e.status === 404 || (e.status === 400 && e.metaCode === 100));
      if (!gone) throw new InstagramError('container-unknown', 'the saved upload could not be checked; tried again later');
      st = 'NOT_FOUND';
    }
    if (st !== 'NOT_FOUND' && st !== 'ERROR' && st !== 'EXPIRED' && st !== 'PUBLISHED' && st !== 'FINISHED' && st !== 'IN_PROGRESS') {
      throw new InstagramError('container-unknown', 'the saved upload has an unknown state; tried again later');
    }
    if (st === 'PUBLISHED') return { mediaId: null, containerId: opts.resumeContainer, left: null, already: true };
    if (st === 'FINISHED' || st === 'IN_PROGRESS') { containerId = opts.resumeContainer; uploaded = true; }
  }

  const limit = await publishingLimit({ ...ctx, igUserId });
  if (limit.left === 0) throw new InstagramError('limit-reached', `Instagram's limit of ${limit.total} posts in 24 hours is used up`);

  if (!uploaded) {
    let bytes;
    try { const st = statSync(opts.videoPath); if (!st.isFile()) throw new Error('not a file'); bytes = st.size; } catch { throw new InstagramError('video-missing', 'the video file is missing'); }
    await guard('container');
    const c = await graph(fetchImpl, 'POST', `${g}/${igUserId}/media`, { params: { media_type: 'REELS', upload_type: 'resumable', caption: opts.caption, access_token: token } });
    if (typeof c?.id !== 'string' || !/^\d{1,30}$/.test(c.id)) throw new InstagramError('container-failed', 'no container id in the answer');
    containerId = c.id;
    opts.onContainer?.(containerId);
    await guard('upload');
    const body = readFileSync(opts.videoPath);
    if (body.length !== bytes) throw new InstagramError('video-changed', 'the video file changed while it was read');
    const up = await graph(fetchImpl, 'POST', `${base(endpoints, cfg, 'rupload')}/${containerId}`, {
      headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(bytes), 'Content-Type': 'application/octet-stream' }, body, ms: UPLOAD_MS });
    if (up?.success !== true) throw new InstagramError('upload-failed', 'the upload was not accepted');
  }
  {
    // Poll until FINISHED, with a ceiling; ERROR and EXPIRED are final for this container.
    const until = now() + cfg.pollMaxMs;
    for (;;) {
      const st = await containerStatus({ ...ctx, containerId });
      if (st === 'FINISHED') break;
      if (st === 'ERROR') throw new InstagramError('container-error', 'Instagram could not process the video');
      if (st === 'EXPIRED') throw new InstagramError('container-expired', 'the upload expired before it was published');
      if (st === 'PUBLISHED') return { mediaId: null, containerId, left: limit.left, already: true };
      if (now() >= until) throw new InstagramError('processing-timeout', 'Instagram is still processing the video; tried again later');
      await sleep(cfg.pollEveryMs);
    }
  }
  await guard('publish');
  const p = await graph(fetchImpl, 'POST', `${g}/${igUserId}/media_publish`, { params: { creation_id: containerId, access_token: token } });
  if (typeof p?.id !== 'string' || !p.id) throw new InstagramError('publish-failed', 'no media id in the answer');
  return { mediaId: p.id, containerId, left: limit.left === null ? null : limit.left - 1 };
}
