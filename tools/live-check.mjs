#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Is the user's installed studio live or recording right now? Agents run this before any heavy step (builds, tests,
// CI, model loads, ffmpeg): a stream on air must never compete with agent work for the CPU or GPU (2026-11-18: agent
// tests and builds during a live stream lined up with 183 capture-audio restarts).
//   node tools/live-check.mjs        exit 0 = off air, exit 1 = live or recording (sinks listed), exit 2 = unknown
// Rule (same as services/clip/clip_common.py on_air()): no installed host process (an ujwalam-host.exe under
// %LOCALAPPDATA%\Ujwalam) = off air. For each running installed host, its own log in
// %LOCALAPPDATA%\Ujwalam\data\host\logs (host-<start time>.log, named at the host's start): each sink's last
// "live" / "stopped" / "failed" / "dropped" line; "dropped" (retrying) stays live; a live sink counts however old the
// log is, until the host's "exit" line. Unknown (exit 2): an ujwalam-host.exe whose path or start time cannot be read
// (an elevated host), the process list failing, or a running host whose log is missing or unreadable. Read only;
// prints sink ids and states, nothing else from the log.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOG_BIND_SEC = 120;

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

/** Seconds since 1970 of a local "YYYY-MM-DDTHH-MM-SS" stamp, or null. */
export function stampSec(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000 : null;
}

/** The log of the host started at startSec: the newest host-<stamp>.log within LOG_BIND_SEC of the start, or null. */
export function logForStart(names, startSec) {
  let best = null;
  for (const f of names) {
    const m = /^host-(.+)\.log$/.exec(f);
    const t = m && stampSec(m[1]);
    if (t !== null && t !== undefined && Math.abs(t - startSec) <= LOG_BIND_SEC && (!best || t > best.t)) best = { t, f };
  }
  return best && best.f;
}

/** { code, line }. hosts: start times (s) of running installed hosts, [] for none, null when unknown.
 *  readLog(startSec): that host's log text, or null when it has none or cannot be read. */
export function decide(hosts, readLog) {
  if (hosts === null) return { code: 2, line: 'live-check: the studio host process could not be checked; unknown' };
  if (!hosts.length) return { code: 0, line: 'live-check: off air' };
  const live = [];
  for (const start of hosts) {
    const text = readLog(start);
    if (text === null) return { code: 2, line: 'live-check: the studio host runs and its log cannot be read; unknown' };
    if (!hostExited(text)) live.push(...liveSinks(text));
  }
  return live.length ? { code: 1, line: `live-check: LIVE (${live.join(', ')}); do no heavy work` }
    : { code: 0, line: 'live-check: off air (studio open, nothing live)' };
}

/** Start times (s) of running installed hosts, by path, never by name alone; null when any ujwalam-host.exe cannot
 *  be resolved or the process list fails. */
export function installedHosts(base = process.env.LOCALAPPDATA) {
  if (process.platform !== 'win32' || !base) return null;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='ujwalam-host.exe'\" | ForEach-Object { '{0}|{1}' -f $_.ExecutablePath, $(if ($_.CreationDate) { $_.CreationDate.ToString('yyyy-MM-ddTHH-mm-ss') } else { '' }) }"],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0 || r.error) return null;
  const root = path.join(base, 'Ujwalam').toLowerCase() + path.sep;
  const out = [];
  for (const line of r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const [exe, stamp] = line.split('|');
    if (!exe) return null; // an ujwalam-host.exe whose path cannot be read: maybe the user's
    if (!exe.toLowerCase().startsWith(root)) continue; // a dev or test host from a repo checkout
    const t = stampSec(stamp ?? '');
    if (t === null) return null;
    out.push(t);
  }
  return out;
}

function main() {
  const base = process.env.LOCALAPPDATA;
  const dir = base ? path.join(base, 'Ujwalam', 'data', 'host', 'logs') : null;
  const hosts = installedHosts(base);
  const { code, line } = decide(hosts, (start) => {
    try {
      const f = logForStart(readdirSync(dir), start);
      return f ? readFileSync(path.join(dir, f), 'utf8') : null;
    } catch { return null; } // missing folder, or the file went between the listing and the read
  });
  console.log(line);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
