#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Builds Ujwalam-Setup.exe (app/setup) into out/setup/build (gitignored).
//   node app/setup/tools/build.mjs [--reconfigure]
// cmake, ninja and cl come from VS Build Tools' vcvars64.bat (found through vswhere, as the studio build). No Qt.
// Nothing is installed. The build runs at below-normal priority with at most 4 parallel jobs.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vcvars } from '../../studio/tools/build.mjs';

export const SETUP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SETUP_DIR, '..', '..');
// UJWALAM_SETUP_BUILD: another build folder (a worktree build that must not replace the main checkout's).
export const BUILD_DIR = process.env.UJWALAM_SETUP_BUILD ? path.resolve(process.env.UJWALAM_SETUP_BUILD) : path.join(REPO_ROOT, 'out', 'setup', 'build');
export const SETUP_EXE = path.join(BUILD_DIR, 'ujwalam-setup.exe');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const build = path.relative(REPO_ROOT, BUILD_DIR);
  const src = path.relative(REPO_ROOT, SETUP_DIR);
  const steps = [];
  if (process.argv.includes('--reconfigure') || !existsSync(path.join(BUILD_DIR, 'build.ninja'))) {
    steps.push(`cmake -S "${src}" -B "${build}" -G Ninja -DCMAKE_BUILD_TYPE=Release`);
  }
  steps.push(`cmake --build "${build}" -j 4`);
  const bat = vcvars();
  if (!bat) { console.error('VS Build Tools (vcvars64.bat) not found'); process.exit(69); }
  const line = `call "${bat}" >nul && ${steps.join(' && ')}`;
  const c = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: REPO_ROOT, stdio: 'inherit', windowsVerbatimArguments: true, windowsHide: true });
  // Below normal before vcvars finishes: the compiler and linker it starts inherit the priority class.
  try { os.setPriority(c.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* the build still runs */ }
  c.on('exit', (code) => {
    if (code === 0 && existsSync(SETUP_EXE)) console.log(`built ${SETUP_EXE}`);
    process.exit(code ?? 1);
  });
}
