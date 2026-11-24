// SPDX-License-Identifier: GPL-3.0-or-later
// tools/package/sandbox/sandbox-check.mjs: the Sandbox sees the setup and the harness read-only and writes only the
// out folder; paths are XML-escaped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wsbConfig } from '../tools/package/sandbox/sandbox-check.mjs';

test('wsb maps setup and harness read-only, only the out folder writable', () => {
  const x = wsbConfig({ distDir: 'C:\\b&d\\dist', harnessDir: 'C:\\h', outDir: 'C:\\o', setupName: 'Ujwalam-Setup-0.1.0-alpha.9.exe', download: 'face-ai-models', keepOpen: false });
  const maps = [...x.matchAll(/<HostFolder>([^<]*)<\/HostFolder><SandboxFolder>([^<]*)<\/SandboxFolder><ReadOnly>(\w+)<\/ReadOnly>/g)].map((m) => m.slice(1));
  assert.deepEqual(maps, [['C:\\b&amp;d\\dist', 'C:\\ujw\\dist', 'true'], ['C:\\h', 'C:\\ujw\\harness', 'true'], ['C:\\o', 'C:\\ujw\\out', 'false']]);
  assert.match(x, /Test-Path 'C:\\ujw\\harness\\in-sandbox\.ps1'/); // waits for the mapped folders
  assert.match(x, /-Setup 'C:\\ujw\\dist\\Ujwalam-Setup-0\.1\.0-alpha\.9\.exe' -Out 'C:\\ujw\\out' -Download 'face-ai-models'&quot;<\/Command>/);
  assert.doesNotMatch(x, /KeepOpen/);
  assert.match(wsbConfig({ distDir: 'a', harnessDir: 'b', outDir: 'c', setupName: 's.exe', download: 'd', keepOpen: true }), /-KeepOpen&quot;<\/Command>/);
});
