// SPDX-License-Identifier: GPL-3.0-or-later
// Feature settings (2026-11-26, user: "don't use the janky flag system"): finished features marked "setting": true in
// data/flags.json are Settings toggles stored in <dataDir>/settings.json features; the old flags.local.json value is
// honoured once (migrateFeatureSettings); the control page's flag switch writes the same place (kill-switch while live).
// Also the honest clip queue state (record-clips.mjs clipsState) and the task row controls of a job paused for the stream.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import { createFlags, DEFAULT_FLAGS_FILE, loadDefinitions, LOCAL_NAME, migrateFeatureSettings } from '../services/flags/index.mjs';
import { readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';
import { clipsState } from '../services/studio-ui/record-clips.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-featset-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const settingsOf = (d) => JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8'));

const MOVED = ['beatdrop', 'long-highlights-video', 'delete-processed-recordings', 'growth', 'instagram-autopost', 'realism-look', 'scene-edit', 'face-ai', 'live-clips'];

describe('committed definitions', () => {
  test('the finished, user-requested features are Settings toggles; the rest stay flags', () => {
    const defs = loadDefinitions(DEFAULT_FLAGS_FILE);
    assert.deepEqual(defs.filter((d) => d.setting).map((d) => d.id).sort(), [...MOVED].sort());
    assert.equal(defs.find((d) => d.id === 'beatdrop').default, true, 'BeatDrop ships on');
  });
});

describe('reading and writing', () => {
  test('settings.json features wins, then the old flags.local.json value, then the default', () => {
    const d = tmp();
    const f = createFlags({ dataDir: d });
    assert.equal(f.isOn('beatdrop'), true); // default on (D415)
    writeFileSync(path.join(d, LOCAL_NAME), JSON.stringify({ flags: { beatdrop: false, 'face-ai': true } }));
    assert.equal(f.isOn('beatdrop'), false, 'an explicit old switch is honoured before the move');
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { recording: 'after' }, features: { beatdrop: true } }));
    assert.equal(f.isOn('beatdrop'), true, 'the Settings value wins');
    assert.equal(f.isOn('face-ai'), true);
  });

  test('set() on a setting feature writes settings.json, keeps the other settings and leaves flags.local.json alone', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { recording: 'after', live: 'off' } }));
    writeFileSync(path.join(d, LOCAL_NAME), JSON.stringify({ flags: { posting: true } }));
    const f = createFlags({ dataDir: d });
    const seen = [];
    f.subscribe((e) => seen.push([e.id, e.on]));
    f.set('beatdrop', false);
    assert.deepEqual(settingsOf(d).features, { beatdrop: false });
    assert.equal(settingsOf(d).clips.recording, 'after');
    assert.deepEqual(JSON.parse(readFileSync(path.join(d, LOCAL_NAME), 'utf8')).flags, { posting: true });
    assert.equal(f.isOn('beatdrop'), false);
    assert.equal(f.list().find((x) => x.id === 'beatdrop').setting, true);
    assert.deepEqual(seen, [['beatdrop', false]]);
    f.set('posting', false); // a plain flag still goes to flags.local.json
    assert.equal(JSON.parse(readFileSync(path.join(d, LOCAL_NAME), 'utf8')).flags.posting, false);
    assert.equal(settingsOf(d).features.posting, undefined);
  });

  test('a Settings save keeps the features; a settings patch cannot set them', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ features: { beatdrop: false, growth: true } }));
    assert.deepEqual(readSettings(d).features, { beatdrop: false, growth: true });
    writeSettings(d, { clips: { recording: 'after' } });
    assert.deepEqual(settingsOf(d).features, { beatdrop: false, growth: true });
    assert.ok(settingsProblems({ features: { beatdrop: true } }).length > 0);
  });
});

describe('one-time move (migration)', () => {
  test('copies the effective value of each moved feature once; later flag file edits change nothing', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { recording: 'ask' }, features: { growth: false } }));
    writeFileSync(path.join(d, LOCAL_NAME), JSON.stringify({ flags: { 'live-clips': true, growth: true, beatdrop: false } }));
    const moved = migrateFeatureSettings({ dataDir: d });
    assert.ok(!moved.includes('growth'), 'a value already in Settings is kept');
    const ft = settingsOf(d).features;
    assert.equal(ft.growth, false);
    assert.equal(ft['live-clips'], true, 'old explicit switch honoured');
    assert.equal(ft.beatdrop, false, 'old explicit off honoured');
    assert.equal(ft['long-highlights-video'], true, 'default on (D406)');
    assert.equal(ft['scene-edit'], false, 'default off');
    for (const id of MOVED) assert.equal(typeof ft[id], 'boolean', id);
    assert.deepEqual(migrateFeatureSettings({ dataDir: d }), [], 'runs once');
    writeFileSync(path.join(d, LOCAL_NAME), JSON.stringify({ flags: { beatdrop: true } }));
    assert.equal(createFlags({ dataDir: d }).isOn('beatdrop'), false, 'the flag file no longer decides');
  });

  test('never creates settings.json (that would skip the first-run choices) and leaves a broken one alone', () => {
    const d = tmp();
    assert.deepEqual(migrateFeatureSettings({ dataDir: d }), []);
    writeFileSync(path.join(d, 'settings.json'), '{ broken');
    assert.deepEqual(migrateFeatureSettings({ dataDir: d }), []);
    assert.equal(readFileSync(path.join(d, 'settings.json'), 'utf8'), '{ broken');
  });
});

describe('Python reads the same value (clip_common.flag_on)', () => {
  const py = process.env.UJWALAM_PYTHON || 'python';
  const probe = spawnSync(py, ['-c', 'import sys'], { windowsHide: true });
  test('settings first, then flags.local.json, then the default', { skip: probe.status !== 0 ? 'no Python' : false }, () => {
    const d = tmp();
    writeFileSync(path.join(d, LOCAL_NAME), JSON.stringify({ flags: { beatdrop: false, 'face-ai': true } }));
    writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ features: { 'face-ai': false } }));
    const code = 'import sys, clip_common as cc; d=sys.argv[1]; print(cc.flag_on(d,"beatdrop"), cc.flag_on(d,"face-ai"), cc.flag_on(d,"long-highlights-video"))';
    const r = spawnSync(py, ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(path.join(REPO, 'services', 'clip'))}); ${code}`, d], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'False False True');
  });
});

describe('clip queue state (status.json)', () => {
  test('running only while a job works; paused while on air; waiting when every job waits for the user', () => {
    assert.equal(clipsState({}).state, 'idle');
    const job = { type: 'full', name: 'a' };
    assert.equal(clipsState({ current: job, queue: [job] }).state, 'running');
    assert.deepEqual(clipsState({ current: { ...job, pausedForLive: true }, queue: [job], liveNow: true }), { state: 'paused', stateText: 'Paused while the stream runs' });
    assert.equal(clipsState({ current: { ...job, pausedForLive: true }, queue: [job], liveNow: false }).stateText, 'Paused while recording');
    assert.equal(clipsState({ current: job, halted: true, queue: [job] }).state, 'queued');
    assert.equal(clipsState({ queue: [{ ...job, paused: true }, { ...job, awaitStart: true }] }).state, 'waiting');
    assert.equal(clipsState({ queue: [{ ...job, paused: true }, job] }).state, 'queued');
    assert.equal(clipsState({ queue: [job], liveNow: true }).state, 'paused');
    assert.equal(clipsState({ queue: [{ ...job, type: 'beatdrop' }], recNow: true }).stateText, 'Waits until the recording ends');
    assert.equal(clipsState({ queue: [job], recNow: true }).state, 'queued', 'a fresh clip job may run beside a recording');
  });
});
