# Devices and mixer fixes (2026-11-18)

User bug report (2026-11-18): the audio mixer has many bugs (strips missing or doubled, meters wrong or dead), and a
layer that is not found at start is never found afterwards.

Branch `fix/devices-mixer`. Status per item: **verified** = a test ran and passed (command below);
**UNVERIFIED** = written, built or reasoned, but no test has run it (the host tests start the host and were not run on
this pass, see "Not run").

## What changed, per item

| Item | Change | Status |
|------|--------|--------|
| A1 | A preset placeholder (game capture, camera) becomes the real capture layer once its device is listed: at start (`launch.mjs` `rebindAtStart`, backup in `_old/` first) and with a one-click **Connect** on the layer row (`/ui/api/devices/connect`; also while live) | verified (node, QML twin of the button not run: no placeholder in the fake host) |
| A2 | A mic or output sound whose device was missing at start is built when the device appears (`bind_waiting_audio` on every device change); until then the mixer shows a waiting strip with the reason | waiting strip verified (QML, fake host); host build path UNVERIFIED |
| A3 | Connect attempts no longer stop after five tries: a slow retry every 60 s; `devices.rescan` and a **Try again** button on waiting layer rows and waiting strips | buttons and route verified (QML, node); host retry UNVERIFIED |
| A4 | The monitoring (CUE) output is re-applied when devices change; missing image/media files are rebuilt on rescan | UNVERIFIED (host test written) |
| A4 | Browser layers reload | **not done** (see below) |
| A5 | `hostRestarted` reloads scenes, layers and the mixer | built, not separately tested |
| B2/B3 | The mixer reloads on a device change (status `devices.seq`) and after add/remove | verified (QML: `mixer.list` read again) |
| B4 | Strips keyed by id in a stable ListModel; a refresh changes the row, not the strip | verified (QML: 3 strips built once over several reloads) |
| B5 | Fader -60..+12 dB, 0 dB tick, "Off" at the bottom (sends -100); an unchanged value sends nothing | verified (QML) |
| B6 | A volume change on a sound with no project entry says once that it is live only | built, not separately tested |
| B7 | A capture card's "-Video" and "(...-Audio)" are one device: the second is refused (`same-device`) and its strip says "Already in the mix as ..." with no Add to stream | verified (node); name rule UNVERIFIED for other brands |
| B8 | Peak hold: the host keeps the highest peak for 300 ms (several windows read the meters); the strip draws a 1.5 s hold marker | QML marker built; host hold UNVERIFIED |
| B9 | `mixer.levels`: a light meters-only call (try_lock, never blocks the render) replaces reading the full list each poll | verified in QML against the fake; host side UNVERIFIED |
| B10 | `mixer.setVolume` answers the volume taken (held to +12); the strip keeps it | verified (QML) |

## Commands and results (all off air, `tools/live-check.mjs` "off air" before each run, BelowNormal, one file at a time)

- `node --test --test-concurrency=1 tests/project-rebind-roles.test.mjs`: pass 4, fail 0
- `node --test --test-concurrency=1 tests/studio-devices-mixer.test.mjs`: pass 9, fail 0
- `node --test --test-concurrency=1 tests/mixer-audio-sources.test.mjs`: pass 7, fail 0
- `node --test --test-concurrency=1 tests/studio-ui-server.test.mjs`: pass 40, fail 0
- `node --test --test-concurrency=1 tests/studio-ui-device-hotplug.test.mjs`: pass 3, fail 0 (expectation updated: the snapshot now carries `connectable`)
- `node --test --test-concurrency=1 tests/studio-ui-mixer-routing.test.mjs`: pass 3, fail 0
- `node --test --test-concurrency=1 tests/studio-ui-alpha.test.mjs`: pass 39, fail 0
- `node app/host/tools/build.mjs`: host built (compiles; not run)
- `node app/studio/tools/build.mjs`: studio built
- `node --test --test-concurrency=1 tests/studio-qml-devices-mixer.test.mjs` (new, headless probe): first run pass 3 fail 1
  (the Try again action ran before the strip existed on the first cold start after the build, 19.5 s); then that test alone passed once and
  two full runs passed (pass 4, fail 0 each)
- `node --test --test-concurrency=1 tests/studio-qml-shell.test.mjs`: pass 5, fail 0
- `node --test --test-concurrency=1 tests/studio-qml-editing.test.mjs`: pass 43, fail 3. Fixes and rerun:
  - The volume-wheel test typed -6, which is the fake game's volume already; since B5 an unchanged value sends nothing.
    The test now types -10 (expects -10, then -12).
  - The volume drag test now expects -42/-6 (a quarter and three quarters of -60..+12).
  - Two Look panel tests failed with exit code null: the shell was killed at its 50 s limit while the machine was
    loaded (the whole file took 819 s).
  - Rerun of the three tests (`--test-name-pattern`): pass 3, fail 0.

## Codex review fixes (2026-11-18, after the rebase onto claude/alpha0-d1)

- **P1, monitoring output switch (live path; superseded by round 2 below).** Checked against OBS 32.1.2 (`libobs/obs.c`
  `obs_set_audio_monitoring_device`, `libobs/audio-monitoring/win32/wasapi-output.c`). The finding is right: the id is
  freed under `monitoring_mutex`, but `on_audio_playback` calls `audio_monitor_init_wasapi` on its reconnect path and
  reads `obs->audio.monitoring_device_id` with only the monitor's own playback lock held. `audio_monitor_destroy` (CUE
  off) frees the monitor before it takes `monitoring_mutex`, while `obs_reset_audio_monitoring` walks the list. Fix:
  `Studio::when_no_monitors` runs the switch under the studio lock. Every CUE change takes that lock. The switch runs
  only when no source has a monitor (`obs_enum_all_sources`, private sources included; stingers are created with
  `audio_monitoring` 0). Otherwise it waits for the next device change, Try again, or a CUE switched off. Plugging the
  same output back in passes the same id, which libobs returns early on. Status: built; UNVERIFIED at runtime (host
  test not run).
- **P2, Connect saved a stale snapshot.** New `projectSync.update(change)` writes the pending edits, reads the file
  again, makes the change and saves, all in one synchronous step. Connect makes the same rebind on the fresh copy and
  keeps the new project device ids. If the fresh copy would rebind other layers, the host change is undone
  (`changed`). Verified: `tests/studio-devices-mixer.test.mjs`. A structure edit saved and a layer edit recorded while
  the host calls ran are both kept.
- **P2, a failed save after the host accepted.** The host change is undone: `not-saved` (500). If the undo fails too:
  `not-saved-live`. Verified (same file).
- **P2, two cards of one model.** The finding is right: dshow names do not number duplicate cards, so one card's audio
  blocked the other card's layer sound. Neither libobs nor the host gives a shared id: the dshow path and the WASAPI
  endpoint id have nothing in common. The Windows container id would link them, but the host does not read it yet.
  The rule now: refuse only when the device list has exactly one "<product>-Video" and exactly one
  "(<product>-Audio)". Otherwise add the sound with a warning (`maybeSameAs`; the studio shows it in the "Added"
  note). Windows' "(2- <product>-Audio)" counts as the same product. Verified (same file).
- **P3, a device event during a refresh.** A refresh asked for while one runs now runs once more after it. Verified
  (same file).
- **A5** lives in `app/studio/qml/Store.qml` (status poll): when the host uptime drops, `hostRestarted()` re-embeds the
  previews (`PreviewArea.qml`) and `loadScenes()` reloads scenes, then layers and the mixer. Built; not separately
  tested.

### Rerun after the rebase and the review fixes (off air, one file at a time, BelowNormal)

| Test file | Result |
|---|---|
| project-rebind-roles | 4/4 |
| studio-devices-mixer | 14/14 |
| mixer-audio-sources | 7/7 |
| studio-ui-server | 40/40 |
| studio-ui-device-hotplug | 3/3 |
| studio-ui-mixer-routing | 3/3 |
| studio-ui-alpha | 39 pass, 1 skipped |
| studio-ui-transitions | 4/4 |
| studio-ui-scene-templates | 5/5 |
| project-schema | 148/148 |
| studio-qml-devices-mixer | 4/4 |
| studio-qml-editing | 45 pass, 1 fail; the failure was "layer menu: Delete": exit code null, the shell killed at its 50 s limit while the machine was loaded. Rerun alone: pass |
| studio-qml-shell | 4 pass, 1 fail ("defaults"), see below |

- The "defaults" failure in studio-qml-shell is in the base branch, not this one. It expects every flag off except
  four, but `data/flags.json` on claude/alpha0-d1 also has `transitions` on (D391). This branch changes neither file.
- Builds: the host and the studio both build.

## Codex review round 2 (2026-11-18, branch fix/devices-mixer-r2 from claude/alpha0-d1)

Each finding was checked against the OBS 32.1.2 source (`out/obs-src/obs-studio/libobs`).

- **P1 + P1, monitoring output switch.** Both findings are right, and the round-1 fix
  (`Studio::when_no_monitors`) did not make the switch safe:
  - `obs_set_audio_monitoring_device` (obs.c 2985-3009) frees `monitoring_device_id` under `monitoring_mutex`.
  - The readers do not take that lock:
    - `audio_monitor_init_wasapi` (wasapi-output.c 166 and 378), run on a monitor's reconnect;
    - `obs_source_audio_output_capture_device_changed` (obs-source.c 385-433). It runs for every Audio Output Capture
      source (OBS_SOURCE_DO_NOT_SELF_MONITOR) from `check_all_aoc_sources` and from that source's `activate` signal on
      the video thread. That source can read the id with CUE off everywhere.
  - A released source is destroyed later (`obs_source_destroy_defer`). It can still hold a monitor after it left the
    studio's lists.

  Fix: no libobs patch, and the output never changes on a running graph:
  - `apply_monitoring` runs once, at host start, before the studio exists. No libobs source exists then, so nothing can
    read the id.
  - `Studio::when_no_monitors` and every later switch are removed: device watcher, Try again (`devices.rescan`), and
    CUE off.
  - When headphones that were missing at the start are listed later, `check_monitoring` only reports it. `mixer.list`
    and `devices.rescan` return `headphones`: "Headphones "<name>" are connected now. The headphones change applies
    when you restart the studio." The studio says it once.
  - Headphones in use since the start that are unplugged and plugged back are reopened by libobs itself. The id is the
    same, and nothing is freed.
  - A full project reload is not used as a safe point. Proving that no source is left (deferred destroy, private
    sources, the destroy thread) is harder than the restart, and the restart is the plain answer.
  - Verified:
    - host builds;
    - host-devices-late 6/6, host-api 16/16, host-device-hotplug 7/7, host-audio-add 4/4;
    - QML: the sentence is shown (studio-qml-devices-mixer, new test).
  - UNVERIFIED: real headphones with `monitoringDevice` set (no host test sets it).
- **P2 + P2 (pending switch forever, sources_mutex held through the callbacks).** Moot: the setter runs only at
  start, with no sources and before the video tick has any source to render.
- **P2, Connect live and on disk could differ.** The fresh-copy rebind must now give the file exactly what the host
  built. In each scene Connect touched, the layer order must be the same and every rebound layer identical.
  Otherwise nothing is saved (`changed`) and the host is put back. Verified: new test "a placement saved while
  Connect ran".
- **P2, the rollback wiped a newer edit.** `undoHost` now reads the file as it is at that moment (pending edits written
  first). It puts the placeholders back from that copy, skips a layer or scene removed meanwhile, and orders each
  scene as the file has it. The document read at the click is used only when the file cannot be read. Verified: new
  tests (placement kept, order kept). The finding's "conditional on the revision Connect installed" is covered this
  way: the undo makes the host equal to the file, so it cannot overwrite an edit the file holds.
- **P2, B7 false merge (card A saved, A unplugged, identical card B listed).** The finding is right. A saved card
  input now counts as "the same device" only when it is the listed input of a certain pair: same endpoint id, or the
  same name when it has no id. Otherwise the sound is offered and added with the `maybeSameAs` warning. Verified:
  new test. The Windows container id was not added. It needs SetupAPI on the dshow interface path and a CMake link
  change, and it cannot be verified without two identical cards. Proposed as a follow-up.
- **P3, a refresh lost between the last check and `.finally()`.** The in-flight marker is now cleared in the same
  step that finds no pass wanted. Verified: a new test asks again after 0..59 microtask turns.
- **P3, mixer reads waited on devices.list.** The UI server keeps the newest `devices.list`. It reads it again when
  `devices.seq` moves (and at the first status read), and `mixer.list` answers at once from that copy. Verified: new
  test in studio-ui-device-hotplug: the answer comes while devices.list is still pending, with one list per seq.
- The four new device-route and B7 tests fail on the round-1 code (checked by swapping the two source files back)
  and pass now.

### Rerun after round 2 (off air, one file at a time)

| Test file | Result |
|---|---|
| studio-devices-mixer | 18/18 |
| studio-ui-device-hotplug | 4/4 |
| mixer-audio-sources | 7/7 |
| studio-ui-server | 40/40 |
| studio-ui-mixer-routing | 3/3 |
| studio-qml-devices-mixer | 5/5 |
| host-devices-late | 6/6 |
| host-api | 16/16 |
| host-device-hotplug | 7/7 |
| host-audio-add | 4/4 |

## Not run

- (`app/host/tests/host-devices-late.test.mjs` ran after round 2: 6/6, see above.)
- Full CI, GPU tests, any test that starts the host with NVENC.
- The widget studio (`app/studio/src/main_window.cpp`) has none of the QML changes (slider range, waiting strip, Try
  again, Connect).

## Not fixed

- **Browser layer reload (A4).** A reload needs the overlay port work and can reset overlays that are on air; the layer
  code is being changed by another track now. Proposed for that track.
- **Audio lag log** (183 "max audio buffering" lines, 1711 TS_SMOOTHING lines). Not changed. Likely causes, in order:
  1. The same capture card endpoint opened twice (the dshow device's own audio and a WASAPI input of the same device):
     two clocks for one sound, so libobs keeps raising its buffer. B7 now stops new doubles, but an existing project can
     still hold both.
  2. CPU load when a heavy job runs next to the stream (timestamps late, smoothing kicks in).
  Proposed: a startup check that lists projects with both channels of one device and offers one click to keep one;
  log `obs_get_audio_buffering` (or the buffer ms from the log line) in the health panel to see if it climbs after a
  device change. Needs a live log with timestamps to confirm.

## Risks

- B7's name rule (`-Video` / `(...-Audio)`) fits the capture cards seen so far; another brand may name its channels
  differently and still be doubled (no harm beyond today's behaviour).
- A1 at start rewrites the project once (backup first). A wrong role match would move a placeholder to the wrong device;
  only video roles (game capture, camera) are matched.
- The slow retry opens the device again every 60 s while it stays dark; on a busy device that is a short stall each
  minute (UNVERIFIED on hardware).
