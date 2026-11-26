// SPDX-License-Identifier: GPL-3.0-or-later
// Hold (2026-11-26, user: "Hold all for Instagram test"): take every still-private, future-scheduled YouTube video in
// Ujwalam's own posting ledger off its schedule. The video stays private, nothing is deleted; it only no longer goes
// public on its own. Later, YouTube gets only the clips that won on Instagram (auto-post rules youtubeSource).
//   runHold({ dataDir, store, auth, budget, fetchImpl, nowMs, only?, dryRun?, queueFile?, outputsStatus?, updateUnits? })
//     -> { refused } | { held: [id], skipped: [{ id, why }], left, stopped, candidates }
// Per video: videos.list part=snippet,status (1 unit) to confirm it is still private with a future publishAt, then
// videos.update part=status with privacyStatus private and no publishAt (youtube.mjs clearVideoSchedule, 50 units).
// The ledger entry gets heldAt; the upload-queue item (same post id) gets heldAt, so the scheduling manager shows it as
// held and its old time is no longer counted as taken. Resumable: a held entry is never a candidate again; a video that
// YouTube already shows as private with no publishAt (an earlier run stopped after the update) is just marked held.
// Quota: the same counter and stop-for-the-day as rewrite (rewrite.mjs): before each video the run stops when a read plus
// an update would touch the day's read reserve, and reports how many were left. Same lock as rewrite and undo.
// dryRun: counts the candidates only; no sign-in, no call, no write.
// Only the main channel's videos (an entry without `account`): an added channel's video needs that channel's sign-in.
import path from 'node:path';
import { QUEUE_NAME, createUploadQueue } from './auto-chain.mjs';
import { gate, scheduledCandidates, takeLock } from './rewrite.mjs';
import { clearVideoSchedule, getVideoSnippet } from './youtube.mjs';

const READ_UNITS = 1;
/** A video this close to going public is still held: the update takes seconds, and a held video never goes public. */
export const HOLD_MARGIN_MS = 2 * 60 * 1000;
export const HELD_REASON = 'held-instagram-test';
const apiWhy = (e) => (e?.code === 'quota-exceeded' ? 'quota-exceeded' : String(e?.code ?? 'error').slice(0, 40));

/** The ledger's still-scheduled, not yet held videos (the main channel's only), soonest publish time first: the
 *  quota runs out after about 190 videos a day, so the ones about to go public are held first. */
export function holdCandidates({ store, nowMs, only = null }) {
  return scheduledCandidates({ store, nowMs, only, marginMs: HOLD_MARGIN_MS })
    .sort((a, b) => Date.parse(a.entry.publishAt) - Date.parse(b.entry.publishAt));
}

export async function runHold(o) {
  const nowMs = o.nowMs ?? Date.now;
  const cands = holdCandidates({ store: o.store, nowMs: nowMs(), only: o.only });
  if (o.dryRun === true) {
    const other = cands.filter((c) => typeof c.entry.account === 'string').length;
    return { held: [], skipped: [], left: 0, stopped: null, candidates: cands.length, otherChannel: other, dryRun: true };
  }
  const bad = await gate({ flags: { isOn: () => true }, auth: o.auth, outputsStatus: o.outputsStatus });
  if (bad) return { refused: bad };
  const release = takeLock(o.dataDir);
  if (!release) return { refused: 'busy' };
  try { return await holdInner(o, cands, nowMs); } finally { release(); }
}

async function holdInner(o, cands, nowMs) {
  const { store, auth, budget, fetchImpl } = o;
  const queue = createUploadQueue(o.queueFile ?? path.join(o.dataDir, 'posting', QUEUE_NAME), nowMs);
  const held = []; const skipped = []; let stopped = null;
  const need = (o.updateUnits ?? 50) + READ_UNITS;
  const mark = (id, entry) => {
    const at = new Date(nowMs()).toISOString();
    store.ledger.annotate(entry.sha256, entry.target, { heldAt: at });
    if (queue.get(id)) queue.patch(id, { heldAt: at });
    held.push(id);
  };
  for (const { id, entry } of cands) {
    const skip = (why) => { skipped.push({ id, why }); };
    if (typeof entry.account === 'string') { skip('other-channel'); continue; }
    if (budget.writeRoom && budget.writeRoom(need).why) { stopped = 'quota-day-used'; break; }
    const readWhy = (budget.reserveWriteRead ?? budget.reserveRead)(READ_UNITS);
    if (readWhy) { stopped = readWhy; break; }
    let accessToken; try { accessToken = await auth.accessToken(); } catch { stopped = 'not-signed-in'; break; }
    let remote;
    try { remote = await getVideoSnippet({ videoId: entry.videoId, accessToken, fetchImpl }); } catch (e) { if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; } skip(`read-${apiWhy(e)}`); continue; }
    if (!remote.found) { skip('video-not-found'); continue; }
    if (remote.privacyStatus !== 'private') { skip('not-private'); continue; }
    if (typeof remote.publishAt !== 'string' || !remote.publishAt) { mark(id, entry); continue; } // already off its schedule
    if (!(Date.parse(remote.publishAt) > nowMs())) { skip('publish-time-passed'); continue; }
    const updWhy = budget.reserveUpdate();
    if (updWhy) { stopped = updWhy; break; }
    try { await clearVideoSchedule({ videoId: entry.videoId, status: remote.status, accessToken, fetchImpl }); } catch (e) {
      if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; }
      skip(`update-${apiWhy(e)}`); continue; // not marked: the next run reads it again and marks it if it was applied
    }
    mark(id, entry);
  }
  const done = held.length + skipped.length;
  return { held, skipped, left: stopped ? cands.length - done : 0, stopped, candidates: cands.length };
}
