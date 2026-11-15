// SPDX-License-Identifier: GPL-3.0-or-later
// RareUI redesign, slice 1 (D384): the button styles soft, neumorph, premium, pixel and glass in UButton.qml and the
// Loading Spinner in TaskChip.qml. Part 1 (files, no Qt): credit and SPDX lines, no effect items, every Behavior under
// 400 ms, the contrast pairs hold for every shipped pack with each style chosen. Part 2 (headless probe, offscreen,
// never on a screen; skipped when the studio shell is not built): flag off = no visual change; flag on and each style =
// the probe reports it; on air flips Theme.fx to "plain" and the loop items are gone; calm keeps the look and drops the
// loop; the spinner exists only while a task runs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { writeTaskFile } from '../services/studio-ui/tasks.mjs';
import { failures } from '../services/studio-ui/theme-contrast.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const text = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');
const STYLES = ['soft', 'neumorph', 'premium', 'pixel', 'glass'];
const packFiles = readdirSync(path.join(REPO, 'data', 'themes')).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json');
const packs = packFiles.map((f) => JSON.parse(text('data', 'themes', f)));

describe('slice 1 files: buttons and spinner', () => {
  test('UButton.qml and TaskChip.qml carry the credit and SPDX lines, LF, and use no effect item', () => {
    for (const f of ['UButton.qml', 'TaskChip.qml']) {
      const src = text('app', 'studio', 'qml', f);
      assert.ok(src.startsWith('// SPDX-License-Identifier: GPL-3.0-or-later\n'), f);
      assert.ok(src.includes('Design after RareUI (MIT, Swapnil Kalambe)'), f);
      assert.ok(!src.includes('\r'), `${f} uses LF`);
      assert.ok(!/MultiEffect|ShaderEffect/.test(src.replace(/\/\/.*$/gm, '')), `${f} uses no effect item`);
    }
  });

  test('every Behavior and one-off animation in UButton.qml is under 400 ms; the colour change under the pointer is under 100 ms with the flag on', () => {
    const src = text('app', 'studio', 'qml', 'UButton.qml').replace(/\/\/.*$/gm, '');
    const ms = [...src.matchAll(/duration:\s*(\d+)/g)].map((m) => Number(m[1]));
    // The sweep (2500) is a loop, not an entrance or an exit; everything else is a transition.
    const loops = ms.filter((v) => v >= 400);
    assert.deepEqual(loops, [2500, 3000], 'only the glass sweep and its pause are long');
    assert.match(src, /colorMs: Theme\.rareui \? Math\.min\(Theme\.fast, 90\) : Theme\.fast/);
  });

  test('the loop and the spring live in a Loader or a USpring, so nothing of them exists in plain', () => {
    const src = text('app', 'studio', 'qml', 'UButton.qml');
    assert.match(src, /Loader \{ \/\/ the sweep: only in "full"[\s\S]*?active: b\.full/);
    assert.match(src, /active: b\.look !== ""/, 'every look sits in a Loader that is off for the plain look');
    assert.match(src, /look = ""|return "";/, 'plain fx gives no look');
    assert.match(src, /Theme\.fx === "plain"\) return ""/);
  });

  test('each style is chosen in a pack: the contrast pairs hold for every shipped pack (soft, neumorph, premium, pixel, glass)', () => {
    for (const style of STYLES)
      for (const p of packs) {
        const t = structuredClone(p);
        t.components = { ...(t.components ?? {}), button: { ...(t.components?.button ?? {}), style } };
        const bad = failures(t).filter((x) => /button|label|sweep|shade/.test(x));
        assert.deepEqual(bad, [], `${style} on ${p.id}`);
      }
  });

  test('the spinner styles hold the contrast on the task chip for every pack', () => {
    for (const spinner of ['ring', 'bars', 'dots'])
      for (const p of packs) {
        const t = structuredClone(p);
        t.components = { ...(t.components ?? {}), spinner };
        assert.deepEqual(failures(t).filter((x) => /spinner/.test(x)), [], `${spinner} on ${p.id}`);
      }
  });

  test('the probe output carries fx, the flag, the button style and the spinner style', () => {
    const main = text('app', 'studio', 'qml', 'Main.qml');
    for (const k of ['s.fx = Theme.fx', 's.rareui = Theme.rareui', 's.buttonStyle = Theme.buttonStyle', 's.spinnerStyle = Theme.spinnerStyle']) assert.ok(main.includes(k), k);
    const cpp = text('app', 'studio', 'src', 'qml_studio.cpp');
    assert.ok(cpp.includes('"look", "loop"'), 'the tree exports look and loop');
  });
});

const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('slice 1 in the studio window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  // A copy of Violet Night that picks a button style and a spinner, in its own themes folder.
  const themeDir = (style, spinner = 'ring') => {
    const dir = tmp('ujw-rare1-themes-');
    const t = JSON.parse(text('data', 'themes', 'violet-night.json'));
    t.id = 'rare-one'; t.name = 'Rare one';
    t.components = { button: { style }, spinner };
    writeFileSync(path.join(dir, 'rare-one.json'), JSON.stringify(t));
    return dir;
  };
  // flags: { 'rareui-look': true, 'theme-components': true }; live: 'before' (on air at start) | 'during' (goes live after 4 s).
  async function probe({ style = 'glass', spinner = 'ring', flags = {}, actions = [], live = null, tasks = false, ms = 8000 } = {}) {
    const dataDir = tmp('ujw-rare1-');
    if (tasks) writeTaskFile(dataDir, { id: 'clip-a', kind: 'clips', title: 'Editing clips (3 of 7)', state: 'running', stage: 'render', done: 2, total: 7, startedAt: Date.now() - 5000, updatedAt: Date.now() });
    const fl = createFlags({ dataDir });
    for (const [id, on] of Object.entries(flags)) fl.set(id, on);
    const fake = createFakeHost({ outputsReady: true });
    if (live === 'before') await fake.call('stream.start', {});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'r'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags: fl, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await new Promise((resolve) => {
        const child = spawn(SHELL_EXE, [], {
          windowsHide: true,
          env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1',
            UJWALAM_THEMES_DIR: themeDir(style, spinner), UJWALAM_THEME: 'rare-one',
            QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
            UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 30_000);
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
        if (live === 'during') sleep(3500).then(() => fake.call('stream.start', {}));
      });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      const looks = p.tree.filter((n) => n.name === 'ubuttonBg').map((n) => n.look);
      return { p, s: p.state, looks, loops: p.tree.filter((n) => n.name === 'rareLoop').length, spinners: p.tree.filter((n) => n.name === 'taskSpinner') };
    } finally { await srv.close(); }
  }
  const ON = { 'rareui-look': true, 'theme-components': true };

  test('flag off: no visual change (every button keeps the plain look, no loop, no spinner) although the pack names a style', async () => {
    const r = await probe({ style: 'glass', flags: {}, tasks: true });
    assert.equal(r.s.rareui, false);
    assert.equal(r.s.buttonStyle, '');
    assert.ok(r.looks.length > 0, 'buttons are in the tree');
    assert.ok(r.looks.every((l) => l === ''), [...new Set(r.looks)].join(','));
    assert.equal(r.loops, 0);
    assert.equal(r.spinners.length, 0, 'no spinner with the flag off even with a task running');
    assert.equal(r.s.tasks.running, 1);
  });

  test('rareui-look on but theme-components off: the pack styles stay unread, so the look does not change', async () => {
    const r = await probe({ style: 'glass', flags: { 'rareui-look': true } });
    assert.equal(r.s.rareui, true);
    assert.equal(r.s.buttonStyle, '');
    assert.ok(r.looks.every((l) => l === ''));
    assert.equal(r.loops, 0);
  });

  for (const style of STYLES) {
    test(`flag on and style ${style}: the probe reports it, fx is full${style === 'glass' ? ', the sweep loop exists' : ', no loop'}`, async () => {
      const r = await probe({ style, flags: ON });
      assert.deepEqual([r.s.rareui, r.s.fx, r.s.buttonStyle], [true, 'full', style]);
      assert.ok(r.looks.includes(style), `a button draws ${style}: ${[...new Set(r.looks)].join(',')}`);
      if (style === 'glass') assert.ok(r.loops > 0, 'the glass sweep runs in full');
      else assert.equal(r.loops, 0);
    });
  }

  test('a style the pack names that is not drawn yet (liquid) keeps the plain look', async () => {
    const r = await probe({ style: 'liquid', flags: ON });
    assert.equal(r.s.buttonStyle, 'liquid');
    assert.ok(r.looks.every((l) => l === ''));
  });

  test('calm (reduced effects) keeps the styled look still: the glass look is drawn and the sweep loop is gone', async () => {
    const r = await probe({ style: 'glass', flags: ON, actions: ['effects:reduced'], ms: 12000 });
    assert.equal(r.s.fx, 'calm');
    assert.ok(r.looks.includes('glass'));
    assert.equal(r.loops, 0);
  });

  test('High performance is plain: the plain look, no loop', async () => {
    const r = await probe({ style: 'glass', flags: ON, actions: ['effects:performance'], ms: 12000 });
    assert.equal(r.s.fx, 'plain');
    assert.ok(r.looks.every((l) => l === ''));
    assert.equal(r.loops, 0);
  });

  test('on air at start: fx is plain, the buttons are plain and no loop exists', async () => {
    const r = await probe({ style: 'glass', flags: ON, live: 'before' });
    assert.equal(r.s.live, true);
    assert.equal(r.s.fx, 'plain');
    assert.ok(r.looks.every((l) => l === ''));
    assert.equal(r.loops, 0);
  });

  test('going live while the window runs flips fx to plain and the loop items go', async () => {
    const r = await probe({ style: 'glass', flags: ON, live: 'during', ms: 11000 });
    assert.equal(r.s.live, true);
    assert.equal(r.s.fx, 'plain');
    assert.equal(r.loops, 0, 'the sweep was removed when the stream went live');
    assert.ok(r.looks.every((l) => l === ''));
  });

  test('spinner: present only while a task runs (flag on); the style comes from the pack; it keeps running on air', async () => {
    const idle = await probe({ flags: ON, spinner: 'ring' });
    assert.equal(idle.spinners.length, 0, 'no task, no spinner');
    for (const sp of ['ring', 'bars', 'dots']) {
      const r = await probe({ flags: ON, spinner: sp, tasks: true });
      assert.equal(r.s.spinnerStyle, sp);
      assert.equal(r.s.tasks.running, 1);
      assert.deepEqual(r.spinners.map((n) => n.style ?? n.type).length, 1, sp);
      assert.equal(r.p.tree.find((n) => n.name === 'taskSpinner').loop, true);
    }
    const air = await probe({ flags: ON, spinner: 'ring', tasks: true, live: 'before' });
    assert.equal(air.s.fx, 'plain');
    assert.equal(air.spinners.length, 1, 'a status light: it runs on air at its normal rate');
  });
});
