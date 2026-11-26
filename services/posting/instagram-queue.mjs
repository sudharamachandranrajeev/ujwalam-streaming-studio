// SPDX-License-Identifier: GPL-3.0-or-later
// D444 IP2: Instagram Reels jobs for the auto-post chain (user 2026-11-24: "same clips as Shorts", "maximum allowed posts
// a day"). Node stdlib only. Plan: docs/plan/2026-11-24-instagram-autopost.md.
//   createInstagramQueue(file)   -> the job list <data>/posting/instagram-queue.json (post ids, states, times, ids; no token)
//   createInstagramPoster(opts)  -> { wants(), sync(ytItems, store), pass(store), holdsFile(postId), summary(), resetPass() }
//   queueInstagramNow(dataDir, id) -> `cli.mjs instagram post`: that clip first, due now (every check still applies)
// Rules:
//   - Every clip the chain queues for YouTube Shorts (target youtube-shorts, not failed, file not deleted) gets one job,
//     only while Instagram is wanted (flag instagram-autopost on AND connected). Not wanted = nothing changes: the chain
//     behaves exactly as before.
//   - The Graph API has no scheduled publish: each job holds its own time (dueAt), at least the auto-post gap after the
//     latest other job's time. The running app publishes it when due; a time missed while the app was closed posts at the
//     next start, still at least the gap after the last real Instagram post (no burst). One post per pass.
//   - No daily cap of Ujwalam's own: Meta's moving-24 h limit is read before every post (instagram.mjs); none left = wait.
//   - Never while any stream output is live or starting, or when that cannot be read (the chain's liveBlock), checked
//     before the pass and again before each request that changes something.
//   - Data-loss rule: holdsFile(postId) is decided by the queue: a job not done (waiting, posting, failed) keeps the file
//     whatever the flag or connection say; only the user's one-click "Drop Instagram queue" (dropQueue) releases it. With
//     no job, only a Shorts post that sync would add is held (while wanted or unreadable). The chain's delete pass asks.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLimits } from './index.mjs';
import { IG_FLAG, InstagramError, loadIgConfig, publishReel, reelCaption } from './instagram.mjs';

export const IG_QUEUE_NAME = 'instagram-queue.json';
const SHORTS = 'youtube-shorts';
const WAIT_MS = 30 * 60 * 1000;
const LIMIT_WAIT_MS = 60 * 60 * 1000;
const FINAL = new Set(['over-limit', 'video-missing', 'not-approved', 'unknown-post']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => new Date(t).toISOString();
const ms = (s) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };

export const IG_REASON_TEXT = Object.freeze({
  'stream-live': 'Waiting until the stream ends',
  'output-state-unreadable': 'Waiting: could not confirm that no stream is live',
  'reauth-needed': 'Instagram is not connected (or the sign-in expired): click Connect',
  'no-app': 'Save the Meta App ID and App Secret, then click Connect',
  'limit-reached': "Waiting: Instagram's limit of posts in 24 hours is used up",
  'rate-limited': 'Waiting: Instagram asked to slow down',
  'processing-timeout': 'Instagram is still processing the video; checked again shortly',
  'over-limit': 'The caption is over an Instagram limit (2200 characters, 30 hashtags, 20 mentions); edit it in the Posts view',
  'video-missing': 'The video file is missing',
  'not-approved': 'The package is not approved',
  'unknown-post': 'The package was not found',
  'request-timeout': 'Waiting: Instagram did not answer in time',
  'network-error': 'Waiting: Instagram could not be reached',
  'container-unknown': 'Waiting: the started Instagram upload could not be checked; checked again shortly',
  'dropped-by-user': 'Dropped from the Instagram queue by you',
});
export const igReasonText = (code) => (code ? IG_REASON_TEXT[code] ?? `Instagram post failed (${String(code).slice(0, 40)})` : null);

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2));
  renameSync(`${file}.tmp`, file);
}

export function createInstagramQueue(file, now = () => Date.now()) {
  const read = () => { try { const j = JSON.parse(readFileSync(file, 'utf8')); if (isPlain(j) && isPlain(j.items)) return j; } catch { /* new list */ } return { version: 1, items: {}, lastPostedAt: null }; };
  const write = (j) => writeJsonAtomic(file, j);
  return {
    file,
    items: () => Object.values(read().items),
    get: (id) => read().items[id] ?? null,
    lastPostedAt: () => read().lastPostedAt ?? null,
    add(id, dueAt) {
      const j = read();
      if (Object.hasOwn(j.items, id)) return false;
      const at = iso(now());
      j.items[id] = { id, state: 'waiting', dueAt, attempts: 0, nextAt: null, reason: null, containerId: null, mediaId: null, postedAt: null, enqueuedAt: at, updatedAt: at };
      write(j); return true;
    },
    patch(id, fields) {
      const j = read(); const it = j.items[id]; if (!it) return null;
      Object.assign(it, fields, { updatedAt: iso(now()) });
      if (fields.state === 'done' && fields.postedAt) j.lastPostedAt = fields.postedAt;
      write(j); return it;
    },
    /** A crash mid-post leaves 'posting': waiting again; its container id is kept, so the next try resumes it. */
    recover() {
      const j = read(); let n = 0;
      for (const it of Object.values(j.items)) if (it.state === 'posting') { it.state = 'waiting'; it.reason = 'interrupted'; n++; }
      if (n) write(j);
      return n;
    },
  };
}

/** `cli.mjs instagram post --id`: the clip goes first, due now (added if new; a failed job is tried again). */
export function queueInstagramNow(dataDir, id, nowMs = Date.now()) {
  const q = createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME), () => nowMs);
  if (!q.add(id, iso(nowMs))) {
    const it = q.get(id);
    if (it.state !== 'done') q.patch(id, { state: 'waiting', dueAt: iso(nowMs), nextAt: null, attempts: 0, reason: null });
  }
  return q.get(id);
}

/**
 * opts: { dataDir, flags ({ isOn }), auth (createInstagramAuth), liveBlock: async () => code|null, gapMs: () => ms,
 *         nowMs?, log?, fetchImpl?, endpoints?, cfg?, sleep?, limits?, halted?: () => bool }
 */
export function createInstagramPoster(opts) {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const queue = createInstagramQueue(path.join(opts.dataDir, 'posting', IG_QUEUE_NAME), nowMs);
  let recovered = false;
  // One Credential Manager read per pass (resetPass): 'yes' | 'no' | 'unknown'
  let wantCache = null;
  async function wants() {
    if (!opts.flags.isOn(IG_FLAG)) return 'no';
    if (wantCache) return wantCache;
    try { const s = await opts.auth.status(); wantCache = s?.connected === true ? 'yes' : 'no'; } catch { wantCache = 'unknown'; }
    return wantCache;
  }
  const gap = () => { const g = opts.gapMs?.(); return Number.isFinite(g) && g > 0 ? g : 60 * 60 * 1000; };

  /** Adds a job for each Shorts clip in the YouTube queue that has none (only while Instagram is wanted). -> added count. */
  async function sync(ytItems, store) {
    if ((await wants()) !== 'yes') return 0;
    let added = 0;
    const known = new Set(queue.items().map((i) => i.id));
    for (const it of ytItems) {
      if (known.has(it.id) || it.state === 'failed' || it.deleteState === 'deleted') continue;
      const post = store.get(it.id);
      if (!post || post.target !== SHORTS) continue;
      const taken = queue.items().map((i) => ms(i.postedAt) ?? ms(i.dueAt)).filter((t) => t !== null);
      const due = Math.max(nowMs(), taken.length ? Math.max(...taken) + gap() : nowMs());
      if (queue.add(it.id, iso(due))) { added++; known.add(it.id); }
    }
    if (added) log(`posting: ${added} clip(s) added to the Instagram queue`);
    return added;
  }

  /** True while the clip's file must be kept for Instagram (review D444):
   *   - a job exists: decided by the queue alone (kept until done or dropped by the user), whatever the flag or the
   *     connection says now, so switching Instagram off never deletes a file it was still going to post;
   *   - no job yet: kept only when sync would add one (a Shorts post not failed on YouTube) and Instagram is wanted or its
   *     state cannot be read. Long videos and YouTube-failed items are never held. */
  async function holdsFile(postId, { target = null, ytState = null } = {}) {
    const job = queue.get(postId);
    if (job) return job.state !== 'done' && job.state !== 'dropped';
    if (target !== SHORTS || ytState === 'failed') return false;
    return (await wants()) !== 'no';
  }

  /** "Drop Instagram queue" (one click, D332): every job not posted yet is dropped (never posted, never re-added), so its
   *  file is no longer held. Posted jobs stay. -> number dropped. */
  function dropQueue() {
    let n = 0;
    for (const it of queue.items()) if (it.state !== 'done' && it.state !== 'dropped') { queue.patch(it.id, { state: 'dropped', reason: 'dropped-by-user', nextAt: null }); n++; }
    if (n) log(`posting: dropped ${n} clip(s) from the Instagram queue`);
    return n;
  }

  /** Posts at most one due job. -> { posted?: id, skipped?: reason } */
  async function pass(store) {
    if ((await wants()) !== 'yes') return { skipped: 'not-wanted' };
    if (opts.halted?.()) return { skipped: 'stopped' };
    if (!recovered) { recovered = true; queue.recover(); }
    const t = nowMs();
    const due = queue.items().filter((i) => i.state === 'waiting' && ms(i.dueAt) !== null && ms(i.dueAt) <= t && (!i.nextAt || ms(i.nextAt) <= t))
      .sort((a, b) => ms(a.dueAt) - ms(b.dueAt));
    if (!due.length) return { skipped: 'none-due' };
    const last = ms(queue.lastPostedAt());
    if (last !== null && t - last < gap()) return { skipped: 'gap' };
    const blocked = await opts.liveBlock();
    if (blocked) { const why = blocked === 'output-live' ? 'stream-live' : blocked; for (const i of due) if (i.reason !== why) queue.patch(i.id, { reason: why }); return { skipped: why }; }
    const job = due[0];
    const post = store.get(job.id);
    const fail = (code) => { queue.patch(job.id, { state: 'failed', reason: code }); log(`posting: Instagram: ${igReasonText(code)}`); return { skipped: code }; };
    if (!post) return fail('unknown-post');
    if (post.status !== 'approved' && post.status !== 'uploaded') return fail('not-approved');
    const cap = reelCaption(post, opts.limits ?? loadLimits());
    if (!cap.ok) return fail('over-limit');
    const video = store.media(job.id, 'video');
    if (!video) return fail('video-missing');
    let cfg;
    try { cfg = opts.cfg ?? loadIgConfig(); } catch { queue.patch(job.id, { reason: 'bad-config', nextAt: iso(t + WAIT_MS) }); return { skipped: 'bad-config' }; }
    queue.patch(job.id, { state: 'posting', reason: null });
    try {
      const r = await publishReel({ auth: opts.auth, videoPath: video.file, caption: cap.caption, cfg, fetchImpl: opts.fetchImpl, endpoints: opts.endpoints, sleep: opts.sleep,
        resumeContainer: job.containerId ?? undefined,
        onContainer: (id) => queue.patch(job.id, { containerId: id }),
        beforeStep: async () => {
          if (opts.halted?.()) throw new InstagramError('stopped-by-user', 'stopped');
          const b = await opts.liveBlock();
          if (b) throw new InstagramError(b === 'output-live' ? 'stream-live' : b, 'a stream is live or starting');
        } });
      const at = iso(nowMs());
      queue.patch(job.id, { state: 'done', mediaId: r.mediaId, postedAt: at, reason: null, containerId: null });
      log(`posting: posted 1 clip to Instagram${Number.isFinite(r.left) ? ` (${r.left} left in Instagram's 24 hours)` : ''}`);
      return { posted: job.id };
    } catch (e) {
      const code = typeof e?.code === 'string' ? e.code : 'error';
      const later = (w, extra = {}) => queue.patch(job.id, { state: 'waiting', reason: code, nextAt: iso(nowMs() + w), ...extra });
      if (['stream-live', 'output-state-unreadable', 'stopped-by-user'].includes(code)) later(0);
      else if (code === 'reauth-needed' || code === 'no-app') { wantCache = null; later(WAIT_MS); }
      else if (code === 'limit-reached' || code === 'rate-limited') later(LIMIT_WAIT_MS);
      else if (code === 'processing-timeout' || code === 'request-timeout' || code === 'network-error' || code === 'container-unknown') later(cfg.pollEveryMs * 12);
      else if (FINAL.has(code)) fail(code);
      else {
        const attempts = (job.attempts ?? 0) + 1;
        const drop = code === 'container-error' || code === 'container-expired' ? { containerId: null } : {};
        if (attempts >= cfg.maxAttempts) queue.patch(job.id, { state: 'failed', attempts, reason: code.slice(0, 40), ...drop });
        else later(cfg.retryMinutes * 60 * 1000 * 2 ** (attempts - 1), { attempts, ...drop });
      }
      log(`posting: Instagram: ${igReasonText(code)}`);
      return { skipped: code };
    }
  }

  function summary() {
    const items = queue.items();
    const n = (s) => items.filter((i) => i.state === s).length;
    const waiting = items.filter((i) => i.state === 'waiting');
    const reason = waiting.find((i) => i.reason)?.reason ?? null;
    return { waiting: n('waiting'), posting: n('posting'), done: n('done'), failed: n('failed'), dropped: n('dropped'), nextAt: waiting.map((i) => i.dueAt).filter(Boolean).sort()[0] ?? null,
      lastPostedAt: queue.lastPostedAt(), reason, reasonText: igReasonText(reason) };
  }

  // auth/net: the same sign-in and test seams for the insights reader (Instagram winners, 2026-11-26)
  return { queue, wants, sync, holdsFile, dropQueue, pass, summary, resetPass: () => { wantCache = null; },
    auth: opts.auth, net: { fetchImpl: opts.fetchImpl, endpoints: opts.endpoints, cfg: opts.cfg } };
}

/** Per-clip Instagram state for the posts list and the Settings section: { [postId]: { state, dueAt, postedAt, reason } }. */
export function readInstagramStates(dataDir) {
  const q = createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME));
  return Object.fromEntries(q.items().map((i) => [i.id, { state: i.state, dueAt: i.dueAt ?? null, postedAt: i.postedAt ?? null, reason: i.reason ?? null }]));
}
