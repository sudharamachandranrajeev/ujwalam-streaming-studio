// SPDX-License-Identifier: GPL-3.0-or-later
// D394 (proposed): the transitions form lists every type and wipe with availability; each new type is saved through the
// project validator, off air and live. Fake host only; nothing is started.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createStudioServer, TRANSITIONS_FLAG } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

test('D394: kinds and wipes with availability; every new type saved through the validator, off air and live', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-d394-'));
  const file = path.join(dir, 'p.project.json');
  saveProject(file, createProject({ name: 'T', fps: 30 }));
  const state = { live: false, types: true };
  const host = {
    describe: () => ({ kind: 'host', available: true }),
    call: async (m) => {
      if (m === 'host.status') return { live: state.live, recording: false, transitions: { H: { type: 'cut', durationMs: 0, available: true }, V: { type: 'cut', durationMs: 0, available: true } } };
      if (m === 'transitions.types') {
        if (!state.types) throw new Error('no such method');
        return { types: ['cut', 'fade', 'stinger', 'slide', 'swipe', 'wipe', 'fadeColor'].map((t) => ({ type: t, fields: [], available: t !== 'swipe' })), wipes: ['clock', 'iris'] };
      }
      return {};
    },
  };
  const flags = createFlags({ dataDir: dir });
  flags.set(TRANSITIONS_FLAG, true);
  const KEY = 'k'.repeat(48);
  const core = { describe: () => ({ available: false }), call: async () => { throw new Error('x'); } };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, flags, projectSync: createProjectSync({ file }), limits: { statusPollMs: 20 } });
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
    const post = (body) => req('POST', '/ui/api/project/transition', { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf }, JSON.stringify(body));
    const saved = (i) => JSON.parse(readFileSync(file, 'utf8')).canvases[i].transition;
    const ch = (await req('GET', '/ui/api/project/transitions', { cookie })).body;
    assert.deepEqual(ch.kinds.map((k) => k.id), ['stinger', 'cut', 'fade', 'slide', 'swipe', 'wipe', 'fadeColor']);
    assert.equal(ch.kinds.find((k) => k.id === 'swipe').available, false);
    assert.match(ch.kinds.find((k) => k.id === 'swipe').reason, /swipe/);
    assert.equal(ch.kinds.find((k) => k.id === 'slide').available, true);
    assert.deepEqual(ch.kinds.find((k) => k.id === 'wipe').fields, ['pattern', 'softness', 'invert']);
    assert.equal(ch.wipes.find((w) => w.id === 'clock').label, 'Clock');
    assert.equal(ch.wipes.find((w) => w.id === 'clock').available, true);
    assert.equal(ch.wipes.find((w) => w.id === 'fractal').available, false);
    assert.deepEqual(ch.directions, ['left', 'right', 'up', 'down']);
    assert.deepEqual(ch.stingers.map((p) => p.id).sort(), ['cyan-grid', 'neon-glitch', 'synthwave-sweep']);

    let r = await post({ canvas: 'h', type: 'slide', durationMs: 600, direction: 'left' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(saved(0), { type: 'slide', durationMs: 600, direction: 'left' });
    assert.equal((await post({ canvas: 'h', type: 'slide', durationMs: 600, direction: 'diagonal' })).status, 400, 'validator: direction');
    assert.equal((await post({ canvas: 'h', type: 'slide', durationMs: 600 })).status, 400, 'validator: direction needed');
    assert.equal((await post({ canvas: 'h', type: 'slide', durationMs: 600, direction: 'left', swipeIn: true })).status, 400, 'swipeIn is for swipe only');
    assert.equal((await post({ canvas: 'h', type: 'slide', direction: 'left' })).status, 400, 'duration needed');
    assert.equal((await post({ canvas: 'h', type: 'swipe', durationMs: 600, direction: 'up' })).body.error, 'type-unavailable');
    r = await post({ canvas: 'v', type: 'wipe', durationMs: 800, pattern: 'clock', softness: 0.3, invert: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(saved(1), { type: 'wipe', durationMs: 800, pattern: 'clock', softness: 0.3, invert: true });
    assert.equal((await post({ canvas: 'v', type: 'wipe', durationMs: 800, pattern: 'clock', softness: 2 })).status, 400, 'validator: softness 0..1');
    assert.equal((await post({ canvas: 'v', type: 'wipe', durationMs: 800, pattern: 'nope' })).body.error, 'unknown-pattern');
    assert.equal((await post({ canvas: 'v', type: 'wipe', durationMs: 800, pattern: 'fractal' })).body.error, 'unknown-pattern', 'host does not ship it');
    assert.equal((await post({ canvas: 'v', type: 'wipe', durationMs: 800 })).status, 400, 'a wipe needs a pattern');
    r = await post({ canvas: 'h', type: 'fadeColor', durationMs: 900, color: '#102030', pointPct: 40 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(saved(0), { type: 'fadeColor', durationMs: 900, color: '#102030', pointPct: 40 });
    assert.equal((await post({ canvas: 'h', type: 'fadeColor', durationMs: 900, color: 'red' })).status, 400, 'validator: colour');
    assert.deepEqual(ch.ranges.pointPct, [1, 99], 'the validator\'s table is what the boxes get');
    for (const bad of [0, 100, 101]) assert.equal((await post({ canvas: 'h', type: 'fadeColor', durationMs: 900, color: '#102030', pointPct: bad })).status, 400, `validator: point ${bad}`);
    assert.equal((await post({ canvas: 'h', type: 'fadeColor', durationMs: 900, color: '#102030', pointPct: 99 })).status, 200);
    assert.equal((await post({ canvas: 'h', type: 'fade', durationMs: 900, color: '#102030' })).status, 400, 'a colour is for colour fade only');
    // a built-in stinger by id
    r = await post({ canvas: 'h', type: 'stinger', preset: 'cyan-grid' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(saved(0).file, { base: 'data', rel: 'transitions/stingers/cyan-grid-h.webm' });
    assert.equal((await post({ canvas: 'h', type: 'stinger', preset: '../x' })).body.error, 'unknown-stinger');
    // on air (D332): the click applies
    state.live = true;
    assert.equal((await post({ canvas: 'h', type: 'wipe', durationMs: 500, pattern: 'iris' })).status, 200, 'applies while live');
    // a host that cannot list types: saved; the status poll gives the host's own answer
    state.types = false;
    assert.equal((await post({ canvas: 'h', type: 'swipe', durationMs: 500, direction: 'down', swipeIn: true })).status, 200);
    assert.deepEqual(saved(0), { type: 'swipe', durationMs: 500, direction: 'down', swipeIn: true });
    const ch2 = (await req('GET', '/ui/api/project/transitions', { cookie })).body;
    assert.ok(ch2.kinds.every((k) => k.available === true), 'unknown host: nothing is shown as off');
    assert.equal((await post({ canvas: 'h', type: 'stinger', preset: 'neon-glitch' })).status, 200);
    assert.equal((await post({ canvas: 'h', type: 'cut' })).status, 200);
  } finally { await srv.close(); }
});
