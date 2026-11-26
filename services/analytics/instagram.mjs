// SPDX-License-Identifier: GPL-3.0-or-later
// Instagram winners (user decision 2026-11-26): Instagram is the test bed; every week the Reels that did best on Instagram
// in the week before go to YouTube. This module reads the insights of the Reels Ujwalam posted, keeps them in a local
// SQLite file <data>/analytics/instagram.db (gitignored app data; this module is its only writer), scores each Reel and
// picks the week's winners. It never posts; the auto-post chain queues the winners (auto-post.mjs instagramWinnerCandidates).
//
//   openIgStore(file)                                   -> { upsertReel, addSnapshot, reels, snapshots, meta, promotions, ... }
//   parseInsights(json)                                 -> { metric: number }  (pure)
//   reelScore(metrics, lengthSec)                       -> number | null       (pure, the formula below)
//   collectInstagram({ dataDir, auth, posts?, ... })    -> { reels, snapshots, failed, skipped? }
//   ranking(store, { nowMs, posts })                    -> [{ postId, mediaId, score, eligible, why, ... }] best first
//   weeklyWinners({ dataDir, posts, nowMs, perWeek, dryRun? }) -> { week, ran, winners: [row], ranked? }
// A winner whose package is already uploaded (on YouTube, or held there by hold.mjs) is not promoted (why 'on-youtube'):
// putting a held video back on a schedule is not done here (a YouTube update with quota care; left for later).
//
// Score (reelScore), on the snapshot at 48 h after posting:
//   reach     = max(views, reach, 1)
//   watch     = min(avg watch time / Reel length, 2)            (0 when either is unknown; > 1 = rewatched)
//   engage    = min((likes + 2 comments + 3 saves + 4 shares) / reach, 1)
//   score     = log10(1 + reach) * (2 * watch + 10 * engage)
// Watch time carries most weight (a typical watch ratio of 0.3..1 gives 0.6..2, a typical engagement rate of 2..10 % gives
// 0.2..1); shares and saves count more than likes; log10(reach) keeps a Reel seen by 10 people from beating one seen by
// 10 000 on rates alone. Agent defaults 2026-11-26, not user instructions; tune here.
//
// Window: a week's winners are the Reels posted from 9 to 2 days before the weekly run (seven days of posts, each with
// its full 48 h of numbers). Weekly run: the first call on or after Monday 00:00 local time; its winners are recorded
// (promotions table), so nothing is promoted twice.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { INSIGHTS_SCOPE, InstagramError, graphBase, graphRequest, loadIgConfig } from '../posting/instagram.mjs';
import { IG_QUEUE_NAME, createInstagramQueue } from '../posting/instagram-queue.mjs';

export const IG_DB_NAME = path.join('analytics', 'instagram.db');
export const IG_MIN_INTERVAL_MIN = 60;
export const IG_CHECKPOINTS = Object.freeze({ at48h: 48, at7d: 168 });
/** Snapshots are taken until a Reel is this old (and has its 7 d snapshot); older Reels are not read again. */
export const TRACK_HOURS = 8 * 24;
export const DEFAULT_WINNERS_PER_WEEK = 21;
/** Reel media insights asked for (Graph API media insights, REELS). `views` replaced `plays` in 2025; UNVERIFIED names
 *  are listed in docs/evidence/2026-11-26-instagram-winners.md. Watch times come in milliseconds (UNVERIFIED). */
export const REEL_METRICS = Object.freeze(['views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time']);
/** Asked for again when the full list is refused (Graph error 100: a metric not offered for this media or version). */
export const CORE_METRICS = Object.freeze(['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions']);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW = Object.freeze({ fromDays: 9, toDays: 2 });
const MEDIA_ID = /^\d{1,30}$/;

export function openIgStore(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS reels (media_id TEXT PRIMARY KEY, post_id TEXT, clip_id TEXT, posted_at TEXT, length_sec REAL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, media_id TEXT NOT NULL, fetched_at TEXT NOT NULL,
    age_hours REAL, metrics TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS ig_snapshots_media ON snapshots (media_id, fetched_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS promotions (post_id TEXT PRIMARY KEY, media_id TEXT, week TEXT NOT NULL, promoted_at TEXT NOT NULL,
    score REAL, rank INTEGER)`);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const upsert = db.prepare(`INSERT INTO reels (media_id, post_id, clip_id, posted_at, length_sec) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET post_id = excluded.post_id, clip_id = COALESCE(excluded.clip_id, reels.clip_id),
      posted_at = COALESCE(reels.posted_at, excluded.posted_at), length_sec = COALESCE(excluded.length_sec, reels.length_sec)`);
  const insert = db.prepare('INSERT INTO snapshots (media_id, fetched_at, age_hours, metrics) VALUES (?, ?, ?, ?)');
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const promote = db.prepare('INSERT OR IGNORE INTO promotions (post_id, media_id, week, promoted_at, score, rank) VALUES (?, ?, ?, ?, ?, ?)');
  const prom = (r) => ({ postId: r.post_id, mediaId: r.media_id, week: r.week, promotedAt: r.promoted_at, score: r.score, rank: r.rank });
  return {
    upsertReel: (r) => upsert.run(r.mediaId, r.postId ?? null, r.clipId ?? null, r.postedAt ?? null, Number.isFinite(r.lengthSec) ? r.lengthSec : null),
    addSnapshot: (s) => insert.run(s.mediaId, s.fetchedAt, s.ageHours ?? null, JSON.stringify(s.metrics ?? {})),
    reels: () => db.prepare('SELECT * FROM reels ORDER BY posted_at').all().map((r) => ({
      mediaId: r.media_id, postId: r.post_id, clipId: r.clip_id, postedAt: r.posted_at, lengthSec: r.length_sec })),
    snapshots: (mediaId) => db.prepare('SELECT * FROM snapshots WHERE media_id = ? ORDER BY fetched_at').all(mediaId)
      .map((r) => ({ fetchedAt: r.fetched_at, ageHours: r.age_hours, metrics: parse(r.metrics) ?? {} })),
    meta: (k) => getMeta.get(k)?.value ?? null,
    setMeta: (k, v) => setMeta.run(k, String(v)),
    promote: (p) => promote.run(p.postId, p.mediaId ?? null, p.week, p.promotedAt, p.score ?? null, p.rank ?? null).changes > 0,
    promotions: (week = null) => (week
      ? db.prepare('SELECT * FROM promotions WHERE week = ? ORDER BY rank').all(week)
      : db.prepare('SELECT * FROM promotions ORDER BY week, rank').all()).map(prom),
    promoted: (postId) => !!db.prepare('SELECT 1 FROM promotions WHERE post_id = ?').get(postId),
    close: () => db.close(),
  };
}

/** Graph media insights answer -> { name: number }. Takes values[0].value (the lifetime value) or total_value.value. */
export function parseInsights(json) {
  const out = {};
  for (const d of Array.isArray(json?.data) ? json.data : []) {
    if (typeof d?.name !== 'string' || !/^[a-z_]{1,60}$/.test(d.name)) continue;
    const v = Array.isArray(d.values) ? d.values[0]?.value : d.total_value?.value;
    if (typeof v === 'number' && Number.isFinite(v)) out[d.name] = v;
  }
  return out;
}

/** The score formula (see the head of this file). -> number (3 decimals) or null without metrics. Pure. */
export function reelScore(m, lengthSec) {
  if (!m || typeof m !== 'object') return null;
  const n = (k) => (Number.isFinite(m[k]) && m[k] > 0 ? m[k] : 0);
  const seen = Math.max(n('views'), n('reach'));
  const reach = Math.max(seen, 1);
  const avgSec = Number.isFinite(m.ig_reels_avg_watch_time) ? m.ig_reels_avg_watch_time / 1000 : null;
  const watch = avgSec !== null && Number.isFinite(lengthSec) && lengthSec > 0 ? Math.min(avgSec / lengthSec, 2) : 0;
  const engage = Math.min((n('likes') + 2 * n('comments') + 3 * n('saved') + 4 * n('shares')) / reach, 1);
  return Math.round(Math.log10(1 + seen) * (2 * watch + 10 * engage) * 1000) / 1000;
}

/** One Reel's insights. Error 100 on the full list (a metric not offered) -> the core list. A permission refusal ->
 *  'insights-scope-missing'. */
export async function readReelInsights({ fetchImpl = fetch, endpoints, cfg, token, mediaId }) {
  if (!MEDIA_ID.test(String(mediaId))) throw new InstagramError('bad-media-id', 'not an Instagram media id');
  const ask = (metrics) => graphRequest(fetchImpl, 'GET', `${graphBase(endpoints, cfg)}/${mediaId}/insights`, { params: { metric: metrics.join(','), access_token: token } });
  try {
    return parseInsights(await ask(REEL_METRICS));
  } catch (e) {
    if (e?.code === 'not-permitted') throw new InstagramError('insights-scope-missing', 'connect Instagram again to allow reading insights');
    if (e?.code !== 'graph-error' || e.metaCode !== 100) throw e;
  }
  try {
    return parseInsights(await ask(CORE_METRICS));
  } catch (e) {
    if (e?.code === 'not-permitted') throw new InstagramError('insights-scope-missing', 'connect Instagram again to allow reading insights');
    throw e;
  }
}

const ms = (s) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const lengthOf = (p) => (p && Number.isFinite(p.endSec) && Number.isFinite(p.startSec) && p.endSec > p.startSec ? p.endSec - p.startSec : null);

/** The Reels Ujwalam posted: the Instagram queue's done jobs with a media id. posts: post views by id (for clip and length). */
export function postedReels(dataDir, posts = new Map()) {
  const q = createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME));
  return q.items().filter((i) => i.state === 'done' && MEDIA_ID.test(String(i.mediaId ?? '')) && ms(i.postedAt) !== null)
    .map((i) => { const p = posts.get(i.id); return { mediaId: String(i.mediaId), postId: i.id, clipId: p?.clipId ?? null, postedAt: i.postedAt, lengthSec: lengthOf(p) }; });
}

const postMap = (posts) => (posts instanceof Map ? posts : new Map((Array.isArray(posts) ? posts : []).map((p) => [p.id, p])));

/**
 * Reads the insights of every tracked Reel and stores one snapshot each. At most one run per IG_MIN_INTERVAL_MIN unless
 * forced (quota care). Fails closed: not connected -> 'reauth-needed'; the saved sign-in lacks the insights permission
 * -> 'insights-scope-missing' (nothing is asked). A rate limit stops the run; what was read is kept.
 * opts: { dataDir, auth (createInstagramAuth), posts?, fetchImpl?, endpoints?, cfg?, now?, force?, store? }
 */
export async function collectInstagram({ dataDir, auth, posts = [], fetchImpl = fetch, endpoints, cfg, now = () => Date.now(), force = false, store: given }) {
  const store = given ?? openIgStore(path.join(dataDir, IG_DB_NAME));
  try {
    const last = store.meta('lastFetchAt');
    if (!force && last && now() - Date.parse(last) < IG_MIN_INTERVAL_MIN * 60_000) return { skipped: 'recent', lastFetchAt: last, reels: 0, snapshots: 0, failed: 0 };
    const st = await auth.status();
    if (!st?.connected) throw new InstagramError('reauth-needed', 'Instagram is not connected');
    if (st.insightsAllowed === false) throw new InstagramError('insights-scope-missing', `connect Instagram again to allow ${INSIGHTS_SCOPE}`);
    const reels = postedReels(dataDir, postMap(posts));
    for (const r of reels) store.upsertReel(r);
    const t = now();
    const due = store.reels().filter((r) => {
      const posted = ms(r.postedAt);
      if (posted === null) return false;
      if (t - posted <= TRACK_HOURS * HOUR) return true;
      return !store.snapshots(r.mediaId).some((s) => s.ageHours >= IG_CHECKPOINTS.at7d); // one late 7 d read if it was missed
    });
    store.setMeta('lastFetchAt', new Date(t).toISOString());
    if (!due.length) return { reels: reels.length, snapshots: 0, failed: 0 };
    const { token } = await auth.session();
    const c = cfg ?? loadIgConfig();
    const at = new Date(t).toISOString();
    let n = 0; let failed = 0; let stopped = null;
    for (const r of due) {
      let m;
      try { m = await readReelInsights({ fetchImpl, endpoints, cfg: c, token, mediaId: r.mediaId }); } catch (e) {
        if (['insights-scope-missing', 'reauth-needed'].includes(e?.code)) throw e;
        if (e?.code === 'rate-limited') { stopped = 'rate-limited'; break; }
        failed += 1; continue; // a deleted Reel or a one-off error: no snapshot this time
      }
      store.addSnapshot({ mediaId: r.mediaId, fetchedAt: at, ageHours: Math.round(((t - ms(r.postedAt)) / HOUR) * 100) / 100, metrics: m });
      n += 1;
    }
    return { reels: reels.length, snapshots: n, failed, ...(stopped ? { stopped } : {}) };
  } finally {
    if (!given) store.close();
  }
}

/** Per Reel: latest snapshot, the first at or after 48 h and 7 d. */
export function igSummary(store) {
  return store.reels().map((r) => {
    const snaps = store.snapshots(r.mediaId);
    const first = (h) => snaps.find((s) => typeof s.ageHours === 'number' && s.ageHours >= h) ?? null;
    return { ...r, latest: snaps.at(-1) ?? null, at48h: first(IG_CHECKPOINTS.at48h), at7d: first(IG_CHECKPOINTS.at7d) };
  });
}

/** Monday 00:00 local time on or before nowMs -> { key: 'YYYY-MM-DD', startMs }. */
export function weekOf(nowMs) {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const p = (x) => String(x).padStart(2, '0');
  return { key: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, startMs: d.getTime() };
}

/**
 * Every Reel posted inside the window before `atMs` (9..2 days back), scored on its 48 h snapshot, best first.
 * eligible = may go to YouTube now: scored, never promoted, and its package is still approved (an uploaded package is
 * already on YouTube or held there: why 'on-youtube'). posts: post views (id -> { status, target, title, ... }).
 */
export function ranking(store, { atMs, posts = [] }) {
  const byId = postMap(posts);
  const from = atMs - WINDOW.fromDays * DAY; const to = atMs - WINDOW.toDays * DAY;
  const rows = [];
  for (const r of igSummary(store)) {
    const posted = ms(r.postedAt);
    if (posted === null || posted < from || posted >= to) continue;
    const snap = r.at48h;
    const p = byId.get(r.postId);
    const score = snap ? reelScore(snap.metrics, r.lengthSec) : null;
    let why = null;
    if (score === null) why = 'no-48h-numbers';
    else if (store.promoted(r.postId)) why = 'already-promoted';
    else if (!p) why = 'package-missing';
    else if (p.status === 'uploaded') why = 'on-youtube';
    else if (p.status !== 'approved') why = 'not-approved';
    rows.push({ postId: r.postId, mediaId: r.mediaId, clipId: r.clipId, title: p?.title ?? null, postedAt: r.postedAt, lengthSec: r.lengthSec,
      score, metrics: snap?.metrics ?? null, eligible: why === null, why });
  }
  return rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.postedAt).localeCompare(String(b.postedAt)));
}

/**
 * This week's winners. The first call of a week (Monday 00:00 local or later) ranks the window and records the top
 * `perWeek` eligible Reels; later calls in the same week return the same recorded list. dryRun: ranks only, records
 * nothing. -> { week, ran, winners: [{ postId, score, rank, ... }], ranked } (ranked only with dryRun or on the run).
 */
export function weeklyWinners({ dataDir, posts = [], nowMs = Date.now(), perWeek = DEFAULT_WINNERS_PER_WEEK, dryRun = false, store: given }) {
  const store = given ?? openIgStore(path.join(dataDir, IG_DB_NAME));
  try {
    const wk = weekOf(nowMs);
    const n = Number.isInteger(perWeek) && perWeek > 0 ? perWeek : DEFAULT_WINNERS_PER_WEEK;
    if (!dryRun && store.meta('lastWeek') === wk.key) return { week: wk.key, ran: false, winners: store.promotions(wk.key) };
    // the run's window is anchored at Monday 00:00 (a first start on Wednesday picks the same Reels); a dry run previews
    // the window ending now
    const ranked = ranking(store, { atMs: dryRun ? nowMs : wk.startMs, posts });
    const top = ranked.filter((r) => r.eligible).slice(0, n).map((r, i) => ({ ...r, rank: i + 1 }));
    if (dryRun) return { week: wk.key, ran: false, dryRun: true, winners: top, ranked };
    const at = new Date(nowMs).toISOString();
    for (const w of top) store.promote({ postId: w.postId, mediaId: w.mediaId, week: wk.key, promotedAt: at, score: w.score, rank: w.rank });
    store.setMeta('lastWeek', wk.key);
    return { week: wk.key, ran: true, winners: store.promotions(wk.key), ranked };
  } finally {
    if (!given) store.close();
  }
}

/** Score per post id (latest 48 h score) for the scheduling manager. Read only; {} when there is no store yet. */
export function igScores(store) {
  const out = {};
  for (const r of igSummary(store)) { const s = r.at48h ? reelScore(r.at48h.metrics, r.lengthSec) : null; if (r.postId && s !== null) out[r.postId] = s; }
  return out;
}
