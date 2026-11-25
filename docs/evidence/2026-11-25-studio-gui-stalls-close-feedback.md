# 2026-11-25 Studio GUI stalls and close feedback

User report: "it looked like Ujwalam is freezing in between"; after the X and the close question "the confirmation
button also freezes instead of showing what is happening".

## How it was measured

- Realistic headless fixture (`C:\AI\Claude\_data\Ujwalam\scratch\perf-real.mjs`, not committed):
  - the user's flag set and UI settings, copied into a scratch data folder (RareUI look and theme components on);
  - a recording 1 h old, 22 layers with effects, 10 mixer strips with moving meters;
  - a running clip job whose stages, parts and log change every 2 s, a paused job and finished preview tasks;
  - real Windows fonts (`QT_QPA_FONTDIR`) and the lag monitor's work marks (`lag.work`).
- Temporary `Date.now()` laps inside `Store.pollStatus` and `TaskCenter.rebuild` split the status answer by part. They
  were removed again.
- Real logs: `studio-2026-11-25*.log` shows `ui/api/status` blocks of 200-544 ms that grow during the session. The
  `event 43` blocks of 1-8 s are window builds at a reopen. Event-core `stalls.jsonl` shows no Node stall, so the system
  as a whole was not starving.

## Causes (measured)

| # | Cause | Where | Cost before |
|---|---|---|---|
| 1 | Task chip spinner and breathing dot are frame animations. They run for every listed running **or waiting/paused** task, so the whole window redraws at about 60 frames/s. | `TaskChip.qml` (old lines 34, 57, 68, 93, 117) | 1876 frames in 30 s with only a paused job (164 idle); 1886 with recording plus a running job |
| 2 | `TaskCenter.rebuild` sets a new `rows` array on every status poll. The task JSON changes on every poll (timing fields), so the panel ListView and the task window ListView destroy and rebuild every row (UButtons, wrapped texts). | `TaskCenter.qml` `rebuild()`; panel `model: center.rows`; `TaskWindow.qml:241` `model: win.shown` | status answer avg 22-27 ms, max 40-82 ms; of that, `rows = nr` avg 19.7 ms, max 32 ms (task window open) |
| 3 | `Store.takeFlags` compares the flags and the full `flagList` as two JSON texts on every poll. | `Store.qml` `takeFlags` | avg 7 ms, max 28-36 ms per poll |

GC is not the cause: no V4 GC run in 60 s probes (heap 9-12 MB).

## Fixes

1. `TaskChip.qml`: one 8 Hz `Timer` (`taskStepper`) moves the ring (45° steps, 1 turn/s), the bars and dots (same
   rounds as before) and the breathing dot (1.6 s cycle). It runs only while a task is **running**. A waiting or
   paused task shows a still dot.
2. `TaskCenter.qml` / `TaskWindow.qml`:
   - The lists use a `ListModel` of ids (`rowIds`, `shownIds`), kept in order by remove, insert and move (`syncIds`).
   - Each row reads its data from `rowById`, so a poll only changes the texts that changed.
   - The detail fields and parts use models updated in place.
   - The "next start" buttons use a fixed model.
3. `Store.qml`: flags are compared key by key, and the flag list by one field signature.
4. Close feedback (`Main.qml`):
   - An accepted close (X, or "Stop them and close") keeps the window up and shows a "Closing Ujwalam…" card. The card
     names what happens: ending the stream, saving the recording, stopping N tasks.
   - The card takes every click. The studio quits after the first frame with the card is on screen, or after 250 ms at
     most.
   - Log lines: `studio closing: <what>` and `studio closing: shown after N ms (frame|timeout), quitting`.

## After (same fixture, same build otherwise)

| | before | after |
|---|---|---|
| Frames in 30 s, only a paused job | 1876 | 162 |
| Frames in 30 s, recording plus a running job | 1886 | 408 |
| `ui/api/status` answer, task window open (lag monitor) | avg 22-27 ms, max 40-82 ms | avg 3.2 ms, max 13 ms |
| `ui/api/flags` answer | avg about 9 ms, max 62 ms | avg about 4 ms, max 19-24 ms |
| Stalls over 250 ms in a 40 s probe | 1 (start-up window build) | 1 (start-up window build) |

## Tests

- `node --test tests/studio-qml-tray.test.mjs tests/studio-qml-task-window.test.mjs tests/studio-qml-tasks.test.mjs
  tests/rareui-slice1.test.mjs`: 46/46 pass (with fixes 1-4, before the row counter and the new test).
- New `tests/studio-qml-gui-load.test.mjs`:
  - First run: 3/4 pass. The paused/running frame budget passed, and both close-card tests passed.
  - The row-rebuild test failed on its own assumption: it expected more than 10 polls in 8 s, but the studio polls
    every 2 s. The test now runs 14 s and expects 5 or more moves. **Not re-run**: the user's studio started during the
    run, so testing stopped.
- Lint and commit hooks: not run (same reason).

## UNVERIFIED (needs the laptop)

- How much fixes 1-3 shorten the 200-544 ms status stalls during a real recording. The probe uses the Software renderer
  with no NVENC/GPU load.
- The close card on a real window: that the card paints before the quit while the GPU is loaded.
- Window teardown with the embedded host preview windows (cross-process child HWNDs) may block on the host's preview
  thread after the card is shown. Not measurable headless.
- After the window goes, the launcher still stops the host (saves the recording, up to 8 s) with no window on screen.
