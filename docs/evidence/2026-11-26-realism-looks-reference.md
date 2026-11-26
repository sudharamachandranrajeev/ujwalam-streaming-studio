# 2026-11-26 RL5 New look from a reference: evidence

Plan: `docs/plan/2026-11-25-realism-looks.md`, row RL5 (D445). Branch `codex/reel-mix-long-video`.
Status: built and tested on synthetic pictures; the looks it makes are **unverified** on real gameplay (RL6).

## What was built

- `services/clip/look_reference.py`: the user picks a screenshot (png, jpg, bmp, webp) or a short video (mp4, mov, m4v,
  mkv, webm; opened the Reel styles way: named demuxer, file protocol only, no drefs, at most 90 s and 500 MB).
  - Colour is measured with the Reel styles colour analysis that already existed (`reel_style.frame_colour`: Lab mean
    and L spread, 12 frames spread over a video). Black bars around the picture are cut first (rows and columns whose
    brightest pixel is at most 16 of 255).
  - The LUT is written by the existing Reel styles writer (`reel_style.write_lut`, 17^3, same caps: L shift at most
    12, a/b shift at most 15, contrast 0.8 to 1.25). Target: the colour cast in full; brightness and contrast at half of
    their difference from a neutral picture (`TONE_SHARE = 0.5`, UNVERIFIED tuning; mean brightness says as much about
    the content as about the grade).
  - Glow, grain, vignette, clarity and the rest (and the backdrop list) are copied from the built-in look whose LUT moves
    a grey ramp most like the new one (Lab distance; contrast weighted 40 per unit of factor). The studio says so.
  - Saved in the user's data folder, never the repo: `<data>/looks/user-<name>.json` and `.cube`. The JSON keeps only
    numbers (measured colour, the LUT shift, the look it is based on), no path, no file name, no picture.
- File base `userluts` (= `<data>/looks`) in the project schema, the Node validator, `app/host/lib/project.mjs`, the
  host (`model.cpp`, `methods.cpp`, host rebuilt) and `alphaBases` / the studio start.
- Loader merge: `services/project/looks.mjs` `loadLooks(dir, userDir)` and `clip_realism.load_looks(dir, user_dir)`: the
  built-in looks first (Filmic first), then the user's own by name. A `user-` id among the built-ins, a built-in id or a
  `luts` base in the user folder, or a LUT name with a path in it is skipped. Reels (`clip_realism.pick`, `plan`,
  `lut_path`, clipper resume key) find the user's LUT in `<data>/looks`.
- Routes: `POST /ui/api/looks` `{op: from-reference, path, name?}`, `{op: rename, id, name}`, `{op: delete, id}` (flag
  `realism-look`; rename and delete only `user-...` looks; delete removes both files). `GET /ui/api/looks` and the
  Settings info list the user's looks with `own: true` and `basedOn`. Python runs hidden at below-normal priority.
- Studio: Make realism scene submenu ends with **New look from a reference…**; Settings > Clips > Realism look has
  **Your own looks** with **New look from a reference…**, and per own look a name box, **Rename** and **Delete** (one
  click each). The box (`LookReferenceDialog.qml`) has a path field, **Browse…** (a file dialog, `LookFilePicker.qml`),
  a name field (default "My look"), **Make look**, and says: the colour is measured, glow/grain/vignette/detail start
  from the nearest built-in look, nothing from the file is copied, kept or posted.

## Tests (all pass, 2026-11-26)

| Command | Result |
| --- | --- |
| `.venv\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p test_look_reference.py` | 9 tests OK |
| same, `-p test_clip_realism.py` (RL4 regression) | 13 tests OK |
| `node --test tests/user-looks.test.mjs` | 6 pass (loader merge, rename/delete, shapes, bases, module with real Python, HTTP routes) |
| `node --test tests/realism-look.test.mjs tests/realism-looks.test.mjs tests/user-settings-realism-looks.test.mjs tests/reel-styles-api.test.mjs` | 22 pass |
| `node --test --test-name-pattern=RL5 tests/studio-qml-editing.test.mjs tests/studio-qml-settings.test.mjs` | 2 pass (QML probes) |
| `node --test --test-name-pattern="realism\|Realism\|scene menu\|lazy\|made on first use" tests/studio-qml-*.test.mjs` | 10 pass |
| `node --test --test-name-pattern=RL5 app/host/tests/host-project.test.mjs` | 1 pass (base userluts in the real host) |

Known cast (the "done when"): a neutral grey gradient (L 15.4 to 84.6, mean 50, spread 20) pushed by Lab a = +6,
b = -9 is the reference. The made LUT on the neutral gradient gives a = +6.16, b = -9.07 (ab error 0.18; tolerance
1.5) and L 49.91 to 49.80 (tolerance 1.5). A b cast of -30 is capped at -15. A dark reference (L 20 below neutral)
darkens by half the difference within 1.5. A short synthetic mp4 measures within 1.5 of its cast. A vertical picture
on a black frame measures within 0.5 of the same picture without the frame. Every built-in look's own shift picks
itself as nearest (distance 0).

## Local manual check on the user's references (numbers only; nothing from them committed)

Run into a scratch data folder (`C:\AI\Claude\_data\Ujwalam\scratch\rl5-manual`), 3 local reel videos (R1-R3) and the
scene-builder screenshot (R4):

| Ref | Measured L / a / b / spread | LUT shift L / a / b / contrast | Nearest built-in | Time |
| --- | --- | --- | --- | --- |
| R1 video | 19.8 / +8.2 / -7.6 / 13.7 | -12 (cap) / +8.2 / -7.6 / 0.84 | Night neon | 9.0 s |
| R2 video | 30.7 / +3.8 / +0.6 / 19.9 | -9.7 / +3.8 / +0.6 / 1.00 | Night neon | 8.2 s |
| R3 video | 34.5 / -3.3 / +0.7 / 15.2 | -7.8 / -3.3 / +0.7 / 0.88 | Gritty war | 11.6 s |
| R4 picture | 11.7 / +0.9 / +0.4 / 13.9 | -12 (cap) / +0.9 / +0.4 / 0.85 | Gritty war | 0.7 s |

All four references are dark scenes, so every look darkens; whether that is wanted on the laptop's gameplay is for RL6.

## UNVERIFIED / open

- How the looks look on real gameplay, live and on reels (RL6, needs the user). `NEUTRAL` spread (20) and
  `TONE_SHARE` (0.5) are first guesses.
- A user look in a live scene through the real studio start (host loads base `userluts` from `alphaBases`): tested in
  the host with `project.plan`, not yet in a full studio session.
- The native file dialog (Browse…) was not opened in a test (headless probes cannot drive it); the path box is.
- Deleting a look that a scene uses: the host shows the layers without that colour (a warning, tested); the scene keeps
  the effect entry until the user makes the scene again.
