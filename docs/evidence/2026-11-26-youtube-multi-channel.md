# Several YouTube channels for auto-posting (YM1-YM6, SM5), 2026-11-26

Plan: `docs/plan/2026-11-25-youtube-multi-account.md` (user answers 2026-11-25). Checked with fakes only: fake Google per
token, an in-memory token vault instead of Credential Manager, temp data folders, placeholder channels, no network, no real
sign-in, no real post. Studio not running (`node tools/live-check.mjs`: off air; no process from the installed copy).

## What was built

- **YM1 channel list** `<data>/posting/accounts.json` (written by the studio server only). No file = one channel, `main`,
  exactly as before. A queue item without an `account` field reads as `main`; nothing already queued or scheduled changes.
  A new clip starts in a pool (`account: null`) and the chain deals it to a channel. Defaults for added channels are data:
  `data/posting/channels.json` (3 to 6 a day, Shorts only, at most 20 a day per channel, at most 6 channels).
- **YM2 one sign-in per channel**: `main` keeps `Ujwalam/posting/youtube-refresh`; an added channel uses
  `Ujwalam/posting/youtube-refresh/<local id>`. The OAuth client is shared. After sign-in the server reads
  `channels.list part=snippet mine=true` (1 unit, counted in the shared budget) and refuses a channel already listed
  (the new sign-in is removed again).
- **YM3/YM4 taking turns**: `dealPool` gives pool clips to main, A, B, main... in queue order, skipping a channel that is off,
  paused, signed out, full for today, or (Shorts-only) a long video. Each added channel's count for a UTC day is a whole
  number in its range, picked from its id and the day. With several channels each channel uploads at most one clip per pass,
  the first channel rotating. The gap and the posting times hold inside each channel (own schedule read, own slots).
- **YM5 quota**: one budget object and one sender lock for all channels. An added channel's `uploadLimitExceeded` pauses only
  that channel until the next Pacific midnight and does not mark the project quota as used; a token failure pauses it for
  30 minutes. A paused, off or removed channel's waiting clips (no upload started) go back to the pool and to the others.
- **YM6 studio**: Settings > Posting & growth > YOUTUBE CHANNELS (list in plain words, Add channel with an optional name,
  Posting on/off, posts a day at least / at most, Remove). Routes `/ui/api/posts/channels[/add|/set|/remove]`; never a token.
- **SM5**: `/ui/api/posts/schedule/list` rows carry `channel` and `channelText`, the answer lists `channels`, and
  `?channel=<id>` filters. The scheduling manager shows a channel filter and the channel per row when there is more than one.
- Delete-after-upload checks the processed state with each channel's own sign-in.

## Commands and results

- `node --test tests/posting-multi-channel.test.mjs`: 15 pass (migration of an old folder and an old queue item, defaults
  as data, two separate tokens with sign-out of one, dealing in turn with caps and the Shorts-only rule, never past
  today's count, no clip twice and each with its own channel's token, a failing token skipped and its clips re-dealt,
  uploadLimitExceeded pausing only that channel with the project quota open, one shared budget counted once, removal).
- `node --test tests/studio-ui-channels.test.mjs`: 5 pass (old folder shows main only; Add channel, duplicate and main refused;
  on/off, range and name with plain-word refusals; Remove signs out, main stays; SM5 rows, channels and filter).
- `node --test tests/studio-qml-youtube-channels.test.mjs`: 4 pass (headless shell: the card with one channel, Add channel,
  on/off + range + Remove by probe clicks, SM5 channel per row and filter; no QML errors).
- Existing posting and studio-ui posting tests (`tests/posting-*.test.mjs`, `tests/studio-ui-posting*.test.mjs`,
  `tests/studio-ui-schedule-manager.test.mjs`) and the QML schedule, Instagram and posting probes: pass.

## Not done / UNVERIFIED

- UNVERIFIED: Google's Brand Account channel chooser on a real sign-in; YouTube's per-channel upload limit for new channels
  (the app reacts to the `uploadLimitExceeded` answer instead of guessing a number).
- Not per channel yet (YM3/YM7 partial): the posting window and gap settings are shared; the "Streamer:" name line uses the
  main channel's name; rewrite of scheduled posts, analytics and growth suggestions stay main-only.
- The rules' "uploads per day" is the total over all channels; main's own share is that number.
- YM8 (first real run) needs the user. Looks on a real screen not checked (headless only).
