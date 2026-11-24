# D442 task manager: job side (2026-11-24)

Status: test evidence only (no real-stream use yet). The task window (Qt) is a separate task. The Codex second-opinion
review of the job side is still open (D442 point 4).

Branch `claude/d442-task-manager` (from `codex/reel-mix-long-video` 84dbe0e). Commits: 2de0491, 2df4869, 9ed21b2, fcaee94.

## What was built

| Rule (D442) | Where | Test |
|---|---|---|
| Every task has a category: clips, reels, long-video, posting, learning, downloads, maintenance | `tasks.mjs` `TASK_CATEGORIES`, `categoryOf`, `cleanTask`; `record-clips.mjs` `jobCategory`; recording cleanup = maintenance | task-manager-jobs: categories, server route |
| Per-task stop, pause, resume and next-start change through the UI server | `POST /ui/api/tasks/control`, `server.mjs` `taskControl` | task-manager-jobs: POST route |
| Cross-process signal: one atomic file per request, applied in the order asked | `tasks.mjs` `writeTaskControl`, `takeTaskControls` (`<dataDir>/clips/control/<id>~<atMs>-<seq>.json`) | task-manager-jobs: control files |
| Pause takes effect at the next safe point: clip jobs after a piece (detect, gate, render, review, validate line with done ≥ 1); long video after a batch | `record-clips.mjs` `isSafePoint`; `long_video.render(on_part)` and `clipper.py` per-batch `ujwalam-progress` line | pause running job; safe points |
| A job with no safe point says so and does not offer pause (BeatDrop, game pack check) | `pauseInfo`; server 409 `not-pausable` with the reason | not-pausable test; route test |
| Resume does not redo finished work: clips already made are kept (`done-row.json` per clip, same inputs, files there and not empty); long-video batches already saved are kept (`long-parts/`, input key, size, ffprobe duration > 0), bad ones are made again | `clipper.py` `_row_key`, `_done_row`, `_has_duration`; `long_video.py` `part_key`, `part_done` | `test_task_resume.py`; `test_long_video.py` resume test |
| Next start per unfinished task: run, ask or notify, default notify; stored in status.json, survives restarts | `record-clips.mjs` restore, `JOB_KEYS`, `ctl()`; status.json `waitingForYou` | next-start test; restart tests in record-clips.test.mjs |
| Paused or carried-over work never runs while live or recording | `held()` in `record-clips.mjs` | live/recording test |
| Snapshot fields per task: category, controls, pausable + pauseReason, paused, pausing, nextStart, question, parts, logTail (8 lines × 160 chars, sanitised: chat/viewer/user/message/@name lines dropped; paths, links, tokens, key=value secrets, quoted text masked) | `tasks.mjs` `controlFields`, `safeLogLine` | log tail test; running-task test |

## Commands and results

TEMP/TMP set to `C:\AI\Claude\_data\Ujwalam\scratch\tmp` for every run.

```
node --test --test-reporter=tap tests/task-manager-jobs.test.mjs tests/record-clips.test.mjs tests/studio-tasks.test.mjs tests/studio-ui-server.test.mjs
# tests 100
# pass 100
# fail 0

node --test --test-reporter=tap tests/beatdrop-review.test.mjs tests/recording-cleanup.test.mjs tests/posting-auto-chain.test.mjs tests/studio-qml-tasks.test.mjs tests/studio-qml-tray.test.mjs tests/montage-music.test.mjs tests/reel-styles-api.test.mjs
# tests 82
# pass 80
# fail 0
# skipped 2

.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p <pattern>
test_long*.py               Ran 83 tests  OK
test_clip_pipeline.py       Ran 37 tests  OK
test_clip_output_layout.py  Ran 18 tests  OK
test_clip_e2e.py            Ran 7 tests   OK
test_clip_reel_style.py     Ran 6 tests   OK
test_clip_look.py           Ran 17 tests  OK
test_task_resume.py         Ran 1 test    OK

node tools/lint.mjs
lint: 0 finding(s), 37 allow marker(s)
```

Each commit's hook ran the quick checks: `ci: 9/9 passed`. The full `npm run ci` was not run on this branch; it runs after the merge.

## Changed behaviour

- A clip job left over from the last session no longer runs again by itself. It waits until the user starts it (notify), or until the user answers its question (ask). The old behaviour is kept only for jobs set to "run".
- A carried-over or user-resumed job also waits while a recording runs. Before, it could run next to a plain recording.
- Per-task stop removes the job for good. "Stop all" still keeps the queue for the next start.
- The long video keeps its saved parts after a kill or an error, in `<run>/clips/X1/long-parts/`. They are removed once the video is joined or a batch fails. The earlier rule (Codex D406 P2: nothing left behind after a kill) changes to this on purpose; old `attempt-*` folders are still removed at the next start.

## Gaps and risks

1. Fixed by the Codex review (13): the live-review loop now keeps finished clips too.
2. The loudness pre-pass and the overlay files of the long video run again on resume. They are cheaper than the batches, but not free.
3. Fixed by the Codex review (4, 11): the key now holds the source files' identity and the effective settings, and the marker is bound to the files it was written for.
4. Fixed by the Codex review (6): the log tail is now an allowlist of typed events.
5. Upload tasks and the UI server's own short actions offer no per-task controls. Uploads stop only through Stop all.
6. Nothing has been tried on a real stream or a real clip job yet.

## Codex review (second opinion, 2026-11-24)

Codex (medium effort, read-only) reviewed the diff 84dbe0e..a7a2f47 and reported 14 defects (7 high). The brief listed 13; the log-tail leak was the 14th item and is finding 6. Each finding below gives the fix and its test. The branch first merged `codex/reel-mix-long-video` (54830dad, task window included). The window's `waitingForYou` pass-through is kept.

"Pre-existing" means the defect was already there before 84dbe0e.

| # | Finding | Pre-existing | Fix (owning layer) | Test |
|---|---|---|---|---|
| 1 | The launch gate used a stale outputs status. | yes | `record-clips.mjs` `start()` starts a job only on a status at most one tick old (`statusMaxAgeMs` 5000). It starts nothing when the time is unknown, or while live. `feed(status, atMs)` takes the host's answer time. `launch.mjs` passes it (new `recentSample`; a direct call uses `Date.now()`). A child's exit no longer starts a job on an old status; the next tick does. | `task-manager-jobs` "Codex review 1" |
| 2 | A job interrupted by the stream restarted while a recording was still running. | yes | A job ended for the stream is marked `continuation`. `held()` keeps every continuation (interrupted, carried over, user-resumed) waiting while live or recording. | "Codex review 2" |
| 3 | A stop or pause was lost when Ujwalam closed. | no | The intent (`stopReq`, `pauseAt`) is in `status.json` before the child is signalled. A control file is removed only after the state is written (`peekTaskControls` + `ackTaskControls`). At start-up, a job stopped before the close is finished as "Stopped by you"; one with a pending pause comes back paused. | "Codex review 3" |
| 4 | The clip done-row key had no source identity. | no | `clipper._row_key` holds the H/V source identity (normalised path, size, mtime in ns), the effective layouts (crop, input), the captions and transcription settings, and the targets. | `tests/py/test_task_resume.py` `test_key_holds_source_identity_and_effective_layout_and_captions` |
| 5 | The long-part key used the soundtrack's temp path. | no | `long_video.part_key` holds the recording's content fingerprint (size + SHA-256 of the first and last MB). Every file path in the bed and overlay is keyed by its content, never by its path. The key also holds the encoder asked for and the part formats. | `test_key_holds_recording_identity_and_song_content_not_its_path` |
| 6 | The log tail leaked raw stderr (deny-list). | no | Allowlist (main-session decision): `tasks.mjs` `logEventText` / `pushLogEvent`. Allowed events are progress (stage word, done, total, step), safe point, part names from the job's own list, and end codes with fixed text. Raw stderr stays in `clips/run-<name>.log` only. `safeLogLine` and `safeLogTail` are removed; nothing else used them. `logTail` is still an array of at most 8 strings. | "D442 log tail (Codex review 6)"; "running task ... typed events only" |
| 7 | A child's exit could start a job before the waiting controls were applied. | partly (the exit path also skipped Stop all) | One dispatch boundary, `dispatch()`, runs Stop all, then the task controls, then `start()`. Every exit path and the status tick use it. | "Codex review 7" |
| 8 | A resume could lose to a pause still in flight. | no | The state asked for last is kept apart from the kill in flight. A resume clears `pauseAt`, and on exit the job is paused only if `pauseAt` is still set. Otherwise it runs again, as a continuation. | "Codex review 8" |
| 9 | A progress line is not a durable checkpoint. | no | Python prints `ujwalam-safepoint {"stage","done"}` (`clip_common.safepoint_line`) only after the record is committed: a detect checkpoint, a clip's done-row, or a long part's manifest. The launcher pauses only on that line (`parseSafepoint`, `isSafePoint`). Progress lines never pause a job. | "safe points and parts"; "pause: the running job ends only at its next safe point"; `SafePointLine` |
| 10 | Task ids could collide. | yes (name-based ids) | Each job gets a persisted `jobId` (8 hex) in its task id. Jobs from an older `status.json` are given one at start-up. | "Codex review 10" |
| 11 | A stale marker could vouch for replaced media. | no | The clip marker and the long-part manifest are written atomically after the media. They hold the key, the size and the mtime of each file. A file written later does not match. The marker or manifest is removed before a clip or batch is made again. | `test_marker_does_not_vouch_for_replaced_media`, `test_manifest_binds_the_media_and_goes_first` |
| 12 | A fallback batch was cached under the overlay key. | no | A batch made without its overlay gets no manifest and is no safe point, so a resume makes it again. | `test_fallback_batch_is_not_kept_and_safe_point_follows_the_manifest` |
| 13 | Live-review jobs made their clips again. | no | The review loop keeps per-clip completion records, the same scheme as 4 and 11. The key holds the save file's identity, the layouts, the encoder, the frame, the settings and the limits. | Covered by the shared helpers' tests; no separate review-loop test (UNVERIFIED end to end) |

Notes:

- The test-first order was kept per finding while working. The new tests were not run one by one against the pre-fix code: they import new exports, so the old code fails at import.
- Finding 1: the remaining window between the host's answer and the spawn is under one tick. A stream that starts in that window ends the job at the next tick, as before (`pausedForLive`, whole tree).
- The detect checkpoint safe point is printed only when the pass runs for the studio (with progress lines) and the checkpoint was saved.

Test runs (TEMP/TMP under the scratch folder, focused only, no full CI):

- `node --test tests/task-manager-jobs.test.mjs`: 20/20 pass.
- `node --test tests/beatdrop-review.test.mjs tests/record-clips.test.mjs`: 44/44 pass.
- A dependent set of 35 files (every test that imports record-clips, tasks, recording-cleanup or launch, plus `studio-qml-task-window`): 522 tests, 4 failures. All 4 were tests that read task files by the old id. They were fixed and re-run; both affected files then passed (44/44 above).
- Python (`-I`, discover): `test_task_resume` 7 OK, `test_long*` 83 OK, `test_clip_pipeline*` 37 OK, `test_clip_e2e*` 7 OK, `test_clip_detector_pass` 37 OK, `test_g1_detector_pass` 1 OK, `test_clip_frame_reader` 40 OK.
- `node tools/lint.mjs`: 0 findings. The commit hook's quick CI passed 9/9.