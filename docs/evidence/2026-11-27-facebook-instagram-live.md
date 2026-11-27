# Facebook Live and Instagram Live in Go live (D447), 2026-11-27

Plan: `docs/plan/2026-11-27-facebook-live-ig-live-x-posting.md` sections 1 and 2. Branch `feat/fb-ig-live`.

Status: unit tests PASS. Loopback ffprobe: PENDING (waits for the user's go). Real stream: PENDING. Not done until both pass.

## What was built

- Facebook Live to a Page: Meta connect asks for `pages_manage_posts` too; Page pick; at Go live `POST /{page-id}/live_videos` (status LIVE_NOW, title and description from the template); `secure_stream_url` split into server and key, kept in Windows Credential Manager (`Ujwalam/stream/facebook-server`, `Ujwalam/stream/facebook`) for this broadcast only; ended with `end_live_video=true` at stream stop; left-overs ended at the next start.
- facebook sink on the H canvas; reuses the shared Twitch/Kick rung (1080p60 6000 kbps CBR, inside Facebook's 4500-9000 kbps for 1080p60), own rung `fb-h` only when that rung is missing.
- Instagram Live: "Set up Instagram Live" opens instagram.com; one paste box takes URL and key together or apart; rtmps only; kept for this stream only, cleared at stream end; sink on the V canvas.
- Go live dialog: Facebook and Instagram cards with switches, Page pick, read-only Facebook status.
- Flags `facebook-live` and `instagram-live` ship on (D447).
- Keys: the Facebook and Instagram stream keys are temporary entries in Windows Credential Manager for one broadcast, deleted at stream end or after a failed start; never in a file, log or command line. Accepted on 2026-11-27 as matching AGENTS.md (stream keys in Credential Manager only).

## Tests (single files, `node --test`)

| File | Result |
|---|---|
| tests/facebook-instagram-live.test.mjs (fake Graph server, sink, plan, paste) | 15 pass |
| tests/instagram-live.test.mjs | 28 pass, 1 fail (pre-existing at HEAD 0c60fb8b: youtube-event-missing) |
| tests/outputs/schema.test.mjs | 34 pass |
| tests/outputs/validate.test.mjs | 49 pass |
| tests/stream-apply-d387.test.mjs | 10 pass |
| tests/flags.test.mjs, posting-instagram, golive-routes, feature-settings, platform-connect, studio-launch-d327, studio-ui-connect, studio-ui-readiness | all pass |
| tests/studio-qml-golive.test.mjs | NOT RUN (needs the studio build) |

## Sources (checked 2026-11-27)

- https://developers.facebook.com/documentation/live-video-api/reference (format, bitrates, keyframe, audio, 8 h)
- https://developers.facebook.com/documentation/live-video-api/getting-started (live_videos, secure_stream_url, Page permissions)
- Instagram Live Producer help (help.instagram.com): 720x1280, 30 fps, 2250-6000 kbps, key changes each time.

## Pending

- Loopback ffprobe assertions for both sinks.
- QML probe test after a studio build.
- One real stream each, no high-severity feedback.
