// SPDX-License-Identifier: GPL-3.0-or-later
// Start-up lines (2026-11-19): the launcher, host and studio each log one "startup:" line with ordered marks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStartupClock, parseStartupLine } from '../services/studio-ui/startup-clock.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const order = (text, re) => [...text.matchAll(re)].map((m) => m[1]);

test('the clock: marks in order, one line that parses back', () => {
  let t = 10.4;
  const c = createStartupClock(() => t);
  c.mark('main'); t = 900.6; c.mark('core'); t = 4300; c.mark('ui');
  const line = `[studio] ${c.line()}`;
  assert.match(line, /^\[studio\] startup: main 10, core 901, ui 4300 ms since the launcher process started$/);
  assert.deepEqual(parseStartupLine(line), [{ name: 'main', ms: 10 }, { name: 'core', ms: 901 }, { name: 'ui', ms: 4300 }]);
});

test('the host and studio lines parse with the same reader', () => {
  const host = '2026-11-19T08:07:34.829Z info: [host] startup: main 19, obs-startup 28, video 251, audio 251, modules 895, obs 971, overlay 1055, ready 1063 ms since the host process started';
  const studio = '2026-11-19T08:11:43.701Z info: startup: app 60, login 97, settings 100, engine 103, qml 1108, shown 1251, status 1473, frame 1482, flags 1495 ms since the studio process started';
  assert.deepEqual(parseStartupLine(host).map((m) => m.name), ['main', 'obs-startup', 'video', 'audio', 'modules', 'obs', 'overlay', 'ready']);
  assert.equal(parseStartupLine(studio).at(-1).ms, 1495);
  assert.deepEqual(parseStartupLine('no line here'), []);
});

test('the marks sit in start order in the code', () => {
  assert.deepEqual(order(src('services/studio-ui/launch.mjs'), /clock\.mark\('([a-z-]+)'\)/g), ['main', 'studio-early', 'core', 'plan', 'host-ready', 'project', 'status', 'workers', 'ui', 'shell']);
  assert.deepEqual(order(src('app/host/src/obs_runtime.cpp'), /startupclock::mark\("([a-z-]+)"\)/g), ['obs-startup', 'video', 'audio', 'modules']);
  assert.deepEqual(order(src('app/host/src/main.cpp'), /startupclock::(?:mark|finish)\("([a-z-]+)"\)/g), ['main', 'obs', 'overlay', 'ready']);
  assert.deepEqual(order(src('app/studio/src/main.cpp'), /startupclock::mark\("([a-z-]+)"\)/g), ['login', 'settings', 'ui', 'app']); // loginThen and the early studio's port reader sit above main()
  assert.deepEqual(order(src('app/studio/src/qml_studio.cpp'), /startupclock::(?:mark|finishOnce)\("([a-z-]+)"\)/g), ['engine', 'qml', 'shown', 'frame']);
});
