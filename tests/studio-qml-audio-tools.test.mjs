// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer audio tools in the QML studio (plan 2026-11-18-audio-mixer-music, AU1 + AU2): every strip has a Tools button; it
// opens the Tools window with the six tools as plain-word switches; a preset ("Clean voice") is offered and applied
// only on a click; a switch change is sent to the host (audio.setFilters) and saved into the project file. Add audio
// lists one app's sound (exe names) and music files / folders from the stream assets folder. Headless probe
// (UJWALAM_HEADLESS=1, offscreen) against a real UI server and the fake host. Skipped when the shell is not built.
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

describe('QML studio audio tools (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  async function probe(actions = [], opts = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlau-')); dirs.push(dataDir);
    const media = path.join(dataDir, 'media');
    mkdirSync(path.join(media, 'music', 'lobby'), { recursive: true });
    writeFileSync(path.join(media, 'music', 'lobby', 'a.ogg'), 'x');
    writeFileSync(path.join(media, 'music', 'intro.mp3'), 'x');
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    const calls = [];
    const host = { describe: () => fake.describe(), call: async (m, p) => {
      calls.push([m, p]);
      if (m === 'audio.apps') return { available: true, apps: [{ exe: 'player.exe', sound: true }] };
      if (m === 'audio.setFilters') return { audio: p.audio, filters: {} };
      return fake.call(m, p);
    } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'f'.repeat(40);
    const file = path.join(dataDir, 'p.project.json');
    // the fake mixer's "Game" strip is project audio source aud-game (here on a mic device)
    const doc = createProject({ name: 'T', fps: 30 });
    doc.devices.push({ id: 'dev-mic', kind: 'microphone', name: 'Mic', match: { name: 'Mic' } });
    doc.audio.sources.push({ id: 'aud-game', name: 'Game', device: 'dev-mic', volumeDb: 0, muted: false, monitoring: 'off', tracks: ['track1'] });
    saveProject(file, doc);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {},
      assetsDir: media, projectSync: createProjectSync({ file, delayMs: 5 }) });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(opts.ms ?? 4000 + actions.length * 900),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, done: p.actions.map((a) => a.done), calls, saved: JSON.parse(readFileSync(file, 'utf8')) };
    } finally { await srv.close(); }
  }

  test('Tools on a strip: plain-word tools, Clean voice offered and applied on a click, a switch saved and sent live', async () => {
    const r = await probe(['mixer-tools:scene-1/game', 'tools-preset:clean-voice', 'tools-toggle:gain'], { ms: 9000 });
    assert.deepEqual(r.done, [true, true, true], JSON.stringify(r.p.actions));
    const t = r.s.audioTools;
    assert.equal(t.open, true);
    assert.equal(t.audio, 'aud-game');
    assert.deepEqual(t.tools, ['Noise suppression', 'Noise gate', 'Tone (bass, middle, treble)', 'Gain', 'Compressor', 'Limiter']);
    assert.ok(t.presets.includes('Clean voice'));
    const f = r.saved.audio.sources.find((x) => x.id === 'aud-game').filters;
    assert.deepEqual(Object.keys(f).sort(), ['compressor', 'gain', 'gate', 'limiter', 'suppress']);
    assert.equal(f.gain.on, true, 'the Gain switch is on and saved');
    assert.equal(f.suppress.on, true, 'Clean voice applied on the click');
    const sent = r.calls.filter(([m]) => m === 'audio.setFilters');
    assert.equal(sent.length, 2, 'one host call per change');
    assert.ok(!r.calls.some(([m]) => m === 'audio.removeFromProject' || m === 'audio.addFromProject'), 'no rebuild of the sound');
  });

  test('Tools are offered, never applied on their own: opening the window changes nothing', async () => {
    const r = await probe(['mixer-tools:scene-1/game'], { ms: 6000 });
    assert.equal(r.s.audioTools.open, true);
    assert.equal('filters' in r.saved.audio.sources.find((x) => x.id === 'aud-game'), false);
    assert.ok(!r.calls.some(([m]) => m === 'audio.setFilters'));
  });

  test('Add audio lists one app\'s sound by exe name and music from the stream assets folder', async () => {
    const r = await probe(['add-audio-open'], { ms: 6000 });
    const rows = r.s.addAudio.rows;
    assert.ok(rows.some((x) => x.group === "One app's sound" && x.label === 'player.exe'), JSON.stringify(rows));
    assert.ok(rows.some((x) => x.group === 'Music: a folder as a playlist' && x.label === 'music/lobby'));
    assert.ok(rows.some((x) => x.group === 'Music: one sound file' && x.label === 'music/intro.mp3'));
  });
});
