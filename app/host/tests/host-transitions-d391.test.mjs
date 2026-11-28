// SPDX-License-Identifier: GPL-3.0-or-later
// More scene transitions (D391 proposed): slide {direction}, swipe {direction, swipeIn}, wipe {pattern, softness,
// invert} (a luma image from data/transitions/luma-wipes.json) and fadeColor {color, pointPct}, each with durationMs.
// One second transition object per canvas sits on channel 0 while one of these (or a stinger) is chosen, swapped like
// the stinger and released when the canvas goes back to cut or fade. A recorded H canvas switching white to black
// under each type shows the transition for about durationMs; fadeColor passes through its colour; slide left moves
// the new scene in from the right.
//   node --test app/host/tests/host-transitions-d391.test.mjs   (needs the built host, the OBS runtime, NVENC and ffmpeg)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIPES = JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'transitions', 'luma-wipes.json'), 'utf8')).wipes;
let h;
let c;

const full = { visible: true, x: 0, y: 0, width: 640, height: 360 };
const PROJECT = {
  version: 1, id: 'd391', name: 'D391', activeScene: 'white',
  // a project D391 transition loads; the host does not apply it at load (the UI server does, from the project)
  canvases: [{ id: 'h', width: 640, height: 360, fps: 30, transition: { type: 'wipe', durationMs: 800, pattern: 'clock', softness: 0.1 } }],
  devices: [], overlays: [], outputs: [],
  scenes: [
    { id: 'white', name: 'White', layers: [{ id: 'w', type: 'color', name: 'W', source: { color: '#ffffff' }, placements: { h: full } }] },
    { id: 'black', name: 'Black', layers: [{ id: 'k', type: 'color', name: 'K', source: { color: '#000000' }, placements: { h: full } }] },
  ],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
};

before(async () => {
  mkdirSync(OUT, { recursive: true });
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'd391-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' } });
  c = h.client;
  await loadIntoHost(c, PROJECT);
});

after(async () => { if (h) await stopHost(h); });

async function code(params) {
  try { await c.call('transitions.set', params); } catch (e) { return e.code; }
  return null;
}

test('transitions.types: every type with its fields and availability; the wipe ids match data/transitions/luma-wipes.json', async () => {
  const t = await c.call('transitions.types', {});
  const by = Object.fromEntries(t.types.map((x) => [x.type, x]));
  assert.deepEqual(Object.keys(by), ['cut', 'fade', 'stinger', 'slide', 'swipe', 'wipe', 'fadeColor', 'blurZoom', 'lightLeak', 'motionSwipe', 'glitch', 'heartbeat', 'pop']);
  for (const x of t.types) assert.equal(x.available, true, `${x.type} available (obs-transitions loaded)`);
  assert.deepEqual(by.slide.fields, ['durationMs', 'direction']);
  assert.deepEqual(by.swipe.fields, ['durationMs', 'direction', 'swipeIn']);
  assert.deepEqual(by.wipe.fields, ['durationMs', 'pattern', 'softness', 'invert']);
  assert.deepEqual(by.fadeColor.fields, ['durationMs', 'color', 'pointPct']);
  assert.deepEqual(t.wipes, WIPES.map((w) => w.id).sort(), 'the data file lists exactly the images the runtime ships');
  assert.equal((await c.call('transitions.get')).H.type, 'cut', 'a project transition is not applied at load');
});

test('set and reported with their own fields; host defaults fill absent ones', async () => {
  let r = await c.call('transitions.set', { canvas: 'H', type: 'slide', durationMs: 600, direction: 'up' });
  assert.deepEqual(r.H, { type: 'slide', durationMs: 600, direction: 'up', available: true });
  r = await c.call('transitions.set', { canvas: 'H', type: 'swipe', durationMs: 600, direction: 'right', swipeIn: true });
  assert.deepEqual(r.H, { type: 'swipe', durationMs: 600, direction: 'right', swipeIn: true, available: true });
  r = await c.call('transitions.set', { canvas: 'H', type: 'wipe', durationMs: 800, pattern: 'barndoor-h' });
  assert.deepEqual(r.H, { type: 'wipe', durationMs: 800, pattern: 'barndoor-h', softness: 0.03, invert: false, available: true });
  r = await c.call('transitions.set', { canvas: 'H', type: 'fadeColor', durationMs: 1000, color: '#1a2b3c' });
  assert.deepEqual(r.H, { type: 'fadeColor', durationMs: 1000, color: '#1A2B3C', pointPct: 50, available: true });
  assert.deepEqual((await c.call('host.status')).transitions.H, r.H, 'host.status reports the same');
  r = await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  assert.deepEqual(r.H, { type: 'cut', durationMs: 0, available: true }, 'back to cut: no leftover fields');
});

test('bad values refused (-32602) and the canvas left as it was', async () => {
  await c.call('transitions.set', { canvas: 'H', type: 'slide', durationMs: 500, direction: 'left' });
  for (const p of [
    { type: 'slide', durationMs: 500 },                                   // no direction
    { type: 'slide', durationMs: 500, direction: 'upleft' },
    { type: 'slide', durationMs: 500, direction: 'left', swipeIn: true }, // swipe's field
    { type: 'swipe', durationMs: 500, direction: 'up', pattern: 'clock' },
    { type: 'wipe', durationMs: 500 },                                    // no pattern
    { type: 'wipe', durationMs: 500, pattern: 'not-a-shipped-wipe' },
    { type: 'wipe', durationMs: 500, pattern: '../clock' },
    { type: 'wipe', durationMs: 500, pattern: 'clock', softness: 2 },
    { type: 'wipe', durationMs: 500, pattern: 'clock', easing: 'in-quad' },
    { type: 'fadeColor', durationMs: 500 },                               // no colour
    { type: 'fadeColor', durationMs: 500, color: 'red' },
    { type: 'fadeColor', durationMs: 500, color: '#000000', pointPct: 101 },
    { type: 'fadeColor', durationMs: 500, color: '#000000', pointPct: 0 },   // 0 and 100: NaN audio in OBS
    { type: 'fadeColor', durationMs: 500, color: '#000000', pointPct: 100 },
    { type: 'fadeColor', durationMs: 500, color: '#000000', file: { base: 'media', rel: 's.webm' } }, // a stinger's field
    { type: 'fade', durationMs: 500, direction: 'left' },
    { type: 'cut', color: '#000000' },
    { type: 'slide', durationMs: 20000, direction: 'left' },
  ]) assert.equal(await code({ canvas: 'H', ...p }), -32602, JSON.stringify(p));
  assert.deepEqual((await c.call('transitions.get')).H, { type: 'slide', durationMs: 500, direction: 'left', available: true }, 'refusals changed nothing');
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
});

test('switching kinds swaps the second transition: slide, wipe, fade, slide again, fadeColor, cut; scenes still switch', async () => {
  for (const p of [
    { type: 'slide', durationMs: 300, direction: 'left' },
    { type: 'wipe', durationMs: 300, pattern: 'clock' },
    { type: 'fade', durationMs: 300 },
    { type: 'slide', durationMs: 300, direction: 'down' },
    { type: 'fadeColor', durationMs: 300, color: '#ff0000' },
    { type: 'cut' },
  ]) {
    await c.call('transitions.set', { canvas: 'H', ...p });
    await c.call('scenes.activate', { scene: 'black' });
    await sleep(450);
    await c.call('scenes.activate', { scene: 'white' });
    await sleep(450);
    assert.equal((await c.call('transitions.get')).H.type, p.type);
  }
  assert.ok((await c.call('host.alive')) !== undefined, 'host still up');
});

function stats(file, crop) {
  const vf = `${crop ? `crop=${crop},` : ''}signalstats,metadata=mode=print:file=-`;
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-vf', vf, '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 32 << 20 });
  assert.equal(r.status, 0, r.stderr);
  const frames = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /lavfi\.signalstats\.(YAVG|VAVG)=([0-9.]+)/.exec(line);
    if (!m) continue;
    if (m[1] === 'YAVG') frames.push({ y: Number(m[2]) }); else if (frames.length) frames.at(-1).v = Number(m[2]);
  }
  return frames;
}

// Records white, switches to black under transition `t`, stops; returns the file.
async function recordSwitch(name, t) {
  await c.call('scenes.activate', { scene: 'white' });
  await c.call('outputs.configure', {
    rungs: [{ id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name } }],
  });
  await c.call('transitions.set', { canvas: 'H', ...t });
  await c.call('record.start', {});
  let st;
  for (let i = 0; i < 40; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'live') break; await sleep(100); }
  await sleep(700);
  await c.call('scenes.activate', { scene: 'black' });
  await sleep(2000);
  await c.call('record.stop', {});
  for (let i = 0; i < 50; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'stopped') break; await sleep(100); }
  await c.call('outputs.clear');
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  return st.sinks[0].path;
}

// Frames that differ from both the first (white) and the last (black) frame: the transition running, as one run.
// Not a mid-grey band: slide and swipe ease in and out (measured 2026-11-18: mean luma 234..17 over frames 22..46 of a
// 1 s slide, but only 16 frames inside 30..225), so a band check undercounts them; the wipe is linear.
function midRun(f) {
  const y0 = f[0].y, y1 = f.at(-1).y;
  const mid = f.map((x) => Math.abs(x.y - y0) > 1 && Math.abs(x.y - y1) > 1);
  const runs = [];
  for (let i = 0; i < mid.length; i++) if (mid[i]) { if (i > 0 && mid[i - 1]) runs[runs.length - 1]++; else runs.push(1); }
  return runs;
}

for (const t of [
  { type: 'slide', durationMs: 1000, direction: 'left' },
  { type: 'swipe', durationMs: 1000, direction: 'up', swipeIn: true },
  { type: 'wipe', durationMs: 1000, pattern: 'linear-h', softness: 0.03 },
]) {
  test(`recorded ${t.type}: white, about ${t.durationMs} ms in between, black`, async () => {
    const f = stats(await recordSwitch(`d391-${t.type}.mkv`, t));
    const runs = midRun(f);
    console.log(`${t.type}: ${f.length} frames, in-between runs ${JSON.stringify(runs)}`);
    assert.ok(f[0].y > 200, 'starts white');
    assert.ok(f.at(-1).y < 40, 'ends black');
    assert.equal(runs.length, 1, 'one transition');
    assert.ok(runs[0] >= 20 && runs[0] <= 32, `${runs[0]} frames in between (1 s at 30 fps; eased ends are within 1 luma step)`);
  });
}

test('recorded slide left: the new (black) scene comes in from the right (UNVERIFIED OBS direction meaning)', async () => {
  const file = await recordSwitch('d391-slide-dir.mkv', { type: 'slide', durationMs: 1000, direction: 'left' });
  const left = stats(file, 'iw/2:ih:0:0');
  const right = stats(file, 'iw/2:ih:iw/2:0');
  const firstDark = (fr) => fr.findIndex((x) => x.y < 200);
  console.log(`slide left: right half darkens at frame ${firstDark(right)}, left half at ${firstDark(left)}`);
  assert.ok(firstDark(right) >= 0 && firstDark(left) > firstDark(right), 'the right half goes dark first');
});

test('recorded fadeColor red: white, red around the switch point, black', async () => {
  const f = stats(await recordSwitch('d391-fadecolor.mkv', { type: 'fadeColor', durationMs: 1000, color: '#ff0000', pointPct: 50 }));
  const red = f.map((x) => x.v > 200);
  const first = red.indexOf(true);
  console.log(`fadeColor: ${f.length} frames, red frames ${red.filter(Boolean).length}, first at ${first}`);
  assert.ok(f[0].y > 200, 'starts white');
  assert.ok(f.at(-1).y < 40, 'ends black');
  assert.ok(red.filter(Boolean).length >= 2, 'passes through red');
  assert.ok(f.slice(0, first).every((x) => x.y > 60) && f.slice(first).findIndex((x) => x.y < 40) > 0, 'white, then red, then black');
});
