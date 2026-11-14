// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder in the studio (plan Q4 row G, flag scene-builder): the UI server routes. A drawn reference picture in
// a temp stream assets folder is read for real (SB2), built (SB3) and planned as a dry run; "apply" adds one new scene
// to the host first (H and V, then the layers bottom first) and then to the project file, with every existing scene,
// layer, device and setting unchanged (the import rule). Refused while live, without the flag, for a file that is not
// in the assets folder, and with nothing built. The host is a stub: no exe, no GPU.
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
import { SCENE_BUILDER_FLAG } from '../services/studio-ui/scene-builder-routes.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { layoutH, writePng } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));

/** Capture card + camera, Default H + V in one scene (as tests/scene-builder-build.test.mjs). */
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

test('scene builder routes: flag gate, dry-run build, live lock, apply adds one scene host first, existing state unchanged', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb-ui-'));
  const assetsDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb-assets-'));
  writePng(layoutH().canvas, assetsDir, 'ref layout');
  const file = path.join(dir, 'p.project.json');
  const doc = project();
  saveProject(file, doc);
  const before = stateHash(doc);
  const calls = [];
  const state = { live: false, fail: false };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    if (m === 'outputs.status') return {};
    if (state.fail) throw new Error('host says no');
    calls.push([m, p.scene?.id ?? p.scene, p.layer, p.scene?.canvas]);
    return {};
  } };
  const flags = createFlags({ dataDir: dir });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, assetsDir, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (url, body) => raw(port, { method: 'POST', url: `/ui/api/scene-builder${url}`, body: JSON.stringify(body), headers: hdr });
    const get = () => raw(port, { url: '/ui/api/scene-builder', headers: { cookie } });
    const disk = () => JSON.parse(readFileSync(file, 'utf8'));

    // off by default: every route 404, nothing read
    assert.equal(flags.isOn(SCENE_BUILDER_FLAG), false);
    assert.deepEqual([(await get()).status, (await get()).body.error], [404, 'scene-builder-off']);
    assert.equal((await post('/build', { file: 'ref layout.png' })).body.error, 'scene-builder-off');
    flags.set(SCENE_BUILDER_FLAG, true);

    // the list: only pictures and videos of the assets folder
    let r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.body.available, true);
    assert.deepEqual(r.body.references, [{ rel: 'ref layout.png', kind: 'image' }]);
    assert.equal(r.body.built, null);

    // a file the page made up, bad params, nothing built yet
    assert.equal((await post('/build', { file: '../p.project.json' })).body.error, 'unknown-reference');
    assert.equal((await post('/build', { file: 'ref layout.png', x: 1 })).status, 400);
    assert.equal((await post('/apply', {})).body.error, 'nothing-built');

    // live: refused, nothing read
    state.live = true;
    assert.equal((await post('/build', { file: 'ref layout.png' })).body.error, 'live-locked');
    state.live = false;

    // dry run: a plan with one new scene, nothing written, nothing sent
    r = await post('/build', { file: 'ref layout.png' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.diff.adds.scenes.length, 1);
    assert.ok(r.body.diff.adds.layers.length > 0);
    assert.equal(typeof r.body.name, 'string');
    assert.match(r.body.words[0], /^Adds one new scene ".+" \(H and V, \d+ layers\)\. Your other scenes, layers, devices and settings stay as they are\.$/);
    assert.equal(r.body.words.filter((w) => /^(H|V): /.test(w)).length, r.body.diff.adds.layers.length, 'a line per new layer');
    assert.ok(r.body.words.every((w) => typeof w === 'string' && w.length > 0));
    assert.deepEqual(disk(), JSON.parse(JSON.stringify(doc)), 'a build writes nothing');
    assert.equal(calls.length, 0, 'a build sends nothing to the host');
    assert.deepEqual((await get()).body.built, { name: r.body.name, file: 'ref layout.png' });

    // apply while live: refused; a host refusal saves nothing and keeps the build
    state.live = true;
    assert.equal((await post('/apply', {})).body.error, 'live-locked');
    state.live = false;
    state.fail = true;
    assert.equal((await post('/apply', {})).status, 502);
    assert.equal(disk().scenes.length, doc.scenes.length);
    state.fail = false;
    calls.length = 0;

    // apply: H and V scene, then the layers bottom first, then the file
    r = await post('/apply', { x: 1 });
    assert.equal(r.status, 400, 'apply takes no params');
    r = await post('/apply', {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, true);
    const id = r.body.scene.id;
    assert.deepEqual(calls.slice(0, 2).map((c) => [c[0], c[1], c[3]]), [['scenes.create', id, 'H'], ['scenes.create', id, 'V']]);
    assert.ok(calls.slice(2).every((c) => c[0] === 'layers.addFromProject' && c[1] === id));
    assert.equal(calls.length - 2, r.body.layers);
    const saved = disk();
    assert.equal(saved.scenes.length, doc.scenes.length + 1);
    assert.ok(saved.scenes.some((s) => s.id === id));
    const addedOverlays = saved.overlays.map((o) => o.id).filter((o) => !doc.overlays.some((d) => d.id === o));
    assert.equal(stateHash(withoutAdded(saved, { scenes: [id], overlays: addedOverlays })), before, 'existing scenes, layers, devices and settings unchanged');
    assert.equal(validateProject(saved).ok, true);
    assert.equal((await get()).body.built, null, 'the build is used up');
    assert.equal((await post('/apply', {})).body.error, 'nothing-built');
  } finally { await srv.close(); }
});
