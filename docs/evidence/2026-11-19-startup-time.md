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

## Phase 3: early studio start (2026-11-19)

Branch from `claude/alpha0-d1` at c607600. Dev build (`npm run build:host`, `npm run build:studio`), `--alpha`,
practice mode, devices off (no `--allow-devices`: no device was opened for this measurement), one scratch data folder
for every run, warm. One warm-up run (after, not counted), then before and after interleaved, 3 runs each, medians.
Live-check said off air before the builds and runs; the installed studio was not running (checked by its
%LOCALAPPDATA%\Ujwalam path). "Before" is the same build with `UJWALAM_STUDIO_EARLY=0` (the old order: the studio is
spawned after the UI server). Window ready = the launcher mark at which the studio was spawned (`shell` before,
`studio-early` after) + the studio's own `frame` / `flags` marks.

| launcher ms | before (3 runs) | median | after (3 runs) | median |
|---|---|---|---|---|
| studio spawned | 3051, 2886, 2890 | 2890 | 83, 81, 82 | 82 |
| core | 886, 778, 783 | 783 | 848, 836, 871 | 848 |
| host-ready | 2016, 1888, 1899 | 1899 | 1962, 1962, 1992 | 1962 |
| project | 2913, 2735, 2743 | 2743 | 2788, 2817, 2843 | 2817 |
| ui (UI server up) | 3046, 2881, 2886 | 2886 | 2932, 2957, 2986 | 2957 |

| studio ms (since its process started) | before median | after median |
|---|---|---|
| qml (Main.qml loaded) | 697 | 707 (while the host starts) |
| ui (port on its pipe) | - | 2880 |
| login | 69 | 2902 |
| shown | 818 | 2947 |
| frame | 1132 | 3261 |
| flags | 1137 | 3267 |

| window ready (launcher ms) | before (3 runs) | median | after (3 runs) | median |
|---|---|---|---|---|
| first frame | 4181, 4021, 4022 | **4022** | 3301, 3342, 3387 | **3342** |
| flags (saved look applied) | 4187, 4031, 4027 | **4031** | 3307, 3348, 3394 | **3348** |

Window ready about 0.68 s sooner (-17%). Not the 1.2 s proposed: phase 2 already cut the QML load to about 0.7 s, and
that load plus Qt's start (about 0.72 s together) is what now overlaps the host start. The first frame still costs about
0.3 s after the window is shown and cannot start before it. The studio's QML load competes for the CPU with the event
core and the host: core +65 ms, host ready +63 ms, UI server +71 ms (medians). Outputs are started only by a click, so
no stream or recording start waits on this.

What changed:

1. `services/studio-ui/launch.mjs`: with the service-swap flag off, on Windows, the studio is spawned right after the
   flags are read (before the event core), with the one-time key in its environment as before (never on argv) and no
   URL (`earlyShellSpawnSpec`). Once the UI server listens, the launcher writes `ui <port>` on the studio's stdin pipe
   (no secret in it) and adopts it: from then on the same `watchShell` handles its exit (user close stops all, crash
   reopens it with a new key, at most 3 in 10 min). An early studio that ended before the UI server was up is recorded
   in `studio-exits.jsonl` (`early: true`) and one is started the old way. A launcher that ends before adopting it
   kills it. `UJWALAM_STUDIO_EARLY=0` switches it off. With the service-swap flag on, the studio slot starts the window
   exactly as before (no early start), so the update swap path is unchanged.
2. `app/studio/src/main.cpp`: `UJWALAM_STUDIO_EARLY=1` without a URL: load Main.qml at once with nothing on screen,
   wait for `ui <port>` (127.0.0.1 only), log in, apply the saved theme, then place the window. End of input before
   the line exits 0. The login asks again every 100 ms for up to 10 s while nothing answers (connection refused); a
   refused key exits 77 as before and is never retried.
3. `app/studio/src/qml_studio.cpp`: `begin()` split into `load()` (engine and Main.qml, no window) and `reveal()` (show,
   taskbar id and relaunch values (D400), start). `begin()` = both, unchanged for the probe and the normal path.
4. `app/studio/src/api_client.cpp`: in the early mode, requests the QML makes before the login (the update check) wait
   and go out after it, after the studio's own settings read.

The window is never shown before the login and the saved theme: there is no new waiting state on screen. Hotkeys, the
panic key, the replay buffer and outputs are host/launcher side and not touched. The studio swap path (flag on), the
single-instance guard (outside launch.mjs) and the crash-relaunch logic are unchanged; the early studio joins the
relaunch logic once adopted.

Tests (one file at a time, `UJWALAM_HEADLESS=1`, BelowNormal): `tests/studio-early-start.test.mjs` 7/7 (spec and
switch; real studio with the UI server 3 s late, port sent before the server listens, one login, no request without
the session; end of input before the port exits 0; refused key exits 77 after one try; launcher: early studio adopted,
window ready after the UI server, killed studio reopened as before; an early crash before adoption is started again
and repeated crashes stop as before). Unchanged and passing: `studio-swap-launcher` 9/9, `studio-ui-alpha` 39 pass 1
skipped, `taskbar-id` 2/2, `studio-crash-capture` 4/4, `studio-qml-palette` 7/7, `studio-swap-stream` 1 pass 1
skipped. `npm run lint`: 0 findings.

UNVERIFIED: the installed (packaged) build and `ujwalam-start.exe` starts; `--live` and `--allow-devices` starts; a
cold start after a reboot; that the taskbar button and relaunch values look right on a real shown window started early
(the code path is the same `reveal()`; only the hidden and probe modes were run by tests).

## Not changed (proposals)

- Project load (about 1.3 s): about 0.7 s is the NVENC session probe inside `project.load` (deferred outputs). Must stay
  a runtime probe (AGENTS.md); it could run while the studio opens if the studio shows "outputs starting". Encoder
  graph change: needs Opus + Codex review.
- Studio QML load (about 1.0 s of 1.45 s): qmlcachegen is on (qt_add_qml_module). The remaining cost is creating every
  page at start; pages not shown first could be Loaders (asynchronous).
- The studio is spawned only after the project load and UI server; spawning it earlier (key given on its stdin) would
  overlap its 1.4 s with the host and project load.

## Phase 2 (2026-11-19, branch of the start-up agent)

Same method as above: dev build, `--alpha --allow-devices`, practice mode, warm, 3 runs each, medians; live-check said
off air before every build and run. Scratch data folder (a fresh project, not the 1,350-file tree), so the launcher
numbers are lower than in phase 1 and are compared only with each other.

| launcher ms | before (3 runs) | median | after (3 runs) | median |
|---|---|---|---|---|
| core | 768, 791, 775 | 775 | 867, 809, 809 | 809 |
| host-ready | 1886, 1909, 1892 | 1892 | 2235, 1923, 1923 | 1923 |
| project | 3322, 3349, 3329 | 3329 | 3680, 3357, 3392 | 3392 |
| ui | 3502, 3528, 3500 | 3502 | 3857, 3537, 3580 | 3580 |
| shell | 3510, 3536, 3508 | 3510 | 3866, 3546, 3586 | 3586 |

| studio ms | before (3 runs) | median | after (3 runs) | median |
|---|---|---|---|---|
| qml (Main.qml loaded) | 1077, 1100, 1105 | **1100** | 798, 801, 765 | **798** |
| shown | 1212, 1234, 1243 | 1234 | 936, 937, 896 | 936 |
| frame | 1442, 1479, 1477 | 1477 | 1284, 1279, 1237 | 1279 |
| flags (window ready) | 1454, 1491, 1489 | **1489** | 1295, 1289, 1249 | **1289** |

Host `ready` median: before 961, after 954 ms (host code unchanged). The launcher code is unchanged too; its spread
(after1 was slower from the host's first mark on) is run-to-run noise. Window ready (shell + flags): before about
5.00 s, after about 4.88 s; the studio's own part is 200 ms shorter (-13%).

What changed: the 19 dialogs and windows that are not on screen at start (Settings, YouTube, Go live, palette, More
windows, add/rename dialogs, ClipsAsk) are made on their first use (`app/studio/qml/LazyDialog.qml`, a Loader with
the same calls). A removal experiment first showed they cost about 330 ms of the QML load. ConfirmDialog, CloseDialog,
TaskCenter, the guide and every panel stay as they were. Hotkeys (Ctrl+K, Ctrl+1..9, window keys) live in Main.qml
and are unchanged; Settings' Escape shortcut only acts while Settings is open. Outputs, panic key and replay buffer
are host/launcher side and not touched.

Tests (UJWALAM_HEADLESS=1, one file at a time, BelowNormal): all 29 `studio-qml-*` files pass, plus the new
`tests/studio-qml-lazy.test.mjs` (nothing made at start; a dialog made on first use, only that one; a window opened
that way works). Two editing asserts now read "no rename box open" as "not made or not open" (the probe tree only
lists made dialogs). The first full run caught a real slip (Settings' guide signals resolved to the dialog's own
`guide` property inside the component); fixed with `win.guideItem()`, and the guide tests pass.

Not changed:
- NVENC probe (about 0.7 s of `project`): deferring it to the first output start would make that start slower, and
  overlapping it means an encoder-graph change (Opus + Codex review). Not done.
- Spawning the studio before the host and UI server: the largest remaining win (about 1.2 s overlap), but the studio
  needs the UI URL and key at spawn, a login retry, and QML load split from the window show (theme before show). It
  touches the launcher's crash-relaunch and swap slot paths. Proposed, not done.

UNVERIFIED: the installed (packaged) build and a cold start after a reboot; the effect on `--live` starts.
