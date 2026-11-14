# Q4 side column: Inspector, Look panel, Outputs panel, Bots box (QML studio) — 2026-11-14

Plan: `docs/plan/2026-11-11-qml-studio-plan.md` Q4; checklist `docs/plan/2026-11-14-qml-parity-checklist.md` rows B
(Inspector) and D (Outputs panel, Bots box). QML twins of the widget's INSPECTOR box (`main_window.cpp`
`renderInspector`/`applyInspector`), `streampages::OutputsPanel` (`stream_pages.cpp`) and the BOTS box (`loadBots`,
`botAction`). Status: verified by headless probe tests (fake host, fake bots, real UI server). Not yet seen on the real
screen (Q5 side-by-side check, the user's).

## What was built

- `app/studio/qml/InspectorPanel.qml`: X, Y, width, height (whole numbers), rotation (one decimal), crop left/top/right/
  bottom; values held to the widget's ranges (-16384..16384, size 1..16384, rotation -360..360, crop 0..16384). Apply
  sends only the changed values in one `layers.setPlacement`; a held answer goes to the one-click window (D332). Undo
  changes shows the layer's values again. The boxes follow the layer when the selection or its placement changes.
- `app/studio/qml/OutputsPanel.qml` (flag `outputs-panel`): one row per output with badge, name, summary and switch;
  Virtual Camera row shown and switched off (not in this host build). Read on every flag read (as the widget). Offline
  the switch saves what Start stream starts; live it starts/stops only that output on the click. + opens Settings >
  Stream. A refused or unconfirmed switch goes back on the next read.
- `app/studio/qml/BotsPanel.qml` (flag `bot-manager`): Streamer.bot and Speaker.bot with state words, Start (installed,
  not running, no check error) and Stop (only a copy Ujwalam started), the facts line and the hint. Read on every 5th
  flag read (as the widget) and after each click.
- `Main.qml`: a scrolling side column under the layers list (at most 60% of the column height) holds the three.
  `Store.qml`: `signal flagsRead()` after each flag read.

## Evidence

Commands (studio built with `node app/studio/tools/build.mjs`; tests run one file at a time, BelowNormal priority, the
user's installed studio was running so no full CI and no GPU tests; the probe uses the Software renderer):

```
node --test --test-concurrency=1 tests/studio-qml-outputs-bots.test.mjs   -> tests 5, pass 5, fail 0
node --test --test-concurrency=1 tests/studio-qml-editing.test.mjs        -> pass 29, fail 0 (3 new inspector tests)
node --test --test-concurrency=1 tests/studio-qml-shell.test.mjs          -> pass 3, fail 0
```

Covered: flags off = neither box shown and actions refused; offline toggle writes `stream-setup.json`
(`twitch.enabled=false`); live toggle sends only `stream.stop {sinks:['twitch']}`, no start; + opens Settings on
Stream; a switch already in that state is refused; bots: 2 rows / 4 buttons, Start calls the bot module once, the row
reads "up" with Stop on afterwards, Stop of a copy not started by Ujwalam is refused; inspector: empty text, values and
canvas line, Apply patch `{x:100, rotation:12.3, crop:{left:10}}`, Nothing changed, Undo changes, out-of-range width
held to 16384.

## Look panel (added the same day)

- The effect type table moved out of `main_window.cpp` into `app/studio/src/fx_types.h/.cpp` (one table for both
  studios); `QmlApi::fxTypes()` hands it to QML; `QmlApi::chooseColour()` opens the system colour picker (never in test
  mode).
- `app/studio/qml/LookPanel.qml`: cards per type in the widget's group order (rounded first in Shape), switch, sliders
  with number boxes (`UValueSlider.qml`), colour swatch + hex box; at most 6 effects (a 7th says why); offline sends
  250 ms after the last change, live waits for Apply; a reload keeps unsent changes of the same layer.

```
node --test --test-name-pattern="Look panel" tests/studio-qml-editing.test.mjs                       -> pass 3, fail 0
node --test --test-name-pattern="Look panel|Copy look|shared slider ..." tests/studio-qt-shell.test.mjs -> pass 2, fail 0 (widget after the table move)
```

Covered: groups and order, rounded first, at least 9 cards, `layers.setEffects {scene, layer:'cam', effects:[{type:'rounded', radius:40}]}`
reached the fake host and is undoable; on/off removes; a typed 9999 is held to 500; no Look without a selected layer;
the 7th effect refused with the note; live: nothing sent before Apply.

## Volume box (added the same day)

- The mixer strip's volume is now `UValueSlider` (slider + dB box, the widget's ValueSlider, D330). `USlider` takes the
  wheel only while it has focus (`wheelEnabled: activeFocus`), so scrolling never moves a slider by accident.
- New generic probe action in `qml_studio.cpp`: `wheel:<notches>:<focus|nofocus>:<objectName>` (a real QWheelEvent at
  the item's centre; "focus" activates the window and focuses the item first, as a click would). Mixer probe
  `volume-type:<strip>:<dB>` types into the real box and presses Enter.

```
node --test --test-name-pattern=volume tests/studio-qml-editing.test.mjs -> pass 1, fail 0
```

Sent `mixer.setVolume` dB values: `[-6, -8]` (typed -6; 3 unfocused notches sent nothing; 2 focused notches down).

## Not covered

- The real-screen look (Q5).
- A live inspector Apply that the server holds for a click (the confirm path is the shared ConfirmDialog, tested elsewhere).
