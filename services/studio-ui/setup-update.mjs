// SPDX-License-Identifier: GPL-3.0-or-later
// "Update available" (setup installer, 2026-11-18): the studio offers a newer package from the build folder and installs
// it with one click through Ujwalam-Setup.exe. No polling: the studio asks on start and when the user clicks "Check for
// updates"; while an install runs it re-reads the state until it ends.
//
//   GET  /ui/api/setup/update[?fresh=1]  { installed, current, folder, latest: { version, verified } | null, available,
//                                          installing, last: { ok, code, message, at } | null, reason }
//   POST /ui/api/setup/update  {}        202 { started, version } | 409 { error: live|busy|nothing|not-verified|... , message }
//
// The update folder is data\ujwalam.json "updateFolder" (UJWALAM_UPDATE_DIR, set by run-installed.mjs; Ujwalam-Setup.exe
// writes the folder it installed from). A package counts only when its SHA-256 matches its .zip.sha256 file (cached by
// path, size and time). The install runs Ujwalam-Setup.exe --update --quiet --next-start (hidden, below-normal
// priority; it checks the zip again and Install-Ujwalam.ps1 checks every file and backs the settings up first). Never
// while live or recording (or when that cannot be read): the new version runs from the next start.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTE = '/ui/api/setup/update';
const ZIP_RE = /^ujwalam-(\d{1,6}\.\d{1,6}\.\d{1,6}-alpha\.\d{1,6})-win64\.zip$/;
const HERE_INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Compares "X.Y.Z-alpha.N" versions (pure). */
export function cmpVersion(a, b) {
  const p = (v) => String(v).split(/[.-]/).filter((x) => x !== 'alpha').map(Number);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 4; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; }
  return 0;
}

/** The newest ujwalam-<version>-win64.zip in dir by version: { version, zip } or null. */
export function newestPackage(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    const m = ZIP_RE.exec(n);
    if (m && (!best || cmpVersion(m[1], best.version) > 0)) best = { version: m[1], zip: path.join(dir, n) };
  }
  return best;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

// What Ujwalam-Setup.exe exits with (app/setup/src/setup.cpp) and Install-Ujwalam.ps1's codes, in plain words.
const MESSAGES = {
  4: 'That version is already installed.',
  7: 'The package does not match its checksums; build it again.',
  10: 'The package is incomplete; build it again.',
  13: 'Your settings could not be backed up, so nothing was changed.',
  20: 'No package was found in the build folder.',
  21: 'The package does not match its checksum file; build it again.',
  22: 'The package could not be unpacked; nothing was changed.',
  26: 'The package is not newer than the installed version.',
};

/**
 * opts: { json, log, updateDir, installDir, hostStatus: async () => host.status, spawnImpl, now }.
 * installDir is the running version's folder (<install root>\<version>); a checkout run has no install root.
 * Returns { handle(method, route, res, url) -> Promise<boolean> }.
 */
export function createSetupUpdate(opts) {
  const { json } = opts;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const spawnImpl = opts.spawnImpl ?? spawn;
  const installDir = path.resolve(opts.installDir ?? HERE_INSTALL);
  const root = path.dirname(installDir);
  const updateDir = typeof opts.updateDir === 'string' && opts.updateDir ? path.resolve(opts.updateDir) : null;
  const sums = new Map(); // zip path -> { key, ok }
  let installing = null; // { version, started }
  let checking = false; // a POST between its first check and the start
  let last = null;

  const current = () => {
    try { return JSON.parse(readFileSync(path.join(installDir, 'release.json'), 'utf8')).version ?? null; } catch { return null; }
  };
  const installed = () => existsSync(path.join(root, 'current.txt')) && existsSync(path.join(installDir, 'release.json'));
  const setupExe = () => [updateDir && path.join(updateDir, 'Ujwalam-Setup.exe'), path.join(root, 'Ujwalam-Setup.exe')].find((f) => f && existsSync(f)) ?? null;

  async function verified(zip, fresh) {
    let st;
    try { st = statSync(zip); } catch { return false; }
    const key = `${st.size}:${st.mtimeMs}`;
    const hit = sums.get(zip);
    if (!fresh && hit && hit.key === key) return hit.ok;
    let ok = false;
    try {
      const want = readFileSync(`${zip}.sha256`, 'utf8').trim().slice(0, 64).toLowerCase();
      ok = /^[0-9a-f]{64}$/.test(want) && (await hashFile(zip)) === want;
    } catch { ok = false; }
    sums.set(zip, { key, ok });
    return ok;
  }

  async function state(fresh) {
    const base = { installed: installed(), current: current(), folder: updateDir, latest: null, available: false, installing: installing?.version ?? null, last };
    if (!base.installed) return { ...base, reason: 'not-installed' };
    if (!updateDir) return { ...base, reason: 'no-update-folder' };
    const pkg = newestPackage(updateDir);
    if (!pkg) return { ...base, reason: 'no-package' };
    const newer = !base.current || cmpVersion(pkg.version, base.current) > 0;
    if (!newer) return { ...base, latest: { version: pkg.version, verified: null }, reason: 'up-to-date' };
    const ok = await verified(pkg.zip, fresh);
    if (!ok) return { ...base, latest: { version: pkg.version, verified: false }, reason: 'not-verified' };
    if (!setupExe()) return { ...base, latest: { version: pkg.version, verified: true }, reason: 'no-setup' };
    return { ...base, latest: { version: pkg.version, verified: true }, available: true, reason: null, zip: pkg.zip };
  }

  // Live or recording, or unknown: refuse (fail closed).
  async function onAir() {
    try {
      const hs = await opts.hostStatus();
      return !hs || hs.live === true || hs.recording === true || hs.starting === true;
    } catch { return true; }
  }

  function runSetup(exe, zip, version) {
    const args = ['--update', '--quiet', '--next-start', '--package', zip, '--install-root', root];
    const c = spawnImpl(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* it still runs */ }
    const tail = [];
    const keep = (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) { tail.push(l.trim()); if (tail.length > 30) tail.shift(); } };
    c.stdout?.on('data', keep);
    c.stderr?.on('data', keep);
    const done = (code) => {
      if (!installing) return;
      const ok = code === 0;
      last = { ok, code, version, at: now(),
        message: ok ? `Ujwalam ${version} is installed. Close the studio and open Ujwalam again to use it.`
          : `${MESSAGES[code] ?? 'The update stopped.'} (code ${code})`, lines: tail.slice(-12) };
      log(`setup update ${version}: exit ${code}`);
      installing = null;
    };
    c.on('error', (e) => { tail.push(e.message); done(-1); });
    c.on('exit', (code) => done(code ?? -1));
  }

  async function handle(method, route, res, url) {
    if (route !== ROUTE) return false;
    if (method === 'GET') {
      const s = await state(url?.searchParams?.get('fresh') === '1');
      delete s.zip;
      json(res, 200, s);
      return true;
    }
    if (method !== 'POST') return false;
    if (installing || checking) { json(res, 409, { error: 'busy', message: 'An update is already being installed.' }); return true; }
    checking = true;
    let s;
    try {
      if (await onAir()) {
        json(res, 409, { error: 'live', message: 'Stop the stream and the recording first; the update installs when nothing is on air.' });
        return true;
      }
      s = await state(true);
    } finally { checking = false; }
    if (!s.available) {
      const message = s.reason === 'not-verified' ? 'The package in the build folder does not match its checksum file; build it again.'
        : s.reason === 'no-setup' ? 'Ujwalam-Setup.exe is not in the build folder; build the package again.'
          : 'There is no newer package in the build folder.';
      json(res, 409, { error: s.reason ?? 'nothing', message });
      return true;
    }
    installing = { version: s.latest.version, started: now() };
    last = null;
    runSetup(setupExe(), s.zip, s.latest.version);
    json(res, 202, { started: true, version: s.latest.version });
    return true;
  }

  return { handle, state };
}
