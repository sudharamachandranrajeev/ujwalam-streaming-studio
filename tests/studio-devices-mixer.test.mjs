// SPDX-License-Identifier: GPL-3.0-or-later
// Devices and mixer fixes (user bug report 2026-11-18): the game sound is in the mix once (B7: a capture card's own
// layer sound and its audio input are one device), and the UI server's device routes (A1 Connect: preset placeholders
// become the capture layers in place; A3 Try again: host devices.rescan). Device names here are placeholders.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { addAudioSource, audioChoices, hardwareKey, sameDeviceRows } from '../services/project/audio-sources.mjs';
import { placeholderRoles } from '../services/project/rebind-roles.mjs';
import { buildAlphaProject, upgradePresets } from '../services/studio-ui/alpha.mjs';
import { createDeviceRoutes } from '../services/studio-ui/device-routes.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESETS_DIR = path.join(REPO, 'registry', 'presets');
const FIX = path.join(REPO, 'tests', 'fixtures', 'project');
const DEV_LIST = JSON.parse(readFileSync(path.join(FIX, 'devices-list.fixture.json'), 'utf8'));
const PROFILE = JSON.parse(readFileSync(path.join(FIX, 'profile.fixture.json'), 'utf8'));

// ---- B7: one device, two Windows names
const LIST = { devices: [
  { kind: 'audio-input', name: 'HDMI/Line In (Card X-Audio)', path: '{in-card}', obsId: '{in-card}' },
  { kind: 'audio-input', name: 'Microphone (Other Mic)', path: '{in-mic}', obsId: '{in-mic}' },
  { kind: 'video', name: 'Card X-Video', path: '\\\\?\\usb#cardx', obsId: 'x' },
] };
function cardDoc() {
  const doc = createProject({ name: 'T', fps: 30 });
  doc.devices = [{ id: 'card', kind: 'capture-card', name: 'Card', match: { name: 'Card X-Video' } }];
  const pl = { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } };
  doc.scenes[0].layers.push({ id: 'game', type: 'capture', name: 'Game capture', source: { device: 'card' }, placements: pl },
    { id: 'game-copy', type: 'duplicate', name: 'Backdrop', source: { layer: 'game' }, placements: structuredClone(pl) });
  assert.ok(validateProject(doc).ok, JSON.stringify(validateProject(doc).errors));
  return doc;
}
const rows = (doc) => [{ id: `${doc.scenes[0].id}/game`, layer: 'game', name: 'Game capture', mixers: 0, tracks: [] }];

test('hardwareKey: only the "-Video" / "-Audio" pair of one product counts; other names are never guessed', () => {
  assert.equal(hardwareKey('Card X-Video', 'video'), 'card x');
  assert.equal(hardwareKey('HDMI/Line In (Card X-Audio)', 'audio'), 'card x');
  assert.equal(hardwareKey('Card X', 'video'), null);
  assert.equal(hardwareKey('Microphone (Other Mic)', 'audio'), null);
  assert.equal(hardwareKey('Card X-Audio', 'audio'), null, 'an input name without the endpoint brackets');
});

test('B7: with the card audio input in the mix, the capture layer sound is not offered and cannot be added; a mixer row says why', () => {
  const doc = cardDoc();
  const a = addAudioSource(doc, { key: 'input|{in-card}', list: LIST });
  assert.ok(a.project, JSON.stringify(a));
  const c = audioChoices({ doc: a.project, list: LIST, mixer: rows(doc) });
  assert.deepEqual(c.layers, [], 'the layer sound is not offered');
  assert.deepEqual(c.skipped, [{ name: 'Game capture', as: a.audio.name }]);
  const x = addAudioSource(a.project, { key: 'layer|game', mixer: rows(doc) });
  assert.deepEqual([x.error, x.as], ['same-device', a.audio.name]);
  const r = sameDeviceRows(a.project, rows(doc));
  assert.equal(r[0].sameAs, a.audio.name);
  // a copy of the capture layer counts as the capture layer
  const copyRow = [{ id: `${doc.scenes[0].id}/game-copy`, layer: 'game-copy', name: 'Backdrop', mixers: 0, tracks: [] }];
  assert.equal(sameDeviceRows(a.project, copyRow)[0].sameAs, a.audio.name);
  // another input is unaffected
  assert.ok(audioChoices({ doc: a.project, list: LIST, mixer: [] }).inputs.some((i) => i.key === 'input|{in-mic}'));
});

test('B7: with the capture layer sound in the mix, the card audio input is not offered and cannot be added', () => {
  const doc = cardDoc();
  const a = addAudioSource(doc, { key: 'layer|game', mixer: rows(doc) });
  assert.ok(a.project, JSON.stringify(a));
  const c = audioChoices({ doc: a.project, list: LIST, mixer: rows(doc) });
  assert.deepEqual(c.inputs.map((i) => i.key), ['input|{in-mic}']);
  assert.equal(c.skipped.length, 1);
  assert.equal(addAudioSource(a.project, { key: 'input|{in-card}', list: LIST }).error, 'same-device');
  assert.equal(addAudioSource(doc, { key: 'input|{in-card}', list: LIST }).error, undefined, 'nothing in the mix yet: allowed');
  assert.deepEqual(sameDeviceRows(doc, rows(doc)), rows(doc), 'no input in the mix: rows unchanged');
});

// ---- A1 / A3: the device routes
function harness({ list = DEV_LIST, refuse = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-devroutes-'));
  const file = path.join(dir, 'p.project.json');
  let n = 0;
  const doc = buildAlphaProject({ presetsDir: PRESETS_DIR, profile: PROFILE, bindings: { bound: {}, unavailable: [] }, devicesListed: true, idFn: (p) => `${p}-${++n}` }).project;
  saveProject(file, doc);
  const calls = [];
  const host = { call: async (m, p) => {
    if (m === 'devices.list') { if (!list) throw new Error('devices are disabled'); return list; }
    calls.push([m, p.scene ?? null, p.layer ?? null]);
    if (refuse && m === refuse.method && (refuse.layer === undefined || refuse.layer === p.layer)) throw new Error('refused');
    if (m === 'devices.rescan') { if (!list) throw new Error('devices are disabled'); return { retried: 1, audio: 0, media: 0 }; }
    return { ok: true };
  } };
  const out = {};
  const json = (res, status, body) => { res.status = status; res.body = body; };
  let edits = 0;
  const routes = createDeviceRoutes({ host, json, projectSync: { status: () => ({ file }), reload() {} }, presetsDir: PRESETS_DIR, afterEdit: () => { edits++; } });
  const post = async (route, body) => { const res = {}; assert.equal(await routes.handle('POST', route, body, res), true); return res; };
  return { file, doc, calls, routes, post, out, disk: () => JSON.parse(readFileSync(file, 'utf8')), edits: () => edits };
}

test('device routes: connectable lists the placeholder roles whose device is listed (ids only); none when devices are off', async () => {
  const h = harness();
  assert.deepEqual(h.routes.connectable(), []);
  await h.routes.refresh();
  const c = h.routes.connectable();
  assert.deepEqual(c.map((x) => x.role), ['game-capture', 'facecam']);
  assert.ok(c.every((x) => x.layers.length && x.layers.every((id) => typeof id === 'string')));
  assert.ok(!JSON.stringify(c).includes('name'), 'no device names');
  const off = harness({ list: null });
  await off.routes.refresh();
  assert.deepEqual(off.routes.connectable(), []);
});

test('device routes: Connect replaces the placeholders on the host and in the file (real layer before its copies), nothing else', async () => {
  const h = harness();
  const P = upgradePresets(PRESETS_DIR);
  const before = placeholderRoles(h.doc, P).find((x) => x.role === 'facecam');
  const r = await h.post('/ui/api/devices/connect', { role: 'facecam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.connected.map((x) => x.role), ['facecam']);
  const ids = before.layers.map((l) => l.layer);
  const removes = h.calls.filter((c) => c[0] === 'layers.remove').map((c) => c[2]);
  const adds = h.calls.filter((c) => c[0] === 'layers.addFromProject').map((c) => c[2]);
  assert.deepEqual(removes.sort(), [...ids].sort());
  assert.deepEqual([...adds].sort(), [...ids].sort());
  const disk = h.disk();
  const layer = (id) => disk.scenes.flatMap((s) => s.layers).find((l) => l.id === id);
  assert.equal(layer(adds[0]).type, 'capture', 'the real capture layer is added first');
  assert.ok(adds.slice(1).every((id) => layer(id).type === 'duplicate'));
  assert.ok(h.calls.some((c) => c[0] === 'layers.orderFromProject'));
  // only the facecam placeholders changed
  const others = (d) => JSON.stringify(d.scenes.map((s) => s.layers.filter((l) => !ids.includes(l.id))));
  assert.equal(others(disk), others(h.doc));
  assert.deepEqual(placeholderRoles(disk, P).map((x) => x.role), ['game-capture'], 'the game is still waiting');
  assert.equal(h.edits(), 1);
  assert.equal((await h.post('/ui/api/devices/connect', { role: 'facecam' })).body.error, 'nothing-to-connect');
});

test('device routes: a host refusal puts the placeholders back and saves nothing; bad bodies are refused', async () => {
  const h = harness({ refuse: { method: 'layers.addFromProject' } });
  const saved = readFileSync(h.file, 'utf8');
  const r = await h.post('/ui/api/devices/connect', {});
  assert.equal(r.status, 502);
  assert.equal(readFileSync(h.file, 'utf8'), saved, 'file unchanged');
  const removed = h.calls.filter((c) => c[0] === 'layers.remove').length;
  assert.ok(removed > 0);
  // after the failure every removed placeholder is offered back (addFromProject with the old document)
  const readds = h.calls.filter((c) => c[0] === 'layers.addFromProject').length;
  assert.ok(readds >= removed, 'each removed placeholder is added back');
  for (const bad of [[], null, { role: 'mic' }, { role: 'facecam', x: 1 }]) assert.equal((await h.post('/ui/api/devices/connect', bad)).status, 400, JSON.stringify(bad));
});

test('device routes: Try again calls devices.rescan and answers counts; devices off is said plainly', async () => {
  const h = harness();
  const r = await h.post('/ui/api/devices/rescan', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.retried, r.body.connectable], [1, ['game-capture', 'facecam']]);
  assert.equal((await h.post('/ui/api/devices/rescan', { x: 1 })).status, 400);
  const off = harness({ list: null });
  const o = await off.post('/ui/api/devices/rescan', {});
  assert.equal(o.body.error, 'devices-off');
});

test('fake host: a waiting device sound is a waiting mixer row until devices.rescan finds it; mixer.levels lists meters only', async () => {
  const host = createFakeHost({ waitingAudio: [{ id: 'aud-x', name: 'Mic X' }] });
  let m = await host.call('mixer.list', {});
  const w = m.sources.find((s) => s.id === 'audio:aud-x');
  assert.equal(w.waiting, true);
  assert.match(w.message, /Waiting for/);
  assert.ok(!(await host.call('mixer.levels', {})).levels.some((l) => l.id === 'audio:aud-x'), 'a waiting row has no meter');
  assert.equal((await host.call('devices.rescan', {})).audio, 1);
  m = await host.call('mixer.list', {});
  assert.equal(m.sources.find((s) => s.id === 'audio:aud-x').waiting, undefined);
});
