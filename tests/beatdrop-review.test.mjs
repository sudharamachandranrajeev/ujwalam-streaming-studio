// SPDX-License-Identifier: GPL-3.0-or-later
// BeatDrop review (BD7b, D420): the beatdrop job type (argv, queued after a full job only with the flag on and detector
// hits, moments then render, retake), retake input checks, and the review route's JSON from a synthetic render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clipRunSpec, createRecordClips, hasHits, jobStages } from '../services/studio-ui/record-clips.mjs';
import { RETAKE_FILE, createBeatdropReview, knownRuns, pieceBlocks, pieceKind, retakeProblems } from '../services/studio-ui/beatdrop-review.mjs';
import { writeSettings } from '../services/studio-ui/user-settings.mjs';

const RUNGS = [{ id: 'rec-h', canvas: 'H' }, { id: 'rec-v', canvas: 'V' }];
const st = (state, { h, v }) => ({ rungs: RUNGS, sinks: [
  { id: 'practice-h', kind: 'record', rung: 'rec-h', state, path: h },
  { id: 'practice-v', kind: 'record', rung: 'rec-v', state, path: v },
  { id: 'yt', kind: 'stream', rung: 'rec-h', state: 'stopped' }] });
const tick = () => new Promise((r) => setImmediate(r));

function setup() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-bd7b-'));
  const root = path.join(d, 'repo');
  mkdirSync(path.join(root, 'services', 'clip'), { recursive: true });
  mkdirSync(path.join(root, '.venv', 'Scripts'), { recursive: true });
  for (const f of ['clipper.py', 'moments.py']) writeFileSync(path.join(root, 'services', 'clip', f), '');
  writeFileSync(path.join(root, '.venv', 'Scripts', 'python.exe'), '');
  const rec = path.join(d, 'rec'); mkdirSync(rec);
  const h = path.join(rec, 'practice-h-1.mkv'); const v = path.join(rec, 'practice-v-1.mkv');
  writeFileSync(h, ''); writeFileSync(v, '');
  const dataDir = path.join(d, 'core'); mkdirSync(dataDir);
  const spawned = [];
  const spawnFn = (exe, argv, o) => { const c = new EventEmitter(); c.kill = () => {}; spawned.push({ exe, argv, o, c }); return c; };
  const t = Date.parse('2026-11-08T10:00:00Z');
  return { d, root, h, v, dataDir, spawned, spawnFn, now: () => t, S: (state) => st(state, { h, v }),
    run: path.join(dataDir, 'clips', 'runs', 'practice-h-1'),
    status: () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'status.json'), 'utf8')) };
}
const make = (s, extra = {}) => createRecordClips({ clipRoot: s.root, dataDir: s.dataDir, log: () => {}, spawnFn: s.spawnFn, now: s.now, beatdropFlag: () => true, ...extra });

test('beatdrop job argv: moments (with hits only when they exist), render (V only when it exists), retake', () => {
  const root = 'C:/clip'; const py = path.join(root, '.venv', 'Scripts', 'python.exe');
  const script = path.join(root, 'services', 'clip', 'clipper.py'); const mom = path.join(root, 'services', 'clip', 'moments.py');
  const out = path.join('D', 'clips', 'runs', 'h'); const hits = path.join(out, 'detector-hits.jsonl');
  const has = (l) => (p) => [py, ...l].some((x) => path.resolve(x) === path.resolve(p));
  const spec = (job, l) => clipRunSpec({ clipRoot: root, dataDir: 'D', outRoot: 'E:/clips', job: { type: 'beatdrop', h: 'C:/r/h.mkv', name: 'h', ...job }, exists: has([script, mom, 'C:/r/h.mkv', ...l]) });
  assert.deepEqual(spec({}, [hits]).spec.argv, ['-I', mom, '--recording', 'C:/r/h.mkv', '--hits', hits, '--out', path.join(out, 'moments.json')]);
  assert.equal(spec({ step: 'moments' }, []).spec.argv.includes('--hits'), false);
  assert.deepEqual(spec({ step: 'render', v: 'C:/r/v.mkv' }, ['C:/r/v.mkv']).spec.argv.slice(2),
    ['--data-dir', 'D', 'beatdrop', '--out', out, '--recording', 'C:/r/h.mkv', '--v-recording', 'C:/r/v.mkv', '--encoder', 'h264_nvenc', '--publish', 'E:/clips']);
  assert.equal(spec({ step: 'render', v: 'C:/r/v.mkv' }, []).spec.argv.includes('--v-recording'), false, 'no V file: no V flag');
  assert.deepEqual(spec({ step: 'retake', retake: 'swap', piece: 3 }, []).spec.argv.slice(-4), ['--retake', 'swap', '--piece', '3']);
  assert.deepEqual(spec({ step: 'retake', retake: 'slower-intro' }, []).spec.argv.slice(-2), ['--retake', 'slower-intro']);
  assert.equal(spec({ step: 'retake', retake: 'bogus' }, []).spec, null);
  assert.equal(spec({ step: 'retake', retake: 'swap' }, []).spec, null, 'swap needs a piece');
  assert.equal(spec({ step: 'retake', retake: 'swap', piece: 0 }, []).spec, null);
  assert.equal(clipRunSpec({ clipRoot: root, dataDir: 'D', job: { type: 'beatdrop', h: 'C:/r/h.mkv', name: 'h' }, exists: has([script, 'C:/r/h.mkv']) }).spec, null, 'no moment finder');
  assert.deepEqual(jobStages({ type: 'beatdrop' }), ['montage']);
});

test('hasHits: only a non-empty detector-hits.jsonl', () => {
  assert.equal(hasHits('D', { stat: () => ({ size: 10 }) }), true);
  assert.equal(hasHits('D', { stat: () => ({ size: 0 }) }), false);
  assert.equal(hasHits('D', { stat: () => { throw new Error('missing'); } }), false);
});

async function fullJob(s, rc, { hits }) {
  writeSettings(s.dataDir, { clips: { recording: 'after', live: 'off' } });
  rc.feed(s.S('live')); rc.feed(s.S('stopped'));
  assert.equal(s.spawned.length, 1);
  if (hits) { mkdirSync(s.run, { recursive: true }); writeFileSync(path.join(s.run, 'detector-hits.jsonl'), '{"t":1}\n'); }
  s.spawned[0].c.emit('exit', 0); await tick();
}

test('a BeatDrop job is queued after a full job only with the flag on and detector hits; moments then render', async () => {
  const s = setup();
  try {
    const rc = make(s);
    await fullJob(s, rc, { hits: true });
    assert.equal(s.spawned.length, 2, 'the moment finder starts after the clip job');
    assert.ok(s.spawned[1].argv.some((a) => a.endsWith('moments.py')));
    assert.equal(s.spawned[1].o.windowsHide, true);
    assert.equal(s.status().running.type, 'beatdrop');
    const task = JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'beatdrop-practice-h-1.json'), 'utf8'));
    assert.equal(task.title, 'BeatDrop montage from practice-h-1');
    s.spawned[1].c.emit('exit', 0); await tick();
    assert.equal(s.spawned.length, 3, 'then the render');
    assert.ok(s.spawned[2].argv.includes('beatdrop'));
    assert.ok(s.spawned[2].argv.includes('--publish'));
    assert.deepEqual(JSON.parse(readFileSync(path.join(s.run, 'beatdrop-source.json'), 'utf8')), { h: s.h, v: s.v }, 'the source is saved for retakes');
    s.spawned[2].c.emit('exit', 0); await tick();
    assert.equal(s.status().state, 'idle');
    rc.stop();
  } finally { rmSync(s.d, { recursive: true, force: true }); }
  for (const [name, flag, hits] of [['flag off', false, true], ['no hits', true, false]]) {
    const t = setup();
    try {
      const rc = make(t, { beatdropFlag: () => flag });
      await fullJob(t, rc, { hits });
      assert.equal(t.spawned.length, 1, name);
      rc.stop();
    } finally { rmSync(t.d, { recursive: true, force: true }); }
  }
  const u = setup();
  try {
    const rc = make(u, { beatdropFlag: () => { throw new Error('unreadable'); } });
    await fullJob(u, rc, { hits: true });
    assert.equal(u.spawned.length, 1, 'an unreadable flag counts as off');
    rc.stop();
  } finally { rmSync(u.d, { recursive: true, force: true }); }
});

test('a failed moment finder ends the job: no render', async () => {
  const s = setup();
  try {
    const rc = make(s);
    await fullJob(s, rc, { hits: true });
    s.spawned[1].c.emit('exit', 1); await tick();
    assert.equal(s.spawned.length, 2);
    assert.equal(JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'beatdrop-practice-h-1.json'), 'utf8')).state, 'failed');
    rc.stop();
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

// A synthetic finished run: render.json, the plan and the H video.
function fixtureRun(dataDir, name = 'run-a') {
  const dir = path.join(dataDir, 'clips', 'runs', name, 'beatdrop');
  const wd = path.join(dir, 'clips', 'B1'); mkdirSync(wd, { recursive: true });
  writeFileSync(path.join(dir, 'render.json'), JSON.stringify({ clips: [{ id: 'B1', files: [{ layout: 'beatdrop-h', file: 'beatdrop-h.mp4' }, { layout: 'beatdrop-v', file: 'beatdrop-v.mp4' }],
    summary: ['Opened slow, then 3 kills on the beat.', 'The best kill is on the drop.'], retakes: [{ op: 'another-take', seed: 7 }, { op: 'swap', piece: 3 }, { op: 'bogus' }], music: { id: 'song-1' } }] }));
  writeFileSync(path.join(wd, 'beatdrop-h.mp4'), ''); writeFileSync(path.join(wd, 'beatdrop-v.mp4'), '');
  const rec = path.join(dataDir, 'rec-h.mkv'); writeFileSync(rec, '');
  writeFileSync(path.join(dir, '..', 'beatdrop-source.json'), JSON.stringify({ h: rec, v: null }));
  writeFileSync(path.join(wd, 'beatdrop-plan.json'), JSON.stringify({ fps: 30, total: 6, pieces: [
    { part: 'cold-open', anchor: null, outStart: 0, outFrames: 60 },
    { part: 'drop', anchor: { kind: 'kill' }, outStart: 60, outFrames: 30 },
    { part: 'body', anchor: { kind: 'gunshot' }, outStart: 90, outFrames: 45 },
    { part: 'body', anchor: { kind: 'kill' }, outStart: 135, outFrames: 45 }] }));
}

test('pieceKind and pieceBlocks: kill / move / calm, seconds from frames', () => {
  assert.equal(pieceKind({ part: 'drop', anchor: null }), 'kill');
  assert.equal(pieceKind({ part: 'body', anchor: { kind: 'gunshot' } }), 'move');
  assert.equal(pieceKind({ part: 'body', anchor: null }), 'calm');
  assert.deepEqual(pieceBlocks({ fps: 30, pieces: [{ part: 'body', anchor: null, outStart: 30, outFrames: 15 }] }), { blocks: [{ n: 1, part: 'body', kind: 'calm', start: 1, length: 0.5 }], total: 1.5 });
  assert.deepEqual(pieceBlocks(null), { blocks: [], total: 0 });
});

test('the review route: the JSON shape from a render and its plan; flag off is 404; unknown run is 404', () => {
  const s = setup();
  try {
    fixtureRun(s.dataDir);
    const r = createBeatdropReview({ dataDir: s.dataDir });
    const { status, body } = r.info();
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(body).sort(), ['blocks', 'busy', 'h', 'made', 'retakes', 'run', 'runs', 'source', 'summary', 'total', 'v']);
    assert.equal(body.run, 'run-a'); assert.equal(body.made, true); assert.equal(body.busy, false);
    assert.deepEqual(body.summary, ['Opened slow, then 3 kills on the beat.', 'The best kill is on the drop.']);
    assert.deepEqual(body.retakes, ['Another take', 'Swapped clip 3'], 'the plan\'s retake objects in plain words; unknown ops left out');
    assert.deepEqual(body.blocks.map((b) => [b.n, b.part, b.kind, b.start, b.length]), [[1, 'cold-open', 'calm', 0, 2], [2, 'drop', 'kill', 2, 1], [3, 'body', 'move', 3, 1.5], [4, 'body', 'kill', 4.5, 1.5]]);
    assert.equal(body.total, 6);
    assert.equal(path.basename(body.h), 'beatdrop-h.mp4'); assert.equal(path.basename(body.v), 'beatdrop-v.mp4');
    assert.equal(r.info('run-a').status, 200);
    assert.equal(r.info('..\\x').status, 404); assert.equal(r.info('nope').status, 404);
    assert.equal(createBeatdropReview({ dataDir: s.dataDir, flagOn: () => false }).info().status, 404);
    assert.deepEqual(createBeatdropReview({ dataDir: path.join(s.d, 'none') }).info().body.runs, []);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('retake input checks: op from the list, piece a whole number in range, run from the known runs only', () => {
  const s = setup();
  try {
    fixtureRun(s.dataDir);
    assert.deepEqual(knownRuns(s.dataDir), ['run-a']);
    const runs = ['run-a'];
    assert.deepEqual(retakeProblems({ run: 'run-a', op: 'another-take' }, { runs }), []);
    assert.deepEqual(retakeProblems({ run: 'run-a', op: 'swap', piece: 4 }, { runs, pieces: 4 }), []);
    for (const b of [null, [], { run: 'run-a' }, { run: 'run-a', op: 'delete' }, { run: 'run-a', op: 'another-take', piece: 1 }, { run: 'run-a', op: 'swap' },
      { run: 'run-a', op: 'swap', piece: 0 }, { run: 'run-a', op: 'swap', piece: 5 }, { run: 'run-a', op: 'swap', piece: 1.5 }, { run: 'run-a', op: 'swap', piece: '2' },
      { run: 'other', op: 'another-take' }, { run: '../run-a', op: 'another-take' }, { op: 'another-take' }, { run: 'run-a', op: 'another-take', path: 'C:/x' }]) {
      assert.ok(retakeProblems(b, { runs, pieces: 4 }).length > 0, JSON.stringify(b));
    }
    const r = createBeatdropReview({ dataDir: s.dataDir });
    for (const b of [{ run: 'run-a', op: 'nope' }, { run: 'run-a', op: 'swap', piece: 9 }, { run: 'zzz', op: 'another-take' }]) assert.equal(r.retake(b).status, 400, JSON.stringify(b));
    assert.equal(existsSync(path.join(s.dataDir, 'clips', RETAKE_FILE)), false, 'a bad request writes nothing');
    assert.equal(r.retake({ run: 'run-a', op: 'swap', piece: 2 }).status, 200);
    assert.deepEqual({ ...JSON.parse(readFileSync(path.join(s.dataDir, 'clips', RETAKE_FILE), 'utf8')), atMs: 0 }, { run: 'run-a', op: 'swap', piece: 2, atMs: 0 });
    assert.equal(createBeatdropReview({ dataDir: s.dataDir, flagOn: () => false }).retake({ run: 'run-a', op: 'another-take' }).status, 404);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('a retake request becomes a retake job; one at a time per run; the video routes only to a known run and layout', async () => {
  const s = setup();
  try {
    fixtureRun(s.dataDir, 'practice-h-1');
    writeFileSync(path.join(s.run, 'beatdrop-source.json'), JSON.stringify({ h: s.h, v: s.v }));
    const rc = make(s);
    const opened = [];
    const r = createBeatdropReview({ dataDir: s.dataDir, openFile: (p) => { opened.push(p); return true; } });
    assert.equal(r.retake({ run: 'practice-h-1', op: 'swap', piece: 2 }).status, 200);
    rc.feed(s.S('stopped'));
    assert.equal(s.spawned.length, 1);
    assert.deepEqual(s.spawned[0].argv.slice(-4), ['--retake', 'swap', '--piece', '2']);
    assert.ok(s.spawned[0].argv.includes('--retake') && s.spawned[0].argv.includes('swap'));
    const task = JSON.parse(readFileSync(path.join(s.dataDir, 'tasks', 'beatdrop-practice-h-1.json'), 'utf8'));
    assert.equal(task.title, 'New BeatDrop take from practice-h-1');
    assert.equal(r.retake({ run: 'practice-h-1', op: 'another-take' }).status, 409, 'busy: one take at a time');
    s.spawned[0].c.emit('exit', 0); await tick();
    assert.equal(s.status().state, 'idle', 'a retake is a single step');
    assert.equal(r.play({ run: 'practice-h-1', layout: 'v' }).status, 200);
    assert.equal(path.basename(opened[0]), 'beatdrop-v.mp4');
    for (const b of [{ run: 'practice-h-1', layout: 'x' }, { run: 'other', layout: 'h' }, { run: 'practice-h-1', layout: 'h', file: 'C:/x' }]) assert.equal(r.play(b).status, 400);
    rc.stop();
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});

test('Codex BD7b: a waiting retake is never written over; a deleted recording turns retakes off', () => {
  const s = setup();
  try {
    fixtureRun(s.dataDir);
    const r = createBeatdropReview({ dataDir: s.dataDir });
    assert.equal(r.info().body.source, true);
    assert.equal(r.retake({ run: 'run-a', op: 'another-take' }).status, 200);
    const first = readFileSync(path.join(s.dataDir, 'clips', RETAKE_FILE), 'utf8');
    const again = r.retake({ run: 'run-a', op: 'slower-intro' });
    assert.equal(again.status, 409, 'the first request is still waiting for the queue');
    assert.equal(readFileSync(path.join(s.dataDir, 'clips', RETAKE_FILE), 'utf8'), first, 'and it is kept as it was');
    rmSync(path.join(s.dataDir, 'clips', RETAKE_FILE));
    rmSync(path.join(s.dataDir, 'rec-h.mkv')); // Delete clipped recordings removed it
    assert.equal(r.info().body.source, false);
    const gone = r.retake({ run: 'run-a', op: 'another-take' });
    assert.equal(gone.status, 409); assert.equal(gone.body.error, 'no-source');
    assert.equal(existsSync(path.join(s.dataDir, 'clips', RETAKE_FILE)), false);
  } finally { rmSync(s.d, { recursive: true, force: true }); }
});
