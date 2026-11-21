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
  off a 9:16 frame. Fixed: `credit_layout` wraps each line to 92 % of the frame width, measured with the credit font's
  own advance widths (Pillow `ImageFont.getlength`, pinned in requirements-bundle.lock.txt; a link is cut where it still
  fits), and lowers the size only when the rows would pass 96 % of the frame height. Stagger stays per credit line.
- P2 temp files left on a title error: the music bed and LUT were removed only after the render call. Fixed: one
  try/finally from the music bed through the render removes bed, LUT (named before it is written), graph and title files.
- P3 pin vs moving effects: the pin is tracked on the source before the effects, so a zoom or slide under the title would
  move the footage away from it. Fixed: `beatdrop_fx.moving_windows` (the same windows `graph` draws: scope zoom,
  ragdoll zoom, hero push, whip pan, shake); a pinned piece that overlaps one gets the screen-space title with a log line.

Codex verify (round 2): a fixed 0.6 em glyph estimate was narrower than Rajdhani Bold's W (0.807 em): replaced by the
font's own widths (above). A failed music bed write left `music.wav.part`: `music_library.write_wav` now removes its
`.part` on any failure (every caller).

Test bugs fixed (these render tests had never run): `test_any_error_removes_the_title_files` did not create the lock
folder `make()` expects; the mini plan's title line (45 frames) was shorter than its 400 ms entrance + 300 ms exit, so
the pin window was empty (drop moved to 2.0 s, the line is 1 s); credits were measured inside the exit fade (now just
before it).

## Commands and results

`.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p <file>`; live-check exit 0 first.

| Run | Result |
|---|---|
| test_beatdrop_titles.py (all, incl. rendered) | 18 tests OK. Track: 200 points, worst inlier share 1.0, max error 0.13 px over 240 frames (limit 3.0 px). Rendered pin: max 1.80 px, mean 0.96 px (limit 3.0). Title onsets on their downbeats (error 0 frames). Entrance/exit ms: presents 233/133, title 200/117. Hero colour spread 81.3 before, 3.0 inside; name 430 px; credits 2487 px. Flash peak 0/s, one audio stream. Credits on 9:16: 4 long lines -> 18 rows at 45.5 px |
| test_beatdrop*.py (both files, below-normal priority, before the round-2 test fixes) | 64 tests: 62 OK, 1 skipped, the 2 title test bugs above; BD5 montage title onset 0 frames off the last downbeat, presents 0 frames off |
| test_music_library*.py | 15 OK |

## UNVERIFIED

- Real footage: the pin on real replays (C/D), the look of titles, hero and credits to the user, the CODM colours.
- Pillow and libass widths agree on the real screen (both FreeType; kerning may differ by a few px; the 8 % margin covers it).
- NVENC render with titles (tests render with libopenh264 on the CPU).

Codex verify round 3: a long unspaced word could be cut between a base letter and its combining mark; the cut now
moves so a mark stays with its letter (test added). 18 tests OK after the fix.
Codex verify round 4: a letter followed by many spacing marks could still be wider than the room; credit_layout now
also lowers the size while any row is too wide (down to 4 px). 18 tests OK.
Codex verify round 5: a credit that cannot fit whole even at 4 px was returned as fitted. It now raises, so the render
fails and nothing is posted with a cut credit (real credits are capped at 120/160 characters, so only junk input hits
this). The long-word cut uses a binary search (a linear search was quadratic on a 4000-character word). 18 tests OK.
Codex verify round 6: the height check ignored the entrance rise; it is included now. 18 tests OK.
