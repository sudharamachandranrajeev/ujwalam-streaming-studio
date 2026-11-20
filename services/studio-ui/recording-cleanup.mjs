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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkInFolder, safeDeleteFile } from '../common/safe-delete.mjs';
import { clipsFolder } from './user-settings.mjs';

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
  // Once: recordings clipped before jobs.jsonl existed get a job record only where the old run files prove it.
  try { const b = backfillJobRecords({ dataDir, folder, nowMs }); if (b.ran) log(`clips: earlier recordings checked: ${b.proven} proven processed, ${b.kept} kept (clips/${BACKFILL_LOG})`); } catch { /* kept */ }
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

// ---- One-time backfill for recordings clipped before jobs.jsonl existed ------------------------------------------------
// User, 2026-11-20: "Delete if clips exist". What earlier builds left per run (read 2026-11-20 from record-clips.mjs and
// clipper.py): <data>/clips/runs/<stem>/render.json { recording: <H file NAME> }, report.json { results: [{ ok }] },
// published.json / montage/published.json { files: [{ file: <path in the clips folder> }] }. No size, file id or exit
// code was recorded, and render.json's duration needs ffprobe to compare, so the identity is the name: a recording
// directly in the recordings folder whose run folder (same base name) has a render.json naming exactly that file.
// It is proven ("clips-exist") when that run made at least one clip that still exists in the clips folder, or that
// report.json lists as ok. Its V recording is the same session's <stem>-v.<ext> (stream-setup.mjs vRecordName), taken
// only with a qualifying H; a V file with no H partner is kept. A proven recording gets one job record
// ({ type: 'full', backfill: true }); every other cleanup condition (Keep for labelling, off air, no job pending, the
// safe-delete checks) still applies. Each verdict goes to <data>/clips/backfill-recordings.jsonl, whose existence marks
// the backfill as done.
export const BACKFILL_LOG = 'backfill-recordings.jsonl';
const REC_EXT = /\.(mkv|mp4|mov|flv|ts|m4v)$/i;
const readJson = (f) => { try { const j = JSON.parse(readFileSync(f, 'utf8')); return isPlain(j) ? j : null; } catch { return null; } };
const vStem = (stem) => /-v$/i.test(stem);

/** Does an old run prove clips were made from `file`? -> { proven, reason, clips } (reads only). */
export function backfillVerdict({ dataDir, file, clipsDirOf = clipsFolder }) {
  const stem = sessionName(file);
  const run = path.join(clipsDir(dataDir), 'runs', stem);
  const render = readJson(path.join(run, 'render.json'));
  if (!render) return { proven: false, reason: 'no-run-folder', clips: 0 };
  if (String(render.recording ?? '').toLowerCase() !== path.basename(file).toLowerCase()) return { proven: false, reason: 'run-is-for-another-file', clips: 0 };
  let root = null; try { root = clipsDirOf(dataDir); } catch { /* the clips folder is unknown: only report.json counts */ }
  let clips = 0;
  for (const p of [path.join(run, 'published.json'), path.join(run, 'montage', 'published.json')]) {
    const files = readJson(p)?.files;
    if (!Array.isArray(files)) continue;
    for (const r of files) { const f = typeof r?.file === 'string' ? (path.isAbsolute(r.file) ? r.file : root && path.join(root, r.file)) : null; if (f && existsSync(f)) clips++; }
  }
  const okInReport = (readJson(path.join(run, 'report.json'))?.results ?? []).filter((r) => r?.ok === true).length;
  if (clips > 0 || okInReport > 0) return { proven: true, reason: 'clips-exist', clips: Math.max(clips, okInReport) };
  return { proven: false, reason: 'no-clips', clips: 0 };
}

/** The backfill's verdicts and the job records it would write (reads only). -> { done, verdicts: [{ file, size, decision,
 *  reason, session }], records: [] }. done: it ran before (the log exists), nothing to add. */
export function planBackfill({ dataDir, folder, nowMs = Date.now(), clipsDirOf = clipsFolder }) {
  if (existsSync(path.join(clipsDir(dataDir), BACKFILL_LOG))) return { done: true, verdicts: [], records: [] };
  const known = new Set(readJobRecords(dataDir).flatMap((r) => [key(r.h), key(r.v)]).filter(Boolean));
  let names = [];
  try { names = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile() && REC_EXT.test(e.name)).map((e) => e.name).sort(); } catch { return { done: false, verdicts: [], records: [] }; }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return null; } };
  const at = new Date(nowMs).toISOString();
  const verdicts = []; const records = []; const pairedV = new Set();
  for (const n of names.filter((x) => !vStem(sessionName(x)))) {
    const h = path.join(folder, n);
    if (known.has(key(h))) continue;
    const ext = path.extname(n); const vName = byLower.get(`${sessionName(n)}-v${ext}`.toLowerCase());
    const v = vName && !known.has(key(path.join(folder, vName))) ? path.join(folder, vName) : null;
    const b = backfillVerdict({ dataDir, file: h, clipsDirOf });
    const session = sessionName(n);
    verdicts.push({ file: h, size: sizeOf(h), decision: b.proven ? 'proven' : 'kept', reason: b.reason, session });
    if (v) { pairedV.add(vName); verdicts.push({ file: v, size: sizeOf(v), decision: b.proven ? 'proven' : 'kept', reason: b.proven ? 'clips-exist (V of a proven H)' : `its H is kept (${b.reason})`, session }); }
    if (b.proven) records.push({ h, v, type: 'full', kind: 'recording', name: session, result: 'done', code: 0, reelsNotMade: null, at, backfill: true });
  }
  for (const n of names.filter((x) => vStem(sessionName(x)) && !pairedV.has(x))) {
    const v = path.join(folder, n);
    if (!known.has(key(v))) verdicts.push({ file: v, size: sizeOf(v), decision: 'kept', reason: 'v-without-h', session: sessionName(n) });
  }
  return { done: false, verdicts, records, at };
}

/** Runs once: writes the proven job records and the verdict log. -> { ran, proven, kept }. Never throws. */
export function backfillJobRecords({ dataDir, folder, nowMs = Date.now(), clipsDirOf = clipsFolder }) {
  let p; try { p = planBackfill({ dataDir, folder, nowMs, clipsDirOf }); } catch { return { ran: false, proven: 0, kept: 0 }; }
  if (p.done) return { ran: false, proven: 0, kept: 0 };
  for (const r of p.records) appendJobRecord(dataDir, r);
  const logFile = path.join(clipsDir(dataDir), BACKFILL_LOG);
  try { mkdirSync(path.dirname(logFile), { recursive: true }); writeFileSync(logFile, p.verdicts.map((v) => `${JSON.stringify({ ...v, at: p.at })}\n`).join('')); } catch { /* tried again next start */ }
  return { ran: true, proven: p.verdicts.filter((v) => v.decision === 'proven').length, kept: p.verdicts.filter((v) => v.decision === 'kept').length };
}

/** Dry run: what one cleanup pass would delete and keep, with sizes and reasons. Reads only; never writes or deletes.
 *  It cannot know the live state or the running jobs (it says so) and does not test "in use" (that needs the rename). */
export function dryRun({ dataDir, folder, clipsDirOf = clipsFolder }) {
  const bf = planBackfill({ dataDir, folder, clipsDirOf });
  const records = [...readJobRecords(dataDir), ...bf.records];
  const rows = [];
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return null; } };
  for (const s of cleanupPlan({ dataDir, records })) {
    for (const file of [s.h, s.v].filter(Boolean)) {
      if (!existsSync(file)) continue;
      const where = s.reason ? null : checkInFolder(file, folder);
      rows.push({ file, size: sizeOf(file), action: s.reason || where ? 'keep' : 'delete', reason: s.reason ?? where ?? 'clipped (in use and live state are checked when it runs)' });
    }
  }
  const listed = new Set(rows.map((r) => key(r.file)));
  for (const v of bf.verdicts) if (v.decision === 'kept' && !listed.has(key(v.file))) rows.push({ file: v.file, size: v.size, action: 'keep', reason: v.reason });
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

const gbOf = (n) => (Number(n || 0) / 1024 ** 3).toFixed(2);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  if (!a.includes('--dry-run') || !arg('--data') || !arg('--recordings')) {
    console.error('usage: node services/studio-ui/recording-cleanup.mjs --dry-run --data <data dir> --recordings <recordings folder>');
    process.exit(2);
  }
  const rows = dryRun({ dataDir: path.resolve(arg('--data')), folder: path.resolve(arg('--recordings')) });
  for (const r of rows) console.log(`${r.action.toUpperCase().padEnd(6)} ${gbOf(r.size).padStart(8)} GB  ${r.file}  (${r.reason})`);
  const del = rows.filter((r) => r.action === 'delete');
  console.log(`dry run: would delete ${del.length} file(s), ${gbOf(del.reduce((n, r) => n + (r.size || 0), 0))} GB; keep ${rows.length - del.length}. Nothing was changed.`);
}