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

The first dry run on the real folders (main session) kept all 12 files as `no-run-folder`. The real recordings are
`alpha-<ts>.mkv` / `alpha-v-<ts>.mkv` and their clips came from the live clipper, not from record-clips runs. The rule
is therefore (D405): an H file with no clip job counts as processed when a clip still in the clips folder has a name
time inside [the time in the recording's name, its last write], or when an older run folder names it and made a clip.
It must also be finished: not written by an output, last written at least 10 minutes ago, and the live clipper not
running. V goes only with a qualifying H; `replay/` is never touched. The same check runs from now on (start-up, after
each clip job, every 15 minutes off air), so live-clipper sessions are covered going forward.

Dry run on a fixture copy in the real layout (temp folders):

```
DELETE  alpha-20261101-200000.mkv    (clip at 20:30 inside 20:00-22:00)
KEEP    alpha-20261102-200000.mkv    (no-clips-in-its-time-window)
DELETE  alpha-v-20261101-200000.mkv
KEEP    alpha-v-20261102-200000.mkv  (its H is kept (no-clips-in-its-time-window))
KEEP    alpha-v-20261103-200000.mkv  (v-without-h)
dry run: would delete 2 file(s), 0.00 GB; keep 3. Nothing was changed.
```

Tests: `tests/recording-cleanup.test.mjs` 20/20. The fixtures cover:
- a qualifying H+V pair;
- an H whose only clip is after its end;
- a V with no H;
- a session kept for labelling;
- an older run folder, and a run folder that names another file;
- a `replay/` file, which is left alone;
- recordings still being written, just ended, or with the live clipper busy;
- the dry run, both in-process and from the command line, writing nothing.

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
## Codex round 2 fixes (2026-11-20)

- The H/V identity is taken when the clip job starts and carried to its finish record; a file replaced while the job
  ran gives no record. A record without a start identity is not written.
- `safeDeleteFile` with `requireId` refuses a missing identity (`no-identity`). The V identity is read once per plan.
- The live/recording state, the clip jobs and the Keep for labelling list are checked synchronously right before the
  rename into `.ujwalam-deleting` (`gate`); an async or unreadable state counts as unknown and stops the batch.
- A run folder proves a recording only when its `render.json` `createdAt` is at or after the file's last write minus
  2 min and the name time is not after it (`run-older-than-file` otherwise).
- `published.json` paths count only when relative, without `..`, and a regular file inside the clips folder by real
  path (no junctions or directories).
- Tests: recording-cleanup 23/23, record-clips 27/27, posting-auto-d375 46/46.

## Custom posting times and "What gets posted" (user 2026-11-20: "add the ability to setup custom schedule in app as well")

- `placement: custom` (`services/posting/schedule.mjs`): `customTimes` `{ mon: ['09:00', '18:00'], ... }` (up to 24 a
  day) and `skipDates` (`YYYY-MM-DD`, up to 400). Times are local wall times (DST-safe through `zonedToUtc`); slots fill
  them in order; a time too close (`minGapMinutes`) to a channel post or a taken time is skipped, never moved; a kept
  slot must be one of its day's times. Lead time, `maxAheadDays`, quota, `maxUploadsPerDay` and retries apply as before.
  Custom with no time refuses to load (fail closed). The backlog order is the same mixed order as random-daily.
- Auto-post card: placement list "Random each day" (default), "Custom times", "Fill gaps between posts", "Always after
  the last scheduled post". Custom times: a week grid with time chips (add by a time field, remove with x), "Copy to
  every day", days off, and the next 10 posts with these times. Save/Discard as before; no typed confirms.
- "What gets posted": when the rules file is the user's own shape, the card shows each rule with its kinds as
  switches and its daily maximum, plus Upload automatically and the overall maximum. `GET/POST
  /ui/api/posts/auto/rules` (session; POST also CSRF and same Origin) read and edit it; only the named fields of the
  named rules change, every other key and rule is kept (`saveRulesEdit`), written atomically after `validateRules`.
  Card Save then sends `keepRules: true` so the schedule is saved without replacing those rules.
- Never silent: when auto-post is on and nothing can upload (no rules, bad rules, not signed in, no app key, read
  scope missing) the card shows it in red and the upload pass keeps one task bar line (`auto-post-notice`), e.g.
  "Auto-post is on but no rule says what to post: nothing uploads". The card checks sign-in locally only; the read
  scope comes from the upload pass's last check (a scope check needs a Google token call).
- Tests: posting-custom-schedule 12/12 (weekday times, DST, days off, channel and taken clashes, unknown rules kept,
  keepRules, notices, routes with CSRF/Origin, QML bytecode compile), posting-random-daily 9/9, posting-schedule
  28/28, posting-auto-d375 46/46, posting-auto-chain 14/14, studio-ui-posting-auto 8/8.
- UNVERIFIED: the QML card was compiled, not run; `tests/studio-qml-posting.test.mjs` skips here because the studio
  shell is not built in this worktree.
## Codex round 3 fixes (2026-11-20)

- A clip proves only one recording: the one whose window holds it with the latest start at or before the clip time;
  two with the same start keep both (`ambiguous-window`).
- Run-folder proof needs a clip of that run still in the clips folder (report.json ok alone is not enough), and the run
  made at or after the file's last write (no slack).
- The card never replaces a rules file it cannot read: it shows "Your rules file has a problem: <reason>; fix it or
  reset it" with a Reset button. Save sends `keepRules` unless the card's own rule controls changed.
- Custom times: a time that does not exist on a spring-forward day is skipped; a repeated autumn time is its first
  occurrence. An impossible day off is a problem (400), not an error.
- Tests: recording-cleanup 24/24, posting-custom-schedule 15/15, posting-random-daily 9/9, studio-ui-posting-auto 8/8,
  posting-auto-d375 46/46.