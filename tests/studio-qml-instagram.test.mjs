// SPDX-License-Identifier: GPL-3.0-or-later
// D444 IP3: Settings > Posting & growth > INSTAGRAM REELS in the QML studio (headless probe, UJWALAM_HEADLESS=1, never on a
// screen) against a real UI server with a fake Instagram auth (no network, never Meta). Skipped when the shell is not built.
// Actions: ap-ig-appid, ap-ig-secret, ap-ig-save, ap-ig-connect, ap-ig-disconnect, ap-ig-flag.
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
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const NOW = Date.parse('2026-11-13T10:00:00Z');
const GRID = { tierOffsets: [0, 15, 30, 45], gridGapMinutes: 15, readReuseMinutes: 120 }; // D434 shipped

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

describe('QML studio Settings > Posting & growth > Instagram Reels (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), flagIds = ['posting', 'auto-post', 'post-schedule'], ig, before } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlap-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    before?.(dataDir);
    for (const id of flagIds) flags.set(id, true);
    const queueFile = path.join(dataDir, 'posting', QUEUE_NAME);
    const q = createUploadQueue(queueFile, () => NOW);
    q.add('clip1'); q.patch('clip1', { state: 'queued', publishAt: '2026-11-13T12:00:00.000Z' });
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 't'.repeat(40);
    const youtube = { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, fetchImpl: async () => { throw new Error('no network in tests'); } };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), now: () => NOW, youtube, instagram: { auth: ig } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, ap: p.state.settings?.postingPage, dataDir, item: () => createUploadQueue(queueFile).get('clip1') };
    } finally { await srv.close(); }
  }
  const PAGE = 'settings-page:Posting%20%26%20growth';
  const open = ['settings-open', PAGE];
  const WAIT = [PAGE];
  const fakeIg = (start = {}) => {
    const s = { hasApp: false, connected: false, saved: null, signIns: 0, ...start };
    return { s, auth: {
      status: async () => ({ hasApp: s.hasApp, connected: s.connected, username: s.connected ? 'placeholder_account' : null, expiresAt: s.connected ? '2027-01-20T00:00:00.000Z' : null }),
      setApp: async ({ appId, appSecret }) => { s.saved = { appId, secretLength: appSecret.length }; s.hasApp = true; },
      signIn: async () => { s.signIns++; s.connected = true; return {}; },
      signOut: async () => { s.connected = false; },
    } };
  };

  test('the section shows the state in plain words and the exact redirect URI; never connected by itself', async () => {
    const f = fakeIg();
    const { ap } = await probe({ actions: [...open, ...WAIT], ig: f.auth });
    assert.equal(ap.ig.loaded, true); assert.equal(ap.ig.connected, false); assert.equal(ap.ig.flagOn, true, 'ON by default (D444)');
    assert.match(ap.ig.status, /Not connected\. Save your Meta app's App ID and App Secret/);
    assert.match(ap.ig.redirectUri, /^http:\/\/localhost:\d+\/$/);
    assert.equal(f.s.signIns, 0);
  });

  test('Save app sends the ID and secret once (the secret box is cleared, never shown); Connect and Disconnect act on their own click', async () => {
    const f = fakeIg();
    const { ap, p } = await probe({ actions: [...open, ...WAIT, 'ap-ig-appid:1234567', 'ap-ig-secret:fakeappsecret0123456', 'ap-ig-save', ...WAIT, 'ap-ig-connect', ...WAIT, ...WAIT], ig: f.auth }); // lint-allow: secret (a fake test app secret, not a credential)
    assert.deepEqual(f.s.saved, { appId: '1234567', secretLength: 20 });
    assert.equal(ap.ig.secretTyped, false, 'the secret box is emptied after Save');
    assert.doesNotMatch(JSON.stringify(p.tree), /fakeappsecret/);
    assert.equal(f.s.signIns, 1);
    assert.equal(ap.ig.connected, true); assert.match(ap.ig.status, /Connected to @placeholder_account/);
    const r = await probe({ actions: [...open, ...WAIT, 'ap-ig-disconnect', ...WAIT], ig: fakeIg({ hasApp: true, connected: true }).auth });
    assert.equal(r.ap.ig.connected, false);
  });

  test('the on/off switch sets the instagram-autopost flag', async () => {
    const { dataDir, ap } = await probe({ actions: [...open, ...WAIT, 'ap-ig-flag:off', ...WAIT], ig: fakeIg().auth });
    assert.equal(ap.ig.flagOn, false);
    assert.equal(createFlags({ dataDir }).isOn('instagram-autopost'), false);
  });
  test('Drop Instagram queue: shown while clips wait, one click drops them', async () => {
    const { queueInstagramNow, readInstagramStates } = await import('../services/posting/instagram-queue.mjs');
    let dir = null;
    const f = fakeIg({ hasApp: true, connected: true });
    const { ap, dataDir } = await probe({ actions: [...open, ...WAIT, 'ap-ig-drop', ...WAIT], ig: f.auth, before: (d) => { dir = d; queueInstagramNow(d, 'clip1'); } });
    assert.equal(dir, dataDir);
    assert.equal(readInstagramStates(dataDir).clip1.state, 'dropped');
    assert.match(ap.ig.msg, /Dropped 1 clip/);
  });
});
