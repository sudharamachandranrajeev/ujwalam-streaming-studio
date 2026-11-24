// SPDX-License-Identifier: GPL-3.0-or-later
// What the software is doing, in plain words, for the studio window's task bar (it only informs; it never blocks).
// A task: { id, title, kind, state: running|done|failed|waiting, done, total (null = unknown), stage, note,
// startedAt, updatedAt, stages?, stageText?, unit?, activeAt?, progressAt? } plus, in list(), progress (0..1 | null),
// elapsedMs and etaMs (null = unknown; D311 proposed), silentMs, stalled, stallAfterMs and step (2026-11-10). Two sources: files <dataDir>/tasks/<id>.json written by launcher-side jobs (writeTaskFile,
// atomic), and in-memory tasks of the UI server for its own long actions (createTasks().track). Finished or silent
// tasks are dropped after PRUNE_MS. Text only: no chat text, no viewer names, no paths beyond the clips folder.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TASK_STATES = Object.freeze(['running', 'done', 'failed', 'waiting']);
export const PRUNE_MS = 10 * 60_000;
export const MAX_TASKS = 40;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const FINISHED = new Set(['done', 'failed']);

const cut = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : null);
const int = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

// ---- task manager, job side (D442, 2026-11-24) ----
// Every task has a category (the window filters by it). A writer may name it; otherwise it follows the task's kind.
export const TASK_CATEGORIES = Object.freeze(['clips', 'reels', 'long-video', 'posting', 'learning', 'downloads', 'maintenance']);
const KIND_CATEGORY = { clips: 'clips', 'live-clips': 'clips', beatdrop: 'reels', reels: 'reels', montage: 'reels', long: 'long-video',
  upload: 'posting', posting: 'posting', train: 'learning', learning: 'learning', download: 'downloads', downloads: 'downloads' };
export const categoryOf = (t) => (TASK_CATEGORIES.includes(t?.category) ? t.category : KIND_CATEGORY[t?.kind] ?? 'maintenance');
// What a task that did not finish does at the next start: run it, ask the user, or only say so (default, user 2026-11-24).
export const NEXT_START = Object.freeze(['run', 'ask', 'notify']);
export const DEFAULT_NEXT_START = 'notify';
// The per-task controls a writer offers (the UI server refuses any other): stop, pause, resume, next (change nextStart).
export const TASK_CONTROLS = Object.freeze(['stop', 'pause', 'resume', 'next']);
export const LOG_TAIL_LINES = 8;
const LOG_LINE_MAX = 160;
// D442 log tail (Codex review: the deny-list leaked): an ALLOWLIST. The task shows only typed events the job emits,
// turned into fixed text here: progress (stage, done, total, step), a safe point, the parts it runs (from its own list)
// and how it ended (known codes, fixed plain-language text). Raw tool output never leaves the launcher: it stays in
// the job's local log file only.
const STAGE_WORD = /^[a-z][a-z0-9-]{0,23}$/;
const PART_NAMES = Object.freeze(['Clip maker (Python)', 'Screen reader (OCR)', 'Video tools (ffmpeg)']);
export const END_TEXT = Object.freeze({
  done: 'Finished', failed: 'Stopped with an error; the full log is on this computer', stopped: 'Stopped by you',
  paused: 'Paused by you', 'paused-live': 'Paused while the stream runs', 'paused-rec': 'Paused while recording',
});
const n = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
/** The fixed text of one allowed event, or null (not shown). */
export function logEventText(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'progress' && STAGE_WORD.test(ev.stage ?? '')) {
    const d = n(ev.done); const t = n(ev.total);
    const step = STAGE_WORD.test(ev.step ?? '') ? ` (${ev.step})` : '';
    return `${ev.stage}${step}${d === null ? '' : `: ${d}${t ? ` of ${t}` : ''}`}`;
  }
  if (ev.type === 'safepoint' && STAGE_WORD.test(ev.stage ?? '')) return `Safe point: ${ev.stage} ${n(ev.done) ?? ''}`.trim();
  if (ev.type === 'part' && PART_NAMES.includes(ev.name)) return `Running: ${ev.name}`;
  if (ev.type === 'end' && Object.hasOwn(END_TEXT, ev.code)) return END_TEXT[ev.code];
  return null;
}
/** Adds an allowed event to a tail (array of at most LOG_TAIL_LINES strings); a repeat of the last line is skipped. */
export function pushLogEvent(tail, ev) {
  const s = logEventText(ev);
  if (!s || tail.at(-1) === s) return tail;
  tail.push(s);
  while (tail.length > LOG_TAIL_LINES) tail.shift();
  return tail;
}
const cleanTail = (lines) => (Array.isArray(lines)
  ? lines.filter((l) => typeof l === 'string').map((l) => cut(l.replace(/[\u0000-\u001f\u007f]/g, ' '), LOG_LINE_MAX)).filter(Boolean).slice(-LOG_TAIL_LINES) : []);
/** A clean task from untrusted input (a file or a caller), or null. */
export function cleanTask(t, id = t?.id) {
  if (!t || typeof t !== 'object' || typeof id !== 'string' || !ID.test(id)) return null;
  const state = TASK_STATES.includes(t.state) ? t.state : null;
  const title = cut(t.title, 120);
  if (!state || !title) return null;
  const total = int(t.total);
  let done = int(t.done);
  if (done !== null && total !== null && done > total) done = total;
  // Panel detail (2026-11-10): the job's known stages in order, the current stage in plain words, what is counted
  // (frame, clip, MB), when it began working (activeAt; startedAt may be when it was queued) and when its last progress
  // line came (progressAt; null = none yet). Optional: older writers leave them out.
  const stages = Array.isArray(t.stages) ? t.stages.slice(0, 8).map((s) => cut(s, 24)).filter(Boolean) : [];
  return { id, title, kind: cut(t.kind, 24) ?? 'task', state, done, total: total === 0 ? null : total, stage: cut(t.stage, 24),
    note: cut(t.note, 160), startedAt: int(t.startedAt), updatedAt: int(t.updatedAt),
    stages: stages.length ? stages : null, stageText: cut(t.stageText, 60), unit: cut(t.unit, 16), activeAt: int(t.activeAt), progressAt: int(t.progressAt),
    measured: t.measured === false ? false : null, // false = this stage reports no progress while it works
    ...controlFields(t) };
}

/** D442 fields of a clean task: category, the controls offered, pause (pausable + plain reason when not, paused,
 *  pausing = asked, waits for the next safe point), nextStart (null = not an unfinished job), question (nextStart "ask":
 *  the task waits for the user's answer), parts running (plain names) and a bounded, sanitised log tail. */
function controlFields(t) {
  const controls = Array.isArray(t.controls) ? TASK_CONTROLS.filter((c) => t.controls.includes(c)) : [];
  const pausable = t.pausable === true;
  return {
    category: categoryOf(t), controls,
    pausable, pauseReason: pausable ? null : cut(t.pauseReason, 120),
    paused: t.paused === true, pausing: t.pausing === true,
    nextStart: NEXT_START.includes(t.nextStart) ? t.nextStart : null,
    question: cut(t.question, 160),
    parts: Array.isArray(t.parts) ? t.parts.slice(0, 6).map((p) => cut(p, 40)).filter(Boolean) : [],
    logTail: cleanTail(t.logTail),
  };
}

export const tasksDir = (dataDir) => path.join(dataDir, 'tasks');

/** Atomic write of one task file (best effort: the task bar must never break the job). */
export function writeTaskFile(dataDir, task) {
  const c = cleanTask(task);
  if (!c) return false;
  try {
    const dir = tasksDir(dataDir);
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${c.id}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(c));
    renameSync(`${f}.tmp`, f);
    return true;
  } catch { return false; }
}

// D442 per-task control requests, UI server -> launcher (another process): one file per request,
// <dataDir>/clips/control/<id>~<atMs>-<seq>.json { op, nextStart?, atMs }, written atomically. The launcher
// (record-clips.mjs) reads and removes them on its status tick and applies them in the order they were asked
// (atMs, then seq), so pause then resume or next then stop all count; a request older than the launcher is dropped.
let controlSeq = 0;
export const controlDir = (dataDir) => path.join(dataDir, 'clips', 'control');

/** A clean control request or null: { op, nextStart (op 'next' only), atMs }. */
export function cleanControl(r) {
  if (!r || typeof r !== 'object' || !TASK_CONTROLS.includes(r.op) || !Number.isFinite(r.atMs)) return null;
  if (r.op === 'next' && !NEXT_START.includes(r.nextStart)) return null;
  return { op: r.op, ...(r.op === 'next' ? { nextStart: r.nextStart } : {}), atMs: Math.floor(r.atMs) };
}

export function writeTaskControl(dataDir, id, req) {
  const c = cleanControl(req);
  if (typeof id !== 'string' || !ID.test(id) || !c) return false;
  const dir = controlDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${id}~${c.atMs}-${String(controlSeq++).padStart(6, '0')}.json`);
  writeFileSync(`${f}.tmp`, JSON.stringify(c));
  renameSync(`${f}.tmp`, f);
  return true;
}

/** Reads the waiting control requests without removing them: [{ id, op, nextStart?, atMs, file }], in the order they
 *  were asked. Codex review: the reader removes a request (ackTaskControls) only after its effect is committed to
 *  status.json, so a close in between applies it again at the next start. Unreadable files are removed. */
export function peekTaskControls(dataDir) {
  const dir = controlDir(dataDir);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const nm of names) {
    if (!nm.endsWith('.json')) continue;
    const m = /^([A-Za-z0-9._-]{1,80})~(\d{1,16})-(\d{1,9})\.json$/.exec(nm);
    const f = path.join(dir, nm);
    let c = null;
    try { c = cleanControl(JSON.parse(readFileSync(f, 'utf8'))); } catch { c = null; }
    if (c && m) out.push({ id: m[1], ...c, seq: Number(m[3]), file: f });
    else try { rmSync(f, { force: true }); } catch { /* next tick */ }
  }
  return out.sort((a, b) => a.atMs - b.atMs || a.seq - b.seq).map(({ seq: _s, ...r }) => r);
}
/** Removes applied requests (their files). */
export function ackTaskControls(reqs) {
  for (const r of reqs) try { rmSync(r.file, { force: true }); } catch { /* read again next tick; applying it twice is harmless */ }
}
/** Reads and removes the waiting requests at once (no state to commit in between). */
export function takeTaskControls(dataDir) {
  const reqs = peekTaskControls(dataDir);
  ackTaskControls(reqs);
  return reqs.map(({ file: _f, ...r }) => r);
}

export function removeTaskFile(dataDir, id) {
  if (!ID.test(id)) return;
  try { rmSync(path.join(tasksDir(dataDir), `${id}.json`), { force: true }); } catch { /* gone */ }
}

/** Task files, newest first; files older than PRUNE_MS (finished or not updated) are deleted. */
export function readTaskFiles(dataDir, nowMs = Date.now()) {
  const dir = tasksDir(dataDir);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -5);
    let t = null;
    try { t = cleanTask(JSON.parse(readFileSync(path.join(dir, n), 'utf8')), id); } catch { t = null; }
    if (!t) continue;
    if (nowMs - (t.updatedAt ?? t.startedAt ?? 0) > PRUNE_MS) { removeTaskFile(dataDir, id); continue; }
    out.push(t);
  }
  return out;
}

// ---- progress, elapsed time and time left (user 2026-11-09, D311 proposed) ----
// Every task in the list carries: progress (0..1, or null = unknown amount of work), elapsedMs (since it started; a
// finished task: up to its last update) and etaMs (time left, or null = unknown). The time left comes only from the
// measured rate of the current stage: (time since the first sample of this stage) * (work left / work done since then).
// No rate yet (fewer than ETA_MIN_MS of samples, no progress since, unknown total, waiting): unknown, never a guess.
export const ETA_MIN_MS = 3000;

/** 0..1 for a task, or null when the amount of work is unknown. A finished "done" task is 1. */
export function progressOf(t) {
  if (t?.state === 'done') return 1;
  if (!Number.isFinite(t?.total) || t.total <= 0 || !Number.isFinite(t?.done)) return null;
  return Math.min(1, Math.max(0, t.done / t.total));
}

/** Time left in ms from a stage's first sample { at, p } and the current progress p at now; null = unknown. */
export function etaFrom(first, p, now) {
  if (!first || !Number.isFinite(p) || !Number.isFinite(first.p) || !Number.isFinite(first.at)) return null;
  const dt = now - first.at;
  const dp = p - first.p;
  if (dt < ETA_MIN_MS || dp <= 0 || p >= 1) return p >= 1 ? 0 : null;
  return Math.round(dt * (1 - p) / dp);
}

/**
 * A rate tracker: timing(task) -> { progress, elapsedMs, etaMs }. One sample per task and stage is kept (the first one
 * seen); it starts again when the stage changes or the progress goes back. Forgotten tasks are dropped by keep(ids).
 */
export function createTiming(now = Date.now) {
  const first = new Map();
  function timing(t) {
    const n = now();
    const p = progressOf(t);
    const start = Number.isFinite(t.startedAt) ? t.startedAt : null;
    const end = t.state === 'done' || t.state === 'failed' ? (t.updatedAt ?? n) : n;
    const elapsedMs = start === null ? null : Math.max(0, end - start);
    let etaMs = null;
    if (t.state === 'running' && p !== null) {
      const stage = t.stage ?? '';
      let f = first.get(t.id);
      if (!f || f.stage !== stage || p < f.p) { f = { stage, at: n, p }; first.set(t.id, f); }
      etaMs = etaFrom(f, p, n);
    } else first.delete(t.id);
    return { progress: p, elapsedMs, etaMs };
  }
  function keep(ids) { for (const id of [...first.keys()]) if (!ids.has(id)) first.delete(id); }
  return { timing, keep };
}

// ---- stall warning and step (user 2026-11-10) ----
// A running task that has sent no progress for stallAfterMs (data/studio/tasks.json), or none at all since it began
// working, is marked stalled: the panel warns "it may be stuck" and offers Stop. Only a warning; nothing is stopped.
export const TASKS_CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'studio', 'tasks.json');

/** { stallAfterMs } from data/studio/tasks.json; stallAfterMs null (no warning) when the file is missing or wrong. */
export function loadTaskConfig(file = TASKS_CONFIG) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return { stallAfterMs: Number.isFinite(j.stallAfterMs) && j.stallAfterMs >= 10_000 ? Math.floor(j.stallAfterMs) : null };
  } catch { return { stallAfterMs: null }; }
}

/** LU2: data/studio/tasks.json as data. Strict (a reload keeps the last good version on any problem): an object whose
 *  stallAfterMs is null (no warning) or an integer of at least 10000 ms. */
export function parseTaskConfig(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('needs a JSON object');
  const v = j.stallAfterMs;
  if (v === null || v === undefined) return { stallAfterMs: null };
  if (!Number.isInteger(v) || v < 10_000 || v > 24 * 3_600_000) throw new Error('stallAfterMs must be a whole number of ms from 10000 (or null)');
  return { stallAfterMs: v };
}

/** For a running task: { silentMs, stalled } (silence since the last progress line, else since it began); else nulls. */
export function stallOf(t, now, stallAfterMs) {
  if (t?.state !== 'running') return { silentMs: null, stalled: false };
  const ref = t.progressAt ?? t.activeAt ?? t.startedAt;
  if (!Number.isFinite(ref)) return { silentMs: null, stalled: false };
  const silentMs = Math.max(0, now - ref);
  // A stage that reports no progress while it works (measured: false: publish, montage) is never called stuck.
  return { silentMs, stalled: t.measured !== false && Number.isFinite(stallAfterMs) && silentMs >= stallAfterMs };
}

/** { index (1-based), count } of the current stage in the task's known stages, or null. */
export function stepOf(t) {
  if (!Array.isArray(t?.stages) || !t.stage) return null;
  const i = t.stages.indexOf(t.stage);
  return i < 0 ? null : { index: i + 1, count: t.stages.length };
}

const RANK = { running: 0, waiting: 1, failed: 2, done: 3 };
const order = (a, b) => RANK[a.state] - RANK[b.state] || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);

/** opts: { dataDir?, now?, stallAfterMs? (default: data/studio/tasks.json; a number, or a function read on each
 *  list() so a reloaded config applies at once) }. start() returns a handle; track() runs a
 *  function as a task. */
export function createTasks({ dataDir = null, now = Date.now, stallAfterMs = loadTaskConfig().stallAfterMs } = {}) {
  const stallMs = typeof stallAfterMs === 'function' ? stallAfterMs : () => stallAfterMs;
  const mem = new Map();
  const clock = createTiming(now);
  let seq = 0;
  const prune = () => {
    const t = now();
    for (const [id, x] of mem) if (t - x.updatedAt > PRUNE_MS) mem.delete(id);
    while (mem.size > MAX_TASKS) mem.delete(mem.keys().next().value);
  };
  function start({ title, kind = 'task', total = null, stage = null, note = null }) {
    const id = `ui-${now().toString(36)}-${(seq++).toString(36)}`;
    const t = now();
    // D442: the UI server's own actions run inside it in one go; they cannot be paused or stopped one by one.
    const rec = { ...controlFields({ kind, pauseReason: 'It runs inside the studio and takes only a moment' }), id, title: cut(title, 120) ?? 'Working', kind: cut(kind, 24) ?? 'task', state: 'running', done: total === null ? null : 0, total: int(total), stage: cut(stage, 24), note: cut(note, 160), startedAt: t, updatedAt: t, activeAt: t, progressAt: null };
    mem.set(id, rec);
    prune();
    const set = (p) => { Object.assign(rec, p, { updatedAt: now() }); };
    return {
      id,
      update: (p = {}) => set({ ...(p.done !== undefined || p.stage !== undefined ? { progressAt: now() } : {}), ...(p.done !== undefined ? { done: int(p.done) } : {}), ...(p.total !== undefined ? { total: int(p.total) } : {}),
        ...(p.stage !== undefined ? { stage: cut(p.stage, 24) } : {}), ...(p.note !== undefined ? { note: cut(p.note, 160) } : {}), ...(p.title ? { title: cut(p.title, 120) } : {}) }),
      done: (note = null) => set({ state: 'done', note: cut(note, 160), ...(rec.total !== null ? { done: rec.total } : {}) }),
      fail: (note = null) => set({ state: 'failed', note: cut(note, 160) }),
    };
  }
  /** Runs fn(handle) as a task. A result with ok === false, or a thrown error, marks it failed (the error is rethrown). */
  async function track(spec, fn) {
    const h = start(spec);
    try {
      const r = await fn(h);
      if (r && typeof r === 'object' && r.failed === true) h.fail(r.note ?? 'Did not finish'); else h.done(spec.doneNote ?? null);
      return r;
    } catch (e) { h.fail('Did not finish'); throw e; }
  }
  /** All tasks: running first, then waiting, then the newest finished. */
  function list() {
    prune();
    const all = [...mem.values()].map((x) => ({ ...x }));
    if (dataDir) all.push(...readTaskFiles(dataDir, now()));
    const n = now();
    const stallAfterMs = stallMs();
    const out = all.sort(order).slice(0, MAX_TASKS).map((t) => ({ stages: null, stageText: null, unit: null, activeAt: null, progressAt: null, measured: null, ...t,
      ...clock.timing(t), ...stallOf(t, n, stallAfterMs), stallAfterMs, step: stepOf(t) }));
    clock.keep(new Set(out.map((t) => t.id)));
    return out;
  }
  return { start, track, list, isFinished: (t) => FINISHED.has(t.state) };
}
