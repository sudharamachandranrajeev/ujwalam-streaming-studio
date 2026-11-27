// SPDX-License-Identifier: GPL-3.0-or-later
// Make clips again (2026-11-27): a stopped or failed clip task keeps a button that queues the same job again; the Clips
// menu lists recordings with no finished run (H + its V partner) and queues one with one click. Queue builder from a
// stopped task record, recordings list pairing, the launcher's queue (needsIdle respected), and the routes' auth.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ackMakeRequest, againRecord, cleanRequest, jobFromAgain, jobFromRecording, listRecordings, readAgain, takeMakeRequests, writeAgain, writeMakeRequest } from '../services/studio-ui/clips-again.mjs';
import { createRecordClips } from '../services/studio-ui/record-clips.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { writeSettings } from '../services/studio-ui/user-settings.mjs';
import { writeTaskControl, writeTaskFile } from '../services/studio-ui/tasks.mjs';

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));
const RUNGS = [{ id: 'rec-h', canvas: 'H' }, { id: 'rec-v', canvas: 'V' }];
const take = (d) => { const r = takeMakeRequests(d); r.forEach(ackMakeRequest); return r; };
const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const d = tmp('ujw-again-');
  const root = path.join(d, 'repo');
  mkdirSync(path.join(root, 'services', 'clip'), { recursive: true });
  mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'clip', 'clipper.py'), '');
  writeFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), '');
  const rec = path.join(d, 'rec'); mkdirSync(rec);
  const dataDir = path.join(d, 'core'); mkdirSync(dataDir);
  writeSettings(dataDir, { clips: { recording: 'after', live: 'after' } });
  const spawned = []; const killed = []; const lines = [];
  let t = Date.parse('2026-11-27T10:00:00Z');
  const S = (rec0, { h } = {}) => ({ rungs: RUNGS, sinks: [{ id: 'r-h', kind: 'record', rung: 'rec-h', state: rec0, path: h }, { id: 'yt', kind: 'stream', rung: 'rec-h', state: 'stopped' }] });
  const s = { d, root, rec, dataDir, spawned, killed, lines, S, advance: (ms) => { t += ms; },
    make: () => createRecordClips({ clipRoot: root, dataDir, log: (l) => lines.push(l), now: () => t, recordingsFolder: rec,
      spawnFn: (exe, argv) => { const c = new EventEmitter(); c.stderr = new PassThrough(); spawned.push({ argv, c }); return c; },
      killTreeFn: (c) => { killed.push(c); setImmediate(() => c.emit('exit', 1)); } }),
    status: () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'status.json'), 'utf8')),
    tasks: () => readdirSync(path.join(dataDir, 'tasks')).map((n) => JSON.parse(readFileSync(path.join(dataDir, 'tasks', n), 'utf8'))),
    file: (n, size = 5) => { const f = path.join(rec, n); writeFileSync(f, 'x'.repeat(size)); return f; },
    now: () => t };
  return s;
}

test('record: a stopped task keeps its job; the builder gives the same job back, as the user\'s own start', () => {
  const job = { type: 'review', kind: 'recording', h: 'C:\\r\\alpha-20261127-090000.mkv', v: 'C:\\r\\alpha-v-20261127-090000.mkv', since: '2026-11-27T09:00:00.000Z', until: '2026-11-27T10:00:00.000Z', name: 'alpha-20261127-090000', minutes: 60, nextStart: 'run' };
  const rec = againRecord(job, 5);
  assert.deepEqual([rec.type, rec.kind, rec.h, rec.v, rec.since, rec.until, rec.name, rec.minutes, rec.nextStart], [job.type, job.kind, job.h, job.v, job.since, job.until, job.name, 60, 'run']);
  assert.deepEqual(jobFromAgain(rec, { exists: () => true }).job, { ...job, userStarted: true });
  assert.equal(jobFromAgain(rec, { exists: (p) => !p.includes('alpha-v') }).job.v, undefined, 'a V file that is gone is left out');
  assert.match(jobFromAgain(rec, { exists: () => false }).problem, /gone/);
  assert.ok(jobFromAgain({ ...rec, type: 'train' }).problem);
  assert.ok(jobFromAgain({ ...rec, name: null }).problem);
  assert.equal(jobFromAgain({ type: 'review', name: 'live-1', kind: 'live', since: 's', until: 'u' }).job.type, 'review', 'a review of a stream needs no recording file');
});

test('launcher: Stop on a running clip task leaves "again"; the request queues the same job, once, and the old row goes', async () => {
  const s = setup();
  try {
    const h = s.file('alpha-20261127-090000.mkv');
    const rc = s.make();
    rc.feed(s.S('live', { h })); s.advance(1000); rc.feed(s.S('stopped', { h }));
    assert.equal(s.spawned.length, 1);
    assert.equal(s.status().running.name, 'alpha-20261127-090000');
    const id = s.tasks().find((t) => t.kind === 'clips').id;
    writeTaskControl(s.dataDir, id, { op: 'stop', atMs: s.now() }); rc.feed(s.S('stopped'));
    await tick(); await tick();
    const row = s.tasks().find((t) => t.id === id);
    assert.deepEqual([row.state, row.note, row.again], ['failed', 'Stopped by you', true], 'the task keeps the button');
    assert.ok(readAgain(s.dataDir, id), 'and the job is saved');
    assert.equal(s.spawned.length, 1, 'nothing runs again by itself');
    assert.equal(writeMakeRequest(s.dataDir, { op: 'again', id, atMs: s.now() }), true);
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'queued through the same queue and started (outputs off)');
    assert.ok(s.spawned[1].argv.includes(h)); assert.ok(s.spawned[1].argv.includes('--recording'));
    assert.equal(s.status().running.name, 'alpha-20261127-090000');
    assert.equal(s.tasks().filter((t) => t.id === id).length, 0, 'the old row is gone');
    assert.equal(readAgain(s.dataDir, id), null);
    // the same job asked for again while it is queued adds nothing
    writeAgain(s.dataDir, id, { type: 'full', h, name: 'alpha-20261127-090000' }, s.now());
    writeMakeRequest(s.dataDir, { op: 'again', id, atMs: s.now() }); rc.feed(s.S('stopped'));
    assert.equal(s.status().queued.length, 0); assert.equal(s.spawned.length, 2);
    rc.stop();
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('launcher: a failed run offers it too; a gone recording or an unknown task is dropped with a plain log', async () => {
  const s = setup();
  try {
    const h = s.file('alpha-20261127-100000.mkv');
    const rc = s.make();
    rc.feed(s.S('live', { h })); s.advance(1000); rc.feed(s.S('stopped', { h }));
    s.spawned[0].c.emit('exit', 2); await tick();
    const row = s.tasks().find((t) => t.kind === 'clips');
    assert.deepEqual([row.state, row.again], ['failed', true]);
    rmSync(h);
    writeMakeRequest(s.dataDir, { op: 'again', id: row.id, atMs: s.now() }); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    assert.ok(s.lines.some((l) => /make clips again: the recording is gone/.test(l)));
    writeMakeRequest(s.dataDir, { op: 'again', id: 'clip-nothing-00000000', atMs: s.now() }); rc.feed(s.S('stopped'));
    assert.ok(s.lines.some((l) => /make clips again: that job cannot be made again/.test(l)));
    assert.deepEqual(takeMakeRequests(s.dataDir), [], 'every request was taken');
    rc.stop();
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('launcher: a recording chosen in the Clips menu waits while a recording runs (needsIdle), then starts', async () => {
  const s = setup();
  try {
    const h = s.file('alpha-20261127-110000.mkv'); const other = s.file('alpha-20261127-120000.mkv');
    const rc = s.make();
    rc.feed(s.S('live', { h: other })); // a recording is running now
    writeMakeRequest(s.dataDir, { op: 'recording', name: 'alpha-20261127-110000', atMs: s.now() });
    rc.feed(s.S('live', { h: other }));
    assert.deepEqual(s.status().queued.map((q) => q.name), ['alpha-20261127-110000']);
    assert.equal(s.spawned.length, 0, 'not started beside the recording');
    rc.feed(s.S('live', { h: other }));
    assert.equal(s.spawned.length, 0);
    s.advance(1000); rc.feed(s.S('stopped', { h: other }));
    const ran = s.spawned.map((x) => x.argv[x.argv.indexOf('--recording') + 1]);
    assert.equal(ran.length, 1, 'one job at a time');
    assert.ok(ran[0] === h || ran[0] === other);
    rc.stop();
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('recordings list: H paired with its V by name, finished runs left out, newest first, junk and V-only skipped', () => {
  const s = setup();
  try {
    const { rec, dataDir } = s;
    const t0 = Date.now() / 1000;
    const mk = (n, ageS, size = 7) => { const f = s.file(n, size); const at = new Date((t0 - ageS) * 1000); utimesSync(f, at, at); };
    mk('alpha-20261127-090000.mkv', 300); mk('alpha-v-20261127-090000.mkv', 300);
    mk('alpha-20261126-090000.mkv', 900); // no V
    mk('alpha-20261125-090000.mkv', 1200); mk('alpha-v-20261125-090000.mkv', 1200); // has a finished job
    mk('alpha-20261124-090000.mkv', 1500); // has a finished run folder
    mk('alpha-v-20261120-090000.mkv', 1800); // a V with no H
    mk('empty-20261121-090000.mkv', 600, 0);
    writeFileSync(path.join(rec, 'notes.txt'), 'x');
    mkdirSync(path.join(rec, 'replay'));
    mkdirSync(path.join(dataDir, 'clips', 'runs', 'alpha-20261124-090000'), { recursive: true });
    writeFileSync(path.join(dataDir, 'clips', 'runs', 'alpha-20261124-090000', 'published.json'), '{"files":["a"]}');
    const done = path.join(rec, 'alpha-20261125-090000.mkv');
    const list = listRecordings({ folder: rec, dataDir, readRecords: () => [{ h: done, result: 'done' }, { h: path.join(rec, 'alpha-20261126-090000.mkv'), result: 'failed' }] });
    assert.deepEqual(list.map((r) => r.name), ['alpha-20261127-090000', 'alpha-20261126-090000']);
    assert.equal(list[0].v, path.join(rec, 'alpha-v-20261127-090000.mkv'));
    assert.equal(list[1].v, null, 'no V file: H only');
    assert.deepEqual(jobFromRecording(list[0], { nowMs: 0 }), { type: 'full', kind: 'recording', h: list[0].h, v: list[0].v, name: 'alpha-20261127-090000', until: '1970-01-01T00:00:00.000Z', nextStart: 'notify', userStarted: true });
    assert.deepEqual(listRecordings({ folder: path.join(rec, 'nope'), dataDir }), []);
    assert.equal(listRecordings({ folder: rec, dataDir, limit: 1 }).length, 1);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('requests: only a task id or a plain recording name; files taken once, oldest first', () => {
  const s = setup();
  try {
    assert.equal(cleanRequest({ op: 'recording', name: '..\\x', atMs: 1 }), null);
    assert.equal(cleanRequest({ op: 'recording', name: 'C:/x', atMs: 1 }), null);
    assert.equal(cleanRequest({ op: 'again', id: '../x', atMs: 1 }), null);
    assert.equal(cleanRequest({ op: 'delete', id: 'x', atMs: 1 }), null);
    assert.equal(writeMakeRequest(s.dataDir, { op: 'recording', name: 'b', atMs: 2 }), true);
    assert.equal(writeMakeRequest(s.dataDir, { op: 'again', id: 'clip-a-00000001', atMs: 1 }), true);
    assert.deepEqual(takeMakeRequests(s.dataDir).map(({ op, atMs }) => [op, atMs]), [['again', 1], ['recording', 2]]);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// ---- routes: session cookie + Origin + CSRF like the other mutating routes ----
const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = JSON.parse(t); } catch { b = t; } resolve({ status: res.statusCode, headers: res.headers, body: b }); });
    });
    req.on('error', reject); req.end(body);
  });
}

test('routes: need the session, Origin and CSRF; again only for a task that offers it; make only for a listed recording', async () => {
  const d = tmp('ujw-again-srv-');
  const rec = path.join(d, 'rec'); mkdirSync(rec);
  writeFileSync(path.join(rec, 'alpha-20261127-090000.mkv'), 'xxxx'); writeFileSync(path.join(rec, 'alpha-v-20261127-090000.mkv'), 'xxxx');
  const fake = createFakeHost({});
  const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir: d, recordingsFolder: rec, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    assert.equal((await raw(port, { url: '/ui/api/clips/recordings' })).status, 401, 'no cookie');
    const cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const hdr = { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf };
    const post = (route, b, extra = {}) => raw(port, { method: 'POST', url: route, body: JSON.stringify(b), headers: { ...hdr, ...extra } });
    const list = await raw(port, { url: '/ui/api/clips/recordings', headers: { cookie } });
    assert.deepEqual([list.status, list.body.recordings.map((r) => [r.name, r.hasV])], [200, [['alpha-20261127-090000', true]]]);
    assert.ok(!JSON.stringify(list.body).includes(rec), 'no path leaves the server');
    for (const route of ['/ui/api/clips/again', '/ui/api/clips/make']) {
      const b = route.endsWith('again') ? { id: 'clip-a-0000000a' } : { name: 'alpha-20261127-090000' };
      assert.equal((await post(route, b, { origin: 'http://evil.test' })).status, 403, `${route} wrong Origin`);
      assert.equal((await raw(port, { method: 'POST', url: route, body: JSON.stringify(b), headers: { cookie, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } })).status, 403, `${route} no Origin`);
      assert.equal((await post(route, b, { 'x-ujwalam-csrf': 'nope' })).status, 403, `${route} bad CSRF`);
      assert.equal((await raw(port, { method: 'POST', url: route, body: JSON.stringify(b), headers: { origin: hdr.origin, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } })).status, 401, `${route} no cookie`);
    }
    assert.deepEqual(take(d), [], 'nothing was written by the refused calls');
    assert.equal((await post('/ui/api/clips/make', { name: '..\\x' })).status, 404);
    assert.equal((await post('/ui/api/clips/make', { name: 'nope' })).status, 404);
    assert.equal((await post('/ui/api/clips/make', { name: 'alpha-20261127-090000', path: 'C:/' })).status, 400);
    assert.equal((await post('/ui/api/clips/make', { name: 'alpha-20261127-090000' })).status, 202);
    assert.deepEqual(take(d).map((r) => [r.op, r.name]), [['recording', 'alpha-20261127-090000']]);
    const now = Date.now();
    writeTaskFile(d, { id: 'clip-a-0000000a', title: 'Clips from a did not finish', kind: 'clips', state: 'failed', startedAt: now, updatedAt: now, again: true, note: 'Stopped by you' });
    writeTaskFile(d, { id: 'clip-b-0000000b', title: 'Clips from b', kind: 'clips', state: 'running', startedAt: now, updatedAt: now, again: true });
    assert.equal((await post('/ui/api/clips/again', { id: 'clip-nope-0000000c' })).status, 404);
    assert.equal((await post('/ui/api/clips/again', { id: 'clip-b-0000000b' })).status, 409, 'a running task never offers it');
    assert.equal((await post('/ui/api/clips/again', { id: '../x' })).status, 400);
    assert.equal((await post('/ui/api/clips/again', { id: 'clip-a-0000000a', h: 'C:/x.mkv' })).status, 400);
    assert.equal((await post('/ui/api/clips/again', { id: 'clip-a-0000000a' })).status, 202);
    assert.deepEqual(take(d).map((r) => [r.op, r.id]), [['again', 'clip-a-0000000a']]);
    const t = (await raw(port, { url: '/ui/api/tasks', headers: { cookie } })).body.tasks.find((x) => x.id === 'clip-a-0000000a');
    assert.equal(t.again, true);
  } finally { await srv.close(); rmSync(d, { recursive: true, force: true }); }
});
