# 2026-11-27 Click loss on task Start: cause and fix

Branch `fix/ui-click-freeze-diag`. Commits: `7e3a5d1a` (click diagnostics), `781e95c1` (closing card radius),
`6932bef2` (one task count), `8bd29619` (panels as tool windows).

## Symptom

The user pressed Start on a waiting clip job in the task panel. Nothing happened. Other buttons still worked.
The task chip said "waiting" while the status bar said "running".

## Root cause

- The task panel, the schedule panel and the task toast stack were all `Popup` with `popupType: Popup.Window`.
  Each one is a separate `Qt::Popup` window.
- Qt 6.8 sends mouse input to the newest open popup window (`QGuiApplicationPrivate::activePopupWindow`,
  `QWindowPrivate::forwardToPopup`).
- At start-up the "1 task is waiting for you" notice opens the toast stack. Later toasts (an upload starting)
  open it again. When the stack opened after the panel, the stack got the click meant for Start. The panel's
  button never saw it.
- Hidden test mode uses `Popup.Item`, so the QML tests never ran the real popup-window path.
- The two texts disagreed because the status bar counted running plus waiting tasks as "running".

## Fix

- `app/studio/qml/FloatSurface.qml` (new): shows a panel as a frameless `Qt.Tool` window owned by the studio
  window (`transientParent`). It uses `Popup.Item` in hidden test mode. It follows the studio window when it
  moves or resizes, and hides when the studio window is minimised.
- `TaskCenter.qml` (panel and toast stack) and `ScheduleCenter.qml` (panel) use it. The schedule panel keeps
  keyboard focus for its search box (`takesFocus`).
- `Store.qml`: `taskWords` counts running and waiting tasks apart. The status bar (`Main.qml`) and the task chip
  both use it, for example "1 task running, 1 waiting".

## Evidence

| Check | Result |
|---|---|
| Offscreen `qmltestrunner`, panel plus toast | No loss. Offscreen has no real popup windows. |
| Win32 harness: cross-process child window whose thread is blocked for 4 s | Clicks still landed in 33-48 ms. Attached input queue stall ruled out as the cause. |
| Windows platform, panel `Popup.Window` then toast `Popup.Window` opened after it | Start click LOST, twice. A button in the main window still worked. |
| Same, toast opened first | Start works. |
| Fix shape (both as tool windows) | Start click handled in 50 ms, toast click in 78 ms, Start again works. |
| Start chain from the request on: real `createStudioServer` plus real `createRecordClips` (fake spawn), carried-over job waiting | `POST /ui/api/tasks/control {op: resume}` answered 202. Control file written. Launcher log `clips: practice-h-1: resume (asked by you)`. Job spawned (spawn count 1 to 2). |
| Focused tests: `studio-qml-tasks`, `studio-qml-schedule-manager`, `studio-qml-tray`, `task-manager-jobs`, `studio-theme-members` | 66/66 pass (theme members run separately: pass). |
| Commit hook quick checks | 9/9 pass on both commits. |

Harness input was system mouse input (`SetCursorPos` plus `mouse_event`), the same path as `SendInput`.

## Verified vs UNVERIFIED

- Verified: the loss mechanism on the Windows platform with real windows and system mouse input; the fix shape
  in the same harness; the server and launcher chain from the Start request to the job starting; the shared
  task wording (tests).
- UNVERIFIED: a click by a human hand in the full built studio. A full-studio run with the clicker reached the
  task chip, but UI Automation did not find Start, and the runs stopped when the user came back to the laptop.
- UNVERIFIED: transparent tool-window rendering and placement on the user's displays and scaling.
- UNVERIFIED: the click diagnostics (`7e3a5d1a`) in daily use.

## Risks

- About 49 other `Popup.Window` uses remain. Any popup that opens by itself (for example the clips question)
  can still take a click from an older popup. The same fix applies to them.
- A tool window is a separate native window: it may show above other apps' windows while the studio is behind
  them. It hides when the studio is minimised.
- While testing, five synthetic clicks landed outside the test window: one on the desktop and four in
  a terminal window. Nothing was typed or run. The clicker now checks that the target window belongs to the
  test process and that the user has been idle for 10 s.
