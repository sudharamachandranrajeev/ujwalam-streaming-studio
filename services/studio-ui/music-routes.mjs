// SPDX-License-Identifier: GPL-3.0-or-later
// UI server routes for scene music (MU2, plan 2026-11-18-audio-mixer-music). No flag: a requested feature ships on;
// each scene's music is off until the user switches it on in the scene's Music row. Each click applies at once (D332),
// also while live (it changes what the stream hears, never the picture). Order as for the mixer (audio-routes.mjs):
// project read -> pure change (validated) -> host -> file saved; a host refusal saves nothing, a failed save undoes the
// host change.
//
//   GET  /ui/api/music  { moods: [{id, title, status, made}], libraryMade, scenes: [{id, name, music}], strip, now }
//                       now = host music.status (what plays and why), null when the host is not reachable
//   POST /ui/api/music {op: 'scene', scene, music: {on, mood, volumeDb}}
//                       saves the scene's music. Switching music on when the project has no Music strip adds one (with
//                       "Duck music under my voice" under the first microphone, when there is one). -> { ok, saved, now }
//   POST /ui/api/music {op: 'preview', mood}  Listen: the host plays the mood's bed on the monitoring device only (a
//                       private source in no track), off air only. The host refuses while any output is active and
//                       stops it before any output starts (scene_music::preview_stop), so it is never heard on air.
//                       {op: 'preview', mood: null} stops it.
// The library is <data dir>/music (MU1 makes it off air: services/clip/scene_music.py --out <it>).
import { loadProject, saveProject } from '../project/store.mjs';
import { validateProject } from '../project/index.mjs';
import { MOOD_RE, VOLUME_DB, libraryExists, libraryState, listMoods, musicStrip, newMusicStrip, sceneMusicProblems } from '../project/scene-music.mjs';

export const MUSIC_ROUTES = Object.freeze(['/ui/api/music']);
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export const MUSIC_ERROR_TEXT = Object.freeze({
  'no-project-file': 'No project file is open, so nothing can be saved.',
  'project-unreadable': 'The project file could not be read.',
  'host-unavailable': 'The studio host is not reachable.',
  'unknown-scene': 'That scene is not in the project any more.',
  'unknown-mood': 'Pick a mood from the list.',
  'bad-params': 'That request was not understood.',
  'not-made': 'This mood\'s music is not made yet. Make the music library off air first.',
  'on-air': 'Listening is only possible off air (no stream and no recording running).',
  'not-saved': 'The project file could not be saved, so the change was undone. Nothing changed.',
  'not-saved-live': 'The project file could not be saved and the change could not be undone: it is live until Ujwalam restarts.',
  'host-unsure': 'The studio host did not answer, and what it plays could not be checked. Try again in a moment.',
  invalid: 'The project would not be valid with that change.',
  busy: 'The last music change is still on its way; try again in a moment.',
});

/** Pure: the project with scene `scene`'s music set (and a Music strip when music goes on and there is none). */
export function setSceneMusic(doc, { scene, music, moods }) {
  const p = structuredClone(doc);
  const sc = (p.scenes ?? []).find((s) => s.id === scene);
  if (!sc) return { error: 'unknown-scene' };
  if (sceneMusicProblems(music, 'music').length) return { error: 'bad-params' };
  if (!moods.some((m) => m.id === music.mood)) return { error: 'unknown-mood' };
  sc.music = { on: music.on, mood: music.mood, volumeDb: Math.round(music.volumeDb * 10) / 10 };
  let added = null;
  if (music.on && !musicStrip(p)) {
    p.audio = p.audio ?? { tracks: [], sources: [] };
    p.audio.sources = p.audio.sources ?? [];
    const devKind = new Map((p.devices ?? []).map((d) => [d.id, d.kind]));
    const mic = p.audio.sources.find((a) => devKind.get(a.device) === 'microphone')?.id ?? null;
    const ids = new Set(p.audio.sources.map((a) => a.id));
    let id = 'scene-music';
    for (let i = 2; ids.has(id); i++) id = `scene-music-${i}`;
    added = newMusicStrip({ id, mic });
    const track = p.audio.tracks?.[0]?.id;
    if (!track) return { error: 'invalid' };
    added.tracks = [track];
    p.audio.sources.push(added);
  }
  const v = validateProject(p);
  if (!v.ok) return { error: 'invalid', errors: v.errors };
  return { project: p, added, music: sc.music };
}

const sameMusic = (a, b) => !!a && !!b && a.on === b.on && a.mood === b.mood && Number(a.volumeDb) === Number(b.volumeDb);

/**
 * opts: { host, json, projectSync, dataDir, libraryDir, moodsDir?, log?, afterEdit?() }
 */
export function createMusicRoutes(opts) {
  const { host, json } = opts;
  const log = opts.log ?? (() => {});
  const libraryDir = opts.libraryDir;
  const moods = () => listMoods(opts.moodsDir);
  let busy = false;
  const refuse = (res, code, status = 409, detail) => json(res, status, { error: code, text: MUSIC_ERROR_TEXT[code] ?? code, ...(detail ? { detail } : {}) });

  function readDoc() {
    const file = opts.projectSync?.status?.().file;
    if (typeof file !== 'string') return { error: 'no-project-file' };
    opts.projectSync.reload();
    try { return { file, doc: loadProject(file).project }; } catch { return { error: 'project-unreadable' }; }
  }
  async function now() { try { return await host.call('music.status', {}); } catch { return null; } }

  async function state(res) {
    const ms = moods();
    const made = libraryDir ? libraryState(libraryDir, ms) : {};
    const r = readDoc();
    const scenes = (r.doc?.scenes ?? []).map((s) => ({ id: s.id, name: s.name, music: s.music ?? null }));
    const nowCached = now();
    return json(res, 200, {
      moods: ms.map((m) => ({ ...m, made: made[m.id]?.made === true })),
      libraryMade: !!libraryDir && libraryExists(libraryDir) && ms.some((m) => made[m.id]?.made),
      volumeDb: VOLUME_DB, scenes, strip: musicStrip(r.doc)?.id ?? null, now: await nowCached,
      previewing: (await nowCached)?.previewing ?? null, ...(r.error ? { error: r.error } : {}),
    });
  }

  async function sceneEdit(res, body) {
    if (typeof body.scene !== 'string' || !ID.test(body.scene) || !isPlain(body.music)) return refuse(res, 'bad-params', 400);
    const r = readDoc();
    if (r.error) return refuse(res, r.error);
    const x = setSceneMusic(r.doc, { scene: body.scene, music: body.music, moods: moods() });
    if (x.error) return refuse(res, x.error, x.error === 'bad-params' || x.error === 'unknown-mood' ? 400 : 409, x.errors?.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300));
    const old = (r.doc.scenes ?? []).find((s) => s.id === body.scene)?.music ?? null;
    // Puts the host back to the file's state. Removing an added strip restores every scene's music from r.doc (host
    // audio_remove_model -> music_from_doc); otherwise the one scene is set back.
    const undo = async () => {
      if (x.added) await host.call('audio.removeFromProject', { project: r.doc, audio: x.added.id }).catch((e) => { if (e?.code !== -32602) throw e; });
      await host.call('music.setScene', { scene: body.scene, music: old });
    };
    // A failed or lost reply may still have been applied: read back what the host holds before deciding.
    const applied = async () => {
      const s = await host.call('music.status', {});
      return sameMusic(s?.scenes?.[body.scene], x.music) && (!x.added || s?.attached === true);
    };
    try {
      if (x.added) await host.call('audio.addFromProject', { project: x.project, audio: x.added.id });
      await host.call('music.setScene', { scene: body.scene, music: x.music });
    } catch (e) {
      let ok = false;
      try { ok = await applied(); } catch {
        return json(res, 502, { error: 'host-unsure', text: MUSIC_ERROR_TEXT['host-unsure'], detail: String(e?.message ?? e?.code ?? 'error').slice(0, 200) });
      }
      if (!ok) {
        try { await undo(); } catch { /* the host did not take it; nothing to keep */ }
        return json(res, 502, { error: 'host-error', text: MUSIC_ERROR_TEXT['host-unavailable'], detail: String(e?.message ?? e?.code ?? 'error').slice(0, 200) });
      }
      log('[studio-ui] scene music: the host reply was lost but the change is in place; saving it');
    }
    try { saveProject(r.file, x.project); } catch {
      // saveProject can throw after the new file is in place (a check after the rename): then it is saved.
      if (!installed(r.file, body.scene, x)) {
        let undone = true;
        try { await undo(); } catch { undone = false; }
        opts.projectSync.reload();
        return refuse(res, undone ? 'not-saved' : 'not-saved-live', 500);
      }
    }
    opts.projectSync.reload();
    opts.afterEdit?.();
    log(`[studio-ui] scene music: ${body.scene} ${x.music.on ? `on (${x.music.mood}, ${x.music.volumeDb} dB)` : 'off'}${x.added ? '; Music strip added' : ''}`);
    return json(res, 200, { ok: true, saved: true, scene: body.scene, music: x.music, stripAdded: x.added?.id ?? null, now: await now() });
  }

  // Listen: the host owns the player (one at a time, stopped before any output starts, off air only).
  async function previewEdit(res, body) {
    if (body.mood !== null) {
      if (typeof body.mood !== 'string' || !MOOD_RE.test(body.mood) || !moods().some((m) => m.id === body.mood)) return refuse(res, 'unknown-mood', 400);
      if (!libraryDir || libraryState(libraryDir, [{ id: body.mood }])[body.mood]?.made !== true) return refuse(res, 'not-made');
    }
    try {
      const r = await host.call('music.preview', { mood: body.mood });
      return json(res, 200, { ok: true, previewing: r?.previewing ?? null });
    } catch (e) {
      if (e?.code === -32009) return refuse(res, 'on-air', 409, String(e?.message ?? '').slice(0, 200));
      return json(res, 502, { error: 'host-error', text: MUSIC_ERROR_TEXT['host-unavailable'] });
    }
  }

  return {
    /** Stops Listen (the UI server closing). */
    async stopPreview() { try { await host.call('music.preview', { mood: null }); } catch { /* host gone: its shutdown stops it */ } },
    /** true when the route was handled. */
    async handle(method, route, body, res) {
      if (route !== '/ui/api/music') return false;
      if (method === 'GET') { await state(res); return true; }
      if (method !== 'POST') return false;
      if (!isPlain(body) || !['scene', 'preview'].includes(body.op)) { refuse(res, 'bad-params', 400); return true; }
      const allowed = body.op === 'scene' ? ['op', 'scene', 'music'] : ['op', 'mood'];
      if (Object.keys(body).some((k) => !allowed.includes(k))) { refuse(res, 'bad-params', 400); return true; }
      if (body.op === 'preview') { await previewEdit(res, body); return true; }
      if (busy) { refuse(res, 'busy'); return true; }
      busy = true;
      try { await sceneEdit(res, body); } finally { busy = false; }
      return true;
    },
  };
}

// True when the file on disk already holds this change (saveProject threw after its rename).
function installed(file, scene, x) {
  try {
    const p = loadProject(file).project;
    const sc = (p.scenes ?? []).find((s) => s.id === scene);
    return sameMusic(sc?.music, x.music) && (!x.added || musicStrip(p)?.id === x.added.id);
  } catch { return false; }
}
