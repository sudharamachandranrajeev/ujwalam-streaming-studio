// SPDX-License-Identifier: GPL-3.0-or-later
// D442 task manager, job side: category per task, per-task stop / pause / resume through the UI server, pause only at
// a safe point (or a plain reason when a job has none), the next-start choice (run | ask | notify, default notify)
// kept across restarts, nothing paused or carried over runs while live or recording, and a bounded, sanitised log tail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NEXT_START, LOG_TAIL_LINES, TASK_CATEGORIES, categoryOf, cleanControl, cleanTask, controlDir, createTasks, safeLogLine, safeLogTail, takeTaskControls, writeTaskControl, writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { ASK_TEXT, createRecordClips, isSafePoint, jobCategory, partsOf, pauseInfo } from '../services/studio-ui/record-clips.mjs';
import { writeSettings } from '../services/studio-ui/user-settings.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), p));

test('D442 categories: the seven named ones; a writer may name it, else it follows the kind; unknown = maintenance', () => {
  assert.deepEqual(TASK_CATEGORIES, ['clips', 'reels', 'long-video', 'posting', 'learning', 'downloads', 'maintenance']);
  assert.equal(categoryOf({ kind: 'clips' }), 'clips');
  assert.equal(categoryOf({ kind: 'upload' }), 'posting', 'auto-chain upload tasks');
  assert.equal(categoryOf({ kind: 'train' }), 'learning');
  assert.equal(categoryOf({ kind: 'settings' }), 'maintenance');
  assert.equal(categoryOf({ kind: 'clips', category: 'long-video' }), 'long-video');
  assert.equal(categoryOf({ kind: 'clips', category: 'games' }), 'clips', 'an unknown category is not taken');
  assert.deepEqual([jobCategory({ type: 'full' }), jobCategory({ type: 'review' }), jobCategory({ type: 'long' }), jobCategory({ type: 'beatdrop' }), jobCategory({ type: 'train' })],
    ['clips', 'clips', 'long-video', 'reels', 'learning']);
});

test('D442 cleanTask: controls filtered, pause reason only when not pausable, nextStart checked, parts and log tail bounded', () => {
  const t = cleanTask({ id: 'clip-a', title: 'x', state: 'running', kind: 'clips', controls: ['stop', 'pause', 'delete', 'next'], pausable: true, pauseReason: 'ignored',
    paused: 'yes', nextStart: 'later', parts: Array.from({ length: 9 }, (_, i) => `p${i}`.repeat(30)), logTail: Array.from({ length: 30 }, (_, i) => `line ${i}`) });
  assert.deepEqual(t.controls, ['stop', 'pause', 'next']);
  assert.equal(t.category, 'clips');
  assert.deepEqual([t.pausable, t.pauseReason, t.paused, t.pausing, t.nextStart, t.question], [true, null, false, false, null, null]);
  assert.equal(t.parts.length, 6); assert.ok(t.parts.every((p) => p.length <= 40));
  assert.equal(t.logTail.length, LOG_TAIL_LINES); assert.equal(t.logTail.at(-1), 'line 29', 'the newest lines are kept');
  const n = cleanTask({ id: 'b', title: 'x', state: 'waiting', pausable: false, pauseReason: 'r'.repeat(300), nextStart: 'ask', question: 'Run it?' });
  assert.deepEqual([n.pausable, n.pauseReason.length, n.nextStart, n.question, n.controls], [false, 120, 'ask', 'Run it?', []]);
  assert.equal(DEFAULT_NEXT_START, 'notify', 'user 2026-11-24');
});

test('D442 log tail: chat, names and messages dropped; paths, links, tokens, secrets and quoted text masked', () => {
  assert.equal(safeLogLine('chat: someone said hi'), null);
  assert.equal(safeLogLine('viewer Foo joined'), null);
  assert.equal(safeLogLine('ping @SomeName'), null);
  assert.equal(safeLogLine('ujwalam-progress {"stage":"render"}'), null, 'progress lines are not log lines');
  assert.equal(safeLogLine('reading C:\\Users\\me\\Videos\\rec.mkv now'), 'reading [path] now');
  assert.equal(safeLogLine('POST https://example.invalid/upload?x=1 done'), 'POST [link] done');
  assert.equal(safeLogLine('access_token=abc.def failed'), 'access_token=[hidden] failed');
  assert.doesNotMatch(safeLogLine('sending Bearer abcdef now'), /abcdef/);
  assert.doesNotMatch(safeLogLine('Authorization: Bearer abcdef') ?? '', /abcdef/);
  assert.doesNotMatch(safeLogLine('id ya29A0ARrdaM1234567890abcdefghijklmnop end'), /ya29/);
  assert.equal(safeLogLine('title "My best game ever" saved'), 'title [text] saved');
  assert.equal(safeLogLine('x'.repeat(500)).length <= 160, true);
  assert.equal(safeLogLine('\u0007\u0000'), null);
  assert.deepEqual(safeLogTail(['a', 'chat x', 'b']), ['a', 'b']);
});

test('D442 control files: atomic, one per request, applied in the order asked, bad ones removed, ids checked', () => {
  const d = tmp('ujw-tm-ctl-');
  try {
    assert.equal(cleanControl({ op: 'pause', atMs: 5 }).op, 'pause');
    assert.equal(cleanControl({ op: 'next', nextStart: 'never', atMs: 5 }), null);
    assert.equal(cleanControl({ op: 'delete', atMs: 5 }), null);
    assert.equal(writeTaskControl(d, '../x', { op: 'stop', atMs: 1 }), false);
    assert.equal(writeTaskControl(d, 'clip-a', { op: 'pause', atMs: 1 }), true);
    assert.equal(writeTaskControl(d, 'clip-a', { op: 'resume', atMs: 2 }), true);
    assert.equal(writeTaskControl(d, 'clip-b', { op: 'next', nextStart: 'run', atMs: 3 }), true);
    writeFileSync(path.join(controlDir(d), 'junk.json'), '{no');
    assert.deepEqual(readdirSync(controlDir(d)).filter((n) => n.endsWith('.tmp')), []);
    assert.equal(writeTaskControl(d, 'clip-a', { op: 'stop', atMs: 2 }), true, 'same ms: kept in the order written');
    assert.deepEqual(takeTaskControls(d), [{ id: 'clip-a', op: 'pause', atMs: 1 }, { id: 'clip-a', op: 'resume', atMs: 2 }, { id: 'clip-a', op: 'stop', atMs: 2 }, { id: 'clip-b', op: 'next', nextStart: 'run', atMs: 3 }]);
    assert.deepEqual(readdirSync(controlDir(d)), [], 'taken once; junk removed');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('D442 in-memory UI tasks: a category, no controls, not pausable with a plain reason', () => {
  const tasks = createTasks({ now: () => 1000, stallAfterMs: null });
  tasks.start({ title: 'Saving your settings', kind: 'settings' });
  const [t] = tasks.list();
  assert.deepEqual([t.category, t.controls, t.pausable, typeof t.pauseReason, t.nextStart], ['maintenance', [], false, 'string', null]);
});

test('D442 safe points and parts: clip jobs between pieces, the long video between batches, BeatDrop and pack check none', () => {
  const full = { type: 'full' }; const long = { type: 'long' };
  assert.equal(isSafePoint({ stage: 'render', done: 1, total: 7 }, full), true, 'a clip was made');
  assert.equal(isSafePoint({ stage: 'render', done: 0, total: 7 }, full), false, 'the stage only began');
  assert.equal(isSafePoint({ stage: 'publish', done: 0, total: 1 }, full), false);
  assert.equal(isSafePoint({ stage: 'montage', done: 1, total: 1 }, full), false);
  assert.equal(isSafePoint({ stage: 'long', done: 2, total: null }, long), true, 'clipper on_part: a batch was saved');
  assert.equal(isSafePoint({ stage: 'long', done: 1, total: 1 }, long), false, 'the end line');
  assert.equal(isSafePoint({ stage: 'long', done: 0, total: 1 }, long), false, 'the start line');
  for (const type of ['beatdrop', 'train']) {
    const p = pauseInfo({ type });
    assert.equal(p.pausable, false); assert.match(p.reason, /can be stopped, not paused/);
    assert.equal(isSafePoint({ stage: 'montage', done: 1, total: 1 }, { type }), false);
  }
  assert.deepEqual(partsOf('render'), ['Clip maker (Python)', 'Video tools (ffmpeg)']);
  assert.deepEqual(partsOf('detect'), ['Clip maker (Python)', 'Screen reader (OCR)']);
  assert.deepEqual(partsOf(null), ['Clip maker (Python)']);
});

// ---- the clip queue (record-clips.mjs) ----
const RUNGS = [{ id: 'rec-h', canvas: 'H' }, { id: 'rec-v', canvas: 'V' }];
function setup() {
  const d = tmp('ujw-tm-rc-');
  const root = path.join(d, 'repo');
  mkdirSync(path.join(root, 'services', 'clip'), { recursive: true });
  mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  writeFileSync(path.join(root, 'services', 'clip', 'clipper.py'), '');
  writeFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), '');
  const rec = path.join(d, 'rec'); mkdirSync(rec);
  const files = (n) => { const h = path.join(rec, `game-h-${n}.mkv`); writeFileSync(h, ''); return h; };
  const dataDir = path.join(d, 'core'); mkdirSync(dataDir);
  const spawned = [];
  const spawnFn = (exe, argv, o) => { const c = new EventEmitter(); c.stderr = new PassThrough(); spawned.push({ argv, o, c }); return c; };
  const killed = [];
  const killTreeFn = (c) => { killed.push(c); c.killed = true; setImmediate(() => c.emit('exit', 1)); };
  const lines = [];
  let t = Date.parse('2026-11-24T10:00:00Z');
  const S = (rec0, { stream = 'stopped', h } = {}) => ({ rungs: RUNGS, sinks: [{ id: 'r-h', kind: 'record', rung: 'rec-h', state: rec0, path: h }, { id: 'yt', kind: 'stream', rung: 'rec-h', state: stream }] });
  const s = { d, root, dataDir, spawned, killed, lines, files, S, now: () => t, advance: (ms) => { t += ms; },
    make: (o = {}) => createRecordClips({ clipRoot: root, dataDir, log: (l) => lines.push(l), spawnFn, killTreeFn, now: () => t, ...o }),
    status: () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'status.json'), 'utf8')),
    task: (id) => JSON.parse(readFileSync(path.join(dataDir, 'tasks', `${id}.json`), 'utf8')),
    ctl: (id, op, extra = {}) => writeTaskControl(dataDir, id, { op, atMs: t, ...extra }),
    /** One finished recording: queues one full clip job. */
    record: (rc, h) => { rc.feed(S('live', { h })); s.advance(1000); rc.feed(S('stopped', { h })); },
  };
  writeSettings(dataDir, { clips: { recording: 'after', live: 'after' } });
  return s;
}
const tick = () => new Promise((r) => setImmediate(r));

test('D442 pause: a waiting job is paused at once and never starts; resume lets it run', async () => {
  const s = setup();
  try {
    const rc = s.make();
    const h1 = s.files(1); const h2 = s.files(2);
    s.record(rc, h1); // job 1 runs
    s.record(rc, h2); // job 2 waits
    assert.equal(s.spawned.length, 1);
    s.ctl('clip-game-h-2', 'pause'); rc.feed(s.S('stopped'));
    assert.deepEqual([s.task('clip-game-h-2').paused, s.task('clip-game-h-2').note], [true, 'Paused by you; press Resume to continue']);
    assert.deepEqual(s.task('clip-game-h-2').controls, ['stop', 'resume', 'next']);
    s.spawned[0].c.emit('exit', 0);
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'paused: not started when its turn comes');
    assert.equal(s.status().waitingForYou, 1);
    s.ctl('clip-game-h-2', 'resume'); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'resumed: it runs');
    assert.equal(s.task('clip-game-h-2').state, 'running');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D442 pause: the running job ends only at its next safe point, stays queued and paused across a restart', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1));
    const err = s.spawned[0].c.stderr;
    s.ctl('clip-game-h-1', 'pause'); rc.feed(s.S('stopped'));
    assert.equal(s.task('clip-game-h-1').pausing, true);
    assert.equal(s.task('clip-game-h-1').note, 'Pausing at the next safe point');
    err.write('ujwalam-progress {"stage":"candidates","done":0,"total":1}\nujwalam-progress {"stage":"render","done":0,"total":5}\n'); await tick();
    assert.equal(s.killed.length, 0, 'no safe point yet: it keeps working');
    err.write('ujwalam-progress {"stage":"render","done":1,"total":5,"note":"clip c01 done"}\n'); await tick();
    assert.equal(s.killed.length, 1, 'a clip was saved: the whole tree is ended there');
    await tick(); await tick();
    const t = s.task('clip-game-h-1');
    assert.deepEqual([t.state, t.paused, t.pausing], ['waiting', true, false]);
    assert.equal(s.status().queued[0].paused, true, 'kept in status.json');
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'paused: it does not start again by itself');
    rc.stop();
    const rc2 = s.make();
    rc2.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'still paused after a restart');
    assert.equal(s.task('clip-game-h-1').paused, true);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D442 pause: BeatDrop and the pack check have no safe point: pause is not offered and a request is ignored', async () => {
  const s = setup();
  try {
    // a job carried over from the last session (status.json), started by the user
    mkdirSync(path.join(s.dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(s.dataDir, 'clips', 'status.json'), JSON.stringify({ queued: [{ type: 'train', kind: 'train', name: 'pack-check-1', nextStart: 'run' }] }));
    const rc = s.make();
    writeFileSync(path.join(s.root, 'services', 'clip', 'pack_tune.py'), '');
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    const t = s.task('clip-pack-check-1');
    assert.deepEqual([t.category, t.pausable, t.controls.includes('pause')], ['learning', false, false]);
    assert.match(t.pauseReason, /can be stopped, not paused/);
    s.ctl('clip-pack-check-1', 'pause'); rc.feed(s.S('stopped'));
    s.spawned[0].c.stderr.write('ujwalam-progress {"stage":"render","done":1,"total":2}\n'); await tick();
    assert.equal(s.killed.length, 0);
    assert.ok(s.lines.some((l) => /cannot be paused/.test(l)));
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D442 stop one task: the running one ends (whole tree) and does not come back; the next one starts; a waiting one leaves the queue', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2)); s.record(rc, s.files(3));
    s.ctl('clip-game-h-3', 'stop'); rc.feed(s.S('stopped'));
    assert.deepEqual([s.task('clip-game-h-3').state, s.task('clip-game-h-3').note], ['failed', 'Stopped by you']);
    s.ctl('clip-game-h-1', 'stop'); rc.feed(s.S('stopped'));
    assert.equal(s.killed.length, 1);
    await tick(); await tick();
    assert.deepEqual([s.task('clip-game-h-1').state, s.task('clip-game-h-1').note], ['failed', 'Stopped by you']);
    assert.equal(s.spawned.length, 2, 'the next job started');
    assert.match(s.spawned[1].argv.join(' '), /game-h-2/);
    assert.deepEqual(s.status().queued, [], 'nothing else queued; the stopped ones are gone');
    rc.stop();
    const rc2 = s.make(); rc2.feed(s.S('stopped'));
    assert.ok(!s.status().queued.some((q) => /h-1|h-3/.test(q.name)), 'stopped jobs do not come back');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D442 next start: default notify waits with a notice; ask carries its question; run starts by itself; the choice survives restarts', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2)); s.record(rc, s.files(3));
    assert.equal(s.task('clip-game-h-2').nextStart, 'notify', 'default');
    s.ctl('clip-game-h-2', 'next', { nextStart: 'ask' });
    s.ctl('clip-game-h-3', 'next', { nextStart: 'run' });
    rc.feed(s.S('stopped'));
    assert.equal(s.task('clip-game-h-2').nextStart, 'ask');
    rc.stop(); await tick();
    const rc2 = s.make();
    rc2.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'only the "run" job started');
    assert.match(s.spawned[1].argv.join(' '), /game-h-3/);
    const n = s.task('clip-game-h-1'); const a = s.task('clip-game-h-2');
    assert.deepEqual([n.state, n.nextStart, n.question, n.note], ['waiting', 'notify', null, 'Did not finish last time; it waits until you start it']);
    assert.deepEqual([a.state, a.nextStart, a.question], ['waiting', 'ask', ASK_TEXT]);
    assert.ok(a.controls.includes('resume'));
    assert.equal(s.status().waitingForYou, 2);
    // the answer to "ask" is resume (run it) or stop
    s.ctl('clip-game-h-2', 'stop'); rc2.feed(s.S('stopped'));
    assert.equal(s.task('clip-game-h-2').state, 'failed');
    s.spawned[1].c.emit('exit', 0);
    s.ctl('clip-game-h-1', 'resume'); rc2.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 3);
    assert.match(s.spawned[2].argv.join(' '), /game-h-1/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D442 carried-over or resumed work never runs while live or recording', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1));
    rc.stop(); await tick();
    const rc2 = s.make();
    const h9 = s.files(9);
    rc2.feed(s.S('live', { h: h9 })); // a recording runs
    s.ctl('clip-game-h-1', 'resume'); rc2.feed(s.S('live', { h: h9 }));
    assert.equal(s.spawned.length, 1, 'resumed while recording: it waits');
    assert.equal(s.task('clip-game-h-1').note, 'Waiting until the recording ends');
    rc2.feed(s.S('stopped', { h: h9, stream: 'live' }));
    assert.equal(s.spawned.length, 1, 'live: nothing starts');
    rc2.feed(s.S('stopped', { h: h9 }));
    assert.equal(s.spawned.length, 2, 'off air, not recording: it runs');
    assert.match(s.spawned[1].argv.join(' '), /game-h-1/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('D442 running task: category, parts, current step and a sanitised log tail; a leftover request is dropped', async () => {
  const s = setup();
  try {
    writeTaskControl(s.dataDir, 'clip-game-h-1', { op: 'stop', atMs: s.now() - 60_000 }); // from before this launcher
    const rc = s.make();
    s.record(rc, s.files(1));
    assert.equal(s.killed.length, 0, 'an old request is not applied');
    const err = s.spawned[0].c.stderr;
    err.write('opening D:\\Clips\\game-h-1.mkv\nchat line from a viewer\ntoken=abc123 ok\nujwalam-progress {"stage":"render","done":2,"total":5}\n'); await tick();
    const t = s.task('clip-game-h-1');
    assert.deepEqual([t.category, t.state, t.stageText, t.parts], ['clips', 'running', 'Making clip videos', ['Clip maker (Python)', 'Video tools (ffmpeg)']]);
    assert.deepEqual(t.logTail, ['opening [path]', 'token=[hidden] ok']);
    assert.ok(existsSync(path.join(s.dataDir, 'clips', 'run-game-h-1.log')));
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// ---- the UI server route ----
const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 't'.repeat(48);
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

test('D442 POST /ui/api/tasks/control: checks id, op and nextStart; only offered controls; not-pausable says why; writes the request', async () => {
  const d = tmp('ujw-tm-srv-');
  const fake = createFakeHost({});
  const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir: d, limits: { statusPollMs: 50 } });
  const { port } = await srv.listen();
  try {
    const cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).body.csrf;
    const post = (b) => raw(port, { method: 'POST', url: '/ui/api/tasks/control', body: JSON.stringify(b), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
    const now = Date.now();
    writeTaskFile(d, { id: 'clip-a', title: 'Clips from a', kind: 'clips', state: 'running', startedAt: now, updatedAt: now, controls: ['stop', 'pause', 'next'], pausable: true, nextStart: 'notify' });
    writeTaskFile(d, { id: 'beatdrop-b', title: 'BeatDrop', kind: 'clips', category: 'reels', state: 'running', startedAt: now, updatedAt: now, controls: ['stop', 'next'], pausable: false, pauseReason: 'made in one piece' });
    writeTaskFile(d, { id: 'up-c', title: 'Uploading', kind: 'upload', state: 'running', startedAt: now, updatedAt: now });
    assert.equal((await post({ id: '../x', op: 'stop' })).status, 400);
    assert.equal((await post({ id: 'clip-a', op: 'kill' })).status, 400);
    assert.equal((await post({ id: 'clip-a', op: 'next', nextStart: 'later' })).status, 400);
    assert.equal((await post({ id: 'clip-a', op: 'stop', nextStart: 'run' })).status, 400);
    assert.equal((await post({ id: 'clip-a', op: 'stop', extra: 1 })).status, 400);
    assert.equal((await post({ id: 'nope', op: 'stop' })).status, 404);
    const np = await post({ id: 'beatdrop-b', op: 'pause' });
    assert.deepEqual([np.status, np.body.error, np.body.reason], [409, 'not-pausable', 'made in one piece']);
    assert.equal((await post({ id: 'clip-a', op: 'resume' })).status, 409, 'resume is not offered while it runs');
    assert.equal((await post({ id: 'up-c', op: 'stop' })).body.error, 'not-offered', 'a task with no controls');
    const ok = await post({ id: 'clip-a', op: 'pause' });
    assert.deepEqual([ok.status, ok.body.op], [202, 'pause']);
    assert.equal((await post({ id: 'clip-a', op: 'next', nextStart: 'run' })).status, 202);
    const got = takeTaskControls(d);
    assert.deepEqual(got.map((r) => [r.id, r.op, r.nextStart]), [['clip-a', 'pause', undefined], ['clip-a', 'next', 'run']], 'every request, in order');
    const list = (await raw(port, { url: '/ui/api/tasks', headers: { cookie } })).body.tasks;
    assert.deepEqual(Object.fromEntries(list.map((t) => [t.id, t.category])), { 'clip-a': 'clips', 'beatdrop-b': 'reels', 'up-c': 'posting' });
  } finally { srv.close(); rmSync(d, { recursive: true, force: true }); }
});
