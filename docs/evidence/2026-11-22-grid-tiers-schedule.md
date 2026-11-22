# 2026-11-22 Auto-post: hourly slot tiers, 100 uploads a day, channel read reuse (D434)

Status: tests pass; real-channel use UNVERIFIED.

## What was built

- `services/posting/schedule.mjs`: placement `grid-tiers` (shipped default), `gridCandidates` (local hours at a minute
  offset, DST-safe, one zone lookup per normal day), `planGridTiers` (earliest free slot of tier 0 across the whole
  rolling window, then tier 1, ...; cursor per tier and floor, binary search over sorted taken times), `gridProblem`
  (slot minutes and gap checked together), new user keys `tierOffsets`, `gridGapMinutes`, `readReuseMinutes`. The
  60-minute floor is skipped for grid-tiers only (`loadScheduleConfig`, `slotClash`).
- `services/posting/auto-post.mjs`: `MAX_PER_DAY` from `data/posting/quota.json` `maxUploadsPerDay` (100).
- `services/posting/quota-budget.mjs`: `uploadsFit` (cover units per upload, reads per reuse period, never more reads
  than uploads), `readModel`; `loadQuota` returns `readUnitsPerRead`, `readReuseMinutes`, `readsPerDayMax`, `maxPerDay`.
- `services/posting/auto-chain.mjs`: `reusableRead` and `planFrom`: a complete saved read younger than
  `readReuseMinutes` plans slots and serves the next upload session without a new read; truncated, future-dated or
  broken saved reads are never reused.
- `services/posting/auto-settings.mjs`: the card carries and saves the three new keys.
- `app/studio/qml/SettingsPosting.qml`: placement "Hourly slots, a year ahead" with an explanation, Slot minutes, Gap
  between slots, Reuse the channel read for, Uploads at most (1..100) text; the fit line uses the server's sum; the
  slot minutes and gap are checked before Save.
- Data: `data/posting/schedule.json` (placement, tierOffsets, gridGapMinutes 15, readReuseMinutes 120, maxAheadDays
  365, source and checked date), `data/posting/quota.json` (maxUploadsPerDay 100, source).

## Test evidence

Commands (UJWALAM_HEADLESS=1, temp UJWALAM_DATA_ROOT):

- `node --test tests/posting-grid-tiers.test.mjs`: 12 pass, 0 fail. Covers tier order across the whole window in a
  half-hour zone (Asia/Kolkata: 47 tier-0 slots in a 2-day window before the first :15 slot), DST (Europe/London: 23
  slots on 29 Mar, 24 on 25 Oct, the missing 01:00 skipped), the rolling window and the cap, the gap rule with off-grid
  channel posts and queue times, a held slot kept or moved, performance (365-day window, 5000 taken times: 300 clips
  and a 3000-clip backlog well under the 2 s and 5 s limits), settings checks, old user files still loading, the fit
  sum (0 min = 21 a day, 60 min = 21, 120 min = 100, old unit sum = 4) and `reusableRead`.
- `node --test tests/posting-e2e.test.mjs` (fake Google): two new D434 cases: one read serves both sessions inside the
  reuse time (1 channels call, 2 uploads, slots 6 h apart); a saved read older than the reuse time is read again; a
  truncated read is never reused (nothing uploads, the next pass reads again).
- All `tests/posting*.test.mjs` and `tests/studio-ui-posting*.test.mjs`: see the run counts in the commit report.
- `tests/studio-qml-posting.test.mjs` (headless probe against the rebuilt studio): new D434 case (labels, help text,
  edits saved to the user's file, fit 21 with reuse 0, a gap wider than the slot distance refused, 101 a day refused).

## UNVERIFIED

- YouTube's 100-a-day upload bucket for this project (no day above 21 uploads has run).
- The real channel's read cost (about 81 units at the current channel size; 401 at the 200-page cap the fit assumes).
- The card on the laptop's screen (only the headless probe ran).
- The user's own saved settings (placement random-daily, 6 a day in the rules) override the shipped defaults until
  changed on the card.
