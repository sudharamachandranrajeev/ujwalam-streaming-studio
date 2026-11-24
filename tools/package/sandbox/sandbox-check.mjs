#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Clean-PC check of a release build in Windows Sandbox (D443 release items, 2026-11-24; the user enabled Sandbox):
// install, first start, one model download, uninstall, on a fresh Windows with nothing else installed.
//   node tools/package/sandbox/sandbox-check.mjs [--setup FILE] [--out DIR] [--download ID] [--timeout-min 30]
//                                                [--keep-open]
//   setup     default: the newest out/dist/Ujwalam-Setup-*.exe; checked against its .sha256 first.
//   out       default: C:\AI\Claude\_data\Ujwalam\scratch\sandbox-<version>-<time> (never the Temp folder).
// The Sandbox sees three folders: the setup's folder (read-only), this folder (read-only) and the out folder (the
// only one it can write). in-sandbox.ps1 does the work there and shuts the Sandbox down; this script waits for
// <out>\done.json and prints <out>\results.json. Exit 0 only when every step passed. Never while live
// (tools/live-check.mjs): the Sandbox takes memory and GPU time.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const SANDBOX_EXE = path.join(process.env.windir ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
const SCRATCH = 'C:\\AI\\Claude\\_data\\Ujwalam\\scratch';
const IN = 'C:\\ujw'; // mapped folder root inside the Sandbox

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The .wsb configuration (pure; tested). */
export function wsbConfig({ distDir, harnessDir, outDir, setupName, download, keepOpen }) {
  // The logon command can run before the mapped folders are there: wait for the script (up to 5 min) first.
  const script = `${IN}\\harness\\in-sandbox.ps1`;
  const cmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "`
    + `for ($i = 0; $i -lt 300 -and -not ((Test-Path '${script}') -and (Test-Path '${IN}\\out')); $i++) { Start-Sleep 1 }; `
    + `& '${script}' -Setup '${IN}\\dist\\${setupName}' -Out '${IN}\\out' -Download '${download}'${keepOpen ? ' -KeepOpen' : ''}"`;
  const map = (host, box, ro) => `    <MappedFolder><HostFolder>${xml(host)}</HostFolder><SandboxFolder>${xml(box)}</SandboxFolder><ReadOnly>${ro}</ReadOnly></MappedFolder>`;
  return [
    '<Configuration>',
    // vGPU on and 6 GiB both lost the connection before the desktop on this PC (2026-11-24); the default (4 GiB) and
    // no vGPU boot. Without vGPU the host draws on Windows' software renderer, like a PC with no usable graphics card.
    '  <vGPU>Disable</vGPU>',
    '  <Networking>Default</Networking>',
    '  <AudioInput>Disable</AudioInput>',
    '  <VideoInput>Disable</VideoInput>',
    '  <ClipboardRedirection>Disable</ClipboardRedirection>',
    '  <PrinterRedirection>Disable</PrinterRedirection>',
    '  <MappedFolders>',
    map(distDir, `${IN}\\dist`, 'true'),
    map(harnessDir, `${IN}\\harness`, 'true'),
    map(outDir, `${IN}\\out`, 'false'),
    '  </MappedFolders>',
    `  <LogonCommand><Command>${xml(cmd)}</Command></LogonCommand>`,
    '</Configuration>',
    '',
  ].join('\n');
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (b) => h.update(b)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function newestSetup() {
  const dist = path.join(REPO, 'out', 'dist');
  const re = /^Ujwalam-Setup-\d+\.\d+\.\d+-alpha\.(\d+)\.exe$/;
  const hits = (existsSync(dist) ? readdirSync(dist) : []).filter((n) => re.test(n)).sort((a, b) => Number(a.match(re)[1]) - Number(b.match(re)[1]));
  return hits.length ? path.join(dist, hits.at(-1)) : null;
}

const sandboxRunning = () => {
  const r = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq WindowsSandboxRemoteSession.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /WindowsSandboxRemoteSession/i.test(r.stdout ?? '');
};

async function main() {
  const a = {};
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i].replace(/^--/, '');
    if (k === 'keep-open') a[k] = true; else a[k] = process.argv[++i];
  }
  if (!existsSync(SANDBOX_EXE)) throw new Error('Windows Sandbox is not installed (WindowsSandbox.exe missing)');
  const live = spawnSync(process.execPath, [path.join(REPO, 'tools', 'live-check.mjs')], { encoding: 'utf8', windowsHide: true });
  if (!/off air/.test(live.stdout ?? '')) throw new Error(`not off air: ${(live.stdout ?? '').trim()}`);
  if (sandboxRunning()) throw new Error('a Windows Sandbox is already running (only one at a time); close it first');

  const setup = path.resolve(a.setup ?? newestSetup() ?? '');
  if (!existsSync(setup)) throw new Error('no setup file (build one with npm run package:alpha, or pass --setup)');
  const want = readFileSync(`${setup}.sha256`, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const got = await sha256(setup);
  if (got !== want) throw new Error(`${path.basename(setup)} does not match its .sha256`);
  const version = path.basename(setup).replace(/^Ujwalam-Setup-|\.exe$/g, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.resolve(a.out ?? path.join(SCRATCH, `sandbox-${version}-${stamp}`));
  mkdirSync(outDir, { recursive: true });
  if (readdirSync(outDir).length) throw new Error(`out folder not empty: ${outDir}`);

  const wsb = path.join(outDir, '..', `sandbox-${version}-${stamp}.wsb`);
  writeFileSync(wsb, wsbConfig({ distDir: path.dirname(setup), harnessDir: HERE, outDir, setupName: path.basename(setup), download: a.download ?? 'face-ai-models', keepOpen: a['keep-open'] === true }));
  console.log(`[sandbox] ${path.basename(setup)} (sha256 ok) -> ${outDir}`);
  const t0 = Date.now();
  spawn(SANDBOX_EXE, [wsb], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  const limit = Number(a['timeout-min'] ?? 30) * 60_000;
  const done = path.join(outDir, 'done.json');
  while (!existsSync(done)) {
    if (Date.now() - t0 > limit) throw new Error(`no result after ${a['timeout-min'] ?? 30} min; the Sandbox is left open for a look (${outDir})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  await new Promise((r) => setTimeout(r, 1000));
  const res = JSON.parse(readFileSync(path.join(outDir, 'results.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const s of res.steps) console.log(`[sandbox] ${s.ok ? 'PASS' : 'FAIL'} ${s.name} (${s.seconds} s)`);
  console.log(`[sandbox] ${res.ok ? 'all steps passed' : 'FAILED'} in ${((Date.now() - t0) / 60000).toFixed(1)} min; details ${path.join(outDir, 'results.json')}`);
  return res.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(`[sandbox] ${e.message}`); process.exit(2); });
}
