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
| tests/studio-qml-shell.test.mjs | 5 pass, 0 fail (after the commit hook built the studio) |
| tests/studio-qml-posting.test.mjs | 12 pass, 0 fail (default card kinds now include long-highlights) |

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
- The cleanup reason text in SettingsClips.qml (not covered by a probe test).

## Codex review fixes (2026-11-21)

| Finding | Fix | Test |
|---|---|---|
| P1 old records without `longNotMade` deleted | with the flag on, long.json made/skipped is required for every record | recording-cleanup.test.mjs "Codex D406 P1" |
| P1 long stage ran while recording | own `long` job: held while recording or live, tree killed when either starts | record-clips.test.mjs "its own job after the clip job" |
| P2 batch joins counted as cross fades | video_seconds/fit count joins per batch | test_long_video.py test_batch_joins_have_no_crossfade... |
| P2 long video alone never posted | countClips counts long/published.json | record-clips.test.mjs "a long video alone reaches auto-post" |
| P2 part files left after an exception or kill | per-attempt folder, removed in finally and at the next start | test_long_video.py test_an_exception_or_an_earlier_kill... |

Results after the fixes: test_long_video.py 20 OK; test_clip*.py 231 OK (37 skipped); record-clips 32 pass;
recording-cleanup 27 pass; studio-ui-flags-feedback 16 pass; live-updates 27 pass.
Still unverified: batch boundaries (every 12 segments) have a short audio fade-out/in, not a cross fade.

## Codex re-review fixes (2026-11-21)

- Cap: the plan fits maxSec minus 2 s (CAP_MARGIN_SEC); the probed file over maxSec fails its check and is removed, never published. Test: test_cap_is_enforced_on_the_probed_file_and_planned_with_a_margin.
- Abandoned attempt folders are cleared at the start of the long step, on every path (flag off, no recording, too short). Test: test_abandoned_attempts_cleared_on_every_path.
- long.json names its recording; with the flag on, the current long.json (made or skipped, same recording) is the proof and supersedes a stale longNotMade. Test: recording-cleanup.test.mjs 'Codex D406 re-review'.

Results: test_long_video.py 23 OK; test_clip*.py 231 OK (37 skipped); recording-cleanup 28 pass.
