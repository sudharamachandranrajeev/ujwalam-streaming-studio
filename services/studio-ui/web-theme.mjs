// SPDX-License-Identifier: GPL-3.0-or-later
// Web theme (Q5, flag `web-theme`): turns a studio theme pack (data/themes/<id>.json) into the control page's
// /css/tokens.css, so the page looks like the studio. Stdlib only. Every variable name of the static ui/css/tokens.css
// is kept (app.css and other pages keep working); packs are checked by hand here (ajv is a dev dependency only).
//
// Mapping (pack -> variable):
//   colors.bg -> --color-bg                  colors.panel -> --color-surface        colors.field -> --color-surface-2
//   colors.border -> --color-border          colors.text -> --color-text            colors.muted -> --color-text-dim
//   colors.accent -> --color-accent and --color-tab-on-bg     colors.accentHi -> --color-accent-hi (new)
//   colors.onAccent -> --color-accent-text, --color-live-text, --color-tab-on-text
//   colors.danger -> --color-live            colors.ok -> --color-ok                colors.disabled -> --color-disabled (new)
// Derived (fixed rules, the same pack always gives the same CSS):
//   --color-meter-bg  = field mixed toward black by 0.28 (dark pack) or 0.06 (light pack), as the studio's "well"
//   --color-text-on-accent-dim = onAccent mixed toward accent by 0.25
//   --color-warn      = amber (#d9a441 dark pack, #8a5a00 light pack), moved toward black or white in 5 % steps until
//                       the onAccent text on it has 4.5:1 (or 20 steps)
//   --color-blocked   = violet (#7a3fd1), moved the same way until the onAccent text on it has 4.5:1
//   --color-scrim     = black at 0.6 (dark pack) or 0.45 (light pack)
// Type: --font-ui = typography.family, its fallbacks, then system-ui and sans-serif (names only: no font file is ever
//   linked, Microsoft fonts included; a family the PC does not have falls through to the next). --font-mono is fixed.
//   --text-md = baseSize pt in px (x 4/3), --text-sm = captionSize in px (at least 11), --text-lg = md + 2.
// Shape: --radius = geometry.radius.medium; --space-1/-2/-4 = geometry.spacing small/medium/large, --space-3 = 1.5 x medium.
// Motion: --anim-in = motion.normalMs (at most 500), --anim-out = motion.fastMs (at most 350): entrances < 600, exits < 400.
// Layout sizes (--topbar-h, --statusbar-h, --left-w, --right-w) are fixed, as in the static file.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, mix } from './theme-contrast.mjs';

export const WEB_THEME_FLAG = 'web-theme';
export const DEFAULT_THEME_ID = 'violet-night'; // what the studio uses until the user picks one (theme.cpp kDefaultId)
export const THEME_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const REPO_THEMES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'themes');
export const COLOR_KEYS = Object.freeze(['bg', 'panel', 'field', 'border', 'text', 'muted', 'accent', 'accentHi', 'danger', 'ok', 'onAccent', 'disabled']);
// Every variable the page and the other pages may use: the static file's names plus the new ones.
export const TOKEN_NAMES = Object.freeze([
  '--color-bg', '--color-surface', '--color-surface-2', '--color-border', '--color-text', '--color-text-dim', '--color-accent',
  '--color-accent-text', '--color-live', '--color-live-text', '--color-ok', '--color-warn', '--color-blocked', '--color-meter-bg',
  '--color-text-on-accent-dim', '--color-tab-on-bg', '--color-tab-on-text', '--color-scrim', '--color-accent-hi', '--color-disabled',
  '--font-ui', '--font-mono', '--text-sm', '--text-md', '--text-lg', '--space-1', '--space-2', '--space-3', '--space-4', '--radius',
  '--topbar-h', '--statusbar-h', '--left-w', '--right-w', '--anim-in', '--anim-out',
]);

const HEX = /^#[0-9a-fA-F]{6}$/;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/; // a font name only: no quotes, commas or braces reach the CSS
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/** Problems with a pack for the web page; [] when it can be turned into tokens. */
export function packProblems(p) {
  const bad = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['not an object'];
  if (typeof p.id !== 'string' || !THEME_ID.test(p.id) || p.id.length > 40) bad.push('id');
  if (typeof p.dark !== 'boolean') bad.push('dark');
  for (const k of COLOR_KEYS) if (typeof p.colors?.[k] !== 'string' || !HEX.test(p.colors[k])) bad.push(`colors.${k}`);
  const t = p.typography;
  if (typeof t?.family !== 'string' || !FAMILY.test(t.family)) bad.push('typography.family');
  if (t?.fallbacks !== undefined && (!Array.isArray(t.fallbacks) || t.fallbacks.length > 4 || t.fallbacks.some((f) => typeof f !== 'string' || !FAMILY.test(f)))) bad.push('typography.fallbacks');
  if (!num(t?.baseSize, 8, 14)) bad.push('typography.baseSize');
  if (!num(t?.captionSize, 6, 12)) bad.push('typography.captionSize');
  for (const k of ['small', 'medium', 'large']) {
    if (!num(p.geometry?.radius?.[k], 0, 40)) bad.push(`geometry.radius.${k}`);
    if (!num(p.geometry?.spacing?.[k], 1, 40)) bad.push(`geometry.spacing.${k}`);
  }
  if (!num(p.motion?.normalMs, 0, 5000)) bad.push('motion.normalMs');
  if (!num(p.motion?.fastMs, 0, 5000)) bad.push('motion.fastMs');
  return bad;
}

// Move `color` toward black (light ink) or white (dark ink) until `ink` on it reaches 4.5:1; fixed 5 % steps.
function fitInk(color, ink) {
  const toward = contrast('#000000', ink) > contrast('#ffffff', ink) ? '#000000' : '#ffffff';
  let c = color;
  for (let i = 0; i < 20 && contrast(c, ink) < 4.5; i++) c = mix(c, toward, 0.05);
  return c;
}
const px = (pt) => Math.round((pt * 4) / 3);

/** The token values for a pack: { '--color-bg': '#...', ... } in TOKEN_NAMES order. Throws on a bad pack. */
export function tokensFromPack(p) {
  const bad = packProblems(p);
  if (bad.length) throw new Error(`theme pack not usable: ${bad.join(', ')}`);
  const c = Object.fromEntries(COLOR_KEYS.map((k) => [k, p.colors[k].toLowerCase()]));
  const dark = p.dark;
  const g = p.geometry, t = p.typography, m = p.motion;
  const fam = [t.family, ...(t.fallbacks ?? [])].map((f) => (f.includes(' ') ? `"${f}"` : f)).join(', ');
  const md = px(t.baseSize);
  const v = {
    '--color-bg': c.bg, '--color-surface': c.panel, '--color-surface-2': c.field, '--color-border': c.border,
    '--color-text': c.text, '--color-text-dim': c.muted, '--color-accent': c.accent, '--color-accent-text': c.onAccent,
    '--color-live': c.danger, '--color-live-text': c.onAccent, '--color-ok': c.ok,
    '--color-warn': fitInk(dark ? '#d9a441' : '#8a5a00', c.onAccent),
    '--color-blocked': fitInk('#7a3fd1', c.onAccent),
    '--color-meter-bg': mix(c.field, '#000000', dark ? 0.28 : 0.06),
    '--color-text-on-accent-dim': mix(c.onAccent, c.accent, 0.25),
    '--color-tab-on-bg': c.accent, '--color-tab-on-text': c.onAccent,
    '--color-scrim': dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.45)',
    '--color-accent-hi': c.accentHi, '--color-disabled': c.disabled,
    '--font-ui': `${fam}, system-ui, sans-serif`,
    '--font-mono': 'ui-monospace, "Cascadia Mono", monospace',
    '--text-sm': `${Math.max(11, px(t.captionSize))}px`, '--text-md': `${md}px`, '--text-lg': `${md + 2}px`,
    '--space-1': `${g.spacing.small}px`, '--space-2': `${g.spacing.medium}px`, '--space-3': `${Math.round(g.spacing.medium * 1.5)}px`,
    '--space-4': `${g.spacing.large}px`, '--radius': `${g.radius.medium}px`,
    '--topbar-h': '48px', '--statusbar-h': '28px', '--left-w': '260px', '--right-w': '300px',
    '--anim-in': `${Math.round(Math.min(m.normalMs, 500))}ms`, '--anim-out': `${Math.round(Math.min(m.fastMs, 350))}ms`,
  };
  return Object.fromEntries(TOKEN_NAMES.map((n) => [n, v[n]]));
}

/** The tokens.css text for a pack (the same pack gives the same text). */
export function tokensCss(p) {
  const v = tokensFromPack(p);
  const lines = TOKEN_NAMES.map((n) => `  ${n}: ${v[n]};`);
  return `/* SPDX-License-Identifier: GPL-3.0-or-later */\n/* Generated from studio theme "${p.id}" (services/studio-ui/web-theme.mjs). Do not edit. */\n:root {\n  color-scheme: ${p.dark ? 'dark' : 'light'};\n${lines.join('\n')}\n}\n`;
}

/** Folders searched for a pack, first match wins (the studio's order, as far as the web server can know it):
 *  UJWALAM_THEMES_DIR, the user's custom themes (%APPDATA%/Ujwalam Studio/themes), the repo's data/themes. */
export function defaultThemeDirs(env = process.env) {
  const d = [];
  if (env.UJWALAM_THEMES_DIR) d.push(env.UJWALAM_THEMES_DIR);
  const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  d.push(path.join(appData, 'Ujwalam Studio', 'themes'), REPO_THEMES);
  return d;
}

/** Load one pack by id from the folders; null when the id is not a plain theme id, the file is missing, over 64 KB, not
 *  JSON, unusable, or the pack's own id differs from the file name. The id must match THEME_ID, so it cannot leave a folder. */
export function loadPack(id, dirs) {
  if (typeof id !== 'string' || id.length > 40 || !THEME_ID.test(id)) return null;
  for (const dir of dirs) {
    try {
      const base = realpathSync(dir);
      const file = realpathSync(path.join(base, `${id}.json`));
      if (path.dirname(file) !== base) continue;
      const st = statSync(file);
      if (!st.isFile() || st.size > 65536) continue;
      const pack = JSON.parse(readFileSync(file, 'utf8'));
      if (pack?.id !== id || packProblems(pack).length) continue;
      return pack;
    } catch { /* next folder */ }
  }
  return null;
}

/** tokens.css text for a theme id (default: the studio's default), or null when unknown or broken (the caller serves the static file). */
// The saved id of the pack Ujwalam Light replaced (D389): the old Soft choice opens the light pack (theme.cpp migratedId).
export const MIGRATED_THEME_IDS = { soft: 'ujwalam-light' };
export function tokensCssFor(id, dirs = defaultThemeDirs()) {
  const pack = loadPack(MIGRATED_THEME_IDS[id] ?? id ?? DEFAULT_THEME_ID, dirs);
  return pack ? tokensCss(pack) : null;
}
