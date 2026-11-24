# AI post text, thumbnails, captions and voice (D443, approved 2026-11-24)

User request 2026-11-24: scheduled reels have weak titles and no real description. Integrate a local text model in
Ujwalam to write title, description, tags and thumbnail per post; use it for captions, voice recognition (live and
recorded) to edit reels, and to learn the audience's and the streamer's trends over time.

## User answers (2026-11-24)

- The model runs inside Ujwalam: a bundled llama.cpp server plus Qwen3-VL-4B (GGUF + vision projector). Download
  approved; pinned version and SHA-256, model folder under the project data, never AppData Temp.
- Fully automatic: AI text goes straight into scheduled posts (the user can still edit them).
- English, hype tone.
- Rewrite the already scheduled reels automatically (real YouTube metadata change approved).
- Add the YouTube Analytics read-only scope (one sign-in together with the caption scope).
- Live voice markers: yes. Exact phrases are not fixed yet; words the user says on stream include "adipoli",
  "polich"/"pwolich", "super", "scene", "scene item". These start as excitement words (below), not as fixed commands.
- Plan and order approved ("yes - go ahead and start").

## Findings

- Weak titles: the 2026-11-18 drafts carry `source.facts = null`, so every `textPools` line is skipped and the target
  fallback "Stream victory reel N (date)" is used (services/posting/post-text.mjs).
- The description is sent (services/posting/youtube.mjs, `snippet.description`) but is the generic template. What
  YouTube shows is UNVERIFIED.
- Thumbnails: `thumbnails.set` already runs best effort; YouTube mostly ignores it for Shorts. The reel's first frame
  (RP6, services/clip/reel_thumbnail.py) is the real Shorts cover; for the long video `thumbnails.set` works.

## Phases

| Id | What | Model |
|---|---|---|
| T1 | Model runner: llama.cpp server + Qwen3-VL-4B, pinned, started by Ujwalam after a stream only (never while live or recording: live-check), one model in VRAM at a time (Whisper turbo unloaded first), stopped after the batch. Calls go through services/common/local-ai.mjs (127.0.0.1 only). No console window (D191). | Opus |
| T2 | Post text: per post, 3-4 frames + transcript + detector facts -> JSON title, description, tags, thumbnail hook, frame time, facts seen. Checked: platform limits, schema, privacy (no chat text, no viewer names, profile terms only through {handles}/{links}), claimed kills/result must match detector facts or be marked seen-by-model. Any failure: template text as today. Flag ON (user-requested). | Sonnet, Opus review of the checker |
| T3 | Thumbnail: model picks the frame and a 2-4 word hook; reel_thumbnail renders it (Shorts: first frame; long video: thumbnails.set). | Sonnet |
| T4 | Rewrite scheduled posts: every scheduled, not yet public YouTube item gets new text via videos.update; quota budgeted; original text kept for undo; one ledger entry each. | Sonnet, Codex review |
| T5 | Captions (C2): the model cleans Whisper lines (punctuation, Manglish spelling, game words from a data list). | Sonnet |
| T6 | Voice and excitement: the live CPU Whisper and the post-stream transcript feed an excitement score per moment from (a) the mic's loudness and pitch rise over the speaker's own baseline, (b) excitement words from data (seed: adipoli, polich, pwolich, super, scene), (c) laughter/shout from a small local audio-event model (ONNX, CPU; download needs the user's yes), (d) chat rate (existing engage signals). Live: marks only, never acts on stream. Post-stream: the score ranks clip candidates and reel cuts. | Opus |
| T7 | Audience learning: Analytics read (views, average view duration, retention) per post stored locally; scoring favours the title styles, looks and moments that did well. No model retraining. | Sonnet, Codex review |

Every phase: tests and evidence in docs/evidence/, a switch in Settings.

## Release items (user, 2026-11-24 evening)

- Installer stays one file (Ujwalam-Setup-<version>.exe, tools/package/single-setup.mjs). Verified on a clean
  Windows in Windows Sandbox (user approved enabling it) for every release build: install, first start, model download,
  uninstall.
- Downloads: every model and optional part goes through the in-app download manager (services/studio-ui/downloads.mjs:
  queue, pause/resume with Range, SHA-256 check, never while live). The D443 model and server items join it; verified
  end to end from the studio (start, pause, resume, cancel, bad hash, offline).
- Backup and restore in the app (user choices): settings and data without media (scenes, settings, presets, posting
  queue and schedules, learning data, sign-in state kept encrypted); one password-protected file per backup in a
  folder the user picks; restore shows what it replaces and keeps a safety copy first. Verified by a round trip on a
  second data folder and in Sandbox.
- A new alpha build ships when T2-T4 are done, so the user can check managing the already scheduled and future posts
  from Ujwalam.