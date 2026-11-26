// SPDX-License-Identifier: GPL-3.0-or-later
// Realism look (D381, flag realism-look): the generated filmic LUT (byte for byte from tools/make-realism-lut.mjs), the
// read-only file base "luts", preset fx-realism-grade, the pure realismScene change and the UI server route
// (flag gate, live lock, host first then the file). No host exe, no GPU: the host is a stub here.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planInHost } from '../app/host/lib/project.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { loadLooks } from '../services/project/looks.mjs';
import { REALISM_EFFECTS, duplicateScene, realismScene } from '../services/project/structure.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { REALISM_FLAG, createStudioServer } from '../services/studio-ui/server.mjs';
import { LUT_FILE, SIZE, cubeText, grade, tone } from '../tools/make-realism-lut.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);

// ---- the LUT

test('LUT: the committed data/luts/realism-filmic.cube is exactly what tools/make-realism-lut.mjs writes', () => {
  assert.equal(LUT_FILE, path.join(REPO, 'data', 'luts', 'realism-filmic.cube'));
  const disk = readFileSync(LUT_FILE);
  const want = Buffer.from(cubeText(), 'utf8');
  assert.equal(disk.length, want.length, 'same size');
  assert.ok(disk.equals(want), 'same bytes: run node tools/make-realism-lut.mjs and commit the result');
  assert.ok(!disk.includes(0x0d), 'LF only');
});

test('LUT: .cube format (33^3, red fastest, values 0..1) and the look stays gentle', () => {
  const lines = cubeText().split('\n');
  assert.equal(lines.at(-1), '', 'ends with a newline');
  assert.deepEqual(lines.slice(0, 3), [`LUT_3D_SIZE ${SIZE}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']);
  assert.equal(SIZE, 33);
  const data = lines.slice(3, -1);
  assert.equal(data.length, 33 ** 3);
  for (const l of data) {
    const v = l.split(' ').map(Number);
    assert.equal(v.length, 3, l);
    for (const x of v) assert.ok(x >= 0 && x <= 1 && /^\d\.\d{6}$/.test(String(x.toFixed(6))), l);
  }
  // red changes fastest: the second entry is (1/32, 0, 0) graded
  assert.equal(data[1], grade(1 / 32, 0, 0).map((x) => x.toFixed(6)).join(' '));
  // tone curve: monotonic, black lifted a little, white rolled off below 1, mid grey kept near 0.5
  let prev = -1;
  for (let i = 0; i <= 1000; i++) { const y = tone(i / 1000); assert.ok(y > prev, `monotonic at ${i}`); prev = y; }
  assert.ok(Math.abs(tone(0) - 0.01) < 1e-9);
  assert.ok(tone(1) > 0.96 && tone(1) < 0.98);
  assert.ok(Math.abs(tone(0.5) - 0.5) < 0.01);
  // greys stay near grey (split tone at most a couple of percent), saturated colours are tamed, never inverted
  for (const g of [0, 0.18, 0.5, 0.75, 1]) {
    const [r, gg, b] = grade(g, g, g);
    assert.ok(Math.max(r, gg, b) - Math.min(r, gg, b) < 0.03, `grey ${g}: ${r} ${gg} ${b}`);
  }
  const [r, g, b] = grade(1, 0, 0);
  assert.ok(r > 0.8 && g < 0.1 && b < 0.1 && r - Math.max(g, b) < 0.9,'pure red stays red, a little less saturated');
});

// ---- base luts and the preset

test('base luts: the project validator and the host lib take it; other names stay refused', async () => {
  const doc = createProject({ name: 'T', fps: 30 });
  doc.scenes[0].layers.push({ id: 'c', type: 'color', name: 'C', source: { color: '#101010' },
    placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } }, effects: [structuredClone(REALISM_EFFECTS[0])] });
  assert.ok(validateProject(doc).ok, JSON.stringify(validateProject(doc).errors));
  const bad = structuredClone(doc);
  bad.scenes[0].layers[0].effects[0].file.base = 'nope';
  assert.equal(validateProject(bad).ok, false);
  const sent = [];
  const client = { call: async (m, p) => { sent.push([m, p]); return {}; } };
  await planInHost(client, doc, { bases: { luts: path.join(REPO, 'data', 'luts') } });
  assert.deepEqual(Object.keys(sent[0][1].bases), ['luts']);
  await assert.rejects(planInHost(client, doc, { bases: { nope: REPO } }), /unknown pathRef base/);
  // the host's own allowlists (C++) name luts too
  assert.match(readFileSync(path.join(REPO, 'app', 'host', 'src', 'model.cpp'), 'utf8'), /bases = \{"data", "luts", "media", "overlays", "profile", "userluts"\}/);
  assert.match(readFileSync(path.join(REPO, 'app', 'host', 'src', 'methods.cpp'), 'utf8'), /m\.first != "luts"/);
});

test('preset fx-realism-grade: the LUT effect the realism scene uses, on a shipped file', () => {
  const p = JSON.parse(readFileSync(path.join(REPO, 'registry', 'presets', 'fx-realism-grade.json'), 'utf8'));
  assert.equal(p.function, 'layer-lut');
  assert.deepEqual(p.params.effect, { ...REALISM_EFFECTS[0], file: { ...REALISM_EFFECTS[0].file } });
  assert.equal(p.params.effect.file.base, 'luts');
  assert.equal(path.join(REPO, 'data', 'luts', p.params.effect.file.rel), LUT_FILE);
  const flag = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags.find((f) => f.id === REALISM_FLAG);
  assert.deepEqual([flag.default, flag.onBy, flag.page], [true, 'D445', 'editing'], 'on by default since D445, on the page with the other layer-effect flags');
});

// ---- realismScene (pure)

const PL = (w, h) => ({ visible: true, x: 0, y: 0, width: w, height: h });
function alphaLike() {
  const doc = createProject({ name: 'T', fps: 30 });
  doc.devices = [
    { id: 'dev-game', kind: 'capture-card', name: 'Card', match: { name: 'Card' }, origin: { importer: 'alpha', id: 'role/game-capture' } },
    { id: 'dev-cam', kind: 'camera', name: 'Cam', match: { name: 'Cam' }, origin: { importer: 'alpha', id: 'role/facecam' } },
  ];
  const both = { h: PL(1920, 1080), v: PL(1080, 1920) };
  doc.scenes[0].layers.push(
    { id: 'game-backdrop', type: 'duplicate', name: 'Backdrop', source: { layer: 'game' }, placements: both, effects: [{ type: 'blur', strength: 71 }] },
    { id: 'game', type: 'capture', name: 'Game', source: { device: 'dev-game' }, placements: both, effects: [{ type: 'rounded', radius: 64 }] },
    { id: 'facecam', type: 'capture', name: 'Cam', source: { device: 'dev-cam' }, placements: both },
    { id: 'game-v', type: 'duplicate', name: 'Game V', source: { layer: 'game' }, placements: { v: PL(1080, 1920) } },
    { id: 'bg', type: 'color', name: 'Colour', source: { color: '#101010' }, placements: both },
  );
  const v = validateProject(doc);
  assert.ok(v.ok, JSON.stringify(v.errors));
  return doc;
}

test('realismScene: a named copy; every game layer of the copy gets the grade after its own effects; the source is untouched', () => {
  const doc = alphaLike();
  const before = JSON.stringify(doc);
  const s = doc.scenes[0];
  const r = realismScene(doc, { scene: s.id });
  assert.ok(!r.error, JSON.stringify(r));
  assert.equal(JSON.stringify(doc), before, 'input unchanged');
  assert.equal(r.scene.name, `${s.name} Filmic`, 'no look given: Filmic, the D381 grade');
  assert.equal(r.scene.id, `${s.id}-filmic`);
  assert.equal(r.look, 'filmic');
  assert.equal(r.project.scenes[1].id, r.scene.id, 'right after the source');
  assert.equal(JSON.stringify(r.project.scenes[0]), JSON.stringify(s), 'the source scene in the result is unchanged');
  assert.equal(r.project.activeScene, doc.activeScene, 'the start scene stays');
  const byName = Object.fromEntries(r.layers.map((l) => [l.name, l]));
  const grade3 = REALISM_EFFECTS.map((e) => JSON.parse(JSON.stringify(e)));
  assert.deepEqual(byName.Backdrop.effects, [{ type: 'blur', strength: 71 }, ...grade3]);
  assert.deepEqual(byName.Game.effects, [{ type: 'rounded', radius: 64 }, ...grade3]);
  assert.deepEqual(byName['Game V'].effects, grade3);
  assert.equal(byName.Cam.effects, undefined, 'the face camera is not graded');
  assert.equal(byName.Colour.effects, undefined);
  assert.equal(byName.Game.type, 'duplicate', 'one device, one open source: the copy shows the same capture');
  assert.equal(byName.Game.source.layer, 'game');
  assert.deepEqual(r.graded.sort(), [byName.Backdrop.id, byName.Game.id, byName['Game V'].id].sort());
  assert.ok(validateProject(r.project).ok);
  // again: "Filmic 2"; a realism copy of the realism scene does not stack the grade twice
  const r2 = realismScene(r.project, { scene: s.id });
  assert.equal(r2.scene.name, `${s.name} Filmic 2`);
  assert.equal(r2.scene.id, `${s.id}-filmic-2`);
  const r3 = realismScene(r2.project, { scene: r.scene.id });
  assert.ok(!r3.error, JSON.stringify(r3));
  assert.equal(r3.scene.name, `${s.name} Filmic 3`);
  for (const l of r3.layers.filter((x) => r3.graded.includes(x.id))) assert.equal(l.effects.filter((e) => e.type === 'lut').length, 1, l.name);
  // effects are deep copies, not shared with the module constant
  r.layers.find((l) => l.name === 'Game').effects.at(-1).amount = 0.9;
  assert.equal(REALISM_EFFECTS[2].amount, 0.25);
});

test('realismScene: no game capture, the effect limit and unknown scenes are refused; capture card fallback', () => {
  const doc = alphaLike();
  const s = doc.scenes[0].id;
  assert.equal(realismScene(doc, { scene: 'zz' }).error, 'unknown-scene');
  const camOnly = structuredClone(doc);
  camOnly.scenes[0].layers = camOnly.scenes[0].layers.filter((l) => l.id === 'facecam' || l.id === 'bg');
  assert.equal(realismScene(camOnly, { scene: s }).error, 'no-game-capture');
  const full = structuredClone(doc);
  full.scenes[0].layers.find((l) => l.id === 'game').effects = [{ type: 'rounded', radius: 64 }, { type: 'blur', strength: 2 }, { type: 'mirror' }, { type: 'flip' }];
  assert.ok(validateProject(full).ok);
  assert.deepEqual(realismScene(full, { scene: s }), { error: 'too-many-effects', layer: 'game' });
  // no role origin: the project's only capture card is the game
  const noRole = structuredClone(doc);
  for (const d of noRole.devices) delete d.origin;
  assert.equal(realismScene(noRole, { scene: s }).graded.length, 3);
  // plain duplicate stays as it was
  assert.equal(duplicateScene(doc, { scene: s }).layers.find((l) => l.name === 'Game').effects.length, 1);
  assert.equal(realismScene(doc, { scene: s, look: 'nope' }).error, 'unknown-look');
});

test('realismScene (D445): each look of the library applies to the game layers; backdrops get only its backdrop types; original unchanged', () => {
  const looks = loadLooks();
  assert.ok(looks.length >= 7);
  const doc = alphaLike();
  const before = JSON.stringify(doc);
  const s = doc.scenes[0];
  for (const look of looks) {
    const r = realismScene(doc, { scene: s.id, look: look.id });
    assert.ok(!r.error, `${look.id}: ${JSON.stringify(r)}`);
    assert.equal(JSON.stringify(doc), before, `${look.id}: input unchanged`);
    assert.equal(JSON.stringify(r.project.scenes[0]), JSON.stringify(s), `${look.id}: the source scene is unchanged`);
    assert.equal(r.scene.name, `${s.name} ${look.name}`);
    assert.equal(r.scene.id, `${s.id}-${look.id}`);
    assert.equal(r.look, look.id);
    const byName = Object.fromEntries(r.layers.map((l) => [l.name, l]));
    const all = JSON.parse(JSON.stringify(look.effects));
    assert.deepEqual(byName.Game.effects, [{ type: 'rounded', radius: 64 }, ...all], look.id);
    assert.deepEqual(byName['Game V'].effects, all, look.id);
    assert.deepEqual(byName.Backdrop.effects, [{ type: 'blur', strength: 71 }, ...all.filter((e) => look.backdrop.includes(e.type))], `${look.id}: backdrop`);
    assert.equal(byName.Cam.effects, undefined);
    assert.equal(r.graded.length, 3);
    assert.deepEqual(validateProject(r.project).errors, [], look.id);
  }
  // a look scene made from a look scene changes the look, never stacks two; the name keeps the source's root
  const dark = realismScene(doc, { scene: s.id, look: 'dark-cinematic' });
  const neon = realismScene(dark.project, { scene: dark.scene.id, look: 'night-neon' });
  assert.ok(!neon.error, JSON.stringify(neon));
  assert.equal(neon.scene.name, `${s.name} Night neon`);
  assert.equal(neon.scene.id, `${s.id}-night-neon`);
  const game = neon.layers.find((l) => l.name === 'Game');
  const nn = looks.find((l) => l.id === 'night-neon');
  assert.deepEqual(game.effects, [{ type: 'rounded', radius: 64 }, ...JSON.parse(JSON.stringify(nn.effects))]);
  // an old D381 "<name> Realism" scene is a root too: its copy is "<name> Cinematic", not "<name> Realism Cinematic"
  const old = realismScene(doc, { scene: s.id });
  Object.assign(old.project.scenes.find((x) => x.id === old.scene.id), { id: `${s.id}-realism`, name: `${s.name} Realism` });
  const c = realismScene(old.project, { scene: `${s.id}-realism`, look: 'cinematic' });
  assert.deepEqual([c.scene.name, c.scene.id], [`${s.name} Cinematic`, `${s.id}-cinematic`]);
});

// ---- the UI server route

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

test('server: scene.realism needs flag realism-look (not scene-edit), refused while live, host first then the file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-realism-'));
  const file = path.join(dir, 'p.project.json');
  const doc = alphaLike();
  saveProject(file, doc);
  const sid = doc.scenes[0].id;
  const calls = [];
  const state = { live: false, fail: false };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: state.live };
    if (m === 'outputs.status') return {}; // the server's own status poll can land at any time under load: not a write
    if (state.fail) throw new Error('host says no');
    calls.push([m, p.scene?.id ?? p.scene, p.layer, p.scene?.canvas]);
    return {};
  } };
  const flags = createFlags({ dataDir: dir });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body), headers: hdr });
    const disk = () => JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(flags.isOn(REALISM_FLAG), true, 'on by default (D445)');
    flags.set(REALISM_FLAG, false);
    let r = await post({ op: 'scene.realism', scene: sid });
    assert.deepEqual([r.status, r.body.error], [404, 'realism-look-off']);
    assert.equal(calls.length, 0);
    flags.set(REALISM_FLAG, true);
    // the look list for the menu: read-only, Filmic first, each with a name, words and a swatch
    const looks = (await raw(port, { url: '/ui/api/looks', headers: { cookie } })).body.looks;
    assert.equal(looks[0].id, 'filmic');
    assert.ok(looks.length >= 7 && looks.every((l) => l.name && l.summary && l.swatch.length === 5), JSON.stringify(looks));
    assert.equal((await post({ op: 'scene.realism', scene: sid, look: 'nope' })).body.error, 'unknown-look');
    assert.equal((await post({ op: 'scene.realism', scene: sid, name: 'x' })).status, 400, 'unknown key');
    state.live = true;
    assert.equal((await post({ op: 'scene.realism', scene: sid })).body.error, 'live-locked');
    state.live = false;
    state.fail = true;
    assert.equal((await post({ op: 'scene.realism', scene: sid })).status, 502, 'a host refusal saves nothing');
    assert.equal(disk().scenes.length, 1);
    state.fail = false;
    r = await post({ op: 'scene.realism', scene: sid, look: 'dark-cinematic' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.scene, { id: `${sid}-dark-cinematic`, name: `${doc.scenes[0].name} Dark cinematic` });
    assert.equal(r.body.look, 'dark-cinematic');
    assert.equal(r.body.graded, 3);
    assert.deepEqual(calls.map((c) => c[0]), ['scenes.create', 'scenes.create', ...doc.scenes[0].layers.map(() => 'layers.addFromProject')], 'H and V scene, then the layers bottom first');
    assert.deepEqual(calls.slice(0, 2).map((c) => c[3]), ['H', 'V']);
    const saved = disk();
    assert.equal(saved.scenes.length, 2);
    assert.deepEqual(saved.scenes[0], JSON.parse(JSON.stringify(doc.scenes[0])), 'the original scene on disk is unchanged');
    assert.equal(saved.scenes[1].layers.filter((l) => (l.effects ?? []).some((e) => e.type === 'lut' && e.file.base === 'luts' && e.file.rel === 'look-dark-cinematic.cube')).length, 3);
    assert.equal(validateProject(saved).ok, true);
    // a scene without a game capture: refused with a code the studio puts in words
    r = await post({ op: 'scene.add', name: 'Empty' });
    assert.equal(r.status, 200);
    assert.equal((await post({ op: 'scene.realism', scene: r.body.scene.id })).body.error, 'no-game-capture');
  } finally { await srv.close(); }
});

// Bug 2026-11-26: realism scenes gone after a restart. The host made the scene, refused one overlay copy ("no overlay
// URL for this layer", -32004), and the route returned before saving: a scene in the studio that was never in the file.
test('server: scene.realism saves the scene when the host cannot show one layer yet; another refusal undoes the scene', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-realism-lost-'));
  const file = path.join(dir, 'p.project.json');
  const doc = alphaLike();
  saveProject(file, doc);
  const sid = doc.scenes[0].id;
  const calls = [];
  const state = { refuse: null };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: false };
    if (m === 'outputs.status') return {};
    calls.push([m, p.scene?.id ?? p.scene, p.layer]);
    if (m === 'layers.addFromProject' && state.refuse && p.layer === state.refuse.layer) {
      throw Object.assign(new Error(`Layer ${p.layer} cannot be added: no overlay URL for this layer`), { code: state.refuse.code });
    }
    return {};
  } };
  const flags = createFlags({ dataDir: dir });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body), headers: hdr });
    const disk = () => JSON.parse(readFileSync(file, 'utf8'));
    const lastSrc = doc.scenes[0].layers.at(-1).id;
    // the copy's layer ids: from the pure function on the same document
    const want = realismScene(doc, { scene: sid });
    const copyLast = want.layers.at(-1).id;
    // a non-"unavailable" refusal mid-way: the half-built scene is removed from the host, nothing saved
    state.refuse = { layer: copyLast, code: 'RPC_-32000' }; // the studio host client sends RPC_<code> (backends.mjs rpc)
    let r = await post({ op: 'scene.realism', scene: sid });
    assert.equal(r.status, 502, JSON.stringify(r.body));
    assert.deepEqual(calls.at(-1), ['scenes.remove', want.scene.id, undefined], 'the half-built scene is undone in the host');
    assert.equal(disk().scenes.length, 1);
    // the user's case: one layer unavailable until the next full load -> the scene is saved and survives a restart
    calls.length = 0;
    state.refuse = { layer: copyLast, code: 'RPC_-32004' }; // bug 2026-11-26: alpha.48 checked only the number
    r = await post({ op: 'scene.realism', scene: sid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.saved, true);
    assert.equal(r.body.later, 1);
    assert.ok(!calls.some((c) => c[0] === 'scenes.remove'));
    const saved = disk();
    assert.deepEqual(saved.scenes.map((s) => s.id), [sid, want.scene.id]);
    assert.ok(saved.scenes[1].layers.some((l) => l.id === copyLast), 'the layer the host skipped is in the file');
    assert.notEqual(lastSrc, copyLast);
    // scene.duplicate takes the same path
    state.refuse = null;
    r = await post({ op: 'scene.duplicate', scene: sid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(disk().scenes.length, 3);
  } finally { await srv.close(); }
});

// Fix 2026-11-27 (overlay copy URLs): the route sends each copied layer's overlay page URL with layers.addFromProject,
// built from the host's own overlay.status ports, so an overlay copy shows now and nothing waits for the next start.
test('server: scene.realism and scene.duplicate send overlay URLs, so an overlay copy is added now (no later)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-realism-urls-'));
  const file = path.join(dir, 'p.project.json');
  const doc = alphaLike();
  doc.overlays = [{ id: 'ov-gg', name: 'GG', file: { base: 'overlays', rel: 'gg-burst/index.html' } }];
  doc.scenes[0].layers.push({ id: 'gg', type: 'browser', name: 'GG', source: { overlay: 'ov-gg', width: 1920, height: 1080 }, placements: { h: PL(1920, 1080), v: PL(1080, 1920) } });
  assert.ok(validateProject(doc).ok, JSON.stringify(validateProject(doc).errors));
  saveProject(file, doc);
  const sid = doc.scenes[0].id;
  const state = { overlay: true, statusCalls: 0 };
  const sent = [];
  // like the real host: an overlay layer without its URL is unavailable (-32004, as the studio client reports it)
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: false };
    if (m === 'outputs.status') return {};
    if (m === 'overlay.status') { state.statusCalls++; if (!state.overlay) throw Object.assign(new Error('overlay server not running'), { code: 'RPC_-32004' }); return { state: 'running', staticPort: 41001, feedPort: 41002 }; }
    if (m === 'layers.addFromProject') {
      const l = p.project.scenes.find((s) => s.id === p.scene).layers.find((x) => x.id === p.layer);
      if (l.type === 'browser') {
        sent.push(p);
        if (typeof p.browserUrls?.[p.layer] !== 'string') throw Object.assign(new Error('no overlay URL for this layer'), { code: 'RPC_-32004' });
        return { note: 'This overlay shows fully after the next start.' };
      }
    }
    return {};
  } };
  const flags = createFlags({ dataDir: dir });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (body) => raw(port, { method: 'POST', url: '/ui/api/project/structure', body: JSON.stringify(body), headers: hdr });
    for (const op of ['scene.realism', 'scene.duplicate']) {
      sent.length = 0;
      state.statusCalls = 0;
      const r = await post({ op, scene: sid });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.saved, true);
      assert.equal(r.body.later, undefined, `: no layer waits for the next start`);
      assert.equal(sent.length, 1, `: the overlay copy was sent once`);
      const url = Object.values(sent[0].browserUrls).find((u) => u.includes('/overlays/gg-burst/index.html'));
      assert.ok(sent[0].browserUrls[sent[0].layer].startsWith('http://127.0.0.1:41001/overlays/gg-burst/index.html?'), 'URL on the host overlay server port');
      assert.ok(url && /[?&]sbPort=41002(&|$)/.test(url), 'feed port from overlay.status');
      assert.ok(['effects', 'display'].includes(sent[0].relayScope));
      assert.equal(state.statusCalls, 1, `: one overlay.status for the whole multi-layer scene`);
      assert.equal(r.body.note, 'This overlay shows fully after the next start.', 'the host note reaches the studio');
    }
    // fallback: overlay server not running -> no URLs sent, the copy is skipped into later and still saved
    state.overlay = false;
    sent.length = 0;
    const r = await post({ op: 'scene.duplicate', scene: sid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.later, 1);
    assert.equal(sent[0].browserUrls, undefined);
  } finally { await srv.close(); }
});