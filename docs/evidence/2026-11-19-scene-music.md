# MU2 scene music: per-scene mood, Music strip, fade with the transition, ducking (2026-11-19)

Plan `docs/plan/2026-11-18-audio-mixer-music.md` row MU2. Branch `feat/scene-music` from `claude/alpha0-d1` (merged up to
222e8fb: AU1-AU3 with three Codex rounds, D400). Off air (`tools/live-check.mjs`: off air before every build and test).
Tests one file at a time at BelowNormal priority, `UJWALAM_HEADLESS=1`. No device opened, nothing went live, no model
loaded. The beds used by the tests are generated tones, not the MU1 library; the real moods are still `proposed`
until the user listens (D393).

## What was built

- Project: `scenes[].music = {on, mood, volumeDb}` (mood = an id of `data/music/moods`, volumeDb -40..0, absent = off),
  and one Music strip: `audio.sources[] { music: {} }` (at most one per project). Schema, validator
  (`services/project/scene-music.mjs` `sceneMusicProblems`) and host check the same rules.
- Library: `<data dir>/music/<mood>.wav`, made off air by the MU1 CLI (`services/clip/scene_music.py --out <data dir>/music`).
  The studio start passes it to the host as base `music` (host-only, never a project pathRef base), also before it
  exists. Nothing is generated on the live path. A missing bed plays nothing and says why in plain words
  ("The music for "brb" is not made yet. Make the music library off air, then it plays.").
- Host (`app/host/src/scene_music.{h,cpp}`): the Music strip is an `ffmpeg_source` built like an AU1 playback sound, so
  the AU2/AU3 tools (Tools button, "Duck music under my voice") work on it unchanged. One level filter
  `ujw_music_level` ("ujw:music:level") is added after the tools in the filter array, so libobs runs it first: the
  fade and the scene level come before the duck and the limiter. It is added on the graphics thread (D399). It ramps
  its gain sample by sample; the music thread only stores `{to, ms, seq}` in atomics (no settings update, no filter list
  change, no rebuild). All fades run on one music thread; scene switches only queue a cue (nothing blocks the video or
  RPC thread).
- Scene switch (main canvas only): fade out until the scene changes, fade in after it. Fade and D391 types: half the
  duration each; stinger: its switch point each way; cut or zero duration: 25 ms + 25 ms. The same bed in the next
  scene keeps playing; only its level moves. One strip is one source, so a change of bed is out-then-in, not an overlap.
- RPC: `music.setScene {scene, music|null}`, `music.status`, `music.testWaitIdle` (test hooks).
- UI server (`services/studio-ui/music-routes.mjs`): `GET /ui/api/music`; `POST {op:'scene'}` saves a scene's music
  (host first, then the file; undo on a failed save). The first time music goes on, one Music strip is added on the
  first track with "Duck music under my voice" (12 dB, 10 ms, 400 ms) under the first microphone, if the mixer has one
  (the user's click is the trigger, D332). `POST {op:'preview'}` asks the host (`music.preview`), which plays a made bed through a
  private ffmpeg_source in no track, on the monitoring device only. An on-air gate (`scene_music::hold`) covers
  it: every sink holds the gate from the moment it is wanted until it is not (starting, connecting, live, retry waits;
  `set_want` in outputs.cpp), and replay buffer and NVENC probe starts hold it while they start. Taking the gate
  silences the preview at once (its own level filter to 0, an atomic store) and hands the source to retirement; the
  stop and release run later outside the gate. A preview is opened outside the gate at level 0 and only switched up
  when no hold and no active output exist. So an output start never waits on file or device work. One preview at a time; the UI server stops it on close, the host on
  shutdown. (Codex review 2026-11-19 replaced the first SoundPlayer version.)
- QML: scene menu "Music…" opens `SceneMusicWindow.qml`: a "Music in this scene" switch with its plain-word line, mood
  buttons (with "(not made yet)"), a level slider (greyed while off), Listen / Stop listening (disabled on air), and a
  fixed-height status line. The default mood when first opened follows the scene name (start/soon -> starting-soon,
  brb -> brb, end/outro -> ending, match/game -> in-match, else lobby). No flag: per-scene music is off until switched on.

## Codex review fixes (2026-11-19)

- Ramp command is one 64-bit atomic {seq 16, ms 16, to float}: the audio thread never pairs an old seq with a new target.
- A `media` mutex is held across every call into the strip's source; detach takes it first; each media call and each
  ramp publication is refused when its cue is replaced (`pending`) or the strip retired (`gen`). Shutdown join runs
  inside the obs_runtime shutdown guard.
- Lost host reply: the UI server reads `music.status` back; applied means saved, not undone. A save that throws after
  the file is in place is read back and kept.
- Removing the strip (the UI server's rollback of an add) restores every scene's music from that document
  (`music_from_doc`).
- Round 2: the gate above replaced "preview_stop before obs_output_start" (a gap between them, and file work under the
  lock outputs wait on). After a rollback the UI server reads `music.status` back; when the host does not match the
  file it answers `live-differs` ("What plays now differs from the saved project ... Restart Ujwalam ...").

## Measured (host test, `app/host/tests/host-scene-music.test.mjs`, 2026-11-19)

Beds: lobby = 1 kHz at -20 dBFS peak, in-match = 440 Hz at -30 dBFS peak (8 s WAVs, loop). `audio.testMeasure` after the
strip's filters, 10 ms bins.

| Case | Measured | Setting |
|---|---|---|
| Lobby bed level | peak -20.00 dBFS, RMS -23.01 | 0 dB scene level |
| Fade 1000 ms, lobby -> in-match | out 470 ms, in 480 ms, total 950 ms; -20 -> -30 dBFS | 500 + 500 ms |
| Smoothness (fade 1000) | largest 10 ms step above -35 dBFS: 0.86 dB | sample-by-sample ramp |
| Same mood, next scene -6 dB (fade 600) | -20 -> -26 dBFS, lowest bin -26.00 (no dip, no restart) | |
| Cut, chat (-26) -> in-match (-30) | 100 ms from the first drop to the new level, 50 ms of it silent (5 bins) | 25 + 25 ms fade |
| Music off / no music field / missing bed | peak below -90 dBFS; plain reason in `music.status` | |
| Live level change (music.setScene -12 dB) | peak -32 dBFS | 300 ms ramp |
| Duck under the mic on the Music strip | -20.00 -> -31.71 dBFS, dip 11.71 dB | 12 dB, 10 / 400 ms |
| Switch storm: 12 switches 60 ms apart, fade 400 | largest step 0.80 dB (run 2; 1.19 run 1); ends on in-match at -30 dBFS | last cue wins |
| Listen, then record.start | preview stopped by the start; refused (-32009) while recording; plays again after | off air only |
| Listen racing record.start, 8 rounds | never playing while recording | gate |
| record.start while a Listen open is delayed 1500 ms (test hook) | started in 60 ms; the slow Listen refused | no file work under the gate |
| Rolled-back strip add | every scene's music equals the document again | music_from_doc |

Notes:
- First draft used a libobs `gain_filter` updated every 5 ms. Measured: ffmpeg_source hands audio over in blocks of about
  85 ms and a filter applies one gain per block, so the fade was a staircase of 1.8 to 5 dB steps. The host level filter
  replaced it; the step check (< 1.5 dB per 10 ms above -35 dBFS) is in the test.
- The cut: the 50 ms of silence is ffmpeg_source closing one file and opening the next (the fade itself is 25 + 25 ms).
  Whether that is audible as a gap on real music is UNVERIFIED (nobody listened).
- The duck's dip equals AU3's (11.71 dB): the level filter runs before the duck, so the scene level does not change the
  duck's threshold position relative to the voice.

## Tests (2026-11-19, BelowNormal, headless, one file at a time)

| File | Result |
|---|---|
| `app/host/tests/host-scene-music.test.mjs` (new) | 12 pass, 0 fail |
| `tests/scene-music-routes.test.mjs` (new) | 10 pass, 0 fail |
| `tests/studio-qml-scene-music.test.mjs` (new) | 3 pass, 0 fail |
| `tests/project-schema.test.mjs` | 148/0 |
| `tests/audio-tools-routes.test.mjs` | 15/0 |
| `app/host/tests/host-audio-add.test.mjs` | 4/0 |
| `app/host/tests/host-audio-tools.test.mjs` | 26 pass, 0 fail, 1 skipped (file symlink, EPERM) |
| `tests/studio-qml-audio-tools.test.mjs` | 5/0 |
| `tests/studio-qml-devices-mixer.test.mjs` | 5/0 |
| `npm run lint` | 0 findings |

Builds: `node app/host/tools/build.mjs`, `node app/studio/tools/build.mjs` (both exit 0). Not run: the full `npm run ci`.

## Unverified

- The MU1 beds through this path (the tests use tones), the moods' sound (D393: `proposed` until the user listens), and
  the loudness on air with the real library (-20 / -23 / -24 / -30 LUFS targets from MU1).
- The 50 ms gap on a cut and the out-then-in change of bed on real music; a true overlap crossfade would need two
  sources mixed into one strip (not built).
- The stinger mapping (out and in = its switch point) on a real stinger.
- Listen on a real monitoring device: the tests run without devices, so nobody has heard it. Whether a private
  ffmpeg_source in no scene feeds the monitor is also unproven. It plays at the bed's own level, not the scene level.
  A desktop-audio capture of the monitoring device is harmless: Listen never plays while an output is active.
- A real microphone for the duck, and use on a real stream.
