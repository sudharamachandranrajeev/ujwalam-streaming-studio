// SPDX-License-Identifier: GPL-3.0-or-later
// Scenario picker in the QML studio (D390): Add scene > "From a scenario..." opens a grid of scenario cards, picking one
// shows the plan in plain words (nothing written), "Add scene" adds one new H + V scene with one click. Screen share asks
// for a window (default) or a whole screen from the host's read-only list (the fake host answers placeholders). No
// flag needed. Headless probe (UJWALAM_HEADLESS=1, never on a screen) against a real UI server and the fake host.
// Skipped when the shell is not built.
// DEPENDS ON THE CAPTURE BRANCH: the plan of a screen share with a picked window or screen makes a window / screen layer,
// which the project schema (owned by that branch) must know first; those checks run only then.
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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const WINDOW_LAYERS = JSON.stringify(rd('data/schemas/project.schema.json')).includes('"window"');

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
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

describe('QML studio: Add scene > From a scenario (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 900), sceneBuilderFlag = true, live = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-scn-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    flags.set('scene-builder', sceneBuilderFlag); // the scenario picker needs no flag: it works either way
    const file = path.join(dataDir, 'p.project.json');
    const assetsDir = path.join(dataDir, 'assets'); mkdirSync(assetsDir);
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
      return { p, s: p.state, sc: p.state.scenarios, doc0, doc: () => JSON.parse(readFileSync(file, 'utf8')), calls };
    } finally { await srv.close(); }
  }
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const open = ['scn-open'];
  const WAIT = ['scn-wait']; // a quiet action: the window gets its answer before the next one

  test('Add scene has "From a scenario…"; it opens the picker with six cards, no flag needed', async () => {
    const r = await probe({ actions: ['scn-from-add-scene', ...WAIT, ...WAIT], sceneBuilderFlag: false });
    assert.equal(done(r.p)['scn-from-add-scene'], true, JSON.stringify(r.p.actions));
    assert.equal(r.sc.open, true);
    assert.deepEqual(r.sc.cards, ['gameplay', 'lobby', 'screen-share', 'starting-soon', 'brb', 'ending']);
    assert.ok(r.sc.labels.includes('Lobby / just chatting'));
    assert.equal(r.sc.selected, '');
    assert.equal(r.sc.canAdd, false);
    assert.match(r.sc.info, /^Pick a scenario\./);
    assert.deepEqual(r.doc(), JSON.parse(JSON.stringify(r.doc0)), 'opening writes nothing');
  });

  test('pick a card: the plan in plain words and nothing written; Add scene adds one H + V scene, host first, other scenes unchanged', async () => {
    const dry = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:gameplay', ...WAIT, ...WAIT] });
    assert.equal(done(dry.p)['scn-pick:gameplay'], true, JSON.stringify(dry.p.actions));
    assert.equal(dry.sc.selected, 'gameplay');
    assert.equal(dry.sc.needsScreen, false);
    assert.equal(dry.sc.built, 'Gameplay');
    assert.match(dry.sc.words[0], /^Adds one new scene "Gameplay" \(H and V, \d+ layers\)\./);
    assert.ok(dry.sc.words.some((w) => /^(H|V): /.test(w)), 'a line per new layer');
    assert.equal(dry.sc.canAdd, true);
    assert.deepEqual(dry.doc(), JSON.parse(JSON.stringify(dry.doc0)), 'planning writes nothing');
    assert.ok(!dry.calls.some(([m]) => m === 'scenes.create'), 'planning sends nothing to the host');

    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:lobby', ...WAIT, ...WAIT, 'scn-add', ...WAIT, ...WAIT], ms: 14000 });
    assert.equal(done(r.p)['scn-add'], true, JSON.stringify(r.p.actions));
    const creates = r.calls.filter(([m]) => m === 'scenes.create');
    assert.deepEqual(creates.map(([, p]) => p.scene.canvas), ['H', 'V']);
    const id = creates[0][1].scene.id;
    assert.ok(r.calls.some(([m, p]) => m === 'layers.addFromProject' && p.scene === id));
    const saved = r.doc();
    assert.equal(saved.scenes.length, r.doc0.scenes.length + 1);
    assert.equal(saved.scenes.find((s) => s.id === id).name, 'Lobby');
    for (const s of r.doc0.scenes) assert.deepEqual(saved.scenes.find((x) => x.id === s.id), JSON.parse(JSON.stringify(s)), 'other scenes unchanged');
    assert.equal(validateProject(saved).ok, true);
    assert.match(r.sc.info, /^Added "Lobby" \(\d+ layers\)\./);
    assert.equal(r.sc.built, '');
    assert.equal(r.sc.canAdd, false, 'the plan is used up');
    assert.match(r.s.note, /^Scene added: /);
    assert.ok(r.s.scenes.some((n) => n.startsWith('Lobby')), JSON.stringify(r.s.scenes));
  });

  test('a holding screen (starting soon) plans without a camera and without the screen picker', async () => {
    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:starting-soon', ...WAIT, ...WAIT] });
    assert.equal(r.sc.built, 'Starting soon');
    assert.equal(r.sc.needsScreen, false);
    assert.ok(!r.sc.words.some((w) => /Camera/.test(w)));
  });

  test('screen share asks for a window (default) or a whole screen from the host list (placeholders only)', async () => {
    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:screen-share', ...WAIT, ...WAIT] });
    assert.equal(r.sc.selected, 'screen-share');
    assert.equal(r.sc.needsScreen, true);
    assert.equal(r.sc.kind, 'window', 'a window is the default');
    assert.equal(r.sc.targetsAvailable, true);
    assert.deepEqual(r.sc.targetList, ['Example App  (example.exe)']);
    assert.equal(r.sc.targetId, 'Example App:ExampleClass:example.exe');
    const screens = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:screen-share', ...WAIT, ...WAIT, 'scn-kind:screen', ...WAIT, ...WAIT] });
    assert.equal(screens.sc.kind, 'screen');
    assert.deepEqual(screens.sc.targetList, ['Display 1  (1920 x 1080)']);
    assert.equal(screens.sc.targetId, 'display-1');
    assert.deepEqual(screens.doc(), JSON.parse(JSON.stringify(screens.doc0)), 'picking writes nothing');
  });

  test('a picked window is planned and added as one new window layer per canvas (needs the capture branch schema)', { skip: WINDOW_LAYERS ? false : 'needs the capture branch: project schema without layer types window / screen' }, async () => {
    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:screen-share', ...WAIT, ...WAIT, 'scn-add', ...WAIT, ...WAIT], ms: 14000 });
    assert.equal(done(r.p)['scn-add'], true, JSON.stringify(r.p.actions));
    const sc = r.doc().scenes.find((s) => s.name === 'Screen share');
    assert.equal(sc.layers.filter((l) => l.type === 'window').length, 2);
  });

  test('live: the cards do nothing, Add scene stays off, and the window says why', async () => {
    const r = await probe({ actions: [...open, ...WAIT, ...WAIT, 'scn-pick:gameplay'], live: true });
    assert.equal(done(r.p)['scn-pick:gameplay'], false);
    assert.equal(r.sc.selected, '');
    assert.equal(r.sc.canAdd, false);
    assert.ok(r.p.tree.find((n) => n.name === 'scenarioLiveNote')?.visible !== false);
    assert.ok(!r.calls.some(([m]) => m === 'scenes.create'));
  });
});
