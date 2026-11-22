# BD6 replay alignment engine: evidence (2026-11-22, D431)

What was built: `services/clip/replay_align.py` lines up replay passes (capture-card recordings of the game's own
replay viewer) with each other by their game audio, finds a half-speed pass, maps pass time to replay time to match
time, splits a pass where the user paused, and reads the HUD clocks by OCR as a second check. Clock regions are game
data in `data/games/codm/replay-align.json` (status unverified). Tests: `tests/py/test_replay_align.py`.

No user-facing entry point was added (internal engine; the guided-capture UI is a later BD6 step), so there is no
feature flag.

## Fixtures

Seven local recordings from 2026-11-21 (outside the repo, never committed; they show other players' names and a
device ID). Names below are the pass letters only.

| Pass | View | HUD | Speed | Length |
|---|---|---|---|---|
| A | first person | spectator HUD + replay controls | 1x | 46.5 s |
| B | first person | player HUD | 1x | 48.0 s |
| B2 | first person | clean | 1x | 50.7 s |
| C | third person | clean | 1x | 43.3 s |
| C-max | third person | clean | 1x | 50.7 s |
| C-vh | third person | clean | 1x | 48.6 s |
| D | third person | clean | 0.5x | 90.0 s |
| FULL | full match recording | | 1x | 329.9 s |

## Pair table (audio, rate searched 1.0 / 0.5)

Offset = where the second pass starts on the first pass's timeline (replay seconds). r = Pearson of the onset
envelopes over the overlap (the confidence); margin = r minus the best placement more than 0.5 s away. Command
(below-normal priority, project venv, a scratchpad script calling `align_pair` with a 10 s minimum overlap):

| Pair | Rate found | Offset (s) | r | Margin |
|---|---|---|---|---|
| A-B | 1.0 | 2.232 | 0.589 | 0.413 |
| A-B2 | 1.0 | 1.007 | 0.566 | 0.405 |
| A-C | 1.0 | 5.114 | 0.400 | 0.253 |
| A-C-max | 1.0 | -1.370 | 0.312 | 0.102 |
| A-C-vh | 1.0 | 0.549 | 0.449 | 0.283 |
| A-D | 0.5 | -0.512 | 0.242 | 0.098 |
| B-B2 | 1.0 | -1.225 | 0.599 | 0.439 |
| B-C | 1.0 | 2.879 | 0.454 | 0.349 |
| B-C-max | 1.0 | -3.595 | 0.328 | 0.153 |
| B-C-vh | 1.0 | -1.686 | 0.473 | 0.291 |
| B-D | 0.5 | -2.747 | 0.232 | 0.037 |
| B2-C | 1.0 | 4.096 | 0.361 | 0.199 |
| B2-C-max | 1.0 | -2.378 | 0.365 | 0.198 |
| B2-C-vh | 1.0 | -0.458 | 0.429 | 0.252 |
| B2-D | 0.5 | -1.525 | 0.223 | 0.063 |
| C-C-max | 1.0 | -6.467 | 0.477 | 0.308 |
| C-C-vh | 1.0 | -4.558 | 0.486 | 0.288 |
| C-D | 0.5 | -5.627 | 0.276 | 0.130 |
| C-max-C-vh | 1.0 | 1.916 | 0.463 | 0.300 |
| C-max-D | 0.5 | 38.149 | 0.230 | 0.065 |
| C-vh-D | 0.5 | -1.064 | 0.220 | 0.033 |
| FULL vs A | 1.0 | 31.828 | 0.229 | -0.028 |

Consistency (independent pairs must add up): A-B + B-B2 = 1.007 against A-B2 1.007; A-B + B-C = 5.111 against
A-C 5.114; A-C + C-C-max = -1.353 against A-C-max -1.370; A-C + C-D = -0.513 against A-D -0.512; A-B + B-D =
-0.515 against -0.512. Every 1x pair and every pair with D agrees within 0.02 s, except C-max-D (38.1 s, overlap only
12.5 s at a 10 s minimum overlap: a chance match; it would be -0.86 from the chain). The half-speed pass D was found
as 0.5x against every other pass.

With the default 5 s minimum overlap and pass A as the reference (the real-fixture test, `UJWALAM_REPLAY_FIXTURES`
set), every pass gets one segment with the same offsets as above and `aligned: true`; FULL gets `aligned: false`
(margin below zero).

## OCR second check (HUD clocks)

`replay_align.py --ref A B --ocr` (12 samples per pass, RapidOCR as pinned for the clipper):

| Pass | Clock | Readings | Agree (within 1.5 s) | Fitted offset |
|---|---|---|---|---|
| A | match clock, spectator HUD (counts down) | 12 | 12 | 295.15 |
| A | replay control bar position (counts up) | 12 | 12 | 61.41 |
| B | match clock, player HUD (counts down) | 12 | 12 | 294.73 |

B's clock, mapped through the audio offset A-B, gives the same match clock as A's within 0.42 s (the clock shows
whole seconds). So match time = 295.15 - replay time (seconds left on the clock), and A's replay starts 61.4 s into
the game's replay. Clean passes (B2, C, C-max, C-vh, D) show no clock; they get match time through the audio map.

## Pauses

Synthetic only: a 3.5 s silent pause inside a pass is found (two segments, offsets right within 0.05 s, the break
in the silent stretch); a 1.2 s silence that is not a pause leaves one segment. A windowed search (8 s windows) was
tried first on the real passes and rejected: game audio repeats (gunfire, steps), so short windows found chance
matches 20-40 s away on C-max and D and split them wrongly. The final method tries each silent or frozen stretch as
a pause and keeps it only if the whole pass then fits clearly better. None of the real passes was paused.

## Tests

`.venv-gpu/Scripts/python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_replay_align.py" -v`:
11 tests, 10 synthetic pass, the real-fixture test skipped unless `UJWALAM_REPLAY_FIXTURES` is set (with it set:
11 pass, table above). Under the system Python (no numpy) the file skips.

## UNVERIFIED

- The full-match recording (FULL) is not aligned to the passes by audio (r 0.23, negative margin). Why is not known:
  it may be the live match with another audio mix, or a different stretch. Match time for now comes from the HUD
  clock, not from FULL.
- Pauses on real passes (no paused fixture yet); seeks are not modelled.
- Frozen-frame detection (`--frozen`) has not run on a real pass.
- Clock regions come from one frame of each HUD type, one match mode, default layout; whether the countdown clock
  floors or rounds (0.5 s correction assumed).
- Thresholds (r 0.2, margin 0.05) rest on seven passes of one match.
