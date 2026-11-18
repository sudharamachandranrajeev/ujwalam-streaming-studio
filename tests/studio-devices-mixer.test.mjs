// SPDX-License-Identifier: GPL-3.0-or-later
// Devices and mixer fixes (user bug report 2026-11-18): the game sound is in the mix once (B7: a capture card's own
// layer sound and its audio input are one device), and the UI server's device routes (A1 Connect: preset placeholders
// become the capture layers in place; A3 Try again: host devices.rescan). Device names here are placeholders.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { addAudioSource, audioChoices, hardwareKey, pairedKeys, sameDeviceRows } from '../services/project/audio-sources.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
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
  const x = addAudioSource(a.project, { key: 'layer|game', list: LIST, mixer: rows(doc) });
  assert.deepEqual([x.error, x.as], ['same-device', a.audio.name]);
  const r = sameDeviceRows(a.project, rows(doc), LIST);
  assert.equal(r[0].sameAs, a.audio.name);
  // a copy of the capture layer counts as the capture layer
  const copyRow = [{ id: `${doc.scenes[0].id}/game-copy`, layer: 'game-copy', name: 'Backdrop', mixers: 0, tracks: [] }];
  assert.equal(sameDeviceRows(a.project, copyRow, LIST)[0].sameAs, a.audio.name);
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
  assert.deepEqual(sameDeviceRows(doc, rows(doc), LIST), rows(doc), 'no input in the mix: rows unchanged');
});

test('B7 (Codex review P2): two cards of one model are never merged: the second card\'s input is offered and added with a warning', () => {
  const two = { devices: [...LIST.devices,
    { kind: 'audio-input', name: 'HDMI/Line In (2- Card X-Audio)', path: '{in-card-2}', obsId: '{in-card-2}' },
    { kind: 'video', name: 'Card X-Video', path: '\\\\?\\usb#cardx2', obsId: 'x2' }] };
  assert.deepEqual([...pairedKeys(LIST)], ['card x'], 'one card: the pair is certain');
  assert.deepEqual([...pairedKeys(two)], [], 'two cards of one model: not certain');
  assert.deepEqual([...pairedKeys(null)], [], 'no list: not certain');
  const doc = cardDoc();
  const a = addAudioSource(doc, { key: 'layer|game', list: two, mixer: rows(doc) });
  assert.ok(a.project, JSON.stringify(a));
  const c = audioChoices({ doc: a.project, list: two, mixer: rows(doc) });
  assert.deepEqual(c.skipped, []);
  const offered = c.inputs.filter((i) => i.maybeSameAs);
  assert.deepEqual(offered.map((i) => i.key).sort(), ['input|{in-card-2}', 'input|{in-card}']);
  const x = addAudioSource(a.project, { key: 'input|{in-card-2}', list: two });
  assert.equal(x.error, undefined);
  assert.equal(x.maybeSameAs, a.audio.name);
  const b = addAudioSource(doc, { key: 'input|{in-card}', list: two });
  assert.deepEqual(sameDeviceRows(b.project, rows(doc), two), rows(doc), 'not certain: no "already in the mix" on the strip');
});

test('project sync update: pending edits are written, the change is made on a fresh read, saved in one step', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-psync-'));
  const file = path.join(dir, 'p.project.json');
  const doc = cardDoc();
  const a = addAudioSource(doc, { key: 'input|{in-mic}', list: LIST });
  saveProject(file, a.project);
  const sync = createProjectSync({ file, delayMs: 60_000 });
  assert.equal(sync.record('mixer.setVolume', { audioSource: a.audio.id, volumeDb: -7 }), true);
  const r = sync.update((fresh) => {
    assert.equal(fresh.audio.sources[0].volumeDb, -7, 'the pending edit is in the fresh read');
    fresh.scenes[0].name = 'Changed';
    return { project: fresh };
  });
  assert.ok(r.project);
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([disk.audio.sources[0].volumeDb, disk.scenes[0].name], [-7, 'Changed']);
  assert.deepEqual(sync.update(() => ({ error: 'changed' })), { error: 'changed' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).scenes[0].name, 'Changed', 'a refused change saves nothing');
});

// ---- A1 / A3: the device routes
function harness({ list = DEV_LIST, refuse = null, onCall = null, sync = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-devroutes-'));
  const file = path.join(dir, 'p.project.json');
  let n = 0;
  const doc = buildAlphaProject({ presetsDir: PRESETS_DIR, profile: PROFILE, bindings: { bound: {}, unavailable: [] }, devicesListed: true, idFn: (p) => `${p}-${++n}` }).project;
  saveProject(file, doc);
  const calls = [];
  const host = { call: async (m, p) => {
    const now = typeof list === 'function' ? list() : list;
    if (m === 'devices.list') { if (!now) throw new Error('devices are disabled'); return now; }
    calls.push([m, p.scene ?? null, p.layer ?? null]);
    await onCall?.(m, p, calls);
    if (refuse && m === refuse.method && (refuse.layer === undefined || refuse.layer === p.layer) && (refuse.after === undefined || calls.filter((c) => c[0] === m).length > refuse.after)) throw new Error('refused');
    if (m === 'devices.rescan') { if (!list) throw new Error('devices are disabled'); return { retried: 1, audio: 0, media: 0 }; }
    return { ok: true };
  } };
  const out = {};
  const json = (res, status, body) => { res.status = status; res.body = body; };
  let edits = 0;
  const projectSync = sync ? sync(file) : createProjectSync({ file, delayMs: 60_000 });
  const routes = createDeviceRoutes({ host, json, projectSync, presetsDir: PRESETS_DIR, afterEdit: () => { edits++; } });
  const post = async (route, body) => { const res = {}; assert.equal(await routes.handle('POST', route, body, res), true); return res; };
  return { file, doc, calls, routes, post, out, projectSync, disk: () => JSON.parse(readFileSync(file, 'utf8')), edits: () => edits };
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

// Codex review 2026-11-18 (P2/P3)
test('device routes: Connect keeps a project edit saved, and one recorded, while the host calls ran', async () => {
  const P = upgradePresets(PRESETS_DIR);
  let h = null;
  let other = null;
  h = harness({ onCall: (m) => {
    if (m !== 'layers.orderFromProject' || h.touched) return;
    h.touched = true;
    const d = h.disk();
    d.name = 'Edited meanwhile'; // a structure edit saved by another route
    saveProject(h.file, d);
    const ph = new Set(placeholderRoles(d, P).flatMap((x) => x.layers.map((l) => l.layer)));
    const s = d.scenes.find((x) => x.layers.some((l) => !ph.has(l.id) && l.placements));
    other = { scene: s.id, layer: s.layers.find((l) => !ph.has(l.id) && l.placements).id };
    assert.equal(h.projectSync.record('layers.setVisible', { ...other, visible: false }), true); // a pending layer edit
  } });
  const r = await h.post('/ui/api/devices/connect', { role: 'facecam' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const disk = h.disk();
  assert.equal(disk.name, 'Edited meanwhile');
  const l = disk.scenes.find((s) => s.id === other.scene).layers.find((x) => x.id === other.layer);
  assert.ok(Object.values(l.placements).every((p) => p.visible === false), 'the pending edit is saved too');
  assert.deepEqual(placeholderRoles(disk, P).map((x) => x.role), ['game-capture']);
});

test('device routes: a failed save undoes the host change and says so; a failed undo says it is live only', async () => {
  const failing = (file) => ({ ...createProjectSync({ file, delayMs: 60_000 }), update: () => ({ error: 'not-saved' }) });
  const h = harness({ sync: failing });
  const saved = readFileSync(h.file, 'utf8');
  const r = await h.post('/ui/api/devices/connect', { role: 'facecam' });
  assert.deepEqual([r.status, r.body.error], [500, 'not-saved']);
  assert.equal(readFileSync(h.file, 'utf8'), saved);
  const removes = h.calls.filter((c) => c[0] === 'layers.remove');
  const adds = h.calls.filter((c) => c[0] === 'layers.addFromProject');
  assert.equal(removes.length, adds.length, 'each new layer is removed again and each placeholder put back');
  const k = placeholderRoles(h.doc, upgradePresets(PRESETS_DIR)).find((x) => x.role === 'facecam').layers.length;
  const h2 = harness({ sync: failing, refuse: { method: 'layers.remove', after: k } });
  const r2 = await h2.post('/ui/api/devices/connect', { role: 'facecam' });
  assert.deepEqual([r2.status, r2.body.error], [500, 'not-saved-live']);
  assert.match(r2.body.text, /live until Ujwalam restarts/);
});

test('device routes: a device change during a refresh is not lost (one more pass after it)', async () => {
  let cur = { devices: [] };
  const h = harness({ list: () => cur });
  const p1 = h.routes.refresh();
  cur = DEV_LIST;
  const p2 = h.routes.refresh();
  await p1;
  await p2;
  assert.deepEqual(h.routes.connectable().map((x) => x.role), ['game-capture', 'facecam']);
});

// Codex review round 2 (2026-11-18)
test('device routes (round 2, P3): a refresh asked for at any moment while one ends is never lost', async () => {
  let cur = { devices: [] };
  const h = harness({ list: () => cur });
  for (let hops = 0; hops < 60; hops++) {
    cur = { devices: [] };
    await h.routes.refresh();
    assert.deepEqual(h.routes.connectable(), []);
    const p1 = h.routes.refresh();
    let p2 = null;
    const late = (async () => {
      for (let i = 0; i < hops; i++) await null;
      cur = DEV_LIST; // a device arrives, and its refresh is asked for
      p2 = h.routes.refresh();
    })();
    await p1;
    await late;
    await p2;
    assert.deepEqual(h.routes.connectable().map((x) => x.role), ['game-capture', 'facecam'], `asked after ${hops} turn(s)`);
  }
});

test('device routes (round 2, P2): a placement saved while Connect ran: nothing saved, the host gets the placeholder back as the file has it', async () => {
  const P = upgradePresets(PRESETS_DIR);
  let h = null;
  let edited = null;
  const readds = [];
  h = harness({ onCall: (m, p) => {
    if (m === 'layers.addFromProject' && edited) readds.push(p);
    if (m !== 'layers.orderFromProject' || edited) return;
    const d = h.disk();
    const lid = placeholderRoles(d, P).find((x) => x.role === 'facecam').layers[0].layer;
    const l = d.scenes.flatMap((s) => s.layers).find((x) => x.id === lid);
    for (const pl of Object.values(l.placements)) pl.x += 7; // the user moved the placeholder meanwhile
    saveProject(h.file, d);
    edited = { lid, d };
  } });
  const r = await h.post('/ui/api/devices/connect', { role: 'facecam' });
  assert.deepEqual([r.status, r.body.error], [409, 'changed']);
  const disk = h.disk();
  assert.deepEqual(disk, edited.d, 'the file keeps the user\'s edit; Connect saved nothing');
  const back = readds.find((p) => p.layer === edited.lid);
  assert.ok(back, 'the placeholder is put back on the host');
  const lay = (doc) => doc.scenes.flatMap((s) => s.layers).find((x) => x.id === edited.lid);
  assert.deepEqual(lay(back.project), lay(edited.d), 'from the file as it is now, not from the copy read at the click');
  assert.deepEqual(placeholderRoles(disk, P).map((x) => x.role), ['game-capture', 'facecam']);
});

test('device routes (round 2, P2): a layer order saved while Connect ran is the order the undo puts back', async () => {
  let h = null;
  let order = null;
  let edited = false;
  h = harness({ onCall: (m, p) => {
    if (m === 'layers.orderFromProject' && edited) order = p.project.scenes.find((s) => s.id === p.scene).layers.map((l) => l.id);
    if (m !== 'layers.orderFromProject' || edited) return;
    edited = true;
    const d = h.disk();
    const s = d.scenes.find((x) => x.id === p.scene);
    s.layers.reverse(); // the user reordered the scene meanwhile
    saveProject(h.file, d);
  } });
  const r = await h.post('/ui/api/devices/connect', { role: 'facecam' });
  assert.equal(r.body.error, 'changed');
  const scene = h.disk().scenes.find((s) => s.layers.some((l) => order?.includes(l.id)));
  assert.deepEqual(order, scene.layers.map((l) => l.id), 'the undo orders the scene as the file has it now');
});

test('B7 (round 2, P2): card A\'s saved sound with A unplugged and an identical card B listed is only a warning', () => {
  const doc = cardDoc();
  const a = addAudioSource(doc, { key: 'input|{in-card}', list: LIST }); // card A's input, saved by endpoint id
  assert.ok(a.project);
  const cardB = { devices: [
    { kind: 'audio-input', name: 'HDMI/Line In (Card X-Audio)', path: '{in-card-b}', obsId: '{in-card-b}' },
    { kind: 'video', name: 'Card X-Video', path: '\\\\?\\usb#cardb', obsId: 'b' }] };
  assert.deepEqual([...pairedKeys(cardB)], ['card x'], 'card B alone is a certain pair');
  assert.deepEqual(sameDeviceRows(a.project, rows(doc), cardB), rows(doc), 'B\'s layer sound is not "already in the mix"');
  const c = audioChoices({ doc: a.project, list: cardB, mixer: rows(doc) });
  assert.deepEqual(c.skipped, []);
  assert.deepEqual(c.layers.map((l) => [l.key, l.maybeSameAs]), [['layer|game', a.audio.name]]);
  const x = addAudioSource(a.project, { key: 'layer|game', list: cardB, mixer: rows(doc) });
  assert.deepEqual([x.error, x.maybeSameAs], [undefined, a.audio.name]);
  // card A back: certain again
  assert.equal(sameDeviceRows(a.project, rows(doc), LIST)[0].sameAs, a.audio.name);
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

test('start (A1): a kept project with placeholders is rebound before the load when the devices are listed; a copy goes to _old', async () => {
  const { rebindAtStart } = await import('../services/studio-ui/launch.mjs');
  const h = harness();
  const dataDir = path.dirname(h.file);
  const lines = [];
  const log = console.log;
  console.log = (s) => lines.push(String(s));
  try {
    await rebindAtStart({ client: { call: async () => DEV_LIST }, file: h.file, profile: {}, dataDir });
  } finally { console.log = log; }
  assert.deepEqual(placeholderRoles(h.disk(), upgradePresets(PRESETS_DIR)), []);
  const old = path.join(dataDir, '_old');
  assert.ok(readdirSync(old).some((f) => /\.before-rebind\.project\.json$/.test(f)), lines.join('\n'));
  // nothing listed: the file stays as it is
  const h2 = harness();
  const before = readFileSync(h2.file, 'utf8');
  await rebindAtStart({ client: { call: async () => ({ devices: [] }) }, file: h2.file, profile: {}, dataDir: path.dirname(h2.file) });
  assert.equal(readFileSync(h2.file, 'utf8'), before);
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
