# BeatDrop BD5 (titles, pin, hero, credits): evidence, 2026-11-21

Decision: D416. Plan: `docs/plan/2026-11-21-beatdrop-montages.md` sections 1, 3 and 5 (BD5).
Branch: `claude/beatdrop-bd5` (from `claude/alpha0-d1` at 1a10cd7). Status: synthetic fixtures; real footage UNVERIFIED.

## What was built

- `services/clip/beatdrop_titles.py` (new): fills the planner's title, hero and credits slots and draws them in the one
  montage render (an ASS file burned by libass after the BD4 effects).
  - `title-extrude`: "<brand> presents" on the title slot's first downbeat, then the song title from the intro's last
    downbeat to the drop; layered 2D text (depth copies, lighter top, light sweep, glow); slam in under 600 ms, fade out
    under 400 ms.
  - `title-pin`: the title tracked onto a flat area of each covered shot (OpenCV corners + pyramidal Lucas-Kanade with a
    forward-backward check + RANSAC homography, CPU, low resolution, frame budget); low confidence gets the screen-space
    title and a plan log line.
  - `hero-bw`: the outro hero fades to black and white with a slow push-in and eases back (no snap); player name under it.
  - `credits-roll`: the music record's credit exactly as `montage_music.credit_text` gives it, then the data lines.
- `services/clip/beatdrop.py`, `beatdrop_fx.py`, `clipper.py`: slots filled after planning, the pin tracked before the
  render, `hero-bw` in the effect graph, title files cleaned up.
- Data: `data/clip/beatdrop.json` `titles`, `data/games/codm/beatdrop.json` `look` (OFL fonts from data/fonts, colours,
  glyph widths; proposed, not checked against the user's footage), plan schema slots.
- Registry: 4 core functions (`title-extrude`, `title-pin`, `hero-bw`, `credits-roll`), 5 presets.
- Brand and player name come from `data/profile.local.json` at run time; a missing or `<placeholder>` value leaves its
  line out (logged). Nothing real is committed; tests use "Test Brand" / "TestPlayer".

## Codex review (codex exec, read-only, medium effort), this session

Three earlier findings were fixed before this session (handover). This session's review of the staged tree:

- P2 credits clipped: credit lines had a fixed size and libass does not wrap (WrapStyle 2), so a long title or link ran
  off a 9:16 frame. Fixed: `credit_layout` wraps each line to 92 % of the frame width (look `textGlyphWidthOfSize` 0.6,
  a wide average advance so the estimate errs wide; a link is cut into pieces) and lowers the size only when the rows
  would pass 96 % of the frame height. Stagger stays per credit line.
- P2 temp files left on a title error: the music bed and LUT were removed only after the render call. Fixed: one
  try/finally from the music bed through the render removes bed, LUT (named before it is written), graph and title files.
- P3 pin vs moving effects: the pin is tracked on the source before the effects, so a zoom or slide under the title would
  move the footage away from it. Fixed: `beatdrop_fx.moving_windows` (the same windows `graph` draws: scope zoom,
  ragdoll zoom, hero push, whip pan, shake); a pinned piece that overlaps one gets the screen-space title with a log line.

Also fixed: `test_any_error_removes_the_title_files` did not create the lock folder `make()` expects (test bug).

## Commands and results

`.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p <file>`; live-check exit 0 first.

| Run | Result |
|---|---|
| test_beatdrop_titles.py SlotTests, TrackTests, GuardAndCleanupTests | 13 tests OK (track: 200 points, worst inlier share 1.0, max error 0.13 px over 240 frames, limit 3.0 px; credits on 9:16: 3 long lines -> 16 rows at 50.5 px) |
| test_beatdrop_titles.py RenderedTitlesTests | PENDING |
| test_beatdrop.py | PENDING |

## UNVERIFIED

- Real footage: the pin on real replays (C/D), the look of titles, hero and credits to the user, the CODM colours.
- The glyph-width estimate against the real Rajdhani Bold advance widths (errs wide by design).
- NVENC render with titles (tests render with libopenh264 on the CPU).
