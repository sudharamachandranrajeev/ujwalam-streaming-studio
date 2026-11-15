# YouTube presets and in-app YouTube control (D388), 2026-11-15

Requested by the user on 2026-11-15. Approved plan, option 1 (chat read every 15 s). Twitch and Kick are not touched.

## User decisions (binding)

- Named YouTube quality presets: each holds the YouTube H and V size + bitrate (+ on/off per output) and the H and V
  event template. Picked per stream before Go live.
- In-app YouTube control: edit event details (before and while live), live status panel, live chat (read + send),
  past streams manager.
- **No feature flag.** On by default. The `youtube-events` flag is retired (removed from `data/flags.json`; any
  local override of it is ignored). Where something needs on/off, it is a visible modern toggle inside the YouTube
  window itself (`UToggle`-style switch with its text), never a hidden switch in Settings > Features. User words:
  "stop your flag based BS implementation that'll get user confused. use toggle function, the least something modern.
  turn this on by default as this is requested feature by default rather than flagging it".
- Chat: read every 15 s per live YouTube output (5 quota units a read). Send by the user's click on Send only.
- fps is not in a preset: the canvas fps is shared with Twitch and Kick, so a preset never changes it.

## Rules that still apply

- Keys stay in Windows Credential Manager. A preset never holds a key; it holds a size, and the key for that size is
  the D385 slot `Ujwalam/stream/<output>-1440p|-2160p` (1080p = the plain `Ujwalam/stream/<output>`). The UI sees
  only key present true/false.
- Chat text and author names are untrusted data: plain text only (QML `Text.PlainText`, never rich text or
  `innerHTML`), in memory only (ring of 500 per output), never written to any file or log. Logs carry counts and
  codes only, never a title, chat text, author, key or token.
- Every YouTube write (preset use, details, thumbnail, end, delete, chat send) happens on the user's click (D332): no
  typed phrase, no "are you sure". Delete and End are one click each.
- An output that is live is never stopped or reconfigured by any of this: a preset used while live is saved and
  applied at the next Go live (D387 pending path).
- Quota: 10 000 units a day. Status poll at most every 30 s (server caches 25 s); chat read every 15 s; category list
  cached 24 h; broadcast list cached 60 s unless refresh.

## Server contract (services/studio-ui, JSON over the local UI API)

Errors: `{ error: <code>, message: <plain sentence> }` with the existing `YT_EVENTS_STATUS` mapping (401 not signed
in / unauthorized, 409 live not enabled, 429 quota, 404 unknown, 400 bad-params, 502 API failed). All bodies are
validated with an allow-list of keys (`only([...])` pattern of `ytEventsRoute`). Ids match `ID_RE`
(`/^[A-Za-z0-9_-]{1,64}$/`). Output ids are the YouTube sinks of the plan in effect (`ytOutputs()`).

### Sign-in (agent B)

- `GET /ui/api/youtube/account` -> `{ signedIn, canSignIn, channelTitle|null }` (channelTitle from channels.list
  mine=true part=snippet, cached 1 h; shown only in the app, never logged).
- `POST /ui/api/youtube/signin` -> starts the existing platform-connect YouTube OAuth sign-in (same client, same
  scope `https://www.googleapis.com/auth/youtube`), `{ started: true, url? }` as the existing Connections sign-in does.
  Works without the `platform-connect` flag for YouTube (the YouTube window must not be dead behind another flag).

### Presets (agent A, `services/studio-ui/youtube-presets.mjs`, file `<dataDir>/youtube-presets.json`, atomic write)

Preset shape:
```json
{ "id": "p-<8 hex>", "name": "4K ranked",
  "outputs": {
    "youtube-h": { "enabled": true, "size": "2160p", "bitrateKbps": 50000, "templateId": "abc", "templateTitle": "...", "title": null },
    "youtube-v": { "enabled": true, "size": "1440p", "bitrateKbps": 20000, "templateId": "def", "templateTitle": "...", "title": null } } }
```
- size in `1080p|1440p|2160p` (V uses the portrait list of `stream-setup.mjs`); bitrate inside the platform limits in
  `data/platforms/youtube*.json` for that size (never hardcoded); name 1..40 chars, plain; max 12 presets.
- `GET /ui/api/youtube/presets` -> `{ presets: [...], activeId|null, sizes: { "youtube-h": [...], "youtube-v": [...] },
  limits: { "<output>": { "<size>": { min, max, default } } }, keys: { "<output>": { "<size>": true|false } } }`
- `POST /ui/api/youtube/preset/save` `{ preset }` (no id = new) -> `{ ok, preset, presets }`
- `POST /ui/api/youtube/preset/delete` `{ id }` -> `{ ok, presets, activeId }`
- `POST /ui/api/youtube/preset/use` `{ id }` -> writes the stream setup exactly as Settings > Stream Save does (same
  validation, same `writeSetup`, same D387 apply) changing only YouTube H/V size, bitrate and enabled, and writes the
  two template choices (`youtube-events.json`). Answers `{ ok, activeId, appliesAt: "now"|"next-go-live"|"next-start",
  detail?, missingKeys: ["youtube-h 2160p", ...], events: <GET /ui/api/youtube/events body> }`. A preset whose size
  has no stored key is still used, but `missingKeys` lists it and Go live refuses that output with "Set the 4K key in
  Settings > Connections" (existing D385 refusal).
- The stream setup is only what the host streams with while the existing `stream-settings` switch is on. GET presets
  returns `setupInUse`; with it off, preset/use sets the templates only and answers `appliesAt: "not-used"` with a
  plain `detail` (no new flag, no default flipped: Twitch and Kick stream from that same plan).

### Events, details, live, chat, broadcasts (agent B)

Existing (kept, flag gate removed): `GET /ui/api/youtube/events`, `POST /ui/api/youtube/templates`,
`POST /ui/api/youtube/event/set`. `GET /ui/api/youtube/events` gains `autoEvent: boolean` (default true) and
`POST /ui/api/youtube/event/auto` `{ on }` sets it (the in-window toggle "New YouTube event at every Go live"; off =
Go live streams to the keys with no event made, as before D386).

Choice overrides before Go live: `POST /ui/api/youtube/event/set` also takes optional `description` (<=5000),
`privacy` (`public|unlisted|private`), `tags` (array <=30 of <=100 chars, no `<>`), `categoryId` (`^[0-9]{1,4}$`);
`createEvent` uses an override instead of the template's value when set.

Current events: at an accepted start (`ytKept`) the server writes `<dataDir>/youtube-live.json`
`{ version: 1, outputs: { "<output>": { broadcastId, title, madeAt } } }` (atomic); cleared for an output when a fresh
status shows it stopped after a Stop, or when the broadcast is `complete`.

- `GET /ui/api/youtube/live` -> `{ at, outputs: [{ output, label, broadcastId, title, watchUrl, lifeCycle,
  health: { status: "good"|"ok"|"bad"|"noData"|null, issues: [plain sentence] }, viewers|null, likes|null,
  chat: boolean }] }` (liveBroadcasts.list + liveStreams.list status/healthStatus + videos.list
  liveStreamingDetails,statistics; cached 25 s).
- `POST /ui/api/youtube/details` `{ broadcastId, title?, description?, privacy?, tags?, categoryId? }` ->
  liveBroadcasts.update (snippet keeps scheduledStartTime) + videos.update for tags/category -> `{ ok, warnings }`.
- `POST /ui/api/youtube/thumbnail` `{ broadcastId, path }` (local file the user picked; png/jpeg by magic bytes,
  <= 2 MB) -> thumbnails.set -> `{ ok }`.
- `GET /ui/api/youtube/categories` -> `{ categories: [{ id, title }] }` (assignable only, cached 24 h).
- `GET /ui/api/youtube/chat?output=<id>&after=<cursor>` -> `{ messages: [{ id, author, text, at, kind:
  "text"|"superChat"|"membership"|"other", amount? }], cursor, live: boolean }`. The server reads YouTube every
  max(15 s, pollingIntervalMillis) per output only while a client asked in the last 60 s and the event is live.
- `POST /ui/api/youtube/chat/send` `{ output, text }` (1..200 chars, plain) -> liveChatMessages.insert -> `{ ok }`.
- `GET /ui/api/youtube/broadcasts?status=all|upcoming|active|completed&page=<token>` -> `{ items: [{ id, title, when,
  privacy, lifeCycle, current: boolean }], next|null }`.
- `POST /ui/api/youtube/broadcast/end` `{ id }` -> liveBroadcasts.transition `complete` -> `{ ok }`. Refused
  (`output-live`, 409) when it is the current event of an output that is streaming (end the stream instead).
- `POST /ui/api/youtube/broadcast/delete` `{ id }` -> same refusal; else delete -> `{ ok }`.

## UI (agent C, QML studio window)

One `YoutubeWindow.qml` replacing the picker dialog's role, opened from the On Air bar "YouTube" button (always
visible, no flag) and from a refused Go live (`youtube-event-missing` / `youtube-event-failed`, existing). Tabs:

1. **Presets**: preset cards (name, H size/bitrate, V size/bitrate, templates, key present dots); Use (one click),
   Edit, New, Delete; editor with size pickers, bitrate slider inside limits, H/V on toggles, template pickers.
   Shows `appliesAt` and `missingKeys` from the answer.
2. **Event**: per output, the template choice + overrides (title, description, privacy, tags, category, thumbnail
   file) before Go live; while live, the same fields edit the running event (details/thumbnail routes). Toggle "New
   YouTube event at every Go live" (`event/auto`).
3. **Live**: per output, health pill (good/ok/bad colours from theme tokens), issues text, viewers, likes, watch
   link (opens the browser on click). Polls every 30 s while live and the tab is visible.
4. **Chat**: H/V switch, message list (plain text, author + text, super chats marked), input + Send (Enter sends).
   Polls the server every 3 s while visible.
5. **Streams**: past/upcoming list with filter, "Use as H template" / "Use as V template", End, Delete (one click).

Sign-in: when `account.signedIn` is false, every tab shows one "Sign in with YouTube" button (`/youtube/signin`).
Theme tokens only, bundled fonts, entrances < 600 ms, exits < 400 ms, `Theme.fx` gate for any effect.
Headless probe tests (`UJWALAM_HEADLESS=1`) against a fake server.
