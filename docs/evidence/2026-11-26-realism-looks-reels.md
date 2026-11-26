# 2026-11-26 RL4 realism looks on reels: evidence

Plan: `docs/plan/2026-11-25-realism-looks.md`, row RL4 (D445). Branch `codex/reel-mix-long-video`.

## What was built

- `services/clip/clip_realism.py` maps a look from `data/looks/*.json` to one ffmpeg filter fragment. The look JSON is
  the only source of the amounts:
  - LUT: `lut3d` on a cube mixed with the identity by the look's amount (written per render, removed after).
  - bloom: split, half-size luma threshold (`lutrgb`), `gblur`, screen `blend` at opacity min(1, 2 x amount).
  - clarity: `unsharp` on luma, matrix = size % of the shorter side, odd, 3..13 (ffmpeg allows lx + ly <= 25).
  - sharpen: `cas` on luma only (on chroma it moved flat colours by 1 to 3/255).
  - chromatic: `rgbashift`, amount x 0.5 % of the shorter side.
  - vignette: `vignette`, angle matched to the host shader's corner value (test checks it).
  - grain: `noise` on luma with a fixed seed, temporal, amplitude amount x 64, last so it is never sharpened.
  - A light clean-up (`atadenoise`, 5 frames, low thresholds) runs first.
- The clipper picks a look per reel type (reel, impact, montage): off, one look, or a seeded random pick from the ticked
  looks (`clip_look._rng`, same reel = same look). The clip row gets `realism` (id, name, steps, seed).
- When a realism look is used, the reel style's LUT is not applied: the look replaces the style's colour, never both.
  The style's pace, joins and zooms stay. BeatDrop and the long video are not covered (not in RL4).
- Settings: `clips.realismLooks.byType.<type> = {mode, look, ticks}`, checked the same way in Node and Python.
  `GET /ui/api/settings` returns the looks and the types.
- Studio: Settings > Clips > Clip look > Realism look. One choice per reel type (Off, Random from the looks I tick,
  or a look by name). Random shows one switch per look. The hint says the look replaces the reel style's colour.
  Default is Off for every type (the user picks a look; nothing changes on existing reels).

## Measurements (synthetic clip, never the user's corpus)

Source: 1080x1920, 30 fps, 10 s. It has five bars of the swatch reference colours, a moving `testsrc2` and a 440 Hz
tone. It was rendered through `clip_montage.render_argv` (2 pieces, libopenh264, the worker's encoder settings) at
BelowNormal priority on the laptop. Script: scratch `rl4/measure.py`.

| Look | Render s per min of reel | Added vs none | Flashes/s | Audio streams | Audio same as plain | Colour min cos | Size ratio range |
|---|---|---|---|---|---|---|---|
| none | 9.7 | - | - | 1 | - | - | - |
| filmic | 67.7 | 58.0 | 0.0 | 1 | yes | 0.931 | 0.62 to 1.43 |
| cinematic | 86.6 | 77.0 | 0.0 | 1 | yes | 0.940 | 0.95 to 1.21 |
| cold-high-key | 61.4 | 51.7 | 0.0 | 1 | yes | 0.999 | 0.88 to 1.02 |
| dark-cinematic | 106.7 | 97.0 | 0.0 | 1 | yes | 0.990 | 0.98 to 1.06 |
| gritty-war | 85.8 | 76.1 | 0.0 | 1 | yes | 0.986 | 0.98 to 1.11 |
| hdr-vivid | 55.6 | 45.9 | 0.0 | 1 | yes | 0.986 | 0.90 to 1.07 |
| night-neon | 83.8 | 74.1 | 0.0 | 1 | yes | 0.995 | 0.94 to 1.08 |

- Colour direction compares the colour part of each look (LUT, sharpen and clarity on; vignette, bloom, grain and
  chromatic off) against the same pipeline at LUT amount 0. For each bar, the measured RGB shift is compared with the
  swatch shift (look swatch minus reference). "cos" is the direction match (1 = same direction). "size ratio" is the
  measured size over the swatch size. Bars whose swatch shift is under 4/255 are skipped (4 bars for cinematic and
  hdr-vivid). The test bar is cos > 0.8 and 0.4 to 2 x size.
- Flash rate: `flashes_per_second` from `tests/py/test_reel_transition_sets.py` on every frame, limit 3/s.
- Audio: the md5 of the decoded audio equals the plain render's for every look.
- Render cost: a realism look adds about 46 to 97 s of CPU time per minute of reel (6 to 11 x the plain render).
  A profile of cinematic over 10 s: clean-up 0.1 s, RGB round trip 0.3 s, LUT 1.5 s, full look 6.8 s. Bloom (blur on a
  half-size frame) and clarity are the main cost. Reels are made after the stream, so the live stream is not affected.

## Tests

- `tests/py/test_clip_realism.py` (13 tests): settings problems, effective settings, seeded pick (same seed = same
  look, every ticked look reachable), filter-string goldens, vignette against the host shader, mixed LUT, montage graph
  order, and a render test at 270x480 (flash, audio, colour direction for every look). Result: OK.
- Related Python tests: `test_clip_montage` (36 OK), `test_clip_reel_style` (6 OK, a source-text check updated for the
  new `realism=rl` argument), `test_beatdrop` (46 OK, 1 skipped), `test_clip_output_layout` (18 OK).
- `tests/user-settings-realism-looks.test.mjs` (3 tests) with `tests/user-settings-reel-styles.test.mjs`: 5 pass.
- `tests/studio-qml-settings.test.mjs`, new probe "Realism look is off for every reel type ...". All "Settings > Clips"
  probes: 12 pass, after `npm run build:studio`.

## UNVERIFIED

- The look on a real reel from a real stream (only synthetic footage measured).
- The look on the vertical Live clip path with a non-canvas layout (code path shared, not rendered here).
- Render time on a GPU encoder (measured with libopenh264 on the CPU only).
