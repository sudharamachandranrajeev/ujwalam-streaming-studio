// SPDX-License-Identifier: GPL-3.0-or-later
// D403 Delete clipped recordings (flag delete-processed-recordings): deleted only when every condition holds;
// refused while live or recording, with a job pending, for an unprocessed recording, for a session kept for labelling,
// for a file swapped mid-check, for a path outside the recordings folder, and for a failed job. Temp folders only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { safeRoot } from './helpers/data-root-guard.mjs';
import { safeDeleteFile } from '../services/common/safe-delete.mjs';
import {
  BACKFILL_LOG, CLEANUP_FLAG, DELETED_RECORDINGS_LOG, appendJobRecord, backfillVerdict, dryRun, fileIdentity, planBackfill, recName, vNameOf, cleanupPlan, readKeepList, runRecordingCleanup, setKeep,
} from '../services/studio-ui/recording-cleanup.mjs';
import { loadDefinitions, DEFAULT_FLAGS_FILE } from '../services/flags/index.mjs';

const tmp = [];
const mk = () => { const d = safeRoot(mkdtempSync(path.join(os.tmpdir(), 'ujw-reccl-'))); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const OFF_AIR = { sinks: [{ id: 'rec', kind: 'record', state: 'stopped' }, { id: 'yt', kind: 'stream', state: 'stopped' }] };
const T = Date.parse('2026-11-20T10:00:00Z');

function fixture({ v = true } = {}) {
  const dataDir = mk(); const folder = mk();
  const h = path.join(folder, '2026-11-18 20-00-00 H.mkv'); writeFileSync(h, Buffer.alloc(4096, 1));
  const vf = v ? path.join(folder, '2026-11-18 20-00-00 V.mkv') : null; if (vf) writeFileSync(vf, Buffer.alloc(2048, 2));
  const job = (over = {}) => appendJobRecord(dataDir, { h, v: vf, type: 'review', kind: 'live', name: '2026-11-18 20-00-00 H', result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00.000Z', ...over });
  const run = (over = {}) => runRecordingCleanup({ dataDir, folder, flagOn: true, status: OFF_AIR, state: {}, nowMs: T, ...over });
  return { dataDir, folder, h, vf, job, run };
}

describe('recording cleanup (D403)', () => {
  test('the flag is ON by default, labelled in plain words', () => {
    const f = loadDefinitions(DEFAULT_FLAGS_FILE).find((d) => d.id === CLEANUP_FLAG);
    assert.equal(f.default, true); assert.equal(f.label, 'Delete clipped recordings'); assert.equal(f.page, 'clips');
  });

  test('every condition holds: H and V deleted, logged with size and file id, one task line per batch', async () => {
    const x = fixture(); x.job();
    const tasks = [];
    const r = await x.run({ writeTask: (_d, t) => tasks.push(t) });
    assert.equal(r.ran, true);
    assert.deepEqual(r.deleted.map((d) => path.basename(d.file)).sort(), ['2026-11-18 20-00-00 H.mkv', '2026-11-18 20-00-00 V.mkv']);
    assert.ok(!existsSync(x.h) && !existsSync(x.vf));
    const log = readFileSync(path.join(x.dataDir, 'clips', DELETED_RECORDINGS_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(log.length, 2);
    for (const e of log) { assert.ok(e.size > 0); assert.match(e.fileId, /^\d+:\d+$/); assert.equal(e.reason, 'clipped-and-reviewed'); assert.equal(e.at, new Date(T).toISOString()); }
    assert.equal(tasks.length, 1); assert.match(tasks[0].title, /^Deleted 2 recordings, freed [\d.]+ GB$/);
    // A second pass finds nothing more to do.
    assert.equal((await x.run()).deleted.length, 0);
  });

  test('refused while live or recording, with an unknown state, or with the flag off', async () => {
    const x = fixture(); x.job();
    for (const [status, why] of [
      [{ sinks: [{ id: 'yt', kind: 'stream', state: 'live' }] }, 'live-or-recording'],
      [{ sinks: [{ id: 'rec', kind: 'record', state: 'live' }] }, 'live-or-recording'],
      [{ sinks: [{ id: 'yt', kind: 'stream', state: 'starting' }] }, 'live-or-recording'],
      [null, 'state-unknown'],
    ]) { const r = await x.run({ status }); assert.equal(r.refused, why); assert.equal(r.deleted.length, 0); }
    assert.equal((await x.run({ flagOn: false })).refused, 'flag-off');
    assert.ok(existsSync(x.h) && existsSync(x.vf));
  });

  test('a clip job running, queued or waiting for its answer keeps the recording', async () => {
    const x = fixture(); x.job();
    for (const state of [{ running: { h: x.h } }, { queued: [{ h: x.h, v: x.vf }] }, { asks: [{ h: x.h }] }, { queued: [{ v: x.vf }] }]) {
      const r = await x.run({ state });
      assert.deepEqual(r.kept.map((k) => k.reason), ['job-pending']); assert.equal(r.deleted.length, 0);
    }
    assert.ok(existsSync(x.h));
  });

  test('a recording with no clip job (unprocessed) is never touched; a failed or reel-less last job keeps it', async () => {
    const x = fixture();
    let r = await x.run();
    assert.deepEqual([r.deleted.length, r.kept.length], [0, 0]);
    x.job({ result: 'failed', code: 1 });
    r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['job-failed']);
    x.job({ at: '2026-11-19T01:00:00.000Z', reelsNotMade: 'the reel step did not finish; see the log' });
    r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['reels-not-made']);
    // A full run done and a later review that failed: the review's latest result counts.
    const y = fixture(); y.job({ type: 'full' }); y.job({ type: 'review', result: 'failed', code: 2, at: '2026-11-19T00:00:00.000Z' });
    r = await y.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['job-failed']);
    assert.ok(existsSync(x.h) && existsSync(y.h));
  });

  test('D406: the recording waits for its long highlights video; a failed one keeps it; once made it goes', async () => {
    const x = fixture();
    x.job({ longNotMade: 'the long video step did not finish; see the log' });
    let r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['long-video-not-made']); assert.equal(r.deleted.length, 0);
    x.job({ at: '2026-11-19T01:00:00.000Z', longNotMade: 'part 1 did not render: boom' });
    r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['long-video-not-made']);
    assert.ok(existsSync(x.h) && existsSync(x.vf));
    // H only (no V): the long video still decides (it never depends on V)
    const y = fixture({ v: false }); y.job({ longNotMade: 'failed' });
    r = await y.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['long-video-not-made']);
    x.job({ at: '2026-11-19T02:00:00.000Z', longNotMade: null });
    r = await x.run(); assert.equal(r.deleted.length, 2, 'made: the latest job decides');
    // the field is strict: anything but a string or null is no proof; older records without it still count
    assert.equal(cleanupPlan({ dataDir: y.dataDir, records: [{ h: y.h, hId: fileIdentity(y.h), v: null, vId: null, type: 'full', kind: null, name: 'n', result: 'done', code: 0, reelsNotMade: null, longNotMade: 3, at: '2026-11-18T22:00:00Z' }] }).length, 0);
  });

  test('Keep for labelling: a ticked session is kept; untick and it goes; an unreadable list keeps everything', async () => {
    const x = fixture(); x.job();
    assert.deepEqual(setKeep(x.dataDir, '2026-11-18 20-00-00 H', true), ['2026-11-18 20-00-00 h']);
    let r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['kept-for-labelling']);
    assert.equal(cleanupPlan({ dataDir: x.dataDir })[0].reason, 'kept-for-labelling');
    writeFileSync(path.join(x.dataDir, 'clips', 'keep-for-labelling.json'), '{ broken');
    assert.equal(readKeepList(x.dataDir).all, true);
    r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['kept-for-labelling']);
    assert.throws(() => setKeep(x.dataDir, 'a', true), (e) => e.code === 'keep-unreadable');
    unlinkSync(path.join(x.dataDir, 'clips', 'keep-for-labelling.json'));
    setKeep(x.dataDir, '2026-11-18 20-00-00 H', false);
    r = await x.run(); assert.equal(r.deleted.length, 2);
    assert.throws(() => setKeep(x.dataDir, '..\\x', true), (e) => e.code === 'bad-name');
  });

  test('a path outside the recordings folder is refused (also through a junction), and nothing outside is touched', async () => {
    const x = fixture({ v: false });
    const elsewhere = mk(); const out = path.join(elsewhere, 'other H.mkv'); writeFileSync(out, 'x');
    appendJobRecord(x.dataDir, { h: out, v: null, type: 'full', kind: 'recording', name: 'other H', result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00.000Z' });
    let r = await x.run();
    assert.deepEqual(r.kept.map((k) => k.reason), ['not-in-folder']); assert.ok(existsSync(out));
    // a junction inside the folder that leads out
    const j = path.join(x.folder, 'link'); let made = true;
    try { (await import('node:fs')).symlinkSync(elsewhere, j, 'junction'); } catch { made = false; }
    if (made) {
      const via = path.join(j, 'other H.mkv');
      appendJobRecord(x.dataDir, { h: via, v: null, type: 'full', kind: 'recording', name: 'other H', result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00.000Z' });
      r = await x.run();
      assert.ok(r.kept.some((k) => k.file === via && ['outside-folder', 'link'].includes(k.reason)), JSON.stringify(r.kept));
      assert.ok(existsSync(out));
    }
  });

  test('a file swapped mid-check is kept (identity checked right before the delete)', async () => {
    const x = fixture({ v: false }); x.job();
    const swap = (o) => safeDeleteFile({ ...o, beforeUnlink: async () => { unlinkSync(x.h); writeFileSync(x.h, Buffer.alloc(9000, 7)); } });
    const r = await x.run({ deleteImpl: swap });
    assert.deepEqual(r.kept.map((k) => k.reason), ['file-changed']); assert.equal(r.deleted.length, 0);
    assert.equal(readFileSync(x.h).length, 9000, 'the new file is still there');
    // swapped after the move into the holding folder: put back, not deleted
    const y = fixture({ v: false }); y.job();
    const swap2 = (o) => safeDeleteFile({ ...o, beforeDelete: async (held) => { unlinkSync(held); writeFileSync(held, 'other'); } });
    const r2 = await y.run({ deleteImpl: swap2 });
    assert.deepEqual(r2.kept.map((k) => k.reason), ['file-changed']); assert.ok(existsSync(y.h));
  });

  test('a file held open by another program without delete sharing is kept (file-in-use)', async () => {
    const x = fixture({ v: false }); x.job();
    // Simulated: Node cannot open a file without delete sharing, so the rename refusal is injected.
    const r = await x.run({ deleteImpl: async () => ({ deleted: false, reason: 'file-in-use' }) });
    assert.deepEqual(r.kept.map((k) => k.reason), ['file-in-use']); assert.ok(existsSync(x.h));
  });

  test('Windows: a real program holding the file open (no delete sharing) -> file-in-use, file kept', { skip: process.platform !== 'win32' }, async () => {
    const x = fixture({ v: false }); x.job();
    const { spawn } = await import('node:child_process');
    const ready = path.join(x.dataDir, 'held.txt');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f=[IO.File]::Open('${x.h.replace(/'/g, "''")}','Open','Read','Read'); Set-Content -LiteralPath '${ready.replace(/'/g, "''")}' 1; Start-Sleep -Seconds 20; $f.Close()`],
    { windowsHide: true, stdio: 'ignore' });
    try {
      for (let k = 0; k < 150 && !existsSync(ready); k++) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(ready), 'the holder started');
      const r = await x.run();
      assert.deepEqual(r.kept.map((k) => k.reason), ['file-in-use']); assert.ok(existsSync(x.h));
    } finally { ps.kill(); }
  });

  test('the folder must exist; a missing V file is skipped and H still goes', async () => {
    const x = fixture(); x.job(); unlinkSync(x.vf);
    assert.equal((await x.run({ folder: path.join(x.folder, 'nope') })).refused, 'no-recordings-folder');
    const r = await x.run(); assert.deepEqual(r.deleted.map((d) => d.file), [x.h]);
  });
});

describe('recordings with no clip job: their clips decide (user 2026-11-20: "Delete if clips exist")', () => {
  // Fixtures in the real layout (names only): alpha-<ts>.mkv (H), alpha-v-<ts>.mkv (V), a replay/ subfolder; clips in
  // <clips>/<YYYY-MM-DD>/<game>_<kind>_<YYYYMMDD-HHMMSS>_..._v.mp4.
  const local = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
  const rec = (folder, name, endMs, n = 3000) => { const f = path.join(folder, name); writeFileSync(f, Buffer.alloc(n, 5)); utimesSync(f, endMs / 1000, endMs / 1000); return f; };
  const clip = (root, day, stamp) => { mkdirSync(path.join(root, day), { recursive: true }); writeFileSync(path.join(root, day, `codm_short_${stamp}_kills-3_01_v.mp4`), 'clip'); };
  const runFiles = (dataDir, stem, { recording = `${stem}.mkv`, ok = false, createdAt = new Date(2026, 10, 6).toISOString(), published = null } = {}) => {
    const run = path.join(dataDir, 'clips', 'runs', stem); mkdirSync(run, { recursive: true });
    writeFileSync(path.join(run, 'render.json'), JSON.stringify({ tool: 'clipper', recording, clips: [], createdAt }));
    writeFileSync(path.join(run, 'report.json'), JSON.stringify({ results: [{ id: 'c01', file: 'stream-v.mp4', ok }] }));
    if (published) writeFileSync(path.join(run, 'published.json'), JSON.stringify({ files: published.map((file) => ({ file })) }));
    else rmSync(path.join(run, 'published.json'), { force: true });
  };
  const verdicts = (dataDir) => readFileSync(path.join(dataDir, 'clips', BACKFILL_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((l) => [path.basename(l.file), l.decision, l.reason]);
  function world() {
    const dataDir = mk(); const folder = mk(); const clipsRoot = mk();
    const f = {
      h: rec(folder, 'alpha-20261101-200000.mkv', local(2026, 11, 1, 22, 0), 5000), v: rec(folder, 'alpha-v-20261101-200000.mkv', local(2026, 11, 1, 22, 0), 4000),
      noClips: rec(folder, 'alpha-20261102-200000.mkv', local(2026, 11, 2, 22, 0)), noClipsV: rec(folder, 'alpha-v-20261102-200000.mkv', local(2026, 11, 2, 22, 0)),
      vOnly: rec(folder, 'alpha-v-20261103-200000.mkv', local(2026, 11, 3, 22, 0)),
      kept: rec(folder, 'alpha-20261104-200000.mkv', local(2026, 11, 4, 22, 0)), keptV: rec(folder, 'alpha-v-20261104-200000.mkv', local(2026, 11, 4, 22, 0)),
      old: rec(folder, 'practice-h-1.mkv', local(2026, 11, 5, 22, 0)), // an older record-clips run (run folder rule)
    };
    mkdirSync(path.join(folder, 'replay'), { recursive: true }); f.replay = path.join(folder, 'replay', 'replay-h-20261101-201000.mkv'); writeFileSync(f.replay, 'r');
    clip(clipsRoot, '2026-11-01', '20261101-203000'); clip(clipsRoot, '2026-11-01', '20261101-213000');
    clip(clipsRoot, '2026-11-02', '20261102-233000'); // after that recording ended: outside its window
    clip(clipsRoot, '2026-11-04', '20261104-201500');
    clip(clipsRoot, '2026-11-05', '20261105-120000'); // made by the practice run; outside every alpha window
    runFiles(dataDir, 'practice-h-1', { ok: true, published: ['2026-11-05/codm_short_20261105-120000_kills-3_01_v.mp4'] });
    return { dataDir, folder, clipsDirOf: () => clipsRoot, f };
  }

  test('names: H and V of a session; clip times; V name of an H', () => {
    assert.deepEqual(recName('alpha-v-20261101-200000.mkv'), { prefix: 'alpha', v: true, stamp: '20261101-200000' });
    assert.equal(vNameOf('alpha-20261101-200000.mkv'), 'alpha-v-20261101-200000.mkv');
    assert.equal(vNameOf('practice.mkv'), 'practice-v.mkv');
  });

  test('dry run lists what would go and what stays, with sizes and reasons, and changes nothing', () => {
    const w = world(); setKeep(w.dataDir, 'alpha-20261104-200000', true);
    const before = readdirSync(w.dataDir, { recursive: true }).sort();
    const rows = dryRun({ dataDir: w.dataDir, folder: w.folder, clipsDirOf: w.clipsDirOf, nowMs: T });
    assert.deepEqual(rows.map((r) => [path.basename(r.file), r.action]), [
      ['alpha-20261101-200000.mkv', 'delete'], ['alpha-20261102-200000.mkv', 'keep'], ['alpha-20261104-200000.mkv', 'keep'],
      ['alpha-v-20261101-200000.mkv', 'delete'], ['alpha-v-20261102-200000.mkv', 'keep'], ['alpha-v-20261103-200000.mkv', 'keep'],
      ['alpha-v-20261104-200000.mkv', 'keep'], ['practice-h-1.mkv', 'delete']]);
    assert.equal(rows.find((r) => r.file === w.f.h).size, 5000);
    assert.equal(rows.find((r) => r.file === w.f.vOnly).reason, 'v-without-h');
    assert.equal(rows.find((r) => r.file === w.f.kept).reason, 'kept-for-labelling');
    assert.equal(rows.find((r) => r.file === w.f.noClips).reason, 'no-clips-in-its-time-window');
    assert.ok(!rows.some((r) => r.file.includes('replay')), 'the replay folder is not looked at');
    assert.deepEqual(readdirSync(w.dataDir, { recursive: true }).sort(), before, 'nothing written');
    for (const x of Object.values(w.f)) assert.ok(existsSync(x));
  });

  test('the first pass proves by clips in the window (or an old run), deletes H and V, keeps the rest, logs every verdict', async () => {
    const w = world(); setKeep(w.dataDir, 'alpha-20261104-200000', true);
    const tasks = [];
    const r = await runRecordingCleanup({ dataDir: w.dataDir, folder: w.folder, flagOn: true, status: OFF_AIR, nowMs: T, clipsDirOf: w.clipsDirOf, writeTask: (_d, t) => tasks.push(t) });
    assert.deepEqual(r.deleted.map((d) => path.basename(d.file)).sort(), ['alpha-20261101-200000.mkv', 'alpha-v-20261101-200000.mkv', 'practice-h-1.mkv']);
    assert.deepEqual(verdicts(w.dataDir), [
      ['alpha-20261101-200000.mkv', 'proven', 'clips-exist (2 clips in its time window)'], ['alpha-v-20261101-200000.mkv', 'proven', 'clips-exist (2 clips in its time window) (V of a proven H)'],
      ['alpha-20261102-200000.mkv', 'kept', 'no-clips-in-its-time-window'], ['alpha-v-20261102-200000.mkv', 'kept', 'its H is kept (no-clips-in-its-time-window)'],
      ['alpha-20261104-200000.mkv', 'proven', 'clips-exist (1 clip in its time window)'], ['alpha-v-20261104-200000.mkv', 'proven', 'clips-exist (1 clip in its time window) (V of a proven H)'],
      ['practice-h-1.mkv', 'proven', 'clips-exist'], ['alpha-v-20261103-200000.mkv', 'kept', 'v-without-h']]);
    assert.match(tasks[0].title, /^Deleted 3 recordings, freed [\d.]+ GB$/);
    for (const x of [w.f.noClips, w.f.noClipsV, w.f.vOnly, w.f.kept, w.f.keptV, w.f.replay]) assert.ok(existsSync(x));
    // a second pass adds no verdict lines for what it kept again
    await runRecordingCleanup({ dataDir: w.dataDir, folder: w.folder, flagOn: true, status: OFF_AIR, nowMs: T, clipsDirOf: w.clipsDirOf });
    assert.equal(verdicts(w.dataDir).length, 8);
  });

  test('from now on: a session still being written, just ended, or while the live clipper runs is kept; once settled it goes', async () => {
    const w = world();
    const end = Date.now() - 60_000; utimesSync(w.f.h, end / 1000, end / 1000); // "just ended" (inside the settle time)
    const opts = { dataDir: w.dataDir, folder: w.folder, flagOn: true, clipsDirOf: w.clipsDirOf };
    const writing = { sinks: [{ id: 'rec', kind: 'record', state: 'stopped', path: w.f.old }] };
    let r = await runRecordingCleanup({ ...opts, status: writing, nowMs: Date.now(), clipperBusy: true });
    assert.equal(r.deleted.length, 0, 'clipper running: nothing proven');
    r = await runRecordingCleanup({ ...opts, status: writing, nowMs: Date.now() });
    assert.ok(existsSync(w.f.h) && existsSync(w.f.v), 'just ended: kept');
    assert.ok(existsSync(w.f.old), 'the file an output names: kept');
    const plan = planBackfill({ dataDir: w.dataDir, folder: w.folder, clipsDirOf: w.clipsDirOf, nowMs: Date.now(), writing: [w.f.old] });
    assert.ok(plan.verdicts.some((v) => v.file === w.f.old && v.reason === 'being-recorded'));
    assert.ok(plan.verdicts.some((v) => v.file === w.f.h && v.reason === 'just-recorded'));
    // settled: the window is [name time, last write], so the clips of 1 Nov still count only if the end covers them
    utimesSync(w.f.h, local(2026, 11, 1, 22, 0) / 1000, local(2026, 11, 1, 22, 0) / 1000);
    r = await runRecordingCleanup({ ...opts, status: OFF_AIR, nowMs: Date.now() });
    assert.ok(r.deleted.some((d) => d.file === w.f.h));
  });

  test('a run folder that names another file proves nothing', () => {
    const w = world();
    runFiles(w.dataDir, 'practice-h-1', { recording: 'other.mkv', ok: true });
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: w.f.old, mtimeMs: Date.now(), clipsDirOf: w.clipsDirOf }).reason, 'run-is-for-another-file');
  });

  test('D406 backfill: with the long video on, a proven recording waits for its long video (no record written, checked again each pass); a failed one keeps it', async () => {
    const w = world(); setKeep(w.dataDir, 'alpha-20261104-200000', true);
    const opts = { dataDir: w.dataDir, folder: w.folder, flagOn: true, status: OFF_AIR, nowMs: T, clipsDirOf: w.clipsDirOf, longOn: true };
    const plan = planBackfill({ ...opts });
    assert.equal(plan.records.length, 0, 'nothing proven while no long video exists');
    assert.equal(plan.verdicts.find((v) => v.file === w.f.h).reason, 'long-video-not-made (no long video yet)');
    let r = await runRecordingCleanup(opts);
    assert.equal(r.deleted.length, 0);
    const long = (stem, status) => { const d = path.join(w.dataDir, 'clips', 'runs', stem, 'long'); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'long.json'), JSON.stringify({ status })); };
    long('alpha-20261101-200000', 'failed'); long('practice-h-1', 'skipped');
    assert.equal(planBackfill({ ...opts }).verdicts.find((v) => v.file === w.f.h).reason, 'long-video-not-made (the long video failed)');
    r = await runRecordingCleanup(opts);
    assert.deepEqual(r.deleted.map((d) => path.basename(d.file)), ['practice-h-1.mkv'], 'too short (skipped) counts as done');
    assert.ok(existsSync(w.f.h) && existsSync(w.f.v), 'a failed long video keeps the recording');
    long('alpha-20261101-200000', 'made');
    r = await runRecordingCleanup(opts);
    assert.deepEqual(r.deleted.map((d) => path.basename(d.file)).sort(), ['alpha-20261101-200000.mkv', 'alpha-v-20261101-200000.mkv']);
    // the flag off: the long video plays no part (the D403 behaviour)
    const w2 = world();
    assert.equal(planBackfill({ dataDir: w2.dataDir, folder: w2.folder, clipsDirOf: w2.clipsDirOf, nowMs: T, longOn: false }).verdicts.find((v) => v.file === w2.f.h).decision, 'proven');
  });

  test('the command line dry run prints and changes nothing', async () => {
    const w = world();
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, [path.resolve('services/studio-ui/recording-cleanup.mjs'), '--dry-run', '--data', w.dataDir, '--recordings', w.folder], { encoding: 'utf8', windowsHide: true });
    assert.match(out, /would delete \d+ file\(s\)/); assert.match(out, /Nothing was changed/);
    assert.ok(!existsSync(path.join(w.dataDir, 'clips', BACKFILL_LOG)));
  });
  test('Codex round 2: an old run made before the file now at that name proves nothing; published paths must be clips inside the clips folder', () => {
    const w = world();
    runFiles(w.dataDir, 'practice-h-1', { ok: true, createdAt: new Date(2026, 10, 4).toISOString() }); // before the file's last write (5 Nov)
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: w.f.old, mtimeMs: new Date(2026, 10, 5, 22).getTime(), clipsDirOf: w.clipsDirOf }).reason, 'run-older-than-file');
    const outside = mk(); writeFileSync(path.join(outside, 'x.mp4'), 'x');
    const root = w.clipsDirOf();
    mkdirSync(path.join(root, 'adir'), { recursive: true });
    runFiles(w.dataDir, 'practice-h-1', { ok: false, published: ['../' + path.basename(outside) + '/x.mp4', path.join(outside, 'x.mp4'), 'adir', '2026-11-01/missing.mp4'] });
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: w.f.old, mtimeMs: new Date(2026, 10, 5, 22).getTime(), clipsDirOf: w.clipsDirOf }).reason, 'no-clips');
    runFiles(w.dataDir, 'practice-h-1', { ok: false, published: ['2026-11-01/codm_short_20261101-203000_kills-3_01_v.mp4'] });
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: w.f.old, mtimeMs: new Date(2026, 10, 5, 22).getTime(), clipsDirOf: w.clipsDirOf }).reason, 'clips-exist');
  });
  test('Codex round 3: a clip belongs to one recording only; equal starts are ambiguous; report ok alone or a run made before the last write proves nothing', () => {
    const w = world();
    const mt = (h, m) => new Date(2026, 10, 10, h, m).getTime();
    const A = path.join(w.folder, 'alpha-20261110-200000.mkv'); const B = path.join(w.folder, 'alpha-20261110-210000.mkv');
    const wins = [{ file: A, start: mt(20, 0), end: mt(23, 0) }, { file: B, start: mt(21, 0), end: mt(22, 0) }];
    // a clip at 21:30 is in both windows: it belongs to B (latest start), so A is not proven by it
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: A, mtimeMs: mt(23, 0), clipsDirOf: w.clipsDirOf, times: [mt(21, 30)], windows: wins }).proven, false);
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: B, mtimeMs: mt(22, 0), clipsDirOf: w.clipsDirOf, times: [mt(21, 30)], windows: wins }).proven, true);
    const C = path.join(w.folder, 'other-20261110-200000.mkv');
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: A, mtimeMs: mt(23, 0), clipsDirOf: w.clipsDirOf, times: [mt(20, 30)], windows: [...wins, { file: C, start: mt(20, 0), end: mt(23, 0) }] }).reason, 'ambiguous-window');
    const old = new Date(2026, 10, 5, 22).getTime();
    runFiles(w.dataDir, 'practice-h-1', { ok: true }); // report ok, no clip of the run left
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: w.f.old, mtimeMs: old, clipsDirOf: w.clipsDirOf }).reason, 'no-clips');
    runFiles(w.dataDir, 'practice-h-1', { ok: true, createdAt: new Date(old - 60 * 1000).toISOString(), published: ['2026-11-05/codm_short_20261105-120000_kills-3_01_v.mp4'] });
    assert.equal(backfillVerdict({ dataDir: w.dataDir, file: w.f.old, mtimeMs: old, clipsDirOf: w.clipsDirOf }).reason, 'run-older-than-file', 'no slack');
  });
});

describe('Codex round 2: identity from the job start, identity required, the gate right before the rename', () => {
  test('a file replaced while its job ran gives no record; a job record keeps the start identity', () => {
    const x = fixture({ v: false });
    const start = fileIdentity(x.h);
    writeFileSync(x.h, Buffer.alloc(5000, 3));
    appendJobRecord(x.dataDir, { h: x.h, hId: start, v: null, type: 'full', kind: 'recording', name: 'n', result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00.000Z' });
    assert.ok(!existsSync(path.join(x.dataDir, 'clips', 'jobs.jsonl')));
    appendJobRecord(x.dataDir, { h: x.h, hId: null, v: null, type: 'full', kind: 'recording', name: 'n', result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00.000Z' });
    assert.ok(!existsSync(path.join(x.dataDir, 'clips', 'jobs.jsonl')), 'no start identity: no record');
  });

  test('safe delete refuses a missing required identity; the gate (state and Keep for labelling) runs right before the rename', async () => {
    const x = fixture({ v: false }); x.job();
    assert.equal((await safeDeleteFile({ file: x.h, folder: x.folder, hash: false, expectId: null, requireId: true })).reason, 'no-identity');
    // ticked Keep for labelling after the plan, before the rename
    let r = await x.run({ deleteImpl: (o) => safeDeleteFile({ ...o, beforeUnlink: async () => { setKeep(x.dataDir, '2026-11-18 20-00-00 H', true); } }) });
    assert.deepEqual(r.kept.map((k) => k.reason), ['kept-for-labelling']); assert.ok(existsSync(x.h));
    setKeep(x.dataDir, '2026-11-18 20-00-00 H', false);
    // a recording starts after the plan, before the rename
    let live = false;
    r = await x.run({ recheck: () => ({ status: live ? { sinks: [{ id: 'rec', kind: 'record', state: 'live' }] } : OFF_AIR, state: {} }),
      deleteImpl: (o) => safeDeleteFile({ ...o, beforeUnlink: async () => { live = true; } }) });
    assert.equal(r.stopped, 'live-or-recording'); assert.ok(existsSync(x.h));
    // an async recheck is not trusted
    r = await x.run({ recheck: async () => ({ status: OFF_AIR, state: {} }) });
    assert.equal(r.stopped, 'state-unknown'); assert.ok(existsSync(x.h));
  });
});
describe('Codex round 1: identity, strict lines, re-checks mid-batch, V only with the deciding jobs', () => {
  test('a file replaced at the same path after it was clipped is kept; a forged or loose line proves nothing', async () => {
    const x = fixture({ v: false }); x.job();
    writeFileSync(x.h, Buffer.alloc(4096, 9)); // same name and size, new content and time
    const t = new Date(Date.now() + 5000); (await import('node:fs')).utimesSync(x.h, t, t);
    let r = await x.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['file-changed-since-clipped']); assert.ok(existsSync(x.h));
    const y = fixture({ v: false });
    const forged = [
      { h: y.h, v: null, type: 'full', name: 'n', kind: null, result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00Z' }, // no identity
      { h: y.h, hId: { size: '4096', dev: '1', ino: '2', mtimeNs: '3' }, v: null, vId: null, type: 'full', name: 'n', kind: null, result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00Z', extra: 1 },
      { h: 'relative.mkv', hId: { size: '1', dev: '1', ino: '2', mtimeNs: '3' }, v: null, vId: null, type: 'full', name: 'n', kind: null, result: 'done', code: 0, reelsNotMade: null, at: '2026-11-18T22:00:00Z' },
    ];
    mkdirSync(path.join(y.dataDir, 'clips'), { recursive: true });
    writeFileSync(path.join(y.dataDir, 'clips', 'jobs.jsonl'), `${forged.map((l) => JSON.stringify(l)).join('\n')}\n`);
    r = await y.run(); assert.equal(r.deleted.length, 0); assert.ok(existsSync(y.h));
    // a well-formed line with a made-up identity is not the file there now
    const okShape = { ...forged[1] }; delete okShape.extra;
    writeFileSync(path.join(y.dataDir, 'clips', 'jobs.jsonl'), `${JSON.stringify(okShape)}\n`);
    r = await y.run(); assert.deepEqual(r.kept.map((k) => k.reason), ['file-changed-since-clipped']); assert.ok(existsSync(y.h));
  });

  test('a recording or a clip job that starts mid-batch stops it; later files are kept', async () => {
    for (const [later, why] of [[{ status: { sinks: [{ id: 'rec', kind: 'record', state: 'live' }] }, state: {} }, 'live-or-recording'],
      [{ status: OFF_AIR, state: { queued: [{ h: 'C:/r/new.mkv', name: 'new' }] } }, 'jobs-changed']]) {
      const x = fixture(); x.job();
      let calls = 0;
      const r = await x.run({ recheck: () => (++calls === 1 ? { status: OFF_AIR, state: {} } : later) });
      assert.equal(r.deleted.length, 1, why); assert.equal(r.stopped, why);
      assert.deepEqual(r.kept.map((k) => k.reason), [why]);
      assert.ok(existsSync(x.vf), 'the V file was kept');
    }
  });

  test('a failed H+V run then a finished H-only run deletes H only; V needs every deciding job to list it', async () => {
    const x = fixture(); x.job({ type: 'full', result: 'failed', code: 1 });
    x.job({ type: 'full', v: null, at: '2026-11-19T01:00:00.000Z' });
    let r = await x.run();
    assert.deepEqual(r.deleted.map((d) => d.file), [x.h]); assert.ok(existsSync(x.vf));
    const y = fixture(); y.job({ type: 'full' }); y.job({ type: 'review', v: null, at: '2026-11-19T01:00:00.000Z' });
    r = await y.run();
    assert.deepEqual(r.deleted.map((d) => d.file), [y.h]); assert.ok(existsSync(y.vf));
    assert.ok(r.kept.some((k) => k.reason === 'v-not-in-every-latest-job'));
  });
});