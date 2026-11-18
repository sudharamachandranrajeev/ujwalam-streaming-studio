// SPDX-License-Identifier: GPL-3.0-or-later
// Built-in cyberpunk stingers (D391): the presets in data/transitions/stingers/<id>.json (made by tools/make-stingers.mjs)
// and the project transition each one stands for. Node stdlib only; read only. A page or request names a stinger by id
// only, never by path: the file is always base "data", rel "transitions/stingers/<id>-<h|v>.webm".
//
//   listStingerPresets(dir?)            -> [{ id, label, description, pointMs, durationMs, default }]  (sorted, default first)
//   defaultStingerId(dir?)              -> id of the preset marked "default" ('neon-glitch')
//   stingerTransition(id, canvasId, dir?) -> { type: 'stinger', durationMs: 0, file: { base: 'data', rel }, pointMs }
//   isImportedFade(transition, canvasId) -> true for no transition or the Meld session's plain fade (H 2006 ms, V 1000 ms)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STINGER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'transitions', 'stingers');
export const STINGER_ID_RE = /^[a-z][a-z0-9-]{0,40}$/;
export const IMPORTED_FADE_MS = Object.freeze({ h: 2006, v: 1000 });

export function listStingerPresets(dir = STINGER_DIR) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const f of names) {
    const m = /^([a-z][a-z0-9-]*)\.json$/.exec(f);
    if (!m) continue;
    let p;
    try { p = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (p?.id !== m[1] || !STINGER_ID_RE.test(p.id) || !Number.isInteger(p.pointMs) || !Number.isInteger(p.durationMs) || typeof p.label !== 'string') continue;
    // a preset without both canvas files is not offered
    if (!['h', 'v'].every((c) => existsSync(path.join(dir, `${p.id}-${c}.webm`)))) continue;
    out.push({ id: p.id, label: p.label, description: typeof p.description === 'string' ? p.description : '', pointMs: p.pointMs, durationMs: p.durationMs, default: p.default === true });
  }
  return out.sort((a, b) => Number(b.default) - Number(a.default) || a.id.localeCompare(b.id));
}

export function defaultStingerId(dir = STINGER_DIR) {
  return listStingerPresets(dir).find((p) => p.default)?.id ?? null;
}

export function stingerTransition(id, canvasId, dir = STINGER_DIR) {
  if (canvasId !== 'h' && canvasId !== 'v') throw new RangeError('canvas must be h or v');
  const p = listStingerPresets(dir).find((x) => x.id === id);
  if (!p) throw new RangeError(`unknown stinger preset ${String(id).slice(0, 40)}`);
  return { type: 'stinger', durationMs: 0, file: { base: 'data', rel: `transitions/stingers/${p.id}-${canvasId}.webm` }, pointMs: p.pointMs };
}

export function isImportedFade(t, canvasId) {
  if (t === undefined || t === null) return true;
  return t.type === 'fade' && t.durationMs === IMPORTED_FADE_MS[canvasId] && t.easing === undefined && t.mirror === undefined;
}
