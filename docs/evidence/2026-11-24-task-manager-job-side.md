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

1. A paused live-review job (moments made into clips after a stream) makes its clips again when resumed. Only the whole-recording render loop keeps finished clips. The detect step resumes from its own checkpoint in both cases.
2. The loudness pre-pass and the overlay files of the long video run again on resume. They are cheaper than the batches, but not free.
3. A finished `done-row.json` is reused by any later run of the same run folder with the same inputs and tool version. That is intended, but a changed render setting outside the key would not show up.
4. The log-tail filter works from a deny-list. Codex should review it.
5. Upload tasks and the UI server's own short actions offer no per-task controls. Uploads stop only through Stop all.
6. Nothing has been tried on a real stream or a real clip job yet.
