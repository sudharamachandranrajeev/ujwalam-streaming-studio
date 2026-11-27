// SPDX-License-Identifier: GPL-3.0-or-later
// Reach text (2026-11-27): the base of every post's text. Hook-first title, caption, CTA, live/community lines and a small
// hashtag set come from data/posting/post-text-library.json (research: docs/evidence/2026-11-27-post-text-reach.md).
// Pure and deterministic: the same clip (seed) gets the same text; a line whose slot has no value is not used (never
// guessed); a title over the platform limit is not used; recent lines and hashtags are not repeated. The local model
// (ai-text.mjs) only adapts this draft lightly, and when it is off this draft is the text.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LIBRARY_FILE = path.join(REPO, 'data', 'posting', 'post-text-library.json');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash32 = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const len = (s) => Array.from(String(s)).length;
const HASHTAG = /^#[\p{L}\p{N}_]{2,40}$/u;

export function loadLibrary(file = LIBRARY_FILE) {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return isPlain(j?.platforms) ? j : null; } catch { return null; }
}

/** Slot values for one clip. Missing = undefined (the line is not used). */
export function slotValues({ facts = {}, game = null, mode = null, profile = {} }) {
  const modeName = typeof mode === 'string' && mode.trim() ? (game?.modeNames?.[mode.trim()] ?? mode.trim()) : null;
  const h = isPlain(profile.handles) ? profile.handles : {};
  const l = isPlain(profile.links) ? profile.links : {};
  const gh = Array.isArray(game?.hashtags?.default) ? game.hashtags.default : [];
  return {
    game: game?.short, gameFull: game?.name, kills: facts.kills, killsText: facts.killsText, result: facts.result,
    weapon: facts.weapon, map: facts.map, mode: modeName ?? undefined, streamer: h.twitch ?? h.youtube, channel: h.youtube ?? h.twitch,
    community: l.discord, gameTag: gh[0], gameTag2: gh[1],
  };
}
const fill = (line, v) => {
  let ok = true;
  const s = String(line).replace(/\{(\w+)\}/g, (_m, k) => { const x = v[k]; if (typeof x !== 'string' && typeof x !== 'number') { ok = false; return ''; } const t = String(x).trim(); if (!t) ok = false; return t; });
  return ok ? s.replace(/\s+/g, ' ').trim() : null;
};
const pickOne = (cands, seed, recent) => {
  if (!cands.length) return null;
  const fresh = cands.filter((c) => !recent.includes(c.id));
  if (fresh.length) return fresh[hash32(`${seed}:${fresh.length}`) % fresh.length];
  return cands.reduce((a, b) => (recent.lastIndexOf(b.id) < recent.lastIndexOf(a.id) ? b : a));
};
const strs = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()) : []);

/**
 * -> null (no library entry: the caller keeps its own text) | { title, lead, cta, live: string[], description, hashtags, used: string[], kind }
 * Args: library, target (youtube-shorts | youtube-video | instagram-reels), kind (a clip row kind), facts (cleanFacts), game (gamePost() object or null),
 * mode, profile (cleaned local profile), seed, recent (ids from the history), titleMax, hashtagLimit (hard limit of the platform, optional).
 * The target "x" is data only (status planned) and returns null until an uploader exists.
 */
export function reachDraft({ library, target, kind, facts = {}, game = null, mode = null, profile = {}, seed = '', recent = [], titleMax = null, hashtagLimit = null }) {
  const lib = library ?? loadLibrary();
  const plat = lib?.platforms?.[target];
  const libKind = lib?.kindMap?.[kind] ?? kind;
  const k = plat?.kinds?.[libKind];
  if (!isPlain(plat) || !isPlain(k) || plat.status === 'planned') return null;
  const v = slotValues({ facts, game, mode: mode ?? facts.mode, profile });
  const id = (p, i) => `r:${target}:${libKind}:${p}${i}`;
  const cands = (list, p) => strs(list).map((line, i) => ({ id: id(p, i), text: fill(line, v) })).filter((c) => c.text);
  const soft = Number.isInteger(plat.titleSoftMax) ? plat.titleSoftMax : null;
  let titles = cands(k.titles, 't').filter((c) => titleMax === null || len(c.text) <= titleMax);
  const short = soft === null ? titles : titles.filter((c) => len(c.text) <= soft);
  if (short.length) titles = short;
  const title = pickOne(titles, `${seed}:t`, recent);
  if (!title) return null;
  const lead = pickOne(cands(k.captions, 'c'), `${seed}:c`, recent);
  const cta = pickOne(cands(plat.ctas, 'a'), `${seed}:a`, recent);
  const live = strs(plat.live).map((l) => fill(l, v)).filter(Boolean);
  // hashtags: core (always kept) + a few from the rotating pool, none of the recent ones, at most the platform's recommended number
  const hc = isPlain(plat.hashtags) ? plat.hashtags : {};
  const cap = Math.min(Number.isInteger(hc.recommendedMax) ? hc.recommendedMax : 5, Number.isInteger(hashtagLimit) ? hashtagLimit : 30);
  const seen = new Set(); const tags = [];
  const add = (t) => { if (typeof t === 'string' && HASHTAG.test(t) && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); tags.push(t); return true; } return false; };
  for (const c of [...strs(hc.core), ...strs(k.hashtags?.core)]) { const t = fill(c, v); if (t) add(t); }
  const gameExtra = Array.isArray(game?.hashtags?.default) ? game.hashtags.default.slice(2) : [];
  let pool = [...strs(hc.pool).map((c) => fill(c, v)).filter(Boolean), ...strs(k.hashtags?.pool), ...gameExtra].filter((t) => HASHTAG.test(t) && !seen.has(t.toLowerCase()));
  pool = [...new Set(pool)];
  const want = Math.max(0, Math.min(Number.isInteger(hc.pick) ? hc.pick : 2, cap - tags.length));
  const used = [title.id, ...(lead ? [lead.id] : []), ...(cta ? [cta.id] : [])];
  for (let i = 0; i < want && pool.length; i++) {
    const fresh = pool.filter((t) => !recent.includes(`h:${t.toLowerCase()}`));
    const from = fresh.length ? fresh : pool;
    const t = from[hash32(`${seed}:h${i}:${from.length}`) % from.length];
    pool = pool.filter((x) => x !== t);
    if (add(t)) used.push(`h:${t.toLowerCase()}`);
  }
  const description = [lead?.text, cta?.text, live.join('\n')].filter(Boolean).join('\n\n');
  return { title: title.text, lead: lead?.text ?? '', cta: cta?.text ?? '', live, description, hashtags: tags, used, kind: libKind };
}

const words = (s) => new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
/** The model's title keeps the draft's structure when at least half of the draft's words are still in it (numbers included). */
export function keepsDraftTitle(aiTitle, draftTitle) {
  const d = words(draftTitle); if (!d.size) return true;
  const a = words(aiTitle);
  let n = 0; for (const w of d) if (a.has(w)) n++;
  return n * 2 >= d.size;
}
