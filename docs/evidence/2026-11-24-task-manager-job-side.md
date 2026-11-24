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
### Codex review, round 2 (fix diff 54830dad..0fa5944b, 17 items)

All 17 items were fixed. None was judged "not a defect". Tests are in `tests/task-manager-jobs.test.mjs` ("Codex round 2 #N") and `tests/py/test_task_resume.py` (`RoundTwo`).

| Item | Finding | Fix | Test |
|---|---|---|---|
| R2-1 | An idle sample could authorise a spawn after a stream had started. | Main-session decision: no host reservation. Right before each spawn, `record-clips` asks the host for a fresh `outputs.status` (option `freshStatus`; `launch.mjs` uses the tick's own call). The job starts only if the answer comes back within 1 s, says no stream is on, and, for work that waits for idle outputs, says no recording is on. An error, an unknown state or a slow answer: no start. Residual: the spawn itself; the next tick's `pausedForLive` kill (whole tree) stays the backstop. | #1 |
| R2-2 | A recording that was stopping counted as idle for continuations. | The long video, BeatDrop and every continuation wait while `outputsOnAir` (the existing fail-closed rule) is true. A stopping, starting, reconnecting or unknown sink counts as busy. | #2 |
| R2-3 | A restart dropped controls the last launcher never read. | A request older than this launcher is applied to a carried-over job (same job id) before any start. For a job of this session it is still a leftover. | #3 |
| R2-4 | A failed status commit left control changes active in memory. | Control changes are staged: if the `status.json` write fails, they are undone. A failed write also blocks `start()` until a write succeeds. Stopped tasks are finished and the child is signalled only after the commit. | #4 |
| R2-5 | An older control could replay after a newer one was applied. | Request files get a random part in their name, which makes a unique key. Each job keeps the keys it applied (`applied`, last 32, in `status.json`); a request read again is skipped. | #5 |
| R2-6 | The live-interruption exit bypassed dispatch. | That exit now runs `dispatch()` (Stop all, then the controls). The gates decide what may start. | #6 |
| R2-7 | Safe-point and progress stages reached the log tail after a syntax check only. | Stages map from a fixed set of known values to fixed text (`LOG_STAGE_TEXT`); anything else is dropped. The step is not shown. | "log tail (Codex review 6)" |
| R2-8 | Task-file reads accepted any log-tail string. | Task files keep versioned structured events (`logEvents`, `v: 1`, validated on read). `logTail` (at most 8 strings) is built from them on every read. A string tail from an older file is dropped. | "cleanTask" |
| R2-9 | Migration left the old controllable task row beside the new one. | When an older job gets its id, its old name-only task row is removed, so the route answers 404 for that id. Controls are checked against the current job ids. | #9 |
| R2-10 | The caption key held only the model and tool paths. | `_caption_assets`: the given or default speech model folder, the tool and a GPU model's fallback, each as file names, sizes and mtimes. Large files are not hashed. | `test_caption_key_follows_the_model_files` |
| R2-11 | Relative overlay files were resolved against the wrong folder, and fonts were not in the key. | Overlay paths are resolved against the batch folder. The ASS and every font file are keyed by content. | `test_recording_mtime_and_overlay_files_from_the_batch_folder` |
| R2-12 | The recording fingerprint missed edits in the middle of the file. | Main-session decision: size + first/last MB digest + mtime in ns; no full-file hash. Residual: an edit inside the middle that keeps the size, both end MBs and the mtime is not seen. | same test |
| R2-13 | A failed overlay preparation was not marked degraded. | The overlay builder marks a batch as degraded when its info has a failure reason or status. Such a batch gets no manifest and is no safe point. | `test_degraded_overlay_gets_no_manifest` |
| R2-14 | An empty file list still produced a completion marker. | With no expected output there is no marker, and so no safe point. | `test_no_marker_without_expected_outputs_and_sidecars_are_bound` |
| R2-15 | The review marker did not cover subtitle sidecars. | The marker binds `transcript.json`, `captions.srt` and `captions.vtt` (their size and mtime, or their absence). | same test |
| R2-16 | The review key held the mutable look history. | The review key leaves out the look history. Reuse is keyed on the stable inputs; the kept row carries the look it was made with. | `test_review_key_ignores_look_history` |
| R2-17 | The review key held the style folder, not the effective style. | The review key holds the style this clip gets (the same seeded pick), its effective tuning and its files (names, sizes, mtimes). | covered by the key path; no separate test (UNVERIFIED) |

Changed test: the D406 long-video test in `record-clips.test.mjs`. The long job's live-interruption exit now runs dispatch, so the next clip job (allowed beside a plain recording) starts first. The test finishes that job before it expects the long job again.
### Codex review, round 3 (0fa5944b..b7c5c667, 10 items)

Nine items were fixed and one was accepted as a residual. Tests are in `tests/task-manager-jobs.test.mjs` ("Codex round 3 #N", the control-route test and the round-2 #5 test) and `tests/py/test_task_resume.py` (`RoundThree`).

| Item | Finding | Fix | Test |
|---|---|---|---|
| R3-1 | The fresh-status callback started the job without applying the waiting controls. | After a good answer, the callback runs `dispatch()`. It applies Stop all and the controls, picks the job again and checks every gate again. The answer counts for that job for 1 s. | #1 |
| R3-2 | A launch error could become an unhandled rejection. | The whole launch path catches errors: the fresh-status chain, the speech-model check chain, and the folder, log-file and spawn steps. The job stays queued and is tried again. Its task shows the typed end event `not-started` ("Could not start; it tries again shortly"). | #2 |
| R3-3 | A replayed Next start was applied after the restored job's wait state was set. | A restored job remembers when its wait comes from its old next-start choice (`awaitFromNext`). A Next start asked before the close sets that wait again: `run` clears it, `ask` and `notify` keep it. The first dispatch applies it, before any start. | #3 |
| R3-4 | Task rows were published before the status commit. | `write()` publishes the queue rows, the live-clipper row and the finished rows only after `status.json` is saved. Finished rows wait in a list until then. A failed control commit takes its rows back out. Live progress rows need a saved status. | #4 |
| R3-5 | The 32-entry dedup list could age out a key. | There is no fixed cap. A job keeps an applied key while that request's file exists, and drops it once the file is gone. | round-2 #5 (changed) |
| R3-6 | The control route trusted stale task rows. | The route accepts only an id that matches a job the launcher has running or queued in `clips/status.json` (`currentClipTaskIds`). Anything else gets 404. | control-route test |
| R3-7 | A degraded batch could reuse a manifest. | The degraded check runs before manifest reuse, so such a batch is always made again and is no safe point. | `test_degraded_batch_never_reuses_a_manifest` |
| R3-8 | Stale caption sidecars could be certified. | Invalidating a row also removes `transcript.json`, `captions.srt` and `captions.vtt`, so the marker binds only files this render made. | `test_invalidating_a_row_clears_its_caption_files` |
| R3-9 | Kept rows broke the look pool's no-repeat. | A review run saves the look history it started from (`look-history-start.json` in its output folder). A resumed run starts from that copy and replays each kept clip's picks and music track in clip order. The copy is removed when the run completes. | `test_marker_keeps_the_look_track_for_replay` (the full replay in a review run is UNVERIFIED by a test) |
| R3-10 | A caption model replaced by one with the same size and mtime is not noticed. | Accepted residual, as decided by the main session. The key holds names, sizes and mtimes, not a full hash. | none |
### Codex review, round 4 (b7c5c667..6e7f8bca, 9 items)

Main-session decisions applied. Tests are in `tests/task-manager-jobs.test.mjs` ("Codex round 4 #N").

| Item | Finding | Outcome | Test |
|---|---|---|---|
| R4-a (Codex 700, 703, 718, 815; round-3 R3-9) | The round-3 look-history snapshot and replay had its own defects. | Removed (main-session decision). A kept row keeps its look as rendered; only newly rendered clips add to the history, as before D442. Accepted residual: after a resume, a look may repeat sooner than the no-repeat window. Cosmetic only. | none |
| R4-b (server.mjs:1023) | The route answers 202 for a job the launcher just dropped after a failed commit. | Accepted (main-session decision). 202 means "request delivered". The launcher ignores ids it no longer has, and the task list shows the truth. | none |
| R4-1 (record-clips.mjs:598) | The fresh reply was checked against the job asked for, not the job picked later. | The reply is kept for 1 s. After the controls are applied and a job is picked again, it is checked against that job: a job that waits for idle outputs needs no recording; any other needs no stream. | #1 |
| R4-2 (record-clips.mjs:616) | A spawn that fails later (child `error`) was not handled. | The `error` listener is attached at spawn. It clears the launch state, keeps the job queued and adds the typed `not-started` event. The later `exit` of that child is ignored. | #2 (a missing program, real `spawn`) |
| R4-3 (record-clips.mjs:451) | Only some saved choices replayed a pending Next start. | Pending Next start requests are read at construction and applied to restored jobs of any saved choice, Run included, before the wait is set. Their keys are kept, so the first dispatch skips them. This replaces round 3's `awaitFromNext`. | #3 (Run, then a pending Ask: it waits) and round-3 #3 |
| R4-4 (record-clips.mjs:781) | Applied keys were pruned even when the folder listing failed. | Keys are pruned only after a good listing (`listTaskControls`: ok plus every key present). A failed listing keeps all keys; a missing folder counts as a good, empty listing. | #4 |