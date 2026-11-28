// SPDX-License-Identifier: GPL-3.0-or-later
// Shader scene transitions (2026-11-28): blurZoom, lightLeak, motionSwipe, glitch, heartbeat, pop (host type
// ujw_shader_transition, src/shader_transition.h). Each is set and reported with its easing; a recorded H canvas switching
// between two test-card scenes under each one shows the transition for about durationMs, never a black frame, at most 3
// luminance flashes per second, and ends on the new scene; forceComplete ends a running one; a switch while recording
// works; a style whose shader fails (test seam UJWALAM_TEST_SHADER_FAIL) runs as a fade. With UJWALAM_TR_BENCH=1 it
// also reports the render thread's frame time during each transition at 1080p60 against no transition.
//   node --test app/host/tests/host-shader-transitions.test.mjs   (needs the built host, the OBS runtime, NVENC and ffmpeg)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const BENCH = process.env.UJWALAM_TR_BENCH === '1';
const STYLES = ['blurZoom', 'lightLeak', 'motionSwipe', 'glitch', 'heartbeat', 'pop'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h;
let c;
let media;

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

const W = 640, H = 360;
const full = (w, hh) => ({ visible: true, x: 0, y: 0, width: w, height: hh });
// Two test-card scenes: a warm one (A) and a cool one (B), so the V (red-difference) channel tells them apart and
// neither is near black (a black frame shows as Y near 16).
const project = (w, hh, fps) => ({
  version: 1, id: 'shtr', name: 'Shader transitions', activeScene: 'a',
  canvases: [{ id: 'h', width: w, height: hh, fps }], devices: [], overlays: [], outputs: [],
  scenes: [
    { id: 'a', name: 'A', layers: [{ id: 'ia', type: 'image', name: 'A', source: { file: { base: 'media', rel: 'a.png' } }, placements: { h: full(w, hh) } }] },
    { id: 'b', name: 'B', layers: [{ id: 'ib', type: 'image', name: 'B', source: { file: { base: 'media', rel: 'b.png' } }, placements: { h: full(w, hh) } }] },
  ],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
});

async function start(env = {}) {
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'shtr-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1', ...env } });
  c = h.client;
  const r = await loadIntoHost(c, project(W, H, 30), { bases: { media } });
  assert.deepEqual(r.unavailable, []);
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'shtr-media-'));
  // testsrc2 tinted warm and cool; the bars and moving parts give the blurs and glitch something to act on
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-vf', 'colorchannelmixer=rr=1:gg=0.55:bb=0.35', '-frames:v', '1', path.join(media, 'a.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=1', '-vf', 'hflip,colorchannelmixer=rr=0.35:gg=0.6:bb=1', '-frames:v', '1', path.join(media, 'b.png')]);
  await start();
});

after(async () => { if (h) await stopHost(h); });

async function code(params) {
  try { await c.call('transitions.set', params); } catch (e) { return e.code; }
  return null;
}

test('transitions.types lists the six styles, available, with durationMs and easing (motionSwipe also direction)', async () => {
  const t = await c.call('transitions.types', {});
  const by = Object.fromEntries(t.types.map((x) => [x.type, x]));
  for (const s of STYLES) {
    assert.equal(by[s]?.available, true, s);
    assert.deepEqual(by[s].fields, s === 'motionSwipe' ? ['durationMs', 'easing', 'direction'] : ['durationMs', 'easing']);
  }
});

test('set and reported: easing kept, motionSwipe direction defaults to left; bad values refused and nothing changed', async () => {
  let r = await c.call('transitions.set', { canvas: 'H', type: 'blurZoom', durationMs: 500, easing: 'in-out-sine' });
  assert.deepEqual(r.H, { type: 'blurZoom', durationMs: 500, easing: 'in-out-sine', available: true });
  r = await c.call('transitions.set', { canvas: 'H', type: 'motionSwipe', durationMs: 450 });
  assert.deepEqual(r.H, { type: 'motionSwipe', durationMs: 450, direction: 'left', available: true });
  for (const p of [
    { type: 'glitch', durationMs: 400, direction: 'left' },
    { type: 'pop', durationMs: 400, easing: 'bogus' },
    { type: 'pop', durationMs: 400, color: '#000000' },
    { type: 'motionSwipe', durationMs: 400, direction: 'sideways' },
    { type: 'heartbeat', durationMs: 20000 },
    { type: 'slide', durationMs: 400, direction: 'left', easing: 'in-quad' },
  ]) assert.equal(await code({ canvas: 'H', ...p }), -32602, JSON.stringify(p));
  assert.deepEqual((await c.call('transitions.get')).H, { type: 'motionSwipe', durationMs: 450, direction: 'left', available: true });
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
});

function stats(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-vf', 'signalstats,metadata=mode=print:file=-', '-f', 'null', '-'],
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

// Records A, switches to B under transition t, stops; returns the file.
async function recordSwitch(name, t, during = null) {
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  await c.call('scenes.activate', { scene: 'a' });
  await c.call('outputs.configure', {
    rungs: [{ id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: W, h: H, fps: 30, bitrate: 3000, gopSec: 2 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name } }],
  });
  await c.call('transitions.set', { canvas: 'H', ...t });
  await c.call('record.start', {});
  let st;
  for (let i = 0; i < 40; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'live') break; await sleep(100); }
  await sleep(800);
  await c.call('scenes.activate', { scene: 'b' });
  if (during) await during();
  await sleep(1800);
  await c.call('record.stop', {});
  for (let i = 0; i < 50; i++) { st = await c.call('outputs.status'); if (st.sinks[0].state === 'stopped') break; await sleep(100); }
  await c.call('outputs.clear');
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  return st.sinks[0].path;
}

// Frames that differ from both the first (A) and the last (B) frame in Y or V: the transition running, as runs.
function midRuns(f) {
  const a = f[0], b = f.at(-1);
  const off = (x, r) => Math.abs(x.y - r.y) > 1.5 || Math.abs(x.v - r.v) > 1.5;
  const mid = f.map((x) => off(x, a) && off(x, b));
  const runs = [];
  for (let i = 0; i < mid.length; i++) if (mid[i]) { if (i > 0 && mid[i - 1]) runs[runs.length - 1]++; else runs.push(1); }
  return runs;
}

// Luminance flashes (WCAG-style, whole frame): a flash is a pair of opposing mean-luma changes of at least 10 % of the
// luma range (22 of 219 steps). Returns the most flashes in any 1 s (30 frame) window.
function flashesPerSecond(f) {
  const ext = []; // turning points that moved at least the threshold
  let dir = 0, ref = f[0].y;
  const TH = 22;
  for (const x of f) {
    if (dir >= 0 && x.y > ref) ref = x.y;
    else if (dir <= 0 && x.y < ref) ref = x.y;
    if (dir >= 0 && ref - x.y >= TH) { ext.push(f.indexOf(x)); dir = -1; ref = x.y; }
    else if (dir <= 0 && x.y - ref >= TH) { ext.push(f.indexOf(x)); dir = 1; ref = x.y; }
  }
  let most = 0;
  for (let i = 0; i < ext.length; i++) {
    const n = ext.filter((e) => e >= ext[i] && e < ext[i] + 30).length;
    most = Math.max(most, Math.floor(n / 2));
  }
  return most;
}

const measured = [];
for (const s of STYLES) {
  const t = { type: s, durationMs: 600, easing: 'in-out-sine', ...(s === 'motionSwipe' ? { direction: 'left' } : {}) };
  test(`recorded ${s}: A, about 600 ms in between, never black, <= 3 flashes/s, ends on B`, async () => {
    const f = stats(await recordSwitch(`shtr-${s}.mkv`, t));
    const runs = midRuns(f);
    const minY = Math.min(...f.map((x) => x.y));
    const fl = flashesPerSecond(f);
    const longest = Math.max(0, ...runs);
    measured.push({ style: s, frames: f.length, runs, longest, minY: +minY.toFixed(1), flashes: fl });
    console.log(`${s}: ${f.length} frames, in-between runs ${JSON.stringify(runs)}, min luma ${minY.toFixed(1)}, flashes/s ${fl}`);
    assert.ok(Math.abs(f[0].v - f.at(-1).v) > 8, 'A and B differ');
    assert.ok(minY > 40, `never a black frame (min mean luma ${minY})`);
    assert.ok(longest >= 6 && longest <= 24, `${longest} frames in between (600 ms = 18 frames at 30 fps; eased ends sit within the tolerance)`);
    assert.ok(fl <= 3, `${fl} flashes per second`);
    assert.equal((await c.call('transitions.get')).H.type, 'cut');
  });
}

test('forceComplete ends a running shader transition at once on its target scene', async () => {
  await c.call('scenes.activate', { scene: 'a' });
  await c.call('transitions.set', { canvas: 'H', type: 'heartbeat', durationMs: 8000, easing: 'linear' });
  await c.call('scenes.activate', { scene: 'b' });
  await sleep(400);
  const r = await c.call('transitions.forceComplete', { canvas: 'H' });
  assert.deepEqual(r, { canvas: 'H', completed: true });
  assert.deepEqual(await c.call('transitions.forceComplete', { canvas: 'H' }), { canvas: 'H', completed: false }, 'nothing left running');
  // a new switch right after works
  await c.call('transitions.set', { canvas: 'H', type: 'pop', durationMs: 300 });
  await c.call('scenes.activate', { scene: 'a' });
  await sleep(600);
  assert.deepEqual(await c.call('transitions.forceComplete', { canvas: 'H' }), { canvas: 'H', completed: false }, 'the 300 ms pop finished on its own');
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
});

test('on air: the transition type changes during a running transition while recording; no black frame, ends on B', async () => {
  const f = stats(await recordSwitch('shtr-onair.mkv', { type: 'glitch', durationMs: 900 }, async () => {
    await sleep(200);
    await c.call('transitions.set', { canvas: 'H', type: 'lightLeak', durationMs: 500 }); // a change while it runs
  }));
  const minY = Math.min(...f.map((x) => x.y));
  console.log(`on-air change: ${f.length} frames, min luma ${minY.toFixed(1)}`);
  assert.ok(minY > 40, 'never black');
  assert.ok(Math.abs(f.at(-1).v - f[0].v) > 8, 'ends on B');
});

test('fallback: a style whose shader fails runs as a fade (reported fallback: true), never black', async () => {
  await stopHost(h);
  h = null;
  await start({ UJWALAM_TEST_SHADER_FAIL: 'glitch' });
  const r = await c.call('transitions.set', { canvas: 'H', type: 'glitch', durationMs: 600, easing: 'in-out-sine' });
  assert.deepEqual(r.H, { type: 'glitch', durationMs: 600, easing: 'in-out-sine', fallback: true, available: true });
  const f = stats(await recordSwitch('shtr-fallback.mkv', { type: 'glitch', durationMs: 600, easing: 'in-out-sine' }));
  const runs = midRuns(f);
  const minY = Math.min(...f.map((x) => x.y));
  console.log(`fallback fade: runs ${JSON.stringify(runs)}, min luma ${minY.toFixed(1)}`);
  assert.ok(minY > 40, 'never black');
  assert.ok(Math.max(...runs) >= 6, 'a fade runs');
  // the other styles still use their shaders
  assert.equal((await c.call('transitions.set', { canvas: 'H', type: 'pop', durationMs: 400 })).H.fallback, undefined);
  console.log(`MEASURED ${JSON.stringify(measured)}`);
});

test('render cost during each transition at 1080p60 (UJWALAM_TR_BENCH=1)', { skip: !BENCH && 'set UJWALAM_TR_BENCH=1' }, async () => {
  await loadIntoHost(c, project(1920, 1080, 60), { bases: { media } });
  const sample = async (ms) => {
    const ft = [], gpu = [];
    for (let t = 0; t < ms; t += 250) {
      const s = await c.call('host.status');
      ft.push(s.render.avgFrameTimeMs);
      if (typeof s.gpuPct === 'number') gpu.push(s.gpuPct);
      await sleep(250);
    }
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return { frameMs: avg(ft), gpuPct: avg(gpu) };
  };
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  await sleep(1500);
  const rows = [{ name: 'none (cut, idle)', ...(await sample(3000)) }];
  let scene = 'a';
  for (const s of [...STYLES, 'fade']) {
    await c.call('transitions.set', { canvas: 'H', type: s, durationMs: 8000 });
    scene = scene === 'a' ? 'b' : 'a';
    await c.call('scenes.activate', { scene });
    await sleep(1500);
    rows.push({ name: s, ...(await sample(4000)) });
    await c.call('transitions.forceComplete', { canvas: 'H' });
  }
  const f = (v, d = 3) => (v == null ? 'n/a' : v.toFixed(d));
  console.log('| transition | frame ms | +ms vs idle | GPU % |');
  console.log('|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${f(r.frameMs)} | ${f(r.frameMs - rows[0].frameMs)} | ${f(r.gpuPct, 0)} |`);
  for (const r of rows) assert.ok(r.frameMs < 1000 / 60, `${r.name}: fits a 60 fps frame`);
});
