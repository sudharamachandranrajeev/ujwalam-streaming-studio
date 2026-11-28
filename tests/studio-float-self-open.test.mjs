// SPDX-License-Identifier: GPL-3.0-or-later
// Surfaces that open by themselves (not from the user's click) must not be Popup.Window: Qt 6.8 sends the clicks of every
// popup window to the newest one, so a popup that appears on its own steals the clicks of the popup the user is using
// (app/studio/qml/FloatSurface.qml, docs/evidence/2026-11-27-click-loss-fix.md, 2026-11-28-float-self-open.md).
// Static check on the QML source. The click routing itself needs real Windows popup windows and system mouse input: the
// offscreen headless probe uses Popup.Item, which has no popup chain, so it cannot show the loss (the evidence file
// records the real-window harness run).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const QML = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'studio', 'qml');
const src = (f) => readFileSync(path.join(QML, f), 'utf8');
// Opened by a store signal, a timer or a host event, with no click behind them.
const SELF_OPENING = ['TaskCenter.qml', 'ScheduleCenter.qml', 'ClipsAsk.qml'];

describe('self-opening surfaces are FloatSurface, never Popup.Window', () => {
  for (const f of SELF_OPENING) {
    test(f, () => {
      const s = src(f);
      assert.match(s, /FloatSurface\s*\{/, `${f} uses FloatSurface`);
      assert.doesNotMatch(s.replace(/\/\/.*$/gm, ''), /Popup\.Window/, `${f} has no Popup.Window`);
    });
  }

  test('"Make clips?" keeps its names, Escape = Not now, the keys and the centred placement', () => {
    const s = src('ClipsAsk.qml');
    for (const n of ['clipsAsk"', 'clipsAskRemember', 'clipsAskNo', 'clipsAskYes', 'clipsAskLook_']) assert.ok(s.includes(`objectName: "${n}`), n);
    assert.match(s, /Keys\.onEscapePressed:\s*dlg\.answer\(false\)/);
    assert.match(s, /takesFocus:\s*true/);
    assert.match(s, /px:\s*Math\.round\(\(dlg\.width - pw\) \/ 2\)/);
    assert.match(s, /py:\s*Math\.round\(\(dlg\.height - ph\) \/ 2\)/);
    assert.match(src('Main.qml'), /function onClipsAsk\(ask\) \{ clipsAskDlg\.put\(ask\) \}/);
  });
});
