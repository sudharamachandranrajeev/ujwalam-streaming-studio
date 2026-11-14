// SPDX-License-Identifier: GPL-3.0-or-later
// QML twin of the task bar parts of tests/studio-qt-shell.test.mjs (plan Q4, checklist A; D287 and the user's feedback
// of 2026-11-10): the task chip in the on-air bar, the task panel at the top right (every task in full: stage, count,
// time left measured or "estimating", last progress, "may be stuck", Stop, Clear finished, the x of a finished row) and
// the notifications (start of a long job, done, failed, may be stuck; a click opens the panel). The words come from the
// widget studio's C++ (taskbar.h tasktime::*), so they are the same. Headless probe (UJWALAM_HEADLESS=1, offscreen, never
// on a screen) against a real UI server and the fake host; task files in <dataDir>/tasks/*.json stand in for jobs.
// Probe actions: tasks:open, tasks:close, tasks:dismiss, tasks:clear, tasks:toast-click, tasks:stop (the widget names).
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

describe('QML studio: task chip, task panel and notifications (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // prepare(dataDir) writes task files first; onStatus(n, dataDir) runs on each status request; onOut(out, dataDir) on output.
  async function probe({ actions = [], ms = 5000, prepare, onStatus, onOut, env = {} } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmltask-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'k'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    if (onStatus) {
      let n = 0;
      srv.server.on('request', (req) => { if (req.method === 'GET' && req.url?.split('?')[0] === '/ui/api/status') onStatus(++n, dataDir); });
    }
    try {
      const r = await new Promise((resolve) => {
        const child = spawn(SHELL_EXE, [], {
          windowsHide: true,
          env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1',
            UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
            UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; onOut?.(out, dataDir); });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 30_000);
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
      });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, t: p.state.tasks, dataDir, out: r.out };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => [a.action, a.done]);
  const node = (p, name) => p.tree.find((n) => n.name === name);

  // The QML studio embeds its two previews in the probe too (the widget probe does not): the UI server lists each
  // preview.open as a short task of its own ("Opening the horizontal preview", id ui-<time>-<n>, done at once). Those
  // are real and follow the same rules; the counts below are about the tasks each test writes.
  const own = (t) => t.ids.filter((id, i) => /^ui-[0-9a-z]+-[0-9a-z]+$/.test(id) && /^Opening the (horizontal|vertical) preview$/.test(t.titles[i])).length;
  const mine = (log) => log.filter((x) => !/^Done: Opening the (horizontal|vertical) preview$/.test(x));

  test('chip counts running tasks, the list opens and closes by probe action; nothing listed hides the chip', async () => {
    const idle = await probe({ actions: ['tasks:clear'] });
    assert.equal(idle.t.running, 0);
    assert.equal(idle.t.total, own(idle.t), `only the studio's own preview tasks: ${JSON.stringify(idle.t.titles)}`);
    assert.equal(idle.t.chipHidden, true, 'hidden when nothing is listed');
    assert.equal(node(idle.p, 'taskChip').visible, false);
    assert.equal(idle.t.panelOpen, false);
    const { p, t } = await probe({ ms: 6000, actions: ['tasks:open'], prepare: (d) => {
      task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', stage: 'render', done: 2, total: 7 });
      task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting', note: 'Waiting until the stream ends' });
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed', note: 'Could not open' });
    } });
    assert.deepEqual(done(p), [['tasks:open', true]]);
    assert.equal(t.chipHidden, false);
    assert.equal(t.chipText, '1 task running');
    const chip = node(p, 'taskChip'), bar = node(p, 'onAirBar');
    assert.equal(chip.visible, true);
    assert.ok(chip.rect[1] >= bar.rect[1] && chip.rect[1] + chip.rect[3] <= bar.rect[1] + bar.rect[3], 'the chip sits in the on-air bar');
    assert.deepEqual([t.running, t.waiting, t.total - own(t), t.rows - own(t), t.panelOpen], [1, 1, 3, 3, true]);
    assert.ok(!t.toastLog.includes('Failed: Opening the horizontal preview'), 'tasks already finished when the window starts do not pop up');
    assert.match(t.chipTip, /^Editing clips \(3 of 7\) - \d+:\d\d elapsed · /);
    const c = await probe({ ms: 6000, actions: ['tasks:open', 'tasks:clear', 'tasks:close'], prepare: (d) => {
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed' });
    } });
    assert.deepEqual(done(c.p), [['tasks:open', true], ['tasks:clear', true], ['tasks:close', true]]);
    assert.deepEqual([c.t.panelOpen, c.t.rows, c.t.total - own(c.t)], [false, 0, 1], 'cleared rows leave the list; the tasks stay in the snapshot');
    const x = await probe({ ms: 6000, actions: ['tasks:open', 'tasks:dismiss'], prepare: (d) => {
      task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', stage: 'render', done: 2, total: 7 });
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed' });
    } });
    assert.deepEqual(done(x.p), [['tasks:open', true], ['tasks:dismiss', true]]);
    assert.equal(x.t.rows, x.t.total - 1, 'the x hides one finished task from the list');
    assert.equal(x.t.panelOpen, true);
  });

  test('"Clear finished" removes every done and failed task at once; running and waiting ones stay (user, 2026-11-10)', async () => {
    const { p, t } = await probe({ ms: 6000, actions: ['tasks:open', 'tasks:clear'], prepare: (d) => {
      task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', stage: 'render', done: 2, total: 7 });
      task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting', note: 'Waiting until the stream ends' });
      task(d, { id: 'ui-c', kind: 'preview', title: 'Opening the horizontal preview', state: 'failed', note: 'Could not open' });
      task(d, { id: 'ui-d', kind: 'upload', title: 'Uploaded', state: 'done' });
      task(d, { id: 'data-posting-rules', kind: 'data', title: 'Auto-post rules not applied: the file has a problem', state: 'failed' });
    } });
    assert.deepEqual(done(p), [['tasks:open', true], ['tasks:clear', true]]);
    assert.deepEqual([t.total - own(t), t.rows, t.clearShown, t.panelOpen], [5, 2, false, true], `the two unfinished tasks stay listed: ${JSON.stringify(t.titles)}`);
    assert.deepEqual(t.detail.map((r) => r.id).sort(), ['clip-a', 'clip-b']);
    const only = await probe({ ms: 6000, actions: ['tasks:open', 'tasks:clear'], prepare: (d) => task(d, { id: 'ui-d', kind: 'upload', title: 'Uploaded', state: 'done' }) });
    assert.deepEqual([only.t.rows, only.t.panelOpen, only.t.chipHidden], [0, false, true], 'nothing left: the list folds away');
    const before = await probe({ actions: ['tasks:open'], prepare: (d) => task(d, { id: 'ui-d', kind: 'upload', title: 'Uploaded', state: 'done' }) });
    assert.equal(before.t.clearShown, true, 'the button shows while a finished task is listed');
    assert.equal(node(before.p, 'taskClear').visible, true);
    assert.equal(before.t.chipText, 'Tasks', 'only finished tasks listed: a quiet button');
  });

  test('a task that was running and finishes gives a notification; a failure too; the last one is the failure', async () => {
    // Tied to the studio's own status polls (its start-up time varies): the job finishes after the second poll, the
    // upload fails after the third.
    const { t } = await probe({ ms: 9000, prepare: (d) => task(d, { id: 'clip-a', title: 'Editing clips', state: 'running', done: 1, total: 4 }),
      onStatus: (n, d) => {
        if (n === 2) task(d, { id: 'clip-a', title: 'Clips ready from practice-1', state: 'done', note: '4 clips made' });
        if (n === 3) task(d, { id: 'ui-x', kind: 'upload', title: 'Uploading a clip to YouTube (private)', state: 'failed', note: 'The upload did not finish' });
      } });
    assert.deepEqual(mine(t.toastLog), ['Done: Clips ready from practice-1', 'Failed: Uploading a clip to YouTube (private)'], 'one notification for the finished clip run, one for the failed upload');
    assert.deepEqual([t.running, t.chipHidden, t.chipQuiet, t.chipText], [0, false, true, 'Tasks'], 'only finished tasks listed: a quiet button');
    assert.equal(t.lastToast, 'Failed: Uploading a clip to YouTube (private)');
    assert.ok(t.toasts >= 1 && t.toasts <= 3, 'at most three notifications at a time');
  });

  test('a long job that starts after the window opened gives a "Started" notification; one running at start does not', async () => {
    let added = false;
    const { t } = await probe({ ms: 5000, prepare: (d) => task(d, { id: 'clip-old', title: 'Clips from practice-2', state: 'running', done: 1, total: 9 }),
      onStatus: (n, d) => { if (n === 2 && !added) { added = true; task(d, { id: 'upload-1', kind: 'upload', title: 'Uploading a clip to YouTube (private)', state: 'running' }); } } });
    assert.equal(t.startToasts, 1, JSON.stringify(t.toastLog));
    assert.ok(t.toastLog.includes('Started: Uploading a clip to YouTube (private)'), JSON.stringify(t.toastLog));
    assert.ok(!t.toastLog.some((x) => x.includes('practice-2')), 'already running when the window started: no notification');
    assert.equal(t.chipText, '2 tasks running');
  });

  // The 2026-11-08 widget crash (a progress bar's freed animation, docs/evidence/2026-11-08-studio-crash.md): the QML
  // twin drives the same sequence with the window shown (offscreen) and animations on, and must not crash.
  test('regression: a clip task running and finishing with the panel open and animations on does not crash the studio', async () => {
    const { t, s } = await probe({ ms: 12000, actions: ['tasks:open', 'tasks:close', 'tasks:open'], env: { UJWALAM_REDUCE_MOTION: '0' }, prepare: (d) => {
      const steps = [[0, 'running', 0], [1500, 'running', 1], [3500, 'running', 2], [5500, 'running', 3], [7000, 'running', 4], [8500, 'done', 5]];
      for (const [at, state, n] of steps)
        setTimeout(() => task(d, { id: 'clip-practice-h', title: state === 'done' ? 'Clips ready from practice-h' : 'Reviewing the moments in practice-h', state, stage: 'review', done: n, total: 5, note: `clip L0${n} done` }), at);
      setTimeout(() => task(d, { id: 'ui-prev', kind: 'preview', title: 'Opening the horizontal preview', state: 'done' }), 4000);
    } });
    assert.equal(s.windowShown, true, 'the probe window was shown (offscreen), so the animations ran');
    assert.equal(t.running, 0, 'the clip job finished while the window watched');
    assert.ok(t.titles.includes('Clips ready from practice-h'), JSON.stringify(t.titles));
  });

  const STAGES = ['detect', 'candidates', 'gate', 'render', 'validate'];
  const hung = (d) => task(d, { id: 'clip-hung', title: 'Finding the best moments in practice-h-7', state: 'running', stage: 'detect', stages: STAGES, stageText: 'Starting',
    activeAt: Date.now() - 5 * 60_000 - 5000, progressAt: null, startedAt: Date.now() - 6 * 60_000 });
  const moving = (d, n) => task(d, { id: 'clip-a', title: 'Finding the best moments in practice-h-8', state: 'running', stage: 'detect', stages: STAGES, stageText: 'Reading the game screen', unit: 'frame',
    done: Math.min(3148, 412 + n * 3), total: 3148, activeAt: Date.now() - 60_000, progressAt: Date.now() });
  test('task panel: top right under the bar; every task in full; a job with no progress for 5 min warns it may be stuck', async () => {
    const { t, p } = await probe({ ms: 6000, actions: ['tasks:open'], prepare: (d) => {
      hung(d);
      moving(d, 0);
      task(d, { id: 'clip-b', title: 'Clips from practice-3', state: 'waiting', note: 'Waiting for its turn' });
    }, onStatus: (n, d) => { if (n > 1) moving(d, n); } });
    assert.deepEqual([t.chipHidden, t.panelOpen, t.running, t.waiting, t.stalled], [false, true, 2, 1, 1]);
    assert.equal(t.chipText, '2 tasks running - 1 may be stuck');
    assert.equal(t.panel.right, 14, 'anchored at the right edge');
    assert.ok(t.panel.y >= t.topY && t.panel.y < 140, `under the on-air bar: ${JSON.stringify(t.panel)} topY ${t.topY}`);
    assert.ok(t.panel.width >= 400, 'wide enough that lines are read in full');
    const by = Object.fromEntries(t.detail.map((r) => [r.id, r]));
    assert.equal(by['clip-hung'].stage, 'Step 1 of 5: Starting');
    assert.match(by['clip-hung'].warn, /^No progress for 5 min - it may be stuck$/);
    assert.match(by['clip-hung'].last, /^No progress yet \(started 5 min ago\)$/);
    assert.equal(by['clip-hung'].count, 'Working; how much is left is not known for this step');
    assert.match(by['clip-hung'].eta, /^Elapsed \d+:\d\d · Time left unknown$/);
    assert.deepEqual([by['clip-hung'].stalled, by['clip-hung'].stop], [true, true]);
    assert.equal(by['clip-a'].stage, 'Step 1 of 5: Reading the game screen');
    assert.match(by['clip-a'].count, /^4\d\d of 3148 frames \(1[34]%\)$/);
    assert.match(by['clip-a'].eta, /^Elapsed \d+:\d\d · (Estimating time left\.\.\.|About \d+ (h \d+ )?min left in this step)$/, 'a measured time left, or estimating; never a guess');
    assert.match(by['clip-a'].last, /^Last progress \d+ s ago$/);
    assert.deepEqual([by['clip-a'].stalled, by['clip-a'].warn, by['clip-a'].stop], [false, '', true]);
    assert.deepEqual([by['clip-b'].state, by['clip-b'].stop], ['waiting', true]);
    assert.match(by['clip-b'].eta, /^Elapsed \d+:\d\d · Waiting its turn$/);
    assert.ok(t.toastsShown >= 1 && t.toastPos.every((x) => x.y >= t.topY), 'notifications under the bar');
    assert.ok(t.toastPos.every((x) => x.x + x.width <= t.panel.x), 'with the panel open, notifications sit to its left');
    // What the user reads in the panel: the warning line and a Stop button per stoppable row, in the tree.
    assert.ok(p.tree.some((n) => n.name === 'taskWarn' && n.visible && n.text === by['clip-hung'].warn), 'the warning is drawn');
    assert.equal(p.tree.filter((n) => n.name === 'taskStop' && n.visible).length, 3, 'Stop on each of the three jobs');
  });

  test('the "may be stuck" notification is at the top right; a click opens the panel; Stop reaches the stop route', async () => {
    const { t, p, dataDir } = await probe({ actions: ['tasks:toast-click', 'tasks:stop'], prepare: (d) => hung(d) });
    assert.ok(t.toastLog.includes('May be stuck: Finding the best moments in practice-h-7'), JSON.stringify(t.toastLog));
    assert.deepEqual(done(p), [['tasks:toast-click', true], ['tasks:stop', true]]);
    assert.deepEqual([t.toastClicks, t.panelOpen, t.stopsSent], [1, true, 1]);
    assert.ok(existsSync(path.join(dataDir, 'clips', 'stop-tasks.json')), 'the launcher gets the stop request');
    assert.equal(p.state.note, 'Stopping the background jobs...');
    const q = await probe({ ms: 3500, prepare: (d) => hung(d) });
    assert.equal(q.t.panelOpen, false, 'collapsed until clicked');
    assert.ok(q.t.toastLog.includes('May be stuck: Finding the best moments in practice-h-7'), JSON.stringify(q.t.toastLog));
    assert.ok(q.t.toastPos.length >= 1);
    assert.ok(q.t.toastPos.every((x) => x.right === 14), `notifications at the right edge: ${JSON.stringify(q.t.toastPos)}`);
    assert.ok(q.t.toastPos[0].y >= q.t.topY && q.t.toastPos[0].y < 140, 'the first at the top, under the bar');
  });
});
