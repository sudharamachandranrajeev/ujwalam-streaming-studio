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

## UNVERIFIED

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
