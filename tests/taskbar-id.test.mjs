// SPDX-License-Identifier: GPL-3.0-or-later
// One taskbar id (System.AppUserModel.ID) for Ujwalam (2026-11-19, docs/evidence/2026-11-19-taskbar-grouping.md): the
// studio, the host's preview windows and the installer's shortcuts must use the same string, or Windows shows the
// running app on a separate taskbar button from the pinned shortcut.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

test('studio, host and installer use the same taskbar id', () => {
  const studio = /kId\[\] = L"([^"]+)"/.exec(read('app/studio/src/taskbar_id.h'))?.[1];
  const host = /kAppUserModelId\[\] = L"([^"]+)"/.exec(read('app/host/src/main.cpp'))?.[1];
  const installer = /^\$AppUserModelId = '([^']+)'/m.exec(read('tools/package/Install-Ujwalam.ps1'))?.[1];
  assert.equal(studio, 'Ujwalam.Studio');
  assert.equal(host, studio);
  assert.equal(installer, studio);
  // Windows limit: at most 128 characters, no spaces.
  assert.ok(studio.length <= 128 && !/\s/.test(studio));
});

test('the studio sets the id before its first window; the host before any window; setup has none', () => {
  const main = read('app/studio/src/main.cpp');
  // D432: the app object is lagmon::TimedApplication<QApplication> app(argc, argv); any form of it counts
  const appAt = main.search(/QApplication>? app\(argc, argv\)/);
  assert.ok(appAt > 0, 'the application object is found');
  assert.ok(main.indexOf('taskbarid::applyProcess()') > 0 && main.indexOf('taskbarid::applyProcess()') < appAt);
  const host = read('app/host/src/main.cpp');
  assert.ok(host.indexOf('SetCurrentProcessExplicitAppUserModelID(kAppUserModelId)') < host.indexOf('App app;'));
  assert.ok(!read('app/setup/src/setup.cpp').includes('AppUserModel'), 'Ujwalam-Setup.exe is a different tool');
  // The relaunch command comes from the launcher stub.
  assert.match(read('app/studio/src/start_stub.cpp'), /UJWALAM_RELAUNCH_EXE/);
});
