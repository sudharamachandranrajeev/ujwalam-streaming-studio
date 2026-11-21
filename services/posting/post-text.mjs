// SPDX-License-Identifier: GPL-3.0-or-later
// PT1 (D408): post text from the clip's facts. The lines are data (data/posting/templates.json textPools per kind, plus
// data/games/<id>/posting.json per game); a line that names a fact the clip does not have is left out (never guessed),
// a line over the platform's title limit (data/posting/limits.json) is left out, and the last N lines used are not used
// again. The pick is seeded by the clip's bytes, so the same clip gets the same text. Pure except the history file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEXT_HISTORY_NAME = 'text-history.json';
/** The facts a line may name (services/clip/reel_thumbnail.py facts(), carried in post.json source.facts) and {kills}. */
export const FACT_KEYS = Object.freeze(['medal', 'killsText', 'kills', 'result', 'mode']);
const FACT_RE = /\{(medal|killsText|kills|result|mode)\}/g;
const GAME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** The clip's facts as stored: only known keys, short plain strings; {kills} from killsText ("3 KILLS"). */
export function cleanFacts(f) {
  if (!isPlain(f)) return {};
  const out = {};
  for (const k of ['medal', 'killsText', 'result', 'mode']) {
    const v = f[k];
    if (typeof v === 'string' && v.trim() && v.length <= 40 && !/[{}<>\n]/.test(v)) out[k] = v.trim();
  }
  const m = /^(\d{1,3}) KILLS?$/i.exec(out.killsText ?? '');
  if (m) out.kills = m[1];
  return out;
}

/** The pools for a kind: the shared lines (templates.textPools) plus the game's (data/games/<id>/posting.json). */
export function poolsFor(templates, kind, game, { gamesDir = path.join(REPO, 'data', 'games') } = {}) {
  const base = isPlain(templates?.textPools?.[kind]) ? templates.textPools[kind] : {};
  let g = {};
  if (typeof game === 'string' && GAME_ID.test(game)) {
    const j = readJson(path.join(gamesDir, game, 'posting.json'));
    if (isPlain(j?.textPools?.[kind])) g = j.textPools[kind];
  }
  const lines = (k) => [...(Array.isArray(base[k]) ? base[k] : []), ...(Array.isArray(g[k]) ? g[k] : [])].filter((s) => typeof s === 'string' && s.trim());
  return { title: lines('title'), lead: lines('lead') };
}

/** Fills a line's fact placeholders; null when a fact it names is missing. Other placeholders stay for renderText. */
export function fillFacts(line, facts) {
  let ok = true;
  const s = line.replace(FACT_RE, (_m, k) => { if (facts[k] === undefined) { ok = false; return ''; } return facts[k]; });
  return ok ? s : null;
}

const hash32 = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };

/** Picks one line: those whose facts are known and that fit `fits`, not in `recent`, seeded. -> { line, text } | null. */
export function pickLine(lines, facts, { seed, recent = [], fits = () => true }) {
  const ok = lines.map((line) => ({ line, text: fillFacts(line, facts) })).filter((x) => x.text !== null && fits(x.text));
  if (!ok.length) return null;
  const fresh = ok.filter((x) => !recent.includes(x.line));
  if (fresh.length) return fresh[hash32(`${seed}:${fresh.length}`) % fresh.length];
  // every fitting line was used lately: the one used longest ago repeats rather than none
  return ok.reduce((a, b) => (recent.lastIndexOf(b.line) < recent.lastIndexOf(a.line) ? b : a));
}

export function createTextHistory(dataDir, keep = 20) {
  const file = path.join(dataDir, 'posting', TEXT_HISTORY_NAME);
  const read = () => { const j = readJson(file); return Array.isArray(j?.lines) ? j.lines.filter((s) => typeof s === 'string') : []; };
  return {
    recent: () => read().slice(-keep),
    add(...lines) {
      const all = [...read(), ...lines.filter(Boolean)].slice(-Math.max(keep, 1) * 4);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, lines: all }));
      renameSync(`${file}.tmp`, file);
    },
  };
}

/** Title and lead for one clip. maxTitle: the title limit in characters (null = none); the rendered length is checked
 *  by the caller's limits check too. -> { title: {line,text}|null, lead: {line,text}|null } */
export function draftText({ templates, kind, game, facts, seed, recent = [], maxTitle = null, gamesDir }) {
  const f = cleanFacts(facts);
  const pools = poolsFor(templates, kind, game, gamesDir ? { gamesDir } : undefined);
  const fits = (s) => maxTitle === null || Array.from(s).length <= maxTitle;
  return {
    title: pickLine(pools.title, f, { seed: `${seed}:t`, recent, fits }),
    lead: pickLine(pools.lead, f, { seed: `${seed}:l`, recent }),
  };
}
