// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer audio tools on a real host (plan 2026-11-18-audio-mixer-music, AU1 playback + AU2 strip filters).
//   node --test app/host/tests/host-audio-tools.test.mjs
// Known test signals (generated WAV files under a temp media base) play through project audio sources of kind
// playback (ffmpeg_source, looping). audio.testMeasure reads peak and RMS (dBFS, channel 0) after the source's
// filters; audio.setFilters changes the filters in place. Each tool's effect is measured against the same signal
// without it. No device is opened (--test-hooks without --allow-devices). Headless. Needs the built host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The host process's thread count (Windows; no console window).
const threads = () => Number(execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${h.child.pid}).Threads.Count`], { windowsHide: true }).toString().trim());
const row = async (id) => (await c.call('mixer.list', {})).sources.find((x) => x.id === `audio:${id}`);

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
  // RNNoise adapts to the noise over its first second or so: measured after that (one run under CPU load measured
  // 7.6 dB with a 0.4 s wait, 15.2 dB alone; 2026-11-18 review rerun)
  const sup = await c.call('audio.testMeasure', { audio: 's-noise', skipMs: 2000, ms: 2000 });
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
// ---- review fixes (Codex review of AU1/AU2, 2026-11-18) ----

test('tool edits during scene switches: the list changes run on the graphics thread; the host keeps running', async () => {
  // libobs walks a source's filters without its filter mutex in the video tick when the source is shown or hidden;
  // a layer's sound is shown and hidden by every scene switch. Edits and switches are sent together, 40 rounds.
  wav('layer-tone.wav', sine(1000, -20));
  const d = project();
  d.scenes = [
    { id: 'main', name: 'Main', layers: [{ id: 'tl', type: 'media', name: 'Tone', source: { file: { base: 'media', rel: 'layer-tone.wav' }, loop: true },
      placements: { h: { visible: true, x: 0, y: 0, width: 64, height: 36 } } }] },
    { id: 'other', name: 'Other', layers: [] },
  ];
  d.audio.sources = [{ id: 's-layer', name: 'layer', layer: 'tl', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }];
  await loadIntoHost(c, d, { bases: { media } });
  doc = d;
  const full = {
    gate: { on: true, closeDb: -60, openDb: -55, attackMs: 25, holdMs: 200, releaseMs: 150 }, gain: { on: true, db: 0 },
    compressor: { on: true, ratio: 2, thresholdDb: -30, attackMs: 6, releaseMs: 60, outputGainDb: 0 }, limiter: { on: true, thresholdDb: -6, releaseMs: 60 },
  };
  for (let i = 0; i < 40; i++)
    await Promise.all([c.call('scenes.activate', { scene: i % 2 ? 'main' : 'other' }), setFilters('s-layer', i % 2 ? full : { limiter: full.limiter })]);
  await c.call('scenes.activate', { scene: 'main' });
  const last = await setFilters('s-layer', full);
  const m = await measure('s-layer');
  RESULTS.sceneSwitchEdits = { rounds: 40, frames: m.frames, order: m.filters.order };
  assert.deepEqual(last.filters.order, ['gate', 'gain', 'compressor', 'limiter']);
  assert.ok(m.frames > 40000, `the layer's sound flows after the switches (${m.frames} frames)`);
});

test('an unchanged tool is not updated again: changing the gain leaves an open gate open', async () => {
  const d = project();
  await loadIntoHost(c, d, { bases: { media } });
  doc = d;
  // gate open (the -20 dBFS tone is far over -55), then only the gain changes: the gate must not close and reopen
  const gate = { on: true, closeDb: -60, openDb: -55, attackMs: 500, holdMs: 0, releaseMs: 150 };
  await setFilters('s-mid', { gate, gain: { on: true, db: 0 } });
  await sleep(1000);
  const during = c.call('audio.testMeasure', { audio: 's-mid', skipMs: 100, ms: 600 });
  await setFilters('s-mid', { gate, gain: { on: true, db: -1 } });
  const m = await during;
  RESULTS.unchangedGate = { rmsDb: m.rmsDb, frames: m.frames };
  // a gate closed by an update would reopen over its 500 ms attack: the window's level would drop far below -24 dB RMS
  assert.ok(m.rmsDb > -24.5, `the gate stayed open (RMS ${m.rmsDb.toFixed(2)} dBFS over the change)`);
});

test('a gate whose close level is above its open level is refused; "#" in an exe name is refused', async () => {
  const s = doc.audio.sources.find((x) => x.id === 's-mid');
  s.filters = { gate: { on: true, closeDb: -20, openDb: -30, attackMs: 25, holdMs: 200, releaseMs: 150 } };
  await assert.rejects(c.call('audio.setFilters', { project: doc, audio: 's-mid' }), (e) => e.code === -32602);
  delete s.filters;
  const d = structuredClone(doc);
  d.audio.sources = [{ id: 's-app', name: 'App', app: { exe: 'a#3Ab.exe' }, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }];
  await assert.rejects(c.call('project.plan', { project: d }), (e) => e.code === -32602);
});

test('sound files come from the media base only', async () => {
  const d = structuredClone(doc);
  d.audio.sources = [{ id: 's-data', name: 'Data', playback: { file: { base: 'data', rel: 'x.wav' }, loop: true }, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }];
  await assert.rejects(planInHost(c, d, { bases: { media } }), (e) => e.name === 'ProjectRefused', 'the validator refuses base data');
  await assert.rejects(c.call('project.plan', { project: d }), (e) => e.code === -32602, 'and the host');
});

test('a playlist of files that cannot play stops after one pass ("unavailable"), with no thread growth', async () => {
  const dir = path.join(media, 'bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'x.wav'), Buffer.from('not a sound file at all'));
  writeFileSync(path.join(dir, 'y.mp3'), Buffer.from('nor is this one'));
  const t0 = threads();
  doc.audio.sources.push({ id: 's-bad', name: 'bad', playback: { folder: { base: 'media', rel: 'bad' }, loop: true },
    volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-bad' });
  let r;
  for (let i = 0; i < 50 && (r = await row('s-bad'))?.playlist?.state !== 'unavailable'; i++) await sleep(200);
  assert.equal(r?.playlist?.state, 'unavailable', `stopped: ${JSON.stringify(r?.playlist)}`);
  const at = r.playlist.at;
  await sleep(2000);
  const t1 = threads();
  const later = await row('s-bad');
  RESULTS.badPlaylist = { playlist: later.playlist, threadsBefore: t0, threadsAfter: t1 };
  assert.equal(later.playlist.at, at, 'no file is opened again');
  assert.ok(t1 <= t0 + 4, `threads ${t0} -> ${t1}`);
});

test('a link in a playlist folder that points out of the media folder is left out', async (t) => {
  const outside = mkdtempSync(path.join(OUT, 'audio-tools-outside-'));
  wav('out.wav', sine(1000, -5), 1.5, outside);
  const dir = path.join(media, 'linked');
  mkdirSync(dir, { recursive: true });
  wav('in-a.wav', sine(1000, -25), 1.5, dir);
  wav('in-b.wav', sine(1000, -28), 1.5, dir);
  try { symlinkSync(path.join(outside, 'out.wav'), path.join(dir, 'link.wav'), 'file'); } catch (e) {
    t.skip(`no symlink right on this account (${e.code})`); return;
  }
  doc.audio.sources.push({ id: 's-linked', name: 'linked', playback: { folder: { base: 'media', rel: 'linked' }, loop: true },
    volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-linked' });
  const r = await row('s-linked');
  assert.equal(r.playlist?.files, 2, 'the link is not in the list');
  const peaks = [];
  for (let i = 0; i < 8; i++) peaks.push((await c.call('audio.testMeasure', { audio: 's-linked', skipMs: 0, ms: 450 })).peakDb);
  RESULTS.linkedPlaylist = { peaks };
  assert.ok(peaks.every((p) => p < -20), `the -5 dBFS file outside media never plays: ${peaks.map((p) => p.toFixed(1))}`);
});
test('a playlist folder that is a junction out of the media folder is refused (no link right needed)', async () => {
  const outside = mkdtempSync(path.join(OUT, 'audio-tools-outside-'));
  wav('o1.wav', sine(1000, -5), 1, outside);
  wav('o2.wav', sine(1000, -5), 1, outside);
  symlinkSync(outside, path.join(media, 'jout'), 'junction');
  const d = structuredClone(doc);
  d.audio.sources = [{ id: 's-j', name: 'j', playback: { folder: { base: 'media', rel: 'jout' }, loop: true }, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] }];
  const p = await planInHost(c, d, { bases: { media } });
  const u = (p.unavailable ?? []).find((x) => x.audio === 's-j');
  assert.equal(u?.code, 'unavailable', JSON.stringify(p.unavailable));
});
// ---- AU3 ducking ----

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

test('AU3 duck: music dips by about the amount while the mic talks, within attack, and comes back within release', async () => {
  wav('duck-music.wav', sine(1000, -20));
  wav('duck-mic.wav', sine(300, -10));
  const d = project();
  d.audio.sources = [
    { id: 's-music', name: 'Music', playback: { file: { base: 'media', rel: 'duck-music.wav' }, loop: true }, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] },
    { id: 's-mic', name: 'Mic', playback: { file: { base: 'media', rel: 'duck-mic.wav' }, loop: true }, volumeDb: 0, muted: true, monitoring: 'off', tracks: ['t1'] },
  ];
  await loadIntoHost(c, d, { bases: { media } });
  doc = d;
  const duck = { on: true, source: 's-mic', amountDb: 12, attackMs: 10, releaseMs: 400 };
  const r = await setFilters('s-music', { duck });
  assert.equal(r.duck.active, true, JSON.stringify(r.duck));
  assert.equal(r.filters.duck.sidechain, 'ujw:audio:s-mic');
  await sleep(500);
  const BIN = 10;
  const mus = c.call('audio.testMeasure', { audio: 's-music', skipMs: 0, ms: 3000, binMs: BIN });
  const mic = c.call('audio.testMeasure', { audio: 's-mic', skipMs: 0, ms: 3000, binMs: BIN });
  await sleep(800);
  await c.call('mixer.setMute', { id: 'audio:s-mic', muted: false });
  await sleep(1000);
  await c.call('mixer.setMute', { id: 'audio:s-mic', muted: true });
  const [m, k] = await Promise.all([mus, mic]);
  const off = Math.round((k.startMs - m.startMs) / BIN); // mic bin i = music bin i + off
  const on = k.bins.findIndex((v) => v > -30) + off;
  const endI = k.bins.length - 1 - [...k.bins].reverse().findIndex((v) => v > -30);
  const end = endI + 1 + off;
  const base = median(m.bins.slice(5, on - 2));
  const dipped = median(m.bins.slice(on + 20, end - 5));
  const dip = base - dipped;
  // the mic's audio reaches the music's compressor through libobs's sidechain buffer, a little later than its own
  // capture: that delay is reported (latencyMs); the attack is timed from the first dipped bin to the full dip
  const startBins = m.bins.slice(on).findIndex((v) => v <= base - 1);
  const attackBins = m.bins.slice(on + startBins).findIndex((v) => v <= base - 0.9 * dip);
  const backBins = m.bins.slice(end).findIndex((v) => v >= base - 1.5);
  RESULTS.duck = { setting: duck, baseDb: base, dippedDb: dipped, dipDb: dip, latencyMs: startBins * BIN, attackMs: attackBins * BIN, recoveryMs: backBins * BIN,
    obsAttackMs: r.filters.duck.obsAttackMs, obsReleaseMs: r.filters.duck.obsReleaseMs, ratio: r.filters.duck.ratio };
  assert.ok(Math.abs(dip - 12) < 2, `dip ${dip.toFixed(2)} dB, set 12`);
  assert.ok(startBins >= 0 && startBins * BIN <= 150, `the dip starts ${startBins * BIN} ms after the mic (sidechain buffer)`);
  assert.ok(attackBins >= 0 && attackBins * BIN <= duck.attackMs + 50, `full dip in ${attackBins * BIN} ms (attack ${duck.attackMs} ms; 10 ms bins, 21 ms blocks)`);
  assert.ok(backBins >= 0 && backBins * BIN <= duck.releaseMs + 50, `back within 1.5 dB in ${backBins * BIN} ms (release ${duck.releaseMs} ms)`);
});

test('AU3 duck: off with a plain reason while the mic is missing; on again when it is back; no rebuild', async () => {
  const mic = doc.audio.sources.find((x) => x.id === 's-mic');
  doc.audio.sources = doc.audio.sources.filter((x) => x.id !== 's-mic');
  await c.call('audio.removeFromProject', { project: doc, audio: 's-mic' });
  let row1 = await row('s-music');
  assert.equal(row1.duck.active, false);
  assert.match(row1.duck.reason, /^Off: /);
  // a sound that is gone does not compress the music on its own signal (-20 dBFS tone stays at -20)
  const m = await measure('s-music');
  assert.ok(Math.abs(m.peakDb - -20) < 0.6, `music at ${m.peakDb.toFixed(2)} while the mic is missing`);
  doc.audio.sources.push({ ...mic, muted: false });
  await c.call('audio.addFromProject', { project: doc, audio: 's-mic' });
  row1 = await row('s-music');
  assert.equal(row1.duck.active, true, JSON.stringify(row1.duck));
  await sleep(500);
  const m2 = await measure('s-music');
  RESULTS.duckReconnect = { missingPeak: m.peakDb, backPeak: m2.peakDb, reason: (await row('s-music')).duck.reason };
  assert.ok(m2.peakDb < -28, `ducking again after the mic came back (${m2.peakDb.toFixed(2)} dBFS)`);
  assert.equal((await c.call('mixer.list', {})).sources.filter((x) => x.id === 'audio:s-music').length, 1, 'same strip');
});

test('AU3 duck: a strip never ducks under itself; the host refuses a bad source id', async () => {
  const s = doc.audio.sources.find((x) => x.id === 's-music');
  s.filters = { duck: { on: true, source: 'Bad Id', amountDb: 12, attackMs: 10, releaseMs: 400 } };
  await assert.rejects(c.call('audio.setFilters', { project: doc, audio: 's-music' }), (e) => e.code === -32602);
  s.filters = { duck: { on: true, source: 's-mic', amountDb: 19, attackMs: 10, releaseMs: 400 } };
  await assert.rejects(c.call('audio.setFilters', { project: doc, audio: 's-music' }), (e) => e.code === -32602);
  delete s.filters;
});

// ---- review round 2 ----

test('AU3 duck: a rebind never compresses the music on its own signal (off until the new sound is bound)', async () => {
  // both mics muted: the sidechain is silence, so a bound duck leaves the -20 dBFS tone alone; an unbound one that
  // ran would compress it on itself (threshold -30 dB, ratio 2.5: about 6 dB down)
  delete doc.audio.sources.find((x) => x.id === 's-music').filters;
  doc.audio.sources.find((x) => x.id === 's-mic').muted = true;
  await c.call('mixer.setMute', { id: 'audio:s-mic', muted: true });
  doc.audio.sources.push({ id: 's-mic2', name: 'Mic 2', playback: { file: { base: 'media', rel: 'duck-mic.wav' }, loop: true }, volumeDb: 0, muted: true, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-mic2' });
  await setFilters('s-music', { duck: { on: true, source: 's-mic', amountDb: 12, attackMs: 1, releaseMs: 400 } });
  await sleep(1500); // the dip of the last test (the mic was talking) is fully released
  const BIN = 10;
  const mus = c.call('audio.testMeasure', { audio: 's-music', skipMs: 0, ms: 4000, binMs: BIN });
  const t0 = Date.now(); const marks = [];
  await sleep(200);
  for (let i = 0; i < 12; i++) {
    marks.push(Date.now() - t0);
    await setFilters('s-music', { duck: { on: true, source: i % 2 ? 's-mic' : 's-mic2', amountDb: 12, attackMs: 1, releaseMs: 400 } });
    await sleep(120);
  }
  // the sound it ducks under goes and comes back (the clear and the rebind of the watchdog path)
  const mic2 = doc.audio.sources.find((x) => x.id === 's-mic2');
  doc.audio.sources = doc.audio.sources.filter((x) => x.id !== 's-mic2');
  marks.push(Date.now() - t0);
  await c.call('audio.removeFromProject', { project: doc, audio: 's-mic2' });
  marks.push(Date.now() - t0);
  doc.audio.sources.push(mic2);
  await c.call('audio.addFromProject', { project: doc, audio: 's-mic2' });
  const m = await mus;
  const base = median(m.bins);
  const low = Math.min(...m.bins);
  RESULTS.duckRebind = { baseDb: base, lowestBinDb: low, bins: m.bins.length, marks, dips: m.bins.map((v, i) => [i * BIN, v]).filter(([, v]) => v < base - 0.3) };
  assert.ok(Math.abs(base - -20) < 0.6, `music at ${base.toFixed(2)} dBFS`);
  assert.ok(low > base - 1, `no bin dips (lowest ${low.toFixed(2)} dBFS, ${(base - low).toFixed(2)} dB under)`);
});

test('removing a boost while its limiter goes off never lets the full boost through', async () => {
  const lim = { on: true, thresholdDb: -12, releaseMs: 60 };
  const boosted = { gain: { on: true, db: 30 }, limiter: lim };
  const plain = { limiter: { ...lim, on: false } };
  await setFilters('s-music', boosted);
  await sleep(300);
  const BIN = 10;
  const mus = c.call('audio.testMeasure', { audio: 's-music', skipMs: 0, ms: 4000, binMs: BIN });
  for (let i = 0; i < 16; i++) {
    await setFilters('s-music', i % 2 ? boosted : plain);
    await sleep(100);
  }
  const m = await mus;
  const high = Math.max(...m.bins);
  RESULTS.boostRemoval = { highestBinDb: high, bins: m.bins.length };
  // -20 dBFS + 30 dB = +10 dBFS unlimited; capped at -12 by the limiter; -20 without the boost
  assert.ok(high < -6, `highest bin ${high.toFixed(2)} dBFS`);
  await setFilters('s-music', null);
});

test('a playlist whose first file cannot play goes on to the second (one end counted per file)', async () => {
  const dir = path.join(media, 'firstbad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a-bad.wav'), Buffer.from('not a sound file at all'));
  wav('b-good.wav', sine(1000, -25), 1.5, dir);
  doc.audio.sources.push({ id: 's-firstbad', name: 'firstbad', playback: { folder: { base: 'media', rel: 'firstbad' }, loop: true },
    volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-firstbad' });
  const peaks = [];
  for (let i = 0; i < 8; i++) peaks.push((await c.call('audio.testMeasure', { audio: 's-firstbad', skipMs: 0, ms: 450 })).peakDb);
  const r = await row('s-firstbad');
  RESULTS.firstBadPlaylist = { peaks, playlist: r.playlist };
  assert.equal(r.playlist?.state, 'playing', JSON.stringify(r.playlist));
  assert.ok(peaks.some((p) => Math.abs(p - -25) < 1), `the good file plays: ${peaks.map((p) => p.toFixed(1))}`);
});

test('a playlist whose other files are gone restarts the same file (no silence)', async () => {
  const dir = path.join(media, 'samefile');
  mkdirSync(dir, { recursive: true });
  wav('x1.wav', sine(1000, -25), 0.8, dir);
  wav('x2.wav', sine(1000, -25), 0.8, dir);
  doc.audio.sources.push({ id: 's-same', name: 'same', playback: { folder: { base: 'media', rel: 'samefile' }, loop: true },
    volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-same' });
  unlinkSync(path.join(dir, 'x2.wav'));
  await sleep(1000);
  const peaks = [];
  for (let i = 0; i < 8; i++) peaks.push((await c.call('audio.testMeasure', { audio: 's-same', skipMs: 0, ms: 450 })).peakDb);
  const r = await row('s-same');
  RESULTS.sameFilePlaylist = { peaks, playlist: r.playlist };
  assert.equal(r.playlist?.state, 'playing', JSON.stringify(r.playlist));
  assert.ok(peaks.every((p) => p > -30), `x1 keeps playing after x2 is gone: ${peaks.map((p) => p.toFixed(1))}`);
});
test('a broken file between two good ones never stalls the playlist (its early end is counted when it opens)', async () => {
  const dir = path.join(media, 'midbad');
  mkdirSync(dir, { recursive: true });
  wav('a-good.wav', sine(1000, -25), 0.8, dir);
  writeFileSync(path.join(dir, 'b-bad.wav'), Buffer.from('not a sound file at all'));
  wav('c-good.wav', sine(1000, -22), 0.8, dir);
  doc.audio.sources.push({ id: 's-midbad', name: 'midbad', playback: { folder: { base: 'media', rel: 'midbad' }, loop: true },
    volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await c.call('audio.addFromProject', { project: doc, audio: 's-midbad' });
  const peaks = [];
  for (let i = 0; i < 14; i++) peaks.push((await c.call('audio.testMeasure', { audio: 's-midbad', skipMs: 0, ms: 450 })).peakDb);
  const r = await row('s-midbad');
  RESULTS.midBadPlaylist = { peaks, playlist: r.playlist };
  assert.equal(r.playlist?.state, 'playing', JSON.stringify(r.playlist));
  assert.ok(peaks.some((p) => Math.abs(p - -22) < 1), `the file after the broken one plays: ${peaks.map((p) => p.toFixed(1))}`);
  assert.ok(peaks.slice(-4).every((p) => p > -30), `still playing at the end (looped past the broken file): ${peaks.map((p) => p.toFixed(1))}`);
});