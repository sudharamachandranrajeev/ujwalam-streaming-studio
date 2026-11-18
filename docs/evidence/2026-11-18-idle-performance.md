# 2026-11-18 Idle performance (off air)

Branch `perf/idle-load`. The user reported that the studio is laggy and uses too many resources while off air. An
audit found five causes. Each fix below is one commit with what changed, the expected effect and how to measure it.

Status: the code changes are built and tested. The user's studio was open while items 1-5 were built, so the host GPU
tests ran later, after the user closed it (about 22:05): host-replay-onair, host-a0-day2, host-browser and
host-preview-edit all pass (results in each section). The before/after idle numbers are NOT measured yet: the main
session runs `tools/perf-idle.mjs` on `claude/alpha0-d1` (before) and on the merged branch (after). During every GPU
run here the clip agent's ffmpeg was also using the GPU.

## Measurement (all items)

`node tools/perf-idle.mjs --minutes 10 [--warmup 60]` (see the script header). It refuses to run (exit 1) when
`node tools/live-check.mjs` says live, or when the installed studio runs (found by its exe path under
`%LOCALAPPDATA%\Ujwalam`, never by process name; a failed check counts as running). It starts the headless alpha stack
(`tools/soak/stack.mjs`: mock Streamer.bot, event core, host in alpha mode with the overlay child, UI server; every
stream target a 127.0.0.1 listener), waits, measures for N minutes and prints one JSON line:

- per role (host, CEF pages, overlay child, event core, UI server, mux): CPU seconds in the window, private and
  working-set MB at the end;
- GPU 3D and video-encode utilisation, mean and max (nvidia-smi every 5 s);
- from `host.status`: render lag and skipped frames in the window, average frame time, live and recording (both must
  be false);
- `others`: other GPU-heavy processes seen during the window (ffmpeg, another host), so overlaps are visible.

Not in it: the launcher's own loops and the Python workers (the host token exists only inside the launcher). Items 4
and 5 and their tests cover that part.

Plan: run it on `claude/alpha0-d1` (before) and on the merged branch (after), same minutes, same machine state.

## 1. Replay buffer only while live or recording

Before: the alpha host config had `replay: { seconds: 60, autoStart: true }`. The host started a replay buffer for H
and V at studio start: two replay outputs that keep the 2560x1440 and 1440x2560 rung encoders (or fallback NVENC
encoders) running and hold 60 s of video in RAM. Measured off air (2026-11-18): video encode at 65 % with nothing
live.

Change:

- Host config `replay.onAirOnly` (new, default false; `app/host/src/host_config.cpp`). With it, the autostarted
  replay buffer is armed but attaches only while some sink is wanted (a stream or recording started and not stopped;
  a retrying stream counts). `Outputs::start` and `Outputs::stop` re-check the gate; the output supervisor checks it
  once a second, so a sink that ends on its own (a recording that failed to start, retries used up) also stops it.
- An explicit `replay.start` stays a manual start: on at once, until `replay.stop` (tests and tools rely on it).
- `replay.status` gains `onAirOnly` and `waiting` (armed, off air, no output).
- Off air, `replay.save` answers `off air: the replay buffer runs only while you are live or recording`. The
  feedback hotkey (Ctrl+Alt+F) still writes `moment.json` and `log.txt`; the replay error in `moment.json` says the
  same. The Save clip button (Qt shell and QML) shows that sentence.
- The launcher writes `replay: { seconds: 60, autoStart: true, onAirOnly: true }` and prints the state.

Expected effect: off air, no replay encoder and no 60 s memory buffer: video encode near 0 %, about 2 NVENC sessions
and a few hundred MB of RAM fewer. While live or recording nothing changes: the replay binds to the rungs the sinks
already use. Side effect: the buffer starts empty at go-live, so a clip saved in the first 60 s of a stream is shorter.

Tests:

- `node --test --test-concurrency=1 tests/studio-ui-alpha.test.mjs`: 39 pass, 1 skipped, 0 fail (host config keys,
  launcher status line with the fake host).
- New `app/host/tests/host-replay-onair.test.mjs` (real host, NVENC; run after the studio was closed): 3 pass.
- `app/host/tests/host-a0-day2.test.mjs` (manual replay.start path, unchanged behaviour): 10 pass.

Measure: `perf-idle` field `gpu.videoEncodePct` (before about 65 %), host private working set, NVENC sessions
(`host.status` `gpu.encoderSessions`).

## 2. Browser layers: 30 fps (pages keep running while hidden)

Before: every browser layer (project layers in `model.cpp`, `layers.add` in `studio.cpp`) rendered at the fastest
canvas rate (60 fps) with `shutdown: false`, so pages in scenes that are not on air, and hidden layers (the goal bar,
`atmos-frame`), kept painting full-canvas CEF frames all the time.

Change:

- Frame rate: `model::kBrowserFps` = 30 unless the layer's source asks for more with the new optional `fps` key
  (project schema, 1..240; never above the fastest canvas). `layers.add` uses 30 unless its `fps` asks otherwise.
- Shutdown: first `shutdown: true` (commit d8610df, with a `browserKeep` list for chat-list), then back to
  `shutdown: false` for every browser layer after the measurement in 2a: obs-browser 32.1.2 already stops painting a
  page that is not shown, so shutdown saved nothing, while it reloaded pages on every show (2-3 frames late on a cut)
  and lost events that arrived while hidden. The `browserKeep` / `data/overlays/browser-render.json` plumbing is
  removed with it. `restart_when_active` stays false.
- How events reach hidden scenes: overlay pages connect to the overlay bridge feed themselves (WebSocket, sbHost/sbPort
  in the page URL); the relay page `ujw:overlay-relay` is a private source and is unchanged. Pages keep running while
  hidden, so they keep their state (chat-list history, an alert card in its hold time) and show it when their scene
  comes on air. The bridge has no backlog, so nothing is ever replayed.
- `project.plan` lists `fps` per browser source (for the host test).
- `atmos-frame`: a hidden layer (`visible: false`) in the default scenes; obs-browser does not paint it while hidden
  (measured: no CEF CPU for hidden pages). If it is switched on, it renders at 30 fps; a lighter port under the
  project's own overlay folder is a follow-up only if it then measures heavy. `legacy/` is not touched.

Expected effect: browser (CEF) paint work about halved for the layers on air (60 to 30 fps). Hidden layers and
scenes not shown cost nothing measurable, as before. No reload on a scene switch.

Tests:

- `tests/project-schema.test.mjs`: 142 pass. Host build: built.
- `app/host/tests/host-browser.test.mjs` (real host, CEF): plan fps 30, and 60 when the source asks with a 60 fps
  canvas; new test: an effect fired while its scene is hidden is drawn when the scene is cut on air 400 ms later.
  Results below (2b).

Measure: `perf-idle` `gpu.gpu3dPct`, host CPU seconds, the CEF subprocess (obs-browser-page.exe) CPU and memory.

### 2a. Measured: what shutdown costs on a scene switch (2026-11-18, studio closed)

Asked in review: with `shutdown: true` a page reloads when its scene comes on air, so an overlay could be blank for
the first frames after a cut or fade. Measured with `node app/host/tools/browser-switch-measure.mjs --mode both
--cycles 3` (added in the commit that carries this section; it needs that commit's `browserKeep`). Real host, NVENC
recording at 640x360 30 fps, read back as 320x180 grey frames, no image kept. Scene `ov`: four legacy overlays in
quadrants (atmos-frame, blood-moon-hud, social-ticker, cam-pop-frame) and a white marker block that gives the exact
switch frame. Overlap: the clip agent's ffmpeg was running on the GPU during both runs (it started 22:15).

Frames from the switch until a quadrant shows 80 % of its steady drawing (30 fps; a cell lists each cycle):

| overlay (share of quadrant drawn) | cut, shutdown | cut, kept running | fade 300 ms, shutdown | fade 300 ms, kept running |
| --- | --- | --- | --- | --- |
| blood-moon-hud (0.7 %) | 4, 2 | 2, 1, 1 | 7, 6 | 6, 7, 7 |
| social-ticker (2.4 %) | 5, 4, 0 | 2, 1, 1 | 6, 6 | 6, 6, 7 |
| atmos-frame (0.4-0.8 %, animated) | 30, 19 | 16, 1, 27 | 29, 32 | 7, 6, 77 |
| cam-pop-frame | draws nothing without an event | same | same | same |

Two shutdown-mode windows (one cut, one fade) lost their marker (wall clock against file time drifted) and are left
out. atmos-frame animates, so its 80 % point is noisy in both modes. First run (`--cycles 2`, 1 % threshold): ticker
4-5 frames with shutdown against 1-2 kept running.

- Cut: shutdown adds about 2-3 frames (67-100 ms) before a page draws. Fade 300 ms: no difference (the fade dominates).
- CPU while the overlay scene is hidden, 30 s: obs-browser-page.exe 0.03 s with shutdown and 0.03 s kept running
  (first run 0.08 / 0.09). obs-browser 32.1.2 already stops painting a page that is not shown, so shutdown saves
  nothing measurable while hidden. On air, 30 s after a 5 s settle: CEF 11.1 s (shutdown) and 9.9 s (kept running).
- Missed event: gg-burst fired while its scene was hidden, scene cut on air 400 ms later. Shutdown: 0 % drawn (the
  page was closed when the effect went out, and the reloaded page gets nothing: the bridge sends only `Hello` on connect,
  no backlog, so nothing is replayed either). Kept running: 2.1 % of the frame drawn (the rest of the burst).

Result: shutdown has a visible cost on cuts and loses events, and no measured saving. The next commit sets
`shutdown: false` again (the Change list above). The measuring tool is removed with it, because its comparison needs
the `browserKeep` switch. It is in commit 12578c0.

### 2b. Host test after the change

`node --test app/host/tests/host-browser.test.mjs`: 8 pass. gg-burst onset 0 ms after effect.fire, shown 2267 ms,
peak 2.1 %. New test: an effect fired while its scene is hidden, scene cut on air 400 ms later: peak 2.3 % of the
frame drawn (the rest of the burst is shown). Overlay child restart: back in 611 ms, effect onset 33 ms after it.

## 3. Previews stop drawing while they cannot be seen

Before: the H and V preview displays (`app/host/src/preview.cpp`, stand-alone windows and the previews embedded in
the Qt studio shell, D280) drew every frame even while hidden, minimised or zero size.

Change: `update_drawing` calls `obs_display_set_enabled(false)` while the preview window is not visible (its own
WS_VISIBLE or a hidden parent), its top-level window is minimised, or its client area is zero; and `true` again when it
can be seen. It runs on WM_SIZE, WM_WINDOWPOSCHANGED and on the existing 200 ms refresh timer (which catches a hidden or
minimised parent: a child gets no message then). Headless embedded previews (`never_show`, tests) keep drawing: tests
count their selection boxes. `preview.list` / `preview.open` report `drawing`. The Qt shell needs no change: it hides
or minimises the windows the previews are embedded in, which the host now sees.

Expected effect: with the studio minimised or the preview area hidden, no preview render passes: less GPU 3D load
(two full-canvas scale-and-draw passes per frame at the display rate).

Tests:

- Host build: built.
- `app/host/tests/host-preview-edit.test.mjs` (real host, headless): asserts `drawing` stays true for a headless
  embedded preview. 19 pass.
- NOT TESTED: a visible preview minimised and restored (needs a non-headless host with a window on screen; tests run
  headless). Check by hand: open the studio, minimise it, `preview.list` shows `drawing: false`; restore it,
  `drawing: true` within 200 ms and the picture continues.

Measure: `perf-idle` with the studio shell minimised versus shown (`gpu.gpu3dPct`).

## 4. Python workers only while wanted

Before: the launcher started the live clipper (`services/clip/live_worker.py`) and the face worker
(`services/face/face_worker.py`) with every alpha session, whatever the flags; each idled in its own loop while off.

Why live_worker used about 3054 CPU seconds off air (2026-11-18): it scans (frames.grab + detector scan + OCR, once
per second) whenever `flag_on('live-clips') or worker_wanted()`. `worker_wanted()` reads
`<data>/clips/live-worker.json`, which the launcher (record-clips.mjs) keeps fresh only while live (clips "while
live") or recording (clips "while recording"), and which is ignored when older than 30 s. So off air the only way to
scan is the live-clips flag: with it on, the worker scanned all day with nothing live. (Read from the code; the user's
local flags file was not read, so which day the flag was switched on is UNVERIFIED.)

Change:

- `live_worker.py` `wanted()`: the launcher's request (live-worker.json) as before; the live-clips flag counts only
  while `host.status` says live or recording (the clips token allows host.status). A host that does not answer counts
  as off air. Checked every 5 s as before.
- Launcher: the clipper process runs only while `liveClipperWanted` (live-clips flag on, or clips set to "while live"
  or "while recording"); the face worker only while the face-ai flag is on. Both are re-checked on the 5 s clip tick,
  so a switch made while live applies within 5 s. A worker no longer wanted gets its parent pipe closed (it ends
  itself, D234) and is ended with its tree after 10 s; that exit is not counted as a crash. The task panel shows the
  clipper as not started with the plain reason (`LIVE_CLIPPER_OFF_REASON`). Switching off and on again starts fresh
  (restart count 0).
- The scene file for the clipper spec is read again only when it changed (mtime and size), and the flags are read
  through one instance (re-read only on change) instead of a new instance per check.

Expected effect: off air with default settings (flags off, clips "ask"): no clipper and no face worker process (two
Python processes with onnxruntime fewer: CPU near 0 and a few hundred MB of RAM). With the flag on, the clipper process
waits off air (one host.status call every 5 s) instead of scanning.

Tests:

- `python -I -m unittest discover -s tests/py -t tests/py -p test_live_worker.py`: 11 run, OK (2 skipped: no numpy);
  new `OnAirTests` (flag counts only while live or recording, a dead host is off air, flag off never calls the host,
  the launcher request wins).
- `tests/studio-ui-alpha.test.mjs`: 40 pass, 1 skipped (new: `liveClipperWanted`, `clipperStoppedView`).
- NOT RUN: a full alpha session with the real workers switching on and off (needs the studio closed and the venvs).

Measure: `perf-idle` per-process CPU seconds for python.exe (before: live_worker scanning when the flag is on).

## 5. Polling loops do less work that does not change

Before:

- UI server (`services/studio-ui/server.mjs`), 1 s tick: `readSettings` twice (preview snap, clip status), a read and
  parse of `clips/status.json` and of the recovery status, and up to three `outputs.status` calls (on-air bar while
  live or recording, record while live, Instagram).
- Launcher: the clip tick (5 s) read the host discovery file and called `outputs.status` while the host watch loop
  (2 s) called it too; `createFlags` (which reads and validates `data/flags.json`) was built anew on each check; the
  scene file was loaded every 5 s while the clipper could not start.

Change:

- New `services/common/stat-cache.mjs`: a value read again only when its file changed (mtime in ns, size, file id).
  Used for settings.json, clips/status.json and the recovery status in the UI server, and settings.json in the
  launcher's clip tick. The posting queue summary is not cached (it depends on the clock).
- One `outputs.status` per tick, shared (lazily) by the on-air bar, record while live and Instagram. The record-while-
  live owner is still taken before any status is read.
- Idle back-off: off air, with no event-stream (SSE) page open and no recording owned, the tick skips every second
  interval (2 s). The Qt shell polls `/ui/api/status` every 2 s, so it still sees a fresh snapshot each poll. Live,
  recording or with a page open: every second as before.
- Launcher: the clip tick uses the host watch loop's `outputs.status` when it is at most 2.5 s old (one call and one
  file read fewer every 5 s). Item 4 already added one flags instance and the scene-file stat check.
- Not changed: the host watch loop (2 s): crash recovery needs the last streams seen; the mixer and device polling
  (another agent's work).

Expected effect: off air, UI server host calls fall from 3 per second (host.status, core.status, + previewSync
calls) to the same per 2 s, no file parses per tick while nothing changes, and one host call fewer every 5 s in the
launcher. Small CPU savings in node.exe; mainly less wake-up churn.

Tests (each file alone, `--test-concurrency=1`, BelowNormal): `tests/stat-cache.test.mjs` 2 pass (new),
`studio-ui-server` 40, `instagram-live` 29, `studio-ui-preview-edit` 6, `live-test-kit` 16, `studio-ui-alpha` 40,
`studio-ui-quit-lock` 5, `studio-ui-transitions` 4, `studio-ui-device-hotplug` 3, `studio-ui-stream-settings` 16,
`golive-routes` 35, `studio-ui-readiness` 39, `record-live` 12: all pass.

Measure: `perf-idle` node.exe CPU seconds (UI server and launcher).
