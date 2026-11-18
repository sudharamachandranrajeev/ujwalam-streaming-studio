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

## Not run

- `app/host/tests/host-devices-late.test.mjs` (new): starts the host. Late mic sound built on device change (A2),
  `mixer.levels` and the +12 dB limit (B9/B5), `devices.rescan` (A3), the slow retry (A3), image rebuild on rescan (A4).
  Run it off air on the laptop: `node --test --test-concurrency=1 app/host/tests/host-devices-late.test.mjs`.
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
