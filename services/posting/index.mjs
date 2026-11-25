// SPDX-License-Identifier: GPL-3.0-or-later
// P16a export-only posting. Node stdlib only. NOTHING here uploads, signs in or touches the network.
//
//   packageRun({ runDir, ledgerFile, profile, ffmpeg?, ... }) -> { packaged, skipped }
//     Input: a clip run folder from services/clip/clipper.py (candidates.json, report.json, clips/<id>/<layout>.mp4).
//     For each clip x target it offers only a variant whose report.json says PASS for that target and writes
//       <runDir>/posts/<clipId>/<target>/{<layout>.mp4 (byte copy, never re-encoded), cover.jpg, captions.ass?, post.json}
//     Text comes from data/posting/templates.json; {handles.x}/{links.x} resolve from the local profile, {date}/{n}
//     from the run. Chat text, viewer names, marker notes and candidate reasons are never read into post text.
//     Limits come from data/posting/limits.json (checked against official pages, D186; per field with its
//     counting unit). Over a limit = flagged, never truncated.
//     privacy is fixed "private"; status starts "draft".
//   Ledger (<dataDir>/posting/ledger.json): one entry per video SHA-256 + target. A video is never packaged twice for
//     the same target, even after reject. Later upload steps reuse this ledger (not built here).
//   packageUploads({ dataDir, ledgerFile, ... }) (D301): packages every finished video in <dataDir>/clips/uploads.json
//     (kinds short | montage | won-reel) that is not posted or packaged yet; target by length/aspect from limits.json.
//   createPostStore({ ledgerFile, dataDir? }) -> list/get/edit/setStatus/media for the studio UI server.
//
// Why Node (not Python next to the clipper): the studio-ui server edits and approves packages and owns the ledger
// semantics, the profile placeholder resolver (services/project/scene-preset.mjs) is Node, and one implementation
// avoids two writers in two languages. The clipper's PASS/FAIL report is the only coupling (a JSON file).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as FS, copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../flags/index.mjs';
import { resolveString } from '../project/scene-preset.mjs';
import { trustedRow } from './clips-source.mjs';
import { cleanFacts, createTextHistory, creditMissing, draftText, legacyContext, legacyFor, musicCredit, musicOf, musicStamp, readProvenanceSince, renderMusic } from './post-text.mjs';
import { applyTextPrefs, readPrefs } from './post-prefs.mjs';
import { keepsParts } from './ai-text-check.mjs';
import { dropTemplateLead, gameHashtags, gameLines, gameTags, gameTitleTags, resolveGame } from './game-text.mjs';
import { makeHookCover } from './ai-cover.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const POSTING_FLAG = 'posting';
export const DEFAULT_TEMPLATES = path.join(REPO, 'data', 'posting', 'templates.json');
export const DEFAULT_LIMITS = path.join(REPO, 'data', 'posting', 'limits.json');
export const DEFAULT_TARGETS = path.join(REPO, 'data', 'clip', 'targets.json');
export const LEDGER_NAME = 'ledger.json';
export const STATUSES = Object.freeze(['draft', 'approved', 'rejected']);
export const TARGET_ID = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;
const POST_ID = /^[0-9a-f]{16}\.[a-z][a-z0-9-]{0,31}$/;
const UNRESOLVED = /\{[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\}/g;
export const EDIT_LIMITS = Object.freeze({ title: 300, description: 8000, tags: 30, tagChars: 60, hashtags: 60, hashtagChars: 80 });
const MEDIA = Object.freeze({ video: { ext: '.mp4', type: 'video/mp4' }, cover: { ext: '.jpg', type: 'image/jpeg' },
  subtitles: { ext: '.srt', type: 'application/x-subrip' } }); // C1: the long video's caption file (post.captions)
/** C1 (user 2026-11-24: long video captions "burned in and uploaded"): kinds whose package carries <video>.srt as
 *  captions.srt, uploaded as the video's caption track. Shorts and reels only burn theirs in (a track would show twice). */
export const CAPTION_UPLOAD_KINDS = Object.freeze(['long-highlights']);

export class PostingError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'PostingError'; this.code = code; }
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isRealFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const isRealDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

// ---------------------------------------------------------------- data files

/** PT1: post.json source.textVersion of text drafted from facts (an older draft is redrafted once, auto-chain). */
export const TEXT_VERSION = 2;
const textHistory = (opts, templates) => (typeof opts.dataDir === 'string' ? createTextHistory(opts.dataDir, Number.isInteger(templates.recentLines) ? templates.recentLines : 20) : null);

export function loadTemplates(file = DEFAULT_TEMPLATES) {
  const j = readJson(file);
  if (!isPlain(j) || !isPlain(j.targets) || !Array.isArray(j.layoutPreference)) throw new PostingError('bad-templates', 'posting: bad templates file');
  for (const [id, t] of Object.entries(j.targets)) {
    if (!TARGET_ID.test(id) || typeof t.title !== 'string' || typeof t.description !== 'string' || !Array.isArray(t.tags) || !Array.isArray(t.hashtags)) throw new PostingError('bad-templates', `posting: bad template ${id}`);
  }
  return j;
}

export function loadLimits(file = DEFAULT_LIMITS) {
  const j = readJson(file);
  if (!isPlain(j) || !isPlain(j.targets)) throw new PostingError('bad-limits', 'posting: bad limits file');
  for (const [id, t] of Object.entries(j.targets)) {
    if (!isPlain(t) || !isPlain(t.fields)) throw new PostingError('bad-limits', `posting: limits for ${id.slice(0, 32)} have no fields`);
    for (const f of Object.values(t.fields)) {
      if (!isPlain(f) || (f.unit !== undefined && f.unit !== 'youtube-tags' && !Object.hasOwn(UNITS, f.unit)))
        throw new PostingError('bad-limits', `posting: bad field unit in limits for ${id.slice(0, 32)}`);
    }
  }
  return j;
}

// ---------------------------------------------------------------- text

/** Profile copy without angle-bracket template values (data/profile.example.json), so they count as unresolved. */
export function cleanProfile(p) {
  if (typeof p === 'string') return /^<.*>$/.test(p) ? undefined : p;
  if (Array.isArray(p)) return p.map(cleanProfile).filter((x) => x !== undefined);
  if (isPlain(p)) {
    const o = {};
    for (const [k, v] of Object.entries(p)) { const c = cleanProfile(v); if (c !== undefined) o[k] = c; }
    return o;
  }
  return p;
}

/** Fills {date} and {n}, then profile placeholders. Unresolved ones stay literal and are returned in `missing`. */
export function renderText(tpl, { profile, n, date }, missing) {
  const s = tpl.replace(/\{(date|n)\}/g, (_m, k) => String(k === 'n' ? n : date));
  return resolveString(s, profile ?? {}, missing, false);
}

export const unresolvedKeys = (...texts) => [...new Set(texts.flatMap((t) => [...String(t).matchAll(UNRESOLVED)].map((m) => m[0].slice(1, -1))))].sort();
const len = (s) => Array.from(String(s)).length;

/** Length of s in a platform unit (data/posting/limits.json). */
export const UNITS = Object.freeze({
  chars: (s) => Array.from(String(s)).length,
  utf16: (s) => String(s).length,
  'utf8-bytes': (s) => Buffer.byteLength(String(s), 'utf8'),
});
/** YouTube snippet.tags: tag characters + a comma between tags + 2 quotes per tag that contains a space. */
export const youtubeTagsLength = (tags) =>
  tags.reduce((n, t) => n + UNITS.chars(t) + (/\s/.test(t) ? 2 : 0), 0) + Math.max(0, tags.length - 1);

/**
 * The text a platform field receives, built from post.json parts: text parts and the hashtags (joined by spaces)
 * are separated by a blank line; tags are joined by commas. Uploaders must send exactly this (D186). Pure.
 */
export function composeField(post, from) {
  const part = (k) => (Array.isArray(post[k]) ? post[k].join(k === 'tags' ? ',' : ' ') : String(post[k] ?? '')).trim();
  return from.map(part).filter(Boolean).join('\n\n');
}

const countMatches = (s, re) => [...String(s).matchAll(re)].length;
const HASHTAG = /(?:^|\s)#[^\s#]+/gu;
const MENTION = /(?:^|\s)@[^\s@]+/gu;

/** PT5 (D410): a check for applyTextPrefs: the post with a changed title, description or hashtags still passes every limit. */
export const limitsFit = (post, limits) => (p) => checkLimits({ ...post, ...p }, limits).checks.every((x) => x.ok);

/** Checks the composed platform fields against the target's limits. A field without max is not length-checked. Pure. */
export function checkLimits(post, limits) {
  const L = limits?.targets?.[post.target];
  if (!L || !isPlain(L.fields)) return { status: 'unknown-target', ok: false, checks: [] };
  const checks = [];
  for (const [field, f] of Object.entries(L.fields)) {
    const from = Array.isArray(f.from) ? f.from : [field];
    if (Number.isInteger(f.max)) {
      const value = f.unit === 'youtube-tags' ? youtubeTagsLength(post.tags ?? []) : (UNITS[f.unit] ?? UNITS.chars)(composeField(post, from));
      checks.push({ field, value, max: f.max, unit: f.unit ?? 'chars', ok: value <= f.max });
    }
    const text = composeField(post, from);
    if (typeof f.forbid === 'string' && f.forbid) {
      const value = Array.from(text).filter((ch) => f.forbid.includes(ch)).length;
      checks.push({ field, value, max: 0, unit: `forbidden ${f.forbid}`, ok: value === 0 });
    }
    if (Number.isInteger(f.hashtagMax)) { const value = countMatches(text, HASHTAG); checks.push({ field, value, max: f.hashtagMax, unit: 'hashtags', ok: value <= f.hashtagMax }); }
    if (Number.isInteger(f.mentionMax)) { const value = countMatches(text, MENTION); checks.push({ field, value, max: f.mentionMax, unit: 'mentions', ok: value <= f.mentionMax }); }
  }
  return { status: L.status ?? 'unverified', source: L.source ?? null, checked: L.checked ?? null, ok: checks.every((c) => c.ok), checks };
}

function cleanList(v, maxItems, maxChars, hash) {
  if (!Array.isArray(v) || v.length > maxItems) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    let s = x.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (hash) s = s.replace(/\s+/g, '');
    if (hash && s && !s.startsWith('#')) s = `#${s}`;
    if (!s || s === '#') continue;
    if (len(s) > maxChars) return null;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- ledger

export function createLedger(file) {
  const read = () => {
    const j = readJson(file);
    return isPlain(j) && isPlain(j.entries) ? j : { version: 1, entries: {} };
  };
  const key = (sha, target) => `${sha}:${target}`;
  return {
    file,
    get: (sha, target) => read().entries[key(sha, target)] ?? null,
    list: () => Object.values(read().entries),
    /** Fresh read, change one entry, atomic write. Refuses a duplicate key. */
    put(entry) {
      const j = read();
      const k = key(entry.sha256, entry.target);
      if (Object.hasOwn(j.entries, k)) throw new PostingError('duplicate', 'ledger: already packaged for this target');
      j.entries[k] = entry;
      writeJsonAtomic(file, j);
    },
    setStatus(sha, target, status, at) {
      const j = read();
      const e = j.entries[key(sha, target)];
      if (!e) throw new PostingError('unknown-post', 'ledger: unknown entry');
      e.status = status; e.updatedAt = at;
      writeJsonAtomic(file, j);
    },
    /** Adds plain string fields (videoId; publishAt, the UTC time Google got with the upload, D375) to one entry. Fresh read, atomic write. */
    annotate(sha, target, fields) {
      const j = read();
      const e = j.entries[key(sha, target)];
      if (!e) throw new PostingError('unknown-post', 'ledger: unknown entry');
      for (const [k, v] of Object.entries(fields)) {
        if (k === 'videoId' && typeof v === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(v)) e[k] = v;
        if (k === 'publishAt' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) e[k] = v;
      }
      writeJsonAtomic(file, j);
    },
  };
}

// ---------------------------------------------------------------- tools

export function findFfmpeg(explicit) {
  if (explicit) {
    if (isRealFile(explicit)) return path.resolve(explicit);
    throw new PostingError('no-ffmpeg', 'ffmpeg not found at the given path');
  }
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    for (const n of names) if (dir && isRealFile(path.join(dir, n))) return path.join(dir, n);
  }
  throw new PostingError('no-ffmpeg', 'ffmpeg not found on PATH (pass --ffmpeg)');
}

/** Extracts one JPEG frame at `atSec`. CPU only, one thread, below-normal priority. Resolves true on success. */
/** Where the cover of a finished video (uploads.json row) is taken, in seconds. RP6 (D366): a reel that opens on its
 *  edited start frame (row.thumbnail) uses that frame; otherwise 2 s in, or the middle of a short video. */
export function uploadCoverAt(row, seconds) {
  if (row?.thumbnail === true) return 0;
  return Number.isFinite(seconds) && seconds > 0.4 ? Math.min(2, seconds / 2) : 0;
}

/**
 * D443 T2: the post with the checked AI text: the AI title (+ the game's title hashtags when they fit); description = AI
 * lines, the game's lines (game-text.mjs gameLines), then the template's own description (links, credits) unchanged, then
 * the user's footer and the music credit; tags = game tags, mode tags, the user's own tags, AI tags, then the
 * template's, within the limit. -> { post } | { reject: code }. Pure.
 */
export function aiPost({ ai, tpl, ctx, post: base, music, limits, target, titleMax, kind, seed, prefs, game = null, mode = null, templates = null }) {
  const miss = new Set(); const tplMiss = new Set();
  const title = renderText(ai.title, ctx, miss);
  const aiDesc = renderText(ai.description, ctx, miss);
  const tags = ai.tags.map((t) => renderText(t, ctx, miss));
  // the template's own opening line ("Highlight 4 from the stream on ...") is replaced by the AI lines; credits stay
  const tplFull = renderText(tpl.description, ctx, tplMiss);
  const tplDesc = templates ? dropTemplateLead(tplFull, templates) : tplFull;
  if ([...miss].some((k) => !tplMiss.has(k))) return { reject: 'unresolved' };
  // the game's lines (Featured, subscribe, streamer; 2026-11-25 style) go between the AI lines and the template's credits
  // (game: the gamePost() object from ai-text.mjs gen; null: no game data)
  const lines = gameLines(game, target, mode, (s) => { const m = new Set(); const r = renderText(s, ctx, m); return m.size ? null : r; });
  const p = { title, description: [aiDesc, lines, tplDesc].filter(Boolean).join('\n\n'), tags: [], hashtags: gameHashtags(game, target) ?? [...base.hashtags], target };
  const fits = limitsFit(p, limits);
  const seen = new Set();
  const own = Array.isArray(prefs?.tags) ? prefs.tags : [];
  for (const t of gameTags(game, target, mode, [...own, ...tags, ...base.tags])) {
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    if (fits({ tags: [...p.tags, t] })) { p.tags.push(t); seen.add(k); }
  }
  Object.assign(p, applyTextPrefs(p, prefs, { kind, seed, titleMax, fits: limitsFit(p, limits) }));
  p.title = gameTitleTags(p.title, game, target, titleMax);
  if (music.use === 'credit') p.description = `${p.description}\n\n${music.text}`;
  if (!p.title) return { reject: 'title' };
  if (!checkLimits(p, limits).ok) return { reject: 'limits' };
  const lost = keepsParts(p.description, [tplDesc, music.use === 'credit' ? music.text : null]);
  if (lost !== null) return { reject: 'credit-lost' };
  return { post: p };
}

export function extractCover(ffmpeg, video, atSec, out) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-y', '-threads', '1', '-ss', atSec.toFixed(3), '-i', video, '-frames:v', '1', '-q:v', '2', out];
    let p;
    // Normal priority on purpose: one frame on one thread (well under a second of CPU). At BelowNormal it got no CPU at
    // all while the machine was busy (3 of 3 extracts not done in 180 s with 20 busy threads on 16 cores, 2026-11-24),
    // so the 60 s ceiling dropped the cover exactly when the PC was loaded (full CI; a stream would do the same).
    try { p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); } catch { return resolve(false); }
    const t = setTimeout(() => p.kill(), 60_000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && isRealFile(out)); });
  });
}

// ---------------------------------------------------------------- packager

/** opts: { runDir, ledgerFile, profile?, ffmpeg?, templates?, limits?, targets?: [id], now? }
 *  -> { packaged: [{ clipId, target, dir, layout }], skipped: [{ clipId, target, reason }] } */
export async function packageRun(opts) {
  const runDir = path.resolve(opts.runDir);
  const now = opts.now ?? (() => new Date());
  const templates = opts.templates ?? loadTemplates();
  const limits = opts.limits ?? loadLimits();
  const cands = readJson(path.join(runDir, 'candidates.json'));
  const report = readJson(path.join(runDir, 'report.json'));
  if (!isPlain(cands) || !Array.isArray(cands.candidates)) throw new PostingError('no-candidates', 'run folder has no usable candidates.json');
  if (!isPlain(report) || !Array.isArray(report.results)) throw new PostingError('no-report', 'run folder has no usable report.json (run clipper validate first)');
  const known = Object.keys(templates.targets);
  // A template marked uploadsOnly (youtube-video) is for finished videos from uploads.json, not for clip variants.
  const targets = opts.targets ?? known.filter((t) => templates.targets[t].uploadsOnly !== true);
  for (const t of targets) if (!known.includes(t) || !limits.targets?.[t]) throw new PostingError('unknown-target', `no template or limits for target ${String(t).slice(0, 32)}`);
  const profile = cleanProfile(opts.profile ?? {});
  const date = typeof cands.recordStartUtc === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cands.recordStartUtc) ? cands.recordStartUtc.slice(0, 10) : 'unknown-date';
  const ledger = createLedger(opts.ledgerFile);
  const pref = (l) => { const i = templates.layoutPreference.indexOf(l); return i < 0 ? 99 : i; };
  const runName = path.basename(runDir);
  const packaged = []; const skipped = [];
  let ffmpeg = null;
  // Codex verify (D414): manual run packaging goes through the same music gate as packageUploads
  const rdoc = readJson(path.join(runDir, 'render.json'));
  const legacy = legacyContext(opts.dataDir);

  for (let idx = 0; idx < cands.candidates.length; idx++) {
    const c = cands.candidates[idx];
    if (!isPlain(c) || !SAFE_NAME.test(String(c.id))) continue;
    const n = Number.isInteger(c.rank) ? c.rank : idx + 1;
    for (const target of targets) {
      const rows = report.results
        .filter((r) => r.id === c.id && r.file && SAFE_NAME.test(String(r.file)) && SAFE_NAME.test(String(r.layout)) && r.targets?.[target]?.ok === true && r.ok !== false)
        .sort((a, b) => pref(a.layout) - pref(b.layout));
      const row = rows.find((r) => isRealFile(path.join(runDir, 'clips', c.id, r.file)));
      if (!row) { skipped.push({ clipId: c.id, target, reason: 'no-pass-variant' }); continue; }
      const src = path.join(runDir, 'clips', c.id, row.file);
      const rm = renderMusic(rdoc, c.id);
      const mm = musicOf({ kind: 'short', ...(rm ? { music: rm } : {}) }, { legacyMadeHere: legacyFor(legacy, src, path.join(runDir, 'render.json')) });
      const music = musicCredit(mm);
      if (music.use === 'refuse') { skipped.push({ clipId: c.id, target, reason: music.renderOnly ? 'render-only' : music.unknown ? 'music-unknown' : 'music-credit-missing', detail: music.reason }); continue; }
      const sha = await sha256File(src);
      if (ledger.get(sha, target)) { skipped.push({ clipId: c.id, target, reason: 'already-packaged' }); continue; }
      const dir = path.join(runDir, 'posts', c.id, target);
      if (existsSync(dir)) { skipped.push({ clipId: c.id, target, reason: 'folder-exists' }); continue; }
      ffmpeg ??= findFfmpeg(opts.ffmpeg);
      mkdirSync(dir, { recursive: true });
      const videoName = `${row.layout}.mp4`;
      const dst = path.join(dir, videoName);
      copyFileSync(src, dst, FS.COPYFILE_EXCL);
      if (await sha256File(dst) !== sha) throw new PostingError('copy-mismatch', 'copied video differs from the source');
      const tpl = templates.targets[target];
      const missing = new Set();
      const ctx = { profile, n, date };
      const post = {
        title: renderText(tpl.title, ctx, missing),
        description: renderText(tpl.description, ctx, missing),
        tags: tpl.tags.map((t) => renderText(t, ctx, missing)),
        hashtags: tpl.hashtags.map((t) => renderText(t, ctx, missing)),
        target,
      };
      // PT5 (D410): the user's tone, emoji, own hashtags and footer; the defaults change nothing
      Object.assign(post, applyTextPrefs(post, readPrefs(opts.dataDir).prefs.text, { kind: 'short', seed: sha, titleMax: limits.targets?.[target]?.fields?.title?.max ?? null, fits: limitsFit(post, limits) }));
      if (music.use === 'credit') post.description = post.description ? `${post.description}\n\n${music.text}` : music.text; // D414: last, after the prefs
      const dur = Number(row.facts?.duration);
      const peak = Number.isFinite(Number(c.anchor)) && Number.isFinite(Number(c.start)) ? Number(c.anchor) - Number(c.start) : 0;
      const at = Math.min(Math.max(peak, 0), Number.isFinite(dur) && dur > 0.4 ? dur - 0.2 : Math.max(peak, 0));
      const coverOk = await extractCover(ffmpeg, dst, at, path.join(dir, 'cover.jpg'));
      let captions = null;
      const capSrc = path.join(runDir, 'clips', c.id, 'captions.ass');
      if (isRealFile(capSrc)) { copyFileSync(capSrc, path.join(dir, 'captions.ass'), FS.COPYFILE_EXCL); captions = 'captions.ass'; }
      const stamp = now().toISOString();
      const full = {
        version: 1,
        ...post,
        privacy: 'private',
        status: 'draft',
        source: { run: runName, clipId: c.id, layout: row.layout, startSec: c.start, endSec: c.end, score: Number.isFinite(c.score) ? c.score : null, sha256: sha,
          music: musicStamp(mm, music), ...(music.use === 'credit' ? { musicCredit: music.text } : {}) },
        video: { file: videoName, bytes: statSync(dst).size },
        cover: coverOk ? { file: 'cover.jpg', atSec: Number(at.toFixed(3)) } : null,
        captions,
        limits: checkLimits(post, limits),
        unresolved: unresolvedKeys(post.title, post.description, ...post.tags, ...post.hashtags),
        createdAt: stamp,
        updatedAt: stamp,
      };
      writeJsonAtomic(path.join(dir, 'post.json'), full);
      ledger.put({ sha256: sha, target, status: 'draft', dir, clipId: c.id, createdAt: stamp, updatedAt: stamp });
      packaged.push({ clipId: c.id, target, dir, layout: row.layout, cover: coverOk, limitsOk: full.limits.ok, unresolved: full.unresolved });
    }
  }
  return { packaged, skipped };
}

// ---------------------------------------------------------------- finished videos (uploads.json, D301)

export const UPLOAD_KINDS = Object.freeze(['short', 'montage', 'won-reel', 'impact-play', 'long-highlights']); // D406: long-highlights = the session's long H video (youtube-video)
/** Kinds packaged only while their feature flag is on (D326: impact-play reels, off by default). */
export const KIND_FLAGS = Object.freeze({ 'impact-play': 'impact-play-reels' });
export const CANVAS_TAIL = /_(\d{2})_(v(?:-[a-z0-9-]+)?|h)\.[a-z0-9]+$/i;
export const NAME_DATE =/_(\d{4})(\d{2})(\d{2})-\d{6}_/;
const NAME_STAMP = /_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_/;
/** The clip's first moment from its file name (clip_names.py: local wall time) as 'YYYY-MM-DDTHH:MM:SS' (no zone), or null. */
export function madeAtOf(name) {
  const m = NAME_STAMP.exec(String(name ?? ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

/** Target for one finished video, from data/posting/limits.json (never hardcoded): vertical and not longer than the
 *  Shorts limit -> the target that carries `video`; anything else -> `youtube-video`. */
export function pickYoutubeTarget({ seconds, vertical }, limits) {
  const shorts = limits.targets?.['youtube-shorts']?.video;
  const max = Number(shorts?.maxDurationSec);
  const isShort = !!shorts && vertical === true && Number.isFinite(Number(seconds)) && Number.isFinite(max) && Number(seconds) <= max;
  return isShort ? 'youtube-shorts' : 'youtube-video';
}

/** RP5 (D373): the edit choices a reel was made with (uploads.json row `choices`, written by clipper.py publish):
 *  { transition: cut|fade, title: on|off, music: on|off, mixAt?: ISO } -> a clean copy, or null. Short words only. */
export function cleanChoices(c) {
  if (!isPlain(c)) return null;
  const out = {};
  for (const k of ['transition', 'title', 'music']) if (typeof c[k] === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(c[k])) out[k] = c[k];
  if (typeof c.mixAt === 'string' && !Number.isNaN(Date.parse(c.mixAt)) && c.mixAt.length <= 40) out.mixAt = c.mixAt;
  return Object.keys(out).length ? out : null;
}

/** opts: { dataDir, ledgerFile, profile?, ffmpeg?, templates?, limits?, run?, now?, flags? }
 *  Packages every validated, published video in <dataDir>/clips/uploads.json that is not posted and not packaged yet
 *  (kinds short | montage | won-reel | impact-play | long-highlights; impact-play only while the flag impact-play-reels is on, read
 *  from <dataDir>/flags.local.json or opts.flags = { isOn(id) }). Packages go to <dataDir>/posting/packages/<run>/<kind>-<sha16>/<target>/.
 *  -> { packaged: [{ file, kind, target, dir }], skipped: [{ file, reason }] } */
export async function packageUploads(opts) {
  const templates = opts.templates ?? loadTemplates();
  const limits = opts.limits ?? loadLimits();
  // D375: opts.rows (from the clips folder scan, clips-source.mjs) replaces the uploads.json rows when given.
  const doc = Array.isArray(opts.rows) ? { files: opts.rows } : readJson(path.join(opts.dataDir, 'clips', 'uploads.json'));
  const packaged = []; const skipped = [];
  if (!isPlain(doc) || !Array.isArray(doc.files)) return { packaged, skipped };
  const now = opts.now ?? (() => new Date());
  const profile = cleanProfile(opts.profile ?? {});
  const ledger = createLedger(opts.ledgerFile);
  let ffmpeg = null;
  let flags = null;
  const legacy = legacyContext(opts.dataDir); // D414: clips rendered before music records (settings rule + provenance start)
  for (const raw of doc.files) {
    // Codex verify: an uploads.json row counts only while it still describes the file (scan rows are checked already)
    const row = !Array.isArray(opts.rows) && isPlain(raw) && typeof raw.file === 'string' && path.isAbsolute(raw.file) && isRealFile(raw.file)
      ? trustedRow(raw, raw.file, legacy.since) : raw;
    const file = isPlain(row) && typeof row.file === 'string' ? row.file : null;
    const skip = (reason) => skipped.push({ file: file ? path.basename(file) : '?', reason });
    if (!file || !UPLOAD_KINDS.includes(row.kind)) { skip('unknown-kind'); continue; }
    if (opts.run && row.run !== opts.run) continue;
    if (KIND_FLAGS[row.kind]) {
      flags ??= opts.flags ?? createFlags({ dataDir: opts.dataDir });
      if (!flags.isOn(KIND_FLAGS[row.kind])) { skip('flag-off'); continue; }
    }
    if (Array.isArray(row.posted) && row.posted.some((p) => p?.platform === 'youtube')) { skip('already-posted'); continue; }
    if (row.supersededBy !== undefined) { skip('superseded'); continue; } // BD7c: a BeatDrop retake replaced this render
    if (!path.isAbsolute(file) || !isRealFile(file)) { skip('file-missing'); continue; }
    // D414: a montage's song. NCS library track = its credit goes in the description, no credit = not sent; a song
    // from anywhere else = render only, never posted (fail closed, plain-word reason)
    // Codex BD review: from the render's own music record (row.music), so a folder-scanned montage is checked too; a
    // montage whose music cannot be told is refused (music-unknown)
    const mm = musicOf(row, { legacyMadeHere: legacyFor(legacy, file) });
    const music = musicCredit(mm);
    if (music.use === 'refuse') { skipped.push({ file: path.basename(file), reason: music.renderOnly ? 'render-only' : music.unknown ? 'music-unknown' : 'music-credit-missing', detail: music.reason }); continue; }
    const tail = CANVAS_TAIL.exec(path.basename(file));
    const vertical = tail ? tail[2].toLowerCase().startsWith('v') : false;
    const seconds = Number(row.seconds);
    const target = pickYoutubeTarget({ seconds, vertical }, limits);
    if (!templates.targets[target] || !limits.targets?.[target]) { skip('no-template'); continue; }
    const sha = await sha256File(file);
    if (ledger.get(sha, target)) { skip('already-packaged'); continue; }
    const runName = SAFE_NAME.test(String(row.run)) ? row.run : 'run';
    const dir = path.join(opts.dataDir, 'posting', 'packages', runName, `${row.kind}-${sha.slice(0, 16)}`, target);
    if (existsSync(dir)) { skip('folder-exists'); continue; }
    ffmpeg ??= findFfmpeg(opts.ffmpeg);
    mkdirSync(dir, { recursive: true });
    const videoName = `${row.kind}.mp4`;
    const dst = path.join(dir, videoName);
    copyFileSync(file, dst, FS.COPYFILE_EXCL);
    if (await sha256File(dst) !== sha) throw new PostingError('copy-mismatch', 'copied video differs from the source');
    const dm = NAME_DATE.exec(path.basename(file));
    const date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : 'unknown-date';
    const n = tail ? Number(tail[1]) : 1;
    const base = templates.targets[target];
    const tpl = isPlain(base.kinds?.[row.kind]) ? { ...base, ...base.kinds[row.kind] } : base;
    const missing = new Set();
    const ctx = { profile, n, date };
    // PT1 (D408): title and first line from the clip's facts (lines with a missing fact are left out); else the template's.
    const facts = cleanFacts(row.facts);
    const game = typeof row.game === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(row.game) ? row.game : null;
    const hist = textHistory(opts, templates);
    const titleMax = limits.targets[target]?.fields?.title?.max ?? null;
    const d = draftText({ templates, kind: row.kind, game, facts, seed: sha, recent: hist?.recent() ?? [], maxTitle: titleMax, gamesDir: opts.gamesDir });
    let post = {
      title: renderText(d.title?.text ?? tpl.title, ctx, missing),
      description: renderText(d.lead ? `${d.lead.text}\n\n${tpl.description}` : tpl.description, ctx, missing),
      tags: tpl.tags.map((t) => renderText(t, ctx, missing)),
      hashtags: tpl.hashtags.map((t) => renderText(t, ctx, missing)),
      target,
    };
    // PT5 (D410): the user's tone, emoji, own hashtags and footer (Settings > Posting & growth); the defaults change nothing
    Object.assign(post, applyTextPrefs(post, readPrefs(opts.dataDir).prefs.text, { kind: row.kind, seed: sha, titleMax, fits: limitsFit(post, limits) }));
    if (music.use === 'credit') post.description = post.description ? `${post.description}\n\n${music.text}` : music.text; // D414: last, after the prefs
    // D443 T2: AI text (opts.aiText from ai-text.mjs withAiText, one model start per batch) replaces the template text only
    // when the checker passed and the composed fields still fit the limits and keep the template's lines; else the
    // template text above stays and the reason is recorded.
    const aiMeta = {};
    if (typeof opts.aiText === 'function' || opts.aiWhy) {
      const tried = typeof opts.aiText === 'function' ? await opts.aiText({ file, seconds, facts, kind: row.kind, limits: limits.targets[target], ffmpeg, game: resolveGame(game, opts.gamesDir ? { gamesDir: opts.gamesDir } : undefined) }) : { ok: false, code: opts.aiWhy };
      const mixed = tried.ok ? aiPost({ ai: tried.text, tpl, ctx, post, music, limits, target, titleMax, kind: row.kind, seed: sha, prefs: readPrefs(opts.dataDir).prefs.text, game: tried.game ?? null, mode: facts.mode, templates }) : { reject: tried.code };
      if (mixed.post) {
        post = mixed.post;
        if (opts.aiText.stats) opts.aiText.stats.used += 1;
        Object.assign(aiMeta, { textSource: 'ai', ...(tried.tagsDropped ? { tagsDropped: tried.tagsDropped } : {}), ...(tried.factsSource ? { factsSource: tried.factsSource } : {}),
          ai: { version: opts.aiText.version ?? null, thumbHook: tried.text.thumbHook, thumbTime: Number(tried.text.thumbTime.toFixed(2)), factsSeen: tried.text.factsSeen } });
      } else {
        if (opts.aiText?.stats && tried.ok) { opts.aiText.stats.rejected += 1; opts.aiText.stats.rejects[mixed.reject] = (opts.aiText.stats.rejects[mixed.reject] ?? 0) + 1; }
        Object.assign(aiMeta, { textSource: 'template', aiReject: String(mixed.reject ?? 'error').slice(0, 40) });
      }
    }
    if (aiMeta.textSource !== 'ai' && hist && (d.title || d.lead)) hist.add(d.title?.line, d.lead?.line);
    let at = uploadCoverAt(row, seconds);
    const coverFile = path.join(dir, 'cover.jpg');
    // D443 T3: with checked AI text, the cover is the frame at thumbTime with the hook as big text (RP6 renderer). A reel that
    // opens on its own edited start frame (row.thumbnail) keeps frame 0, as before. A failed render keeps the plain frame.
    let coverOk = false; let hookCover = false;
    if (aiMeta.textSource === 'ai' && row.thumbnail !== true) {
      const want = Number(Math.min(aiMeta.ai.thumbTime, Number.isFinite(seconds) ? seconds : aiMeta.ai.thumbTime).toFixed(3));
      hookCover = await (opts.coverMaker ?? makeHookCover)({ ffmpeg, video: dst, atSec: want, hook: aiMeta.ai.thumbHook, out: coverFile }) === true;
      if (hookCover) { at = want; coverOk = true; }
      aiMeta.ai.cover = hookCover ? 'hook' : 'plain';
    }
    if (!coverOk) coverOk = await extractCover(ffmpeg, dst, at, coverFile);
    const srt = CAPTION_UPLOAD_KINDS.includes(row.kind) ? `${file.slice(0, -path.extname(file).length)}.srt` : null;
    let captions = null;
    if (srt && isRealFile(srt)) { copyFileSync(srt, path.join(dir, 'captions.srt'), FS.COPYFILE_EXCL); captions = 'captions.srt'; }
    const stamp = now().toISOString();
    const clipId = `${row.kind}-${sha.slice(0, 12)}`;
    const full = {
      version: 1,
      ...post,
      ...aiMeta,
      privacy: 'private',
      status: 'draft',
      source: { run: runName, clipId, kind: row.kind, layout: tail ? tail[2].toLowerCase() : 'unknown', startSec: 0, endSec: Number.isFinite(seconds) ? seconds : null, score: null, sha256: sha,
        ...(cleanChoices(row.choices) ? { choices: cleanChoices(row.choices) } : {}), // RP5: the reel's edit choices
        // PT1: the clip's facts (medal, kills, result, mode; only the known ones) and its game, for post text and redrafts
        ...(Object.keys(facts).length ? { facts } : {}), ...(game ? { game } : {}), textVersion: TEXT_VERSION,
        // D414: the montage's NCS track and the credit text the description must keep (checked again at approve and upload)
        // Codex verify: every package records its music check (source.music), re-checked at approve and upload
        music: musicStamp(mm, music), ...(music.use === 'credit' ? { musicCredit: music.text } : {}),
        // D375: when the clip was made (from its name; posting order is oldest first) and the clips-folder file it came
        // from (the file the flag post-delete-uploaded may remove after a confirmed upload). Local data only.
        ...(madeAtOf(path.basename(file)) ? { madeAt: madeAtOf(path.basename(file)) } : {}), file: path.resolve(file) },
      video: { file: videoName, bytes: statSync(dst).size },
      cover: coverOk ? { file: 'cover.jpg', atSec: Number(at.toFixed(3)) } : null,
      captions,
      limits: checkLimits(post, limits),
      unresolved: unresolvedKeys(post.title, post.description, ...post.tags, ...post.hashtags),
      createdAt: stamp,
      updatedAt: stamp,
    };
    writeJsonAtomic(path.join(dir, 'post.json'), full);
    ledger.put({ sha256: sha, target, status: 'draft', dir, clipId, createdAt: stamp, updatedAt: stamp });
    packaged.push({ file: path.basename(file), kind: row.kind, target, dir, limitsOk: full.limits.ok, unresolved: full.unresolved });
  }
  return { packaged, skipped };
}

/**
 * What the pre-PT1 templates generated for a draft (Codex review 2026-11-21): the target's base text (with its
 * kinds.<kind> override for a finished video), with {n} and {date} from the values the draft was made with: the
 * clips-folder file name (source.file) for a finished video, else the run's candidates.json (rank, recordStartUtc)
 * for a clip variant. -> { title, description, tags, hashtags } | null (a value cannot be found). Reads only.
 */
export function legacyText(e, p, templates, profile) {
  const base = templates?.targets?.[p?.target];
  if (!isPlain(base) || typeof base.title !== 'string') return null;
  let n; let date; let tpl = base;
  if (typeof p.source?.file === 'string') {
    const name = path.basename(p.source.file);
    const tail = CANVAS_TAIL.exec(name); const dm = NAME_DATE.exec(name);
    date = dm ? `${dm[1]}-${dm[2]}-${dm[3]}` : 'unknown-date';
    n = tail ? Number(tail[1]) : 1;
    const kind = p.source.kind;
    if (typeof kind === 'string' && isPlain(base.kinds?.[kind])) tpl = { ...base, ...base.kinds[kind] };
  } else {
    if (typeof e?.dir !== 'string') return null;
    const cands = readJson(path.join(path.resolve(e.dir, '..', '..', '..'), 'candidates.json'));
    if (!isPlain(cands) || !Array.isArray(cands.candidates)) return null;
    const idx = cands.candidates.findIndex((c) => isPlain(c) && c.id === p.source?.clipId);
    if (idx < 0) return null;
    const c = cands.candidates[idx];
    n = Number.isInteger(c.rank) ? c.rank : idx + 1;
    date = typeof cands.recordStartUtc === 'string' && /^\d{4}-\d{2}-\d{2}/.test(cands.recordStartUtc) ? cands.recordStartUtc.slice(0, 10) : 'unknown-date';
  }
  const ctx = { profile, n, date }; const missing = new Set();
  return { title: renderText(tpl.title, ctx, missing), description: renderText(tpl.description, ctx, missing),
    tags: (tpl.tags ?? []).map((t) => renderText(t, ctx, missing)), hashtags: (tpl.hashtags ?? []).map((t) => renderText(t, ctx, missing)) };
}

// ---------------------------------------------------------------- store (studio UI)

export const postId = (entry) => `${entry.sha256.slice(0, 16)}.${entry.target}`;

/** opts: { ledgerFile, limits?, now?, dataDir? (LL2 label rows on upload, D338) }. Reads and edits packages known to the ledger. */
export function createPostStore(opts) {
  const ledger = createLedger(opts.ledgerFile);
  const limitsFile = opts.limits ?? null;
  const now = opts.now ?? (() => new Date());
  const limits = () => limitsFile ?? loadLimits();

  function entries() {
    return ledger.list().filter((e) => isPlain(e) && SHA.test(String(e.sha256)) && TARGET_ID.test(String(e.target)) && typeof e.dir === 'string' && path.isAbsolute(e.dir));
  }
  function load(entry) {
    const file = path.join(entry.dir, 'post.json');
    if (!isRealDir(entry.dir) || !isRealFile(file)) return null;
    const p = readJson(file);
    if (!isPlain(p) || p.target !== entry.target || p.source?.sha256 !== entry.sha256) return null;
    return p;
  }
  const find = (id) => (typeof id === 'string' && POST_ID.test(id) ? entries().find((e) => postId(e) === id) ?? null : null);
  const view = (e, p) => ({
    id: postId(e), target: p.target, clipId: p.source.clipId, kind: typeof p.source.kind === 'string' ? p.source.kind : 'short', layout: p.source.layout, score: Number.isFinite(p.source.score) ? p.source.score : null, startSec: p.source.startSec, endSec: p.source.endSec,
    choices: cleanChoices(p.source.choices),
    madeAt: typeof p.source.madeAt === 'string' ? p.source.madeAt : (typeof p.createdAt === 'string' ? p.createdAt.slice(0, 19) : null), // D375: posting order
    sourceName: typeof p.source.file === 'string' ? path.basename(p.source.file) : null, // D403: kind and parts for the backlog order
    status: e.status, videoId: e.videoId ?? null, privacy: 'private', title: p.title, description: p.description, tags: p.tags, hashtags: p.hashtags,
    limits: p.limits, unresolved: p.unresolved ?? [], hasCover: !!p.cover, hasCaptions: !!p.captions, videoBytes: p.video?.bytes ?? null, updatedAt: p.updatedAt,
  });
  function save(e, p) {
    p.updatedAt = now().toISOString();
    writeJsonAtomic(path.join(e.dir, 'post.json'), p);
  }

  return {
    ledger,
    dataDir: typeof opts.dataDir === 'string' ? opts.dataDir : null,
    list() {
      const out = [];
      for (const e of entries()) { const p = load(e); if (p) out.push(view(e, { ...p, status: e.status })); }
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },
    get(id) { const e = find(id); const p = e && load(e); return p ? view(e, p) : null; },
    /** fields: { title?, description?, tags?, hashtags? } -> view | error string. A changed package goes back to draft. */
    edit(id, fields) {
      const e = find(id); const p = e && load(e);
      if (!p) return 'unknown-post';
      if (e.status === 'uploaded') return 'already-uploaded';
      if (!isPlain(fields) || Object.keys(fields).some((k) => !['title', 'description', 'tags', 'hashtags'].includes(k))) return 'bad-params';
      const next = { title: p.title, description: p.description, tags: p.tags, hashtags: p.hashtags };
      if (fields.title !== undefined) {
        if (typeof fields.title !== 'string' || fields.title.length > EDIT_LIMITS.title) return 'bad-title';
        next.title = fields.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      }
      if (fields.description !== undefined) {
        if (typeof fields.description !== 'string' || fields.description.length > EDIT_LIMITS.description) return 'bad-description';
        next.description = fields.description.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
      }
      if (fields.tags !== undefined) { const t = cleanList(fields.tags, EDIT_LIMITS.tags, EDIT_LIMITS.tagChars, false); if (!t) return 'bad-tags'; next.tags = t; }
      if (fields.hashtags !== undefined) { const t = cleanList(fields.hashtags, EDIT_LIMITS.hashtags, EDIT_LIMITS.hashtagChars, true); if (!t) return 'bad-hashtags'; next.hashtags = t; }
      Object.assign(p, next);
      p.limits = checkLimits({ ...next, target: p.target }, limits());
      p.unresolved = unresolvedKeys(next.title, next.description, ...next.tags, ...next.hashtags);
      p.status = 'draft';
      p.editedByUser = true; // PT1: a redraft never replaces the user's own words
      save(e, p);
      ledger.setStatus(e.sha256, e.target, 'draft', p.updatedAt);
      return view({ ...e, status: 'draft' }, p);
    },
    /**
     * Fills the profile placeholders ({handles.x}, {links.x}) still left in draft packages, from `profile` (2026-11-20:
     * an install packaged 263 clips without its profile, so none could be approved). Only drafts, only the placeholder
     * text itself: a value the profile does not have stays literal and still blocks approval. Returns how many changed.
     */
    fillPlaceholders(profile) {
      // A profile value that itself holds a placeholder counts as missing: one pass, no nesting, no growth per pass.
      const noNested = (v) => (typeof v === 'string' ? (/\{[^{}]*\}/.test(v) ? undefined : v)
        : Array.isArray(v) ? v.map(noNested).filter((x) => x !== undefined)
          : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNested(x)]).filter(([, x]) => x !== undefined)) : v);
      const prof = noNested(cleanProfile(profile ?? {}));
      let filled = 0;
      for (const e of entries()) {
        if (e.status !== 'draft') continue;
        const p = load(e);
        if (!p || !(p.unresolved ?? []).length) continue;
        const missing = new Set();
        const fill = (s) => resolveString(String(s), prof, missing, false);
        const next = { title: fill(p.title), description: fill(p.description), tags: (p.tags ?? []).map(fill), hashtags: (p.hashtags ?? []).map(fill) };
        const unresolved = unresolvedKeys(next.title, next.description, ...next.tags, ...next.hashtags);
        const same = next.title === p.title && next.description === p.description
          && JSON.stringify(next.tags) === JSON.stringify(p.tags ?? []) && JSON.stringify(next.hashtags) === JSON.stringify(p.hashtags ?? []);
        if (same) continue;
        Object.assign(p, next);
        p.limits = checkLimits({ ...next, target: p.target }, limits());
        p.unresolved = unresolved;
        save(e, p);
        ledger.setStatus(e.sha256, e.target, 'draft', p.updatedAt);
        filled++;
      }
      return filled;
    },
    /**
     * PT1 (D408): drafts made before the fact-based text get it once: a fact title replaces the old title and a lead line
     * goes before the old description. Only drafts the user has not edited; each is marked (source.textVersion) whether
     * or not a line fitted, so it never runs twice. factsFor(post) -> { facts, game } for drafts packaged without facts.
     * opts: { templates, profile, recent: () => [], used: (...lines) => void, factsFor? }. Returns how many changed.
     */
    redraftOnce(opts) {
      const prof = cleanProfile(opts.profile ?? {});
      let changed = 0;
      for (const e of entries()) {
        if (e.status !== 'draft') continue;
        const p = load(e);
        if (!p || p.editedByUser || p.source?.textVersion === TEXT_VERSION) continue;
        // Codex review 2026-11-21 (D409): a draft from before the editedByUser marker is redrafted only while its text
        // is exactly what the old templates made for it (re-rendered from its stored values); any other text may be the
        // user's own words and is kept untouched. No stored values to re-render from: kept too.
        const old = legacyText(e, p, opts.templates, prof);
        if (!old || old.title !== p.title || old.description !== p.description
          || JSON.stringify(old.tags) !== JSON.stringify(p.tags ?? []) || JSON.stringify(old.hashtags) !== JSON.stringify(p.hashtags ?? [])) continue;
        const known = isPlain(p.source?.facts) ? { facts: p.source.facts, game: p.source.game ?? null } : (opts.factsFor?.(p) ?? { facts: {}, game: null });
        const facts = cleanFacts(known.facts);
        const d = draftText({ templates: opts.templates, kind: p.source?.kind ?? 'short', game: known.game, facts, seed: e.sha256,
          recent: opts.recent?.() ?? [], maxTitle: limits().targets?.[p.target]?.fields?.title?.max ?? null, gamesDir: opts.gamesDir });
        const missing = new Set();
        const next = { title: d.title ? renderText(d.title.text, { profile: prof, n: 1, date: '' }, missing) : p.title,
          description: d.lead ? `${renderText(d.lead.text, { profile: prof, n: 1, date: '' }, missing)}\n\n${p.description}` : p.description };
        if (d.title || d.lead) { opts.used?.(d.title?.line, d.lead?.line); changed++; }
        Object.assign(p, next);
        p.source = { ...p.source, ...(Object.keys(facts).length ? { facts } : {}), ...(known.game ? { game: known.game } : {}), textVersion: TEXT_VERSION };
        p.limits = checkLimits({ title: p.title, description: p.description, tags: p.tags, hashtags: p.hashtags, target: p.target }, limits());
        p.unresolved = unresolvedKeys(p.title, p.description, ...(p.tags ?? []), ...(p.hashtags ?? []));
        save(e, p);
      }
      return changed;
    },
    /** status: draft | approved | rejected. Approve needs text inside the limits, no unresolved placeholder, an intact video. */
    async setStatus(id, status) {
      if (!STATUSES.includes(status)) return 'bad-status';
      const e = find(id); const p = e && load(e);
      if (!p) return 'unknown-post';
      if (e.status === 'uploaded') return 'already-uploaded';
      if (status === 'approved') {
        if (!p.title) return 'empty-title';
        if (!checkLimits(p, limits()).ok) return 'over-limit';
        if (unresolvedKeys(p.title, p.description, ...p.tags, ...p.hashtags).length) return 'unresolved-placeholders';
        const mg = creditMissing(p, readProvenanceSince(typeof opts.dataDir === 'string' ? opts.dataDir : null));
        if (mg) return mg; // D414: a library song's credit was removed from the description, or the music was never checked
        const vf = path.join(e.dir, p.video?.file ?? '');
        if (!SAFE_NAME.test(String(p.video?.file)) || !isRealFile(vf) || await sha256File(vf) !== e.sha256) return 'video-changed';
      }
      p.status = status;
      save(e, p);
      ledger.setStatus(e.sha256, e.target, status, p.updatedAt);
      return view({ ...e, status }, p);
    },
    /** -> { file, type, size } for kind video|cover|subtitles (.srt only), or null. Name comes from post.json, must be a plain file
     *  with the allowlisted extension, inside the package folder (real path), no link. */
    media(id, kind) {
      const e = find(id); const p = e && load(e);
      const m = Object.hasOwn(MEDIA, kind) ? MEDIA[kind] : null;
      if (!p || !m) return null;
      const name = kind === 'video' ? p.video?.file : kind === 'cover' ? p.cover?.file : p.captions;
      if (typeof name !== 'string' || !SAFE_NAME.test(name) || path.extname(name).toLowerCase() !== m.ext) return null;
      const file = path.join(e.dir, name);
      if (!isRealFile(file)) return null;
      const dir = realpathSync(e.dir); const real = realpathSync(file);
      if (!real.startsWith(dir + path.sep)) return null;
      return { file: real, type: m.type, size: statSync(real).size };
    },
    /** Package folder for "open folder". */
    dir(id) { const e = find(id); return e && load(e) ? e.dir : null; },
  };
}
