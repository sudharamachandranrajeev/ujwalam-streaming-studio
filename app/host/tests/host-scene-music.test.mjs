// SPDX-License-Identifier: GPL-3.0-or-later
// Scene music on a real host (MU2, plan 2026-11-18-audio-mixer-music).
//   node --test app/host/tests/host-scene-music.test.mjs
// A temp music library (base "music") holds generated beds named after moods; the project has one Music strip
// (audio.sources[] { music: {} }) and scenes with music { on, mood, volumeDb }. audio.testMeasure (10 ms bins, after the
// strip's filters) measures what the strip plays across scene switches: the fade with the transition, the same bed
// kept across scenes, a cut, music off, a missing bed, a live level change and ducking under a voice. No device is
// opened (--test-hooks without --allow-devices). Headless. Needs the built host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const RATE = 48000;
const BIN = 10;
export const RESULTS = {};
let h, c, lib, media, doc;

function wav(file, fn, seconds = 8) {
  const n = Math.round(RATE * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(fn(i / RATE) * 32767))), 44 + i * 2);
  writeFileSync(file, b);
}
const amp = (db) => 10 ** (db / 20);
const sine = (hz, peakDb) => (t) => amp(peakDb) * Math.sin(2 * Math.PI * hz * t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const music = (on, mood, volumeDb = 0) => ({ on, mood, volumeDb });

function project() {
  return {
    version: 1, id: 'scene-music', name: 'Scene music test', activeScene: 'lobby',
    canvases: [{ id: 'h', width: 640, height: 360, fps: 30 }],
    devices: [], overlays: [], outputs: [],
    scenes: [
      { id: 'lobby', name: 'Lobby', layers: [], music: music(true, 'lobby') },
      { id: 'chat', name: 'Just chatting', layers: [], music: music(true, 'lobby', -6) },
      { id: 'match', name: 'In match', layers: [], music: music(true, 'in-match') },
      { id: 'quiet', name: 'Quiet', layers: [], music: music(false, 'lobby') },
      { id: 'brb', name: 'BRB', layers: [], music: music(true, 'brb') },
      { id: 'plain', name: 'No music field', layers: [] },
    ],
    audio: {
      tracks: [{ id: 't1', name: 'Track 1' }],
      sources: [
        { id: 'scene-music', name: 'Music', music: {}, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] },
        { id: 's-mic', name: 'Mic', playback: { file: { base: 'media', rel: 'mic.wav' }, loop: true }, volumeDb: 0, muted: true, monitoring: 'off', tracks: ['t1'] },
      ],
    },
  };
}

const status = () => c.call('music.status', {});
const idle = () => c.call('music.testWaitIdle', { ms: 5000 });
const measure = (ms) => c.call('audio.testMeasure', { audio: 'scene-music', skipMs: 0, ms, binMs: BIN });
// Switches to `scene` `atMs` into a binned measurement of `ms`.
async function across(scene, ms, atMs = 600) {
  const m = measure(ms);
  await sleep(atMs);
  await c.call('scenes.activate', { scene });
  return m;
}

before(async () => {
  mkdirSync(OUT, { recursive: true });
  lib = mkdtempSync(path.join(OUT, 'scene-music-lib-'));
  media = mkdtempSync(path.join(OUT, 'scene-music-media-'));
  wav(path.join(lib, 'lobby.wav'), sine(1000, -20));
  wav(path.join(lib, 'in-match.wav'), sine(440, -30));
  wav(path.join(media, 'mic.wav'), sine(300, -10));
  h = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'scene-music-')), extraArgs: ['--test-hooks', '--headless'], env: { UJWALAM_HEADLESS: '1' }, timeoutMs: 60000 });
  c = h.client;
  doc = project();
  const r = await loadIntoHost(c, doc, { bases: { media, music: lib } });
  assert.deepEqual(r.unavailable ?? r.plan?.unavailable ?? [], [], 'the music strip and the mic are built');
  await idle();
});

after(async () => {
  console.log('SCENE-MUSIC-RESULTS ' + JSON.stringify(RESULTS));
  if (!h) return;
  const r = await stopHost(h);
  assert.equal(r.code, 0, 'host exits 0');
});

test('the active scene\'s bed plays on the Music strip at its level', async () => {
  const s = await status();
  assert.equal(s.attached, true);
  assert.equal(s.mood, 'lobby');
  assert.equal(s.file, 'lobby.wav');
  assert.equal(s.playing, true);
  assert.equal(s.reason, '');
  const row = (await c.call('mixer.list', {})).sources.find((x) => x.id === 'audio:scene-music');
  assert.ok(row, 'one Music strip in the mixer');
  const m = await c.call('audio.testMeasure', { audio: 'scene-music', skipMs: 200, ms: 1000 });
  RESULTS.lobbyLevel = { peakDb: m.peakDb, rmsDb: m.rmsDb };
  assert.ok(Math.abs(m.peakDb - -20) < 0.6, `lobby bed at -20 dBFS peak: ${m.peakDb}`);
});

test('a 1000 ms fade: the old bed fades out until the switch, the new one fades in after it', async () => {
  await c.call('transitions.set', { canvas: 'H', type: 'fade', durationMs: 1000 });
  const m = await across('match', 3000);
  await idle();
  const b = m.bins;
  const base = median(b.slice(5, 50));
  // The level filter ramps sample by sample: no 10 ms bin above -35 dBFS may jump by 1.5 dB or more (a block-wise
  // gain would jump 2 to 5 dB every 85 ms, the size of ffmpeg_source's audio blocks).
  const start = b.findIndex((v, i) => i > 10 && v < base - 0.5); // the fade out begins
  const lowest = Math.min(...b);
  const low = b.indexOf(lowest); // the bed changes here
  const target = median(b.slice(-40));
  const reached = b.findIndex((v, i) => i > low && v >= target - 0.5);
  const outMs = (low - start) * BIN, inMs = (reached - low) * BIN, totalMs = (reached - start) * BIN;
  const jumps = b.slice(start, reached + 1).map((v, i, a) => (i && Math.min(v, a[i - 1]) > -35 ? Math.abs(v - a[i - 1]) : 0));
  const maxStepDb = Math.max(...jumps);
  RESULTS.fade1000 = { baseDb: base, targetDb: target, lowestDb: lowest, outMs, inMs, totalMs, maxStepDb };
  assert.ok(maxStepDb < 1.5, `smooth: largest 10 ms step above -35 dBFS is ${maxStepDb} dB`);
  assert.ok(Math.abs(base - -20) < 0.6 && Math.abs(target - -30) < 0.6, `lobby -20 -> in-match -30 (${base}, ${target})`);
  assert.ok(outMs >= 350 && outMs <= 650, `fade out ${outMs} ms (half of 1000)`);
  assert.ok(inMs >= 350 && inMs <= 700, `fade in ${inMs} ms (half of 1000)`);
  const s = await status();
  assert.deepEqual(s.lastFade, { outMs: 500, inMs: 500 });
  assert.equal(s.file, 'in-match.wav');
});

test('the same mood in the next scene keeps playing: only the level moves, no dip, no restart', async () => {
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  await c.call('scenes.activate', { scene: 'lobby' });
  await idle();
  await c.call('transitions.set', { canvas: 'H', type: 'fade', durationMs: 600 });
  const m = await across('chat', 2000);
  await idle();
  const b = m.bins;
  const before = median(b.slice(5, 50)), after = median(b.slice(-40));
  const lowest = Math.min(...b.slice(5));
  RESULTS.sameMood = { beforeDb: before, afterDb: after, lowestBinDb: lowest };
  assert.ok(Math.abs(before - -20) < 0.6 && Math.abs(after - -26) < 0.6, `-20 -> -26 dB (${before}, ${after})`);
  assert.ok(lowest > -26.6, `never below the new level (lowest ${lowest}): the bed was not restarted`);
});

test('a cut fades over a short fixed time (no click) and switches the bed', async () => {
  await c.call('transitions.set', { canvas: 'H', type: 'cut' });
  const m = await across('match', 1500);
  await idle();
  const b = m.bins;
  const base = median(b.slice(5, 50));
  const start = b.findIndex((v, i) => i > 10 && v < base - 1);
  const target = median(b.slice(-40));
  const reached = b.findIndex((v, i) => i > start && v >= target - 1 && i > start + 1);
  const quiet = b.slice(start, reached).filter((v) => v < -60).length;
  RESULTS.cut = { baseDb: base, targetDb: target, spanMs: (reached - start) * BIN, silentBins: quiet };
  assert.ok(Math.abs(target - -30) < 0.6, `in-match after the cut: ${target}`);
  assert.ok((reached - start) * BIN <= 150, `the cut's fade spans ${(reached - start) * BIN} ms`);
  assert.deepEqual((await status()).lastFade, { outMs: 25, inMs: 25 });
});

test('music off, a scene with no music, and a missing bed: silence with a plain reason', async () => {
  await c.call('scenes.activate', { scene: 'quiet' });
  await idle();
  let s = await status();
  assert.equal(s.playing, false);
  assert.match(s.reason, /off for this scene/);
  let m = await c.call('audio.testMeasure', { audio: 'scene-music', skipMs: 100, ms: 500 });
  assert.ok(m.peakDb < -90, `silent: ${m.peakDb}`);
  await c.call('scenes.activate', { scene: 'brb' });
  await idle();
  s = await status();
  assert.match(s.reason, /"brb" is not made yet/);
  m = await c.call('audio.testMeasure', { audio: 'scene-music', skipMs: 100, ms: 500 });
  assert.ok(m.peakDb < -90, `missing bed: silent (${m.peakDb})`);
  await c.call('scenes.activate', { scene: 'plain' });
  await idle();
  assert.match((await status()).reason, /off for this scene/);
  RESULTS.reasons = { brb: s.reason };
});

test('music.setScene changes the active scene\'s music live, refuses bad values', async () => {
  await c.call('scenes.activate', { scene: 'lobby' });
  await idle();
  let s = await c.call('music.setScene', { scene: 'lobby', music: music(true, 'lobby', -12) });
  await idle();
  let m = await c.call('audio.testMeasure', { audio: 'scene-music', skipMs: 100, ms: 500 });
  assert.ok(Math.abs(m.peakDb - -32) < 0.6, `lobby at -12 dB: ${m.peakDb}`);
  s = await c.call('music.setScene', { scene: 'lobby', music: music(true, 'lobby', 0) });
  await idle();
  assert.equal(s.scenes.lobby.volumeDb, 0);
  for (const bad of [{ scene: 'lobby', music: music(true, 'Bad Mood') }, { scene: 'lobby', music: music(true, 'lobby', 5) }, { scene: 'nope', music: null }, { scene: 'lobby' }]) {
    await assert.rejects(c.call('music.setScene', bad), (e) => e.code === -32602, JSON.stringify(bad));
  }
});

test('ducking under the voice works on the Music strip (its level runs before the duck)', async () => {
  const strip = doc.audio.sources.find((x) => x.id === 'scene-music');
  strip.filters = { duck: { on: true, source: 's-mic', amountDb: 12, attackMs: 10, releaseMs: 400 } };
  await c.call('audio.setFilters', { project: doc, audio: 'scene-music' });
  await sleep(300);
  const m = measure(3000);
  await sleep(800);
  await c.call('mixer.setMute', { id: 'audio:s-mic', muted: false });
  await sleep(1200);
  await c.call('mixer.setMute', { id: 'audio:s-mic', muted: true });
  const r = await m;
  const base = median(r.bins.slice(5, 60));
  const low = median(r.bins.filter((v) => v < base - 3));
  RESULTS.duck = { baseDb: base, duckedDb: low, dipDb: base - low };
  assert.ok(Math.abs(base - -20) < 0.6, `music before: ${base}`);
  assert.ok(base - low > 9, `music ducked by ${(base - low).toFixed(2)} dB under the voice`);
  const f = await c.call('audio.setFilters', { project: doc, audio: 'scene-music' });
  assert.ok(f, 'the strip kept its tools');
  assert.equal((await status()).file, 'lobby.wav', 'the bed kept playing');
});

test('a switch storm: no step above the limit, the last cue wins', async () => {
  await c.call('transitions.set', { canvas: 'H', type: 'fade', durationMs: 400 });
  await c.call('scenes.activate', { scene: 'lobby' });
  await idle();
  const order = ['match', 'chat', 'lobby', 'match', 'quiet', 'chat', 'match', 'lobby', 'chat', 'match', 'lobby', 'match'];
  const m = measure(4500);
  await sleep(300);
  for (const scene of order) { // faster than any fade: each cue replaces the one before it
    await c.call('scenes.activate', { scene });
    await sleep(60);
  }
  const r = await m;
  await idle();
  const b = r.bins;
  const jumps = b.map((v, i) => (i && Math.min(v, b[i - 1]) > -35 ? Math.abs(v - b[i - 1]) : 0));
  const maxStepDb = Math.max(...jumps);
  const s = await status();
  const end = median(b.slice(-40));
  RESULTS.storm = { switches: order.length, maxStepDb, endDb: end, mood: s.mood };
  assert.ok(maxStepDb < 1.5, `smooth through the storm: largest 10 ms step above -35 dBFS is ${maxStepDb} dB`);
  assert.equal(s.scene, 'match');
  assert.equal(s.file, 'in-match.wav', 'the last cue wins');
  assert.ok(Math.abs(end - -30) < 0.6, `in-match level at the end: ${end}`);
});

test('a rolled-back strip add restores every scene\'s music from the document', async () => {
  const before = (await status()).scenes;
  const proposal = project();
  proposal.scenes[0].music = music(true, 'lobby', -15);
  proposal.scenes[1].music = music(false, 'lobby', -9);
  const old = project();
  old.audio.sources = old.audio.sources.filter((x) => x.id !== 'scene-music');
  await c.call('audio.removeFromProject', { project: old, audio: 'scene-music' });
  assert.equal((await status()).attached, false);
  await c.call('audio.addFromProject', { project: proposal, audio: 'scene-music' });
  let s = await status();
  assert.equal(s.scenes.lobby.volumeDb, -15, 'the proposal is live');
  await c.call('audio.removeFromProject', { project: old, audio: 'scene-music' }); // the UI server's rollback
  s = await status();
  assert.deepEqual(s.scenes, before, 'every scene as in the document again');
  await c.call('audio.addFromProject', { project: project(), audio: 'scene-music' });
  await idle();
  assert.equal((await status()).attached, true);
});

test('Listen: off air only; a recording that starts stops it first', async () => {
  await c.call('scenes.activate', { scene: 'lobby' });
  let r = await c.call('music.preview', { mood: 'lobby' });
  assert.equal(r.previewing, 'lobby');
  assert.equal((await status()).previewing, 'lobby');
  await assert.rejects(c.call('music.preview', { mood: 'brb' }), (e) => e.code === -32009 && /not made yet/.test(e.message));
  const RUNG = { id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 1500, gopSec: 2 };
  await c.call('outputs.configure', { rungs: [RUNG], audio: { bitrate: 128, sampleRate: 48000 },
    sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: 'scene-music-listen.mkv' } }] });
  r = await c.call('music.preview', { mood: 'lobby' });
  assert.equal(r.previewing, 'lobby', 'configure alone is not on air');
  await c.call('record.start', {});
  assert.equal((await status()).previewing, null, 'the recording start stopped Listen');
  let st;
  for (let i = 0; i < 40; i++) {
    st = await c.call('outputs.status');
    if (st.sinks[0].state === 'live') break;
    await sleep(100);
  }
  assert.equal(st.sinks[0].state, 'live');
  await assert.rejects(c.call('music.preview', { mood: 'lobby' }), (e) => e.code === -32009 && /off air/.test(e.message), 'refused while recording');
  assert.equal((await status()).previewing, null);
  await c.call('record.stop', {});
  for (let i = 0; i < 50; i++) {
    st = await c.call('outputs.status');
    if (!st.sinks.some((k) => k.active)) break;
    await sleep(100);
  }
  await c.call('outputs.clear', {});
  r = await c.call('music.preview', { mood: 'lobby' });
  assert.equal(r.previewing, 'lobby', 'off air again');
  assert.equal((await c.call('music.preview', { mood: null })).previewing, null);
  RESULTS.listen = { stoppedByRecord: true, refusedWhileRecording: true };
});

test('a project with two music strips or a non-empty music value is refused', async () => {
  const two = project();
  two.audio.sources.push({ id: 'm2', name: 'Music 2', music: {}, volumeDb: 0, muted: false, monitoring: 'off', tracks: ['t1'] });
  await assert.rejects(c.call('project.plan', { project: two, bases: { media, music: lib } }), (e) => e.code === -32602);
  const bad = project();
  bad.audio.sources[0].music = { file: 'x' };
  await assert.rejects(c.call('project.plan', { project: bad, bases: { media, music: lib } }), (e) => e.code === -32602);
});
