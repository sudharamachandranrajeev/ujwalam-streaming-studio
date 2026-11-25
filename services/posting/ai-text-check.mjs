// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T2: the checker for AI post text. Pure: no files, no model. The model's answer is data; nothing goes into a post
// unless every rule here passes (any failure -> the caller keeps the template text and records the code).
//
//   checkAiText({ answer, facts, seconds, limits, cfg, profileTerms, forbidTerms }) ->
//     { ok: true, text: { title, description, tags, thumbHook, thumbTime, factsSeen }, factsSource: 'detector'|'model'|null }
//     | { ok: false, code, detail }
//
// Codes: schema, title, description, tags, hook, thumb-time, markup, url, mention, placeholder, privacy, fact-kills,
// fact-result, fact-number, hashtag, control, length. And keepsParts() for the lines the template adds (credit etc.).
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const bad = (code, detail) => ({ ok: false, code, detail });

const UNIT = {
  chars: (s) => Array.from(String(s)).length,
  utf16: (s) => String(s).length,
  'utf8-bytes': (s) => Buffer.byteLength(String(s), 'utf8'),
};
const lengthOf = (unit, s) => (UNIT[unit] ?? UNIT.chars)(s);
/** YouTube snippet.tags: tag characters + a comma between tags + 2 quotes per tag that contains a space. */
const tagsLength = (tags) => tags.reduce((n, t) => n + UNIT.chars(t) + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/u;
const CONTROL_NO_NL = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const OK_PLACEHOLDER = /\{(?:handles|links)\.[a-z][a-z0-9_]{0,31}\}/g;
const URL_RE = /https?:|ftp:|www\.|\b[a-z0-9-]{2,}\.(?:com|net|org|tv|gg|io|me|co|app|ly|be|to|xyz|info|link|live|ai|dev|us|uk|in)\b/i;

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const KILL_WORD = '(?:kills?|kill streak|eliminations?|frags?|downs?|knocks?|takedowns?)';
const WIN = /\b(?:victory|victorious|won|win|wins|winner|winning|champions?|booyah)\b/i;
const LOSS = /\b(?:defeat|defeated|lost|loss|losing)\b/i;

/** 'win' | 'loss' | null for a result word of the detector ("VICTORY", "DEFEAT") or of the model. */
export function resultClass(s) {
  if (typeof s !== 'string') return null;
  const w = WIN.test(s), l = LOSS.test(s);
  return w && !l ? 'win' : l && !w ? 'loss' : null;
}

/** The skeleton of a text: lowercase letters and digits only (separator variants fold into one form). */
const skel = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * The terms of a local profile (data/profile.local.json) that must never appear in post text: every string value under
 * streamer, channels, games, brand, handles, links and private_terms (handles/URLs reduced to their name part).
 * Paths, devices and assets are not terms. -> string[] (skeleton-length >= 3).
 */
export function termsOfProfile(profile) {
  const out = new Set();
  const take = (v) => {
    if (typeof v === 'string') {
      const t = v.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?/i, '');
      for (const part of [t, ...t.split(/[\/?#]/).filter(Boolean)]) if (skel(part).length >= 3 && !/^<.*>$/.test(part)) out.add(part);
    } else if (Array.isArray(v)) v.forEach(take);
    else if (isPlain(v)) Object.values(v).forEach(take);
  };
  if (isPlain(profile)) for (const k of ['streamer', 'channels', 'games', 'brand', 'handles', 'links', 'private_terms']) take(profile[k]);
  return [...out];
}

/** The first term found in `text` (skeleton containment; a short term only as a whole word), or null. */
export function findTerm(text, terms) {
  const sk = skel(text);
  const low = String(text).toLowerCase();
  for (const t of terms ?? []) {
    const k = skel(t);
    if (k.length < 3) continue;
    if (k.length >= 5) { if (sk.includes(k)) return t; continue; }
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${String(t).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u');
    if (re.test(low)) return t;
  }
  return null;
}

/** Every kill count claimed in a text: digits ("5 kills", "5-kill") and number words ("five kills"). -> number[] */
export function killClaims(text) {
  const out = [];
  const s = String(text);
  for (const m of s.matchAll(new RegExp(`(\\d{1,3})\\s*(?:-|\\s)?\\s*(?:x\\s*)?${KILL_WORD}\\b`, 'gi'))) out.push(Number(m[1]));
  for (const m of s.matchAll(/\b(double|triple|quad(?:ruple)?|penta)[\s-]*kills?\b/gi)) out.push({ double: 2, triple: 3, quad: 4, quadruple: 4, penta: 5 }[m[1].toLowerCase()]);
  for (const m of s.matchAll(new RegExp(`\\b(${Object.keys(WORD_NUM).join('|')})\\s*(?:-|\\s)?\\s*${KILL_WORD}\\b`, 'gi'))) out.push(WORD_NUM[m[1].toLowerCase()]);
  return out;
}

// claim-context numbers: next to win/won/victory/rank/place/top (also 1st 2nd), N/M, xN, Nx
const CLAIM_WORD = '(?:wins?|won|victory|rank(?:ed)?|place|top|st|nd|rd|th)';
const CLAIM_NUM = new RegExp(`\\b${CLAIM_WORD}\\s*:?\\s*(\\d{1,3})\\b|\\b(\\d{1,3})\\s*-?\\s*${CLAIM_WORD}\\b|\\b(\\d{1,3})\\s*/\\s*(\\d{1,3})\\b|\\bx\\s*(\\d{1,3})\\b|\\b(\\d{1,3})\\s*x\\b`, 'gi');
const KILL_NUM = new RegExp(`\\d{1,3}\\s*(?:-|\\s)?\\s*(?:x\\s*)?${KILL_WORD}\\b`, 'gi');
const textOf =(t) => [t.title, t.description, ...t.tags, t.thumbHook].filter((x) => x !== null).join('\n');

/** Shape of the answer. -> text object | { code, detail }. cover false (the scheduled-post rewrite changes text only):
 *  the cover hook and frame time are not used, so they are not checked and come back null. */
function shape(answer, cfg, cover = true) {
  if (!isPlain(answer)) return bad('schema', 'the answer is not an object');
  const A = cfg.answer;
  const str = (k) => (typeof answer[k] === 'string' ? answer[k].trim() : null);
  const title = str('title'), description = str('description'), thumbHook = str('thumbHook');
  if (title === null || !title) return bad('schema', 'title');
  if (description === null || !description) return bad('schema', 'description');
  if (cover && (thumbHook === null || !thumbHook)) return bad('schema', 'thumbHook');
  if (!Array.isArray(answer.tags) || answer.tags.some((t) => typeof t !== 'string')) return bad('schema', 'tags');
  if (cover && (typeof answer.thumbTime !== 'number' || !Number.isFinite(answer.thumbTime))) return bad('schema', 'thumbTime');
  const fs = answer.factsSeen;
  if (!isPlain(fs)) return bad('schema', 'factsSeen');
  const seen = {};
  for (const k of ['kills', 'result', 'mode', 'medal']) {
    const v = fs[k];
    if (v === undefined || v === null) { seen[k] = null; continue; }
    if (k === 'kills' ? !(Number.isInteger(v) && v >= 0 && v <= 200) : !(typeof v === 'string' && v.length <= 40)) return bad('schema', `factsSeen.${k}`);
    seen[k] = typeof v === 'string' ? v.trim() : v;
  }
  const tags = [...new Set(answer.tags.map((t) => t.trim()).filter(Boolean))];
  let lines = description.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  // a small model often writes the lines as sentences in one paragraph: one sentence per line then
  if (lines.length === 1) lines = lines[0].split(/(?<=[.!?])\s+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > A.description.maxLines) lines = lines.slice(0, A.description.maxLines); // extra trailing sentences are dropped
  if (lines.length < A.description.minLines) return bad('description', `${lines.length} lines`);
  if (tags.length < A.tags.min || tags.length > A.tags.max) return bad('tags', `${tags.length} tags`);
  if (tags.some((t) => UNIT.chars(t) > A.tags.maxChars)) return bad('tags', 'a tag is too long');
  if (!cover) return { title, description: lines.join('\n'), tags, thumbHook: null, thumbTime: null, factsSeen: seen };
  const words = thumbHook.split(/\s+/).filter(Boolean);
  if (words.length < A.thumbHook.minWords || words.length > A.thumbHook.maxWords || UNIT.chars(thumbHook) > A.thumbHook.maxChars) return bad('hook', `${words.length} words`);
  return { title, description: lines.join('\n'), tags, thumbHook, thumbTime: answer.thumbTime, factsSeen: seen };
}

/**
 * opts: { answer, facts (cleanFacts output: medal, killsText, kills, result, mode), seconds, limits (limits.json
 *   targets[target]: { fields }), cfg (data/posting/ai-text.json), profileTerms: string[], forbidTerms: string[] }
 */
export function checkAiText({ answer, facts = {}, seconds, limits, cfg, profileTerms = [], forbidTerms = [], screenWords, vocab, cover = true }) {
  const t = shape(answer, cfg, cover);
  if (t.ok === false) return t;
  // time of the thumbnail frame inside the clip
  if (cover && Number.isFinite(seconds) && (t.thumbTime < 0 || t.thumbTime > seconds)) return bad('thumb-time', 'outside the clip');
  if (cover && t.thumbTime < 0) return bad('thumb-time', 'negative');
  // numbers: the facts' numbers (detector: kills, placement, teams; the model's kills only when the detector has none)
  const detKills = Number.isFinite(Number(facts.kills)) ? Number(facts.kills) : null;
  const factNums = new Set([detKills, Number(facts.placement), Number(facts.teams)].filter((n) => n !== null && Number.isFinite(n)));
  // a tag with a number that is not a fact is dropped alone; the post stays
  const tagsBefore = t.tags.length;
  t.tags = t.tags.filter((g) => [...g.matchAll(/\d+/g)].every((m) => factNums.has(Number(m[0]))));
  const tagsDropped = tagsBefore - t.tags.length;
  // platform limits (data/posting/limits.json), per field
  const F = isPlain(limits?.fields) ? limits.fields : {};
  const titleF = F.title ?? {}, descF = F.description ?? {}, tagsF = F.tags ?? {};
  if (Number.isInteger(titleF.max) && lengthOf(titleF.unit, t.title) > titleF.max) return bad('length', 'title over the platform limit');
  if (Number.isInteger(descF.max) && lengthOf(descF.unit, t.description) > descF.max) return bad('length', 'description over the platform limit');
  if (Number.isInteger(tagsF.max) && tagsLength(t.tags) > tagsF.max) return bad('length', 'tags over the platform limit');
  // characters
  for (const [field, v] of [['title', t.title], ['description', t.description], ['tags', t.tags.join(' ')], ['thumbHook', t.thumbHook]]) {
    if (v === null) continue; // no cover hook (cover false)
    if ((field === 'description' ? CONTROL_NO_NL : CONTROL).test(v)) return bad('control', field);
    if (/[<>]/.test(v)) return bad('markup', field);
    for (const f of [titleF, descF, tagsF]) if (typeof f.forbid === 'string' && [...f.forbid].some((c) => v.includes(c))) return bad('markup', field);
    if (v.includes('#')) return bad('hashtag', field);
    if (/(^|[^\p{L}\p{N}])@[\p{L}\p{N}_]/u.test(v)) return bad('mention', field);
  }
  // placeholders: only {handles.x} / {links.x}
  const all = textOf(t);
  const rest = all.replace(OK_PLACEHOLDER, ' ');
  if (/[{}]/.test(rest)) return bad('placeholder', 'only {handles.x} and {links.x} may appear');
  // privacy: no URL, no profile term, no chat/viewer term outside the placeholders
  if (URL_RE.test(rest)) return bad('url', 'a web address in the text');
  const hit = findTerm(rest, [...profileTerms, ...forbidTerms]);
  if (hit !== null) return bad('privacy', 'a private or chat term in the text');
  // screen names: a word that is on screen (OCR of the frames) and not in the allowed vocabulary is a player, team or
  // account name; screenWords undefined = not checked (pure tests only; the runner always passes it and fails closed)
  if (screenWords instanceof Set) {
    const ok = vocab instanceof Set ? vocab : new Set();
    for (const w of rest.toLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []) if (screenWords.has(w) && !ok.has(w)) return bad('screen-name', 'a word that is on screen and not a common or game word');
    // a longer screen word inside the text with the spaces and marks taken out ("Shadow King" for "Shadow_King")
    const sk = skel(rest);
    for (const w of screenWords) { const k = skel(w); if (k.length >= 5 && !ok.has(w) && sk.includes(k)) return bad('screen-name', 'a name that is on screen, written another way'); }
  }
  // facts: only the detector's facts verify a claim; with none the text may not claim kills or a win/loss at all
  // (factsSeen is recorded for later learning, never used to accept)
  let usedDetector = false;
  for (const c of killClaims(rest)) {
    if (detKills === null) return bad('fact-unverified', 'a kill count claimed without detector facts');
    if (c !== detKills) return bad('fact-kills', 'a kill count that the detector facts do not give');
    usedDetector = true;
  }
  const hasWin = WIN.test(rest), hasLoss = LOSS.test(rest);
  if (hasWin || hasLoss) {
    if (hasWin && hasLoss) return bad('fact-result', 'both a win and a loss');
    if (!(typeof facts.result === 'string' && facts.result)) return bad('fact-unverified', 'a win or loss claimed without a detector result');
    if (resultClass(facts.result) !== (hasWin ? 'win' : 'loss')) return bad('fact-result', 'a result that the detector facts do not give');
    usedDetector = true;
  }
  // numbers in title, description and hook: a claim-context number must be a fact number; any other digit is rejected
  let body = [t.title, t.description, t.thumbHook].filter((x) => x !== null).join('\n').replace(OK_PLACEHOLDER, ' ');
  for (const m of body.matchAll(CLAIM_NUM)) {
    for (const g of m.slice(1).filter((x) => x !== undefined)) if (!factNums.has(Number(g))) return bad('fact-number', 'a claimed number that is not a fact');
  }
  body = body.replace(CLAIM_NUM, ' ').replace(KILL_NUM, ' ');
  if (/\d/.test(body)) return bad('fact-number', 'a number that is not a fact');
  const source = usedDetector ? 'detector' : null;
  return { ok: true, text: t, factsSource: source, tagsDropped };
}

/** The lines the template (credit, links, hashtags) adds must all still be in the final text. -> missing part | null */
export function keepsParts(finalText, parts) {
  const s = String(finalText ?? '');
  for (const p of parts ?? []) if (typeof p === 'string' && p.trim() && !s.includes(p.trim())) return p;
  return null;
}
