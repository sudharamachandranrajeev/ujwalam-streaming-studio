# BeatDrop BD7b: studio job, route and review card (2026-11-22)

Status: built, NOT run. A heavy render suite was running, so no test, CI, Python or studio ran. The main session runs the tests below. Decision: D420.

## Built

- `services/studio-ui/beatdrop-review.mjs` (new): reads `runs/<run>/beatdrop/render.json` and the plan; piece blocks (kill / move / calm); strict retake checks; `GET /ui/api/beatdrop[?run=]`, `POST /ui/api/beatdrop/retake`, `POST /ui/api/beatdrop/play`.
- `services/studio-ui/record-clips.mjs`: job type `beatdrop` (steps moments, render, retake), queued after a full job with the flag and detector hits, same live/recording hold as the long video, task titles in plain words, retake request read from `clips/retake.json`.
- `services/studio-ui/server.mjs`, `launch.mjs`: routes wired; `beatdropFlag` from the flag `beatdrop`.
- `app/studio/qml/BeatDropWindow.qml` (new), `Main.qml`, `OnAirBar.qml`, `app/studio/CMakeLists.txt`: the review card and its button.
- `tests/beatdrop-review.test.mjs` (new): argv of all steps, queueing rules (flag off, no hits, unreadable flag), moments to render chain, failed moments, route JSON from a synthetic render, retake validation (bad op, bad piece, unknown run, extra keys), retake job and the one-at-a-time rule, play route.

## Run

`node --test tests/beatdrop-review.test.mjs tests/record-clips.test.mjs tests/studio-ui-server.test.mjs`

## UNVERIFIED

- All of the above has not run. QML was not loaded (the Qt studio tests, `tests/studio-qml-clips.test.mjs` style, are not extended).
- Whether `clipper beatdrop` needs `--project` or other flags beyond those in its help.
- The exit codes of `clipper beatdrop` (flag off, on air) are shown only as "not made; see the log".
- Video preview opens the system player (no Qt Multimedia); the V toggle is the "Play V video" button.
- A BeatDrop montage is not handed to auto-post by this job (D419 publishes it like a montage).
- Real footage, NVENC, the look on screen.
