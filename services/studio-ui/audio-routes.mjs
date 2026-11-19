// SPDX-License-Identifier: GPL-3.0-or-later
// UI server routes for the mixer's "Add audio", "Add to stream" and "Remove" (D393 proposed; user feedback on alpha.33:
// the game capture's sound had no mixer strip, and the user asked to add the available audio channels). No flag: a
// requested feature ships on. Each click applies at once (D332), also while live: it changes what the stream hears,
// never the picture. Order as for structure edits (D240): pending mixer edits written -> project file read -> pure
// change (services/project/audio-sources.mjs, validated) -> host -> file saved. A host refusal saves nothing; a failed
// save undoes the host change (500 not-saved), or says it is live only when the undo fails too (500 not-saved-live).
//
//   GET  /ui/api/audio/choices          { available, devicesOff, inputs, outputs, layers } (audioChoices); devices are
//                                       listed fresh each time (never opened); devicesOff when the host lists none
//                                       (started without devices). Device names are shown on this local page only.
//   POST /ui/api/audio {op: 'add', key, name?}       a new mixer sound from a key of the choices -> { ok, audio, saved }
//   POST /ui/api/audio {op: 'stream', id}            a mixer row (host mixer id) into the stream mix (the first track):
//                                       a sound with a project entry gets that track (as mixer.setTracks, D273); a
//                                       layer's sound without one gets a project entry bound to its layer -> { ok, saved }
//   POST /ui/api/audio {op: 'remove', audio}         the project audio source leaves the mixer -> { ok, removed, saved }
//   POST /ui/api/audio {op: 'filters', audio, filters}  AU2 strip tools (null = none), applied in place on air (the host
//                                       never rebuilds the source) -> { ok, audio, filters, saved }
//   GET  /ui/api/audio/tools            { ranges, order, refs, presets, filters: {audio id: filters}, sounds } for the Tools window
//                                       (presets: data/audio-tools/presets.json)
// AU1 choices also list apps (host audio.apps: exe names only, never window titles) and sound files / folders under
// the media base (listAudio; rel paths only, never an absolute path).
// Device names and endpoint ids are never logged.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProject, saveProject } from '../project/store.mjs';
import { addAudioSource, audioChoices, removeAudioSource, sameDeviceRows, setAudioFilters, streamTracks } from '../project/audio-sources.mjs';
import { FILTER_ORDER, FILTER_RANGES, FILTER_REFS } from '../project/audio-filters.mjs';
import { listAudio } from './assets.mjs';

export { sameDeviceRows };
import { loadDevicePresets, matchRoles } from '../project/device-roles.mjs';

export const AUDIO_ROUTES = Object.freeze(['/ui/api/audio/choices', '/ui/api/audio/tools', '/ui/api/audio']);
export const AUDIO_PRESETS_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'audio-tools', 'presets.json');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const KEYS = { add: ['key', 'name'], stream: ['id'], remove: ['audio'], filters: ['audio', 'filters'] };
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const MIXER_ID = /^(?:[A-Za-z0-9_.:-]{1,64}\/[A-Za-z0-9_.:-]{1,64}|audio:[A-Za-z0-9_.:-]{1,64})$/;

/** Plain words for a refusal code (the studio shows them as they are). */
export const AUDIO_ERROR_TEXT = Object.freeze({
  'no-project-file': 'No project file is open, so nothing can be saved.',
  'project-unreadable': 'The project file could not be read.',
  'host-unavailable': 'The studio host is not reachable.',
  'unknown-device': 'That device is not connected any more. Open Add audio again.',
  'unknown-sound': 'That sound is not in the mixer any more.',
  'already-added': 'That sound is in the mixer already.',
  'too-many-sounds': 'The mixer has the most sounds it can hold.',
  'too-many-devices': 'The project has the most devices it can hold.',
  'no-track': 'The project has no audio track.',
  'bad-key': 'Pick a sound from the list.',
  'unknown-app': 'That app is not running any more. Open Add audio again.',
  'ambiguous-app': 'Two different programs with this name are running, so Ujwalam cannot tell which one to capture. Close one, then try again.',
  'unknown-file': 'That sound file is not in your media folder any more. Open Add audio again.',
  'bad-tools': 'A tool setting is out of its range.',
  'bad-duck': 'Pick another sound of the mixer (a microphone, an app or a sound file) to duck under.',
  'in-stream': 'That sound is in the stream already.',
  'same-device': 'That device\'s sound is in the mix already through another channel; adding it twice would double it in the stream.',
  'bad-params': 'That request was not understood.',
  'not-saved': 'The project file could not be saved, so the change was undone. Nothing changed.',
  'not-saved-live': 'The project file could not be saved and the change could not be undone: it is live until Ujwalam restarts.',
  busy: 'The last mixer change is still on its way; try again in a moment.',
  invalid: 'The project would not be valid with that change.',
});

/**
 * opts: { host, json, projectSync, profileFile?, presetsDir, afterEdit?(), log? }
 */
export function createAudioRoutes(opts) {
  const { host, json } = opts;
  const log = opts.log ?? (() => {});
  const projectFile = () => opts.projectSync?.status?.().file;
  let busy = false;

  async function listDevices() {
    try { return await host.call('devices.list', {}); } catch { return null; }
  }
  async function mixerRows() {
    const m = await host.call('mixer.list', {});
    return Array.isArray(m?.sources) ? m.sources : [];
  }
  // The capture card's audio input (role game-audio, D221/D222): the Game channel whose CUE is heard at once.
  function recommendedEntry(list) {
    if (!list) return null;
    try {
      let overrides = {};
      if (opts.profileFile && existsSync(opts.profileFile)) overrides = JSON.parse(readFileSync(opts.profileFile, 'utf8'))?.devices?.roles ?? {};
      const presets = opts.presetsDir && existsSync(opts.presetsDir) ? loadDevicePresets(opts.presetsDir) : [];
      return matchRoles({ list, presets, overrides, roles: ['game-audio'] }).bound['game-audio']?.entry ?? null;
    } catch { return null; }
  }
  function readDoc() {
    const file = projectFile();
    if (typeof file !== 'string') return { error: 'no-project-file' };
    opts.projectSync.reload(); // pending mixer edits are written first; the cached document is re-read afterwards
    try { return { file, doc: loadProject(file).project }; } catch { return { error: 'project-unreadable' }; }
  }
  const kindOf = (a) => (a.device ? 'device' : a.app ? 'app' : a.playback ? 'playback' : 'layer');
  const refuse = (res, code, status = 409, detail) => json(res, status, { error: code, text: AUDIO_ERROR_TEXT[code] ?? code, ...(detail ? { detail } : {}) });

  async function listApps() {
    try { const r = await host.call('audio.apps', {}); return Array.isArray(r?.apps) ? r.apps : []; } catch { return []; }
  }
  const audioFiles = () => listAudio(opts.assetsDir ?? null);

  async function choices(res) {
    const r = readDoc();
    if (r.error) return json(res, 200, { available: false, error: r.error });
    let mixer;
    try { mixer = await mixerRows(); } catch { return json(res, 200, { available: false, error: 'host-unavailable' }); }
    const list = await listDevices();
    const c = audioChoices({ doc: r.doc, list, mixer, recommended: recommendedEntry(list), apps: await listApps(), audio: audioFiles() });
    return json(res, 200, { available: true, devicesOff: !list, mediaFolder: typeof opts.assetsDir === 'string', ...c });
  }

  function tools(res) {
    let presets = [];
    try { presets = JSON.parse(readFileSync(opts.presetsFile ?? AUDIO_PRESETS_FILE, 'utf8')).presets ?? []; } catch { /* no presets: the tools still work */ }
    // the saved tools of every project sound, by audio id (a strip without tools is absent)
    const r = readDoc();
    const filters = {};
    for (const a of r.doc?.audio?.sources ?? []) if (a.filters) filters[a.id] = a.filters;
    // AU3: the sounds a strip can duck under (not a layer's sound), microphones first: [{id, name, mic}]
    const devKind = new Map((r.doc?.devices ?? []).map((d) => [d.id, d.kind]));
    const sounds = (r.doc?.audio?.sources ?? []).filter((a) => !a.layer)
      .map((a) => ({ id: a.id, name: a.name || a.id, mic: devKind.get(a.device) === 'microphone' }))
      .sort((x, y) => Number(y.mic) - Number(x.mic));
    return json(res, 200, { order: FILTER_ORDER, ranges: FILTER_RANGES, refs: FILTER_REFS, presets, filters, sounds });
  }

  // Host first, then the file: a refusal there saves nothing. A failed save undoes the host change (undo: the opposite
  // host call with the unchanged document), so the host never holds a sound the file does not: a retry would otherwise
  // add a second id for the same device and the stream would hear it twice.
  async function commit(res, file, project, call, undo, answer, done) {
    let out;
    try { out = await call(); } catch (e) {
      return json(res, 502, { error: 'host-error', detail: String(e?.message ?? e?.code ?? 'error').slice(0, 200) });
    }
    try { saveProject(file, project); } catch {
      let undone = true;
      try { await undo(); } catch { undone = false; }
      opts.projectSync.reload();
      opts.afterEdit?.();
      return refuse(res, undone ? 'not-saved' : 'not-saved-live', 500);
    }
    opts.projectSync.reload();
    log(done);
    opts.afterEdit?.();
    return json(res, 200, { ok: true, ...answer(out), saved: true });
  }

  async function edit(res, body) {
    if (!isPlain(body) || typeof body.op !== 'string' || !Object.hasOwn(KEYS, body.op) || Object.keys(body).some((k) => k !== 'op' && !KEYS[body.op].includes(k))) return refuse(res, 'bad-params', 400);
    if (body.op === 'add' && (typeof body.key !== 'string' || body.key.length > 600 || (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)))) return refuse(res, 'bad-params', 400);
    if (body.op === 'stream' && (typeof body.id !== 'string' || !MIXER_ID.test(body.id))) return refuse(res, 'bad-params', 400);
    if (body.op === 'remove' && (typeof body.audio !== 'string' || !ID.test(body.audio))) return refuse(res, 'bad-params', 400);
    if (body.op === 'filters' && (typeof body.audio !== 'string' || !ID.test(body.audio) || !(body.filters === null || isPlain(body.filters)))) return refuse(res, 'bad-params', 400);
    const r = readDoc();
    if (r.error) return refuse(res, r.error);
    const { file, doc } = r;
    let mixer;
    try { mixer = await mixerRows(); } catch { return refuse(res, 'host-unavailable'); }

    if (body.op === 'remove') {
      const x = removeAudioSource(doc, { audio: body.audio });
      if (x.error) return refuse(res, x.error, 409, x.errors?.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300));
      return commit(res, file, x.project, () => host.call('audio.removeFromProject', { project: x.project, audio: body.audio }),
        () => host.call('audio.addFromProject', { project: doc, audio: body.audio }),
        (out) => ({ op: 'remove', audio: body.audio, removed: out?.removed === true }), `[studio-ui] mixer: sound removed (${x.removed.device ? 'device' : 'layer'})`);
    }

    if (body.op === 'filters') {
      const x = setAudioFilters(doc, { audio: body.audio, filters: body.filters });
      if (x.error) return refuse(res, x.error, x.error === 'bad-tools' || x.error === 'bad-duck' ? 400 : 409, x.errors?.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300));
      return commit(res, file, x.project, () => host.call('audio.setFilters', { project: x.project, audio: body.audio }),
        () => host.call('audio.setFilters', { project: doc, audio: body.audio }),
        (out) => ({ op: 'filters', audio: body.audio, filters: x.audio.filters ?? null, live: out?.filters ?? null, duck: out?.duck ?? null }), '[studio-ui] mixer: tools changed');
    }

    if (body.op === 'stream') {
      const row = mixer.find((m) => m.id === body.id);
      if (!row) return refuse(res, 'unknown-sound');
      if (typeof row.audioSource === 'string') {
        const tracks = streamTracks(doc, row.audioSource);
        if (!tracks) return refuse(res, 'unknown-sound');
        if (tracks.length === (row.tracks ?? []).length && tracks.every((t) => row.tracks.includes(t))) return refuse(res, 'in-stream');
        let out;
        try { out = await host.call('mixer.setTracks', { id: body.id, tracks }); } catch (e) {
          return json(res, 502, { error: 'host-error', detail: String(e?.message ?? e?.code ?? 'error').slice(0, 200) });
        }
        // Saved like the mixer's track buttons (project-sync, D273): keyed by the project audio source the host resolved.
        const saved = opts.projectSync.record('mixer.setTracks', { audioSource: out?.audioSource, tracks: out?.tracks, monitoring: out?.monitoring });
        opts.afterEdit?.();
        return json(res, 200, { ok: true, op: 'stream', audio: row.audioSource, saved: saved ? 'pending' : false });
      }
      if (typeof row.layer !== 'string') return refuse(res, 'unknown-sound');
      body = { op: 'add', key: `layer|${row.layer}` };
    }

    const list = body.key.startsWith('layer|') ? null : await listDevices();
    const row = body.key.startsWith('layer|') ? mixer.find((m) => m.layer === body.key.slice(6) && typeof m.audioSource !== 'string') : null;
    const kind0 = body.key.slice(0, body.key.indexOf('|'));
    const x = addAudioSource(doc, { key: body.key, list, mixer, name: body.name, volumeDb: row?.volumeDb, muted: row?.muted,
      apps: kind0 === 'app' ? await listApps() : null, audio: kind0 === 'file' || kind0 === 'folder' ? audioFiles() : null });
    if (x.error === 'same-device') return json(res, 409, { error: x.error, text: `That device's sound is in the mix already as ${String(x.as).slice(0, 120)}; adding it twice would double it in the stream.` });
    if (x.error) return refuse(res, x.error, 409, x.errors?.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300));
    return commit(res, file, x.project, () => host.call('audio.addFromProject', { project: x.project, audio: x.audio.id }),
      () => host.call('audio.removeFromProject', { project: doc, audio: x.audio.id }),
      (out) => ({ op: 'add', audio: { id: x.audio.id, name: x.audio.name, kind: kindOf(x.audio), cueDelayed: out?.cueDelayed === true },
        // B7: maybe the same card as a sound in the mix (another card of the same model is possible): added, with a warning
        ...(x.maybeSameAs ? { warning: `This may be the same device as ${x.maybeSameAs}, which is in the mix already. If you hear it twice, remove one.` } : {}) }),
      `[studio-ui] mixer: sound added (${kindOf(x.audio)})`);
  }

  return {
    /** true when the route was handled. */
    async handle(method, route, body, res) {
      if (method === 'GET' && route === '/ui/api/audio/choices') { await choices(res); return true; }
      if (method === 'GET' && route === '/ui/api/audio/tools') { tools(res); return true; }
      if (method === 'POST' && route === '/ui/api/audio') {
        if (busy) { refuse(res, 'busy'); return true; }
        busy = true;
        try { await edit(res, body); } finally { busy = false; }
        return true;
      }
      return false;
    },
  };
}

export const DEFAULT_PRESETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'registry', 'presets');
