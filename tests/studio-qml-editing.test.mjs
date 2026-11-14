// SPDX-License-Identifier: GPL-3.0-or-later
// Editing in the QML studio (plan Q4, section B): undo and redo, the arrow-key nudge, the layer menu and its keys, layer
// reorder, the scene menu and its keys. QML twins of the widget tests in tests/studio-qt-shell.test.mjs (layer menu, keys,
// reorder, scene menu, undo): same project, same routes, same words. Headless probe (UJWALAM_HEADLESS=1, offscreen, never
// on a screen) against a real UI server and the fake host. Probe actions: click:<objectName>, type:<objectName>=<text>,
// select-layer:<id>, layer-menu:show|blank|<item>, layer-key:<keys>, layer-drag:<fromRow>:<toRow> (rows top first),
// select-scene:<id>, scene-menu:show|blank|<item>, scene-key:<keys>, key:<keys>[:<times>] (window keys: Ctrl+Z, Ctrl+Y,
// Ctrl+Shift+Z, arrows with or without Shift). Skipped when the shell is not built (npm run build:studio).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 50_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// The same project as the widget menu tests: scene-1 (game, cam, chat) and scene-2 (text), matching the fake host.
function menuProject() {
  const doc = createProject({ name: 'T', fps: 30 });
  const place = (w, h) => ({ h: { visible: true, x: 0, y: 0, width: w, height: h }, v: { visible: true, x: 0, y: 0, width: 1080, height: 608 } });
  doc.scenes = [
    { id: 'scene-1', name: 'Gameplay', layers: [
      { id: 'game', type: 'color', name: 'Game capture', source: { color: '#101010' }, placements: place(1920, 1080) },
      { id: 'cam', type: 'color', name: 'Camera', source: { color: '#202020' }, placements: place(440, 248) },
      { id: 'chat', type: 'color', name: 'Chat overlay', source: { color: '#303030' }, visible: false, placements: place(480, 440) },
    ] },
    { id: 'scene-2', name: 'Starting soon', layers: [{ id: 'text', type: 'text', name: 'Title card', source: { text: 'Soon' }, placements: place(1920, 1080) }] },
  ];
  doc.activeScene = 'scene-1';
  doc.devices = [{ id: 'cam-dev', kind: 'camera', name: 'Face camera', match: { name: 'Cam' } }];
  const v = validateProject(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return doc;
}

describe('QML studio editing (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // opts: flags (ids switched on), live, project (a project file, default true), editing (host previewEditing), seed(fake).
  async function probe(actions = [], opts = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmled-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of opts.flags ?? []) flags.set(id, true);
    const fake = createFakeHost({ outputsReady: true });
    if (opts.live) await fake.call('stream.start', {});
    if (opts.seed) await opts.seed(fake);
    const calls = [];
    const host = { describe: () => fake.describe(), call: async (m, p) => {
      calls.push([m, p]);
      if (opts.editing && m === 'host.status') return { ...(await fake.call(m, p)), previewEditing: true, previewSelection: { seq: 0, H: null, V: null } };
      return fake.call(m, p);
    } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'e'.repeat(40);
    const file = opts.project === false ? null : path.join(dataDir, 'p.project.json');
    if (file) { const doc = menuProject(); opts.editProject?.(doc); saveProject(file, doc); }
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {},
      ...(file ? { projectSync: createProjectSync({ file, delayMs: 5 }) } : {}) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(opts.ms ?? 4000 + actions.length * 900),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, d: Object.fromEntries(p.actions.map((a) => [a.action, a.done])), done: p.actions.map((a) => a.done), calls, fake, file,
        doc: () => JSON.parse(readFileSync(file, 'utf8')), layersOf: async (scene = 'scene-1') => (await fake.call('layers.list', { scene })).layers };
    } finally { await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const names = (list) => list.map((l) => l.name).reverse(); // top first, as the list shows them
  const by = (items) => Object.fromEntries(items.map((i) => [i.id, i]));
  const ids = (doc, i = 0) => doc.scenes[i].layers.map((l) => l.id);

  // ---------------------------------------------------------------- undo and redo
  test('undo and redo buttons: off with no history; an edit makes Undo ready and its tip names the edit', async () => {
    const e = await probe();
    assert.equal(node(e.p, 'undoBtn').enabled, false);
    assert.equal(node(e.p, 'redoBtn').enabled, false);
    assert.equal(e.s.edit.canUndo, false);
    const r = await probe(['click:eye:chat']);
    assert.deepEqual(r.done, [true]);
    assert.equal(r.s.edit.undo, 1);
    assert.equal(node(r.p, 'undoBtn').enabled, true);
    assert.equal(node(r.p, 'redoBtn').enabled, false);
    assert.ok(r.s.edit.nextUndo.length > 0, 'the server names the next edit');
    assert.equal(r.s.layerPanel.undoTip, 'Undo: ' + r.s.edit.nextUndo);
    assert.equal(r.s.layerPanel.redoTip, 'Redo (Ctrl+Y)');
    // the heading's tools fit inside the panel and do not overlap each other
    const panel = node(r.p, 'layersPanel').rect;
    const tools = ['undoBtn', 'redoBtn', 'addLayer', 'deleteLayer'].map((n) => node(r.p, n).rect).sort((a, b) => a[0] - b[0]);
    assert.ok(tools[0][0] >= panel[0] + 60, 'the tools start after the heading word');
    assert.ok(tools.at(-1)[0] + tools.at(-1)[2] <= panel[0] + panel[2], 'the tools end inside the panel');
    tools.slice(1).forEach((t, i) => assert.ok(t[0] >= tools[i][0] + tools[i][2], 'no overlap'));
  });

  test('Undo button reverts the edit on the host, Redo applies it again', async () => {
    const u = await probe(['click:eye:chat', 'click:undoBtn']);
    assert.deepEqual(u.done, [true, true]);
    assert.equal((await u.layersOf()).find((l) => l.id === 'chat').visible, false, 'the eye click was undone');
    assert.equal(u.s.edit.redo, 1);
    assert.equal(node(u.p, 'redoBtn').enabled, true);
    assert.match(u.s.note, /^Undone: layers\.setVisible chat/);
    const r = await probe(['click:eye:chat', 'click:undoBtn', 'click:redoBtn']);
    assert.deepEqual(r.done, [true, true, true]);
    assert.equal((await r.layersOf()).find((l) => l.id === 'chat').visible, true);
    assert.match(r.s.note, /^Redone: layers\.setVisible chat/);
    assert.equal(r.s.edit.undo, 1);
  });

  test('Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z are window keys; the Shortcuts and the probe use the same table', async () => {
    const r = await probe(['click:eye:chat', 'key:Ctrl+Z', 'key:Ctrl+Shift+Z', 'key:Ctrl+Z', 'key:Ctrl+Y']);
    assert.deepEqual(r.done, [true, true, true, true, true]);
    assert.equal((await r.layersOf()).find((l) => l.id === 'chat').visible, true, 'undone, redone, undone, redone');
    for (const k of ['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Left', 'Shift+Up']) assert.ok(r.s.windowKeys.includes(k), k);
  });

  test('while live: Undo and Redo are greyed and say why; the key says so and sends nothing', async () => {
    const r = await probe(['key:Ctrl+Z'], { live: true });
    assert.equal(r.s.live, true);
    assert.equal(node(r.p, 'undoBtn').enabled, false);
    assert.equal(r.s.layerPanel.undoTip, 'Undo (not while live)');
    assert.equal(r.s.layerPanel.redoTip, 'Redo (not while live)');
    assert.match(r.s.note, /^Live: undo and redo are off/);
    assert.equal(r.calls.filter(([m]) => m === 'layers.setVisible').length, 0);
  });

  // ---------------------------------------------------------------- arrow-key nudge
  test('arrow keys nudge the selected layer 1 px, Shift 10 px, through layers.setPlacement', async () => {
    const r = await probe(['select-layer:cam', 'key:Right', 'key:Shift+Down', 'key:Left', 'key:Shift+Up'], { editing: true });
    assert.deepEqual(r.done, [true, true, true, true, true]);
    const sent = r.calls.filter(([m]) => m === 'layers.setPlacement').map(([, x]) => [x.layer, x.placement]);
    assert.deepEqual(sent, [['cam', { x: 1441 }], ['cam', { y: 50 }], ['cam', { x: 1440 }], ['cam', { y: 40 }]]);
    const cam = (await r.layersOf()).find((l) => l.id === 'cam').placement;
    assert.deepEqual([cam.x, cam.y], [1440, 40], 'each press added to the placement before it');
  });

  test('presses that come while a move is on its way add up into one more placement call', async () => {
    const r = await probe(['select-layer:cam', 'key:Right:3'], { editing: true });
    assert.deepEqual(r.done, [true, true]);
    const sent = r.calls.filter(([m]) => m === 'layers.setPlacement').map(([, x]) => x.placement);
    assert.deepEqual(sent, [{ x: 1441 }, { x: 1443 }], 'the first press at once, the other two together');
    assert.equal((await r.layersOf()).find((l) => l.id === 'cam').placement.x, 1443);
  });

  test('no nudge without preview editing, without a selected layer, or while live (live says so)', async () => {
    const off = await probe(['select-layer:cam', 'key:Right']);
    assert.deepEqual(off.done, [true, false]);
    assert.equal(off.calls.filter(([m]) => m === 'layers.setPlacement').length, 0);
    const none = await probe(['key:Right'], { editing: true });
    assert.deepEqual(none.done, [false]);
    const live = await probe(['select-layer:cam', 'key:Right'], { editing: true, live: true });
    assert.deepEqual(live.done, [true, true]);
    assert.match(live.s.note, /^Live: arrow keys are off\. Use the inspector\./);
    assert.equal(live.calls.filter(([m]) => m === 'layers.setPlacement').length, 0);
  });

  // ---------------------------------------------------------------- layer menu
  test('layer menu: items, keys and tips; Delete needs no flag; the list has its keys', async () => {
    const r = await probe(['select-layer:game', 'layer-menu:show']);
    assert.deepEqual(r.done, [true, true]);
    const m = r.s.layerPanel.menu;
    assert.equal(m.open, true);
    assert.deepEqual(m.items.map((i) => i.text), ['Add layer…', 'Duplicate', 'Rename…', 'Hide', 'Move up', 'Move down', 'Move to top', 'Move to bottom', 'Copy look', 'Paste look', 'Delete…']);
    const b = by(m.items);
    assert.deepEqual([b.duplicate.keys, b.rename.keys, b.delete.keys, b.copylook.keys, b.pastelook.keys], ['Ctrl+D', 'F2', 'Del', 'Ctrl+Shift+C', 'Ctrl+Shift+V']);
    assert.equal(b.duplicate.enabled, true, 'duplicate needs no flag');
    assert.deepEqual([b.delete.enabled, b.delete.tip], [true, ''], 'D330: delete needs no flag');
    assert.deepEqual([b.pastelook.enabled, b.pastelook.tip], [false, 'Copy a look first']);
    assert.deepEqual([b.down.enabled, b.up.enabled, b.bottom.enabled, b.top.enabled], [false, true, false, true], 'game is the bottom layer');
    assert.deepEqual(r.s.layerPanel.keys.slice().sort(), ['Ctrl+D', 'Ctrl+Shift+C', 'Ctrl+Shift+V', 'Del', 'F2']);
    assert.deepEqual(r.s.scenePanel.keys.slice().sort(), ['Del', 'F2']);
  });

  test('layer menu: Duplicate puts the copy right above the source, saves the project and selects the copy', async () => {
    const r = await probe(['select-layer:game', 'layer-menu:duplicate']);
    assert.deepEqual(r.done, [true, true]);
    assert.deepEqual(names(await r.layersOf()), ['Chat overlay', 'Camera', 'Game capture copy', 'Game capture'], 'top first');
    assert.equal(r.s.selected, 'game-copy');
    assert.deepEqual(r.calls.map(([m]) => m).filter((m) => m.endsWith('FromProject')), ['layers.addFromProject', 'layers.orderFromProject']);
    assert.deepEqual(ids(r.doc()), ['game', 'game-copy', 'cam', 'chat']);
    assert.equal(validateProject(r.doc()).ok, true);
    assert.match(r.s.note, /layer\.duplicate/);
  });

  test('layer menu: Rename opens a name box with the current name; the new name shows in the list and is saved', async () => {
    const r = await probe(['select-layer:cam', 'layer-menu:rename', 'type:renameName=Facecam big', 'click:renameOk']);
    assert.deepEqual(r.done, [true, true, true, true]);
    assert.deepEqual(r.s.layers.map((l) => l.name).reverse(), ['Chat overlay', 'Facecam big', 'Game capture'], 'the list shows the new name at once');
    assert.equal(r.doc().scenes[0].layers[1].name, 'Facecam big');
    const open = await probe(['select-layer:cam', 'layer-menu:rename']);
    assert.equal(node(open.p, 'renameBox').opened, true);
    assert.equal(node(open.p, 'renameName').text, 'Camera');
    const same = await probe(['select-layer:cam', 'layer-menu:rename', 'type:renameName=Camera', 'click:renameOk']);
    assert.equal(same.calls.filter(([m]) => m.endsWith('FromProject')).length, 0, 'an unchanged name sends nothing');
    assert.equal(same.doc().scenes[0].layers[1].name, 'Camera');
  });

  test('layer menu: Move to top and bottom are saved into the project; Show/Hide uses the host call', async () => {
    const r = await probe(['select-layer:game', 'layer-menu:top', 'layer-menu:visible', 'select-layer:chat', 'layer-menu:bottom']);
    assert.ok(r.done.every(Boolean), JSON.stringify(r.p.actions));
    assert.equal(r.calls.filter(([m]) => m === 'layers.move').length, 0, 'project layers: no live-only move');
    assert.equal(r.calls.filter(([m]) => m === 'layers.orderFromProject').length, 2);
    assert.deepEqual(ids(r.doc()), ['chat', 'cam', 'game'], 'bottom first: game on top, chat at the bottom');
    assert.deepEqual(r.calls.filter(([m]) => m === 'layers.setVisible').map(([, x]) => [x.layer, x.visible]), [['game', false]]);
  });

  test('layer menu: Move up and Move down each shift one place', async () => {
    const r = await probe(['select-layer:game', 'layer-menu:up', 'select-layer:chat', 'layer-menu:down']);
    assert.ok(r.done.every(Boolean), JSON.stringify(r.p.actions));
    // game up: cam, game, chat; chat down: cam, chat, game
    assert.deepEqual(ids(r.doc()), ['cam', 'chat', 'game']);
  });

  test('layer reorder by drag: a row moved to the top or bottom is saved; a layer the project lacks moves live-only', async () => {
    // rows top first: Chat overlay (0), Camera (1), Game capture (2)
    const r = await probe(['layer-drag:2:0', 'layer-drag:1:2']);
    assert.deepEqual(r.done, [true, true]);
    assert.deepEqual(ids(r.doc()), ['chat', 'cam', 'game']);
    assert.equal(r.calls.filter(([m]) => m === 'layers.orderFromProject').length, 2);
    const q = await probe(['layer-drag:2:0'], { project: false });
    assert.deepEqual(q.done, [true]);
    assert.equal(q.calls.filter(([m]) => m === 'layers.move').length, 1, 'no project file: the live-only host move');
    const same = await probe(['layer-drag:1:1']);
    assert.deepEqual(same.done, [false], 'a row dropped where it was moves nothing');
  });

  test('layer reorder: a layer the project lacks falls back to the host move, with the layer that was dragged', async () => {
    const r = await probe(['layer-drag:0:2'], { editProject: (doc) => { doc.scenes[0].layers = doc.scenes[0].layers.filter((l) => l.id !== 'chat'); } });
    assert.deepEqual(r.done, [true]);
    assert.deepEqual(r.calls.filter(([m]) => m === 'layers.move').map(([, x]) => [x.scene, x.layer, x.index]), [['scene-1', 'chat', 0]]);
    assert.equal(r.calls.filter(([m]) => m === 'layers.orderFromProject').length, 0);
  });

  test('layer menu: Copy look then Paste look sets the same effects on another layer through layers.setEffects', async () => {
    const seed = (f) => f.call('layers.setEffects', { scene: 'scene-1', layer: 'cam', effects: [{ type: 'rounded', radius: 40 }] });
    const r = await probe(['select-layer:cam', 'layer-menu:copylook', 'select-layer:game', 'layer-menu:pastelook'], { seed });
    assert.ok(r.done.every(Boolean), JSON.stringify(r.p.actions));
    assert.deepEqual(r.s.edit.lookClip, [{ type: 'rounded', radius: 40 }]);
    const list = await r.layersOf();
    assert.deepEqual(list.find((l) => l.id === 'game').effects, [{ type: 'rounded', radius: 40 }]);
    assert.deepEqual(list.find((l) => l.id === 'cam').effects, [{ type: 'rounded', radius: 40 }]);
    assert.match(r.s.note, /^Look applied\./);
    const none = await probe(['select-layer:game', 'layer-menu:pastelook']);
    assert.deepEqual(none.done, [true, false], 'Paste look is greyed until a look is copied');
  });

  test('layer menu: Delete removes the layer from the host and the project on the click, no flag, no question', async () => {
    const r = await probe(['select-layer:chat', 'layer-menu:delete']);
    assert.ok(r.done.every(Boolean));
    assert.deepEqual(names(await r.layersOf()), ['Camera', 'Game capture']);
    assert.equal(r.calls.filter(([m]) => m === 'layers.remove').length, 1, 'one click, one delete');
    assert.deepEqual(ids(r.doc()), ['game', 'cam']);
  });

  test('layer keys: Ctrl+D duplicates, Del deletes, F2 opens the rename box, Ctrl+Shift+C and V copy and paste a look', async () => {
    const seed = (f) => f.call('layers.setEffects', { scene: 'scene-1', layer: 'cam', effects: [{ type: 'rounded', radius: 12 }] });
    const r = await probe(['select-layer:cam', 'layer-key:Ctrl+Shift+C', 'select-layer:game', 'layer-key:Ctrl+Shift+V', 'layer-key:Ctrl+D', 'layer-key:F2'], { seed });
    assert.ok(r.done.every(Boolean), JSON.stringify(r.p.actions));
    const list = await r.layersOf();
    assert.deepEqual(list.find((l) => l.id === 'game').effects, [{ type: 'rounded', radius: 12 }]);
    assert.ok(list.some((l) => l.id === 'game-copy'), 'Ctrl+D made the copy');
    assert.equal(node(r.p, 'renameBox').opened, true, 'F2 on the selected layer (the copy)');
    assert.equal(node(r.p, 'renameName').text, 'Game capture copy');
    const d = await probe(['select-layer:chat', 'layer-key:Del']);
    assert.deepEqual(names(await d.layersOf()), ['Camera', 'Game capture']);
    const un = await probe(['layer-key:Ctrl+D', 'layer-key:F2']);
    assert.match(un.s.note, /^Select a layer first\./);
    assert.equal(node(un.p, 'renameBox').opened, false);
  });

  test('right-click on empty space offers only Add layer; Add layer in the menu opens the add window', async () => {
    const r = await probe(['layer-menu:blank']);
    assert.deepEqual(r.s.layerPanel.menu.items.map((i) => [i.id, i.text, i.enabled]), [['add', 'Add layer…', true]]);
    const a = await probe(['layer-menu:show', 'layer-menu:add']);
    assert.deepEqual(a.done, [true, true]);
    assert.equal(node(a.p, 'addLayerBox')?.opened ?? true, true);
  });

  test('while live: Add, Duplicate, Rename and Delete are greyed with "Not while live"; Show/Hide, Move and Copy stay on', async () => {
    const r = await probe(['select-layer:game', 'layer-menu:show', 'layer-menu:duplicate'], { live: true });
    assert.equal(r.s.live, true);
    const b = by(r.s.layerPanel.menu.items);
    for (const id of ['add', 'duplicate', 'rename', 'delete']) assert.deepEqual([id, b[id].enabled, b[id].tip], [id, false, 'Not while live']);
    for (const id of ['visible', 'up', 'copylook']) assert.equal(b[id].enabled, true, id);
    assert.deepEqual(r.done, [true, true, false], 'a greyed item does nothing');
    assert.equal(r.s.layers.length, 3);
    const k = await probe(['select-layer:game', 'layer-key:Ctrl+D'], { live: true });
    assert.match(k.s.note, /^Not while live\./);
    assert.equal(k.s.layers.length, 3);
  });

  // ---------------------------------------------------------------- scene menu
  test('scene menu: Duplicate scene copies it with its layers; Rename changes the name; both without a flag', async () => {
    const r = await probe(['select-scene:scene-2', 'scene-menu:duplicate', 'select-scene:scene-2', 'scene-menu:rename', 'type:renameName=Intro', 'click:renameOk']);
    assert.ok(r.done.every(Boolean), JSON.stringify(r.p.actions));
    assert.equal(r.s.scenes.length, 4);
    assert.ok(r.s.scenes.some((n) => n.startsWith('Intro')), JSON.stringify(r.s.scenes));
    assert.ok(r.s.scenes.some((n) => n.startsWith('Starting soon copy')), JSON.stringify(r.s.scenes));
    assert.deepEqual(r.doc().scenes.map((s) => s.id), ['scene-1', 'scene-2', 'scene-2-copy']);
    assert.equal(r.doc().scenes[2].layers.length, 1);
    assert.equal((await r.layersOf('scene-2-copy')).length, 1, 'the layers reached the host');
  });

  test('scene menu: items for a scene, Delete greyed without the flag and for the active scene; with the flag it removes another scene', async () => {
    const off = await probe(['select-scene:scene-2', 'scene-menu:show']);
    assert.deepEqual(off.s.scenePanel.menu.items.map((i) => [i.text, i.enabled]), [['Add scene…', true], ['Add layer…', true], ['Rename…', true], ['Duplicate scene', true], ['Delete…', false]]);
    assert.equal(off.s.scenePanel.menu.items[4].tip, 'Turn on scene editing in Settings > Editing');
    assert.equal(off.s.scenePanel.menu.items[2].keys, 'F2');
    const on = await probe(['select-scene:scene-1', 'scene-menu:delete', 'select-scene:scene-2', 'scene-menu:delete'], { flags: ['scene-edit'] });
    assert.deepEqual(on.done, [true, false, true, true], 'the active scene cannot be deleted');
    assert.equal(on.s.scenes.length, 2);
    assert.deepEqual(on.doc().scenes.map((s) => s.id), ['scene-1']);
    const act = await probe(['select-scene:scene-1', 'scene-menu:show'], { flags: ['scene-edit'] });
    assert.equal(by(act.s.scenePanel.menu.items).delete.tip, 'Switch to another scene first');
  });

  test('scene menu: Make realism scene shows only with flag realism-look, and makes one copy on the click', async () => {
    const off = await probe(['select-scene:scene-1', 'scene-menu:show']);
    assert.ok(!off.s.scenePanel.menu.items.some((i) => i.id === 'realism'));
    const on = await probe(['select-scene:scene-1', 'scene-menu:show'], { flags: ['realism-look'] });
    assert.deepEqual(on.s.scenePanel.menu.items.map((i) => i.id), ['addscene', 'add', 'rename', 'duplicate', 'realism', 'delete']);
    // a scene with no game capture: the click reaches the route and the refusal is said in plain words
    const none = await probe(['select-scene:scene-1', 'scene-menu:realism'], { flags: ['realism-look'] });
    assert.deepEqual(none.done, [true, true]);
    assert.equal(none.s.note, 'Not done: This scene shows no game capture, so there is nothing to grade.');
    assert.equal(none.s.scenes.length, 3);
    // a project whose scene shows the game capture card: one click makes the graded copy, the original stays
    const withCard = (doc) => {
      doc.devices.push({ id: 'card', kind: 'capture-card', name: 'Card', match: { name: 'Card' } });
      const pl = { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 }, v: { visible: true, x: 0, y: 0, width: 1080, height: 608 } };
      doc.scenes[0].layers.push({ id: 'gamecard', type: 'capture', name: 'Game card', source: { device: 'card' }, placements: pl });
    };
    const run = await probe(['select-scene:scene-1', 'scene-menu:realism'], { flags: ['realism-look'], editProject: withCard });
    assert.deepEqual(run.done, [true, true]);
    assert.match(run.s.note, /^Realism scene made: .+ \(1 game layer\(s\) graded\)/);
    assert.equal(run.s.scenes.length, 4, 'a new scene next to the original');
    assert.equal(run.doc().scenes.length, 3);
  });

  test('scene menu on empty space offers only Add scene; Add layer acts on the scene the menu was opened on', async () => {
    const b = await probe(['scene-menu:blank']);
    assert.deepEqual(b.s.scenePanel.menu.items.map((i) => [i.id, i.text, i.enabled]), [['addscene', 'Add scene…', true]]);
    const c = await probe(['select-scene:scene-2', 'scene-menu:add', 'click:kind:text', 'type:addText=Hi', 'click:addLayerOk']);
    assert.ok(c.done.every(Boolean), JSON.stringify(c.p.actions));
    assert.equal(c.doc().scenes[1].layers.length, 2, 'the scene the menu was opened on (Starting soon), not the active one');
    assert.equal(c.doc().scenes[0].layers.length, 3);
  });

  test('scene keys: F2 opens the rename box for the current scene, Del deletes it (scene editing on, never the active scene)', async () => {
    const f = await probe(['select-scene:scene-2', 'scene-key:F2']);
    assert.deepEqual(f.done, [true, true]);
    assert.equal(node(f.p, 'renameBox').opened, true);
    assert.equal(node(f.p, 'renameName').text, 'Starting soon');
    const d = await probe(['select-scene:scene-2', 'scene-key:Del'], { flags: ['scene-edit'] });
    assert.deepEqual(d.doc().scenes.map((s) => s.id), ['scene-1']);
    const off = await probe(['select-scene:scene-2', 'scene-key:Del']);
    assert.match(off.s.note, /scene editing/);
  });

  test('command palette: Undo, Rename and Duplicate commands run the same functions as the menus', async () => {
    const type = (t) => `palette-type:${encodeURIComponent(t)}`;
    const r = await probe(['palette-open', type('duplicate this scene'), 'palette-run']);
    assert.deepEqual(r.done, [true, true, true]);
    assert.ok(r.s.scenes.some((n) => n.startsWith('Gameplay copy')), JSON.stringify(r.s.scenes));
    const u = await probe(['click:eye:chat', 'palette-open', type('undo'), 'palette-run']);
    assert.equal((await u.layersOf()).find((l) => l.id === 'chat').visible, false, 'undone from the palette');
    const l = await probe(['select-layer:cam', 'palette-open', type('rename the selected layer'), 'palette-run']);
    assert.equal(node(l.p, 'renameBox').opened, true);
    const none = await probe(['palette-open', type('selected layer')]);
    assert.deepEqual(none.s.palette.items, [], 'layer commands need a selected layer');
  });

  test('while live: the scene menu items are greyed with "Not while live"; scene keys say so', async () => {
    const r = await probe(['select-scene:scene-2', 'scene-menu:show', 'scene-menu:duplicate'], { live: true, flags: ['scene-edit'] });
    const b = by(r.s.scenePanel.menu.items);
    for (const id of ['addscene', 'add', 'rename', 'duplicate', 'delete']) assert.deepEqual([id, b[id].enabled, b[id].tip], [id, false, 'Not while live']);
    assert.deepEqual(r.done, [true, true, false]);
    const k = await probe(['select-scene:scene-2', 'scene-key:F2'], { live: true });
    assert.match(k.s.note, /^Not while live\./);
    assert.equal(node(k.p, 'renameBox').opened, false);
  });
});
