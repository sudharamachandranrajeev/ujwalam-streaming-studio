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

/** One capture per endpoint: true when any device an audio source uses names this endpoint, whatever that device's id. */
function endpointInUse(doc, projectKind, entry) {
  const used = usedDevices(doc);
  return (doc.devices ?? []).some((d) => used.has(d.id) && (d.match?.deviceId
    ? lower(d.match.deviceId) === lower(entry.path)
    : d.kind === projectKind && typeof d.match?.name === 'string' && d.match.name === entry.name));
}

/** Mixer rows (host mixer.list sources) that are a layer's sound with no project audio entry. */
const freeLayerSounds = (mixer) => (Array.isArray(mixer) ? mixer : []).filter((m) => m && typeof m.layer === 'string' && typeof m.audioSource !== 'string');

// One physical device, two Windows names (B7, 2026-11-18): a capture card lists its picture as "<product>-Video" and its
// sound input as "<endpoint> (<product>-Audio)" (AVerMedia, seen 2026-11-06). Its game sound must be in the mix once: the
// capture layer's own sound OR the card's audio input. Only that "-Video" / "-Audio" pair counts as the same device; any
// other naming is never guessed (UNVERIFIED for other brands).
export function hardwareKey(name, kind) {
  let s = String(name ?? '').trim();
  // Windows numbers a second endpoint of the same product inside the brackets ("(2- <product>-Audio)"): the same product
  if (kind === 'audio') { const m = /\(([^()]+)\)\s*$/.exec(s); if (!m) return null; s = m[1].trim().replace(/^\d+-\s*/, ''); }
  const m = (kind === 'audio' ? /^(.{3,})-audio$/i : /^(.{3,})-video$/i).exec(s);
  return m ? m[1].trim().toLowerCase() : null;
}

/** Hardware keys whose pair is certain in this devices.list: exactly one video entry ("<product>-Video") and exactly one
 *  audio input ("(<product>-Audio)") carry it, so both are the one card. Two cards of one model (or no list) leave the
 *  pair unknown: never refused then, only a warning (Codex review 2026-11-18, P2). libobs and the host give no shared id
 *  (dshow path vs WASAPI endpoint id); a Windows container id would be the exact link (not read yet). */
export function pairedKeys(list) {
  return new Set(pairedInputs(list).keys());
}
/** pairedKeys -> the one listed audio input entry of that pair. */
function pairedInputs(list) {
  const v = new Map(), a = new Map();
  for (const e of entriesOf(list)) {
    const k = e.kind === 'video' ? hardwareKey(e.name, 'video') : e.kind === 'audio-input' ? hardwareKey(e.name, 'audio') : null;
    if (!k) continue;
    const m = e.kind === 'video' ? v : a;
    m.set(k, [...(m.get(k) ?? []), e]);
  }
  return new Map([...v].filter(([k, x]) => x.length === 1 && a.get(k)?.length === 1).map(([k]) => [k, a.get(k)[0]]));
}
/** The keys where the project sound in the mix (inputsInMix) is the listed input of a certain pair (Codex review round 2,
 *  P2): a saved input of card A while A is unplugged and an identical card B is listed is another device, so only a
 *  warning. A saved device with an endpoint id must name that endpoint; one with a name only binds to the one listed. */
function certainInputs(inputs, list) {
  const out = new Set();
  for (const [k, e] of pairedInputs(list)) {
    const s = inputs.get(k);
    if (s && (s.endpoint === null ? s.match === e.name : lower(s.endpoint) === lower(e.path))) out.add(k);
  }
  return out;
}

function layerOf(doc, id) {
  for (const s of doc.scenes ?? []) for (const l of s.layers ?? []) if (l.id === id) return l;
  return null;
}
/** The hardware key of the device behind layer `id` (a copy counts as its source layer), or null. */
function layerHardware(doc, id) {
  let l = layerOf(doc, id);
  if (l?.type === 'duplicate') l = layerOf(doc, l.source?.layer);
  if (l?.type !== 'capture') return null;
  const d = (doc.devices ?? []).find((x) => x.id === l.source?.device);
  return d ? hardwareKey(d.match?.name ?? d.name, 'video') : null;
}
/** hardware key -> { name, endpoint, match } of the project sound that already takes that device's audio input (WASAPI):
 *  its name, the saved endpoint id (null when the device matches by name only) and the matched name. */
function inputsInMix(doc) {
  const out = new Map();
  for (const a of doc.audio?.sources ?? []) {
    const d = typeof a.device === 'string' ? (doc.devices ?? []).find((x) => x.id === a.device) : null;
    const k = d && d.kind === 'microphone' ? hardwareKey(d.match?.name ?? d.name, 'audio') : null;
    if (k && !out.has(k)) out.set(k, { name: a.name, endpoint: typeof d.match?.deviceId === 'string' ? d.match.deviceId : null, match: d.match?.name ?? d.name });
  }
  return out;
}
/** hardware key -> the name of the project sound that takes a capture layer's own sound. */
function layersInMix(doc) {
  const out = new Map();
  const { out: bound } = boundLayers(doc);
  for (const id of bound) {
    const k = layerHardware(doc, id);
    if (!k || out.has(k)) continue;
    const a = (doc.audio?.sources ?? []).find((x) => x.layer === id || (x.device && layerOf(doc, id)?.source?.device === x.device)) ?? null;
    out.set(k, a?.name ?? 'the capture layer');
  }
  return out;
}

/** Mixer rows with `sameAs` (the project sound name) on a layer sound whose device's audio input is in the mix already,
 *  only for a pair that is certain in `list` (pairedKeys). The studio then shows that strip as "already in the mix as
 *  <name>" without an Add to stream button. */
export function sameDeviceRows(doc, rows, list) {
  if (!doc || !Array.isArray(rows)) return rows;
  const inputs = inputsInMix(doc);
  if (!inputs.size) return rows;
  const certain = certainInputs(inputs, list);
  return rows.map((m) => {
    if (!m || typeof m.layer !== 'string' || typeof m.audioSource === 'string') return m;
    const k = layerHardware(doc, m.layer);
    return k && certain.has(k) ? { ...m, sameAs: String(inputs.get(k).name).slice(0, 120) } : m;
  });
}

export function audioChoices({ doc, list, mixer, recommended = null } = {}) {
  const free = (kind) => entriesOf(list).filter((e) => e.kind === KIND_OF[kind] && !endpointInUse(doc, PROJECT_KIND[kind], e));
  const rec = recommended && typeof recommended.path === 'string' ? lower(recommended.path) : null;
  const { out: bound, real } = boundLayers(doc);
  const inputs = inputsInMix(doc), layers = layersInMix(doc), paired = pairedKeys(list), certain = certainInputs(inputs, list);
  // The same device's sound is in the mix already (B7): a certain pair is not offered (skipped, said why); a pair that
  // may be another card of the same model is offered with maybeSameAs (the studio may warn).
  const skipped = [];
  const maybe = new Map();
  const sameOk = (k, name, as, sure) => {
    if (!k || !as) return true;
    if (sure) { skipped.push({ name, as }); return false; }
    maybe.set(name, as);
    return true;
  };
  const inputOk = (e) => { const k = hardwareKey(e.name, 'audio'); return sameOk(k, e.name.slice(0, 120), layers.get(k), paired.has(k)); };
  const layerOk = (m) => { const k = layerHardware(doc, m.layer); return sameOk(k, String(m.name ?? m.layer).slice(0, 120), k ? inputs.get(k)?.name : undefined, certain.has(k)); };
  const warn = (name) => (maybe.has(name) ? { maybeSameAs: String(maybe.get(name)).slice(0, 120) } : {});
  return {
    inputs: free('input').filter(inputOk).map((e) => ({ key: `input|${e.path}`, name: e.name.slice(0, 120), recommended: rec !== null && lower(e.path) === rec, ...warn(e.name.slice(0, 120)) }))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended)),
    outputs: free('output').map((e) => ({ key: `output|${e.path}`, name: e.name.slice(0, 120) })),
    layers: freeLayerSounds(mixer).filter((m) => !bound.has(real(m.layer))).filter(layerOk).map((m) => {
      const name = String(m.name ?? m.layer).slice(0, 120);
      return { key: `layer|${m.layer}`, layer: m.layer, name, cueDelayed: m.cueDelayed === true, ...warn(name) };
    }),
    skipped,
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
  let maybeSameAs = null; // B7: the same model's sound is in the mix, but the pair is not certain (pairedKeys)
  const src = { id: newId('aud'), name: '', volumeDb: 0, muted: false, monitoring: 'off', tracks: [track], origin: { ...ORIGIN } };
  if (typeof volumeDb === 'number' && Number.isFinite(volumeDb)) src.volumeDb = Math.min(12, Math.max(-100, Math.round(volumeDb * 100) / 100));
  if (typeof muted === 'boolean') src.muted = muted;
  if (kind === 'layer') {
    const row = freeLayerSounds(mixer).find((m) => m.layer === ref);
    if (!row) return { error: 'unknown-sound' };
    const { out: bound, real } = boundLayers(doc);
    if (!doc.scenes.some((s) => s.layers.some((l) => l.id === ref))) return { error: 'unknown-sound' };
    if (bound.has(real(ref))) return { error: 'already-added' };
    const hw = layerHardware(doc, ref);
    const inMix = inputsInMix(doc);
    if (hw && inMix.has(hw)) {
      if (certainInputs(inMix, list).has(hw)) return { error: 'same-device', as: inMix.get(hw).name };
      maybeSameAs = inMix.get(hw).name; // maybe another card of the same model: allowed, with a warning
    }
    src.layer = ref;
    src.name = label(name) ?? label(row.name) ?? 'Sound';
  } else {
    const entry = entriesOf(list).find((e) => e.kind === KIND_OF[kind] && lower(e.path) === lower(ref));
    if (!entry) return { error: 'unknown-device' };
    if (endpointInUse(project, PROJECT_KIND[kind], entry)) return { error: 'already-added' };
    const hw = kind === 'input' ? hardwareKey(entry.name, 'audio') : null;
    if (hw && layersInMix(doc).has(hw)) {
      if (pairedKeys(list).has(hw)) return { error: 'same-device', as: layersInMix(doc).get(hw) };
      maybeSameAs = layersInMix(doc).get(hw);
    }
    let dev = deviceFor(project, PROJECT_KIND[kind], entry);
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
  return checked(project, { audio: src, ...(maybeSameAs ? { maybeSameAs: String(maybeSameAs).slice(0, 120) } : {}) });
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
