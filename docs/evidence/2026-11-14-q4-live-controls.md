# 2026-11-14 — QML studio Q4 track A: live controls and safety

Plan: `docs/plan/2026-11-14-qml-parity-checklist.md` section A. Branch `ui/q4-live`. Flag `studio-qml` (off by default):
the widget studio stays the default; everything here is in the QML studio only.

## What was built (each the QML twin of the widget behaviour: same routes, same words, same rules)

| Item | QML | Widget reference |
|---|---|---|
| Save clip (host `replay.save`) and Mark moment (host `marker.add`, source `api`), one click each (D332), same notes and tooltips | `OnAirBar.qml` (`clipBtn`, `markBtn`, beside Record / Go live), `Store.saveClip()` / `markMoment()`, two palette commands | `main_window.cpp` buildControls |
| Alert strip: status `alerts` (flag `live-test-kit`), at most 8 lines, 400 characters each, plain text, edge colour by the worst level (danger / accent / border), hidden when empty | `AlertStrip.qml` under the on-air bar (the panels sit under it) | `updateAlerts` |
| Close with tasks running: "Keep running in the tray" (default), "Stop them and close", "Do not close"; each task with its time text; Escape = Do not close | `CloseDialog.qml`, `Main.qml` onClosing | `closeEvent` |
| Tray: icon with tooltip, task list, Open Ujwalam, Stop all and quit, "all finished" notification and exit, a new task cancels the countdown, never quits while live or recording (quit lock `ui/api/quit/begin|commit|cancel`, fail closed), Stop all while live stops only the tasks (`ui/api/tasks/stop`) | `TrayFlow.qml` + the widget's own `TrayKeeper` through the `Tray` bridge (`qml_tasks.h/.cpp`) | `tray.cpp`, main_window enterTray / leaveTray / stopAllFromTray / allFinished |
| Task chip and panel: count, quiet "Tasks", "may be stuck", panel at the top right with stage, count, percent bar, elapsed, time left, last progress, warning, Stop, Clear finished, x; notifications on start of a long job, done, failed, may be stuck (max 3, 6 s, a click opens the panel) | `TaskChip.qml` (in the on-air bar), `TaskCenter.qml`; every line from the widget's C++ `tasktime::*` through the `TaskText` bridge | `taskbar.cpp` |

Shared C++, not rewritten: `TrayKeeper` gained `setUnseen()`: in the QML studio's hidden and probe modes no tray icon,
no notification and no list window are ever created (the model runs and the probe reads it). The widget studio is
unchanged (unseen is off there).

## Tests (after `npm run build:studio`, each file alone, UJWALAM_HEADLESS=1, offscreen, never on a screen)

| File | Result | Twin of |
|---|---|---|
| `tests/studio-qml-controls.test.mjs` | 5/5 pass | `studio-qt-shell` Save clip / Mark moment (D281), `studio-qt-alerts` (2) |
| `tests/studio-qml-tray.test.mjs` | 14/14 pass | `studio-tray` (14), plus: the question ends "What should happen to it?", the window is back after Open, a probe shows no icon |
| `tests/studio-qml-tasks.test.mjs` | 7/7 pass | the task parts of `studio-qt-shell` (chip, Clear finished, toasts, the 2026-11-08 crash sequence, full panel and stuck warning, stuck toast click and Stop), plus a "Started" notification test |
| `tests/studio-qml-shell.test.mjs` | 3/3 pass | (regression) |
| `tests/studio-qml-palette.test.mjs` | 6/6 pass | (regression) |
| `tests/studio-qml-settings.test.mjs` | 15/15 pass | (regression) |
| `tests/studio-tray.test.mjs` (widget) | 14/14 pass | (regression: `tray.cpp` changed; unseen is off there) |

Each new test also fails on any QML error line (TypeError, ReferenceError, binding loop) on stderr.

## Differences from the widget (deliberate)

- The QML probe embeds both previews, so the UI server lists two short "Opening the ... preview" tasks of its own; the
  task tests count the tasks they write next to those (the rules are the same for both).
- The toast stack and the task panel are their own windows (`Popup.Window`) on a normal screen, so the native previews
  never cover them; in hidden and probe modes they are drawn inside the window (`studioUnseen`), since an offscreen
  screen is smaller than the window and would push a popup window inward.
- The load chip hides when the window is narrower than 1360 px so Save clip and Mark moment fit; the status line still
  shows host and event core.
- Theme "bracket" chip variant (D336) is not mirrored on the task chip (the QML chips have no bracket variant yet).

## UNVERIFIED

- The real tray icon, its tooltip, notifications and the list window on the user's desktop (a probe never shows them;
  `TrayKeeper` is the same code the widget studio uses there).
- Whether the task panel and notification popup windows take focus from a game on a real screen (Qt 6.8 `Popup.Window`).
- The 8-line cap of the alert strip has no test with more than 3 alerts (the server builds the alerts; the cap is the
  same loop as the widget's).
