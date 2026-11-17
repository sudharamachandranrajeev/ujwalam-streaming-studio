// SPDX-License-Identifier: GPL-3.0-or-later
// A dialog that opens as its own window (popupType Popup.Window, Qt 6.8) takes its size from implicitWidth and
// implicitHeight; a plain width/height on the dialog is ignored there and the window opened tiny on a real display
// (alpha.33 feedback: Go live chooser and the YouTube presets window). Static check of every studio QML file:
// the dialog's own size (the lines right after its popupType) must be implicit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const QML = join(import.meta.dirname, '..', 'app', 'studio', 'qml');

test('window dialogs size themselves with implicitWidth/implicitHeight', () => {
  const bad = [];
  let checked = 0;
  for (const f of readdirSync(QML).filter((n) => n.endsWith('.qml'))) {
    const lines = readFileSync(join(QML, f), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (!/popupType:.*Popup\.Window/.test(l)) return;
      const indent = l.match(/^\s*/)[0];
      // Only top-level dialogs (indent of 4): nested popups inside a window (menus, toasts) size differently.
      if (indent.length !== 4) return;
      checked++;
      for (let k = i + 1; k <= i + 8 && k < lines.length; k++) {
        if (new RegExp(`^${indent}(width|height):`).test(lines[k])) bad.push(`${f}:${k + 1}: ${lines[k].trim()}`);
      }
    });
  }
  assert.ok(checked >= 15, `expected the studio's window dialogs, found ${checked}`);
  assert.deepEqual(bad, [], 'use implicitWidth/implicitHeight on a Popup.Window dialog');
});
