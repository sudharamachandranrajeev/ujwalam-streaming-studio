#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Is the user's installed studio live or recording right now? Agents run this before any heavy step (builds, tests,
// CI, model loads, ffmpeg): a stream on air must never compete with agent work for the CPU or GPU (2026-11-18: agent
// tests and builds during a live stream lined up with 183 capture-audio restarts).
//   node tools/live-check.mjs        exit 0 = off air, exit 1 = live or recording (sinks listed), exit 2 = unknown
// Reads the newest host log of the installed app (%LOCALAPPDATA%\Ujwalam\data\host\logs) and follows each sink's
// last "live" / "stopped" / "failed" line; "dropped" followed by "retry" stays live. A host log older than the running
// host's start is ignored. Read only; prints sink ids and states, nothing else from the log.
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

function main() {
  const base = process.env.LOCALAPPDATA;
  const dir = base ? path.join(base, 'Ujwalam', 'data', 'host', 'logs') : null;
  if (!dir || !existsSync(dir)) { console.log('live-check: no installed host logs; off air'); return 0; }
  const logs = readdirSync(dir).filter((f) => /^host-.*\.log$/.test(f)).map((f) => path.join(dir, f));
  if (!logs.length) { console.log('live-check: no host log; off air'); return 0; }
  const newest = logs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  let text;
  try { text = readFileSync(newest, 'utf8'); } catch (e) { console.log(`live-check: cannot read the host log (${e.code ?? e.message}); unknown`); return 2; }
  const live = liveSinks(text);
  const ageS = Math.round((Date.now() - statSync(newest).mtimeMs) / 1000);
  if (live.length && ageS < 120) { console.log(`live-check: LIVE (${live.join(', ')}); do no heavy work`); return 1; }
  console.log(`live-check: off air${live.length ? ` (log quiet ${ageS} s; host likely closed)` : ''}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
