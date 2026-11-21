// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Clips > Montage music (D413 item 2, D414): the user's NCS library. The rules live in Python
// (services/clip/montage_music.py: the folder's drive rule, credits from tags or the file name, the credit checks);
// this module only runs it, hidden:
//   GET  /ui/api/montage-music  -> { tracks: [{ id, file, artist, title, line, link, source, edited, missing, complete }],
//                                    folder, folderProblem }
//   POST /ui/api/montage-music  { op: 'credit', id, credit: { artist, title, line, link } } -> { ok, complete }
// The folder comes from the saved settings (clips.montageMusic.folder), never from the request. The folder is read off
// air only (Codex BD review); while live (or unknown) the saved credits are listed with a plain note.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pythonIn } from './record-clips.mjs';
import { readSettings } from './user-settings.mjs';

const ID = /^[0-9a-f]{16}$/;
const CREDIT_KEYS = ['artist', 'title', 'line', 'link'];

/** Problems with a POST body (shape only; Python checks the values); [] when fine. */
export function montageMusicOpProblems(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b) || b.op !== 'credit') return ['op must be credit'];
  const extra = Object.keys(b).filter((k) => !['op', 'id', 'credit'].includes(k));
  if (extra.length) return [`unknown ${extra.join(', ')}`];
  if (typeof b.id !== 'string' || !ID.test(b.id)) return ['id must be a track of the folder'];
  const c = b.credit;
  if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((k) => !CREDIT_KEYS.includes(k))
    || CREDIT_KEYS.some((k) => k in c && (typeof c[k] !== 'string' || c[k].length > 400))) return ['credit must be { artist, title, line, link } as text'];
  return [];
}

/** opts: { dataDir, clipRoot, spawnFn, python (tests) } -> { info(), run(body) -> { status, body } }. */
export function createMontageMusic({ dataDir, clipRoot, spawnFn = spawn, python = null }) {
  const py = () => python ?? pythonIn(clipRoot)?.exe ?? null;
  const script = path.join(clipRoot, 'services', 'clip', 'montage_music.py');
  function runPy(op, body) {
    return new Promise((resolve) => {
      const exe = py();
      if (!exe) { resolve({ code: -1, out: '', err: "the clip maker's Python is missing" }); return; }
      let out = ''; let err = '';
      let c;
      try { c = spawnFn(exe, ['-I', script, op, '--data-dir', dataDir, '--json', JSON.stringify(body)], { cwd: clipRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ code: -1, out: '', err: String(e.message) }); return; }
      c.stdout.on('data', (d) => { out += d; if (out.length > 4_000_000) out = out.slice(-4_000_000); });
      c.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
      c.on('error', (e) => resolve({ code: -1, out, err: String(e.message) }));
      c.on('close', (code) => resolve({ code, out, err }));
    });
  }
  const lastJson = (out) => { const l = out.trim().split('\n').filter((x) => x.startsWith('{')).pop(); try { return l ? JSON.parse(l) : null; } catch { return null; } };
  const reason = (err) => (err.trim().split('\n').filter(Boolean).pop() ?? 'it did not finish').replace(/^montage music: /, '').slice(0, 300);
  const folder = () => readSettings(dataDir).clips.montageMusic?.folder ?? '';

  async function info() {
    const r = await runPy('list', { folder: folder() });
    const j = r.code === 0 ? lastJson(r.out) : null;
    return j ?? { tracks: [], folder: folder(), folderProblem: null, problem: reason(r.err) };
  }
  async function run(b) {
    const p = montageMusicOpProblems(b);
    if (p.length) return { status: 400, body: { error: 'bad-params', detail: p.join('; ') } };
    const r = await runPy('credit', { id: b.id, credit: b.credit });
    const j = r.code === 0 ? lastJson(r.out) : null;
    return j ? { status: 200, body: j } : { status: 400, body: { error: 'not-saved', detail: reason(r.err) } };
  }
  return { info, run };
}
