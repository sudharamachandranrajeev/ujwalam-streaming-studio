// SPDX-License-Identifier: GPL-3.0-or-later
// Scene music in the QML studio (MU2, plan 2026-11-18-audio-mixer-music): the scene menu's "Music…" opens the scene's
// Music window with an on switch, the moods (made / not made yet) and a level slider; switching music on saves the
// scene's music, adds one Music strip and tells the host (music.setScene); a mood and a level change are saved;
// Listen asks the host (music.preview), which refuses on air. Headless probe (UJWALAM_HEADLESS=1, offscreen) against a
// real UI server and the fake host; nothing is played. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const QT = qtDir();
const skip = !existsSync(EXE) || !QT ? 'studio shell not built (npm run build:studio)' : false;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(EXE, [], {
      windowsHide: true,
      env: { ...process.env, PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}`, UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 50_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio scene music (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function probe(actions = [], opts = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlmu-')); dirs.push(dataDir);
    const lib = path.join(dataDir, 'music');
    mkdirSync(lib);
    writeFileSync(path.join(lib, 'lobby.wav'), Buffer.alloc(1000));
    writeFileSync(path.join(lib, 'in-match.wav'), Buffer.alloc(1000));
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    const calls = [], played = [];
    const host = { describe: () => fake.describe(), call: async (m, p) => {
      calls.push([m, p]);
      if (m === 'music.status') return { attached: true, scene: '', mood: '', playing: false, reason: '' };
      if (m === 'music.setScene' || m === 'audio.addFromProject') return {};
      if (m === 'music.preview') {
        if (opts.live && p.mood !== null) throw Object.assign(new Error('Listening is only possible off air'), { code: 'RPC_-32009' });
        played.push(p.mood ?? 'stop');
        return { previewing: p.mood };
      }
      if (m === 'outputs.status' && opts.live) return { sinks: [{ id: 'yt', kind: 'stream', state: 'live' }] };
      return fake.call(m, p);
    } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'f'.repeat(40);
    const file = path.join(dataDir, 'p.project.json');
    const doc = createProject({ name: 'T', fps: 30 });
    doc.scenes[0].id = 'scene-1';
    doc.activeScene = 'scene-1';
    doc.scenes[0].name = 'In match';
    doc.devices.push({ id: 'dev-mic', kind: 'microphone', name: 'Mic', match: { name: 'Mic' } });
    doc.audio.sources.push({ id: 'aud-mic', name: 'Mic', device: 'dev-mic', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'] });
    saveProject(file, doc);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {},
      projectSync: createProjectSync({ file, delayMs: 5 }) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(opts.ms ?? 4000 + actions.length * 900),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, done: p.actions.map((a) => a.done), calls, played, saved: JSON.parse(readFileSync(file, 'utf8')) };
    } finally { await srv.close(); }
  }

  test('Music window: the moods, not-made marked; opening changes nothing; the default mood follows the scene name', async () => {
    const r = await probe(['scene-music-open:scene-1'], { ms: 6000 });
    assert.deepEqual(r.done, [true], JSON.stringify(r.p.actions));
    const w = r.s.sceneMusic;
    assert.equal(w.open, true);
    assert.deepEqual(w.moods, ['brb', 'ending', 'in-match', 'lobby', 'starting-soon']);
    assert.deepEqual(w.made, ['in-match', 'lobby']);
    assert.deepEqual(w.music, { on: false, mood: 'in-match', volumeDb: 0 });
    assert.match(w.status, /off in this scene/);
    assert.equal('music' in r.saved.scenes[0], false);
    assert.ok(!r.calls.some(([m]) => m === 'music.setScene'));
  });

  test('switching on saves the music, adds one Music strip ducking under the mic; mood and level saved', async () => {
    const r = await probe(['scene-music-open:scene-1', 'music-on', 'music-mood:lobby', 'music-volume:-8'], { ms: 9000 });
    assert.deepEqual(r.done, [true, true, true, true], JSON.stringify(r.p.actions));
    assert.deepEqual(r.saved.scenes[0].music, { on: true, mood: 'lobby', volumeDb: -8 });
    const strips = r.saved.audio.sources.filter((s) => 'music' in s);
    assert.equal(strips.length, 1);
    assert.equal(strips[0].name, 'Music');
    assert.equal(strips[0].filters.duck.source, 'aud-mic');
    assert.equal(r.calls.filter(([m]) => m === 'audio.addFromProject').length, 1);
    assert.equal(r.calls.filter(([m]) => m === 'music.setScene').length, 3);
  });

  test('Listen: plays the bed off air; refused while live', async () => {
    let r = await probe(['scene-music-open:scene-1', 'music-listen'], { ms: 7000 });
    assert.deepEqual(r.done, [true, true]);
    assert.deepEqual(r.played, ['in-match', 'stop'], 'Listen stops when the UI server closes');
    assert.equal(r.s.sceneMusic.previewing, 'in-match');
    r = await probe(['scene-music-open:scene-1', 'music-listen'], { ms: 7000, live: true });
    assert.deepEqual(r.played.filter((m) => m !== 'stop'), [], 'nothing plays on air');
  });
});
