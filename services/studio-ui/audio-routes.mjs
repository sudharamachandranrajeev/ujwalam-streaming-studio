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
// Device names and endpoint ids are never logged.

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProject, saveProject } from '../project/store.mjs';
import { addAudioSource, audioChoices, removeAudioSource, sameDeviceRows, streamTracks } from '../project/audio-sources.mjs';

export { sameDeviceRows };
import { loadDevicePresets, matchRoles } from '../project/device-roles.mjs';

export const AUDIO_ROUTES = Object.freeze(['/ui/api/audio/choices', '/ui/api/audio']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const KEYS = { add: ['key', 'name'], stream: ['id'], remove: ['audio'] };
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
  const refuse = (res, code, status = 409, detail) => json(res, status, { error: code, text: AUDIO_ERROR_TEXT[code] ?? code, ...(detail ? { detail } : {}) });

  async function choices(res) {
    const r = readDoc();
    if (r.error) return json(res, 200, { available: false, error: r.error });
    let mixer;
    try { mixer = await mixerRows(); } catch { return json(res, 200, { available: false, error: 'host-unavailable' }); }
    const list = await listDevices();
    const c = audioChoices({ doc: r.doc, list, mixer, recommended: recommendedEntry(list) });
    return json(res, 200, { available: true, devicesOff: !list, ...c });
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
    const x = addAudioSource(doc, { key: body.key, list, mixer, name: body.name, volumeDb: row?.volumeDb, muted: row?.muted });
    if (x.error === 'same-device') return json(res, 409, { error: x.error, text: `That device's sound is in the mix already as ${String(x.as).slice(0, 120)}; adding it twice would double it in the stream.` });
    if (x.error) return refuse(res, x.error, 409, x.errors?.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300));
    return commit(res, file, x.project, () => host.call('audio.addFromProject', { project: x.project, audio: x.audio.id }),
      () => host.call('audio.removeFromProject', { project: doc, audio: x.audio.id }),
      (out) => ({ op: 'add', audio: { id: x.audio.id, name: x.audio.name, kind: x.audio.device ? 'device' : 'layer', cueDelayed: out?.cueDelayed === true },
        // B7: maybe the same card as a sound in the mix (another card of the same model is possible): added, with a warning
        ...(x.maybeSameAs ? { warning: `This may be the same device as ${x.maybeSameAs}, which is in the mix already. If you hear it twice, remove one.` } : {}) }),
      `[studio-ui] mixer: sound added (${x.audio.device ? 'device' : 'layer'})`);
  }

  return {
    /** true when the route was handled. */
    async handle(method, route, body, res) {
      if (method === 'GET' && route === '/ui/api/audio/choices') { await choices(res); return true; }
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
