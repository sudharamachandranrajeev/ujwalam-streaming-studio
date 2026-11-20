# Evidence: backlog auto-post (random-daily) and recording cleanup (D403, proposed D405)

Date: 2026-11-19/20. Branch `claude/autopost-backlog`. Status: tests pass; real-use items UNVERIFIED (below).

## What was built

1. `placement: random-daily` (default in `data/posting/schedule.json`): each local day 09:00-23:00 gets a seeded
   3-6 posts at seeded minute times, >= 90 min apart (also from channel and queue times). DST-safe via Intl.
   The seed is saved once in the user's `schedule.json`. Shown and edited in the Auto-post card
   (`app/studio/qml/SettingsPosting.qml`).
2. Backlog order (`services/posting/backlog-order.mjs`): seeded shuffle; no same kind back to back while another kind
   waits; split-reel parts consecutive and in part order.
3. Recording cleanup (`services/studio-ui/recording-cleanup.mjs`, flag `delete-processed-recordings`,
   "Delete clipped recordings", ON): safe-delete steps shared with posted clips in `services/common/safe-delete.mjs`.
   Job history `<data>/clips/jobs.jsonl`; Keep for labelling list `<data>/clips/keep-for-labelling.json` (Settings >
   Clips > Recordings); deletions logged to `<data>/clips/deleted-recordings.jsonl`; one task-bar line per batch.

## Example: first 2 weeks for 198 clips (seed 20261119, Europe/London, start 2026-11-20 08:00 UTC, empty channel)

| Day | Posts | Times |
|---|---|---|
| Fri 20 Nov | 4 | 09:20, 11:59, 15:32, 17:07 |
| Sat 21 Nov | 4 | 13:01, 15:28, 18:53, 20:44 |
| Sun 22 Nov | 6 | 10:26, 12:43, 15:05, 16:50, 19:12, 20:47 |
| Mon 23 Nov | 4 | 09:26, 11:59, 17:35, 22:54 |
| Tue 24 Nov | 5 | 10:38, 12:12, 14:19, 17:04, 22:37 |
| Wed 25 Nov | 4 | 13:17, 15:05, 16:53, 20:33 |
| Thu 26 Nov | 5 | 10:14, 12:43, 15:25, 19:58, 22:46 |
| Fri 27 Nov | 3 | 11:27, 14:10, 15:52 |
| Sat 28 Nov | 4 | 13:26, 16:10, 18:28, 21:33 |
| Sun 29 Nov | 5 | 12:02, 14:09, 15:54, 17:29, 19:32 |
| Mon 30 Nov | 6 | 10:44, 12:15, 15:23, 19:24, 20:55, 22:57 |
| Tue 01 Dec | 5 | 12:18, 16:27, 19:06, 20:39, 22:18 |
| Wed 02 Dec | 4 | 09:48, 17:41, 20:50, 22:25 |
| Thu 03 Dec | 3 | 10:26, 12:41, 15:20 |

62 posts in 14 days; all 198 placed over 44 days (`planQueueSlots`, pure). The approval daily cap
(`maxUploadsPerDay`) and the YouTube quota still limit how fast items reach the queue.

## Recording cleanup conditions (all must hold)

1. Flag on. 2. Latest outputs status known and no stream/record sink starting, live, reconnecting or retrying.
3. At least one job in `jobs.jsonl` for the H file; latest job of each type (full, review) ended `done`, exit 0, and
   with reels made when a V file exists. 4. No running, queued or asking job uses H or V. 5. Not on Keep for labelling
   (unreadable list keeps all). 6. Per file: inside the recordings folder by real path (no link/junction/UNC), a regular
   file, same identity (dev, file id, size, mtime) right before and after the move to `.ujwalam-deleting`, rename not
   refused (in use). Recordings with no job record (all made before this build) are never deleted.
   Runs once at start-up (first off-air, idle status) and after each clip job, on a later turn, no file contents read.

## Tests (one file at a time, UJWALAM_HEADLESS=1, BelowNormal, live-check off air)

| File | Result |
|---|---|
| tests/recording-cleanup.test.mjs | 11/11 (incl. real PowerShell holder -> file-in-use) |
| tests/record-clips.test.mjs | 26/26 |
| tests/flags.test.mjs | 10/10 |
| tests/posting-random-daily.test.mjs | 8/8 |
| tests/posting-backlog-order.test.mjs | 5/5 |
| tests/posting-schedule.test.mjs | 28/28 |
| tests/posting-auto-d375.test.mjs | 46/46 |
| tests/posting-auto-chain.test.mjs | 14/14 |
| tests/posting-uploads.test.mjs | 11/11 |
| tests/studio-ui-posting-auto.test.mjs | 8/8 |
| tests/studio-ui-posting.test.mjs | 8/8 |
| tests/posting-e2e.test.mjs | 38/38 (fake YouTube server) |
| tests/posting-preview.test.mjs | 12/12 |

QML compiles in the pre-commit quick CI (build-studio). `tests/studio-qml-posting.test.mjs` not run (needs the built
studio running headless; not run per the no-full-CI rule).

## UNVERIFIED

- Card fields and the Recordings list in the running studio (no UI run).
- `file-in-use` with OBS/libobs writing: tested with a .NET Read/Read-share holder only.
- Real YouTube scheduled publish at the planned times (fake server only).
- The user's existing `schedule.json` with `placement: fill-gaps` stays on fill-gaps until switched in the card.

## Backfill for old recordings (user, 2026-11-20: "Delete if clips exist")

A recording with no job record counts as processed when
  its run folder's `render.json` names exactly that H file (same base name, directly in the recordings folder) and the
  run made at least one clip that still exists in the clips folder or that `report.json` lists as ok. No size, file id
  or exit code was recorded by earlier builds, so the name is the identity. Its V file (`<stem>-v.<ext>`) goes with a
  qualifying H only; a V file with no H is kept. All other conditions still apply. Runs once; verdicts in
  `<data>/clips/backfill-recordings.jsonl`. Dry run: `node services/studio-ui/recording-cleanup.mjs --dry-run --data
  <dir> --recordings <dir>` lists what would be deleted and kept and changes nothing.
Tests: `tests/recording-cleanup.test.mjs` 15/15 (fixtures: a qualifying H+V pair, an H whose clips are gone, a V without H,
a session kept for labelling, a never-clipped H, a run naming another file; dry run in-process and from the command line).

## Codex round 1 fixes (2026-11-20)

- Each `jobs.jsonl` entry carries the identity (size, device, file id, modified time in ns) of the H and V files it
  used; lines that fail the strict schema are ignored. A file is deleted only when the file at that path now has exactly
  that identity, checked again through the delete's own handle (`safeDeleteFile` `expectId`). Backfill entries take the
  identity at backfill time and are marked `backfill: true`.
- The live/recording state and the clip jobs are read again right before each file (`recheck`); any change stops the
  batch and the rest is kept.
- A V file is deleted only when every deciding entry (latest full, latest review) lists it with its current identity.
- random-daily: every taken time on a local day counts toward the day's maximum, also outside 09:00-23:00, for new and
  kept slots.
- Tests: recording-cleanup 18/18, record-clips 27/27, posting-random-daily 9/9, posting-schedule 28/28, posting-e2e 38/38.