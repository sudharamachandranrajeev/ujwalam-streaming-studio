# Background job pacing: evidence (2026-11-27)

Plan: `docs/plan/2026-11-27-background-job-pacing.md` (user decisions 2026-11-27). Branch `feat/job-pacing`.

Status: unit-tested. Real-run proof PENDING (needs a build and a real clip job; the user's studio was busy with a
measured clip job while this was written, so no build, ffmpeg or studio run was made).

## What was built

- `services/clip/clip_common.py`
  - `read_user_signals()`: `GetLastInputInfo` (idle seconds), `SHQueryUserNotificationState` (busy, D3D full screen,
    presentation), `GetSystemPowerStatus` (on battery, percent). ctypes only; no process, no WMI. A failed call = unknown.
  - `choose_pace(signals, cfg)` (pure): battery hold, then full-screen/presentation/busy hold, then full when idle >=
    `awaySec`, else gentle. Unknown never holds and never gives full speed.
  - `PaceGate`: duty cycle (gentle: run `runSec`, suspended `pauseSec`) and a running-time clock.
  - `run_tool(..., pacing=None)`: paces only when `enable_pacing` turned it on (or a test passes `pacing`). Each poll and
    each duty-cycle edge it reads the signals and suspends/resumes the child (`NtSuspendProcess`/`NtResumeProcess`).
    The stall watchdog and the timeout count only running time. `stop()` still wins. `kill()` resumes the child first.
    Writes `ujwalam-pace {"pace":"..."}` on stderr once per change.
  - `enable_pacing(data_dir)`: on when `settings.json clips.goEasy` is not `false` (default on), Windows only.
- `services/clip/clipper.py main`: calls `enable_pacing(data_dir)` after `lower_own_priority(background_io=True)`. All
  post-stream jobs (clips, review, long video, BeatDrop) run through `clipper.py`, so their children are paced.
  `live_worker.py` never calls it: the live clipper is never paced. `pack_tune.py` (game pack check) is not paced.
- `data/clip/pacing.json`: awaySec 300, gentle 1 s run / 3 s pause, battery hold always (belowPercent 101), hold on
  fullscreen, presentation, busy.
- `services/studio-ui/user-settings.mjs`: `clips.goEasy` (boolean, stored only once set; absent = on).
- `services/studio-ui/record-clips.mjs`: `parsePace`, `PACE_TEXT`; the running task's note shows "Going slowly while
  you use the PC", "Paused while a game is full screen", "Paused while you present", "Paused while a full-screen app
  runs", "Paused on battery", "Full speed (you are away)" (full only when there is no other note). A held task has
  `measured: false`, so it is never called stuck.
- `app/studio/qml/SettingsClips.qml`, `SettingsDialog.qml`: switch "Go easy while I use the PC" in Settings > Clips
  (After each stream or recording), on by default, saved as `clips.goEasy` (Save/Discard draft as the other switches).
- `app/studio/qml/TaskChip.qml`: no change needed; the spinner already steps from one 8 Hz timer (2026-11-25).

## Tests run (2026-11-27)

| Command | Result |
| --- | --- |
| `.venv-gpu\Scripts\python.exe -I tests\py\test_job_pacing.py` | 13 tests OK (choose_pace, config fallback, duty cycle = 0.25 +- 0.03, hold freezes running time, unreadable signals = gentle, switch, run_tool: held child not stalled and finishes when the hold ends, stop wins while held, gentle child finishes, one pace line per change) |
| `.venv-gpu\Scripts\python.exe -I tests\py\test_render_watch.py` | 10 tests OK (stall watch unchanged without pacing) |
| `node --test tests/record-clips.test.mjs` | 35 pass (parsePace, goEasy setting check, pace notes on the running task) |
| commit hook `node tools/ci.mjs --quick` | 9/9 PASS on both commits |

## Pending (needs a build or a real run)

- Full CI (`npm run ci`), including the QML settings tests (`tests/studio-qml-settings.test.mjs`) for the new switch.
- Studio build and a look at Settings > Clips.
- Real run: the same 60-minute review with the user away, then active; sampler shows NVDEC and disk dropping while
  active and the job still finishing; total time recorded. Also check a full-screen game holds the job and it resumes.
- Known limit: `NtSuspendProcess` suspends the child process only; a grandchild in the same job keeps running
  (clip children are single processes today).
