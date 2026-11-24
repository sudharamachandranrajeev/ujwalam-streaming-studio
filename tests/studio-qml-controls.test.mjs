// SPDX-License-Identifier: GPL-3.0-or-later
// QML studio live controls (plan Q4, checklist A): the twins of the widget tests for Save clip and Mark moment
// (studio-qt-shell, D281) and the live alert strip (studio-qt-alerts, flag live-test-kit, D305 proposed). Headless probe
// (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a real UI server and the fake host. Skipped when the shell
// is not built (npm run build:studio).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { LIVE_DIR, STATUS_FILE } from '../services/studio-ui/stream-recovery.mjs';
import { loadTestKitConfig } from '../services/studio-ui/live-test-kit.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const SESSION = 'a'.repeat(32);
const RECOVERY_TEXT = 'Host crashed at 18:02, streams restarted: YouTube H; NOT restarted: Kick (start them from the control page)';

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

describe('QML studio: Save clip, Mark moment and the alert strip (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // o.alerts: the live-test-kit setup of the widget test (flag on or off, a recovery event, an audio warning, live).
  async function probe({ actions = [], ms = Math.max(5000, 3000 + actions.length * 700), alerts = null, live = false } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlctl-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    if (live) await fake.call('stream.start', {});
    const calls = [];
    let host = { describe: () => fake.describe(), call: (m, p) => { calls.push([m, p]); return fake.call(m, p); } };
    if (alerts) {
      if (alerts.flagOn) flags.set('live-test-kit', true);
      mkdirSync(path.join(dataDir, LIVE_DIR), { recursive: true });
      writeFileSync(path.join(dataDir, LIVE_DIR, STATUS_FILE), JSON.stringify({ v: 1, events: [
        { session: SESSION, at: '2026-11-09T18:02:30.000Z', crashAt: '2026-11-09T18:02:00.000Z', result: 'partial', reason: 'restart', text: RECOVERY_TEXT },
      ] }));
      await fake.call('stream.start', {}); // live: the Streamer.bot reminder shows too
      host = {
        describe: () => fake.describe(),
        async call(m, p) {
          calls.push([m, p]);
          const r = await fake.call(m, p);
          return m === 'host.status' ? { ...r, audioHealth: { warnings: ['Game audio missing'], sources: [{ id: 'audio:game', name: 'Game', state: 'missing', receiving: false }] } } : r;
        },
      };
    }
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'c'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {},
      ...(alerts ? { liveSession: SESSION } : {}) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, calls, out: r.out };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => [a.action, a.done]);
  const node = (p, name) => p.tree.find((n) => n.name === name);

  test('Save clip and Mark moment (D281): replay.save and an api marker reach the host with no confirm; the note says what happened', async () => {
    const { p, calls, out } = await probe({ actions: ['click:clipBtn', 'click:markBtn'] });
    assert.deepEqual(done(p), [['click:clipBtn', true], ['click:markBtn', true]]);
    assert.ok(calls.some(([m]) => m === 'replay.save'), 'replay.save called');
    assert.ok(calls.some(([m, q]) => m === 'marker.add' && q?.source === 'api'), 'marker.add {source: api} called');
    assert.match(out, /^studio note: Clip not saved: the replay buffer is not running\.$/m, 'the fake host saves no file: said in plain words');
    assert.equal(p.state.note, 'Moment marked.');
    assert.equal(p.state.palette.open, false, 'no confirm window, no palette');
  });

  test('the buttons sit with Record and Go live, labelled, in one row', async () => {
    const { p } = await probe();
    const clip = node(p, 'clipBtn'), mark = node(p, 'markBtn'), rec = node(p, 'recordBtn');
    // D431: a bar narrower than its full labels (the headless probe window) shortens these two; both forms are labels
    const compact = clip.text === 'Clip';
    assert.deepEqual([clip.text, clip.enabled, clip.visible], [compact ? 'Clip' : 'Save clip', true, true]);
    assert.deepEqual([mark.text, mark.enabled, mark.visible], [compact ? 'Mark' : 'Mark moment', true, true]);
    assert.ok(clip.rect[0] < mark.rect[0] && mark.rect[0] < rec.rect[0], 'Save clip, Mark moment, then Record');
    assert.equal(clip.rect[1], rec.rect[1], 'one row in the on-air bar');
  });

  test('preview Own window / To front (D280): preview.open and preview.focus with only the canvas; the buttons sit under each preview, never over it', async () => {
    const { p, calls } = await probe({ actions: ['click:previewOpen:h', 'click:previewFront:v'] });
    assert.deepEqual(done(p), [['click:previewOpen:h', true], ['click:previewFront:v', true]]);
    assert.ok(calls.some(([m, q]) => m === 'preview.open' && JSON.stringify(q) === '{"canvas":"h"}'), 'preview.open {canvas:h}');
    assert.ok(calls.some(([m, q]) => m === 'preview.focus' && JSON.stringify(q) === '{"canvas":"v"}'), 'preview.focus {canvas:v}');
    assert.equal(p.state.note, 'Preview opened.', 'To front says nothing when it works (as the widget)');
    for (const c of ['h', 'v']) {
      const frame = node(p, c === 'h' ? 'previewH' : 'previewV').rect;
      for (const b of [`previewOpen:${c}`, `previewFront:${c}`]) {
        const r = node(p, b).rect;
        assert.ok(r[1] >= frame[1] + frame[3], `${b} below its preview`);
        assert.ok(r[0] >= frame[0] && r[0] + r[2] <= frame[0] + frame[2] + 1, `${b} within its preview's width`);
      }
      assert.deepEqual([node(p, `previewOpen:${c}`).text, node(p, `previewFront:${c}`).text], ['Own window', 'To front']);
    }
  });

  test('palette: "Save clip" and "Mark moment" run the same host calls as the buttons', async () => {
    const { p, calls } = await probe({ actions: ['palette-open', `palette-type:${encodeURIComponent('replay')}`, 'palette-run', 'palette-open', `palette-type:${encodeURIComponent('mark moment')}`, 'palette-run'] });
    assert.deepEqual(done(p).map(([, d]) => d), [true, true, true, true, true, true]);
    assert.equal(calls.filter(([m]) => m === 'replay.save').length, 1);
    assert.equal(calls.filter(([m, q]) => m === 'marker.add' && q?.source === 'api').length, 1);
  });

  test('alert strip: flag off (the default): hidden', async () => {
    const { s, p } = await probe({ alerts: { flagOn: false } });
    assert.deepEqual(s.alerts, { shown: false, text: '', level: '' });
    assert.equal(node(p, 'alertBar').visible, false);
  });

  test('alert strip: flag on: recovery, sound and the Streamer.bot reminder in plain words, worst level error', async () => {
    const { s, p } = await probe({ alerts: { flagOn: true } });
    assert.equal(s.alerts.shown, true);
    assert.equal(s.alerts.level, 'error');
    const lines = s.alerts.text.split('\n');
    assert.equal(lines[0], RECOVERY_TEXT);
    assert.match(lines[1], /^Sound problem: Game audio missing\. /);
    assert.ok(lines[2].includes(`"${loadTestKitConfig().streamerbotAction}"`), lines[2]);
    assert.equal(lines.length, 3);
    const bar = node(p, 'alertBar'), scenes = node(p, 'scenesPanel');
    assert.ok(bar.rect[1] + bar.rect[3] <= scenes.rect[1], 'the strip sits above the panels, never over them');
  });

  test('stats cards (D287): a sample per status poll; "Not live" off air; a running clock and "On air" while live; between the side column and the mixer', async () => {
    const off = await probe();
    assert.ok(off.s.stats.samples >= 2, 'a history sample per status poll');
    assert.deepEqual([off.s.stats.session, off.s.stats.note], ['Not live', 'Session time']);
    assert.match(off.s.stats.fps, /^\d+\.\d fps, \d+ dropped$/);
    assert.match(off.s.stats.gpu, /^\d+%$/);
    assert.match(off.s.stats.cpu, /^\d+%$/);
    const cards = node(off.p, 'statsPanel').rect, side = node(off.p, 'sideColumn').rect, mixer = node(off.p, 'mixerPanel').rect;
    assert.ok(side[1] + side[3] <= cards[1] && cards[1] + cards[3] <= mixer[1], 'side column, then the cards, then the mixer');
    assert.equal(node(off.p, 'chipStats'), undefined, 'no stats chip in the top bar any more (the cards show it)');
    const on = await probe({ live: true, ms: 6000 });
    assert.match(on.s.stats.session, /^00:00:0[1-9]$/, 'the clock runs while live');
    assert.equal(on.s.stats.note, 'On air');
  });

  test('status line: a UI server that does not answer is said as such, not as a host that stopped', async () => {
    // A server that lets the studio log in, then drops every other request: the UI server went away after the start.
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/login')) { res.writeHead(302, { Location: '/', 'Set-Cookie': 'ujw=s; HttpOnly' }); return res.end(); }
      if (req.url.startsWith('/ui/api/session')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"csrf":"x"}'); }
      req.socket.destroy();
    });
    const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
    let r;
    try { r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: 'c'.repeat(40), UJWALAM_STUDIO_PROBE_MS: '5000' }); }
    finally { srv.close(); }
    assert.equal(r.code, 0, r.err);
    const m = /^studio probe: (.+)$/m.exec(r.out);
    assert.ok(m, `no probe line: ${r.out} ${r.err}`);
    const p = JSON.parse(m[1]);
    assert.match(node(p, 'health').text, /^UI server: not reachable/);
    assert.doesNotMatch(node(p, 'health').text, /Host: not running/);
  });
});
