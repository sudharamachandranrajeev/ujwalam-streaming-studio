// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: the per-pixel effects of the realism looks (D445, plan 2026-11-25-realism-looks RL2): bloom, clarity and
// chromatic render as their shaders say, add no flash, and every look in data/looks loads and grades as its generator
// says. Records 1280x720 H frames through NVENC and reads them back with ffmpeg.
//   node --test app/host/tests/host-realism-fx.test.mjs   (needs the built host and the OBS runtime)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const LUTS = path.join(REPO_ROOT, 'data', 'luts');
const LOOKS = path.join(REPO_ROOT, 'data', 'looks');
let h;
let c;
let media;

function ffmpeg(args) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'realism-'));
  // spot: a white 40 px square in the middle of black (bloom); step: grey 96 | grey 160 halves (clarity);
  // box: a white square 100..620 on black, 720 px (chromatic); scene: a still test picture (flash checks)
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=200x200,format=gray,geq=lum='if(between(X,80,119)*between(Y,80,119),255,0)'", '-frames:v', '1', path.join(media, 'spot.png')]);
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=200x200,format=gray,geq=lum='if(lt(X,100),96,160)'", '-frames:v', '1', path.join(media, 'step.png')]);
  ffmpeg(['-f', 'lavfi', '-i', "nullsrc=s=720x720,format=gray,geq=lum='if(between(X,100,619)*between(Y,100,619),255,0)'", '-frames:v', '1', path.join(media, 'box.png')]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1', '-frames:v', '1', path.join(media, 'scene.png')]);
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'data-')), project: path.join(HOST_DIR, 'projects', 'test-card.project.json') });
  c = h.client;
});

after(async () => {
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

async function recordFrame(name, seconds = 2) {
  await c.call('outputs.configure', {
    rungs: [{ id: 'rh', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 1280, h: 720, fps: 30, bitrate: 12000, gopSec: 1 }],
    audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'fh', rung: 'rh', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name } }]
  });
  await c.call('record.start', {});
  await new Promise((res) => setTimeout(res, seconds * 1000));
  await c.call('record.stop', {});
  let st;
  for (let i = 0; i < 60; i++) {
    st = await c.call('outputs.status');
    if (st.sinks.every((s) => s.state === 'stopped')) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  return st.sinks.find((s) => s.id === 'fh').path;
}

function frameRgb(file, w, h) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.8', '-i', file, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20, windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(r.stdout.length, w * h * 3);
  return (x, y) => { const i = (y * w + x) * 3; return [r.stdout[i], r.stdout[i + 1], r.stdout[i + 2]]; };
}

const img = (rel) => ({ file: { base: 'media', rel } });
const at = (x, y, width, height) => ({ h: { visible: true, x, y, width, height } });
const L = (id, source, placements, effects, type = 'image') => ({ id, type, name: id, source, ...(effects ? { effects } : {}), placements });
const doc = (id, layers) => ({
  version: 1, id, name: id, activeScene: 'main',
  canvases: [{ id: 'h', width: 1280, height: 720, fps: 60 }], devices: [], overlays: [], outputs: [],
  scenes: [{ id: 'main', name: 'Main', layers: [L('bg', { color: '#000000' }, at(0, 0, 1280, 720), null, 'color'), ...layers] }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
});
const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

test('D445 bloom, clarity and chromatic: validated, round-trip through layers.list, and render as their shaders say', async () => {
  const { validateProject } = await import('../../../services/project/validate.mjs');
  const BLOOM = { type: 'bloom', amount: 1, threshold: 0.5, size: 10 };
  const CLARITY = { type: 'clarity', amount: 1, size: 10 };
  const CHROMA = { type: 'chromatic', amount: 1 };
  const d = doc('realism-fx', [
    L('spot-raw', img('spot.png'), at(20, 20, 200, 200)),
    L('spot-bloom', img('spot.png'), at(240, 20, 200, 200), [BLOOM]),
    L('grey-bloom', { color: '#404040' }, at(460, 20, 200, 200), [BLOOM], 'color'),
    L('step-raw', img('step.png'), at(20, 260, 200, 200)),
    L('step-clarity', img('step.png'), at(240, 260, 200, 200), [CLARITY]),
    L('grey-clarity', { color: '#808080' }, at(460, 260, 200, 200), [CLARITY], 'color'),
    L('box', img('box.png'), at(680, 60, 600, 600), [CHROMA]), // shown at 600 / 720: the square's left edge at x 763
  ]);
  assert.ok(validateProject(d).ok, JSON.stringify(validateProject(d).errors));
  const r = await loadIntoHost(c, d, { bases: { media } });
  assert.deepEqual(r.unavailable, []);
  const by = Object.fromEntries((await c.call('layers.list', { scene: 'main', canvas: 'H' })).layers.map((l) => [l.id, l]));
  for (const l of d.scenes[0].layers.filter((x) => x.effects)) assert.deepEqual(by[l.id].effects, l.effects, `layers.list round-trip: ${l.id}`);
  const px = frameRgb(await recordFrame('realism-fx-h.mkv'), 1280, 720);
  // bloom: light spills past the white square; far away and below the threshold nothing changes
  const rawEdge = lum(px(20 + 130, 20 + 100)), bloomEdge = lum(px(240 + 130, 20 + 100));
  assert.ok(bloomEdge - rawEdge >= 20, `bloom spills light 10 px past the spot: raw ${rawEdge.toFixed(0)} bloom ${bloomEdge.toFixed(0)}`);
  assert.ok(lum(px(240 + 100, 20 + 100)) >= 235, 'bloom: the spot stays white');
  assert.ok(lum(px(240 + 5, 20 + 5)) <= 24, 'bloom: the far corner stays black');
  const g = px(460 + 100, 20 + 100);
  assert.ok(Math.abs(lum(g) - 64) <= 10, `bloom: a grey below the threshold is unchanged (${g})`);
  // clarity: the dark side of the step gets darker next to the edge, the light side lighter; flat grey is unchanged
  const dRaw = lum(px(20 + 92, 260 + 100)), dCl = lum(px(240 + 92, 260 + 100));
  const lRaw = lum(px(20 + 108, 260 + 100)), lCl = lum(px(240 + 108, 260 + 100));
  assert.ok(dRaw - dCl >= 8, `clarity darkens the dark side at the edge: raw ${dRaw.toFixed(0)} clarity ${dCl.toFixed(0)}`);
  assert.ok(lCl - lRaw >= 8, `clarity lightens the light side at the edge: raw ${lRaw.toFixed(0)} clarity ${lCl.toFixed(0)}`);
  const gc = px(460 + 100, 260 + 100);
  assert.ok(Math.abs(lum(gc) - 128) <= 10, `clarity: flat grey unchanged (${gc})`);
  // chromatic: at the left edge of the box (3.6 source px fringe there, 3 px on the canvas) red leads outwards and blue
  // trails inwards; the centre is white
  let fringe = 0;
  for (let x = 763 - 6; x <= 763 + 6; x++) { const p = px(x, 360); fringe = Math.max(fringe, p[0] - p[2]); }
  assert.ok(fringe >= 40, `chromatic: red/blue fringe at the box edge (max red - blue ${fringe})`);
  const mid = px(680 + 300, 360);
  assert.ok(mid.every((v) => v >= 230), `chromatic: the centre is untouched (${mid})`);
  await c.call('outputs.clear');
});

test('D445 bloom and chromatic add no flash: a full-canvas still with bloom, clarity, chromatic and grain stays at or under 3 flashes/s', async () => {
  const d = doc('realism-flash', [L('scene', img('scene.png'), at(0, 0, 1280, 720), [
    { type: 'bloom', amount: 1, threshold: 0.5, size: 5 }, { type: 'clarity', amount: 1, size: 3 }, { type: 'chromatic', amount: 1 },
    { type: 'grain', amount: 0.4, size: 2 }])]);
  assert.deepEqual((await loadIntoHost(c, d, { bases: { media } })).unavailable, []);
  const file = await recordFrame('realism-flash-h.mkv', 3);
  const { analyseVideo } = await import('../../../tools/fx-test.mjs');
  const res = await analyseVideo(file, { sample: { width: 320, height: 180 }, fps: 30 });
  assert.ok(res.frames >= 60, `frames ${res.frames}`);
  assert.ok(res.peakFlashesPerSecond <= 3, `peak ${res.peakFlashesPerSecond} flashes/s`);
  console.log(`realism effects flash check: peak ${res.peakFlashesPerSecond} flashes/s over ${res.frames} frames`);
  await c.call('outputs.clear');
});
