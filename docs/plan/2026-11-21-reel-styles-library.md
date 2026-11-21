# Reel styles library: styles learned from example videos (plan, 2026-11-21)

Status: user idea 2026-11-20, answered by interview (memory reel-style-and-long-video). Queued after the clip look
(FX1-FX4, merged `faacc09`, D411); it reuses the look pools, name styles, transition sets and music matching from
there. Phases RS1-RS4. User-requested, so ON by default (flag `reel-styles`).

## 1. The user's choices (2026-11-20)

- A "Reel styles" library in Settings > Clips. The user adds example videos; Ujwalam analyses each set into a named
  style and applies it to reels, impact plays and montages.
- Copy all of: cuts and pacing (beat cuts, speed ramps), transitions and zooms, text and captions, colour (LUT) and
  music energy.
- Rebuilt from Ujwalam's own effects (closest match, tunable), never pixel copies. Examples are analysed only, never
  posted, never committed, never uploaded.
- Preview on one of the user's own clips; pick a style per reel type.

## 2. Hard limits (unchanged)

Flash <= 3/s per canvas; overlay entrances < 600 ms, exits < 400 ms; audio encoded once; the final true-peak limiter
from D411 stays; no network; no installs. The shipped runtime already has PyAV, numpy, OpenCV (headless) and RapidOCR
(`services/clip/requirements-bundle.lock.txt`). Examples stay local: their path is stored, nothing is copied into the
repo; the analysis (numbers only, no frames) goes to `<data>/clips/styles/<id>/style.json`.

## 3. Phases

### RS1 Analyser (`services/clip/style_analyse.py`, off air only, BelowNormal, one job at a time)
Per example video, then merged per style (median over examples, with spread):
- Cuts and pacing: shot boundaries from frame-histogram distance (OpenCV), shot length distribution, cut rate,
  share of cuts on a music beat (beats from `music_library` analysis of the example's own audio).
- Speed ramps: frame-motion magnitude (optical flow, low resolution) versus time; a ramp = a sustained step in
  apparent speed around a cut. Marked UNVERIFIED until checked on the user's examples.
- Zooms and shake: global scale and offset between frames (OpenCV feature match + affine fit at low resolution);
  zoom pulses (size, duration, how often), shake amplitude.
- Transitions: classify each cut as hard, cross-fade, flash (luminance spike), whip (directional blur) from the frames
  around it; map to the nearest D411 transition set and weights.
- Text and captions: RapidOCR on sampled frames: text boxes' position band, size relative to frame height, how long
  each stays, entrance timing; maps to a name style (kinetic / corner tag / lower third) and caption placement.
- Colour: per-shot Lab statistics; a 17^3 `.cube` LUT fitted by matching the example's colour distribution against a
  neutral reference (the user's own clip statistics), strength capped so skin and HUD stay readable.
- Music energy: `music_library.analyse` on the example's audio -> energy and mood targets for the music match.
- Anything the analyser cannot measure reliably is left out of the style with a reason, never guessed.

### RS2 Style record and mapping
`style.json` v1: `{name, examples: [{path, sha256, seconds}], cuts, ramps, zooms, transitions, text, colour{lut file,
strength}, music, measured: {...}, version}`. Mapped onto the D411 look parameters (`data/clip/look.json`) plus two new
core functions, each with manifest, at least one preset and similar tags (AGENTS.md, registry-add): `zoom-pulse`
(scale keyframes on beats / kills) and `speed-ramp` (setpts ramp around a moment, audio kept in sync or muted for the
ramp, encoded once). Every mapped value is tunable afterwards.

### RS3 Settings > Clips > Reel styles
Add examples (file picker, path only), name the style, "Analyse" (off air, shows progress in the task area), the
measured numbers in plain words ("cuts every 1.2 s, 70 % on the beat, warm colour, zoom pulse on kills"), sliders to
tune each part, "Preview on my clip" (a short CPU render of one of the user's clips), and a style per reel type
(reel, impact play, montage). Save / Discard, no typed confirms, no layout jumps. Styles can be part of the D411
randomise-from-ticks pool.

### RS4 Render integration
`clip_look` takes the chosen style for the reel type and builds the plan: shot pacing and beat cuts, transitions,
zoom pulses, speed ramps, name and caption placement, LUT (`lut3d`, once in the filter graph), music energy target.
Live clips, montages and the long video keep working when no style is chosen.

## 4. Done when (evidence in docs/evidence/)

| Phase | Done when |
|---|---|
| RS1 | synthetic fixtures with known cuts, flashes, zooms, text and colour cast are measured within stated tolerances; a 60 s example analyses within a stated time and memory bound on CPU |
| RS2 | style.json validated by schema; mapping tests; zoom-pulse and speed-ramp in the registry with presets; flash and timing limits hold |
| RS3 | settings round trip; QML tests; preview render on a fixture |
| RS4 | a reel rendered with a style measures back close to that style (cut rate, transition mix, LUT colour shift) on fixtures; real-footage check needs the user's examples |

## 5. Needs the user

- Example videos for the first real style (asked at phase start, per AGENTS.md): 3-5 short reels per style, 15-60 s
  each, of the look the user wants. Local only; the analyser never copies or posts them. RS1-RS2 are built and tested
  on synthetic fixtures until they arrive.
