// SPDX-License-Identifier: GPL-3.0-or-later
// QML studio tips, tours and help (plan Q4 E; D294 proposed): the QML twin of the guide tests in studio-qt-shell.test.mjs
// (same probe names: guide-tour:*, guide-hint:*, guide-help:*, guide-settings:*), plus the ? button and the help panel
// keeping clear of the previews. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI
// server (data/guide text) and the fake host. Skipped when the shell is not built (npm run build:studio).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
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

describe('QML studio: tips, tours and help (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(6000, 3500 + actions.length * 600), flagsOn = [], guide = null, env = {} } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-guide-')); dirs.push(dataDir);
    if (guide) writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ui: { guide } }));
    const flags = createFlags({ dataDir });
    for (const id of flagsOn) flags.set(id, true);
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'g'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, g: p.state.guide, s: p.state, dataDir };
    } finally { await srv.close(); }
  }
  const settingsOf = (dir) => JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const guideFile = (dir) => { try { return settingsOf(dir).ui?.guide; } catch { return undefined; } };
  const done = (p) => p.actions.map((a) => [a.action, a.done]);
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const box = (r) => ({ x: r[0], y: r[1], w: r[2], h: r[3] });

  test('guide: text and choices load; the window has its named parts and the ? button; nothing starts by itself on a window that is not shown', async () => {
    const { g, p } = await probe();
    assert.equal(g.ready, true);
    assert.deepEqual(g.tours, ['welcome', 'clips', 'posting']);
    assert.equal(g.hintDefs, 6);
    assert.deepEqual([g.tips, g.tourDone, g.dismissed], [true, false, []]);
    assert.equal(g.coach.active, false);
    assert.equal(g.help.open, false);
    assert.equal(g.hint.showing, false, 'no tip at start: the previews the window opens are not a job');
    for (const a of ['scenes', 'layers', 'previewH', 'previewV', 'mixer', 'ctlStream', 'ctlRecord', 'ctlClip', 'ctlMark', 'chips', 'chipClips', 'taskChip', 'myClips', 'settings', 'more', 'help', 'layerAdd', 'sceneAdd']) assert.ok(g.anchors.includes(a), a);
    const help = node(p, 'helpBtn');
    assert.deepEqual([help.text, help.visible, help.enabled], ['?', true, true]);
    assert.ok(node(p, 'moreBtn').rect[0] < help.rect[0] && help.rect[0] < node(p, 'settingsBtn').rect[0], 'More, ?, Settings in the top bar');
  });

  test('guide: the welcome tour starts, steps forward and back, and skips a step whose part is not shown', async () => {
    const { p, g } = await probe({ actions: ['guide-tour:start', 'guide-tour:next', 'guide-tour:next', 'guide-tour:back'] });
    assert.deepEqual(done(p), [['guide-tour:start', true], ['guide-tour:next', true], ['guide-tour:next', true], ['guide-tour:back', true]]);
    const c = g.coach;
    assert.deepEqual([c.active, c.tour, c.step, c.stepId], [true, 'welcome', 2, 'layers'], 'forward twice, back once');
    assert.ok(c.of >= 12 && c.of < 16, `steps shown: ${c.of} (Look is hidden with no layer selected)`);
    assert.equal(c.count, `STEP 2 OF ${c.of}`);
    assert.equal(c.neverOffered, true);
    assert.ok(c.hole.w > 5 && c.hole.h > 5, 'a lit hole round the step');
    const layers = node(p, 'layersPanel').rect;
    [c.hole.x, c.hole.y, c.hole.w, c.hole.h].forEach((v, i) => assert.ok(Math.abs(v - layers[i]) <= 1, `round the layers panel: ${JSON.stringify(c.hole)} vs ${layers}`));
  });

  test('guide: the whole welcome tour, to Done, marks it done in settings.json; the card never covers its part', async () => {
    const { p, g, dataDir } = await probe({ actions: ['guide-tour:start', ...Array(17).fill('guide-tour:next')], ms: 16000 });
    assert.equal(p.actions[0].done, true);
    assert.equal(g.coach.active, false, 'the last Done closes it');
    assert.deepEqual(g.coach.overlaps, [], 'on no step does the card cover the part it points at');
    assert.equal(guideFile(dataDir).tourDone, true);
    assert.equal(g.tourDone, true);
  });

  test('guide: Skip with the box ticked is remembered; Close without it is not', async () => {
    const a = await probe({ actions: ['guide-tour:start', 'guide-tour:tick', 'guide-tour:skip'] });
    assert.deepEqual(done(a.p), [['guide-tour:start', true], ['guide-tour:tick', true], ['guide-tour:skip', true]]);
    assert.equal(a.g.coach.active, false);
    assert.equal(guideFile(a.dataDir).tourDone, true);
    const b = await probe({ actions: ['guide-tour:start', 'guide-tour:close'] });
    assert.equal(b.g.coach.active, false);
    assert.equal(b.g.tourDone, false);
    assert.equal(guideFile(b.dataDir), undefined, 'nothing written: it comes back next time');
  });

  test('guide: a focused tour (clips) runs on the related controls and does not touch the welcome choice', async () => {
    const { g } = await probe({ actions: ['guide-tour:start:clips', 'guide-tour:next', 'guide-tour:next', 'guide-tour:next', 'guide-tour:next', 'guide-tour:next'] });
    const c = g.coach;
    assert.deepEqual([c.tour, c.of, c.step, c.next, c.neverOffered], ['clips', 6, 6, 'Done', false]);
    assert.equal(c.anchor, 'settings');
    assert.deepEqual(c.overlaps, [], 'the card never covers its target');
    assert.equal(g.tourDone, false);
  });

  test('guide: the ? button opens help with its two sections, clear of the previews; Show me runs the related tour; Replay runs the welcome tour', async () => {
    const o = await probe({ flagsOn: ['posting'], actions: ['click:helpBtn'] });
    assert.deepEqual(done(o.p), [['click:helpBtn', true]]);
    assert.equal(o.g.help.open, true);
    assert.deepEqual(o.g.help.sections, ['How clips are made', 'Posting your clips']);
    assert.match(o.g.help.facts, /posting is ON, automatic posting is OFF/);
    const panel = box(node(o.p, 'guideHelp').rect);
    for (const n of ['previewH', 'previewV']) assert.ok(!inter(panel, box(node(o.p, n).rect)), `help clear of ${n}`);
    const s = await probe({ actions: ['guide-help:open', 'guide-help:show-posting'] });
    assert.equal(s.g.help.open, false, 'the panel closes to show the controls');
    assert.deepEqual([s.g.coach.active, s.g.coach.tour], [true, 'posting']);
    assert.match(s.g.help.facts, /posting is OFF, automatic posting is OFF/);
    const r = await probe({ actions: ['guide-help:open', 'guide-help:replay'] });
    assert.deepEqual([r.g.coach.active, r.g.coach.tour, r.g.help.open], [true, 'welcome', false]);
  });

  test('guide: a hint shows once its thing happens; the box saves "do not show again" and it stays away, also in the next run', async () => {
    const a = await probe({ actions: ['guide-hint:went-live', 'guide-hint:tick-gotit', 'guide-hint:went-live'] });
    assert.deepEqual(done(a.p), [['guide-hint:went-live', true], ['guide-hint:tick-gotit', true], ['guide-hint:went-live', false]]);
    assert.equal(a.g.hint.showing, false);
    assert.deepEqual(guideFile(a.dataDir).dismissed, ['went-live']);
    const again = await probe({ actions: ['guide-hint:went-live'], guide: { dismissed: ['went-live'] } });
    assert.deepEqual(done(again.p), [['guide-hint:went-live', false]], 'dismissed for good');
    assert.equal(again.g.hint.seen, 0);
  });

  test('guide: a hint closed without the box is not saved; only one hint at a time; none while a tour runs; it points at its part', async () => {
    const { p, g, dataDir } = await probe({ actions: ['guide-hint:went-live', 'guide-hint:clip-run-started', 'guide-hint:close', 'guide-tour:start', 'guide-hint:clip-run-started'] });
    assert.deepEqual(done(p), [['guide-hint:went-live', true], ['guide-hint:clip-run-started', false], ['guide-hint:close', true], ['guide-tour:start', true], ['guide-hint:clip-run-started', false]]);
    assert.equal(guideFile(dataDir)?.dismissed?.length ?? 0, 0);
    assert.equal(g.hint.seen, 1);
    const h = await probe({ actions: ['guide-hint:went-live'] });
    assert.deepEqual([h.g.hint.showing, h.g.hint.anchor], [true, 'ctlStream']);
    assert.ok(!inter(box(node(h.p, 'guideHint').rect), box(node(h.p, 'streamBtn').rect)), 'next to Go live, not over it');
    assert.notEqual(h.g.hint.arrow, '', 'with its arrow');
  });

  test('guide: a hint hides itself after its time (UJWALAM_GUIDE_HINT_MS stands in for 8 s) and is not saved', async () => {
    const { p, g, dataDir } = await probe({ actions: ['guide-hint:went-live'], env: { UJWALAM_GUIDE_HINT_MS: '400' } });
    assert.equal(p.actions[0].done, true);
    assert.equal(g.hint.seen, 1);
    assert.equal(g.hint.showing, false, 'gone by itself');
    assert.equal(guideFile(dataDir), undefined);
  });

  test('guide: tips off in Settings stops hints and is saved; Reset clears the dismissed list and the tour choice', async () => {
    const off = await probe({ actions: ['settings-open', 'settings-page:Help%20%26%20tips', 'guide-settings:tips-off', 'guide-hint:went-live'], ms: 8000 });
    assert.deepEqual(done(off.p), [['settings-open', true], ['settings-page:Help%20%26%20tips', true], ['guide-settings:tips-off', true], ['guide-hint:went-live', false]]);
    assert.equal(guideFile(off.dataDir).tips, false);
    assert.equal(off.g.tips, false);
    const reset = await probe({ actions: ['settings-open', 'settings-page:Help%20%26%20tips', 'guide-settings:reset', 'guide-hint:went-live'], ms: 8000,
      guide: { dismissed: ['went-live', 'first-task'], tourDone: true, tips: true } });
    assert.deepEqual(done(reset.p).map(([, d]) => d), [true, true, true, true]);
    assert.deepEqual(guideFile(reset.dataDir), { tips: true, dismissed: [], tourDone: false });
    assert.equal(reset.g.hint.id, 'went-live', 'shows again after the reset');
  });

  test('guide: Settings > Help & tips: Replay closes Settings and starts the tour; a finished tour shows there as done', async () => {
    const { s, g } = await probe({ actions: ['settings-open', 'settings-page:Help%20%26%20tips', 'guide-settings:replay'], ms: 8000, guide: { tourDone: true } });
    assert.equal(s.flagsInSettings, false, 'Settings closed');
    assert.deepEqual([g.coach.active, g.coach.tour], [true, 'welcome']);
  });
});
