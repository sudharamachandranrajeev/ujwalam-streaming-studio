// SPDX-License-Identifier: GPL-3.0-or-later
// New scene from a reference in the QML studio (plan Q4 row G, flag scene-builder): More > "New scene from a reference…"
// lists the pictures and videos of the stream assets folder, Build shows the new scene in plain words (nothing written),
// "Add this scene" adds it with one click: the host gets the H and V scene, the project file one more scene, the other
// scenes unchanged. Hidden without the flag; Build and Add are off while live. The route itself is tested in
// studio-ui-scene-builder.test.mjs. Headless probe (UJWALAM_HEADLESS=1, never on a screen) against a real UI server
// and the fake host. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset, mergeCanvasScenes } from '../services/project/scene-preset.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';
import { layoutH, writePng } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const REF = 'ref layout.png';

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

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
  return out;
}

describe('QML studio: new scene from a reference (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 900), flagsOn = ['scene-builder'], live = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-sb-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    flags.set('scene-builder', flagsOn.includes('scene-builder')); // on by default since D390: [] means off here
    for (const id of flagsOn) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    const assetsDir = path.join(dataDir, 'assets'); mkdirSync(assetsDir);
    writePng(layoutH().canvas, assetsDir, REF.replace(/\.png$/, ''));
    const doc0 = project();
    saveProject(file, doc0);
    const fake = createFakeHost({ outputsReady: true });
    if (live) await fake.call('stream.start', {});
    const calls = [];
    const host = { describe: () => fake.describe(), call: (m, p) => { if (!['host.status', 'outputs.status'].includes(m)) calls.push([m, p]); return fake.call(m, p); } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 's'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }), assetsDir,
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, sb: p.state.sceneBuilder, doc0, doc: () => JSON.parse(readFileSync(file, 'utf8')), calls };
    } finally { await srv.close(); }
  }
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const open = ['more-open', 'more:scenebuilder'];
  const WAIT = [`sb-pick:${REF}`]; // a quiet action: the window gets its answer before the next one

  test('flag off: no menu item; flag on: the item with its tip', async () => {
    const r = await probe({ actions: ['more-open', 'more:scenebuilder'], flagsOn: [] });
    assert.equal(done(r.p)['more:scenebuilder'], false);
    assert.ok(!r.s.more.items.some((i) => i.id === 'scenebuilder'));
    assert.equal(r.sb.open, false);
    const on = await probe({ actions: ['more-open'] });
    const item = on.s.more.items.find((i) => i.id === 'scenebuilder');
    assert.ok(item, JSON.stringify(on.s.more.items));
    assert.equal(item.text, 'New scene from a reference…');
    assert.match(item.tip, /Your other scenes stay as they are\./);
  });

  test('More > New scene from a reference: Build shows the plan in plain words and writes nothing; Add this scene adds one scene host first', async () => {
    const dry = await probe({ actions: [...open, ...WAIT, ...WAIT, 'sb-build', ...WAIT, ...WAIT] });
    const d = done(dry.p);
    assert.equal(d['more:scenebuilder'], true, JSON.stringify(dry.p.actions));
    assert.equal(d['sb-build'], true, JSON.stringify(dry.p.actions));
    assert.deepEqual(dry.sb.refs, [REF]);
    assert.equal(dry.sb.info, 'Dry run: nothing written yet.');
    assert.match(dry.sb.words[0], /^Adds one new scene ".+" \(H and V, \d+ layers\)\./);
    assert.ok(dry.sb.words.some((w) => /^(H|V): /.test(w)), 'a line per new layer');
    assert.notEqual(dry.sb.built, '');
    assert.equal(dry.sb.canAdd, true);
    assert.deepEqual(dry.doc(), JSON.parse(JSON.stringify(dry.doc0)), 'Build writes nothing');
    assert.ok(!dry.calls.some(([m]) => m === 'scenes.create'), 'Build sends nothing to the host');

    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'sb-build', ...WAIT, ...WAIT, 'sb-add', ...WAIT, ...WAIT], ms: 14000 });
    assert.equal(done(r.p)['sb-add'], true, JSON.stringify(r.p.actions));
    const creates = r.calls.filter(([m]) => m === 'scenes.create');
    assert.deepEqual(creates.map(([, p]) => p.scene.canvas), ['H', 'V']);
    const id = creates[0][1].scene.id;
    assert.ok(r.calls.some(([m, p]) => m === 'layers.addFromProject' && p.scene === id));
    const saved = r.doc();
    assert.equal(saved.scenes.length, r.doc0.scenes.length + 1);
    for (const s of r.doc0.scenes) assert.deepEqual(saved.scenes.find((x) => x.id === s.id), JSON.parse(JSON.stringify(s)), 'other scenes unchanged');
    assert.equal(validateProject(saved).ok, true);
    assert.match(r.sb.info, /^Added ".+" \(\d+ layers\)\.$/);
    assert.equal(r.sb.built, '');
    assert.equal(r.sb.canAdd, false, 'the build is used up');
    assert.match(r.s.note, /^Scene added: /);
    const name = saved.scenes.find((s) => s.id === id).name;
    assert.ok(r.s.scenes.some((n) => n.startsWith(name)), `the scene list shows the new scene: ${JSON.stringify(r.s.scenes)}`);
  });

  test('live: the window lists the files but Build and Add stay off, and say why', async () => {
    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'sb-build'], live: true });
    assert.equal(done(r.p)['sb-build'], false);
    assert.equal(r.sb.canBuild, false);
    assert.equal(r.sb.canAdd, false);
    assert.deepEqual(r.sb.refs, [REF]);
    assert.ok(r.p.tree.find((n) => n.name === 'sbLiveNote')?.visible !== false);
    assert.ok(!r.calls.some(([m]) => m === 'scenes.create'));
  });
});
