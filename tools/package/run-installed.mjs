// SPDX-License-Identifier: GPL-3.0-or-later
// Entry point of an installed (or unzipped) Alpha build, run by Ujwalam.cmd or by ujwalam-start.exe (the shortcuts:
// no console window; its output goes to <data>\core\logs\launcher-*.log, UJWALAM_LAUNCH_LOG). Same as `npm run alpha` from a checkout,
// with every path taken from the install dir and the user's data dir instead of the repo:
//   install dir   two levels above this file (holds release.json, bin/ujwalam-host.exe, obs/)
//   data root     UJWALAM_DATA_ROOT, else %LOCALAPPDATA%\Ujwalam\data (never inside the install dir)
//     core/       event-core data dir (--data-dir): projects/, logs/, flags.local.json, host.json ...
//     host/       host data dir (UJWALAM_HOST_DATA): module config, markers/, recordings/
//     feedback/   feedback captures (--feedback-dir)
//     diag/       diagnostics bundles
//     ujwalam.json  optional user config: { "overlayRoot": "<dir>", "profile": "<file>", "clipRoot": "<dir>",
//                   "updateFolder": "<dir>" } (relative to the data root)
//     profile.local.json  default profile (only when ujwalam.json names none)
//   Overlay root and profile come only from the data root or ujwalam.json, never from the package.
// Usage: Ujwalam.cmd [launcher flags...]   e.g. --mock --no-open --stop-on-stdin, --allow-devices, --live
//        Ujwalam.cmd diag [--out FILE]     diagnostics bundle (tools/diag/bundle.mjs), no host or UI needed
// Node is checked first (release.json nodeMin) and the launcher is loaded only after the check passes.
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function nodeOk(version, min) {
  const p = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const a = p(version);
  const b = p(min);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return true;
}

/**
 * True while Ujwalam setup (Install-Ujwalam.ps1) installs, repairs, rolls back or uninstalls in this install root: it
 * holds <root>\install.lock open with no sharing (Codex review 2026-11-18). A lock file left by nothing is not "busy".
 */
export function installBusy(root) {
  const f = path.join(root, 'install.lock');
  if (!existsSync(f)) return false;
  try { closeSync(openSync(f, 'r')); return false; } catch (e) { return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES'; }
}

export function dataRootFrom(env = process.env) {
  if (env.UJWALAM_DATA_ROOT) return path.resolve(env.UJWALAM_DATA_ROOT);
  if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set; set UJWALAM_DATA_ROOT');
  return path.join(path.resolve(env.LOCALAPPDATA), 'Ujwalam', 'data');
}

/** Paths, environment and launcher argv for an installed run (pure apart from reading ujwalam.json; tested). */
export function installedSpec({ install = INSTALL, dataRoot, userArgs = [] }) {
  const inside = (p) => { const r = path.relative(install, p); return !r.startsWith('..') && !path.isAbsolute(r); };
  if (inside(dataRoot)) throw new Error('the data root must not be inside the install dir');
  let cfg = {};
  const cfgFile = path.join(dataRoot, 'ujwalam.json');
  if (existsSync(cfgFile)) cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const fromCfg = (k, def) => (typeof cfg[k] === 'string' && cfg[k] && !/^<.*>$/.test(cfg[k]) ? path.resolve(dataRoot, cfg[k]) : def);
  // overlayRoot names the folder that holds overlays/, brand/ and kit/ (host overlayRootProblem). Installs from
  // 2026-11-03 wrote the overlays/ folder itself; that form is read as its parent (D278), the file is not rewritten.
  const named = fromCfg('overlayRoot', path.join(dataRoot, 'overlays'));
  const overlayRoot = path.basename(named).toLowerCase() === 'overlays' && existsSync(named) && !existsSync(path.join(named, 'overlays'))
    ? path.dirname(named) : named;
  const profile = fromCfg('profile', path.join(dataRoot, 'profile.local.json'));
  // clipRoot: developer override, a checkout holding services/clip and its Python venv. Unset: the build's own clip
  // maker and its bundled Python (runtime\python, since 2026-11-19).
  const clipRoot = fromCfg('clipRoot', null);
  // updateFolder: the build folder the studio looks in for a newer package (Update available; Ujwalam-Setup.exe writes
  // the folder it installed from). Unset: no update check.
  const updateFolder = fromCfg('updateFolder', null);
  for (const [k, p] of [['overlayRoot', overlayRoot], ['profile', profile]]) {
    if (inside(p)) throw new Error(`${k} must not point into the install dir`);
  }
  const dirs = { core: path.join(dataRoot, 'core'), host: path.join(dataRoot, 'host'), feedback: path.join(dataRoot, 'feedback'), diag: path.join(dataRoot, 'diag') };
  // Bundled ffmpeg/ffprobe (runtime\ffmpeg, 2026-11-19): first on PATH for every child (the clip maker finds them on
  // PATH) and named in FFMPEG/FFPROBE (posting, scene builder, media info). A build without it keeps the PC's PATH.
  const ff = path.join(install, 'runtime', 'ffmpeg');
  const bundledFf = existsSync(path.join(ff, 'ffmpeg.exe'));
  const env = {
    ...(bundledFf ? { PATH: [ff, path.join(install, 'runtime', 'node'), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter), FFMPEG: path.join(ff, 'ffmpeg.exe'), FFPROBE: path.join(ff, 'ffprobe.exe') } : {}),
    UJWALAM_OBS_RUNTIME: path.join(install, 'obs'),
    UJWALAM_HOST_EXE: path.join(install, 'bin', 'ujwalam-host.exe'),
    UJWALAM_HOST_DATA: dirs.host,
    UJWALAM_OVERLAY_ROOT: overlayRoot,
    ...(clipRoot ? { UJWALAM_CLIP_ROOT: clipRoot } : {}),
    ...(updateFolder ? { UJWALAM_UPDATE_DIR: updateFolder } : {}),
  };
  const has = (f) => userArgs.includes(f);
  const argv = ['--alpha'];
  if (!has('--data-dir')) argv.push('--data-dir', dirs.core);
  if (!has('--feedback-dir')) argv.push('--feedback-dir', dirs.feedback);
  if (!has('--profile')) argv.push('--profile', profile);
  argv.push(...userArgs.filter((a) => a !== '--alpha'));
  return { install, dataRoot, dirs, overlayRoot, profile, clipRoot, updateFolder, env, argv };
}

/**
 * ujwalam-start.exe (the shortcuts' windowless start, 2026-11-08) writes each run's output to
 * <data>\core\logs\launcher-<UTC time>-p<pid>.log; keep the newest `keep` (names sort by time). Returns the removed names.
 */
export function pruneLaunchLogs(dir, keep = 10) {
  let names;
  try { names = readdirSync(dir).filter((n) => /^launcher-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-p\d+\.log$/.test(n)).sort(); } catch { return []; }
  const old = names.slice(0, Math.max(0, names.length - keep));
  for (const n of old) { try { rmSync(path.join(dir, n), { force: true }); } catch { /* still open: next time */ } }
  return old;
}

/**
 * The start-up clip maker check (the zip ships no Python, D283): one plain line when clips cannot be made, else null.
 * t = record-clips.mjs clipTools() for the folder the launcher will use (clipRoot from ujwalam.json, else the install).
 */
export function clipMakerNote(t) {
  if (!t || t.py) return null;
  return `[ujwalam] Clips can't be made on this PC yet: ${t.reason}.${t.fix ? ` ${t.fix}.` : ''} Everything else works.`;
}

export async function main(args = process.argv.slice(2)) {
  let release;
  try { release = JSON.parse(readFileSync(path.join(INSTALL, 'release.json'), 'utf8')); } catch { console.log('[ujwalam] release.json missing: run Ujwalam.cmd from an installed or unzipped build'); return 2; }
  if (!nodeOk(process.versions.node, release.nodeMin)) {
    console.log(`[ujwalam] Node.js ${release.nodeMin} or newer is needed (found ${process.versions.node}). Install it from nodejs.org; nothing was started.`);
    return 9;
  }
  if (installBusy(path.dirname(INSTALL))) {
    console.log('[ujwalam] Ujwalam setup is installing, updating, repairing or rolling back right now. Nothing was started: open Ujwalam again when setup has finished.');
    return 14;
  }
  let dataRoot;
  try { dataRoot = dataRootFrom(); } catch (e) { console.log(`[ujwalam] ${e.message}`); return 2; }
  if (process.env.UJWALAM_LAUNCH_LOG) pruneLaunchLogs(path.dirname(process.env.UJWALAM_LAUNCH_LOG));
  if (args[0] === 'diag') {
    const spec = installedSpec({ dataRoot, userArgs: [] });
    const { main: diag } = await import(pathToFileURL(path.join(INSTALL, 'tools', 'diag', 'bundle.mjs')).href);
    const has = (f) => args.includes(f);
    return diag([
      '--data-dir', spec.dirs.core, '--host-data', spec.dirs.host, '--profile', spec.profile, '--release', path.join(INSTALL, 'release.json'),
      ...(has('--out') ? [] : ['--out', path.join(spec.dirs.diag, `ujwalam-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`)]),
      ...args.slice(1),
    ]);
  }
  let spec;
  try { spec = installedSpec({ dataRoot, userArgs: args }); } catch (e) { console.log(`[ujwalam] ${e.message}`); return 2; }
  for (const d of Object.values(spec.dirs)) mkdirSync(d, { recursive: true });
  if (!existsSync(spec.profile)) {
    // The alpha project needs the profile's placeholder values; the package never carries a filled-in one.
    console.log(`[ujwalam] no profile at ${spec.profile}. Copy ${path.join(INSTALL, 'data', 'profile.example.json')} there`);
    console.log('[ujwalam] and fill in your values (it stays on this PC), or name another file with --profile. Nothing was started.');
    return 2;
  }
  Object.assign(process.env, spec.env);
  console.log(`[ujwalam] ${release.version} from ${spec.install}; data ${spec.dataRoot}; overlays ${existsSync(spec.overlayRoot) ? spec.overlayRoot : 'off (no overlay folder)'}; profile ${existsSync(spec.profile) ? 'found' : 'none'}`);
  try {
    const { clipTools } = await import(pathToFileURL(path.join(INSTALL, 'services', 'studio-ui', 'record-clips.mjs')).href);
    const note = clipMakerNote(clipTools({ clipRoot: spec.clipRoot ?? INSTALL })); // the launcher's CLIP_ROOT rule
    if (note) console.log(note);
  } catch { /* the check only informs; the launcher reports clips itself */ }
  const { main: launch } = await import(pathToFileURL(path.join(INSTALL, 'services', 'studio-ui', 'launch.mjs')).href);
  return launch(spec.argv);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());
