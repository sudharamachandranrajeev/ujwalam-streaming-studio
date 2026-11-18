// SPDX-License-Identifier: GPL-3.0-or-later
// Idle load of the studio off air (2026-11-18): starts the headless alpha stack (tools/soak/stack.mjs: mock Streamer.bot,
// event core, ujwalam-host in alpha mode with UJWALAM_HEADLESS=1, overlay child, studio UI server; every stream target a
// 127.0.0.1 listener; nothing goes live), waits, then measures for N minutes and prints ONE JSON line (the last stdout line;
// the stack's own [studio] start lines come before it, progress goes to stderr):
//   procs:  per role (host, CEF pages, overlay child, event core, UI server, mux, ...): CPU seconds in the window, private
//           and working-set MB at the end, process count. The loopback listeners (this tool's ffmpeg) are left out.
//   gpu:    mean / max of nvidia-smi utilization.gpu (3D) and utilization.encoder (video encode), sampled every 5 s;
//           null when nvidia-smi is missing. Other GPU users (games, other tests) count too: see `others`.
//   host:   host.status in the window: render lag (render.renderLagged delta), skipped frames per canvas, encodeSkipped,
//           avgFrameTimeMs at the end, live / recording (both must stay false: off air).
//   others: names of other GPU-heavy processes that ran during the window (ffmpeg, another ujwalam-host), for the notes.
// Not in it: the launcher's own loops (services/studio-ui/launch.mjs) and the Python workers it supervises (the live
// clipper and face worker run only while wanted; off air with default flags they are not started).
//   node tools/perf-idle.mjs [--minutes 5] [--warmup 60]
// Refuses (exit 1) while tools/live-check.mjs says live, and while the installed studio runs (found by its exe path
// under %LOCALAPPDATA%\Ujwalam, never by process name; a check that fails counts as running): a second host next to
// it reset the GPU on 2026-11-12. Everything runs BelowNormal; no window opens. Temporary files: out/perf-idle/.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedUjwalamProcesses } from './ci.mjs';
import { REPO, execText, gpu, setBelow, startStack } from './soak/stack.mjs';

const TREE_PS = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process | ForEach-Object { "{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}" -f $_.ProcessId,$_.ParentProcessId,$_.Name,$_.KernelModeTime,$_.UserModeTime,$_.PrivatePageCount,$_.WorkingSetSize,$_.CreationDate.Ticks }';
const ROLE_PS = '$ErrorActionPreference="SilentlyContinue"; Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "{0}|{1}" -f $_.ProcessId,$_.CommandLine }';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Arguments: --minutes (0.5..240, default 5), --warmup seconds (0..600, default 60). Throws on a bad value. */
export function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? Number(argv[i + 1]) : d; };
  const minutes = get('--minutes', 5), warmup = get('--warmup', 60);
  if (!(minutes >= 0.5 && minutes <= 240)) throw new RangeError('--minutes must be 0.5..240');
  if (!(warmup >= 0 && warmup <= 600)) throw new RangeError('--warmup must be 0..600 seconds');
  return { minutes, warmup };
}

/** Role of a process from its name and (node only) script path; never prints the command line. */
export function roleOf(name, cmd = '') {
  const n = String(name).toLowerCase(), c = String(cmd).replaceAll('\\', '/');
  if (n === 'ujwalam-host.exe') return 'host';
  if (n === 'obs-browser-page.exe') return 'cef';
  if (n === 'obs-ffmpeg-mux.exe') return 'mux';
  if (n === 'node.exe') {
    if (c.includes('app/host/overlay/child.mjs')) return 'overlay-child';
    if (c.includes('services/event-core/')) return 'event-core';
    if (c.includes('services/studio-ui/')) return 'ui-server';
    return 'node-other';
  }
  if (n === 'python.exe' || n === 'pythonw.exe') return 'python';
  if (n === 'conhost.exe') return 'conhost';
  return n.replace(/\.exe$/, '');
}

/** Processes under each root pid: [{ pid, ppid, name, cpuS, privMB, wsMB, created }] (one CIM query). A process created
 *  before its listed parent is not its child: Windows keeps a parent id after that parent exits and the id is reused. */
export function treesOf(rows, roots) {
  const kids = new Map();
  for (const p of rows) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const out = new Map();
  const stack = [];
  for (const r of roots) { const self = rows.find((p) => p.pid === r); if (self) out.set(self.pid, self); stack.push(r); }
  while (stack.length) { const id = stack.pop(); const parent = out.get(id); for (const c of kids.get(id) ?? []) { if (c.pid === id || out.has(c.pid) || (parent && c.created < parent.created)) continue; out.set(c.pid, c); stack.push(c.pid); } }
  return [...out.values()];
}

/** Per-role summary of two snapshots (a: window start, b: end). A process that started in the window counts from 0. */
export function summarise(a, b, roles) {
  const start = new Map(a.map((p) => [p.pid, p.cpuS]));
  const by = {};
  for (const p of b) {
    const r = roles.get(p.pid) ?? roleOf(p.name);
    const e = (by[r] ??= { cpuS: 0, privMB: 0, wsMB: 0, n: 0 });
    e.cpuS += Math.max(0, p.cpuS - (start.get(p.pid) ?? 0));
    e.privMB += p.privMB; e.wsMB += p.wsMB; e.n++;
  }
  for (const e of Object.values(by)) { e.cpuS = +e.cpuS.toFixed(2); e.privMB = Math.round(e.privMB); e.wsMB = Math.round(e.wsMB); }
  return by;
}

async function snapshot() {
  const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TREE_PS], 60000);
  if (!out) return null;
  return out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [pid, ppid, name, k, u, priv, ws, created] = l.split('|');
    return { pid: +pid, ppid: +ppid, name, cpuS: (Number(k) + Number(u)) / 1e7, privMB: +priv / 1048576, wsMB: +ws / 1048576, created: Number(created) || 0 };
  });
}

async function nodeRoles() {
  const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ROLE_PS], 60000);
  const m = new Map();
  for (const l of (out ?? '').split(/\r?\n/).filter(Boolean)) { const i = l.indexOf('|'); m.set(Number(l.slice(0, i)), roleOf('node.exe', l.slice(i + 1))); }
  return m;
}

const stat = (xs) => (xs.length ? { mean: +(xs.reduce((s, x) => s + x, 0) / xs.length).toFixed(1), max: Math.max(...xs) } : null);

async function main() {
  const { minutes, warmup } = parseArgs(process.argv.slice(2));
  const live = spawnSync(process.execPath, [path.join(REPO, 'tools', 'live-check.mjs')], { encoding: 'utf8', windowsHide: true });
  if (live.status !== 0) { console.error('perf-idle: refused: live-check says live (or failed); nothing started'); return 1; }
  const installed = installedUjwalamProcesses();
  if (installed === null) { console.error('perf-idle: refused: could not check whether the installed studio runs'); return 1; }
  if (installed.length) { console.error(`perf-idle: refused: the installed studio runs (${installed.map((p) => `${p.name} pid ${p.pid}`).join(', ')})`); return 1; }
  setBelow(process.pid);

  const runDir = path.join(REPO, 'out', 'perf-idle', new Date().toISOString().replace(/[:.]/g, '-'));
  const dirs = Object.fromEntries(['core', 'host', 'recv', 'recordings', 'feedback'].map((d) => [d, path.join(runDir, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const checks = [];
  const log = (...m) => console.error('[perf-idle]', ...m);
  const check = (name, pass) => checks.push({ name, pass: !!pass });
  const st = await startStack({ runDir, coreDir: dirs.core, hostData: dirs.host, recvDir: dirs.recv, recordingsDir: dirs.recordings, feedbackDir: dirs.feedback, log, check });
  if (!st) { console.error('perf-idle: the stack did not start'); return 2; }
  let result;
  try {
    log(`warm-up ${warmup} s, then ${minutes} min`);
    await sleep(warmup * 1000);
    const roots = [st.host?.pid, st.core?.pid, st.ui?.pid].filter(Boolean);
    const h0 = await st.c.call('host.status');
    const a = treesOf((await snapshot()) ?? [], roots);
    const g3d = [], genc = [], others = new Set();
    const end = Date.now() + minutes * 60000;
    while (Date.now() < end) {
      const g = await gpu();
      if (g) { g3d.push(g.gpuPct); genc.push(g.encPct); }
      const all = (await snapshot()) ?? [];
      const ours = new Set(treesOf(all, [...roots, process.pid]).map((p) => p.pid));
      for (const p of all) if (!ours.has(p.pid) && /^(ffmpeg|ujwalam-host|obs64|meldstudio)/i.test(p.name)) others.add(p.name);
      await sleep(Math.min(5000, Math.max(0, end - Date.now())));
    }
    const roles = await nodeRoles();
    const b = treesOf((await snapshot()) ?? [], roots);
    const h1 = await st.c.call('host.status');
    const r0 = h0.render ?? {}, r1 = h1.render ?? {};
    result = {
      at: new Date().toISOString(), minutes, warmupS: warmup,
      procs: summarise(a, b, roles),
      gpu: { gpu3dPct: stat(g3d), videoEncodePct: stat(genc) },
      host: {
        live: h1.live, recording: h1.recording,
        renderLagged: (r1.renderLagged ?? 0) - (r0.renderLagged ?? 0), renderTotal: (r1.renderTotal ?? 0) - (r0.renderTotal ?? 0),
        encodeSkipped: (r1.encodeSkipped ?? 0) - (r0.encodeSkipped ?? 0), avgFrameTimeMs: r1.avgFrameTimeMs ?? null,
        canvases: (h1.canvases ?? []).map((c) => ({ id: c.id, skippedFrames: c.skippedFrames - ((h0.canvases ?? []).find((x) => x.id === c.id)?.skippedFrames ?? 0) })),
        cpuPct: h1.cpuPct ?? null
      },
      others: [...others],
      checks
    };
  } finally {
    await st.teardown();
  }
  console.log(JSON.stringify(result));
  try { rmSync(runDir, { recursive: true, force: true }); } catch { /* a file still open: left in out/ (gitignored) */ }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
