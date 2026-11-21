// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Clips > Reel styles (RS3, D412; plan docs/plan/2026-11-21-reel-styles-library.md). The rules live in
// Python (services/clip/reel_style.py and style_analyse.py); this module only runs them, one at a time, hidden:
//   GET  /ui/api/reel-styles  -> { flag, styles: [card], reelTypes, tune, maxExamples, job }
//   POST /ui/api/reel-styles  { op: 'create', name, paths } | { op: 'tune', id, tune } | { op: 'analyse', id }
//                             | { op: 'preview', id, src }
// Example videos are referenced by path only (never copied); what comes back is numbers and plain words. Analyse and
// preview run off air only (refused here while live, and Python checks again) and show in the task area.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killChildTree } from '../common/kill-tree.mjs';
import { isLive as streamLive, isRecording, pythonIn } from './record-clips.mjs';

// reel_style.py preview_dir(): the one preview folder, in the temp folder, emptied at start and at close
export const PREVIEW_DIR = path.join(os.tmpdir(), 'ujwalam-reel-style-preview');

export const REEL_STYLES_FLAG = 'reel-styles';
const OPS = { create: ['name', 'paths'], tune: ['id', 'tune'], analyse: ['id'], preview: ['id', 'src'] };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_JSON = 8000;

/** Problems with a POST body (shape only; Python checks the values); [] when fine. */
export function reelStyleOpProblems(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.hasOwn(OPS, b.op)) return [`op must be one of ${Object.keys(OPS).join(', ')}`];
  const extra = Object.keys(b).filter((k) => k !== 'op' && !OPS[b.op].includes(k));
  if (extra.length) return [`unknown ${extra.join(', ')}`];
  if ('id' in b || OPS[b.op].includes('id')) { if (typeof b.id !== 'string' || !ID.test(b.id)) return ['id must be a style id']; }
  if (b.op === 'create' && (typeof b.name !== 'string' || !Array.isArray(b.paths) || b.paths.some((p) => typeof p !== 'string'))) return ['create needs a name and example paths'];
  if (b.op === 'tune' && (!b.tune || typeof b.tune !== 'object' || Array.isArray(b.tune))) return ['tune must be an object'];
  if (b.op === 'preview' && typeof b.src !== 'string') return ['preview needs one of your clips'];
  if (JSON.stringify(b).length > MAX_JSON) return ['the request is too long'];
  return [];
}

/**
 * opts: { dataDir, clipRoot, tasks, isLive: () => bool, flagOn: () => bool, spawnFn, python (tests), ffmpeg,
 *   status: async () => outputs.status (the host), killTreeFn, watchMs, previewDir }.
 * While analyse or preview runs, outputs.status is read every watchMs: a stream or a recording that starts ends the
 * whole process tree, the rule record-clips uses for the long video (D406: isLive / isRecording, killChildTree).
 * -> { info(), run(body) -> { status, body }, close() } (the server answers with them).
 */
export function createReelStyles({ dataDir, clipRoot, tasks, isLive = () => false, flagOn = () => true, spawnFn = spawn, python = null, ffmpeg = process.env.UJWALAM_FFMPEG || 'ffmpeg',
  status = null, killTreeFn = killChildTree, watchMs = 2000, previewDir = PREVIEW_DIR }) {
  const clearPreviews = () => { try { rmSync(previewDir, { recursive: true, force: true }); } catch { /* in use: next time */ } };
  clearPreviews(); // a preview left by the last session
  const onAirNow = async () => { if (isLive()) return true; if (!status) return false; try { const st = await status(); return streamLive(st) || isRecording(st); } catch { return true; } };
  let job = null; // { op, id, state, note }: the one analyse or preview running (or the last one)
  const py = () => python ?? pythonIn(clipRoot)?.exe ?? null;
  const script = (n) => path.join(clipRoot, 'services', 'clip', n);

  function runPy(argv, onLine = null, onChild = null) {
    return new Promise((resolve) => {
      const exe = py();
      if (!exe) { resolve({ code: -1, out: '', err: "the clip maker's Python is missing" }); return; }
      let out = ''; let err = ''; let buf = '';
      let c;
      try { c = spawnFn(exe, ['-I', ...argv], { cwd: clipRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: '', err: String(e.message) }); return; }
      if (onChild) onChild(c);
      c.stdout.on('data', (d) => {
        out += d; buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (onLine && line) onLine(line); }
      });
      c.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
      c.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
      c.on('close', (code) => resolve({ code, out, err }));
    });
  }
  const lastJson = (out) => { const l = out.trim().split('\n').filter((x) => x.startsWith('{')).pop(); try { return l ? JSON.parse(l) : null; } catch { return null; } };
  const reason = (err) => (err.trim().split('\n').filter(Boolean).pop() ?? 'it did not finish').replace(/^(reel styles|style analysis): /, '').slice(0, 300);
  const styleArgs = (op, b) => [script('reel_style.py'), op, '--data-dir', dataDir, '--ffmpeg', ffmpeg, '--json', JSON.stringify(b)];

  async function info() {
    if (!flagOn()) return { flag: false, styles: [], job: null };
    const r = await runPy(styleArgs('list', {}));
    const j = r.code === 0 ? lastJson(r.out) : null;
    return j ? { flag: true, ...j, job } : { flag: true, styles: [], job, problem: reason(r.err) };
  }

  async function run(b) {
    if (!flagOn()) return { status: 404, body: { error: 'reel-styles-off' } };
    const p = reelStyleOpProblems(b);
    if (p.length) return { status: 400, body: { error: 'bad-params', detail: p.join('; ') } };
    const heavy = b.op === 'analyse' || b.op === 'preview';
    if (heavy && await onAirNow()) return { status: 409, body: { error: 'live', detail: 'Styles are analysed and previewed after the stream.' } };
    if (heavy && job?.state === 'running') return { status: 409, body: { error: 'busy', detail: 'A style is being analysed or previewed; try again when it finishes.' } };
    if (!heavy) {
      const r = await runPy(styleArgs(b.op, Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'op'))));
      const j = r.code === 0 ? lastJson(r.out) : null;
      return j ? { status: 200, body: j } : { status: 400, body: { error: 'not-saved', detail: reason(r.err) } };
    }
    const t = tasks.start({ title: b.op === 'analyse' ? 'Analysing a reel style' : 'Previewing a reel style on your clip', kind: 'reel-style' });
    job = { op: b.op, id: b.id, state: 'running', note: 'starting' };
    const done = (ok, note, extra = {}) => { job = { ...job, state: ok ? 'done' : 'failed', note, ...extra }; if (ok) t.done(note); else t.fail(note.slice(0, 160)); };
    const argv = b.op === 'analyse' ? [script('style_analyse.py'), '--data-dir', dataDir, '--style', b.id] : styleArgs('preview', { id: b.id, src: b.src });
    // runs on; the card polls GET for job. Watched: a stream or recording that starts ends the whole tree.
    let child = null; let stoppedFor = null;
    const watch = setInterval(async () => {
      if (child && !stoppedFor && await onAirNow()) { stoppedFor = 'a stream or recording started'; killTreeFn(child); }
    }, watchMs);
    watch.unref?.();
    runPy(argv, (line) => {
      const m = /^progress example (\d+)\/(\d+)$/.exec(line);
      if (m) { t.update({ done: Number(m[1]) - 1, total: Number(m[2]), note: `example ${m[1]} of ${m[2]}` }); job = { ...job, note: `example ${m[1]} of ${m[2]}` }; }
    }, (c) => { child = c; }).then((r) => {
      clearInterval(watch);
      const j = r.code === 0 && !stoppedFor ? lastJson(r.out) : null;
      if (stoppedFor) done(false, `Stopped: ${stoppedFor}. Analyse or preview again after it.`);
      else if (!j) done(false, `Not finished: ${reason(r.err)}`);
      else if (b.op === 'analyse') done(true, j.summary ?? 'analysed');
      else done(true, j.note ?? 'preview made', { previewFile: j.out });
    });
    return { status: 202, body: { job } };
  }
  return { info, run, job: () => job, close: clearPreviews };
}
