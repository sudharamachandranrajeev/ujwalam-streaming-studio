# Scheduling manager window, 2026-11-25

Status: **approved**; SM1-SM4 built 2026-11-26 (evidence: docs/evidence/2026-11-26-scheduling-manager.md); SM5 built 2026-11-26 (evidence: docs/evidence/2026-11-26-youtube-multi-channel.md).

## Request

"The NEXT POSTING TIMES list is in Settings and, since it is extremely long, the UI is laggy and took ages to find
Instagram Reels settings. Move it to a scheduling manager like the task manager, which can have its pop-out feature as
well, to manage the scheduled items there."

## Cause

`SettingsPosting.qml` (card "NEXT POSTING TIMES", ~line 1205) draws every scheduled post as a Repeater row inside the
Settings page, which is one long scrolling Column. With hundreds of scheduled posts (a year of hourly slots, up to 100
a day) every row is a live item, so the page is slow to open, scroll and lay out, and the settings below the list
(Instagram Reels) are far down.

## Plan

| # | Step | Done when |
|---|------|-----------|
| SM1 | **Remove the list from Settings.** The card becomes one short line: the count of scheduled posts, the next post time, and a button **Open scheduling manager**. Instagram Reels and the other settings move up. Settings stays fast with any number of posts. | QML probe: Settings has no per-post Repeater; open time of the Posting page with 500 scheduled posts is under a budget. |
| SM2 | **Scheduling manager window** like the task manager (D442): a panel opened from the on-air bar (a "Schedule" chip or More menu) and from the Settings button, with **Open in own window** (pop-out) and **Dock**, same behaviour as `TaskCenter` / `TaskWindow`. | Same open/dock/own-window tests as the task manager. |
| SM3 | **The list.** A virtualised `ListView` (only visible rows exist), grouped by day with day headers, with the target (YouTube Shorts, YouTube video, Instagram Reels), the time, the clip name, and the state in plain words (waiting, uploaded and scheduled, posted, failed with the reason). Search box, filter by target and state, sort by time. Rows update by id, never rebuilt on every status read. | 1000-row probe stays inside a frame and memory budget; filters and search tests. |
| SM4 | **Manage items there.** Per row and for a selection: **Move** (new time), **Remove from queue**, **Post now** (never while live), **Retry** for a failed one. The existing routes and checks are reused (`autopostMove` / `autopostRemove`: one click, no typed confirmation, D332). Bulk: move a day's posts, remove all failed. | Route tests per action; undo for bulk moves. |
| SM5 | **Multi-channel ready.** When several YouTube channels exist (plan `2026-11-25-youtube-multi-account.md`), the list shows the channel per row and filters by channel. | Filter test with two channels. |

Order: after the studio slowness fix and the alpha.44 push; the Settings change (SM1) goes first because it fixes the
lag the user sees now.

## Notes

- Data comes from the same schedule read the Settings list uses (`ap.times`); no new posting logic.
- Loading is lazy: the window reads the schedule only when open, one read per open plus changes pushed on status.
- A day's posts and times are the user's own data; tests use placeholder clips.
