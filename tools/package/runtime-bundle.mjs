#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// The runtimes the package carries (single-file setup, 2026-11-19): Node.js, the Python embeddable distribution with
// the clip and face workers' packages and OCR models, ffmpeg/ffprobe, and the Visual C++ runtime DLLs deployed next to
// every exe folder (app-local, no vc_redist, no admin rights). Pinned in data/runtime/bundle.json.
//
//   prepareRuntime({ repo, cache, log }) -> { files: [{ dest, src, why }], info }
//     dest is the package path ('/' separators). Every input is checked against its SHA-256 in bundle.json; a mismatch
//     stops the build. Downloads (Node zip, Python zip, OCR models) are cached in <cache> (default out/runtime-cache,
//     gitignored) and fetched again only when missing or wrong. The Python packages are installed once per lock-file
//     hash with the build PC's own Python 3.14.7 (pip --target --no-index --require-hashes from the cached wheels;
//     the wheels themselves are fetched with pip download from PyPI when missing).
//   node tools/package/runtime-bundle.mjs [--check]   prepares (or only checks) the cache and prints the summary
//
// Build-PC inputs: ffmpeg from UJWALAM_FFMPEG_DIR or PATH, the CRT from UJWALAM_VC_CRT_DIR or VS Build Tools (vswhere),
// Python 3.14.7 from UJWALAM_BUILD_PYTHON or PATH. Nothing is installed on the PC; everything lands in <cache>.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntry, readZip } from './zip.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileSha = (f) => sha256(readFileSync(f));
const posix = (p) => p.split(path.sep).join('/');

export function loadBundle(repo = REPO) {
  return JSON.parse(readFileSync(path.join(repo, 'data', 'runtime', 'bundle.json'), 'utf8'));
}

/** The CRT file names and the package folders they go next to (pure; used by the allowlist too). */
export function crtTargets(bundle) {
  const names = Object.keys(bundle.vcRuntime.files);
  return bundle.vcRuntime.nextTo.flatMap((dir) => names.map((n) => (dir ? `${dir}/${n}` : n)));
}

async function download(url, dest, want, log) {
  if (existsSync(dest) && fileSha(dest) === want) return dest;
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== want) throw new Error(`download ${url}: SHA-256 ${got}, expected ${want}; refused`);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(`${dest}.part`, buf);
  renameSync(`${dest}.part`, dest);
  return dest;
}

function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, n.name);
    if (n.isSymbolicLink()) continue;
    if (n.isDirectory()) walk(p, base, out); else if (n.isFile()) out.push(posix(path.relative(base, p)));
  }
  return out;
}

function which(name) {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (d && existsSync(path.join(d, name))) return path.join(d, name);
  }
  return null;
}

function crtDir(bundle) {
  if (process.env.UJWALAM_VC_CRT_DIR) return path.resolve(process.env.UJWALAM_VC_CRT_DIR);
  const ver = bundle.vcRuntime.version.split(' ')[0];
  const pf86 = process.env['ProgramFiles(x86)'];
  const vswhere = pf86 && path.join(pf86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!vswhere || !existsSync(vswhere)) return null;
  const r = spawnSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath'], { encoding: 'utf8', windowsHide: true });
  const vs = r.stdout?.trim().split(/\r?\n/)[0];
  return vs ? path.join(vs, 'VC', 'Redist', 'MSVC', ver, 'x64', 'Microsoft.VC143.CRT') : null;
}

function buildPython(version) {
  const exe = process.env.UJWALAM_BUILD_PYTHON || which('python.exe');
  if (!exe) throw new Error(`Python ${version} is needed on the build PC to install the bundled packages (UJWALAM_BUILD_PYTHON or PATH)`);
  const r = spawnSync(exe, ['-I', '-c', 'import platform,struct;print(platform.python_version(),struct.calcsize("P")*8)'], { encoding: 'utf8', windowsHide: true });
  const [v, bits] = (r.stdout ?? '').trim().split(' ');
  if (v !== version || bits !== '64') throw new Error(`the build Python is ${v} ${bits}-bit (${exe}); the bundle needs exactly ${version} 64-bit (same ABI as the embeddable one)`);
  return exe;
}

function lockWheels(lockText) {
  const out = [];
  let cur = null;
  for (const l of lockText.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)==([^\s\\]+)/.exec(l);
    if (m) { cur = { name: m[1], version: m[2], hashes: [] }; out.push(cur); continue; }
    const h = /--hash=sha256:([0-9a-f]{64})/.exec(l);
    if (h && cur) cur.hashes.push(h[1]);
  }
  return out;
}

export async function prepareRuntime({ repo = REPO, cache = path.join(repo, 'out', 'runtime-cache'), log = (s) => console.log(`[runtime] ${s}`) } = {}) {
  const b = loadBundle(repo);
  const byDest = new Map(); // later wins: the pinned CRT replaces the embeddable Python's own vcruntime140*.dll
  const add = (dest, src, why) => byDest.set(dest.toLowerCase(), { dest, src, why });
  const info = {};

  // 1. Node.js: node.exe and LICENSE from the official zip.
  const nodeZip = await download(b.node.url, path.join(cache, 'node', path.basename(b.node.url)), b.node.sha256, log);
  const nodeDir = path.join(cache, 'node', `v${b.node.version}`);
  const entries = readZip(nodeZip);
  for (const [entry, name] of Object.entries(b.node.take)) {
    const out = path.join(nodeDir, name);
    if (!existsSync(out)) {
      const e = entries.find((x) => x.name === entry);
      if (!e) throw new Error(`node zip has no ${entry}`);
      mkdirSync(nodeDir, { recursive: true });
      writeFileSync(out, extractEntry(nodeZip, e));
    }
    add(`runtime/node/${name}`, out, `Node.js ${b.node.version}`);
  }
  info.node = { version: b.node.version, sha256: fileSha(path.join(nodeDir, 'node.exe')) };

  // 2. Python embeddable + packages + OCR models.
  const pyZip = await download(b.python.url, path.join(cache, 'python', path.basename(b.python.url)), b.python.sha256, log);
  const embed = path.join(cache, 'python', `embed-${b.python.sha256.slice(0, 12)}`);
  if (!existsSync(path.join(embed, '.done'))) {
    rmSync(embed, { recursive: true, force: true });
    for (const e of readZip(pyZip)) {
      const out = path.join(embed, ...e.name.split('/'));
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, extractEntry(pyZip, e));
    }
    writeFileSync(path.join(embed, '.done'), b.python.sha256);
  }
  const pthName = readdirSync(embed).find((n) => /^python\d+\._pth$/.test(n));
  for (const r of walk(embed)) {
    if (r === '.done' || r === pthName) continue;
    add(`runtime/python/${r}`, path.join(embed, ...r.split('/')), `Python ${b.python.version} embeddable`);
  }
  const pth = path.join(cache, 'python', pthName);
  writeFileSync(pth, `${b.python.pth.join('\r\n')}\r\n`); // no "import site": only the folders listed, no user site
  add(`runtime/python/${pthName}`, pth, 'Python search path (generated)');

  const lockText = readFileSync(path.join(repo, ...b.python.lock.split('/')), 'utf8');
  const lockSha = sha256(lockText).slice(0, 12);
  const wheelDir = path.join(cache, 'wheels');
  const site = path.join(cache, 'python', `site-${lockSha}`);
  if (!existsSync(path.join(site, '.done'))) {
    const py = buildPython(b.python.version);
    const wheels = lockWheels(lockText);
    const have = new Set(existsSync(wheelDir) ? readdirSync(wheelDir).map((n) => fileSha(path.join(wheelDir, n))) : []);
    if (wheels.some((w) => !w.hashes.some((h) => have.has(h)))) {
      log('downloading the locked wheels from PyPI');
      const req = path.join(cache, 'python', `req-${lockSha}.txt`);
      writeFileSync(req, wheels.map((w) => `${w.name}==${w.version}`).join('\n'));
      const d = spawnSync(py, ['-m', 'pip', 'download', '--no-deps', '--only-binary', ':all:', '--platform', 'win_amd64', '--python-version', '3.14', '--implementation', 'cp',
        '--abi', 'cp314', '--abi', 'abi3', '--abi', 'none', '-d', wheelDir, '-r', req, '-q', '--disable-pip-version-check'], { encoding: 'utf8', windowsHide: true });
      if (d.status !== 0) throw new Error(`pip download failed: ${(d.stderr ?? '').trim().slice(-800)}`);
    }
    rmSync(site, { recursive: true, force: true });
    log(`installing ${wheels.length} locked packages (no index, hashes required)`);
    const r = spawnSync(py, ['-m', 'pip', 'install', '--no-deps', '--no-index', '--find-links', wheelDir, '--require-hashes', '--only-binary', ':all:', '--no-compile',
      '--disable-pip-version-check', '--target', site, '-r', path.join(repo, ...b.python.lock.split('/')), '-q'], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`pip install --target failed: ${(r.stderr ?? '').trim().slice(-800)}`);
    rmSync(path.join(site, 'bin'), { recursive: true, force: true }); // console-script launchers point at the build PC's Python
    for (const m of b.ocrModels.files) {
      const dest = path.join(site, ...b.ocrModels.dir.replace(/^Lib\/site-packages\//, '').split('/'), m.file);
      const cached = await download(m.url, path.join(cache, 'ocr', m.file), m.sha256, log);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(cached));
    }
    writeFileSync(path.join(site, '.done'), lockSha);
  }
  for (const m of b.ocrModels.files) {
    const f = path.join(site, ...b.ocrModels.dir.replace(/^Lib\/site-packages\//, '').split('/'), m.file);
    if (!existsSync(f) || fileSha(f) !== m.sha256) throw new Error(`OCR model ${m.file} is missing or not the pinned file`);
  }
  let siteCount = 0;
  for (const r of walk(site)) {
    // No package test suites ship (the bundle carries no tests); numpy.testing and the like are code, not tests, and stay.
    if (r === '.done' || /(^|\/)(__pycache__|tests?)\//.test(r)) continue;
    add(`runtime/python/Lib/site-packages/${r}`, path.join(site, ...r.split('/')), 'Python package (requirements-bundle.lock.txt)');
    siteCount++;
  }
  info.python = { version: b.python.version, packages: lockWheels(lockText).length, siteFiles: siteCount };

  // 3. ffmpeg / ffprobe and their DLLs, each pinned.
  const ffBin = process.env.UJWALAM_FFMPEG_DIR ? path.resolve(process.env.UJWALAM_FFMPEG_DIR) : (which('ffmpeg.exe') && path.dirname(which('ffmpeg.exe')));
  if (!ffBin) throw new Error('ffmpeg not found (UJWALAM_FFMPEG_DIR or PATH)');
  for (const [n, want] of Object.entries(b.ffmpeg.files)) {
    const f = path.join(ffBin, n);
    if (!existsSync(f) || fileSha(f) !== want) throw new Error(`ffmpeg input ${n} in the ffmpeg folder is missing or not the pinned file (data/runtime/bundle.json)`);
    add(`runtime/ffmpeg/${n}`, f, `ffmpeg ${b.ffmpeg.version}`);
  }
  for (const [rel, want] of Object.entries(b.ffmpeg.licenceFile)) {
    const f = path.resolve(ffBin, rel);
    if (!existsSync(f) || fileSha(f) !== want) throw new Error('ffmpeg LICENSE.txt is missing or not the pinned file');
    add('runtime/ffmpeg/LICENSE.txt', f, 'ffmpeg licence');
  }
  info.ffmpeg = { version: b.ffmpeg.version };

  // 4. Visual C++ runtime, app-local next to every exe folder.
  const crt = crtDir(b);
  if (!crt || !existsSync(crt)) throw new Error(`Visual C++ redist folder not found (${crt ?? 'no VS Build Tools'}; UJWALAM_VC_CRT_DIR)`);
  for (const [n, want] of Object.entries(b.vcRuntime.files)) {
    if (fileSha(path.join(crt, n)) !== want) throw new Error(`VC++ runtime ${n} is not the pinned file (data/runtime/bundle.json)`);
  }
  for (const dest of crtTargets(b)) add(dest, path.join(crt, path.posix.basename(dest)), `Visual C++ runtime ${b.vcRuntime.version.split(' ')[0]} (app-local)`);
  info.vcRuntime = { version: b.vcRuntime.version.split(' ')[0] };

  return { files: [...byDest.values()].sort((a, b) => a.dest.localeCompare(b.dest)), info };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const t0 = Date.now();
    const r = await prepareRuntime();
    const bytes = r.files.reduce((s, f) => s + statSync(f.src).size, 0);
    console.log(JSON.stringify({ ...r.info, files: r.files.length, mib: Math.round(bytes / 1048576), seconds: Math.round((Date.now() - t0) / 1000) }, null, 2));
  } catch (e) {
    console.error(`[runtime] FAILED: ${e.message}`);
    process.exit(1);
  }
}
