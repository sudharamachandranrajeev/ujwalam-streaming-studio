#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Is the user's installed studio live or recording right now? Agents run this before any heavy step (builds, tests,
// CI, model loads, ffmpeg): a stream on air must never compete with agent work for the CPU or GPU (2026-11-18: agent
// tests and builds during a live stream lined up with 183 capture-audio restarts).
//   node tools/live-check.mjs        exit 0 = off air, exit 1 = live or recording (sinks listed), exit 2 = unknown
// Reads the newest host log of the installed app (%LOCALAPPDATA%\Ujwalam\data\host\logs) and follows each sink's
// last "live" / "stopped" / "failed" line; "dropped" followed by "retry" stays live. The age of the log does not
// matter (a long stream can log nothing for minutes): a live sink counts until its "stopped"/"failed" line, the
// host's "exit" line, or until no installed host process (an ujwalam-host.exe under %LOCALAPPDATA%\Ujwalam) runs, the
// case of a host that crashed while live. Same rule as services/clip/clip_common.py on_air(). Read only; prints sink
// ids and states, nothing else from the log.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function sinkStates(text) {
  const state = new Map();
  for (const m of text.matchAll(/\[host\] sink (\S+) (live|stopped|failed|dropped)\b/g)) state.set(m[1], m[2]);
  return state;
}

export function liveSinks(text) {
  return [...sinkStates(text)].filter(([, s]) => s === 'live' || s === 'dropped').map(([id]) => id);
}

/** The host wrote its "exit" line: the process that owned this log has ended. */
export const hostExited = (text) => /\[host\] exit\b/.test(text);

/** { code, line } from the log text and hostRunning(): true | false | null (could not tell). */
export function decide(text, hostRunning) {
  const live = liveSinks(text);
  if (!live.length) return { code: 0, line: 'live-check: off air' };
  if (hostExited(text)) return { code: 0, line: 'live-check: off air (the host closed)' };
  const run = hostRunning();
  if (run === true) return { code: 1, line: `live-check: LIVE (${live.join(', ')}); do no heavy work` };
  if (run === false) return { code: 0, line: 'live-check: off air (the host ended without closing its log)' };
  return { code: 2, line: `live-check: sinks ${live.join(', ')} were live and the host process could not be checked; unknown` };
}

/** Is an installed host (ujwalam-host.exe under %LOCALAPPDATA%\Ujwalam) running? By path, never by name alone. */
export function installedHostRunning(base = process.env.LOCALAPPDATA) {
  if (process.platform !== 'win32' || !base) return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-Process -Name ujwalam-host -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }"],
  { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.status !== 0 || r.error) return null;
  const root = path.join(base, 'Ujwalam').toLowerCase() + path.sep;
  return r.stdout.split(/\r?\n/).some((p) => p.trim().toLowerCase().startsWith(root));
}

function main() {
  const base = process.env.LOCALAPPDATA;
  const dir = base ? path.join(base, 'Ujwalam', 'data', 'host', 'logs') : null;
  if (!dir || !existsSync(dir)) { console.log('live-check: no installed host logs; off air'); return 0; }
  const logs = readdirSync(dir).filter((f) => /^host-.*\.log$/.test(f)).map((f) => path.join(dir, f));
  if (!logs.length) { console.log('live-check: no host log; off air'); return 0; }
  const newest = logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  let text;
  try { text = readFileSync(newest, 'utf8'); } catch (e) { console.log(`live-check: cannot read the host log (${e.code ?? e.message}); unknown`); return 2; }
  const { code, line } = decide(text, () => installedHostRunning(base));
  console.log(line);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
