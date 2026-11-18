// SPDX-License-Identifier: GPL-3.0-or-later
// The Outputs panel and the Bots box in the QML studio (plan Q4 section D; twins of studio-qt-d327's Outputs panel test
// and studio-qt-shell's Bots box). A real UI server, the fake host and the fake bots. Outputs (flag outputs-panel): rows
// with switches and Virtual Camera (switched off); offline a switch saves what Start stream starts; live it stops that
// one output on the click (D332); + opens Settings > Stream. Bots (flag bot-manager): Streamer.bot and Speaker.bot with
// Start and Stop; Start acts on the click; Stop is off for a copy Ujwalam did not start. Flags off: neither is shown and
// their actions are refused. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen). Skipped when the shell
// is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
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

describe('QML studio: Outputs panel and Bots box (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ flags: on = [], actions = [], live = false, ms = Math.max(7000, 3000 + actions.length * 900) }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlob-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of on) flags.set(id, true);
    if (!on.includes('outputs-panel')) flags.set('outputs-panel', false); // on by default since D389: "flags off" means the user switched it off
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    if (live) await fake.call('stream.start', {});
    const calls = [];
    const host = { describe: () => fake.describe(), call: (m, p) => { if (!['host.status', 'outputs.status'].includes(m)) calls.push([m, p]); return fake.call(m, p); } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const bots = createFakeBots();
    const key = 'o'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots, projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, op: p.state.outputsPanel, bp: p.state.botsPanel, s: p.state, dataDir, calls, bots };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => a.done);

  test('flags off: neither box is shown; their actions are refused', async () => {
    const { p, op, bp, bots } = await probe({ actions: ['outputs-toggle:twitch:off', 'outputs-add', 'bots-start:streamerbot'] });
    assert.equal(op.shown, false);
    assert.equal(bp.shown, false);
    assert.deepEqual(done(p), [false, false, false]);
    assert.deepEqual(bots.calls, []);
  });

  test('Outputs: rows with switches and Virtual Camera (switched off); offline a switch saves what Start stream starts', async () => {
    const r = await probe({ flags: ['stream-settings', 'outputs-panel'], actions: ['outputs-toggle:twitch:off'] });
    assert.equal(r.op.shown, true);
    assert.equal(r.op.live, false);
    assert.equal(r.op.virtualCamera, false, 'Virtual Camera row shown, switched off and disabled');
    assert.ok(r.op.rows.some((x) => x.id === 'twitch'), JSON.stringify(r.op.rows));
    assert.deepEqual(done(r.p), [true]);
    const setup = JSON.parse(readFileSync(path.join(r.dataDir, 'stream-setup.json'), 'utf8'));
    assert.equal(setup.outputs.find((o) => o.id === 'twitch').enabled, false);
    assert.equal(r.op.rows.find((x) => x.id === 'twitch').on, false, 'the switch follows the saved choice');
    assert.ok(!r.calls.some(([m]) => m === 'stream.start' || m === 'stream.stop'), 'offline: nothing started or stopped');
  });

  test('Outputs live: a switch stops that one output on the click, no window (D332); the others keep running', async () => {
    const l = await probe({ flags: ['stream-settings', 'outputs-panel'], live: true, actions: ['outputs-toggle:twitch:off'] });
    assert.deepEqual(done(l.p), [true]);
    assert.equal(l.op.live, true);
    assert.deepEqual(l.calls.filter(([m]) => m === 'stream.stop').map(([, x]) => x), [{ sinks: ['twitch'] }], 'only twitch stopped, on the click');
    assert.ok(!l.calls.some(([m]) => m === 'stream.start'), 'nothing else started');
  });

  test('Outputs: + opens Settings on the Stream page; a switch already in that state is refused', async () => {
    const r = await probe({ flags: ['stream-settings', 'outputs-panel'], actions: ['outputs-toggle:twitch:on', 'outputs-add'] });
    assert.deepEqual(done(r.p), [false, true]);
    assert.equal(r.s.settings?.open, true);
    assert.equal(r.s.settings?.page, 'Stream');
  });

  test('Bots: both bots with Start on and Stop off; Start acts on the click; Stop of a copy Ujwalam did not start is refused', async () => {
    const r = await probe({ flags: ['bot-manager'], actions: ['bots-stop:speakerbot', 'bots-start:streamerbot'] });
    assert.equal(r.bp.shown, true);
    assert.deepEqual(r.bp.rows.map((x) => x.bot), ['streamerbot', 'speakerbot']);
    assert.equal(r.bp.buttons, 4, 'Start and Stop for Streamer.bot and Speaker.bot');
    assert.deepEqual(done(r.p), [false, true]);
    assert.deepEqual(r.bots.calls, [['start', 'streamerbot']], 'started on the click, nothing stopped');
    const sb = r.bp.rows.find((x) => x.bot === 'streamerbot'), sp = r.bp.rows.find((x) => x.bot === 'speakerbot');
    assert.deepEqual([sb.state, sb.start, sb.stop], ['up', false, true], 'read again after the click: up, and Stop is on');
    assert.deepEqual([sp.state, sp.start, sp.stop], ['stopped', true, false]);
    assert.match(sp.facts, /^installed: yes, running: no, port 8083 answering: no, started by Ujwalam: no$/);
    assert.equal(r.bp.hint, 'Start and Stop act on the click. Stop only ends a bot that Ujwalam started.');
  });
});
