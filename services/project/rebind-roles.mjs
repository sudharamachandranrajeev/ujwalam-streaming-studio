// SPDX-License-Identifier: GPL-3.0-or-later
// Late device binding for scene preset placeholders (user bug report 2026-11-18: "if a layer is not detected at start it
// fails to detect afterwards"). A preset capture role (game-capture, facecam) that had no device when the scene was built
// is a transparent colour layer (scene-preset.mjs, D112): nothing could ever turn it into the capture again. This module
// does that once the role's device is listed. Pure: no device is listed or opened here; the caller lists and matches
// (device-roles.mjs matchRoles) and applies the result to the host and the file.
//
//   placeholderRoles(doc, presets) -> [{ role, layers: [{ scene, layer, key, presetId, kind: 'capture' | 'duplicate' }] }]
//     The transparent placeholders a preset capture role left, found by their origin ({importer: 'preset',
//     id: '<preset id>/<layer key>'}) and the preset's own layer list. A layer the user changed (another type or colour)
//     is not a placeholder any more and is never touched.
//   rebindPlaceholders(doc, { presets, bindings, flags, idFn }) -> { project, rebound: [{ role, device, layers }], unchanged }
//     For every role with placeholders and a bound device (bindings = matchRoles(...)): a project device for it (an
//     existing device of a fitting kind that names the same endpoint is reused), then each placeholder is replaced IN
//     PLACE: same id, name, placements (only the preset's crop is put back), position in its scene and origin. The first
//     one becomes the capture layer (an existing capture layer of that device wins), every other one a `duplicate` of
//     it (one device is opened once, D60). The preset's effects come back as the preset builds them (flag rules of
//     loadScenePreset). Nothing else in the document changes: other layers, scenes, audio, outputs are copied as they are.
//     Audio is not added here: the mixer's Add audio adds a mic or the card's audio input, and a capture layer's own sound
//     is metered (and can be added to the stream) as soon as the layer is built.

import { newId, validateProject } from './index.mjs';
import { ROLES } from './device-roles.mjs';

export const VIDEO_ROLES = Object.freeze(['game-capture', 'facecam']);
const TRANSPARENT = '#00000000';
const lower = (s) => String(s ?? '').toLowerCase();

const isPlaceholder = (l) => l && l.type === 'color' && lower(l.source?.color) === lower(TRANSPARENT) && l.origin?.importer === 'preset' && typeof l.origin.id === 'string';

function presetLayer(presets, originId) {
  const slash = originId.lastIndexOf('/');
  if (slash <= 0) return null;
  const preset = presets?.[originId.slice(0, slash)];
  const key = originId.slice(slash + 1);
  const pl = preset?.params?.layers?.find((x) => x.key === key);
  return pl ? { preset, pl, key, presetId: preset.id ?? originId.slice(0, slash) } : null;
}

export function placeholderRoles(doc, presets) {
  const byRole = new Map();
  for (const s of doc?.scenes ?? []) {
    for (const l of s.layers ?? []) {
      if (!isPlaceholder(l)) continue;
      const hit = presetLayer(presets, l.origin.id);
      if (!hit) continue;
      let role = null, kind = null;
      if (hit.pl.type === 'capture' && VIDEO_ROLES.includes(hit.pl.role)) { role = hit.pl.role; kind = 'capture'; }
      else if (hit.pl.type === 'duplicate') {
        const target = hit.preset.params.layers.find((x) => x.key === hit.pl.of);
        if (target?.type === 'capture' && VIDEO_ROLES.includes(target.role)) { role = target.role; kind = 'duplicate'; }
      }
      if (!role) continue;
      if (!byRole.has(role)) byRole.set(role, []);
      byRole.get(role).push({ scene: s.id, layer: l.id, key: hit.key, presetId: hit.presetId, canvas: hit.preset.params.canvas, kind });
    }
  }
  return VIDEO_ROLES.filter((r) => byRole.has(r)).map((role) => ({ role, layers: byRole.get(role) }));
}

/** The project device that names this devices.list entry (a fitting kind; by deviceId, else by name). */
function deviceFor(doc, role, entry) {
  const kinds = ROLES[role].projectKinds;
  return (doc.devices ?? []).find((d) => kinds.includes(d.kind) && (d.match?.deviceId
    ? lower(d.match.deviceId) === lower(entry.path) || (entry.obsId && lower(d.match.deviceId) === lower(entry.obsId))
    : typeof d.match?.name === 'string' && d.match.name === entry.name)) ?? null;
}

export function rebindPlaceholders(doc, { presets = {}, bindings = { bound: {} }, flags = {}, idFn = newId } = {}) {
  const roles = placeholderRoles(doc, presets).filter((r) => bindings?.bound?.[r.role]);
  if (!roles.length) return { project: doc, rebound: [], unchanged: true };
  const project = structuredClone(doc);
  const used = new Set();
  for (const s of project.scenes) for (const l of s.layers) used.add(l.id);
  for (const d of project.devices ?? []) used.add(d.id);
  const fresh = (prefix) => { let id; do { id = idFn(prefix); } while (used.has(id)); used.add(id); return id; };
  const find = (sid, lid) => project.scenes.find((s) => s.id === sid)?.layers.find((l) => l.id === lid);
  const rebound = [];

  for (const { role, layers } of roles) {
    const b = bindings.bound[role];
    let dev = deviceFor(project, role, b.entry);
    if (!dev) {
      if ((project.devices ?? []).length >= 64) continue;
      const match = { name: String(b.entry.name).slice(0, 256) };
      if (b.entry.path && String(b.entry.path).length <= 512) match.deviceId = b.entry.path;
      dev = { id: fresh('dev'), kind: b.projectKind, name: String(b.entry.name || role).slice(0, 120), match, origin: { importer: 'alpha', id: `role/${role}` } };
      if (b.format) dev.format = { ...b.format };
      (project.devices ??= []).push(dev);
    }
    // the layer every other one shows: an existing capture layer of this device, else the first capture placeholder
    // (a main-canvas one first: the V picture copies the H one, as mergeCanvasScenes builds it)
    const existing = project.scenes.flatMap((s) => s.layers).find((l) => l.type === 'capture' && l.source?.device === dev.id);
    const captures = layers.filter((x) => x.kind === 'capture').sort((a, c) => (a.canvas === 'h' ? 0 : 1) - (c.canvas === 'h' ? 0 : 1));
    const real = existing ? null : captures[0] ?? null;
    if (!existing && !real) continue; // only copies of a capture layer that is not a placeholder of this role: leave them
    const realId = existing ? existing.id : real.layer;
    const changed = [];
    for (const x of layers) {
      const l = find(x.scene, x.layer);
      const hit = presetLayer(presets, l.origin.id);
      if (real && x.layer === real.layer) { l.type = 'capture'; l.source = { device: dev.id }; }
      else { l.type = 'duplicate'; l.source = { layer: realId }; }
      // the preset's crop (a placeholder has none) on the canvas this preset placed it on
      if (hit.pl.crop && l.placements?.[hit.preset.params.canvas]) l.placements[hit.preset.params.canvas].crop = { ...hit.pl.crop };
      const effectsOn = [hit.pl.flag, hit.pl.effectsFlag].every((f) => !f || flags[f] === true);
      if (Array.isArray(hit.pl.effects) && hit.pl.effects.length && effectsOn && !l.effects) l.effects = structuredClone(hit.pl.effects);
      changed.push(x.layer);
    }
    rebound.push({ role, device: dev.id, real: realId, layers: changed });
  }
  if (!rebound.length) return { project: doc, rebound: [], unchanged: true };
  const v = validateProject(project);
  if (!v.ok) return { error: 'invalid', errors: v.errors.slice(0, 5) };
  return { project, rebound, unchanged: false };
}
