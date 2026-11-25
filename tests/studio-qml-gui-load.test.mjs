// SPDX-License-Identifier: GPL-3.0-or-later
// GUI-thread load of the QML studio (2026-11-25, user report: "Ujwalam is freezing in between"; the close question
// "freezes instead of showing what is happening"). Guards the fixes measured in
// docs/evidence/2026-11-25-studio-gui-stalls-close-feedback.md:
// - the task panel and the task window keep their rows between status polls (a new rows array as the list model built
//   every row again on each poll, 20 ms of a 22 ms status answer in the realistic probe);
// - a waiting or paused task does not animate the task chip (the chip redrew the window at about 60 frames a second for
//   as long as any task was listed); a running one moves in 8 Hz steps;
// - closing shows "Closing Ujwalam..." with what it does, on screen before the studio quits.
// Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI server and the fake host.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const task = (dataDir, o) => writeTaskFile(dataDir, { kind: 'clips', startedAt: Date.now() - 5000, updatedAt: Date.now(), ...o });
const RUNNING = { id: 'clip-a', title: 'Clips from practice-1', state: 'running', stage: 'detect', done: 1, total: 4000 };
const PAUSED = { id: 'clip-b', title: 'Clips from practice-2', state: 'waiting', note: 'Paused by you; press Resume to continue', paused: true };

describe('QML studio: GUI-thread load of tasks and the close feedback (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function run({ actions = [], ms = 8000, prepare, onStatus } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlload-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'g'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags: createFlags({ dataDir }), authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    if (onStatus) {
      let n = 0;
      srv.server.on('request', (req) => { if (req.method === 'GET' && req.url?.split('?')[0] === '/ui/api/status') onStatus(++n, dataDir); });
    }
    try {
      const r = await new Promise((resolve) => {
        const t0 = Date.now();
        const child = spawn(SHELL_EXE, [], {
          windowsHide: true,
          env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1',
            UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
            UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 30_000);
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, ms: Date.now() - t0 }); });
      });
      assert.equal(r.code, 0, r.err);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const m = /^studio probe: (.+)$/m.exec(r.out);
      return { ...r, p: m ? JSON.parse(m[1]) : null };
    } finally { await srv.close(); }
  }
  const frames = (p) => (p.lag.work['frame render'] || { n: 0 }).n;

  test('a task that moves on every poll: the panel and the task window build each row once, the status answer stays short', async () => {
    let done = 1;
    const r = await run({ // the studio reads the status every 2 s: about 6 reads in 14 s, each with a new count
      ms: 14000, actions: ['tasks:open', 'tasks:window-open'], prepare: (d) => task(d, RUNNING),
      onStatus: (n, d) => task(d, { ...RUNNING, done: ++done, updatedAt: Date.now() }),
    });
    assert.ok(r.p, `no probe line: ${r.out}`);
    const t = r.p.state.tasks;
    assert.deepEqual(r.p.actions.map((a) => a.done), [true, true]);
    assert.ok(t.detail.find((x) => x.id === 'clip-a').count !== '', 'the running row shows its count');
    assert.ok(done >= 5, `the task moved on several polls (${done})`);
    // Each listed task is one row in the panel and at most one in the window; before: every poll built all of them again.
    assert.ok(t.rowsMade <= 2 * t.rows, `rows built ${t.rowsMade} for ${t.rows} rows`);
    const st = r.p.lag.work['ui/api/status'];
    assert.ok(st && st.n >= 4, 'several status answers');
    assert.ok(st.totalMs / st.n < 40, `status answer avg ${Math.round(st.totalMs / st.n)} ms`);
  });

  test('only a paused task: the chip stands still (few frames); a running task moves in steps, not at the frame rate', async () => {
    const paused = await run({ prepare: (d) => task(d, PAUSED) });
    assert.equal(paused.p.state.tasks.waiting, 1);
    assert.equal(paused.p.state.tasks.running, 0);
    const running = await run({ prepare: (d) => task(d, RUNNING) });
    assert.equal(running.p.state.tasks.running, 1);
    // Before (2026-11-25): about 60 frames a second in both cases (480 in 8 s). An 8 s probe now draws far fewer.
    assert.ok(frames(paused.p) < 150, `paused: ${frames(paused.p)} frames in 8 s`);
    assert.ok(frames(running.p) < 300, `running: ${frames(running.p)} frames in 8 s`);
  });

  test('close, "Stop them and close": the window shows what closing does, on screen before the studio quits', async () => {
    const r = await run({ ms: 15000, actions: ['close', 'close-choice:stop'], prepare: (d) => task(d, RUNNING) });
    assert.equal(r.p, null, 'the close quit before the probe time');
    assert.match(r.out, /^studio closing: stopping 1 task$/m);
    const m = /^studio closing: shown after (\d+) ms \((frame|timeout)\), quitting$/m.exec(r.out);
    assert.ok(m, r.out);
    assert.ok(Number(m[1]) <= 400, `the closing card was on screen after ${m[1]} ms`);
    assert.ok(r.ms < 15000, `the studio ended (${r.ms} ms)`);
  });

  test('close with nothing running: no question, the closing card, then exit 0', async () => {
    const r = await run({ ms: 15000, actions: ['close'] });
    assert.equal(r.p, null);
    assert.match(r.out, /^studio closing: closing the services$/m);
    assert.match(r.out, /^studio closing: shown after \d+ ms \((frame|timeout)\), quitting$/m);
  });
});
