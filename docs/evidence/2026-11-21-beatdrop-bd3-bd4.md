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
| tests/py/test_beatdrop.py | 27 tests OK after the review fixes (planner 15, stop guard 2, music choice 1, BD4 flash 1, rendered montage 8) |
| tests/py/test_clip_montage.py | 35 OK |
| tests/py/test_clip_reel_style.py | 6 OK |
| tests/py/test_clip_look.py | 15 OK |
| tests/py/test_clip_live_montage.py | the 2 failures seen at f9f32ab were a D414 test bug (sidecars counted), fixed on claude/alpha0-d1 in 8bdd329 and merged here |
| tests/flags.test.mjs | 10 pass |
| tests/beatdrop-schemas.test.mjs | 3 pass |
| tests/registry.test.mjs, tests/registry-layer-effects.test.mjs | 14 + 1 pass |
| tests/package-alpha.test.mjs | 17 pass ("repo file set" included), the 2 installer failures came from running it with UJWALAM_DATA_ROOT set; it passes without it |
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
  between bright and dark game shots (now counted and measured, see below; tested on synthetic brightness only).

## Codex review fixes (2026-11-21, after f9f32ab)

claude/alpha0-d1 merged first (55441ef). Each fix has a test in tests/py/test_beatdrop.py; all 27 tests pass (CPU,
headless, BelowNormal, temp data root, live-check exit 0 before each run); test_clip_montage 35 OK; flags and
beatdrop-schemas 13 pass.

| Item | Fix | Test |
|---|---|---|
| 1 (P1) cut flashes unmeasured | cut edges probed for relative luminance (one small seek per edge, cached `beatdrop-luma.json`); a jump >= 0.1 counts in the 3/s budget, impact flashes yield, a cut over budget gets a 3-frame luma-matched dissolve (`cut-soften`); plan `cuts`. The rendered file is measured with the fx-test analyser; above 3/s or unmeasurable: status failed, reason recorded, file removed, never published | `test_bright_dark_cuts_count_as_flashes`, `test_cuts_over_the_budget_are_softened`, `test_soften_matches_the_outgoing_level`, `test_over_the_flash_limit_is_failed_not_published` (fake 4.5/s), `test_render_is_measured_and_recorded` (real render: peak 2.5/s in render.json) |
| 2 (P1) on-air only checked before ffmpeg | `run_tool(stop=)` polls `live()` (unknown = on air) and kills ffmpeg; status `stopped: on air`, part removed; clipper writes no render.json and exits 4 so it runs again | `StopGuardTests` (2), `test_live_flip_mid_render_stops_it` (live flips once the part file has bytes; plus live() None) |
| 3 (P2) early first drop dropped and relabelled | first drop wins, cold open shortened and logged; below 2 bars: `firstDropMissed` {at, reason}, `song.firstDrop` null, kill on `song.dropAt` | `test_first_drop_before_the_cold_open_minimum_wins`, `test_first_drop_too_early_is_recorded_not_relabelled` |
| 4 (P2) earlier kill in a lead-in | no other kill inside an anchored piece (either side), no other gunshot before the anchor beyond the no-kill margin; too short at 0.5x moves to the next moment | `test_lead_in_holds_no_other_kill` (two kills 0.3 s apart) |

Re-measured Done-when after the fixes: 48/48 kills within one frame (max 16.7 ms), first kill on the drop 0.0 ms,
flash peak 2.5/s. At 120 bpm a piece is at least one beat, so plan cuts never exceed 2/s; softening is exercised
by the unit test with cuts every 0.2 s. A softened cut still counts in the budget (a dissolve is still a brightness
change). UNVERIFIED: real dark/bright game footage.

## Codex verify of 416127e (2026-11-21), round 2

Accepted as fixed: the flash budget and the first drop. Accepted residual (D415 item 9, not changed): gunshots within
noKillMarginSec before the anchor are that kill's own burst. Fixed, each with a test in tests/py/test_beatdrop.py:

| Item | Fix | Test |
|---|---|---|
| 1 (P1) live starts between the last poll and the child's exit | `run_tool(stop=)` checks once more after the exit; stop = `STOPPED_RC`, output discarded | `test_stream_starting_as_the_child_exits_discards_it` (poll 30 s, child ends at once) |
| 2 (P1) probes and flash check unguarded | each brightness probe and the node flash check run through `run_tool` with the job's stop; `live()` is checked between steps; any stop = `stopped: on air`, exit 4, nothing published | `test_stream_during_probes_or_flash_check_stops_the_job` (on air from the 5th look onward, which falls in the planning steps; and on air during the flash check) |
| 3 (P1) rerender replaced the video before render.json | a new name per render `beatdrop-<id>.mp4`; render.json is written atomically pointing at it, then older videos are removed; orphans not in render.json are swept before a run | `test_rerender_new_name_then_old_removed_and_orphans_swept` (second clipper run plus a planted orphan: only the new video is left, render.json points at it with the NCS record) |

### Round 2 test runs (after merging claude/alpha0-d1, flag `beatdrop` with `"onBy": "D415"`)

- Node, CPU, headless, temp data root: flags 10 pass, studio-qml-shell 5 pass, studio-ui-flags-feedback 16 pass,
  live-updates 27 pass.
- tests/py/test_beatdrop.py on the final code: 20 of 21 ran clean (planner, stop guard including the exit race, music
  choice, BD4 flash: densest impact flash 2/s, unspaced control 4/s). The rendered class did not run: its shared
  `clipper.py beatdrop` render passed 900 s and timed out in setUpClass. A diagnostic run of the same render was
  stopped by the tool because the PC ran low on memory. The render had started after 15 s (probes done, part file
  growing slowly). UNVERIFIED: the rendered-class tests on the final code. An earlier run of that class on this round's
  code (before the GuardStop handling and the test fixes) passed setUp and 11 of 13 tests; the 2 errors are fixed.

## Codex verify of c370e5c (2026-11-21), round 3

The coordinator ran the rendered class on c370e5c+merge: 10 OK in 1054 s.

| Item | Fix | Test (tests/py/test_beatdrop.py) |
|---|---|---|
| 1 (P1) killing node left its ffmpeg | `run_tool` puts the child in a kill-on-close job (`clip_common.kill_on_close_job`) and ends the job on every stop path (stop, stall, timeout, finally) | `test_stop_ends_the_whole_tree`: the child starts a grandchild; after the stop the grandchild PID is gone (tasklist) |
| 2 (P1) sweeps outside the lock | the orphan sweep, the render.json write (`write_render` callback from clipper), the old-video sweep and the on-air cleanup all run inside `make()` while holding HeavyJobLock; referenced files are never deleted | `test_sweeps_and_on_air_cleanup_run_inside_the_lock_and_touch_only_own_files` |
| 3 (P2) sweep and cleanup too broad | only `^beatdrop-[0-9a-f]{12}\.mp4(\.part)?$` in wd; on air removes only this run's own part file and the probe file | `test_sweep_matches_only_its_own_names` (beatdrop-notes.mp4, other.mp4.part, beatdrop-plan.json and the referenced video survive); the lock test above (someone-else.mp4.part survives) |

Runs (CPU, headless, BelowNormal, temp data root, live-check exit 0 first): StopGuardTests + PlannerTests 22 OK;
test_render_watch 10 OK; test_clip_montage 35 OK.

The rendered class on this round's code was stopped by the tool (the PC ran low on memory): UNVERIFIED until it is run once with memory free.
