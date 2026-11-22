# RR1: Top 5 countdown reel (2026-11-22)

Status: built and tested on synthetic clips. Not yet made from the user's own clips. Decision: D424. Flag:
`countdown-reel` (on by default, user-requested).

## Built

- `services/clip/countdown.py` (new):
  - `check` (overlay timing rule, colours, card long enough for its entrance and exit between joins, item counts).
  - Items: `pick_items` (the best rendered vertical live clips and impact plays across `clips/runs`, by score, then
    kills, then the newest run; one entry per file; missing files, H files, montages and its own output skipped),
    `user_items` (a JSON list, #1 first), `display_name`, `clean_name` (no ASS override characters).
  - `combined_music`: the reel's music record from its entries' records (D414; fail closed).
  - `timeline` (card, clip, card, clip ... with the join overlap), `card_events` / `to_ass` (the `#N` pop in the
    rank's colour, the name letters moving in from seeded scattered places and turning upright in 500 ms, everything
    fading out in 250 ms, never during the card's incoming join), `prepare` / `cleanup` (ASS and bundled fonts).
  - `render_argv`: one ffmpeg run; each clip is one input (its first frame, blurred and darkened, is the card still);
    `xfade` slides and `acrossfade` between every part; silence for the cards and silent clips; the text burned last.
  - `make`: off air only, inside the heavy-job lock; stopped and cleaned up when a stream starts; the flash check
    (`tools/fx-test.mjs`, as BeatDrop); only a passing file becomes `countdown.mp4`.
- `services/clip/clipper.py`: `clipper countdown --out DIR [--items LIST] [--publish CLIPS]` writes
  `DIR/clips/R1/countdown.mp4` and `DIR/render.json` (tool `clipper.countdown`, the entries, the music record),
  validates and publishes.
- `services/clip/clip_publish.py` / `clip_names.py`: kind `countdown`, label `top-N`.
- Data: `data/clip/countdown.json`; flag `countdown-reel` in `data/flags.json`.

## Tests

`tests/py/test_countdown.py`: config check, names, item pick across runs (order, skips, unreadable files), the
user's list, the combined music record, timeline starts and caps, card events (colour, timing, letters inside the
frame, seeded), the ASS file, the ffmpeg graph; real renders (108x192, three synthetic clips, one silent): length,
audio, size, working files removed, flash over the limit not kept, a stream starting during the render stops it.

## Results (2026-11-22, project venv `.venv-gpu`, `UJWALAM_HEADLESS=1`, temp data root)

```
python -I -m unittest discover -s tests/py -t tests/py -p test_countdown.py         Ran 28 tests  OK
python -I -m unittest discover -s tests/py -t tests/py -p test_clip_output_layout.py Ran 18 tests  OK
python -I -m unittest discover -s tests/py -t tests/py -p test_beatdrop_publish.py   Ran 8 tests   OK
python -I -m unittest discover -s tests/py -t tests/py -p test_clip_pipeline.py      Ran 37 tests  OK
```

CI's plain Python (no Pillow): `test_countdown.py` Ran 28, OK (skipped=3; the renders skip).

A full-size render (1080x1920, three synthetic 3 s clips): `done`, 12.7 s. Frames looked at: the #3 card at 1.0 s
(blurred, darkened still, cyan `#3`, "Double Kill" assembled and evenly spaced) and at 0.25 s (letters still moving
in), and the clip at 6.5 s (full picture, no card text). The first full-size render showed the name letters spread
apart: the widths were measured on the font's em, while libass sizes a font by its ascent plus descent; fixed.
The first real render also showed the ffmpeg on this machine is a build without `eq` and `boxblur` (GPL filters); the card uses
`gblur` and `lutyuv`.

## Codex review (read-only, medium effort)

- Round 1 (4 findings, all fixed): an NCS record only on the first entry no longer credits the whole reel (credited
  only when every entry has the identical record); the raw `made-here` record is written, not the normalised name;
  short sound is padded so every join stays on time; a second run into the same `--out` is refused.
- Round 2 (2 findings, both fixed): the output folder is reserved atomically, so two runs at once cannot share it;
  a clip's sound keeps its start against its picture.
- Round 3 (1 finding, fixed): the sound offset is measured from the streams' start times (`adelay` or a head cut).
- Round 4 (1 finding, fixed): a clip's length is its picture stream's, never the container's.
- Round 5 (1 finding, fixed): a Matroska picture stream's own `DURATION` tag is used before the container's.
- Round 6 (1 finding, fixed): that tag is the track's end time, so the picture's start is taken off it (checked
  on a real ffmpeg Matroska file whose picture runs 2 s to 5 s: 3 s).
- Round 7: clean.

## UNVERIFIED

- The look on the user's own clips; whether score then kills picks the clips the user would pick.
- Not built: a studio button or job (CLI only), auto-posting (posting's name patterns do not include `countdown`),
  the loadout pop-in, the face-cam part and the notes box of reference 2.
