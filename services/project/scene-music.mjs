// SPDX-License-Identifier: GPL-3.0-or-later
// Scene music (MU2, plan 2026-11-18-audio-mixer-music): each scene may carry music { on, mood, volumeDb }. The beds are
// the MU1 library (services/clip/scene_music.py, made off air only) in <data dir>/music/<mood>.wav; the host plays them
// on the one Music strip of the mixer (audio.sources[] entry { music: {} }) and fades with the scene transition.
//   sceneMusicProblems(m, path)      -> [{path, message}] for a scene's music value
//   listMoods(dir = MOODS_DIR)       -> [{id, title, status}] from data/music/moods/*.json (sorted by id)
//   moodFile(libraryDir, mood)       -> absolute path of the mood's bed (it may not exist)
//   libraryState(libraryDir, moods)  -> {mood: {made, bytes}} which beds are there
//   musicStrip(project)              -> the project's music audio source or null
//   newMusicStrip({id, mic})         -> a Music strip for audio.sources (track t1, duck under `mic` when given)
//   DEFAULT_MOODS                    -> scene name word -> mood (the user's choices, 2026-11-18)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOOD_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const VOLUME_DB = Object.freeze([-40, 0]);
export const MOODS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'music', 'moods');
export const LIBRARY_SUBDIR = 'music';

export function sceneMusicProblems(m, p) {
  const out = [];
  const bad = (q, message) => out.push({ path: q, message });
  if (m === null || typeof m !== 'object' || Array.isArray(m)) { bad(p, 'must be an object'); return out; }
  for (const k of Object.keys(m)) if (!['on', 'mood', 'volumeDb'].includes(k)) bad(`${p}.${k}`, 'unknown property');
  for (const k of ['on', 'mood', 'volumeDb']) if (!(k in m)) bad(p, `missing ${k}`);
  if ('on' in m && typeof m.on !== 'boolean') bad(`${p}.on`, 'must be a boolean');
  if ('mood' in m && (typeof m.mood !== 'string' || !MOOD_RE.test(m.mood))) bad(`${p}.mood`, 'must be a mood id');
  if ('volumeDb' in m && (typeof m.volumeDb !== 'number' || !Number.isFinite(m.volumeDb) || m.volumeDb < VOLUME_DB[0] || m.volumeDb > VOLUME_DB[1])) {
    bad(`${p}.volumeDb`, `must be a number ${VOLUME_DB[0]}..${VOLUME_DB[1]}`);
  }
  return out;
}

export function listMoods(dir = MOODS_DIR) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    try {
      const m = JSON.parse(readFileSync(path.join(dir, n), 'utf8'));
      if (typeof m.id === 'string' && MOOD_RE.test(m.id) && `${m.id}.json` === n) out.push({ id: m.id, title: String(m.title ?? m.id).slice(0, 80), status: m.status === 'accepted' ? 'accepted' : 'proposed' });
    } catch { /* a broken manifest is left out */ }
  }
  return out;
}

export function moodFile(libraryDir, mood) {
  if (!MOOD_RE.test(mood)) throw new TypeError('bad mood id');
  return path.join(libraryDir, `${mood}.wav`);
}

export function libraryState(libraryDir, moods) {
  const out = {};
  for (const m of moods) {
    let made = false, bytes = 0;
    try { const st = statSync(moodFile(libraryDir, m.id)); made = st.isFile() && st.size > 44; bytes = st.size; } catch { /* not made */ }
    out[m.id] = { made, bytes };
  }
  return out;
}

export const musicStrip = (project) => (project?.audio?.sources ?? []).find((s) => s && typeof s === 'object' && 'music' in s) ?? null;

export function newMusicStrip({ id = 'scene-music', mic = null } = {}) {
  const s = { id, name: 'Music', music: {}, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] };
  // "Duck music under my voice" (data/audio-tools/presets.json): 12 dB, within 10 ms, back within 400 ms. Only when a
  // microphone is in the mixer; the strip is made on the user's click (turning a scene's music on).
  if (mic) s.filters = { duck: { on: true, source: mic, amountDb: 12, attackMs: 10, releaseMs: 400 } };
  return s;
}

// Scene name word -> mood (the user's answers, 2026-11-18). Only a default for the picker when a scene's music is
// first switched on; the user picks any mood.
export const DEFAULT_MOODS = Object.freeze([
  [/start|soon|intro/i, 'starting-soon'], [/brb|break|be right back|away/i, 'brb'], [/end|outro|bye|thanks/i, 'ending'],
  [/match|game|play|live/i, 'in-match'], [/lobby|chat|talk/i, 'lobby'],
]);
export function defaultMood(sceneName, moods) {
  const ids = new Set(moods.map((m) => m.id));
  for (const [re, id] of DEFAULT_MOODS) if (re.test(String(sceneName ?? '')) && ids.has(id)) return id;
  return ids.has('lobby') ? 'lobby' : (moods[0]?.id ?? 'lobby');
}

export const libraryDirOf = (dataDir) => path.join(path.resolve(dataDir), LIBRARY_SUBDIR);
export const libraryExists = (dir) => existsSync(dir);
