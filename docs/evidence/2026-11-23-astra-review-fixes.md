# Astra review fixes for the long-video theme work (2026-11-23)

Handover 2026-11-22, "Resume here" step 1. Branch `codex/reel-mix-long-video`. These fixes apply before the
`long-video-themes` flag may be switched on.

## Fixes

1. **K.O. card styles lost in the summary.** `long_teaching.merge_info` dropped each batch's `cardStyles`.
   `render.json` therefore always recorded `[]`, and the WIP test `test_long_theme` failed on it. The batches' styles
   are now joined in video order. `clipper._long_video_steps.overlay_failed` clears `cardStyles` when a batch is
   rendered again without its overlay, because nothing of that batch's overlay is on screen.
2. **Host log bound by the wrong clock.** The installed host names its log `host-<UTC stamp>.log`
   (`app/host/src/main.cpp`, `hlog::utc_now`). `clip_common.log_for_start` and `tools/live-check.mjs logForStart` read
   the stamp as local time, so under summer time (UTC+1) no log was within the 120 s window. The guard then answered
   "unknown", and the clip jobs counted that as on air. Both now read the name as UTC. The process start stays in
   local time, as before.
3. **Limiter delay at batch joins.** `alimiter` without `latency=1` delays the sound by its 20 ms look-ahead and cuts
   the last 20 ms. Measured on an impulse at 0.500 s (ffmpeg n8.1.3, 48 kHz):
   `latency=0` -> pulse at 0.520 s; `latency=1` -> pulse at 0.500 s, with the same length both times. Each long-video
   batch therefore had a 20 ms gap at its join and a 20 ms sound lag. The one limiter chain in
   `clip_montage.render_argv` now has `latency=1`. This also moves every reel's and montage's limited track 20 ms
   earlier, which is now in sync with the picture.
4. **Graded picture not 4:2:0.** `lut3d` and `colorbalance` work in RGB. The graded output went to the encoder
   without a format, so it could be encoded 4:4:4. The post chain now ends with `format=yuv420p`. This covers the
   theme grade and the existing LUT path.
5. **Two long renders in one run folder.** `_long_video` cleared every `attempt-*` folder in the run's `long/`
   folder. A second render would remove the first render's soundtrack and parts. Each long render now holds an
   OS lock on that folder (`HeavyJobLock(out, job="long video")`, the same kernel-freed lock as the heavy jobs). A
   second render returns `failed` ("another long video render is using this run folder") and does not write
   `long.json`, because the running render owns it.

## Tests

- `python -I -m unittest discover -s tests/py -t tests/py -p "test_long_*.py"` -> `Ran 80 tests ... OK`. New:
  `AstraReview.test_card_styles_merge_in_video_order_and_a_dropped_overlay_has_none` and
  `test_a_second_long_render_leaves_the_running_one_alone`. The theme test also checks
  `colorbalance=...:pl=1,format=yuv420p[` and `:latency=1,` in every batch.
- `python -I -m unittest discover -s tests/py -t tests/py -p "test_clip_frame_reader.py"` -> `Ran 40 tests ... OK`.
  The on-air tests now build their start times from UTC and include a July (summer time) case.
- `node --test tests/live-check.test.mjs` -> 5 pass, 0 fail, including a summer-time case.

## Real two-batch render (2026-11-24, handover step 2)

Setup: a synthetic 100 s recording made in the session scratchpad (`testsrc2` 1280x720 60 fps; track 1 a 440 Hz tone
at -18 dB, track 2 pink noise), hits at 20, 50 and 80 s, flags `long-highlights-video` and `long-video-themes` on.
Only `lv.load_config` was patched (minSec 2, maxSec 60, batchPieces 2), as in `test_long_theme`. The render ran
through `clipper.main([... "long" ...])` with `h264_nvenc`, off air. The result was 3 moments in 2 batches. The join
is at 12.8 s. The second batch's music starts at offset 12.8 s.

6. **New finding: AAC encoder delay at every batch join.** The first real render showed track 1 near silent
   (-55 to -93 dBFS, 1 ms windows) from 12.820 to 12.842 s. The second batch's sound then started abruptly at
   -24.7 dBFS. Audio was 19.349 s against 19.336 s of picture. The cause is that each part was encoded to AAC and
   the join copied the streams, so each part's 1024-sample encoder delay (21.3 ms) stayed in. A 2 x 2 s check
   confirmed it: AAC parts joined by copy gave 4.053 s of sound and a quiet gap at 2.026 to 2.047 s, while PCM parts
   joined with one AAC encode gave no gap. On a real long video (about 10 batches) the sound would drift about
   0.2 s behind the picture by the end.
   **Fix:** `long_video.PART_AUDIO` makes the parts carry 24-bit PCM. `concat_argv` copies the picture and encodes the
   sound once (`rnd.AUDIO`). This matches the "audio encoded once" rule.

After the fix (same render):

- `ffprobe`: h264 **Main**, **yuv420p**; two AAC LC stereo tracks; picture and both tracks are 19.300 s.
- Track 1, 1 ms windows below -50 dBFS mid-file: 1, at 12.799 s. This is where the two batches' designed 80 ms
  fades cross, with no dead gap. Track 2 dips only at the start fade, a crossfade midpoint (6.41 s), the batch fades
  around 12.8 s, and the end fade.
- Loudness of track 1 (`ebur128=peak=true`): **I -14.0 LUFS**, peak -7.4 dBFS. `render.json` loudness `after`
  `{lufs -14.0, truePeak -7.4, ok}`. Music bed: generated here, `bedGainDb -18.8`, `mixTargetLufs -51.8`.
- `render.json` `cardStyles`: `["zoom-punch", "glitch", "slash"]` (fix 1 working end to end).
- `python -I -m unittest discover -s tests/py -t tests/py -p "test_long_*.py"` -> 80 OK; `test_ko_cards.py` -> 10 OK.
  `test_long_video.Render.test_batches_then_join_with_one_audio_encode` now checks PCM parts and one AAC encode at
  the join.
- Other suites run on the fixes (before the PCM change): `test_clip_loudness` 12 OK, `test_music_*` 57 OK
  (1 skipped), `test_reel_music` 13 OK, `test_reel_transition_sets` 14 OK, `test_clip_montage` 35 OK,
  `test_beatdrop` 46 OK (1 skipped, 686 s).

## UNVERIFIED / open

- Batch joins are still a hard cut with an 80 ms fade out and in. Inside a batch, the theme's slide transition joins
  the moments. Whether batch joins should also slide is a design question for the long video and is not changed here.
- Synthetic sound only. A real stream recording has not been rendered with the theme.
- A Codex second-opinion review of these fixes has not been run yet.
