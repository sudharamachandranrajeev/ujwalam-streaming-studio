// SPDX-License-Identifier: GPL-3.0-or-later
// QML task manager window (D442, 2026-11-24): the task list in its own top-level window (TaskWindow.qml). Headless probe
// (UJWALAM_HEADLESS=1, offscreen; the window is never shown) against a real UI server and the fake host; task files in
// <dataDir>/tasks/*.json stand in for jobs, and the control requests the window sends are read back from
// <dataDir>/clips/control/. Probe actions: tasks:window-open, tasks:window-dock, tasks:window-close (the window's X),
// tasks:sort:<state|start|category>, tasks:filter-state:<all|running|waiting|failed|done>, tasks:filter-cat:<category|all>,
// tasks:select:<id>, tasks:ctl:<id>:<stop|pause|resume|next>[:<run|ask|notify>] (the button's own click function).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { controlDir, writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const NOW = Date.now();
const task = (dataDir, o) => writeTaskFile(dataDir, { kind: 'clips', startedAt: NOW - 5000, updatedAt: NOW, ...o });
// A small set that covers every state, category and control combination the window decides on.
const set = (d) => {
  task(d, { id: 'clip-a', title: 'Editing clips (3 of 7)', state: 'running', category: 'clips', startedAt: NOW - 60_000, stage: 'render', stages: ['detect', 'render', 'validate'], stageText: 'Cutting the clips', done: 2, total: 7,
    controls: ['stop', 'pause', 'next'], pausable: true, nextStart: 'notify', parts: ['Clip 3', 'Clip 4'], logTail: ['Used <b>bold</b> text'],
    logEvents: [{ v: 1, type: 'progress', stage: 'render', done: 3, total: 7 }, { v: 1, type: 'part', name: 'Video tools (ffmpeg)' }] });
  task(d, { id: 'reel-b', title: 'Making the reel', state: 'running', category: 'reels', startedAt: NOW - 30_000, controls: ['stop'], pausable: false,
    pauseReason: 'This step cannot be paused' });
  task(d, { id: 'long-c', title: 'Long video batch', state: 'waiting', category: 'long-video', startedAt: NOW - 90_000, controls: ['stop', 'resume', 'next'], paused: true,
    nextStart: 'ask', question: 'Carry on with the long video?' });
  task(d, { id: 'post-d', title: 'Posting to YouTube', state: 'running', category: 'posting', startedAt: NOW - 10_000, controls: ['stop'], pausing: true });
  task(d, { id: 'dl-e', title: 'Download finished', state: 'done', category: 'downloads', startedAt: NOW - 120_000 });
  task(d, { id: 'maint-f', title: 'Cleanup failed', state: 'failed', category: 'maintenance', startedAt: NOW - 20_000 });
};

describe('QML studio: task manager window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = 6000, prepare } = {}) {
    const dataDir = mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ujw-qmltw-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'k'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await new Promise((resolve) => {
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
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
      });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, t: p.state.tasks, m: p.state.tasks.manager, dataDir };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => [a.action, a.done]);
  const O = ['tasks:window-open'];
  const sent = (dataDir) => {
    const dir = controlDir(dataDir);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ id: f.split('~')[0], ...JSON.parse(readFileSync(path.join(dir, f), 'utf8')) })) : [];
  };
  const byId = (m) => Object.fromEntries(m.rows.map((r) => [r.id, r]));
  // The studio's own preview tasks (ui-*) are in the list too; the assertions look at the tasks written here.
  const mine = (m, ids) => ids.filter((id) => !/^ui-/.test(id));

  test('opens in its own window from the panel and docks back; the hidden test mode never shows a window', async () => {
    const closed = await probe({ prepare: set, actions: ['tasks:open'] });
    assert.deepEqual([closed.t.panelOpen, closed.t.windowOpen, closed.m], [true, false, null], 'the window is made on first use');
    const w = await probe({ prepare: set, actions: ['tasks:open', ...O] });
    assert.deepEqual(done(w.p), [['tasks:open', true], ['tasks:window-open', true]]);
    assert.deepEqual([w.t.windowOpen, w.t.panelOpen, w.m.open, w.m.visible], [true, false, true, false], 'open state, panel folded away, and never visible while headless');
    assert.equal(w.p.state.windowShown !== undefined, true);
    const dock = await probe({ prepare: set, actions: [...O, 'tasks:window-dock'] });
    assert.deepEqual([dock.t.windowOpen, dock.t.panelOpen, dock.m.open], [false, true, false], 'Dock returns to the panel');
    const x = await probe({ prepare: set, actions: [...O, 'tasks:window-close'] });
    assert.deepEqual([x.t.windowOpen, x.t.panelOpen], [false, true], 'closing the window returns to the panel');
    const again = await probe({ prepare: set, actions: [...O, 'tasks:window-dock', ...O] });
    assert.deepEqual([again.t.windowOpen, again.t.panelOpen], [true, false], 'it can be opened again');
  });

  test('sort by state, start time and category; filter by state and category (words on every control)', async () => {
    const ids = (m) => mine(m, m.ids);
    const s = await probe({ prepare: set, actions: O });
    assert.deepEqual([s.m.sort, s.m.filterState, s.m.filterCat, s.m.sizeColumn], ['state', 'all', 'all', false], 'no size column: the snapshot has no size per task');
    assert.deepEqual([s.m.sortText, s.m.stateText, s.m.catText], ['State', 'All', 'All']);
    assert.deepEqual(ids(s.m), ['post-d', 'reel-b', 'clip-a', 'long-c', 'maint-f', 'dl-e'], 'running (newest first), waiting, failed, done');
    const st = await probe({ prepare: set, actions: [...O, 'tasks:sort:start'] });
    assert.deepEqual([st.m.sort, st.m.sortText], ['start', 'Start time (newest first)']);
    assert.deepEqual(ids(st.m), ['post-d', 'maint-f', 'reel-b', 'clip-a', 'long-c', 'dl-e']);
    const c = await probe({ prepare: set, actions: [...O, 'tasks:sort:category'] });
    assert.deepEqual(ids(c.m), ['clip-a', 'dl-e', 'long-c', 'maint-f', 'post-d', 'reel-b'], 'category name order');
    const f = await probe({ prepare: set, actions: [...O, 'tasks:filter-state:running'] });
    assert.deepEqual([f.m.stateText, ids(f.m)], ['Running', ['post-d', 'reel-b', 'clip-a']]);
    const f2 = await probe({ prepare: set, actions: [...O, 'tasks:filter-cat:reels'] });
    assert.deepEqual([f2.m.catText, ids(f2.m)], ['Reels', ['reel-b']]);
    const f3 = await probe({ prepare: set, actions: [...O, 'tasks:filter-state:done', 'tasks:filter-cat:clips'] });
    assert.deepEqual(ids(f3.m), [], 'both filters apply together');
  });

  test('each row shows only the buttons its job offers in `controls`; pausing and "cannot pause" say so in words', async () => {
    const { m } = await probe({ prepare: set, actions: O });
    const r = byId(m);
    assert.deepEqual(r['clip-a'].buttons, ['stop', 'pause', 'next:run', 'next:ask', 'next:notify']);
    assert.deepEqual(r['reel-b'].buttons, ['stop']);
    assert.deepEqual(r['long-c'].buttons, ['stop', 'resume', 'next:run', 'next:ask', 'next:notify']);
    assert.deepEqual(r['post-d'].buttons, ['stop']);
    assert.deepEqual([r['dl-e'].buttons, r['maint-f'].buttons], [[], []], 'a finished task offers nothing');
    assert.equal(r['reel-b'].note, 'This step cannot be paused', 'the reason shown as plain text, no Pause button');
    assert.equal(r['post-d'].note, 'Pausing at the next safe point…');
    assert.deepEqual([r['long-c'].stateText, r['long-c'].question], ['Paused', 'Carry on with the long video?']);
    assert.deepEqual([r['clip-a'].nextStart, r['long-c'].nextStart], ['notify', 'ask']);
  });

  test('a click posts the right body once; the row waits for the list to change; a control the job does not offer sends nothing', async () => {
    const { p, m, dataDir } = await probe({ ms: 7000, prepare: set, actions: [...O, 'tasks:ctl:clip-a:pause', 'tasks:ctl:clip-a:stop', 'tasks:ctl:long-c:next:run',
      'tasks:ctl:long-c:resume', 'tasks:ctl:reel-b:pause', 'tasks:ctl:clip-a:next:notify', 'tasks:ctl:dl-e:stop'] });
    assert.deepEqual(done(p).slice(1), [['tasks:ctl:clip-a:pause', true], ['tasks:ctl:clip-a:stop', false], ['tasks:ctl:long-c:next:run', true],
      ['tasks:ctl:long-c:resume', false], ['tasks:ctl:reel-b:pause', false], ['tasks:ctl:clip-a:next:notify', false], ['tasks:ctl:dl-e:stop', false]],
    'second click on a task waits; Pause on a job that does not offer it, and the choice already made, send nothing');
    assert.equal(m.postsSent, 2);
    assert.deepEqual(sent(dataDir).map(({ id, op, nextStart }) => ({ id, op, ...(nextStart ? { nextStart } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
      [{ id: 'clip-a', op: 'pause' }, { id: 'long-c', op: 'next', nextStart: 'run' }]);
    const r = byId(m);
    assert.deepEqual([r['clip-a'].busy, r['long-c'].busy, r['reel-b'].busy], [true, true, false], 'buttons wait until the row changes');
  });

  test('clicking a task shows its details: stage, progress, step, time, parts, and the log as plain text', async () => {
    const { m } = await probe({ prepare: set, actions: [...O, 'tasks:select:clip-a'] });
    assert.equal(m.selected, 'clip-a');
    const d = m.detail;
    assert.equal(d.title, 'Editing clips (3 of 7)');
    const f = Object.fromEntries(d.fields.map((x) => [x.k, x.v]));
    assert.equal(f.State, 'Running');
    assert.equal(f.Category, 'Clips');
    assert.equal(f.Stage, 'Step 2 of 3: Cutting the clips');
    assert.equal(f.Progress, '28% done');
    assert.match(f['Time spent'], /^Elapsed \d+:\d\d$/);
    assert.ok('Time left' in f, JSON.stringify(f));
    assert.equal(f['Next start'], 'Just notify me');
    assert.deepEqual(d.parts, ['Clip 3', 'Clip 4']);
    assert.deepEqual(d.log, ['Making clip videos: 3 of 7', 'Running: Video tools (ffmpeg)'], 'Codex round 2: fixed text from typed events; a string tail is dropped');
    assert.equal(d.logPlain, true, 'the log text is drawn as plain text, never rich text');
    const none = await probe({ prepare: set, actions: O });
    assert.equal(none.m.detail, null, 'nothing selected: a hint instead of details');
  });

  test('"N tasks are waiting for you" notice at the start opens the task manager window', async () => {
    const waiting = (n) => (d) => { set(d); mkdirSync(path.join(d, 'clips'), { recursive: true }); writeFileSync(path.join(d, 'clips', 'status.json'), JSON.stringify({ available: true, waitingForYou: n })); };
    const a = await probe({ prepare: waiting(2), actions: ['tasks:toast-click'] });
    assert.equal(a.t.waitingForYou, 2);
    assert.equal(a.t.waitNotices, 1);
    assert.ok(a.t.toastLog.includes('2 tasks are waiting for you'), JSON.stringify(a.t.toastLog));
    assert.deepEqual([a.t.windowOpen, a.t.panelOpen, a.t.toastClicks], [true, false, 1], 'a click on the notice opens the window');
    const one = await probe({ prepare: waiting(1) });
    assert.ok(one.t.toastLog.includes('1 task is waiting for you'), JSON.stringify(one.t.toastLog));
    const none = await probe({ prepare: set });
    assert.equal(none.t.waitNotices, 0, 'nothing waits: no notice');
  });
});
