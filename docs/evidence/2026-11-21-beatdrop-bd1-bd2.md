# BeatDrop BD1 moment finder, BD2 song map and the NCS montage music library (D414), 2026-11-21

Plan: `docs/plan/2026-11-21-beatdrop-montages.md` (D413). Branch `claude/beatdrop-bd1` (not merged, not pushed).
Decision: D414 in `docs/plan/2026-10-29-v1-decisions.md`.

## How it was tested

- The user's studio was open (off air) the whole time. Before each test run, `node tools/live-check.mjs` was run and
  its exit code was checked. No GPU or NVENC work ran; no full CI.
- Each test file ran on its own at BelowNormal priority, with `UJWALAM_HEADLESS=1` and a temporary
  `UJWALAM_DATA_ROOT`. Node: `--test-force-exit --test-timeout=180000`. Python: the repo's `.venv-gpu` interpreter, `-I`.
- Synthetic fixtures only (tests build the videos and tracks in temp folders). No real footage, clips-corpus file,
  reference video or real song was used. No install, no network.

## What was built

- **BD1** `services/clip/moments.py` with the game numbers as data in `data/games/codm/moments.json`
  (schema `data/schemas/moments.schema.json`): gunshots (1-6 kHz spectral flux confirmed by a muzzle flash within 2
  frames), hits and kills (from detector hits; kill time = first hit-marker frame), scope in/out, flicks, slides/jumps,
  third person. Each moment: `{kind, t, frame, strength, source, status: "unverified"}`. Refuses to run on air
  (unknown counts as on air), uses the guarded decode (frame, wall-clock and memory caps), BelowNormal, one job at a
  time (lock file), CPU only.
- **BD2** `services/clip/song_map.py`, numbers in `data/clip/song-map.json` (schema `data/schemas/song-map.schema.json`,
  example `tests/fixtures/song-map-example.json`): beat grid (tempo + phase least-squares fit on kick onsets, refined
  by a short-FFT flux maximum), downbeats, sections, drops, transients. JSON numbers only.
- **NCS library** `services/clip/montage_music.py`, `data/clip/montage-music.json`; studio route
  `services/studio-ui/montage-music.mjs` (GET/POST `/ui/api/montage-music`); setting `clips.montageMusic` in
  `services/studio-ui/user-settings.mjs` (on by default; folder on a local fixed drive; random seeded with no repeat of
  the last N, or a fixed track); per-track editable credits stored under the data root. Settings > Clips "Montage
  music" card in `app/studio/qml/SettingsClips.qml` / `SettingsDialog.qml`.
- **Fail closed in posting**: `services/posting/post-text.mjs` `musicCredit` / `creditMissing`. Packaging adds the
  credit lines to the description; a library track without a complete credit is skipped (`music-credit-missing`,
  plain-word reason naming Settings > Clips > Montage music); a song from elsewhere is `render-only`. Approve
  (`setStatus`) and `uploadVideo` check again; the auto chain treats `music-credit-missing` as permanent with a plain
  reason.

## Measured results

| File | Result | What it shows |
|---|---|---|
| tests/py/test_moments.py | 8/8 OK | Synthetic clip: gunshots at frames 15 and 36, kill 39, hit 39, scope in 75, scope out 105, flick 120, jump 150 all exact; third person 181 vs truth 180 (1 frame). No extra moments. On-air refusal, guard and schema shape. |
| tests/py/test_song_map.py | 7/7 OK | Track a (120 bpm): max beat error 1.30 ms, fit rms 0.0 ms, drops 16.309 s / 40.309 s vs truth 16.31 / 40.31. Track b (140 bpm): max error 1.60 ms, rms 0.19 ms, drop 6.976 s vs 6.977. Sections right. |
| tests/py/test_montage_music.py | 7/7 OK | Credits from tags and file names, edits kept across scans, seeded pick with no repeat of the last N, folder rules, credit checks. |
| tests/beatdrop-schemas.test.mjs | 3/3 OK | Shipped data files and the example match their schemas; bad files are refused. |
| tests/montage-music.test.mjs | 6/6 OK | Setting defaults and checks, route list/credit via real Python, packaging with credit, skip without credit, render only, approve and upload refuse once the credit is removed. |
| Existing tests re-run | all pass | posting-uploads 12, posting-pt1-text 5, posting-e2e 61, posting-youtube 9, posting-schedule 28, posting-pt2 10, posting-pt3 9, golive-routes 35, guide 14, learning-signals 10, stream-apply-d387 10, user-settings-clip-look 4, user-settings-reel-styles 2. |
| tests/studio-qml-settings.test.mjs | 22/22 OK | Headless QML probe (studio rebuilt on CPU): the Montage music card opens without QML errors, ON by default with a random song and 3; only the changed parts (on off, avoidLast 5) are sent at Save. The other 21 Settings cases still pass. |

Done when: BD1 within 2 frames (PASS, worst 1 frame); BD2 beat grid within 20 ms (PASS, worst 1.6 ms) and drop found
(PASS).

## UNVERIFIED

- Accuracy on real footage (BD1) and real NCS tracks (BD2): only synthetic fixtures were measured. Every moment keeps
  `status: "unverified"` and the numbers in `moments.json` are unverified until checked against labelled real clips.
- Detector weights from the clip pack are not used by BD1 yet (kills come from detector hits as listed).
- Content ID claims on NCS tracks: possible, not tested.
- The Montage music card was checked through the headless probe only, not by the user in the running studio.
