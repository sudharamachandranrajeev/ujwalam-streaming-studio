// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer audio sources on a project document (D393 proposed, user feedback on alpha.33: "add option to add available
// audio channels"). Pure, like structure.mjs: each change returns { project, ... } (a changed copy, checked with
// validateProject) or { error } with a short code. The studio UI server applies it to the host
// (audio.addFromProject / audio.removeFromProject) and then saves the file.
//
//   audioChoices({ doc, list, mixer, recommended })  what "Add audio" offers:
//       inputs   WASAPI capture endpoints (mics, the capture card's audio input, line-in)  { key, name, recommended }
//       outputs  WASAPI render endpoints (desktop / app sound)                              { key, name }
//       layers   layer sounds the mixer meters but no project audio entry names            { key, name, layer, cueDelayed }
//     A device that a project audio source already uses is left out. `recommended` is the devices.list entry the
//     game-audio role matches (the capture card's audio input, D221/D222): its realtime CUE is not delayed.
//   addAudioSource(doc, { key, list, mixer, name?, volumeDb?, muted? }) -> { project, audio }
//       key "input|<endpoint>" / "output|<endpoint>": a device of kind microphone / audio-output (reused when the
//       project has one for that endpoint) and an audio source on it; "layer|<layer id>": an audio source bound to
//       that layer's sound. The new source goes to the stream mix (the first project track), CUE off (no echo).
//   removeAudioSource(doc, { audio }) -> { project, removed }  a device this module added and nothing else uses goes too.
//   streamTracks(doc, audioSource) -> track ids with the stream track added (the first project track), or null.
// Keys come from audioChoices and are checked against the same fresh device list and mixer: never a made-up device.

import { newId, validateProject } from './index.mjs';

const ORIGIN = Object.freeze({ importer: 'mixer', id: 'add-audio' });
const KIND_OF = { input: 'audio-input', output: 'audio-output' };
const PROJECT_KIND = { input: 'microphone', output: 'audio-output' };
const lower = (s) => String(s ?? '').toLowerCase();
const label = (v) => (typeof v === 'string' && v.trim().length >= 1 ? v.trim().slice(0, 120) : null);

function checked(project, extra) {
  const v = validateProject(project);
  return v.ok ? { project, ...extra } : { error: 'invalid', errors: v.errors.slice(0, 5) };
}

const entriesOf = (list) => (Array.isArray(list?.devices) ? list.devices : []).filter((e) => e && typeof e.path === 'string' && e.path && typeof e.name === 'string');

/** The project device of `kind` that names this endpoint (by deviceId, else by name when it has no deviceId). */
function deviceFor(doc, projectKind, entry) {
  return (doc.devices ?? []).find((d) => d.kind === projectKind && (d.match?.deviceId
    ? lower(d.match.deviceId) === lower(entry.path)
    : typeof d.match?.name === 'string' && d.match.name === entry.name)) ?? null;
}

/** Layer ids whose sound a project audio source already takes (as the host binds them: a copy is its source layer, a
 *  capture-card or camera device's audio is its capture layer). */
function boundLayers(doc) {
  const layers = doc.scenes.flatMap((s) => s.layers);
  const real = (id) => { const l = layers.find((x) => x.id === id); return l?.type === 'duplicate' ? l.source?.layer : id; };
  const videoDevs = new Set((doc.devices ?? []).filter((d) => d.kind === 'capture-card' || d.kind === 'camera').map((d) => d.id));
  const out = new Set();
  for (const a of doc.audio?.sources ?? []) {
    if (typeof a.layer === 'string') out.add(real(a.layer));
    else if (videoDevs.has(a.device)) for (const l of layers) if (l.type === 'capture' && l.source?.device === a.device) out.add(l.id);
  }
  return { out, real };
}

const usedDevices = (doc) => new Set((doc.audio?.sources ?? []).map((a) => a.device).filter(Boolean));

/** Mixer rows (host mixer.list sources) that are a layer's sound with no project audio entry. */
const freeLayerSounds = (mixer) => (Array.isArray(mixer) ? mixer : []).filter((m) => m && typeof m.layer === 'string' && typeof m.audioSource !== 'string');

export function audioChoices({ doc, list, mixer, recommended = null } = {}) {
  const used = usedDevices(doc);
  const free = (kind) => entriesOf(list).filter((e) => e.kind === KIND_OF[kind]).filter((e) => {
    const d = deviceFor(doc, PROJECT_KIND[kind], e);
    return !d || !used.has(d.id);
  });
  const rec = recommended && typeof recommended.path === 'string' ? lower(recommended.path) : null;
  const { out: bound, real } = boundLayers(doc);
  return {
    inputs: free('input').map((e) => ({ key: `input|${e.path}`, name: e.name.slice(0, 120), recommended: rec !== null && lower(e.path) === rec }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended)),
    outputs: free('output').map((e) => ({ key: `output|${e.path}`, name: e.name.slice(0, 120) })),
    layers: freeLayerSounds(mixer).filter((m) => !bound.has(real(m.layer))).map((m) => ({ key: `layer|${m.layer}`, layer: m.layer, name: String(m.name ?? m.layer).slice(0, 120), cueDelayed: m.cueDelayed === true })),
  };
}

export function addAudioSource(doc, { key, list, mixer, name, volumeDb, muted } = {}) {
  if (typeof key !== 'string') return { error: 'bad-key' };
  const bar = key.indexOf('|');
  const kind = bar > 0 ? key.slice(0, bar) : '';
  const ref = bar > 0 ? key.slice(bar + 1) : '';
  if (!ref || !['input', 'output', 'layer'].includes(kind)) return { error: 'bad-key' };
  if ((doc.audio?.sources ?? []).length >= 256) return { error: 'too-many-sounds' };
  const track = doc.audio?.tracks?.[0]?.id;
  if (!track) return { error: 'no-track' };
  const project = structuredClone(doc);
  const src = { id: newId('aud'), name: '', volumeDb: 0, muted: false, monitoring: 'off', tracks: [track], origin: { ...ORIGIN } };
  if (typeof volumeDb === 'number' && Number.isFinite(volumeDb)) src.volumeDb = Math.min(12, Math.max(-100, Math.round(volumeDb * 100) / 100));
  if (typeof muted === 'boolean') src.muted = muted;
  if (kind === 'layer') {
    const row = freeLayerSounds(mixer).find((m) => m.layer === ref);
    if (!row) return { error: 'unknown-sound' };
    const { out: bound, real } = boundLayers(doc);
    if (!doc.scenes.some((s) => s.layers.some((l) => l.id === ref))) return { error: 'unknown-sound' };
    if (bound.has(real(ref))) return { error: 'already-added' };
    src.layer = ref;
    src.name = label(name) ?? label(row.name) ?? 'Sound';
  } else {
    const entry = entriesOf(list).find((e) => e.kind === KIND_OF[kind] && lower(e.path) === lower(ref));
    if (!entry) return { error: 'unknown-device' };
    let dev = deviceFor(project, PROJECT_KIND[kind], entry);
    if (dev && usedDevices(project).has(dev.id)) return { error: 'already-added' };
    if (!dev) {
      if ((project.devices ?? []).length >= 64) return { error: 'too-many-devices' };
      dev = { id: newId('dev'), kind: PROJECT_KIND[kind], name: entry.name.slice(0, 120) || 'Audio device', match: { name: entry.name.slice(0, 256) }, origin: { ...ORIGIN } };
      if (entry.path.length <= 512) dev.match.deviceId = entry.path;
      (project.devices ??= []).push(dev);
    }
    src.device = dev.id;
    src.name = label(name) ?? dev.name;
  }
  project.audio.sources.push(src);
  return checked(project, { audio: src });
}

export function removeAudioSource(doc, { audio } = {}) {
  const src = (doc.audio?.sources ?? []).find((a) => a.id === audio);
  if (!src) return { error: 'unknown-sound' };
  const project = structuredClone(doc);
  project.audio.sources = project.audio.sources.filter((a) => a.id !== audio);
  // The device this mixer added for it goes too when nothing else uses it (a layer or another sound).
  if (src.device) {
    const dev = (project.devices ?? []).find((d) => d.id === src.device);
    const inUse = project.audio.sources.some((a) => a.device === src.device) ||
      project.scenes.some((s) => s.layers.some((l) => l.source?.device === src.device));
    if (dev && !inUse && dev.origin?.importer === ORIGIN.importer) project.devices = project.devices.filter((d) => d.id !== dev.id);
  }
  return checked(project, { removed: src });
}

export function streamTracks(doc, audioSource) {
  const src = (doc.audio?.sources ?? []).find((a) => a.id === audioSource);
  const ids = (doc.audio?.tracks ?? []).map((t) => t.id);
  if (!src || !ids.length) return null;
  const want = new Set([...(src.tracks ?? []), ids[0]]);
  return ids.filter((t) => want.has(t));
}
