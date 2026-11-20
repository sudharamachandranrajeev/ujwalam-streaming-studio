// SPDX-License-Identifier: GPL-3.0-or-later
// D403 Delete clipped recordings (flag delete-processed-recordings): deleted only when every condition holds;
// refused while live or recording, with a job pending, for an unprocessed recording, for a session kept for labelling,
// for a file swapped mid-check, for a path outside the recordings folder, and for a failed job. Temp folders only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { safeRoot } from './helpers/data-root-guard.mjs';
import { safeDeleteFile } from '../services/common/safe-delete.mjs';
import {
  BACKFILL_LOG, CLEANUP_FLAG, DELETED_RECORDINGS_LOG, appendJobRecord, backfillJobRecords, cleanupPlan, readKeepList, runRecordingCleanup, setKeep,
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

describe('one-time backfill for recordings clipped before jobs.jsonl (coordinator 2026-11-20)', () => {
  // A fixture copy of what earlier builds left in <data>/clips: run folders with render.json, report.json, published.json.
  const runFiles = (dataDir, stem, { recording = `${stem}.mkv`, ok = true, published = true, extra = {} } = {}) => {
    const run = path.join(dataDir, 'clips', 'runs', stem); mkdirSync(run, { recursive: true });
    writeFileSync(path.join(run, 'render.json'), JSON.stringify({ tool: 'clipper', recording, clips: [], ...extra }));
    writeFileSync(path.join(run, 'report.json'), JSON.stringify({ results: [{ id: 'c01', file: 'stream-v.mp4', ok }] }));
    if (published) writeFileSync(path.join(run, 'published.json'), JSON.stringify({ files: [{ file: 'a' }] }));
    writeFileSync(path.join(dataDir, 'clips', `run-${stem}.log`), 'detect 100%\n');
  };
  const rec = (folder, name, n = 3000) => { const f = path.join(folder, name); writeFileSync(f, Buffer.alloc(n, 5)); return f; };
  const backlog = (dataDir) => readFileSync(path.join(dataDir, 'clips', BACKFILL_LOG), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  test('what earlier builds wrote proves no file identity or run exit codes: every old recording is kept, with the reason logged', async () => {
    const dataDir = mk(); const folder = mk();
    const a = rec(folder, 'old-a.mkv'); runFiles(dataDir, 'old-a');
    const b = rec(folder, 'old-b.mkv'); // never clipped
    const c = rec(folder, 'old-c.mkv'); runFiles(dataDir, 'old-c', { recording: 'other.mkv' });
    const d = rec(folder, 'old-d.mkv'); runFiles(dataDir, 'old-d', { ok: false });
    const e = rec(folder, 'old-e.mkv'); runFiles(dataDir, 'old-e', { published: false });
    writeFileSync(path.join(folder, 'notes.txt'), 'x');
    const r = await runRecordingCleanup({ dataDir, folder, flagOn: true, status: OFF_AIR, nowMs: T });
    assert.equal(r.deleted.length, 0);
    for (const f of [a, b, c, d, e]) assert.ok(existsSync(f));
    assert.deepEqual(backlog(dataDir).map((l) => [path.basename(l.file), l.decision, l.reason]), [
      ['old-a.mkv', 'kept', 'no-size-or-file-id-recorded'], ['old-b.mkv', 'kept', 'no-run-folder'], ['old-c.mkv', 'kept', 'run-is-for-another-file'],
      ['old-d.mkv', 'kept', 'not-validated'], ['old-e.mkv', 'kept', 'not-published']]);
    assert.ok(!existsSync(path.join(dataDir, 'clips', 'jobs.jsonl')), 'no job record written');
  });

  test('proven only with size or file id AND a full run AND a review run, each exit 0; then cleanup deletes it; runs once', async () => {
    const dataDir = mk(); const folder = mk();
    const ok = rec(folder, 'p-ok.mkv', 4000);
    runFiles(dataDir, 'p-ok', { extra: { recordingFile: { size: 4000 }, runs: [{ type: 'full', code: 0 }, { type: 'review', code: 0 }] } });
    const wrongSize = rec(folder, 'p-size.mkv', 4000);
    runFiles(dataDir, 'p-size', { extra: { recordingFile: { size: 3999 }, runs: [{ type: 'full', code: 0 }, { type: 'review', code: 0 }] } });
    const noReview = rec(folder, 'p-full.mkv', 4000);
    runFiles(dataDir, 'p-full', { extra: { recordingFile: { size: 4000 }, runs: [{ type: 'full', code: 0 }, { type: 'review', code: 1 }] } });
    const noFull = rec(folder, 'p-rev.mkv', 4000);
    runFiles(dataDir, 'p-rev', { extra: { recordingFile: { size: 4000 }, runs: [{ type: 'review', code: 0 }] } });
    const known = rec(folder, 'p-known.mkv'); appendJobRecord(dataDir, { h: known, v: null, type: 'full', result: 'failed', code: 1, at: '2026-11-19T00:00:00Z' });
    assert.deepEqual(backfillJobRecords({ dataDir, folder, nowMs: T }), { ran: true, proven: 1, kept: 3 });
    assert.deepEqual(backlog(dataDir).map((l) => [path.basename(l.file), l.reason]),
      [['p-full.mkv', 'no-finished-review-run'], ['p-ok.mkv', 'proven'], ['p-rev.mkv', 'no-finished-full-run'], ['p-size.mkv', 'no-size-or-file-id-recorded']]);
    assert.deepEqual(backfillJobRecords({ dataDir, folder, nowMs: T }), { ran: false, proven: 0, kept: 0 }, 'once');
    const r = await runRecordingCleanup({ dataDir, folder, flagOn: true, status: OFF_AIR, nowMs: T });
    assert.deepEqual(r.deleted.map((x) => x.file), [ok]);
    for (const f of [wrongSize, noReview, noFull, known]) assert.ok(existsSync(f));
  });
});