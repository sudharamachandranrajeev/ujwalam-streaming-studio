# BeatDrop BD3 (beat-locked planner) and BD4 (effects): evidence, 2026-11-21

Decision: D415. Plan: `docs/plan/2026-11-21-beatdrop-montages.md` sections 1.3, 5 (BD3, BD4) and 7.
Branch: `claude/beatdrop-bd3` (from `claude/alpha0-d1` at d112466). Status: synthetic fixtures PASS; real footage UNVERIFIED.

## What was built

- `services/clip/beatdrop.py`: the planner (moments + song map + optional reel style -> plan JSON), the music choice
  (NCS library pick, else the made-here bed), the bed from the plan's song start, the render call and `make()` (off
  air only, one heavy job, CPU or the chosen encoder).
- `services/clip/beatdrop_fx.py`: BD4 effects as one filter graph fragment, flash re-spacing.
- `services/clip/clip_montage.py` `render_argv`: extended (piece `speed`, `outFrames`, `game`; `music.duck: None`;
  `fx`). Calls without the new keys produce the same command line (test below).
- `services/clip/clipper.py beatdrop`: its own montage kind, `DIR/beatdrop/render.json` with `musicRecords: 1`.
- Data: `data/clip/beatdrop.json` (engine numbers, targets, effect presets), `data/games/codm/beatdrop.json` (game
  numbers, unverified), `data/schemas/beatdrop-plan.schema.json`, flag `beatdrop` (ON, D415).
- Registry: 8 core functions, 16 presets (2 each, similar tags): scope-zoom-transition, whip-pan, impact-flash,
  rgb-split, shot-shake, letterbox, ragdoll-slowmo, bloom-grade.

## Fixtures (made by the test, nothing real)

- Recording: 82 s, 60 fps, 320x180 FFV1, textured grey scene panning 2 px/frame; 0-20 s no kills (third-person
  moments); then 50 kills every 1.2 s (green square at the centre for 4 frames from the kill frame; a click on the
  kill and 6 frames before it), a flick 0.85 s after each kill. Moments JSON written with the known frames.
- Song: click track 120 bpm, phase 0.25 s; intro 4 bars, drop 8, breakdown 2, drop 8, outro 4; known drop 8.25 s;
  saved as "Test Artist - Click Drop [NCS Release].wav" in a temp Montage music folder (Settings > Clips > Montage
  music on, temp data root).

## Commands and results (CPU only: libopenh264; studio open, off air; live-check exit 0 before each run)

All Python runs: `.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p <file>` started with
`start /belownormal`, `UJWALAM_HEADLESS=1`, `UJWALAM_DATA_ROOT` = a temp folder.

| File | Result |
|---|---|
| tests/py/test_beatdrop.py | 17 tests OK (planner 10, music choice 1, BD4 flash 1, rendered montage 5) |
| tests/py/test_clip_montage.py | 35 OK |
| tests/py/test_clip_reel_style.py | 6 OK |
| tests/py/test_clip_look.py | 15 OK |
| tests/py/test_clip_live_montage.py | 4 OK, 2 FAIL: the `_short_` name count also counts the D414 `.music.json` sidecars; not touched by this branch (pre-existing, UNVERIFIED on the base commit) |
| tests/flags.test.mjs | 10 pass |
| tests/beatdrop-schemas.test.mjs | 3 pass |
| tests/registry.test.mjs, tests/registry-layer-effects.test.mjs | 14 + 1 pass |
| tests/package-alpha.test.mjs | 17 pass ("repo file set" included), 2 fail: Install-Ujwalam.ps1 fake-install and -SettingsOnly tests (installer, not touched by this branch; UNVERIFIED whether they fail on the base commit) |
| npm run validate:registry | OK: registry valid |

### Done when (plan section 7, BD3), measured on the rendered montage

Output of `RenderedMontageTests` (`clipper.py beatdrop --encoder libopenh264 --width 320 --height 180 --max-sec 60`):

```
BD3 measured: 48 kills rendered, 48 within one frame of a beat (100.0 %), max error 16.7 ms, first kill at 8.2500 s,
drop at 8.2500 s (error 0.0 ms); planned stats {'pieces': 73, 'medianShotSec': 0.5, 'cutsPerMin': 82.7,
'onBeatShare': 0.75, 'kills': 48}
BD3 montage flash: peak 2.5 flashes/s over 3135 frames (limit 3)
```

| Done when | Target | Measured | |
|---|---|---|---|
| kills within one frame of a beat | >= 80 % | 100 % (48/48), worst 16.7 ms | PASS |
| first kill on the first drop | within 1 frame | 0.0 ms, no kill in the cold open | PASS |
| flash limit | <= 3/s per canvas | 2.5/s (fx test analyser on rendered frames) | PASS |
| one audio encode | 1 | one `-c:a` in the command, one audio stream in the file | PASS |
| music record in render.json | present | `musicRecords: 1`, clip `music` = {source ncs, trackId, credit}; clip_publish reads it as ncs | PASS |

Kill times are read back from the rendered frames (first frame of the green square, relative to the grey around it,
so a kill under a white impact flash is still seen on its first frame) and compared with the click track's known
beats, not with the plan.

### BD4

- Each effect alone at its densest (requested every 0.25 s for 4 s over flat grey, worst case), rendered and measured
  with the fx test analyser (`tools/fx-test.mjs analyseVideo`, WCAG 2.x general and red flash):
  `{'scope-zoom-transition': 0, 'whip-pan': 0, 'impact-flash': 2, 'rgb-split': 0, 'shot-shake': 0, 'letterbox': 0,
  'ragdoll-slowmo': 0, 'bloom-grade': 0}` flashes/s, all PASS.
- Control: the same impact flashes without re-spacing measure 4 flashes/s and FAIL, so the measurement is real.
- Timing limits from the manifests: letterbox in <= 550 ms, out <= 350 ms; whip-pan 6-10 frames; impact-flash
  maxPerSec clamped to 3; every function `flashesPerSec` <= 3, format post-render.

## Placeholders, mocks, limits

- Title, hero and credits slots are empty placeholders (`content: null`) for BD5.
- Posting does not pick up `DIR/beatdrop/` yet (no candidates.json); no studio card or button for BeatDrop yet.
- The bundled LGPL ffmpeg has no `eq` filter: bloom-grade saturation uses `hue=s`.
- The planner's default shot length (0.6 s at 120 bpm) makes one-beat pieces whose kill is on the cut; with a style of
  1 s shots the kill sits on the second beat (planner test).

## UNVERIFIED

- Real footage and real tracks (BD1/BD2 accuracy on them is also unverified), game numbers in
  `data/games/codm/beatdrop.json`, how the effects look to the user, Content ID on NCS tracks, flash rate of real cuts
  between bright and dark game shots (the cuts themselves are not re-spaced).
- The two package-alpha installer failures and the two live-montage failures above on the base commit.
