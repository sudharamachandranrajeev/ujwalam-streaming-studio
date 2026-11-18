// SPDX-License-Identifier: GPL-3.0-or-later
// Scenario scenes in the studio (D390): /ui/api/scene-templates routes. No flag (the scenario picker needs none): the
// list, the read-only capture targets, a dry-run build in plain words, one-click apply (off air only), the same
// existing-state guarantee as the scene builder. The host is a stub: no exe, no GPU.
//
// DEPENDS ON THE CAPTURE BRANCH: a build with a picked window or screen makes a "window" / "screen" layer, which the
// project schema (owned by that branch) must know before the project validates; those two tests run only then.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { stateHash, withoutAdded } from '../services/project/scene-package.mjs';
import { loadScenePreset, mergeCanvasScenes } from '../services/project/scene-preset.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
const WINDOW_LAYERS = JSON.stringify(rd('data/schemas/project.schema.json')).includes('"window"');
const gate = WINDOW_LAYERS ? false : 'needs the capture branch: project schema without layer types window / screen';
const TARGETS = { displays: [{ id: 'display-1', name: 'Display 1', width: 2560, height: 1440 }], windows: [{ id: 'Example App:ExampleClass:example.exe', title: 'Example App', exe: 'example.exe' }] };

function project() {
  const profile = rd('tests/fixtures/project/profile.fixture.json');
  const p = createProject({ name: 'T' });
  p.devices.push({ id: 'dev-cap', kind: 'capture-card', name: 'Capture', match: { name: 'cap' }, origin: { importer: 'alpha', id: 'role/game-capture' } });
  p.devices.push({ id: 'dev-cam', kind: 'camera', name: 'Camera', match: { name: 'cam' }, origin: { importer: 'alpha', id: 'role/facecam' } });
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const h = loadScenePreset(p, rd('registry/presets/scene-default-h.json'), { profile, roles });
  const v = loadScenePreset(h.project, rd('registry/presets/scene-default-v.json'), { profile, roles });
  const out = mergeCanvasScenes(v.project, h.sceneId, v.sceneId).project;
  out.scenes = out.scenes.filter((s) => s.layers.length);
  out.activeScene = out.scenes[0].id;
  assert.ok(validateProject(out).ok);
  return out;
}

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

async function setup({ targets = TARGETS } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sc-ui-'));
  const file = path.join(dir, 'p.project.json');
  const doc = project();
  saveProject(file, doc);
  const calls = [];
  const state = { live: false, fail: false };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    if (m === 'outputs.status') return {};
    if (m === 'capture.listTargets') { if (!targets) throw new Error('unknown method'); return targets; }
    if (state.fail) throw new Error('host says no');
    calls.push([m, p.scene?.id ?? p.scene, p.layer, p.scene?.canvas]);
    return {};
  } };
  const flags = createFlags({ dataDir: dir }); // scene-builder is not switched on here: scenarios need no flag
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, assetsDir: dir, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
  const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
  return {
    srv, doc, calls, state, flags, file,
    post: (url, body) => raw(port, { method: 'POST', url: `/ui/api/scene-templates${url}`, body: JSON.stringify(body), headers: hdr }),
    get: (url = '') => raw(port, { url: `/ui/api/scene-templates${url}`, headers: { cookie } }),
    disk: () => JSON.parse(readFileSync(file, 'utf8')),
  };
}

test('scenario routes: list, no flag needed, dry run in plain words, live lock, one-click apply adds one H+V scene host first, existing state unchanged', async () => {
  const t = await setup();
  try {
    assert.equal(t.flags.isOn('scene-builder'), true, 'scene-builder is on by default (user-requested feature)');
    t.flags.set('scene-builder', false);
    // the list needs no flag
    let r = await t.get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.templates.map((x) => x.id), ['gameplay', 'lobby', 'screen-share', 'starting-soon', 'brb', 'ending']);
    const lobby = r.body.templates.find((x) => x.id === 'lobby');
    assert.equal(lobby.label, 'Lobby / just chatting');
    assert.ok(lobby.preview.h.length && lobby.preview.v.length);
    assert.ok(lobby.preview.h.every((s) => typeof s.role === 'string' && s.box.w > 0));
    assert.equal(r.body.templates.find((x) => x.id === 'screen-share').needsScreen, true);

    // bad params, unknown template, nothing built
    assert.equal((await t.post('/build', { template: 'gameplay', x: 1 })).status, 400);
    assert.equal((await t.post('/build', { template: 5 })).status, 400);
    assert.equal((await t.post('/build', { template: 'nope' })).body.error, 'unknown-template');
    assert.equal((await t.post('/build', { template: 'gameplay', bind: { screen: { kind: 'window', target: 'a' } } })).status, 400, 'bind only for a template that needs a screen');
    assert.equal((await t.post('/apply', {})).body.error, 'nothing-built');

    // live: refused, nothing read
    t.state.live = true;
    assert.equal((await t.post('/build', { template: 'gameplay' })).body.error, 'live-locked');
    t.state.live = false;

    // dry run: a plan with one new scene (H and V), nothing written, nothing sent
    r = await t.post('/build', { template: 'gameplay' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'Gameplay');
    assert.equal(r.body.diff.adds.scenes.length, 1);
    assert.deepEqual(r.body.diff.adds.scenes[0].canvases, ['h', 'v']);
    assert.match(r.body.words[0], /^Adds one new scene "Gameplay" \(H and V, \d+ layers\)\. Your other scenes, layers, devices and settings stay as they are\.$/);
    assert.equal(r.body.words.filter((w) => /^(H|V): /.test(w)).length, r.body.diff.adds.layers.length);
    assert.deepEqual(t.disk(), JSON.parse(JSON.stringify(t.doc)), 'a build writes nothing');
    assert.equal(t.calls.length, 0, 'a build sends nothing to the host');

    // apply while live: refused; a host refusal saves nothing and keeps the build
    t.state.live = true;
    assert.equal((await t.post('/apply', {})).body.error, 'live-locked');
    t.state.live = false;
    t.state.fail = true;
    assert.equal((await t.post('/apply', {})).status, 502);
    assert.equal(t.disk().scenes.length, t.doc.scenes.length);
    t.state.fail = false;
    t.calls.length = 0;

    assert.equal((await t.post('/apply', { x: 1 })).status, 400, 'apply takes no params: one click');
    r = await t.post('/apply', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, true);
    const id = r.body.scene.id;
    assert.deepEqual(t.calls.slice(0, 2).map((c) => [c[0], c[1], c[3]]), [['scenes.create', id, 'H'], ['scenes.create', id, 'V']]);
    assert.ok(t.calls.slice(2).every((c) => c[0] === 'layers.addFromProject' && c[1] === id));
    assert.equal(t.calls.length - 2, r.body.layers);
    const saved = t.disk();
    assert.equal(saved.scenes.length, t.doc.scenes.length + 1);
    assert.equal(saved.scenes.find((s) => s.id === id).name, 'Gameplay');
    const addedOverlays = saved.overlays.map((o) => o.id).filter((o) => !t.doc.overlays.some((d) => d.id === o));
    assert.equal(stateHash(withoutAdded(saved, { scenes: [id], overlays: addedOverlays })), stateHash(t.doc), 'existing scenes, layers, devices and settings unchanged');
    assert.equal(validateProject(saved).ok, true);
    assert.equal((await t.post('/apply', {})).body.error, 'nothing-built', 'the build is used up');
  } finally { await t.srv.close(); }
});

test('scenario routes: holding screens carry their message (editable text), screen share without a pick keeps a placeholder', async () => {
  const t = await setup();
  try {
    let r = await t.post('/build', { template: 'starting-soon', text: 'Back at eight' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.name, 'Starting soon');
    assert.equal((await t.post('/build', { template: 'starting-soon', text: 'x'.repeat(81) })).status, 400);
    r = await t.post('/apply', {});
    assert.equal(r.status, 200);
    const sc = t.disk().scenes.find((s) => s.id === r.body.scene.id);
    assert.ok(sc.layers.some((l) => l.type === 'browser' && /(^|&)text=Back\+at\+eight(&|$)/.test(l.source.query)), 'the message is on the panel');

    r = await t.post('/build', { template: 'screen-share' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.words.some((w) => /^To set up later: screen on H /.test(w)), JSON.stringify(r.body.words));
    assert.ok(r.body.words.some((w) => /^To set up later: screen on V /.test(w)));
    assert.equal(r.body.diff.adds.layers.filter((l) => l.placeholder && /no window or screen/.test(l.placeholder)).length, 2);
    // a second scene of the same name is numbered, never replaced
    assert.equal((await t.post('/apply', {})).status, 200);
    r = await t.post('/build', { template: 'starting-soon' });
    assert.equal(r.body.name, 'Starting soon (2)');
  } finally { await t.srv.close(); }
});

test('scenario routes: capture targets are read only and only a target the host listed can be picked', async () => {
  const t = await setup();
  try {
    let r = await t.get('/targets');
    assert.deepEqual(r.body, { available: true, ...TARGETS });
    assert.equal((await t.post('/build', { template: 'screen-share', bind: { screen: { kind: 'window', target: 'made up' } } })).body.error, 'unknown-target');
    assert.equal((await t.post('/build', { template: 'screen-share', bind: { screen: { kind: 'screen', target: 'made up' } } })).body.error, 'unknown-target');
    assert.equal((await t.post('/build', { template: 'screen-share', bind: { screen: { kind: 'tv', target: 'a' } } })).status, 400);
    assert.equal((await t.post('/build', { template: 'screen-share', bind: { screen: { kind: 'window' } } })).status, 400);
    assert.equal((await t.post('/build', { template: 'screen-share', bind: { window: 'x' } })).status, 400);
    assert.equal(t.calls.length, 0);
  } finally { await t.srv.close(); }

  // a host without the call (the capture branch is not merged): an empty list, never an error page
  const n = await setup({ targets: null });
  try {
    const r = await n.get('/targets');
    assert.deepEqual(r.body, { available: false, displays: [], windows: [] });
  } finally { await n.srv.close(); }
});

test('scenario routes: a picked window makes one new window layer per canvas (needs the capture branch schema)', { skip: gate }, async () => {
  const t = await setup();
  try {
    let r = await t.post('/build', { template: 'screen-share', bind: { screen: { kind: 'window', target: TARGETS.windows[0].id } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.words.some((w) => /^H: Screen: shows the window you picked$/.test(w)), JSON.stringify(r.body.words));
    assert.ok(!r.body.diff.placeholders.some((p) => p.role === 'screen'));
    r = await t.post('/apply', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sc = t.disk().scenes.find((s) => s.id === r.body.scene.id);
    assert.equal(sc.layers.filter((l) => l.type === 'window').length, 2);
    assert.equal(validateProject(t.disk()).ok, true);
  } finally { await t.srv.close(); }
});

test('scenario routes: a picked whole screen makes a screen layer sized by the display (needs the capture branch schema)', { skip: gate }, async () => {
  const t = await setup();
  try {
    let r = await t.post('/build', { template: 'screen-share', bind: { screen: { kind: 'screen', target: 'display-1' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await t.post('/apply', {});
    const sc = t.disk().scenes.find((s) => s.id === r.body.scene.id);
    assert.equal(sc.layers.filter((l) => l.type === 'screen').length, 2);
  } finally { await t.srv.close(); }
});
