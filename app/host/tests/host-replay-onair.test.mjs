// SPDX-License-Identifier: GPL-3.0-or-later
// Replay buffer on air only (idle load, 2026-11-18): a host started with replay { autoStart: true, onAirOnly: true }
// runs no replay encoder and no memory buffer off air; the buffer starts with the first recording and stops when the
// last one ends. Off air, replay.save and the feedback capture say so in plain words. A manual replay.start still runs
// at once. Real host (libobs, test card, no devices, no previews, file sinks only; nothing leaves the machine).
//   node --test app/host/tests/host-replay-onair.test.mjs   (needs the built host and the OBS runtime; GPU: NVENC)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h, c, DATA;

before(async () => {
  mkdirSync(OUT, { recursive: true });
  DATA = mkdtempSync(path.join(OUT, 'onair-'));
  const cfg = { replay: { seconds: 10, autoStart: true, onAirOnly: true, fallbackKbps: { H: 6000, V: 4000 } }, hotkeys: { enabled: false }, feedbackDir: path.join(DATA, 'feedback') };
  writeFileSync(path.join(DATA, 'host-config.json'), JSON.stringify(cfg, null, 2));
  h = await launchHost({
    dataDir: DATA,
    project: path.join(HOST_DIR, 'projects', 'test-card.project.json'),
    extraArgs: ['--host-config', path.join(DATA, 'host-config.json'), '--test-hooks'],
    timeoutMs: 60000,
  });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h, 40000);
  assert.equal(r.code, 0, 'host exits 0');
});

async function until(fn, ms = 20000, step = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

test('off air: armed, waiting, no replay output; replay.save and the feedback capture say off air', async () => {
  const st = await c.call('replay.status');
  assert.equal(st.wanted, true);
  assert.equal(st.onAirOnly, true);
  assert.equal(st.waiting, true);
  assert.deepEqual(st.canvases, [], 'no replay output off air');
  assert.deepEqual((await c.call('host.status')).replayRunning, { H: false, V: false });
  const r = await c.call('replay.save');
  assert.deepEqual(r.saved, []);
  assert.match(r.errors[0].error, /^off air: the replay buffer runs only while you are live or recording$/);
  const cap = await c.call('feedback.capture', { note: 'off air' });
  const m = await until(() => {
    try { const x = JSON.parse(readFileSync(path.join(cap.dir, 'moment.json'), 'utf8')); return x.replay.state === 'done' ? x : null; } catch { return null; }
  });
  assert.ok(m, 'the capture finished (log and status kept)');
  assert.match(m.replay.errors[0].error, /^off air/);
});

test('a recording starts the buffer on its rungs; stopping the last one stops it', async () => {
  await c.call('outputs.configure', {
    rungs: [
      { id: 'h1', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1920, h: 1080, fps: 60, bitrate: 6000, gopSec: 2 },
      { id: 'v1', canvas: 'V', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1080, h: 1920, fps: 60, bitrate: 4000, gopSec: 2 },
    ],
    audio: { bitrate: 160, sampleRate: 48000 },
    sinks: [
      { id: 'rec-h', rung: 'h1', platform: 'local', proto: 'file', target: { transport: 'file', name: 'onair-h.mkv' } },
      { id: 'rec-v', rung: 'v1', platform: 'local', proto: 'file', target: { transport: 'file', name: 'onair-v.mkv' } },
    ],
  });
  assert.deepEqual((await c.call('replay.status')).canvases, [], 'configure alone does not start it');
  await c.call('record.start', { sinks: ['rec-h', 'rec-v'] });
  const st = await c.call('replay.status');
  assert.equal(st.waiting, false);
  assert.deepEqual(st.canvases.map((x) => [x.canvas, x.state, x.rung]), [['H', 'running', 'h1'], ['V', 'running', 'v1']]);
  await sleep(3000);
  const r = await c.call('replay.save', { canvas: 'H' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.saved.length, 1);
  await c.call('record.stop', { sinks: ['rec-h'] });
  assert.equal((await c.call('replay.status')).canvases.length, 2, 'one recording still wanted: the buffer stays');
  await c.call('record.stop', { sinks: ['rec-v'] });
  const off = await c.call('replay.status');
  assert.deepEqual(off.canvases, [], 'the last recording stopped: no replay output');
  assert.equal(off.waiting, true);
  await until(async () => (await c.call('outputs.status')).sinks.every((s) => s.state === 'stopped'));
});

// Codex review: a stream sink that keeps reconnecting (want stays true) must not detach the replay or restart its
// encoder, alone or beside a recording. The stream goes to a loopback RTMP port where nothing listens (connection
// refused): no real platform, no key. Samples every 100 ms: the replay outputs stay (same start, bufferedForMs only
// grows) and the shared rung encoder stays active through every retry.
test('stream sink reconnecting: the replay stays attached and the rung encoder never stops (alone and with a recording)', async () => {
  const net = await import('node:net');
  const PORT = 19499;
  const refused = await new Promise((r) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT }, () => { s.destroy(); r(false); });
    s.on('error', () => r(true));
  });
  assert.ok(refused, `nothing may listen on 127.0.0.1:${PORT} for this test`);
  await c.call('outputs.configure', {
    rungs: [
      { id: 'h1', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1920, h: 1080, fps: 60, bitrate: 6000, gopSec: 2 },
      { id: 'v1', canvas: 'V', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1080, h: 1920, fps: 60, bitrate: 4000, gopSec: 2 },
    ],
    audio: { bitrate: 160, sampleRate: 48000 },
    sinks: [
      { id: 'dead', rung: 'h1', platform: 'twitch', proto: 'rtmp', priority: 1, target: { transport: 'rtmp', port: PORT, app: 'live', stream: 'x' } },
      { id: 'rec-h', rung: 'h1', platform: 'local', proto: 'file', target: { transport: 'file', name: 'retry-h.mkv' } },
    ],
    policy: { retryBaseMs: 300, retryCapMs: 600, retryMax: 0, retryResetLiveMs: 10000 },
  });
  await c.call('stream.start', { sinks: ['dead'] });
  const watch = async (ms) => {
    const seen = { states: new Set(), samples: 0 };
    let last = null;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const [rp, os] = await Promise.all([c.call('replay.status'), c.call('outputs.status')]);
      const h = rp.canvases.find((x) => x.canvas === 'H');
      assert.deepEqual(rp.canvases.map((x) => [x.canvas, x.state]), [['H', 'running'], ['V', 'running']], 'replay stays attached');
      assert.equal(h.rung, 'h1');
      if (last !== null) assert.ok(h.bufferedForMs >= last, `bufferedForMs went back (${last} -> ${h.bufferedForMs}): re-attached`);
      last = h.bufferedForMs;
      assert.equal(os.rungs.find((x) => x.id === 'h1').active, true, 'the shared rung encoder stays active');
      seen.states.add(os.sinks.find((x) => x.id === 'dead').state);
      seen.samples += 1;
      await sleep(100);
    }
    const dead = (await c.call('outputs.status')).sinks.find((x) => x.id === 'dead');
    return { ...seen, retries: dead.retries, last };
  };
  const alone = await watch(8000);
  assert.ok(alone.retries >= 2, `the stream sink retried (${alone.retries})`);
  assert.ok(alone.states.has('retrying'), `states seen: ${[...alone.states]}`);
  await c.call('record.start', { sinks: ['rec-h'] });
  const before = alone.retries;
  const withRec = await watch(8000);
  assert.ok(withRec.retries > before, `still retrying beside the recording (${before} -> ${withRec.retries})`);
  assert.ok(withRec.last >= alone.last, 'the same replay outputs as before the recording started');
  await c.call('stream.stop', { sinks: ['dead'] });
  assert.equal((await c.call('replay.status')).canvases.length, 2, 'the recording is still wanted: the buffer stays');
  await c.call('record.stop', { sinks: ['rec-h'] });
  assert.deepEqual((await c.call('replay.status')).canvases, [], 'nothing wanted: detached');
  await until(async () => (await c.call('outputs.status')).sinks.every((s) => s.state === 'stopped' || s.state === 'failed'));
  console.log(`# retry test: alone ${alone.samples} samples, ${alone.retries} retries, states ${[...alone.states]}; with recording ${withRec.samples} samples, ${withRec.retries} retries`);
});

test('manual replay.start runs off air until replay.stop', async () => {
  const st = await c.call('replay.start');
  assert.equal(st.onAirOnly, false);
  assert.deepEqual(st.canvases.map((x) => [x.canvas, x.state]), [['H', 'running'], ['V', 'running']]);
  const stop = await c.call('replay.stop');
  assert.equal(stop.wanted, false);
  assert.deepEqual(stop.canvases, []);
});
