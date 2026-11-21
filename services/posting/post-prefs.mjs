// SPDX-License-Identifier: GPL-3.0-or-later
// PT5 (D410): the user's post text and growth settings from Settings > Posting & growth, kept in the same data folder as
// the other posting settings (<data>/posting/prefs.json, so they survive updates like schedule.json and the rules file).
//   readPrefs(dataDir)            -> { prefs, defaults, error, limits, kinds }   never throws (a bad file: defaults + error)
//   savePrefs(dataDir, body)      -> { ok: true, ...readPrefs } | { ok: false, problems: [{ key, text }] }
//   checkPrefs(j)                 -> { values, problems }  pure
//   applyTextPrefs(post, text, { kind, seed, titleMax, style }) -> { title, description, hashtags }  pure
//   userKindShares(dataDir)       -> { kind: fraction } | null (null = the shares are even: posting order as before)
// The defaults change nothing: tone hype keeps the drafted lines as written, emoji off, no own hashtags, no footer, even
// shares, growth suggestions on (requested feature, D410). Node stdlib only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RULE_KINDS } from './auto-post.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PREFS_NAME = 'prefs.json';
export const DEFAULT_TEXT_STYLE = path.join(REPO, 'data', 'posting', 'text-style.json');
export const prefsFile = (dataDir) => path.join(dataDir, 'posting', PREFS_NAME);
export const TONES = Object.freeze(['hype', 'clean']);
export const PREF_LIMITS = Object.freeze({ hashtags: 10, hashtagChars: 40, footer: 500 });
const HASHTAG = /^#[\p{L}\p{N}_]{1,39}$/u;
// the post editor's rule (services/posting/index.mjs edit): no control characters except a line break
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const CONTROL_G = /[\u0000-\u0009\u000b-\u001f\u007f]/g;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** Even shares in whole percent (the first kinds take the remainder), e.g. 5 kinds -> 20 each. */
export function evenShares(kinds = RULE_KINDS) {
  const base = Math.floor(100 / kinds.length); let rest = 100 - base * kinds.length;
  return Object.fromEntries(kinds.map((k) => [k, base + (rest-- > 0 ? 1 : 0)]));
}

export const defaultPrefs = () => ({ text: { tone: 'hype', emoji: false, hashtags: [], footer: '' }, kindShare: evenShares(), growthSuggestions: true });

/** Checks a whole prefs object (every key required). -> { values, problems }. Pure. */
export function checkPrefs(j) {
  const problems = []; const add = (key, text) => problems.push({ key, text });
  if (!isPlain(j)) return { values: null, problems: [{ key: null, text: 'nothing to save' }] };
  const t = isPlain(j.text) ? j.text : {};
  if (!TONES.includes(t.tone)) add('tone', 'tone must be hype or clean');
  if (typeof t.emoji !== 'boolean') add('emoji', 'emoji must be on or off');
  let tags = null;
  if (!Array.isArray(t.hashtags) || t.hashtags.length > PREF_LIMITS.hashtags || !t.hashtags.every((s) => typeof s === 'string' && HASHTAG.test(s))) {
    add('hashtags', `own hashtags: up to ${PREF_LIMITS.hashtags}, each like #gaming (letters, numbers or _ after the #, at most ${PREF_LIMITS.hashtagChars} characters)`);
  } else if (t.hashtags.some((s) => s.toLowerCase() === '#shorts')) add('hashtags', 'leave #Shorts out of your own hashtags: Shorts get it already, and other videos must not have it');
  else tags = [...new Map(t.hashtags.map((s) => [s.toLowerCase(), s])).values()];
  if (typeof t.footer !== 'string' || t.footer.length > PREF_LIMITS.footer || /[<>]/.test(t.footer) || CONTROL.test(t.footer)) add('footer', `the description footer is plain text of at most ${PREF_LIMITS.footer} characters, without < or > or control characters`);
  const ks = isPlain(j.kindShare) ? j.kindShare : null;
  let share = null;
  if (!ks || Object.keys(ks).some((k) => !RULE_KINDS.includes(k)) || !RULE_KINDS.every((k) => Number.isInteger(ks[k]) && ks[k] >= 0 && ks[k] <= 100)) {
    add('kindShare', 'each kind\'s share is a whole percent from 0 to 100');
  } else if (RULE_KINDS.reduce((s, k) => s + ks[k], 0) !== 100) add('kindShare', 'the shares must add up to 100 %');
  else share = Object.fromEntries(RULE_KINDS.map((k) => [k, ks[k]]));
  if (typeof j.growthSuggestions !== 'boolean') add('growthSuggestions', 'growth suggestions must be on or off');
  if (problems.length) return { values: null, problems };
  return { values: { text: { tone: t.tone, emoji: t.emoji, hashtags: tags, footer: t.footer.trim() }, kindShare: share, growthSuggestions: j.growthSuggestions }, problems };
}

/** The saved prefs over the defaults. A missing file is the defaults; an unreadable or bad one too, with error set. */
export function readPrefs(dataDir) {
  const defaults = defaultPrefs();
  let prefs = defaults; let error = null;
  const raw = typeof dataDir === 'string' ? readJson(prefsFile(dataDir)) : null;
  if (raw !== null) {
    const merged = { ...defaults, ...(isPlain(raw) ? raw : {}), text: { ...defaults.text, ...(isPlain(raw?.text) ? raw.text : {}) } };
    const c = checkPrefs(merged);
    if (c.values) prefs = c.values; else error = c.problems.map((p) => p.text).join('; ');
  } else if (typeof dataDir === 'string') {
    try { readFileSync(prefsFile(dataDir)); error = 'your post text settings file is not valid JSON'; } catch { /* no file: defaults */ }
  }
  return { prefs, defaults, error, limits: { ...PREF_LIMITS, tones: TONES }, kinds: [...RULE_KINDS] };
}

/** Saves the whole prefs object in one click (D332), atomically, after every value was checked. */
export function savePrefs(dataDir, body) {
  const c = checkPrefs(isPlain(body) ? body.prefs : null);
  if (!c.values) return { ok: false, problems: c.problems };
  const file = prefsFile(dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ $comment: 'Your post text and growth settings (Settings > Posting & growth, D410).', version: 1, ...c.values }, null, 2)}\n`);
  renameSync(tmp, file);
  return { ok: true, ...readPrefs(dataDir) };
}

/** The share of each kind as fractions for the auto-post order (auto-post.mjs mixOrder), or null when they are even. */
export function userKindShares(dataDir) {
  const { prefs, error } = readPrefs(dataDir);
  if (error) return null;
  const even = evenShares();
  if (RULE_KINDS.every((k) => prefs.kindShare[k] === even[k])) return null;
  return Object.fromEntries(RULE_KINDS.map((k) => [k, prefs.kindShare[k] / 100]));
}

export function loadTextStyle(file = DEFAULT_TEXT_STYLE) {
  const j = readJson(file);
  return isPlain(j?.emoji) ? j : { emoji: {} };
}

const hash32 = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h; };
const len = (s) => Array.from(s).length;

/** The post text with the user's choices applied. Pure. text = prefs.text. Each addition (the emoji, the footer, each own
 *  hashtag) is kept only when the composed text still passes `fits` (the caller's checkLimits against
 *  data/posting/limits.json) and titleMax; otherwise it is left out. #Shorts from the user is never added. */
export function applyTextPrefs(post, text, { kind = 'short', seed = '', titleMax = null, fits = () => true, style = loadTextStyle() } = {}) {
  let title = String(post.title ?? '');
  let description = String(post.description ?? '');
  const hashtags = Array.isArray(post.hashtags) ? [...post.hashtags] : [];
  const t = text ?? defaultPrefs().text;
  if (t.tone === 'clean') {
    title = title.replace(/!+$/u, '').replace(/!+/gu, '.').trim();
    description = description.replace(/!+/gu, '.');
  } else if (t.emoji === true) {
    const list = Array.isArray(style.emoji?.[kind]) ? style.emoji[kind].filter((e) => typeof e === 'string' && e) : [];
    if (list.length) {
      const e = list[hash32(`${seed}:emoji`) % list.length];
      const next = `${title} ${e}`;
      if ((titleMax === null || len(next) <= titleMax) && fits({ title: next, description, hashtags })) title = next;
    }
  }
  const foot = typeof t.footer === 'string' ? t.footer.replace(/\r\n?/g, '\n').replace(CONTROL_G, ' ').trim() : '';
  if (foot && fits({ title, description: `${description}\n\n${foot}`, hashtags })) description = `${description}\n\n${foot}`;
  const seen = new Set(hashtags.map((h) => String(h).toLowerCase()));
  for (const h of Array.isArray(t.hashtags) ? t.hashtags : []) {
    if (typeof h !== 'string' || !HASHTAG.test(h) || h.toLowerCase() === '#shorts' || seen.has(h.toLowerCase())) continue;
    if (!fits({ title, description, hashtags: [...hashtags, h] })) continue;
    hashtags.push(h); seen.add(h.toLowerCase());
  }
  return { title, description, hashtags };
}
