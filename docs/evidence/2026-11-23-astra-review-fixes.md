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

## UNVERIFIED

- A real two-batch themed render (separate output tracks, nonzero music offset, decoded seam audio, pixel format,
  loudness) has not been run yet. It is handover step 2.
- A Codex second-opinion review of these fixes has not been run yet.
