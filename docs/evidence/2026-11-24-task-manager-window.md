# D442 task manager: the window side (2026-11-24)

Branch `claude/d442-task-window` (from `a8374e8`). Job side: `docs/evidence/2026-11-24-task-manager-job-side.md`.

## What was built

| Item | Where |
|---|---|
| Own top-level window (`Window`), opened by "Open in own window" in the task panel; "Dock" or the window's X returns to the panel; made on first use; never visible while `studioUnseen` (headless) | `app/studio/qml/TaskWindow.qml`, `TaskCenter.qml` (`openWindow`, `dockWindow`, `winLoader`) |
| Sort (State, Start time newest first, Category) and filter (State, Category), drop-downs with a label in words each | `TaskWindow.qml` (`shown`) |
| Per-row buttons only from `controls`: Stop, Pause, Resume, Next start (Run / Ask me / Just notify, current one highlighted). No confirm dialog | `buttonsOf()` is the one list used by the shown buttons and the probe |
| "Pausing at the next safe point…" while `pausing`; `pauseReason` as plain text when not pausable | `pauseNote()` |
| Row buttons wait after a click until the row's state signature changes (also released after 10 s or when the request is refused) | `pending`, `busyOf()`, `purgePending()` |
| Detail view on click: state, category, stage, progress, time spent, time left, last progress, note, question, next start, warning, parts, log tail (`textFormat: Text.PlainText`) | `detailFields()`, `taskLog` |
| Start notice "N tasks are waiting for you" (toast); a click opens the window | `TaskCenter.checkWaiting()`, toast `act: "window"` |
| `waitingForYou` reaches the studio: the status snapshot's `clips` object did not carry it (only `status.json` did), so `clipStatus()` now passes it through (integer, capped 99) | `services/studio-ui/server.mjs`, `Store.qml` (`waitingForYou`) |

Theme tokens only (`Theme.c.*`, `Theme.sp.*`); no hardcoded colours.

## Gaps and notes

- Size sort: no size field exists on a task in the snapshot, so the window has no size column or sort (`sizeColumn: false` in the probe, asserted).
- The window is never drawn in the headless test, so layout (widths, wrapping, scrolling) is checked by the probe's data and the QML compile only, not by a screenshot. A visual check on a real display is still to do.
- The "Pausing…" text uses the single ellipsis character as written in the request; the older panel text uses three dots.
- Stop in the window posts the per-task `control` op. The panel's Stop button still stops all background jobs (old route), unchanged.
- The notice fires once when `waitingForYou` first rises above what was seen (again only if more wait later). The default next-start (notify) is the job side's.
- Probe actions added: `tasks:window-open|window-dock|window-close`, `tasks:sort:<key>`, `tasks:filter-state:<v>`, `tasks:filter-cat:<v>`, `tasks:select:<id>`, `tasks:ctl:<id>:<op>[:<next>]` (calls the button's own click function, so a refused click returns false).

## Commands and results

Studio build (worktree, `out/studio/build`):

```
node app/studio/tools/build.mjs   -> built ...\out\studio\build\ujwalam-studio.exe   (about 43 s; QML cache compile of TaskWindow and TaskCenter clean)
```

New tests, `tests/studio-qml-task-window.test.mjs` (TEMP/TMP under `C:\AI\Claude\_data\Ujwalam\scratch\tmp`):

```
node --test tests/studio-qml-task-window.test.mjs
  ok  opens in its own window from the panel and docks back; the hidden test mode never shows a window
  ok  sort by state, start time and category; filter by state and category
  ok  each row shows only the buttons its job offers in `controls`; pausing and "cannot pause" say so in words
  ok  a click posts the right body once; the row waits for the list to change; a control the job does not offer sends nothing
  ok  clicking a task shows its details (stage, progress, time, parts, log as plain text)
  ok  "N tasks are waiting for you" notice at the start opens the task manager window
```

(first full run: 5 of 6, the detail test's fixture lacked stage names; fixed in the test; the detail test then passed alone, 6 of 6 after.)

Existing tests kept green:

```
node --test tests/studio-qml-tasks.test.mjs tests/studio-tasks.test.mjs tests/studio-qml-tray.test.mjs tests/task-manager-jobs.test.mjs   -> tests 47, pass 47, fail 0
node --test tests/studio-ui-server.test.mjs tests/studio-qml-clips.test.mjs                                                      -> tests 47, pass 47, fail 0
node tools/lint.mjs   -> lint: 0 finding(s), 37 allow marker(s)
```

Not run: the full `npm run ci` (as asked). The commit hook's quick checks passed (9/9) on each commit.

## Files

- Created: `app/studio/qml/TaskWindow.qml`, `tests/studio-qml-task-window.test.mjs`, this file.
- Changed: `app/studio/qml/TaskCenter.qml`, `app/studio/qml/Store.qml`, `app/studio/CMakeLists.txt`, `services/studio-ui/server.mjs`.
