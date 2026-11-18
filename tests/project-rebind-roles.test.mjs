// SPDX-License-Identifier: GPL-3.0-or-later
// Late device binding (user bug report 2026-11-18, A1): an alpha project built while the capture card and the camera were
// not connected has transparent placeholders for them; once they are listed, rebindPlaceholders turns those placeholders
// back into the capture layers (same ids, same placements, the preset's crop and effects) and changes nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject } from '../services/project/index.mjs';
import { loadDevicePresets, matchRoles } from '../services/project/device-roles.mjs';
import { placeholderRoles, rebindPlaceholders } from '../services/project/rebind-roles.mjs';
import { buildAlphaProject, upgradePresets } from '../services/studio-ui/alpha.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS_DIR = path.join(REPO, 'registry', 'presets');
const FIX = path.join(REPO, 'tests', 'fixtures', 'project');
const LIST = JSON.parse(readFileSync(path.join(FIX, 'devices-list.fixture.json'), 'utf8'));
const PROFILE = JSON.parse(readFileSync(path.join(FIX, 'profile.fixture.json'), 'utf8'));
const PRESETS = upgradePresets(PRESETS_DIR);
const DEVICE_PRESETS = loadDevicePresets(PRESETS_DIR);
const bindings = (list = LIST) => matchRoles({ list, presets: DEVICE_PRESETS });
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const byOrigin = (layers, id) => layers.find((l) => l.origin?.id === id);
let n = 0;
const idFn = (p) => `${p}-${++n}`;

const noDevices = () => buildAlphaProject({ presetsDir: PRESETS_DIR, profile: PROFILE, bindings: { bound: {}, unavailable: [] }, devicesListed: true, idFn }).project;

test('placeholderRoles: a project built without devices has game-capture and facecam placeholders on H and V', () => {
  const doc = noDevices();
  const roles = placeholderRoles(doc, PRESETS);
  assert.deepEqual(roles.map((r) => r.role), ['game-capture', 'facecam']);
  const game = roles.find((r) => r.role === 'game-capture').layers;
  assert.ok(game.some((x) => x.kind === 'capture' && x.canvas === 'h'));
  assert.ok(game.some((x) => x.kind === 'capture' && x.canvas === 'v'));
  assert.ok(game.some((x) => x.kind === 'duplicate'), 'the blurred backdrop copies the game');
  // a project built with devices has none
  const withDevices = buildAlphaProject({ presetsDir: PRESETS_DIR, profile: PROFILE, bindings: bindings(), devicesListed: true, idFn }).project;
  assert.deepEqual(placeholderRoles(withDevices, PRESETS), []);
});

test('rebind: placeholders become the capture layers in place; other layers, scenes, audio and outputs unchanged', () => {
  const doc = noDevices();
  const frozen = JSON.stringify(doc);
  const r = rebindPlaceholders(doc, { presets: PRESETS, bindings: bindings(), idFn });
  assert.equal(JSON.stringify(doc), frozen, 'input not mutated');
  assert.equal(r.unchanged, false);
  assert.ok(validateProject(r.project).ok, JSON.stringify(validateProject(r.project).errors));
  const touched = new Set(r.rebound.flatMap((x) => x.layers));
  assert.deepEqual(r.rebound.map((x) => x.role), ['game-capture', 'facecam']);

  const before = doc.scenes[0].layers, after = r.project.scenes[0].layers;
  assert.deepEqual(after.map((l) => l.id), before.map((l) => l.id), 'same layers, same order, same ids');
  // every untouched layer is byte for byte the same; so are the other parts of the project
  assert.equal(hash(after.filter((l) => !touched.has(l.id))), hash(before.filter((l) => !touched.has(l.id))));
  for (const k of ['canvases', 'audio', 'overlays', 'outputs', 'activeScene', 'origin', 'name']) assert.equal(hash(r.project[k]), hash(doc[k]), k);
  assert.equal(hash(r.project.scenes.slice(1)), hash(doc.scenes.slice(1)), 'other scenes');
  assert.deepEqual(r.project.devices.slice(0, doc.devices.length), doc.devices, 'existing devices kept');

  // the H game layer is the capture; the V game and both backdrops copy it (one device open)
  const hGame = byOrigin(after, 'scene-default-h/game');
  const dev = r.project.devices.find((d) => d.id === hGame.source.device);
  assert.equal(hGame.type, 'capture');
  assert.equal(dev.kind, 'capture-card');
  for (const id of ['scene-default-v/game', 'scene-default-h/game-backdrop', 'scene-default-v/game-backdrop']) {
    const l = byOrigin(after, id);
    assert.equal(l.type, 'duplicate', id);
    assert.equal(l.source.layer, hGame.id, `${id} copies the H game layer`);
  }
  const cam = byOrigin(after, 'scene-default-h/facecam');
  assert.equal(cam.type, 'capture');
  assert.equal(byOrigin(after, 'scene-default-v/facecam').source.layer, cam.id);

  // same picture as a build with the devices connected: placements (with crop), names and effects match
  const ref = buildAlphaProject({ presetsDir: PRESETS_DIR, profile: PROFILE, bindings: bindings(), devicesListed: true, idFn }).project.scenes[0].layers;
  for (const l of after.filter((x) => touched.has(x.id))) {
    const want = byOrigin(ref, l.origin.id);
    assert.equal(l.type, want.type, l.origin.id);
    assert.deepEqual(l.placements, want.placements, `${l.origin.id} placements`);
    assert.deepEqual(l.effects, want.effects, `${l.origin.id} effects`);
    assert.equal(l.name, want.name);
  }
});

test('rebind: only the roles whose device is listed; a second run changes nothing', () => {
  const doc = noDevices();
  const camOnly = { ...LIST, devices: LIST.devices.filter((d) => !/live gamer/i.test(d.name)) };
  const r = rebindPlaceholders(doc, { presets: PRESETS, bindings: bindings(camOnly), idFn });
  assert.deepEqual(r.rebound.map((x) => x.role), ['facecam']);
  assert.equal(byOrigin(r.project.scenes[0].layers, 'scene-default-h/game').type, 'color', 'game stays a placeholder');
  assert.deepEqual(placeholderRoles(r.project, PRESETS).map((x) => x.role), ['game-capture']);
  const again = rebindPlaceholders(r.project, { presets: PRESETS, bindings: bindings(camOnly), idFn });
  assert.equal(again.unchanged, true);
  assert.equal(again.project, r.project);
  const none = rebindPlaceholders(doc, { presets: PRESETS, bindings: { bound: {} }, idFn });
  assert.equal(none.unchanged, true);
});

test('rebind: a placeholder the user changed is left alone; an existing device for the endpoint is reused', () => {
  const doc = noDevices();
  const L = doc.scenes[0].layers;
  byOrigin(L, 'scene-default-v/facecam').source.color = '#ff0000ff'; // the user coloured it in
  const b = bindings();
  const cam = b.bound.facecam.entry;
  doc.devices.push({ id: 'dev-mine', kind: 'camera', name: 'My cam', match: { name: cam.name, deviceId: cam.path } });
  const r = rebindPlaceholders(doc, { presets: PRESETS, bindings: b, idFn });
  const after = r.project.scenes[0].layers;
  assert.equal(byOrigin(after, 'scene-default-h/facecam').source.device, 'dev-mine');
  assert.equal(byOrigin(after, 'scene-default-v/facecam').type, 'color');
  assert.equal(byOrigin(after, 'scene-default-v/facecam').source.color, '#ff0000ff');
  assert.equal(r.project.devices.filter((d) => d.kind === 'camera').length, 1, 'no second camera device');
});
