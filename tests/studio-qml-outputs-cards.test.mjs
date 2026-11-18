// SPDX-License-Identifier: GPL-3.0-or-later
// The Outputs panel as destination cards in the QML studio (D389, track B; replaces the row list of D327 OS3). Checks:
// the card text in plain words (platform and orientation, quality, one status chip with its reason) for each state
// (Ready, Add the key, Live, Off, Problem); the "Go live here" switch shows the real saved state and, while it saves,
// keeps what the user chose (a spinner, one flip, never back and forth); two switched-on destinations with the same
// platform and the same key are flagged on both cards; the summary line; Add the key opens Settings > Connections on that
// output; the grid reflows from one to two columns and no item lies outside its card or its panel; cards keep their size
// in every state. A loopback stand-in in front of the real UI server answers ui/api/outputs/panel, outputs/toggle and
// connect from a script (and records the toggles); everything else goes to the real server. Headless probe
// (UJWALAM_HEADLESS=1, offscreen). Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createMemoryStores } from '../services/platform-connect/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const outs = () => [
  { id: 'youtube-h', name: 'YouTube', platform: 'youtube', canvas: 'H', enabled: true, summary: '1440p @ 60fps 24,000 kbps · Main canvas', inPlan: true, state: null },
  { id: 'youtube-v', name: 'YouTube (portrait)', platform: 'youtube', canvas: 'V', enabled: true, summary: '1080x1920 @ 60fps 10,000 kbps · Portrait canvas', inPlan: true, state: null },
  { id: 'twitch', name: 'Twitch', platform: 'twitch', canvas: 'H', enabled: true, summary: '1080p @ 60fps 6,000 kbps · Main canvas', inPlan: true, state: null },
  { id: 'kick', name: 'Kick', platform: 'kick', canvas: 'H', enabled: false, summary: '1080p @ 60fps 6,000 kbps · Main canvas', inPlan: true, state: null },
];
const row = (id, last4, extra = {}) => ({ id, platform: id.split('-')[0], label: id, state: last4 ? 'connected' : 'missing', key: last4 ? { present: true, last4 } : { present: false }, ...extra });
const keys = (v = 'vvvv') => [
  row('youtube-h', 'hhhh'), row('youtube-h-1440p', 'hhhh', { sinkId: 'youtube-h', quality: '1440p' }),
  row('youtube-v', v || null), row('twitch', 'tttt'), row('kick', 'kkkk'),
];

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

describe('QML studio Outputs cards (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // opts: list (the panel outputs), live, connect (rows or null = no keys read), toggleMs (how long a toggle takes to save), actions
  async function probe({ list = outs(), live = false, connect = keys(), toggleMs = 300, actions = [], ms = Math.max(7000, 3500 + actions.length * 900) } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-oc-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    flags.set('platform-connect', true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'c'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), connect: { storeFor: createMemoryStores({}).storeFor }, log: () => {} });
    const { port: upstream } = await srv.listen();
    const toggles = [];
    let reads = 0;
    const proxy = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url, 'http://x').pathname;
        let body = {};
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* not JSON */ }
        const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (url === '/ui/api/outputs/panel') { reads += 1; return json(200, { live, virtualCamera: { available: false, reason: 'Not in this build' }, canvasMode: 'multi', outputs: list }); }
        if (url === '/ui/api/connect') return connect ? json(200, { outputs: connect, accounts: {} }) : json(404, { error: 'platform-connect-off' });
        if (url === '/ui/api/outputs/toggle') {
          toggles.push(body);
          return setTimeout(() => { const o = list.find((x) => x.id === body.id); if (o) o.enabled = body.on === true; json(200, { ok: true, id: body.id, enabled: body.on, live: false }); }, toggleMs);
        }
        const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${upstream}`;
        const up = http.request({ host: '127.0.0.1', port: upstream, path: req.url, method: req.method, headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
        up.on('error', () => { res.writeHead(502); res.end(); });
        up.end(raw);
      });
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const port = proxy.address().port;
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, op: p.state.outputsPanel, toggles, reads };
    } finally { await new Promise((r) => proxy.close(r)); await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const card = (op, id) => op.rows.find((x) => x.id === id);
  const W = ['o-wait', 'o-wait', 'o-wait']; // unknown action: only gives the answers time
  const inside = (r, outer) => r[0] >= outer[0] - 1 && r[1] >= outer[1] - 1 && r[0] + r[2] <= outer[0] + outer[2] + 1 && r[1] + r[3] <= outer[1] + outer[3] + 1;

  test('cards say where, how good and what state, in plain words; the summary line says what Go live starts', async () => {
    const r = await probe({});
    assert.equal(r.op.shown, true);
    assert.deepEqual(r.op.rows.map((x) => [x.id, x.title, x.quality]), [
      ['youtube-h', 'YouTube · landscape', '1440p, 24 Mbps'], ['youtube-v', 'YouTube · portrait', '1080p, 10 Mbps'],
      ['twitch', 'Twitch', '1080p, 6 Mbps'], ['kick', 'Kick', '1080p, 6 Mbps'],
    ]);
    assert.deepEqual(r.op.rows.map((x) => x.chip), ['Ready', 'Ready', 'Ready', 'Off']);
    assert.deepEqual(r.op.rows.map((x) => x.on), [true, true, true, false]);
    assert.equal(card(r.op, 'youtube-h').reason, 'Go live will start this one.');
    assert.equal(card(r.op, 'kick').reason, 'Left out when you press Go live.');
    assert.equal(r.op.summary, 'Go live starts: YouTube landscape (1440p), YouTube portrait (1080p), Twitch.');
    assert.equal(node(r.p, 'outputsSummary').text, r.op.summary);
    assert.equal(node(r.p, 'outputChip:youtube-h').text, 'Ready');
    assert.equal(r.op.title, 'Where you go live');
    for (const x of r.op.rows) assert.equal(node(r.p, `outputSwitch:${x.id}`).text, 'Go live here', x.id);
    assert.equal(r.op.virtualCamera, false);
  });

  test('Add the key: a destination whose key is not stored says so; its chip opens Settings > Connections on that output', async () => {
    const r = await probe({ connect: keys(''), actions: ['outputs-key:youtube-v', ...W] });
    const v = card(r.op, 'youtube-v');
    assert.equal(v.chip, 'Add the key');
    assert.equal(v.reason, 'No stream key for 1080p yet. Click Add the key.');
    assert.equal(v.keyMissing, true);
    assert.equal(card(r.op, 'youtube-h').keyMissing, false);
    assert.equal(done(r.p)['outputs-key:youtube-v'], true);
    assert.equal(r.s.settings.open, true);
    assert.equal(r.s.settings.page, 'Connections');
    assert.equal(r.s.settings.connectionsPage.only, 'youtube-v');
    const none = await probe({ connect: null, actions: ['outputs-key:youtube-v'] });
    assert.equal(done(none.p)['outputs-key:youtube-v'], false, 'with no key information nothing says a key is missing');
    assert.equal(card(none.op, 'youtube-v').chip, 'Ready');
  });

  test('live states: Live, a dropped connection is a Problem with its reason, Off for the one that is not in this stream', async () => {
    const list = outs();
    list[0].state = 'live'; list[1].state = 'retrying'; list[2].state = 'starting'; list[3].state = null;
    const r = await probe({ list, live: true });
    assert.equal(r.op.live, true);
    assert.deepEqual(r.op.rows.map((x) => x.chip), ['Live', 'Problem', 'Live', 'Off']);
    assert.equal(card(r.op, 'youtube-v').reason, 'The connection dropped. Trying again.');
    assert.deepEqual(r.op.rows.map((x) => x.on), [true, true, true, false]);
    assert.equal(r.op.summary, 'On air now: YouTube landscape (1440p), YouTube portrait (1080p), Twitch.');
    assert.equal(card(r.op, 'kick').enabled, false, 'live: an output the host does not have cannot be switched');
  });

  test('an output outside the plan is a Problem with its reason and a switch that is off', async () => {
    const list = outs();
    list[1].inPlan = false;
    const r = await probe({ list });
    assert.equal(card(r.op, 'youtube-v').chip, 'Problem');
    assert.equal(card(r.op, 'youtube-v').reason, 'This one needs the portrait canvas. Turn it on in Settings > Stream.');
    assert.equal(card(r.op, 'youtube-v').enabled, false);
  });

  test('two switched-on destinations with the same platform and the same key are flagged on both cards', async () => {
    const r = await probe({ connect: [...keys().filter((x) => x.id !== 'youtube-v'), row('youtube-v', 'hhhh')] });
    for (const id of ['youtube-h', 'youtube-v']) {
      const c = card(r.op, id);
      assert.equal(c.dup, true, id);
      assert.equal(c.chip, 'Problem', id);
      assert.equal(c.reason, 'Both go to the same YouTube stream: only one will work. Switch one off.', id);
    }
    assert.equal(card(r.op, 'twitch').dup, false);
    // one of them switched off: no warning
    const list = outs();
    list[1].enabled = false;
    const ok = await probe({ list, connect: [...keys().filter((x) => x.id !== 'youtube-v'), row('youtube-v', 'hhhh')] });
    assert.equal(card(ok.op, 'youtube-h').dup, false);
    assert.equal(card(ok.op, 'youtube-h').chip, 'Ready');
    // different keys: no warning
    const diff = await probe({});
    assert.equal(card(diff.op, 'youtube-h').dup, false);
  });

  test('the switch: one click saves once, shows the chosen state with a spinner while it saves, flips once and never back', async () => {
    const r = await probe({ toggleMs: 400, actions: ['outputs-toggle:twitch:off', ...W, ...W] });
    assert.deepEqual(r.toggles, [{ id: 'twitch', on: false }], 'one save');
    const t = card(r.op, 'twitch');
    assert.equal(t.on, false);
    assert.equal(t.chip, 'Off');
    assert.equal(t.busy, false, 'the spinner is gone when the read after the save came');
    assert.deepEqual(t.flips, [false], 'the switch went to Off once and stayed there');
    assert.equal(r.op.summary, 'Go live starts: YouTube landscape (1440p), YouTube portrait (1080p).');
    // (the probe waits for requests in flight, so the mid-save spinner state cannot be read here: UNVERIFIED by probe)
    // switching an output on that is already on does nothing
    const same = await probe({ actions: ['outputs-toggle:twitch:on'] });
    assert.deepEqual(done(same.p), { 'outputs-toggle:twitch:on': false });
    assert.deepEqual(same.toggles, []);
  });

  test('cards keep their size in every state; the grid is one column in the side column and two when wide; nothing lies outside its parent', async () => {
    const list = outs();
    list[0].state = 'live'; list[1].state = 'retrying';
    const states = [['ready', outs(), false], ['live', list, true]];
    for (const [name, l, live] of states) {
      for (const width of [null, 640]) {
        const r = await probe({ list: structuredClone(l), live, actions: width ? [`outputs-width:${width}`, ...W] : [] });
        const panel = node(r.p, 'outputsPanel').rect;
        assert.equal(r.op.cols, width ? 2 : 1, `${name} ${width}`);
        const heights = new Set();
        const xs = new Set();
        for (const x of r.op.rows) {
          const c = node(r.p, `outputCard:${x.id}`).rect;
          heights.add(c[3]);
          xs.add(c[0]);
          assert.ok(inside(c, panel), `${name} ${width}: card ${x.id} inside the panel ${JSON.stringify([c, panel])}`);
          for (const part of ['outputBadge', 'outputTitle', 'outputQuality', 'outputChip', 'outputSwitch', 'outputReason']) {
            const pr = node(r.p, `${part}:${x.id}`).rect;
            assert.ok(inside(pr, c), `${name} ${width}: ${part}:${x.id} inside its card ${JSON.stringify([pr, c])}`);
          }
          const t = node(r.p, `outputTitle:${x.id}`).rect, chip = node(r.p, `outputChip:${x.id}`).rect, badge = node(r.p, `outputBadge:${x.id}`).rect;
          assert.ok(badge[0] + badge[2] <= t[0] + 1 && t[0] + t[2] <= chip[0] + 1, `${name} ${width}: badge, title and chip do not overlap (${x.id})`);
          const sw = node(r.p, `outputSwitch:${x.id}`).rect, q = node(r.p, `outputQuality:${x.id}`).rect, why = node(r.p, `outputReason:${x.id}`).rect;
          assert.ok(q[1] + q[3] <= sw[1] + 1 && sw[1] + sw[3] <= why[1] + 1, `${name} ${width}: quality, switch and reason are stacked (${x.id})`);
        }
        assert.equal(heights.size, 1, `${name} ${width}: every card has the same height ${[...heights]}`);
        assert.equal(xs.size, width ? 2 : 1, `${name} ${width}: columns`);
        const sum = node(r.p, 'outputsSummary').rect;
        assert.ok(inside(sum, panel), `${name} ${width}: the summary line is inside the panel`);
      }
    }
  });
});
