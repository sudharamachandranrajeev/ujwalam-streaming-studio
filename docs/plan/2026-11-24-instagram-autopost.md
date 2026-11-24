# 2026-11-24 — Instagram Reels autopost (D444)

Approved by the user 2026-11-24 ("approve plan, same clips as Shorts, maximum allowed posts a day").

## Facts (checked 2026-11-24)

- Instagram Graph API with Facebook Login: a Reel is a container (`POST /<IG_USER_ID>/media`, `media_type=REELS`,
  `upload_type=resumable`), the video bytes go from this PC to `rupload.facebook.com/ig-api-upload/<version>/<container id>`
  (headers `offset`, `file_size`), the container's `status_code` is polled until `FINISHED`, then
  `POST /<IG_USER_ID>/media_publish`. No public video URL needed. Source:
  https://developers.facebook.com/documentation/instagram-platform/content-publishing (checked 2026-11-24).
- Limit: 100 API-published posts per account in a moving 24 h window; the remaining count is read from
  `GET /<IG_USER_ID>/content_publishing_limit` before each post. Same source, plus
  https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ .
- The API has no scheduled publish: Ujwalam publishes each Reel itself at its time (the app must run).
- Caption: 2200 characters, 30 hashtags, 20 mentions (`data/posting/limits.json`, target `instagram-reels`).
- Permissions: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`. An app in
  development mode posting only to accounts with a role on the app needs no Meta app review: UNVERIFIED until the
  user's first real post.

## User decisions

1. Same clips as YouTube Shorts: every clip the auto-post chain sends to Shorts also goes to Instagram Reels.
2. Posts a day: the maximum Meta allows (100 per moving 24 h, read live from the API). Ujwalam adds no lower cap; posts
   are still at least the auto-post gap apart, and never while a stream is live or starting.

## Phases

| Id | What | Done when |
|---|---|---|
| IP1 | `services/posting/instagram.mjs`: Facebook Login (localhost redirect like the YouTube sign-in), App ID/secret and tokens in Windows Credential Manager only, long-lived token renewed before expiry; finds the IG user id through the linked Page; container, resumable upload, status poll, publish; reads `content_publishing_limit` first. CLI: `node services/posting/cli.mjs instagram signin|status|post <package>`. | Tests against a fake Graph/rupload server pass (upload bytes, offsets, poll, publish, limit reached, expired token, error answers). |
| IP2 | Auto-post chain: each Shorts clip gets an Instagram job; its own time (first free slot at least the gap from other IG posts, within the moving-24 h limit); missed times post at the next start; never while live. The clip file is never deleted (flag post-delete-uploaded) until every target that wants it has posted it. | Chain tests: Shorts + IG both posted before delete; IG failure keeps the file; live blocks IG. |
| IP3 | Settings > Posting & growth: Instagram section (Connect, App ID/secret boxes, on/off, status), the posts list shows Instagram state per clip. Flag `instagram-autopost`, ON (user-requested), does nothing until connected. | QML probe test of the section; flag in data/flags.json. |
| IP4 | Evidence doc; setup notes for the user (Meta app, Page link, permissions); first real post only after the user's yes. | Evidence file; real post confirmed by the user. |
