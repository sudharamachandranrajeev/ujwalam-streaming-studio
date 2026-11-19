// SPDX-License-Identifier: GPL-3.0-or-later
// More menu windows in the QML studio (plan Q4): Feedback notes (D150), Report a problem (flag report-button) and Import
// Meld session. A real UI server and the fake host. Feedback: moments from a temp feedback folder, a note saved with tag
// and severity. Report: the server builds the link (test reporter), only an https://github.com/ link passes, and test
// mode never opens a browser. Import: the minimal Meld fixture creates a new project file, the host check's counts show,
// Load sends project.load with the skip choice; no session configured says how to set one. Headless probe
// (UJWALAM_HEADLESS=1, offscreen, never on a screen). Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.resolve(HERE, '..', 'ui');
const MELD = path.join(HERE, 'fixtures', 'project', 'meld-minimal.session.json');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio: More menu windows (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  async function probe({ actions, flagIds = [], server = {}, ms = Math.max(7000, 3000 + actions.length * 700) }) {
    const dataDir = tmp('ujw-qmlmw-');
    const flags = createFlags({ dataDir });
    for (const id of flagIds) flags.set(id, true);
    const fake = createFakeHost({ outputsReady: true });
    const calls = [];
    const host = {
      describe: () => fake.describe(),
      call: async (m, p) => {
        calls.push([m, p]);
        if (m === 'project.plan') return { unavailable: [{ x: 1 }, { x: 2 }], warnings: [], devicesListed: [], flags: { devices: false } };
        if (m === 'project.load') return { built: { scenes: 1, sources: 1 }, unavailable: [] };
        return fake.call(m, p);
      },
    };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'm'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), authority: null,
      limits: { statusPollMs: 50, loadRetryMs: [1, 1, 1] }, log: () => {}, sessionFile: null, ...server });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, calls, dataDir };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => a.done);
  const enc = encodeURIComponent;

  describe('More menu', () => {
    test('flags off: Import and Feedback only; an item opens its window', async () => {
      const { p, s } = await probe({ actions: ['more:import', 'more-open', 'more:posts', 'more:feedback'] });
      assert.deepEqual(done(p), [false, true, false, true], 'closed menu runs nothing; a hidden item cannot be picked');
      assert.equal(s.more.open, false, 'picking an item closes the menu');
      assert.equal(s.feedback.open, true);
    });
    test('flags on: Posts, Growth numbers and Report a problem show, in the widget order', async () => {
      const { s } = await probe({ flagIds: ['posting', 'growth', 'report-button'], actions: ['more-open'] });
      assert.equal(s.more.open, true);
      assert.deepEqual(s.more.items.map((i) => i.id), ['import', 'scenebuilder', 'feedback', 'posts', 'growth', 'report', 'updates']);
      assert.ok(s.more.items.every((i) => i.enabled && i.tip !== ''), 'every item enabled with a tip');
    });
  });

  describe('Feedback notes', () => {
    function moments() {
      const dir = tmp('ujw-qmlmw-fb-');
      for (const [t, scene] of [['120000', 'Gameplay'], ['121500', 'Starting soon']]) {
        mkdirSync(path.join(dir, '2026-11-14', t), { recursive: true });
        writeFileSync(path.join(dir, '2026-11-14', t, 'moment.json'), JSON.stringify({ timestamp: `2026-11-14T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`, scene, stats: { fps: 60, dropped: 3 } }));
      }
      return dir;
    }
    test('the moments list; pick one, write a note with tag and severity, Save note writes note.json', async () => {
      const feedbackDir = moments();
      const { p, s } = await probe({ server: { feedbackDir },
        actions: ['feedback-open', 'feedback-pick:1', `feedback-text:${enc('Audio dropped for a second')}`, 'feedback-tag:annoying', 'feedback-severity:high', 'feedback-save'] });
      assert.deepEqual(done(p), [true, true, true, true, true, true]);
      const fb = s.feedback;
      assert.equal(fb.info, 'Saved.');
      assert.equal(fb.rows.length, 2);
      assert.ok(fb.rows.some((r) => /annoying\/high$/.test(r)), fb.rows.join(' | '));
      assert.match(fb.meta, /Starting soon|Gameplay/);
      assert.match(fb.meta, /fps=60/);
      const saved = fb.selected;
      const note = JSON.parse(readFileSync(path.join(feedbackDir, ...saved.split('/'), 'note.json'), 'utf8'));
      assert.deepEqual([note.text, note.tag, note.severity], ['Audio dropped for a second', 'annoying', 'high']);
    });
    test('no moments: says how to make one; the form needs a pick; an unknown tag is refused', async () => {
      const empty = tmp('ujw-qmlmw-fb0-');
      let r = await probe({ server: { feedbackDir: empty }, actions: ['feedback-open', 'feedback-save'] });
      assert.match(r.s.feedback.info, /^No feedback moments yet\./);
      assert.equal(r.s.feedback.formShown, false);
      assert.deepEqual(done(r.p), [true, false]);
      r = await probe({ server: { feedbackDir: moments() }, actions: ['feedback-open', 'feedback-pick:0', 'feedback-tag:nonsense', 'feedback-pick:5'] });
      assert.deepEqual(done(r.p), [true, true, false, false]);
      assert.equal(r.s.feedback.tag, 'bug', 'a new note starts as bug / medium');
      assert.equal(r.s.feedback.severity, 'medium');
    });
  });

  describe('Report a problem', () => {
    const reporter = (url, extra = {}) => ({ build: () => ({ configured: true, url, truncated: false, ...extra }) });
    test('flag off: the server refuses; nothing opens', async () => {
      const { s, p } = await probe({ server: { reporter: reporter('https://github.com/o/r/issues/new') }, actions: ['report-open', `report-title:${enc('Crash')}`, 'report-send'] });
      assert.deepEqual(done(p), [true, true, true]);
      assert.match(s.report.result, /^Report failed: /);
    });
    test('flag on: a github.com link passes (test mode never opens it); a link elsewhere is refused', async () => {
      let r = await probe({ flagIds: ['report-button'], server: { reporter: reporter('https://github.com/o/r/issues/new?title=x', { truncated: true }) },
        actions: ['report-open', `report-title:${enc('Preview froze')}`, `report-note:${enc('After a scene switch')}`, 'report-send'] });
      assert.equal(r.s.report.open, false, 'closed after the send');
      assert.equal(r.s.report.result, 'Shortened to fit: attach the diag bundle. Review it in your browser, then submit. (test mode: not opened)');
      r = await probe({ flagIds: ['report-button'], server: { reporter: reporter('https://evil.example/issues/new') }, actions: ['report-open', `report-title:${enc('x')}`, 'report-send'] });
      assert.equal(r.s.report.result, 'Report: the link was refused');
      r = await probe({ flagIds: ['report-button'], server: { reporter: reporter('http://github.com/o/r') }, actions: ['report-open', `report-title:${enc('x')}`, 'report-send'] });
      assert.equal(r.s.report.result, 'Report: the link was refused', 'http is refused too');
    });
    test('not configured: the server\'s words; actions refused while closed', async () => {
      const { s, p } = await probe({ flagIds: ['report-button'], server: { reporter: { build: () => ({ configured: false, message: 'Report: set links.issues_url in the profile' }) } },
        actions: ['report-send', 'report-open', `report-title:${enc('x')}`, 'report-send'] });
      assert.deepEqual(done(p), [false, true, true, true]);
      assert.equal(s.report.result, 'Report: set links.issues_url in the profile');
    });
  });

  describe('Import Meld session', () => {
    test('no session configured: says how to set one; Load stays off', async () => {
      const { s } = await probe({ actions: ['import-open'] });
      assert.match(s.import.info, /^No Meld session file is configured/);
      assert.equal(s.import.canLoad, false);
    });
    test('the fixture: a new project file, the counts, skip offered for the 2 unavailable items; Load sends it with the skip choice', async () => {
      const { s, p, calls } = await probe({ server: { sessionFile: MELD }, actions: ['import-open', 'import-skip:on', 'import-load'] });
      assert.deepEqual(done(p), [true, true, true]);
      assert.match(s.import.info, /^Created a new project file \(/);
      assert.ok(s.import.counts.some((c) => /^imported scenes: \d+$/.test(c)), s.import.counts.join(' | '));
      assert.ok(s.import.counts.includes('plan unavailable: 2'));
      assert.equal(s.import.skipShown, true);
      assert.equal(s.import.open, false, 'Load closes the window');
      assert.ok(calls.some(([m]) => m === 'project.plan'));
      assert.ok(calls.some(([m]) => m === 'project.load'), 'Load sent project.load');
    });
  });
});
