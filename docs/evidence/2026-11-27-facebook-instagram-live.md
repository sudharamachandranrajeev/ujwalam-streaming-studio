# Facebook Live and Instagram Live in Go live (D447), 2026-11-27

Plan: `docs/plan/2026-11-27-facebook-live-ig-live-x-posting.md` sections 1 and 2. Branch `feat/fb-ig-live`.

Status: unit tests PASS. Loopback ffprobe: PASS (2026-11-27, below). Real stream: PENDING. Not done until a real stream passes.

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
| tests/instagram-live.test.mjs | 29 pass (the "launched with Instagram" failure was test isolation: the studio server read the laptop's real Credential Manager, where a YouTube sign-in made Go live ask for a YouTube event; the test now uses an in-memory secret store and sets the D447 Instagram tick) |
| app/host/tests/outputs-plan.test.mjs | 19 pass (new: o3-fbig-loopback plan equals preset + addFacebook + addInstagram; facebook on reencode-tk, instagram on ig-v) |
| tests/outputs/schema.test.mjs | 34 pass |
| tests/outputs/validate.test.mjs | 49 pass |
| tests/stream-apply-d387.test.mjs | 10 pass |
| tests/flags.test.mjs, posting-instagram, golive-routes, feature-settings, platform-connect, studio-launch-d327, studio-ui-connect, studio-ui-readiness | all pass |
| tests/studio-qml-golive.test.mjs | 11 pass (headless, 339 s, studio built) |

## Loopback ffprobe (2026-11-27, PASS 65/65)

Command: `node app/host/tools/o1-loopback.mjs --plan app/host/outputs/o3-fbig-loopback.json --seconds 60` (UJWALAM_HEADLESS=1, studio closed, live-check off air). Local ffmpeg listeners on 127.0.0.1 only; no platform, no keys. Result: `out/host/o3-fbig/2026-11-27T20-05-05/result.json` (gitignored).

| Sink | Rung | ffprobe | Limit (data/platforms) |
|---|---|---|---|
| facebook | reencode-tk (shared with twitch, kick) | H.264 1920x1080, 60.00 fps, 6002 kbps CBR, keyframe gap 2.000 s (26 keyframes), AAC 48 kHz stereo 160 kbps | 1080p60, 4500-9000 kbps, keyframe <= 4 s (2 s recommended), AAC <= 256 kbps |
| instagram | ig-v (own V rung, GPU-scaled 1080x1920 -> 720x1280) | H.264 720x1280, 29.98 fps, 4009 kbps, keyframe gap 2.000 s, AAC 48 kHz stereo 160 kbps | 720x1280, <= 30 fps, 2250-6000 kbps, AAC <= 256 kbps |
| youtube-h / youtube-v / twitch / kick | yt-h / vert / reencode-tk | 2560x1440@60 34012 kbps / 1080x1920@60 7505 kbps / 1920x1080@60 6002 kbps / 6001 kbps | unchanged |

- No extra encoder for Facebook: 4 rungs for 6 sinks; NVENC sessions probed at configure (probe started 4 of 4), NVML 0 before, steady median 4 = rungs, not sinks.
- twitch and facebook files carry identical packets (video 3009 of 3009, audio 2350 of 2350): one encoder, audio encoded once (one AAC encoder in the host log).
- Instagram's own rung: the V rung `vert` (7500 kbps) is above Instagram's 6000 kbps, so `ig-v` was added (the validator decided).
- Kick drop and reconnect, other sinks stayed live 16/16 samples; 0 skipped or lagged frames.

## Sources (checked 2026-11-27)

- https://developers.facebook.com/documentation/live-video-api/reference (format, bitrates, keyframe, audio, 8 h)
- https://developers.facebook.com/documentation/live-video-api/getting-started (live_videos, secure_stream_url, Page permissions)
- Instagram Live Producer help (help.instagram.com): 720x1280, 30 fps, 2250-6000 kbps, key changes each time.

## Pending

- One real stream each, no high-severity feedback.
