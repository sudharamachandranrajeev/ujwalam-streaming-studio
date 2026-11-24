// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T4: rewrite the text of scheduled, not yet public YouTube posts Ujwalam uploaded, and undo it.
//   runRewrite({ dataDir, store, auth, budget, flags, aiDeps, fetchImpl, ffmpeg, nowMs, limits, outputsStatus?, only?, log? })
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { keepsParts } from './ai-text-check.mjs';
import { withAiText } from './ai-text.mjs';
import { checkLimits, composeField, limitsFit, loadLimits, unresolvedKeys } from './index.mjs';
import { CAPTIONS_SCOPE } from './oauth.mjs';
import { WRITABLE_SNIPPET, getVideoSnippet, isStreamLive, updateVideoSnippet } from './youtube.mjs';

export const REWRITE_FLAG = 'post-rewrite-scheduled';
export const REWRITES_NAME = 'rewrites.json';
export const REWRITE_LEDGER_NAME = 'rewrite-ledger.jsonl';
const READ_UNITS = 1; // videos.list
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

async function gate({ flags, auth, outputsStatus }) {
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
export function scheduledCandidates({ store, nowMs, only = null }) {
  const out = [];
  for (const e of store.ledger.list()) {
    if (!e || e.status !== 'uploaded' || typeof e.videoId !== 'string' || !e.videoId) continue;
    if (typeof e.publishAt !== 'string' || !TIME.test(e.publishAt)) continue;
    if (!(Date.parse(e.publishAt) > nowMs)) continue; // public or past: untouched
    const id = `${e.sha256.slice(0, 16)}.${e.target}`;
    if (Array.isArray(only) && !only.includes(id)) continue;
    out.push({ id, entry: e });
  }
  return out;
}

const apiWhy = (e) => (e?.code === 'quota-exceeded' ? 'quota-exceeded' : String(e?.code ?? 'error').slice(0, 40));

export async function runRewrite(o) {
  const { dataDir, store, auth, budget, flags, nowMs = Date.now, fetchImpl, log = () => {} } = o;
  const bad = await gate({ flags, auth, outputsStatus: o.outputsStatus });
  if (bad) return { refused: bad };
  const limits = o.limits ?? loadLimits();
  const stateFile = rewritesFile(dataDir);
  const cands = scheduledCandidates({ store, nowMs: nowMs(), only: o.only });
  const rewritten = []; const skipped = []; let stopped = null;
  const need = (o.updateUnits ?? 50) + READ_UNITS;
  const room = budget.writeRoom?.(need) ?? { fit: cands.length, why: null };
  log(`rewrite: ${cands.length} scheduled video(s) from Ujwalam's list; today's quota has room for ${room.why ? 0 : room.fit}`);
  const accessToken = await auth.accessToken();

  await withAiText(o.aiDeps ?? {}, async (gen, aiWhy) => {
    for (const { id, entry } of cands) {
      const skip = (why) => { skipped.push({ id, why }); };
      const st = readState(stateFile);
      const prev = st.items[entry.videoId];
      if (prev?.state === 'rewritten') { skip('already-rewritten'); continue; }
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
      const readWhy = budget.reserveRead(READ_UNITS);
      if (readWhy) { stopped = readWhy; break; }
      let remote;
      try { remote = await getVideoSnippet({ videoId: entry.videoId, accessToken, fetchImpl }); } catch (e) { if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; } skip(`read-${apiWhy(e)}`); continue; }
      if (!remote.found || !remote.snippet) { skip('video-not-found'); continue; }
      if (remote.privacyStatus !== 'private' || typeof remote.publishAt !== 'string' || !times(remote.publishAt, entry.publishAt) || !(Date.parse(remote.publishAt) > nowMs())) { skip('not-scheduled-now'); continue; }
      if (remote.snippet.title !== composeField(post, ['title']) || (remote.snippet.description ?? '') !== composeField(post, ['description', 'hashtags'])) { skip('changed-on-youtube'); continue; }
      if (typeof remote.snippet.categoryId !== 'string') { skip('no-category'); continue; }
      const r = await gen({ file: video.file, seconds, facts: post.source?.facts ?? {}, kind: post.source?.kind ?? 'short', limits: limits.targets?.[post.target], ffmpeg: o.ffmpeg });
      if (!r.ok) { skip(`template-fallback-${String(r.code).slice(0, 30)}`); continue; }
      // the new text: AI title, AI lines then the old description unchanged (links, credits), AI tags then the old ones
      const p = { title: r.text.title, description: `${r.text.description}\n\n${post.description}`, tags: [], hashtags: [...(post.hashtags ?? [])], target: post.target };
      const fits = limitsFit(p, limits);
      const seen = new Set();
      for (const t of [...r.text.tags, ...(post.tags ?? [])]) { const k = String(t).toLowerCase(); if (!t || seen.has(k)) continue; if (fits({ tags: [...p.tags, t] })) { p.tags.push(t); seen.add(k); } }
      // a placeholder the old text already carried is not new; one the AI text brings is a reject
      const oldKeys = new Set(unresolvedKeys(post.title, post.description, ...(post.tags ?? [])));
      const newKeys = unresolvedKeys(p.title, r.text.description, ...r.text.tags).filter((k) => !oldKeys.has(k));
      if (!p.title || newKeys.length || !checkLimits(p, limits).ok || keepsParts(p.description, [post.description]) !== null) { skip(`text-rejected-${!p.title ? 'title' : newKeys.length ? 'unresolved' : !checkLimits(p, limits).ok ? 'limits' : 'parts-lost'}`); continue; }
      const next = { ...pick(remote.snippet), title: composeField(p, ['title']), description: composeField(p, ['description', 'hashtags']), tags: p.tags };
      const updWhy = budget.reserveUpdate();
      if (updWhy) { stopped = updWhy; break; }
      // the original is saved BEFORE the call, so a crash leaves it recoverable
      const at = new Date(nowMs()).toISOString();
      const fresh = readState(stateFile);
      fresh.items[entry.videoId] = { id, sha256: entry.sha256, target: entry.target, state: 'pending', original: remote.snippet, written: next, at };
      writeState(stateFile, fresh);
      try { await updateVideoSnippet({ videoId: entry.videoId, snippet: next, accessToken, fetchImpl }); } catch (e) {
        const f2 = readState(stateFile); delete f2.items[entry.videoId]; writeState(stateFile, f2);
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
  const { dataDir, store, auth, budget, flags, nowMs = Date.now, fetchImpl } = o;
  // undo is the way back: it needs the same permission, not the rewrite switch
  const bad = await gate({ flags: { isOn: () => true }, auth, outputsStatus: o.outputsStatus });
  if (bad) return { refused: bad };
  const stateFile = rewritesFile(dataDir);
  const accessToken = await auth.accessToken();
  const items = Object.entries(readState(stateFile).items).filter(([, v]) => (v.state === 'rewritten' || v.state === 'pending') && (!Array.isArray(o.only) || o.only.includes(v.id)));
  const restored = []; const skipped = []; let stopped = null;
  const need = (o.updateUnits ?? 50) + READ_UNITS;
  for (let i = 0; i < items.length; i++) {
    const [videoId, rec] = items[i];
    const skip = (why) => skipped.push({ id: rec.id, why });
    if (!store.ledger.get(rec.sha256, rec.target)) { skip('not-in-our-list'); continue; } // only our own ledger
    if (budget.writeRoom && budget.writeRoom(need).why) { stopped = 'quota-day-used'; break; }
    const readWhy = budget.reserveRead(READ_UNITS);
    if (readWhy) { stopped = readWhy; break; }
    let remote;
    try { remote = await getVideoSnippet({ videoId, accessToken, fetchImpl }); } catch (e) { if (apiWhy(e) === 'quota-exceeded') { stopped = 'quota-exceeded'; break; } skip(`read-${apiWhy(e)}`); continue; }
    if (!remote.found || !remote.snippet) { skip('video-not-found'); continue; }
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
