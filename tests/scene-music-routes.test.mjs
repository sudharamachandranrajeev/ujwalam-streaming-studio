// SPDX-License-Identifier: GPL-3.0-or-later
// Scene music, UI server and project side (MU2, plan 2026-11-18-audio-mixer-music): the scene music value and the Music
// strip in the schema and the validator; GET /ui/api/music (moods, which beds are made, each scene's music, what the
// host plays); POST op 'scene' (saved, sent to music.setScene, a Music strip with "Duck music under my voice" added the
// first time music goes on, refusals save nothing); POST op 'preview' (off air only, a made bed only). Stub host; real
// project files in a temp folder; a stub player (nothing is played).
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createMusicRoutes, setSceneMusic } from '../services/studio-ui/music-routes.mjs';
import { defaultMood, listMoods, newMusicStrip, sceneMusicProblems } from '../services/project/scene-music.mjs';
import { validateProject } from '../services/project/validate.mjs';
import { alphaBases } from '../services/studio-ui/alpha.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'fixtures', 'project', 'sample.project.json');
const SCHEMA = JSON.parse(readFileSync(path.join(HERE, '..', 'data', 'schemas', 'project.schema.json'), 'utf8'));
const sample = () => JSON.parse(readFileSync(SAMPLE, 'utf8'));

function setup({ live = false, failHost = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-mu-'));
  const file = path.join(dir, 'p.project.json');
  copyFileSync(SAMPLE, file);
  const lib = path.join(dir, 'music');
  mkdirSync(lib);
  writeFileSync(path.join(lib, 'lobby.wav'), Buffer.alloc(1000));
  const calls = [], played = [];
  const host = {
    call: async (m, p) => {
      calls.push([m, structuredClone(p)]);
      if (m === failHost) throw Object.assign(new Error('refused'), { code: -32602 });
      if (m === 'music.status') return { attached: true, mood: 'lobby', playing: true, reason: '' };
      if (m === 'outputs.status') return { sinks: [{ kind: 'stream', active: live }] };
      return {};
    },
  };
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const projectSync = { status: () => ({ file }), reload() {}, record() { return true; } };
  const routes = createMusicRoutes({ host, json, projectSync, libraryDir: lib, play: (f) => { played.push(f); return { stop() { played.push('stop'); } }; } });
  const req = async (method, body) => { const res = {}; assert.equal(await routes.handle(method, '/ui/api/music', body, res), true); return res; };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  return { req, calls, saved, played, lib };
}

test('schema and validator: scene music and the Music strip', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const check = ajv.compile(SCHEMA);
  const p = sample();
  p.scenes[0].music = { on: true, mood: 'lobby', volumeDb: -6 };
  p.audio.sources.push(newMusicStrip({ mic: 'aud-mic' }));
  p.audio.sources.at(-1).tracks = ['track1'];
  assert.ok(check(p), JSON.stringify(check.errors));
  assert.ok(validateProject(p).ok, JSON.stringify(validateProject(p).errors));
  for (const [bad, why] of [
    [{ on: true, mood: 'Lobby', volumeDb: 0 }, 'mood id'], [{ on: true, mood: 'lobby', volumeDb: 3 }, 'above 0'],
    [{ on: true, mood: 'lobby' }, 'missing volumeDb'], [{ on: 'yes', mood: 'lobby', volumeDb: 0 }, 'on not boolean'],
    [{ on: true, mood: 'lobby', volumeDb: 0, file: 'x' }, 'extra key'],
  ]) {
    const q = structuredClone(p);
    q.scenes[0].music = bad;
    assert.equal(check(q), false, `schema refuses ${why}`);
    assert.equal(validateProject(q).ok, false, `validator refuses ${why}`);
    assert.ok(sceneMusicProblems(bad, 'm').length > 0);
  }
  const two = structuredClone(p);
  two.audio.sources.push({ ...newMusicStrip({ id: 'm2' }), tracks: ['track1'] });
  assert.equal(validateProject(two).ok, false, 'one Music strip per project');
  const nonEmpty = structuredClone(p);
  nonEmpty.audio.sources.at(-1).music = { file: 'x' };
  assert.equal(check(nonEmpty), false);
  assert.equal(validateProject(nonEmpty).ok, false);
});

test('moods come from data/music/moods; defaults follow the scene name', () => {
  const ms = listMoods();
  assert.deepEqual(ms.map((m) => m.id), ['brb', 'ending', 'in-match', 'lobby', 'starting-soon']);
  assert.ok(ms.every((m) => m.status === 'proposed'), 'nobody listened yet: all proposed');
  assert.equal(defaultMood('Starting soon', ms), 'starting-soon');
  assert.equal(defaultMood('Be right back', ms), 'brb');
  assert.equal(defaultMood('In match', ms), 'in-match');
  assert.equal(defaultMood('Main', ms), 'lobby');
});

test('the music library is a host base, given even before it is made', () => {
  const b = alphaBases({ musicDir: path.join(os.tmpdir(), 'not-made-yet', 'music') });
  assert.equal(b.music, path.join(os.tmpdir(), 'not-made-yet', 'music'));
  assert.equal(alphaBases({}).music, undefined);
});

test('GET: moods with made beds, scenes, no strip yet, what plays', async () => {
  const { req } = setup();
  const r = await req('GET');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.moods.filter((m) => m.made).map((m) => m.id), ['lobby']);
  assert.equal(r.body.libraryMade, true);
  assert.deepEqual(r.body.scenes.map((s) => [s.id, s.music]), [['scene-main', null], ['scene-brb', null]]);
  assert.equal(r.body.strip, null);
  assert.equal(r.body.now.mood, 'lobby');
  assert.ok(!JSON.stringify(r.body).includes(os.tmpdir()), 'no absolute path reaches the page');
});

test('switching music on adds one Music strip ducking under the mic, saves, tells the host', async () => {
  const { req, calls, saved } = setup();
  let r = await req('POST', { op: 'scene', scene: 'scene-main', music: { on: true, mood: 'lobby', volumeDb: -6 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stripAdded, 'scene-music');
  const p = saved();
  assert.deepEqual(p.scenes[0].music, { on: true, mood: 'lobby', volumeDb: -6 });
  const strip = p.audio.sources.find((s) => s.id === 'scene-music');
  assert.deepEqual(strip.music, {});
  assert.deepEqual(strip.tracks, ['track1']);
  assert.deepEqual(strip.filters.duck, { on: true, source: 'aud-mic', amountDb: 12, attackMs: 10, releaseMs: 400 });
  assert.deepEqual(calls.filter(([m]) => m !== 'music.status').map(([m, q]) => [m, q.audio ?? q.scene]), [['audio.addFromProject', 'scene-music'], ['music.setScene', 'scene-main']]);
  // a second scene: no second strip
  r = await req('POST', { op: 'scene', scene: 'scene-brb', music: { on: true, mood: 'brb', volumeDb: 0 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.stripAdded, null);
  assert.equal(saved().audio.sources.filter((s) => 'music' in s).length, 1);
  // off keeps the mood and level (the row shows them greyed)
  r = await req('POST', { op: 'scene', scene: 'scene-main', music: { on: false, mood: 'lobby', volumeDb: -6 } });
  assert.deepEqual(saved().scenes[0].music, { on: false, mood: 'lobby', volumeDb: -6 });
});

test('refusals save nothing: bad scene, mood, level, keys; a host refusal undoes the strip', async () => {
  const { req, saved } = setup();
  const before = JSON.stringify(saved());
  for (const [body, code] of [
    [{ op: 'scene', scene: 'nope', music: { on: true, mood: 'lobby', volumeDb: 0 } }, 'unknown-scene'],
    [{ op: 'scene', scene: 'scene-main', music: { on: true, mood: 'polka', volumeDb: 0 } }, 'unknown-mood'],
    [{ op: 'scene', scene: 'scene-main', music: { on: true, mood: 'lobby', volumeDb: 6 } }, 'bad-params'],
    [{ op: 'scene', scene: 'scene-main', music: { on: true, mood: 'lobby', volumeDb: 0 }, extra: 1 }, 'bad-params'],
    [{ op: 'nope' }, 'bad-params'],
  ]) {
    const r = await req('POST', body);
    assert.equal(r.body.error, code, JSON.stringify(body));
  }
  assert.equal(JSON.stringify(saved()), before);
  const f = setup({ failHost: 'music.setScene' });
  const r = await f.req('POST', { op: 'scene', scene: 'scene-main', music: { on: true, mood: 'lobby', volumeDb: 0 } });
  assert.equal(r.status, 502);
  assert.ok(f.calls.some(([m]) => m === 'audio.removeFromProject'), 'the added strip is taken out again');
  assert.equal(f.saved().audio.sources.some((s) => 'music' in s), false);
});

test('preview: off air only, a made bed only, stop', async () => {
  let s = setup({ live: true });
  let r = await s.req('POST', { op: 'preview', mood: 'lobby' });
  assert.equal(r.body.error, 'on-air');
  assert.deepEqual(s.played, []);
  s = setup();
  r = await s.req('POST', { op: 'preview', mood: 'brb' });
  assert.equal(r.body.error, 'not-made');
  r = await s.req('POST', { op: 'preview', mood: 'lobby' });
  assert.equal(r.body.previewing, 'lobby');
  assert.equal(path.basename(s.played[0]), 'lobby.wav');
  r = await s.req('POST', { op: 'preview', mood: null });
  assert.equal(r.body.previewing, null);
  assert.equal(s.played.at(-1), 'stop');
  r = await s.req('POST', { op: 'preview', mood: '../x' });
  assert.equal(r.body.error, 'unknown-mood');
});

test('setSceneMusic is pure', () => {
  const p = sample();
  const before = JSON.stringify(p);
  const x = setSceneMusic(p, { scene: 'scene-main', music: { on: true, mood: 'lobby', volumeDb: 0 }, moods: listMoods() });
  assert.ok(x.project);
  assert.equal(JSON.stringify(p), before);
});
