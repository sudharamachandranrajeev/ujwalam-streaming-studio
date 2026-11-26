# Instagram winners: Reel insights, score, weekly promoter to YouTube (2026-11-26)

Result: **PASS** on fakes (unit and chain tests). **Awaiting live test**: no real Meta call was made; the metric names
and units below are UNVERIFIED against a real account.

User decision 2026-11-26: Instagram is the test bed; every week the best Reels of the week before go to YouTube.

## What was built

- `data/posting/instagram.json`: scope `instagram_manage_insights` added (reason in `$comment`). Connect already uses
  `auth_type=rerequest`, so the next Connect asks for it.
- `services/posting/instagram.mjs`: Connect now saves the granted permission names with the token (from
  `/me/permissions`); `status()` adds `insightsAllowed` (true / false / null = sign-in from before this change).
- `services/analytics/instagram.mjs` (new): insights reader, SQLite store `<data>/analytics/instagram.db`
  (reels, snapshots, promotions, meta), `reelScore`, `ranking`, `weeklyWinners`, `igScores`.
- `services/posting/auto-post.mjs`: `instagramWinnerCandidates()` returns this week's recorded winners; new rules key
  `youtubeWinnersPerWeek` (1..7 x max per day, default 21).
- `services/posting/auto-chain.mjs`: in `youtubeSource: "instagram-winners"` mode the chain reads the insights first
  (at most once an hour, only when Instagram is connected and no stream is live or starting), then queues the winners.
  The existing upload slot logic and daily caps spread them over the week.
- `services/posting/schedule-manager.mjs`: every row has `igScore`; the view has `nextWeekToYoutube` (dry-run preview).
- `services/analytics/cli.mjs`: `instagram fetch [--force] | show [--json] | winners [--dry-run] [--json]`
  (needs the `instagram-autopost` flag).

## Metrics asked (GET /{media-id}/insights?metric=...)

| Metric | Use | Status |
|---|---|---|
| `views` | reach base | UNVERIFIED (replaced `plays` / `ig_reels_aggregated_all_plays_count` in 2025) |
| `reach` | reach base | UNVERIFIED |
| `likes`, `comments`, `saved`, `shares` | engagement | UNVERIFIED |
| `total_interactions` | stored only | UNVERIFIED |
| `ig_reels_avg_watch_time` | watch ratio (read as milliseconds) | UNVERIFIED name and unit |
| `ig_reels_video_view_total_time` | stored only (milliseconds) | UNVERIFIED |

If Graph refuses the full list with error 100, the core list (`reach, likes, comments, saved, shares,
total_interactions`) is asked instead. Error 10/200 (permission) -> `insights-scope-missing`. The answer is read from
`values[0].value` or `total_value.value`.

## Score (at the first snapshot 48 h or more after posting)

```
reach  = max(views, reach, 1)
watch  = min(avg watch time s / Reel length s, 2)          0 when unknown
engage = min((likes + 2 comments + 3 saves + 4 shares) / reach, 1)
score  = log10(1 + reach) * (2 * watch + 10 * engage)
```

Window: Reels posted 9 to 2 days before Monday 00:00 local (7 days of posts, each with full 48 h numbers). Weekly run:
the first chain pass on or after Monday 00:00 local; winners are recorded in `promotions`, never promoted twice. A
winner whose package is already uploaded (on YouTube or held by `hold.mjs`) is skipped as `on-youtube`; putting a held
video back on a schedule is not built (needs a quota-checked YouTube update; left for later). Formula weights are agent
defaults, not user instructions.

## Commands and output

```
node --test tests/instagram-winners.test.mjs tests/posting-hold.test.mjs tests/posting-instagram.test.mjs
ℹ pass 55
ℹ fail 0
```

```
node --test tests/analytics.test.mjs tests/instagram-live.test.mjs tests/instagram-winners.test.mjs tests/posting-auto-chain.test.mjs tests/posting-instagram.test.mjs tests/posting-pt4-growth.test.mjs tests/studio-ui-growth.test.mjs tests/studio-ui-posting-instagram.test.mjs tests/studio-ui-schedule-manager.test.mjs (+ three studio-qml-* files, headless)
ℹ pass 132
ℹ fail 0
```

`tests/instagram-winners.test.mjs` covers: insights parsing; full list then core list on error 100; permission refusal;
bad media id never sent; missing scope and not connected fail before any request; hourly limit; 48 h and 7 d
checkpoints; old Reels not read again; rate limit stops the run; deleted Reel counted failed; score ordering (watch >
likes, shares/saves > likes, reach scales, watch cap); window and reasons; top N; same week returns the same list; next
week never repeats; dry run records nothing; default 21; rules key; the chain queues the winner and not the loser;
scheduling-manager `igScore` and `nextWeekToYoutube`; CLI flag-off exit 3 and dry run.

## Not checked

- Real Graph API answers (names, units, availability for Reels under 48 h). UNVERIFIED.
- Whether Meta grants `instagram_manage_insights` to the app in development mode without review. UNVERIFIED.
- Studio UI showing `igScore` / `nextWeekToYoutube` (view data only; no QML change).
- Un-holding YouTube videos that won on Instagram.
