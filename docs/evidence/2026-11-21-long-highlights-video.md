# 2026-11-21 Long highlights video (D406)

Status: built and unit-tested. A real render on a real recording is UNVERIFIED.

## What it is

One long highlights video per recorded session, made from the H (16:9) recording. It holds kills, streaks and wins in
time order. Overlapping moments are merged, so no footage appears twice. Length is about 8-20 minutes. It is posted as a
normal YouTube video (upload kind `long-highlights`, target `youtube-video`). Flag `long-highlights-video`, clips page,
ON by default (user-requested).

## Test evidence (2026-11-21, one file at a time, UJWALAM_HEADLESS=1, BelowNormal, live-check exit 0 before each)

| Test file | Result |
|---|---|
| tests/py/test_long_video.py | 18 tests, OK |
| tests/py (test_clip*.py, 231 tests) | OK after the progress-contract regex gained `long` (37 skipped, as before) |
| tests/record-clips.test.mjs | 30 pass, 0 fail |
| tests/recording-cleanup.test.mjs | 26 pass, 0 fail |
| tests/flags.test.mjs | 10 pass, 0 fail |
| tests/live-updates.test.mjs | 27 pass, 0 fail |
| tests/studio-ui-flags-feedback.test.mjs | 16 pass, 0 fail |
| tests/posting-uploads.test.mjs | 12 pass, 0 fail |
| tests/studio-ui-posting-auto.test.mjs | 8 pass, 0 fail |
| tests/posting-auto.test.mjs | 14 pass, 0 fail |
| tests/posting-rules-in-data.test.mjs | 8 pass, 0 fail |
| tests/posting-backlog-order.test.mjs | 5 pass, 0 fail |
| tests/studio-qml-shell.test.mjs, tests/studio-qml-posting.test.mjs | 0 tests ran (studio build not present in this worktree): NOT VERIFIED |

What the tests cover:

- Moments merged where they overlap or touch; no second use of footage.
- Over 20 minutes: lowest-scored segment dropped first (ties: shorter, then later).
- Under 8 minutes: no video, plain reason in minutes.
- Batches of 12 pieces, joined with `-c copy` (audio encoded once).
- Flag off, no recording, no detector hits: a status file with the reason.
- The new kind in names, uploads.json, rules (validateRules), packaging (youtube-video, own template text), the rules
  editor kind list.
- record-clips: `--long-video` passed for H runs, the `long` stage, `longNotMade` in jobs.jsonl, status and task note.
- Live gate: no job starts while live; a stream that starts kills the job (the long step runs inside it).
- Cleanup: `long-video-not-made` keeps the recording; a failed long video keeps it; once made it goes; backfill waits
  for `long.json` while the flag is on; too short (skipped) counts as done.

## Not verified

- A real NVENC render from a real recording (length, sync, transitions, the H frame).
- The concat-copy join of AAC parts on real files (small gaps at joins possible).
- YouTube's 15-minute limit for unverified accounts (videos up to 20 minutes would fail there).
- The QML views (kind toggle text, cleanup reason text): no studio build here.
