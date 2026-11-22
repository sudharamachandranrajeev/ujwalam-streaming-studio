# BeatDrop BD7b: studio job, route and review card (2026-11-22)

Status: built by a Sonnet subagent, reviewed by the main session and Codex (six rounds, the last CLEAN). Node tests
pass. QML not loaded by any test. Decision: D420.

## Built

- `services/studio-ui/beatdrop-review.mjs` (new): reads `runs/<run>/beatdrop/render.json` and the plan; piece blocks (kill / move / calm); strict retake checks; `GET /ui/api/beatdrop[?run=]`, `POST /ui/api/beatdrop/retake`, `POST /ui/api/beatdrop/play`.
- `services/studio-ui/record-clips.mjs`: job type `beatdrop` (steps moments, render, retake), queued after a full job with the flag and detector hits, same live/recording hold as the long video, task titles in plain words, retake request read from `clips/retake.json`.
- `services/studio-ui/server.mjs`, `launch.mjs`: routes wired; `beatdropFlag` from the flag `beatdrop`.
- `app/studio/qml/BeatDropWindow.qml` (new), `Main.qml`, `OnAirBar.qml`, `app/studio/CMakeLists.txt`: the review card and its button.
- `tests/beatdrop-review.test.mjs` (new): argv of all steps, queueing rules (flag off, no hits, unreadable flag), moments to render chain, failed moments, route JSON from a synthetic render, retake validation (bad op, bad piece, unknown run, extra keys), retake job and the one-at-a-time rule, play route, and the review cases below.

## Review (main session + Codex, 2026-11-22)

The main session checked the argv against `clipper.py beatdrop` and `moments.py`, and the file layout against what
`cmd_beatdrop` writes (`<run>/beatdrop/render.json`, `clips/B1/beatdrop-plan.json`, layouts `beatdrop-h`/`beatdrop-v`):
they match. Fixed:

1. The plan's retakes are objects (`{op, seed | piece}`); the route now turns them into words (`retakeWords`). The
   card shows only the engine's summary, which already ends with the retakes (no double listing).
2. Codex 1, P1: the queue rejected every retake (the request's `atMs` failed the strict key check). `atMs` is stripped.
3. Codex 1, P1: a retake needs its recording, which Delete clipped recordings may remove after the first montage.
   D420 item 6: no new retention rule; the route refuses with `no-source` and the card says so with its retake
   buttons off (`source` in the route JSON).
4. Codex 1, P2: a second request overwrote a waiting one; now refused while `retake.json` waits.
5. Codex 1 and 2: the QML redeclared `Item.scale` (strip delegate, now `pxPerSec`) and `Popup.data` (card state, now
   `review`); either stops the window loading.
6. Codex 2 and 3: a waiting request now counts as busy, and the queue removes the request file only after the job is
   in `status.json` (the route runs in another process), so the card never says "ready" while the take is queued.
7. Codex 4 and 5: an unreadable request file is removed (it would block the next one); a request whose file could not
   be removed is not queued twice (dedupe on run, op, piece and time).

Accepted residual: a failed `status.json` write is swallowed as before (the whole queue state would be wrong then).

## Run

`node --test tests/beatdrop-review.test.mjs tests/record-clips.test.mjs tests/studio-ui-server.test.mjs`:
84 pass, 0 fail (2026-11-22, `UJWALAM_HEADLESS=1`). Quick CI 9/9 on each commit.

## UNVERIFIED

- QML was not loaded (no Qt studio test opens the BeatDrop window; `qmllint` 6.8.3 shows only import and
  unqualified warnings, and it did not catch the `scale` redeclare either, so it proves little).
- The exit codes of `clipper beatdrop` (flag off, on air) are shown only as "not made; see the log".
- Video preview opens the system player (no Qt Multimedia); the V toggle is the "Play V video" button.
- A BeatDrop montage is not handed to auto-post by this job (D419 publishes it like a montage).
- Real footage, NVENC, the look on screen, a retake started from the real card.
