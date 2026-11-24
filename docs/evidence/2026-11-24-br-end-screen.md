# 2026-11-24 — BR end screen (S2) and BR top HUD (H1), D441

Status: **unverified** (pack 0.9.0). Placeholders only; raw OCR scans with player names stay in the gitignored
`docs/evidence/private/br-end-2026-11-22/`.

## Source

- Recording of 2026-11-22, 6 Battle Royale matches, OCR at 1 fps (RapidOCR PP-OCRv6 small), coordinates as fractions
  of the visible game box.
- End-screen frames: 17 per match (102). Top-HUD frames: 47, match 1 only.

## Measured geometry (same in all 6 matches)

| Item | x | y |
|---|---|---|
| GAME OVER heading | 0.325-0.672 | 0.368-0.519 |
| MISSION COMPLETED heading (win) | 0.194-0.804 | 0.371-0.518 |
| Ranking value #N/M | 0.635-0.724 | 0.541-0.621 |
| Mode value | 0.634-0.719 | 0.634-0.679 |
| MAP value | 0.650-0.718 | 0.685-0.722 |
| Strip #N/M | 0.251-0.349 | 0.026-0.093 |
| Strip "Mode - Map" | 0.103-0.275 | 0.889-0.929 |
| HUD players left | 0.136-0.171 | 0.022-0.060 |
| HUD own kill counter | 0.204-0.219 | 0.027-0.056 |

Not read on purpose: the N/M box at x 0.056-0.095 on every end frame (not players left); the gulag countdown box at
x 0.232-0.270; the strip's per-teammate KILLS N (the text does not tell which card is the streamer); a
daily-challenge popup that can cover x 0.64-0.81 y 0.67-0.76 (only pack map names are read there).

## Tests

`.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -p <file>` (2026-11-24):

- `test_br_end_screen.py`: 18 tests OK (synthetic boxes at the geometry above, placeholder names).
- `test_learning_capture.py`: 21 tests OK (a BR match is offered BR modes only).
- `test_clip_match_gate.py`: 37 tests OK (unchanged MP behaviour).
- `npm run validate:games`: OK.

## Local replay of the 6 matches (parse_br_end / parse_br_hud)

| Match | Card frames | Strip frames | Placement / teams | Mode | Map | Heading | Result | HUD kills (2+ frames) |
|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 0 | #1/51 | battle royale | VERDANSK | MISSION COMPLETED | VICTORY | 7 |
| 2 | 1 | 3 | #4/50 | battle royale | VERDANSK | GAME OVER | none | no HUD scan |
| 3 | 1 | 3 | #2/51 | battle royale | VERDANSK | GAME OVER | none | no HUD scan |
| 4 | 1 | 2 | #2/27 | battle royale | VERDANSK | GAME OVER | none | no HUD scan |
| 5 | 1 | 2 | #22/25 | battle royale | VERDANSK | GAME OVER | none | no HUD scan |
| 6 | 2 | 2 | #3/25 | battle royale | VERDANSK | GAME OVER | none | no HUD scan |

All 6 placements match the screens. Match 1: players left was read on 39 of 47 HUD frames. The HUD kill count (7) is
not checked against a known total.

## Known gaps

- The older 2026-10-27 card layout (#N/M left of the heading, mode under it; scans g1-live-2 and g1-live-3) is not
  covered.
- Only VERDANSK and Battle Royale were seen; other maps and BR modes need real end screens.
- A match whose family is unknown is offered the MP mode choices only.
- The own kills from the HUD counter (`ownKills`) can differ from the kill-feed `ownKillTimes` that reels cut from.
- Not checked: whether the HUD counter shows a teammate's kills while spectating.
- The HUD was scanned for match 1 only.
- Duo or squad is not known: `teams` is the lobby team count only.
