// SPDX-License-Identifier: GPL-3.0-or-later
// YM6 + SM5 in the QML studio (headless probe, UJWALAM_HEADLESS=1, never on a screen) against a real UI server with a fake
// Google (in-memory token vault, no network, no Credential Manager, placeholder channels). Skipped when the shell is not
// built. Actions: ap-ch-label, ap-ch-add, ap-ch-on, ap-ch-range, ap-ch-remove, ap-ch-refresh (Settings > Posting & growth >
// YOUTUBE CHANNELS) and sched:channel:<id|all> (the scheduling manager's channel filter).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
import { readAccounts, refreshTargetFor, updateAccounts } from '../services/posting/accounts.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const A = 'ch-aaaaaa1';
const later = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace(/\.\d+Z$/, '.000Z');

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** Fake Google: refresh tokens by Credential Manager target in memory; channels.list answers by access token. */
function fakeGoogle() {
  const vault = new Map([[refreshTargetFor('main'), 'refresh-main']]);
  const chOfTok = new Map([['tok-main', { id: 'UC-placeholder-main', title: 'Placeholder main' }]]);
  const auths = new Map(); let signIns = 0;
  const authFor = (id) => {
    if (!auths.has(id)) {
      const target = refreshTargetFor(id);
      auths.set(id, {
        signIn: async () => { signIns++; vault.set(target, 'r'); chOfTok.set(`tok-${id}`, { id: `UC-placeholder-${id}`, title: 'Placeholder second' }); return {}; },
        accessToken: async () => { if (!vault.has(target)) throw Object.assign(new Error('no'), { code: 'oauth-reauth-needed' }); return `tok-${id}`; },
        status: async () => ({ signedIn: vault.has(target), hasClient: true }),
        signOut: async () => vault.delete(target),
      });
    }
    return auths.get(id);
  };
  const fetchImpl = async (url, o = {}) => {
    const ch = chOfTok.get(String(o.headers?.Authorization ?? '').replace(/^Bearer /, ''));
    return { ok: true, status: 200, json: async () => ({ items: ch ? [{ id: ch.id, snippet: { title: ch.title } }] : [] }) };
  };
  return { vault, authFor, fetchImpl, signIns: () => signIns };
}

describe('QML studio: YouTube channels and the schedule by channel (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], ms = Math.max(9000, 4000 + actions.length * 700), before } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlym-')); dirs.push(dataDir);
    mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
    const flags = createFlags({ dataDir });
    for (const id of ['posting', 'auto-post', 'post-schedule']) flags.set(id, true);
    const g = fakeGoogle();
    before?.(dataDir, g);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'y'.repeat(40);
    const youtube = { auth: { status: async () => ({ signedIn: true, hasClient: true }) }, fetchImpl: async () => { throw new Error('no network in tests'); }, outputsStatus: async () => ({ sinks: [] }) };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), now: () => Date.now(), youtube, log: () => {},
      channels: { authFor: g.authFor, fetchImpl: g.fetchImpl, newId: () => A } });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, ch: p.state.settings?.postingPage?.channels, s: p.state.schedule, dataDir, g };
    } finally { await srv.close(); }
  }
  const PAGE = 'settings-page:Posting%20%26%20growth';
  const open = ['settings-open', PAGE];
  const WAIT = [PAGE];
  const withA = (dataDir, g) => {
    updateAccounts(dataDir, (d) => { d.accounts.push({ id: A, label: 'Second', enabled: true, addedAt: '2026-11-26T00:00:00Z', postsPerDay: { min: 3, max: 6 }, shortsOnly: true }); });
    g.vault.set(refreshTargetFor(A), 'r');
  };

  test('an install with one channel shows the main channel only, in plain words, and Add channel', async () => {
    const { ch } = await probe({ actions: [...open, ...WAIT] });
    assert.equal(ch.loaded, true);
    assert.deepEqual(ch.list.map((c) => [c.id, c.label, c.main, c.enabled]), [['main', 'Main channel', true, true]]);
    assert.match(ch.list[0].row, /^Signed in, posting on\. Follows Uploads per day above\.$/);
    assert.equal(ch.full, false);
  });

  test('Add channel: one click opens the sign-in; the channel is listed with 3 to 6 a day, Shorts only', async () => {
    const { ch, dataDir, g } = await probe({ actions: [...open, ...WAIT, 'ap-ch-label:Second%20channel', 'ap-ch-add', ...WAIT, 'ap-ch-refresh', ...WAIT] });
    assert.equal(g.signIns(), 1);
    const a = ch.list.find((c) => c.id === A);
    assert.ok(a, JSON.stringify(ch));
    assert.deepEqual([a.label, a.enabled, a.postsPerDay], ['Second channel', true, { min: 3, max: 6 }]);
    assert.match(a.row, /^Signed in, posting on\. 3 to 6 a day \(0 of [3-6] today\)\. Shorts only\.$/);
    assert.equal(readAccounts(dataDir).accounts[1].channelId, `UC-placeholder-${A}`);
  });

  test('posting off, the posts-a-day range and Remove each act on one click', async () => {
    const r = await probe({ before: withA, actions: [...open, ...WAIT, `ap-ch-on:${A}:off`, ...WAIT, `ap-ch-range:${A}:2:4`, ...WAIT] });
    const a = r.ch.list.find((c) => c.id === A);
    assert.deepEqual([a.enabled, a.postsPerDay], [false, { min: 2, max: 4 }]);
    assert.match(a.row, /^Posting off\./);
    const bad = await probe({ before: withA, actions: [...open, ...WAIT, `ap-ch-range:${A}:5:3`] });
    assert.match(bad.ch.msg, /the first not above the second/);
    const gone = await probe({ before: withA, actions: [...open, ...WAIT, `ap-ch-remove:${A}`, ...WAIT] });
    assert.deepEqual(gone.ch.list.map((c) => c.id), ['main']);
    assert.match(gone.ch.msg, /Its videos stay on YouTube/);
    assert.equal(gone.g.vault.has(refreshTargetFor(A)), false, 'its sign-in left the token store');
  });

  test('SM5: with two channels each row shows its channel and the list filters by channel', async () => {
    const before = (dataDir, g) => {
      withA(dataDir, g);
      const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
      for (const id of ['m1', 'a1', 'a2']) q.add(id);
      q.patch('m1', { account: 'main', publishAt: later(30) });
      q.patch('a1', { account: A, publishAt: later(31) });
      q.patch('a2', { account: A, publishAt: later(32) });
    };
    const all = await probe({ before, actions: ['sched:open'] });
    assert.equal(all.s.multiChannel, true);
    assert.deepEqual(all.s.channels, [{ id: 'main', label: 'Main channel' }, { id: A, label: 'Second' }]);
    assert.deepEqual(Object.fromEntries(all.s.rows.map((x) => [x.id, x.channelText])), { m1: 'Main channel', a1: 'Second', a2: 'Second' });
    const onlyA = await probe({ before, actions: ['sched:open', `sched:channel:${A}`] });
    assert.deepEqual([onlyA.s.fChannel, onlyA.s.rows.map((x) => x.id)], [A, ['a1', 'a2']]);
    const back = await probe({ before, actions: ['sched:open', `sched:channel:${A}`, 'sched:channel:all'] });
    assert.equal(back.s.shownRows, 3);
    const one = await probe({ actions: ['sched:open'] });
    assert.equal(one.s.multiChannel, false, 'one channel: no channel filter');
  });
});
