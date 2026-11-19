# Start-up time (2026-11-19)

User report (2026-11-19): "studio start-up time is very slow". Branch `perf/startup` (from `claude/alpha0-d1` at
1664aa6, merged again before measuring).

## What the installed logs showed (alpha.33, read only)

Times from the launcher, host and studio log files of the user's last 8 starts (all `--live --allow-devices`):

| start | host log after launcher | studio after launcher | "theme: components on" after studio started |
|---|---|---|---|
| 2026-11-15 14:33 | 3.7 s | 6.4 s | about 1 s |
| 2026-11-17 15:41 | 3.6 s | 6.0 s | 9 s |
| 2026-11-18 19:14 | 4.5 s | 8.4 s | 9 s |

The UI server's stall tracer (stalls.jsonl) logged a 1.3 to 1.5 s main-thread stall in the event core at every
start, with almost no CPU time (waiting on a child process): the data folder ACL pass (`icacls` five times, two of them
over the whole tree, about 1,300 files in the user's data folder). At the same time the launcher started last session's
unfinished clip job (Python and ffmpeg), the live clipper (DirectML OCR) and the face worker while the studio window was
loading. "theme: components on" is logged after the first status and flags answers.

## Instrumentation (permanent, one line per process)

- Launcher: `[studio] startup: main, core, plan, host-ready, project, status, workers, ui, shell` (ms since the
  launcher process started; `services/studio-ui/startup-clock.mjs`).
- Host log: `startup: main, obs-startup, video, audio, modules, obs, overlay, ready` (ms since process creation;
  `app/host/src/startup_clock.h`).
- Studio log: `startup: app, login, settings, engine, qml, shown, status, frame, flags` (ms since process creation;
  `app/studio/src/startup_clock.h`; written once both the first frame and the first flags answer are in).

## Measurement

Dev build (`npm run build:host`, `npm run build:studio`), practice mode (no `--live`), `--allow-devices` (live-check
said off air; the installed studio was not running, checked by its %LOCALAPPDATA%\Ujwalam path). Scratch data folder
with about 1,350 files (a copy of a 1,300-file tree, as large as the user's). Each start was stopped after its startup
lines (launcher tree killed; no strays left). Warm starts (file cache warm); medians of 3.

| phase (launcher ms) | before (3 runs) | median | after (3 runs) | median |
|---|---|---|---|---|
| main (Node boot + imports) | 73, 70, 70 | 70 | 76, 73, 71 | 73 |
| core (event core up) | 1889, 1867, 2016 | **1889** | 858, 846, 824 | **846** |
| host-ready | 2986, 2961, 3130 | 2986 | 1995, 1966, 1942 | 1966 |
| project (load into host) | 4449, 4282, 4400 | 4400 | 3481, 3293, 3243 | 3293 |
| ui (UI server up) | 4609, 4436, 4552 | 4552 | 3643, 3443, 3406 | 3443 |
| shell (studio spawned) | 4625, 4441, 4557 | **4557** | 3648, 3448, 3411 | **3448** |

| studio (ms since its process started) | before median | after median |
|---|---|---|
| qml (Main.qml loaded) | 1070 | 1088 |
| frame (first frame on screen) | 1439 | 1449 |
| flags (saved look applied) | 1450 | 1455 |

| host (ms since its process started) | before median | after median |
|---|---|---|
| video (D3D11 up) | 244 | 257 |
| modules (all plugins loaded) | 818 | 828 |
| ready (discovery written) | 959 | 964 |

Window ready (launcher shell + studio flags): before about 6.0 s, after about 4.9 s (-1.1 s) on this tree. The ACL
pass alone: 360 ms per call before, 65 ms after (`protectPath` on the 1,300-file tree, 3 runs each).

First start in a fresh data folder (project built, before the ACL change): launcher shell 4307 ms, studio frame 1452 ms.
True cold start after a reboot: UNVERIFIED (not measured).

## What changed

1. `services/event-core/config.mjs` `protectPath`: reads the DACLs first (one `icacls /save`); when the item and tree
   already pass the same final check as before (allow ACEs for the current user's SID only, inheritance off at the
   top), nothing is rewritten. Anything else runs the full path as before. A test entry widened with Everyone:R was
   detected and fixed by the full path (checked by hand on the scratch tree).
2. `services/studio-ui/record-clips.mjs` (`resumeHoldMs`, launcher 60 s): clip jobs left from the last session wait
   60 s after a start; jobs of this session start at once. Test in `tests/record-clips.test.mjs`.
3. `services/studio-ui/launch.mjs`: the live clipper and the face worker start 10 s after the host is ready
   (`UJWALAM_WORKER_START_DELAY_MS`), not on the window's critical path. Outputs, hotkeys, panic key and replay are
   unchanged and still ready before the studio opens.
4. Start-up lines in all three processes (above); `tests/startup-clock.test.mjs`, and
   `tests/live-updates-launcher.test.mjs` checks the launcher line exists and its marks are ordered.

Items 2 and 3 do not show in the dev numbers (no unfinished clip job, no venv for the workers in the scratch folder):
their effect on the user's 9 s studio gap is UNVERIFIED until the next installed start's startup lines are read.
`--live` starts (credential reads, YouTube event calls in the UI server) were not measured: UNVERIFIED.

## Not changed (proposals)

- Project load (about 1.3 s): about 0.7 s is the NVENC session probe inside `project.load` (deferred outputs). Must stay
  a runtime probe (AGENTS.md); it could run while the studio opens if the studio shows "outputs starting". Encoder
  graph change: needs Opus + Codex review.
- Studio QML load (about 1.0 s of 1.45 s): qmlcachegen is on (qt_add_qml_module). The remaining cost is creating every
  page at start; pages not shown first could be Loaders (asynchronous).
- The studio is spawned only after the project load and UI server; spawning it earlier (key given on its stdin) would
  overlap its 1.4 s with the host and project load.
