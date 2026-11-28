// SPDX-License-Identifier: GPL-3.0-or-later
// Shader scene transitions (2026-11-28): blurZoom, lightLeak, motionSwipe, glitch, heartbeat, pop. The validator and the
// JSON Schema agree on them and on a scene's own transition; every realism look carries a subtle default that a realism
// scene gets as its own; the transitions form saves a scene's own transition (and takes it off again); switching to a
// scene with its own transition sets it on the host before the switch. Fake host only; nothing is started.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { loadLooks } from '../services/project/looks.mjs';
import { realismScene } from '../services/project/structure.mjs';
import { EASED_TYPES, SHADER_TRANSITIONS, TRANSITION_TYPES } from '../services/project/validate.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer, TRANSITIONS_FLAG } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const readJson = (...p) => JSON.parse(readFileSync(path.join(REPO, ...p), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const projectSchema = ajv.compile(readJson('data', 'schemas', 'project.schema.json'));
const lookSchema = new Ajv2020({ allErrors: true, strict: true }).compile(readJson('data', 'schemas', 'look.schema.json'));
const STYLES = ['blurZoom', 'lightLeak', 'motionSwipe', 'glitch', 'heartbeat', 'pop'];

test('the six shader styles are transition types that take an easing curve; easing.json describes each in plain words', () => {
  assert.deepEqual(SHADER_TRANSITIONS, STYLES);
  for (const s of STYLES) { assert.ok(TRANSITION_TYPES.includes(s)); assert.ok(EASED_TYPES.includes(s)); }
  const e = readJson('data', 'transitions', 'easing.json');
  for (const s of STYLES) {
    const k = e.kinds.find((x) => x.id === s);
    assert.ok(k, s);
    assert.equal(k.shader, true);
    assert.ok(k.label.length > 2 && k.help.length > 30 && !/shader|uv|HLSL/i.test(k.help), `${s}: plain-word help`);
  }
});

function withTransition(where, t) {
  const d = createProject({ name: 'T', fps: 30 });
  if (where === 'canvas') d.canvases[0].transition = t; else d.scenes[0].transition = t;
  return d;
}

for (const [name, where, t, ok] of [
  ['canvas blurZoom with easing', 'canvas', { type: 'blurZoom', durationMs: 500, easing: 'in-out-sine' }, true],
  ['canvas motionSwipe with direction', 'canvas', { type: 'motionSwipe', durationMs: 500, direction: 'up' }, true],
  ['canvas motionSwipe without direction (left)', 'canvas', { type: 'motionSwipe', durationMs: 500 }, true],
  ['scene glitch', 'scene', { type: 'glitch', durationMs: 400 }, true],
  ['scene pop eased', 'scene', { type: 'pop', durationMs: 400, easing: 'out-cubic' }, true],
  ['scene fade', 'scene', { type: 'fade', durationMs: 400 }, true],
  ['glitch with a direction', 'canvas', { type: 'glitch', durationMs: 400, direction: 'left' }, false],
  ['heartbeat with a colour', 'scene', { type: 'heartbeat', durationMs: 400, color: '#000000' }, false],
  ['lightLeak without a duration', 'scene', { type: 'lightLeak' }, false],
  ['unknown style', 'scene', { type: 'sparkle', durationMs: 400 }, false],
  ['slide still refuses easing', 'canvas', { type: 'slide', durationMs: 400, direction: 'left', easing: 'in-quad' }, false],
]) {
  test(`validator and schema agree: ${name} -> ${ok ? 'valid' : 'refused'}`, () => {
    const d = withTransition(where, t);
    assert.equal(validateProject(d).ok, ok, JSON.stringify(validateProject(d).errors));
    assert.equal(projectSchema(d), ok, JSON.stringify(projectSchema.errors));
  });
}

test('a scene transition never takes mirror (the validator; the schema shares the canvas definition)', () => {
  const d = withTransition('scene', { type: 'pop', durationMs: 400, mirror: true });
  assert.equal(validateProject(d).ok, false);
});

test('every realism look carries a subtle default transition (300..800 ms) that the look schema accepts; looks differ', () => {
  const files = readdirSync(path.join(REPO, 'data', 'looks')).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 7);
  const types = new Set();
  for (const f of files) {
    const l = readJson('data', 'looks', f);
    assert.ok(lookSchema(l), `${f}: ${JSON.stringify(lookSchema.errors)}`);
    assert.ok(l.transition, `${f} has a transition`);
    assert.ok(STYLES.includes(l.transition.type), `${f}: a shader style`);
    assert.ok(l.transition.durationMs >= 300 && l.transition.durationMs <= 800, `${f}: subtle length`);
    const d = withTransition('scene', l.transition);
    assert.ok(validateProject(d).ok && projectSchema(d), `${f}: a valid project transition`);
    types.add(l.transition.type);
  }
  assert.equal(types.size, STYLES.length, 'every style is some look\'s default');
});

const PL = (w, h) => ({ visible: true, x: 0, y: 0, width: w, height: h });
function gameDoc() {
  const doc = createProject({ name: 'T', fps: 30 });
  doc.devices = [{ id: 'dev-game', kind: 'capture-card', name: 'Card', match: { name: 'Card' } }];
  doc.scenes[0].layers.push({ id: 'game', type: 'capture', name: 'Game', source: { device: 'dev-game' }, placements: { h: PL(1920, 1080) } });
  return doc;
}

test('realismScene: the copy gets its look\'s transition as its own; the source keeps none; a realism copy of it changes it', () => {
  const looks = loadLooks();
  const doc = gameDoc();
  const r = realismScene(doc, { scene: doc.scenes[0].id, look: 'night-neon' }, looks);
  assert.ok(!r.error, JSON.stringify(r));
  assert.deepEqual(r.scene.transition, looks.find((l) => l.id === 'night-neon').transition);
  assert.equal(r.project.scenes[0].transition, undefined, 'the source scene is unchanged');
  assert.ok(validateProject(r.project).ok);
  const r2 = realismScene(r.project, { scene: r.scene.id, look: 'cinematic' }, looks);
  assert.deepEqual(r2.scene.transition, looks.find((l) => l.id === 'cinematic').transition);
  // a user look takes the transition of the look it was based on
  const user = { ...looks.find((l) => l.id === 'filmic'), id: 'user-mine', name: 'Mine', transition: undefined, measured: { basedOn: 'gritty-war' } };
  delete user.transition;
  const r3 = realismScene(doc, { scene: doc.scenes[0].id, look: 'user-mine' }, [...looks, user]);
  assert.deepEqual(r3.scene.transition, looks.find((l) => l.id === 'gritty-war').transition);
});

test('form: a scene\'s own transition is saved and taken off again; switching to it sets it on the host first', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-shtr-'));
  const file = path.join(dir, 'p.project.json');
  const doc = createProject({ name: 'T', fps: 30 });
  doc.canvases[0].transition = { type: 'fade', durationMs: 300 };
  doc.scenes.push({ id: 'second', name: 'Second', layers: [] });
  saveProject(file, doc);
  const calls = [];
  const cur = { H: { type: 'fade', durationMs: 300, available: true }, V: { type: 'cut', durationMs: 0, available: true } };
  const active = { H: doc.scenes[0].id };
  const host = {
    describe: () => ({ kind: 'host', available: true }),
    call: async (m, p) => {
      calls.push([m, p]);
      if (m === 'host.status') return { live: false, recording: false, transitions: structuredClone(cur), canvases: [{ id: 'H', active: active.H }] };
      if (m === 'transitions.types') return { types: TRANSITION_TYPES.map((t) => ({ type: t, fields: [], available: true })), wipes: [] };
      if (m === 'transitions.set') { const { canvas, ...t } = p; cur[canvas] = { ...t, available: true }; return {}; }
      if (m === 'scenes.activate') { active.H = p.scene; return { ok: true }; }
      return {};
    },
  };
  const flags = createFlags({ dataDir: dir });
  flags.set(TRANSITIONS_FLAG, true);
  const KEY = 'k'.repeat(48);
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 60000 } });
  const { port } = await srv.listen();
  const req = (method, url, headers, body) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject);
    r.end(body);
  });
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await req('GET', '/ui/api/session', { cookie })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (url, body) => req('POST', url, hdr, JSON.stringify(body));
    const scene = () => JSON.parse(readFileSync(file, 'utf8')).scenes.find((s) => s.id === 'second');

    const ch = (await req('GET', '/ui/api/project/transitions', { cookie })).body;
    assert.ok(ch.kinds.filter((k) => k.shader === true).map((k) => k.id).join() === STYLES.join(), 'the form marks the shader kinds');
    assert.ok(ch.curves.some((c) => c.id === 'in-out-sine'), 'curves without flag stream-settings');
    assert.deepEqual(ch.scenes.map((s) => [s.id, s.transition]).at(-1), ['second', null]);

    let r = await post('/ui/api/project/transition', { scene: 'second', type: 'motionSwipe', durationMs: 450, easing: 'in-out-cubic', direction: 'right' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(scene().transition, { type: 'motionSwipe', durationMs: 450, easing: 'in-out-cubic', direction: 'right' });
    assert.equal((await post('/ui/api/project/transition', { scene: 'nope', type: 'pop', durationMs: 400 })).body.error, 'unknown-scene');
    assert.equal((await post('/ui/api/project/transition', { scene: 'second', canvas: 'h', type: 'pop', durationMs: 400 })).status, 400, 'scene or canvas, not both');
    assert.equal((await post('/ui/api/project/transition', { scene: 'second', type: 'stinger', preset: 'cyan-grid' })).status, 400, 'built-in stingers are per canvas');
    assert.equal((await post('/ui/api/project/transition', { scene: 'second', type: 'glitch', durationMs: 400, direction: 'left' })).status, 400, 'validator: glitch has no direction');
    assert.equal((await post('/ui/api/project/transition', { canvas: 'h', type: 'pop', durationMs: 400, easing: 'bogus-curve' })).status, 400, 'unknown curve');
    assert.equal((await post('/ui/api/project/transition', { canvas: 'h', type: 'inherit' })).status, 400, 'inherit is for a scene');

    // switching to the scene: its own transition is set on the host before scenes.activate
    calls.length = 0;
    r = await post('/ui/api/host', { method: 'scenes.activate', params: { scene: 'second' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const iSet = calls.findIndex(([m, p]) => m === 'transitions.set' && p.canvas === 'H');
    const iAct = calls.findIndex(([m]) => m === 'scenes.activate');
    assert.ok(iSet >= 0 && iSet < iAct, JSON.stringify(calls.map(([m]) => m)));
    assert.deepEqual(calls[iSet][1], { canvas: 'H', type: 'motionSwipe', durationMs: 450, easing: 'in-out-cubic', direction: 'right' });
    // back to the first scene: the canvas fade again, before the switch
    calls.length = 0;
    await post('/ui/api/host', { method: 'scenes.activate', params: { scene: doc.scenes[0].id } });
    assert.deepEqual(calls.find(([m]) => m === 'transitions.set')?.[1], { canvas: 'H', type: 'fade', durationMs: 300 });

    // Same as the canvas: the scene's own transition is taken off
    r = await post('/ui/api/project/transition', { scene: 'second', type: 'inherit' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(scene().transition, undefined);
    calls.length = 0;
    await post('/ui/api/host', { method: 'scenes.activate', params: { scene: 'second' } });
    assert.equal(calls.filter(([m]) => m === 'transitions.set').length, 0, 'the canvas fade is already set');
  } finally { await srv.close(); }
});
