// SPDX-License-Identifier: GPL-3.0-or-later
// Late devices on a real host (user bug report 2026-11-18: "if a layer is not detected at start it fails to detect
// afterwards"; mixer strips missing):
//   A2  a microphone missing at load keeps a waiting mixer row and host.status waiting entry, and is built by the next
//       device pass once it is listed (before: dropped until a project reload)
//   A3  after the fast connect attempts a capture layer without a picture is still tried once a minute; devices.rescan
//       ("Try again") starts the attempts over at once
//   A4  devices.rescan builds an image layer whose file was missing at load, once the file is there
//   B5  mixer.setVolume takes up to +12 dB; B9 mixer.levels lists the meters of the mixer.list rows
//   node --test app/host/tests/host-devices-late.test.mjs
// No device is listed or opened: --test-hooks without --allow-devices; devices.testSet gives fake lists (capture layers
// on ujw_test_capture, microphones on ujw_test_audio). Headless (UJWALAM_HEADLESS=1). Needs the built host.
// NOT RUN when written (2026-11-18): the user's studio may be open; host tests run off air with the studio closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD = 'UJW Test Capture Card'; // names no real device has
const MIC = 'UJW Test Mic';
const CARD_PATH = '\\\\?\\usb#vid_0000&pid_0003&mi_00#7&eeee&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global';
const MIC_PATH = '{0.0.1.00000000}.{66666666-2222-3333-4444-555555555555}';
const INVALID = -32602;
// 1 x 1 red PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

let h;
let c;
let media;

const place = { h: { visible: true, x: 0, y: 0, width: 640, height: 360 } };
const doc = () => ({
  version: 1, id: 'late', name: 'Late devices test', activeScene: 'main',
  canvases: [{ id: 'h', width: 1280, height: 720, fps: 30 }],
  devices: [
    { id: 'dev-card', kind: 'capture-card', name: 'Capture card', match: { name: CARD, deviceId: CARD_PATH } },
    { id: 'dev-mic', kind: 'microphone', name: 'Mic', match: { name: MIC, deviceId: MIC_PATH } },
  ],
  overlays: [], outputs: [],
  scenes: [{ id: 'main', name: 'Main', layers: [
    { id: 'cap', type: 'capture', name: 'Game', source: { device: 'dev-card' }, placements: place },
    { id: 'logo', type: 'image', name: 'Logo', source: { file: { base: 'media', rel: 'late-logo.png' } }, placements: place },
  ] }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [
    { id: 'aud-mic', name: 'Mic', device: 'dev-mic', volumeDb: -6, muted: false, monitoring: 'off', tracks: ['t1'] },
  ] },
});
async function until(fn, what, ms = 10_000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(step);
  }
}
const rows = async () => (await c.call('mixer.list', {})).sources;
const layerIds = async () => (await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.map((l) => l.id);

before(async () => {
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'late-media-'));
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'late-')), extraArgs: ['--test-hooks', '--headless'], env: { UJWALAM_HEADLESS: '1' }, timeoutMs: 60000 });
  c = h.client;
  await c.call('devices.testSet', { devices: [{ kind: 'video', name: CARD, path: CARD_PATH, fail: 100 }] }); // no mic; the card sends nothing
  await loadIntoHost(c, doc(), { bases: { media }, skipUnavailable: true });
});

after(async () => {
  if (!h) return;
  try { await c.call('devices.testSet', { devices: null }); } catch { /* host gone */ }
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('A2: a microphone missing at load is a waiting mixer row and a host.status waiting entry', async () => {
  const mic = (await rows()).find((r) => r.id === 'audio:aud-mic');
  assert.ok(mic, 'the strip does not vanish');
  assert.deepEqual([mic.waiting, mic.audioSource, mic.name, mic.peakDb], [true, 'aud-mic', 'Mic', null]);
  assert.match(mic.message, /^Waiting for audio input "Mic": it is not connected\. Plug it in; the sound connects by itself\./);
  const st = await c.call('host.status');
  assert.ok(st.devices.waiting.some((w) => w.audio === 'aud-mic' && w.device === 'dev-mic'));
  assert.ok(!(await c.call('mixer.levels', {})).levels.some((l) => l.id === 'audio:aud-mic'), 'a waiting row has no meter');
});

test('A2: plugged in later, the next device pass builds it at its project volume on its track; seq moves', async () => {
  const seq = (await c.call('host.status')).devices.seq;
  const r = await c.call('devices.testSet', { devices: [{ kind: 'video', name: CARD, path: CARD_PATH, fail: 100 }, { kind: 'audio-input', name: MIC, path: MIC_PATH }] });
  assert.ok(r.changes.some((x) => x.audio === 'aud-mic' && x.action === 'bound'), JSON.stringify(r.changes));
  const mic = (await rows()).find((x) => x.id === 'audio:aud-mic');
  assert.deepEqual([mic.waiting, mic.mixers, mic.tracks, Math.round(mic.volumeDb)], [undefined, 1, ['t1'], -6]);
  assert.ok((await c.call('host.status')).devices.seq > seq);
  assert.ok(!(await c.call('host.status')).devices.waiting.some((w) => w.audio === 'aud-mic'));
  // unplugged again: the source stays (the audio health watchdog owns a dead device sound); no second copy on replug
  await c.call('devices.testSet', { devices: [{ kind: 'video', name: CARD, path: CARD_PATH, fail: 100 }, { kind: 'audio-input', name: MIC, path: MIC_PATH }] });
  assert.equal((await rows()).filter((x) => x.id === 'audio:aud-mic').length, 1);
});

test('B9/B5: mixer.levels has the ids of the metered rows and never waits; setVolume takes +12 dB, not more', async () => {
  const lv = await c.call('mixer.levels', {});
  assert.equal(lv.busy, false);
  const ids = (await rows()).filter((r) => !r.waiting).map((r) => r.id).sort();
  assert.deepEqual(lv.levels.map((l) => l.id).sort(), ids);
  const r = await c.call('mixer.setVolume', { id: 'audio:aud-mic', db: 12 });
  assert.ok(Math.abs(r.volumeDb - 12) < 0.01, JSON.stringify(r));
  let e;
  try { await c.call('mixer.setVolume', { id: 'audio:aud-mic', db: 12.5 }); } catch (x) { e = x; }
  assert.equal(e?.code, INVALID);
});

test('A3: devices.rescan starts the connect attempts over for a capture layer without a picture', { timeout: 60_000 }, async () => {
  const cap = async () => (await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.find((l) => l.id === 'cap');
  await until(async () => (await cap()).device.attempt >= 2, 'a second attempt', 8000);
  const r = await c.call('devices.rescan', {});
  assert.equal(r.retried, 1);
  assert.equal((await cap()).device.attempt, 1, 'attempts start over');
  assert.equal((await cap()).device.state, 'connecting');
});

test('A3: after the fast attempts the message says it keeps trying (each minute)', { timeout: 120_000 }, async () => {
  const cap = async () => (await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.find((l) => l.id === 'cap');
  await until(async () => (await cap()).device.attempt >= 5, 'the fifth attempt', 90_000, 500);
  assert.match((await cap()).device.message, /tries again every minute, or press Try again/);
  const n = (await cap()).device.attempt;
  await until(async () => (await cap()).device.attempt > n, 'a slow retry', 70_000, 1000);
});

test('A4: an image whose file was missing at load is built by devices.rescan once the file is there', async () => {
  assert.ok(!(await layerIds()).includes('logo'), 'skipped at load');
  let r = await c.call('devices.rescan', {});
  assert.equal(r.media, 0, 'still missing');
  writeFileSync(path.join(media, 'late-logo.png'), PNG);
  r = await c.call('devices.rescan', {});
  assert.equal(r.media, 1);
  assert.deepEqual(await layerIds(), ['cap', 'logo'], 'in the project order');
  assert.equal((await c.call('devices.rescan', {})).media, 0, 'built once');
});
