// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the channel's scheduled posts (what YouTube Studio shows as "Scheduled") for the post-schedule flag (D310, D375).
// Needs the youtube.readonly scope; the caller checks the granted scopes first and fails closed without it.
//   readChannelSchedule({ accessToken, fetchImpl?, nowMs, cfg })
//     -> { last (ms|null), count, times (ms[], sorted: future scheduled), recent (ms[], sorted: went public in the last
//          RECENT_DAYS), scanned, pages, truncated, reachedLookback }
// Calls (YouTube Data API v3, 1 quota unit each): channels.list mine=true -> the uploads playlist; then per page
// (at most cfg.maxPages x cfg.pageSize): playlistItems.list part=snippet,contentDetails -> video ids, when each was added
// (snippet.publishedAt) and when it went public (contentDetails.videoPublishedAt); videos.list part=status -> privacyStatus
// + publishAt. Only these parts are read (no titles or descriptions). Nothing is written; tokens never leave memory.
// Whole channel (Codex review 2026-11-21, D409): every page of the uploads list is read, to its end (no nextPageToken).
// An old upload can still carry a future publishAt, so no lookback ends the scan any more (cfg.lookbackDays is no
// longer used here). Reaching cfg.maxPages with pages left is truncated (incomplete): the caller gives out no slot and
// uploads nothing (fail closed). A channel with more than maxPages x pageSize uploads must raise maxPages.
// Cost: 1 (channels.list) + 2 per page (playlistItems.list + videos.list) quota units per read.
// Any failure throws ScheduleError: 'schedule-scope-missing' (403 insufficient permissions / 401), 'schedule-read-failed',
// or 'schedule-read-incomplete' (D409: a page without an items list, an item without a video id, a video whose details
// did not come back, or the read past its deadline).
// The caller never guesses a slot when this throws.
import { ScheduleError, futureScheduleTimes, latestFutureSchedule } from './schedule.mjs';

const API = 'https://www.googleapis.com/youtube/v3';

async function getJson(fetchImpl, url, accessToken) {
  let res;
  try { res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }); } catch {
    throw new ScheduleError('schedule-read-failed', 'network error reading the scheduled posts');
  }
  let body = null; try { body = await res.json(); } catch { /* no body */ }
  if (res.ok && body) return body;
  const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '');
  if (res.status === 401 || (res.status === 403 && /insufficient|scope/i.test(reason))) {
    throw new ScheduleError('schedule-scope-missing', 'sign in again to allow reading scheduled posts');
  }
  throw new ScheduleError('schedule-read-failed', `HTTP ${res.status} reading the scheduled posts`);
}

const DAY_MS = 24 * 3600 * 1000;
/** Public videos that went public this many days back still count as taken times (a new post is never within the gap). */
export const RECENT_DAYS = 2;
const msOf = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/** D409 (second Codex review): one read must end within this time, well under the schedule lock's stale time
 *  (auto-chain.mjs LOCK_STALE_MS). Past it the read is incomplete (fail closed) and its requests are aborted. */
export const READ_DEADLINE_MS = 30 * 1000;
const incomplete = (what) => new ScheduleError('schedule-read-incomplete', `the channel answer was incomplete (${what})`);

/** opts.deadlineMs (default READ_DEADLINE_MS): hard deadline on the whole read. */
export async function readChannelSchedule({ accessToken, fetchImpl = fetch, nowMs, cfg, deadlineMs = READ_DEADLINE_MS }) {
  const stop = new AbortController();
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new ScheduleError('schedule-read-incomplete', 'the channel read did not finish in time')); stop.abort(); }, deadlineMs);
  });
  const f = (url, init = {}) => { if (stop.signal.aborted) throw new ScheduleError('schedule-read-incomplete', 'the channel read did not finish in time'); return fetchImpl(url, { ...init, signal: stop.signal }); };
  try { return await Promise.race([readAll({ accessToken, fetchImpl: f, nowMs, cfg }), late]); } finally { clearTimeout(timer); }
}

async function readAll({ accessToken, fetchImpl, nowMs, cfg }) {
  const ch = await getJson(fetchImpl, `${API}/channels?part=contentDetails&mine=true`, accessToken);
  const uploads = ch?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (typeof uploads !== 'string' || !uploads) throw new ScheduleError('schedule-read-failed', 'no uploads list found for this channel');
  const videos = []; const wentPublic = new Map(); let pageToken = null; let pages = 0; let scanned = 0;
  do {
    const q = new URLSearchParams({ part: 'snippet,contentDetails', playlistId: uploads, maxResults: String(cfg.pageSize) });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await getJson(fetchImpl, `${API}/playlistItems?${q}`, accessToken);
    pages++;
    // D409 (second Codex review): a malformed or partial answer is incomplete, never an empty or partial success.
    if (!Array.isArray(page?.items)) throw incomplete('no playlist items list');
    const items = page.items;
    pageToken = typeof page?.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : null;
    const ids = [];
    for (const i of items) {
      const id = i?.contentDetails?.videoId;
      if (typeof id !== 'string' || !id) throw incomplete('a playlist item without a video id');
      ids.push(id);
      const p = msOf(i?.contentDetails?.videoPublishedAt);
      if (p !== null) wentPublic.set(id, p);
    }
    scanned += ids.length;
    if (ids.length) {
      const v = await getJson(fetchImpl, `${API}/videos?part=status&id=${ids.map(encodeURIComponent).join(',')}`, accessToken);
      if (!Array.isArray(v?.items)) throw incomplete('no video details list');
      const got = new Map();
      for (const x of v.items) if (typeof x?.id === 'string' && typeof x?.status?.privacyStatus === 'string') got.set(x.id, x);
      // Every listed video must come back with its status: a missing one could be a scheduled post we did not see.
      for (const id of ids) if (!got.has(id)) throw incomplete('video details missing');
      videos.push(...ids.map((id) => got.get(id)));
    }
  } while (pageToken && pages < cfg.maxPages);
  const { last, count } = latestFutureSchedule(videos, nowMs);
  const recent = [];
  for (const v of videos) {
    if (v?.status?.privacyStatus !== 'public') continue;
    const t = wentPublic.get(v.id);
    if (t !== undefined && t <= nowMs && t > nowMs - RECENT_DAYS * DAY_MS) recent.push(t);
  }
  return { last, count, times: futureScheduleTimes(videos, nowMs), recent: recent.sort((x, y) => x - y), scanned, pages, truncated: Boolean(pageToken) };
}
