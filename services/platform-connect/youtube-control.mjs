// SPDX-License-Identifier: GPL-3.0-or-later
// In-app YouTube control (D388, part B): account, live status, event details, thumbnail, categories, live chat (read +
// send), the broadcast list, End and Delete. Node stdlib only. No feature flag: the YouTube window works by default.
//
// Uses the same Google sign-in as youtube-events.mjs (accessToken from the platform-connect service). Test seams:
// fetchImpl, accessToken, endpoints, now, onUnauthorized, setTimer, clearTimer.
//
// Privacy: chat text and author names are untrusted data. They are plain text, kept in memory only (a ring of 500 per
// output) and are NEVER written to a file or a log: this module has no logger at all. Errors carry codes only, never a
// response body. The channel title is returned to the app only.
//
// Quota (YouTube Data API, 10 000 units a day), units per call:
//   channels.list 1, liveBroadcasts.list 1, liveStreams.list 1, videos.list 1, videoCategories.list 1,
//   liveChatMessages.list 5, liveChatMessages.insert 20,
//   liveBroadcasts.update 50, videos.update 50, thumbnails.set 50, liveBroadcasts.transition 50, liveBroadcasts.delete 50.
// Per hour (the figures the UI polling gives):
//   status panel: one group of 3 reads (liveBroadcasts + liveStreams + videos) per 25 s at most (cache) = 3 x 144 = 432/h
//   chat: one read per 15 s per output only while a client asked in the last 60 s = 5 x 240 = 1 200/h per output
//         (both outputs: 2 400/h), plus 1 unit per 25 s to find the chat while the event is not live yet
//   both open for one hour with two outputs: about 2 900 units, so about 3.4 hours of that in one day; the readers stop
//   when the window is closed (60 s without a request). Details, thumbnail, End, Delete and a chat message cost their
//   unit price once, on the user's click. Categories (24 h cache) and the account (1 h cache) cost 1 unit a day.
//
// UNVERIFIED (no real YouTube answer yet): the exact fields YouTube needs back for liveBroadcasts.update on a running
// event (title, scheduledStartTime, privacyStatus are sent); that videos.update keeps the live event's title in step;
// that liveChatMessages.list answers for a chat that has just opened; the lifeCycle values that allow transition.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ConnectError, DEFAULT_ENDPOINTS, httpJson } from './index.mjs';
import { ID_RE, cleanCategoryId, cleanDescription, cleanPrivacy, cleanTags, cleanTitle, failCode } from './youtube-events.mjs';

export const LIVE_FILE = 'youtube-live.json';
const OUTPUT_RE = /^[a-z0-9-]{1,32}$/;
const PAGE_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CHAT_ID_RE = /^[A-Za-z0-9_=.-]{1,200}$/;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 15_000;
const ACCOUNT_CACHE_MS = 60 * 60_000;
const STATUS_CACHE_MS = 25_000;
const CATEGORY_CACHE_MS = 24 * 60 * 60_000;
const LIST_CACHE_MS = 60_000;
const CHAT_MIN_POLL_MS = 15_000;
const CHAT_IDLE_MS = 60_000;
const CHAT_RESOLVE_MS = 25_000;
const CHAT_ERROR_WAIT_MS = 60_000;
const RING_MAX = 500;
const LIVE_STATES = new Set(['live', 'liveStarting', 'testing']);
const LIST_STATUS = new Set(['all', 'upcoming', 'active', 'completed']);
const HEALTH = new Set(['good', 'ok', 'bad', 'noData']);
const CHAT_DEAD_REASONS = new Set(['liveChatEnded', 'liveChatDisabled', 'liveChatNotFound', 'forbidden']);

const plainText = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '');
// Chat text and names: control characters and the invisible direction marks (spoofing) become spaces.
const chatPlain = (v, max) => (typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/g, ' ').trim().slice(0, max) : '');
const isoOrNull = (v) => { if (typeof v !== 'string') return null; const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const intOrNull = (v) => { const n = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : null; };

// ---- <dataDir>/youtube-live.json: the event each output went live with (not a secret) ----

function cleanLive(outputs) {
  const out = {};
  for (const [k, v] of Object.entries(outputs && typeof outputs === 'object' ? outputs : {})) {
    if (!OUTPUT_RE.test(k) || !v || typeof v !== 'object' || typeof v.broadcastId !== 'string' || !ID_RE.test(v.broadcastId)) continue;
    out[k] = { broadcastId: v.broadcastId, title: plainText(v.title, 100), madeAt: isoOrNull(v.madeAt) };
  }
  return out;
}
/** { "<output>": { broadcastId, title, madeAt } }; unreadable = none. */
export function readLive(dataDir) {
  try { return cleanLive(JSON.parse(readFileSync(path.join(dataDir, LIVE_FILE), 'utf8'))?.outputs); } catch { return {}; }
}
/** Writes the whole map (tmp + rename). Returns what was written. */
export function writeLive(dataDir, outputs) {
  const clean = cleanLive(outputs);
  const file = path.join(dataDir, LIVE_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, outputs: clean }, null, 2)}\n`);
  renameSync(tmp, file);
  return clean;
}
/** Adds or replaces the entries of [{ output, broadcastId, title }] (other outputs keep theirs). */
export function setLive(dataDir, entries, madeAt) {
  const cur = readLive(dataDir);
  for (const e of entries) cur[e.output] = { broadcastId: e.broadcastId, title: e.title, madeAt };
  return writeLive(dataDir, cur);
}
/** Removes the entries for which drop(output, entry) is true. Returns the ids dropped. */
export function clearLive(dataDir, drop) {
  const cur = readLive(dataDir);
  const gone = Object.keys(cur).filter((k) => drop(k, cur[k]));
  if (gone.length) { for (const k of gone) delete cur[k]; writeLive(dataDir, cur); }
  return gone;
}

// ---- the service ----

/** A picture file the user picked: { type, bytes } or throws youtube-bad-thumbnail. PNG / JPEG by magic bytes, <= 2 MB. */
// A drive-letter path only (C:\... or C:/...): never a UNC share (\\host\share, //host/share) or a device path (\\?\, \\.\),
// so a request can never make the server open a network path (Windows would send the user's credentials) or block on one
// (Codex review of D388). The real path is checked again, so a link to a share is refused too. Read asynchronously.
const DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
export async function readThumbnailFile(file) {
  if (typeof file !== 'string' || !file || file.length > 1024 || file.includes('\0') || !DRIVE_PATH_RE.test(file) || /^[\\/]{2}/.test(file)) throw new ConnectError('youtube-bad-thumbnail');
  let bytes;
  try {
    const real = await fsp.realpath(file);
    if (!DRIVE_PATH_RE.test(real)) throw new Error('not-local');
    const st = await fsp.stat(real);
    if (!st.isFile() || st.size <= 8 || st.size > MAX_THUMB_BYTES) throw new Error('size');
    bytes = await fsp.readFile(real);
  } catch { throw new ConnectError('youtube-bad-thumbnail'); }
  if (bytes.length > MAX_THUMB_BYTES) throw new ConnectError('youtube-bad-thumbnail');
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', bytes };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', bytes };
  throw new ConnectError('youtube-bad-thumbnail');
}

/**
 * opts: { fetchImpl, accessToken() -> Promise<string>, endpoints?, now?, onUnauthorized?(), setTimer?, clearTimer? }
 */
export function createYoutubeControl(opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ep = { ...DEFAULT_ENDPOINTS, ...(opts.endpoints ?? {}) };
  const now = opts.now ?? Date.now;
  const onUnauthorized = typeof opts.onUnauthorized === 'function' ? opts.onUnauthorized : () => {};
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t));
  if (typeof opts.accessToken !== 'function') throw new Error('youtube-control: accessToken required');
  let closed = false;

  async function auth() {
    let token;
    try { token = await opts.accessToken(); } catch (e) { throw new ConnectError(typeof e?.code === 'string' ? e.code : 'oauth-reauth-needed'); }
    if (typeof token !== 'string' || !token) throw new ConnectError('oauth-reauth-needed');
    return { Authorization: `Bearer ${token}` };
  }
  // chat: a chat that ended or is closed gives 'youtube-chat-unavailable'. A 404 is 'unknown-broadcast' otherwise.
  async function call(url, { method = 'GET', json, okStatus = [200], chat = false } = {}) {
    const r = await httpJson(fetchImpl, url, { method, headers: await auth(), json });
    if (!okStatus.includes(r.status)) {
      const reason = String(r.data?.error?.errors?.[0]?.reason ?? '');
      let code = failCode(r);
      if (chat && (r.status === 404 || (r.status === 403 && CHAT_DEAD_REASONS.has(reason)))) code = 'youtube-chat-unavailable';
      else if (r.status === 404 && code === 'youtube-api-failed') code = 'unknown-broadcast';
      if (code === 'youtube-unauthorized') { try { onUnauthorized(); } catch { /* bookkeeping only */ } }
      throw new ConnectError(code, `HTTP ${r.status}`);
    }
    return r.data;
  }
  const idParam = (id) => encodeURIComponent(id);
  const needId = (id) => { if (typeof id !== 'string' || !ID_RE.test(id)) throw new ConnectError('bad-params'); return id; };
  const items = (d) => (Array.isArray(d?.items) ? d.items : []);

  // ---- account ----
  let acct = null; // { at, value }
  /** { channelTitle|null, regionCode } of the signed-in channel (cached 1 h). */
  async function account({ refresh = false } = {}) {
    if (!refresh && acct && now() - acct.at < ACCOUNT_CACHE_MS) return { ...acct.value };
    const d = await call(`${ep.youtubeApi}/channels?part=snippet&mine=true`);
    const sn = items(d)[0]?.snippet;
    const value = { channelTitle: plainText(sn?.title, 100) || null, regionCode: typeof sn?.country === 'string' && /^[A-Z]{2}$/.test(sn.country) ? sn.country : 'US' };
    acct = { at: now(), value };
    return { ...value };
  }

  // ---- categories ----
  const catCache = new Map(); // region -> { at, list }
  /** [{ id, title }] the channel can assign (cached 24 h per region). */
  async function categories() {
    let region = 'US';
    try { region = (await account()).regionCode; } catch (e) { if (e?.code === 'youtube-unauthorized' || e?.code === 'oauth-reauth-needed') throw e; }
    const hit = catCache.get(region);
    if (hit && now() - hit.at < CATEGORY_CACHE_MS) return hit.list.map((c) => ({ ...c }));
    let d;
    try { d = await call(`${ep.youtubeApi}/videoCategories?part=snippet&regionCode=${region}`); } catch (e) {
      if (region === 'US' || e?.code !== 'youtube-api-failed') throw e;
      region = 'US';
      d = await call(`${ep.youtubeApi}/videoCategories?part=snippet&regionCode=US`);
    }
    const list = items(d).filter((c) => c?.snippet?.assignable === true && typeof c.id === 'string' && /^[0-9]{1,4}$/.test(c.id)).map((c) => ({ id: c.id, title: plainText(c.snippet.title, 100) }));
    catCache.set(region, { at: now(), list });
    return list.map((c) => ({ ...c }));
  }

  // ---- live status ----
  let statusCache = null; // { at, key, value }
  const invalidateStatus = () => { statusCache = null; };
  /**
   * entries: [{ output, label, broadcastId, title? }]. -> { at, outputs: [...], gone: [broadcastId not found] }.
   * One group of three reads, cached 25 s. A failed liveStreams / videos read leaves health / counts null.
   */
  async function liveStatus(entries, { refresh = false } = {}) {
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.output === 'string' && ID_RE.test(e.broadcastId));
    if (!list.length) return { at: new Date(now()).toISOString(), outputs: [], gone: [] };
    const ids = [...new Set(list.map((e) => e.broadcastId))].sort();
    const key = ids.join(',');
    if (!refresh && statusCache && statusCache.key === key && now() - statusCache.at < STATUS_CACHE_MS) return compose(list, statusCache.value, statusCache.atIso);
    const b = await call(`${ep.youtubeApi}/liveBroadcasts?part=id,snippet,status,contentDetails&id=${ids.map(idParam).join(',')}&maxResults=50`);
    const bById = new Map(items(b).filter((x) => typeof x?.id === 'string').map((x) => [x.id, x]));
    const streamIds = [...new Set([...bById.values()].map((x) => x.contentDetails?.boundStreamId).filter((s) => typeof s === 'string' && ID_RE.test(s)))];
    const soft = async (url) => { try { return await call(url); } catch (e) { if (['youtube-unauthorized', 'youtube-quota', 'oauth-reauth-needed'].includes(e?.code)) throw e; return null; } };
    const [s, v] = await Promise.all([
      streamIds.length ? soft(`${ep.youtubeApi}/liveStreams?part=id,status&id=${streamIds.map(idParam).join(',')}&maxResults=50`) : null,
      bById.size ? soft(`${ep.youtubeApi}/videos?part=liveStreamingDetails,statistics&id=${[...bById.keys()].map(idParam).join(',')}&maxResults=50`) : null,
    ]);
    const value = {
      b: bById,
      s: new Map(items(s).filter((x) => typeof x?.id === 'string').map((x) => [x.id, x])),
      v: new Map(items(v).filter((x) => typeof x?.id === 'string').map((x) => [x.id, x])),
      streamsKnown: s !== null || !streamIds.length, videosKnown: v !== null || !bById.size,
    };
    const atIso = new Date(now()).toISOString();
    statusCache = { at: now(), key, value, atIso };
    return compose(list, value, atIso);
  }
  function compose(list, value, atIso) {
    const gone = [];
    const outputs = list.map((e) => {
      const b = value.b.get(e.broadcastId);
      if (!b) { gone.push(e.broadcastId); return { output: e.output, label: e.label ?? e.output, broadcastId: e.broadcastId, title: plainText(e.title, 100), watchUrl: `https://www.youtube.com/watch?v=${e.broadcastId}`, lifeCycle: null, health: { status: null, issues: [] }, viewers: null, likes: null, chat: false }; }
      const st = value.s.get(b.contentDetails?.boundStreamId)?.status?.healthStatus;
      const issues = (Array.isArray(st?.configurationIssues) ? st.configurationIssues : []).slice(0, 5).map((i) => plainText(i?.description || i?.reason, 200)).filter(Boolean);
      const vd = value.v.get(e.broadcastId);
      return {
        output: e.output, label: e.label ?? e.output, broadcastId: e.broadcastId,
        title: plainText(b.snippet?.title, 100) || plainText(e.title, 100),
        watchUrl: `https://www.youtube.com/watch?v=${e.broadcastId}`,
        lifeCycle: typeof b.status?.lifeCycleStatus === 'string' && /^[A-Za-z]{1,32}$/.test(b.status.lifeCycleStatus) ? b.status.lifeCycleStatus : null,
        health: { status: HEALTH.has(st?.status) ? st.status : null, issues },
        viewers: intOrNull(vd?.liveStreamingDetails?.concurrentViewers),
        likes: intOrNull(vd?.statistics?.likeCount),
        chat: typeof b.snippet?.liveChatId === 'string' && b.snippet.liveChatId !== '',
      };
    });
    return { at: atIso, outputs, gone };
  }

  // ---- details and thumbnail ----
  const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$/;
  /**
   * { broadcastId, title?, description?, privacy?, tags?, categoryId? } -> { warnings: [] }.
   * liveBroadcasts.update keeps scheduledStartTime (and the other required fields); tags and category go through
   * videos.update (its failure is a warning). description '' and tags [] clear the value.
   */
  async function updateDetails(d = {}) {
    const broadcastId = needId(d.broadcastId);
    const has = (k) => d[k] !== undefined;
    if (has('title') && !cleanTitle(d.title)) throw new ConnectError('youtube-bad-title');
    if (has('description') && !(d.description === '' || cleanDescription(d.description))) throw new ConnectError('bad-params');
    if (has('privacy') && !cleanPrivacy(d.privacy)) throw new ConnectError('bad-params');
    if (has('tags') && !((Array.isArray(d.tags) && d.tags.length === 0) || cleanTags(d.tags))) throw new ConnectError('bad-params');
    if (has('categoryId') && !cleanCategoryId(d.categoryId)) throw new ConnectError('bad-params');
    if (!['title', 'description', 'privacy', 'tags', 'categoryId'].some(has)) throw new ConnectError('bad-params');
    const title = has('title') ? cleanTitle(d.title) : undefined;
    const tags = has('tags') ? (d.tags.length ? cleanTags(d.tags) : []) : undefined;
    const warnings = [];
    invalidateStatus();
    const cur = await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status,contentDetails&id=${idParam(broadcastId)}`);
    const b = items(cur).find((x) => x?.id === broadcastId);
    if (!b) throw new ConnectError('unknown-broadcast');
    if (has('title') || has('description') || has('privacy')) {
      const snippet = {
        title: title ?? (typeof b.snippet?.title === 'string' ? b.snippet.title : ''),
        description: has('description') ? d.description : (typeof b.snippet?.description === 'string' ? b.snippet.description : ''),
        scheduledStartTime: isoOrNull(b.snippet?.scheduledStartTime) ?? isoOrNull(b.snippet?.actualStartTime) ?? new Date(now()).toISOString(),
      };
      const end = isoOrNull(b.snippet?.scheduledEndTime); if (end) snippet.scheduledEndTime = end;
      const status = { privacyStatus: d.privacy ?? (cleanPrivacy(b.status?.privacyStatus) ?? 'private') };
      if (typeof b.status?.selfDeclaredMadeForKids === 'boolean') status.selfDeclaredMadeForKids = b.status.selfDeclaredMadeForKids;
      await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status`, { method: 'PUT', json: { id: broadcastId, snippet, status } });
    }
    if (tags !== undefined || has('categoryId')) {
      try {
        const vd = await call(`${ep.youtubeApi}/videos?part=snippet&id=${idParam(broadcastId)}`);
        const vs = items(vd).find((x) => x?.id === broadcastId)?.snippet;
        const cat = d.categoryId ?? (cleanCategoryId(vs?.categoryId) ?? null);
        if (!vs || !cat) warnings.push('The category and tags could not be changed: YouTube gave no category for this event.');
        else {
          const sn = {
            title: title ?? (typeof vs.title === 'string' ? vs.title : ''), categoryId: cat,
            description: has('description') ? d.description : (typeof vs.description === 'string' ? vs.description : ''),
          };
          const tagList = tags !== undefined ? tags : (Array.isArray(vs.tags) ? vs.tags.filter((t) => typeof t === 'string' && t.length <= 100 && !/[<>]/.test(t)).slice(0, 100) : []);
          if (tagList.length) sn.tags = tagList;
          if (typeof vs.defaultLanguage === 'string' && LANG_RE.test(vs.defaultLanguage)) sn.defaultLanguage = vs.defaultLanguage;
          if (typeof vs.defaultAudioLanguage === 'string' && LANG_RE.test(vs.defaultAudioLanguage)) sn.defaultAudioLanguage = vs.defaultAudioLanguage;
          await call(`${ep.youtubeApi}/videos?part=snippet`, { method: 'PUT', json: { id: broadcastId, snippet: sn } });
        }
      } catch (e) {
        if (['youtube-unauthorized', 'youtube-quota', 'oauth-reauth-needed'].includes(e?.code)) throw e;
        warnings.push('YouTube did not take the category and tags; the other details were saved.');
      }
    }
    return { warnings };
  }

  /** thumbnails.set from a local file (PNG / JPEG by magic bytes, <= 2 MB). */
  async function setThumbnail({ broadcastId, path: file } = {}) {
    needId(broadcastId);
    const { type, bytes } = await readThumbnailFile(file);
    const res = await (async () => {
      try {
        return await fetchImpl(`${ep.youtubeUpload}/thumbnails/set?videoId=${idParam(broadcastId)}&uploadType=media`, {
          method: 'POST', headers: { ...(await auth()), 'Content-Type': type, 'Content-Length': String(bytes.length) }, body: bytes, redirect: 'error', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch (e) { if (e instanceof ConnectError) throw e; throw new ConnectError('network-failed'); }
    })();
    let data = null;
    try { const t = await res.text(); data = t ? JSON.parse(t) : null; } catch { data = null; }
    if (res.status !== 200) {
      const code = failCode({ status: res.status, data });
      if (code === 'youtube-unauthorized') { try { onUnauthorized(); } catch { /* bookkeeping only */ } }
      throw new ConnectError(code === 'youtube-forbidden' || code === 'youtube-api-failed' ? (res.status === 404 ? 'unknown-broadcast' : code) : code, `HTTP ${res.status}`);
    }
    return { ok: true };
  }

  // ---- the broadcast list ----
  const listCache = new Map(); // status -> { at, value } (first page only)
  const mapBroadcast = (b) => ({
    id: b.id,
    title: plainText(b.snippet?.title, 100),
    when: isoOrNull(b.snippet?.actualStartTime) ?? isoOrNull(b.snippet?.scheduledStartTime) ?? isoOrNull(b.snippet?.publishedAt),
    privacy: cleanPrivacy(b.status?.privacyStatus),
    lifeCycle: typeof b.status?.lifeCycleStatus === 'string' && /^[A-Za-z]{1,32}$/.test(b.status.lifeCycleStatus) ? b.status.lifeCycleStatus : null,
  });
  /** { items: [{ id, title, when, privacy, lifeCycle }], next|null }; the first page is cached 60 s unless refresh. */
  async function listBroadcasts({ status = 'all', page = null, refresh = false } = {}) {
    if (!LIST_STATUS.has(status)) throw new ConnectError('bad-params');
    if (page !== null && page !== undefined && !(typeof page === 'string' && PAGE_RE.test(page))) throw new ConnectError('bad-params');
    const first = page === null || page === undefined;
    const hit = listCache.get(status);
    if (first && !refresh && hit && now() - hit.at < LIST_CACHE_MS) return { items: hit.value.items.map((i) => ({ ...i })), next: hit.value.next };
    const d = await call(`${ep.youtubeApi}/liveBroadcasts?part=id,snippet,status&broadcastStatus=${status}&broadcastType=all&maxResults=25${first ? '' : `&pageToken=${encodeURIComponent(page)}`}`);
    const list = items(d).filter((b) => typeof b?.id === 'string' && ID_RE.test(b.id)).map(mapBroadcast);
    list.sort((a, b) => (b.when ?? '').localeCompare(a.when ?? ''));
    const value = { items: list, next: typeof d?.nextPageToken === 'string' && PAGE_RE.test(d.nextPageToken) ? d.nextPageToken : null };
    if (first) listCache.set(status, { at: now(), value });
    return { items: value.items.map((i) => ({ ...i })), next: value.next };
  }
  const invalidateLists = () => { listCache.clear(); invalidateStatus(); };

  /** The broadcast's lifeCycleStatus (1 unit), or null when YouTube does not list it. */
  async function lifeCycleOf(id) {
    needId(id);
    const d = await call(`${ep.youtubeApi}/liveBroadcasts?part=id,status&id=${idParam(id)}`);
    const lc = items(d).find((x) => x?.id === id)?.status?.lifeCycleStatus;
    return typeof lc === 'string' && /^[A-Za-z]{1,32}$/.test(lc) ? lc : null;
  }
  /** liveBroadcasts.transition complete. */
  async function endBroadcast(id) {
    needId(id);
    await call(`${ep.youtubeApi}/liveBroadcasts/transition?broadcastStatus=complete&id=${idParam(id)}&part=status`, { method: 'POST' });
    invalidateLists();
    return { ok: true };
  }
  /** liveBroadcasts.delete. */
  async function deleteBroadcast(id) {
    needId(id);
    await call(`${ep.youtubeApi}/liveBroadcasts?id=${idParam(id)}`, { method: 'DELETE', okStatus: [200, 204] });
    invalidateLists();
    return { ok: true };
  }

  // ---- live chat ----
  const readers = new Map(); // output -> reader

  async function resolveChat(broadcastId) {
    const d = await call(`${ep.youtubeApi}/liveBroadcasts?part=snippet,status&id=${idParam(broadcastId)}`);
    const b = items(d).find((x) => x?.id === broadcastId);
    if (!b) throw new ConnectError('unknown-broadcast');
    const chatId = typeof b.snippet?.liveChatId === 'string' && CHAT_ID_RE.test(b.snippet.liveChatId) ? b.snippet.liveChatId : null;
    return { chatId, live: !!chatId && LIVE_STATES.has(b.status?.lifeCycleStatus) };
  }
  const kindOf = (t) => (t === 'textMessageEvent' ? 'text' : t === 'superChatEvent' || t === 'superStickerEvent' ? 'superChat'
    : ['newSponsorEvent', 'memberMilestoneChatEvent', 'membershipGiftingEvent', 'giftMembershipReceivedEvent'].includes(t) ? 'membership' : 'other');
  function ingest(r, data) {
    for (const m of items(data)) {
      if (typeof m?.id !== 'string' || r.ids.has(m.id)) continue;
      const kind = kindOf(m.snippet?.type);
      const msg = {
        seq: ++r.seq, id: m.id.slice(0, 200), author: chatPlain(m.authorDetails?.displayName, 100),
        text: chatPlain(m.snippet?.displayMessage ?? m.snippet?.textMessageDetails?.messageText ?? m.snippet?.superChatDetails?.userComment, 500),
        at: isoOrNull(m.snippet?.publishedAt), kind,
      };
      if (kind === 'superChat') { const a = chatPlain(m.snippet?.superChatDetails?.amountDisplayString ?? m.snippet?.superStickerDetails?.amountDisplayString, 32); if (a) msg.amount = a; }
      r.ring.push(msg);
      r.ids.add(m.id);
    }
    while (r.ring.length > RING_MAX) r.ids.delete(r.ring.shift().id);
  }
  function stopTimer(r) { if (r.timer) { clearTimer(r.timer); r.timer = null; } }
  function schedule(r, ms) {
    stopTimer(r);
    if (closed || !r.live) return;
    r.timer = setTimer(() => { r.timer = null; void tick(r); }, ms);
  }
  async function pollOnce(r) {
    try {
      const d = await call(`${ep.youtubeApi}/liveChatMessages?liveChatId=${idParam(r.chatId)}&part=snippet,authorDetails&maxResults=200${r.next ? `&pageToken=${encodeURIComponent(r.next)}` : ''}`, { chat: true });
      ingest(r, d);
      r.next = typeof d?.nextPageToken === 'string' && PAGE_RE.test(d.nextPageToken) ? d.nextPageToken : r.next;
      const wait = Math.max(CHAT_MIN_POLL_MS, intOrNull(d?.pollingIntervalMillis) ?? 0);
      r.nextAt = now() + wait;
      r.error = null;
      return wait;
    } catch (e) {
      const code = typeof e?.code === 'string' ? e.code : 'youtube-api-failed';
      if (code === 'youtube-chat-unavailable' || code === 'unknown-broadcast') { r.live = false; r.resolvedAt = now(); r.error = null; return null; }
      r.error = code;
      r.nextAt = now() + CHAT_ERROR_WAIT_MS;
      return CHAT_ERROR_WAIT_MS;
    }
  }
  async function tick(r) {
    if (closed || readers.get(r.output) !== r) return;
    if (!r.live || now() - r.lastAsk > CHAT_IDLE_MS) return; // idle: no timer until a client asks again
    r.busy = true;
    let wait;
    try { wait = await pollOnce(r); } finally { r.busy = false; }
    if (wait !== null && readers.get(r.output) === r && !closed) schedule(r, wait);
  }
  /**
   * { output, broadcastId, after? } -> { messages, cursor, live, error? }. The reader reads YouTube every
   * max(15 s, pollingIntervalMillis) only while a client asked within the last 60 s and the event is live.
   */
  async function chatRead({ output, broadcastId, after = 0 } = {}) {
    if (typeof output !== 'string' || !OUTPUT_RE.test(output)) throw new ConnectError('bad-params');
    needId(broadcastId);
    let r = readers.get(output);
    if (r && r.broadcastId !== broadcastId) { stopTimer(r); readers.delete(output); r = null; }
    if (!r) { r = { output, broadcastId, chatId: null, live: false, ring: [], ids: new Set(), seq: 0, next: null, nextAt: 0, resolvedAt: -Infinity, timer: null, lastAsk: now(), busy: false, error: null }; readers.set(output, r); }
    r.lastAsk = now();
    if (closed) return { messages: [], cursor: String(r.seq), live: false };
    if (!r.busy) {
      r.busy = true;
      try {
        if (!r.live && now() - r.resolvedAt >= CHAT_RESOLVE_MS) {
          // The attempt counts, not only a success: a failing look-up waits CHAT_ERROR_WAIT_MS instead of being retried at
          // the window's request rate (Codex review of D388: quota).
          r.resolvedAt = now();
          let c;
          try { c = await resolveChat(broadcastId); } catch (e) {
            r.error = typeof e?.code === 'string' ? e.code : 'youtube-api-failed';
            r.resolvedAt = now() + CHAT_ERROR_WAIT_MS - CHAT_RESOLVE_MS;
            if (r.error === 'youtube-unauthorized' || r.error === 'oauth-reauth-needed') throw e;
            c = null;
          }
          if (c) { r.chatId = c.chatId; r.live = c.live; r.error = null; }
        }
        if (r.live && !r.timer && now() >= r.nextAt) {
          const wait = await pollOnce(r);
          if (wait !== null) schedule(r, wait);
        } else if (r.live && !r.timer) schedule(r, Math.max(0, r.nextAt - now()));
      } finally { r.busy = false; }
    }
    const from = Number.isInteger(after) && after >= 0 ? after : 0;
    return { messages: r.ring.filter((m) => m.seq > from).map(({ seq, ...m }) => m), cursor: String(r.seq), live: r.live, ...(r.error ? { error: r.error } : {}) };
  }

  /** liveChatMessages.insert of 1..200 plain characters into the live chat of the event. */
  async function chatSend({ broadcastId, text } = {}) {
    needId(broadcastId);
    if (typeof text !== 'string') throw new ConnectError('bad-params');
    const t = text.trim();
    if (!t || t.length > 200 || /[\x00-\x1f\x7f]/.test(t)) throw new ConnectError('bad-params');
    const c = await resolveChat(broadcastId);
    if (!c.live) throw new ConnectError('youtube-chat-unavailable');
    await call(`${ep.youtubeApi}/liveChatMessages?part=snippet`, { method: 'POST', chat: true, json: { snippet: { liveChatId: c.chatId, type: 'textMessageEvent', textMessageDetails: { messageText: t } } } });
    return { ok: true };
  }

  /** Stops every chat reader and timer. Nothing runs afterwards. */
  function close() {
    closed = true;
    for (const r of readers.values()) stopTimer(r);
    readers.clear();
  }

  return { account, categories, liveStatus, updateDetails, setThumbnail, listBroadcasts, lifeCycleOf, endBroadcast, deleteBroadcast, chatRead, chatSend, close, _readers: readers };
}
