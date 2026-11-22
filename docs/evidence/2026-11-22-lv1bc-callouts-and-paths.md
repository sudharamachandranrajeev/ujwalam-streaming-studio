# LV1b/LV1c: kill feed callouts and movement paths on the long highlights video (2026-11-22)

Status: built and tested on synthetic data. Not yet seen on a real long video. Decisions: D422 (callouts), D423
(paths). Flag: `long-video-teaching` (on by default, user-requested), with `teaching.callouts.on` and
`teaching.paths.on`.

## Built

- `services/clip/long_video.py`: each moment and merged segment keeps its medal times (`medals`) and each moment's last kill
  (`lastKills`), recording seconds. `render(overlay=)` now takes `{"ass", "fontsdir", "fx"}` per batch; a batch whose
  overlay fails is rendered again with none of it.
- `services/clip/long_teaching.py`:
  - Callouts (LV1b): `callout_box` (the game pack's detector region named in `teaching.callouts`, verified regions
    only), `frame_box` (game-area fractions to long video frame fractions through the detect pass's layout and the
    fit-and-pad), `callout_windows` (a little after each medal, never over a cross fade, never two at once),
    `callout_fx` (crop, enlarge, accent border, darker halo, `overlay` enabled in the windows), `batch_callouts`.
  - Paths (LV1c): `batch_overlay` adds the path styles and events to the batch's ASS; a path failure leaves the rest.
  - `check` refuses bad callout and path settings; `merge_info` counts callouts and paths; `context` takes the game
    pack, the detect layout, the recording size and the game id.
- `services/clip/long_paths.py` (new): the enemy name tag (red, game data) found per frame (`tag_points`, letters
  joined, size and shape limits, HUD and outside-the-game masked), followed back from the kill (`track`: nearest the
  crosshair at the kill, nearest the last position before it, ends when lost), `confident` (enough points, moved far
  enough), `smooth`, `to_frame`, `path_events` (drawn on in steps, a dot at the head, held, faded out in 300 ms),
  `decode`, `batch_paths` (the last kill of each moment, `trackSec` before it, inside the moment's alone-on-screen
  part).
- `services/clip/clipper.py` `_long_video_steps`: passes the game pack, the detect summary's layout and game, and the
  recording size; callout and path counts in `render.json` and `long.json`.
- Data: `data/clip/long-video.json` `teaching.callouts` and `teaching.paths`; `data/games/codm/moments.json`
  `enemyTag` (status unverified); `data/schemas/moments.schema.json` `enemyTag`.

## Tests

- `tests/py/test_long_teaching.py`: callout box from verified regions only, `frame_box` (full frame, canvas, 4:3
  pillarbox, visible clip), windows from medals (cross fades, overlap, too short), the fx string (even crop, scale,
  colours, safe area), bad settings refused, `batch_callouts`, `merge_info`, context; the overlay retry drops the
  callouts too; a real ffmpeg run of the callout graph (the accent border shows only inside its window).
- `tests/py/test_long_paths.py` (new): spec is game data and a game id is never a path, letters join into one tag,
  big or blue areas are not tags, tracking back from the kill with a second tag present, no tag at the crosshair, lost
  too long, a jump to another tag, HUD and outside-the-game masked, confidence, smoothing and frame mapping, draw-on
  events, `batch_paths` with a fake decode, the overlay carries the paths and survives a decode failure, context; a
  real libass burn (the drawn path grows with time).

## Results (2026-11-22, project venv `.venv-gpu`, `UJWALAM_HEADLESS=1`, temp data root)

```
python -I -m unittest discover -s tests/py -t tests/py -p test_long_paths.py      Ran 16 tests  OK
python -I -m unittest discover -s tests/py -t tests/py -p test_long_teaching.py   Ran 35 tests  OK
python -I -m unittest discover -s tests/py -t tests/py -p test_long_video.py      Ran 23 tests  OK
python -I -m unittest discover -s tests/py -t tests/py -p test_reel_captions.py   Ran 14 tests  OK (skipped=2)
python -I -m unittest discover -s tests/py -t tests/py -p test_clip_pipeline.py   Ran 37 tests  OK
```

CI's plain Python (no numpy or OpenCV): `test_long_*.py` Ran 74, OK (skipped=11; the tracking tests skip).

## Codex review (read-only, medium effort)

- Round 1 (7 findings, all fixed): path times counted from the decode start, a kill in the cross fade out tracked
  up to the kill, merged moments keep each path, the crosshair at the game area's centre (not the recording's), a
  summary that cannot be read never stops the video, geometry errors caught in `context`, the card kept inside the
  safe margins.
- Round 2 (4 findings, all fixed): the crosshair from the whole game rect (not its visible part), separate moments'
  paths kept (the free-window rule in `path_kills`), `_gate_pack` also catches `OSError`, a callout counted only when
  its graph is built.
- Round 3 (2 findings, both fixed): each merged moment keeps its own last kill (`lastKills`), so an earlier kill of
  the same moment never takes its path; a detect summary whose top level is not an object is ignored.
- Round 4 (1 finding, fixed): a detect summary layout that is not an object counts as none.
- Round 5 (1 finding, fixed): a detect summary game that is not a string (a list) no longer stops the long video
  in `_gate_pack`.
- Round 6: clean.

## UNVERIFIED

- The red name tag colour, size and shape (`enemyTag`) on the user's footage; how often a path is confident.
- The MP kill feed region is used for every moment, so a BR moment frames the wrong area.
- The look of both on a real long video.
- Not built: the user's own movement path from optical flow, and dragging a path in the review before rendering.
