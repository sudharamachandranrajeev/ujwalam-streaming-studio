// SPDX-License-Identifier: GPL-3.0-or-later
// RS3 (D412) Settings > Clips > Reel styles, the studio side (services/studio-ui/reel-styles.mjs): the real Python CLI
// (services/clip/reel_style.py) for list / create / tune in a temp data folder, and a fake child for analyse, so the
// progress lines reach the task area and the job, and live / busy / flag off are refused. No video is copied.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createReelStyles, reelStyleOpProblems } from '../services/studio-ui/reel-styles.mjs';
import { pythonIn } from '../services/studio-ui/record-clips.mjs';
import { createTasks } from '../services/studio-ui/tasks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// the worktree may have no venv of its own: the main checkout's (UJWALAM_TEST_PYTHON) is used then
const PY = process.env.UJWALAM_TEST_PYTHON || pythonIn(ROOT)?.exe || null;
const skip = PY ? false : 'no project Python';

test('request shapes', () => {
  assert.deepEqual(reelStyleOpProblems({ op: 'create', name: 'a', paths: ['C:/a.mp4'] }), []);
  assert.deepEqual(reelStyleOpProblems({ op: 'analyse', id: 'a' }), []);
  assert.match(reelStyleOpProblems({ op: 'delete' }).join(), /op must be/);
  assert.match(reelStyleOpProblems({ op: 'analyse', id: '../x' }).join(), /style id/);
  assert.match(reelStyleOpProblems({ op: 'analyse', id: 'a', src: 'x' }).join(), /unknown src/);
  assert.match(reelStyleOpProblems({ op: 'tune', id: 'a', tune: [] }).join(), /tune must be/);
});

test('create, list and tune through the Python rules; nothing copied', { skip }, async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), 'ujw-rs3-data-'));
  const ex = mkdtempSync(path.join(os.tmpdir(), 'ujw-rs3-ex-'));
  try {
    const video = path.join(ex, 'liked reel.mp4');
    writeFileSync(video, 'not really a video');
    const rs = createReelStyles({ dataDir: data, clipRoot: ROOT, tasks: createTasks(), python: PY });
    let r = await rs.run({ op: 'create', name: '  Fast   and warm ', paths: [video] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.style.id, 'fast-and-warm');
    assert.equal(r.body.style.name, 'Fast and warm');
    assert.equal(r.body.style.analysed, false);
    const dir = path.join(data, 'clips', 'styles', 'fast-and-warm');
    assert.deepEqual(readdirSync(dir), ['style.json'], 'only the record is written (no video copy)');
    assert.equal(JSON.parse(readFileSync(path.join(dir, 'style.json'), 'utf8')).examples[0].path, video);
    r = await rs.run({ op: 'create', name: 'Fast and warm', paths: [video] });
    assert.equal(r.body.style.id, 'fast-and-warm-2', 'a second style with the same name gets its own id');
    r = await rs.run({ op: 'create', name: 'x', paths: [path.join(ex, 'missing.mp4')] });
    assert.equal(r.status, 400);
    assert.match(r.body.detail, /missing\.mp4: file not found/);
    r = await rs.run({ op: 'create', name: 'x', paths: ['relative.mp4'] });
    assert.match(r.body.detail, /full path/);
    r = await rs.run({ op: 'tune', id: 'fast-and-warm', tune: { shotSec: 1 } });
    assert.equal(r.status, 400);
    assert.match(r.body.detail, /not analysed yet/);
    const info = await rs.info();
    assert.equal(info.flag, true);
    assert.deepEqual(info.styles.map((s) => s.id), ['fast-and-warm', 'fast-and-warm-2']);
    assert.deepEqual(info.reelTypes, ['reel', 'impact', 'montage']);
    assert.ok(info.tune.shotSec.min > 0);
  } finally { rmSync(data, { recursive: true, force: true }); rmSync(ex, { recursive: true, force: true }); }
});

function fakeChild(lines, code) {
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
  setImmediate(() => {
    for (const l of lines) c.stdout.emit('data', `${l}\n`);
    if (code) c.stderr.emit('data', 'style analysis: example 1 is missing: a.mp4\n');
    c.emit('close', code);
  });
  return c;
}

test('analyse runs hidden, reports progress in the task area, and is refused live, busy or with the flag off', async () => {
  const tasks = createTasks();
  const calls = [];
  let live = false; let flag = true;
  const spawnFn = (exe, argv, o) => { calls.push({ argv, o }); return fakeChild(['progress example 1/2', 'progress example 2/2', '{"ok": true, "style": "a", "summary": "cuts every 1.2 s"}'], 0); };
  const rs = createReelStyles({ dataDir: 'D:/data', clipRoot: ROOT, tasks, isLive: () => live, flagOn: () => flag, spawnFn, python: 'python.exe' });
  const r = await rs.run({ op: 'analyse', id: 'a' });
  assert.equal(r.status, 202);
  assert.equal((await rs.run({ op: 'analyse', id: 'a' })).status, 409, 'one at a time');
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(calls[0].o.windowsHide, true);
  assert.ok(calls[0].argv.includes('-I') && calls[0].argv.some((a) => a.endsWith('style_analyse.py')));
  assert.equal(rs.job().state, 'done');
  assert.equal(rs.job().note, 'cuts every 1.2 s');
  const t = tasks.list().find((x) => x.kind === 'reel-style');
  assert.equal(t.state, 'done');
  live = true;
  const l = await rs.run({ op: 'preview', id: 'a', src: 'D:/c.mp4' });
  assert.equal(l.status, 409);
  assert.equal(l.body.error, 'live');
  live = false; flag = false;
  assert.equal((await rs.run({ op: 'analyse', id: 'a' })).status, 404);
  assert.deepEqual((await rs.info()).styles, []);
  const bad = createReelStyles({ dataDir: 'D:/data', clipRoot: ROOT, tasks, spawnFn: () => fakeChild([], 2), python: 'python.exe' });
  await bad.run({ op: 'analyse', id: 'a' });
  await new Promise((ok) => setTimeout(ok, 30));
  assert.equal(bad.job().state, 'failed');
  assert.match(bad.job().note, /example 1 is missing/);
});
