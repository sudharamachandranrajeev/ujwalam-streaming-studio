// SPDX-License-Identifier: GPL-3.0-or-later
// D442 task manager, job side: category per task, per-task stop / pause / resume through the UI server, pause only at
// a safe point (or a plain reason when a job has none), the next-start choice (run | ask | notify, default notify)
// kept across restarts, nothing paused or carried over runs while live or recording, and a log tail built only from
// typed events (allowlist). Codex review findings 1-3, 6-10 have their tests at the end of the queue section.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NEXT_START, END_TEXT, LOG_TAIL_LINES, TASK_CATEGORIES, categoryOf, cleanControl, cleanTask, controlDir, createTasks, logEventText, peekTaskControls, pushLogEvent, takeTaskControls, writeTaskControl, writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { ASK_TEXT, createRecordClips, isSafePoint, jobCategory, parseSafepoint, partsOf, pauseInfo } from '../services/studio-ui/record-clips.mjs';
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
    paused: 'yes', nextStart: 'later', parts: Array.from({ length: 9 }, (_, i) => `p${i}`.repeat(30)), logTail: ['C:\\x\\raw line', 'token=abc'],
    logEvents: [...Array.from({ length: 30 }, (_, i) => ({ v: 1, type: 'progress', stage: 'render', done: i, total: 40 })), { v: 1, type: 'progress', stage: 'a private name', done: 1 }, { type: 'end', code: 'done' }, 'raw'] });
  assert.deepEqual(t.controls, ['stop', 'pause', 'next']);
  assert.equal(t.category, 'clips');
  assert.deepEqual([t.pausable, t.pauseReason, t.paused, t.pausing, t.nextStart, t.question], [true, null, false, false, null, null]);
  assert.equal(t.parts.length, 6); assert.ok(t.parts.every((p) => p.length <= 40));
  assert.equal(t.logTail.length, LOG_TAIL_LINES); assert.equal(t.logTail.at(-1), 'Making clip videos: 29 of 40', 'the newest events are kept');
  assert.ok(!t.logTail.some((l) => /raw|token|private/.test(l)), 'Codex round 2: a string tail (older files) and unknown or unversioned events are dropped');
  assert.equal(cleanTask({ id: 'x', title: 'x', state: 'done', logTail: ['C:\\x\\a.mkv'] }).logTail.length, 0);
  const n = cleanTask({ id: 'b', title: 'x', state: 'waiting', pausable: false, pauseReason: 'r'.repeat(300), nextStart: 'ask', question: 'Run it?' });
  assert.deepEqual([n.pausable, n.pauseReason.length, n.nextStart, n.question, n.controls], [false, 120, 'ask', 'Run it?', []]);
  assert.equal(DEFAULT_NEXT_START, 'notify', 'user 2026-11-24');
});

test('D442 log tail (Codex review 6): an allowlist of typed events with fixed text; anything else is not shown', () => {
  assert.equal(logEventText({ type: 'progress', stage: 'render', done: 2, total: 5 }), 'Making clip videos: 2 of 5');
  assert.equal(logEventText({ type: 'progress', stage: 'long', done: 3, total: null, step: 'part' }), 'Making the long video: 3', 'fixed text; the step is not shown');
  assert.equal(logEventText({ type: 'safepoint', stage: 'abc123token', done: 1 }), null, 'Codex round 2: a stage word that is not a known stage');
  assert.equal(logEventText({ type: 'progress', stage: 'chat from Someone', done: 1 }), null, 'a stage is a plain word only');
  assert.equal(logEventText({ type: 'safepoint', stage: 'render', done: 1 }), 'Safe point: Making clip videos 1');
  assert.equal(logEventText({ type: 'part', name: 'Video tools (ffmpeg)' }), 'Running: Video tools (ffmpeg)');
  assert.equal(logEventText({ type: 'part', name: 'D:\\Tools\\a.exe' }), null, 'part names come from the job\'s own list');
  assert.equal(logEventText({ type: 'end', code: 'failed' }), END_TEXT.failed);
  assert.equal(logEventText({ type: 'end', code: 'token=abc' }), null);
  assert.equal(logEventText({ type: 'raw', text: 'chat line' }), null, 'raw text has no event type');
  const tail = [];
  for (let i = 0; i < 12; i++) pushLogEvent(tail, { type: 'progress', stage: 'render', done: i, total: 20 });
  pushLogEvent(tail, { type: 'progress', stage: 'render', done: 11, total: 20 });
  assert.equal(tail.length, LOG_TAIL_LINES); assert.equal(logEventText(tail.at(-1)), 'Making clip videos: 11 of 20', 'the newest kept; a repeat skipped');
  assert.deepEqual(tail.at(-1), { v: 1, type: 'progress', stage: 'render', done: 11, total: 20 }, 'kept as a versioned event');
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
  // Codex review 9: only the distinct safe point line (printed after the record is committed) counts
  assert.deepEqual(parseSafepoint('ujwalam-safepoint {"stage":"render","done":1}'), { stage: 'render', done: 1 });
  assert.equal(parseSafepoint('ujwalam-progress {"stage":"render","done":1,"total":7}'), null, 'a progress line is not a safe point');
  assert.equal(parseSafepoint('ujwalam-safepoint {"stage":"render","done":"1"}'), null);
  assert.equal(isSafePoint({ stage: 'render', done: 1 }, full), true, 'a clip was made and its record committed');
  assert.equal(isSafePoint({ stage: 'render', done: 0 }, full), false);
  assert.equal(isSafePoint({ stage: 'gate', done: 1 }, full), false, 'no committed record behind it');
  assert.equal(isSafePoint({ stage: 'montage', done: 1 }, full), false);
  assert.equal(isSafePoint({ stage: 'long', done: 2 }, long), true, 'a batch and its manifest were saved');
  assert.equal(isSafePoint({ stage: 'render', done: 2 }, long), false);
  for (const type of ['beatdrop', 'train']) {
    const p = pauseInfo({ type });
    assert.equal(p.pausable, false); assert.match(p.reason, /can be stopped, not paused/);
    assert.equal(isSafePoint({ stage: 'render', done: 1 }, { type }), false);
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
    // task ids end in the job's own id (Codex review 10): a test names the task by its name part
    ids: (prefix) => readdirSync(path.join(dataDir, 'tasks')).filter((n) => n.startsWith(`${prefix}-`) && /-[0-9a-f]{8}\.json$/.test(n) && n.length === prefix.length + 14).map((n) => n.slice(0, -5)),
    id: (prefix) => { const [x, ...more] = s.ids(prefix); assert.ok(x && !more.length, `one task ${prefix}`); return x; },
    task: (prefix) => JSON.parse(readFileSync(path.join(dataDir, 'tasks', `${s.id(prefix)}.json`), 'utf8')),
    ctl: (prefix, op, extra = {}) => writeTaskControl(dataDir, s.id(prefix), { op, atMs: t, ...extra }),
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
    assert.equal(s.killed.length, 0, 'Codex review 9: a progress line is not a committed checkpoint');
    err.write('ujwalam-safepoint {"stage":"render","done":1}\n'); await tick();
    assert.equal(s.killed.length, 1, 'a clip and its record were saved: the whole tree is ended there');
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
    s.spawned[0].c.stderr.write('ujwalam-safepoint {"stage":"render","done":1}\n'); await tick();
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

test('D442 running task: category, parts, current step and a log tail of typed events only; a leftover request is dropped', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1));
    writeTaskControl(s.dataDir, s.id('clip-game-h-1'), { op: 'stop', atMs: s.now() - 60_000 }); // from before this launcher
    rc.feed(s.S('stopped'));
    assert.equal(s.killed.length, 0, 'an old request is not applied');
    assert.deepEqual(readdirSync(controlDir(s.dataDir)), [], 'and it is removed');
    const err = s.spawned[0].c.stderr;
    err.write('opening D:\\Clips\\game-h-1.mkv\nchat line from a viewer\ntoken=abc123 ok\nujwalam-progress {"stage":"render","done":2,"total":5,"note":"C:\\\\x"}\n'); await tick();
    const t = s.task('clip-game-h-1');
    assert.deepEqual([t.category, t.state, t.stageText, t.parts], ['clips', 'running', 'Making clip videos', ['Clip maker (Python)', 'Video tools (ffmpeg)']]);
    assert.deepEqual(t.logTail, ['Making clip videos: 2 of 5', 'Running: Clip maker (Python)', 'Running: Video tools (ffmpeg)'], 'Codex review 6: no raw stderr');
    assert.match(readFileSync(path.join(s.dataDir, 'clips', 'run-game-h-1.log'), 'utf8'), /chat line from a viewer/, 'raw lines stay in the local log only');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// ---- Codex review (second opinion on the job side) ----
test('Codex review 1: a job starts only on an outputs status at most one tick old; unknown or older starts nothing', async () => {
  const s = setup();
  try {
    const rc = s.make();
    const h1 = s.files(1); const h2 = s.files(2);
    rc.feed(s.S('live', { h: h1 })); s.advance(1000);
    rc.feed(s.S('stopped', { h: h1 }), s.now() - 6000); // the answer is older than one tick
    assert.equal(s.spawned.length, 0, 'stale status: fail closed');
    rc.feed(s.S('stopped', { h: h1 }), Number.NaN);
    assert.equal(s.spawned.length, 0, 'unknown status time: fail closed');
    rc.feed(s.S('stopped', { h: h1 }));
    assert.equal(s.spawned.length, 1, 'fresh status: it starts');
    s.record(rc, h2);
    s.advance(6000); // the child exits long after the last status
    s.spawned[0].c.emit('exit', 0);
    assert.equal(s.spawned.length, 1, 'the exit does not start the next job on an old status');
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex review 2: a job the stream interrupted waits while a recording still runs after the stream', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1));
    assert.equal(s.spawned.length, 1);
    const h9 = s.files(9);
    rc.feed(s.S('live', { h: h9, stream: 'live' })); // live and recording: the job is ended
    await tick(); await tick();
    assert.equal(s.killed.length, 1);
    rc.feed(s.S('live', { h: h9 })); // the stream ended, the recording goes on
    assert.equal(s.spawned.length, 1, 'not restarted beside the recording');
    assert.equal(s.task('clip-game-h-1').note, 'Waiting until the recording ends');
    rc.feed(s.S('stopped', { h: h9 }));
    assert.equal(s.spawned.length, 2, 'off air, not recording: it continues');
    assert.match(s.spawned[1].argv.join(' '), /game-h-1/);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex review 3: a stop or pause asked for just before a close is kept in status.json and applied at the next start', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2));
    s.ctl('clip-game-h-1', 'stop'); rc.feed(s.S('stopped'));
    assert.equal(s.status().running.stopReq, true, 'the intent is committed');
    assert.deepEqual(readdirSync(controlDir(s.dataDir)), [], 'the request goes only after the commit');
    rc.stop(); // the close comes before the child's exit
    const rc2 = s.make(); rc2.feed(s.S('stopped'));
    assert.equal(s.task('clip-game-h-1').state, 'failed');
    assert.equal(s.task('clip-game-h-1').note, 'Stopped by you');
    assert.ok(!s.status().queued.some((q) => q.name === 'game-h-1'), 'the stopped job does not come back');
    // a pause asked for on the running job, then a close before its safe point
    s.ctl('clip-game-h-2', 'resume'); rc2.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2);
    s.ctl('clip-game-h-2', 'pause'); rc2.feed(s.S('stopped'));
    assert.equal(s.status().running.pauseAt, true);
    rc2.stop();
    const rc3 = s.make(); rc3.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'it stays paused');
    assert.equal(s.task('clip-game-h-2').paused, true);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex review 7: when a job ends, the controls waiting are applied before the next job is picked', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2)); s.record(rc, s.files(3));
    s.ctl('clip-game-h-2', 'stop'); // asked between status ticks
    s.spawned[0].c.emit('exit', 0);
    assert.equal(s.spawned.length, 2);
    assert.match(s.spawned[1].argv.join(' '), /game-h-3/, 'the stopped job never started');
    assert.equal(s.task('clip-game-h-2').note, 'Stopped by you');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex review 8: a resume that comes while the pause is ending the job wins', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1));
    const c0 = s.spawned[0].c;
    c0.stderr.removeAllListeners('exit');
    s.ctl('clip-game-h-1', 'pause'); rc.feed(s.S('stopped'));
    const kill = s.killed.length;
    // the kill is in flight: the exit comes only after the resume is applied
    const origEmit = c0.emit.bind(c0); let held = null;
    c0.emit = (ev, ...a) => { if (ev === 'exit' && held === null) { held = a; return true; } return origEmit(ev, ...a); };
    c0.stderr.write('ujwalam-safepoint {"stage":"render","done":1}\n'); await tick(); await tick();
    assert.equal(s.killed.length, kill + 1);
    s.ctl('clip-game-h-1', 'resume'); rc.feed(s.S('stopped'));
    c0.emit = origEmit; c0.emit('exit', ...(held ?? [1]));
    assert.equal(s.task('clip-game-h-1').paused, false, 'the last asked state is run');
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'it runs again');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex review 10: two jobs with the same name have their own task ids; an old status gets ids', async () => {
  const s = setup();
  try {
    mkdirSync(path.join(s.dataDir, 'clips'), { recursive: true });
    const h = s.files(1);
    writeFileSync(path.join(s.dataDir, 'clips', 'status.json'), JSON.stringify({ queued: [{ type: 'full', kind: 'live', h, name: 'game-h-1' }, { type: 'long', kind: 'live', h, name: 'game-h-1' }, { type: 'review', kind: 'live', name: 'game-h-1' }] }));
    const rc = s.make(); rc.feed(s.S('stopped'));
    const ids = s.status().queued.map((q) => q.jobId);
    assert.equal(ids.length, 3); assert.ok(ids.every((x) => /^[0-9a-f]{8}$/.test(x))); assert.equal(new Set(ids).size, 3);
    assert.equal(s.ids('clip-game-h-1').length, 2, 'the full and the review job: two tasks, not one');
    s.ctl('long-game-h-1', 'stop'); rc.feed(s.S('stopped'));
    assert.equal(s.status().queued.length, 2, 'a control reaches only its own job');
    rc.stop();
    const rc2 = s.make(); rc2.feed(s.S('stopped'));
    assert.deepEqual(s.status().queued.map((q) => q.jobId), ids.filter((_, i) => i !== 1), 'ids are kept across restarts');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// ---- Codex review round 2 ----
test('Codex round 2 #1: a fresh outputs status right before each spawn; on, slow, unknown or an error: no start', async () => {
  for (const [what, fresh, starts] of [
    ['idle', async () => RC_IDLE, true],
    ['a stream started', async () => ({ sinks: [{ id: 'yt', kind: 'stream', state: 'starting' }] }), false],
    ['no sinks', async () => ({}), false],
    ['an error', async () => { throw new Error('host gone'); }, false],
  ]) {
    const s = setup();
    try {
      let slow = false;
      const rc = s.make({ freshStatus: async () => { if (slow) s.advance(1500); return fresh(); } });
      s.record(rc, s.files(1)); await tick(); await tick();
      assert.equal(s.spawned.length, starts ? 1 : 0, what);
      if (what === 'idle') {
        s.record(rc, s.files(2)); s.spawned[0].c.emit('exit', 0); slow = true;
        rc.feed(s.S('stopped')); await tick(); await tick();
        assert.equal(s.spawned.length, 1, 'an answer that took a second or more: no start');
      }
    } finally { rmSync(s.d, { recursive: true, force: true }); }
  }
});
const RC_IDLE = { sinks: [{ id: 'r-h', kind: 'record', state: 'stopped' }, { id: 'yt', kind: 'stream', state: 'stopped' }] };

test('Codex round 2 #2: a continuation waits while the recording is stopping or its state is not known', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1));
    const h9 = s.files(9);
    rc.feed(s.S('live', { h: h9, stream: 'live' })); await tick(); await tick(); // the stream ends the job
    const ran1 = () => s.spawned.slice(1).filter((x) => /game-h-1\b/.test(x.argv.join(' '))).length;
    rc.feed(s.S('stopping', { h: h9 }));
    assert.equal(ran1(), 0, 'stopping counts as busy');
    rc.feed(s.S('flushing', { h: h9 }));
    assert.equal(ran1(), 0, 'an unknown state counts as busy');
    for (const x of s.spawned.slice(1)) x.c.emit('exit', 0); // a clip job of the h9 recording, if one started
    rc.feed(s.S('stopped', { h: h9 }));
    assert.equal(ran1(), 1, 'known to be off: it continues');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex round 2 #3: a control the last launcher never read is applied to its carried-over job before any start', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2));
    s.ctl('clip-game-h-2', 'next', { nextStart: 'run' }); rc.feed(s.S('stopped'));
    s.ctl('clip-game-h-2', 'stop'); // accepted by the route; the app closes before the next poll
    rc.stop(); s.advance(10_000);
    const rc2 = s.make(); rc2.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'the stopped job did not run again');
    assert.equal(s.task('clip-game-h-2').note, 'Stopped by you');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex round 2 #4: a status that cannot be saved undoes the controls; nothing starts or is signalled until it is', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2));
    s.ctl('clip-game-h-2', 'pause'); rc.feed(s.S('stopped'));
    s.spawned[0].c.emit('exit', 0); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    const tmpPath = path.join(s.dataDir, 'clips', 'status.json.tmp');
    mkdirSync(tmpPath); // the status write fails while this folder is there
    s.ctl('clip-game-h-2', 'resume'); rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1, 'not saved: the resume is not in force');
    assert.equal(s.status().queued[0].paused, true);
    assert.equal(readdirSync(controlDir(s.dataDir)).length, 1, 'the request waits');
    rmSync(tmpPath, { recursive: true });
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 2, 'saved: it runs');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex round 2 #5: a request read again after a later one was applied is skipped (its key is kept with the job)', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2));
    s.ctl('clip-game-h-2', 'pause');
    const [pf] = readdirSync(controlDir(s.dataDir)); const pbody = readFileSync(path.join(controlDir(s.dataDir), pf), 'utf8');
    rc.feed(s.S('stopped'));
    s.advance(10); s.ctl('clip-game-h-2', 'resume'); rc.feed(s.S('stopped'));
    writeFileSync(path.join(controlDir(s.dataDir), pf), pbody); // its delete had failed: the old pause is read again
    rc.feed(s.S('stopped'));
    assert.equal(s.task('clip-game-h-2').paused, false, 'the later resume stands');
    assert.ok(s.status().queued[0].applied.length >= 2);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex round 2 #6: the exit of a job the stream ended applies the waiting controls', async () => {
  const s = setup();
  try {
    const rc = s.make();
    s.record(rc, s.files(1)); s.record(rc, s.files(2));
    rc.feed(s.S('stopped', { stream: 'live' })); // the stream starts: job 1 is ended (its exit comes later)
    s.ctl('clip-game-h-2', 'stop');
    await tick(); await tick();
    assert.equal(s.task('clip-game-h-2').note, 'Stopped by you', 'applied at the exit, before any further status tick');
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex round 2 #9: an older status: the old task row is retired when the job gets its id', async () => {
  const s = setup();
  try {
    const h = s.files(1);
    mkdirSync(path.join(s.dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(s.dataDir, 'clips', 'status.json'), JSON.stringify({ queued: [{ type: 'full', kind: 'live', h, name: 'game-h-1' }] }));
    writeTaskFile(s.dataDir, { id: 'clip-game-h-1', title: 'Clips from game-h-1', kind: 'clips', state: 'waiting', controls: ['stop'], startedAt: 1, updatedAt: 1 });
    const rc = s.make(); rc.feed(s.S('stopped'));
    assert.ok(!existsSync(path.join(s.dataDir, 'tasks', 'clip-game-h-1.json')), 'the old row is gone (the route answers 404 for it)');
    assert.equal(s.ids('clip-game-h-1').length, 1);
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
    assert.equal(peekTaskControls(d).length, 2, 'read without removing');
    const got = takeTaskControls(d);
    assert.deepEqual(got.map((r) => [r.id, r.op, r.nextStart]), [['clip-a', 'pause', undefined], ['clip-a', 'next', 'run']], 'every request, in order');
    const list = (await raw(port, { url: '/ui/api/tasks', headers: { cookie } })).body.tasks;
    assert.deepEqual(Object.fromEntries(list.map((t) => [t.id, t.category])), { 'clip-a': 'clips', 'beatdrop-b': 'reels', 'up-c': 'posting' });
  } finally { srv.close(); rmSync(d, { recursive: true, force: true }); }
});
