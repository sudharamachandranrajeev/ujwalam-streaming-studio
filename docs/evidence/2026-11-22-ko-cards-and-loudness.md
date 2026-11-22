# 2026-11-22 — K.O. cards (D439) and finished-video loudness (D440)

Status: tests pass; a real render was checked on existing clips (read-only source, outputs in a scratch folder). Not yet used on a real posted video.

## D439 K.O. cards on the long video

The long video's numbered chapter card is gone. Each moment gets an unnumbered card: a word from the data table in `data/clip/long-video.json` `teaching.koCards.words` and an optional detail line. The wording is the agent's proposal (`wordsSource`), and the user has not approved it.

- Styles are registry data: `registry/functions/ko-card.json`, with presets `ko-card-slam`, `ko-card-slash`, `ko-card-glitch`, `ko-card-zoom-punch` and `ko-card-stamp`. Entrances last 360–450 ms (under 600) and exits 250–320 ms (under 400). There is no flash (flashesPerSec 0).
- The style for each card comes from a weighted pick with a seeded RNG (seed = recording name) and no repeat of the last 2. The weights and the tick list live in `data/clip/look.json` group `cards`.
- Settings > Clips has a new "Moment cards on the long video" section. It has a tick per style, and with no tick the cards are off.
- Reels and montages never used the chapter card; only the long video did. They are unchanged.

Tests: `tests/py/test_ko_cards.py` 10 OK (registry, timing limits, seeded pick and no-repeat, wording, Python/Node settings agree, a real ffmpeg burn of all five styles with the flash measure passing). `tests/py/test_long_teaching.py` 36 OK. `tests/py/test_clip_look.py` 17 OK.

## D440 loudness -14 LUFS

Finished reels, montages, recaptioned reels and long videos get one static gain ahead of the existing 4x-oversampled limiter. The limiter guarantees -1 dBTP, and the audio is still encoded once. The gain comes from an audio-only pre-pass (ebur128), refined by at most 3 secant passes. The target is in `data/clip/look.json` (music `loudnessLufs`, default -14, range -24 to -9, null = off), and the tolerance and gain limits are in the `loudness` block with `source: "user 2026-11-22"`. Settings > Clips has an on/off switch and a LUFS value. Every render record gets a `loudness` entry (before, gain, passes, after, ok). If the pre-pass fails, the render goes ahead as before with `status: failed`.

Tests: `tests/py/test_clip_loudness.py` 12 OK. A real two-track synthetic render measured -29.5 LUFS before, gain +20.19 dB, -14.3 LUFS after, true peak -3.3 dBTP.

## Real check (existing clips, read-only)

Script: scratchpad `realcheck.py`, run with `.venv-gpu` python -I at BelowNormal priority, after `live-check: off air`.

| render | before | gain | after | true peak |
|---|---|---|---|---|
| reel, 3 pieces of a V montage | -16.3 LUFS | +2.3 dB | -14.1 LUFS | -2.4 dBTP |
| long batch, 4 moments of an H long video | -32.5 LUFS | +24.52 dB (3 passes) | -14.3 LUFS | -3.0 dBTP |

Long-batch cards: styles slam, zoom-punch, stamp, slam; words K.O., TRIPLE K.O., RAMPAGE (detail "streak · 5 kills"), WON. Stills were looked at: the word sits in the accent box in the caption font, upper middle, clear of the HUD.

## Suites

- The Python clip suites (beatdrop*, clip_*, countdown, ko_cards, long_*, match_reel_rules, montage_music and others) all pass. `test_clip_reel_style.py` had a source-text assertion that was updated for the new `_render_pieces` call (the style still reaches the call).
- Node: `tests/user-settings-clip-look.test.mjs` and `tests/studio-qml-settings.test.mjs` 33/33 pass, after `npm run build:studio`.

## Not covered

- BeatDrop is unchanged: it calls `clip_montage.render_argv` without a gain, so its level is not normalised. Its level was not measured here.
- UNVERIFIED: how the cards and the new level look and sound on a posted video, and whether the K.O. wording suits the channel.
