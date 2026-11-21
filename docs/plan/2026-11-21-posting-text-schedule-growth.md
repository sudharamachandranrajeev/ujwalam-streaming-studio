# Posting: clip-aware text, open schedule limits, manual run, growth-led timing (plan, 2026-11-21)

Status: user request 2026-11-21 after installing alpha.36 (scheduled posts appear in YouTube Studio). Queued right
after the long highlights video branch (`claude/long-video`), which touches the same posting files
(posting/index.mjs kinds, auto-post.mjs, SettingsPosting.qml). Phases PT1–PT5.

## 1. The user's words

"the title and description of the post is too generic. it needs to be drafted according to the type of clip, type of
game and type of gameplay. cannot increase the number of posts a day in settings. youtube permits upto 100 uploads a
day. app needs to check the already existing schedule in youtube studio so that the post won't clash with the existing
one's. add customisable settings in posting. add the ability to do manual posting run. only not allowed rul should be
- if there is scheduled video exists - the new schedule videos should only come 1 hr before or after the already
scheduled one and that slot needs to cross schecked as well to keep the gap between video schedule is an hour.
according to the perfomaance mtrics from youtube, Ujwalam can suggest which would be a better time to post and can ask
user's approval for posting schdule tweak for better reach and growth and find optimum schedule timings as well
overtime."

## 2. What is there today

- Text: `data/posting/templates.json`, one fixed title per kind ("Stream highlight {n} ({date})"), placeholders only
  {n}, {date}, {handles.x}, {links.x}. No clip facts, no game, no gameplay.
- Posts a day are capped in three places: the random-daily spinner (1–24, `SettingsPosting.qml`), the rules file
  (`maxPerDay` 1..10), and the quota sum in `data/posting/quota.json` (insertUnits 1600 of 10000 units = 6 a day).
  Google's quota page (fetched 2026-11-13) says videos.insert now has its own bucket of 100 calls a day at 1 unit;
  the file still assumes the old 1600-unit cost (UNVERIFIED for this project).
- Clash check: already built. Every pass reads the channel's uploads (private videos with a future publishAt,
  `schedule.mjs` futureTimes) plus the queue, and keeps minGapMinutes (90) from each. The gap floor in Settings is 15.

## 3. Changes

### PT1 Clip-aware titles, descriptions, tags (local, no paid API)
- Facts per post from the clip's own records: kind (short, montage, won reel, impact play, long highlights), game
  (`data/games/<id>/`), mode and map (OCR), kills, streak / medal names, multi-kill spacing, match result, round,
  clutch (last alive), weapon if detected, session date. Only facts with evidence are used; a missing fact drops the
  line that needs it, never a guess.
- Reuse: `services/clip/reel_thumbnail.py facts(reel)` already returns the known {medal, killsText, result, mode}
  for each reel (medal from the detectors, result and mode from matches.json); clip_publish carries them into
  post.json `source.facts` instead of computing them a second time. The game id comes from the session's game profile.
- Text pools as data: `data/games/<id>/posting.json` (per game: names of modes, medals, hashtags, tags) and
  `data/posting/templates.json` v2 (per kind: many title and description lines, each naming the facts it needs).
  Seeded pick, no-repeat-last-N over the last posts (settled "Pools" rule); title within YouTube's length limit from
  `data/platforms/`; "#Shorts" only on Shorts.
- Settings > Posting & growth > Post text: edit the lines per kind and game, preview on the newest clips, tone
  (hype / clean), emoji on/off, own fixed hashtags and description footer (handles and links from the profile).
- Existing drafts that are still unscheduled are redrafted once with the new text (scheduled ones are left alone).

### PT2 Open limits; the one hard rule
- The only fixed rule: a new slot is at least 60 minutes before or after every other scheduled time: videos already
  scheduled on the channel (read live from YouTube before each pass, as now), Ujwalam's queue, and the other slots of
  the same pass. Each chosen slot is re-checked against the channel read just before its upload session starts; a
  clash moves it to the next free slot.
- Everything else is the user's setting: posts a day up to 24 (the 1 h gap allows no more in a day; up to 100 uploads
  a day is YouTube's ceiling, and the ceiling here is the gap), window 00:00–24:00, gap 60–1440 min, days off, per-kind
  daily share. Rules file `maxPerDay` range raised to match.
- Quota: default to the separate upload bucket (100 a day, 1 unit); if YouTube answers quotaExceeded, the app falls
  back to the unit sum, says so in plain words, and retries the next day. The Settings quota line shows which model is
  in use.

### PT3 Manual posting run
- "Run auto-post now" in Settings > Posting & growth and the task bar: one pass at once (scan, draft, schedule,
  upload), same rules, never while live or starting.
- In the Posts view, per clip: "Schedule next free slot" and "Post now (public)". Both are one click (D332).

### PT4 Growth-led timing (needs the growth flag's read-only statistics permission)
- From YouTube Analytics (AN1, read only): views in the first 24 h and 7 days, average viewed %, subscribers gained,
  by publish hour and weekday, per kind. Viewer activity by hour where the API gives it (UNVERIFIED which report).
- Suggestions only: with at least 8 posts with numbers, the app proposes a schedule change ("move 2 of your daily posts
  to 18:00–21:00: +34 % 24 h views on 12 posts") with the numbers behind it. One click Apply / Dismiss in the Posts
  view; nothing changes without that click. Each applied change is logged and can be undone.
- Over time: a small exploration share (at most 1 in 5 slots) tries times outside the best ones, so the estimate keeps
  learning (Thompson sampling, as RP5); limits in a data file.

### PT5 Settings card "Posting" (customisable)
One place for: posts a day, window, gap (60+), days off, per-kind share, post text (PT1), quota model, manual run,
growth suggestions on/off. Save / Discard, plain words, no layout jumps.

## 4. Done when (evidence in docs/evidence/)
| Phase | Done when |
|---|---|
| PT1 | drafts for each kind and the user's game name real facts; no line with a missing fact; length limits pass |
| PT2 | a channel with hand-scheduled videos: no new slot within 60 min of any; 24 a day possible; quotaExceeded falls back |
| PT3 | manual run refused while live; per-clip schedule and post-now work against the mock and once for real (user's yes) |
| PT4 | suggestion math tested on fixture numbers; nothing applied without the click; undo works |
| PT5 | settings round trip; QML tests |

Real posts made while testing count as real posts: the user's yes first (AGENTS.md ask list).
