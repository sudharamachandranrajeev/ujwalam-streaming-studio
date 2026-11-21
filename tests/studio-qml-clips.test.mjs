// SPDX-License-Identifier: GPL-3.0-or-later
// Clips in the QML studio's on-air bar (D283, D284; plan Q4 section C): the QML twin of the widget's Clips pill, its
// tooltip, the "Make clips?" question and the My clips button (studio-qt-shell's clip tests). A real UI server reads
// <dataDir>/clips/status.json and settings.json; the fake host; the open-folder seam. The question opens only on a window
// the user sees, so the probe puts it with clips-ask. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen).
// Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
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

describe('QML studio: clips chip, question and My clips (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  async function probe({ actions = [], settings, status, ms = Math.max(6000, 3000 + actions.length * 700) }) {
    const dataDir = tmp('ujw-qmlclips-');
    if (settings) writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
    if (status) { mkdirSync(path.join(dataDir, 'clips'), { recursive: true }); writeFileSync(path.join(dataDir, 'clips', 'status.json'), JSON.stringify(status)); }
    const opened = [];
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'c'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost({ outputsReady: true }), launchKey: key, dataDir, flags: createFlags({ dataDir }), bots: createFakeBots(),
      authority: null, openFolder: (d) => { opened.push(d); return true; }, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, c: p.state.clips, dataDir, opened };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => a.done);

  test('no clip runs yet: "Clips: ready" (default: ask me), the tip names both modes and the folder; no question open', async () => {
    const { c } = await probe({});
    assert.equal(c.text, 'Clips: ready');
    assert.match(c.tip, /^Recording: Ask me each time I stop recording\nLive: Ask me each time a stream ends\nClips folder: ./);
    assert.equal(c.ask.open, false);
  });

  test('the clip maker without Python: plain words, the reason and the fix in the tip; not set up; both off', async () => {
    const reason = "the clip maker's Python is missing (the Ujwalam download does not include Python)";
    const fix = 'To make clips, point Ujwalam at a folder that has the clip maker and its Python';
    let r = await probe({ settings: { clips: { recording: 'after', live: 'off' } }, status: { state: 'idle', available: false, reason, fix, missing: 'python', asks: [], queued: [], last: null } });
    assert.equal(r.c.text, 'Clips: Python not found');
    assert.ok(r.c.tip.includes(reason) && r.c.tip.includes(fix), r.c.tip);
    assert.match(r.c.tip, /Recording: Make clips automatically when I stop recording\nLive: Don't make clips/);
    r = await probe({ settings: { clips: { recording: 'after', live: 'off' } }, status: { state: 'idle', available: false, reason: 'not set up', fix, missing: 'root', asks: [], queued: [], last: null } });
    assert.equal(r.c.text, 'Clips: not set up');
    r = await probe({ settings: { clips: { recording: 'off', live: 'off' } } });
    assert.equal(r.c.text, 'Clips: off');
  });

  test('running, waiting, done and failed in plain words; the last reason in the tip', async () => {
    const base = { state: 'idle', available: true, asks: [], queued: [], last: null };
    const cases = [
      [{ ...base, running: { name: 'practice-h-1', kind: 'recording' } }, 'Making clips...'],
      [{ ...base, queued: ['a', 'b'] }, 'Clips waiting: 2'],
      [{ ...base, last: { name: 'x', kind: 'live', result: 'done', clips: 4 } }, '4 new clip(s)'],
      [{ ...base, last: { name: 'x', kind: 'live', result: 'failed', reason: 'no moments found' } }, 'Clips: last try failed'],
    ];
    for (const [status, text] of cases) {
      const { c } = await probe({ status });
      assert.equal(c.text, text);
      if (status.last?.reason) assert.match(c.tip, /\nLast time: no moments found$/);
    }
  });

  test('the last clips\' reel style and what it could not change show in the tip, in plain words (RS4, Codex RS verify)', async () => {
    const note = 'style not applied: v-crop (crop layout gets the colour only; pace, joins, zoom pulses and slow motion need the canvas layout)';
    const { c } = await probe({ status: { state: 'idle', available: true, asks: [], queued: [], last: { name: 'x', kind: 'live', result: 'done', clips: 2, styles: { names: ['Warm'], notApplied: [note] } } } });
    assert.equal(c.text, '2 new clip(s)', 'the bar text is unchanged (no layout jump)');
    assert.match(c.tip, /\nReel style: Warm\nStyle not applied: v-crop \(crop layout gets the colour only; pace, joins, zoom pulses and slow motion need the canvas layout\)$/);
    const none = await probe({ status: { state: 'idle', available: true, asks: [], queued: [], last: { name: 'x', kind: 'live', result: 'done', clips: 2 } } });
    assert.doesNotMatch(none.c.tip, /Reel style|not applied/);
  });
  test('"Make clips?": the question for a recording, Make clips with "every time" saves the answer; a stream asks with its own words', async () => {
    const ask = { id: 'practice-h-1-1', name: 'practice-h-1', kind: 'recording', minutes: 8 };
    const live = { id: 'live-2', name: 'live-2', kind: 'live', minutes: null };
    const r = await probe({ status: { state: 'idle', available: true, asks: [ask, live], queued: [], last: null }, actions: ['clips-answer:yes', 'clips-ask', 'clips-answer:yes:remember'] });
    assert.deepEqual(done(r.p), [false, true, true], 'no answer without a question open');
    assert.equal(r.c.text, 'Make clips? (2)', 'listed until the launcher picks up the answer');
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.dataDir, 'clips', 'answer.json'), 'utf8')), { id: ask.id, make: true, remember: true });
    assert.equal(r.c.ask.open, true, 'the next question opens once the first is answered');
    assert.equal(r.c.ask.message, 'Your stream has ended.\n\nShould Ujwalam find the best moments and make clips from it?');
    assert.equal(r.c.ask.remember, 'Do this every time a stream ends');
  });

  test('Not now answers no; each question is put once; My clips opens the clips folder through the server', async () => {
    const ask = { id: 'rec-9', name: 'rec-9', kind: 'recording', minutes: 3 };
    const r = await probe({ status: { state: 'idle', available: true, asks: [ask], queued: [], last: null }, actions: ['clips-ask', 'clips-answer:no', 'clips-ask', 'clips-folder'] });
    assert.deepEqual(done(r.p), [true, true, false, true], 'a question already answered is not put again');
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.dataDir, 'clips', 'answer.json'), 'utf8')), { id: ask.id, make: false, remember: false });
    assert.equal(r.opened.length, 1);
    assert.match(r.opened[0], /clips/i);
  });

  test('"Make clips?": a music, transition and name style for this one recording goes with the answer (D411); As in Settings sends none', async () => {
    const ask = { id: 'rec-7', name: 'rec-7', kind: 'recording', minutes: 5 };
    const r = await probe({ status: { state: 'idle', available: true, asks: [ask], queued: [], last: null },
      actions: ['clips-ask', 'clips-look:music:drop', 'clips-look:transitions:off', 'clips-look:name:kinetic', 'clips-look:name:', 'clips-answer:yes'] });
    assert.deepEqual(done(r.p), [true, true, true, true, true, true]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.dataDir, 'clips', 'answer.json'), 'utf8')),
      { id: ask.id, make: true, remember: false, look: { music: 'drop', transitions: 'off' } });
  });
});
