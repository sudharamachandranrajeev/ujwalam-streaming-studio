# BeatDrop BD7a: retakes, summary and the V cut (engine side) — evidence

Date: 2026-11-21. Decision: D418. Plan: `docs/plan/2026-11-21-beatdrop-montages.md`, BD7. Branch `claude/beatdrop-bd7`.
Done-when: "one-click retakes change only what they name; H and V renders from one plan."

## What was built

- `services/clip/beatdrop.py`
  - `retake(plan, op, moments, ...)` with four retakes: `another-take`, `slower-intro`, `more-third-person` and `swap` (`piece`). Each works on the saved plan and records itself in `plan.retakes`.
  - `summary(plan)`: plain-word lines for the UI.
  - `vertical_source(...)`: picks the V source and framing from `data/clip/layouts.json`.
  - `retake_song(...)`: the same NCS track by id, or the same seeded made-here bed.
  - `make(..., vertical=, retake=)`: renders the V file from the same plan in a second ffmpeg run. The V file has its own name and its own flash check. Both files stay .part until both are measured.
  - Calm pieces now carry `near` (the calm moment kind).
- `services/clip/clip_render.py` `layout_chain`: wraps the existing `layout_graph` once per montage piece and gives its labels unique names.
- `services/clip/clip_montage.py` `render_argv(layout=)`: frames each piece with that chain. Calls without `layout` render exactly as before.
- `services/clip/clipper.py` `cmd_beatdrop`: new options `--retake`, `--piece` and `--v-recording`. render.json now lists the files `beatdrop-h` and `beatdrop-v` (V `geometry` is the layout id, and it has its own `flash`), plus `summary` and `retakes`.
- `data/clip/beatdrop.json`: new `retakes` and `vertical` blocks. `data/schemas/beatdrop-plan.schema.json`: new `retakes` and piece `near` fields.

## Tests run (data only so far)

Run from the worktree with `UJWALAM_HEADLESS=1` and `UJWALAM_DATA_ROOT` set to a temp folder. Python is `.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py`.

| Command (`-p` / `-k`) | Result |
|---|---|
| `test_beatdrop_retake.py -k RetakePlanTests -k VerticalGraphTests` | Ran 10, OK |
| `test_beatdrop.py -k PlannerTests -k StopGuardTests -k MusicChoiceTests` | Ran 33, OK (skipped 1) |
| `test_beatdrop_titles.py` | Ran 18, OK |
| `test_clip_montage*.py` | validate 2/2 PASS |
| commit hook `node tools/ci.mjs --quick` | 9/9 passed |

What the data tests show:

- **swap**: only piece N differs. The new moment lands on the same output frame and beat. All other pieces, the slots, the song and the timing are byte-identical, and the saved plan is not modified. The test covers a body kill, a calm piece and the drop.
- **slower-intro**: only the cold-open pieces change, by one step, with the same source start and the same frames. The effects are identical. Repeated retakes stop at `speed.min` with a clear message.
- **more-third-person**: at most `convert` body moves become calm shots, never a kill and never the drop. The kill count is unchanged, and the beat effects of a converted piece go with it.
- **another-take**: the same seed gives the same plan. The drop piece is identical (first-drop rule). Every anchor stays on its frame and beat. More than a third of the pieces change. A second take records seed 2 and differs from the first.
- **Common to all retakes**: the plan follows the schema, no kill sits in a calm piece, anchored source spans never overlap, each moment is used once, the flash spacing holds after a retake, and the retake count is capped by `retakes.max`.
- **Summary of the fixture**: `['kill on the first drop at 0:08', '45 kills on beats', '15 moves between beats (flicks, slides, jumps)', '5 third-person shots', 'slow intro: 4 shots at 0.75x', '68 shots, 0:50 long']`.
- **V graph**: there is one blurred-fill chain per piece, with labels made unique per piece, and one audio encoder. The H graph is unchanged.

## Not yet run: render tests

`test_beatdrop_retake.py -k RenderedRetakeTests` has not been run. The tool permission check refused the below-normal-priority launch, so it is left for the main session. It runs `clipper.py beatdrop` twice:

1. The first run uses a V canvas sibling.
2. The second run is `--retake swap` with a V recording that does not exist, so it takes the blurred-fill fallback.

It asserts the following:

- render.json lists both files.
- V is 9:16 (180x320 for the 320x180 test frame).
- H and V have the same duration as the plan (±0.1 s).
- Each file has one audio stream.
- The V flash test passes.
- After the retake, only the named piece changed, the song is the same, every file has a new name, the old files are swept and no temp files are left.

The existing `test_beatdrop.py RenderedMontageTests` now also renders a V file through the CLI and should be re-run too.

## UNVERIFIED

- Real footage and real songs (synthetic fixtures only).
- NVENC (tests use libopenh264).
- How the V framing looks to the user: the stream-v canvas and the blurred-fill fallback, and the letterbox effect on 9:16.
- A made-here bed retake when `--max-sec` differs from the first render: the bed would differ.
- The studio preview card (BD7b).
