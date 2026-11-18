// SPDX-License-Identifier: GPL-3.0-or-later
// Measure what browser-layer shutdown costs on a scene switch (idle load, 2026-11-18).
//   node app/host/tools/browser-switch-measure.mjs [--mode shutdown|keep|both] [--cycles 2]
// Real host (NVENC + CEF). Off air only: refuses when tools/live-check.mjs says live. A test copy of the host with its
// own data dir; overlay pages from cfg.overlayRoot (legacy/, read-only). Prints one JSON line per mode:
//   switch: per transition (cut, fade 300 ms) and per overlay quadrant, the frames from the scene switch until the
//           quadrant shows 80 % of its steady drawing (the scene's own marker block gives the switch frame)
//   missed: gg-burst fired while its scene is hidden, scene shown 400 ms later: share of pixels it drew afterwards
//   cpu:    CPU seconds of the host and its CEF subprocesses over 30 s with the overlay scene hidden, then on air (after 5 s)
// keep = every browser layer keeps its page while not shown (browserKeep for all), shutdown = the current default.
// The recording (out/host/tests, gitignored) is read as numbers and deleted; no image is kept.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchHost, stopHost } from '../lib/launch.mjs';
import { overlayUrls, validateOrThrow } from '../lib/project.mjs';
import { REPO_ROOT, HOST_DIR } from '../lib/config.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const modes = arg('--mode', 'both') === 'both' ? ['shutdown', 'keep'] : [arg('--mode')];
const cycles = Number(arg('--cycles', '2'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(REPO_ROOT, 'out', 'host', 'tests');

if (spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools', 'live-check.mjs')], { stdio: 'inherit', windowsHide: true }).status !== 0) {
  console.error('browser-switch-measure: live (or the check failed): not running');
  process.exit(1);
}

const W = 1280, H = 720;
// Four overlays in quadrants (pages 1920x1080 scaled into 600x338), a white marker block between them.
const QUADS = [
  { id: 'atmos', ov: 'atmos-frame', x: 10, y: 10 },
  { id: 'hud', ov: 'blood-moon-hud', x: 670, y: 10 },
  { id: 'ticker', ov: 'social-ticker', x: 10, y: 372 },
  { id: 'campop', ov: 'cam-pop-frame', x: 670, y: 372 }
];
const QW = 600, QH = 338;
const MARK = { x: 615, y: 345, w: 50, h: 30 };
const bg = (id) => ({ id, type: 'color', name: 'Bg', source: { color: '#203040' }, placements: { h: { visible: true, x: 0, y: 0, width: W, height: H } } });
const PROJECT = {
  version: 1, id: 'browser-switch', name: 'Browser switch', activeScene: 'empty',
  canvases: [{ id: 'h', width: W, height: H, fps: 30 }],
  devices: [], outputs: [],
  overlays: [...QUADS.map((q) => ({ id: `ov-${q.id}`, name: q.ov, file: { base: 'overlays', rel: `${q.ov}/index.html` } })),
    { id: 'ov-gg', name: 'gg-burst', file: { base: 'overlays', rel: 'gg-burst/index.html' } }],
  scenes: [
    { id: 'empty', name: 'Empty', layers: [bg('bg0')] },
    { id: 'ov', name: 'Overlays', layers: [bg('bg1'),
      { id: 'mark', type: 'color', name: 'Mark', source: { color: '#ffffff' }, placements: { h: { visible: true, x: MARK.x, y: MARK.y, width: MARK.w, height: MARK.h } } },
      ...QUADS.map((q) => ({ id: q.id, type: 'browser', name: q.ov, source: { overlay: `ov-${q.id}`, width: 1920, height: 1080 },
        placements: { h: { visible: true, x: q.x, y: q.y, width: QW, height: QH } } }))] },
    { id: 'gg', name: 'GG', layers: [bg('bg2'),
      { id: 'gg', type: 'browser', name: 'GG', source: { overlay: 'ov-gg', width: 1920, height: 1080 }, placements: { h: { visible: true, x: 0, y: 0, width: W, height: H } } }] }
  ],
  audio: { tracks: [{ id: 't1', name: 'Track 1' }], sources: [] }
};

// Grey 320x180 frames at 30 fps of a recording.
const FW = 320, FH = 180, S = FW / W;
function frames(file) {
  const r = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `fps=30,scale=${FW}:${FH}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 1 << 30, windowsHide: true });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const n = FW * FH, out = [];
  for (let f = 0; f + n <= r.stdout.length; f += n) out.push(r.stdout.subarray(f, f + n));
  return out;
}
// Share of a rectangle's pixels that differ from base by more than 24 levels.
function diff(fr, base, { x, y, w, h }) {
  const x0 = Math.round(x * S), y0 = Math.round(y * S), x1 = Math.round((x + w) * S), y1 = Math.round((y + h) * S);
  let c = 0, n = 0;
  for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) { n++; if (Math.abs(fr[j * FW + i] - base[j * FW + i]) > 24) c++; }
  return c / n;
}
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] ?? 0; };

// CPU seconds of the host and every process under it (CEF subprocesses).
function treeCpu(rootPid) {
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,KernelModeTime,UserModeTime | ConvertTo-Json -Compress'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
  const all = JSON.parse(r.stdout);
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ParentProcessId)) kids.set(p.ParentProcessId, []); kids.get(p.ParentProcessId).push(p); }
  const byName = {};
  const walk = (pid) => { for (const p of kids.get(pid) ?? []) { add(p); walk(p.ProcessId); } };
  const add = (p) => { byName[p.Name] = (byName[p.Name] ?? 0) + (Number(p.KernelModeTime) + Number(p.UserModeTime)) / 1e7; };
  const self = all.find((p) => p.ProcessId === rootPid);
  if (self) add(self);
  walk(rootPid);
  return byName;
}
const cpuDelta = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, +(b[k] - (a[k] ?? 0)).toFixed(2)]));

const RUNG = { id: 'r', canvas: 'H', codec: 'h264', encoder: 'nvenc', rc: 'cbr', w: 640, h: 360, fps: 30, bitrate: 4000, gopSec: 1 };
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await sleep(100); }
}

async function run(mode) {
  mkdirSync(OUT, { recursive: true });
  const dataDir = mkdtempSync(path.join(OUT, 'bswitch-'));
  const h = await launchHost({ dataDir, overlay: true, project: path.join(HOST_DIR, 'projects', 'test-card.project.json'), extraArgs: ['--test-hooks'] });
  const c = h.client;
  try {
    const st = await c.call('overlay.status');
    const project = validateOrThrow(PROJECT);
    const renderFile = path.join(dataDir, 'browser-render.json');
    writeFileSync(renderFile, JSON.stringify({ version: 1, source: 'measure', checked: '2026-11-18', note: 'measure', keepWhenHidden: mode === 'keep' ? [...QUADS.map((q) => q.ov), 'gg-burst'] : [] }));
    const { browserUrls, relayScope, browserKeep } = overlayUrls(project, st, { renderFile });
    const p = { project, browserUrls };
    if (browserKeep.length) p.browserKeep = browserKeep;
    if (relayScope) p.relayScope = relayScope;
    const plan = await c.call('project.plan', p);
    const shut = Object.fromEntries(plan.sources.filter((s) => s.overlay).map((s) => [s.layer, s.shutdown]));
    await c.call('project.load', p);
    await sleep(5000); // pages that keep running load now; shut-down pages are not created until shown

    const pid = h.child.pid;
    const c0 = treeCpu(pid);
    await sleep(30000);
    const c1 = treeCpu(pid);

    await c.call('outputs.configure', { rungs: [RUNG], audio: { bitrate: 128, sampleRate: 48000 }, sinks: [{ id: 'rec', rung: 'r', platform: 'local', proto: 'file', priority: 1, target: { transport: 'file', name: `bswitch-${mode}.mkv` } }] });
    await c.call('record.start', {});
    await waitFor(async () => (await c.call('outputs.status')).sinks[0].state === 'live', 5000, 'recording live');
    const t0 = Date.now();
    const now = () => (Date.now() - t0) / 1000;
    const marks = [];
    for (const tr of [{ type: 'cut' }, { type: 'fade', durationMs: 300 }]) {
      await c.call('transitions.set', { canvas: 'H', ...tr });
      for (let i = 0; i < cycles; i++) {
        await sleep(1500);
        marks.push({ tr: tr.type, at: now() });
        await c.call('scenes.activate', { scene: 'ov' });
        await sleep(4000);
        await c.call('scenes.activate', { scene: 'empty' });
      }
    }
    // Missed event: gg-burst fired while its scene is hidden, then the scene is shown 400 ms later (cut).
    await c.call('transitions.set', { canvas: 'H', type: 'cut' });
    await sleep(2000);
    const fired = await c.call('effect.fire', { name: 'gg' });
    await sleep(400);
    const ggAt = now();
    await c.call('scenes.activate', { scene: 'gg' });
    await sleep(3500);
    await c.call('scenes.activate', { scene: 'ov' });
    await sleep(5000); // pages that were shut down load first; the window measures steady drawing
    const c2 = treeCpu(pid);
    await sleep(30000);
    const c3 = treeCpu(pid);
    await c.call('record.stop', {});
    const stopped = await waitFor(async () => { const s = await c.call('outputs.status'); return s.sinks[0].state === 'stopped' && s; }, 8000, 'recording stopped');
    const file = stopped.sinks[0].path;
    const fr = frames(file);

    // Switch: marker onset gives the switch frame; each quadrant's onset = first frame at 80 % of its steady level.
    const sw = marks.map((m) => {
      const from = Math.max(0, Math.round((m.at - 1.0) * 30)), to = Math.min(fr.length, Math.round((m.at + 4.0) * 30));
      const base = fr[from];
      const mk = []; for (let f = from; f < to; f++) mk.push(diff(fr[f], base, MARK));
      const swf = mk.findIndex((v) => v > 0.5);
      const quads = {};
      for (const q of QUADS) {
        const v = []; for (let f = from; f < to; f++) v.push(diff(fr[f], base, { x: q.x, y: q.y, w: QW, h: QH }));
        const steady = median(v.slice(-30));
        if (steady < 0.003) { quads[q.id] = { steadyPct: +(steady * 100).toFixed(2), frames: null }; continue; }
        const on = v.findIndex((x, k) => k >= swf && x >= 0.8 * steady);
        quads[q.id] = { steadyPct: +(steady * 100).toFixed(1), frames: on < 0 ? null : on - swf };
      }
      return { tr: m.tr, markerFrame: swf < 0 ? null : swf, quads };
    });
    // Missed: pixels drawn on the gg scene after the switch (beyond the plain background).
    const gf = Math.round(ggAt * 30), gbase = fr[Math.max(0, gf - 15)];
    let ggPeak = 0; for (let f = gf; f < Math.min(fr.length, gf + 75); f++) ggPeak = Math.max(ggPeak, diff(fr[f], gbase, { x: 0, y: 0, w: W, h: H }));
    rmSync(file, { force: true });
    return {
      mode, shutdown: shut, switch: sw,
      missed: { fired, drawnAfterShowPct: +(ggPeak * 100).toFixed(2) },
      cpu: { hidden30s: cpuDelta(c0, c1), onAir30s: cpuDelta(c2, c3) },
      host: await c.call('host.status').then((s) => ({ renderLagged: s.render?.renderLagged ?? null, skipped: (s.canvases ?? []).map((x) => x.skippedFrames) })).catch(() => null)
    };
  } finally {
    await stopHost(h);
  }
}

for (const m of modes) console.log(JSON.stringify(await run(m)));
