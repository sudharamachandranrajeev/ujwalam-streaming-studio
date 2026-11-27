# 2026-11-27 Make clips again

Gap: the user clicked Stop on a stuck clip task (a review of a recording). The task went away and nothing in the app could make clips from that recording again.

## What was built

1. **Task panel and task window.** A clip task that ended stopped or failed shows a "Make clips again" button (`TaskCenter.qml`, `TaskWindow.qml`). One click puts the same job (type, kind, H, V, since, until, name, minutes, next start, look) back into the existing clip queue. The clipper then reuses the run folder (`<data>/clips/runs/<name>`: cached analysis, finished clips). The old row goes away; the queued job shows its own row.
2. **Clips menu.** "Make clips from a recording..." (`ClipsFromRecording.qml`) lists recent recordings with no finished run, newest first, with the date, size and whether the V file exists. One click on "Make clips" queues a whole-recording job (`type: full`). The V partner is found by the same naming as the recording cleanup (`alpha-<ts>.mkv` and `alpha-v-<ts>.mkv`). A recording counts as finished only when a clip job record says done for it or its run folder has `published.json`. A stopped or failed run is listed.

The queue job is a `full` job (whole-recording search), not a `review` job: a review needs the live clipper's saves, which an arbitrary recording does not have. A task that was a review job comes back as a review job (same type as before).

## How it works

- `services/studio-ui/clips-again.mjs`: the record of a job (`<data>/clips/again/<task id>.json`, written by the launcher when a clip job ends stopped or failed), `jobFromAgain`, `listRecordings`, `jobFromRecording`, and the request files (`<data>/clips/make/*.json`, UI server to launcher).
- `record-clips.mjs`: `finishTask` saves the record and marks the task `again`; `readMake` (every status tick) turns a request into a queued job through `add()`. The job is `userStarted`, so `needsIdle` and `outputsOnAir` apply: it never starts beside a recording or a stream. A job with the same name and type already queued or running is not added twice. A gone recording or an unknown task is dropped with a plain log line.
- `server.mjs`: `GET /ui/api/clips/recordings` (names, sizes, hasV; no paths), `POST /ui/api/clips/again {id}` (only a task that offers it), `POST /ui/api/clips/make {name}` (only a listed recording). The POSTs use the same session cookie, Origin and CSRF gate as every mutating route. A request carries a task id or a recording name, never a path.
- `launch.mjs` and `cli.mjs`: the recordings folder in use is passed to the UI server (`--recordings`).
- `tasks.mjs`: `again` is a task field (only on a failed task).

A finished task row is pruned after 10 minutes (`PRUNE_MS`). After that the Clips menu is the way back.

## Tests (single files, no studio launch, no GPU)

`node --test tests/clips-again.test.mjs`: 13 pass.

- Queue builder from a stopped task record (same job back, V left out when gone, bad types and names refused).
- Launcher: Stop leaves the task `again: true` and a saved record; the request queues and starts the same job (same recording), once; the old row is removed; a repeat adds nothing.
- Failed run offers it; gone recording and unknown task dropped with a plain log.
- A job chosen in the menu waits while a recording runs, then starts (one job at a time).
- Recordings list: H paired with V, finished job and finished run folder left out, V without H and empty files skipped, newest first.
- Routes: 401 without a cookie, 403 for a wrong Origin, missing Origin, bad CSRF; 404/409/400 for unknown, not-offered and extra-field bodies; nothing written by refused calls; no path in the list.
- QML compile (qmlcachegen bytecode) of `ClipsFromRecording`, `TaskCenter`, `TaskWindow`, `Store`, `OnAirBar`, `Main`: pass.

Also run and passing: `tests/task-manager-jobs.test.mjs`, `tests/studio-tasks.test.mjs`, `tests/studio-ui-server.test.mjs`, `tests/qml-popup-sizes.test.mjs`.

## Not done here

- Real click: pending. The studio was not launched (the user's studio is running). Steps: stop a clip task, press "Make clips again" in the task panel; and Clips > "Make clips from a recording...", pick one.
- The headless QML probe tests (`studio-qml-*.test.mjs`) were not run (they start the shell).
- No full CI.
