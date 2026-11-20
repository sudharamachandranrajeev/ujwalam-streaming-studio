// SPDX-License-Identifier: GPL-3.0-or-later
// D403 Delete full recordings once Ujwalam has processed them (flag delete-processed-recordings, ON by default: user
// request 2026-11-19, "make sure to remove the full recording after Ujwalam done processing everything in that video").
// Node stdlib only.
//
// What counts as processed: record-clips.mjs appends one line per finished clip job to <data>/clips/jobs.jsonl
// ({ h, v, type, kind, name, result, code, reelsNotMade, at }). A recording session is its H file plus its V file (job.h,
// job.v). It is deleted for good only when ALL of these hold:
//   1. the flag is on;
//   2. the studio is neither live nor recording (the latest outputs.status; no status = refused);
//   3. it has at least one finished clip job, and for each job type that used it (full run, review run) the latest one
//      ended well (exit 0) with its reels made when a V file was there;
//   4. no clip job that uses it is running, queued or waiting for the "make clips?" answer;
//   5. it is not on the Keep for labelling list (<data>/clips/keep-for-labelling.json, ticked in Settings > Clips);
//   6. each file is inside the configured recordings folder (by its real path; never through a link that leads out),
//      a regular file, the same file (by file id) right before the delete, and not held open by another program
//      (services/common/safe-delete.mjs, the same steps as posted clips; the file is not hashed: recordings are large,
//      the file id, size and modified time are checked through one handle instead).
// A recording with no clip job at all is never deleted: Ujwalam did not process it.
// Every deletion: one line in <data>/clips/deleted-recordings.jsonl ({ file, size, fileId, reason, at }); one task bar
// line per batch ("Deleted N recordings, freed X GB").
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeDeleteFile } from '../common/safe-delete.mjs';

export const CLEANUP_FLAG = 'delete-processed-recordings';
export const JOBS_LOG = 'jobs.jsonl';
export const DELETED_RECORDINGS_LOG = 'deleted-recordings.jsonl';
export const KEEP_FILE = 'keep-for-labelling.json';
const ACTIVE = new Set(['starting', 'live', 'reconnecting', 'retrying']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const key = (p) => (typeof p === 'string' && p ? path.resolve(p).toLowerCase() : null);
/** The session name of a recording: its H file name without the extension (as record-clips.mjs names its jobs). */
export const sessionName = (h) => path.basename(String(h ?? '')).replace(/\.[^.]+$/, '');

const clipsDir = (dataDir) => path.join(dataDir, 'clips');
const readLines = (file) => { try { return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(isPlain); } catch { return []; } };

/** One finished clip job (record-clips.mjs calls this when a job ends). Never throws. */
export function appendJobRecord(dataDir, rec) {
  try { mkdirSync(clipsDir(dataDir), { recursive: true }); appendFileSync(path.join(clipsDir(dataDir), JOBS_LOG), `${JSON.stringify(rec)}\n`); } catch { /* the next job writes again */ }
}
export const readJobRecords = (dataDir) => readLines(path.join(clipsDir(dataDir), JOBS_LOG));
export const readDeletedRecordings = (dataDir) => readLines(path.join(clipsDir(dataDir), DELETED_RECORDINGS_LOG));

/** The Keep for labelling list: session names (lower case). A file that cannot be read keeps EVERYTHING (fail closed). */
export function readKeepList(dataDir) {
  const f = path.join(clipsDir(dataDir), KEEP_FILE);
  if (!existsSync(f)) return { all: false, names: new Set() };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!isPlain(j) || !Array.isArray(j.sessions)) return { all: true, names: new Set() };
    return { all: false, names: new Set(j.sessions.filter((s) => typeof s === 'string').map((s) => s.toLowerCase())) };
  } catch { return { all: true, names: new Set() }; }
}

/** Ticks or unticks one session on the Keep for labelling list (atomic write). -> the list. */
export function setKeep(dataDir, name, keep) {
  if (typeof name !== 'string' || !/^[^\\/:*?"<>|]{1,200}$/.test(name)) throw Object.assign(new Error('bad session name'), { code: 'bad-name' });
  const cur = readKeepList(dataDir);
  if (cur.all) throw Object.assign(new Error('the Keep for labelling list cannot be read'), { code: 'keep-unreadable' });
  const names = new Set(cur.names);
  if (keep) names.add(name.toLowerCase()); else names.delete(name.toLowerCase());
  const f = path.join(clipsDir(dataDir), KEEP_FILE);
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ $comment: 'Recordings kept for labelling (Settings > Clips, D403): never deleted by Delete clipped recordings.', sessions: [...names].sort() }, null, 2)}\n`);
  renameSync(tmp, f);
  return [...names].sort();
}

const statusActive = (status) => {
  const sinks = Array.isArray(status?.sinks) ? status.sinks : [];
  return sinks.some((s) => (s?.kind === 'stream' || s?.kind === 'record') && ACTIVE.has(s.state));
};

/**
 * Every processed recording session with its verdict. Pure apart from reading the data dir's logs and the keep list.
 * state: { running, queued: [], asks: [] } from record-clips (jobs that use a file). -> [{ name, h, v, reason }] where
 * reason null = may be deleted now.
 */
export function cleanupPlan({ dataDir, state = {}, records = readJobRecords(dataDir), keepList = readKeepList(dataDir), deleted = readDeletedRecordings(dataDir) }) {
  const sessions = new Map();
  for (const r of records) {
    const h = key(r.h); if (!h) continue; // a stream without a recording made no file to delete
    if (!sessions.has(h)) sessions.set(h, { h: r.h, v: null, recs: [] });
    const s = sessions.get(h); s.recs.push(r); if (typeof r.v === 'string' && r.v) s.v = r.v;
  }
  const pending = new Set();
  for (const j of [state.running, ...(state.queued ?? []), ...(state.asks ?? [])]) { if (isPlain(j)) { const a = key(j.h); const b = key(j.v); if (a) pending.add(a); if (b) pending.add(b); } }
  const gone = new Set(deleted.map((d) => key(d.file)).filter(Boolean));
  const out = [];
  for (const [h, s] of sessions) {
    const name = sessionName(s.h);
    if (gone.has(h) && (!s.v || gone.has(key(s.v)))) continue; // deleted already
    const latest = new Map();
    for (const r of s.recs) { const t = r.type === 'review' ? 'review' : 'full'; const p = latest.get(t); if (!p || String(r.at) >= String(p.at)) latest.set(t, r); }
    let reason = null;
    if ([...latest.values()].some((r) => r.result !== 'done' || r.code !== 0)) reason = 'job-failed';
    else if (s.v && [...latest.values()].some((r) => typeof r.reelsNotMade === 'string' && r.reelsNotMade)) reason = 'reels-not-made';
    else if (pending.has(h) || (s.v && pending.has(key(s.v)))) reason = 'job-pending';
    else if (keepList.all || keepList.names.has(name.toLowerCase())) reason = 'kept-for-labelling';
    out.push({ name, h: s.h, v: s.v, reason });
  }
  return out;
}

/**
 * One cleanup pass. folder: the configured recordings folder. status: the latest outputs.status (null = unknown: refused).
 * -> { ran, refused?, deleted: [{ file, size }], kept: [{ file, reason }] }.
 */
export async function runRecordingCleanup({ dataDir, folder, flagOn, status, state = {}, nowMs = Date.now(), log = () => {}, writeTask = null, deleteImpl = safeDeleteFile }) {
  const res = { ran: false, deleted: [], kept: [] };
  if (flagOn !== true) return { ...res, refused: 'flag-off' };
  if (typeof folder !== 'string' || !folder || !existsSync(folder)) return { ...res, refused: 'no-recordings-folder' };
  if (!isPlain(status)) return { ...res, refused: 'state-unknown' };
  if (statusActive(status)) return { ...res, refused: 'live-or-recording' };
  res.ran = true;
  const logFile = path.join(clipsDir(dataDir), DELETED_RECORDINGS_LOG);
  for (const s of cleanupPlan({ dataDir, state })) {
    if (s.reason) { res.kept.push({ file: s.h, reason: s.reason }); continue; }
    for (const file of [s.h, s.v].filter((f) => typeof f === 'string' && f)) {
      if (!existsSync(file)) continue; // gone already (deleted by hand, or the other half of a session deleted earlier)
      const r = await deleteImpl({ file, folder, hash: false });
      if (!r.deleted) { res.kept.push({ file, reason: r.reason }); continue; }
      const at = new Date(nowMs).toISOString();
      res.deleted.push({ file, size: r.size });
      try {
        mkdirSync(path.dirname(logFile), { recursive: true });
        appendFileSync(logFile, `${JSON.stringify({ file, size: r.size, fileId: `${r.id.dev}:${r.id.ino}`, reason: 'clipped-and-reviewed', session: s.name, at })}\n`);
      } catch { /* the file is gone either way; the task bar line still says so */ }
    }
  }
  if (res.deleted.length) {
    const bytes = res.deleted.reduce((n, d) => n + (Number(d.size) || 0), 0);
    const gb = (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1);
    const n = res.deleted.length;
    const title = `Deleted ${n} recording${n === 1 ? '' : 's'}, freed ${gb} GB`;
    log(`clips: ${title} (listed in clips/${DELETED_RECORDINGS_LOG})`);
    if (typeof writeTask === 'function') {
      try { writeTask(dataDir, { id: `rec-deleted-${nowMs}`, kind: 'clips', title, state: 'done', startedAt: nowMs, updatedAt: nowMs, note: 'Deleted permanently: every clip from them is made and reviewed (Delete clipped recordings)' }); } catch { /* the log has it */ }
    }
  }
  return res;
}
