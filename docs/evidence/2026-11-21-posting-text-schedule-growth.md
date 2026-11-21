# Posting text, schedule and growth: PT2, PT3, PT1 evidence (2026-11-21)

Plan: `docs/plan/2026-11-21-posting-text-schedule-growth.md`. Decisions: D408 (the plan) and D409 (as built).
Branch: `claude/posting-pt`. All tests used mocks only: temp data folders, a fake host, fake auth and a fake Google fetch.
Nothing was uploaded or posted.

Each file was run on its own with `UJWALAM_HEADLESS=1` at BelowNormal priority, with `node --test`. The live check came
back with exit code 0 (off air). `npm run build:studio` ran before the QML tests.

| Test file | Result |
|---|---|
| tests/posting-pt2-hard-gap.test.mjs (new) | PASS |
| tests/posting-pt3-actions.test.mjs (new) | PASS |
| tests/posting-pt1-text.test.mjs (new) | PASS |
| tests/posting-e2e.test.mjs (2 new PT2 cases: a clash during a pass, quotaExceeded fallback) | PASS |
| tests/posting-schedule, posting-random-daily, posting-custom-schedule | PASS |
| tests/posting-auto, posting-auto-chain, posting-auto-d375, posting-rules-in-data | PASS |
| tests/posting-youtube, posting-uploads, posting, posting-preview | PASS |
| tests/studio-ui-posting-auto, studio-ui-posting-youtube, studio-ui-posting | PASS |
| tests/studio-qml-posting, studio-qml-posts (after build:studio) | PASS |
| tests/py/test_clip_output_layout, test_learning_mix, test_long_video | PASS |
| commit hook quick CI | 9/9 PASS on each commit |

## What is shown

- With 24 a day, a whole-day window and hand-scheduled channel videos at odd minutes, no new slot falls within 60 min
  of a channel video or of another new slot. This holds for random-daily, fill-gaps, after-last and custom. Full days
  hold exactly 24.
- A hand-scheduled channel video that appears during a pass gives the clip a new slot before its session starts.
- quotaExceeded switches to the unit sum and shows a plain-words notice. The clip stays queued and uses no try. After
  the next Pacific day the upload bucket is tried again.
- "Run auto-post now" is refused while a stream is live or starting, and the chain takes the request without waiting
  for its throttle.
- "Schedule next free slot" queues the clip at least 1 h from every other post. "Post now (public)" was removed in
  the second Codex review (see below). Every upload carries a publishAt. `post.json` can never make a video public.
- Text: a line that needs a missing fact is never used. The same clip always gets the same line. The last N lines are
  not repeated, and a title over the limit is left out. An older unedited draft is redrafted once. Edited and approved
  drafts are left as they are.

## Codex fixes (review 2026-11-21)

Five defects were fixed. Each has a test, and all of them used mocks only. Every posting test file was run again
afterwards, one at a time (table below).

| Defect | Fix | Test |
|---|---|---|
| "Post now (public)" checked only saved times, had its own `uploading` set and did not record its time | The chain's schedule lock is shared. Inside it the channel is read fresh, and a failed or incomplete read refuses the click. The post is held in the queue (`public-uploading`, then `public-done` with the time it went up). If it is not sent, the hold is given back. | posting-pt3-actions: fresh read finds a post 50 min away; failed or incomplete read; recorded as taken; lock busy or chain uploading; a failed send gives the hold back. posting-e2e: no session while a public post is being sent, and the slot keeps the gap from it afterwards. |
| Chain accepted a channel read up to 10 min old | The channel is read right before each new upload session, inside the lock. A failed or incomplete read fails closed. | posting-e2e: one read per session (3 clips, 3 reads); a hand-scheduled post with no clock advance; a failed read before the 2nd session; an incomplete read; the lock held elsewhere. |
| Scan stopped at the lookback, so an old upload with a future publishAt was missed | The whole uploads list is read. Reaching `maxPages` means incomplete, so the read fails closed. The `schedule.json` comments are updated. | posting-auto-d375: whole list read with cost 1 + 2/page; an upload 375 days old scheduled ahead is seen; 2500 uploads with 40 pages is truncated. |
| Quota fallback waited 6 h, did not recount earlier bucket uploads, and was extended by repeated answers | `exhaustedUntil` is the next Pacific midnight (saved). Under the fallback, the day's bucket uploads count 1,600 units each again. A repeated answer keeps `until` and uses no tries. | posting-pt2-hard-gap: midnight in both PST and PDT; blocked until then, then free; recount refuses the 7th; repeats do not extend. posting-e2e: no init before midnight, even with Run now, then it uploads. |
| Redraft trusted only the new `editedByUser` marker | A legacy draft is redrafted only when its title, description, tags and hashtags exactly equal the old template rendered again with its stored values: the file name for finished videos, or candidates.json rank and date for clip variants. | posting-pt1-text: an edited title, an added note or changed tags are left untouched. A run-variant draft is rendered again, and one with no candidates.json is kept. |

## Second Codex review (2026-11-21)

| Item | Fix | Test |
|---|---|---|
| A. "Post now (public)" | Removed: the route, the button, `reservePublicNow`/`finishPublicNow` and the public states. The Upload button and CLI `youtube upload` now queue at the next free time and ask for a pass. `uploadVideo`/`uploadPost` refuse a missing publishAt (`publish-at-required`) before any request. | posting-pt3-actions: the route queues and makes no request; it is refused while live and with auto-post off; the public route and symbols are gone; undefined, null and '' are refused with no fetch; only the chain calls `uploadPost`. studio-ui-posting-youtube, posting-youtube-cli: queued, nothing sent. |
| B. Expired session restarted without a fresh read | The whole pass runs in one lock hold. `uploadVideo` calls `beforeNewSession` before every new session: a full read, then the 60-min check, with the time taken after the read. One read serves one session. A resume needs a complete read in the same hold. | posting-e2e: an expired session meets a new hand-scheduled post (two reads, no new session, moved to a clear time); a resume waits through a failed read and touches no session. |
| C. Malformed or partial read | Missing items, an id with no details or no privacy status count as incomplete and fail closed. | posting-auto-d375: five faults each reject. posting-e2e: a partial answer schedules nothing and uses no try. |
| D. One upload gate | `sendGated` applies the budget and records quotaExceeded. The chain is the only caller. | posting-e2e: blocked means nothing is sent; a quota answer saves the wait until the next Pacific midnight. |
| E. Lock takeover and read deadline | Heartbeat every 5 s. Takeover only if the pid is gone or the beat is older than 2 min. A 30 s read deadline aborts the request and counts as incomplete. | posting-e2e: a live holder is not taken over; a dead pid or a stopped beat is; a beating holder holds; `held()` turns false when the file is lost. posting-auto-d375: the deadline aborts; 3 deadlines fit in the lock lifetime. |

Quota sum (worst case, shipped values, 10,000 units a day and a 100-unit read reserve). One channel read costs
1 (channels.list) + 2 per page of 50 uploads (playlistItems.list + videos.list). With `maxPages` 40 that is 81 units
at most. All 81 are reserved before the read and the unused part is given back. One read is made per upload session.

| Model | Per upload | Uploads a day that fit |
|---|---|---|
| upload-bucket | 50 (cover) + 81 (read) = 131 | floor(9,900 / 131) = 75, so 24 (the 60-min gap; bucket 100) |
| unit-sum (fallback) | 1,600 + 50 + 81 = 1,731 | floor(9,900 / 1,731) = 5 (was 6) |

A channel with fewer uploads costs less: for example, 200 uploads is 4 pages, which costs 9 units per read. The
"Post now" read costs the same. The per-pass status checks for the delete (1 unit each) come out of the reserve, as
before.

Test runs after the fixes (one file at a time, `UJWALAM_HEADLESS=1`, BelowNormal, temp `UJWALAM_DATA_ROOT`, live
check exit 0):

All 25 files PASS (exit 0), again after the second review (plus learning-signals): posting-auto-chain, posting-auto-d375, posting-auto, posting-backlog-order,
posting-custom-schedule, posting-e2e, posting-live-check, posting-oauth, posting-preview, posting-pt1-text,
posting-pt2-hard-gap, posting-pt3-actions, posting-random-daily, posting-rules-in-data, posting-schedule,
posting-uploads, posting-youtube-cli, posting-youtube, posting, studio-ui-posting-auto, studio-ui-posting-queue,
studio-ui-posting-youtube, studio-ui-posting, studio-qml-posting, studio-qml-posts.

## Third Codex review (2026-11-21)

| Item | Fix | Test |
|---|---|---|
| 1. The read time was taken before the read | `readChannelSchedule` takes a clock and reads it after the last page (`readAt`). Public videos from the last 2 days count with no upper bound. The chain plans from `readAt`. | posting-auto-d375: a video public at T0+1 min, with the page back at T0+2 min, is in `recent` and `readAt` is T0+2 min. posting-e2e: the same through the chain; the slot keeps the 6 h test gap from it. |
| 2. Malformed page token, public video without a time | A present but bad `nextPageToken` (null, number, '', object) is incomplete. A public video with a missing or invalid `videoPublishedAt` is incomplete. | posting-auto-d375: 4 bad tokens and 4 bad times reject with `schedule-read-incomplete`. posting-e2e: a null or invalid time means no upload, no slot and no try used. The test fakes now give public videos a time. |
| 3. Takeover was not atomic | The stale file is renamed to a unique tombstone, compared with the exact content judged stale, then deleted. A file that does not match is put back with an exclusive create. Release does the same. The heartbeat uses `r+` and never re-creates the file. `held()` is checked after every read, before a session starts or resumes, in `beforeNewSession` and before every chunk. | posting-e2e: 2 spawned node processes (`windowsHide`) contend for a dead-pid lock, 3 rounds, exactly one wins each round. A lock taken over during the channel read means no session, `schedule-busy`, and the other lock is left alone. The earlier lock tests still pass. |
| 4. No request deadline | `timedFetch` in `youtube.mjs` settles at the deadline even when the fetch ignores the abort. The session start, progress query and thumbnail get 60 s and each chunk gets 10 min. The scheduled chunk deadline is kept. `request-timeout` waits 5 min with no try used. `withScheduleLock` has `maxHoldMs` (60 min): at the cap it aborts, releases the lock and rejects with `schedule-hold-cap`. | posting-e2e: a hung session start (100 ms deadline) leaves the item waiting, frees the lock, and the next tick posts. A hung chunk and then a hung progress query each time out with the session kept, then it resumes on the same session. With a 1 h request deadline and a 300 ms cap, the pass ends at the cap, the lock is released and the next tick posts. |

Test runs after the third review (one file at a time, `UJWALAM_HEADLESS=1`, BelowNormal, temp `UJWALAM_DATA_ROOT`, live
check exit 0): all 25 files listed above pass (exit 0), plus learning-signals. Counts: posting-auto-d375 51,
posting-e2e 55.

## Fourth Codex review (2026-11-21)

| Item | Fix | Test |
|---|---|---|
| 1. Stale-lock takeover racy with 3 contenders | One sender by design: only the studio's chain sends (`uploadPost` has no other caller; the CLI and the Upload button only queue and write the run-now file). An in-process mutex serialises passes. The file lock only guards against a second sender process: a lock that is not provably ours is refused with `sender-elsewhere` and a plain-words notice, never taken over. A dead-pid lock is replaced only by the process that will hold it, under an exclusive claim for that exact lock and an exclusive create; any failure refuses. Tombstone, heartbeat and stale-age logic removed. | posting-e2e: a live other holder and unreadable content are refused and left untouched; a dead holder's lock is replaced; a taken claim refuses; a second in-process pass waits, then runs; no claim or tombstone files left. The chain with another live process's lock: `sender-elsewhere`, no try used, nothing sent, the lock left alone. Spawned processes: the second process refuses while the first holds; 3 contenders on a dead lock, 3 rounds, exactly one wins each round. |
| 2. Untimed status request; body reads without deadline | `timedFetch` runs the fetch and a `read` step (body, headers) under one deadline. Used by the session start, progress query, every chunk, the cover and `checkUploadStatus`. | studio-ui-posting-youtube: `checkUploadStatus` with a hung request and with a hung `json()` both end with `request-timeout`. |
| 3. Fixed 10-min chunk deadline | `chunkTimeoutMs(bytes, floorBps, slowestBps)` = bytes at the slower of `fallbackKbps` (data) and the slowest measured chunk, plus `REQUEST_MS`. A chunk timeout queries Google: measured progress resumes from Google's count with no try used; no progress waits (`request-timeout`, no try). | studio-ui-posting-youtube: `chunkTimeoutMs` grows with size and with a slower measured speed, never below the floor; a hung chunk after 100 bytes arrived resumes (`init, chunk, query, chunk`, no retry wait); with no progress it stops after one query. |

Single instance: the launcher has no single-instance guard (searched `services/studio-ui/launch.mjs` and the repo). A
second studio on the same data folder is refused by the file lock, not prevented from starting.

Test runs after the fourth review (one file at a time, `UJWALAM_HEADLESS=1`, BelowNormal, a fresh temp
`UJWALAM_DATA_ROOT` per file, live check exit 0 before each file): all 23 `posting*` and `studio-ui-posting*` files,
studio-qml-posting (12), studio-qml-posts (4) and learning-signals (10) pass with exit 0. Counts: posting-e2e 56,
posting-auto-d375 51, studio-ui-posting-youtube 11.

## UNVERIFIED

- Fourth review: (1) a leftover claim file (a crash between the claim and the exclusive create, a few lines of code)
  blocks the dead-lock path for that exact lock; every pass then refuses with the notice until the file is removed by
  hand. (2) Windows pid reuse can make a dead holder's pid look alive: the pass refuses (safe side), notice shown.
  (3) The floor speed (`fallbackKbps` 1000) and the `REQUEST_MS` margin are not measured on the real link.
  (4) `oauth.mjs` token requests and `schedule-read.mjs` page reads were not changed here: the read is covered by its
  30 s whole-read deadline; the token refresh was not reviewed for a deadline.

- Third review: (1) A pass stopped at the hold cap keeps running in the background until its aborted request
  settles. It cannot send any more because `held()` is false and its requests are aborted, but it can still update its
  own queue item. (2) Reading a response body (`res.json()`) after the headers arrive has no deadline of its own; the
  hold cap covers it. (3) A tombstone that is put back is written again, not renamed, so its mtime changes. That only
  happens when a lock was judged stale. (4) Node's `renameSync` replaces an existing target on Windows; the tombstone
  names are unique, so the target never exists. The 60 s, 10 min and 60 min values are not measured on the real link.

- Codex fixes, residual risks. (1) A public upload that runs much slower than its estimate (bytes at half
  fallbackKbps) could end within 60 min of a slot that was already given out after the estimated end. Before each
  session the chain checks again and moves a slot whose session has not started, but a session that has already started
  cannot be moved. (2) When the send fails, the hold is given back. If Google had in fact received the video and the
  answer was lost, its time is not held. (3) The lock was tested in one process (the chain and the studio share a
  process in the launcher); taking over a lock across processes when a pid has died is not tested. (4) A complete
  read of the whole channel was tested only on fakes up to 2,000 uploads; the real channel's upload count, and so its
  read cost, has not been measured.

- The real numbers of Google's separate upload allowance (100 a day, about 50 units per cover), and which error reason
  Google sends when it is used up.
- Second review: a queued clip from the Upload button is sent only when auto-post is on and its rules allow uploads.
  The lock takeover across two real processes (dead pid, stopped heartbeat) is tested with a fake pid in one process
  only. The 30 s read deadline is not measured against the real channel.
- Text quality on real clips: facts reach uploads.json only for clips published after this change, and older drafts
  get facts only where their uploads.json row has them.
- The Posts window buttons have not been clicked in the running studio. Only the probe-driven QML tests ran.

## Not done

- PT5 (the post text card in Settings: tone, emoji, hashtags, footer, a growth toggle) and PT4 (growth suggestions
  from AN1) are not built yet.
