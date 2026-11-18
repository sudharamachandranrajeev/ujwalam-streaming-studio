// SPDX-License-Identifier: GPL-3.0-or-later
// tools/perf-idle.mjs pure parts (idle load, 2026-11-18): arguments, process roles, trees and the per-role summary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, roleOf, summarise, treesOf } from '../tools/perf-idle.mjs';

test('perf-idle: arguments are bounded', () => {
  assert.deepEqual(parseArgs([]), { minutes: 5, warmup: 60 });
  assert.deepEqual(parseArgs(['--minutes', '2', '--warmup', '0']), { minutes: 2, warmup: 0 });
  assert.throws(() => parseArgs(['--minutes', '0']), /--minutes/);
  assert.throws(() => parseArgs(['--minutes', 'x']), /--minutes/);
  assert.throws(() => parseArgs(['--warmup', '-1']), /--warmup/);
});

test('perf-idle: roles from the name and the node script, never the command line itself', () => {
  assert.equal(roleOf('ujwalam-host.exe'), 'host');
  assert.equal(roleOf('obs-browser-page.exe'), 'cef');
  assert.equal(roleOf('node.exe', 'node C:\\x\\app\\host\\overlay\\child.mjs --root y'), 'overlay-child');
  assert.equal(roleOf('node.exe', 'node C:/x/services/event-core/cli.mjs serve'), 'event-core');
  assert.equal(roleOf('node.exe', 'node C:/x/services/studio-ui/cli.mjs serve'), 'ui-server');
  assert.equal(roleOf('node.exe', 'node other.mjs'), 'node-other');
  assert.equal(roleOf('Python.exe'), 'python');
  assert.equal(roleOf('obs-ffmpeg-mux.exe'), 'mux');
});

test('perf-idle: trees under the roots, CPU per role in the window, new processes count from zero', () => {
  const rows = (cpu) => [
    { pid: 1, ppid: 0, name: 'explorer.exe', cpuS: 99, privMB: 1, wsMB: 1 },
    { pid: 10, ppid: 1, name: 'ujwalam-host.exe', cpuS: cpu.host, privMB: 300, wsMB: 200 },
    { pid: 11, ppid: 10, name: 'obs-browser-page.exe', cpuS: 5, privMB: 50, wsMB: 40 },
    { pid: 12, ppid: 11, name: 'obs-browser-page.exe', cpuS: cpu.cef, privMB: 60, wsMB: 50 },
    { pid: 20, ppid: 1, name: 'node.exe', cpuS: 3, privMB: 70, wsMB: 60 },
    ...(cpu.newMux ? [{ pid: 13, ppid: 10, name: 'obs-ffmpeg-mux.exe', cpuS: cpu.newMux, privMB: 5, wsMB: 5 }] : [])
  ];
  const a = treesOf(rows({ host: 10, cef: 2 }), [10, 20]);
  assert.deepEqual(a.map((p) => p.pid).sort((x, y) => x - y), [10, 11, 12, 20]);
  const b = treesOf(rows({ host: 13.5, cef: 2.5, newMux: 0.25 }), [10, 20]);
  const s = summarise(a, b, new Map([[20, 'ui-server']]));
  assert.deepEqual(s.host, { cpuS: 3.5, privMB: 300, wsMB: 200, n: 1 });
  assert.deepEqual(s.cef, { cpuS: 0.5, privMB: 110, wsMB: 90, n: 2 });
  assert.deepEqual(s['ui-server'], { cpuS: 0, privMB: 70, wsMB: 60, n: 1 });
  assert.equal(s.mux.cpuS, 0.25);
  assert.equal(s.explorer, undefined);
});

test('perf-idle: a process older than its listed parent is not counted (the parent id was reused)', () => {
  const rows = [
    { pid: 10, ppid: 1, name: 'ujwalam-host.exe', cpuS: 1, privMB: 1, wsMB: 1, created: 200 },
    { pid: 11, ppid: 10, name: 'obs-browser-page.exe', cpuS: 1, privMB: 1, wsMB: 1, created: 300 },
    { pid: 12, ppid: 10, name: 'proxy.exe', cpuS: 9, privMB: 1, wsMB: 1, created: 100 }
  ];
  assert.deepEqual(treesOf(rows, [10]).map((p) => p.pid).sort((x, y) => x - y), [10, 11]);
});
