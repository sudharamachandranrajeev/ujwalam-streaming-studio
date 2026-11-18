// SPDX-License-Identifier: GPL-3.0-or-later
// Cyberpunk stingers as the default transition (D391): preset data, the studio form (a built-in stinger by id, never a
// path), the new-project default, and the one-time switch of an existing project that is still on the imported fade.
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags, DEFAULT_FLAGS_FILE, loadDefinitions } from '../services/flags/index.mjs';
import { createProject, loadProject, saveProject } from '../services/project/index.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { defaultStingerId, isImportedFade, listStingerPresets, stingerTransition } from '../services/project/stinger-presets.mjs';
import { alphaBases, applyTransitionDefaults, buildAlphaProject, prepareAlphaProject, transitionMarkerFile } from '../services/studio-ui/alpha.mjs';
import { createStudioServer, TRANSITIONS_FLAG } from '../services/studio-ui/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-stdef-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const imported = () => { const p = createProject({ name: 'T', fps: 30 }); for (const c of p.canvases) c.transition = { type: 'fade', durationMs: c.id === 'h' ? 2006 : 1000 }; return p; };

test('presets: neon-glitch is the default; both canvas files exist; the transition names base data', () => {
  const l = listStingerPresets();
  assert.deepEqual(l.map((p) => p.id).sort(), ['cyan-grid', 'neon-glitch', 'synthwave-sweep']);
  assert.equal(l[0].id, 'neon-glitch');
  assert.equal(defaultStingerId(), 'neon-glitch');
  assert.deepEqual(stingerTransition('neon-glitch', 'v'), { type: 'stinger', durationMs: 0, file: { base: 'data', rel: 'transitions/stingers/neon-glitch-v.webm' }, pointMs: 450 });
  assert.throws(() => stingerTransition('../x', 'h'), /unknown stinger/);
  assert.throws(() => stingerTransition('neon-glitch', 'x'), /canvas/);
});

test('flag transitions is on by default (D391)', () => {
  assert.equal(loadDefinitions(DEFAULT_FLAGS_FILE).find((d) => d.id === 'transitions').default, true);
  assert.equal(createFlags({ dataDir: tmp() }).isOn('transitions'), true);
});

test('isImportedFade: unset and the Meld fade only', () => {
  assert.equal(isImportedFade(undefined, 'h'), true);
  assert.equal(isImportedFade({ type: 'fade', durationMs: 2006 }, 'h'), true);
  assert.equal(isImportedFade({ type: 'fade', durationMs: 1000 }, 'v'), true);
  assert.equal(isImportedFade({ type: 'fade', durationMs: 1000 }, 'h'), false);
  assert.equal(isImportedFade({ type: 'fade', durationMs: 2006, easing: 'linear' }, 'h'), false);
  assert.equal(isImportedFade({ type: 'cut', durationMs: 0 }, 'h'), false);
  assert.equal(isImportedFade({ type: 'stinger', durationMs: 0, file: { base: 'media', rel: 'a.webm' }, pointMs: 5 }, 'h'), false);
});

test('a new alpha project gets the neon-glitch stinger on both canvases; the app data folder is base data', () => {
  const profile = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'project', 'profile.fixture.json'), 'utf8'));
  const b = buildAlphaProject({ presetsDir: path.resolve(HERE, '..', 'registry', 'presets'), profile });
  for (const c of b.project.canvases) assert.deepEqual(c.transition, stingerTransition('neon-glitch', c.id));
  const dataDir = tmp();
  assert.deepEqual(alphaBases({ appDataDir: dataDir, lutsDir: null, assetsDefault: null }), { data: path.resolve(dataDir) });
  assert.deepEqual(alphaBases({ lutsDir: null, assetsDefault: null }), {}, 'only the studio start gives the data base');
});

test('migration: an imported fade or unset transition becomes the stinger once; a later choice is never overwritten', () => {
  const dataDir = tmp();
  const file = path.join(dataDir, 'projects', 'alpha.project.json');
  const p = imported();
  delete p.canvases[1].transition;
  saveProject(file, p);
  const r = applyTransitionDefaults({ file, dataDir, now: new Date('2026-11-18T10:00:00Z') });
  assert.deepEqual(r.changes.map((c) => [c.canvas, c.from, c.to]), [['h', 'fade', 'neon-glitch'], ['v', 'unset', 'neon-glitch']]);
  assert.ok(existsSync(r.backup) && /before-tr1/.test(r.backup));
  assert.equal(loadProject(r.backup).project.canvases[0].transition.type, 'fade', 'the copy is the project as it was');
  const after1 = loadProject(file).project;
  for (const c of after1.canvases) assert.deepEqual(c.transition, stingerTransition('neon-glitch', c.id));
  assert.ok(existsSync(transitionMarkerFile(dataDir)));
  // the user goes back to the fade: the marker keeps it
  after1.canvases[0].transition = { type: 'fade', durationMs: 2006 };
  saveProject(file, after1);
  assert.equal(applyTransitionDefaults({ file, dataDir }), null);
  assert.equal(loadProject(file).project.canvases[0].transition.type, 'fade');
});

test('migration: a cut or another fade stays; the marker is still written; a broken project is left alone and unmarked', () => {
  const dataDir = tmp();
  const file = path.join(dataDir, 'projects', 'alpha.project.json');
  const p = imported();
  p.canvases[0].transition = { type: 'cut', durationMs: 0 };
  p.canvases[1].transition = { type: 'fade', durationMs: 500 };
  saveProject(file, p);
  const r = applyTransitionDefaults({ file, dataDir });
  assert.deepEqual(r.changes, []);
  assert.equal(r.backup, null);
  assert.ok(existsSync(transitionMarkerFile(dataDir)));
  assert.equal(loadProject(file).project.canvases[1].transition.durationMs, 500);
  const d2 = tmp();
  mkdirSync(path.join(d2, 'projects'));
  writeFileSync(path.join(d2, 'projects', 'alpha.project.json'), '{ not json');
  assert.equal(applyTransitionDefaults({ file: path.join(d2, 'projects', 'alpha.project.json'), dataDir: d2 }), null);
  assert.equal(existsSync(transitionMarkerFile(d2)), false);
});

test('prepareAlphaProject: stingerDir applies the migration at start; without it nothing changes; a built project is marked', async () => {
  const dataDir = tmp();
  const file = path.join(dataDir, 'projects', 'alpha.project.json');
  saveProject(file, imported());
  const noBuild = async () => { throw new Error('no build'); };
  const off = await prepareAlphaProject({ dataDir, build: noBuild });
  assert.equal(off.action, 'loaded');
  assert.equal(loadProject(file).project.canvases[0].transition.type, 'fade');
  const on = await prepareAlphaProject({ dataDir, build: noBuild, stingerDir: true });
  assert.equal(on.action, 'loaded');
  assert.equal(on.transitions.length, 2);
  assert.ok(readdirSync(path.join(dataDir, 'projects', '_old')).some((n) => /before-tr1/.test(n)));
  assert.equal(loadProject(file).project.canvases[1].transition.file.base, 'data');
  const d2 = tmp();
  const build = async () => { const p = createProject({ name: 'N', fps: 30 }); for (const c of p.canvases) c.transition = stingerTransition('neon-glitch', c.id); return p; };
  const built = await prepareAlphaProject({ dataDir: d2, build, stingerDir: true });
  assert.equal(built.action, 'built');
  assert.ok(existsSync(transitionMarkerFile(d2)));
});

test('studio form: a built-in stinger is chosen by id only; the project gets base data; a path or an unknown id is refused', async () => {
  const dir = tmp();
  const assets = path.join(dir, 'assets'); mkdirSync(assets);
  const file = path.join(dir, 'p.project.json');
  saveProject(file, createProject({ name: 'T', fps: 30 }));
  const tr = { H: { type: 'cut', durationMs: 0, available: true }, V: { type: 'cut', durationMs: 0, available: true } };
  const host = { describe: () => ({ kind: 'host', available: true }), call: async (m, p) => {
    if (m === 'host.status') return { live: false, recording: false, transitions: structuredClone(tr) };
    if (m === 'transitions.set') { tr[p.canvas] = { type: p.type, durationMs: p.durationMs ?? 0, available: true, ...(p.type === 'stinger' ? { file: `${p.file.base}:${p.file.rel}`, pointMs: p.pointMs, audio: p.audio } : {}) }; return tr; }
    return {};
  } };
  const flags = createFlags({ dataDir: dir });
  flags.set(TRANSITIONS_FLAG, true);
  const KEY = 'k'.repeat(48);
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), assetsDir: assets, limits: { statusPollMs: 20 } });
  const { port } = await srv.listen();
  const req = (method, url, headers, body) => new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject); r.end(body);
  });
  try {
    const cookie = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}` }, (res) => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); }));
    const csrf = (await req('GET', '/ui/api/session', { cookie })).body.csrf;
    const post = (body) => req('POST', '/ui/api/project/transition', { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf }, JSON.stringify(body));
    const ch = (await req('GET', '/ui/api/project/transitions', { cookie })).body;
    assert.deepEqual(ch.stingers.map((s) => s.id), ['neon-glitch', 'cyan-grid', 'synthwave-sweep']);
    assert.equal(ch.stingers[0].default, true);
    assert.equal(JSON.stringify(ch).includes('.webm'), false, 'the page is never told a path');
    assert.equal((await post({ canvas: 'h', type: 'stinger', preset: '../../profile.local' })).body.error, 'unknown-stinger');
    assert.equal((await post({ canvas: 'h', type: 'stinger', preset: 'neon-glitch', file: 'x.webm' })).status, 400, 'preset and file together');
    assert.equal((await post({ canvas: 'h', type: 'stinger', preset: 'neon-glitch', pointMs: 1 })).status, 400, 'the preset owns its point');
    assert.equal((await post({ canvas: 'h', type: 'fade', durationMs: 500, preset: 'neon-glitch' })).status, 400);
    const r = await post({ canvas: 'v', type: 'stinger', preset: 'cyan-grid' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).canvases[1].transition, stingerTransition('cyan-grid', 'v'));
    for (let i = 0; i < 100 && tr.V.type !== 'stinger'; i++) await sleep(10);
    assert.equal(tr.V.file, 'data:transitions/stingers/cyan-grid-v.webm');
    assert.equal(tr.V.pointMs, 450);
  } finally { await srv.close(); }
});
