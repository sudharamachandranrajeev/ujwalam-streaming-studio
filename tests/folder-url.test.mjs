// SPDX-License-Identifier: GPL-3.0-or-later
// FX6 (D429): app/studio/qml/folderUrl.js turns a FolderDialog URL into a Windows folder path (the QML library file,
// run here in a plain VM context).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { aiRuntimeOk } from '../services/studio-ui/user-settings.mjs';

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'studio', 'qml', 'folderUrl.js'), 'utf8');
const ctx = {};
vm.runInNewContext(src, ctx);

test('folder URLs: local drive, UNC, escapes, and anything else refused', () => {
  const cases = [
    ['file:///C:/AI/ace-step-1.5', 'C:\\AI\\ace-step-1.5'],
    ['file:///D:/', 'D:\\'],
    ['file:///C:', 'C:\\'],
    ['file://server/share/runtime', '\\\\server\\share\\runtime'],
    ['file:///C:/My%20Music/ace', 'C:\\My Music\\ace'],
    ['file:///opt/x', ''], ['file://server', ''], ['C:/x', ''], ['http://x/y', ''], ['file:///C:/%E0%A4%A', ''], ['', ''],
  ];
  for (const [url, want] of cases) {
    assert.equal(ctx.folderPath(url), want, url);
    if (want) assert.equal(aiRuntimeOk(want), true, `${want} passes the settings check`);
  }
});
