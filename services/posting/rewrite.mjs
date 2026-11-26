// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T4: rewrite the text of scheduled, not yet public YouTube posts Ujwalam uploaded, and undo it.
//   runRewrite({ dataDir, store, auth, budget, flags, aiDeps, fetchImpl, ffmpeg, nowMs, limits, profile?, outputsStatus?, only?, log? })
//     (profile: the local profile for {handles.x} in the game's description lines; a line it cannot fill is left out)
//     -> { refused } | { rewritten: [id], skipped: [{ id, why }], left, stopped }
//   runUndo({ dataDir, store, auth, budget, flags, fetchImpl, nowMs, only?, force? }) -> { refused } | { restored: [id], skipped, left, stopped }
// Only videos in Ujwalam's own posting ledger (status uploaded, a videoId and the publish time Google got in the future)
// are candidates; nothing else on the channel is read or written. Per video, cheap local checks first, then
// videos.list part=snippet (1 unit), the checks against YouTube's answer (still private, still scheduled for the same time,
// text still the text Ujwalam uploaded), the AI text (same withAiText + checker as the drafts; a template fallback or a
// failed check SKIPS the video, never overwrites it), then the whole original snippet is saved, videos.update is sent
// (the snippet is replaced as a whole, so every writable field is carried over) and one ledger line is written.
// Quota (quota.json updateUnits 50 per update, source and UNVERIFIED note there): checked before every video; the run stops
// when a read plus an update would touch the day's read reserve and reports how many were left.
// Files: <data>/posting/rewrites.json (originals and state per video id), <data>/posting/rewrite-ledger.jsonl (one line each).
// Never writes a stream key or token; chat text never reaches the model (the checker's rule, unchanged).
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keepsParts } from './ai-text-check.mjs';
import { withAiText } from './ai-text.mjs';
import { dropTemplateLead, gameHashtags, gameLines, gameTags, gameTitleTags, resolveGame } from './game-text.mjs';
import { checkLimits, cleanProfile, composeField, limitsFit, loadLimits, loadTemplates, renderText, unresolvedKeys } from './index.mjs';
import { readPrefs } from './post-prefs.mjs';
import { CAPTIONS_SCOPE } from './oauth.mjs';
import { WRITABLE_SNIPPET, getVideoSnippet, isStreamLive, updateVideoSnippet } from './youtube.mjs';

export const REWRITE_FLAG = 'post-rewrite-scheduled';
export const REWRITES_NAME = 'rewrites.json';
export const REWRITE_LEDGER_NAME = 'rewrite-ledger.jsonl';
const READ_UNITS = 1; // videos.list
const MARGIN_MS = 30 * 60 * 1000; // a video this close to going public is left alone (generation takes minutes)
export const LOCK_NAME = 'rewrite.lock';
/** Same text up to what YouTube may normalise: line endings and trailing spaces (UNVERIFIED which of these it changes). */
const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
/** One rewrite or undo at a time: exclusive lock file (wx); a dead owner's lock is taken over. -> release fn | null (busy). */
export function takeLock(dataDir) {
  const f = path.join(dataDir, 'posting', LOCK_NAME);
  mkdirSync(path.dirname(f), { recursive: true });
  for (let n = 0; n < 2; n++) {
    try { const fd = openSync(f, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); return () => { try { unlinkSync(f); } catch { /* gone */ } }; } catch (e) {
      if (e?.code !== 'EEXIST') return null;
      let pid = NaN; try { pid = Number(readFileSync(f, 'utf8')); } catch { /* raced */ }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return null;
      try { unlinkSync(f); } catch { return null; }
    }
  }
  return null;
}
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const times = (a, b) => Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Date.parse(a) === Date.parse(b);

function readState(file) {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); if (j && typeof j === 'object' && j.items && typeof j.items === 'object') return j; } catch { /* none yet */ }
  return { version: 1, items: {} };
}
function writeState(file, j) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(j, null, 2));
  renameSync(tmp, file);
}
export const rewritesFile = (dataDir) => path.join(dataDir, 'posting', REWRITES_NAME);
export const rewriteLedgerFile = (dataDir) => path.join(dataDir, 'posting', REWRITE_LEDGER_NAME);
export const readRewrites = (dataDir) => readState(rewritesFile(dataDir));
function ledgerLine(dataDir, line) {
  const f = rewriteLedgerFile(dataDir);
  mkdirSync(path.dirname(f), { recursive: true });
  appendFileSync(f, `${JSON.stringify(line)}\n`);
}

export async function gate({ flags, auth, outputsStatus }) {
  if (!flags?.isOn?.(REWRITE_FLAG)) return 'flag-off';
  if (outputsStatus) {
    let o; try { o = await outputsStatus(); } catch { return 'live-state-unreadable'; }
    if (isStreamLive(o)) return 'live';
  }
  try {
    const scopes = typeof auth.grantedScopes === 'function' ? await auth.grantedScopes() : null;
    if (!Array.isArray(scopes) || !scopes.includes(CAPTIONS_SCOPE)) return 'scope-missing';
    await auth.accessToken();
  } catch { return 'not-signed-in'; }
  return null;
}

/** The videos in Ujwalam's own ledger that are uploaded and scheduled in the future, with their package. */
export function scheduledCandidates({ store, nowMs, only = null, marginMs = MARGIN_MS }) {
  const out = [];
  for (const e of store.ledger.list()) {
    if (!e || typeof e.sha256 !== 'string' || typeof e.target !== 'string' || e.status !== 'uploaded' || typeof e.videoId !== 'string' || !e.videoId) continue;
    if (typeof e.publishAt !== 'string' || !TIME.test(e.publishAt)) continue;
    if (typeof e.heldAt === 'string') continue; // held (hold.mjs): no longer scheduled on YouTube
    if (!(Date.parse(e.publishAt) > nowMs + marginMs)) continue; // public, past or about to go public: untouched
    const id = `${e.sha256.slice(0, 16)}.${e.target}`;
    if (Array.isArray(only) && !only.includes(id)) continue;
    out.push({ id, entry: e });
  }
  return out;
}

const apiWhy = (e) => (e?.code === 'quota-exceeded' ? 'quota-exceeded' : String(e?.code ?? 'error').slice(0, 40));

export async function runRewrite(o) {
  const bad = await gate({ flags: o.flags, auth: o.auth, outputsStatus: o.outputsStatus });
  if (bad) return { refused: bad };
  const release = takeLock(o.dataDir);
  if (!release) return { refused: 'busy' };
  try { return await rewriteInner(o); } finally { release(); }
}
async function rewriteInner(o) {
  const { dataDir, store, auth, budget, flags, nowMs = Date.now, fetchImpl, log = () => {} } = o;
  const limits = o.limits ?? loadLimits();
  const templates = o.templates ?? loadTemplates();
  const stateFile = rewritesFile(dataDir);
  const cands = scheduledCandidates({ store, nowMs: nowMs(), only: o.only, marginMs: o.marginMs ?? MARGIN_MS });
  const rewritten = []; const skipped = []; let stopped = null;
  const need = (o.updateUnits ?? 50) + READ_UNITS;
  const room = budget.writeRoom?.(need) ?? { fit: cands.length, why: null };
  log(`rewrite: ${cands.length} scheduled video(s) from Ujwalam's list; today's quota has room for ${room.why ? 0 : room.fit}`);
  const margin = o.marginMs ?? MARGIN_MS;
  const profile = cleanProfile(o.profile ?? {});
  const { text: ownText } = readPrefs(dataDir).prefs;
  const ownTags = ownText.tags ?? [];
  const ownHashtags = (ownText.hashtags ?? []).filter((h) => h.toLowerCase() !== '#shorts');

  await withAiText(o.aiDeps ?? {}, async (gen, aiWhy) => {
    for (const { id, entry } of cands) {
      const skip = (why) => { skipped.push({ id, why }); };
      const st = readState(stateFile);
      const prev = st.items[entry.videoId];
      // a video rewritten under an older AI text version is rewritten again (2026-11-25: the game name, stricter facts);
      // its record keeps the very first original, so undo still goes back to Ujwalam's own upload text
      const redo = prev?.state === 'rewritten' && gen && prev.version !== gen.version;
      if (prev?.state === 'rewritten' && !redo) { skip('already-rewritten'); continue; }
      if (prev?.state === 'pending') { skip('pending-unresolved'); continue; } // an update that may have been applied: undo checks it
      const dir = store.dir(id);
      const post = (() => { try { return JSON.parse(readFileSync(path.join(dir, 'post.json'), 'utf8')); } catch { return null; } })();
      if (!dir || !post) { skip('package-missing'); continue; }
      if (post.textSource === 'ai') { skip('already-ai-text'); continue; }
      if (post.editedByUser === true) { skip('edited-by-user'); continue; }
      const video = store.media(id, 'video');
      if (!video || !existsSync(video.file)) { skip('video-file-gone'); continue; }
      if (!gen) { skip(`ai-${aiWhy ?? 'off'}`); continue; }
      const seconds = Number.isFinite(post.source?.endSec) && Number.isFinite(post.source?.startSec) ? post.source.endSec - post.source.startSec : null;
      if (!(seconds > 0)) { skip('no-length'); continue; }
      // quota: stop before the read reserve would be touched
      if (budget.writeRoom && budget.writeRoom(need).why) { stopped = 'quota-day-used'; break; }
      const readWhy = (budget.reserveWriteRead ?? budget.reserveRead)(READ_UNITS);
      if (readWhy) { stopped = readWhy; break; }
      let accessToken; try { accessToken = await auth.accessToken(); } catch { stopped = 'not-signed-in'; break; }
      let remote;
      try { remote = await getVideoSnippet({ videoId: entry.videoId, accessToken, fetchImpl }); } catch (e) { if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; } skip(`read-${apiWhy(e)}`); continue; }
      if (!remote.found || !remote.snippet) { skip('video-not-found'); continue; }
      if (remote.privacyStatus !== 'private' || typeof remote.publishAt !== 'string' || !times(remote.publishAt, entry.publishAt) || !(Date.parse(remote.publishAt) > nowMs() + margin)) { skip('not-scheduled-now'); continue; }
      // the text on YouTube must still be the text Ujwalam wrote: the upload's, or (redo) this tool's last rewrite
      const mine = redo ? { title: prev.written?.title, description: prev.written?.description } : { title: composeField(post, ['title']), description: composeField(post, ['description', 'hashtags']) };
      if (norm(remote.snippet.title) !== norm(mine.title) || norm(remote.snippet.description) !== norm(mine.description)) { skip('changed-on-youtube'); continue; }
      if (typeof remote.snippet.categoryId !== 'string') { skip('no-category'); continue; }
      const facts = post.source?.facts ?? {};
      const game = resolveGame(post.source?.game ?? null, o.gamesDir ? { gamesDir: o.gamesDir } : undefined);
      const r = await gen({ file: video.file, seconds, facts, kind: post.source?.kind ?? 'short', limits: limits.targets?.[post.target], ffmpeg: o.ffmpeg, cover: false, game }); // text only: the cover hook is not used
      if (!r.ok) { skip(`template-fallback-${String(r.code).slice(0, 30)}`); continue; }
      // the new text: AI title (with the game), AI lines then the old description without the template's own opening
      // line (links, credits stay), the game's tags first, then the AI tags, then the old ones; the game's hashtags
      // 2026-11-25 style: the game's lines (Featured, subscribe, streamer) after the AI lines, the title hashtags when
      // they fit, and the user's own tags (Settings) right after the game's
      const kept = dropTemplateLead(post.description, templates);
      const lines = gameLines(r.game ?? null, post.target, facts.mode, (s) => { const m = new Set(); const t = renderText(s, { profile, n: 1, date: '' }, m); return m.size ? null : t; });
      const titleMax = limits.targets?.[post.target]?.fields?.title?.max ?? null;
      const p = { title: gameTitleTags(r.text.title, r.game ?? null, post.target, titleMax), description: [r.text.description, lines, kept].filter(Boolean).join('\n\n'), tags: [], hashtags: gameHashtags(r.game ?? null, post.target) ?? [...(post.hashtags ?? [])], target: post.target };
      const fits = limitsFit(p, limits);
      const seenTag = new Set();
      for (const t of gameTags(r.game ?? null, post.target, facts.mode, [...ownTags, ...r.text.tags, ...(post.tags ?? [])])) {
        if (!seenTag.has(t.toLowerCase()) && fits({ tags: [...p.tags, t] })) { p.tags.push(t); seenTag.add(t.toLowerCase()); }
      }
      // the user's own hashtags (Settings) after the game's; the footer is already in the kept text, so only these
      for (const h of ownHashtags) {
        if (!p.hashtags.some((x) => x.toLowerCase() === h.toLowerCase()) && fits({ tags: p.tags, hashtags: [...p.hashtags, h] })) p.hashtags.push(h);
      }
      // a placeholder the old text already carried is not new; one the AI text brings is a reject
      const oldKeys = new Set(unresolvedKeys(post.title, post.description, ...(post.tags ?? [])));
      const newKeys = unresolvedKeys(p.title, r.text.description, ...r.text.tags).filter((k) => !oldKeys.has(k));
      if (!p.title || newKeys.length || !checkLimits(p, limits).ok || keepsParts(p.description, [kept]) !== null) { skip(`text-rejected-${!p.title ? 'title' : newKeys.length ? 'unresolved' : !checkLimits(p, limits).ok ? 'limits' : 'parts-lost'}`); continue; }
      const next = { ...pick(remote.snippet), title: composeField(p, ['title']), description: composeField(p, ['description', 'hashtags']), tags: p.tags };
      // generation took a while: the video must still be far enough from going public
      if (!(Date.parse(remote.publishAt) > nowMs() + margin)) { skip('too-close-to-publish'); continue; }
      const updWhy = budget.reserveUpdate();
      if (updWhy) { stopped = updWhy; break; }
      // the original is saved BEFORE the call, so a crash leaves it recoverable; the record is re-read first so an
      // earlier run's record (and its text) is never taken as the original
      const at = new Date(nowMs()).toISOString();
      const fresh = readState(stateFile);
      const now = fresh.items[entry.videoId];
      if (now && (now.state === 'pending' || (now.state === 'rewritten' && (!redo || now.version === gen.version)))) { skip('already-rewritten'); continue; }
      try { accessToken = await auth.accessToken(); } catch { stopped = 'not-signed-in'; break; }
      fresh.items[entry.videoId] = { id, sha256: entry.sha256, target: entry.target, state: 'pending', original: redo && now?.original ? now.original : remote.snippet, written: next, at, version: gen.version ?? null, ...(redo ? { redoOf: now?.version ?? null } : {}) };
      writeState(stateFile, fresh);
      try { await updateVideoSnippet({ videoId: entry.videoId, snippet: next, accessToken, fetchImpl }); } catch (e) {
        // only a definite 4xx means nothing was written; a timeout or dropped connection may have applied it, so the record stays pending
        if (e?.definite === true) { const f2 = readState(stateFile); delete f2.items[entry.videoId]; writeState(stateFile, f2); } else { skip('update-unknown-pending'); continue; }
        if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; }
        skip(`update-${apiWhy(e)}`); continue;
      }
      const f3 = readState(stateFile); f3.items[entry.videoId] = { ...f3.items[entry.videoId], state: 'rewritten' }; writeState(stateFile, f3);
      ledgerLine(dataDir, { at, action: 'rewrite', id, videoId: entry.videoId, publishAt: entry.publishAt, aiVersion: gen.version ?? null, units: (o.updateUnits ?? 50) + READ_UNITS });
      rewritten.push(id);
    }
  });
  const done = rewritten.length + skipped.length;
  return { rewritten, skipped, left: stopped ? cands.length - done : 0, stopped };
}

const pick = (snip) => Object.fromEntries(WRITABLE_SNIPPET.filter((k) => snip?.[k] !== undefined).map((k) => [k, snip[k]]));

export async function runUndo(o) {
  // undo is the way back: it needs the same permission, not the rewrite switch
  const bad = await gate({ flags: { isOn: () => true }, auth: o.auth, outputsStatus: o.outputsStatus });
  if (bad) return { refused: bad };
  const release = takeLock(o.dataDir);
  if (!release) return { refused: 'busy' };
  try { return await undoInner(o); } finally { release(); }
}
async function undoInner(o) {
  const { dataDir, store, auth, budget, nowMs = Date.now, fetchImpl } = o;
  const stateFile = rewritesFile(dataDir);
  const items = Object.entries(readState(stateFile).items).filter(([, v]) => (v.state === 'rewritten' || v.state === 'pending') && (!Array.isArray(o.only) || o.only.includes(v.id)));
  const restored = []; const skipped = []; let stopped = null;
  const need = (o.updateUnits ?? 50) + READ_UNITS;
  for (let i = 0; i < items.length; i++) {
    const [videoId, rec] = items[i];
    const skip = (why) => skipped.push({ id: rec.id, why });
    if (!store.ledger.get(rec.sha256, rec.target)) { skip('not-in-our-list'); continue; } // only our own ledger
    if (budget.writeRoom && budget.writeRoom(need).why) { stopped = 'quota-day-used'; break; }
    const readWhy = (budget.reserveWriteRead ?? budget.reserveRead)(READ_UNITS);
    if (readWhy) { stopped = readWhy; break; }
    let accessToken; try { accessToken = await auth.accessToken(); } catch { stopped = 'not-signed-in'; break; }
    let remote;
    try { remote = await getVideoSnippet({ videoId, accessToken, fetchImpl }); } catch (e) { if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; } skip(`read-${apiWhy(e)}`); continue; }
    if (!remote.found || !remote.snippet) { skip('video-not-found'); continue; }
    // a video that is public (or about to be) is never changed, not even by a forced undo
    if (remote.privacyStatus !== 'private' || typeof remote.publishAt !== 'string' || !(Date.parse(remote.publishAt) > nowMs())) { skip('now-public'); continue; }
    const cur = pick(remote.snippet);
    if (same(cur, pick(rec.original))) { // already the original (e.g. a pending record whose update never arrived)
      const s = readState(stateFile); s.items[videoId] = { ...s.items[videoId], state: 'restored', restoredAt: new Date(nowMs()).toISOString() }; writeState(stateFile, s); skip('already-original'); continue;
    }
    if (!same(cur, pick(rec.written)) && o.force !== true) { skip('changed-on-youtube'); continue; }
    const updWhy = budget.reserveUpdate();
    if (updWhy) { stopped = updWhy; break; }
    try { await updateVideoSnippet({ videoId, snippet: pick(rec.original), accessToken, fetchImpl }); } catch (e) {
      if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; }
      skip(`update-${apiWhy(e)}`); continue;
    }
    const at = new Date(nowMs()).toISOString();
    const s = readState(stateFile); s.items[videoId] = { ...s.items[videoId], state: 'restored', restoredAt: at }; writeState(stateFile, s);
    ledgerLine(dataDir, { at, action: 'undo', id: rec.id, videoId, units: (o.updateUnits ?? 50) + READ_UNITS });
    restored.push(rec.id);
  }
  return { restored, skipped, left: stopped ? items.length - restored.length - skipped.length : 0, stopped };
}
