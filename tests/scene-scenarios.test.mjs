// SPDX-License-Identifier: GPL-3.0-or-later
// Scenario scenes (D390): data/scene-templates/*.json -> reference-read shape -> buildPackage -> scene package ->
// NEW namespaced H + V scene. Checks the template schema, the explicit H and V boxes (V inside the safe zone, no
// overlaps on V), the built layout against the template boxes, links to the project's own sources, placeholders with
// reasons, the screen role (existing window / screen layer, or a picked target), the message text of the holding
// screens and the existing-state hash after the dry run.
//
// DEPENDS ON THE CAPTURE BRANCH: the project schema must know the layer types "window" and "screen" (owned by that
// branch, not this one). Tests that import a package holding such a layer through planScenePackage (it validates the
// project) run only when the schema knows them (WINDOW_LAYERS); the rest run now. Titles are placeholders ("Example App").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createProject, validateProject } from '../services/project/index.mjs';
import { loadScenePreset, mergeCanvasScenes } from '../services/project/scene-preset.mjs';
import { planScenePackage, stateHash, withoutAdded } from '../services/project/scene-package.mjs';
import { loadBuildRules } from '../services/scene-builder/build.mjs';
import { buildScenario, listTemplates, templatePreview, templateProblems, templateRead } from '../services/scene-builder/scenarios.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (rel) => JSON.parse(readFileSync(path.join(REPO, rel), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateTemplate = ajv.compile(rd('data/schemas/scene-template.schema.json'));
const validatePkg = ajv.compile(rd('data/schemas/scene-package.schema.json'));
const validateRead = ajv.compile(rd('data/schemas/reference-read.schema.json'));
const profile = rd('tests/fixtures/project/profile.fixture.json');
const RULES = loadBuildRules();
const TEMPLATES = listTemplates();
const IDS = ['gameplay', 'lobby', 'screen-share', 'starting-soon', 'brb', 'ending'];
const WINDOW_LAYERS = JSON.stringify(rd('data/schemas/project.schema.json')).includes('"window"');
const gate = WINDOW_LAYERS ? false : 'needs the capture branch: project schema without layer types window / screen';
const EDGE_TOL = 0.03;

/** Capture card + camera, Default H + V, an alert-box layer and a chat-list layer (as the alpha project). */
function project({ chat = true } = {}) {
  const p = createProject({ name: 'T' });
  p.devices.push({ id: 'dev-cap', kind: 'capture-card', name: 'Capture', match: { name: 'cap' }, origin: { importer: 'alpha', id: 'role/game-capture' } });
  p.devices.push({ id: 'dev-cam', kind: 'camera', name: 'Camera', match: { name: 'cam' }, origin: { importer: 'alpha', id: 'role/facecam' } });
  const roles = { 'game-capture': 'dev-cap', facecam: 'dev-cam' };
  const h = loadScenePreset(p, rd('registry/presets/scene-default-h.json'), { profile, roles });
  const v = loadScenePreset(h.project, rd('registry/presets/scene-default-v.json'), { profile, roles });
  const out = mergeCanvasScenes(v.project, h.sceneId, v.sceneId).project;
  out.scenes = out.scenes.filter((s) => s.layers.length);
  out.activeScene = out.scenes[0].id;
  out.overlays.push({ id: 'ov-alert-box', name: 'alert-box', file: { base: 'overlays', rel: 'alert-box/index.html' } });
  out.scenes[0].layers.push({ id: 'lyr-alerts1', type: 'browser', name: 'Alerts', source: { overlay: 'ov-alert-box', query: 'hold=6000&x=24&y=210&types=follow,raid', width: 1920, height: 1080 }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } });
  // the default scenes already hold a chat-list layer; a project without chat has none
  if (!chat) {
    for (const sc of out.scenes) sc.layers = sc.layers.filter((l) => l.source?.overlay !== 'ov-chat-list');
    out.overlays = out.overlays.filter((o) => o.id !== 'ov-chat-list');
  }
  { const v = validateProject(out); assert.ok(v.ok, JSON.stringify(v.errors?.slice(0, 3))); }
  return out;
}
/** The same project plus window layers (no validation: needs the capture branch schema to import). */
function withWindow(p, n = 1) {
  const out = structuredClone(p);
  for (let i = 0; i < n; i++) out.scenes[0].layers.push({ id: `lyr-win${i + 1}`, type: 'window', name: `Example App ${i + 1}`, source: { window: `Example App ${i + 1}:ExampleClass:example.exe`, match: 'title', cursor: true }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } });
  return out;
}
const PICK = { create: { type: 'window', source: { window: 'Example App:ExampleClass:example.exe', match: 'title', cursor: true } } };

const frac = (pl, cv) => ({ x: pl.x / cv.width, y: pl.y / cv.height, w: pl.width / cv.width, h: pl.height / cv.height });
const within = (a, b, tol) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const S = RULES.v.safeBox;
const slotOf = (t, canvas, role) => t.slots[canvas].find((s) => s.role === role);
const presetOf = (pkg, canvas) => pkg.presets.find((p) => p.params.canvas === canvas);
const layerOf = (pkg, canvas, key) => presetOf(pkg, canvas).params.layers.find((l) => l.key === key);

describe('scenario templates (data)', () => {
  test('six templates, each valid against the schema and the loader; ids and order are unique', () => {
    assert.deepEqual(TEMPLATES.map((t) => t.id).sort(), [...IDS].sort());
    assert.deepEqual(TEMPLATES.map((t) => t.id), ['gameplay', 'lobby', 'screen-share', 'starting-soon', 'brb', 'ending']);
    assert.equal(new Set(TEMPLATES.map((t) => t.order)).size, TEMPLATES.length);
    for (const t of TEMPLATES) {
      assert.ok(validateTemplate(t), `${t.id}: ${JSON.stringify(validateTemplate.errors?.slice(0, 3))}`);
      assert.deepEqual(templateProblems(t), []);
    }
    assert.equal(TEMPLATES.find((t) => t.id === 'lobby').label, 'Lobby / just chatting');
  });

  test('the schema and the loader refuse a bad template', () => {
    const t = structuredClone(TEMPLATES[0]);
    t.slots.v[0].box.w = 1.5;
    assert.equal(validateTemplate(t), false);
    assert.ok(templateProblems(t).length);
    const u = structuredClone(TEMPLATES[0]);
    u.slots.h.push({ role: 'game', box: { x: 0, y: 0, w: 0.1, h: 0.1 } });
    assert.match(templateProblems(u)[0], /more than one game slot/);
    const w = structuredClone(TEMPLATES[0]);
    w.slots.h[0].text = 'hello';
    assert.match(templateProblems(w)[0], /text is for a graphics slot/);
  });

  test('V boxes sit inside the V safe zone and do not overlap; every template has H and V boxes of its own', () => {
    for (const t of TEMPLATES) {
      const v = t.slots.v.map((s) => s.box);
      for (const b of v) assert.ok(within(b, S, 1e-6), `${t.id}: a V box leaves the safe zone ${JSON.stringify(b)}`);
      for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) assert.equal(overlap(v[i], v[j]) < 1e-9, true, `${t.id}: V boxes ${i} and ${j} overlap`);
      assert.notDeepEqual(t.slots.h.map((s) => s.box), t.slots.v.map((s) => s.box));
    }
  });

  test('roles: every template has chat; the holding screens carry a message and no game; screen-share uses the screen role', () => {
    for (const t of TEMPLATES) for (const c of ['h', 'v']) assert.ok(slotOf(t, c, 'chat'), `${t.id} ${c} has chat`);
    for (const id of ['starting-soon', 'brb', 'ending']) {
      const t = TEMPLATES.find((x) => x.id === id);
      for (const c of ['h', 'v']) { assert.ok(slotOf(t, c, 'graphics').text.length > 0); assert.equal(slotOf(t, c, 'game'), undefined); }
    }
    const ss = TEMPLATES.find((x) => x.id === 'screen-share');
    assert.equal(ss.needsScreen, true);
    assert.ok(slotOf(ss, 'h', 'screen') && slotOf(ss, 'v', 'screen') && !slotOf(ss, 'h', 'game'));
    assert.ok(slotOf(TEMPLATES.find((x) => x.id === 'lobby'), 'h', 'camera').box.w > slotOf(TEMPLATES.find((x) => x.id === 'gameplay'), 'h', 'camera').box.w, 'lobby: bigger camera than gameplay');
    const g = TEMPLATES.find((x) => x.id === 'lobby');
    assert.ok(slotOf(g, 'h', 'game').box.w < 0.3, 'lobby: game small');
  });

  test('templatePreview lists the boxes for the card diagram', () => {
    const p = templatePreview(TEMPLATES[0]);
    assert.deepEqual(Object.keys(p), ['id', 'label', 'description', 'needsScreen', 'preview']);
    assert.ok(p.preview.h.length && p.preview.v.length);
  });

  test('the adapter makes a reference-read shaped object per canvas (slots valid against the read schema)', () => {
    for (const t of TEMPLATES) for (const c of ['h', 'v']) {
      const r = templateRead(t, c);
      assert.equal(r.tool, 'scene-builder/reference-read');
      assert.equal(r.canvas, c.toUpperCase());
      const probe = { ...r, palette: { k: 1, clusters: [{ hex: '#000000', share: 1, L: 0, C: 0, h: 0 }], roles: { background: null, surface: null, text: null, accent: null, accentAlt: null }, contrast: { textOnBackground: null } },
        style: { type: { weight: null, weightRatio: null, size: null, glyphHeightPx1080: null, polarity: null, family: null, glyphs: 0, confidence: 0 }, cornerRadius: { px1080: null, class: 'medium', corners: 0, confidence: 1 }, glow: { used: false, share: 0, colour: null, marks: 0, confidence: 0 }, shadow: { used: false, share: 0, offset: null, depth: 0, boxes: 0, confidence: 0 } } };
      assert.ok(validateRead(probe), `${t.id} ${c}: ${JSON.stringify(validateRead.errors?.slice(0, 3))}`);
    }
  });
});

describe('building each scenario against a project', () => {
  for (const id of IDS) {
    test(`${id}: H and V layers on the template boxes, V in the safe zone, placeholders listed, existing state unchanged`, () => {
      const t = TEMPLATES.find((x) => x.id === id);
      const p = project();
      const before = stateHash(p);
      const pkg = buildScenario(t, p, { rules: RULES });
      assert.ok(validatePkg(pkg), JSON.stringify(validatePkg.errors?.slice(0, 3)));
      assert.equal(pkg.name, t.sceneName);
      assert.deepEqual(pkg.presets.map((x) => x.params.canvas), ['h', 'v']);
      assert.equal(stateHash(p), before, 'building changes nothing');
      const { project: out, diff } = planScenePackage(p, pkg);
      assert.equal(diff.adds.scenes.length, 1);
      assert.deepEqual(diff.adds.scenes[0].canvases, ['h', 'v']);
      const sceneId = diff.adds.scenes[0].id;
      const addedOverlays = out.overlays.map((o) => o.id).filter((o) => !p.overlays.some((d) => d.id === o));
      assert.equal(stateHash(withoutAdded(out, { scenes: [sceneId], overlays: addedOverlays })), before, 'existing scenes, layers, devices and settings unchanged');
      assert.equal(stateHash(p), before);
      for (const canvas of ['h', 'v']) {
        const cv = p.canvases.find((c) => c.id === canvas);
        const rows = diff.adds.layers.filter((l) => l.canvas === canvas);
        const slots = t.slots[canvas];
        assert.equal(rows.length, slots.length, `${canvas}: a layer per slot`);
        for (const l of rows) {
          const b = frac({ x: l.rect.x, y: l.rect.y, width: l.rect.width, height: l.rect.height }, cv);
          const slot = slots.find((s) => s.role === l.slot.role);
          assert.ok(slot, `${canvas}: ${l.key}`);
          assert.ok(within(b, slot.box, EDGE_TOL), `${canvas} ${l.key}: ${JSON.stringify(b)} inside ${JSON.stringify(slot.box)}`);
          if (['camera', 'chat', 'alerts', 'graphics', 'screen'].includes(l.slot.role) && !l.shows?.layer) assert.ok(within(slot.box, { x: b.x, y: b.y, w: b.w, h: b.h }, EDGE_TOL) || l.slot.role === 'game', `${canvas} ${l.key} fills its box`);
          if (canvas === 'v') assert.ok(within(b, S, EDGE_TOL), `v ${l.key} inside the safe zone`);
        }
      }
      const holes = new Set(diff.placeholders.map((x) => `${x.canvas}:${x.role}`));
      if (id === 'screen-share') { assert.ok(holes.has('h:screen') && holes.has('v:screen'), 'no window or screen yet: a placeholder per canvas'); assert.match(diff.placeholders.find((x) => x.role === 'screen').reason, /no window or screen/); }
      else assert.ok(![...holes].some((h) => h.endsWith(':screen')));
      assert.ok(!pkg.warnings.some((w) => /no game slot/.test(w)), 'no game warning for a scenario');
    });
  }

  test('gameplay and lobby show the game and the camera of the project (links), the camera covers its box', () => {
    const p = project();
    for (const id of ['gameplay', 'lobby']) {
      const pkg = buildScenario(TEMPLATES.find((x) => x.id === id), p, { rules: RULES });
      for (const canvas of ['h', 'v']) {
        assert.equal(layerOf(pkg, canvas, 'game').type, 'link');
        assert.equal(layerOf(pkg, canvas, 'camera').type, 'link');
        assert.equal(layerOf(pkg, canvas, 'chat').type, 'browser');
      }
      assert.ok(pkg.bindings.links.game && pkg.bindings.links.camera);
    }
  });

  test('chat sized to its own box per canvas (chat-list x/y/width/height), canvas orientation per canvas', () => {
    const pkg = buildScenario(TEMPLATES.find((x) => x.id === 'gameplay'), project(), { rules: RULES });
    const qh = new URLSearchParams(layerOf(pkg, 'h', 'chat').query), qv = new URLSearchParams(layerOf(pkg, 'v', 'chat').query);
    assert.equal(qh.get('canvas'), 'horizontal');
    assert.equal(qv.get('canvas'), 'vertical');
    assert.equal(Number(qv.get('width')), Math.round(slotOf(TEMPLATES.find((x) => x.id === 'gameplay'), 'v', 'chat').box.w * 1080));
  });

  test('a project without chat: a placeholder with the reason, never a guess', () => {
    const pkg = buildScenario(TEMPLATES.find((x) => x.id === 'brb'), project({ chat: false }), { rules: RULES });
    assert.deepEqual(pkg.placeholders.map((x) => `${x.canvas}:${x.role}`).sort(), ['h:chat', 'v:chat']);
    assert.match(pkg.placeholders[0].reason, /no chat overlay layer/);
    const { diff } = planScenePackage(project({ chat: false }), pkg);
    assert.equal(diff.placeholders.length >= 2, true);
  });

  test('holding screens: the message is the panel text; text= replaces it; a bad message is refused', () => {
    const t = TEMPLATES.find((x) => x.id === 'starting-soon');
    const q = (pkg, c) => new URLSearchParams(layerOf(pkg, c, 'graphics-1').query);
    const pkg = buildScenario(t, project(), { rules: RULES });
    assert.equal(q(pkg, 'h').get('text'), 'Starting soon');
    assert.equal(q(pkg, 'v').get('text'), 'Starting soon');
    assert.equal(layerOf(pkg, 'h', 'graphics-1').overlay, 'ujwalam-panel/index.html');
    assert.equal(q(buildScenario(t, project(), { rules: RULES, text: 'Back at 8' }), 'h').get('text'), 'Back at 8');
    assert.throws(() => buildScenario(t, project(), { rules: RULES, text: 'x'.repeat(81) }), /1 to 80/);
    assert.throws(() => buildScenario(t, project(), { rules: RULES, text: '  ' }), /1 to 80/);
  });

  test('the same input gives the same package (stable id)', () => {
    const now = new Date('2026-11-18T00:00:00Z');
    const p = project();
    const a = buildScenario(TEMPLATES[0], p, { rules: RULES, now }), b = buildScenario(TEMPLATES[0], p, { rules: RULES, now });
    assert.deepEqual(a, b);
    assert.match(a.id, /^sc-gameplay-[0-9a-f]{10}$/);
  });
});

describe('screen role', () => {
  const ss = () => TEMPLATES.find((x) => x.id === 'screen-share');

  test('an existing window layer is linked (shown as a duplicate), contained in the box, never cropped', () => {
    const p = withWindow(project());
    const pkg = buildScenario(ss(), p, { rules: RULES });
    assert.ok(validatePkg(pkg), JSON.stringify(validatePkg.errors?.slice(0, 3)));
    for (const c of ['h', 'v']) { const l = layerOf(pkg, c, 'screen'); assert.equal(l.type, 'link'); assert.equal(l.role, 'screen'); assert.equal(l.fit, 'contain'); assert.equal(l.crop, undefined); }
    assert.equal(pkg.bindings.links.screen, 'lyr-win1');
    assert.deepEqual(pkg.placeholders, []);
  });

  test('two window layers and nothing chosen: a placeholder that says to pick; a layer id (bind) chooses', () => {
    const p = withWindow(project(), 2);
    const none = buildScenario(ss(), p, { rules: RULES });
    assert.match(none.placeholders.find((x) => x.role === 'screen').reason, /2 window layers; pick the one to show/);
    const one = buildScenario(ss(), p, { rules: RULES, bind: { screen: 'lyr-win2' } });
    assert.equal(one.bindings.links.screen, 'lyr-win2');
    const bad = buildScenario(ss(), p, { rules: RULES, bind: { screen: 'lyr-alerts1' } });
    assert.match(bad.placeholders.find((x) => x.role === 'screen').reason, /does not show a window or a screen/);
  });

  test('a window layer wins over a screen layer when both exist (window is the default)', () => {
    const p = withWindow(project());
    p.scenes[0].layers.push({ id: 'lyr-scr1', type: 'screen', name: 'Display', source: { display: 'display-1', cursor: true }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } });
    assert.equal(buildScenario(ss(), p, { rules: RULES }).bindings.links.screen, 'lyr-win1');
    const only = project();
    only.scenes[0].layers.push({ id: 'lyr-scr1', type: 'screen', name: 'Display', source: { display: 'display-1', cursor: true }, placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } } });
    assert.equal(buildScenario(ss(), only, { rules: RULES }).bindings.links.screen, 'lyr-scr1');
  });

  test('a picked window creates a NEW window layer on both canvases (source as the layer contract); nothing else changes', () => {
    const p = project();
    const pkg = buildScenario(ss(), p, { rules: RULES, bind: { screen: PICK } });
    assert.ok(validatePkg(pkg), JSON.stringify(validatePkg.errors?.slice(0, 3)));
    for (const c of ['h', 'v']) {
      const l = layerOf(pkg, c, 'screen');
      assert.equal(l.type, 'window');
      assert.deepEqual(l.target, { window: 'Example App:ExampleClass:example.exe', match: 'title', cursor: true });
      assert.equal(l.placeholder, undefined);
    }
    assert.equal(pkg.bindings.links.screen, undefined);
    assert.deepEqual(pkg.placeholders, []);
  });

  test('a picked screen creates a screen layer, sized by the display when known (contain)', () => {
    const pick = { create: { type: 'screen', source: { display: 'display-1', cursor: true }, content: { width: 2560, height: 1440 } } };
    const pkg = buildScenario(ss(), project(), { rules: RULES, bind: { screen: pick } });
    const l = layerOf(pkg, 'h', 'screen');
    assert.equal(l.type, 'screen');
    assert.deepEqual(l.target, { display: 'display-1', cursor: true });
    assert.equal(l.fit, 'contain');
    const box = slotOf(ss(), 'h', 'screen').box;
    assert.ok(Math.abs(l.rect.w * 1920 / (l.rect.h * 1080) - 2560 / 1440) < 0.01, 'the 16:9 display keeps its aspect');
    assert.ok(within(l.rect, box, 1e-3));
  });

  test('an unusable picked target (bad shape) is a placeholder, never a guess', () => {
    for (const bad of [{ create: { type: 'window', source: { window: '', match: 'title', cursor: true } } }, { create: { type: 'window', source: { window: 'a:b:c', match: 'bogus', cursor: true } } }, { create: { type: 'tv', source: {} } }, { create: { type: 'screen', source: { display: 'd' } } }]) {
      const pkg = buildScenario(ss(), project(), { rules: RULES, bind: { screen: bad } });
      assert.match(pkg.placeholders.find((x) => x.role === 'screen').reason, /not usable/);
    }
  });

  test('the picked target never carries fields beyond the contract (no title text of the page is copied)', () => {
    const pick = { create: { type: 'window', source: { window: 'Example App:ExampleClass:example.exe', match: 'exe', cursor: false, extra: 'x' } } };
    assert.deepEqual(Object.keys(layerOf(buildScenario(ss(), project(), { rules: RULES, bind: { screen: pick } }), 'v', 'screen').target).sort(), ['cursor', 'match', 'window']);
  });

  test('import of a built scenario that links an existing window layer (needs the capture branch schema)', { skip: gate }, () => {
    const p = withWindow(project());
    assert.ok(validateProject(p).ok);
    const before = stateHash(p);
    const { project: out, diff } = planScenePackage(p, buildScenario(ss(), p, { rules: RULES }));
    const id = diff.adds.scenes[0].id;
    assert.equal(stateHash(withoutAdded(out, { scenes: [id], overlays: out.overlays.map((o) => o.id).filter((o) => !p.overlays.some((d) => d.id === o)) })), before);
    assert.ok(diff.adds.layers.some((l) => l.key === 'screen' && l.shows?.layer === 'lyr-win1'));
  });

  test('import of a built scenario with a picked window makes one new window layer per canvas (needs the capture branch schema)', { skip: gate }, () => {
    const p = project();
    const before = stateHash(p);
    const { project: out, diff } = planScenePackage(p, buildScenario(ss(), p, { rules: RULES, bind: { screen: PICK } }));
    const id = diff.adds.scenes[0].id;
    const wins = out.scenes.find((s) => s.id === id).layers.filter((l) => l.type === 'window');
    assert.equal(wins.length, 2, 'one window layer for H and one for V (merged scene: one source each canvas)');
    assert.equal(stateHash(withoutAdded(out, { scenes: [id], overlays: out.overlays.map((o) => o.id).filter((o) => !p.overlays.some((d) => d.id === o)) })), before);
    assert.equal(validateProject(out).ok, true);
  });
});
