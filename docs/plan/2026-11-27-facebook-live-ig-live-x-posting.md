# Facebook Live, Instagram Live setup and X posting (2026-11-27, PLAN, waits for the user's yes)

User (2026-11-27): "implement instagram and facebook streaming; implement autoposting to X". Interview answers:

- Instagram Live: guided paste each stream (Instagram's API gives apps no Live key). Facebook Live: automatic key.
- Facebook target: a Facebook Page.
- Shapes: Instagram gets the vertical 9:16 canvas, Facebook the horizontal 16:9 canvas.
- X: free API tier, text + link only (no video upload, no spending). Every clip that goes public gets one X post.
- X setup: Ujwalam walks the user through making the free X developer app.

Facts marked UNVERIFIED are checked against the official docs at build time and recorded in `data/platforms/*.json`
with source and date (AGENTS.md: platform limits are data, never hardcoded).

## 1. Facebook Live (Page, automatic key)

- Sign-in: reuse the existing Meta app and Connect flow that Instagram posting uses (Settings > Posting & growth).
  Add Facebook Page Live permissions (UNVERIFIED names: `publish_video`, `pages_manage_posts`, `pages_read_engagement`,
  `pages_show_list`). Page token in Windows Credential Manager only.
- Each Go Live with Facebook ticked: `POST /{page-id}/live_videos` (status LIVE_NOW, title/description from the stream
  template) returns `secure_stream_url`; the key goes straight to the delivery sink in memory, never to a file or log.
- Stream end: `POST /{live-video-id}` with `end_live_video=true`; on crash, the next start ends any left-over live video.
- Output: a new `facebook` sink bound to the H canvas, on the shared re-encoded rung that already feeds Twitch/Kick if
  Facebook's limits allow it (UNVERIFIED: 1080p60, up to ~9 Mbps, keyframe 2 s); else its own rung from the H canvas.
- `data/platforms/facebook.json` with limits, source, checked date.
- Go Live chooser: Facebook card, on/off per stream; live status from the Graph API (read only).
- Feature flag `facebook-live` (requested feature: ships on, visible switch).

## 2. Instagram Live (guided paste, vertical)

- Today: the `instagram` sink exists but needs server + key in Credential Manager set by CLI, so it is always left out.
- New: in Go Live, the Instagram card has "Set up Instagram Live": opens instagram.com Live producer in the browser,
  and one paste box that accepts the copied stream URL + key (or each separately), checks the format (rtmps://),
  and stores them in Credential Manager for this stream only (cleared at stream end, since Instagram keys are one-time).
- Bound to the V canvas. Instagram limits in `data/platforms/instagram.json` re-checked (UNVERIFIED: 720x1280 or
  1080x1920, 30 fps, ~3.5-6 Mbps).
- Reminder text: Instagram Live must also be started with "Go live" on instagram.com after Ujwalam sends video.

## 3. X posting (free tier, text + link)

- Settings > Posting & growth > X: "Connect X" with a step-by-step guide to create the free developer app
  (developer.x.com), callback `http://127.0.0.1:<port>/x/callback`, then OAuth 2.0 PKCE sign-in (UNVERIFIED scopes:
  `tweet.read tweet.write users.read offline.access`). Client id and tokens in Credential Manager.
- When a YouTube Short or Instagram Reel goes public, queue one X post: the clip's post text (shortened to X's limit)
  + the public link. Same queue rules as Instagram: one at a time, gap between posts, live guard, retries with a
  ceiling, failure never blocks the rest (the lesson from the Instagram queue fix).
- Free-tier post limit is data (`data/platforms/x.json`, UNVERIFIED: ~500 posts/month per app, ~17/day); the queue
  spreads posts to stay under it and says so in plain words when the month's allowance is used up.
- Feature flag `x-autopost` (on, visible switch); never posts without the user's Connect.

## 4. Order, proof, risks

Order: X posting (no live risk) -> Instagram Live paste flow -> Facebook Live (touches the live path and the encoder
graph: Opus builds, independent Opus review, loopback ffprobe assertions before any real platform).
Proof: unit tests with fake Graph/X servers; loopback ffprobe of the facebook and instagram sinks; then one real test
stream only after the user says "start stream test"; one real X post only after the user's yes.
Risks: Meta app review may be needed for Page Live permissions on a public app (dev mode works for the app's own
admins, UNVERIFIED); X free tier terms change often; extra output adds NVENC load (probe sessions at runtime).
User steps needed: Facebook re-connect with new permissions; create the X developer app; first real stream test.
