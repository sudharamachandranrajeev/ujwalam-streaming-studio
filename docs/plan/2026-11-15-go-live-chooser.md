# Go live chooser, streamer-friendly outputs, UI overhaul (D389), 2026-11-15

Requested by the user on 2026-11-15 after installing alpha.31 ("keys are getting connected, but the go live
implementation is bad"). Approved answers: AI help = local model; theme = full UI overhaul; outputs = hard to use and
layout jumps, "make it streamer friendly rather than a programmer or tech friendly, take inspiration from Meld Studio";
chooser = every Go live, last choice pre-selected. Twitch and Kick streaming is not changed. On by default, no flag
(D388 rule, memory `requested-features-on`).

## 1. Go live chooser (track A server, track B QML)

Pressing Go live while at least one YouTube output is switched on opens the chooser first (no YouTube output on, or
not signed in to YouTube: Go live works exactly as today). One choice for the whole start, then a quality per YouTube
output, then one "Go live" button. The last mode and qualities are pre-selected.

Modes:

1. **existing** — "Use an event on your channel": the user's upcoming or live YouTube events (made in YouTube Studio
   or earlier). The chosen event is bound to the stream of the key for the chosen quality. Nothing is created. Such an
   event is never deleted by Ujwalam, on any failure (it is the user's, `ours: false`). If its `enableAutoStart` is
   false it is updated to auto-start and auto-stop (contentDetails sent whole). An event that is already live and
   bound to a different stream is refused with a plain sentence (YouTube cannot re-bind a live event). One event per
   YouTube output (H and V each pick their own; the same event for both is refused).
2. **copy** — "Pick from your past streams": a past broadcast as template; a new event copied from it (the D386 path).
3. **last** — "New stream like the last one": template = the newest completed broadcast of that output (newest
   overall when none is mapped); title, description, privacy, category, tags, thumbnail copied (D386 path), scheduled
   start = now.
4. **new** — "Set up a new stream": fields title (1..100), description (<=5000), privacy, category, tags, optional
   thumbnail file (same checks as the D388 thumbnail route), latency normal, DVR on, made-for-kids false,
   auto-start/auto-stop on. "Help me write it" fills title/description/tags from the local model (section 2).

Quality per YouTube output: `1080p|1440p|2160p` (V: the portrait list), bitrate = the platform default for that size
from `data/platforms/` (never hardcoded). The key used is the D385 slot for that size (`Ujwalam/stream/<output>` for
1080p, `-1440p`, `-2160p`); a size whose key is not stored is shown greyed with "Add the key" (opens Settings >
Connections filtered to it). Applying a quality changes only that YouTube output's size and bitrate through the
shared `saveSetup` path (same validation, same D387 apply); the D388 shared-rung refusal applies (Twitch/Kick never
change with it). With `stream-settings` off the quality cannot be applied: the chooser says so in plain words and
streams at the current size.

### Server routes (track A, new file `services/studio-ui/golive-routes.mjs`, wired in `server.mjs`)

- `GET /ui/api/youtube/golive/options` ->
  `{ signedIn, outputs: [{ id, label, orientation: "landscape"|"portrait", on, sizes: [{ size, key: bool, bitrateKbps }], size }],
     existing: [{ id, title, lifeCycle, when, boundToOther: bool }], past: [{ id, title, when }] (newest first, <= 15),
     last: { "<output>": { id, title, when } | null }, choice: <saved choice or null>, setupInUse: bool }`
  existing = liveBroadcasts.list mine broadcastStatus upcoming + active (ready/testing/live/created), past = completed.
  Cached 60 s unless `?refresh=1`; quota noted in the decision.
- `POST /ui/api/youtube/golive/prepare` `{ mode, outputs: { "<output>": { size, broadcastId? , templateId?, fields? } } }`
  -> validates (allow-list keys, ID_RE, sizes from the lists, fields like `event/set` overrides), applies the
  qualities (`saveSetup`), writes the choice to `youtube-events.json` (`mode` + per output `{ size, broadcastId |
  templateId | fields }`; old choices without `mode` read as `copy`), answers
  `{ ok, appliesAt, missingKeys: [...], ready: bool, detail? }`. Nothing is created on YouTube here.
- The Go live hook (existing D386 block in `server.mjs`) reads the saved choice: `existing` -> `bindExisting`
  (new in `youtube-events.mjs`: find the stream by key, update auto-start if needed, bind; `ours: false` so the
  cleanup in the `finally` never deletes it; the live list `youtube-live.json` records it); `copy`/`last` ->
  `createEvent` (`last` resolves its template at Go live, newest completed); `new` -> `createEvent` without a template
  (new `createFromFields`). Refusal texts name the output and say what to do, no codes.
- `POST /ui/api/youtube/golive/suggest` `{ output?, hint? (<=200 plain) }` -> `{ title, description, tags, source:
  "local-model"|"smart-fill" }`. Section 2.

### QML (track B)

`GoLiveDialog.qml`: opens from `store.toggleStream()` when going live with a YouTube output on and signed in. Four
large mode cards (icon, one-line plain description), the list or form for the picked mode, a quality row per YouTube
output (segmented 1080p / 1440p / 4K, greyed with "Add the key" when the key is missing), a plain summary line
("Goes live on YouTube landscape in 1440p into 'Ranked grind tonight', and on Twitch and Kick as usual"), and one
"Go live" button (Enter). Esc / Cancel closes with nothing changed. On Go live: `prepare`, then the existing
`stream.start` path (readiness, refusals and toasts unchanged). Last choice pre-selected. Busy and error states in
plain words; no typed phrase, no "are you sure" (D332).

## 2. "Help me write it" (track A)

- Local model only, through an OpenAI-compatible server on `127.0.0.1` (LM Studio's local server, default
  `http://127.0.0.1:1234/v1/chat/completions`; address and model name in `<dataDir>/ai-writer.json`, never a remote
  host: anything not 127.0.0.1/localhost/::1 is refused). No install by Ujwalam; the user starts the LM Studio server.
- Never while anything is live or recording (6 GB VRAM, D1): refused with a plain sentence. The request asks LM Studio
  to unload the model soon after (`ttl` field; UNVERIFIED whether every LM Studio version honours it).
- Input: the game name (from the profile, local only), the last 5 of the user's own stream titles, the date, `hint`.
  Never chat text, viewer names or memory (AGENTS.md). Output is cleaned like the event fields (plain, lengths,
  no `<>`), tags <= 15.
- Fallback "smart-fill" (no model reachable, timeout 20 s, bad answer): title from the last title pattern with the
  date/stream number, description from the last description, tags from the last tags. `source` tells the UI which.

## 3. Outputs panel, streamer-friendly (track B)

Meld Studio as the flow reference (UX only, never its assets). The panel shows destinations, not plumbing:

- One card per destination: platform name + orientation in plain words ("YouTube · landscape", "YouTube · portrait",
  "Twitch", "Kick"), quality in plain words ("1440p, 24 Mbps"), a status chip: Ready / Add the key / Live / Off /
  Problem (plain reason on hover and under the card).
- One big switch per card, label "Go live here". The switch shows the real saved state; while saving it shows a
  spinner, never flips back and forth; the card never changes size.
- Duplicate warning: two switched-on destinations that would send to the same platform account with the same key are
  flagged on both cards ("Both go to the same YouTube stream: only one will work. Switch one off.").
- A summary line at the bottom: "Go live starts: YouTube landscape (1440p), YouTube portrait (1080p), Twitch, Kick."
- Responsive: the card grid reflows to the panel width (1 or 2 columns), text elides with a tooltip, no overlap.
- The data comes from the existing setup and Connections status routes; a small read-only route may be added
  (`GET /ui/api/outputs/summary`) in a new file owned by track B.

## 4. UI overhaul (track C, design system first)

Follows `docs/plan/2026-11-14-rareui-redesign.md` (user's answers) and memory `ui-feel-feedback`,
`streamer-friendly-ux`. Phase C1 (now): a new design system in the QML studio — spacing scale, type scale, radii,
elevation (real layered soft shadows, not hard offsets), motion; one polished light theme and one polished dark theme
replacing "Soft"; every `U*` component restyled to it; every overlap or hidden setting found under Soft fixed (probe
test per page: no item outside its parent, no text clipped). Effects (`Theme.fx`, `ShadowLayers`, springs) redone to a
quality level: no banding, no hard outlines, still plain while live/recording/High performance. Phase C2 (after B
merges): main window layout overhaul.

## Rules (all tracks)

Keys only in Windows Credential Manager; the UI sees key present true/false. No key, token, title or chat text in a
log. Every YouTube write on the user's click. Live outputs never stopped or reconfigured. Never going live in tests:
fake YouTube, fake host, loopback only. Theme tokens only, entrances < 600 ms, exits < 400 ms. Headless probe tests.
