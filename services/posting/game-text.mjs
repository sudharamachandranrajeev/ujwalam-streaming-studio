// SPDX-License-Identifier: GPL-3.0-or-later
// The game in every AI post (user, 2026-11-25): the game's name in the title, its tags first, its hashtags. All values are
// data (data/games/<id>/posting.json "post"); nothing here names a game.
//   gamePost(game, { gamesDir }) -> { id, name, short, titleMatch: string[], tags, modeTags, hashtags } | null
//   gameTitle(title, g, max) -> the title with the game in it, or null (it does not fit)
//   gameTags(g, target, mode, rest) -> [game tags, mode tag, rest] (duplicates out, case-insensitive)
//   gameHashtags(g, target) -> string[] | null (null: keep the template's)
//   dropTemplateLead(description, templates) -> the description without a first paragraph that is a template's own
//     opening line ("Highlight 4 from the stream on 2026-11-12."): the AI lines replace it, the credit lines stay.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GAMES_DIR = path.join(REPO, 'data', 'games');
const GAME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);

/** The games that have post data. -> string[] */
export function postGames({ gamesDir = GAMES_DIR } = {}) {
  let dirs = [];
  try { dirs = readdirSync(gamesDir, { withFileTypes: true }).filter((d) => d.isDirectory() && GAME_ID.test(d.name)).map((d) => d.name); } catch { return []; }
  return dirs.filter((id) => gamePost(id, { gamesDir }) !== null).sort();
}

export function gamePost(game, { gamesDir = GAMES_DIR } = {}) {
  if (typeof game !== 'string' || !GAME_ID.test(game)) return null;
  let p;
  try { p = JSON.parse(readFileSync(path.join(gamesDir, game, 'posting.json'), 'utf8'))?.post; } catch { return null; }
  if (!p || typeof p.name !== 'string' || typeof p.short !== 'string' || !p.name.trim() || !p.short.trim()) return null;
  const per = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, strs(v)]));
  return {
    id: game, name: p.name.trim(), short: p.short.trim(),
    titleMatch: strs(p.titleMatch).map((s) => s.toLowerCase()).concat(p.short.trim().toLowerCase()),
    tags: per(p.tags), hashtags: per(p.hashtags),
    modeTags: Object.fromEntries(Object.entries(p.modeTags && typeof p.modeTags === 'object' ? p.modeTags : {}).filter(([, v]) => typeof v === 'string' && v.trim())),
  };
}

/** The post's game: its own when it has post data, else the one game that has post data (null when none or several). */
export function resolveGame(game, opts = {}) {
  if (gamePost(game, opts)) return game;
  const all = postGames(opts);
  return all.length === 1 ? all[0] : null;
}

export function gameTitle(title, g, max = null) {
  const t = String(title ?? '').trim();
  if (!g) return t || null;
  if (g.titleMatch.some((m) => t.toLowerCase().includes(m))) return t;
  const out = `${t} | ${g.short}`;
  return Number.isInteger(max) && [...out].length > max ? null : out;
}

const forTarget = (o, target) => (Object.hasOwn(o, target) ? o[target] : (o.default ?? []));

export function gameTags(g, target, mode, rest = []) {
  const first = g ? [...forTarget(g.tags, target)] : [];
  if (g && typeof mode === 'string' && mode.trim()) first.push(g.modeTags[mode] ?? (mode.trim().length <= 30 ? mode.trim().toLowerCase() : ''));
  const seen = new Set(); const out = [];
  for (const t of [...first, ...rest]) { const k = String(t ?? '').trim().toLowerCase(); if (!k || seen.has(k)) continue; seen.add(k); out.push(String(t).trim()); }
  return out;
}

export function gameHashtags(g, target) {
  if (!g) return null;
  const h = forTarget(g.hashtags, target);
  return h.length ? [...h] : null;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Every template description's first line (targets, and per-kind variants inside them) as a pattern: its placeholders
 *  ({n}, {date}) match any text on that line. A first line with no placeholder or with a link/handle is a credit: kept. */
function leadPatterns(templates) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.description === 'string') {
      const first = o.description.split('\n')[0].trim();
      if (/\{[\w]+\}/.test(first) && !/\{(?:handles|links)\./.test(first)) out.push(new RegExp(`^${first.split(/\{[\w.]+\}/).map(esc).join('[^\\n]+?')}$`));
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(templates?.targets);
  return out;
}

export function dropTemplateLead(description, templates) {
  const d = String(description ?? '');
  const lines = d.split('\n');
  if (!leadPatterns(templates).some((re) => re.test(lines[0].trim()))) return d;
  let i = 1;
  while (i < lines.length && !lines[i].trim()) i++;
  return i < lines.length ? lines.slice(i).join('\n') : d; // only the lead: nothing would be left, so it stays
}
