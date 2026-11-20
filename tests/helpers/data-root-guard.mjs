// SPDX-License-Identifier: GPL-3.0-or-later
// Tests never touch the user's real Ujwalam data or install (%LOCALAPPDATA%\Ujwalam; coordinator 2026-11-20, after a
// smoke run used it by mistake). Every test data root and install root goes through this guard.
import os from 'node:os';
import path from 'node:path';

export function realUjwalamDir(env = process.env) {
  const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.resolve(base, 'Ujwalam');
}

/** Returns p resolved; throws when it is %LOCALAPPDATA%\Ujwalam or inside it, or not under the temp folder. */
export function safeRoot(p, env = process.env) {
  const r = path.resolve(p);
  const real = realUjwalamDir(env);
  const rel = path.relative(real, r);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error(`refused: ${r} is the real Ujwalam folder`);
  const tmp = path.resolve(os.tmpdir());
  const rt = path.relative(tmp, r);
  if (rt.startsWith('..') || path.isAbsolute(rt)) throw new Error(`refused: test roots live under ${tmp}, not ${r}`);
  return r;
}

/** A child environment whose UJWALAM_DATA_ROOT is the given temp folder (never inherited from the caller). */
export function childEnvWith(dataRoot, extra = {}) {
  return { ...process.env, ...extra, UJWALAM_DATA_ROOT: safeRoot(dataRoot) };
}
