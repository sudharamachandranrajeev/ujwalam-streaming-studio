# 2026-11-19 — One taskbar button for Ujwalam (AppUserModelID)

Status: code and tests PASS; real taskbar behaviour UNVERIFIED (the user checks by hand after updating).

## Report

User: "after studio starts it goes to a different set of icon on taskbar; usually other apps open and can be hovered
from that pinned icon itself."

## Cause

The pinned taskbar shortcut and the Start/Desktop shortcuts start `%LOCALAPPDATA%\Ujwalam\ujwalam-start.exe` (a
windowless launcher). The windows belong to other programs: `ujwalam-studio.exe` (studio) and `ujwalam-host.exe`
(preview windows), inside a version folder `%LOCALAPPDATA%\Ujwalam\<version>\`. Windows groups taskbar buttons by
AppUserModelID. None was set, so Windows derived one from each exe path: the studio got its own button, the pin never
lit up, and every new version folder changed the path again.

## Fix

One explicit id, `Ujwalam.Studio` (product name only), everywhere:

| Where | What |
| --- | --- |
| `app/studio/src/taskbar_id.h` (new) | the id; `SetCurrentProcessExplicitAppUserModelID`; window property store helpers |
| `app/studio/src/main.cpp` | sets the process id before `QApplication` (before the first window); the headless probe reports `appUserModelId` |
| `app/studio/src/qml_studio.cpp` | on the real studio window (normal and hidden modes): window `System.AppUserModel.ID`, `RelaunchCommand`, `RelaunchDisplayNameResource` ("Ujwalam"), `RelaunchIconResource` (launcher exe, icon 0) via `SHGetPropertyStoreForWindow`; cleared again before the window is destroyed. Prints `studio taskbar: id ..., window set, relaunch launcher` |
| `app/studio/src/start_stub.cpp` | `ujwalam-start.exe` passes `UJWALAM_RELAUNCH_EXE` (its own path) and `UJWALAM_RELAUNCH_ARGS` (its arguments, e.g. `--live --allow-devices`) to the launcher; the studio's spawn env keeps them (only `*TOKEN*`/`*KEY*` are filtered). Pinning the running window therefore pins the launcher with the same arguments, not `ujwalam-studio.exe`. The stub shows no window, so it sets no id itself. Without these variables (dev runs, tests) only the id is set. |
| `app/host/src/main.cpp` | `kAppUserModelId`, set first thing in `wmain` (before any preview window); log line `taskbar id: Ujwalam.Studio` |
| `tools/package/Install-Ujwalam.ps1` | `$AppUserModelId`; the live and practice shortcuts (Start menu and Desktop) get `System.AppUserModel.ID` through `IShellLinkW` + `IPropertyStore` (small C# type via `Add-Type`; WScript.Shell cannot write it). The setup shortcut gets none. New `-TaskbarPinDir` (default `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar`, tests pass a temp folder) |
| `app/setup/src/setup.cpp` | passes a new `--taskbar-pin-dir` through to the installer (tests only). Ujwalam-Setup.exe sets no id: it is a different tool and keeps its own button. |

### Existing pin (update path)

On every install, update and repair (the shortcut step), the installer looks in the pinned-taskbar folder. A `.lnk`
there whose target is this install's `ujwalam-start.exe` is the app's own pin (Windows' copy of the shortcut the user
pinned); only its `System.AppUserModel.ID` is set, nothing else (target, arguments, icon and name stay). Pins that point
anywhere else are not touched (the test checks this with a foreign pin). The installer prints
`pinned taskbar shortcut: taskbar id set on <name>`. Explorer caches pins, so the change may show only after the next
sign-in or an Explorer restart; unpinning and pinning again also works.

## Tests (2026-11-19, worktree, `UJWALAM_HEADLESS=1`, BelowNormal, one file at a time, `tools/live-check.mjs`: off air)

Builds: `npm run build:studio`, `npm run build:host`, `npm run build:setup`: exit 0, no new warnings in the changed files.

| Test | Result | What it checks |
| --- | --- | --- |
| `tests/taskbar-id.test.mjs` (new) | PASS | studio, host and installer ids are identical; set before the first window; setup has none; stub passes the relaunch command |
| `tests/package-alpha.test.mjs` | PASS (20/21, 1 skipped unrelated; the install test ran) | after install, both app shortcuts in Start and Desktop read back `Ujwalam.Studio` through `Shell.Application ... ExtendedProperty('System.AppUserModel.ID')` (independent of the installer's own code); a pre-existing pin to `ujwalam-start.exe` gets the id; a foreign pin stays empty |
| `tests/setup-installer.test.mjs` | PASS (11/11) | Setup.exe install/update/rollback/uninstall unchanged; a temp pin folder is passed so the user's real pins are never read |
| `tests/studio-qml-shell.test.mjs` | PASS | probe reports `appUserModelId: "Ujwalam.Studio"` |
| `tests/studio-qml-tray.test.mjs` | PASS (14/14) | tray unchanged |
| `app/host/tests/host-crash-report.test.mjs` | PASS (8/8) | host log has `taskbar id: Ujwalam.Studio` |
| `app/host/tests/host-structure.test.mjs` | PASS (4/4) | host structure unchanged |

`npm run lint`: 0 findings.

A manual check in Windows PowerShell 5.1: the C# helper wrote and read the id on a temp `.lnk`; target and arguments
were unchanged.

## UNVERIFIED (user checks by hand after updating)

1. Start Ujwalam from the pinned taskbar icon: the studio window appears under that same pinned icon (hover shows its
   thumbnail); no second Ujwalam button appears. If the old pin still opens a separate button, sign out and in (or
   unpin, start Ujwalam from the Start menu, and pin the running window again).
2. Preview windows (when undocked) group under the same button.
3. Right-click the running studio's button, "Pin to taskbar": the pin starts `ujwalam-start.exe` with the same
   arguments, not `ujwalam-studio.exe`.
4. Ujwalam setup keeps its own separate button.
