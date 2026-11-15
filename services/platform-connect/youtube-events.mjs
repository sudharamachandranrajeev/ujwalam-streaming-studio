// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube live events per go-live (D386; D388: no feature flag, the in-window toggle `autoEvent` decides). Node stdlib only.
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
//     user's overrides (title, description, privacy, tags, category; D388: an override replaces the template's value).
//     The file also holds `autoEvent` (default true): false = Go live makes no event and calls YouTube not at all.
//     Written atomically.
//   - D389 Go live chooser: the file also holds `mode` (existing | copy | last | new; a file without one reads as copy)
//     and per output any of { size, broadcastId, templateId, fields }; the mode decides which part Go live uses:
//     existing = bindExisting (the user's own planned or live event: auto-start/stop turned on if off, bound to this
//     output's stream, never deleted by Ujwalam); copy = createEvent from the picked template; last = resolveLast
//     (newest finished stream on this output's key, else the newest overall) then createEvent; new = createFromFields.
//
// D389 quota: the chooser's lists (upcoming, active, completed) cost 3 units per refresh (cached 60 s by the caller) plus
// 1 for liveStreams.list; the completed list follows nextPageToken up to COMPLETED_PAGES (4) pages of 50, so up to 3
// units more on a channel with over 50 finished streams (also for resolveLast at a "last" Go live). bindExisting: 1 (broadcast) + 1 (liveStreams.list), plus 50 for the contentDetails update when
// auto-start is off and 50 for the bind when not bound to that stream yet. createFromFields: about 1 + 50 + 50 (+50
// thumbnail) + 50 bind.
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
//   - D389 bindExisting: the contentDetails field set sent back whole on liveBroadcasts.update (the read value minus
//     boundStreamId / boundStreamLastUpdateTimeMs, auto-start/stop on) is accepted and keeps the user's other settings.
//
// Errors carry codes only, never a response body. Test seams: fetchImpl, accessToken, readKey, endpoints, now.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConnectError, DEFAULT_ENDPOINTS, ERROR_TEXT, STREAM_REF_RE, httpJson, sameSecret } from './index.mjs';

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

/** A description YouTube takes: <= 5000 characters, no '<' or '>', no control characters except line breaks and tabs. '' = none. */
export function cleanDescription(v) {
  if (typeof v !== 'string' || !v || v.length > 5000 || /[<>]/.test(v) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) return null;
  return v;
}
/** Tags YouTube takes: an array of 1..30 plain strings of 1..100 characters (no '<' or '>'), 500 characters in all. [] = none. */
export function cleanTags(v) {
  if (!Array.isArray(v) || !v.length || v.length > 30) return null;
  const out = [];
  let total = 0;
  for (const t of v) {
    if (typeof t !== 'string') return null;
    const x = t.trim();
    if (!x || x.length > 100 || /[<>]/.test(x) || /[\x00-\x1f\x7f]/.test(x)) return null;
    total += x.length;
    out.push(x);
  }
  return total > 500 ? null : out;
}
export const cleanCategoryId = (v) => (typeof v === 'string' && /^[0-9]{1,4}$/.test(v) ? v : null);
export const cleanPrivacy = (v) => (typeof v === 'string' && PRIVACY.has(v) ? v : null);

// ---- the choice store (not a secret) ----

/** Go live chooser modes (D389): use an event on the channel, copy a past one, like the last one, or a new one. */
export const MODES = Object.freeze(['existing', 'copy', 'last', 'new']);
/** Pages of 50 the completed-broadcasts list follows (1 unit each): the newest finished stream per key behind 50 others. */
export const COMPLETED_PAGES = 4;
export const SIZE_RE = /^(1080|1440|2160)p$/;
const FIELD_KEYS = ['title', 'description', 'privacy', 'categoryId', 'tags', 'thumbnail'];
// A picked thumbnail file: a drive-letter path only (never a UNC share or a device path; the D388 thumbnail rule). The
// file itself is checked when it is read (readThumbnailFile in youtube-control.mjs).
const THUMB_PATH_OK = (v) => typeof v === 'string' && v.length <= 1024 && !v.includes('\0') && /^[A-Za-z]:[\\/]/.test(v);

/**
 * The fields of a new event (mode "new", D389): { title, description?, privacy?, categoryId?, tags?, thumbnail? }.
 * Strict: an unknown key or one bad value = null. '' description and [] tags = none.
 */
export function cleanFields(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !Object.keys(v).every((k) => FIELD_KEYS.includes(k))) return null;
  const title = cleanTitle(v.title);
  if (!title) return null;
  const f = { title };
  if (v.description !== undefined && v.description !== null) { if (v.description === '') f.description = ''; else { const d = cleanDescription(v.description); if (d === null) return null; f.description = d; } }
  if (v.privacy !== undefined && v.privacy !== null) { const p = cleanPrivacy(v.privacy); if (!p) return null; f.privacy = p; }
  if (v.categoryId !== undefined && v.categoryId !== null) { const c = cleanCategoryId(v.categoryId); if (!c) return null; f.categoryId = c; }
  if (v.tags !== undefined && v.tags !== null) { if (Array.isArray(v.tags) && v.tags.length === 0) f.tags = []; else { const t = cleanTags(v.tags); if (!t) return null; f.tags = t; } }
  if (v.thumbnail !== undefined && v.thumbnail !== null && v.thumbnail !== '') { if (!THUMB_PATH_OK(v.thumbnail)) return null; f.thumbnail = v.thumbnail; }
  return f;
}

// One output's choice. It may hold a template (copy), an event of the channel (existing), new-event fields (new) and a
// size at once: the mode in the file decides which is used, the others stay as the chooser's pre-selection.
function cleanChoice(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = {};
  if (typeof v.templateId === 'string' && ID_RE.test(v.templateId)) {
    Object.assign(c, { templateId: v.templateId, templateTitle: plainText(v.templateTitle, 100), title: cleanTitle(v.title) });
    // '' and [] are kept (the user cleared the template's value); absent = the template's value.
    const description = v.description === '' ? '' : cleanDescription(v.description); if (description !== null) c.description = description;
    const privacy = cleanPrivacy(v.privacy); if (privacy) c.privacy = privacy;
    const tags = Array.isArray(v.tags) && v.tags.length === 0 ? [] : cleanTags(v.tags); if (tags) c.tags = tags;
    const categoryId = cleanCategoryId(v.categoryId); if (categoryId) c.categoryId = categoryId;
  }
  if (typeof v.broadcastId === 'string' && ID_RE.test(v.broadcastId)) { c.broadcastId = v.broadcastId; c.broadcastTitle = plainText(v.broadcastTitle, 100); }
  const fields = cleanFields(v.fields); if (fields) c.fields = fields;
  if (typeof v.size === 'string' && SIZE_RE.test(v.size)) c.size = v.size;
  return Object.keys(c).length ? c : null;
}
/** The template part of a choice removed (D388 "no template"); the chooser's parts stay. null when nothing is left. */
export function withoutTemplate(c) {
  if (!c) return null;
  const { templateId, templateTitle, title, description, privacy, tags, categoryId, ...rest } = c;
  return Object.keys(rest).length ? rest : null;
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
function readChoiceFile(dataDir) { try { const j = JSON.parse(readFileSync(path.join(dataDir, CHOICES_FILE), 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
/** { "<sinkId>": { templateId?, templateTitle?, title?, description?, privacy?, tags?, categoryId?, broadcastId?, broadcastTitle?,
 *  fields?, size? } } from <dataDir>/youtube-events.json; unreadable = none. */
export function readChoices(dataDir) { return cleanChoices(readChoiceFile(dataDir).outputs); }
/** The toggle "New YouTube event at every Go live" (D388): true unless the file says false. Unreadable = true. */
export function readAutoEvent(dataDir) { return readChoiceFile(dataDir).autoEvent !== false; }
/** The Go live mode (D389). A file without one (written before D389) reads as 'copy'. */
export function readMode(dataDir) { const m = readChoiceFile(dataDir).mode; return MODES.includes(m) ? m : 'copy'; }
function writeFileAtomic(dataDir, outputs, autoEvent, mode) {
  const clean = cleanChoices(outputs);
  const file = path.join(dataDir, CHOICES_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, autoEvent, mode: MODES.includes(mode) ? mode : 'copy', outputs: clean }, null, 2)}
`);
  renameSync(tmp, file);
  return clean;
}
/** Writes the whole choice map (tmp + rename), keeping the autoEvent setting and (unless given) the mode. Returns what was written. */
export function writeChoices(dataDir, outputs, { mode, autoEvent } = {}) {
  return writeFileAtomic(dataDir, outputs, typeof autoEvent === 'boolean' ? autoEvent : readAutoEvent(dataDir), mode ?? readMode(dataDir));
}
/** Sets the autoEvent toggle, keeping the choices and the mode. Returns the new value. */
export function writeAutoEvent(dataDir, on) { writeFileAtomic(dataDir, readChoices(dataDir), on === true, readMode(dataDir)); return on === true; }

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

  // The channel's streams (liveStreams.list mine, up to 4 pages; 1 unit a page). Held in memory by the caller only.
  async function listStreams() {
    let pageToken = null;
    const streams = [];
    for (let page = 0; page < 4; page++) {
      const data = await call(`${ep.youtubeApi}/liveStreams?part=id,cdn&mine=true&maxResults=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      for (const s of Array.isArray(data?.items) ? data.items : []) streams.push(s);
      pageToken = typeof data?.nextPageToken === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.nextPageToken) ? data.nextPageToken : null;
      if (!pageToken) break;
    }
    return streams;
  }
  // The id of the stream in `streams` whose key is the one stored under keyRef (constant-time compare), or a code.
  async function matchKey(streams, keyRef) {
    let key = null;
    try { key = await opts.readKey(keyRef); } catch { key = null; }
    if (typeof key !== 'string' || !key) { key = null; return { error: 'youtube-key-missing' }; }
    let id = null;
    for (const s of streams) {
      if (typeof s?.id === 'string' && ID_RE.test(s.id) && sameSecret(s?.cdn?.ingestionInfo?.streamName, key)) { id = s.id; break; }
    }
    key = null;
    return id ? { id } : { error: 'youtube-key-not-found' };
  }

  /** The id of the channel's stream whose key is the one stored under keyRef. The key stays in this function. */
  async function findStreamId(keyRef) {
    if (typeof keyRef !== 'string' || !STREAM_REF_RE.test(keyRef)) throw new ConnectError('youtube-key-missing');
    const streams = await listStreams();
    const m = await matchKey(streams, keyRef);
    streams.length = 0;
    if (m.error) throw new ConnectError(m.error, ERROR_TEXT[m.error]);
    return m.id;
  }
  /** D389: { keyRef -> streamId | null } for several keys with one stream list. Keys never leave this function. */
  async function streamIdsFor(keyRefs) {
    const refs = [...new Set((Array.isArray(keyRefs) ? keyRefs : []).filter((r) => typeof r === 'string' && STREAM_REF_RE.test(r)))];
    const out = new Map();
    if (!refs.length) return out;
    const streams = await listStreams();
    for (const r of refs) { const m = await matchKey(streams, r); out.set(r, m.id ?? null); }
    streams.length = 0;
    return out;
  }

  // ---- D389: the Go live chooser's lists and the three new ways to get an event ----
  const LIVE_NOW = new Set(['live', 'liveStarting', 'testing', 'testStarting']);
  const lifeOf = (b) => (typeof b?.status?.lifeCycleStatus === 'string' && /^[A-Za-z]{1,32}$/.test(b.status.lifeCycleStatus) ? b.status.lifeCycleStatus : null);
  const whenOf = (b) => isoOrNull(b?.snippet?.actualStartTime) ?? isoOrNull(b?.snippet?.scheduledStartTime) ?? isoOrNull(b?.snippet?.publishedAt);
  /** One list of the channel's broadcasts by status, newest first. pages > 1 follows nextPageToken (1 unit a page, 50 a
   *  page) up to that fixed cap: the completed list, so an output's newest finished stream is not missed behind 50 others. */
  async function listByStatus(status, pages = 1) {
    const items = [];
    let token = null;
    for (let i = 0; i < pages; i++) {
      const data = await call(`${ep.youtubeApi}/liveBroadcasts?part=id,snippet,status,contentDetails&broadcastStatus=${status}&broadcastType=all&maxResults=50${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      for (const b of Array.isArray(data?.items) ? data.items : []) if (typeof b?.id === 'string' && ID_RE.test(b.id)) items.push(b);
      token = typeof data?.nextPageToken === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.nextPageToken) ? data.nextPageToken : null;
      if (!token) break;
    }
    return items.map((b) => ({
      id: b.id, title: plainText(b.snippet?.title, 100), when: whenOf(b), lifeCycle: lifeOf(b),
      boundStreamId: typeof b.contentDetails?.boundStreamId === 'string' && ID_RE.test(b.contentDetails.boundStreamId) ? b.contentDetails.boundStreamId : null,
    })).sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''));
  }
  /**
   * The chooser's lists (3 units: upcoming, active, completed): { existing: [{ id, title, lifeCycle, when, boundStreamId }],
   * past: [{ id, title, when, boundStreamId }] }, newest first. existing = upcoming + active, not complete/revoked.
   */
  async function chooserLists() {
    const [up, act, done] = await Promise.all([listByStatus('upcoming'), listByStatus('active'), listByStatus('completed', COMPLETED_PAGES)]);
    const seen = new Set();
    const existing = [...act, ...up].filter((b) => !seen.has(b.id) && seen.add(b.id) && b.lifeCycle !== 'complete' && b.lifeCycle !== 'revoked');
    existing.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''));
    return { existing, past: done.map(({ lifeCycle, ...b }) => b) };
  }
  /** The past streams' text for a smart fill: { title, description, tags } of a broadcast (2 units), or null. */
  async function broadcastText(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    const b = (await call(`${ep.youtubeApi}/liveBroadcasts?part=id,snippet&id=${encodeURIComponent(id)}`))?.items?.find?.((x) => x?.id === id);
    if (!b) return null;
    let tags = [];
    try {
      const v = (await call(`${ep.youtubeApi}/videos?part=snippet&id=${encodeURIComponent(id)}`))?.items?.find?.((x) => x?.id === id);
      tags = Array.isArray(v?.snippet?.tags) ? v.snippet.tags.filter((t) => typeof t === 'string') : [];
    } catch (e) { if (e?.code === 'youtube-unauthorized' || e?.code === 'youtube-quota') throw e; tags = []; }
    return { title: plainText(b.snippet?.title, 100), description: typeof b.snippet?.description === 'string' ? b.snippet.description.slice(0, 5000) : '', tags };
  }
  /**
   * Mode "last": the newest completed broadcast of the stream the key under keyRef belongs to, else the newest completed
   * one overall. -> template id; throws youtube-no-past-stream when the channel has none.
   */
  async function resolveLast({ keyRef } = {}) {
    const done = await listByStatus('completed', COMPLETED_PAGES);
    if (!done.length) throw new ConnectError('youtube-no-past-stream');
    let streamId = null;
    try { streamId = await findStreamId(keyRef); } catch (e) { if (e?.code === 'youtube-unauthorized' || e?.code === 'youtube-quota') throw e; streamId = null; }
    return (done.find((b) => streamId && b.boundStreamId === streamId) ?? done[0]).id;
  }

  /**
   * Mode "existing" (D389): the user's own event (made in YouTube Studio or earlier) bound to the stream of keyRef.
   * Nothing is created and the event is never deleted here (it is not Ujwalam's). A finished event, an event that is live
   * on another stream (YouTube cannot re-bind it) or an event gone from the channel is refused before any write.
   * An event with auto-start off is updated to auto-start and auto-stop (contentDetails sent whole). Costs: 1 (read)
   * + 1 (liveStreams) + 50 (update, only when needed) + 50 (bind, only when not bound to that stream yet).
   * -> { broadcastId, title, warnings[] }
   */
  async function bindExisting({ broadcastId, keyRef } = {}) {
    if (typeof broadcastId !== 'string' || !ID_RE.test(broadcastId)) throw new ConnectError('youtube-bad-choice');
    const data = await call(`${ep.youtubeApi}/liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(broadcastId)}`);
    const b = Array.isArray(data?.items) ? data.items.find((x) => x?.id === broadcastId) : null;
    if (!b) throw new ConnectError('youtube-event-gone');
    const life = lifeOf(b);
    if (life === 'complete' || life === 'revoked') throw new ConnectError('youtube-event-ended');
    const streamId = await findStreamId(keyRef);
    const cd = b.contentDetails && typeof b.contentDetails === 'object' ? b.contentDetails : {};
    const bound = typeof cd.boundStreamId === 'string' ? cd.boundStreamId : null;
    const liveNow = LIVE_NOW.has(life);
    if (liveNow && bound && bound !== streamId) throw new ConnectError('youtube-event-bound-other');
    const warnings = [];
    if (!liveNow && cd.enableAutoStart !== true) {
      // Sent whole (an omitted contentDetails field would be reset by YouTube); only the read-only binding fields are left
      // out. UNVERIFIED against a real event: the exact field set YouTube wants back.
      const { boundStreamId, boundStreamLastUpdateTimeMs, ...rest } = structuredClone(cd);
      await call(`${ep.youtubeApi}/liveBroadcasts?part=contentDetails`, { method: 'PUT', json: { id: broadcastId, contentDetails: { ...rest, enableAutoStart: true, enableAutoStop: true } } });
    }
    if (bound !== streamId) {
      await call(`${ep.youtubeApi}/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails`, { method: 'POST' });
    }
    return { broadcastId, title: plainText(b.snippet?.title, 100), warnings };
  }

  /**
   * Mode "new" (D389): a live event from the user's fields, no template. Latency normal, DVR on, made-for-kids false,
   * auto-start and auto-stop on, bound to the stream of keyRef. Category and tags through videos.update; the thumbnail
   * through opts thumbnail(broadcastId) (the D388 thumbnail path; its failure is a warning). A half-made event is deleted.
   * -> { broadcastId, title, warnings[] }
   */
  async function createFromFields({ fields, keyRef, thumbnail } = {}) {
    const f = cleanFields(fields);
    if (!f) throw new ConnectError('youtube-bad-choice');
    const streamId = await findStreamId(keyRef); // a key that is not on this channel stops the start with nothing made
    const warnings = [];
    const description = f.description ?? '';
    const ins = await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status,contentDetails`, {
      method: 'POST',
      json: {
        snippet: { title: f.title, description, scheduledStartTime: new Date(now()).toISOString() },
        status: { privacyStatus: f.privacy ?? 'private', selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: true, enableAutoStop: true, enableDvr: true, latencyPreference: 'normal', monitorStream: { enableMonitorStream: false } },
      },
    });
    const broadcastId = typeof ins?.id === 'string' && ID_RE.test(ins.id) ? ins.id : null;
    if (!broadcastId) throw new ConnectError('youtube-api-failed');
    try {
      if (f.categoryId || f.tags?.length) {
        let cat = f.categoryId ?? null;
        if (!cat) {
          try { cat = cleanCategoryId((await call(`${ep.youtubeApi}/videos?part=snippet&id=${encodeURIComponent(broadcastId)}`))?.items?.find?.((x) => x?.id === broadcastId)?.snippet?.categoryId); } catch (e) { if (e?.code === 'youtube-unauthorized') throw e; cat = null; }
        }
        if (!cat) warnings.push('The tags were not set: YouTube gave no category for the new event.');
        else {
          const snippet = { title: f.title, categoryId: cat, description };
          if (f.tags?.length) snippet.tags = f.tags;
          try { await call(`${ep.youtubeApi}/videos?part=snippet`, { method: 'PUT', json: { id: broadcastId, snippet } }); } catch (e) {
            if (e?.code === 'youtube-unauthorized') throw e;
            warnings.push('YouTube did not take the category and tags for the new event.');
          }
        }
      }
      if (typeof thumbnail === 'function' && f.thumbnail) {
        try { await thumbnail(broadcastId, f.thumbnail); } catch (e) {
          if (e?.code === 'youtube-unauthorized' || e?.code === 'oauth-reauth-needed') throw e;
          warnings.push(e?.code === 'youtube-bad-thumbnail' ? 'The thumbnail file could not be read (PNG or JPEG of at most 2 MB), so the event has YouTube\'s default thumbnail.' : 'YouTube did not take the thumbnail (custom thumbnails need a verified channel); the event has the default thumbnail.');
        }
      }
      await call(`${ep.youtubeApi}/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=id,contentDetails`, { method: 'POST' });
    } catch (e) {
      await deleteEvent(broadcastId);
      throw e instanceof ConnectError ? e : new ConnectError('youtube-api-failed');
    }
    return { broadcastId, title: f.title, warnings };
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
  async function createEvent({ templateId, title, keyRef, description: ovDescription, privacy: ovPrivacy, tags: ovTags, categoryId: ovCategoryId } = {}) {
    if (typeof templateId !== 'string' || !ID_RE.test(templateId)) throw new ConnectError('youtube-template-missing');
    if (title !== undefined && title !== null && !cleanTitle(title)) throw new ConnectError('youtube-bad-title');
    // D388 overrides: a value the user set replaces the template's; a bad one stops the start before anything is made.
    const ov = {};
    // '' and [] are kept: the user cleared the template's description / tags (Codex review of D388).
    if (ovDescription === '') ov.description = '';
    else if (ovDescription !== undefined && ovDescription !== null) { ov.description = cleanDescription(ovDescription); if (!ov.description) throw new ConnectError('youtube-bad-choice'); }
    if (ovPrivacy !== undefined && ovPrivacy !== null) { ov.privacy = cleanPrivacy(ovPrivacy); if (!ov.privacy) throw new ConnectError('youtube-bad-choice'); }
    if (Array.isArray(ovTags) && ovTags.length === 0) ov.tags = [];
    else if (ovTags !== undefined && ovTags !== null) { ov.tags = cleanTags(ovTags); if (!ov.tags) throw new ConnectError('youtube-bad-choice'); }
    if (ovCategoryId !== undefined && ovCategoryId !== null) { ov.categoryId = cleanCategoryId(ovCategoryId); if (!ov.categoryId) throw new ConnectError('youtube-bad-choice'); }
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
    const description = ov.description ?? (typeof tpl.snippet?.description === 'string' ? tpl.snippet.description.slice(0, 5000) : (typeof video?.snippet?.description === 'string' ? video.snippet.description.slice(0, 5000) : ''));
    const kids = typeof tpl.status?.selfDeclaredMadeForKids === 'boolean' ? tpl.status.selfDeclaredMadeForKids
      : (typeof video?.status?.selfDeclaredMadeForKids === 'boolean' ? video.status.selfDeclaredMadeForKids : (typeof video?.status?.madeForKids === 'boolean' ? video.status.madeForKids : undefined));
    const status = { privacyStatus: ov.privacy ?? (PRIVACY.has(tpl.status?.privacyStatus) ? tpl.status.privacyStatus : 'private'), ...(kids !== undefined ? { selfDeclaredMadeForKids: kids } : {}) };
    const ins = await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status,contentDetails`, {
      method: 'POST', json: { snippet: { title: name, description, scheduledStartTime: new Date(now()).toISOString() }, status, contentDetails },
    });
    const broadcastId = typeof ins?.id === 'string' && ID_RE.test(ins.id) ? ins.id : null;
    if (!broadcastId) throw new ConnectError('youtube-api-failed');
    try {
      // videos.update: only fields the template (or an override) has; category is required by YouTube for a snippet update.
      const vs = video?.snippet ?? (ov.categoryId ? {} : null);
      if (vs) {
        const cat = ov.categoryId ?? (typeof vs.categoryId === 'string' && /^[0-9]{1,4}$/.test(vs.categoryId) ? vs.categoryId : null);
        if (cat) {
          const snippet = { title: name, categoryId: cat, description };
          const tagList = ov.tags ?? (Array.isArray(vs.tags) ? vs.tags.filter((t) => typeof t === 'string' && t.length <= 100 && !/[<>]/.test(t)).slice(0, 100) : []);
          if (tagList.length) snippet.tags = tagList;
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

  return { listTemplates, knownTemplate, findStreamId, streamIdsFor, chooserLists, broadcastText, resolveLast, bindExisting, createFromFields, createEvent, deleteEvent };
}
