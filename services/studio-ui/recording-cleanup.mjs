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

/** A file's identity (Codex round 1): size, device, file id and modified time in ns, as strings; null when unreadable. */
export function fileIdentity(file) {
  try { const s = statSync(file, { bigint: true }); return s.isFile() ? { size: String(s.size), dev: String(s.dev), ino: String(s.ino), mtimeNs: String(s.mtimeNs) } : null; } catch { return null; }
}
const ID_KEYS = ['dev', 'ino', 'mtimeNs', 'size'];
const isId = (x) => isPlain(x) && Object.keys(x).sort().join() === ID_KEYS.join() && ID_KEYS.every((k) => /^\d{1,40}$/.test(x[k])) && x.ino !== '0';
export const sameId = (a, b) => isId(a) && isId(b) && ID_KEYS.every((k) => a[k] === b[k]);
const REC_KEYS = new Set(['h', 'hId', 'v', 'vId', 'type', 'kind', 'name', 'result', 'code', 'reelsNotMade', 'at', 'backfill']);
/** Strict schema of a jobs.jsonl line; anything else is ignored (never proof). */
export function validJobRecord(r) {
  if (!isPlain(r) || Object.keys(r).some((k) => !REC_KEYS.has(k))) return false;
  const abs = (p) => typeof p === 'string' && p.length < 1024 && path.isAbsolute(p);
  if (!abs(r.h) || !isId(r.hId)) return false;
  if (r.v !== null && !(abs(r.v) && isId(r.vId))) return false;
  if (r.v === null && r.vId !== null && r.vId !== undefined) return false;
  if (r.type !== 'full' && r.type !== 'review') return false;
  if (r.result !== 'done' && r.result !== 'failed') return false;
  if (!(r.code === null || Number.isInteger(r.code))) return false;
  if (!(r.reelsNotMade === null || typeof r.reelsNotMade === 'string')) return false;
  if (typeof r.name !== 'string' || !(r.kind === null || typeof r.kind === 'string')) return false;
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return false;
  if (r.backfill !== undefined && r.backfill !== true) return false;
  return true;
}

/** One finished clip job (record-clips.mjs calls this when a job ends), with the identity of the H and V files it
 *  used, taken now. A job without an H file (a stream without a recording) is not recorded: it made no file to delete.
 *  Never throws. */
export function appendJobRecord(dataDir, rec) {
  try {
    if (typeof rec?.h !== 'string' || !rec.h) return;
    const v = typeof rec.v === 'string' && rec.v ? rec.v : null;
    // Codex round 2: the identity is taken when the job starts reading (record-clips) and must still be the file's now;
    // a file replaced while the job ran gives no record.
    const hNow = fileIdentity(rec.h); const vNow = v ? fileIdentity(v) : null;
    if (rec.hId !== undefined && !sameId(rec.hId, hNow)) return;
    if (v && rec.vId !== undefined && !sameId(rec.vId, vNow)) return;
    const full = { ...rec, h: path.resolve(rec.h), hId: hNow, v: v && path.resolve(v), vId: vNow };
    if (!validJobRecord(full)) return; // e.g. the H file is gone: nothing to prove
    mkdirSync(clipsDir(dataDir), { recursive: true }); appendFileSync(path.join(clipsDir(dataDir), JOBS_LOG), `${JSON.stringify(full)}\n`);
  } catch { /* the next job writes again */ }
}
export const readJobRecords = (dataDir) => readLines(path.join(clipsDir(dataDir), JOBS_LOG)).filter(validJobRecord);
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

const pendingKeys = (state = {}) => {
  const out = new Set();
  for (const j of [state.running, ...(state.queued ?? []), ...(state.asks ?? [])]) { if (isPlain(j)) { const a = key(j.h); const b = key(j.v); if (a) out.add(a); if (b) out.add(b); } }
  return out;
};
const stateMark = (state = {}) => JSON.stringify([state.running ? [key(state.running.h), key(state.running.v), state.running.name ?? null] : null,
  ...(state.queued ?? []).map((j) => [key(j?.h), key(j?.v), j?.name ?? null]), ...(state.asks ?? []).map((j) => [key(j?.h), key(j?.v), j?.id ?? null])]);

/**
 * Every processed recording session with its verdict. Reads the logs, the keep list and the files' identities.
 * state: { running, queued: [], asks: [] } from record-clips. -> [{ name, h, hId, v, vId, reason, vReason }]: reason null =
 * H may be deleted now; v null = no V file qualifies (vReason says why).
 * Codex round 1: the latest entry of each job type (full, review) decides; H qualifies only when the file at that path
 * now has the identity those entries recorded; V qualifies only when the same entries all list that V file with the
 * identity it has now.
 */
export function cleanupPlan({ dataDir, state = {}, records = readJobRecords(dataDir), keepList = readKeepList(dataDir), deleted = readDeletedRecordings(dataDir), idOf = fileIdentity }) {
  const sessions = new Map();
  for (const r of records.filter(validJobRecord)) {
    const h = key(r.h);
    if (!sessions.has(h)) sessions.set(h, { h: r.h, recs: [] });
    sessions.get(h).recs.push(r);
  }
  const pending = pendingKeys(state);
  const gone = new Set(deleted.map((d) => key(d.file)).filter(Boolean));
  const out = [];
  for (const [h, s] of sessions) {
    const name = sessionName(s.h);
    const latest = new Map();
    for (const r of s.recs) { const p = latest.get(r.type); if (!p || r.at >= p.at) latest.set(r.type, r); }
    const used = [...latest.values()];
    const hNow = idOf(s.h);
    // V: the one file every deciding entry lists, unchanged since.
    const vPath = used[0].v;
    const vNow = vPath ? idOf(vPath) : null; // read once (Codex round 2)
    let vReason = null;
    if (used.every((r) => !r.v)) vReason = 'no-v';
    else if (!vPath || used.some((r) => key(r.v) !== key(vPath))) vReason = 'v-not-in-every-latest-job';
    else if (!used.every((r) => sameId(r.vId, vNow))) vReason = existsSync(vPath) ? 'v-changed-since-clipped' : 'v-gone';
    if (gone.has(h) && (vReason || gone.has(key(vPath)))) continue; // deleted already
    let reason = null;
    if (used.some((r) => r.result !== 'done' || r.code !== 0)) reason = 'job-failed';
    else if (!vReason && used.some((r) => typeof r.reelsNotMade === 'string' && r.reelsNotMade)) reason = 'reels-not-made';
    else if (pending.has(h) || (vPath && pending.has(key(vPath)))) reason = 'job-pending';
    else if (keepList.all || keepList.names.has(name.toLowerCase())) reason = 'kept-for-labelling';
    else if (!hNow) reason = 'file-gone';
    else if (!used.every((r) => sameId(r.hId, hNow))) reason = 'file-changed-since-clipped';
    out.push({ name, h: s.h, hId: hNow, v: vReason ? null : vPath, vId: vReason ? null : vNow, reason, vReason: reason ? reason : vReason });
  }
  return out;
}
/**
 * One cleanup pass. folder: the configured recordings folder. status: the latest outputs.status (null = unknown: refused).
 * -> { ran, refused?, deleted: [{ file, size }], kept: [{ file, reason }] }.
 */
export async function runRecordingCleanup({ dataDir, folder, flagOn, status, state = {}, nowMs = Date.now(), log = () => {}, writeTask = null, deleteImpl = safeDeleteFile, recheck = null, clipperBusy = false, clipsDirOf = clipsFolder }) {
  const res = { ran: false, deleted: [], kept: [] };
  if (flagOn !== true) return { ...res, refused: 'flag-off' };
  if (typeof folder !== 'string' || !folder || !existsSync(folder)) return { ...res, refused: 'no-recordings-folder' };
  if (!isPlain(status)) return { ...res, refused: 'state-unknown' };
  if (statusActive(status)) return { ...res, refused: 'live-or-recording' };
  res.ran = true;
  // Recordings with no clip job (live-clipper sessions, and every one made before jobs.jsonl): their clips decide.
  try {
    const writing = (Array.isArray(status.sinks) ? status.sinks : []).map((s) => s?.path).filter((p) => typeof p === 'string');
    const b = backfillJobRecords({ dataDir, folder, nowMs, clipsDirOf, writing, clipperBusy });
    if (b.ran && (b.first || b.proven)) log(`clips: recordings without a clip job checked: ${b.proven} proven processed, ${b.kept} kept (clips/${BACKFILL_LOG})`);
  } catch { /* kept */ }
  const logFile = path.join(clipsDir(dataDir), DELETED_RECORDINGS_LOG);
  // Codex round 1: the live state and the clip jobs are read again right before each file (recheck: () => { status,
  // state }); the batch stops at the first change, and every file not yet deleted is kept.
  const mark = stateMark(state);
  // Codex round 2: synchronous, and called by safeDeleteFile right before its rename (no await in between); the Keep for
  // labelling list is read again there too.
  const STOPS = new Set(['state-unknown', 'live-or-recording', 'jobs-changed']);
  const gateFor = (name) => () => {
    if (typeof recheck === 'function') {
      let now; try { now = recheck(); } catch { return 'state-unknown'; }
      if (typeof now?.then === 'function' || !isPlain(now?.status)) return 'state-unknown';
      if (statusActive(now.status)) return 'live-or-recording';
      if (stateMark(now.state ?? {}) !== mark) return 'jobs-changed';
    }
    const keep = readKeepList(dataDir);
    if (keep.all || keep.names.has(name.toLowerCase())) return 'kept-for-labelling';
    return null;
  };
  for (const s of cleanupPlan({ dataDir, state })) {
    if (s.reason) { res.kept.push({ file: s.h, reason: s.reason }); continue; }
    if (s.vReason && s.vReason !== 'no-v') res.kept.push({ file: `${s.name} (V)`, reason: s.vReason });
    for (const [file, expectId] of [[s.h, s.hId], [s.v, s.vId]].filter(([f]) => typeof f === 'string' && f)) {
      if (res.stopped) { res.kept.push({ file, reason: res.stopped }); continue; }
      if (!existsSync(file)) continue; // gone already (deleted by hand, or the other half of a session deleted earlier)
      const r = await deleteImpl({ file, folder, hash: false, expectId, requireId: true, gate: gateFor(s.name) });
      if (!r.deleted) { if (STOPS.has(r.reason)) res.stopped = r.reason; res.kept.push({ file, reason: r.reason }); continue; }
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

// ---- Recordings with no clip job: the clips in their time window (user, 2026-11-20: "Delete if clips exist") -----------
// How the data really looks (main session, 2026-11-20): the recordings folder holds alpha-<YYYYMMDD-HHMMSS>.mkv (H) and
// alpha-v-<YYYYMMDD-HHMMSS>.mkv (V) at its top (a replay/ subfolder holds replay-buffer saves: never touched). The clips
// were made by the live clipper while recording (clips.recording "while"), so no record-clips job exists for them. The
// clips folder holds <YYYY-MM-DD>/<game>_<kind>_<YYYYMMDD-HHMMSS>_..._v.mp4.
// An H recording with no jobs.jsonl entry counts as processed when either
//   (a) at least one clip still in the clips folder has a name time inside [the time in the recording's name, the
//       recording's last write], or
//   (b) a run folder runs/<stem>/render.json names exactly that file and that run made a clip that still exists or that
//       report.json lists as ok (older record-clips runs);
// AND it is finished: not a file an output is writing now, last written at least SETTLE_MS ago, and the live clipper is
// not running (record-clips passes clipperBusy while it watches). Its V file is the same session's (alpha-v-<ts>, or
// <stem>-v), taken only with a qualifying H; a V file with no H is kept. Each one gets a job record with the files'
// identity taken now, marked backfill. The first pass logs every verdict to <data>/clips/backfill-recordings.jsonl; later
// passes add a line for each recording they prove. Every other cleanup condition still applies.
export const BACKFILL_LOG = 'backfill-recordings.jsonl';
export const SETTLE_MS = 10 * 60 * 1000;
/** An old run's render.json may be written a little before the recording's last write is flushed. */
export const RUN_SLACK_MS = 2 * 60 * 1000;
const REC_EXT = /\.(mkv|mp4|mov|flv|ts|m4v)$/i;
const readJson = (f) => { try { const j = JSON.parse(readFileSync(f, 'utf8')); return isPlain(j) ? j : null; } catch { return null; } };
const STAMP = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/;
/** "YYYYMMDD-HHMMSS" (local time, as the host and the clip maker name files) -> ms, or null. */
export const stampMs = (s) => { const m = STAMP.exec(String(s ?? '')); if (!m) return null; const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); return Number.isFinite(t) ? t : null; };
/** A recording file name -> { prefix, v, stamp } (alpha-20261118-200000.mkv / alpha-v-20261118-200000.mkv), else null. */
export function recName(name) {
  const m = /^(.*?)(-v)?-(\d{8}-\d{6})\.[A-Za-z0-9]+$/i.exec(name);
  return m ? { prefix: m[1], v: !!m[2], stamp: m[3] } : null;
}
const isVName = (n) => { const r = recName(n); return r ? r.v : /-v$/i.test(sessionName(n)); };
/** The V partner's file name of an H file name: alpha-<ts>.mkv -> alpha-v-<ts>.mkv; else <stem>-v.<ext> (vRecordName). */
export const vNameOf = (n) => { const r = recName(n); const ext = path.extname(n); return r && !r.v ? `${r.prefix}-v-${r.stamp}${ext}` : `${sessionName(n)}-v${ext}`; };

/** Clip names with a time, per date folder, from the clips folder (top-level YYYY-MM-DD folders only). Reads names only. */
export function clipTimes(root) {
  const out = [];
  let days = [];
  try { days = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)); } catch { return out; }
  for (const d of days) {
    let files = [];
    try { files = readdirSync(path.join(root, d.name), { withFileTypes: true }).filter((e) => e.isFile() && /\.(mp4|mov|webm|mkv)$/i.test(e.name)); } catch { continue; }
    for (const e of files) { const m = /_(\d{8}-\d{6})_/.exec(e.name); const t = m ? stampMs(m[1]) : null; if (t !== null) out.push(t); }
  }
  return out;
}

/** Is `file` (an H recording) proven processed by its clips or an old run? -> { proven, reason, clips }. Reads only. */
export function backfillVerdict({ dataDir, file, mtimeMs, clipsDirOf = clipsFolder, times = null }) {
  let root = null; try { root = clipsDirOf(dataDir); } catch { /* unknown clips folder */ }
  const start = stampMs(recName(path.basename(file))?.stamp);
  if (start !== null && Number.isFinite(mtimeMs) && root) {
    const n = (times ?? clipTimes(root)).filter((t) => t >= start && t <= mtimeMs).length;
    if (n > 0) return { proven: true, reason: `clips-exist (${n} clip${n === 1 ? '' : 's'} in its time window)`, clips: n };
  }
  const run = path.join(clipsDir(dataDir), 'runs', sessionName(file));
  const render = readJson(path.join(run, 'render.json'));
  if (!render) return { proven: false, reason: start === null ? 'no-run-folder' : 'no-clips-in-its-time-window', clips: 0 };
  if (String(render.recording ?? '').toLowerCase() !== path.basename(file).toLowerCase()) return { proven: false, reason: 'run-is-for-another-file', clips: 0 };
  // Codex round 2: the name alone could be a newer file. The run must have been made after this file was last written
  // (render.json createdAt + RUN_SLACK_MS), and after the start in the file's name when it has one.
  const made = Date.parse(render.createdAt);
  if (!Number.isFinite(made) || !Number.isFinite(mtimeMs) || mtimeMs > made + RUN_SLACK_MS) return { proven: false, reason: 'run-older-than-file', clips: 0 };
  if (start !== null && start > made) return { proven: false, reason: 'run-older-than-file', clips: 0 };
  let clips = 0;
  for (const p of [path.join(run, 'published.json'), path.join(run, 'montage', 'published.json')]) {
    const files = readJson(p)?.files;
    if (!Array.isArray(files)) continue;
    // Codex round 2: only a regular file inside the clips folder by its real path (no .., link, junction or folder).
    for (const r of files) {
      const rel = typeof r?.file === 'string' ? r.file : null;
      if (!rel || !root || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) continue;
      if (checkInFolder(path.join(root, rel), root) === null) clips++;
    }
  }
  const okInReport = (readJson(path.join(run, 'report.json'))?.results ?? []).filter((r) => r?.ok === true).length;
  if (clips > 0 || okInReport > 0) return { proven: true, reason: 'clips-exist', clips: Math.max(clips, okInReport) };
  return { proven: false, reason: 'no-clips', clips: 0 };
}

/** Verdicts and the job records to add for recordings with no job record (reads only).
 *  writing: paths an output writes now (from the status); clipperBusy: the live clipper runs.
 *  -> { first, verdicts: [{ file, size, decision, reason, session }], records, at } */
export function planBackfill({ dataDir, folder, nowMs = Date.now(), clipsDirOf = clipsFolder, writing = [], clipperBusy = false }) {
  const first = !existsSync(path.join(clipsDir(dataDir), BACKFILL_LOG));
  const known = new Set(readJobRecords(dataDir).flatMap((r) => [key(r.h), key(r.v)]).filter(Boolean));
  const busy = new Set(writing.map(key).filter(Boolean));
  let names = [];
  try { names = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile() && REC_EXT.test(e.name)).map((e) => e.name).sort(); } catch { return { first, verdicts: [], records: [] }; }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const statOf = (f) => { try { return statSync(f); } catch { return null; } };
  let root = null; try { root = clipsDirOf(dataDir); } catch { /* unknown */ }
  const times = root ? clipTimes(root) : [];
  const at = new Date(nowMs).toISOString();
  const verdicts = []; const records = []; const pairedV = new Set();
  for (const n of names.filter((x) => !isVName(x))) {
    const h = path.join(folder, n);
    if (known.has(key(h))) continue;
    const vName = byLower.get(vNameOf(n).toLowerCase());
    const v = vName && !known.has(key(path.join(folder, vName))) ? path.join(folder, vName) : null;
    if (v) pairedV.add(vName);
    const st = statOf(h); const vst = v ? statOf(v) : null;
    const session = sessionName(n);
    let b;
    if (busy.has(key(h)) || (v && busy.has(key(v)))) b = { proven: false, reason: 'being-recorded' };
    else if (clipperBusy) b = { proven: false, reason: 'live-clipper-running' };
    else if (!st || nowMs - Math.max(st.mtimeMs, vst?.mtimeMs ?? 0) < SETTLE_MS) b = { proven: false, reason: 'just-recorded' };
    else b = backfillVerdict({ dataDir, file: h, mtimeMs: st.mtimeMs, clipsDirOf, times });
    verdicts.push({ file: h, size: st?.size ?? null, decision: b.proven ? 'proven' : 'kept', reason: b.reason, session });
    if (v) verdicts.push({ file: v, size: vst?.size ?? null, decision: b.proven ? 'proven' : 'kept', reason: b.proven ? `${b.reason} (V of a proven H)` : `its H is kept (${b.reason})`, session });
    // The identity is taken now, at backfill time, and the entry is marked backfill (Codex round 1).
    if (b.proven) records.push({ h, hId: fileIdentity(h), v, vId: v ? fileIdentity(v) : null, type: 'full', kind: 'recording', name: session, result: 'done', code: 0, reelsNotMade: null, at, backfill: true });
  }
  for (const n of names.filter((x) => isVName(x) && !pairedV.has(x))) {
    const v = path.join(folder, n);
    if (!known.has(key(v))) verdicts.push({ file: v, size: statOf(v)?.size ?? null, decision: 'kept', reason: 'v-without-h', session: sessionName(n) });
  }
  return { first, verdicts, records, at };
}

/** Each pass: writes the proven job records; the first pass logs every verdict, later ones each newly proven one.
 *  -> { ran, first, proven, kept }. Never throws. */
export function backfillJobRecords({ dataDir, folder, nowMs = Date.now(), clipsDirOf = clipsFolder, writing = [], clipperBusy = false }) {
  let p; try { p = planBackfill({ dataDir, folder, nowMs, clipsDirOf, writing, clipperBusy }); } catch { return { ran: false, proven: 0, kept: 0 }; }
  for (const r of p.records) appendJobRecord(dataDir, r);
  const lines = p.first ? p.verdicts : p.verdicts.filter((v) => v.decision === 'proven');
  const logFile = path.join(clipsDir(dataDir), BACKFILL_LOG);
  try { mkdirSync(path.dirname(logFile), { recursive: true }); appendFileSync(logFile, lines.map((v) => `${JSON.stringify({ ...v, at: p.at })}\n`).join('')); } catch { /* tried again next pass */ }
  return { ran: true, first: p.first, proven: p.verdicts.filter((v) => v.decision === 'proven').length, kept: p.verdicts.filter((v) => v.decision === 'kept').length };
}
/** Dry run: what one cleanup pass would delete and keep, with sizes and reasons. Reads only; never writes or deletes.
 *  It cannot know the live state or the running jobs (it says so) and does not test "in use" (that needs the rename). */
export function dryRun({ dataDir, folder, clipsDirOf = clipsFolder, nowMs = Date.now() }) {
  const bf = planBackfill({ dataDir, folder, clipsDirOf, nowMs });
  const records = [...readJobRecords(dataDir), ...bf.records];
  const rows = [];
  const sizeOf = (f) => { try { return statSync(f).size; } catch { return null; } };
  for (const s of cleanupPlan({ dataDir, records })) {
    for (const file of [s.h, s.v].filter(Boolean)) {
      if (!existsSync(file)) continue;
      const where = s.reason ? null : checkInFolder(file, folder);
      const why = bf.verdicts.find((v) => key(v.file) === key(file))?.reason ?? 'its clip jobs finished';
      rows.push({ file, size: sizeOf(file), action: s.reason || where ? 'keep' : 'delete', reason: s.reason ?? where ?? `${why}; in use and live state are checked when it runs` });
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