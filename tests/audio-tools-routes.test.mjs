// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer audio tools, UI server side (plan 2026-11-18-audio-mixer-music, AU1 + AU2): Add audio offers running apps (exe
// names only) and sound files / folders under the media base; adding one saves an app / playback audio source on the
// stream track; the strip tools (op 'filters') are validated against the filters' obs ranges, sent to the host's
// audio.setFilters and saved; the presets file is valid data. Stub host; real project files in a temp folder.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAudioRoutes, AUDIO_PRESETS_FILE } from '../services/studio-ui/audio-routes.mjs';
import { listAudio } from '../services/studio-ui/assets.mjs';
import { FILTER_ORDER, FILTER_RANGES, FILTER_REFS, defaultTool, filtersProblems } from '../services/project/audio-filters.mjs';
import { validateProject } from '../services/project/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, 'fixtures', 'project', 'sample.project.json');
const SCHEMA = JSON.parse(readFileSync(path.join(HERE, '..', 'data', 'schemas', 'project.schema.json'), 'utf8'));

function setup({ apps = [{ exe: 'player.exe', sound: true }, { exe: 'Browser.exe', sound: false }] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-au-'));
  const file = path.join(dir, 'p.project.json');
  copyFileSync(SAMPLE, file);
  const media = path.join(dir, 'media');
  mkdirSync(path.join(media, 'music', 'lobby'), { recursive: true });
  writeFileSync(path.join(media, 'music', 'intro.mp3'), 'x');
  writeFileSync(path.join(media, 'music', 'lobby', 'a.ogg'), 'x');
  writeFileSync(path.join(media, 'music', 'lobby', 'b.wav'), 'x');
  writeFileSync(path.join(media, 'logo.png'), 'x');
  const calls = [];
  const host = {
    call: async (m, p) => {
      calls.push([m, structuredClone(p)]);
      if (m === 'mixer.list') return { sources: [] };
      if (m === 'devices.list') return { devices: [] };
      if (m === 'audio.apps') return { available: true, apps };
      if (m === 'audio.addFromProject') return { audio: p.audio, kind: 'device', cueDelayed: false };
      if (m === 'audio.setFilters') {
        const s = p.project.audio.sources.find((x) => x.id === p.audio);
        return { audio: p.audio, filters: { ...(s.filters ?? {}), order: FILTER_ORDER.filter((k) => s.filters?.[k]) } };
      }
      return {};
    },
  };
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const projectSync = { status: () => ({ file }), reload() {}, record() { return true; } };
  const routes = createAudioRoutes({ host, json, projectSync, assetsDir: media });
  const req = async (method, route, body) => { const res = {}; assert.equal(await routes.handle(method, route, body, res), true); return res; };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  return { req, calls, saved };
}

test('listAudio: sound files and folders with sound files, rel paths only', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-la-'));
  mkdirSync(path.join(dir, 'm'));
  writeFileSync(path.join(dir, 'm', 'x.MP3'), 'x');
  writeFileSync(path.join(dir, 'm', 'y.txt'), 'x');
  const r = listAudio(dir);
  assert.deepEqual(r, { files: ['m/x.MP3'], folders: [{ rel: 'm', count: 1 }] });
  assert.deepEqual(listAudio(null), { files: [], folders: [] });
});

test('choices list apps (sound first, exe names) and sound files / folders', async () => {
  const { req } = setup();
  const r = await req('GET', '/ui/api/audio/choices');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.apps.map((a) => a.key), ['app|player.exe', 'app|Browser.exe']);
  assert.deepEqual(r.body.files.map((f) => f.key), ['file|music/intro.mp3', 'file|music/lobby/a.ogg', 'file|music/lobby/b.wav']);
  assert.deepEqual(r.body.folders.map((f) => [f.key, f.count]), [['folder|music', 1], ['folder|music/lobby', 2]]);
  assert.ok(!JSON.stringify(r.body).includes(os.tmpdir()), 'no absolute path reaches the page');
});

test('add an app: saved as its exe name on the stream track; a name the host did not list is refused', async () => {
  const { req, saved, calls } = setup();
  let r = await req('POST', '/ui/api/audio', { op: 'add', key: 'app|player.exe' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.audio.kind, 'app');
  const s = saved().audio.sources.find((x) => x.id === r.body.audio.id);
  assert.deepEqual([s.app, s.tracks, s.name], [{ exe: 'player.exe' }, ['track1'], 'player']);
  assert.ok(calls.some(([m, p]) => m === 'audio.addFromProject' && p.audio === s.id));
  r = await req('POST', '/ui/api/audio', { op: 'add', key: 'app|player.exe' });
  assert.equal(r.status, 409, 'twice: already in the mix');
  r = await req('POST', '/ui/api/audio', { op: 'add', key: 'app|evil.exe' });
  assert.equal(r.body.error, 'unknown-app');
  r = await req('GET', '/ui/api/audio/choices');
  assert.deepEqual(r.body.apps.map((a) => a.key), ['app|Browser.exe'], 'an app in the mix is not offered again');
});

test('add a file (loops) and a folder playlist under the media base; an unknown path is refused', async () => {
  const { req, saved } = setup();
  let r = await req('POST', '/ui/api/audio', { op: 'add', key: 'file|music/intro.mp3' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.audio.kind, 'playback');
  let s = saved().audio.sources.find((x) => x.id === r.body.audio.id);
  assert.deepEqual(s.playback, { file: { base: 'media', rel: 'music/intro.mp3' }, loop: true });
  assert.equal(s.name, 'intro');
  r = await req('POST', '/ui/api/audio', { op: 'add', key: 'folder|music/lobby', name: 'Lobby music' });
  s = saved().audio.sources.find((x) => x.id === r.body.audio.id);
  assert.deepEqual([s.playback, s.name], [{ folder: { base: 'media', rel: 'music/lobby' }, loop: true }, 'Lobby music']);
  for (const key of ['file|../secret.mp3', 'file|C:/x.mp3', 'file|logo.png', 'folder|nope']) {
    r = await req('POST', '/ui/api/audio', { op: 'add', key });
    assert.equal(r.body.error, 'unknown-file', key);
  }
  assert.ok(validateProject(saved()).ok);
});

test('tools: set, change and clear a strip\'s filters; saved and sent to the host in place', async () => {
  const { req, saved, calls } = setup();
  const clean = JSON.parse(readFileSync(AUDIO_PRESETS_FILE, 'utf8')).presets.find((p) => p.id === 'clean-voice').filters;
  let r = await req('POST', '/ui/api/audio', { op: 'filters', audio: 'aud-mic', filters: clean });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(saved().audio.sources.find((x) => x.id === 'aud-mic').filters, clean);
  assert.deepEqual(r.body.live.order, ['suppress', 'gate', 'compressor', 'limiter']);
  const last = calls.filter(([m]) => m === 'audio.setFilters').at(-1)[1];
  assert.equal(last.audio, 'aud-mic');
  r = await req('POST', '/ui/api/audio', { op: 'filters', audio: 'aud-mic', filters: { ...clean, gain: { on: false, db: 4 } } });
  assert.equal(saved().audio.sources.find((x) => x.id === 'aud-mic').filters.gain.on, false, 'a tool switched off stays saved');
  r = await req('POST', '/ui/api/audio', { op: 'filters', audio: 'aud-mic', filters: null });
  assert.equal(r.status, 200);
  assert.equal('filters' in saved().audio.sources.find((x) => x.id === 'aud-mic'), false);
});

test('tools: out-of-range or unknown values are refused before the host; nothing saved', async () => {
  const { req, saved, calls } = setup();
  const before = JSON.stringify(saved());
  for (const filters of [{ gain: { on: true, db: 30.5 } }, { gate: { ...defaultTool('gate'), attackMs: 1.5 } }, { reverb: { on: true } },
    { compressor: { on: true, ratio: 0.5, thresholdDb: -18, attackMs: 6, releaseMs: 60, outputGainDb: 0 } }, { limiter: { on: true } }]) {
    const r = await req('POST', '/ui/api/audio', { op: 'filters', audio: 'aud-mic', filters });
    assert.equal(r.status, 400, JSON.stringify(filters));
    assert.equal(r.body.error, 'bad-tools');
  }
  assert.equal((await req('POST', '/ui/api/audio', { op: 'filters', audio: 'nope', filters: null })).body.error, 'unknown-sound');
  assert.equal((await req('POST', '/ui/api/audio', { op: 'filters', audio: 'aud-mic', filters: [] })).status, 400);
  assert.equal(JSON.stringify(saved()), before);
  assert.ok(!calls.some(([m]) => m === 'audio.setFilters'));
});

test('tools route: ranges, order and presets; every preset is a valid filters value', async () => {
  const { req } = setup();
  const r = await req('GET', '/ui/api/audio/tools');
  assert.deepEqual(r.body.order, ['suppress', 'gate', 'eq', 'gain', 'duck', 'compressor', 'limiter']);
  assert.deepEqual(r.body.ranges.gain.db.slice(0, 2), [-30, 30]);
  assert.ok(r.body.presets.some((p) => p.id === 'clean-voice' && p.name === 'Clean voice'));
  const file = JSON.parse(readFileSync(AUDIO_PRESETS_FILE, 'utf8'));
  assert.ok(file.source && /^\d{4}-\d{2}-\d{2}$/.test(file.checked), 'source and checked date');
  // a preset that needs a mic gets duck.source = the chosen mic in the Tools window
  for (const p of r.body.presets) {
    const f = structuredClone(p.filters);
    if (p.needs === 'mic') f.duck.source = 'aud-mic';
    assert.deepEqual(filtersProblems(f, p.id), [], p.id);
  }
  assert.deepEqual(Object.keys(r.body.presets.find((p) => p.id === 'clean-voice').filters), ['suppress', 'gate', 'compressor', 'limiter']);
});

test('schema and validator agree on the tool ranges (obs_properties limits)', () => {
  const s = SCHEMA.$defs.audioFilters.properties;
  for (const [kind, keys] of Object.entries(FILTER_RANGES)) {
    for (const [k, [min, max, , int]] of Object.entries(keys)) {
      assert.deepEqual([s[kind].properties[k].minimum, s[kind].properties[k].maximum], [min, max], `${kind}.${k}`);
      assert.equal(s[kind].properties[k].type, int ? 'integer' : 'number', `${kind}.${k} type`);
    }
    assert.deepEqual(s[kind].required.sort(), ['on', ...(FILTER_REFS[kind] ?? []), ...Object.keys(keys)].sort(), kind);
  }
});

test('validator: app exe names only, playback needs exactly one of file / folder', () => {
  const doc = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const add = (x) => { const d = structuredClone(doc); d.audio.sources.push({ id: 'aud-x', name: 'X', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'], ...x }); return validateProject(d); };
  assert.ok(add({ app: { exe: 'player.exe' } }).ok);
  assert.ok(!add({ app: { exe: 'C:\\apps\\player.exe' } }).ok, 'no folder');
  assert.ok(!add({ app: { exe: 'player' } }).ok, 'an exe');
  assert.ok(!add({ app: { exe: 'player.exe', title: 'x' } }).ok, 'no window title');
  assert.ok(add({ playback: { folder: { base: 'media', rel: 'music' }, loop: true } }).ok);
  assert.ok(!add({ playback: { loop: true } }).ok);
  assert.ok(!add({ playback: { file: { base: 'media', rel: 'a.mp3' }, folder: { base: 'media', rel: 'm' }, loop: true } }).ok);
  assert.ok(!add({ playback: { file: { base: 'media', rel: '../a.mp3' }, loop: true } }).ok);
  assert.ok(!add({ app: { exe: 'a.exe' }, device: 'dev-mic' }).ok, 'one kind only');
  assert.ok(add({ device: 'dev-mic', filters: { suppress: { on: true }, eq: defaultTool('eq', false) } }).ok);
});

// ---- review fixes (Codex review of AU1/AU2, 2026-11-18) ----

test('review: a gate whose close level is above its open level is refused; "#" in an exe name is refused', async () => {
  const { req } = setup();
  const r = await req('POST', '/ui/api/audio', { op: 'filters', audio: 'aud-mic', filters: { gate: { ...defaultTool('gate'), closeDb: -20, openDb: -30 } } });
  assert.equal(r.body.error, 'bad-tools');
  const doc = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  doc.audio.sources.push({ id: 'aud-x', name: 'X', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'], app: { exe: 'a#3Ab.exe' } });
  assert.ok(!validateProject(doc).ok, 'validator');
});

test('review: two different programs with one name are offered but refused with a plain reason', async () => {
  const { req, saved } = setup({ apps: [{ exe: 'player.exe', sound: true, ambiguous: true }] });
  const c = await req('GET', '/ui/api/audio/choices');
  assert.equal(c.body.apps[0].ambiguous, true);
  const r = await req('POST', '/ui/api/audio', { op: 'add', key: 'app|player.exe' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'ambiguous-app');
  assert.match(r.body.text, /Two different programs/);
  assert.ok(!saved().audio.sources.some((x) => x.app));
});

test('review: sound files come from the media base only; the schema says exactly one kind and one of file / folder', async () => {
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const v = new Ajv2020({ allErrors: true, strict: true }).compile(SCHEMA);
  const doc = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const add = (x) => { const d = structuredClone(doc); d.audio.sources.push({ id: 'aud-x', name: 'X', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'], ...x }); return d; };
  const good = add({ playback: { file: { base: 'media', rel: 'a.mp3' }, loop: true } });
  assert.ok(validateProject(good).ok);
  assert.ok(v(good), JSON.stringify(v.errors));
  for (const [why, d] of [
    ['base data', add({ playback: { file: { base: 'data', rel: 'a.mp3' }, loop: true } })],
    ['file and folder', add({ playback: { file: { base: 'media', rel: 'a.mp3' }, folder: { base: 'media', rel: 'm' }, loop: true } })],
    ['two kinds', add({ app: { exe: 'a.exe' }, device: 'dev-mic' })],
    ['no kind', add({})],
  ]) {
    assert.ok(!validateProject(d).ok, `validator: ${why}`);
    assert.ok(!v(d), `schema: ${why}`);
  }
});
// ---- AU3 ducking ----

test('AU3: Tools lists the sounds a strip can duck under (no layer sounds); the duck preset is offered', async () => {
  const { req } = setup();
  const r = await req('GET', '/ui/api/audio/tools');
  const doc = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const layerIds = doc.audio.sources.filter((a) => a.layer).map((a) => a.id);
  assert.ok(r.body.sounds.length > 0);
  for (const s of r.body.sounds) assert.ok(!layerIds.includes(s.id), `${s.id} is not a layer sound`);
  const firstNonMic = r.body.sounds.findIndex((s) => !s.mic);
  assert.ok(firstNonMic < 0 || r.body.sounds.slice(firstNonMic).every((s) => !s.mic), 'microphones first');
  const p = r.body.presets.find((x) => x.id === 'duck-under-voice');
  assert.equal(p.name, 'Duck music under my voice');
  assert.equal(p.needs, 'mic');
  assert.deepEqual(r.body.refs, { duck: ['source'] });
});

test('AU3: duck under another sound is saved and sent; under itself, a layer sound or an unknown id is refused', async () => {
  const { req, saved, calls } = setup();
  const doc = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const other = doc.audio.sources.find((a) => a.id !== 'aud-mic' && !a.layer);
  const layer = doc.audio.sources.find((a) => a.layer);
  const duck = (source) => ({ duck: { on: true, source, amountDb: 12, attackMs: 10, releaseMs: 400 } });
  assert.ok(other, 'the sample has a second sound');
  let r = await req('POST', '/ui/api/audio', { op: 'filters', audio: other.id, filters: duck('aud-mic') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(saved().audio.sources.find((x) => x.id === other.id).filters, duck('aud-mic'));
  assert.ok(calls.some(([m, p]) => m === 'audio.setFilters' && p.audio === other.id));
  for (const bad of [other.id, 'nope', ...(layer ? [layer.id] : [])]) {
    r = await req('POST', '/ui/api/audio', { op: 'filters', audio: other.id, filters: duck(bad) });
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error, 'bad-duck', bad);
  }
  r = await req('POST', '/ui/api/audio', { op: 'filters', audio: other.id, filters: { duck: { ...duck('aud-mic').duck, amountDb: 19 } } });
  assert.equal(r.body.error, 'bad-tools', 'amount over 18 dB');
});

test('AU3: the validator refuses a strip ducking under itself; a missing sound id stays valid (the host says why)', () => {
  const doc = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  const s = doc.audio.sources.find((a) => a.id === 'aud-mic');
  s.filters = { duck: { on: true, source: 'aud-mic', amountDb: 12, attackMs: 10, releaseMs: 400 } };
  assert.ok(!validateProject(doc).ok);
  s.filters.duck.source = 'aud-gone';
  assert.ok(validateProject(doc).ok);
});