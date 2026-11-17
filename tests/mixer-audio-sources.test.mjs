// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer Add audio / Add to stream / Remove (D393 proposed; user feedback on alpha.33): the pure project changes
// (services/project/audio-sources.mjs) and the UI server routes (/ui/api/audio*, audio-routes.mjs: host first, then the
// file; a host refusal saves nothing; allowed while live). Device names here are placeholders.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { addAudioSource, audioChoices, removeAudioSource, streamTracks } from '../services/project/audio-sources.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const LIST = { devices: [
  { kind: 'audio-input', name: '<mic-device>', path: '{in-1}', obsId: '{in-1}' },
  { kind: 'audio-input', name: '<capture-card-audio>', path: '{in-2}', obsId: '{in-2}' },
  { kind: 'audio-output', name: '<speakers>', path: '{out-1}', obsId: '{out-1}' },
  { kind: 'video', name: '<capture-card>', path: '\\\\?\\usb#card', obsId: 'x' },
] };

function base() {
  const doc = createProject({ name: 'T', fps: 30 });
  doc.devices = [{ id: 'card', kind: 'capture-card', name: 'Card', match: { name: '<capture-card>' } },
    { id: 'mic', kind: 'microphone', name: 'Mic', match: { name: '<mic-device>', deviceId: '{IN-1}' } }];
  const pl = { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 }, v: { visible: true, x: 0, y: 0, width: 1080, height: 608 } };
  doc.scenes[0].layers.push({ id: 'game', type: 'capture', name: 'Game capture', source: { device: 'card' }, placements: pl },
    { id: 'clip', type: 'media', name: 'Intro video', source: { file: { base: 'media', rel: 'intro.mp4' }, loop: true }, placements: structuredClone(pl) });
  doc.audio.sources.push({ id: 'aud-mic', name: 'Mic', device: 'mic', volumeDb: 0, muted: false, monitoring: 'off', tracks: [doc.audio.tracks[0].id] });
  const v = validateProject(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return doc;
}
const MIXER = (doc) => [
  { id: 'audio:aud-mic', name: 'Mic', audioSource: 'aud-mic', mixers: 1, tracks: [doc.audio.tracks[0].id] },
  { id: `${doc.scenes[0].id}/game`, scene: doc.scenes[0].id, layer: 'game', name: 'Game capture', mixers: 0, tracks: [], cueDelayed: true, volumeDb: -3, muted: false },
];

test('audioChoices: free inputs and outputs, the capture card audio first and marked; layer sounds with no entry', () => {
  const doc = base();
  const c = audioChoices({ doc, list: LIST, mixer: MIXER(doc), recommended: LIST.devices[1] });
  assert.deepEqual(c.inputs.map((i) => [i.key, i.recommended]), [['input|{in-2}', true]], 'the mic in use is left out (deviceId case-insensitive)');
  assert.deepEqual(c.outputs.map((o) => o.key), ['output|{out-1}']);
  assert.deepEqual(c.layers, [{ key: 'layer|game', layer: 'game', name: 'Game capture', cueDelayed: true }]);
  const none = audioChoices({ doc, list: null, mixer: [] });
  assert.deepEqual([none.inputs, none.outputs, none.layers], [[], [], []], 'no device list: devices off');
});

test('audioChoices: a capture-card device audio entry takes its capture layer (the host binds it there)', () => {
  const doc = base();
  doc.audio.sources.push({ id: 'aud-card', name: 'Game', device: 'card', volumeDb: 0, muted: false, monitoring: 'off', tracks: [] });
  assert.deepEqual(audioChoices({ doc, list: LIST, mixer: MIXER(doc) }).layers, []);
  assert.equal(addAudioSource(doc, { key: 'layer|game', mixer: MIXER(doc) }).error, 'already-added', 'never two entries on one layer: the host would refuse the load');
});

test('addAudioSource: a device input in the stream mix, CUE off; the device is added once and reused', () => {
  const doc = base();
  const a = addAudioSource(doc, { key: 'input|{in-2}', list: LIST });
  assert.ok(a.project, JSON.stringify(a));
  assert.equal(doc.audio.sources.length, 1, 'input unchanged');
  assert.equal(a.audio.name, '<capture-card-audio>');
  assert.deepEqual(a.audio.tracks, [doc.audio.tracks[0].id]);
  assert.equal(a.audio.monitoring, 'off');
  const dev = a.project.devices.find((d) => d.id === a.audio.device);
  assert.deepEqual([dev.kind, dev.match.deviceId, dev.origin.importer], ['microphone', '{in-2}', 'mixer']);
  assert.equal(addAudioSource(a.project, { key: 'input|{in-2}', list: LIST }).error, 'already-added');
  const o = addAudioSource(doc, { key: 'output|{out-1}', list: LIST, name: 'Desktop' });
  assert.deepEqual([o.audio.name, o.project.devices.find((d) => d.id === o.audio.device).kind], ['Desktop', 'audio-output']);
  assert.equal(addAudioSource(doc, { key: 'input|{gone}', list: LIST }).error, 'unknown-device', 'only a listed device');
  assert.equal(addAudioSource(doc, { key: 'video|x', list: LIST }).error, 'bad-key');
  assert.equal(addAudioSource(doc, { key: 'output|{in-2}', list: LIST }).error, 'unknown-device', 'kind must fit');
});

test('addAudioSource: a layer sound keeps its live volume and mute; removeAudioSource drops it and the device it added', () => {
  const doc = base();
  const a = addAudioSource(doc, { key: 'layer|game', mixer: MIXER(doc), volumeDb: -3, muted: false });
  assert.deepEqual([a.audio.layer, a.audio.name, a.audio.volumeDb], ['game', 'Game capture', -3]);
  assert.equal(addAudioSource(doc, { key: 'layer|clip', mixer: MIXER(doc) }).error, 'unknown-sound', 'only a sound the mixer meters');
  const r = removeAudioSource(a.project, { audio: a.audio.id });
  assert.equal(r.project.audio.sources.length, 1);
  const d = addAudioSource(doc, { key: 'input|{in-2}', list: LIST });
  const rd = removeAudioSource(d.project, { audio: d.audio.id });
  assert.equal(rd.project.devices.length, 2, 'the device the mixer added goes with it');
  const rm = removeAudioSource(doc, { audio: 'aud-mic' });
  assert.ok(rm.project.devices.some((x) => x.id === 'mic'), 'a device the mixer did not add stays');
  assert.equal(removeAudioSource(doc, { audio: 'nope' }).error, 'unknown-sound');
});

test('one capture per endpoint: a second device entry naming an endpoint in use is neither listed nor added', () => {
  const doc = base();
  // An unused device that names the mic's endpoint, listed first (as a failed save and a retry could leave behind).
  doc.devices.unshift({ id: 'mic-copy', kind: 'microphone', name: 'Mic copy', match: { name: '<mic-device>', deviceId: '{in-1}' } });
  assert.ok(!audioChoices({ doc, list: LIST, mixer: [] }).inputs.some((i) => i.key === 'input|{in-1}'));
  assert.equal(addAudioSource(doc, { key: 'input|{in-1}', list: LIST }).error, 'already-added');
  assert.equal(addAudioSource(doc, { key: 'input|{IN-1}', list: LIST }).error, 'already-added', 'endpoint ids compare case-insensitively');
});

test('streamTracks: the stream track (the first) is added in project order', () => {
  const doc = base();
  doc.audio.tracks.push({ id: 'rec', name: 'Recording' });
  doc.audio.sources[0].tracks = ['rec'];
  assert.deepEqual(streamTracks(doc, 'aud-mic'), [doc.audio.tracks[0].id, 'rec']);
  assert.equal(streamTracks(doc, 'nope'), null);
});

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('server: choices, add, add to stream and remove; host first, then the file; works while live', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-audio-'));
  const file = path.join(dir, 'p.project.json');
  const doc = base();
  saveProject(file, doc);
  const calls = [];
  const state = { live: true, refuse: false, refuseUndo: false, rows: MIXER(doc) };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    if (m === 'devices.list') return LIST;
    if (m === 'mixer.list') return { sources: state.rows, tracks: doc.audio.tracks };
    if (!m.startsWith('audio.') && m !== 'mixer.setTracks') return {}; // the server's own polls (outputs.status, ...)
    calls.push([m, p.audio ?? p.id, p.tracks]);
    if (state.refuse) throw new Error('This sound cannot be added: Windows did not open the device.');
    if (state.refuseUndo && m === 'audio.removeFromProject') throw new Error('host gone');
    if (m === 'mixer.setTracks') return { id: p.id, audioSource: 'aud-mic', tracks: p.tracks, monitoring: 'off' };
    return { audio: p.audio, removed: true, cueDelayed: false };
  } };
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const projectSync = createProjectSync({ file, delayMs: 1 });
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, projectSync, limits: { statusPollMs: 50 }, presetsDir: path.join(dir, 'none') });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/audio', body: JSON.stringify(body),
      headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const disk = () => JSON.parse(readFileSync(file, 'utf8'));

    const ch = (await raw(port, { url: '/ui/api/audio/choices', headers: { cookie } })).body;
    assert.equal(ch.available, true);
    assert.equal(ch.devicesOff, false);
    assert.deepEqual(ch.inputs.map((i) => i.key), ['input|{in-2}']);
    assert.deepEqual(ch.layers.map((l) => l.layer), ['game']);

    assert.equal((await post({ op: 'add', key: 'input|{in-2}', extra: 1 })).status, 400, 'unknown key');
    // Malformed input: a controlled 400 before anything is read or called, never a throw.
    const before = calls.length;
    for (const bad of [{ op: ['add'], key: 'input|{in-2}' }, { op: { a: 1 }, key: 'x' }, { op: 'add', key: 5 }, { op: 'add', key: ['input|{in-2}'] },
      { op: 'add', key: 'input|{in-2}', name: 7 }, { op: 'stream', id: { a: 1 } }, { op: 'stream', id: ['audio:aud-mic'] }, { op: 'remove', audio: ['aud-mic'] },
      { op: 'remove', audio: null }, { op: 'constructor' }, { op: 'toString' }, [], 'add', null]) {
      const b = await post(bad);
      assert.equal(b.status, 400, JSON.stringify(bad));
      if (bad !== null && typeof bad === 'object' && !Array.isArray(bad)) assert.equal(b.body.error, 'bad-params', JSON.stringify(bad)); // others: the server's body check
    }
    assert.equal(calls.length, before, 'no host call for a malformed request');

    // A failed save undoes the host change: the host never keeps a sound the file does not (a retry would double it).
    mkdirSync(`${file}.bak`); // saveProject copies the file to .bak first: a folder there makes the save fail
    let r = await post({ op: 'add', key: 'input|{in-2}' });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, 'not-saved');
    assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['audio.addFromProject', 'audio.removeFromProject']);
    assert.equal(calls.at(-1)[1], calls.at(-2)[1], 'the same id is taken back');
    assert.equal(disk().audio.sources.length, 1, 'nothing saved');
    state.refuseUndo = true;
    r = await post({ op: 'add', key: 'input|{in-2}' });
    assert.deepEqual([r.status, r.body.error], [500, 'not-saved-live'], 'says plainly when the undo failed too');
    state.refuseUndo = false;
    rmSync(`${file}.bak`, { recursive: true });

    state.refuse = true;
    r = await post({ op: 'add', key: 'input|{in-2}' });
    assert.equal(r.status, 502);
    assert.match(r.body.detail, /did not open the device/);
    assert.equal(disk().audio.sources.length, 1, 'a host refusal saves nothing');
    state.refuse = false;

    r = await post({ op: 'add', key: 'input|{in-2}' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, true);
    const added = disk().audio.sources.find((a) => a.id === r.body.audio.id);
    assert.ok(added?.device, 'saved with its device');
    assert.equal(calls.at(-1)[0], 'audio.addFromProject');

    r = await post({ op: 'stream', id: `${doc.scenes[0].id}/game` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const bound = disk().audio.sources.find((a) => a.layer === 'game');
    assert.deepEqual([bound.volumeDb, bound.tracks], [-3, [doc.audio.tracks[0].id]], 'the layer sound joins the stream at its live volume');

    state.rows = [{ ...MIXER(doc)[0], mixers: 0, tracks: [] }];
    r = await post({ op: 'stream', id: 'audio:aud-mic' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(calls.at(-1), ['mixer.setTracks', 'audio:aud-mic', [doc.audio.tracks[0].id]]);
    projectSync.flush();
    assert.deepEqual(disk().audio.sources.find((a) => a.id === 'aud-mic').tracks, [doc.audio.tracks[0].id], 'saved like the track buttons');
    state.rows = MIXER(doc);
    assert.equal((await post({ op: 'stream', id: 'audio:aud-mic' })).body.error, 'in-stream');

    r = await post({ op: 'remove', audio: added.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!disk().audio.sources.some((a) => a.id === added.id));
    assert.ok(!disk().devices.some((d) => d.id === added.device), 'its device went too');
    assert.equal(calls.at(-1)[0], 'audio.removeFromProject');
    assert.equal((await post({ op: 'remove', audio: 'nope' })).body.error, 'unknown-sound');
  } finally { await srv.close(); }
});
