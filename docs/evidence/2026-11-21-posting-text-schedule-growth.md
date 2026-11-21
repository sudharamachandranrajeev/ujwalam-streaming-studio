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
- "Schedule next free slot" queues the clip at least 1 h from every other post. "Post now (public)" sends
  `privacyStatus: public` with no publishAt. It is refused within 60 min of another post and while live or starting.
  `post.json` can never make a video public.
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

All 25 files PASS (exit 0): posting-auto-chain, posting-auto-d375, posting-auto, posting-backlog-order,
posting-custom-schedule, posting-e2e, posting-live-check, posting-oauth, posting-preview, posting-pt1-text,
posting-pt2-hard-gap, posting-pt3-actions, posting-random-daily, posting-rules-in-data, posting-schedule,
posting-uploads, posting-youtube-cli, posting-youtube, posting, studio-ui-posting-auto, studio-ui-posting-queue,
studio-ui-posting-youtube, studio-ui-posting, studio-qml-posting, studio-qml-posts.

## UNVERIFIED

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
- That a public upload with no publishAt goes live at once on a real channel. This needs one real post, which needs the
  user's yes.
- Text quality on real clips: facts reach uploads.json only for clips published after this change, and older drafts
  get facts only where their uploads.json row has them.
- The Posts window buttons have not been clicked in the running studio. Only the probe-driven QML tests ran.

## Not done

- PT5 (the post text card in Settings: tone, emoji, hashtags, footer, a growth toggle) and PT4 (growth suggestions
  from AN1) are not built yet.
