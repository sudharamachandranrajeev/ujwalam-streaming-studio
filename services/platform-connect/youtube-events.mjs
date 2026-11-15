// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube live events per go-live (D386, flag `youtube-events`, needs `platform-connect`). Node stdlib only.
//
// What it does:
//   - Every Go live makes a fresh YouTube live event (liveBroadcast) for each YouTube output that starts. The event is
//     copied from a previous broadcast the user picked as that output's "template" (H and V each pick their own):
//     title (or the user's own title for that output), description, privacy, made-for-kids, DVR, embed, record from
//     start, latency preference and closed-caption type from the broadcast; category, tags, default language and audio
//     language through videos.update; the thumbnail through thumbnails.set. Auto-start and auto-stop are on, the monitor
//     stream is off, and the event is bound to the reusable stream whose key that output streams with.
//   - The stream is found by comparing each stream's key on the channel (liveStreams.list) with the key stored in
//     Windows Credential Manager, in memory and in constant time (sameSecret). The key is never returned, logged or kept.
//   - The template choice per output (<dataDir>/youtube-events.json) is not a secret: template id, its title and the
//     user's title override. Written atomically.
//
// Quota (YouTube Data API, 10 000 units a day by default): listing templates costs 1 unit. One output's go-live costs
// about 203 units: reads 3 x 1 (template broadcast, template video, liveStreams.list), liveBroadcasts.insert 50,
// videos.update 50, thumbnails.set 50, liveBroadcasts.bind 50. Two YouTube outputs: about 406 units per go-live.
//
// UNVERIFIED (no real stream yet):
//   - monitorStream.enableMonitorStream false together with enableAutoStart true: the event should go live as soon as
//     the stream's data arrives, with no testing stage and no click in YouTube Studio.
//   - The copied thumbnail is the template's published image (maxres, else standard, else high) from i.ytimg.com: it
//     may be a re-encoded, smaller copy of the original upload.
//   - thumbnails.set needs a verified channel (custom thumbnails); without it the copy fails and a warning is given.
//   - Whether YouTube applies videos.update category / tags / languages to a broadcast that has not started yet.
//
// Errors carry codes only, never a response body. Test seams: fetchImpl, accessToken, readKey, endpoints, now.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConnectError, DEFAULT_ENDPOINTS, ERROR_TEXT, STREAM_REF_RE, httpJson, sameSecret } from './index.mjs';

export const EVENTS_FLAG = 'youtube-events';
export const CHOICES_FILE = 'youtube-events.json';
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OUTPUT_RE = /^[a-z0-9-]{1,32}$/;
const TEMPLATE_CACHE_MS = 5 * 60_000;
const MAX_TEMPLATES = 25;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const THUMB_HOST = 'i.ytimg.com';
const HTTP_TIMEOUT_MS = 15_000;
const PRIVACY = new Set(['public', 'unlisted', 'private']);
const LATENCY = new Set(['normal', 'low', 'ultraLow']);
const CAPTIONS = new Set(['closedCaptionsDisabled', 'closedCaptionsHttpPost', 'closedCaptionsEmbedded']);
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;

/** A title YouTube takes: 1..100 characters, no '<' or '>'. Returns the trimmed title or null. */
export function cleanTitle(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 100 || /[<>]/.test(t) || /[\x00-\x1f\x7f]/.test(t)) return null;
  return t;
}
const plainText = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
const isoOrNull = (v) => { if (typeof v !== 'string') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

// ---- the choice store (not a secret) ----

function cleanChoice(v) {
  if (!v || typeof v !== 'object' || typeof v.templateId !== 'string' || !ID_RE.test(v.templateId)) return null;
  return { templateId: v.templateId, templateTitle: plainText(v.templateTitle, 100), title: cleanTitle(v.title) };
}
function cleanChoices(outputs) {
  const out = {};
  for (const [k, v] of Object.entries(outputs && typeof outputs === 'object' ? outputs : {})) {
    if (!OUTPUT_RE.test(k)) continue;
    const c = cleanChoice(v);
    if (c) out[k] = c;
  }
  return out;
}
/** { "<sinkId>": { templateId, templateTitle, title|null } } from <dataDir>/youtube-events.json; unreadable = none. */
export function readChoices(dataDir) {
  try { return cleanChoices(JSON.parse(readFileSync(path.join(dataDir, CHOICES_FILE), 'utf8'))?.outputs); } catch { return {}; }
}
/** Writes the whole choice map (tmp + rename). Returns what was written. */
export function writeChoices(dataDir, outputs) {
  const clean = cleanChoices(outputs);
  const file = path.join(dataDir, CHOICES_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, outputs: clean }, null, 2)}\n`);
  renameSync(tmp, file);
  return clean;
}

// ---- the API client ----

/** Error code for a failed YouTube answer (codes only). */
export function failCode(r) {
  if (r.status === 401) return 'youtube-unauthorized';
  const reason = String(r.data?.error?.errors?.[0]?.reason ?? '');
  if (r.status === 429 || reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'dailyLimitExceeded') return 'youtube-quota';
  if (r.status === 403) return reason === 'liveStreamingNotEnabled' || reason === 'insufficientLivePermissions' ? 'youtube-live-not-enabled' : 'youtube-forbidden';
  return 'youtube-api-failed';
}

/**
 * opts: { fetchImpl, accessToken() -> Promise<string>, readKey(keyRef) -> Promise<string|null>, endpoints?, now?,
 *         onUnauthorized?() }
 */
export function createYoutubeEvents(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ep = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints ?? {}) };
  const now = opts.now ?? Date.now;
  const onUnauthorized = typeof opts.onUnauthorized === 'function' ? opts.onUnauthorized : () => {};
  if (typeof opts.accessToken !== 'function' || typeof opts.readKey !== 'function') throw new Error('youtube-events: accessToken and readKey required');
  let cache = null; // { at, templates }
  let lastIds = new Set();

  async function auth() {
    let token;
    try { token = await opts.accessToken(); } catch (e) { throw new ConnectError(typeof e?.code === 'string' ? e.code : 'oauth-reauth-needed'); }
    if (typeof token !== 'string' || !token) throw new ConnectError('oauth-reauth-needed');
    return { Authorization: `Bearer ${token}` };
  }
  async function call(url, { method = 'GET', json, okStatus = [200] } = {}) {
    const r = await httpJson(fetchImpl, url, { method, headers: await auth(), json });
    if (!okStatus.includes(r.status)) {
      const code = failCode(r);
      if (code === 'youtube-unauthorized') { try { onUnauthorized(); } catch { /* bookkeeping only */ } }
      throw new ConnectError(code, `HTTP ${r.status}`);
    }
    return r.data;
  }

  /** The user's previous broadcasts, newest first (max 25): [{ id, title, when, privacy, lifeCycle }]. */
  async function listTemplates({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.at < TEMPLATE_CACHE_MS) return cache.templates.map((t) => ({ ...t }));
    const data = await call(`${ep.youtubeApi}/liveBroadcasts?part=id,snippet,status&broadcastStatus=all&broadcastType=all&maxResults=50`);
    const items = Array.isArray(data?.items) ? data.items : [];
    const templates = items.filter((b) => typeof b?.id === 'string' && ID_RE.test(b.id)).map((b) => ({
      id: b.id,
      title: plainText(b.snippet?.title, 100),
      when: isoOrNull(b.snippet?.actualStartTime) ?? isoOrNull(b.snippet?.scheduledStartTime) ?? isoOrNull(b.snippet?.publishedAt),
      privacy: PRIVACY.has(b.status?.privacyStatus) ? b.status.privacyStatus : null,
      lifeCycle: typeof b.status?.lifeCycleStatus === 'string' && /^[A-Za-z]{1,32}$/.test(b.status.lifeCycleStatus) ? b.status.lifeCycleStatus : null,
    }));
    templates.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''));
    const top = templates.slice(0, MAX_TEMPLATES);
    cache = { at: now(), templates: top };
    lastIds = new Set(top.map((t) => t.id));
    return top.map((t) => ({ ...t }));
  }
  /** A template from the last list (re-listed once when it is not there), or null. */
  async function knownTemplate(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const find = () => cache?.templates.find((t) => t.id === id) ?? null;
    if (lastIds.has(id) && find()) return { ...find() };
    await listTemplates({ refresh: true });
    return find() ? { ...find() } : null;
  }

  /** The id of the channel's stream whose key is the one stored under keyRef. The key stays in this function. */
  async function findStreamId(keyRef) {
    if (typeof keyRef !== 'string' || !STREAM_REF_RE.test(keyRef)) throw new ConnectError('youtube-key-missing');
    let pageToken = null;
    const streams = [];
    for (let page = 0; page < 4; page++) {
      const data = await call(`${ep.youtubeApi}/liveStreams?part=id,cdn&mine=true&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      for (const s of Array.isArray(data?.items) ? data.items : []) streams.push(s);
      pageToken = typeof data?.nextPageToken === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.nextPageToken) ? data.nextPageToken : null;
      if (!pageToken) break;
    }
    let key = null;
    try { key = await opts.readKey(keyRef); } catch { key = null; }
    if (typeof key !== 'string' || !key) { key = null; throw new ConnectError('youtube-key-missing'); }
    let id = null;
    for (const s of streams) {
      if (typeof s?.id === 'string' && ID_RE.test(s.id) && sameSecret(s?.cdn?.ingestionInfo?.streamName, key)) { id = s.id; break; }
    }
    key = null;
    streams.length = 0;
    if (!id) throw new ConnectError('youtube-key-not-found', ERROR_TEXT['youtube-key-not-found']);
    return id;
  }

  // The template's best thumbnail, downloaded (https, i.ytimg.com, <= 2 MB) and set on the new video. Warnings only.
  async function copyThumbnail(template, videoId, warnings) {
    const th = template?.snippet?.thumbnails ?? {};
    const pick = [th.maxres, th.standard, th.high].find((t) => typeof t?.url === 'string');
    if (!pick) { warnings.push('The template has no thumbnail to copy.'); return; }
    let u;
    try { u = new URL(pick.url); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || u.hostname.toLowerCase() !== THUMB_HOST) { warnings.push('The template thumbnail is not on YouTube\'s image server, so it was not copied.'); return; }
    let bytes = null; let type = 'image/jpeg';
    try {
      const res = await fetchImpl(u.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const len = Number(res.headers?.get?.('content-length'));
      const ct = String(res.headers?.get?.('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (ct === 'image/png' || ct === 'image/jpeg') type = ct;
      if (res.status === 200 && !(Number.isFinite(len) && len > MAX_THUMB_BYTES)) {
        const b = Buffer.from(await res.arrayBuffer());
        if (b.length > 0 && b.length <= MAX_THUMB_BYTES) bytes = b;
      }
    } catch { bytes = null; }
    if (!bytes) { warnings.push('The template thumbnail could not be downloaded (or is over 2 MB), so the new event has YouTube\'s default thumbnail.'); return; }
    try {
      const res = await fetchImpl(`${ep.youtubeUpload}/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
        method: 'POST', headers: { ...(await auth()), 'Content-Type': type, 'Content-Length': String(bytes.length) }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      try { await res.text(); } catch { /* body not used */ }
      if (res.status !== 200) warnings.push('YouTube did not take the copied thumbnail (custom thumbnails need a verified channel); the event has the default thumbnail.');
    } catch { warnings.push('The copied thumbnail could not be uploaded; the event has the default thumbnail.'); }
  }

  /**
   * A new live event copied from templateId, bound to the stream whose key is stored under keyRef.
   * Returns { broadcastId, title, warnings[] }. Throws ConnectError (codes only); a half-made event is deleted.
   */
  async function createEvent({ templateId, title, keyRef } = {}) {
    if (typeof templateId !== 'string' || !ID_RE.test(templateId)) throw new ConnectError('youtube-template-missing');
    if (title !== undefined && title !== null && !cleanTitle(title)) throw new ConnectError('youtube-bad-title');
    const warnings = [];
    const tData = await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status,contentDetails&id=${encodeURIComponent(templateId)}`);
    const tpl = Array.isArray(tData?.items) ? tData.items.find((b) => b?.id === templateId) : null;
    if (!tpl) throw new ConnectError('youtube-template-missing');
    const name = cleanTitle(title) ?? cleanTitle(tpl.snippet?.title);
    if (!name) throw new ConnectError('youtube-bad-title');
    let video = null;
    try {
      const vData = await call(`${ep.youtubeApi}/videos?part=snippet,status&id=${encodeURIComponent(templateId)}`);
      video = Array.isArray(vData?.items) ? vData.items.find((v) => v?.id === templateId) ?? null : null;
    } catch (e) { if (e?.code === 'youtube-unauthorized' || e?.code === 'youtube-quota') throw e; video = null; }
    if (!video) warnings.push('The template\'s category, tags and languages could not be read, so they were not copied.');
    // Found before anything is made: a key that is not on this channel stops the start with nothing to clean up.
    const streamId = await findStreamId(keyRef);

    const tcd = tpl.contentDetails ?? {};
    const contentDetails = { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false } }; // UNVERIFIED: straight live
    for (const k of ['enableDvr', 'enableEmbed', 'recordFromStart']) if (typeof tcd[k] === 'boolean') contentDetails[k] = tcd[k];
    if (LATENCY.has(tcd.latencyPreference)) contentDetails.latencyPreference = tcd.latencyPreference;
    if (CAPTIONS.has(tcd.closedCaptionsType)) contentDetails.closedCaptionsType = tcd.closedCaptionsType;
    const description = typeof tpl.snippet?.description === 'string' ? tpl.snippet.description.slice(0, 5000) : (typeof video?.snippet?.description === 'string' ? video.snippet.description.slice(0, 5000) : '');
    const kids = typeof tpl.status?.selfDeclaredMadeForKids === 'boolean' ? tpl.status.selfDeclaredMadeForKids
      : (typeof video?.status?.selfDeclaredMadeForKids === 'boolean' ? video.status.selfDeclaredMadeForKids : (typeof video?.status?.madeForKids === 'boolean' ? video.status.madeForKids : undefined));
    const status = { privacyStatus: PRIVACY.has(tpl.status?.privacyStatus) ? tpl.status.privacyStatus : 'private', ...(kids !== undefined ? { selfDeclaredMadeForKids: kids } : {}) };
    const ins = await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status,contentDetails`, {
      method: 'POST', json: { snippet: { title: name, description, scheduledStartTime: new Date(now()).toISOString() }, status, contentDetails },
    });
    const broadcastId = typeof ins?.id === 'string' && ID_RE.test(ins.id) ? ins.id : null;
    if (!broadcastId) throw new ConnectError('youtube-api-failed');
    try {
      // videos.update: only fields the template has; category is required by YouTube for a snippet update.
      const vs = video?.snippet ?? null;
      if (vs) {
        if (typeof vs.categoryId === 'string' && /^[0-9]{1,4}$/.test(vs.categoryId)) {
          const snippet = { title: name, categoryId: vs.categoryId, description };
          if (Array.isArray(vs.tags)) { const tags = vs.tags.filter((t) => typeof t === 'string' && t.length <= 100 && !/[<>]/.test(t)).slice(0, 100); if (tags.length) snippet.tags = tags; }
          if (typeof vs.defaultLanguage === 'string' && LANG_RE.test(vs.defaultLanguage)) snippet.defaultLanguage = vs.defaultLanguage;
          if (typeof vs.defaultAudioLanguage === 'string' && LANG_RE.test(vs.defaultAudioLanguage)) snippet.defaultAudioLanguage = vs.defaultAudioLanguage;
          try { await call(`${ep.youtubeApi}/videos?part=snippet`, { method: 'PUT', json: { id: broadcastId, snippet } }); } catch (e) {
            if (e?.code === 'youtube-unauthorized') throw e;
            warnings.push('YouTube did not take the template\'s category, tags and languages for the new event.');
          }
        } else warnings.push('The template has no category, so category, tags and languages were not copied.');
      }
      await copyThumbnail(tpl, broadcastId, warnings);
      await call(`${ep.youtubeApi}/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails`, { method: 'POST' });
    } catch (e) {
      await deleteEvent(broadcastId);
      throw e instanceof ConnectError ? e : new ConnectError('youtube-api-failed');
    }
    return { broadcastId, title: name, warnings };
  }

  /** Deletes an event Ujwalam made. Best effort: true when YouTube said yes, never throws. */
  async function deleteEvent(broadcastId) {
    if (typeof broadcastId !== 'string' || !ID_RE.test(broadcastId)) return false;
    try { await call(`${ep.youtubeApi}/liveBroadcasts?id=${encodeURIComponent(broadcastId)}`, { method: 'DELETE', okStatus: [200, 204] }); return true; } catch { return false; }
  }

  return { listTemplates, knownTemplate, findStreamId, createEvent, deleteEvent };
}
