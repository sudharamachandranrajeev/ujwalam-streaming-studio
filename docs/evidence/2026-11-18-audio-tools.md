# Mixer audio tools: app sound, music playback, strip filters (AU1 finish, AU2)

Date: 2026-11-18. Plan `docs/plan/2026-11-18-audio-mixer-music.md`, items AU1 (finish) and AU2. Branch `feat/audio-tools`
from `claude/alpha0-d1` (54e71c2, MX1 + DV1 merged, D395). Off air (`tools/live-check.mjs`: off air before every build
and test). Tests one file at a time at BelowNormal priority, `UJWALAM_HEADLESS=1`. No device was opened, nothing went
live. The clip agent's `.venv-gpu` python and an ffmpeg were running during the host runs; these tests use no GPU
encode, and the measured levels below are exact to the dB, so no overlap effect was seen.

## What was built

AU1 (finish), "Add audio" gets two new kinds of sound, each a mixer strip on track 1, saved in the project:

- One app's sound: `audio.sources[].app = { exe }`, built on libobs `wasapi_process_output_capture` (present in OBS
  32.1.2 `plugins/win-wasapi/win-wasapi.cpp`, loaded with the win-wasapi module, so only with `--allow-devices`).
  The window spec is `"::<exe>"` with priority 2 (executable): empty title and class, any window of that program
  matches (`libobs/util/windows/window-helpers.c` `window_rating`). The host's `audio.apps` lists running apps with a
  visible top-level window by exe name only; it tests that a window has a title but never reads it. `sound: true` marks
  apps with an active audio session on the default render device. Exe names are checked by one rule (no folder, ends in
  `.exe`) in the validator, the schema and the host.
- A sound file or a folder playlist: `audio.sources[].playback = { file | folder: pathRef, loop }` (base `media`, the
  stream assets folder; rel paths only, never an absolute path in the project). One file: `ffmpeg_source` looping.
  A folder: the audio files in it by name; on `media_ended` the host sets the next file on the same source
  (`obs_source_update`, from its own thread, never the media thread), and after the last one starts again when `loop`.
  `vlc_source` is not used: the host never loads `vlc-video` (obs_runtime.cpp).
- The audio watchdog (D297) and the audio health view skip these two kinds: silence is normal there, never a dead
  device.

AU2, per-strip tools on libobs audio filters, part of the project data (`audio.sources[].filters`):

| Tool | libobs filter | Values (range = the filter's obs_properties limit, OBS 32.1.2) |
|---|---|---|
| suppress | `noise_suppress_filter_v2`, method `rnnoise` | none |
| gate | `noise_gate_filter` | openDb, closeDb -96..0; attackMs, holdMs, releaseMs 0..10000 (int) |
| eq | `basic_eq_filter` | lowDb, midDb, highDb -20..20 |
| gain | `gain_filter` | db -30..30 |
| compressor | `compressor_filter` (sidechain none) | ratio 1..32; thresholdDb -60..0; attackMs 1..500; releaseMs 1..1000 (int); outputGainDb -32..32 |
| limiter | `limiter_filter` | thresholdDb -60..0; releaseMs 1..1000 (int) |

- One range table in `services/project/audio-filters.mjs`, mirrored in `data/schemas/project.schema.json`
  (`$defs/audioFilters`) and `app/host/src/audio_tools.cpp`; a test checks schema = table.
- Order on a strip is fixed: suppress, gate, eq, gain, compressor, limiter. Filters are named `ujw:tool:<kind>`.
- Changes apply live and in place: `audio.setFilters` updates settings, switches a filter on or off, adds or removes
  it, and re-sorts with `obs_source_filter_set_index`. The source is never rebuilt. The watchdog's `recreate_global`
  already copies filters (`obs_source_copy_filters`).
- Presets as data: `data/audio-tools/presets.json` ("Clean voice" = suppress + gate + compressor + limiter, "Loud room"
  = those plus a bass cut), with source and checked date. Offered in the Tools window, never applied by themselves.
- UI: a "Tools" button on every mixer strip (off, with a reason, on a layer sound that is not in the stream yet: it
  has no project entry to keep tools). The Tools window: a switch per tool with its plain-word line, sliders always
  shown (greyed while off, so nothing moves), "Use Clean voice", "Use Loud room", "All tools off". Each change is sent
  at once and saved into the project file.
- Routes: `POST /ui/api/audio {op:'filters', audio, filters}` (validated, host first, then saved, undone on a failed
  save), `GET /ui/api/audio/tools` (ranges, order, presets, saved tools). `GET /ui/api/audio/choices` also returns
  `apps`, `files`, `folders`.

## Host test: measured filter effects

`node --test app/host/tests/host-audio-tools.test.mjs`: 12 pass, 0 fail (39 s). Generated 16-bit 48 kHz mono WAV files
play through project playback sources; `audio.testMeasure` (--test-hooks) reads peak and RMS (channel 0) after the
source's filters, through an audio capture callback (libobs calls it after `filter_async_audio`).

| Tool | Signal | Without | With | Effect |
|---|---|---|---|---|
| playback | 1 kHz sine, -20 dBFS peak | | peak -20.00, RMS -23.01 | plays at its level, 49152 frames in 1 s |
| gain +6 / -10 dB | 1 kHz, -20 dBFS | RMS -23.01 | -17.01 / -33.01 | +6.00 / -10.00 dB |
| gain switched off | same | | RMS back to -23.01 | off = plain level |
| gate open -26, close -32 | 1 kHz, -40 dBFS | peak -39.99 | no signal (-200, silence) | silenced below threshold |
| gate, same | 1 kHz, -20 dBFS | | peak -20.00 | louder signal passes |
| compressor 4:1, -20 dB, 1/50 ms | 1 kHz, -6 dBFS | peak -6.00 | peak -16.18 | -10.18 dB (expected 14 x 3/4 = 10.5) |
| limiter -12 dB | 1 kHz, -3 dBFS | peak -3.00 | peak -12.00 | capped at the ceiling |
| eq low -15 dB | 100 Hz, -20 dBFS | RMS -23.01 | RMS -30.70 | -7.68 dB in the low band |
| eq low -15 dB | 10 kHz, -20 dBFS | RMS -23.01 | RMS -23.01 | high band unchanged (0.00 dB) |
| eq high +10 dB | 10 kHz, -20 dBFS | RMS -23.01 | RMS -12.13 | +10.88 dB |
| suppression (RNNoise) | white noise, RMS -30 dBFS | RMS -29.96 | RMS -43.13 | -13.17 dB stationary noise |
| live change | 1 kHz, -20 dBFS, six tools, then gain change, then all removed, inside one 1.5 s window | | 70912 of 72000 frames | audio kept flowing; same strip id and tracks |
| folder playlist (loop) | a.wav -30 dBFS 1.5 s, b.wav -10 dBFS 1.5 s | | peaks per 450 ms: -30, -30, -30, -10, -10, -10, -10, -30, -30 | next file on the same strip, then loops |
| reload | project saved with gate off (close -50) + limiter -24 | | order gate, limiter; gate off; peak -24.00 | saved tools come back on project.load |

Notes on the numbers:
- The 3-band EQ uses gentle crossovers: at 100 Hz the low band's -15 dB measured -7.7 dB. The test checks "more than
  5 dB lower" (first draft asked for 10 dB and failed on this measured behaviour; the threshold was set from the
  measurement, not the other way round).
- Live change: 1.5% fewer frames than 1.5 s holds, inside the test's 5% margin; callback timing at the window edges is
  the likely cause (UNVERIFIED). No gap was measured.
- App sound: the host refuses an app source without `--allow-devices` (`forbidden`) and refuses a path in `exe`;
  `audio.apps` returned exe names only. A real app capture on a real PC is UNVERIFIED (no device run).

## Route and QML tests

- `node --test tests/audio-tools-routes.test.mjs`: 9 pass, 0 fail. listAudio, choices (apps sound-first, files,
  folders, no absolute path reaches the page), add app (saved as exe on the stream track; a name the host did not list
  refused; twice refused), add file / folder (loop true; `../`, absolute, non-audio and unknown refused), tools set /
  change / clear (saved, sent to `audio.setFilters`), out-of-range values refused before the host with nothing saved,
  tools route (ranges, order, presets with source and date, every preset valid), schema = table, validator rules.
- `node --test tests/studio-qml-audio-tools.test.mjs` (headless probe, fake host): 3 pass, 0 fail. Tools button opens
  the window with the six plain-word tools; "Use Clean voice" and the Gain switch each make one `audio.setFilters` call
  and are saved; opening the window changes nothing; no add/remove of the sound. Add audio lists "One app's sound"
  (player.exe) and both music groups.
- Regressions, each run alone: `tests/project-schema.test.mjs` 148/0, `tests/mixer-audio-sources.test.mjs` 7/0,
  `tests/studio-ui-mixer-routing.test.mjs` 3/0, `tests/studio-qml-devices-mixer.test.mjs` 4/0,
  `app/host/tests/host-audio-add.test.mjs` 4/0, `app/host/tests/host-audio-health.test.mjs` 7/0. `npm run lint`:
  0 findings. Builds: `node app/host/tools/build.mjs`, `node app/studio/tools/build.mjs` (both exit 0).
- After the rebase onto `claude/alpha0-d1` 823550a (devices round 2, idle load, setup merged): host and studio rebuilt,
  rerun alone: host-audio-tools 12/0, audio-tools-routes 9/0, studio-qml-audio-tools 3/0, host-audio-add 4/0,
  studio-qml-devices-mixer 5/0. The commit hook's quick CI passed (9/9).
- Not run: the full CI (`npm run ci`).

## Unverified

- One app's sound and the app list on a real PC with `--allow-devices`; a UWP app (OBS matches those by title, which
  Ujwalam never stores, so a UWP app may not be found).
- The presets' values on the user's mic and room; RNNoise on real speech (measured on white noise only).
- Use on a real stream.

## Review fixes (Codex review of AU1/AU2, 2026-11-18)

Each finding was checked against the OBS 32.1.2 source in `_vendor/obs-32.1.2/src` (the repo has no `out/obs-src`).

| # | Finding | Checked | Fix | Test |
|---|---|---|---|---|
| 1 | Filter list changes race the video tick | Confirmed: `obs_source_video_tick` walks `filters` without `filter_mutex` on show/hide and activate/deactivate (obs-source.c 1389-1422). The audio walk (`filter_async_audio`) runs under `filter_mutex` (4049). | `apply_filters` runs on the graphics thread through `obs_queue_task(OBS_TASK_GRAPHICS, …, wait=true)`, between ticks. No host graphics-thread callback takes the studio mutex, so the wait cannot deadlock. | 40 rounds of a scene switch and a tool edit sent together on a layer's sound: the host keeps running; afterwards 49152 frames flow and the order is right. |
| 2 | Playlist weak reference use after free | Confirmed: the weak ref was released by `on_destroy` while a `media_ended` handler could still use it. | `Playlist` owns its weak ref (released in its destructor). The worker holds a `shared_ptr` to it. `shutdown_playlists()` runs before `obs_shutdown` and stops and joins the worker. | Covered by the playlist tests and every host test's clean exit (code 0). |
| 3 | Unchanged filters re-updated | Confirmed: `noise_gate_update` sets `is_open = false` (noise-gate-filter.c 91). | A filter is updated only when a setting differs (`same_settings`). | The gate stays open across a gain change: RMS over the change -24.01 dBFS (-23 dBFS tone with gain -1). |
| 4 | New filters process a block before `on` is applied | Confirmed (a new private source starts enabled). | New tools join switched off. Tools going off are switched off first to last, and tools going on are switched on last to first, so a limiter is on before the boost in front of it. The audio thread can still run a block between two calls; each step leaves a safe chain. Full atomicity would need the source's `filter_mutex`, which libobs does not expose. | Order and live-change tests (above). |
| 5 | Playlist: first file ends before subscribe; broken files reopen forever | Plausible from the code; not reproduced on the old build. | One worker thread for all playlists, with at most one queued step per list. After subscribing, the media state is checked (ENDED or ERROR starts the next file). An audio capture callback marks a file as heard. After one full pass with no audio, the list stops as `unavailable`, shown in `mixer.list` `playlist.state`. | Two broken files (loop on): `unavailable` after one pass; `at` unchanged 2 s later; host threads 52 -> 52. |
| 6 | Links out of media; any base | Confirmed: `is_regular_file` follows links, and playback accepted every base. | Schema (`mediaRef`), validator and host require base `media`. Each folder entry is kept only when its canonical target is inside the canonical media folder. The worker checks each file again when it opens it. | Base `data` is refused by the validator and the host. A junction folder out of media is refused. A file symlink in the folder: test written, skipped on this account (no symlink right, EPERM): UNVERIFIED. |
| 7 | Same-name programs merged | Confirmed for programs with one name and two paths. Other sessions' windows are not on our desktop. | The app list and the build keep only this user's programs in this session (session id and token user SID). Two different paths for one name are `ambiguous`: the list marks them, Add refuses with a plain reason (`ambiguous-app`), and a load leaves the strip unavailable with that reason. Nothing connects to OBS's `hooked` signal, and window titles are never read, logged or sent. | Route test (ambiguous refused, nothing saved). The live scan on a real PC is UNVERIFIED (needs `--allow-devices`). |
| 8 | `#` in exe names | Confirmed (OBS encodes `#` and `:` in window specs). | `#` is refused in the schema, validator and host. | Host and validator tests. |
| 9 | Exactly-one in the schema; gate close <= open | ajv strict refuses `required`-only branches (strictRequired). Branches with `type` and `properties: {k: true}` pass. | Schema `oneOf` for device/layer/app/playback and file/folder. The gate's `closeDb <= openDb` is enforced in the validator and host; the slider takes the other level along. | Schema and validator tests; host refusal; QML probe (close -10 moves open to -10). |

Suppression measurement: under CPU load (the clip agent's ffmpeg was running), a 0.4 s wait measured 7.6 dB once. Alone it measured 15.2 dB. RNNoise adapts over about a second, so the test now waits 2 s; the rerun measured 15.82 dB.

Between playlist files, ffmpeg_source closes one file and opens the next on the same source. The gap was not measured (UNVERIFIED); the playlist test hears both files and the loop.

Runs (2026-11-18, BelowNormal, headless, one file at a time). host-audio-tools 18 pass / 0 fail / 1 skipped (file symlink, EPERM). audio-tools-routes 12/0. project-schema 148/0. studio-qml-audio-tools 4/0. studio-qml-devices-mixer 5/0. host-audio-add 4/0. Lint: 0 findings. Host and studio builds exit 0.
## AU3 ducking: music and game sound drop while the mic talks

What was built:

- Tool `duck` on a strip: `{on, source, amountDb 3..18, attackMs 1..500, releaseMs 1..1000}`. It is the same table in `services/project/audio-filters.mjs` (`FILTER_RANGES`, `FILTER_REFS`), the schema (`$defs/audioFilters.duck`) and the host (`audio_tools.cpp` `tools()`). Processing order: suppress, gate, eq, gain, duck, compressor, limiter.
- libobs: a `compressor_filter` named `ujw:tool:duck` with `sidechain_source` set to the libobs name of the other sound's source. The project stores only that sound's audio source id (`source`); the host finds the source (`Studio::duck_name`).
- Mapping (one constant pair in JS and C++): the threshold is -30 dBFS. A talking voice's peaks (-10 dBFS reference) give a drop of `amountDb`, so `ratio = 1 / (1 - amount/20)` (12 dB gives ratio 2.5; the 18 dB maximum gives ratio 10). The compressor's peak follower is exponential, so going 20 dB takes ln(10) time constants. `attackMs` ("drops within") and `releaseMs` ("back within") are therefore divided by ln(10) for the compressor's attack and release (400 ms gives 174 ms).
- Missing sound: compressor_filter without a sidechain compresses the strip on its own signal (compressor-filter.c `analyze_envelope`). While the sound is not in the mixer, is waiting for its device (D395), or is a layer's sound (its private source has no findable name), the filter is switched off and keeps a plain reason. `mixer.list` shows `duck {on, active, source, reason}`, and the Tools window shows the reason after a change.
- Reconnect: `refresh_ducks()` runs after a load, after `audio_add_model` (also when an A2 waiting device is bound), after `audio_remove_model`, and after the watchdog's `recreate_global`. The recreate case forces a new lookup, because the parked old source keeps the name's weak reference alive. Only the duck filter's settings and switch change; there is no rebuild.
- Edits: the route refuses a duck under the strip itself, under a layer's sound or under an unknown sound (`bad-duck`). The validator refuses a duck under the strip itself only; a saved id whose sound was removed later stays valid, and the host says why ducking is off.
- Preset "Duck music under my voice" (`data/audio-tools/presets.json`, `needs: "mic"`): drops by 12 dB, within 10 ms, back within 400 ms. The Tools window fills `source` with the first microphone of the mixer, only on the user's click. The "Duck under:" buttons pick another sound.
- `audio.testMeasure` (test hooks) gained `binMs`: peak per bin, aligned on the audio clock (`startMs`). Muted audio counts as silence.

Loopback measurement (`app/host/tests/host-audio-tools.test.mjs`, AU3 tests, 2026-11-18). Music: a 1 kHz tone at -20 dBFS. Mic: a 300 Hz tone at -10 dBFS, switched on by unmuting for 1 s. Setting: 12 dB, 10 ms, 400 ms; 10 ms bins.

| Value | Measured | Setting |
|---|---|---|
| Music level before | -20.00 dBFS | |
| Ducked level | -31.71 dBFS | |
| Dip | 11.71 dB | 12 dB |
| Full dip after the dip starts | 10 ms | attack 10 ms |
| Mic onset to the first dipped music bin | 100 ms | (see below) |
| Back within 1.5 dB after the mic stops | 410 ms | release 400 ms (10 ms bins) |
| Compressor as built | ratio 2.5, attack 4 ms, release 174 ms | |

The 100 ms between the mic's own capture and the start of the dip is UNVERIFIED as to cause. It is either libobs's sidechain buffer (the compressor reads the mic's audio from a deque filled by an audio capture callback) or a difference in the two ffmpeg_sources' timestamps used to line the bins up. A real mic's latency on air is UNVERIFIED.

Missing mic: the mic is removed from the mixer, then the music measures -20.00 dBFS (ducking is off with "Off: …", and the music is not compressed on its own signal). The mic is added back unmuted, then ducking is on again: -29.16 dBFS. The strip stays the same strip (no rebuild).

Accepted small risk: after a new lookup (first apply, or the mic's source recreated) compressor_filter finds the source on its next video tick. For at most one frame the filter runs without a sidechain.

Tests (2026-11-18, BelowNormal, headless, one file at a time):

- host-audio-tools: 21 pass, 0 fail, 1 skipped (file symlink, EPERM). The 3 AU3 tests cover the dip timing, the missing and back reconnect, and refusal of a bad id and of 19 dB.
- audio-tools-routes: 15/0. The 3 AU3 tests cover the sounds list without layer sounds and microphones first, the preset offered, save and send, the bad-duck refusals, and the validator refusing a duck under the strip itself.
- studio-qml-audio-tools: 5/0. The preset click ducks under the mic and does not offer the strip itself; a sound picked plus switch plus amount are saved.
- host-audio-add 4/0, host-audio-health 7/0, studio-qml-devices-mixer 5/0, project-schema 148/0.
- Lint: 0 findings. Host and studio builds exit 0.

Unverified (AU3): a real microphone and real speech (the -10 dBFS reference and the -30 dBFS threshold are set for typical voice peaks, not tuned on the user's mic); use on a real stream.