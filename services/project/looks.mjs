// SPDX-License-Identifier: GPL-3.0-or-later
// Realism looks (D445, plan 2026-11-25-realism-looks RL1): the look library in data/looks/<id>.json (schema
// data/schemas/look.schema.json; LUTs from tools/make-look-luts.mjs). Read only; stdlib only.
//
//   loadLooks(dir?) -> [look] sorted for the menu: Filmic first, then by name. A file that is not a look (bad JSON, id
//                      not its file name, no effects, first effect not a LUT on base luts) is skipped, so one broken file
//                      never hides the others. Each call reads the folder again (a handful of small files).
//   lookSummary(look) -> { id, name, summary, swatch } for the studio menu
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'looks');
export const DEFAULT_LOOK = 'filmic';
const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function usable(look, file) {
  if (!look || typeof look !== 'object' || look.version !== 1 || !ID_RE.test(look.id ?? '') || `${look.id}.json` !== file) return false;
  if (typeof look.name !== 'string' || !look.name.trim() || look.name.length > 24) return false;
  if (!Array.isArray(look.effects) || !look.effects.length || !Array.isArray(look.backdrop)) return false;
  const lut = look.effects[0];
  return lut?.type === 'lut' && lut.file?.base === 'luts' && typeof lut.file.rel === 'string';
}

export function loadLooks(dir = LOOKS_DIR) {
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    let look;
    try { look = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (usable(look, f)) out.push(look);
  }
  return out.sort((a, b) => (a.id === DEFAULT_LOOK ? -1 : b.id === DEFAULT_LOOK ? 1 : a.name.localeCompare(b.name)));
}

export const lookSummary = (l) => ({ id: l.id, name: l.name, summary: typeof l.summary === 'string' ? l.summary : '',
  swatch: Array.isArray(l.swatch) ? l.swatch.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) : [] });
