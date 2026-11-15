// SPDX-License-Identifier: GPL-3.0-or-later
// RareUI redesign, slice 2 (D384): the tab styles slide (Animated Tab, the Settings page list), dock (Floating Navigation, the
// top bar's More / ? / Settings) and avatar (Toast Tabs, the theme picker). Part 1 (files, no Qt): credit and SPDX lines, no
// effect items, every animation under 400 ms, the contrast pairs hold for every shipped pack with each style chosen. Part 2
// (headless probe, offscreen, never on a screen; skipped when the studio shell is not built): flag off = no change; each style
// reported; calm keeps the look and plain (on air, High performance) drops it; no loop item anywhere; switching the Settings
// pages with the mouse still works with the slide look.
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
import { failures } from '../services/studio-ui/theme-contrast.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const text = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');
const STYLES = ['slide', 'dock', 'avatar'];
const LOOK_NAME = { slide: 'tabLook:settings', dock: 'tabLook:dock', avatar: 'tabLook:avatar' };
const packFiles = readdirSync(path.join(REPO, 'data', 'themes')).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json');
const packs = packFiles.map((f) => JSON.parse(text('data', 'themes', f)));

describe('slice 2 files: tabs', () => {
  const QML = ['NavPill.qml', 'OnAirBar.qml', 'SettingsDialog.qml', 'SettingsAppearance.qml'];
  test('the files that port a RareUI design carry the credit line; SPDX first; LF; no effect item', () => {
    for (const f of QML) {
      const src = text('app', 'studio', 'qml', f);
      assert.ok(src.startsWith('// SPDX-License-Identifier: GPL-3.0-or-later\n'), f);
      assert.ok(src.includes('Design after RareUI (MIT, Swapnil Kalambe)') || src.includes('RareUI, MIT, Swapnil Kalambe'), `${f} credit`);
      assert.ok(!src.includes('\r'), `${f} uses LF`);
      assert.ok(!/MultiEffect|ShaderEffect/.test(src.replace(/\/\/.*$/gm, '')), `${f} uses no effect item`);
    }
  });

  test('no system font name; every animation duration is under 400 ms; no looping animation', () => {
    for (const f of QML) {
      const src = text('app', 'studio', 'qml', f).replace(/\/\/.*$/gm, '');
      assert.ok(!/Consolas|Corbel/.test(src), f);
      for (const m of src.matchAll(/duration:\s*(\d+)/g)) assert.ok(Number(m[1]) < 400, `${f} duration ${m[1]}`);
      assert.ok(!/Animation\.Infinite/.test(src), `${f} has no loop`);
    }
    assert.match(text('app', 'studio', 'qml', 'NavPill.qml'), /fadeMs: 90/);
  });

  test('every look sits behind Theme.rareui and Theme.fx; plain is the old look', () => {
    for (const [f, style] of [['SettingsDialog.qml', 'slide'], ['OnAirBar.qml', 'dock'], ['SettingsAppearance.qml', 'avatar']]) {
      const src = text('app', 'studio', 'qml', f);
      assert.ok(src.includes(`Theme.rareui && Theme.fx !== "plain" && Theme.tabsStyle === "${style}"`), `${f} gate`);
    }
    assert.match(text('app', 'studio', 'qml', 'UButton.qml'), /bare \|\| !Theme\.rareui/);
  });

  test('Theme.tabsStyle is exposed like buttonStyle and the probe state carries it', () => {
    assert.match(text('app', 'studio', 'src', 'qml_bridge.h'), /Q_PROPERTY\(QString tabsStyle READ tabsStyle NOTIFY lookChanged\)/);
    assert.match(text('app', 'studio', 'src', 'qml_bridge.cpp'), /tabsStyle\(\) const \{ return rareui_ \? theme::component\(QStringLiteral\("tabs"\)\)/);
    assert.ok(text('app', 'studio', 'qml', 'Main.qml').includes('s.tabsStyle = Theme.tabsStyle'));
    assert.ok(text('app', 'studio', 'CMakeLists.txt').includes('qml/NavPill.qml'));
  });

  test('each style is chosen in a pack: the contrast pairs hold for every shipped pack (slide, dock, avatar)', () => {
    for (const style of STYLES)
      for (const p of packs) {
        const t = structuredClone(p);
        t.components = { ...(t.components ?? {}), tabs: style };
        assert.deepEqual(failures(t).filter((x) => /tab|dock|avatar|slide/.test(x)), [], `${style} on ${p.id}`);
      }
  });
});

const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('slice 2 in the studio window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  // A copy of Violet Night that picks a tab style, in its own themes folder.
  const themeDir = (tabs) => {
    const dir = tmp('ujw-rare2-themes-');
    const t = JSON.parse(text('data', 'themes', 'violet-night.json'));
    t.id = 'rare-two'; t.name = 'Rare two';
    t.components = { tabs };
    writeFileSync(path.join(dir, 'rare-two.json'), JSON.stringify(t));
    return dir;
  };
  // live: 'before' (on air at start) | 'during' (goes live after 3.5 s).
  async function probe({ style = 'slide', flags = {}, actions = [], live = null, ms = 9000 } = {}) {
    const dataDir = tmp('ujw-rare2-');
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
            UJWALAM_THEMES_DIR: themeDir(style), UJWALAM_THEME: 'rare-two',
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
      const looks = Object.fromEntries(p.tree.filter((n) => /^tabLook:/.test(n.name)).map((n) => [n.name, n.look]));
      return { p, s: p.state, looks, loops: p.tree.filter((n) => n.name === 'rareLoop' || n.loop === true).length };
    } finally { await srv.close(); }
  }
  const ON = { 'rareui-look': true, 'theme-components': true };
  const OPEN = ['settings-open', 'settings-page:Appearance'];

  test('flag off: no change (every tab look is empty) although the pack names a style', async () => {
    const r = await probe({ style: 'slide', flags: {}, actions: OPEN });
    assert.equal(r.s.rareui, false);
    assert.equal(r.s.tabsStyle, '');
    assert.ok(Object.keys(r.looks).length >= 2, `the tab items are in the tree: ${Object.keys(r.looks)}`);
    assert.ok(Object.values(r.looks).every((l) => l === ''), JSON.stringify(r.looks));
    assert.equal(r.loops, 0);
  });

  test('rareui-look on, theme-components off: the pack style stays unread', async () => {
    const r = await probe({ style: 'dock', flags: { 'rareui-look': true }, actions: OPEN });
    assert.equal(r.s.tabsStyle, '');
    assert.ok(Object.values(r.looks).every((l) => l === ''));
  });

  for (const style of STYLES) {
    test(`flag on and style ${style}: the probe reports it in its place only, fx is full, no loop item`, async () => {
      const r = await probe({ style, flags: ON, actions: OPEN });
      assert.deepEqual([r.s.rareui, r.s.fx, r.s.tabsStyle], [true, 'full', style]);
      assert.equal(r.looks[LOOK_NAME[style]], style);
      for (const [name, look] of Object.entries(r.looks)) if (name !== LOOK_NAME[style]) assert.equal(look, '', name);
      assert.equal(r.loops, 0, 'springs stop at rest; nothing loops');
    });
  }

  test('a style the studio does not draw (underline) keeps every look empty', async () => {
    const r = await probe({ style: 'underline', flags: ON, actions: OPEN });
    assert.equal(r.s.tabsStyle, 'underline');
    assert.ok(Object.values(r.looks).every((l) => l === ''));
  });

  test('calm (reduced effects) keeps the styled look: slide is still reported', async () => {
    const r = await probe({ style: 'slide', flags: ON, actions: [...OPEN, 'effects:reduced'], ms: 12000 });
    assert.equal(r.s.fx, 'calm');
    assert.equal(r.looks['tabLook:settings'], 'slide');
    assert.equal(r.loops, 0);
  });

  test('High performance is plain: every look is empty', async () => {
    for (const style of STYLES) {
      const r = await probe({ style, flags: ON, actions: [...OPEN, 'effects:performance'], ms: 12000 });
      assert.equal(r.s.fx, 'plain');
      assert.ok(Object.values(r.looks).every((l) => l === ''), `${style}: ${JSON.stringify(r.looks)}`);
      assert.equal(r.loops, 0);
    }
  });

  test('on air at start: plain, no tab look, no loop', async () => {
    const r = await probe({ style: 'dock', flags: ON, live: 'before', actions: OPEN });
    assert.equal(r.s.live, true);
    assert.equal(r.s.fx, 'plain');
    assert.ok(Object.values(r.looks).every((l) => l === ''));
    assert.equal(r.loops, 0);
  });

  test('going live while the window runs drops the dock look', async () => {
    const r = await probe({ style: 'dock', flags: ON, live: 'during', ms: 11000 });
    assert.equal(r.s.live, true);
    assert.equal(r.s.fx, 'plain');
    assert.equal(r.looks['tabLook:dock'], '');
  });

  test('mouse and probe switching of the Settings pages still works with the slide look', async () => {
    const r = await probe({ style: 'slide', flags: ON, actions: ['settings-open', 'click:nav:Transitions', 'settings-page:Preview'], ms: 11000 });
    assert.equal(r.looks['tabLook:settings'], 'slide');
    assert.equal(r.s.settings.page, 'Preview');
    const c = await probe({ style: 'slide', flags: ON, actions: ['settings-open', 'click:nav:Transitions'], ms: 11000 });
    assert.equal(c.s.settings.page, 'Transitions', 'a click on a page button moves to it');
  });

  test('the avatar look: the theme cards stay clickable and the bubble exists', async () => {
    // A click on another pack's card switches the theme live (and so its tab style); the pack in use is clicked here.
    const r = await probe({ style: 'avatar', flags: ON, actions: [...OPEN, 'click:themeCard:rare-two'], ms: 11000 });
    assert.equal(r.looks['tabLook:avatar'], 'avatar');
    assert.ok(r.p.tree.some((n) => n.name === 'themeCard:rare-two'));
    assert.ok(r.p.tree.some((n) => n.name === 'themeCard:retro-wave'));
    assert.ok(r.p.tree.some((n) => n.name === 'avatarBubble'));
  });
});
