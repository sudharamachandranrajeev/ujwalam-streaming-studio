// SPDX-License-Identifier: GPL-3.0-or-later
// Screen and window capture layers (D390 proposed): layer types screen (libobs monitor_capture) and window
// (window_capture), the read-only capture.listTargets list, and the --allow-screen-capture switch.
//
// Part 1 (always): a host started without --allow-screen-capture keeps win-capture off: capture.listTargets is refused
// (-32001), a project with a screen and a window layer plans both as forbidden, and bad layer specs are refused.
// Part 2 (UJWALAM_SCREEN_CAPTURE_TESTS=1 only): a host started with --allow-screen-capture loads win-capture. Loading it
// fetches the OBS compatibility list from obsproject.com and copies the capture hooks to ProgramData, so it never runs
// in CI or by default. It lists the real displays and windows (window titles are personal: this test never prints
// them, it prints counts only), loads a project with one screen and one window layer and checks both are live.
// Nothing is recorded or saved.
//   node --test app/host/tests/host-screen-capture.test.mjs   (needs the built host and the OBS runtime)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { loadIntoHost, planInHost } from '../lib/project.mjs';
import { REPO_ROOT } from '../lib/config.mjs';

const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');
const LIVE = process.env.UJWALAM_SCREEN_CAPTURE_TESTS === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const full = { visible: true, x: 0, y: 0, width: 640, height: 360 };
// Placeholder specs only: never a real window title in a committed file.
const WINDOW_SPEC = 'Example Title:ExampleClass:example-app.exe';
const project = (layers) => ({
  version: 1, id: 'screencap', name: 'Screen capture', activeScene: 's',
  canvases: [{ id: 'h', width: 640, height: 360, fps: 30 }],
  devices: [], overlays: [], outputs: [],
  scenes: [{ id: 's', name: 'S', layers: [{ id: 'bg', type: 'color', name: 'BG', source: { color: '#202020' }, placements: { h: full } }, ...layers] }],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] },
});
const screenLayer = (display, extra = {}) => ({ id: 'scr', type: 'screen', name: 'Screen', source: { display, ...extra }, placements: { h: full } });
const windowLayer = (window, extra = {}) => ({ id: 'win', type: 'window', name: 'Window', source: { window, ...extra }, placements: { h: full } });

let off; // host without --allow-screen-capture
before(async () => {
  mkdirSync(OUT, { recursive: true });
  off = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'screencap-off-')), extraArgs: ['--headless'], env: { UJWALAM_HEADLESS: '1' } });
});
after(async () => { if (off) await stopHost(off); });

async function errCode(c, method, params) {
  try { await c.call(method, params); } catch (e) { return e.code; }
  return null;
}

test('off by default: win-capture not loaded, listTargets refused, screen and window layers planned as forbidden', async () => {
  const c = off.client;
  const info = await c.call('host.info');
  assert.equal(info.flags.allowScreenCapture, false);
  assert.ok(info.disabledModules.includes('win-capture'), 'win-capture stays off without the switch');
  assert.equal(await errCode(c, 'capture.listTargets', {}), -32001);
  assert.equal(await errCode(c, 'capture.listTargets', { x: 1 }), -32602, 'no parameters');
  const plan = await planInHost(c, project([screenLayer('display-id-1'), windowLayer(WINDOW_SPEC)]));
  const why = Object.fromEntries(plan.unavailable.map((u) => [u.layer, u]));
  for (const id of ['scr', 'win']) {
    assert.equal(why[id]?.code, 'forbidden', `${id} forbidden`);
    assert.match(why[id].reason, /--allow-screen-capture/);
  }
  // The plan still names their OBS types (plan.sources lists every layer); the load skips unavailable layers.
  const t = Object.fromEntries(plan.sources.map((x) => [x.layer, x.obsType]));
  assert.deepEqual([t.scr, t.win], ['monitor_capture', 'window_capture']);
  const r = await loadIntoHost(c, project([screenLayer('display-id-1'), windowLayer(WINDOW_SPEC)]));
  assert.ok(r, 'the project loads; the two layers are left out');
  const ls = await c.call('layers.list', { scene: 's' });
  assert.ok(!ls.layers.some((l) => (l.id === 'scr' || l.id === 'win') && l.source), 'no screen or window source is created');
});

test('bad screen and window specs: the whole plan is refused (-32602), whatever the switch', async () => {
  const c = off.client;
  for (const [layer, re] of [
    [screenLayer(''), /display/],
    [screenLayer('d1', { window: WINDOW_SPEC }), /window/],
    [screenLayer('d1', { cursor: 'yes' }), /cursor/],
    [windowLayer('no-colons'), /window/],
    [windowLayer('Title:Class:'), /window/],
    [windowLayer('a:b:c:d.exe'), /window/],
    [windowLayer(WINDOW_SPEC, { match: 'pid' }), /match/],
    [windowLayer(WINDOW_SPEC, { display: 'd1' }), /display/],
  ]) {
    const e = await planInHost(c, project([layer])).then(() => null, (x) => x);
    assert.equal(e?.code, -32602, `${JSON.stringify(layer.source)} refused`);
    assert.match(e.message, re, JSON.stringify(layer.source));
  }
});

test('with --allow-screen-capture: listTargets shape; a screen and a window layer load and are live', { skip: !LIVE && 'set UJWALAM_SCREEN_CAPTURE_TESTS=1 (loads win-capture: network fetch, ProgramData hooks)' }, async () => {
  const on = await launchHost({ dataDir: mkdtempSync(path.join(OUT, 'screencap-on-')), extraArgs: ['--headless', '--allow-screen-capture'], env: { UJWALAM_HEADLESS: '1' } });
  try {
    const c = on.client;
    const info = await c.call('host.info');
    assert.equal(info.flags.allowScreenCapture, true);
    assert.ok(!info.disabledModules.includes('win-capture'), 'win-capture loaded');
    const t = await c.call('capture.listTargets', {});
    assert.deepEqual(Object.keys(t).sort(), ['displays', 'windows']);
    assert.ok(t.displays.length >= 1, 'at least one display');
    for (const d of t.displays) {
      assert.deepEqual(Object.keys(d).sort(), ['height', 'id', 'name', 'width']);
      assert.ok(typeof d.id === 'string' && d.id.length >= 1 && d.id !== 'DUMMY');
      assert.ok(Number.isInteger(d.width) && d.width > 0 && Number.isInteger(d.height) && d.height > 0, 'size parsed from the OBS label');
    }
    for (const w of t.windows) {
      assert.deepEqual(Object.keys(w).sort(), ['exe', 'id', 'title']);
      assert.equal(w.id.split(':').length, 3, 'OBS window spec title:class:exe');
      assert.equal(typeof w.title, 'string');
    }
    console.log(`capture.listTargets: ${t.displays.length} displays, ${t.windows.length} windows`); // counts only (titles are personal)
    assert.ok(t.windows.length >= 1, 'at least one window to capture (the desktop session has some)');

    const p = project([screenLayer(t.displays[0].id), windowLayer(t.windows[0].id, { match: 'exe', cursor: false })]);
    const plan = await planInHost(c, p);
    assert.deepEqual(plan.unavailable, [], 'both buildable');
    const src = Object.fromEntries(plan.sources.map((s) => [s.layer, s]));
    assert.equal(src.scr.obsType, 'monitor_capture');
    assert.equal(src.win.obsType, 'window_capture');
    await loadIntoHost(c, p);
    // Live: both layers are in the scene with a source; the display reports its size once the duplicator has a frame.
    let ls;
    for (let i = 0; i < 30; i++) {
      ls = await c.call('layers.list', { scene: 's' });
      if (ls.layers.find((l) => l.id === 'scr')?.width > 0) break;
      await sleep(200);
    }
    const scr = ls.layers.find((l) => l.id === 'scr');
    const win = ls.layers.find((l) => l.id === 'win');
    assert.ok(scr && scr.source, 'screen layer live');
    assert.ok(scr.width > 0 && scr.height > 0, `display delivers frames (${scr.width}x${scr.height})`);
    assert.ok(win && win.source, 'window layer live (its size is 0 while the window is minimised)');

    // Live add (layers.addFromProject) builds the same way.
    const p2 = structuredClone(p);
    p2.scenes[0].layers.push({ ...screenLayer(t.displays[0].id, { cursor: false }), id: 'scr2' });
    await c.call('layers.addFromProject', { project: p2, scene: 's', layer: 'scr2' });
    assert.ok((await c.call('layers.list', { scene: 's' })).layers.some((l) => l.id === 'scr2'), 'screen layer added live');
  } finally { await stopHost(on); }
});
