// SPDX-License-Identifier: GPL-3.0-or-later
// Growth numbers window in the QML studio (AN1b, D372; plan Q4, twin of studio-qt-growth): a real UI server, the fake
// host, a fake Google, a seeded analytics.db with placeholder videos in a temp data dir. Flag growth off (default): no
// palette entry, the window says it is switched off. On: the palette entry shows, the table lists the videos with their
// 24 h checkpoint, a header click sorts, Refresh within the hour is skipped with a plain note and "Refresh now" shows;
// not signed in: a clear note and Refresh disabled. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen).
// Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { DB_NAME, openStore } from '../services/analytics/index.mjs';
import { ANALYTICS_SCOPE, READONLY_SCOPE, SCOPE } from '../services/posting/oauth.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const NOW = Date.parse('2026-11-13T10:30:00Z');

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

function seed(dataDir) {
  const st = openStore(path.join(dataDir, DB_NAME));
  st.upsertVideo({ videoId: 'vidA', postId: 'p1', kind: 'montage', clipId: 'C01', title: 'Sample montage A', uploadedAt: '2026-11-10T10:00:00Z' });
  st.setState('vidA', 'public', '2026-11-11T12:00:00Z');
  st.addSnapshot({ videoId: 'vidA', fetchedAt: '2026-11-12T12:30:00.000Z', ageHours: 24.5, data: { views: 100, likes: 8 }, analytics: { views: 98, likes: 8, averageViewPercentage: 61.2, shares: 3, subscribersGained: 2 } });
  st.addSnapshot({ videoId: 'vidA', fetchedAt: '2026-11-13T10:00:00.000Z', ageHours: 46, data: { views: 150, likes: 12 }, analytics: { views: 148, likes: 12, averageViewPercentage: 58.4, shares: 4, subscribersGained: 3 } });
  st.upsertVideo({ videoId: 'vidB', postId: 'p2', kind: 'won-reel', clipId: 'C02', title: 'Sample reel B', uploadedAt: '2026-11-12T10:00:00Z' });
  st.setState('vidB', 'public', '2026-11-12T20:00:00Z');
  st.addSnapshot({ videoId: 'vidB', fetchedAt: '2026-11-13T10:00:00.000Z', ageHours: 14, data: { views: 40, likes: 5 }, analytics: null });
  st.close();
}

describe('QML studio: Growth numbers window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ flagOn, signedIn = true, seeded = true, actions, ms = Math.max(7000, 3000 + actions.length * 700) }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlgr-')); dirs.push(dataDir);
    if (seeded) seed(dataDir);
    const flags = createFlags({ dataDir });
    if (flagOn) flags.set('growth', true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'g'.repeat(40);
    let fetches = 0;
    const growth = {
      auth: { status: async () => ({ signedIn, hasClient: true }), grantedScopes: async () => [SCOPE, READONLY_SCOPE, ANALYTICS_SCOPE], accessToken: async () => 'tok' },
      fetchImpl: async () => { fetches += 1; throw new Error('no network in tests'); },
    };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), now: () => NOW, growth, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, g: p.state.growth, s: p.state, fetches };
    } finally { await srv.close(); }
  }
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));

  test('flag off: no palette entry, and the window says it is switched off', async () => {
    const { g, s } = await probe({ flagOn: false, seeded: false, actions: ['growth-open', 'palette-open'] });
    assert.equal(g.open, true);
    assert.equal(g.rows, 0);
    assert.match(g.info, /switched off/);
    assert.equal(g.refreshEnabled, false);
    assert.ok(!s.palette.items.includes('Growth numbers'), 'no palette entry while the flag is off');
  });

  test('flag on: palette entry, the videos with their numbers and checkpoints, Refresh within the hour is skipped', async () => {
    const { g, s, p, fetches } = await probe({ flagOn: true, actions: ['palette-open', 'palette-type:growth', 'palette-run', 'growth-refresh'] });
    assert.equal(done(p)['palette-run'], true, 'the palette opened the window');
    assert.equal(g.open, true);
    assert.equal(g.rows, 2);
    const byTitle = Object.fromEntries(g.cells.map((c) => [c[0], c]));
    const a = byTitle['Sample montage A'];
    assert.equal(a[1], 'Montage');
    assert.deepEqual(a.slice(3, 8), ['148', '12', '58.4', '4', '3'], 'latest views, likes, avg viewed %, shares, subs');
    assert.match(a[8], /98 views, 8 likes, 61\.2% viewed, \+2 subs/, 'the 24 h checkpoint');
    assert.equal(a[9], 'not reached yet');
    const b = byTitle['Sample reel B'];
    assert.equal(b[1], 'Won-round reel');
    assert.deepEqual(b.slice(3, 8), ['40', '5', '-', '-', '-'], 'no statistics yet: dashes, not zeros');
    assert.match(g.fetched, /Last read from YouTube/);
    assert.match(g.info, /less than an hour ago/);
    assert.equal(g.forceVisible, true, '"Refresh now" offered after a skipped refresh');
    assert.equal(fetches, 0, 'the skipped refresh made no call to Google');
    assert.equal(s.palette.open, false);
  });

  test('a header click sorts by that column; again sorts the other way; "-" sorts below every number', async () => {
    let r = await probe({ flagOn: true, actions: ['growth-open', 'growth-sort:3'] });
    assert.deepEqual(r.g.cells.map((c) => c[0]), ['Sample reel B', 'Sample montage A'], 'views up: 40 then 148');
    r = await probe({ flagOn: true, actions: ['growth-open', 'growth-sort:5', 'growth-sort:5'] });
    assert.deepEqual(r.g.cells.map((c) => c[0]), ['Sample montage A', 'Sample reel B'], 'avg viewed down: 58.4 then "-"');
    r = await probe({ flagOn: true, actions: ['growth-open', 'growth-sort:10'] });
    assert.equal(done(r.p)['growth-sort:10'], false, 'no such column');
  });

  test('flag on, not signed in: a plain note and Refresh disabled', async () => {
    const { g, p } = await probe({ flagOn: true, signedIn: false, seeded: false, actions: ['growth-open', 'growth-refresh'] });
    assert.equal(g.rows, 0);
    assert.match(g.info, /Not signed in to YouTube/);
    assert.equal(g.refreshEnabled, false);
    assert.equal(done(p)['growth-refresh'], false);
  });

  test('flag on, signed in, nothing posted: the empty state points to the Posts window; actions refused while closed', async () => {
    const { g, p } = await probe({ flagOn: true, seeded: false, actions: ['growth-refresh', 'growth-open'] });
    assert.equal(done(p)['growth-refresh'], false, 'closed: refused');
    assert.match(g.info, /No posted videos yet/);
    assert.equal(g.refreshEnabled, true);
  });
});
