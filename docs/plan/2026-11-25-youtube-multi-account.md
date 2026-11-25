# Several YouTube channels for auto-posting, 2026-11-25

Status: **proposed** (user request 2026-11-25). Building starts after the user answers the open questions below.
The user creates the new channels and says when they exist.

## Request

The user wants several YouTube channels in the app, each fed by auto-posting. New channels probably have a
lower posting limit, so each new channel posts **3 to 6 videos a day**.

## What changes

| # | Step | Done when |
|---|------|-----------|
| YM1 | **Accounts.** `<data>/posting/accounts.json` lists the channels: a local id, a label the user picks, on/off, and the date it was added. The channel id and handle come from YouTube on sign-in and stay in this local file only, never in the repo. The current channel becomes account `main`; every existing ledger, queue and rewrite record reads as `main`, so nothing already scheduled changes. | Migration test: an old data folder reads unchanged as `main`. |
| YM2 | **Sign-in per channel.** One refresh token per channel in Windows Credential Manager (`Ujwalam/posting/youtube-refresh/<account id>`; the current target stays as `main`'s). "Add channel" opens Google sign-in; for a Brand Account channel the user picks it on Google's channel chooser. After sign-in the app reads `channels.list mine=true` and refuses a channel that is already in the list. The OAuth client (id and secret) stays shared. | Fake-Google tests: two channels, separate tokens; sign-out of one leaves the other. |
| YM3 | **Per-channel posting rules.** Each channel has its own posts a day (a random number in a range each day; new channels default to **3 to 6**), posting window, gap, kinds of clip, and its own text settings (own tags, hashtags, footer, and the handle used in the "Streamer:" line). `main` keeps today's rules. | Schedule tests: a new channel never goes past 6 a day; `main` is unchanged. |
| YM4 | **Which clip goes where** (open question 1). The scheduler gives each clip to channels by the chosen rule. Each upload is recorded with its account, so one clip is never posted twice to the same channel. | Chain tests with two channels and the chosen rule. |
| YM5 | **Quota.** YouTube's API quota belongs to the Google Cloud project, not to the channel: with one shared OAuth client, every channel shares one daily quota (10,000 units now). The quota budget counts per project and splits the day's uploads fairly between channels; a channel that hits its own "too many uploads" answer from YouTube pauses until the next Pacific midnight, and the others keep posting. Open question 3 decides one project or one per channel. | Budget tests: shared quota, one channel paused, the others go on. |
| YM6 | **Studio.** Settings > Posting & growth > **YouTube channels**: the list (label, signed in or not, posts today, next post), **Add channel**, a per-channel **Posting on/off** switch, the 3-6 range, and **Remove** (signs that channel out; videos already on YouTube stay). The Posts window shows which channel each post goes to. Plain words, no layout jumps. | QML probe test; screenshot evidence. |
| YM7 | **Other tools per channel.** Rewrite of scheduled posts, analytics, delete-after-upload and the growth suggestions work per channel. | Tests per tool with two channels. |
| YM8 | **First real run** (needs the user): one new channel, private uploads scheduled, check the first day's count and any limit message from YouTube. | Evidence in `docs/evidence/`. |

## Facts and limits (to check against Google's pages before YM5)

- API quota is per Google Cloud project (10,000 units a day by default); the separate upload bucket of 100 a day is UNVERIFIED for this project.
- New or unverified channels: YouTube can lower daily upload limits, and custom thumbnails and videos over 15 minutes need a phone-verified channel. UNVERIFIED for this account; the app must read YouTube's own answer (`uploadLimitExceeded`, `quotaExceeded`) and pause that channel instead of retrying.
- Posting the same video on several channels can count as repetitive or spam content under YouTube's policies, and may harm all of them. This is why open question 1 matters.

## Open questions for the user

1. Clips per channel: (a) each clip goes to one channel only, (b) split by kind or game (e.g. montages to one channel), or (c) the same clip to several channels (spam risk above).
2. Text per channel: same style for all, or each channel with its own tags, hashtags and footer?
3. Quota: all channels on the one Google Cloud project (shared 10,000 units), or one project per channel (more setup, separate quota)?
4. New channels: Shorts only, or the long highlights video too?

## Privacy

Channel ids, handles and labels live only in the local data folder; tokens only in Credential Manager. Tests use
placeholder channels. Nothing private is committed.
