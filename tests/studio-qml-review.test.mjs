// SPDX-License-Identifier: GPL-3.0-or-later
// Review reads in the QML studio (LL3, D340; plan Q4, twin of studio-qt-learning-review): a real UI server, the fake
// host, synthetic review items in a temp learning store. Flag learning-review off (the default): no palette entry, the
// window lists nothing and Confirm writes nothing. On: the items with their questions and the pack's answers, a picture
// when the item has one, Confirm writes one "confirmed" label row and the item leaves the list; an unsure OCR read can be
// typed. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen). Skipped when the shell is not built.
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
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const S = 'live-20261111-120000';
// A real 16x9 JPEG (2026-11-22): the window must decode it, not only receive it (the package once had no JPEG decoder).
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMwD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xABLAAEBAAAAAAAAAAAAAAAAAAAABQEBAAAAAAAAAAAAAAAAAAAABhABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAkAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AIIB2OP/2Q==', 'base64');

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

function seed(dataDir) {
  const dir = path.join(dataDir, 'learning-store', S);
  mkdirSync(path.join(dir, 'frames'), { recursive: true });
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ v: 1, createdAt: '2026-11-11T12:00:00.000Z' }));
  writeFileSync(path.join(dir, 'frames', 'ocr-003.jpg'), JPEG);
  const items = [
    { v: 1, id: 'live-00001', at: '2026-11-11T12:10:00.000Z', t: 600, kind: 'unclassified-banner', detector: 'W1', label: 'VICTORY', mode: 'mp', ocrScore: 0.97, threshold: null, value: null, choices: ['round', 'match', 'not a banner'], frame: null },
    { v: 1, id: 'mode-002', at: '2026-11-11T13:00:00.000Z', t: 740, kind: 'unknown-mode', detector: null, label: null, mode: 'mp', ocrScore: null, threshold: null, value: null, choices: ['domination', 'hardpoint'], match: 2, frame: null, modeReason: 'no mode evidence', modeEvidence: [] },
    { v: 1, id: 'ocr-003', at: '2026-11-11T13:20:00.000Z', t: 900, kind: 'ocr-low', detector: 'K1', label: 'DOUBLE KILL', mode: 'mp', ocrScore: 0.41, threshold: 0.6, value: null, choices: ['DOUBLE KILL', 'wrong read'], frame: 'frames/ocr-003.jpg' },
  ];
  writeFileSync(path.join(dir, 'review.jsonl'), `${items.map((x) => JSON.stringify(x)).join('\n')}\n`);
  return dir;
}

describe('QML studio: Review reads (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ flagOn, actions, ms = Math.max(7000, 3000 + actions.length * 700) }) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlrv-')); dirs.push(dataDir);
    const storeDir = seed(dataDir);
    const flags = createFlags({ dataDir });
    if (flagOn) flags.set('learning-review', true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'r'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      const lf = path.join(storeDir, 'labels.jsonl');
      return { p, rv: p.state.review, s: p.state, labels: existsSync(lf) ? readFileSync(lf, 'utf8').trim().split('\n').map((x) => JSON.parse(x)) : [] };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => a.done);

  test('flag off: no palette entry, the window lists nothing, Confirm writes nothing', async () => {
    const { p, rv, s, labels } = await probe({ flagOn: false, actions: ['palette-open', 'palette-close', 'review-open', 'review-confirm:0'] });
    assert.ok(!s.palette.items.includes('Review reads'));
    assert.equal(rv.items, 0, 'the server refuses the list while the flag is off');
    assert.match(rv.info, /^Not available/);
    assert.equal(p.actions[3].done, false);
    assert.deepEqual(labels, []);
  });

  test('"Review reads (N)" beside My clips: shown only with the flag on and items waiting; it opens the window', async () => {
    let r = await probe({ flagOn: false, actions: ['clips-review'] });
    assert.equal(r.s.clips.reviewShown, false);
    assert.equal(r.p.actions[0].done, false);
    r = await probe({ flagOn: true, actions: ['clips-review'] });
    assert.deepEqual([r.s.clips.reviewShown, r.s.clips.reviewCount], [true, 3]);
    assert.equal(r.p.actions[0].done, true);
    assert.equal(r.rv.open, true);
  });

  test('flag on: palette entry, every item with its question; Confirm writes one confirmed label and the next item shows', async () => {
    const { p, rv, labels } = await probe({ flagOn: true, actions: ['palette-open', 'palette-type:review', 'palette-run', 'review-confirm:1'] });
    assert.deepEqual(done(p), [true, true, true, true]);
    assert.equal(rv.items, 2, 'the confirmed item left the list');
    assert.equal(labels.length, 1);
    assert.deepEqual({ action: labels[0].action, source: labels[0].source, ref: labels[0].ref },
      { action: 'confirmed', source: 'review', ref: { item: 'live-00001', kind: 'unclassified-banner', detector: 'W1', label: 'VICTORY', value: 'match', corrected: true } });
    assert.deepEqual(rv.choices, ['domination', 'hardpoint'], 'the next item and its answers are shown');
    assert.match(rv.question, /^Match 2 of the recording: the game mode could not be told \(no mode evidence\)\. Which mode was it\? The picture is from its end screen, 12:20 into the recording\.$/);
    assert.equal(rv.picture, 'No picture for this one.');
    assert.match(rv.titles[0], /Game mode of match 2\?$/);
  });

  test('an unsure OCR read: its question and picture; typed text is saved as the answer', async () => {
    const { p, rv, labels } = await probe({ flagOn: true, actions: ['review-open', 'review-pick:2', 'review-type:DOUBLE%20KILL%20x2'] });
    assert.deepEqual(done(p), [true, true, true]);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].ref.item, 'ocr-003');
    assert.equal(labels[0].ref.value, 'DOUBLE KILL x2');
    assert.equal(rv.items, 2);
    const pick = await probe({ flagOn: true, actions: ['review-open', 'review-pick:2'] });
    assert.match(pick.rv.question, /^Read as "DOUBLE KILL" with confidence 0\.41, below the game pack's 0\.60\./);
    assert.equal(pick.rv.picture, 'shown', 'the frame came from the server and was decoded');
    assert.ok(pick.rv.titles[2].endsWith('Unsure read: DOUBLE KILL'));
  });

  test('typing is only for unsure reads; picks out of range and actions while closed are refused', async () => {
    const { p, labels } = await probe({ flagOn: true, actions: ['review-pick:0', 'review-open', 'review-type:x', 'review-pick:9', 'review-confirm:7'] });
    assert.deepEqual(done(p), [false, true, false, false, false]);
    assert.deepEqual(labels, []);
  });
});
