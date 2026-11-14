// SPDX-License-Identifier: GPL-3.0-or-later
// Command palette in the QML studio (plan Q4): Ctrl+K opens a search over every studio command (scenes, go live, record,
// add a scene or layer, every Settings page). Each command calls the same Store function as its button. Headless probe
// (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI server and the fake host. Probe actions:
// palette-open, palette-type:<text>, palette-down, palette-up, palette-run, palette-close. Skipped when the shell is not built.
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
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio command palette (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(6000, 3000 + actions.length * 700), flagIds = [] } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlpal-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of flagIds) flags.set(id, true);
    const fake = createFakeHost({ outputsReady: true });
    const calls = [];
    const host = { describe: () => fake.describe(), call: (m, p) => { calls.push(m); return fake.call(m, p); } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'p'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, pal: p.state.palette, calls };
    } finally { await srv.close(); }
  }
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const type = (t) => `palette-type:${encodeURIComponent(t)}`;

  test('opens with every command: the scenes (the one on now marked), go live, record, add, every Settings page', async () => {
    const { pal, p } = await probe({ actions: ['palette-open'] });
    assert.equal(pal.open, true);
    assert.equal(pal.query, '');
    assert.ok(pal.items.includes('Switch to scene: Gameplay (on now)'), pal.items.join(' | '));
    assert.ok(pal.items.includes('Switch to scene: Starting soon'));
    for (const t of ['Go live', 'Start recording', 'Add a scene', 'Add a layer to this scene', 'Settings: Appearance', 'Settings: Transitions', 'Settings: Advanced'])
      assert.ok(pal.items.includes(t), `${t} in ${pal.items.join(' | ')}`);
    assert.ok(node(p, 'paletteSearch'), 'the search box is in the tree');
    assert.equal(pal.index, 0);
  });

  test('typing filters by every word in any order; Enter switches the scene through the same route as its button', async () => {
    const { pal, s, p } = await probe({ actions: ['palette-open', type('soon start'), 'palette-run', 'palette-open'] });
    const d = done(p);
    assert.equal(d['palette-run'], true);
    assert.equal(s.activeScene, 'scene-2');
    assert.ok(pal.items.includes('Switch to scene: Starting soon (on now)'), 'reopened: the new scene is marked');
  });

  test('a Settings command opens Settings on that page', async () => {
    const { s, pal } = await probe({ actions: ['palette-open', type('stinger'), 'palette-run'] });
    assert.equal(pal.open, false, 'the palette closed');
    assert.equal(s.flagsInSettings, true, 'Settings is open');
    assert.equal(s.settings.page, 'Transitions', 'found by the page words, not only the title');
  });

  test('record runs the host action of the Record button', async () => {
    const { calls, pal } = await probe({ actions: ['palette-open', type('record'), 'palette-run'] });
    assert.equal(pal.open, false);
    assert.ok(calls.includes('record.start'), calls.join(','));
  });

  test('Up and Down move the pick and wrap; nothing matching says so and runs nothing', async () => {
    let r = await probe({ actions: ['palette-open', type('scene'), 'palette-up'] });
    assert.ok(r.pal.items.length >= 3);
    assert.equal(r.pal.index, r.pal.items.length - 1, 'Up from the first wraps to the last');
    r = await probe({ actions: ['palette-open', type('zzz nothing'), 'palette-run'] });
    assert.equal(done(r.p)['palette-run'], false);
    assert.equal(r.pal.open, true);
    assert.deepEqual(r.pal.items, []);
    assert.match(node(r.p, 'paletteEmpty').text, /^No command matches "zzz nothing"\.$/);
    assert.equal(node(r.p, 'paletteEmpty').visible, true);
  });

  test('scene keys (D382): off by default; on, Ctrl+N switches to the Nth scene and the palette shows each key', async () => {
    let r = await probe({ actions: ['scene-key:2'] });
    assert.equal(done(r.p)['scene-key:2'], false, 'flag off: the key does nothing');
    assert.equal(r.s.activeScene, 'scene-1');
    r = await probe({ actions: ['scene-key:2', 'scene-key:9', 'palette-open'], flagIds: ['scene-hotkeys'] });
    const d = done(r.p);
    assert.equal(d['scene-key:2'], true);
    assert.equal(d['scene-key:9'], false, 'no 9th scene: nothing happens');
    assert.equal(r.s.activeScene, 'scene-2');
    assert.ok(r.pal.items.includes('Switch to scene: Gameplay   Ctrl+1'), r.pal.items.join(' | '));
    assert.ok(r.pal.items.includes('Switch to scene: Starting soon (on now)   Ctrl+2'));
  });

  test('palette actions are refused while it is closed; Escape-close leaves the studio as it was', async () => {
    const { p, pal, s } = await probe({ actions: [type('x'), 'palette-run', 'palette-open', 'palette-close'] });
    const d = done(p);
    assert.equal(d[type('x')], false);
    assert.equal(d['palette-run'], false);
    assert.equal(pal.open, false);
    assert.equal(s.activeScene, 'scene-1');
  });
});
