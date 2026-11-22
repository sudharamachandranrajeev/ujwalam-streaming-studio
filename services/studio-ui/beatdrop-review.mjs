// SPDX-License-Identifier: GPL-3.0-or-later
// BeatDrop review (BD7b, D420): reads what the clipper wrote for a run and queues one-click retakes.
//   <dataDir>/clips/runs/<run>/beatdrop/render.json                      clips[0]: files, summary, retakes, music
//   <dataDir>/clips/runs/<run>/beatdrop/clips/B1/beatdrop-plan.json      pieces: part, outStart, outFrames, anchor
// Routes (server.mjs): GET /ui/api/beatdrop[?run=NAME], POST /ui/api/beatdrop/retake, POST /ui/api/beatdrop/play.
// The client never sends a path: a run name must equal a run folder that has a BeatDrop render, an op comes from a
// fixed list, a piece is a whole number inside the saved plan. A retake is queued through <dataDir>/clips/retake.json,
// which the clip job queue (record-clips.mjs) reads on its next tick.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const RETAKE_OPS = Object.freeze(['another-take', 'slower-intro', 'more-third-person', 'swap']);
export const RETAKE_FILE = 'retake.json';
const RENDER = path.join('beatdrop', 'render.json');
const PLAN = path.join('beatdrop', 'clips', 'B1', 'beatdrop-plan.json');
const MAX_PIECES = 200;

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').slice(0, n) : '');

export const runsDir = (dataDir) => path.join(dataDir, 'clips', 'runs');

/** Run folders that hold a BeatDrop render, newest first. */
export function knownRuns(dataDir) {
  const root = runsDir(dataDir);
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  const rows = [];
  for (const n of names) {
    const f = path.join(root, n, RENDER);
    try { if (existsSync(f)) rows.push({ n, t: statSync(f).mtimeMs }); } catch { /* skip */ }
  }
  return rows.sort((a, b) => b.t - a.t).map((r) => r.n);
}

/** What kind of piece: a kill on the beat, a move (gunshot, flick, other anchored), or calm. */
export function pieceKind(p) {
  if (p?.part === 'drop') return 'kill';
  const a = p?.anchor;
  if (!isObj(a)) return 'calm';
  return a.kind === 'kill' ? 'kill' : 'move';
}

/** The pieces as blocks for the song strip: { n (1-based), part, kind, start, length } in seconds. */
export function pieceBlocks(plan) {
  if (!isObj(plan) || !Array.isArray(plan.pieces)) return { blocks: [], total: 0 };
  const fps = Number.isFinite(plan.fps) && plan.fps > 0 ? plan.fps : 30;
  const blocks = plan.pieces.slice(0, MAX_PIECES).map((p, i) => ({
    n: i + 1, part: text(p?.part, 24), kind: pieceKind(p),
    start: Math.max(0, Number(p?.outStart) || 0) / fps, length: Math.max(0, Number(p?.outFrames) || 0) / fps,
  }));
  const end = blocks.reduce((m, b) => Math.max(m, b.start + b.length), 0);
  return { blocks, total: Number.isFinite(plan.total) && plan.total > 0 ? plan.total : end };
}

/** Problems with a retake request body; [] when fine. runs = the known run names, pieces = the plan's piece count. */
export function retakeProblems(b, { runs, pieces = null }) {
  if (!isObj(b)) return ['body must be an object'];
  const extra = Object.keys(b).filter((k) => !['run', 'op', 'piece'].includes(k));
  if (extra.length) return [`unknown ${extra.join(', ')}`];
  if (typeof b.run !== 'string' || !runs.includes(b.run)) return ['run must be a run with a BeatDrop montage'];
  if (typeof b.op !== 'string' || !RETAKE_OPS.includes(b.op)) return ['op must be one of ' + RETAKE_OPS.join(', ')];
  if (b.op === 'swap') {
    if (!Number.isInteger(b.piece) || b.piece < 1 || b.piece > (pieces ?? MAX_PIECES)) return ['piece must be a whole number inside the montage'];
  } else if (b.piece !== undefined) return ['piece goes only with swap'];
  return [];
}

/** { h, v } sources of a run, saved by the job queue when it made the montage; null when unknown. */
export function sourceOf(dataDir, run) {
  const s = readJson(path.join(runsDir(dataDir), run, 'beatdrop-source.json'));
  return isObj(s) && typeof s.h === 'string' && s.h ? { h: s.h, v: typeof s.v === 'string' && s.v ? s.v : null } : null;
}

/** opts: { dataDir, flagOn: () => bool, openFile: (path) => bool } -> { info(run), retake(body), play(body) } each { status, body }. */
export function createBeatdropReview({ dataDir, flagOn = () => true, openFile = () => false }) {
  const on = () => { try { return flagOn() === true; } catch { return false; } };
  const busyRun = (run) => {
    const s = readJson(path.join(dataDir, 'clips', 'status.json'));
    const mine = (j) => isObj(j) && j.type === 'beatdrop' && j.name === run;
    return !!s && (mine(s.running) || (Array.isArray(s.queued) && s.queued.some(mine)));
  };
  const load = (run) => {
    const dir = path.join(runsDir(dataDir), run, 'beatdrop');
    const render = readJson(path.join(dir, 'render.json'));
    const clip = isObj(render) && Array.isArray(render.clips) ? render.clips[0] : null;
    if (!isObj(clip)) return null;
    const files = Array.isArray(clip.files) ? clip.files : [];
    const fileOf = (layout) => {
      const f = files.find((x) => isObj(x) && x.layout === layout && typeof x.file === 'string' && x.file && path.basename(x.file) === x.file);
      if (!f) return null;
      const p = path.join(dir, 'clips', 'B1', f.file);
      return existsSync(p) ? p : null;
    };
    const plan = readJson(path.join(runsDir(dataDir), run, PLAN));
    return { clip, plan, h: fileOf('beatdrop-h'), v: fileOf('beatdrop-v') };
  };
  return {
    info(run) {
      if (!on()) return { status: 404, body: { error: 'beatdrop-off' } };
      const runs = knownRuns(dataDir);
      const pick = typeof run === 'string' && run ? (runs.includes(run) ? run : null) : runs[0] ?? null;
      if (run && !pick) return { status: 404, body: { error: 'unknown-run' } };
      if (!pick) return { status: 200, body: { runs, run: null, made: false, busy: false, summary: [], blocks: [], total: 0, retakes: [], h: null, v: null } };
      const r = load(pick);
      if (!r) return { status: 200, body: { runs, run: pick, made: false, busy: busyRun(pick), summary: [], blocks: [], total: 0, retakes: [], h: null, v: null } };
      const { blocks, total } = pieceBlocks(r.plan);
      const lines = (a) => (Array.isArray(a) ? a.slice(0, 20).map((x) => text(typeof x === 'string' ? x : x?.text, 200)).filter(Boolean) : []);
      return { status: 200, body: { runs, run: pick, made: r.h !== null, busy: busyRun(pick), summary: lines(r.clip.summary), blocks, total, retakes: lines(r.clip.retakes), h: r.h, v: r.v } };
    },
    retake(body) {
      if (!on()) return { status: 404, body: { error: 'beatdrop-off' } };
      const runs = knownRuns(dataDir);
      const run = isObj(body) && typeof body.run === 'string' && runs.includes(body.run) ? body.run : null;
      const r = run ? load(run) : null;
      const bad = retakeProblems(body, { runs, pieces: r ? pieceBlocks(r.plan).blocks.length : 0 });
      if (bad.length) return { status: 400, body: { error: 'bad-params', problems: bad } };
      if (!r || r.h === null) return { status: 409, body: { error: 'no-montage' } };
      if (!sourceOf(dataDir, run)) return { status: 409, body: { error: 'no-source', detail: 'the recording this montage came from is not known' } };
      if (busyRun(run)) return { status: 409, body: { error: 'busy', detail: 'a BeatDrop job for this run is already waiting or running' } };
      const dir = path.join(dataDir, 'clips');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${RETAKE_FILE}.tmp`), JSON.stringify({ run, op: body.op, ...(body.op === 'swap' ? { piece: body.piece } : {}), atMs: Date.now() }));
      renameSync(path.join(dir, `${RETAKE_FILE}.tmp`), path.join(dir, RETAKE_FILE));
      return { status: 200, body: { ok: true } };
    },
    play(body) {
      if (!on()) return { status: 404, body: { error: 'beatdrop-off' } };
      const runs = knownRuns(dataDir);
      if (!isObj(body) || Object.keys(body).some((k) => !['run', 'layout'].includes(k)) || typeof body.run !== 'string' || !runs.includes(body.run) || !['h', 'v'].includes(body.layout)) return { status: 400, body: { error: 'bad-params' } };
      const f = load(body.run)?.[body.layout];
      if (!f) return { status: 404, body: { error: 'no-video' } };
      return openFile(f) ? { status: 200, body: { ok: true } } : { status: 502, body: { error: 'open-failed' } };
    },
  };
}
