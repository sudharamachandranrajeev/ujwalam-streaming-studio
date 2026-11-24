// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T5: the local model cleans Whisper caption lines (punctuation, casing, one Manglish spelling, game words from
// data/clip/caption-words.json). Rules:
// - Timing never changes: only the text of a segment is replaced; start, end, count and order stay. The model gets
//   {id, text} cues and must return exactly the same ids (json_schema); any other answer keeps the whole chunk as is.
// - A cleaned line is accepted only by checkCue(): each word must be a word of the original line, a listed word, or within
//   a small edit distance of one (token rule, below); the script set must be the same; no profile term may appear; the
//   line must stay inside the limits of data/clip/reel-captions.json "clean". A rejected line keeps the original text.
// - Any failure (flag off, model off, on air, bad answer) leaves the transcript as it was. Never on air: the runner refuses.
// CLI (called by services/clip/reel_captions.py): node caption-clean.mjs <transcript.json> --flags=a,b -> one JSON line.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { termsOfProfile } from '../posting/ai-text-check.mjs';
import { chatJson, createModelRunner, FLAG as LOCAL_FLAG, LocalModelError } from './runner.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const WORDS_FILE = path.join(REPO, 'data', 'clip', 'caption-words.json');
export const CAPTIONS_FILE = path.join(REPO, 'data', 'clip', 'reel-captions.json');
export const CLEAN_FLAG = 'ai-captions';
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

export function loadCleanConfig({ wordsFile = WORDS_FILE, captionsFile = CAPTIONS_FILE } = {}) {
  return { ...readJson(wordsFile), limits: readJson(captionsFile).clean };
}

const tokens = (s) => String(s).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
const SCRIPTS = [['Malayalam', 0x0d00, 0x0d7f], ['Devanagari', 0x0900, 0x097f], ['Tamil', 0x0b80, 0x0bff], ['Latin', 0x41, 0x24f]];
export function scriptsOf(s) {
  const out = new Set();
  for (const ch of String(s)) {
    if (!/\p{L}/u.test(ch)) continue;
    const c = ch.codePointAt(0);
    out.add(SCRIPTS.find(([, a, b]) => c >= a && c <= b)?.[0] ?? 'Other');
  }
  return out;
}

/** Levenshtein distance, giving up above `cap` (returns cap + 1). */
export function editDistance(a, b, cap = 99) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let min = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < min) min = cur[j];
    }
    if (min > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** The listed words (game terms and cheers), lowercase. */
export const glossary = (cfg) => [...new Set([...(cfg.excitementWords ?? []), ...(cfg.gameTerms ?? [])].map((w) => String(w).toLowerCase()))];

/**
 * Token rule (documented, UNVERIFIED on real speech): every word of the cleaned line must equal a word of the original
 * line or a listed word, or be within editDistance <= maxEditDistance (<= shortWordMaxEdit for words up to shortWordLen
 * letters) of one of them. The word count may grow by at most maxExtraWordsRatio (min 1) and shrink to minKeepWordsRatio.
 * -> { ok: true, text } | { ok: false, code, detail }
 */
export function checkCue(original, cleaned, cfg, { profileTerms = [] } = {}) {
  if (typeof cleaned !== 'string' || !cleaned.trim()) return { ok: false, code: 'empty', detail: 'empty text' };
  if (/[\r\n]/.test(cleaned)) return { ok: false, code: 'multiline', detail: 'line breaks' };
  const text = cleaned.replace(/\s+/g, ' ').trim();
  const lim = cfg.limits ?? {};
  if (lim.maxCueChars && text.length > lim.maxCueChars) return { ok: false, code: 'too-long', detail: `${text.length} characters` };
  const ot = tokens(original); const ct = tokens(text);
  if (lim.maxCueWords && ct.length > lim.maxCueWords) return { ok: false, code: 'too-many-words', detail: `${ct.length} words` };
  const a = scriptsOf(original); const b = scriptsOf(text);
  if (a.size !== b.size || [...a].some((s) => !b.has(s))) return { ok: false, code: 'script', detail: `scripts ${[...a]} -> ${[...b]}` };
  const known = new Set([...ot, ...glossary(cfg)]);
  for (const w of ct) {
    if (known.has(w)) continue;
    const cap = w.length <= (cfg.shortWordLen ?? 4) ? (cfg.shortWordMaxEdit ?? 1) : (cfg.maxEditDistance ?? 2);
    if (![...known].some((k) => editDistance(w, k, cap) <= cap)) return { ok: false, code: 'new-word', detail: `"${w}" is not in the line or the word list` };
  }
  const extra = Math.max(1, Math.floor(ot.length * (cfg.maxExtraWordsRatio ?? 0.2)));
  if (ct.length > ot.length + extra) return { ok: false, code: 'added-words', detail: `${ot.length} -> ${ct.length} words` };
  if (ct.length < Math.ceil(ot.length * (cfg.minKeepWordsRatio ?? 0.6))) return { ok: false, code: 'dropped-words', detail: `${ot.length} -> ${ct.length} words` };
  const low = text.toLowerCase(); const orig = String(original).toLowerCase();
  for (const t of profileTerms) { const x = String(t).toLowerCase(); if (x && low.includes(x) && !orig.includes(x)) return { ok: false, code: 'profile-term', detail: 'a private term' }; }
  return { ok: true, text };
}

export function answerSchema(ids) {
  return {
    type: 'object', additionalProperties: false, required: ['cues'],
    properties: { cues: { type: 'array', minItems: ids.length, maxItems: ids.length, items: {
      type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'integer', enum: ids }, text: { type: 'string' } } } } },
  };
}

export function buildPrompt(cfg, cues) {
  const v = { words: glossary(cfg).join(', '), cues: JSON.stringify(cues) };
  return cfg.prompt.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(v, k) ? v[k] : m));
}

/**
 * Cleans the shown segments of a transcript with one model batch. deps: { runner (createModelRunner), isOn: () => bool
 * (flag ai-captions), cfg?, profileTerms?, chat? (tests: replaces chatJson) }.
 * -> { doc, stats: { status, cues, changed, rejected, rejects, reason? } }. doc is always a copy with the same segments
 * (start/end/count); only `text` can change, and `rawText` keeps the speech model's line where it did.
 */
export async function cleanTranscript(doc, deps = {}) {
  const stats = { status: 'unchanged', cues: 0, changed: 0, rejected: 0, rejects: {} };
  const copy = () => ({ ...doc, segments: (doc?.segments ?? []).map((s) => ({ ...s })) });
  let out = copy();
  let on = false;
  try { on = Boolean(deps.isOn?.()); } catch { on = false; }
  if (!on || !deps.runner) return { doc: out, stats: { ...stats, status: 'off' } };
  const cfg = deps.cfg ?? loadCleanConfig();
  const terms = deps.profileTerms ?? [];
  const idx = out.segments.map((s, i) => [i, s]).filter(([, s]) => s.show !== false && typeof s.text === 'string' && s.text.trim());
  stats.cues = idx.length;
  if (!idx.length) return { doc: out, stats };
  const chat = deps.chat ?? chatJson;
  const reject = (code, n = 1) => { stats.rejected += n; stats.rejects[code] = (stats.rejects[code] ?? 0) + n; };
  try {
    await deps.runner.withModel(async (m) => {
      for (let at = 0; at < idx.length; at += cfg.chunkCues) {
        const part = idx.slice(at, at + cfg.chunkCues);
        const cues = part.map(([i, s]) => ({ id: i, text: s.text }));
        const ids = cues.map((c) => c.id);
        let ans;
        try {
          ans = await chat({ url: m.url, system: cfg.system, prompt: buildPrompt(cfg, cues), schema: answerSchema(ids), timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxTokens, temperature: cfg.temperature });
        } catch (e) {
          if (e instanceof LocalModelError && (e.code === 'on-air' || e.code === 'stopped')) throw e;
          reject(e instanceof LocalModelError ? e.code : 'error', part.length); continue;
        }
        const got = Array.isArray(ans?.cues) ? ans.cues : null;
        const seen = new Set((got ?? []).map((c) => c?.id));
        if (!got || got.length !== ids.length || seen.size !== ids.length || !ids.every((id) => seen.has(id))) { reject('id-mismatch', part.length); continue; }
        const byId = new Map(got.map((c) => [c.id, c.text]));
        for (const [i, s] of part) {
          const r = checkCue(s.text, byId.get(i), cfg, { profileTerms: terms });
          if (!r.ok) { reject(r.code); continue; }
          if (r.text !== s.text) { s.rawText = s.text; s.text = r.text; stats.changed += 1; }
        }
      }
    });
  } catch (e) {
    // the model could not run (off, on air, files missing, crash): captions stay as the speech model wrote them
    out = copy();
    return { doc: out, stats: { status: 'failed', cues: idx.length, changed: 0, rejected: 0, rejects: {}, reason: e instanceof LocalModelError ? e.code : 'error' } };
  }
  return { doc: out, stats: { ...stats, status: stats.changed ? 'cleaned' : 'unchanged' } };
}

// ---- CLI
async function main(argv) {
  const file = argv[2];
  const flags = new Set((argv.find((a) => a.startsWith('--flags='))?.slice(8) ?? '').split(',').filter(Boolean));
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    let terms = [];
    try { terms = termsOfProfile(JSON.parse(readFileSync(path.join(REPO, 'data', 'profile.local.json'), 'utf8'))); } catch { /* none */ }
    const runner = createModelRunner({ isOn: () => flags.has(LOCAL_FLAG) });
    const r = await cleanTranscript(doc, { runner, isOn: () => flags.has(CLEAN_FLAG), profileTerms: terms });
    if (r.stats.status === 'cleaned') {
      writeFileSync(`${file}.part`, `${JSON.stringify({ ...r.doc, captionsCleaned: true }, null, 2)}\n`, 'utf8');
      renameSync(`${file}.part`, file);
    }
    say(r.stats);
  } catch (e) { say({ status: 'failed', reason: String(e?.message ?? e).slice(0, 120) }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv);
