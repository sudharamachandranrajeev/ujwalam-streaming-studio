// SPDX-License-Identifier: GPL-3.0-or-later
// Realism looks (D445, plan 2026-11-25-realism-looks RL1): the look library in data/looks/<id>.json (schema
// data/schemas/look.schema.json; LUTs from tools/make-look-luts.mjs). Read only; stdlib only.
//
//   loadLooks(dir?, userDir?) -> [look] sorted for the menu: Filmic first, then the built-in looks by name, then the
//                      user's own looks by name (RL5: userDir = <data>/looks, ids "user-...", LUT on base userluts; made
//                      by services/clip/look_reference.py). A file that is not a look (bad JSON, id not its file name, no
//                      effects, first effect not a LUT on the right base, a "user-" id among the built-ins or the other
//                      way round) is skipped, so one broken file never hides the others. Each call reads the folders again.
//   lookSummary(look) -> { id, name, summary, swatch, own, basedOn } for the studio menu (own: one of the user's looks)
//   userLooksDir(dataDir) -> <data>/looks
//   renameUserLook(dir, id, name) / deleteUserLook(dir, id) -> { ok: true, look? } | { error } (only "user-..." looks)
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'looks');
export const DEFAULT_LOOK = 'filmic';
export const USER_PREFIX = 'user-';
export const USER_BASE = 'userluts';
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const USER_ID_RE = /^user-[a-z0-9-]{1,27}$/;
const REL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.cube$/;

export const userLooksDir = (dataDir) => path.join(path.resolve(dataDir), 'looks');

function usable(look, file, base = 'luts') {
  if (!look || typeof look !== 'object' || look.version !== 1 || !ID_RE.test(look.id ?? '') || `${look.id}.json` !== file) return false;
  if ((base === 'luts') === look.id.startsWith(USER_PREFIX)) return false;
  if (typeof look.name !== 'string' || !look.name.trim() || look.name.length > 24) return false;
  if (!Array.isArray(look.effects) || !look.effects.length || !Array.isArray(look.backdrop)) return false;
  const lut = look.effects[0];
  return lut?.type === 'lut' && lut.file?.base === base && typeof lut.file.rel === 'string' && (base === 'luts' || REL_RE.test(lut.file.rel));
}

function readDir(dir, base) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    let look;
    try { look = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (usable(look, f, base)) out.push(look);
  }
  return out;
}

export function loadLooks(dir = LOOKS_DIR, userDir = null) {
  const own = readDir(dir, 'luts').sort((a, b) => (a.id === DEFAULT_LOOK ? -1 : b.id === DEFAULT_LOOK ? 1 : a.name.localeCompare(b.name)));
  return userDir ? [...own, ...readDir(userDir, USER_BASE).sort((a, b) => a.name.localeCompare(b.name))] : own;
}

export const lookSummary = (l) => ({ id: l.id, name: l.name, summary: typeof l.summary === 'string' ? l.summary : '',
  swatch: Array.isArray(l.swatch) ? l.swatch.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) : [],
  ...(l.id.startsWith(USER_PREFIX) ? { own: true, basedOn: typeof l.measured?.basedOn === 'string' ? l.measured.basedOn : null } : {}) });

/** A user look's name as the studio saves it: spaces folded, 1..24 characters; null when nothing is left. */
export function cleanLookName(n) {
  if (typeof n !== 'string') return null;
  const s = n.replace(/\s+/g, ' ').trim();
  return s && s.length <= 24 ? s : null;
}

function ownLook(dir, id) {
  if (typeof id !== 'string' || !USER_ID_RE.test(id)) return { error: 'not-your-look' };
  const file = path.join(dir, `${id}.json`);
  let look;
  try { look = JSON.parse(readFileSync(file, 'utf8')); } catch { return { error: 'unknown-look' }; }
  if (!usable(look, `${id}.json`, USER_BASE)) return { error: 'unknown-look' };
  return { look, file };
}

export function renameUserLook(dir, id, name) {
  const nm = cleanLookName(name);
  if (!nm) return { error: 'bad-name' };
  const o = ownLook(dir, id);
  if (o.error) return o;
  const look = { ...o.look, name: nm };
  const tmp = `${o.file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(look, null, 2) + '\n', 'utf8');
  renameSync(tmp, o.file);
  return { ok: true, look };
}

/** Removes <id>.json and its LUT (the id stays reserved by nothing: a new look may take it again). */
export function deleteUserLook(dir, id) {
  const o = ownLook(dir, id);
  if (o.error) return o;
  const cube = path.join(dir, path.basename(o.look.effects[0].file.rel));
  rmSync(o.file, { force: true });
  if (existsSync(cube) && path.dirname(cube) === path.resolve(dir)) rmSync(cube, { force: true });
  return { ok: true };
}
