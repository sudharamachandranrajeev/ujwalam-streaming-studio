// SPDX-License-Identifier: GPL-3.0-or-later
// Dialogs made on first use in the QML studio (LazyDialog, start-up time 2026-11-19): none is made at start, each is made
// on the first call that needs it and then reused. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen)
// against a real UI server and the fake host; the probe lists which dialogs were made before it was read (lazyMade).
// Skipped when the shell is not built.
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
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio dialogs made on first use (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(6000, 3000 + actions.length * 700), flagIds = [] } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmllazy-')); dirs.push(dataDir);
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
  test('no dialog is made at start: the window paints without them (start-up time 2026-11-19)', async () => {
    const { s } = await probe();
    assert.deepEqual(s.lazyMade, []);
  });

  test('a dialog is made on its first use, and only that one (the palette lists the Settings pages, so Settings too)', async () => {
    const { s, pal } = await probe({ actions: ['palette-open'] });
    assert.equal(pal.open, true);
    assert.deepEqual([...s.lazyMade].sort(), ['palette', 'settings']);
  });

  test('a dialog made on first use works as before: More > Feedback opens it, and the probe reads that same window', async () => {
    const { s, p } = await probe({ actions: ['palette-open', `palette-type:${encodeURIComponent('feedback notes')}`, 'palette-run'] });
    assert.equal(Object.fromEntries(p.actions.map((a) => [a.action, a.done]))['palette-run'], true);
    assert.ok(s.lazyMade.includes('feedback'), s.lazyMade.join(','));
    assert.equal(s.lazyMade.includes('youtube'), false);
    assert.equal(s.feedback.open, true, JSON.stringify(s.feedback));
  });
});
