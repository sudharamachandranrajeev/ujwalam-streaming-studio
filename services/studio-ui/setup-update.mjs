// SPDX-License-Identifier: GPL-3.0-or-later
// "Update available" (setup installer, 2026-11-18): the studio offers a newer package from the build folder and installs
// it with one click through Ujwalam-Setup.exe. No polling: the studio asks on start and when the user clicks "Check for
// updates"; while an install runs it re-reads the state until it ends.
//
//   GET  /ui/api/setup/update[?fresh=1]  { installed, current, folder, latest: { version, verified } | null, available,
//                                          installing, last: { ok, code, message, at } | null, reason }
//   POST /ui/api/setup/update  {}        202 { started, version } | 409 { error: live|busy|nothing|not-verified|... , message }
//                                        | 500 { error: not-started, message } (Setup could not be started)
//
// The update folder is data\ujwalam.json "updateFolder" (UJWALAM_UPDATE_DIR, set by run-installed.mjs; Ujwalam-Setup.exe
// writes the folder it installed from). A package is a single-file Ujwalam-Setup-<version>.exe (2026-11-19; preferred)
// or an older ujwalam-<version>-win64.zip; it counts only when its SHA-256 matches the .sha256 file next to it (cached by
// path, size and time). The install runs that setup exe itself (a zip: the build folder's or installed Ujwalam-Setup.exe
// with --package) with --update --quiet --next-start (hidden, below-normal priority; Setup checks the package again and
// Install-Ujwalam.ps1 checks every file and backs the settings up first). Never while live or recording (or when that
// cannot be read): the new version runs from the next start.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROUTE = '/ui/api/setup/update';
const ZIP_RE = /^ujwalam-(\d{1,6}\.\d{1,6}\.\d{1,6}-alpha\.\d{1,6})-win64\.zip$/;
const EXE_RE = /^Ujwalam-Setup-(\d{1,6}\.\d{1,6}\.\d{1,6}-alpha\.\d{1,6})\.exe$/;
const HERE_INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Compares "X.Y.Z-alpha.N" versions (pure). */
export function cmpVersion(a, b) {
  const p = (v) => String(v).split(/[.-]/).filter((x) => x !== 'alpha').map(Number);
  const x = p(a); const y = p(b);
  for (let i = 0; i < 4; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1; }
  return 0;
}

/** The newest package in dir by version: { version, zip, single } (single: a setup exe that carries it; preferred at the same version) or null. */
export function newestPackage(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return null; }
  let best = null;
  for (const n of names) {
    const m = ZIP_RE.exec(n) ?? EXE_RE.exec(n);
    if (!m) continue;
    const single = EXE_RE.test(n);
    const c = best ? cmpVersion(m[1], best.version) : 1;
    if (c > 0 || (c === 0 && single && !best.single)) best = { version: m[1], zip: path.join(dir, n), single };
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
  14: 'Another Ujwalam setup is working right now; try again when it has finished.',
  20: 'No package was found in the build folder.',
  21: 'The package does not match its checksum (it is damaged or incomplete); build or download it again.',
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
  // The build folder's Ujwalam-Setup.exe when it matches its .sha256 (written by npm run package:alpha), else the one
  // installed in the install root (checked against SHA256SUMS.txt when it was installed). Resolved once per POST.
  async function setupExe(fresh) {
    const built = updateDir && path.join(updateDir, 'Ujwalam-Setup.exe');
    if (built && existsSync(built) && await verified(built, fresh)) return built;
    const own = path.join(root, 'Ujwalam-Setup.exe');
    return existsSync(own) ? own : null;
  }

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
    const exe = pkg.single ? pkg.zip : await setupExe(fresh);
    if (!exe) return { ...base, latest: { version: pkg.version, verified: true }, reason: 'no-setup' };
    return { ...base, latest: { version: pkg.version, verified: true }, available: true, reason: null, zip: pkg.zip, exe };
  }

  // Live or recording, or unknown: refuse (fail closed).
  async function onAir() {
    try {
      const hs = await opts.hostStatus();
      return !hs || hs.live === true || hs.recording === true || hs.starting === true;
    } catch { return true; }
  }

  // Starts Setup; throws when it cannot be started (the caller clears `installing`).
  function runSetup(exe, zip, version) {
    // A single-file setup installs what it carries; a zip is handed to Setup.
    const args = ['--update', '--quiet', '--next-start', ...(exe === zip ? [] : ['--package', zip]), '--install-root', root];
    const c = spawnImpl(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (!c || typeof c.on !== 'function') throw new Error('Ujwalam-Setup.exe did not start');
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
      delete s.exe;
      json(res, 200, s);
      return true;
    }
    if (method !== 'POST') return false;
    if (installing || checking) { json(res, 409, { error: 'busy', message: 'An update is already being installed.' }); return true; }
    const liveMsg = { error: 'live', message: 'Stop the stream and the recording first; the update installs when nothing is on air.' };
    checking = true;
    let s;
    try {
      if (await onAir()) { json(res, 409, liveMsg); return true; }
      s = await state(true);
      // Checking the package takes a while: asked again right before Setup starts (Codex review 2026-11-18). Setup
      // itself never touches the running studio either (it only switches current.txt for the next start).
      if (s.available && await onAir()) { json(res, 409, liveMsg); return true; }
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
    try {
      runSetup(s.exe, s.zip, s.latest.version);
    } catch (e) {
      // Not started (Setup missing, blocked or quarantined meanwhile): nothing is installing.
      installing = null;
      last = { ok: false, code: -1, version: s.latest.version, at: now(), message: `Ujwalam setup could not be started (${e.code ?? e.message}); nothing was changed.`, lines: [] };
      log(`setup update ${s.latest.version}: not started (${e.message})`);
      json(res, 500, { error: 'not-started', message: last.message });
      return true;
    }
    json(res, 202, { started: true, version: s.latest.version });
    return true;
  }

  return { handle, state };
}
