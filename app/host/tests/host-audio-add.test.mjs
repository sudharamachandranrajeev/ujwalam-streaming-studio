// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer "Add audio" on a real host (D393 proposed; alpha.33 feedback): audio.addFromProject / audio.removeFromProject
// add one project audio source live and take it out again, without a project reload.
//   node --test app/host/tests/host-audio-add.test.mjs
// No device is listed or opened: --test-hooks without --allow-devices. devices.testSet gives a fake device list; the
// capture layer builds on ujw_test_capture and a microphone on ujw_test_audio (both open nothing). Real WASAPI endpoints
// are UNVERIFIED here. Headless (UJWALAM_HEADLESS=1). Needs the built host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const CARD = 'UJW Test Capture Card'; // names no real device has
const MIC = 'UJW Test Mic';
const CARD_PATH = '\\\\?\\usb#vid_0000&pid_0002&mi_00#7&dddd&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global';
const MIC_PATH = '{0.0.1.00000000}.{11111111-2222-3333-4444-555555555555}';
const CONFLICT = -32009;
const INVALID = -32602;

let h;
let c;

const base = () => ({
  version: 1, id: 'audio-add', name: 'Add audio test', activeScene: 'main',
  canvases: [{ id: 'h', width: 1280, height: 720, fps: 30 }],
  devices: [
    { id: 'dev-card', kind: 'capture-card', name: 'Capture card', match: { name: CARD, deviceId: CARD_PATH } },
    { id: 'dev-mic', kind: 'microphone', name: 'Mic', match: { name: MIC, deviceId: MIC_PATH } },
  ],
  overlays: [], outputs: [],
  scenes: [{ id: 'main', name: 'Main', layers: [
    { id: 'cap', type: 'capture', name: 'Game capture', source: { device: 'dev-card' }, placements: { h: { visible: true, x: 0, y: 0, width: 1280, height: 720 } } },
  ] }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
});
const withSources = (...s) => { const d = base(); d.audio.sources = s; return d; };
const CAP = { id: 'aud-cap', name: 'Game', layer: 'cap', volumeDb: -3, muted: false, monitoring: 'off', tracks: ['t1'] };
const MICSRC = { id: 'aud-mic', name: 'Mic', device: 'dev-mic', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] };

async function rpcErr(method, params) {
  try { await c.call(method, params); } catch (e) { return e; }
  assert.fail(`${method} should have failed`);
}
const rows = async () => (await c.call('mixer.list', {})).sources;

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'audio-add-')), extraArgs: ['--test-hooks', '--headless'], env: { UJWALAM_HEADLESS: '1' }, timeoutMs: 60000 });
  c = h.client;
  await c.call('devices.testSet', { devices: [{ kind: 'video', name: CARD, path: CARD_PATH }, { kind: 'audio-input', name: MIC, path: MIC_PATH }] });
  await loadIntoHost(c, base());
});

after(async () => {
  if (!h) return;
  try { await c.call('devices.testSet', { devices: null }); } catch { /* host gone */ }
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('the capture layer sound is metered but in no track before it is added', async () => {
  const cap = (await rows()).find((r) => r.id === 'main/cap');
  assert.ok(cap, 'a strip for the game capture');
  assert.deepEqual([cap.audioSource, cap.mixers], [null, 0]);
  assert.equal(cap.deviceAudio, false, 'no audio entry: the card\'s own audio is not opened');
  assert.ok(!(await rows()).some((r) => r.id.startsWith('audio:')), 'no device sound yet');
});

test('add a layer sound: on track 1 at its project volume, CUE late (it has video); twice is refused', async () => {
  const r = await c.call('audio.addFromProject', { project: withSources(CAP), audio: 'aud-cap' });
  assert.deepEqual([r.kind, r.cueDelayed], ['layer', true]);
  const cap = (await rows()).find((x) => x.id === 'main/cap');
  assert.deepEqual([cap.audioSource, cap.mixers, cap.tracks, Math.round(cap.volumeDb)], ['aud-cap', 1, ['t1'], -3]);
  assert.equal(cap.deviceAudio, true, 'attached: the card\'s own audio is opened');
  assert.equal((await rpcErr('audio.addFromProject', { project: withSources(CAP), audio: 'aud-cap' })).code, CONFLICT);
  assert.equal((await rpcErr('audio.addFromProject', { project: withSources(CAP), audio: 'nope' })).code, INVALID, 'only an entry in the project');
});

test('add a device sound on its own channel; a second entry for the same endpoint is refused whatever its id', async () => {
  const r = await c.call('audio.addFromProject', { project: withSources(CAP, MICSRC), audio: 'aud-mic' });
  assert.deepEqual([r.kind, r.cueDelayed], ['device', false]);
  const mic = (await rows()).find((x) => x.id === 'audio:aud-mic');
  assert.deepEqual([mic?.mixers, mic?.tracks], [1, ['t1']]);
  // An unsaved add retried under a new id names the same endpoint through another device entry.
  const twin = withSources(CAP, MICSRC, { ...MICSRC, id: 'aud-mic-2', device: 'dev-mic-2' });
  twin.devices.push({ id: 'dev-mic-2', kind: 'microphone', name: 'Mic again', match: { name: MIC, deviceId: MIC_PATH } });
  const e = await rpcErr('audio.addFromProject', { project: twin, audio: 'aud-mic-2' });
  assert.equal(e.code, CONFLICT);
  assert.match(e.message, /in the mixer already/);
  assert.equal((await rows()).filter((x) => x.id.startsWith('audio:')).length, 1, 'still one capture of that device');
});

test('remove needs the project without the entry; remove, then undo (add again) under the same id', async () => {
  assert.equal((await rpcErr('audio.removeFromProject', { project: withSources(CAP, MICSRC), audio: 'aud-mic' })).code, INVALID);
  let r = await c.call('audio.removeFromProject', { project: withSources(CAP), audio: 'aud-mic' });
  assert.deepEqual([r.removed, r.kind], [true, 'device']);
  assert.ok(!(await rows()).some((x) => x.id === 'audio:aud-mic'));
  // The UI server's undo when its save fails: the same id comes back at once (a fresh source with the same name).
  r = await c.call('audio.addFromProject', { project: withSources(CAP, MICSRC), audio: 'aud-mic' });
  assert.equal(r.kind, 'device');
  assert.equal((await rows()).filter((x) => x.id === 'audio:aud-mic').length, 1);

  r = await c.call('audio.removeFromProject', { project: withSources(MICSRC), audio: 'aud-cap' });
  assert.deepEqual([r.removed, r.kind], [true, 'layer']);
  const cap = (await rows()).find((x) => x.id === 'main/cap');
  assert.deepEqual([cap.audioSource, cap.mixers], [null, 0], 'the strip stays, out of the stream');
  assert.equal(cap.deviceAudio, false, 'detached: the card\'s own audio is closed again');
  r = await c.call('audio.removeFromProject', { project: withSources(MICSRC), audio: 'aud-cap' });
  assert.equal(r.removed, false, 'removing twice changes nothing');
});

test('a project loaded with the capture layer\'s audio entry opens the card\'s own audio; without it, not', async () => {
  await loadIntoHost(c, withSources(CAP));
  let cap = (await rows()).find((x) => x.id === 'main/cap');
  assert.deepEqual([cap.audioSource, cap.deviceAudio], ['aud-cap', true]);
  await loadIntoHost(c, base());
  cap = (await rows()).find((x) => x.id === 'main/cap');
  assert.deepEqual([cap.audioSource, cap.deviceAudio], [null, false]);
});
