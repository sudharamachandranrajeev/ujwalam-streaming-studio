// SPDX-License-Identifier: GPL-3.0-or-later
// PT1 (D408): post text from the clip's facts. The lines are data (data/posting/templates.json textPools per kind, plus
// data/games/<id>/posting.json per game); a line that names a fact the clip does not have is left out (never guessed),
// a line over the platform's title limit (data/posting/limits.json) is left out, and the last N lines used are not used
// again. The pick is seeded by the clip's bytes, so the same clip gets the same text. Pure except the history file.
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings } from '../studio-ui/user-settings.mjs';

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

// ---- montage music credit (D413 item 2, D414) begin. A BeatDrop montage's clip row carries montageMusic:
// { library: 'ncs', trackId, credit: { artist, title, line, link } | null } for a track from the user's NCS library, or
// { library: null } for a track from anywhere else. NCS allows use with the artist and song credited in the description,
// so a library track's post always gets the credit lines; without a complete credit it is never sent (fail closed), and
// a montage with a track from elsewhere is rendered only, never auto-posted. Same template and limits as
// services/clip/montage_music.py credit_text (data/clip/montage-music.json).
const MONTAGE_MUSIC_FILE = path.join(REPO, 'data', 'clip', 'montage-music.json');
let mmCfg = null;
const montageCfg = () => (mmCfg ??= readJson(MONTAGE_MUSIC_FILE));
// < > { }, controls, format characters (bidi, zero-width, soft hyphen, BOM, tag characters ...), private use, lone
// surrogates and the invisible marks outside those categories; the same rule as montage_music.py unsafe_text
const CREDIT_BAD = /[<>{}\p{Cc}\p{Cf}\p{Co}\p{Cs}͏ᅟᅠㅤﾠ]/u;
/** The plain-word reason a credit is not usable, or null. */
export function creditProblem(c, cfg = montageCfg(), origin = null) {
  if (!cfg) return 'the montage music settings are missing';
  if (!isPlain(c)) return 'the song has no credit (artist and title)';
  const mx = cfg.credit.maxChars;
  for (const k of ['artist', 'title']) if (typeof c[k] !== 'string' || !c[k].trim()) return `the song credit has no ${k}`;
  for (const [k, n] of Object.entries(mx)) {
    const v = c[k] ?? '';
    if (typeof v !== 'string' || [...v].length > n || CREDIT_BAD.test(v)) return `the song credit's ${k} is not plain text of at most ${n} characters`;
  }
  if (origin && !(typeof c.link === 'string' && c.link.startsWith(cfg.ncsFilename.linkPrefix) && /^[A-Za-z0-9_-]{11}$/.test(c.link.slice(cfg.ncsFilename.linkPrefix.length)))) return "the NCS song credit's link is not a YouTube link";
  if (c.link && !/^https:\/\/[A-Za-z0-9.-]+(\/\S*)?$/.test(c.link)) return "the song credit's link must start with https://";
  return null;
}
/**
 * What posting does with a clip row's montageMusic. -> { use: 'none' } (no montage track), { use: 'credit', text } (add
 * the text to the description), or { use: 'refuse', reason, renderOnly } (not packaged: plain-word reason).
 */
export function musicCredit(mm, cfg = montageCfg()) {
  if (mm === undefined || mm === null) return { use: 'none' };
  if (mm === 'unknown') return { use: 'refuse', reason: "re-render to post: the song's source is not known", renderOnly: false, unknown: true };
  if (!isPlain(mm) || !cfg) return { use: 'refuse', reason: 'the montage music record cannot be read', renderOnly: false };
  if (mm.library !== cfg.library) return { use: 'refuse', reason: 'render only, not auto-posted: the montage song is not from your NCS library', renderOnly: true };
  const origin = cfg.ncsFilename && mm.origin === cfg.ncsFilename.source ? mm.origin : null;
  const bad = creditProblem(mm.credit, cfg, origin);
  if (bad) return { use: 'refuse', reason: `not sent: ${bad}. Add it in Settings > Clips > Montage music.`, renderOnly: false };
  const c = { artist: mm.credit.artist.trim(), title: mm.credit.title.trim(), line: (mm.credit.line ?? '').trim(), link: (mm.credit.link ?? '').trim() };
  const text = (origin ? cfg.ncsFilename.template : cfg.credit.template).map((s) => s.replace(/\{(artist|title|line|link)\}/g, (_m, k) => c[k])).filter((s) => s.trim()).join('\n');
  return { use: 'credit', text };
}
/**
 * Codex BD review: a clip row's music, from the render's own record (row.music: clip_publish.py music_provenance, in
 * uploads.json or the <video>.music.json sidecar a clips-folder scan reads), as musicCredit's input. Made-here music
 * and no music -> undefined (postable); the NCS library -> { library: 'ncs', trackId, credit }; the D411 music folder
 * -> { library: null } (render only); an unknown record -> 'unknown' (held). A row with no record (rendered before
 * records were kept), of any kind: made here (postable) when legacyMadeHere (see legacyMadeHere), else 'unknown'.
 */
export function musicOf(row, { legacyMadeHere = false } = {}) {
  if (!isPlain(row)) return 'unknown';
  if (row.montageMusic !== undefined) return row.montageMusic;
  const m = row.music;
  if (m === undefined || m === null) return legacyMadeHere ? undefined : 'unknown';
  if (!isPlain(m)) return 'unknown';
  if (m.source === 'generated' || m.source === 'none') return undefined;
  if (m.source === 'ncs') return { library: 'ncs', trackId: m.trackId, credit: m.credit ?? null };
  if (m.source === 'ncs-filename') return { library: 'ncs', origin: 'ncs-filename', trackId: m.trackId, credit: m.credit ?? null };
  if (m.source === 'user-folder') return { library: null };
  return 'unknown';
}
/**
 * Clips rendered before music records were kept: their music can only have been made here when the user never set the
 * D411 clip-look music folder and no montage-music library track was ever picked (no pick history). Then true.
 */
export function legacyMadeHere(dataDir, cfg = montageCfg()) {
  let folder;
  try { folder = readSettings(dataDir).clips.look?.music?.folder ?? ''; } catch { return false; }
  if (typeof folder !== 'string' || folder.trim() || !cfg || typeof cfg.history !== 'string') return false;
  return !existsSync(path.join(dataDir, ...cfg.history.split('/')));
}
/**
 * Codex verify (D414): the moment music records started. Written once, the first time this code (or the publish step,
 * clip_publish.py ensure_provenance_since) runs, and never moved later. Only a clip older than it can be a legacy clip;
 * a newer clip with no record is unknown and held, whatever the settings say later.
 */
export const PROVENANCE_FILE = 'clips/music-provenance.json';
export function readProvenanceSince(dataDir) {
  if (typeof dataDir !== 'string') return null;
  try {
    const j = JSON.parse(readFileSync(path.join(dataDir, ...PROVENANCE_FILE.split('/')), 'utf8'));
    const ms = Date.parse(j?.since);
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}
export function ensureProvenanceSince(dataDir, now = () => new Date()) {
  const have = readProvenanceSince(dataDir);
  if (have !== null || typeof dataDir !== 'string') return have;
  const file = path.join(dataDir, ...PROVENANCE_FILE.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx');
  try { writeSync(fd, JSON.stringify({ version: 1, since: now().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, file); } catch (e) { if (e?.code !== 'EEXIST') throw e; } finally { try { unlinkSync(tmp); } catch { /* gone */ } }
  return readProvenanceSince(dataDir); // whoever linked first wins; never moved
}
/** When a clip was made, as late as its files say (creation or last change, the later): null when none can be read. */
export function clipTimeMs(...files) {
  let t = null;
  for (const f of files) {
    try { const s = statSync(f); const v = Math.max(s.birthtimeMs || 0, s.mtimeMs || 0); if (v > 0) t = Math.max(t ?? 0, v); } catch { /* none */ }
  }
  return t;
}
/** -> { pass, since } for one posting run: the settings rule (legacyMadeHere) and the provenance start (made once). */
export function legacyContext(dataDir) {
  return { pass: legacyMadeHere(dataDir), since: ensureProvenanceSince(dataDir) };
}
/** True only when the settings rule passes and the clip (its files) is older than the provenance start. */
export function legacyFor(ctx, ...files) {
  if (!ctx?.pass || !Number.isFinite(ctx.since)) return false;
  const t = clipTimeMs(...files);
  return t !== null && Math.floor(t) <= ctx.since; // the start is kept to the millisecond: the same millisecond counts as before
}
/** clip_publish.py music_provenance for a render.json clip entry (packageRun reads the run folder directly). */
export function renderMusic(rdoc, clipId) {
  const c = Array.isArray(rdoc?.clips) ? rdoc.clips.find((x) => isPlain(x) && x.id === clipId) : undefined;
  if (!isPlain(c) || !('music' in c)) return rdoc?.musicRecords ? { source: 'unknown' } : undefined;
  const m = c.music;
  if (m === null) return { source: 'none' };
  if (!isPlain(m)) return { source: 'unknown' };
  if (m.source === 'ncs') return { source: 'ncs', trackId: m.trackId, credit: m.credit ?? null };
  if (m.source === 'ncs-filename') return { source: 'ncs-filename', trackId: m.trackId, credit: m.credit ?? null, ncs: m.ncs ?? null };
  if (m.source === 'folder') return { source: 'user-folder', track: m.track };
  if (m.source === 'made-here' || (m.source === undefined && !('track' in m) && 'seed' in m)) return { source: 'generated' };
  return { source: 'unknown' };
}
/** What a package records about its music so approve and upload check it again (source.music). */
export function musicStamp(mm, music) {
  return music.use === 'credit'
    ? { checked: 1, use: 'credit', library: mm.library, trackId: String(mm.trackId ?? '').slice(0, 32) }
    : { checked: 1, use: 'post' };
}
/**
 * Fail closed before approve and upload. null = fine; 'music-credit-missing' = a library song's credit is not in the
 * description; 'music-unchecked' = the package carries no music check (source.music) and was made after the
 * provenance start (sinceMs; packages from before it predate the gate and pass as before).
 */
export function creditMissing(post, sinceMs = null) {
  const s = isPlain(post?.source) ? post.source : {};
  const mc = s.musicCredit;
  const credit = () => (typeof mc === 'string' && mc.trim() && typeof post.description === 'string' && post.description.includes(mc) ? null : 'music-credit-missing');
  if (s.music !== undefined) {
    if (!isPlain(s.music) || s.music.checked !== 1) return 'music-unchecked';
    if (s.music.use === 'post') return null;
    return s.music.use === 'credit' ? credit() : 'music-unchecked';
  }
  if (s.montageMusic !== undefined || mc !== undefined) return credit();
  if (Number.isFinite(sinceMs)) { const at = Date.parse(post?.createdAt); if (!(Number.isFinite(at) && at < sinceMs)) return 'music-unchecked'; }
  return null;
}
// ---- montage music credit end

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
