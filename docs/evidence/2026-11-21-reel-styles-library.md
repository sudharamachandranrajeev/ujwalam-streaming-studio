# Reel styles library RS1-RS4 (D412), 2026-11-21

Plan: `docs/plan/2026-11-21-reel-styles-library.md`. Branch `claude/reel-styles` (not merged, not pushed).
Decision: D412 in `docs/plan/2026-10-29-v1-decisions.md`. Flag `reel-styles`, ON by default (requested feature).

## How it was tested

- The user's studio was open (off air) the whole time. Before each test run, `node tools/live-check.mjs` was run and
  its exit code was checked. No GPU or NVENC render ran. All renders used libopenh264 on the CPU, at BelowNormal
  priority, on tiny synthetic videos (`tests/py/style_fixtures.py`: coloured shots with moving shapes, label boxes,
  joins, zooms, slow motion, colour casts and beat audio).
- Each test file ran on its own, with `UJWALAM_HEADLESS=1` and a temporary `UJWALAM_DATA_ROOT`. Full CI was not run.
  The pre-commit quick checks ran on each commit: build, lint, build-host, build-studio, validate-*, private-scan and
  legacy-verify.
- No example reel, real footage or clips-corpus file was used, read or copied.

## Results per test file

| File | Result | What it shows |
|---|---|---|
| `tests/py/test_style_analyse.py` | 10/10 OK | Known truth: cuts within 1 frame (hard) or 2 frames (gradual), with the kinds exact. Beat share 1.0. Zoom pulses within 0.1 s and 0.02 of scale. Speed ramp within 0.35 s and 0.05 of factor. Text start and length within 0.5 s, band and corner exact, height within 3 % of the label. Colour a/b within 1.5. A quiet single shot gives no cuts, zooms or ramps. Bound: a 60 s 540x960 30 fps H.264 example took 62.98-63.89 s and peaked at 217 MB (limit 150 s, 800 MB); 29 cuts, 10 zoom pulses, 16 texts found. |
| `tests/py/test_reel_style.py` | 19/19 OK | Record rules, mapping, tuning, plan helpers. The job refuses on air, when on-air state is unknown, and while busy. A written record is valid and nothing is copied. `pick` follows the settings and the flag. `create` and tune rules work. CPU renders measured back: zoom 1.150 at 2.0 and 5.0 s (in 0.133 s, out 0.2 s, no cut or flash). Speed ramp keeps 6.0 s with one audio stream: slow part measured at 1.9 s, factor 0.467 (planned 1.85 s, 0.5). Mute works. LUT planned a +4.80 b +8.00, measured a +5.23 b +7.71. "Preview on my clip" is 540 px wide, 6.0 s, one audio stream, with zoom pulses at 1.5 and 4.0 s. |
| `tests/py/test_clip_reel_style.py` | 4/4 OK | RS4. With no style (no settings, flag off, or another type), pieces, look and command line are the very same as before. A chosen style gives: pace (6 s pieces cut into about 1.2 s shots, kills kept), the name style, the music energy, its joins, zooms away from joins, one ramp (none with captions, none forced into short pieces) and the LUT, which is cleaned up afterwards. A rendered reel measures back: 3 of 3 soft joins (2 measured as fade, 1 as flash), zoom planned [1.5, 4.02, 6.54, 9.06] and measured [1.5, 4.017, 6.533, 9.067], LUT b within 2.0 and a within 4.5 (see below), lut3d once, one audio stream. |
| `tests/reel-style-schema.test.mjs` | 3/3 pass | The JSON schema accepts the example record. It refuses zoom entrances of 600 ms or more, exits of 400 ms or more, stored frames or text, a bad sha256 and unknown tune keys. Parts that could not be measured can be null. |
| `tests/user-settings-reel-styles.test.mjs` | 2/2 pass | `clips.reelStyles` checks. It saves type by type, the pool is replaced whole, and a broken value reads as none. |
| `tests/reel-styles-api.test.mjs` | 3/3 pass | The studio side runs the real Python CLI. Create writes only `style.json` (no video copy). A repeated name gets its own id. Missing or relative paths and tuning before analysis are refused. Analyse runs hidden (`windowsHide`, `-I`) and its progress lines reach the task area. It is refused while live, while busy and with the flag off. A failed run shows its reason. |
| `tests/studio-qml-settings.test.mjs` | 21/21 pass (with the rebuilt shell) | The Reel styles card opens with no QML errors. The style per type and "Join the mix" are saved with Save. |
| `tests/flags.test.mjs` | 10/10 pass | `reel-styles` is ON, backed by D412. |
| `tests/studio-ui-flags-feedback.test.mjs` | 16/16 pass | ON list. |
| `tests/registry.test.mjs` | 14/14 pass | `zoom-pulse` and `speed-ramp` functions and their 4 presets. |
| `tests/py/test_clip_montage.py` | 35/35 OK | `render_argv` without zoom or LUT is unchanged. |
| `tests/py/test_reel_transition.py`, `test_reel_transition_sets.py` | 9/9, 14/14 OK | |
| `tests/py/test_clip_pipeline.py`, `test_clip_look.py` (15), `test_music_library.py` (15), `test_clip_live_montage.py` (6), `test_reel_title.py` (15), `test_clip_e2e.py` (7) | all OK | Re-run after RS4: the clipper with no style is unchanged. |
| `tests/user-settings-clip-look.test.mjs` (4), `tests/studio-ui-server.test.mjs` (40), `tests/studio-qml-clips.test.mjs` (6), `tests/studio-qml-shell.test.mjs` (5) | all pass | The shell's list of flags that are ON now also has the D411 flags `reel-transitions`, `reel-music` and `clip-look`. They were already missing before this work, so this test was failing before. |

## Codex review fixes (2026-11-21)

Run one file at a time, `UJWALAM_HEADLESS=1`, temp data folder, BelowNormal, CPU only (studio open, off air per
`tools/live-check.mjs`).

| Test file | Result | What it shows |
|---|---|---|
| `tests/py/test_style_analyse.py` | 15/15 OK | New `GuardTests`: a 5.5 s example is refused as "longer than 3 s" or "larger than 0 MB" with nothing decoded; a stream or recording that starts mid-decode stops it at the next check (frame 20 of 165, check every 10); unknown on-air state stops it too; frame, wall-clock and memory caps; the hash is bounded and stoppable; `run_style` refuses a network path right before opening. The 60 s bound still holds (62.5 s, 218 MB). |
| `tests/py/test_reel_style.py` | 22/23 OK, 1 skipped | New `TestReviewFixes`: the fixture passes the schema and limits; slow motion 0, -1, NaN or 50, zoom in 900 ms, out 450 ms, infinite shot length and NaN contrast are refused, as is an unknown key; a broken record is not loaded or picked and its card says "This style can't be used: ...". Local file check: `\\server`, `\\?\UNC`, `\\.\`, `\\?\C:`, `//server`, relative, missing, folder, removable/network/CD/RAM drive types, and paths through a junction are refused. Symbolic link part skipped (no developer mode). Preview refuses a path inside the style library, replaces the old preview, leaves no LUT and writes nothing into the style. |
| `tests/py/test_clip_reel_style.py` | 5/5 OK | New: a single 8 s live-clip piece is paced, gets the LUT and the zoom, and the canvas render command carries `lut3d` once and `zoompan`; the live review path takes the pieces path when styled. |
| `tests/py/test_clip_live_review_gate.py` (6), `test_reel_hook.py` (21) | all OK | Live review path unchanged otherwise. |
| `tests/reel-styles-api.test.mjs` | 4/4 pass | New: refused while recording (from `outputs.status`); off air it runs on; a stream that starts ends the tree once (the record-clips rule) and the job says why; the preview folder is emptied at start and at close. |
| `tests/reel-style-schema.test.mjs` | 3/3 pass | |
| `tests/studio-qml-settings.test.mjs` | 21/21 pass | Card shows the record's problem. Found while re-running: since RS3 the reel styles instance sat inside the server's `readiness()` function, so the routes and `close()` could not reach it (`reelStyles is not defined`; the test hung on the open poll timer). Moved to the server's own scope. |
| `tests/studio-ui-server.test.mjs` | 40/40 pass | |

## Codex verify fixes (2026-11-21)

| Test file | Result | What it shows |
|---|---|---|
| `tests/py/test_style_analyse.py` | 17 tests: 16 OK in the file run; the 60 s bound took 392 s in two file runs while the PC was busy, then 63.2 s (216 MB) run alone. An A/B of the safe open against a plain open on a 10 s example showed no slowdown (2.0 s vs 1.9 s), so the slow runs are put down to load on the PC (UNVERIFIED cause) | New: a 3000 fps, 1 s mkv (ms clock, repeated times): the guard counts every decoded frame and stops at the cap (481 frames, 240 per probed second + 1) and at the second on-air check (frame 20), though sampling keeps about 30. Only the named demuxer opens: `a.m3u8`, `.txt`, `.ffconcat` refused; an HLS playlist named `.mp4`, an ffconcat list named `.mkv` and a matroska file named `.mp4` are refused, and the playlist's segment file is never created or read. |
| `tests/py/test_clip_reel_style.py` | 6/6 OK | New: crop, fill and canvas variants carry `lut3d=file=style.cube` once; no style = command line as before; the plain-word note per non-canvas layout. |
| `tests/py/test_clip_live_review_gate.py`, `test_reel_hook.py`, `test_music_library.py` plus `test_clip_contain.py`, `test_clip_pipeline.py` | 6, 21, 15, 7, 37: all OK | |

Last two (2026-11-21):

| Test file | Result | What it shows |
|---|---|---|
| `tests/py/test_style_analyse.py` (run alone) | 18/18 OK | New: an 8 s mkv with 16-sample PCM sound frames: `music_library.decode` stops at a 2000-frame cap (frame 2001); the whole analysis passes the video pass and stops in the sound pass at its cap (3601 = 9 s x 400 + 1) with `GuardStop`, not "no usable sound"; an on-air flip after the video pass's 24 checks stops the sound pass at its second check (frame 20); a stalled clock stops a sound decode on wall time. 60 s bound: 65.2 s, 217 MB. |
| `tests/py/test_music_library.py` | 15/15 OK | Callers without a guard unchanged. |
| `tests/record-clips.test.mjs` | 34/34 pass | New: `clipStyles` reads style names and the per-layout notes from `render.json`; none or missing = null. |
| `tests/studio-qml-clips.test.mjs` | 7/7 pass | New: the Clips chip's tip shows "Reel style: Warm" and "Style not applied: v-crop (...)"; the chip text stays "2 new clip(s)"; without styles nothing is added. |
| `tests/studio-ui-server.test.mjs` | 40/40 pass | |

A dref-bearing mov was not crafted; `enable_drefs=0` is passed and asserted (UNVERIFIED against a real dref file).

## Limits (left out or unverified)

- UNVERIFIED on real footage and real example reels: all numbers above come from synthetic videos.
- Speed ramps are marked `unverified: true` in every record: slow motion in real reels (frame blending, optical flow)
  may not read as repeated motion.
- Text: overlays that stay still while the picture moves are left out of the motion fit. On real HUDs this is
  UNVERIFIED. Only band, corner and size are kept, never the words.
- Joins: a cross dissolve, or a fade between shots of very different brightness, can read as a flash.
- LUT on fully saturated colours: gamut clipping moved `a` by up to 3.8 (planned -1.0, measured +2.8). `b`, which
  carried the main shift, was within 2.0. On a mid-saturated clip both are within 1.5 (RS2).
- Preview shows colour and zoom pulses only. Pace, joins and music need a whole reel; the card says so.
- Symbolic links (as opposed to junctions) could not be made on this PC without developer mode; that one check is
  skipped (UNVERIFIED). Junctions and every network or device path form are tested.
- The live-clip wiring is tested on the planning and the render command line; a whole live review run with a style was
  not rendered (UNVERIFIED end to end).
- NVENC renders were not tested, because the studio was open.
