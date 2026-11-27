// SPDX-License-Identifier: GPL-3.0-or-later
// Make clips again (2026-11-27). Two ways back to a clip job, both one click, both through the launcher's own clip queue
// (record-clips.mjs), so the clipper reuses its run folder (<dataDir>/clips/runs/<name>: cached analysis, finished clips):
//   1. A clip task that ended stopped or failed keeps "Make clips again" in the task panel. The launcher saves the job
//      when it ends (<dataDir>/clips/again/<task id>.json); the click asks for it by the task id.
//   2. Clips menu > "Make clips from a recording...": recent recordings (H file + its V partner by the naming of
//      recording-cleanup.mjs) that have no finished run; the click asks for one by its name.
// The UI server (another process) only writes a request file, <dataDir>/clips/make/<random>.json; the launcher reads it
// on its status tick, checks it again (the recording is in the recordings folder, the files are there), and queues the
// job. A request names a task or a recording; it never carries a path.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJobRecords, recName, sessionName, vNameOf } from './recording-cleanup.mjs';
import { DEFAULT_NEXT_START, NEXT_START } from './tasks.mjs';

export const AGAIN_DIR = 'again';
export const MAKE_DIR = 'make';
/** Job types that can be made again (the game pack check and BeatDrop have their own places). */
export const AGAIN_TYPES = Object.freeze(['full', 'review']);
export const REQUEST_MAX_AGE_MS = 10 * 60_000;
export const LIST_MAX = 20;
const ID = /^[A-Za-z0-9._-]{1,80}$/;
const REC_EXT = /\.(mkv|mp4|mov|flv|ts|m4v)$/i;
const str = (v, n) => (typeof v === 'string' && v.length > 0 && v.length <= n ? v : null);

/** Can this finished job be offered "Make clips again"? A review needs no recording (its saves are the input). */
export const againable = (j) => AGAIN_TYPES.includes(j?.type) && (j.type === 'review' || (typeof j.h === 'string' && j.h !== ''));

/** The fields kept of a job: what the queue needs to run the same work again. */
export function againRecord(j, atMs) {
  return { type: j.type, kind: j.kind === 'live' ? 'live' : 'recording', h: str(j.h, 1024), v: str(j.v, 1024), since: str(j.since, 40), until: str(j.until, 40), name: str(j.name, 120),
    minutes: Number.isFinite(j.minutes) ? j.minutes : null, nextStart: NEXT_START.includes(j.nextStart) ? j.nextStart : DEFAULT_NEXT_START,
    ...(j.look && typeof j.look === 'object' && !Array.isArray(j.look) ? { look: j.look } : {}), atMs };
}
export const againDir = (dataDir) => path.join(dataDir, 'clips', AGAIN_DIR);
export function writeAgain(dataDir, taskId, j, atMs) {
  if (!ID.test(String(taskId)) || !againable(j)) return false;
  try {
    mkdirSync(againDir(dataDir), { recursive: true });
    const f = path.join(againDir(dataDir), `${taskId}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(againRecord(j, atMs)));
    renameSync(`${f}.tmp`, f);
    return true;
  } catch { return false; }
}
export function readAgain(dataDir, taskId) {
  if (!ID.test(String(taskId))) return null;
  try { const r = JSON.parse(readFileSync(path.join(againDir(dataDir), `${taskId}.json`), 'utf8')); return r && typeof r === 'object' ? r : null; } catch { return null; }
}
export function removeAgain(dataDir, taskId) { if (ID.test(String(taskId))) try { rmSync(path.join(againDir(dataDir), `${taskId}.json`), { force: true }); } catch { /* gone */ } }

/**
 * The queue job of a saved record, or { problem } in plain words. The same type, kind, h, v, since, until, name, minutes and
 * next start as the job that ended; userStarted: it is the user's click, so it never starts beside a recording (needsIdle).
 */
export function jobFromAgain(rec, { exists = existsSync } = {}) {
  if (!rec || typeof rec !== 'object' || !AGAIN_TYPES.includes(rec.type)) return { problem: 'that job cannot be made again' };
  const h = str(rec.h, 1024); const v = str(rec.v, 1024); const name = str(rec.name, 120);
  if (!name) return { problem: 'the job has no name' };
  if (rec.type === 'full' && !h) return { problem: 'there is no recording to make clips from' };
  if (h && !exists(h)) return { problem: 'the recording is gone' };
  return { job: { type: rec.type, kind: rec.kind === 'live' ? 'live' : 'recording', ...(h ? { h } : {}), ...(v && exists(v) ? { v } : {}),
    ...(str(rec.since, 40) ? { since: rec.since } : {}), ...(str(rec.until, 40) ? { until: rec.until } : {}), name, ...(Number.isFinite(rec.minutes) ? { minutes: rec.minutes } : {}),
    nextStart: NEXT_START.includes(rec.nextStart) ? rec.nextStart : DEFAULT_NEXT_START, ...(rec.look && typeof rec.look === 'object' && !Array.isArray(rec.look) ? { look: rec.look } : {}), userStarted: true } };
}

const key = (p) => (typeof p === 'string' && p ? path.resolve(p).toLowerCase() : null);
const isV = (n) => { const r = recName(n); return r ? r.v : /-v$/i.test(sessionName(n)); };

/**
 * Recent recordings with no finished run, newest first: [{ name, h, v|null, at (ms), size }]. H file = a recording file whose
 * name is not a V name; its V partner is vNameOf(H). Finished run = a clip job record with result "done" for that H file
 * (jobs.jsonl), or a run folder with published.json. A stopped or failed run is not finished: it is listed.
 */
export function listRecordings({ folder, dataDir, limit = LIST_MAX, readRecords = readJobRecords, stat = statSync, exists = existsSync }) {
  if (typeof folder !== 'string' || !folder) return [];
  let names;
  try { names = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile() && REC_EXT.test(e.name)).map((e) => e.name); } catch { return []; }
  let done = new Set();
  try { done = new Set(readRecords(dataDir).filter((r) => r.result === 'done').map((r) => key(r.h))); } catch { /* none known */ }
  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out = [];
  for (const n of names.filter((x) => !isV(x))) {
    const h = path.join(folder, n);
    const name = sessionName(n);
    if (done.has(key(h)) || exists(path.join(dataDir, 'clips', 'runs', name, 'published.json'))) continue;
    let st; try { st = stat(h); } catch { continue; }
    if (!st.isFile() || !(st.size > 0)) continue;
    const vn = byLower.get(vNameOf(n).toLowerCase());
    out.push({ name, h, v: vn ? path.join(folder, vn) : null, at: st.mtimeMs, size: st.size });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** The queue job of a listed recording (a whole-recording clip job in the run folder named after it). */
export function jobFromRecording(item, { nowMs = Date.now() } = {}) {
  if (!item?.h || !item.name) return null;
  return { type: 'full', kind: 'recording', h: item.h, ...(item.v ? { v: item.v } : {}), name: item.name, until: new Date(nowMs).toISOString(), nextStart: DEFAULT_NEXT_START, userStarted: true };
}

// ---- requests: UI server -> launcher ----
export const makeDir = (dataDir) => path.join(dataDir, 'clips', MAKE_DIR);
/** A clean request or null: { op: 'again', id } | { op: 'recording', name }, atMs. */
export function cleanRequest(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.atMs)) return null;
  if (r.op === 'again' && typeof r.id === 'string' && ID.test(r.id)) return { op: 'again', id: r.id, atMs: Math.floor(r.atMs) };
  if (r.op === 'recording' && typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 120 && !/[\\/:*?"<>|\x00-\x1f]/.test(r.name)) return { op: 'recording', name: r.name, atMs: Math.floor(r.atMs) };
  return null;
}
export function writeMakeRequest(dataDir, req) {
  const c = cleanRequest(req);
  if (!c) return false;
  try {
    mkdirSync(makeDir(dataDir), { recursive: true });
    const f = path.join(makeDir(dataDir), `${c.atMs}-${randomBytes(4).toString('hex')}.json`);
    writeFileSync(`${f}.tmp`, JSON.stringify(c));
    renameSync(`${f}.tmp`, f);
    return true;
  } catch { return false; }
}
/** The waiting requests, oldest first: [{ ...request, file }]. An unreadable file is removed. */
export function takeMakeRequests(dataDir) {
  let names; try { names = readdirSync(makeDir(dataDir)); } catch { return []; }
  const out = [];
  for (const nm of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(makeDir(dataDir), nm);
    let c = null; try { c = cleanRequest(JSON.parse(readFileSync(file, 'utf8'))); } catch { c = null; }
    if (c) out.push({ ...c, file }); else { try { rmSync(file, { force: true }); } catch { /* next tick */ } }
  }
  return out.sort((a, b) => a.atMs - b.atMs);
}
export const ackMakeRequest = (r) => { try { rmSync(r.file, { force: true }); } catch { /* the launcher skips a request it took (queue holds the job) */ } };
