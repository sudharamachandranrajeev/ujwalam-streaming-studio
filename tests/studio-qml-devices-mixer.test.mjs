// SPDX-License-Identifier: GPL-3.0-or-later
// Devices and mixer in the QML studio (user bug report 2026-11-18: strips missing or doubled, meters wrong or dead; a
// layer not found at start never found later): strips keyed by id are not rebuilt on a refresh (B4), a device sound
// waiting for its device has a strip with Try again (A2/A3), the fader runs -60..+12 dB with Off at the bottom and sends
// nothing for an unchanged value (B5), the meters come from mixer.levels (B9), a capture layer without a picture has Try
// again (A3). Headless probe (UJWALAM_HEADLESS=1, offscreen) against a real UI server and the fake host.
// Skipped when the shell is not built (npm run build:studio).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

describe('QML studio devices and mixer (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // opts: waitingAudio (fake), seed(fake), hostStatus() (merged into host.status), hostCall(m, p) (own answer), ms
  async function probe(actions = [], opts = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmldev-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true, waitingAudio: opts.waitingAudio ?? [] });
    if (opts.seed) await opts.seed(fake);
    const calls = [];
    const host = { describe: () => fake.describe(), call: async (m, p) => {
      calls.push([m, p]);
      if (opts.hostStatus && m === 'host.status') return { ...(await fake.call(m, p)), ...opts.hostStatus() };
      const own = opts.hostCall?.(m, p);
      if (own !== undefined) return own;
      return fake.call(m, p);
    } };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'f'.repeat(40);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
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
      return { p, s: p.state, done: p.actions.map((a) => a.done), calls, fake };
    } finally { await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);

  test('B4/B9: strips are built once; a device change reloads the mixer without rebuilding them; meters come from mixer.levels', async () => {
    let seq = 0;
    const r = await probe([], { ms: 7000, hostStatus: () => ({ devices: { seq: seq++, listed: true, busy: false, waiting: [], connected: {} } }) });
    const reloads = r.calls.filter(([m]) => m === 'mixer.list').length;
    assert.ok(reloads >= 3, `the mixer was read again on device changes: ${reloads}`);
    assert.equal(r.s.mixer.length, 3);
    assert.equal(r.s.mixerStripsMade, 3, 'each strip built once');
    assert.ok(r.calls.some(([m]) => m === 'mixer.levels'), 'the meters poll mixer.levels');
  });

  test('A2/A3: a device sound waiting for its device has a strip that says so, no controls, and Try again; after it the sound is a normal strip', async () => {
    const before = await probe([], { waitingAudio: [{ id: 'aud-x', name: 'Mic X' }] });
    const st = node(before.p, 'streamState:audio:aud-x');
    assert.ok(st, 'a strip for the waiting sound');
    assert.match(st.text, /^Waiting for audio input "Mic X": it is not connected/);
    assert.equal(node(before.p, 'retryAudio:audio:aud-x').visible, true);
    assert.equal(node(before.p, 'addToStream:audio:aud-x')?.visible ?? false, false, 'no Add to stream on a waiting sound');
    assert.equal(node(before.p, 'mute:audio:aud-x').enabled, false);
    assert.equal(before.s.mixer.find((m) => m.id === 'audio:aud-x').waiting, true);

    const r = await probe(['mixer-retry:audio:aud-x'], { waitingAudio: [{ id: 'aud-x', name: 'Mic X' }], ms: 6000 });
    assert.deepEqual(r.done, [true], JSON.stringify({ a: r.p.actions, strips: r.p.tree.filter((n) => n.name.startsWith('strip:')).map((n) => [n.name, n.rect, n.visible]), list: node(r.p, 'mixerStrips') }));
    assert.ok(r.calls.some(([m]) => m === 'devices.rescan'), 'Try again asks the host');
    assert.equal(r.s.mixer.find((m) => m.id === 'audio:aud-x').waiting, false);
    assert.equal(node(r.p, 'retryAudio:audio:aud-x')?.visible ?? false, false);
  });

  test('B5: -60..+12 dB; up to +12 is sent; an unchanged value sends nothing; no volume shows Off', async () => {
    const r = await probe(['volume-type:scene-1/game:-6', 'volume-type:scene-1/cam:12', 'volume-type:scene-1/cam:20'], {
      seed: (f) => f.call('mixer.setVolume', { id: 'scene-2/text', db: -100 }),
    });
    assert.deepEqual(r.done, [true, true, true]);
    const sent = (id) => r.calls.filter(([m, x]) => m === 'mixer.setVolume' && x.id === id).map(([, x]) => x.db);
    assert.deepEqual(sent('scene-1/game'), [], 'the game is at -6 already: nothing sent');
    assert.deepEqual(sent('scene-1/cam'), [12], '+12 sent; 20 is held to +12, the same value again: nothing more');
    assert.equal(node(r.p, 'vol:scene-2/text:box').text, 'Off');
    assert.equal(node(r.p, 'vol:scene-1/game:slider:mark')?.visible, true, 'the 0 dB tick');
    assert.equal(r.s.mixer.find((m) => m.id === 'scene-1/cam').volumeDb, 12, 'B10: the strip keeps the volume the host took');
  });

  // Codex review round 2 (P1): the host never switches the headphones on a running studio; mixer.list carries its sentence.
  test('headphones plugged in after the start: the studio says the change applies on restart', async () => {
    const said = 'Headphones "<headphones>" are connected now. The headphones change applies when you restart the studio.';
    let fake = null;
    const r = await probe([], { seed: (f) => { fake = f; }, hostCall: (m, p) => {
      if (m !== 'mixer.list') return undefined;
      return fake.call(m, p).then((x) => ({ ...x, headphones: said }));
    } });
    assert.equal(r.s.note, said);
  });

  test('A3: a capture layer without a picture has Try again on its row; it asks the host to look again', async () => {
    const r = await probe(['layer-retry:game'], {
      ms: 5000,
      hostCall: (m, p) => {
        if (m !== 'layers.list' || p.scene !== 'scene-1') return undefined;
        return { scene: 'scene-1', canvas: 'H', layers: [
          { id: 'game', name: 'Game capture', visible: true, placement: { visible: true, x: 0, y: 0, width: 1920, height: 1080 }, device: { state: 'connecting', attempt: 5, message: 'No picture from capture card.' } },
          { id: 'cam', name: 'Camera', visible: true, placement: { visible: true, x: 1440, y: 40, width: 440, height: 248 } },
        ] };
      },
    });
    assert.deepEqual(r.done, [true]);
    assert.ok(r.calls.some(([m]) => m === 'devices.rescan'));
    assert.equal(node(r.p, 'layerRetry:cam')?.visible ?? false, false, 'only on the row that waits');
  });
});
