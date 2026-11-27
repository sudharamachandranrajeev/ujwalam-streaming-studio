# Post text reach (2026-11-27)

Problem (user, 2026-11-27): auto-posted text was vague, for example "Kill montage 9 from the stream on <date>. Live on <CHANNEL> Community: <CODE> #Shorts #montage". Little discovery value.

## What changed

- `data/posting/post-text-library.json`: hook-first titles and captions, CTA, live/community lines, core and rotating hashtags, per platform (youtube-shorts, instagram-reels, youtube-video, x as data only) and per clip kind (kill-streak, montage, beatdrop, clutch, victory, funny, fail, top5, long-highlights).
- `services/posting/reach-text.mjs`: deterministic draft from the library. Slots {game} {gameFull} {kills} {killsText} {result} {weapon} {mode} {map} {streamer} {channel} {community} {gameTag} {gameTag2}. A line whose slot has no value is never used. Titles over the platform title limit are never used. Lines and hashtags used lately are not repeated (history `text-history.json`, now the last 40 entries). Core hashtags are always kept; 1-3 more come from the rotating pool, so the total stays at 3-5.
- `services/posting/index.mjs` `packageUploads`: the library draft is the base text. With no library entry (or no usable line) the older text pools and templates are used as before. If the profile has no handle, the template's own live lines stay so the missing value is listed as unresolved (approval stays blocked, as before).
- `aiPost` (alpha.42 AI text): the library draft is sent to the local model as "adapt lightly" (`ai-text.mjs` `draftBlock`). The model's title is kept only when at least half of the draft's words survive (`keepsDraftTitle`); otherwise the draft title is used. Hashtags always come from the library; the CTA and live lines are always added. Model off or rejected: the draft is the text (existing fallback).
- `cleanFacts` also keeps `weapon` and `map` when a detector supplies them.
- Limits stay in `data/posting/limits.json` (title 100, description 5000 bytes, Instagram caption 2200, hashtag counts) and are checked by `checkLimits` as before.
- Not done: already uploaded posts (`rewrite.mjs`) and redrafts of old drafts keep their current text; X has no uploader, so its library entry is data only (status planned).

## Before and after (placeholders)

Before (YouTube Shorts, montage):

```
Kill montage 9 from the stream on 2026-11-11.

Live on <CHANNEL>
Community: <CODE>

#Shorts #montage
```

After (same clip, template path, no model):

```
Title: <GAME> montage: 9 KILLS cut to the beat

9 KILLS cut to the beat. Which one was your favourite?

Subscribe for more <GAME> clips.

Live on <CHANNEL>
Community: <CODE>

#Shorts #<GAME> #Montage #MobileGaming
```

## Research (web search 2026-11-27; the sources are mostly SEO and tool-vendor blogs, so numbers are medium trust)

- YouTube Shorts hashtags: only the first 3 description hashtags show above the title; 3-5 total including #Shorts is the common advice; hashtags are a minor factor next to content and title. Sources: https://hashtagtools.io/blog/youtube-shorts-hashtags-title-vs-description-2026 , https://sproutsocial.com/insights/?p=144315 , https://www.notelm.ai/blog/youtube-shorts-hashtags , https://www.lilachbullock.com/best-hashtags-youtube-shorts/ . The cut-off beyond which YouTube ignores all hashtags is reported as 15 by two blogs and 60 by one; YouTube's own help page (https://support.google.com/youtube/answer/6390658, already cited in limits.json) says 60. We stay at 5 or fewer, so either value is safe.
- Instagram Reels hashtags: official @creators advice is to cap at 3-5 (via https://sproutsocial.com/insights/instagram-reel-hashtags/); a 1.6 million post study found 4-5 tags reach best (https://www.fanpagekarma.com/insights/how-many-hashtags-should-you-use-on-instagram/); one vendor (https://recurpost.com/instagram-scheduler/instagram-hashtag-limits-and-placement-rules/) claims a hard 5-tag cap in the app since December 2025. UNVERIFIED: the hard cap. The Graph API limit (30) in limits.json is unchanged; the library recommends at most 5.
- Gaming Shorts hooks and titles: start the clip right before the payoff; text hook of about 3-5 words; keep the key words in the first ~40 characters of a title because mobile feeds cut titles early; formats such as "Top N" and "Can I clutch this" questions. Sources: https://clip.dor.gg/en/blog/gaming-shorts-viral-pattern , https://blog.eklipse.gg/beginner-guide-2/mastering-short-form-video-hooks.html , https://vidiq.com/blog/post/youtube-shorts-titles/ , https://oembed.org/blog/best-bgmi-shorts-descriptions-get . Our titles are hook-first and mostly 20-45 characters, soft limit 60 (Shorts, Reels) or 70 (long video) in the library.
- Indian mobile FPS: only BGMI sources were found (hashtag style #BGMIClutch, pairing the game tag with #MobileGaming; https://erp.blackboxoperations.com/blog/bgmi-youtube-hashtags-boost-your ; posting in the evening IST is advised by https://fluxnote.io/guides/start-mobile-gaming-youtube-channel-india). UNVERIFIED: any CODM-specific, Malayalam or Hinglish title and hashtag data. Not found, so the library is English only and the tag pools are generic (#MobileGaming, #MobileFPS, #Killstreak, #Clutch). Needs the user's own analytics (data/posting/growth-timing.json and the weekly winners) to tune.
- X (Twitter) hashtag count (1-2) is UNVERIFIED, from general practice; the target is data only.

All the wording in the library is our own; no text was copied from the sources. No logins were used.

## Tests

- `tests/posting-reach-text.test.mjs` (new): library shape and no real names, draft content, missing slots, hashtag rotation and core, title limit, Instagram count, platform limits via `checkLimits`, light AI adaptation through `aiPost`.
- Updated expectations for the new text: `tests/posting-uploads.test.mjs`, `tests/posting-ai-text.test.mjs`.
- Run on this branch (single files, no CI): posting, posting-ai-text, posting-ai-text-check, posting-auto, posting-auto-chain, posting-game-text, posting-hold, posting-instagram, posting-multi-channel, posting-pt3-actions, posting-pt5-settings, posting-preview, posting-reach-text, posting-rewrite, posting-schedule, posting-uploads, posting-youtube, studio-ui-posting-queue: 0 failures. The full CI was not run (it runs in the main checkout).

## Files

data/posting/post-text-library.json, data/posting/templates.json (recentLines 40), services/posting/reach-text.mjs, services/posting/index.mjs, services/posting/ai-text.mjs, services/posting/post-text.mjs, tests/posting-reach-text.test.mjs, tests/posting-uploads.test.mjs, tests/posting-ai-text.test.mjs, this file.
