// SPDX-License-Identifier: GPL-3.0-or-later
// RL5 (D445, plan docs/plan/2026-11-25-realism-looks.md): the user's own realism looks, made from a reference picture
// or short video. The measuring lives in Python (services/clip/look_reference.py, which reuses the Reel styles colour
// analysis); this module runs it, hidden and at below-normal priority, and renames or deletes the user's looks.
//   POST /ui/api/looks { op: 'from-reference', path, name? } -> 200 { look: summary, basedOn: { id, name }, measured }
//                      { op: 'rename', id, name }            -> 200 { look: summary }
//                      { op: 'delete', id }                  -> 200 { ok: true }
// Only measured numbers are saved (<data>/looks/user-<name>.json + .cube); the reference file is only read, never
// copied, kept or posted. Rename and delete touch only "user-..." looks; a built-in look is never changed.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanLookName, deleteUserLook, lookSummary, renameUserLook, userLooksDir } from '../project/looks.mjs';
import { pythonIn } from './record-clips.mjs';

export const REFERENCE_EXT = ['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.mp4', '.mov', '.m4v', '.mkv', '.webm'];
const OPS = { 'from-reference': ['path', 'name'], rename: ['id', 'name'], delete: ['id'] };
const REQUIRED = { 'from-reference': ['path'], rename: ['id', 'name'], delete: ['id'] };
const USER_ID = /^user-[a-z0-9-]{1,27}$/;
const ERRORS = { 'not-your-look': 'Only your own looks can be renamed or deleted.', 'unknown-look': 'That look is not there any more.',
  'bad-name': 'Give the look a name of 1 to 24 characters.' };

/** Problems with a POST body (shape only); [] when fine. */
export function userLookOpProblems(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || !Object.hasOwn(OPS, b.op)) return [`op must be one of ${Object.keys(OPS).join(', ')}`];
  const extra = Object.keys(b).filter((k) => k !== 'op' && !OPS[b.op].includes(k));
  if (extra.length) return [`unknown ${extra.join(', ')}`];
  const missing = REQUIRED[b.op].filter((k) => b[k] === undefined);
  if (missing.length) return [`${b.op} needs ${missing.join(', ')}`];
  if (b.id !== undefined && (typeof b.id !== 'string' || !USER_ID.test(b.id))) return ['Only your own looks can be renamed or deleted.'];
  if (b.name !== undefined && b.name !== '' && !cleanLookName(b.name)) return [ERRORS['bad-name']];
  if (b.path !== undefined) {
    if (typeof b.path !== 'string' || b.path.length > 1024 || !path.isAbsolute(b.path)) return ['Pick a picture or video file (its full path).'];
    if (!REFERENCE_EXT.includes(path.extname(b.path).toLowerCase())) return [`Pick a picture or video: ${REFERENCE_EXT.join(', ')}.`];
  }
  return [];
}

/**
 * opts: { dataDir, clipRoot, flagOn: () => bool, spawnFn, python (tests) }
 * -> { run(body) -> Promise<{ status, body }>, dir }
 */
export function createUserLooks({ dataDir, clipRoot, flagOn = () => true, spawnFn = spawn, python = null }) {
  const dir = userLooksDir(dataDir);
  let busy = false;
  const py = () => python ?? pythonIn(clipRoot)?.exe ?? null;

  function runPy(argv) {
    return new Promise((resolve) => {
      const exe = py();
      if (!exe) { resolve({ code: -1, out: '', err: "the clip maker's Python is missing" }); return; }
      let out = ''; let err = ''; let c;
      try { c = spawnFn(exe, ['-I', ...argv], { cwd: clipRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: '', err: String(e.message) }); return; }
      try { if (c.pid) os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* it lowers its own priority too */ }
      c.stdout.on('data', (d) => { out += d; if (out.length > 100000) out = out.slice(-100000); });
      c.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
      c.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
      c.on('close', (code) => resolve({ code, out, err }));
    });
  }
  const lastJson = (out) => { const l = out.trim().split('\n').filter((x) => x.startsWith('{')).pop(); try { return l ? JSON.parse(l) : null; } catch { return null; } };
  const reason = (err) => (err.trim().split('\n').filter(Boolean).pop() ?? 'it did not finish').replace(/^new look: /, '').slice(0, 300);

  async function run(b) {
    if (!flagOn()) return { status: 404, body: { error: 'realism-look-off' } };
    const p = userLookOpProblems(b);
    if (p.length) return { status: 400, body: { error: 'bad-params', detail: p.join('; ') } };
    if (b.op === 'rename' || b.op === 'delete') {
      let r;
      try { r = b.op === 'rename' ? renameUserLook(dir, b.id, b.name) : deleteUserLook(dir, b.id); } catch (e) { return { status: 500, body: { error: 'not-saved', detail: String(e.message).slice(0, 200) } }; }
      if (r.error) return { status: r.error === 'unknown-look' ? 404 : 400, body: { error: r.error, detail: ERRORS[r.error] } };
      return { status: 200, body: r.look ? { look: lookSummary(r.look) } : { ok: true } };
    }
    try { if (!statSync(b.path).isFile()) throw new Error('not a file'); } catch { return { status: 400, body: { error: 'no-file', detail: 'That file is not there.' } }; }
    if (busy) return { status: 409, body: { error: 'busy', detail: 'A look is being made; try again in a moment.' } };
    busy = true;
    try {
      const r = await runPy([path.join(clipRoot, 'services', 'clip', 'look_reference.py'), 'make', '--data-dir', dataDir,
        '--json', JSON.stringify({ path: b.path, name: cleanLookName(b.name ?? '') ?? '' })]);
      const j = r.code === 0 ? lastJson(r.out) : null;
      if (!j?.look) return { status: 400, body: { error: 'not-made', detail: reason(r.err) } };
      return { status: 200, body: { look: lookSummary(j.look), basedOn: j.basedOn, measured: j.measured } };
    } finally { busy = false; }
  }
  return { run, dir };
}
