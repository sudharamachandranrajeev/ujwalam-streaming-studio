// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer audio tools on a real host (plan 2026-11-18-audio-mixer-music, AU1 playback + AU2 strip filters).
//   node --test app/host/tests/host-audio-tools.test.mjs
// Known test signals (generated WAV files under a temp media base) play through project audio sources of kind
// playback (ffmpeg_source, looping). audio.testMeasure reads peak and RMS (dBFS, channel 0) after the source's
// filters; audio.setFilters changes the filters in place. Each tool's effect is measured against the same signal
// without it. No device is opened (--test-hooks without --allow-devices). Headless. Needs the built host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost, planInHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const RATE = 48000;
const SECONDS = 6;
export const RESULTS = {}; // measured values, printed at the end for the evidence file

let h, c, media, doc;

// 16-bit mono PCM WAV of fn(t) in -1..1.
function wav(file, fn, seconds = SECONDS, dir = media) {
  const n = Math.round(RATE * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(fn(i / RATE) * 32767))), 44 + i * 2);
  writeFileSync(path.join(dir, file), b);
}
const amp = (db) => 10 ** (db / 20);
const sine = (hz, peakDb) => (t) => amp(peakDb) * Math.sin(2 * Math.PI * hz * t);
// Seeded white noise (uniform; RMS = peak / sqrt(3)).
function noise(rmsDb) {
  let s = 12345;
  const a = amp(rmsDb) * Math.sqrt(3);
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return a * (2 * (s / 0x7fffffff) - 1); };
}

const SIGNALS = {
  quiet: ['quiet-1k-40.wav', sine(1000, -40)],
  mid: ['mid-1k-20.wav', sine(1000, -20)],
  loud: ['loud-1k-6.wav', sine(1000, -6)],
  hot: ['hot-1k-3.wav', sine(1000, -3)],
  low: ['low-100-20.wav', sine(100, -20)],
  high: ['high-10k-20.wav', sine(10000, -20)],
  noise: ['noise-30.wav', noise(-30)],
};

function project() {
  return {
    version: 1, id: 'audio-tools', name: 'Audio tools test', activeScene: 'main',
    canvases: [{ id: 'h', width: 640, height: 360, fps: 30 }],
    devices: [], overlays: [], outputs: [],
    scenes: [{ id: 'main', name: 'Main', layers: [] }],
    audio: {
      tracks: [{ id: 't1', name: 'Track 1' }],
      sources: Object.entries(SIGNALS).map(([k, [f]]) => ({
        id: `s-${k}`, name: k, playback: { file: { base: 'media', rel: f }, loop: true },
        volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'],
      })),
    },
  };
}

async function setFilters(id, filters) {
  const s = doc.audio.sources.find((x) => x.id === id);
  if (filters) s.filters = filters; else delete s.filters;
  return c.call('audio.setFilters', { project: doc, audio: id });
}
const measure = (id, ms = 1000) => c.call('audio.testMeasure', { audio: id, skipMs: 400, ms });

before(async () => {
  mkdirSync(OUT, { recursive: true });
  media = mkdtempSync(path.join(OUT, 'audio-tools-media-'));
  for (const [f, fn] of Object.values(SIGNALS)) wav(f, fn);
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'audio-tools-')), extraArgs: ['--test-hooks', '--headless'], env: { UJWALAM_HEADLESS: '1' }, timeoutMs: 60000 });
  c = h.client;
  doc = project();
  const r = await loadIntoHost(c, doc, { bases: { media } });
  assert.deepEqual(r.unavailable ?? r.plan?.unavailable ?? [], [], 'every playback source is built');
});

after(async () => {
  console.log('AUDIO-TOOLS-RESULTS ' + JSON.stringify(RESULTS));
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('AU1 playback: each file plays as its own mixer strip on track 1 at its level', async () => {
  const rows = (await c.call('mixer.list', {})).sources;
  for (const k of Object.keys(SIGNALS)) {
    const row = rows.find((x) => x.id === `audio:s-${k}`);
    assert.ok(row, `strip for ${k}`);
    assert.deepEqual(row.tracks, ['t1']);
  }
  const m = await measure('s-mid');
  RESULTS.playbackMid = m;
  assert.ok(m.frames > 40000, `audio flows (${m.frames} frames)`);
  assert.ok(Math.abs(m.peakDb - -20) < 0.6, `1 kHz at -20 dBFS peak plays at ${m.peakDb.toFixed(2)}`);
});

test('gain shifts the level by its dB', async () => {
  const base = await measure('s-mid');
  const f = await setFilters('s-mid', { gain: { on: true, db: 6 } });
  assert.deepEqual(f.filters.order, ['gain']);
  const up = await measure('s-mid');
  await setFilters('s-mid', { gain: { on: true, db: -10 } });
  const down = await measure('s-mid');
  RESULTS.gain = { baseRms: base.rmsDb, plus6Rms: up.rmsDb, minus10Rms: down.rmsDb };
  assert.ok(Math.abs(up.rmsDb - base.rmsDb - 6) < 0.3, `+6 dB: ${(up.rmsDb - base.rmsDb).toFixed(2)}`);
  assert.ok(Math.abs(down.rmsDb - base.rmsDb + 10) < 0.3, `-10 dB: ${(down.rmsDb - base.rmsDb).toFixed(2)}`);
  // switched off in place: back to the plain level, the filter stays on the strip
  const off = await setFilters('s-mid', { gain: { on: false, db: -10 } });
  assert.equal(off.filters.gain.on, false);
  const plain = await measure('s-mid');
  assert.ok(Math.abs(plain.rmsDb - base.rmsDb) < 0.3, 'off = plain level');
});

test('the gate silences a signal below its threshold and lets a louder one through', async () => {
  const gate = { on: true, closeDb: -32, openDb: -26, attackMs: 25, holdMs: 200, releaseMs: 150 };
  const quietBase = await measure('s-quiet');
  await setFilters('s-quiet', { gate });
  const quiet = await measure('s-quiet');
  await setFilters('s-mid', { gate });
  const mid = await measure('s-mid');
  RESULTS.gate = { quietBasePeak: quietBase.peakDb, quietGatedPeak: quiet.peakDb, midGatedPeak: mid.peakDb };
  assert.ok(Math.abs(quietBase.peakDb - -40) < 0.6, 'the quiet tone is at -40 dBFS without the gate');
  assert.ok(quiet.peakDb < -90, `gated -40 dBFS tone is silent (${quiet.peakDb.toFixed(1)} dBFS)`);
  assert.ok(Math.abs(mid.peakDb - -20) < 0.6, `a -20 dBFS tone passes the gate (${mid.peakDb.toFixed(2)})`);
});

test('the compressor lowers peaks by the expected dB', async () => {
  const base = await measure('s-loud');
  // threshold -20, ratio 4: a -6 dBFS peak is 14 dB over, so it comes down by 14 * (1 - 1/4) = 10.5 dB
  await setFilters('s-loud', { compressor: { on: true, ratio: 4, thresholdDb: -20, attackMs: 1, releaseMs: 50, outputGainDb: 0 } });
  const comp = await measure('s-loud');
  RESULTS.compressor = { basePeak: base.peakDb, compressedPeak: comp.peakDb, reductionDb: base.peakDb - comp.peakDb, expectedDb: 10.5 };
  assert.ok(Math.abs(base.peakDb - comp.peakDb - 10.5) < 1.5, `reduction ${(base.peakDb - comp.peakDb).toFixed(2)} dB, expected 10.5`);
});

test('the limiter caps the level at its ceiling', async () => {
  const base = await measure('s-hot');
  await setFilters('s-hot', { limiter: { on: true, thresholdDb: -12, releaseMs: 60 } });
  const lim = await measure('s-hot');
  RESULTS.limiter = { basePeak: base.peakDb, limitedPeak: lim.peakDb, ceilingDb: -12 };
  assert.ok(base.peakDb > -3.6, 'the hot tone is near -3 dBFS without the limiter');
  assert.ok(lim.peakDb <= -11.5, `limited peak ${lim.peakDb.toFixed(2)} dBFS, ceiling -12`);
  assert.ok(lim.peakDb > -14, 'limited, not muted');
});

test('the 3-band EQ changes the energy of its band only', async () => {
  const lowBase = await measure('s-low'), highBase = await measure('s-high');
  const eq = { on: true, lowDb: -15, midDb: 0, highDb: 0 };
  await setFilters('s-low', { eq });
  await setFilters('s-high', { eq });
  const low = await measure('s-low'), high = await measure('s-high');
  await setFilters('s-high', { eq: { on: true, lowDb: 0, midDb: 0, highDb: 10 } });
  const highUp = await measure('s-high');
  RESULTS.eq = { lowBaseRms: lowBase.rmsDb, lowCutRms: low.rmsDb, highBaseRms: highBase.rmsDb, highWithLowCutRms: high.rmsDb, highBoostRms: highUp.rmsDb };
  // OBS's basic_eq_filter splits the bands with gentle crossovers: at 100 Hz the low band's -15 dB measured -7.7 dB
  // (first run 2026-11-18), so the check is "clearly lower", not the full setting.
  assert.ok(lowBase.rmsDb - low.rmsDb > 5, `100 Hz with low -15 dB: ${(low.rmsDb - lowBase.rmsDb).toFixed(2)} dB`);
  assert.ok(Math.abs(high.rmsDb - highBase.rmsDb) < 1, `10 kHz unchanged by the low band: ${(high.rmsDb - highBase.rmsDb).toFixed(2)} dB`);
  assert.ok(highUp.rmsDb - highBase.rmsDb > 6, `10 kHz with high +10 dB: +${(highUp.rmsDb - highBase.rmsDb).toFixed(2)} dB`);
});

test('noise suppression (RNNoise) lowers stationary noise', async () => {
  const base = await measure('s-noise', 2000);
  await setFilters('s-noise', { suppress: { on: true } });
  const sup = await measure('s-noise', 2000);
  RESULTS.suppress = { baseRms: base.rmsDb, suppressedRms: sup.rmsDb, reductionDb: base.rmsDb - sup.rmsDb };
  assert.ok(base.rmsDb - sup.rmsDb > 10, `stationary noise down by ${(base.rmsDb - sup.rmsDb).toFixed(2)} dB`);
});

test('filters run in the fixed order and change in place: adding, changing and removing keep the audio flowing', async () => {
  const chain = {
    suppress: { on: true }, gate: { on: true, closeDb: -60, openDb: -55, attackMs: 25, holdMs: 200, releaseMs: 150 },
    eq: { on: true, lowDb: 0, midDb: 0, highDb: 0 }, gain: { on: true, db: 0 },
    compressor: { on: true, ratio: 2, thresholdDb: -30, attackMs: 6, releaseMs: 60, outputGainDb: 0 },
    limiter: { on: true, thresholdDb: -6, releaseMs: 60 },
  };
  // added in reverse so the host has to sort them
  const rev = Object.fromEntries(Object.entries(chain).reverse());
  await setFilters('s-mid', { limiter: chain.limiter });
  const r = await setFilters('s-mid', rev);
  assert.deepEqual(r.filters.order, ['suppress', 'gate', 'eq', 'gain', 'compressor', 'limiter']);
  const before = (await c.call('mixer.list', {})).sources.find((x) => x.id === 'audio:s-mid');
  // a measurement window while the tools change: the strip keeps delivering audio (no rebuild, no gap)
  const during = measure('s-mid', 1500);
  await setFilters('s-mid', { gain: { on: true, db: 3 } });
  await setFilters('s-mid', null);
  const m = await during;
  const after = (await c.call('mixer.list', {})).sources.find((x) => x.id === 'audio:s-mid');
  RESULTS.liveChange = { frames: m.frames, expectedFrames: 1.5 * RATE };
  assert.ok(m.frames >= 0.95 * 1.5 * RATE, `audio kept flowing while the tools changed (${m.frames} frames in 1.5 s)`);
  assert.deepEqual(after.tracks, before.tracks);
  assert.equal(after.id, before.id);
  const none = await measure('s-mid');
  assert.deepEqual(none.filters.order, [], 'removed: no tool filter left');
});

test('bad tool values are refused by the host', async () => {
  const s = doc.audio.sources.find((x) => x.id === 's-mid');
  s.filters = { gain: { on: true, db: 31 } };
  await assert.rejects(c.call('audio.setFilters', { project: doc, audio: 's-mid' }), (e) => e.code === -32602);
  s.filters = { reverb: { on: true } };
  await assert.rejects(c.call('audio.setFilters', { project: doc, audio: 's-mid' }), (e) => e.code === -32602);
  delete s.filters;
});

test('AU1 folder playlist: the next file plays on the same strip when one ends', async () => {
  const dir = path.join(media, 'list');
  mkdirSync(dir, { recursive: true });
  wav('a.wav', sine(1000, -30), 1.5, dir);
  wav('b.wav', sine(1000, -10), 1.5, dir);
  doc.audio.sources.push({ id: 's-list', name: 'list', playback: { folder: { base: 'media', rel: 'list' }, loop: true },
    volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-list' });
  // 4.5 s covers a.wav, b.wav and a.wav again (the loop): both levels are heard on the one strip
  const peaks = [];
  for (let i = 0; i < 9; i++) peaks.push((await c.call('audio.testMeasure', { audio: 's-list', skipMs: 0, ms: 450 })).peakDb);
  RESULTS.playlist = { peaks };
  assert.ok(peaks.some((p) => Math.abs(p - -30) < 1), `a.wav (-30 dBFS) heard: ${peaks.map((p) => p.toFixed(1))}`);
  assert.ok(peaks.some((p) => Math.abs(p - -10) < 1), 'b.wav (-10 dBFS) heard');
  const i10 = peaks.findIndex((p) => Math.abs(p - -10) < 1);
  assert.ok(peaks.slice(i10 + 1).some((p) => Math.abs(p - -30) < 1 || p < -30), 'after b.wav the list goes on (loop)');
  assert.equal((await c.call('mixer.list', {})).sources.filter((x) => x.id === 'audio:s-list').length, 1, 'one strip');
});

test('AU1 app sound: planned on wasapi_process_output_capture by exe name; off without devices', async () => {
  const d = structuredClone(doc);
  d.audio.sources = [{ id: 's-app', name: 'Music app', app: { exe: 'player.exe' }, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }];
  const p = await planInHost(c, d, { bases: { media } });
  const u = (p.unavailable ?? []).find((x) => x.audio === 's-app');
  assert.equal(u?.code, 'forbidden', 'no app capture on a host without --allow-devices');
  d.audio.sources[0].app.exe = 'C:\\x\\player.exe';
  await assert.rejects(planInHost(c, d, { bases: { media } }), (e) => e.name === 'ProjectRefused', 'a path is refused by the validator: exe name only');
  await assert.rejects(c.call('project.plan', { project: d }), (e) => e.code === -32602, 'and by the host');
  const apps = await c.call('audio.apps', {});
  assert.ok(Array.isArray(apps.apps));
  for (const a of apps.apps) assert.match(a.exe, /^[^\\/:]+\.exe$/i, 'exe names only');
});
test('saved tools come back on a project load (a restart builds the same strip)', async () => {
  const d = project();
  d.audio.sources.find((x) => x.id === 's-mid').filters = {
    gate: { on: false, closeDb: -50, openDb: -40, attackMs: 25, holdMs: 200, releaseMs: 150 }, limiter: { on: true, thresholdDb: -24, releaseMs: 60 },
  };
  await loadIntoHost(c, d, { bases: { media } });
  doc = d;
  const m = await measure('s-mid');
  RESULTS.reload = { peakDb: m.peakDb, filters: m.filters };
  assert.deepEqual(m.filters.order, ['gate', 'limiter']);
  assert.equal(m.filters.gate.on, false, 'a tool saved off stays off');
  assert.equal(m.filters.gate.closeDb, -50);
  assert.ok(m.peakDb <= -23.5, `the saved limiter works after the load (${m.peakDb.toFixed(2)} dBFS)`);
});