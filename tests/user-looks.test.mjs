// SPDX-License-Identifier: GPL-3.0-or-later
// RL5 (D445) New look from a reference, the studio side: the loader merges the user's own looks (<data>/looks, ids
// "user-...", LUT base userluts) after the built-in ones; rename and delete touch only those; the route
// (services/studio-ui/user-looks.mjs + POST/GET /ui/api/looks) runs the real Python (services/clip/look_reference.py)
// on a synthetic picture made here; a realism scene with an own look validates and points at base userluts.
// The colour tolerance itself is tested in tests/py/test_look_reference.py.
import assert from 'node:assert/strict';
import Ajv2020 from 'ajv/dist/2020.js';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject, validateProject } from '../services/project/index.mjs';
import { LOOKS_DIR, deleteUserLook, loadLooks, lookSummary, renameUserLook, userLooksDir } from '../services/project/looks.mjs';
import { realismScene } from '../services/project/structure.mjs';
import { alphaBases } from '../services/studio-ui/alpha.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { pythonIn } from '../services/studio-ui/record-clips.mjs';
import { REALISM_FLAG, createStudioServer } from '../services/studio-ui/server.mjs';
import { createUserLooks, userLookOpProblems } from '../services/studio-ui/user-looks.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const KEY = 'k'.repeat(48);
const PY = process.env.UJWALAM_TEST_PYTHON || pythonIn(REPO)?.exe || null;
const skipPy = PY ? false : 'no project Python';
const builtIn = loadLooks();
const cinematic = builtIn.find((l) => l.id === 'cinematic');

// a user look as look_reference.py writes it (here by hand, for the loader tests)
function userLook(id, name, extra = {}) {
  return { ...structuredClone(cinematic), id, name, summary: 'Your look from a reference: cool.', measured: { colour: { L: 50, a: -2, b: -8, contrast: 20 }, shift: { L: 0, a: -2, b: -8, contrast: 1 }, basedOn: 'cinematic' },
    effects: [{ type: 'lut', file: { base: 'userluts', rel: `${id}.cube` }, amount: 1 }, ...structuredClone(cinematic.effects.slice(1))], ...extra };
}

// a 24-bit BMP: a grey gradient with a blue-teal cast (no image library needed)
function castBmp(file, w = 96, h = 54) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10); buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18); buf.writeInt32LE(h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(24, 28); buf.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 40 + Math.round((175 * x) / (w - 1));
    const o = 54 + y * row + x * 3;
    buf[o] = Math.min(255, v + 18); buf[o + 1] = Math.min(255, v + 6); buf[o + 2] = Math.max(0, v - 14); // B G R
  }
  writeFileSync(file, buf);
}

test('loadLooks merges the user looks after the built-in ones; wrong bases and ids are skipped', () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl5-load-'));
  try {
    const dir = userLooksDir(data);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'user-zed.json'), JSON.stringify(userLook('user-zed', 'Zed')));
    writeFileSync(path.join(dir, 'user-alpha.json'), JSON.stringify(userLook('user-alpha', 'Alpha')));
    writeFileSync(path.join(dir, 'user-luts.json'), JSON.stringify({ ...userLook('user-luts', 'Luts'), effects: cinematic.effects }), 'utf8'); // base luts in the user folder
    writeFileSync(path.join(dir, 'cinematic.json'), JSON.stringify(cinematic)); // a built-in id in the user folder
    writeFileSync(path.join(dir, 'user-up.json'), JSON.stringify({ ...userLook('user-up', 'Up'), effects: [{ type: 'lut', file: { base: 'userluts', rel: '../x.cube' }, amount: 1 }] }));
    writeFileSync(path.join(dir, 'user-bad.json'), '{');
    const all = loadLooks(LOOKS_DIR, dir);
    assert.deepEqual(all.map((l) => l.id), [...builtIn.map((l) => l.id), 'user-alpha', 'user-zed']);
    assert.deepEqual(loadLooks(LOOKS_DIR, path.join(data, 'missing')).map((l) => l.id), builtIn.map((l) => l.id));
    // a user- id among the built-in looks is skipped too
    const bi = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl5-bi-'));
    copyFileSync(path.join(LOOKS_DIR, 'cinematic.json'), path.join(bi, 'cinematic.json'));
    writeFileSync(path.join(bi, 'user-x.json'), JSON.stringify({ ...cinematic, id: 'user-x' }));
    assert.deepEqual(loadLooks(bi).map((l) => l.id), ['cinematic']);
    rmSync(bi, { recursive: true, force: true });
    assert.deepEqual(lookSummary(all.at(-1)), { id: 'user-zed', name: 'Zed', summary: 'Your look from a reference: cool.', swatch: cinematic.swatch, own: true, basedOn: 'cinematic' });
    assert.equal(lookSummary(cinematic).own, undefined);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('rename and delete: only the user looks, both files go, built-in looks never change', () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl5-del-'));
  try {
    const dir = userLooksDir(data);
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'user-mine.json'), JSON.stringify(userLook('user-mine', 'Mine')));
    writeFileSync(path.join(dir, 'user-mine.cube'), 'LUT_3D_SIZE 2\n');
    assert.deepEqual(renameUserLook(dir, 'user-mine', '  Night   blue '), { ok: true, look: { ...userLook('user-mine', 'Night blue') } });
    assert.equal(loadLooks(LOOKS_DIR, dir).at(-1).name, 'Night blue');
    assert.deepEqual(renameUserLook(dir, 'user-mine', ''), { error: 'bad-name' });
    assert.deepEqual(renameUserLook(dir, 'user-mine', 'x'.repeat(25)), { error: 'bad-name' });
    assert.deepEqual(renameUserLook(dir, 'cinematic', 'X'), { error: 'not-your-look' });
    assert.deepEqual(deleteUserLook(dir, 'cinematic'), { error: 'not-your-look' });
    assert.deepEqual(deleteUserLook(dir, 'user-../x'), { error: 'not-your-look' });
    assert.deepEqual(deleteUserLook(dir, 'user-gone'), { error: 'unknown-look' });
    assert.deepEqual(deleteUserLook(dir, 'user-mine'), { ok: true });
    assert.deepEqual(readdirSync(dir), []);
    assert.deepEqual(loadLooks().map((l) => l.id), builtIn.map((l) => l.id));
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test('request shapes', () => {
  assert.deepEqual(userLookOpProblems({ op: 'from-reference', path: 'C:\\x\\a.png' }), []);
  assert.deepEqual(userLookOpProblems({ op: 'from-reference', path: 'C:\\x\\a.mp4', name: 'Snow' }), []);
  assert.match(userLookOpProblems({ op: 'from-reference', path: 'a.png' }).join(), /full path/);
  assert.match(userLookOpProblems({ op: 'from-reference', path: 'C:\\x\\a.m3u8' }).join(), /Pick a picture or video/);
  assert.match(userLookOpProblems({ op: 'from-reference' }).join(), /needs path/);
  assert.match(userLookOpProblems({ op: 'rename', id: 'cinematic', name: 'x' }).join(), /your own looks/);
  assert.match(userLookOpProblems({ op: 'delete', id: 'user-a', path: 'x' }).join(), /unknown path/);
  assert.match(userLookOpProblems({ op: 'copy' }).join(), /op must be/);
});

test('alphaBases gives the host the user looks folder as base userluts', () => {
  const d = path.join(os.tmpdir(), 'ujw-rl5-bases', 'looks');
  assert.equal(alphaBases({ userLutsDir: d }).userluts, path.resolve(d));
  assert.equal(alphaBases({}).userluts, undefined);
});

test('createUserLooks: a picture becomes a look in <data>/looks; rename, delete; flag off and bad files refused', { skip: skipPy }, async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl5-run-'));
  const ref = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl5-ref-'));
  try {
    const pic = path.join(ref, 'liked look.bmp');
    castBmp(pic);
    let on = true;
    const ul = createUserLooks({ dataDir: data, clipRoot: REPO, python: PY, flagOn: () => on });
    let r = await ul.run({ op: 'from-reference', path: pic, name: ' Teal  snow ' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.look.id, 'user-teal-snow');
    assert.equal(r.body.look.name, 'Teal snow');
    assert.equal(r.body.look.own, true);
    assert.ok(builtIn.some((l) => l.id === r.body.basedOn.id), 'effects from a built-in look');
    assert.match(r.body.look.summary, /cool/);
    assert.ok(r.body.measured.b < -3, JSON.stringify(r.body.measured));
    assert.deepEqual(readdirSync(userLooksDir(data)).sort(), ['user-teal-snow.cube', 'user-teal-snow.json']);
    const check = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(readFileSync(path.join(REPO, 'data', 'schemas', 'look.schema.json'), 'utf8')));
    const saved = JSON.parse(readFileSync(path.join(userLooksDir(data), 'user-teal-snow.json'), 'utf8'));
    assert.ok(check(saved), JSON.stringify(check.errors));
    assert.ok(existsSync(pic), 'the reference is only read');
    assert.ok(!readFileSync(path.join(userLooksDir(data), 'user-teal-snow.json'), 'utf8').includes('liked look'), 'no file name kept');
    r = await ul.run({ op: 'from-reference', path: pic });
    assert.equal(r.body.look.name, 'My look', 'a default name');
    r = await ul.run({ op: 'from-reference', path: path.join(ref, 'missing.png') });
    assert.deepEqual([r.status, r.body.error], [400, 'no-file']);
    const fake = path.join(ref, 'fake.png');
    writeFileSync(fake, 'not a picture');
    r = await ul.run({ op: 'from-reference', path: fake });
    assert.deepEqual([r.status, r.body.error], [400, 'not-made']);
    assert.match(r.body.detail, /not a picture/);
    r = await ul.run({ op: 'rename', id: 'user-teal-snow', name: 'Snow' });
    assert.deepEqual([r.status, r.body.look.name], [200, 'Snow']);
    r = await ul.run({ op: 'delete', id: 'user-my-look' });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    r = await ul.run({ op: 'delete', id: 'user-my-look' });
    assert.equal(r.status, 404);
    on = false;
    r = await ul.run({ op: 'delete', id: 'user-teal-snow' });
    assert.deepEqual([r.status, r.body.error], [404, 'realism-look-off']);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(ref, { recursive: true, force: true }); }
});

// ---- the UI server routes

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

test('server: POST /ui/api/looks makes, renames and deletes own looks; GET lists them; a realism scene uses base userluts', { skip: skipPy }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl5-srv-'));
  const file = path.join(dir, 'p.project.json');
  const doc = createProject({ name: 'T', fps: 30 });
  doc.devices = [{ id: 'dev-game', kind: 'capture-card', name: 'Card', match: { name: 'Card' } }];
  const pl = { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 }, v: { visible: true, x: 0, y: 0, width: 1080, height: 1920 } };
  doc.scenes[0].layers.push({ id: 'game', type: 'capture', name: 'Game', source: { device: 'dev-game' }, placements: pl });
  saveProject(file, doc);
  const pic = path.join(dir, 'ref.bmp');
  castBmp(pic);
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m) => (m === 'host.status' ? { live: false } : {}) };
  const flags = createFlags({ dataDir: dir });
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, dataDir: dir, clipRoot: REPO, projectSync: createProjectSync({ file }), limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (url, body) => raw(port, { method: 'POST', url, body: JSON.stringify(body), headers: hdr });
    const list = async () => (await raw(port, { url: '/ui/api/looks', headers: { cookie } })).body.looks;
    let r = await post('/ui/api/looks', { op: 'from-reference', path: pic, name: 'Cold' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.look.id, 'user-cold');
    const looks = await list();
    assert.deepEqual(looks.map((l) => l.id), [...builtIn.map((l) => l.id), 'user-cold']);
    assert.equal(looks.at(-1).own, true);
    const settings = (await raw(port, { url: '/ui/api/settings', headers: { cookie } })).body;
    assert.ok(settings.realismLooks.looks.some((l) => l.id === 'user-cold'), 'Settings > Clips > Realism look lists it');
    r = await post('/ui/api/project/structure', { op: 'scene.realism', scene: doc.scenes[0].id, look: 'user-cold' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved.scenes[1].layers.find((l) => l.name === 'Game').effects[0], { type: 'lut', file: { base: 'userluts', rel: 'user-cold.cube' }, amount: 1 });
    assert.equal(validateProject(saved).ok, true, JSON.stringify(validateProject(saved).errors));
    // a look scene made again with a built-in look replaces the own look, never stacks
    const again = realismScene(saved, { scene: saved.scenes[1].id, look: 'cinematic' }, loadLooks(LOOKS_DIR, userLooksDir(dir)));
    assert.equal(again.layers.find((l) => l.name === 'Game').effects.filter((e) => e.type === 'lut').length, 1);
    r = await post('/ui/api/looks', { op: 'rename', id: 'user-cold', name: 'Cold snow' });
    assert.deepEqual([r.status, r.body.look.name], [200, 'Cold snow']);
    r = await post('/ui/api/looks', { op: 'delete', id: 'cinematic' });
    assert.equal(r.status, 400);
    r = await post('/ui/api/looks', { op: 'delete', id: 'user-cold' });
    assert.equal(r.status, 200);
    assert.deepEqual((await list()).map((l) => l.id), builtIn.map((l) => l.id));
    flags.set(REALISM_FLAG, false);
    r = await post('/ui/api/looks', { op: 'from-reference', path: pic });
    assert.deepEqual([r.status, r.body.error], [404, 'realism-look-off']);
  } finally { await srv.close(); rmSync(dir, { recursive: true, force: true }); }
});
