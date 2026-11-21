# v1 decisions log (2026-10-29 onwards)

One line each: decision — reason — how to undo. Defaults applied per `2026-10-29-ujwalam-v1-autonomous-addendum.md` §2 and the 10-day plan §4 ("defaults apply if not answered within the day", except deletions, installs, commits, real-platform posts, devices/live streams, spending).

| # | Date | Decision | Reason | Undo |
|---|---|---|---|---|
| D1 | 2026-10-29 | UI route: local web control UI (Node stdlib server on 127.0.0.1, plain `<script>`, no CDN) + native libobs preview windows (Win32 HWND via `obs_display_create`, H and V) hosted by the existing C++ libobs host | Fastest to F2 by end of day 2; no Qt SDK install (OBS runtime ships Qt 6.8.3 DLLs but no dev tools/moc); reuses the event-core API patterns (token, Host/Origin checks) | Replace the web UI with Qt/QML later; the libobs host and its JSON-RPC API stay the same |
| D2 | 2026-10-29 | YouTube test uploads: private to the user's channel until T8 passes; then public/unlisted chosen per clip | Plan §5.2 default | Change the per-clip privacy setting |
| D3 | 2026-10-29 | OAuth/API clients: Node stdlib (`fetch`, `node:http` loopback redirect on 127.0.0.1, PKCE) — no Google or TikTok client libraries | Stdlib-first; no installs | Add a client library later behind the same module |
| D4 | 2026-10-29 | Tokens (YouTube, TikTok) in Windows Credential Manager via the existing PowerShell wrapper (`streamerbot/credential.mjs` pattern) | Plan §6: OS keychain only | — (rule) |
| D5 | 2026-10-29 | Captions: Whisper small, GPU when free post-stream, CPU fallback; engine per the install list answer | Plan §5.5 default; VRAM rule: post-stream models load one at a time | Pick another model size in config |
| D6 | 2026-10-29 | Open P3 items carry into v1 as UNVERIFIED (quiet-window benches, 20-min traced run, real Streamer.bot read); P3 closes with a short gate | Plan day 1 Agent A | Run them when the machine is quiet |
| D7 | 2026-10-29 | P3 open defaults applied: cached Streamer.bot password kept, cleared on connector stop; separate UI confirmation channel in v1 UI work (ADR `docs/adr/2026-10-29-confirmation-channel.md` accepted as direction); `chatAllowed`+`chatMode` merge deferred to C2; 30 s per confirmation step, step 2 own 30 s; baselines only via `--accept`; audit chain stays unkeyed (risk recorded); moderation normalisation beyond legacy: deferred to v1.1 (★ parity kept) | Defaults stated in earlier batches; no answer within the day | Each reversible in config/code |
| D8 | 2026-10-29 | F4 chat-triggered effects on; scene/stream/output actions stay dry-run. Effects are idempotent-safe (a duplicate effect after a crash is cosmetic); the lost-action blocker still applies to C2/C3 actions | v1 plan F4 | Set effect actions back to dry-run in the catalogue |
| D9 | 2026-10-29 | Raw invisible characters in string literals: rewrite as `\u{…}` escapes + lint rule flagging raw bidi/zero-width characters in source | Reviewability; treated as a lint addition (strengthens a check) — listed in the end-list for confirmation | Remove the rule |
| D10 | 2026-10-29 | `npm test` gets `--test-timeout=300000` (5 min per test) | The day-1 checkpoint CI hung > 45 min in `event-core-api-files` and `event-core-streamerbot-cli` while a second full `npm test` ran; both files pass alone (12/12, 7/7). A hang now fails instead of blocking CI. Root cause of the concurrent hang: UNVERIFIED, under investigation | Remove the flag |
| D11 | 2026-10-29 | **Decided by the user 2026-10-29.** E8-03 panic test flake (`ECONNREFUSED` on the first panic under load). (1) The E8-03 test runs the attacker in a child process: same 256 churning sockets, same 10 single-shot panics, same strict all-200 assertion, started once the flood is over the pending cap. The in-process flood stays as measured evidence, not a TCP test. (2) Panic no longer depends only on the shared TCP port. The in-process entry `panicNow` (`api/panic.mjs`, the hotkey entry, call contract for Agent C in its header) and a system-role named pipe (`api/pipe.mjs`: `\\.\pipe\ujwalam-core-system-<random>`, owner-only DACL verified or fail closed, system token only, `actions.panic` + `core.status` only), named only in the owner-only `system.json`, never in `api.json`. (3) Bounded retry `withRetry` / `panicViaPipe` (`api/client.mjs`: 5 tries, 50/100/200/400 ms, ECONNREFUSED/ECONNRESET only). The real panic sender adopts it when it exists (staged). Panic stays idempotent (`already-panic`). (4) Tests: pipe and hotkey panic during the 256-socket TCP flood, with the attacker in a child process and in-process | Measured (`docs/evidence/2026-10-29-p3-e8-03-panic-under-load.md`): the Windows accept queue is capped at about 232 whatever the backlog (a negative SOMAXCONN_HINT aborts libuv); libuv drains 32 per loop turn; an attacker sharing the server's loop delays the drain by 0.5-1.8 s under load, and a TCP connect in that window is refused. With the attacker in a separate process: 360/360 panics answered 200, up to 4096 sockets. A TCP flood cannot reach a named pipe | Set `systemPipe: false` in `startService`; the TCP API and its limits are unchanged. Restore the in-process attacker in the E8-03 test |
| D40 | 2026-10-29 | Studio UI = separate Node server `services/studio-ui/` (127.0.0.1, serves `ui/`), the only holder of event-core and host credentials; the page gets a same-origin API guarded by an HttpOnly SameSite=Strict session cookie + CSRF header + Host/Origin checks | Browsers must never see backend tokens; event-core API refuses browsers by design, so a server-side proxy is needed | Replace with the Qt shell later; backends.mjs clients stay |
| D41 | 2026-10-29 | Login = one-time launch key (env, 120 s, single use, rate limited) traded for the session cookie; launcher opens `/login?k=...` and never prints the key | No token file for the browser to read; no key in later URLs | Switch to a header-only scheme |
| D42 | 2026-10-29 | The UI server is the confirmation channel: it keeps confirmId/actionHash, the human types the phrase ("yes" / "yes, on air") in the page, the server compares and then calls the backend. Stream/record start/stop are confirmed this way (on-air phrase when live or starting a stream); other UI clicks (scene switch, layer show/hide, mixer) are the human's own act and need no phrase | A phrase on every click would make the UI unusable; AI/chat-driven writes still go through the event-core gate | Add `confirm` to more entries of HOST_CALLS |
| D43 | 2026-10-29 | Host API contract used by the UI is PROPOSED and UNVERIFIED with Agent C: discovery `<dataDir>/host.json` `{port,pid,startedAt,token}`, JSON-RPC 2.0 `POST /rpc` Bearer token; methods in `HOST_CALLS` + `host.status`. Until it exists the UI runs on an in-memory fake flagged BLOCKED-ON-HOST (banner, status pill) | Unblocks UI work on day 1 | Adjust names in `server.mjs` HOST_CALLS and `ui/js/app.js` |
| D44 | 2026-10-29 | Launcher `services/studio-ui/launch.mjs` makes the event-core api/system tokens and passes them by env; the UI server gets only the api token. The host is started only if `UJWALAM_HOST_EXE`/`--host-exe` exists | Least privilege; no host binary yet | — |
| D45 | 2026-10-29 | Project model v1 (Agent A): one JSON document per project in `<dataDir>/projects/<id>.project.json`; schema `data/schemas/project.schema.json` (structure) plus hand-written stdlib validator `services/project/validate.mjs` (structure plus cross-references, ids unique, path safety); tests run both on the same cases | Stdlib-first runtime, ajv stays dev-only; JSON Schema alone cannot check references | Drop the validator and use ajv at runtime (needs an install approval) |
| D46 | 2026-10-29 | Layers live inside scenes; array order is z-order (bottom first). Per-canvas geometry in `layer.placements.{h,v}` (a missing canvas means the layer is not shown there). Layer ids unique project-wide so audio sources can reference a layer | Matches Meld H/V per-scene layout; simplest for the UI and the importer | Add a per-canvas order override later as an optional field (additive, no version bump) |
| D47 | 2026-10-29 | Devices are project entries matched by stable `match.deviceId` (display name only as a fallback); layers and audio sources reference the device entry by id, never a device string. Device ids, names and files in fixtures are placeholders | Rules: no hardcoded devices; public repo scrub | — (rule) |
| D48 | 2026-10-29 | Outputs in a project are references `{id, type: rung or sink, ref, canvas}` to Agent C output-config ids; no encoder or bitrate settings in the project (schema rejects them) | Output graph rule: sinks never own encoders; output config is Agent C scope | Agent C may extend `outputRef` additively; the validator does not check that `ref` exists in the output config (cross-check belongs to the host or a later integration test) |
| D49 | 2026-10-29 | Files are path references `{base: data, media, overlays or profile, rel}`; `rel` must be relative with no drive letter, rooted path or `..`; callers map base to a directory (`resolvePathRef`). Overlays are top-level entries browser layers reference by id | No absolute or personal paths in saved projects; legacy overlay files resolved through the profile/data dir | — (rule) |
| D50 | 2026-10-29 | Atomic save = temp file in the same folder, fsync, copy current file to `.bak` (one backup), rename over; load falls back to `.bak` when the main file is missing or invalid; leftover temp files are ignored and removable with `cleanTemps` | Crash test requirement: kill mid-save keeps the original | Remove the `.bak` fallback in `loadProject` |
| D51 | 2026-10-29 | Version 1 is current; `migrate()` runs `MIGRATIONS[n]` one step at a time and refuses newer or unknown versions. A v0 (pre-release single-transform shape) migration is included so the hook has a tested path | Plan: migrate by version; avoid an untested hook | Delete `MIGRATIONS[0]` and its test when no v0 file can exist |
| D52 | 2026-10-29 | Importer traceability: optional `origin {importer, id}` on project, device, scene, layer and audio source (Meld importer fills it; re-import can match by origin) | Day-2 Meld importer needs to map back without guessing | Remove the field; unknown keys are rejected so importers would need it re-added |
| D53 | 2026-10-30 | Meld importer reads the on-disk session file (`{version:1, session}`; seen in Meld Studio 0.10.7.7 and legacy backups) only. The Meld API dump (`apiVersion`/`items`) is refused: it has no device ids or source kinds | The API dump cannot identify capture devices; the session file can | Add an API-dump reader later (device layers would stay unidentified) |
| D54 | 2026-10-30 | Layer kind comes from `meta.sceneObjectSourceName`. Mapped: Video device to capture, Media source to media or image (by extension), Browser to browser, Text to text. Skipped and listed (never guessed): Widget (Meld-hosted content), Duplicator, Game capture, Display capture, Group (children not flattened), unknown kinds. Real session: 114 of 179 layer placements skipped, mostly Duplicator (67) and Widget (35) | No equivalent in the project model; coordinates inside groups and what a duplicator shows are unverified | Add a `duplicate` layer type (source = layer id) so Duplicators import; add display/game capture layer types when the host supports them. Needs a model decision (accepted by main 2026-10-29; implemented as D60) |
| D55 | 2026-10-30 | Additive model change (still version 1, nothing shipped yet): `browser` source gets optional `query` (overlay URL query string, only with `overlay`) and device `match` gets optional `directShowId` | Legacy overlays take theme/canvas parameters in the query; Meld keeps a separate DirectShow id per device | Remove both fields from schema and validator; importer would then drop the query and the DirectShow id |
| D56 | 2026-10-30 | Files: `file:///` media and local overlay URLs become `{base, rel}` relative to the common folder of all such files in the session. The common folder is reported in `report.bases` (real paths, local report only); the caller maps `media` and `overlays` bases to directories. `http://localhost:<port>/overlays/<rel>?<q>` becomes overlay `{base: overlays, rel}` plus `query`; other http(s) stays a URL | Project holds no absolute paths; query parameters are part of the overlay behaviour | Pass an explicit root option later instead of the common folder |
| D57 | 2026-10-30 | H and V Meld scenes (via `linkedSceneId`) merge into one project scene. Layers pair when type, source and name are equal (n-th with n-th); unpaired layers keep one canvas placement. Stacking order follows H; V-only layers go after their nearest V neighbour. Meld `childItems[0]` is taken as the top layer (UNVERIFIED) so project order is the reverse. Order differences between H and V are counted in a warning | Project has one z-order per scene | Add per-canvas order override (additive) once the preview shows a difference |
| D58 | 2026-10-30 | Audio: device tracks (`type` 1 with `uniqueId`) become devices (microphone or audio-output) plus audio sources; layer audio (enabled only) becomes a source bound to the layer. Application tracks (`type` 2) are skipped. `gain` is read as linear amplitude: `volumeDb = 20*log10(gain)` (clamped to -100..12); `monitoring` true becomes `monitor-only`; `outputTracks` is read as a bitmask. All UNVERIFIED | Meld stores no dB value; values must be checked against Meld UI | Change `toDb` and `maskTracks` in `import-meld.mjs` |
| D59 | 2026-10-30 | The importer ignores and counts, never guesses: effects, flips (negative scale), rounded corners, fitmentMode other than 0. Canvas fps is not stored by Meld; default 60 via `--fps` | Project model has no field for them | Add fields (additive) and map them |
| D20 | 2026-10-29 | libobs host (`app/host`, separate from `app/spike`) serves JSON-RPC itself: a C++ HTTP/1.1 server on 127.0.0.1 with Bearer + system token, Host/Origin/Sec-Fetch checks, no body read before auth, rate-limited auth failures, and an owner-only discovery file `<dataDir>/host.json` that fails closed | Same security as the event-core API with no extra process or install; the UI talks to the host directly | Put a Node proxy in front; the method names stay |
| D21 | 2026-10-29 | Agent B's host API names adopted as is (host.status fields, scenes/layers/preview/mixer/stream/record). Additions: host.info, host.shutdown, project.load/get, scenes.create/remove, layers.add/remove, preview.close/list, outputs.*, encoders.probe. The host does not gate stream/record start; the UI server's typed confirmation does | One contract for B and C; confirmation belongs to the confirmation channel (ADR 2026-10-29) | Add a host-side guard method later |
| D22 | 2026-10-29 | Output targets carry no URLs: the host builds `rtmp://127.0.0.1:<port>/<app>` / `srt://127.0.0.1:<port>` / file names under the recordings dir. A private `ujwalam_loopback` service refuses any non-127.0.0.1 URL. The sink's real platform/proto is validated against `data/platforms` separately from the loopback transport | No real platform or stream key can be reached in v1 O1; limits stay data | Add a real-delivery target type behind the live-lock and the "yes" rule (O2+) |
| D23 | 2026-10-29 | libobs auto-reconnect is off (`obs_output_set_reconnect_settings(0,0)`); the host supervisor retries with `min(cap, base·2^(n-1))·(0.5+0.5·rand)`, min 100 ms, reset after `retryResetLiveMs` live. Record sinks are not retried | One owner for retries, visible in outputs.status; a sink failure never stops the others | Turn libobs reconnect back on per output |
| D24 | 2026-10-29 | NVENC sessions are probed at runtime (replay_buffer outputs at canvas size, no GPU scaling) by `outputs.configure` and `encoders.probe`; too few sessions → CONFLICT, never oversubscribed. Measured on this laptop: 12 total, shared with other apps | Rule: never hardcode hardware encoder session limits. A GPU-scaled probe encoder that fails leaks a libobs view | Probe with the real rung settings once the libobs leak is understood |
| D25 | 2026-10-29 | One shared `ffmpeg_aac` encoder (`ujw:enc:audio`) for every sink; video rungs are deduplicated (identical settings → one encoder) | Rule: audio encoded once; sinks never own encoders | — (rule) |
| D26 | 2026-10-29 | SRT is exercised on youtube-v as a loopback transport only (no platform file lists SRT) | Proves the SRT path without inventing a platform limit | Drop the SRT target from `app/host/outputs/o1-loopback.json` |
| D27 | 2026-10-29 | `project.load` is refused while any output is active; otherwise it releases the output graph, rebuilds the studio, then reconfigures the same output config | Encoders cannot rebind video after init; no half-built graph | Allow hot reload of scenes only (no canvas change) later |
| D28 | 2026-10-29 | Device and browser modules (win-dshow, win-wasapi, obs-browser, win-capture, obs-websocket, rtmp-services and others) are not loaded unless `--allow-devices` / `--allow-browser`; both stay off. Layer types today: color, test_pattern, media (local file) | Rule: no capture devices, cameras or mics without "devices ready" | Pass the flag once the user says "devices ready" |
| D29 | 2026-10-29 | Host build output goes to `out/host/build` (gitignored); OBS runtime and source paths come from env or `app/host/host.local.json` (template `host.example.json`); `node app/host/tools/build.mjs` uses vswhere/vcvars when cmake/cl are not on PATH | No hardcoded user paths; no installs | Move the build to the root CMake when the Qt app arrives |
| D60 | 2026-10-30 | New layer type `duplicate`, `source: {layer: <layer id>}`: a second scene item on the same libobs source as the target layer (no new source), with its own per-canvas placements. Target must exist, be a real (non-duplicate) layer, may be in another scene; duplicate-of-duplicate and cycles are rejected. A duplicate has no audio of its own. Meld Duplicator maps to it when the target was imported; otherwise skipped with reason `target-skipped` (detail in `report.skipped[].detail`). Project version stays 1: the model is unreleased and no reader outside this repo exists (the host and UI are written against it now); a bump would only add a no-op migration | Recovers most of the V layout (real session: Duplicator imported 38 of 67) | Remove the type from schema and validator, and the importer branch; or bump to version 2 with an identity migration if a v1 reader ships first |
| D70 | 2026-10-30 | Overlay server (`services/overlay-server/`, F4 part 1): serves the legacy overlay folder read-only on 127.0.0.1 at the legacy URL layout (`/overlays/<name>/index.html?<query>`, plus `/brand` and `/kit`, the only other folders the pages load). Default port 8787 (the legacy port). Allowlisted folders and extensions only; `engage/`, `meld/`, `docs/`, `mockups/` and dotfiles are not reachable. Host header must be `127.0.0.1:<port>` or `localhost:<port>`; dot segments, backslash, NUL, colon and double slash in the path are refused (400), links leaving the folder (403); no listing; GET and HEAD only; no CORS. HTML gets a CSP that pins `connect-src` to loopback (UNVERIFIED in the libobs browser source) | Legacy overlays run byte for byte unchanged; a page cannot send what it reads to another host | `--root`/code only; drop `csp` if CEF rejects it |
| D71 | 2026-10-30 | Bridge transport: one WebSocket feed on its own port (default 8788), separate from the static server and from the event-core API. Frames are the legacy formats: Streamer.bot envelopes (`{event:{source,type},data}`, Subscribe/ack, Hello without `authentication`) for the pages that open a Streamer.bot socket or load `kit/sources/streamerbot.js`, and overlay-bus frames (`{rp:'event',type,data}`) for the rest. Pages are pointed at it with the query parameters they already have (`feedQuery()`: `streamerbot=1&sbHost&sbPort&sbPath`); the real Streamer.bot keeps port 8093. Bus frames reach a page through `/_ujwalam/relay.html` (BroadcastChannel `rp-events`, which `rp-kit.js` already reads) or through the host posting the same object with `window.postMessage`. Legacy files are never edited or rewritten on the way out | Matches "unchanged overlays"; no injected script | A host-side postMessage path replaces the relay page (UNVERIFIED which one CEF needs) |
| D72 | 2026-10-30 | Feed scopes. `/` (effects, default): chat envelopes carry the display name and a masked text (`!` for a command, `.` otherwise) plus effect frames; no chat text leaves the event core. `/display`: full moderated text, role badges, and alert frames (follow, sub, gift, raid, member, donation), only for pages that draw chat or alerts (chat-list, alert-box). Chat text stays untrusted: the feed copies whitelisted fields only (no ids, pseudo ids, tokens, platform user ids), and the pages render with textContent | CLAUDE.md: effects only, no chat text beyond what legacy overlays display | Widen only with the user's yes |
| D73 | 2026-10-30 | Token rule for overlays: the bridge never holds or forwards the event-core API token. As its own process it reads the token from `UJWALAM_EVENT_CORE_API_TOKEN` (never a URL, never a file) and sends it only as the Authorization header of its one SSE request to the event core. Tests assert it is absent from every frame, page, header and stat. The feed is read-only: every client request but Subscribe, UnSubscribe and GetInfo gets `status: error`. Feed Origin must be the static server's origin (a browser page from elsewhere is refused 403); a client without Origin is a local process and is allowed | Browser layers never receive the API token | Move to a Unix-socket or named-pipe feed if loopback is not enough |
| D74 | 2026-10-30 | Day-4 hook point: `bridge.publishEffect(name, meta)` calls `effectGate(effect)` first. Default allows all (effects on, D8). Budget, cooldown and flash guards plug in there and return `{allow:false, reason}`; nothing else changes. Effect names are `[a-z0-9_-]{1,32}`. No effect is derived from chat here: effects come from `effect.fire` (the host or executor calls `publishEffect`), as in legacy where chat only reaches a page that listens for chat | Guards are day-4 work | None |
| D75 | 2026-10-30 | Gaps left on purpose: voice-callout (needs a SpeechToText event kind, P8), blood-moon-hud goal and counters (no event kinds yet), chat-engage (needs the legacy engage server on 8790, P13), cam-pop-frame and the `meld=1` pages (need Meld's WebChannel, absent here). They still load and run from the server; they just receive nothing from the bridge. The legacy harness page `tools/test-events.js` has a missing comma and was not touched | Not invented | Add event kinds in their phases |
| D30 | 2026-10-30 | `devices.list` is list-only and available without `--allow-devices`: DirectShow via `BindToStorage` (never `BindToObject`), WASAPI via `OpenPropertyStore` (never `Activate`), no libobs device module. Proved by code path, unchanged Windows privacy store and unmapped `win-dshow.dll`/`win-wasapi.dll` | The UI and the importer need device ids to match project devices before "devices ready"; listing opens nothing | Gate the method behind the flag (one line in `methods.cpp`) |
| D31 | 2026-10-30 | Project device matching order: `match.directShowId`, then `match.deviceId` (DevicePath, WASAPI endpoint id or win-dshow `name:path` id, case-insensitive), then device instance (UNVERIFIED), then a unique `match.name`. Kind filter: capture-card and camera to DirectShow video, microphone to capture endpoints, audio-output to render endpoints | D55: the DirectShow id is preferred when present; names are only a fallback (D47) | Change `devices::resolve` |
| D32 | 2026-10-30 | Project v1 mapping: one project scene = one libobs scene per project canvas (same id on H and V); one layer = one source created once plus one item per placement; `duplicate` = another item on the target's source. Placement = stretch bounds to the rectangle with centre alignment (rotation about the centre, crop in source pixels; both UNVERIFIED against Meld). Opacity and master volume are not applied and are reported as warnings | One source per layer keeps one decoder or device open per layer; centre alignment makes rotation independent of size | Change `Studio::apply_placement`; add an opacity filter when the UI needs it |
| D33 | 2026-10-30 | Validation split: Node callers validate with `services/project/validate.mjs` before `project.load` (`app/host/lib/project.mjs`), and the host's `--project` flag takes only the host test format (`"format": "ujwalam-host-test"`). The host re-checks every field it consumes and refuses malformed input on its own | One authoritative validator (A's); the host is still a trust boundary | Let `--project` take v1 files with a bases flag |
| D34 | 2026-10-30 | Layers and audio the host cannot build (device or browser off, overlay server not wired, missing file, unmatched device) are listed in `unavailable` with code `forbidden` or `unavailable`; `project.load` refuses them unless `skipUnavailable`; `project.plan` is the dry run | Never guess or silently drop a layer; the UI can show what is missing | — |
| D35 | 2026-10-30 | `project.get` returns `{format, dirty, project}`; for project v1 it returns the document as loaded and host edits only set `dirty` (services/project owns the saved model) | No second model of record in the host; the UI saves through services/project | Have the host write placements back into the document |
| D36 | 2026-10-30 | R2 (a GPU-scaled encoder whose `create()` fails leaks its encoder-only video mix until shutdown) is a libobs 32.1.2 bug in `obs-encoder.c` (`maybe_set_up_gpu_rescale` runs before `create()`; the mix is cleared only when `context.data` is set). Recorded, not worked around beyond D24 (the probe does not scale) | A host fix would need to patch libobs | Patch or upstream fix, then probe with real rung settings |
| D37 | 2026-10-30 | RPC body limit 1 MiB (was 64 KiB) for project documents; auth is still checked before the body is read. Build dir selectable with `UJWALAM_HOST_BUILD` so a second build does not need a running host stopped | Real projects exceed 64 KiB; parallel agents share the machine | Lower the limit; drop the variable |
| D61 | 2026-10-30 | studio-ui uses the host contract as built by Agent C (names `scene`, `layer`, `index`, `id`, `db`, `canvas`); the UI shows layers top-first (host order is bottom-first) and unwraps `{scenes}`, `{layers}`, `{sources}`; the fake host returns the same shapes | Contract adopted unchanged (host-o1 evidence section 8) | Edit `HOST_CALLS` and `ui/js/app.js` |
| D62 | 2026-10-30 | Backends are called with `node:http`, never `fetch`: the host and event core refuse requests carrying Sec-Fetch headers (fetch adds them) | Found in the real-host smoke: fetch got `browser-request-refused` | — |
| D63 | 2026-10-30 | Launcher starts the host with `--runtime/--data-dir/--recordings` from `app/host/lib/config.mjs`, `--discovery <event-core data dir>/host.json`, the host token by env to host + UI server only, `--allow-devices` only when given to the launcher (off by default), clean stop via `host.shutdown` | Least privilege; no device opened without the user's go | Drop the flag passthrough |
| D64 | 2026-10-30 | BLOCKED-ON-HOST banner shows only when the fake backend is in use (no discovery file, or `--fake-host`) | Connected host = no banner | — |
| D65 | 2026-10-30 | UI evidence screenshots use test-card output only; preview crops are client areas only, the full-screen capture lives in gitignored `docs/evidence/private/` | The desktop behind the windows can show personal content | — |
| D66 | 2026-10-30 | "Import Meld session" in the UI: the server reads the session file named by `UJWALAM_MELD_SESSION` or `paths.meld_session` (local profile; the page never supplies a path), writes a NEW `<dataDir>/projects/meld-import-<stamp>.project.json` (+ local report) via `services/project/import-meld.mjs`, runs host `project.plan`, and returns counts only; `project.load` then needs the typed phrase and retries on -32009 (1/2/4 s) | T2 path; no overwrite; no names/paths/device names to the page | Remove the two `/ui/api/project/*` routes and the button |
| D67 | 2026-10-30 | Launcher picks `out/host/build-c/ujwalam-host.exe` when it is newer than the default exe and no exe/build env is set | Day-2 host lives there while another host may hold `out/host/build` | Set `UJWALAM_HOST_BUILD` |
| D68 | 2026-10-30 | UI lists one row per scene id (host lists a scene per canvas) and passes `canvas` to layer calls when the scene is on both H and V (H/V tabs) | Host requires it | — |
| D76 | 2026-10-30 | Effect guards are data: `data/effects/guards.json` (budget, cooldowns, priorities, regions, flash limit, queue, pools, cam-pop rule), each number with source and status. Timings and cam-pop rule values are copied from legacy with file:line; the gate is the bridge `effectGate` | Rule: presets/config are data; star parity | Edit the JSON; `--no-guards` turns the gate off |
| D77 | 2026-10-30 | UNVERIFIED, for the user to confirm: shared budget 30 effects/min; queue max 8, ttl 3000 ms; priorities campop 80, gg 70, storm 40, charge 20; flash offsets charge [0], storm [0]; gg queues on overlap, others drop; pool hype gg 3/storm 2/charge 1 with no-repeat-last 1 | Legacy has no cross-effect budget, priority, region or flash data; proposed, not invented silently | Change the values in guards.json |
| D78 | 2026-10-30 | Regions: `full` and `camera` from legacy geometry; `edge` and `center` are approximations of the legacy CSS (UNVERIFIED). Overlap of regions means drop or queue, never stack | Settled rule: claimed screen region | Adjust rects |
| D79 | 2026-10-30 | Unknown or malformed effect names are refused (fail closed). A queued effect of the same name is refused as busy, not queued twice. busy is inclusive of the end tick | Safe default; mirrors legacy busy flag | — |
| D80 | 2026-10-30 | Preemption happens only to plays flagged `interruptible`; all four legacy effects are false because legacy pages cannot be stopped. A cut play still cools down from the cut | Cannot stop a legacy page mid-play | Set interruptible once a page supports a stop frame |
| D81 | 2026-10-30 | Pages loaded as `/effects/<name>` on the feed get chat envelopes only when the gate admits that effect, so chat-driven effects (charge, storm) share the budget; ungated scopes are unchanged | Legacy pages fire inside the page on chat; the gate can only control what the page receives | Use the `/` scope |
| D82 | 2026-10-30 | Flash safety: limit is 3 per second per canvas from declared offsets (settled). The measured rate from rendered frames is a TODO hook (`reportMeasuredFlashes`) for the host `fx test`; it is not simulated | Needs host frames; no faking | Host calls the hook |
| D83 | 2026-10-30 | Cam-pop rule ported as data + state machine (`campop-rule.mjs`), fires through the gate; parity checked against a dry-run capture of the legacy tool (two runs, one-second resolution). Mic meter source is a host TODO (same 0..1 scale as the legacy reader) | Parity rule | — |
| D84 | 2026-10-30 | Test cleanup: every child a test or soak tool spawns is registered in `tools/proc-registry.mjs`; waits for a child use `waitExit(child, ms)` (kills the whole tree on timeout, never waits forever); `stopTracked()` in `after()` kills whatever a failed or timed-out test left; a last-resort process `exit` hook kills the rest. Windows tree kill is `taskkill /T /F` by the validated absolute path (`systemTool`) | Hung runs stayed alive for hours because an abandoned child or mock kept the test file process alive | Remove the registry calls from the spawn sites |
| D85 | 2026-10-30 | `tools/soak/replay.mjs` `main()` now always ends its run in a `finally`: kills registered children, closes every open mock, removes its signal handlers. Core child start-up and subscribe waits are ceilings of 120 s (env `UJWALAM_SOAK_READY_MS`) instead of 30 s and 20 s; soak test timeouts are 300 s | Under 8 parallel test processes the below-normal-priority child needed more than 30 s to start; the old code then threw and leaked the child and the mock. Ceilings, not assertions: no test assertion changed | Lower READY_MS |
| D86 | 2026-10-30 | The stray check (`tools/stray-procs.mjs`, CI `stray-mocks`) also flags the idempotency kill-test child and listen-CLI children that carry the test-only credential target. It is machine-wide, so another agent or user run in progress at the same time shows up as a stray | Cover all test spawn sites; real `serve` runs are never flagged | Remove TEST_CHILD |
| D87 | 2026-10-30 | Not changed, reported: the connector slow-password loop-delay test measures its own process event-loop delay and is load sensitive by nature; it did not fail in the repeat load runs. The label-server M11 502 under load is outside this task | No weakening of timing asserts | Run timing files in a serial pass if it recurs |
| D110 | 2026-10-30 | Built-in scene preset "Default H" is registry data: function `scene-layout-preset` (category scenes-packages, status in-progress, format `html` because most layers are HTML overlays; the format enum has no "scene" value) and preset `registry/presets/scene-default-h.json` (parity `none`, not a star preset). Layers z0 to z12 are fractions of the canvas; z13 cam-pop is a rule with a layer-key target | Presets are data, not code; registry schema fits as is | Delete the two files |
| D111 | 2026-10-30 | Loader `services/project/scene-preset.mjs` returns a deep copy of the project with ONE new scene appended; overlay entries are added only when no entry has the same file; existing scenes, layers, devices, audio, outputs, canvases and activeScene are untouched (tested byte for byte). Rules are returned (`rules[]` with scene and layer ids), not stored, because the project model has no rule storage | Never modifies existing scenes, layers, devices or settings | Do not call it |
| D112 | 2026-10-30 | Device roles `game-capture` and `facecam` are bound by the caller (`roles: {role: deviceId}`); an unbound role becomes a transparent colour layer with the same geometry and is listed in `unbound`. No device is created or guessed. `game-capture` accepts kinds capture-card and camera because the Meld importer files every video device as `camera` | The preset carries roles, never device names or ids | Bind in the UI after load |
| D113 | 2026-10-30 | Placeholders `{brand.wordmark}`, `{brand.character}`, `{handles.twitch\|youtube\|kick}`, `{links.discord}` resolve from `data/profile.local.json` at load; a missing key fails by key name before anything is built; query values are URL-encoded. Keys added to `data/profile.example.json` (additive). The local profile has none of them yet, so a real load needs them filled in | Brand values stay local | Fill the keys |
| D114 | 2026-10-30 | Geometry rule: Meld's value is used where the Meld layer matches and the box differs by 2 percentage points of the canvas or less (game, facecam, event list, subscribe pill). Where the Meld box is larger (Meld widgets and animated media have boxes much bigger than their visible content), the measured spec value is kept and the difference is reported for the user | A Meld widget box is a container, not the visible region; copying it would move legacy overlays that draw their own content | Switch a layer to `geometry: meld` in the preset |
| D115 | 2026-10-30 | Game capture is cropped, not stretched, in Meld (uniform scale, the box is narrower than the scaled source). The preset carries the same: placement box plus a centred crop of 177 source pixels per side (354 total). Facecam likewise 399 per side. Centred split is UNVERIFIED (Meld's offset unit unknown); Meld's facecam flip (rotation 180 plus negative vertical scale) is not representable and is left out | Do not change the aspect without asking; this only mirrors Meld | Edit `crop` in the preset |
| D116 | 2026-10-30 | Sources without a legacy overlay yet are placeholders, not invented: Subscribe call to action is a transparent colour layer; per-platform follower/subscriber counters point at blood-moon-hud, which draws both counters in one part (page option needed); Background and Atmos front are two atmos-frame configurations (UNVERIFIED which parts make the stone backdrop); Atmos front is hidden because the Meld scene has none | Gaps are listed in the evidence, not hidden | Replace when the overlays exist |
| D117 | 2026-10-30 | The launcher waits (up to 60 s) for the host discovery file before starting the UI server and opening the browser, so the page never meets the fake backend first. The page also reloads scenes, layers and mixer when the status flips between fake and real host (scene ids differ). Found in the full run: the first load had used the fake backend and later layer calls failed with `host-error`. | Agent B (UI) |
| D118 | 2026-10-30 | Launcher test hooks: `--outputs PLAN.json` (validates with `planFile`, writes the params next to the host data dir, passes `--outputs` to the host; nothing is started), `--stop-on-stdin` (any input or end of stdin runs the same clean stop as Ctrl-C), and env `UJWALAM_BROWSER` / `UJWALAM_BROWSER_ARGS` (replace the default browser, for scripted runs). None change the default `npm run studio` behaviour. | Agent B (UI) |
| D119 | 2026-10-30 | Stream and record start/stop in the UI go through the typed-phrase dialog against the real host with the O1 loopback plan only (ffmpeg listeners on 127.0.0.1). Start stream needs "yes, on air"; every stop and the record start while live also need it. A wrong phrase leaves the dialog open and nothing runs. The host does not gate these calls; the UI server does. | Agent B (UI) |
| D120 | 2026-10-30 | H/V tab and active-row contrast fixed with token values only: `--color-text-on-accent-dim` `#101a30` on `#4f8cff` is 5.38:1 (was 1.24:1); `--color-tab-on-text` `#0b1220` on `--color-tab-on-bg` `#4f8cff` is 5.82:1. Both are above the 4.5:1 AA minimum. | Agent B (UI) |
| D121 | 2026-10-30 | The mixer list follows host layer order, so it reorders after a layer move. Tests and scripts must find a mixer channel by name, not by position. Not a UI defect; recorded so no test relies on position. | Agent B (UI) |
| D38 | 2026-10-30 | `devices.list` is refused (-32001) without `--allow-devices`, and `project.plan` / `project.load` list devices only with the flag (device layers then say "devices were not listed"). Supersedes the D30 part "available without `--allow-devices`"; the D30 listing method is unchanged. | Main's decision: everything device-related waits for the user's "devices ready". | Drop the flag check in `methods.cpp` and the `allow_devices` argument of `model_options`. |
| D39 | 2026-10-30 | The R2 upstream filing (D36, libobs GPU-rescale mix leak) goes on the user's end-list; Agent C does not file it. | Filing upstream is a public action under the user's account. | Agent C files it if the user asks. |
| D90 | 2026-10-30 | The overlay server (Agent A's `services/overlay-server`) runs as one child of the host: `app/host/overlay/child.mjs` under Node, started after libobs, in a job object (kill on close, suspended until assigned), no window, only its pipe handles inherited. Control is JSON lines on stdin/stdout (`ready`, `effect`, `stats`), no extra port. Restart on exit with backoff min(15 s, 500 ms x 2^(n-1)) x 0.5-1.0 jitter, reset after 30 s up; exit 64 (bad arguments) is final. Ports are pinned after the first start. | Overlays must survive a child crash without touching stream or recording; pinned ports keep layer URLs valid across restarts. | Run the overlay server as a separate supervised service instead; `--allow-browser` without `--overlay-root` keeps it off. |
| D91 | 2026-10-30 | The child gets an allowlisted environment (15 system variables). The host reads and clears `UJWALAM_EVENT_CORE_API_TOKEN` from its own environment at start, so CEF never inherits it; the child gets it only with `--overlay-events-url` (127.0.0.1 only, 64-hex token). `overlay.status` reports the child's environment variable names and whether it got an event token, never values. | Browser layers must never receive an API token; a check needs proof from the child itself. | Widen the allowlist in `overlay.cpp`. |
| D92 | 2026-10-30 | Layer URLs are built in Node (`app/host/lib/project.mjs` `overlayUrls`, with A's `feedQuery`) from the ports the host reports; the host accepts an overlay layer only if its URL is exactly `http://127.0.0.1:<own static port>/overlays/<that overlay's rel>` plus an optional query, without spaces, control characters or `#`, at most 2048 chars. Otherwise the layer is unavailable with a reason. | The query format belongs to the overlay server (one owner); the host only proves the URL points at its own server and the right file. | Build the URL in the host from `feedQuery`'s rules. |
| D93 | 2026-10-30 | One relay page per project (`/_ujwalam/relay.html`, private browser source `ujw:overlay-relay`, 16x16 at 10 fps, kept showing and active). Relay scope = `display` if any overlay folder is in `data/overlays/feed-scopes.json` (from D72), else `effects`. BroadcastChannel between obs-browser sources: VERIFIED (gg-burst fired through the relay in CEF). | One feed connection per project; effects pages get no chat text. | Per-layer feeds via the layer query. |
| D94 | 2026-10-30 | Browser source settings: `webpage_control_level` 0, fps = the largest canvas fps (custom fps on), no audio reroute, `shutdown` and `restart_when_active` false, `about:blank` when a URL is empty. Hardware acceleration not changed. | A page has no studio access; no default web page is loaded. | Per-layer settings in project v1 later. |
| D95 | 2026-10-30 | `effect.fire {name, meta?}` calls `bridge.publishEffect` in the child and returns the guards verdict (`{ok}` or `{ok:false, reason}`). Name `[a-z0-9][a-z0-9_-]{0,31}`; meta at most 8 keys of 32 chars, primitive values, strings at most 200. -32001 without `--allow-browser`, -32004 while the overlay server is down. Guards on (A's `data/effects/guards.json`). The UI gates the on-air write. | Guards have one owner (A); the host only validates shape and transports. | Route effects through event core instead. |
| D96 | 2026-10-30 | Port 8093 is refused at three points: host `--overlay-port` / `--overlay-feed-port` (exit 64), `Overlay` status check, and the child (exit 64). | The real Streamer.bot keeps 8093. | Remove the checks if Streamer.bot moves. |
| D97 | 2026-10-30 | Shutdown order: studio teardown (relay first), overlay child stop (stdin close, job terminate after 3 s), 1 s wait for CEF when browser is allowed, then libobs shutdown. | Browser sources must be released before obs-browser unloads; host exit stays 0. | Shorten the CEF wait when measured. |
| D98 | 2026-10-30 | O2 uses `app/host/outputs/o2-loopback.json` (the O0 preset `youtube-1440p60.json` unchanged, loopback targets) with the generalized `o1-loopback.mjs --plan`; the tool writes a test card copy at the plan's canvas sizes and checks that a rung smaller than its canvas is GPU-scaled. | One loopback tool for O1 and O2; the Multi rung must be a GPU scale from the H canvas, never a decode. | Separate O2 tool. |
| D99 | 2026-10-30 | The NVENC check compares the steady-state median minus the before count with the rung count; new checks fail on more than 1 % skipped frames for encoding lag or lagged frames for rendering per mix/output (host log). | O2 run 1: a first-sample transient read 7, and 40-87 % encode lag passed the packet checks because skipped frames are re-sent. | Restore the single-sample check. |
| D100 | 2026-10-30 | One heavy GPU job at a time: the O2 1440p60 run needs an idle NVENC (0 sessions before start). | Run 1 failed with another process encoding H+V on the same NVENC. | Lower presets if a second encode must run. |
| D101 | 2026-10-30 | `rungs[]` in configure and `outputs.status` add `scaled`, `gpuScaled`, `encodeW`, `encodeH` (from libobs). | Evidence of GPU scaling comes from the host, not inferred from the plan. | Additive; remove fields if unused. |
| D102 | 2026-10-30 | Contract additions: `overlay.status`, `effect.fire`, `project.load`/`plan` params `browserUrls` and `relayScope`, `built.overlayLayers` and `built.relay`, `project.get.relay`, plan `sources[].url`/`overlay`, `host.info.overlay`. All additive. | UI and A need the overlay state and a fire path. | Additive; no undo needed. |
| D130 | 2026-10-30 | Session paused; state in `docs/plan/2026-10-30-handover.md`. The in-flight `wip(v1-d2)` commit was stopped before its tests (CI > 5 min) and is replaced by the pause commit | User pause instruction | Resume from the handover |
| D131 | 2026-10-30 | Bench rules (user-approved 2026-10-30): (1) a metric in `ms` never regresses by less than 0.1 ms absolute (`ABS_FLOOR_MS`); (2) quiet-run regressions are advisory (exit 0, `bench: advisory (v1 window: ...)`, CI shows ADVISORY) until 2026-11-06, enforced from that date (`ENFORCE_FROM` in `tools/bench/run.mjs`). `stall-tracer-overhead.idle_main_busy_ms_per_min` 64.38 → 102.06 ms/min NOT accepted: quiet re-run later, then ask the user. The half-finished user-path fix named at resume: none found (lint 0 user-path findings; only gitignored `docs/evidence/private/` holds user paths) | User resume instruction | Remove the constants; test `bench rules` covers both sides |
| D132 | 2026-11-03 | Alpha 0 control UI = the existing 127.0.0.1 studio web page (`npm run studio`) plus the host's native H/V preview windows; full Qt studio UI later (user answer, Part D1) | Fastest route; the page already drives the real host | Build a minimal Qt shell instead |
| D133 | 2026-11-03 | Alpha packaging = portable zip + `Install-Ujwalam.ps1` to `%LOCALAPPDATA%\Ujwalam\<version>` with previous-version rollback, no admin; version `0.1.0-alpha.N`; Inno Setup/MSIX and signing later with approval (user answer, Part D2) | No installer tooling to install; rollback in one step | Switch to Inno Setup/MSIX |
| D134 | 2026-11-03 | Private remote = GitHub private repo (user answer, Part D3). The first push still waits for the full-history pre-push scan, the file list and the user's yes | gh CLI present; Actions Windows runners for CI and alpha zips | Gitea, or no remote |
| D135 | 2026-11-03 | Nightly encrypted backup of local-only data (profile.local.json, docs/evidence/private, data/labels, feedback/) with the installed 7-Zip (AES-256, encrypted file names) into the Proton Drive folder; password held by the user, never in the repo or on disk in clear (user answer, Part D4). Scheduling it (Task Scheduler) is a system change and is shown before it is created | Off-machine copy of data that git never holds | Remove the scheduled task; delete the archives |
| D136 | 2026-11-03 | Feedback hotkey `Ctrl+Alt+F`, configurable (user answer, Part D6) | Default from the plan | Change in the host config |
| D137 | 2026-11-03 | Backup agents (Part D5): default applied: `AGENTS.md` now; tools are added as the user gets access; no keys requested | No answer needed now | — |
| D138 | 2026-11-03 | `AGENTS.md` is the single rule source; `CLAUDE.md` imports it (`@AGENTS.md`) and keeps only Claude Code routing. Procedures moved to `docs/procedures/` (evidence, phase gate, registry add, session protocol, feedback triage); `.claude/skills/*` point there. Session lock `tools/agent-lock.mjs` (`.agent-lock`, gitignored); `feedback/` gitignored | Continuity across tools (Part C1) | Restore the old CLAUDE.md from git; delete AGENTS.md |
| D139 | 2026-11-03 | CI gains `build-host` (`npm run build:host`) and `test-host` (`npm run test:host`, concurrency 1, after `test`). The host DACL test drops `PSModulePath` for its Windows PowerShell 5.1 child: run from pwsh 7 it failed with "Get-Acl ... module could not be loaded"; product code already gives its PowerShell children a minimal environment | Handover next-task 1; the host was never in CI | Remove the two steps |
| D140 | 2026-11-03 | Alpha calendar: day 1 = Tue 3 Nov, day 2 = 4 Nov, day 3 = 5 Nov, day 4 (first real stream on Alpha 0) = 6 Nov. v1 items after Alpha 0 follow Part B order (clip pipeline, posting, effects, studio UI, Meld import polish). The 6 Nov v1 acceptance therefore cannot include clipping and posting; reported to the user as a date risk | The new priority file overrides the v1 order (same scope) | Revert to the v1 day order |
| D141 | 2026-11-03 | Two test fixes found by the commit CI: (1) the real-send source scan skips `.claude/worktrees` (agent worktrees are separate checkouts; it read three copies of the connector) and `.claude/worktrees/` is gitignored; (2) `proc-registry` "replay run that fails after starting its mock" runs 60 s instead of 2 s, so on a loaded machine the run cannot finish before the simulated crash (it resolved, "Missing expected rejection"); the kill ends it in seconds (30/30 in 6 s) | Test bugs, not product faults; the checks keep their full scope | Revert the two lines |
| D142 | 2026-11-03 | `tools/backup-local.mjs` (D135): password from Credential Manager `Ujwalam/backup`, given to 7-Zip on stdin only (verified: create with `-p` reads it twice; `t` without `-p` reads it once), `-mhe=on`, write to `.partial`, test, rename; a same-day rerun and `--keep N` move old archives to `_to_delete/`, never delete. Tests 4/4 | No secret on argv or disk | Remove the tool |
| D143 | 2026-11-03 | Default V preset (Agent B): `registry/presets/scene-default-v.json` from the Meld V scene "Mobile Live Full view" (the only V scene linked to the current scene) in the Oct 2026 session file; Meld geometry clamped to the canvas, crop not stretch, placeholders where no legacy overlay exists; includes Voice Callout, Chat Engage, Chat Storm (in the Meld V scene). `scene-layout-preset` function canvases widened to H+V. Mismatches > 2 pp: YouTube counter 2.3, Twitch counter 3.5, ticker 184 (Meld strip mostly off canvas). Evidence `2026-11-03-a0-preset-default-v.md` | User's current V layout as data | Remove the file and its test; revert canvases |
| D144 | 2026-11-03 | Alpha shell (Agent C1), `npm run alpha`: device presets carry `params.match` (data, status unverified); optional profile `devices.roles` override by path or exact name, placeholders ignored; alpha merges H and V into one "Default" scene, V capture layers are `duplicate`s of the H capture (one source per device); audio = mic + game audio on track 1, monitoring off; the host starts with the test card so the V canvas exists; host log to `<dataDir>/logs` (newest 10), in-host ring 1000 lines x 1024 B with 32+ hex runs redacted, RPC `log.tail` (default 200) and `overlay.stats` (counts); a stale discovery file is removed only if its pid is dead; overlay event-source uses `node:http` (fetch sent Sec-Fetch headers that event core refuses per D62: endless "event stream: lost"). Evidence `2026-11-03-a0-alpha-shell.md` | Day-1 shell | Per item in `services/studio-ui/alpha.mjs`, `launch.mjs`, `log.cpp` |
| D145 | 2026-11-03 | Open from B: the Meld importer refuses the wrapper-less `{session:{version}}` shape of the newest session file ("unsupported Meld session version undefined"); fix queued for Meld import polish (Part B order item 5), not Alpha 0 | Alpha needs the presets, not a re-import | — |
| D146 | 2026-11-03 | Real outputs (Agent C2, high stakes, Opus): host reads stream keys and per-account server URLs in-process with CredReadW (`^Ujwalam/stream/[a-z0-9-]{1,32}$`, fixed 1024 B buffer wiped on start/stop/failure/destroy; never argv/env/obs_data/RPC/log; `outputs.status` shows `keyPresent`/`urlPresent`; error text containing the key is withheld); private libobs service `ujwalam_live`; new host flag `--allow-live` (else -32001); recording `.mkv` by default, other containers refused unless `unsafeContainer: true`; recording binds to a streaming rung (`ownRung` plan-only escape); ingest in `data/platforms/*.json` `ingest` (YouTube from data, Twitch/Kick server in keychain); YouTube URL `rtmps://a.rtmps.youtube.com:443/live2` from OBS 32.1.2 services.json, UNVERIFIED; plan `extraSinks`; `data/outputs/alpha-live.json`. O2 loopback 52/52 idle; host-live-keys 5/5. Evidence `2026-11-03-a0-real-outputs.md` | Alpha 0 outputs | Revert `stream_keys.*`, `outputs.*`, flag |
| D147 | 2026-11-03 | Check rules changed openly by C2, for the user's review (AGENTS.md: fix the rule, report): (1) `tests/outputs/schema.test.mjs` allows rtmp(s) URLs only at `platforms ingest.value.servers[].url`/`urlFormat` (no query, no `@`), and a non-official source only on a value marked `unverified: true`; (2) `o1-loopback.mjs` "keeps up": a missing lag line counts as 0 only when every sink logged "Total frames output" (libobs prints lag lines only when non-zero, so a clean run failed) | Rules blocked required data / misread clean runs | Revert the two files |
| D148 | 2026-11-03 | Residual key risks accepted for Alpha (reported): libobs/librtmp keep their own unzeroed key copies for the output lifetime (do not share host crash dumps); libobs logs the server URL to the local gitignored host log; Twitch ingest is plain RTMP (key unencrypted in transit) unless RTMPS is added; same-user processes can read Credential Manager | Upstream behaviour | Add Twitch RTMPS; scrub logs |
| D149 | 2026-11-03 | Feature flags (Agent D2): `data/flags.json` definitions, all default off (`clip-pipeline`, `chat-effects`); local state `<dataDir>/flags.local.json` (atomic); studio-ui server owns writes; OFF instant and never confirmed, even live; ON needs "yes" ("yes, on air" while live); `services/flags/index.mjs` shared read API (`isOn` reloads on file change); SSE `flags` events; Flags panel on the control page | Part B: every new feature behind a flag, switchable live | Remove module, routes, panel, data file |
| D150 | 2026-11-03 | Post-stream feedback form (Agent D2): server lists `feedback/<date>/<HHMMSS>/` moments and writes only `note.json` (text ≤ 2000, tag bug/annoying/wish/works-well, severity high/medium/low); ids `^\d{4}-\d{2}-\d{2}/\d{6}$`, link-free real directories under the feedback root (junction test passes); folder from `opts.feedbackDir`, default `<repo>/feedback`. Panels not yet seen in a browser (UNVERIFIED) | Part B form, traversal impossible | Remove `feedback.mjs`, routes, modal |
| D151 | 2026-11-03 | Typed confirmations (host and flag kinds): the phrase is re-checked at confirm time; if the stream went live after the request, plain "yes" is refused and the record upgrades to "yes, on air" (page shows it again). Found in D2's report; affected stream/record/project/flag confirmations since D119. Test added (61/61 UI server tests) | Live-lock must reflect the state at the moment of the write | Remove the check in `server.mjs` confirm route |
| D152 | 2026-11-03 | Host day-2 (Agent D1, Opus): replay buffer H+V bound to each canvas's largest rung (NVML: no extra NVENC session), fallback rung per canvas when nothing streams (NVENC CBR H 12000 / V 8000 kbps, x264 if no NVENC), restarts empty on output-graph change; global hotkeys panic Ctrl+Alt+P, feedback Ctrl+Alt+F, marker Ctrl+Alt+M (registration failure reported, never fatal); panic hides browser layers and refuses `effect.fire`, never touches outputs/audio, then `actions.panic` over the system pipe (server pid checked, 5 tries); markers JSONL per host session; feedback hotkey writes `moment.json` (file names only), last-200-line `log.txt`, 30 s replay H+V; strict `--host-config`; `hotkeys.trigger` only with `--test-hooks`; hotkeys and replay autostart OFF unless host config enables them; system token read from env then removed, never logged. Voice note not done. Real WM_HOTKEY delivery UNVERIFIED. Evidence `2026-11-04-a0-replay-hotkeys-panic.md` (9/9; host suite 48 pass, 5 skip) | Alpha 0 items 6–8 and Part B capture | Per file: `replay.cpp`, `hotkeys.cpp`, `panic.cpp`, `moments.cpp`, `host_config.*` |
| D153 | 2026-11-03 | Alpha launcher (Agent E1) rewrites `<dataDir>/host-config.json` (owner-only, fails closed) on every start: hotkeys on, replay autostart 30 s, `feedbackDir` (`--feedback-dir`, default `<repo>/feedback`), event-core system file; combos change only via `--hotkey-panic/feedback/marker COMBO\|off`. System token to the host by env only (alpha); UI server gets `--feedback-dir` | One source of truth | Remove `alphaHostConfig`/`writeHostConfig` |
| D154 | 2026-11-03 | `--live` (alpha only) loads `data/outputs/alpha-live.json` and adds host `--allow-live`; excludes `--outputs` (exit 2); an `--outputs` plan with real targets is refused without it; start prints per-sink state + keyPresent/urlPresent only. Streaming still starts only after "yes, on air" | Real targets need an explicit flag | Remove `--live` handling |
| D155 | 2026-11-03 | Feedback form reads the host's `at`/`scenes`; ids accept same-second suffix `-2..-99` | Real moments showed no time/scene; duplicates hidden | Revert `feedback.mjs` regex/helpers |
| D156 | 2026-11-03 | Test seam `UJWALAM_ALPHA_FEEDBACK_PROBE=1` (only with `--no-open`): one `feedback.capture`, then checks the UI server lists it. Real-host run (no devices): 3 hotkeys registered, replay H+V on fallback rungs, moment listed, clips H/V 5.2 s | Runtime evidence without real key presses | Remove `feedbackProbe` |
| D157 | 2026-11-03 | `--hotkey-*` override flags | Ctrl+Alt+M is held by another program on this laptop | Remove `hotkeyOverrides` |
| D158 | 2026-11-03 | Marker hotkey default changed to `Ctrl+Alt+Shift+M` (host default, launcher comment, host test, D2 card); panic Ctrl+Alt+P and feedback Ctrl+Alt+F unchanged | Ctrl+Alt+M fails to register here; Ctrl+Alt+Shift+M registered in E1's run | Revert in `host_config.h` |
| D159 | 2026-11-03 | Alpha zip: one top folder with `bin/`, `obs/`, `notices/`; regex allowlist + forbidden-path list checked on staged tree and on zip entries | Privacy and licence rules enforced at build | Edit `tools/package/manifest.mjs` |
| D160 | 2026-11-03 | OBS runtime subset = PE import closure + libobs-d3d11/libobs-winrt; CEF en-US only; no pdb, no Qt plugins | 152 MB smaller, exact shipped list with reasons | Copy whole runtime |
| D161 | 2026-11-03 | Node not bundled; ≥22.13 checked by installer and launcher (exit 9) | Avoids licence work and size | Bundle `node.exe` in `bin/` |
| D162 | 2026-11-03 | Install versions under `%LOCALAPPDATA%\Ujwalam\<ver>` with `current.txt`/`previous.txt`; `-Rollback`; nothing deleted | No admin, simple rollback | Use a junction |
| D163 | 2026-11-03 | Crash policy: max 3 host restarts in 5 min (backoff 2/5/10 s); recording restarts in a new file + marker; streams not auto-restarted; exit 0 ends session; give-up = exit 3 + diag zip; log `logs/host-crashes.jsonl` | Recording is crash-safe; stream restart has platform side effects | Constants in `launch.mjs` |
| D164 | 2026-11-03 | Diag bundle redacts home path, user name, profile terms, URLs, keys, tokens, chat; outputs presence flags only; markers without notes | Bundles shareable safely | `tools/diag/redact.mjs` RULES |
| D165 | 2026-11-03 | First run without a profile in the data dir stops (exit 2) and points to the example profile | Package never carries a filled profile | Auto-copy example |
| D166 | 2026-11-03 | Amends D113: a brand asset file key (`brand.*` used in an image layer's `file`) missing from the profile no longer fails the scene; the layer becomes a transparent placeholder and the key is reported (`missingAssets`, launcher warning). Query placeholders (`handles.*`, `links.*`) still fail by key name | The user cannot identify the character asset yet; the scene must still load for the first stream | Restore the throw in `scene-preset.mjs` |
| D167 | 2026-11-03 | A preset image layer whose profile file is a video becomes a looping `media` layer (shared `IMAGE_EXT` list in `services/project/index.mjs`, same rule as the Meld importer). Profile: `paths.profile_assets` = the local stream-assets folder, `brand.wordmark` = the Meld wordmark animation | Meld streams the wordmark as a looping mp4 | Use a still file |
| D168 | 2026-11-03 | F6 clipper is a Python stdlib CLI in `services/clip/` (`clipper.py candidates|render|validate|run`), behind flag `clip-pipeline` (off; exits 3 when off) | Matches the P2 tools; no installs | Port to Node |
| D169 | 2026-11-03 | Three layout variants (`full-crop`, `game-facecam`, `blurred-fill`), each validated against Shorts, TikTok and Reels; captions inside the overlap of their safe zones | One render serves all three platforms | One file per platform |
| D170 | 2026-11-03 | Short-form limits and safe zones live in `data/clip/targets.json` (status unverified), not `data/platforms/` | That schema is for live delivery | Extend the platform schema |
| D171 | 2026-11-03 | Candidate score = sum over signal kinds of each kind's strongest value; merges capped at `maxSec`; a candidate more than half inside a better one is dropped. Weights/windows in `data/clip/ranking.json`, status proposed until the user approves | Rewards agreement between signals; no chained long clips | Edit `clip_rank.py` / ranking.json |
| D172 | 2026-11-03 | Chat signals come from `event-core.db` opened read-only; text never stored | One writer per database; privacy | Use an exported jsonl |
| D173 | 2026-11-03 | A marker belongs to a recording when `at − recordMs` is within 5 s of the file's time stamp | Host recordings carry local-time stamps only | Host writes a recording id into markers |
| D174 | 2026-11-03 | `--encoder auto` uses NVENC only when no `ujwalam-host` runs, else libopenh264 | One GPU job at a time | Always pass `--encoder` |
| D175 | 2026-11-03 | `gblur` instead of `boxblur` for the blurred-fill layout | The local ffmpeg is an LGPL build without boxblur | A GPL ffmpeg build |
| D176 | 2026-11-03 | Captions: faster-whisper 1.2.1 + `small` multilingual model in the project `.venv`, hashed lock `services/clip/requirements-whisper.lock.txt`, `av==18.0.0` pinned, CPU int8 by default, model outside the repo and passed with `--whisper-model` (user-approved install) | av 19 breaks faster-whisper 1.2.1; CPU keeps the GPU hold; no path hardcoded | whisper.cpp CLI backend |
| D177 | 2026-11-03 | Clip `game-facecam` rects are a read-only copy of the Default H preset's Facecam and Game layers, geometry `unverified` until a rendered frame is checked; ranking weights `approvedBy` set as proposals only, status stays `proposed` | User approval 2026-11-03 | User marks rects by hand |
| D178 | 2026-11-03 | The host test for devices.list no longer requires the dev host exe to have no Windows camera/mic consent entry; it requires that the call adds or changes none | Windows writes the entry itself after an approved `--allow-devices` run; tests must not edit the registry | Separate test exe name |
| D179 | 2026-11-03 | Twitch bandwidth test is a host process flag `--twitch-bandwidth-test` (not a plan field); the suffix is appended in the key buffer on the connect thread; if it cannot be appended the key is wiped and the connect fails | Survives reconfigure and crash restart; a key never goes out unsuffixed | Plan field |
| D180 | 2026-11-03 | Live-test guard runs in the launcher (`services/studio-ui/live-guard.mjs`), never starts outputs, stops all outputs on failure, not-live >10 s, host unreachable >10 s or budget; exit 4 on abort; per-sink limits stop only that sink; operator stopping every stream = exit 0 | One place sees every sink; no new process | Host-side guard |
| D181 | 2026-11-03 | Loss = (network-dropped + encoder-skipped + render-lagged) / (sent + skipped + lagged); 1 % whole run after 30 s, 3 % any 10 s window, windows under 60 frames not judged; budget in `data/outputs/guard/live-test-budget.json` (user decision 2026-11-03; 60 frames, 2 s poll and 20 s stop wait are agent defaults) | User's budget; counters reported separately | Network drops only |
| D182 | 2026-11-03 | `data/outputs/alpha-live.json` uses the 1080p60 17 Mbps preset for the first tests | User-confirmed live settings | 1440p60 34 Mbps |
| D183 | 2026-11-03 | P16a export-only posting in Node (`services/posting/`), flag `posting` off by default; output `posts/<clip>/<target>/` with byte-copied video, ffmpeg cover, captions, post.json; privacy fixed "private", status draft; no upload, OAuth or network code (user-approved step 1) | One writer shared with the studio server; profile resolver is Node | Python packager in services/clip |
| D184 | 2026-11-03 | Packager offers only variants whose report.json says PASS for that target; layout order is data (`data/posting/templates.json` layoutPreference) | Never offer a file that failed validation | Offer all layouts |
| D185 | 2026-11-03 | Post text from `data/posting/templates.json` placeholders resolved from the local profile at export; unresolved placeholders and over-limit text are flagged and block approval, never truncated; no chat text, viewer names, marker notes or candidate reasons | Privacy scrub; chat is untrusted | Auto-truncate |
| D186 | 2026-11-03 | Posting limits in `data/posting/limits.json` stay UNVERIFIED (checked null) until checked against official pages | No invented verification | Hardcode in code |
| D187 | 2026-11-03 | Ledger `<dataDir>/posting/ledger.json` keyed video SHA-256 + target prevents repackaging; upload steps reuse it. Packager CLI and studio must not write it at the same time (single user; a lock file if that changes) | Idempotent exports | SQLite |
| D188 | 2026-11-03 | Host tests that count NVENC sessions subtract the GPU-wide count taken before the host starts | NVML counts other apps' sessions; a CI run failed with 3 != 2 while another app held one | Per-process NVML query |
| D189 | 2026-11-03 | Supersedes D186. Posting limits checked against official API pages (limits.json 0.2.0, `status: verified`, source + date per target). Limits are per platform field, composed as the uploader sends it, with the platform's counting unit (YouTube description = UTF-8 bytes, TikTok/Instagram = UTF-16 units, titles = code points); YouTube forbids `<` `>`, ignores all hashtags above 60; Instagram allows 30 hashtags, 20 mentions | Malayalam text is 3 bytes per letter, so a character count would pass text YouTube rejects | Count code points everywhere |
| D190 | 2026-11-03 | CI batching (user, 2026-11-03): pre-commit runs the private scan + quick steps (`ci.mjs --quick`: build, lint, build-host, validators, private scan, legacy verify); the full CI runs about hourly and a full pass on an unchanged tree writes a stamp (`<git-dir>/ujwalam-ci-pass.json`, tree hash); pre-push refuses a commit whose tree has no stamp. No tests run while a full CI runs | Full CI takes ~12 min per commit and timing tests flake when runs overlap; small commits stay cheap, pushes stay fully tested | Restore `exec node tools/ci.mjs` in pre-commit and drop the ci-stamp line from pre-push |
| D191 | 2026-11-03 | No console windows and no focus stealing (user, 2026-11-03: "random terminal windows popping"). Every child process asks for no window: JS `windowsHide: true` inside the call, Python `creationflags` (CREATE_NO_WINDOW) or the module's `**NO_WINDOW`; lint rule `hidden-window` enforces it. Only exception: a GUI program the user asked to see (explorer "Open folder"), written `windowsHide: false // GUI window: <reason>`. Preview windows are WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW, shown with SW_SHOWNOACTIVATE, never SetForegroundWindow; a click does not activate them (MA_NOACTIVATE). They open only on a second display (the built-in laptop panel when it is not the main display, else the first non-main display), x/y clamped into its work area; one display: refused (CONFLICT). `--headless` / `UJWALAM_HEADLESS=1` (set by `tools/ci.mjs` for every step): no previews, no browser. Previews are NOT click-through: they are operator windows (move, resize, close), and layered + transparent styles on a D3D swapchain window are untested | 125 child-process calls opened a console window when the parent had none (e.g. agent shells, scheduled tasks); previews took focus with SetForegroundWindow on the main display | Hide only test processes; keep previews on the main display |
| D192 | 2026-11-03 | "wind up" command and live stream test rules adopted into AGENTS.md (user, 2026-11-03). User's choices: stream keys stay in Credential Manager (the proposed STREAM_KEY_* environment variables are not used); the chat feedback question is posted by a Streamer.bot action, Ujwalam's connection stays read-only and only collects replies into gitignored `feedback/`; wind up ends a running nightly backup but keeps its schedule; the wind-up email is sent automatically to the user's own address through the connected Gmail account | Environment variables reach every child process (overlay server, browser layers, ffmpeg); a read-only connector cannot be abused to post in chat | Keys from environment variables; Ujwalam posting in chat |
| D193 | 2026-11-03 | Streamer.bot and Speaker.bot are managed, not bundled: Ujwalam detects the user's installed copies, starts them hidden, shows health, stops only what it started (flag `bot-manager`); plan `docs/plan/2026-11-03-bot-manager-plan.md`, BM1–BM7 in Alpha 0 before A0-S1, BM8 (DoAction for effects) in P15 | Closed-source freeware; redistribution terms unchecked; bundled copies go stale | Ship them inside the zip |
| D194 | 2026-11-03 | Bot manager choices (BM1, BM2, BM6): (1) the template carries placeholders for `bots.*_ws`, not the default addresses, because every string in `data/profile.local.json` is a private term for the git hooks and a copied default address would block commits of the code that holds it; unset or placeholder means the default (Streamer.bot 8093, Speaker.bot 8083); (2) "started by Ujwalam" is pid plus the process creation time in `<dataDir>/bots/state.json`, so a reused pid never matches; (3) health is a bare TCP connect and close, no WebSocket frame is sent to either bot; (4) a bot whose process list fails is an error, never "not running"; (5) `tools/stray-procs.mjs` lists bots Ujwalam started and left running as a report only, the stray-mocks CI step is unchanged; (6) studio stop closes the started bots only while the flag is on; (7) the Bots card is refreshed every 15 s because each check lists processes | Keeps the privacy scan usable, the user's own copy untouched and the read-only rule (D192) | Remove `services/bots`, the card and the flag |
| D195 | 2026-11-03 | Test-stream feedback (BM5): `tools/collect-stream-feedback.mjs` opens `event-core.db` read-only and copies `chat_raw` rows into `feedback/YYYY-MM-DD-stream-feedback.md`. A row counts if it starts with the marker (default `fb:`) or arrives within 10 min after a question. A question is a stored row whose text starts with the configured question prefix (optionally only from the bot's display name), or an explicit time (`--question-at`). Output lines are escaped, single-line, capped at 500 characters and keyed on event id, so a re-run adds no duplicates. | `chat_raw` holds event id, time, platform, display name and text only: no role or bot flag, so the question is matched by its text, and explicit times cover the case where Streamer.bot's own post is not stored. Read-only open keeps one writer per database. Manual CLI, not wired into a service, so no flag. | Wire into the bot manager later behind `bot-manager`. Alert rows share `chat_raw`, so an alert text inside a window can be copied too. |
| D196 | 2026-11-03 | Test broadcast banner (BM3): a new page `services/overlay-server/pages/ujwalam-test-broadcast/` (plain script, tokens from `brand/tokens.css`, opacity plus a short slide, entrance 450 ms, exit 300 ms, hold 18 s, every 900 s), served at `/overlays/ujwalam-test-broadcast/` through a new `ownOverlays` option of the static server (only folders named `ujwalam-*`; `legacy/` untouched). New function `timed-banner` and preset `test-broadcast` (text, label, timing and flag id are params, passed in the layer query). Layer always built on top of Default H (top of the game area) and Default V (inside the proposed safe area). Feature flag `test-broadcast`, default off, switches live: the overlay server answers `GET /_ujwalam/flags.json` with the state of the flags in `OVERLAY_FLAGS` only (read from the data dir the profile names, through `services/flags`), the page polls it every 5 s, shows the banner when the flag turns on, then every 15 min, and hides it at once when it turns off; any failure reads as off. The banner is timer driven, so it takes no effect budget. | The host has no RPC to change a layer's visibility and a host change needs a rebuild; the overlay child is plain JS and resolves the data dir from the profile like every other service, so no host change is needed. Only flag booleans on the allowlist reach a page: no token, no other state | Drop `flagsJson` and the route; gate the layer at project build instead (needs `--rebuild-alpha` after each flip). V safe area numbers (6 percent sides, 8 percent top, bottom edge 22 percent) are proposed, not taken from a platform source. |
| D197 | 2026-11-03 | BM7 clash check: `tools/bot-clash-check.mjs` is read-only (stdout only; exit 0 no clash, 1 clash, 2 a check could not run). Bot ports: listener owner by process name only, never command lines; an unreadable owner counts as a clash. A static scan proves no Ujwalam code binds a bot port. Ujwalam hotkeys are read from `app/host/src/host_config.h`; Streamer.bot hotkeys (key combos only) only from a hotkey file next to `paths.streamerbot_exe`, else a manual item. Audio device and duplicate alerts are manual items in `docs/tests/2026-11-04-A0-S1-bot-clash-checklist.md`, filled on the first private test; fixes go in v1 | Machine-check what is safe to read; keep bot settings (tokens, keys) unread | Delete the tool; use the checklist alone. UNVERIFIED: Streamer.bot hotkey file name and format; the connector default 8080 (`connector.mjs`) differs from the real 8093 and needs `--url` |
| D198 | 2026-11-03 | The studio starts the event core with `--url` set to the bot manager's Streamer.bot address (profile `bots.streamerbot_ws`, else `ws://127.0.0.1:8093/`, D194); a refused address (not loopback) is never passed and a note is printed; `--mock` passes none. The connector default stays Streamer.bot's documented 8080 for the plain CLI | Found in review of BM7: without it the live event core dialled 8080, where the user's Streamer.bot is not listening, so no chat would reach the chat list, effects or the BM5 feedback store on the first real stream | Drop `coreServeArgs`; pass `--url` by hand |
| D199 | 2026-11-03 | Report button (flag `report-button`, off): the control page opens a prefilled GitHub new-issue URL in the user's browser. Ujwalam sends nothing (no API, no token). Repo URL only from profile `links.issues_url`, strictly `https://github.com/<owner>/<repo>`; title, note and whole body pass `tools/diag/redact.mjs`; body holds version, OS, flags and counts-only diagnostics; URL capped at 6000 characters with a truncation note | Lets the user file a bug in seconds during and after test streams, without a token in Ujwalam and without leaking private terms | Remove the flag and route; file issues by hand |
| D200 | 2026-11-03 | The overlay root must hold `overlays/` (and `brand/`, `kit/`); `overlayRootProblem()` in `app/host/lib/config.mjs` checks it in both launchers, and a wrong root turns overlays off with a clear note instead of starting them blank | Found during the BM3 capture: the local host config pointed one level too deep (`legacy/overlays`), so every legacy overlay page and its brand/kit styles returned 404 and all browser layers rendered empty | Keep the old existence-only check |
| D201 | 2026-11-03 | P16b (private YouTube upload) is deferred until after the first real stream; posting stays export-only (P16a). The 10 leftover agent worktrees were removed after a content check (every file present in the branch, two moved or renamed since); their `legacy`/`node_modules` junctions were unlinked without touching the targets | User: "decide based on the final objective". The objective now is the first real stream (5-6 Nov); an upload path needs OAuth, a real post and its own review, none of which help that stream | Start P16b now |
| D203 | 2026-11-03 | First real stream: no spoken announcement. The Speaker.bot step of the Streamer.bot test action is skipped; the test notice is carried by the on-screen banner (BM3) and the chat question (BM4). The AGENTS.md rule that Speaker.bot reads the announcement applies again from the next stream unless the user says otherwise | User: "skip speakerbot setup now" | Add the Speaker.bot step before the stream |
| D202 | 2026-11-03 | GitHub Actions CI (`.github/workflows/ci.yml`, windows-latest, pushes to `claude/**` and pull requests to `master`) runs `npm run ci` with `UJWALAM_CI_ENV=cloud`. `tools/ci.mjs` then lists the steps that need laptop-only inputs (`LAPTOP_ONLY`: build, build-host, test-host, test-py, test-ocr, test-capture, validate-registry, private-scan, legacy-verify, bench) as `NOT RUN (laptop only: <reason>)`, counts them apart, and fails only on steps that ran. A cloud run never writes the push stamp (D190): only a full laptop pass may stamp a push. No secrets, no artifact upload, read-only token | The private repo gets an independent clean-checkout check (missing files, wrong paths, Node-version drift) without pretending the cloud covers libobs, GPU, OCR, the legacy reference or the private-term scan | Keep CI laptop-only |
| D204 | 2026-11-03 | Chat-fired effects go through the effect guards and the `chat-effects` flag. `data/overlays/feed-scopes.json` `effectPages` maps chat-charge to `charge` and chat-storm to `storm`; their studio layers connect at `sbPath=/effects/<name>`, so each chat-fired play is gated per message. The overlay server refuses chat-source effects (`flag-off`) and stops the cam-pop rule while the flag is off; it reads the flag on every decision, so a flip acts live. No flags object means off. API and test-button sources skip the flag. Evidence `2026-11-03-chat-effects-flag-and-effect-pages.md` | Chat effects bypassed the guards (pages on the plain feed) and the flag gated nothing; AGENTS.md: new features behind a flag, off by default, switchable live | Revert the three files; pages fall back to the plain feed |
| D205 | 2026-11-04 | Bot manager work deferred: no further BM items (Streamer.bot test action and timer, manual clash items, BM fixes) until the user reopens it. Built code (Bots card, start/stop, clash checker, test banner) stays as it is | User: "don't work on it now. it will be worked on later" | Reopen on the user's word |
| D206 | 2026-11-04 | D145 resolved: Meld session files carry an outer wrapper `version` (1) and an inner schema `session.version` (2 or 3). The importer accepts the wrapper-less live shape when the inner version is 2 or 3 and refuses others; the report has `sessionVersion` and `sessionSchemaVersion`. Evidence `2026-11-04-meld-import-wrapperless.md` | The live session file was refused; the D145 note misread the inner version as 1 | Revert `import-meld.mjs` |
| D207 | 2026-11-04 | Jev credit key stored by the user in Windows Credential Manager under `Ujwalam/decisions/jev` (generic credential; presence verified with `node services/event-core/cli.mjs credential status --target Ujwalam/decisions/jev`, value never read by the agent). Correction same day: the 5 USD is the **total account balance**, not a daily cap — once cumulative spend reaches 5 USD, Jev calls stop and the app runs on `LocalProvider` only, permanently (not reset by a new day), until the user tops up and raises the figure. J1 (`DecisionProvider`/`JevProvider`/`LocalProvider`, redaction, cumulative-spend tracking) is still not built (parked with the training track, `docs/backlog/2026-10-28-training-track-parked.md`); nothing calls Jev yet. When J1 is built: track cumulative spend (not daily) against 5 USD, persist the running total across restarts, and once reached, switch to `LocalProvider` and never retry Jev until the user raises the cap | User has Jev credits, a fixed 5 USD balance, auto-switch to local decisions after it's used | Remove the credential and this line |
| D208 | 2026-11-04 | Claude Code model routing (`CLAUDE.md`) extended: Codex CLI added as a second cloud model, used for (1) independent parallel phases on their own branch/worktree and (2) mandatory second-opinion review of Opus-gated high-stakes phases before they're marked done. Every cloud model (Opus, Codex, Sonnet) now runs at **medium effort** — no high-effort tier; precision comes from task routing and cross-model agreement, not from spending more effort on one model. Haiku added as a mechanical-only tier (CI log triage, evidence-doc scaffolding, boilerplate data entry, lint-fix passes), always test/schema-verified, never self-certifying. Local model (Qwen2.5-Coder, via LM Studio/Bionic — see D209) added at the same mechanical tier for zero-cost/offline bulk work, with the rule: never loaded while MeldStudio or a live/test stream runs (6 GB VRAM, D1) | User: route cloud models at medium effort; add Codex; keep precision/speed/token-efficiency un-compromised | Revert `CLAUDE.md`'s routing section |
| D209 | 2026-11-04 | Local dev model wired up: `qwen2.5-coder-7b-instruct` (Q4_K_M, 4.68 GB) downloaded and loaded in LM Studio, server on port **1235** (not the LM Studio default 1234 — check before reuse). Registered in Hermes as a named custom provider `providers.local-qwen` (`api: http://localhost:1235/v1`, `default_model: qwen2.5-coder-7b-instruct`) via `hermes config set`, not the `model_aliases`/`model_overrides` keys (those produced "not a recognized config key" warnings — the real schema for a keyless local OpenAI-compatible server is `providers.<name>.api` + `default_model`). Verified round-trip with `hermes chat --provider local-qwen -q "..."`. Rule unchanged from D208: never load while MeldStudio or a live/test stream runs | User downloaded the model and asked to link it to Hermes | Unset `providers.local-qwen`; unload the model |
| D210 | 2026-11-04 | Twitch RTMPS added (resolves D148's open item: the stream key previously went unencrypted in transit over plain RTMP). Verified directly against Twitch's live ingest API (`https://ingest.twitch.tv/ingests`): every one of the 14 ingest servers carries a `url_template_secure` (rtmps) alongside `url_template` (rtmp), same host, no port in either (default 1935 plain / 443 secure) — previously marked `unverified` because the static docs page shows only the RTMP example. `data/platforms/twitch.json` protocols now `["rtmp","rtmps"]`, sourced to the live API; `data/outputs/alpha-live.json` and the `youtube-1080p60` preset's Twitch sink switched to `rtmps`. Two check rules fixed openly (not worked around): `tests/outputs/schema.test.mjs`'s URL-placement test now also allows `ingest.value.urlFormatSecure`; its official-source allowlist now includes `ingest.twitch.tv`; the "platform doesn't support this transport" negative test swapped its example from Twitch+rtmps (now valid) to Kick+rtmp (still genuinely refused, Kick's protocols stay `["rtmps"]` only). 25/25 + 12/12 local test passes. Evidence `2026-11-04-twitch-rtmps.md` | Twitch RTMPS was listed as unresolved/"Later" since D148; verified directly rather than left UNVERIFIED | Revert the platform/preset/plan JSON and the two test-file changes |
| D211 | 2026-11-04 | Report button (D199, flag off by default) now configured: `data/profile.local.json` `links.issues_url` set to this repo's own public GitHub URL (gitignored file, not committed; the account name is kept out of committed docs same as any other profile value, even though it's visible from the git remote itself now the repo is public). Verified `parseIssuesUrl()` resolves it. The flag itself stays off; the user turns it on from the control page when wanted | `links.issues_url` was the one missing piece for the already-built report button; the repo being public removed the reason it was left unset | Clear `links.issues_url` from the local profile |
| | 2026-11-04 (open, flagged to user via WhatsApp, not a D-numbered decision) | Bench regressions become CI-failing from `ENFORCE_FROM` 2026-11-06 (2 days out). Reproduced twice on a quiet machine (no MeldStudio, background load under the noisy threshold): `event-core-audit-full`/`audit-write` throughput ~14-15 % slower, `private-scan-worktree-wall` ~66-75 % slower, `registry-validate-wall` ~48 % slower, `stall-tracer-overhead.idle_main_busy_ms_per_min` ~44-160 % slower (noisier). Baseline dates to 2026-10-30 (`out/bench/accepts.jsonl`, commit `6bfb583d97bb`, 5 days old). Four unrelated subsystems regressing together points to general machine drift (Windows updates/disk/thermal) rather than one code bug, but no root cause confirmed. Per the project's own rule (L2-old, D131), a baseline change needs the user to review old vs new numbers first — not decided or `--accept`-ed by the agent | Time-sensitive, needs the user's review before 2026-11-06 | — (nothing changed yet; `--accept` only after the user reviews) |
| D212 | 2026-11-04 | `LICENSE` filled in with the full verbatim GPL-2.0 text (previously a short placeholder with just the SPDX id and a link). Fetched from `https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt`; the project-specific copyright line uses "Ujwalam" and the git-commit author name, per the GPL's own "How to Apply These Terms" template. `docs/licence-headers.md` updated to match. Preparation work from `docs/licence-headers.md`'s own TODO, done now rather than at P17 because the repo going public makes it the live LICENSE a visitor sees, not just packaging prep | The repo going public made the placeholder visible/live rather than internal-only prep | Revert `LICENSE` and `docs/licence-headers.md` |
| D213 | 2026-11-05 | TikTok dropped from v1 F7 (user: not needed, too few followers). The built-but-uncommitted inbox-draft client is parked, not lost: patch `%LOCALAPPDATA%\Ujwalam\wip\2026-11-05-f7-tiktok-draft.patch`, files in `%LOCALAPPDATA%\Ujwalam\wip\2026-11-05-tiktok-files\`. YouTube Shorts (private upload) and Instagram export-only stay. | User instruction | Apply the patch |
| D214 | 2026-11-05 | Event core gets a least-privilege host token (role markers: marker.add with sources chat/audio, mixer.list only; host enforces, every other method 403). Full host tokens stripped from the event core's env. Live-markers stays off until a Codex second-opinion review of this change. | Event core handles untrusted chat; full token could start/stop outputs | Revert the scoped-role commit |
| D215 | 2026-11-06 | Lint rule fix: `trailing-ws` does not apply to unified diffs (`.diff`/`.patch`). A blank context line is a single space by format, and the vendored obs-nvenc patch must stay byte-identical to upstream `bd96ff53dd`. Only that rule is off for those files; secret, user-path, eol and spdx still run (rejected alternative: `*.diff binary`, which would skip every rule). Test in `tests/lint.test.mjs`. |
| D216 | 2026-11-06 | Bench: baseline accepted from a clean full CI run (reason "project growth from v1 work, user-approved 2026-11-06"; private-scan wall +29 % from v1 growth). Then `npm run bench -- --calibrate` re-measured noise (10 runs): `stall-tracer-overhead.idle_main_busy_ms_per_min` has stddev 74 on mean 94 ms/min, so its minDelta (3 x stddev) is 222 and the metric no longer gates in practice. Follow-up: redesign that metric to measure steadily (longer window or busy-time percentile), then recalibrate. |
| D217 | 2026-11-06 | Posting CLI live check (`auto --run`, `youtube upload`) reads every host discovery file that may exist: the studio's `<event-core data dir>/host.json` first, then the standalone host's. A running host whose state cannot be read (no host token in the shell) refuses; a stale file (pid gone) is skipped. Before: only the standalone file was read, so a live studio session read as "nothing live" (found in the stream-day mock run, `docs/evidence/2026-11-06-stream-day-mock-run.md`). Effect: from a shell, these commands refuse while the studio runs; use the control page (Posts view), which has the host link. Undo: revert `outputsStatusFor` in `services/posting/cli.mjs`. |
| D218 | 2026-11-06 | User choices after the stream-day mock run: chat-speed live markers wait a 2-min warm-up (`data/clip/live-markers.json` chat.warmupSec 120; other thresholds stay proposed); chat-effects ON for the first real test stream; D217 shell refusal while the studio runs is kept. |
| D219 | 2026-11-06 | Qt studio shell (P5a) window rule: the shell window and its embedded previews open on the second display when there is one, shown without activation; with one display they show on it (the user opened the app). Stand-alone host preview windows keep D191 as written (second display only, none on one display). Embedded previews follow the shell window's display. User asked twice for the question in plain words and did not pick; recommended default applied (D219 decided, not user-chosen). | A window the user opens on purpose is not a pop-up; D191 targets windows that appear by themselves | Strict D191 for embedded previews: restore the host's primary-display refusal in `Previews::open_embedded` |
| D220 | 2026-11-06 | Qt studio shell is a native client of the studio UI server (same login key, CSRF, allowlist, typed confirmations); it never holds host or event-core tokens. Qt 6.8.3 MSVC2022 x64 kit via aqtinstall in `_vendor/qt-6.8.3` (user-approved install); `aqt-venv` separate from the project `.venv`. `npm run alpha -- --shell qt` starts it; closing it never stops outputs. | One policy point; no new token holder (D40) | Web control page stays; drop `--shell qt` |
| D221 | 2026-11-06 | Game audio channel (Meld-style): when the capture card exposes a separate audio input (role `game-audio`, preset `device-live-gamer-ultra-21-audio`), the Game mixer channel is that WASAPI input, not the capture layer's audio. The capture layer's own audio stays out of the mix. Fallback without that input: the layer audio as before. User report: headphone audio lagged; "Meld performs better". | libobs `wasapi-output.c` `process_audio_delay` holds monitored audio of a source with video until its video frame time, so monitoring a capture layer always lags; a pure audio input has no video, so no delay | Bind no `game-audio` role (profile override), and the layer audio is the Game channel again |
| D222 | 2026-11-06 | Audio monitoring: host config `audio.lowLatency` (libobs `obs_reset_audio2`, max buffering 20 ms, fixed buffering, as OBS low-latency mode) is on for the alpha studio. Host config `monitoringDevice` names the Windows output (matched by friendly name, one hit only) from profile `devices.monitoringOutput.name`; applied only with `--allow-devices`, else the Windows default. Mixer CUE button per channel (web page and Qt shell, RPC `mixer.setCue`): on = monitor and output (monitor only for a source with no mixers), off = none; a channel with video is marked "CUE delayed". CUE state is live-only for now (not saved to the project). | User: CUE like Meld is "extremely important" and must be realtime | Drop `audio.lowLatency` (1000 ms buffering) and `monitoringDevice` from the alpha host config |
| D223 | 2026-11-06 | Autosave of layer edits (P5b part): the studio UI server records successful `layers.setPlacement` and `layers.setVisible` calls into the alpha project file (debounced 1 s, schema-validated save; a failed save is reported, never partial). `layers.move` is not saved until the H/V shared layer order lands. | Host edits are live-only; the project file is the model of record | Start the UI server without `--project` |
| D224 | 2026-11-07 | Vertical clips are cut from the V canvas recording (layout `stream-v`, kind `canvas`, the `-v-` sibling of the H recording or `--v-recording`), so a clip looks exactly like the vertical stream scene. The three ffmpeg layouts (full crop, gameplay + facecam, blurred fill) stay available only on request. The blurred game background becomes a scene layer: a duplicate layer with a native Gaussian blur effect in the host (plus rounded corners), behind a feature flag. User review of 30 clips: "3 designs not good"; reference = the user's own vertical layout (blurred game copy, framed game, brand/socials). | One design for stream and clips; no second template to maintain | `--layouts full-crop,game-facecam,blurred-fill`, or remove `default` from `data/clip/layouts.json` |
| D225 | 2026-11-07 | Clip ranking "streaks only" (user choice): Triple Kill and above count (Triple 3, Fury 4, Frenzy/Super/Merciless/Ruthless 5, Nuclear/Ultimate Terminator/Relentless 6; Mega/Ultra Kill and Brutal placed in the top tier by the agent, UNVERIFIED); Double Kill, score pop-ups, single medals, MVP/Impact and BR feed 0; medal weights add up across a chain (`sumKinds`); `minScore` 3 (one Triple) except explicit requests (markers, chat "clip it"). Streamer death (N1 KILLCAM) is a hard negative: a clip ends 2 s before the KILLCAM label and never starts inside one; a clip left shorter than `clip.minSec` is dropped (user choice). | User: "Multi kills and chain of kills needs to focus more. Streamer's death is a hard negative." | Previous ranking.json from git |
| D226 | 2026-11-07 | Live clipping (user choice "automatic saves", like Meld): live detectors save the replay buffer (H + V) on a kill chain while streaming; clips land in a review list after the stream; hotkey and chat "!clip" also save; nothing is posted automatically. Blocker: the detector pass runs at about 0.6x real time (5763 s for a 3314 s recording, 4 threads, OCR every frame at 1 fps); it must OCR only the medal / kill-feed regions and skip unchanged frames to run live. | User: "Clipping needs to be done while streaming like meld" | Post-stream clipping only |
| D227 | 2026-11-07 | Live OCR on the GPU: a second venv `.venv-gpu` (same packages, `onnxruntime-directml` 1.24.4 installed `--no-deps` in place of the CPU runtime) runs the ROI detector scan at 1.93x real time (0.519 s/frame, same 77 rows as CPU on 0-120 s); CPU stays 0.82-0.84x. The live worker uses `.venv-gpu` when present, else `.venv` (CPU). | User choice "GPU OCR (Recommended)" 2026-11-07; 0.5 fps on CPU would miss 16-19 of 86 weighted medals and most single-frame deaths | 0.5 fps CPU sampling |
| D228 | 2026-11-07 | Live clipper process: `services/clip/live_worker.py`, started by the launcher with the alpha session when the H game layer is bound to a capture device; idles while flag `live-clips` (default off) is off, re-read every 5 s. Holds only the host `clips` token (frames.grab, replay.save, replay.status, marker.add source clip, host.status). Restarted at most 5 times. Saves go to `<data>/live-clips/<session>/saves.jsonl` (times, medal labels, file paths; no OCR text). Replay buffer 60 s (was 30) so a chain plus 15 s lead fits. `clipper.py live-review` merges overlapping saves and cuts stream-v clips from the V replay files. | D226; least privilege on the live path | Worker inside the event core; full host token |
| D229 | 2026-11-07 | CI runs the bench step right after build-host, before the test suites. Run last, after ~8 min of host/GPU/Python tests, `stall-tracer-overhead.ingest_p95_on_ms` read 0.14-0.16 ms twice against 0.02 ms run alone (baseline 0.01): a false regression from a still-loaded machine. Baseline and limits unchanged. | User: "continue build, why wait" (autonomy rules: fix a wrongly flagging check's rule, log, continue) | Accept 0.14 ms as baseline (hides noise) |
| D230 | 2026-11-07 | Mouse editing on the preview (P5, flag `preview-edit`, default off): the host handles the mouse in its preview window (embedded or pop-out). Click selects the topmost visible layer of that canvas (rotation respected; hidden layers skipped; letterbox clears); drag moves; corner drag resizes, aspect kept (Shift free); snap to canvas edges and centre within 8 screen px (Alt off); 3 px drag threshold, so a click never nudges. Moves apply live through `Studio::layer_set_placement` (the code of RPC `layers.setPlacement`); the release is one edit in a host log (`preview.edits`, `host.status.previewEditSeq`). The studio UI server (holder of the host token) polls that seq with host.status, records each edit through project-sync like an inspector edit, keeps the host switch equal to the flag (`preview.setEditing`), and puts `previewEdit` in its status snapshot so the web page and Qt shell reload the layer list. Live: `layers.setPlacement` has no live gate today (the inspector applies at once while live; only stream/record/flags/bots/project load ask for "yes, on air"), so the mouse path has none either; it adds no bypass. Not yet: arrows, crop, rotate handle, undo. | User request 2026-11-06 ("design like a normal software"); one edit path; no new token holder | Flag `preview-edit` off (default) |
| D231 | 2026-11-07 | HUD safe-zone warning (end-list L12/L13 option a, the recommended default; warn only): at alpha project load the launcher prints overlays above the game capture that cover >= 5 % of a CODM HUD zone (score/timer/medal, minimap, right buttons, left fire, bottom feed). Zones measured by the agent on 2 frames of the 2026-11-06 practice (unverified). Skips hidden, full-canvas, transparent and game-copy layers. Not in the alpha zip (game packs are excluded from the package), so it warns from the repo only. First run: the test-broadcast banner covers 51 % of score/timer and 60 % of the minimap on H. | Autonomy rules: recommended option, logged | Block the load; move layers automatically |
| D232 | 2026-11-07 | Default H test-broadcast banner moves from the top of the game (0.25, 0.04, 0.72 x 0.12) to the left column over the event list (0.008, 0.205, 0.228 x 0.33), beside the game like the V banner. The old rect covered 51 % of the CODM score/timer and 60 % of the minimap (D231 check). The event list is hidden while the banner shows (18 s every 15 min). Takes effect after `--rebuild-alpha`. | End-list L12 recommendation b (move overlays off the game), applied by default | Keep it over the game |
| D233 | 2026-11-07 | Preview editing follow-ups (D230). (1) Hit test: a browser layer covering >= 90 % of the canvas (the transparent effect and atmosphere pages) is skipped, so a click reaches the layer below; it stays editable from the inspector. (2) Live-lock: while any stream output is live, a press on the preview selects nothing (host `Backend.locked` = `Outputs::live()`), and the UI server switches host editing off; inspector `layers.setPlacement` and `layers.move` then need "yes, on air" (`liveConfirm`) and autosave after the confirm. Scene switches, show/hide and the mixer stay instant: they are the controls a live show needs. | AGENTS.md: studio writes while live need "yes, on air"; the agent's D230 report found both gaps | Remove `liveConfirm` / `locked`; drop the browser skip in `Studio::preview_items` |
| D234 | 2026-11-07 | Parent pipe: the studio launcher gives the event core, the host, the UI server and the live clipper stdin as a pipe plus `UJWALAM_PARENT_PIPE=1`. When the launcher dies, even by a hard kill (no signal on Windows), the pipe closes and each child stops cleanly by itself. The host stops only once no stream or recording runs (a supervisor crash never stops the stream or a recording) and re-checks every 5 s. Found when a hard-stopped launcher left the host, core, UI server and 2 clippers running (devices and ports held). | Orphans block the next start | Remove `PARENT_PIPE` from the spawns |
| D235 | 2026-11-07 | `clipper.py detect --project FILE`: on a Ujwalam canvas recording, only the game capture layer's area is scanned (placement, crop and device size from the project, scaled to the recording). The full-frame default read the scrolling bottom ticker, which shows the streamer's name, inside the M5 kill-feed ROI as own kills: 61 "own kills" on a 60 s cycle in the 2026-11-07 practice. The live clipper was not affected (it reads the game layer itself). | False own kills from overlays; same rule as the live path | Run detect without `--project` |
| D236 | 2026-11-07 | Kill montages (`clipper.py montage`, `data/clip/montage.json`): Shorts of 30-45 s (always 20-60 s) from the own kills of qualifying streaks, 3 s before and 1.5 s after each kill, dead time between kills cut, pieces closer than 4 s kept together, cut before a death, matches joined, hard cuts with an 80 ms audio fade, cut from the V recording. Length, padding, joins and match joining chosen by the user 2026-11-07; joinGapSec 4, chainGapSec 12, medalLeadSec 0.5 and medalMatchSec 3 set by the agent (proposed). Research (blogs and vendors only, no official YouTube figures): Shorts up to 3 min; 30-60 s linked with the most views, 15-30 s with the highest retention. | User request 2026-11-07 | Delete the command |
| D237 | 2026-11-07 | Won-match reel: detector W1 (VICTORY/DEFEAT, centre ROI x 0.40–0.60, y 0.35–0.50, role context, unverified; user approved 'Approve W1'). For each VICTORY, a montage W01.. holds every own kill of that match (3 s before, 1.5 s after, cut before a death) plus the VICTORY screen; no 60 s cap; V canvas. User chose 'Every own kill' and 'V' 2026-11-07; resultLeadSec 0.5 and resultHoldSec 3 set by the agent (proposed). | User request 2026-11-07 | Remove W1 and `match_reels` |
| D238 | 2026-11-07 | Undo / redo of layer edits (P5b): the studio UI server keeps the history in memory (newest 50, empty after a restart) for layers.setPlacement, layers.setVisible and layers.move from the inspector, the layer list and preview mouse edits (the host now reports `before`, the rectangle when the press began). Before an edit the server reads the layer from layers.list; only changed keys are stored. Undo/redo re-apply through the host and autosave like an edit; a new edit clears redo; refused while live (fresh host.status, fail closed) because live layout changes need the on-air phrase; a failed re-apply clears the history. Control page: Undo/Redo buttons, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z outside text fields. No flag: an editing aid, not a stream feature. | Plan P5b (undo) | Remove module, routes, buttons |
| D239 | 2026-11-07 | Scene transitions (P5b): per canvas `cut` or `fade` (0–10000 ms) in the host (`transitions.set` / `transitions.get`, `host.status.transitions`, a private `fade_transition` on output channel 0 per canvas). Project canvases carry `transition {type, durationMs}`; the Meld importer maps `sceneTransition` / `verticalSceneTransition` to a fade and warns on an enabled stinger. The UI server keeps the host on cut while flag `transitions` (off by default) is off, else applies the project values. Alpha project: H 2006 ms, V 1000 ms (Meld values). Stinger later. Evidence `docs/evidence/2026-11-07-scene-transitions.md`. |
| D240 | 2026-11-07 | Scene and layer add/remove from the control page (P5b), flag `scene-edit` (off by default). Kinds: copy of an existing layer (a duplicate pointing at the real layer, placements copied), colour, text, an existing project camera/capture device, an existing project overlay. services/project/structure.mjs changes the project (validated); the UI server applies it to the host first (`scenes.create` per canvas, `scenes.remove`, new host RPC `layers.addFromProject` building the one layer from the changed document with the last load's options, `layers.remove`), then saves the file. Refused while live; undo history cleared; removals of a copied or audio-bound layer, the start scene or the last scene refused. Evidence `docs/evidence/2026-11-07-scene-layer-structure.md`. |
| D241 | 2026-11-07 | Image and video layers from the stream assets folder (flag `scene-edit`). The folder (profile `paths.stream_assets`, else `<repo>/data/stream assets`, gitignored) is the `media` pathRef base of the alpha load; the add-layer form lists its images and videos and the server accepts only a listed file. Evidence `docs/evidence/2026-11-07-asset-layers.md`. |
| D242 | 2026-11-08 | Stinger transitions (flag `transitions`): host `obs_stinger_transition` swapped onto the canvas channel, file a pathRef under a load base, cut point `pointMs`; project schema adds the stinger type; Meld import maps an enabled local stinger (same drive as the other media) with its mid point, track matte and audio switch not imported (warned); the control page sets each canvas's transition; a host refusal makes that canvas cut, not retried. Evidence `docs/evidence/2026-11-08-stinger-transitions.md`. |
| D243 | 2026-11-08 | Layer order saved to the project (flag `scene-edit`): structure op `layer.move {scene, layer, canvas, direction}` moves the layer past the next layer on that canvas in the shared bottom-first project order; new host RPC `layers.orderFromProject` reorders every canvas from the document; then the file is saved. Refused while live, where the page keeps the live-only host move. Evidence `docs/evidence/2026-11-08-layer-order.md`. |
| D244 | 2026-11-08 | Stinger audio switch: a stinger's own sound reaches the canvas mix (measured; corrects the D242 evidence), so the project transition gets `audio` (stinger only, absent = true), the host mutes the stinger source when false, the Meld importer maps `audioEnabled`, and the transition form has a "Stinger sound" switch. Evidence `docs/evidence/2026-11-08-stinger-audio.md`. |
| D245 | 2026-11-08 | Real Meld sessions load end to end: the host accepts `canvases[].transition` without building it (the UI server applies it under the `transitions` flag; the refusal broke every Meld import since D239), and the audio source cap is 256 (schema, validator, host), since a Meld session keeps one audio entry per video layer (69 in a real session). Evidence `docs/evidence/2026-11-08-meld-sessions-load.md`. |
| D246 | 2026-11-08 | Chroma key layer effect (`chromaKey`, OBS `chroma_key_filter_v2`) and Meld ChromaKey import with a mapping fitted on the user's three real green-screen CTA videos (similarity = (threshold + feather) x 1000, smoothness = feather x 250; UNVERIFIED for other footage). The effects wrapper passes its target's audio through (composite `audio_render`), so items with effects keep their sound. Evidence `docs/evidence/2026-11-08-chroma-key.md`. |
| D247 | 2026-11-08 | Meld GaussianBlur and corner radii import onto the existing `blur` and `rounded` effects. Meld sizes and radii are read as canvas pixels and `scaleX` as canvas pixels per source pixel (the reading the fill-mode crop already uses), so strength = blurriness / scale and radius = min(radius, half the shorter side) / scale; rounding goes last, uneven corners keep the largest and are reported. Both readings are UNVERIFIED against a Meld render. Evidence `docs/evidence/2026-11-08-meld-blur-radii.md`. |
| D248 | 2026-11-08 | Default H/V presets 0.2.0: the subscribe pill (H, V), the subscribe-and-support animation (V) and a new confetti prompt (V, turned 270 degrees, from the user target layout) are keyed looping videos from the stream assets folder (base `media`, file names in local profile keys `assets.*`), with the Meld-imported key values. They are shown only with feature flag `layer-effects` (no green box when off); a missing profile key leaves a transparent placeholder without effects (fixes effects on a missing-asset placeholder). A video wordmark is keyed via the new preset field `videoEffects` (a still is never keyed). Preset layers may carry `rotation` and `opacity`. Evidence `docs/evidence/2026-11-08-cta-videos.md`. |
| D249 | 2026-11-08 | Microsoft Defender quarantined the built host (`out\host\build\ujwalam-host.exe`) as `Trojan:Win32/Bearfoos.A!ml`, a generic machine-learning detection, during CI test-host (test failed with `spawn UNKNOWN`). Treated as a false positive. The host now carries a version resource and an application manifest (asInvoker, Windows 10/11). The user submits a false-positive report and adds a Defender exclusion for the build folder only (user's choice, admin command run by the user). Code signing stays open for P17. Evidence `docs/evidence/2026-11-08-defender-host.md`. |
| D250 | 2026-11-08 | Live audience counters (flag `live-counters`, off). Streamer.bot has no request for follower/subscriber counts, so the user keeps them in persisted Streamer.bot globals with their own action (names in `data/counters.json`), and the event core only READS them (`GetGlobal`, every 60 s) and publishes `system.counter` when one changes; a live follow (Twitch, Kick) adds 1 to a known count until the next read. The overlay server caches the latest values and serves `/_ujwalam/counters.json` (only while the flag is on); the new page `ujwalam-counter` shows "label N noun". The default H/V presets use it for the Twitch and YouTube counters (presets 0.3.0). Also fixed: the overlay server's remote bus ignored subscribers' `kinds`. User choice 2026-11-08: counters via Streamer.bot. Evidence `docs/evidence/2026-11-08-live-counters.md`. |
| D251 | 2026-11-08 | Scene preset layers can keep their file's true shape: `fit: "contain"` scales the picture to fit the preset box and centres it; `cropBars: true` cuts the file's black bars first (placement crop, source px). Sizes and bars come from `services/project/media-info.mjs`: ffprobe plus our own bar check on 1 gray frame per second of the first 8 s (a row/column is a bar when at most 5 % of its pixels are brighter than luma 24, so a small watermark inside a bar does not end it). ffmpeg's cropdetect is GPL-only and the LGPL ffmpeg in use has none. Without ffprobe, or for an unreadable file, the box stays stretched as before. The H wordmark uses it (preset 0.4.0); the user's wordmark video is 1280x720 with bars 102/103 px left/right. User choice 2026-11-08: "Crop bars, keep shape". Applies when the alpha project is rebuilt (`--rebuild-alpha`). Evidence `docs/evidence/2026-11-08-wordmark-fit.md`. |
| D252 | 2026-11-08 | Preset field `trimKey` (a screen colour, green or blue): for a VIDEO layer with `fit: "contain"`, the crop also cuts the border that is only ever dark or that colour (at most 0.2 % of its pixels otherwise, over 2 frames per second of the first 8 s), padded by 2 % so frames between samples are not clipped. A still is not keyed, so `trimKey` is ignored for it. The H wordmark uses it with #00ff00 (preset 0.4.1): crop 172/104/170/182 of 1280x720, so the text shows at 224x104 px instead of about 130x60. Checked over all 187 frames: 4 pixels of 24.5 million fall outside the crop (compression noise). The probe now reads rgb24 frames (2 per second, scaled down by a whole factor to at most 1280 px wide). User choice 2026-11-08: "Trim green border". Evidence `docs/evidence/2026-11-08-wordmark-fit.md`. |
| D253 | 2026-11-08 | Meld import, fit modes: the fill crop (fitmentMode 2: scaled uniformly, clipped to the box, centre crop in source pixels) now covers media, image and duplicate layers too, not only video devices. A host duplicate draws the target's raw shared source with its own placement crop, so nothing is cropped twice. A picture that already equals the box (either mode) needs nothing and is no longer reported. The old catch-all "fitmentMode other than 0" (112-148 per real session) is split: no known picture size, browser/text layers, or a picture smaller than the box. offsetX/offsetY is reported only when it is not 0. Real sessions 27/28/29 Sep: new crops for 9/10/9 duplicates and 2/4/2 media layers; capture crops 20/23/20 are unchanged. UNVERIFIED against a Meld render, like the capture case. Evidence `docs/evidence/2026-11-08-meld-fill-crop.md`. |
| D254 | 2026-11-08 | Arrow-key nudges (P5, under flag `preview-edit`; D230 had left them out). The host preview windows never take focus (D191), so the keys belong to the control page: with a layer selected and focus outside a text field, an arrow moves it 1 canvas px, Shift 10 px, through `layers.setPlacement` (same path as the inspector, so autosave and undo apply). Presses made while a move is on its way add up into one call, so held keys do not flood the host or the undo list. Off while live: each press would need the typed "yes, on air". A confirm verdict is cancelled at once and a note points to the inspector. The Qt shell does the same (window shortcuts, gated on status `host.previewEditing`, cached placement updated between calls); built with `npm run build:studio`, UNVERIFIED at runtime. Evidence `tests/studio-ui-nudge.test.mjs` (vm, stub DOM); UNVERIFIED in a real browser. |
| D255 | 2026-11-08 | Rotate handle on the preview (P5, under flag `preview-edit`; D230 had left it out). A diamond 24 screen px above the middle of the selected layer's top edge (turns with the layer). Dragging it turns the layer about its centre by the angle the cursor sweeps; Shift = 15 degree steps; stored to 0.1 degree in -180..180. The gesture changes only `rotation`: the live patch, the committed edit and its `before` (undo, D238) are `{rotation}` alone, so position and size never move. Backend::apply now takes the placement patch (patch_json) instead of a rectangle. Evidence: docs/evidence/2026-11-08-rotate-handle.md. |
| D256 | 2026-11-08 | Crop on the preview (P5, under flag `preview-edit`): Alt + drag on an edge of the selected layer (in its own frame, so a turned layer crops along its turned edges) crops that side. The source is cut by the same share as the box edge moves (source px per canvas px kept), so the picture never stretches and the opposite edge stays put; the crop is whole source px, at least 1 px stays, dragging out stops at 0. Corner and rotate handles win over an edge; without Alt a press on the edge moves. The edit is x, y, width, height plus the whole `crop` (undo restores both). Needs the source size from libobs: a source that reports 0 x 0 (not loaded yet) has no crop gesture. Evidence: docs/evidence/2026-11-08-preview-crop.md. |
| D257 | 2026-11-08 | Shadow and glow layer effects (`shadow`, `glow`; host filter `ujw_shadow`, flag `layer-effects` as before) and Meld DropShadow / GlowStyles import (the user's real session uses them 143 times). A blurred copy of the layer's alpha in one colour, offset (shadow) or spread (glow), drawn under the layer. Units are canvas px of the layer as placed, so a shadow looks the same at any source resolution: size = blur reach (sigma = size / 3), distance = offset, angle = where the light comes from (Photoshop convention: 0 right, 90 above), glow spread 0..1 lifts the alpha (Meld choke). The shadow reaches past the box: the filter's output grows by the reach (outset = distance + size, glow size) on every side, and Studio grows the item's bounds by the same so the picture keeps its place and size (centre unchanged, so rotation is unaffected); the filter converts canvas px to its input px from the box Studio sets (set_box). Max effects per layer 4 -> 6. Import order: chromaKey/blur, rounded, then shadow/glow (the rounded shape casts them); GlowStyles edgeStyle other than 0 is reported. Meld units and angle convention UNVERIFIED against a Meld render. Blur code split into reusable Gauss helpers (same output). Evidence: docs/evidence/2026-11-08-shadow-glow.md. |
| D258 | 2026-11-08 | Colour layer effects (flag `layer-effects` as before) and Meld BrightnessContrast / HSV / CCToner import (the user gives no Meld reference renders, so Ujwalam's own effects with documented units, adjustable in the app). `color` {brightness, contrast, saturation -1..1 with 0 = unchanged, hue -180..180 degrees} runs on OBS's own colour correction filter (`color_filter_v2`, obs-filters), no new shader. `toner` {shadows, darktones, midtones, brights, highlights as #RRGGBB, amount 0..1} is a new host filter `ujw_toner`: each pixel's luma (Rec. 709 weights) picks a colour between the five tones (at 0, 0.25, 0.5, 0.75, 1), linearly, mixed with the original by amount; alpha kept. Import mapping, all UNVERIFIED against a Meld render: BrightnessContrast brightness / 150 (Photoshop's +-150 range), contrast / 100; HSV (signed -1..1 values seen) hue = hueAdjust * 180, saturation = satAdjust, brightness = valAdjust, colorize and per-colour adjusts reported; CCToner -> toner, weight -> amount. Meld's effect order is kept. Evidence: docs/evidence/2026-11-08-color-toner.md. |
| D259 | 2026-11-08 | Corner pin layer effect (`cornerPin`, flag `layer-effects` as before; host filter `ujw_corner_pin`) and Meld CornerPin import. The layer is drawn into the quad of its four corners (topLeft, topRight, bottomRight, bottomLeft, x and y each 0..1 of the layer's own frame, y down); outside the quad it is transparent. The host computes the unit-square-to-quad homography (Heckbert 1989) and its inverse on the CPU; the shader maps each output pixel back to the layer. A collapsed quad shows nothing. Corners outside the layer are not supported (the output keeps the layer's box): import clamps them to 0..1 and reports it; an untouched pin imports nothing. Import keeps corners to 4 decimals and Meld's effect order. Meld's corner reading UNVERIFIED against a Meld render. Evidence: docs/evidence/2026-11-08-corner-pin.md. |
| D260 | 2026-11-08 | Effect editor in the native studio window (user 2026-11-08: tune each effect in the app, native UI over the browser page), flag `effect-editor`, off by default. Host `layers.setEffects {scene, layer, effects}` replaces a layer's whole effect list on every canvas (effects belong to the layer, so no canvas field): the list is checked and every new wrapper chain built before anything changes, then each item is swapped for a new one at the same order position with the same placement and visibility (added hidden, placed, then shown, so no frame at the source size); an empty list removes the effects. UI server: allowed only while the flag is on (also re-checked when a live confirm is executed), "yes, on air" while live, saved into the project (`layers[].effects`, empty removes it), undo/redo ("Effects <layer>"); the server checks only the shape (array of at most 6 typed objects, 4 KB), the host checks every value. Status gains `host.effectEditing`. Qt inspector: Effects panel (list, add by type, up, down, remove, per-effect number boxes and #RRGGBB fields with a swatch, Apply effects, Revert); unsent changes survive list reloads of the same layer. Qt panel UNVERIFIED at runtime (built, no shell runtime test). Evidence: docs/evidence/2026-11-08-effect-editor.md. |
| D261 | 2026-11-08 | Codex review of D259/D260 applied: layers.setEffects stages every canvas hidden then swaps per scene inside obs_scene_atomic_update (no half-done frame, no half-done canvas set); corner pins must be convex quads (host, validator, import report); corner-pin inverse normalised; Qt Apply answers only clear the draft they sent. Flaky test hardened: tests/proc-registry.test.mjs waited only 20 s for the core child under full-CI load (2026-11-08 run: missing rejection); now 50 s and an explicit "child registered" assertion. Evidence: docs/evidence/2026-11-08-effect-editor.md. |
| D262 | 2026-11-08 | Blinds layer effect (`blinds`, host filter `ujw_blinds`, flag `layer-effects` as before; also in the Qt effect editor) and Meld VenetianBlinds import (6 uses in the user's session). The layer is cut into parallel slats stacked along `angle` (degrees, y down; 90 = horizontal slats), `width` = slat width in % of the layer's larger side (1..100), the first `completion` share (0..1) of every slat is transparent, `feather` 0..100 source px softens that edge. Import: completion, direction -> angle, width, feather as given, clamped, 3 decimals. Meld units UNVERIFIED against a Meld render (width read as %, feather as px). Still not imported: FractalNoise (1 use). Evidence: docs/evidence/2026-11-08-blinds.md. |
| D263 | 2026-11-08 | Qt shell undo/redo (native UI parity, user 2026-11-08 "get UI ready"): Undo and Redo buttons in the top bar plus Ctrl+Z and Ctrl+Y / Ctrl+Shift+Z (window shortcuts; text and number fields keep their own undo). They call the UI server history (`POST /ui/api/edits/undo|redo`, D238), so the same refusals apply (live-locked, nothing-to-undo, edit-gone) and show in the status note; the buttons are disabled while live, while a call is in flight, or when the history is empty, and their tooltips name the next edit. State refreshes on each status poll. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-undo-redo.md`. |
| D264 | 2026-11-08 | Qt shell feature-flags panel (native UI parity): a "Feature flags" checklist under the layer list, one checkable row per flag from `GET /ui/api/flags`, the description as tooltip. Checking posts `/ui/api/flags/set`; turning on goes through the existing typed confirm ("yes", "yes, on air" while live, D149/D151), turning off is instant (the server never confirms off). The list follows the server on every 2 s status poll, updated in place with signals blocked so a refresh never posts. No new server code. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-flags-panel.md`. |
| D265 | 2026-11-08 | Qt shell structure edits and transitions (native UI parity; the browser page is no longer the main surface). Flag `scene-edit` on: an "Edit scenes and layers" box under the layer list (Add scene with a name; Remove scene / Remove layer after a yes/no question; Add layer of kind copy, colour, text, capture device, overlay, image or video, the choices from `GET /ui/api/project/structure`). Flag `transitions` on: a "Transitions" box above the mixer (canvas H/V; cut, fade with duration, or stinger with video, switch point and sound), from `GET /ui/api/project/transitions`, saved with `POST /ui/api/project/transition`. Both boxes are disabled while live and the server refuses too (`live-locked`). No new server code; the routes are the browser page's (D240/D242). Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-structure-transitions.md`. |
| D266 | 2026-11-08 | Qt shell bots panel (native UI parity): with flag `bot-manager` on, a "Bots" box above the mixer lists Streamer.bot and Speaker.bot from `GET /ui/api/bots` with the browser page's facts, and Start/Stop through `/ui/api/bots/start|stop` and the typed confirm. Stop is enabled only for a copy Ujwalam started (server checks too); a forced close is reported. Status refresh every 5th poll (10 s, it lists processes) and after each confirmed action. No new server code. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-bots-panel.md`. |
| D267 | 2026-11-08 | Qt shell feedback notes (native UI parity): a "Feedback notes" button opens a window with the feedback moments (`GET /ui/api/feedback`) and the browser page's note form (text up to 2000 characters, tag, severity) saved with `POST /ui/api/feedback/note`. User-opened only; no new server code. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-feedback-notes.md`. |
| D268 | 2026-11-08 | Qt shell Meld import (native UI parity): an "Import Meld session" button runs the browser page's flow (`POST /ui/api/project/import-meld` → new project file + host plan counts → optional skip-unavailable → `POST /ui/api/project/load` → typed confirm → `project.load`). No new server code. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-meld-import.md`. |
| D269 | 2026-11-08 | Qt shell report button (native UI parity): with flag `report-button` on, "Report a problem" asks for a title and description (capped at report.mjs limits) and calls `GET /ui/api/report-url`; only an https github.com link is opened, in the user's browser, for review before submitting. Nothing posted by the app. No new server code. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-report-button.md`. |
| D270 | 2026-11-08 | Qt shell posts window (native UI parity, last browser-only view): with flag `posting` on, "Posts" opens the review form on the browser page's routes (list, edit, approve/reject, open folder, auto-post line, YouTube private upload with the typed `yes, upload` sent in the request and checked by the server, refused while live; check status). No in-window video (no Qt Multimedia; Open folder instead). No new server code. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-posts.md`. |
| D271 | 2026-11-08 | Qt shell headless panel probe: `UJWALAM_HEADLESS=1` + `UJWALAM_STUDIO_PROBE_MS` makes the shell build its window offscreen (never shown), run its loads and status polls, print `studio probe: {json}` (flags, which flag-gated panels show, scene/layer/mixer counts, bot buttons, undo state, note) and exit. Tests only; no window ever appears. Two new tests in `tests/studio-qt-shell.test.mjs` (defaults; five flags on) give runtime evidence for the polling and panel wiring of D263–D266/D269/D270; clicks and dialogs stay UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-panel-probe.md`. |
| D272 | 2026-11-08 | Preview snapping to other layers (P5): moves and unrotated corner resizes on the preview now snap within 8 screen px to the other visible layers' bounding-box edges and centres as well as the canvas edges and centre (any edge or centre to any target, so boxes can sit edge to edge; a tie goes to the canvas). Alt still turns snapping off. While a drag holds a snap, the preview draws the guide line (pink on a dark rim) across the canvas. Part of the existing `preview-edit` flag (off by default): it refines that gesture, no new flag. Geometry tested headless through `preview.editSim` (`snap` in the step result); the drawn guide line is UNVERIFIED on screen. Evidence: `docs/evidence/2026-11-08-preview-layer-snap.md`. |
| D273 | 2026-11-08 | Mixer track routing (P5 native UI): host `mixer.setTracks {id, tracks}` sets which project `audio.tracks` a source goes to (libobs mixers; every output encodes track 1, so this changes what the stream and recording hear); `mixer.list` reports the tracks. Project v1 sources with an `audio.sources` entry only. UI server: behind flag `mixer-routing` (off), instant offline, "yes, on air" while live, saved into `audio.sources[].tracks` keyed by the host-resolved `audioSource`. Qt shell: a button per track on each mixer strip; a sound on no track stays listed. No browser-page control (native UI first). Volume and mute stay live-only as before. Evidence: `docs/evidence/2026-11-08-mixer-track-routing.md`. |
| D274 | 2026-11-08 | Qt shell Meld-style add-layer window (P5 native UI): "Add layer..." in the scene-edit box opens a window with the layer kinds and a note on each, a searchable list of what the kind can be made from (or text / colour field with a colour picker), Add or double-click sends the existing `layer.add` structure edit. Row and window share one kind table, choice list and request builder. No new server code; same flag (`scene-edit`) and live refusal. Build-verified; Qt runtime UNVERIFIED. Evidence: `docs/evidence/2026-11-08-qt-add-layer-window.md`. |
| D275 | 2026-11-08 | Qt shell probe actions (tests only): `UJWALAM_STUDIO_PROBE_ACTIONS` clicks real widgets during a headless probe (`flag-off:<id>`, `mute:<strip>`, `track:<strip>:<n>`, `undo`), one every 700 ms from 2.5 s; the probe line lists each action and whether its widget was there. Runtime evidence that the shell's click handlers reach the UI server and host (mute, track routing, flag off). Typed confirms stay UNVERIFIED (never typed). Also the D273 review follow-up: host answers `monitoring` and the project records it; Qt takes one routing change at a time and reloads the mixer after a confirm. Evidence: `docs/evidence/2026-11-08-qt-probe-actions.md`, `docs/evidence/2026-11-08-mixer-track-routing.md`. |
| D276 | 2026-11-08 | Faster full CI (user: "make the test a little faster"). Steps may name `alongside: '<step>'`: a light CPU step runs in a side lane while that step runs; the next main step starts only after the anchor and its whole lane end. test-py, test-ocr, validate-registry/outputs/games, private-scan and legacy-verify run beside test-host (GPU-bound). bench, test and test-capture (NVENC) stay alone, so still one heavy job at a time. The summary time is wall time. Host suite concurrency: see the evidence file. Evidence: `docs/evidence/2026-11-08-ci-speedup.md`. |
| D277 | 2026-11-08 | The Qt studio shell is the default window (user: "need a UI based software delivered today"; browser testing is dated). `npm run alpha` / `Ujwalam.cmd` open the native studio window; `--shell browser` opens the web control page; any other `--shell` value is refused (exit 2). Not built: the browser opens as before. The alpha zip ships the studio exe (see the package evidence). |
| D278 | 2026-11-08 | Installed runs: an `overlayRoot` in `<data>/ujwalam.json` that names the `overlays/` folder itself (written by the 2026-11-03 install) is read as its parent, so the host's overlay-root check (folder holding overlays/, brand/, kit/) passes again. Found in the alpha.3 install: obs-browser skipped and "the overlay server is off". The user's file is not rewritten. Test: `tests/package-alpha.test.mjs` (11 pass); the real install config now resolves to `<repo>/legacy` with no problem. |
| D279 | 2026-11-08 | Qt shell probe actions for typed confirms: `flag-on:<id>`, `type:<text>` (percent-encoded, typed into the open confirm dialog, OK) and `cancel`. Runtime evidence that the shell's confirm dialog posts the typed phrase, re-asks on a wrong phrase and cancels. Evidence: `docs/evidence/2026-11-08-qt-probe-actions.md`. |
| D280 | 2026-11-08 | Qt studio previews embed in the window (slots ask for canvas `h`/`v`, the server enum; retry every 2 s while refused; re-embed after a host restart). With the Qt shell the host gets no `--preview` and no post-load `preview.open`. One close: the studio window closing (exit 0) stops launcher, host and services; while live it asks for the typed "yes, on air" first. Evidence: `docs/evidence/2026-11-08-studio-record-clip-close.md`. |
| D281 | 2026-11-08 | Record and clip from the studio (user: "app does't have the option"). An alpha start without `--live`/`--outputs` uses the record-only `data/outputs/alpha-practice.json` (shipped in the zip). UI server allows `replay.save` and `marker.add {source: api}` without a confirm; Qt adds Save clip and Mark moment; Start stream says it needs the LIVE start. Installer adds an "Ujwalam (alpha, LIVE)" shortcut. Evidence as D280. |
| D282 | 2026-11-08 | User choice: both shortcuts open devices (`--allow-devices`; LIVE adds `--live`). A start with devices rebuilds an alpha project built without devices (old file kept in `projects/_old/`), replacing the old "loaded unchanged, add --rebuild-alpha" warning. Going live still needs Start stream and "yes, on air". Evidence as D280. |
| D283 | 2026-11-08 | Clips from each finished recording (user: "check if the recorded is processing for clips"; it was not: nothing ran the clipper on a recording). With flag `clip-pipeline` on, the launcher reads outputs.status every 5 s; when the record sinks stop, the H and V files are queued for `clipper.py run --detect` (one run at a time, hidden window, below-normal priority, output `<data>/clips/<recording>/`). Never while live: a stream that starts stops the run and queues it again (6 GB VRAM). A run cut short by closing Ujwalam is queued again at the next start. State in `<data>/clips/status.json`; the studio shows a Clips pill. Installed runs: the zip ships no Python, so `clipRoot` in `ujwalam.json` names a folder with `services/clip` and its venv (UJWALAM_CLIP_ROOT); unset = clips not made, with the reason. Tests: `tests/record-clips.test.mjs`. |
| D284 | 2026-11-08 | Clips in plain words, chosen by the user (user: "ask user whether to clip ... automatic clipping and editing while recording or after recording stops ... same for live ... a setting in app and in app updater ... save location"). `<data>/settings.json` holds `clips.recording` and `clips.live`, each `ask` (default: a question after each stop), `after` (the whole recording is clipped when it stops), `while` (the live clipper watches while recording or live, its moments are edited into clips when it stops: `clipper.py live-review --since --until`) or `off`; and `folders.recordings` / `folders.clips` (null = default). A recording that ran during a stream follows the live choice. The studio window has Settings (two plain choices, two folders), a first-run welcome with the same choices, a "Make clips from it?" question (with "do this every time"), a My clips button and plain Clips labels. Install-Ujwalam.ps1 takes the same settings (`-ClipsWhenRecording`, `-ClipsWhenLive`, `-RecordingsFolder`, `-ClipsFolder`, `-ClipMaker`, `-SettingsOnly`). The app setting replaces the `clip-pipeline` flag as the switch (the flag still allows runs for developers): the user asked for it as a setting, and the default "ask" does nothing without a yes. Never while live, folders inside the app or the clips corpus refused, settings refused while live, the recordings folder applies at the next start. Evidence: `docs/evidence/2026-11-08-clip-settings.md`. |
| D285 | 2026-11-08 | Studio look after the user's reference video (`data/stream assets/Stream layout/`, local only; user: "use the reference and build accordingly"): Fusion style, dark violet palette, rounded cards, purple accent (`app/studio/src/theme.cpp`, every colour in `theme.h`). Start stream is the accent button, Record a red outline. The top bar was 3248 px at its minimum (the cause of the clipped text at 125 %): it now holds the record/stream actions, undo/redo, Live/Recording/Clips chips, My clips, Settings and a More menu (Import Meld session, Feedback notes, Posts, Report a problem); frame stats, host and event core moved to the status bar; the preview fallback buttons are now small "Own window" / "To front". Probe gains `UJWALAM_STUDIO_PROBE_SHOT` (a PNG of the hidden window) as evidence; the test checks it renders at 1600x900. Evidence: `docs/evidence/2026-11-08-studio-look.md`. The audio mixer is a strip of cards under the previews (vertical splitter). Next: chat panel and stats cards like the reference. |
| D289 | 2026-11-08 | When clips are made (user asked for a decision: while streaming or after). **Find moments while streaming, make the videos after.** While live, only light work runs: hotkey marks, replay-buffer saves and the live clipper's small OCR regions (the "while" choice). The full detector pass, the end-screen match filter and the video edits run after the stream, one run at a time, below-normal priority. Reasons, measured on the user's 8 Nov recording: the full detector pass took 774 s for 475 s of video (OCR 695 s, CPU, 4 threads), i.e. ~1.6x the video length, and would compete with the game and the encoder; editing uses the video encoder on a 6 GB laptop GPU that the stream already uses (D1, VRAM rule); the match filter needs the end screen, which only exists when a match ends, and the kill count needs the whole match. A stream that starts pauses any clip run (D283). Revisit when a dedicated second GPU or a measured idle-time budget exists. |
| D288 | 2026-11-08 | First stream scene: Default H 0.5.0 and Default V 0.4.0 follow the user's horizontal and vertical target layouts (`data/stream assets/Stream layout/`, local), measured to about 1-2 %. H game gets rounded corners (radius 64 source px, proposed, UNVERIFIED) behind flag `layer-effects`; H goal bar hidden (user decision 2026-11-08), layer kept; H mascot box widened to the target; V gains a mascot layer (`brand.character` profile key) behind `layer-effects`. Both facecam layers stay where they are pending the user's answer (the targets have no camera slot). Counters stay read-only Streamer.bot globals (D250); CTA videos keyed via `assets.*` (D248). Existing projects pick it up only on a rebuild (`--rebuild-alpha`). Render on the real host still to do. Evidence: `docs/evidence/2026-11-08-first-stream-scene.md`. |
| D287 | 2026-11-08 | Task bar, stats cards and motion (user: every activity needs a progress section that informs without interfering). Every long action is a task (`services/studio-ui/tasks.mjs`: plain-words title, running/done/failed/waiting, done/total, stage, note): launcher jobs write `<dataDir>/tasks/<id>.json` (clip runs, from the clipper's `ujwalam-progress {...}` stderr lines); the UI server adds its own (Meld import, project load, transition apply, YouTube upload, settings save, preview open). Served at `GET /ui/api/tasks` and in the status snapshot; text only, no chat, names or paths beyond the clips folder; finished tasks vanish after 10 min. Qt: status-bar chip ("2 tasks running" + thin bar, hidden when idle), slide-up task list, 4 s toasts on finish/fail; child widgets only, never take focus, toasts click-through. Motion: eased 150-250 ms (panel, toasts, bars, chip pulse, Live/Recording colour fade, hover glow); skipped when Windows animation effects are off or `UJWALAM_REDUCE_MOTION=1`; nothing animates while idle. Stats cards (session, GPU, CPU, FPS with history) from the 2 s status poll. Settings gains the match filter controls (`clips.matchGate`). Evidence: `docs/evidence/2026-11-08-task-bar-and-motion.md`. |
| D286 | 2026-11-08 | Match gate: clips only from matches worth it (user: "if it is high amount or the player is in top 3 of the winning or losing team, then the clips of that match can be processed"). The clipper splits a recording into matches at end screens (pack 0.5.0 detector S1 plus W1/M1/M2/K1; screens <90 s apart are one end) and keeps a match's clips when the streamer is on the top-3 screen (`clips.matchGate.top3`, default on) or has at least `minKills` own kills (default null = off; kills from the final scoreboard, else deduplicated own kill-feed lines). A match whose end was not seen, or whose stats were not read, keeps its clips (never drop on doubt). Output `matches.json` (no names); skipped candidates go to `candidates.json` `gatedOut` and return when the gate is re-run after a settings change; `live-review --matches` applies the same rule to live saves; montage is not gated. top3 default on although AGENTS.md says new features default off: the gate only acts inside clip runs, which are themselves off until the user picks a clip choice (D284), and the user asked for exactly this rule. Verified: top-3 read 6/6 frames on one practice match (#1, score 4053). UNVERIFIED: scoreboard kills ROI (no frame yet), kill-feed count (46 vs hand count ~45 offline; full rerun pending), minKills 30 proposed, not set. Evidence: `docs/evidence/2026-11-08-match-gate.md`. |
| D290 | 2026-11-08 | Layer looks in the app (user: "in app settings for rounded corners and other layer effects. cleaner and modern UI"). The effect table carries a group (shape, filter, camera, compositing, light); the inspector's Look panel lists every type by group (Shape, Filters, Camera, Blend, Shadow & glow) with an on/off switch and plain sliders/colours, debounced 250 ms; while live an Apply button goes through the 'yes, on air' confirm. No flag for the Look panel: the user asked for these settings in the app, and the live guards, undo and render-atomic swap stay; `layers.setEffects` is no longer gated by `effect-editor`, which now only shows the Advanced effects list. Settings has pages Clips, Folders, Layer effects ("Show layer effects from the scene" sets flag `layer-effects`) and Advanced (animations Follow Windows / Always on / Off as `ui.motion` in settings.json, `UJWALAM_REDUCE_MOTION` still overrides; feature flags moved here). Round control buttons, slim icon toolbar (Qt-drawn icons), scene cards. UNVERIFIED: real host rendering via the panel, live Apply in the Qt window, 125/150 % scaling, round mixer knobs not done. Evidence: `docs/evidence/2026-11-08-studio-look-2.md`. |
| D291 | 2026-11-08 | Layer filter, camera and compositing effects (user: "add filter effects, camera effects, compositing effects"). New project v1 layer effects, GPU passes in libobs effect files (shared once per process) or OBS filters. Filter: sharpen, vignette, grain (seeded, zero-mean, measured 0 flashes/s), pixelate, posterize, lut (.cube or 512x512 PNG; path refs only); black & white and sepia are toner presets. Camera: mirror, flip, circleMask and roundMask with feather and an inner border ring (camera-frame-decorator). Compositing: opacity; blend add/subtract/multiply/screen/lighten/darken via obs_sceneitem_set_blending_mode, one per layer; gradientMask; imageMask (luma or alpha, invert, feather). Overlay and difference blends are not available on libobs scene items. A missing LUT or mask file is a plan warning (layer shows without the effect); layers.setEffects refuses it (-32004). Meld negative scale imports as mirror/flip. The Look panel lists all types except lut and imageMask until the editor has a file field. Background blur/removal stays planned: needs a segmentation model and VRAM is reserved while live. 17 presets, all in-progress until used on a real stream. Cost: <=0.07 ms render-thread time for six 1080p layers per effect (CPU side; per-effect GPU cost UNVERIFIED). Evidence: `docs/evidence/2026-11-08-filter-camera-compositing-effects.md`. |
| D292 | 2026-11-08 | Layer and scene menus (user: "layer duplication required. right click context menu for layers in scenes"; "ability to add new layer is missing. ability to add new scenes"). Right-click menus and + buttons on the layer and scene lists: Add layer/scene, Duplicate (Ctrl+D), Rename (F2), Show/Hide, Move up/down/to top/to bottom, Copy/Paste look (Ctrl+Shift+C/V), Look…, Delete (Del, confirm). New structure ops `layer.duplicate`, `layer.rename`, `scene.duplicate`, `scene.rename`. Add, duplicate and rename no longer need flag `scene-edit` (the user asked for them; nothing is lost); delete, scene remove and the project-file layer move stay behind it because structure edits clear undo. All structure edits refused while live (fresh host status, fail closed). A copy of a device capture layer is a duplicate-type layer on the same open source (a device opens once); other layers are deep copies; devices, overlays and assets are referenced. The host has no rename: the server overlays the saved name until the host reloads the project. Windows and menus fade with the motion setting. UNVERIFIED on the real host, real mouse/keys and live. Evidence: `docs/evidence/2026-11-08-layer-menu.md`. |
| D293 | 2026-11-08 | Studio themes (user: "custom themes ... entire UI theming according to the topic. use 3D extrusion, drop shadow and glow effects wisely"; "all clicks, pop-ups, dismisses, openings, transitions and hover ... subtle visual feedback"). The whole look is data: `data/themes/<id>.json` (`theme.schema.json`): colours, typography (Windows family names only, nothing bundled), geometry, per-class depth (shadow, glow, extrusion), motion, background pattern, icon weight. Five packs embedded: Violet Night (default), Neon Arcade, Studio Light, Tactical, Retro Wave; a same-id file in UJWALAM_THEMES_DIR, `<exe>/themes`, `<app data>/themes` or data/themes replaces one, a new id adds a custom theme (partial packs merge over Violet Night). Contrast tested: body text >= 4.5:1, round-control icons >= 3:1 in every state, preview text fixed light on the fixed dark preview surface. Effects: shadow on floating things, glow only on primary/active, extrusion on round controls and primary buttons; `ui.effects` full/reduced ("Reduce effects"); `ui.theme`; motion moved to Settings > Appearance. Live theme switch. Interaction feedback central (hover lift, press sink, focus ring, popup fade), follows `ui.motion`, never takes focus, never animates idle. Worst-case full-window repaint 6.8-8.0 ms full vs 3.5-4.0 ms reduced (offscreen). UNVERIFIED: real Windows rendering, scaling, animation feel; menus have no dismiss animation. Evidence: `docs/evidence/2026-11-08-themes.md`. |
| D295 | 2026-11-08 | Face AI (user: "background removal for facecam and mocap features with facial tracking"; chose a built-in ONNX model, camera follows face, effects on face, face mapped onto any reference image, all local; GPU: measure, then the user decides). A sidecar Python worker (onnxruntime-directml, CPU fallback per model) linked to the host over owner-only shared memory `Local\ujwalam-face-<host pid>`; no token, camera or network; hidden, below-normal, at most 5 restarts; frames at most 640x360 at 30/s only while a face effect is shown. Effects `personMask` (remove/blur/replace), `autoFrame`, `faceSticker` are host shaders behind flag `face-ai` (off). Default models MediaPipe selfie segmentation landscape, YuNet, face mesh 468 (~3 MB, Apache-2.0/MIT), SHA-pinned in `data/models/face-ai.json`, never committed. Worker lag or crash: hold the last mask 500 ms, fade out 300 ms, plain camera; stream and recording never wait. Measured next to a 1080p60 NVENC recording (test video, no face): +0.15 ms host frame time, +72 MB VRAM, 50 ms latency, 0 lagged/skipped frames. Avatar from a reference image: offline piecewise-affine prototype only (tears on jaw/brows); neural reenactment deferred (size, VRAM). Live use pending the user's decision after a real facecam test. Codex second-opinion review requested before marking done. Evidence: `docs/evidence/2026-11-08-face-ai.md`, design `docs/plan/2026-11-08-face-ai-design.md`. |
| D294 | 2026-11-08 | Guide for new users (user: "step by step info and continuous focused modern pointers on what's going on in front of and behind the scenes ... dismiss ... do not show again ... get it back from settings"; "in-app floating UI help to show the clipping capability and auto posting capability"). Coach marks, a welcome tour (16 steps, plus clips and posting tours), six 'behind the scenes' hints and a floating ? help panel. Text is data (`data/guide/tour.json`, `hints.json`, schema-validated). `ui.guide = {tips, dismissed, tourDone}` in settings.json (slug ids, max 200); Settings > Help & tips: tips on/off, reset all don't-show-again, replay the tour. Cards are child widgets, never take focus, never cover their anchor (placement below/above/left/right, narrowed if needed; probe asserts no overlap), follow the theme and the motion setting. Hints fire from the polled status snapshot, show once, auto-hide after ~8 s unless hovered. Guide-only settings patches allowed while live. The posting help states only what exists today and what needs the user's yes. Steps with a missing or hidden anchor are skipped. UNVERIFIED on a real display with native previews and on real recording/live/clip events. Evidence: `docs/evidence/2026-11-08-guide.md`. |

## D296 (2026-11-08) Studio crash fix, crash capture, console-free start

Studio crash 2026-11-08 (0xC0000005): use-after-free of a self-deleting glide animation in the task bar's progress bar (SmoothBar::setProgress). Fixed with QPointer; the panel and toast animations are guarded the same way. A regression probe shows the window offscreen with animations on. The studio writes its own log and a text-only crash report (studio-crash-*.txt; module+offset and stack, no minidump) through the host crash reporter. The launcher records every shell exit in studio-exits.jsonl and reopens a crashed shell with a new one-time key, at most 3 times in 10 minutes. Shortcuts run ujwalam-start.exe, which starts Ujwalam with no console window (D191) and writes launcher output to data\core\logs\launcher-*.log. Ujwalam.cmd stays for terminals; stop by closing the window (D280). Evidence: docs/evidence/2026-11-08-studio-crash.md.

## D299 (2026-11-08) Pre-stream readiness and End all streams

Before going live the studio runs a "Ready to go live?" check (flag `readiness`, off by default): host and outputs, stream keys present per live sink and the server-address scheme (only the scheme is ever reported), disk space, other streaming apps, Streamer.bot and Speaker.bot, last loopback test (full-CI stamp, a stand-in), clip maker, audio sources (pluggable; "unknown" until the host reports live audio state) and the NVIDIA GPU pin. Thresholds live in `data/live/readiness.json` (proposed, unverified). Start stream shows the result in the typed confirmation (control page and Qt). A failed item blocks going live unless the user types `yes, on air, override`; each override is logged with item ids only. Warnings never block. A check that cannot run refuses go-live while the flag is on. "End all streams" stops every stream sink with the host's existing `stream.stop {}`, waits until each reports stopped and leaves the recording running; no flag because it adds no new stop behaviour; it keeps the typed confirmation. Evidence: docs/evidence/2026-11-08-pre-stream-readiness.md.

## D297 (2026-11-08) Game audio loss fix and audio health watchdog

ujwalam-host holds the Windows RTWQ platform for the whole process (RtwqStartup before obs_startup, RtwqShutdown after obs_shutdown), as the OBS frontend does. Without it, another in-process component's shutdown killed win-wasapi's shared work queue (MF_E_SHUTDOWN 0xC00D3E85 / MF_E_INVALID_WORKQUEUE 0xC00D36FF) and the game audio source never restarted (win-wasapi ignores the Start() result after reconnect), so the 2026-11-08 recordings carry mic only. Which component shut the platform down is UNVERIFIED. Defence: a host audio health watchdog with no feature flag (pure resilience; `enabled` in data/audio/health.json is the switch). A device audio source with no packets for noDataMs (5000) is reported as '<Name> audio missing' and recreated on the same channel, at most maxRecreates (3) per load; the old source is parked, never destroyed while running. An obs_shutdown guard (20000 ms, exit code 9) ends a stuck exit. Readiness: `audio.status` RPC and host.status.audioHealth (states ok, starting, missing, inactive, unknown), mixer.list receiving/lastDataMs, the control page pill, the record/stream start confirmation, and the D299 readiness audio item (missing = fail, starting/unknown = warn). Layer audio (dshow) is reported, never restarted. Values unverified until a real-device session. Evidence: docs/evidence/2026-11-08-game-audio-loss.md.

## D298 (user 2026-11-08) Montage from every own kill; clips folder layout

Kill montages use every own kill: streak groups first (higher score first), then single-kill groups, filling 30-45 s montages (always 20-60 s); more kills make more montages; deaths stay hard negatives; short clips and the live clipper stay streak-only. User: "combine kills and make a montage. priority given to streaks of course." Output layout (user: the clips folder is for finding uploads when the app cannot upload): the clips folder holds only finished, validated videos as `<clips>\YYYY-MM-DD\<game>_<kind>_<YYYYMMDD-HHMMSS>_<label>_<nn>_<canvas>.mp4` (kind short|montage|won-reel; canvas v|v-<layout>|h), hard-linked (copied across drives) from the run folder in app data (`<data>\clips\runs\<name>`), which holds every analysis and working file; the upload list is `<data>\clips\uploads.json`. Recordings stay host-named `<profile>-<h|v>-<stamp>.mkv` (date sub-folders would need native code, not done). The live clipper's replay saves are deleted after they are edited into clips and validated; hand-made replays are kept. Clips keep all source audio tracks; validate reports track count and loudness per file and fails only on a dropped track (no game-audio detector). Older folders are migrated only through `clipper.py tidy --apply` after the user approves the dry-run list. Evidence: docs/evidence/2026-11-08-montage-all-kills-and-output-layout.md.

## D300 (2026-11-08) Auto-post chain

After a clip job that made clips, with flags `posting` and `auto-post` on and a rules file with `autoUpload: true`, the launcher packages the run for `youtube-shorts`, auto-approves by the rules and uploads each approved clip privately to YouTube. Uploads are blocked by any active or starting stream sink, or an unreadable output state; the check repeats before every 8 MiB chunk. A local recording does not block (network and a little CPU, not the encoder). A persistent queue `<data>/posting/upload-queue.json` retries with exponential backoff (5 min doubling, 6 h cap, failed after 8 attempts); a missing sign-in or a live stream keeps items queued with a clear reason and costs no attempts; items stuck in uploading after a restart go back to queued. The resumable session URL is stored so a stop or restart resumes. Finished uploads fill `posted` in `uploads.json` (no tokens). Replaces the blanket D217 refusal in `auto --run` (recording sinks ignored; fail-closed kept). Off by default (flags plus empty rules). Real upload UNVERIFIED (no Google OAuth client yet). Evidence: docs/evidence/2026-11-08-auto-post-chain.md.

## D301 (2026-11-08) Montage and won-reel posting; upload queue in the UI

The auto-post chain also packages montages and won-match reels from `<data>\clips\uploads.json` (kinds short, montage, won-reel), into `<data>\posting\packages`. Target by length and aspect from data/posting/limits.json: vertical within `youtube-shorts.video.maxDurationSec` (60, agent default, unverified) goes to youtube-shorts, anything longer or horizontal to a new `youtube-video` target; aspect is read from the file name's canvas token. Auto-post rules gain `kinds` (default short only; minScore applies to shorts only); the committed rules stay empty. Uploads stay private through the same ledger and queue. The control page and the Qt Posts view show the queue (counts, next retry, plain reason, per-item state, link when done) with Retry now (`POST /ui/api/posts/queue/retry`: session + CSRF, requeue only, refused while live or when live state is unreadable). Evidence: docs/evidence/2026-11-08-auto-post-chain.md.

**D303 (2026-11-09) Stream recovery after a host crash.** Flag `stream-recovery` (off by default). When the host
crashes while live, the launcher restarts the host, reloads the project and starts the recording in a new file. It
then starts again exactly the stream sinks its last `outputs.status` poll saw starting, live or retrying, and only
when all of these hold: the launcher's go-live authority is armed and the sink was not stopped by the guard; the project reloaded; the host was ready
within `maxGapMs`; and fewer than `maxRecoveries` recoveries happened in `windowMs` (`data/live/recovery.json`,
proposed values 2 / 10 min / 90 s).

The launcher alone owns the go-live authority, in memory; nothing on disk is read for a decision. The UI server uses
it over the launcher's IPC channel:

- `begin` before a confirmed "yes, on air" start, a generation check right before the host call (a stale start is
  not sent), and `arm(generation)` after the host accepted it. If a Stop came in meanwhile, the arm is refused and
  the UI server stops those streams again at once, so the Stop wins.
- `revoke` before a confirmed Stop or End all reaches the host. It takes effect at once, and its answer waits for any
  recovery start in flight.

The recovery decision and its `stream.start` run in one serialized section. If a revoke overtook the start, the
launcher stops those sinks again. A revoke without an answer within 10 s closes the channel, and a closed channel or
an exited UI server closes the authority for the session (fail closed). The live-test guard excludes the sinks it
stops and revokes before stopping everything. A new launcher starts with a new, unarmed authority, so a launcher
restart never goes live by itself.

Past the limit, the streams stay off, the authority is revoked (`recovery-limit`) and the page says to check the host
log. Every decision is logged, added to the restart marker and shown on the control page
(`<data>/live/stream-recovery.json`, no keys or URLs; `stream-authority.json` is a diagnostic mirror only). Platform
grace windows are UNVERIFIED. Evidence: docs/evidence/2026-11-09-stream-recovery.md.

**D304 (2026-11-09) Match gate on the "while" clip path.** `record-clips` live-review jobs pass the H recording to
`clipper.py live-review`. When the D286 match gate is on in Settings and no `--matches` file is given, live-review
runs the detector pass on the recording, segments and decides matches with `match_gate`, writes `matches.json` and
drops saves inside gated-out matches. A gate that is off, a missing recording or any error keeps every save, with a
reason. The runtime of the detect pass on a long recording is UNVERIFIED. Evidence: docs/evidence/2026-11-09-stream-recovery.md.

  `app/studio/src/main_window.h`.
# Live test kit: what a one-hour test stream still needed (2026-11-09)

Result: **PASS (headless tests, Qt headless probe, quick CI). Not yet used on a real stream.** New behaviour is behind
the flag `live-test-kit`, off by default. Branch `live/test-banner`. Proposed decision D305 is at the end.

Scope: the four items of AGENTS.md "Live stream testing" that a one-hour test stream needs: the on-screen test
banner, the spoken announcement, the chat feedback question and collection, and the studio window showing stream
recovery and audio problems.

## 1. Test banner on H and V: already built (BM3, D196), nothing changed

- Flag `test-broadcast` (off), preset `registry/presets/test-broadcast.json` on function `timed-banner`, page
  `services/overlay-server/pages/ujwalam-test-broadcast/` (plain `<script>`, no CDN, `textContent` only, tokens),
  layers in `scene-default-h.json` and `scene-default-v.json` (V placed inside the safe area, D232).
- Entrance 450 ms (< 600), exit 300 ms (< 400), every 15 min, hold 18 s; text: "Test broadcast. We are trying new
  streaming software. Tell us in chat how the video, sound and scenes look."
- Checked again today: `node --test tests/test-broadcast.test.mjs` passes (see section 5).
- Still open from BM3: H/V frame captures from the real host (need the host and the user's yes). UNVERIFIED on a real
  frame that nothing is cut on V.

## 2. Speaker.bot announcement: Ujwalam reminds; the user's own Streamer.bot action speaks

How the code talks to the bots today (searched `services/` for speaker/streamer):

- `services/event-core/streamerbot/`: read-only WebSocket connector, events in, never sends (P3 rule, D192).
- `services/bots/index.mjs`: starts/stops the user's installed copies; `health()` opens a TCP connection and sends
  nothing to either bot.
- No code sends anything to Speaker.bot or Streamer.bot. A Streamer.bot DoAction write path is BM8, planned for P15
  after an ADR and a security review.

So the only allowed path is the user's own Streamer.bot action (BM4 setup:
`docs/tests/2026-11-04-A0-S1-streamerbot-test-action.md`), which posts the chat question and has Speaker.bot read the
announcement. Ujwalam does **not** trigger it: "Ujwalam's Streamer.bot connection stays read-only" (AGENTS.md) rules
out a DoAction call, and a direct Speaker.bot "speak" request would be a new write path into another program that
needs the same review. What was added:

- `data/live/test-kit.json` (status `unverified`, a source per value): the action name (`Ujwalam test stream`),
  the announcement, the chat question, its prefix, the reply marker `fb:`, the reply window (10 min) and the
  reminder time (10 min). Nothing of this is written in code (a test checks it).
- With the flag on, for the first `reminderMin` minutes after the stream goes live, the studio window and the
  control page show: `Test stream: start your Streamer.bot action "Ujwalam test stream" now (it posts the feedback
  question and has Speaker.bot read the announcement). Ujwalam does not post or speak.`

UNVERIFIED: that the action exists on the laptop under that name, and that its Speaker.bot step speaks (the first
real stream ran without the spoken step, user 2026-11-03; on Streamer.bot 0.2.8 the step is copied from the user's
TTS action).

## 3. Chat feedback: collected by itself when the stream ends

Already there: `tools/collect-stream-feedback.mjs` (BM5, D195), read-only on `event-core.db`, writes
`feedback/YYYY-MM-DD-stream-feedback.md` (gitignored), escapes viewer text, never duplicates. Gaps filled:

- With the flag on, the studio UI server watches `host.status.live`; when a stream ends (live -> offline) it runs
  the collector for exactly that stream's time span, with the prefix, marker and window from `test-kit.json`, into
  the launcher's feedback folder. The collector runs as its own Node process (`runCollectorChild`: `node
  tools/collect-stream-feedback.mjs --json ...`, `windowsHide`, killed after 60 s), so a large chat database or a slow
  disk never stalls the UI server's event loop (status polls, stream control; Codex review, MEDIUM, fixed). Its result
  is recorded when the child ends. It never throws: a failure (including the time limit) shows
  as a warning line ("Viewer feedback was not collected: ... Run tools/collect-stream-feedback.mjs by hand.").
- After the stream the strip shows: `Viewer feedback saved: N message(s) (YouTube a, Twitch b, Kick c) in
  feedback/<date>-stream-feedback.md`. Counts and the file name only; no viewer text or names leave that file.
- The CLI uses the same `test-kit.json` defaults when `--question-prefix`, `--marker` or `--window-min` are not given.
- Ujwalam never posts the question (the user's Streamer.bot action does).

## 4. Studio window (Qt) and control page: stream recovery and sound problems in plain words

- `services/studio-ui/live-test-kit.mjs` `liveAlerts()` (pure) builds `alerts: [{ id, level, text }]` in the
  `/ui/api/status` snapshot when the flag is on: the newest stream-recovery event of this session first (its own
  text from `stream-recovery.mjs`, level `warn` when restarted, `error` otherwise), then each `audioHealth` warning
  as `Sound problem: Game audio missing. Ujwalam is restarting that sound; if it stays silent, check the device and
  its cable.`, then the Streamer.bot reminder and the feedback result.
- Qt (`app/studio/src/main_window.cpp`): a strip under the top bar (`alertBar`), plain text only, one line per
  alert, border coloured by the worst level (theme tokens `danger` / `accent` / `border`), hidden when empty or with
  the flag off. `probe()` reports `alerts { shown, text, level }`.
- Control page (`ui/js/app.js`): the existing audio and recovery pills stay; a new `st-testkit` pill shows the
  reminder and the feedback result (`textContent` via `setText`).

## 5. Tests and checks

| Command | Result |
|---|---|
| `node --test tests/live-test-kit.test.mjs` | 16/16 pass (after the child-process change): a collector over the time limit is killed and reported; the child is started hidden; a 2.5 s busy collection while the status route is polled every 50 ms: every answer under 500 ms, the result recorded afterwards; plus: config + sources, no texts in code, bad config refused, flag off by default, package list; `liveAlerts` cases; auto-collect on a temp DB with placeholder names (3 replies kept, question/unrelated/pre-stream rows left out, once only, flag off = nothing, missing DB = failed result); server flag off = no `alerts`, flag on = sound line + reminder while live, feedback line after |
| `node --test tests/studio-qt-alerts.test.mjs` (shell built with `node app/studio/tools/build.mjs`) | 2/2 pass: flag off = strip hidden; flag on = 3 lines (recovery text, sound line, reminder with the action name), level `error` |
| touched suites (stream-feedback, studio-qt-shell, package-alpha, studio-ui-server, test-broadcast, studio-ui-readiness, stream-recovery, studio-ui-alpha, studio-ui-live-test) | 204 tests: 201 pass, 2 skipped (pre-existing skips), 1 fail = `test-broadcast` "registry validates", caused by the worktree having no `legacy/` (legacySource paths missing); after linking `legacy/` to the main checkout, `tests/test-broadcast.test.mjs` 14/14 pass |
| `node tools/ci.mjs --quick` | 8/8 pass in 27.4 s (build, lint, build-host, validate-registry, validate-outputs, validate-games, private-scan, legacy-verify) |

All headless (`UJWALAM_HEADLESS=1`), fake host, 127.0.0.1 only; nothing went live, nothing was posted, spoken or
sent to Streamer.bot or Speaker.bot.

## 6. Also fixed

`tools/package/manifest.mjs` did not ship `data/live/readiness.json` and `data/live/recovery.json`: in the packaged
alpha the readiness check and stream recovery would read no config (recovery reason `config`, streams not
restarted). Both are now listed, with `data/live/test-kit.json` and `tools/collect-stream-feedback.mjs` (imported by
the UI server).

## UNVERIFIED / open

- The Streamer.bot action name and its Speaker.bot step on the laptop (section 2).
- Banner H/V captures from the real host (BM3).
- The auto-collection on a real stream: event-core.db written by the real event core during a live stream (the
  table and columns match the BM5 tests; real chat never used in tests).
- The look of the Qt strip on a real display (only the headless probe ran).

## Proposed decision D305

D305 (proposed 2026-11-09): Live test kit behind flag `live-test-kit` (off). Ujwalam does not speak, post or
trigger Streamer.bot actions for a test stream; the user's own Streamer.bot action (name and texts in
`data/live/test-kit.json`) posts the feedback question and has Speaker.bot read the announcement, and Ujwalam only
reminds the user to start it for the first minutes after going live. When a stream ends, the studio UI server
collects the viewers' replies read-only from `event-core.db` into `feedback/YYYY-MM-DD-stream-feedback.md`
(gitignored). The status snapshot carries plain-words `alerts` (stream recovery, sound problems, the reminder, the
feedback result), shown as a strip in the Qt studio window and as a pill on the control page. A write path into
Streamer.bot or Speaker.bot stays BM8 (P15, ADR and security review).

## Files changed

- New: `data/live/test-kit.json`, `services/studio-ui/live-test-kit.mjs`, `tests/live-test-kit.test.mjs`,
  `tests/studio-qt-alerts.test.mjs`, this file.
- Changed: `data/flags.json`, `services/studio-ui/server.mjs`, `tools/collect-stream-feedback.mjs`,
  `tools/package/manifest.mjs`, `ui/index.html`, `ui/js/app.js`, `app/studio/src/main_window.cpp`,
  `app/studio/src/main_window.h`.

**D306 (2026-11-09) Posting and clip pipeline end-to-end tests.** `tests/posting-e2e.test.mjs` runs the auto-post chain against a local fake YouTube; `tests/py/test_clip_e2e.py` runs the clip maker on a generated recording. Found and fixed: a resumable upload whose final answer was lost was retried 8 times and could post twice. Now a finished session's video resource is recorded, and a new session starts only on 404/410. UNVERIFIED against real YouTube (the fake models Google's documented behaviour). Evidence: `docs/evidence/2026-11-09-posting-e2e.md`, `docs/evidence/2026-11-09-clip-pipeline-e2e.md`.

**D307 (2026-11-09) Live clip minimum length and auto-post preview.** Live clip windows are extended to `minClipSec` (20 s, `data/clip/live-clips.json`) by starting earlier, bounded by the replay buffer and the previous KILLCAM; a missing key means 0. `node services/posting/cli.mjs auto --preview` and `GET /ui/api/posts/auto/preview` (behind `posting`) show what the rules would queue and why others are skipped; zero network, zero writes. Won-match reels are not filtered by the match gate (current behaviour, locked by a test; open question to the user). Evidence: `docs/evidence/2026-11-09-live-window-and-match-gate.md`, `docs/evidence/2026-11-09-auto-post-preview.md`.

**D308 (2026-11-09) Failure simulations and clip maker check.** Host test seam `audio.testHangDestroy` exists only with `--test-hooks` (never passed by the launcher) and only for the fake `ujw_test_audio` source; `host-audio-failsim.test.mjs` drives the shipped `data/audio/health.json` values (no data 5 s, 3 recreates, parked 12, shutdown guard 20 s). Readiness: a malformed or unreadable audio answer now fails (an empty list stays a warning). When the clip maker's Python, folder or script is missing, the start-up line, the control page and the Qt window say which part and how to fix it. Flaky tests: the posting CLI test uses its own data dir; `stopHost` waits up to 60 s. Evidence: `docs/evidence/2026-11-09-failure-sims-and-clipmaker-check.md`, `docs/evidence/2026-11-09-flaky-tests.md`.

**D309 (2026-11-09): Twitch takes either rtmp:// or rtmps://.** The Twitch live target uses
`"transport": "auto"` (`data/outputs/alpha-live.json`). At output build time, the launcher reads only the scheme of
the server address stored in `Ujwalam/stream/twitch-server`. The value is dropped at once and never logged,
persisted or put in params. That scheme picks the transport, if it is one of the platform's rtmp/rtmps protocols in
`data/platforms/twitch.json`. Anything else (another scheme, no scheme, no stored address, unreadable) refuses the
plan with a plain message that names the credential target, not its value. `auto` needs `serverRef` and a platform
that takes both schemes. Kick (rtmps only) cannot use it and stays `rtmps`; a stored `rtmp://` Kick address is
refused at build time. The host is unchanged and re-checks the scheme against the chosen transport when it connects.
Readiness accepts either scheme for Twitch and asks for a restart when the address changes scheme after start.

**D310 (proposed 2026-11-09): Scheduled posting behind flag `post-schedule` (off).** Each clip the auto-post chain
queues uploads to YouTube as private with `status.publishAt` (UTC). Slot = the later of the channel's latest future
scheduled post (private + publishAt after now, read with youtube.readonly: channels.list mine -> uploads playlist ->
playlistItems -> videos.list part=status, only when a clip needs a slot) and the latest slot already in the upload
queue (any state), plus intervalHours; never sooner than now + minLeadHours + marginMinutes; rounded up to the
minute. Settings in `data/posting/schedule.json` (6 h from the user; lead 1 h, margin 15 min, 20 x 50 pages: agent
defaults). Slots go out in queue order and are saved on the queue item; a retry keeps its slot while it is still at
least minLead ahead, and a failed item keeps its slot (the gap stays). The time is re-checked right before an upload
session starts or resumes (>= now + minLead) and before every chunk (>= now + margin); every chunk request is aborted chunkDeadlineSeconds (120 s) before the time,
and the final chunk only starts when its estimated transfer (slowest measured chunk, else fallbackKbps) fits;
after an abort a progress query decides (finished = done, else re-slotted); a time too close drops an
unfinished session and the clip gets a new slot at the end. Each session's publish time is saved with it; an
unfinished session whose time differs from the slot is dropped and a new one started, and the time recorded as
scheduled is always the one the finished session carried. A finished upload confirmed after its time passed is marked
`went-public-early` with a plain message. `videos.update` after upload is not used (needs the broad youtube scope).
Fail closed: without the readonly scope (sign-in again needed), on a failed read, on a read that hit the page cap
(`schedule-read-incomplete`) or a bad settings file, the clip waits without a slot and nothing uploads; no attempt is
used. Sign-in asks for upload + readonly only while the flag is on. Nothing reads, slots or uploads while live. With
the flag on, `auto --run` only approves; the studio queue uploads. `youtube upload --id` (manual) stays an unscheduled
private upload. Evidence: `docs/evidence/2026-11-09-scheduled-posting.md`.

## Files changed

- `app/host/lib/outputs-plan.mjs`
- `app/host/tests/outputs-plan.test.mjs`
- `data/outputs/alpha-live.json`
- `data/platforms/twitch.json` (note text only)
- `services/studio-ui/launch.mjs`
- `services/studio-ui/readiness.mjs`
- `tests/studio-ui-alpha.test.mjs`
- `tests/studio-ui-readiness.test.mjs`
- `tools/outputs-validate-presets.mjs`
- `docs/evidence/2026-11-09-twitch-either-scheme.md` (this file)

**D311 (2026-11-09): Nothing runs hidden after close; tasks visible with elapsed and ETA.** Every background task (clip job, upload) shows in the studio task bar with elapsed time, ETA (or unknown) and a toast on start. Closing the studio with tasks running asks: keep in tray, stop tasks, or do not close. The tray icon lists each task with progress and exits when all finish. A tray exit or Stop all never ends a stream or recording: the UI server holds a closing lock (granted only when not live, not recording and status readable; never expires once granted; the studio exits only after a synchronous commit check), and while live Stop all stops only the tasks. A clip job ends with its whole process tree (taskkill /T, kill-on-close job, parent-gone watch); killChildTree never targets an exited child. Evidence: `docs/evidence/2026-11-09-visible-tasks-and-tray.md`.
**D312 (2026-11-09): Caption seam.** `tests/py/test_caption_seam.py` drives synthetic speech through the real clipper `render --captions faster-whisper` (test-only; skips without the model). The speech wav is generated at test time with the Windows built-in synthesizer and never committed (the repo is public and the voice's output terms are unchecked). faster-whisper runs with `vad_filter=True`: without it, captions after silence started at 0.0 s, about 6 s before the words.
**D313 (user 2026-11-09): Limits approved; tray allowed on the main display.** Approved as shipped: audio recreate 3 then park (max 12 parked); disk warn 44 GB free, stop recording 22 GB; Shorts 60 s max; stream recovery at most 2 restarts per 10 min with a 90 s gap. D191 exception: the tray icon and its task menu live in the Windows taskbar on the main display; the menu opens only on a click and never takes focus by itself. Every other app window keeps D191 (second display only, no activation, none with one display).
**D314 (user 2026-11-09): Retry close to its time.** A queued clip whose public time is less than 1 h away gets a new time 1 h from now; every later queued clip that has not started uploading is re-chained 6 h apart from that time. Clips already uploaded keep their times (they cannot be moved without the broad youtube scope). Slots can be scheduled up to 2 years ahead; a slot beyond that waits.
**D315 (user 2026-11-09): Match reel rules (CODM; data in `data/games/<id>/`).** A match gets a reel when any rule holds: won and placed top 3; defeated and placed first on the scoreboard (reading of "if it's top"; UNVERIFIED, asked); own kills above 20 in Hardpoint, Domination or Control (won or defeated); own kills above 7 in TDM; Search and Destroy: a won match, or multiple own kills within one round. Replaces the top-3-only rule of D237.
**D316 (user 2026-11-09): Second-display / no-focus window rule dropped.** User: "d191 was placed due to a bug. don't need that rule anymore." Dropped: app windows opening only on a second display, never taking focus, showing nothing with one display (D191 window part, D219 studio placement, host preview placement). Kept, because they are the fix for that bug (console windows seen after close): no child process opens a console window (`hidden-window` lint, windowsHide / CREATE_NO_WINDOW, the windowless `ujwalam-start.exe`), tests run headless (`UJWALAM_HEADLESS=1`), and a window that appears at random is traced to its process. Supersedes the tray exception in D313.
**D315a (user 2026-11-09): Defeat reel placement.** A defeated match gets a reel when placed top 2 on the scoreboard (answers the D315 question; replaces the first-place reading).

## D317 — Clip job hang at the first child process (2026-11-10)

Since D311 (alpha.16) the clip job's parent-pipe watcher read stdin on a thread. On Windows a blocking read on a
synchronous pipe blocks every other call on that handle, and `subprocess` duplicates the standard input handle for each
child: the first ffprobe start hung forever (user's live-review stuck 38+ min at 0 %, 0.3 s CPU). Fix: the watcher reads
its own non-inheritable copy of the pipe; fd 0 and the standard input handle become NUL (`clip_common._take_stdin_pipe`).
Regression test `test_clip_contain.ParentPipe.test_child_starts_while_the_watcher_reads_the_pipe` hangs without the fix
and passes with it. `live_worker.py` and `face_worker.py` have the same watcher pattern; they do not start children after
it today (check before they do).

## D318 — Clip jobs get the project layout (2026-11-10)

The studio's clip jobs ran `detect` without `--project`, so detectors scanned the full H canvas instead of the game layer
(S1 top-3 and mode ROIs off). `record-clips` now passes the alpha project file when it exists (both `run` and
`live-review`). The project is read at job time, not at record time (UNVERIFIED risk if the layout changed in between).

## D319 — Auto-post rules in the data dir (2026-11-10)

The user's rules (`autoUpload`, `rules`) live in `<dataDir>/posting/auto-post-rules.json` and survive updates; the shipped
file is the empty template; an explicit file wins; an invalid user file fails closed. `auto --init-rules` creates the copy
(never overwrites). The Posts dialog shows the path and a read-only rules preview.

## D320 — Google app in production; privacy policy (2026-11-10)

User moved the OAuth app from Testing (7-day refresh tokens) to In production, unverified (personal use; "unverified
app" warning at sign-in). `PRIVACY.md` in the repo is the policy. Branding verification failed (home page on github.com
not owned); not needed for one user. UNVERIFIED: whether YouTube locks uploads from this unaudited API project to
private (projects created after 2020-07-28); the first scheduled upload will show it. Fix if locked: YouTube API
Services audit form.

## D321 — Task panel (2026-11-10, user)

User: task notification at the top right; the always-visible minimal task strip is replaced by a collapsible panel that
shows each task in full (stage in words, step, done/total, percent, elapsed, ETA from the observed rate), and a stall
warning when no progress arrives for N minutes. An indeterminate animation with no ETA "provides no insight".

## D322 — Kill montages on the "while" clip path (2026-11-10, proposed)

User: "checked the normal clips. but did not receive the montage clips from Ujwalam". The studio's clip job for a
recorded stream runs `clipper.py live-review`, which made only the short clips. Now, when the stream has both its H and
V recordings, the studio passes `--recording H --v-recording V --montage`. After the short clips are rendered, validated
and published (and the used replay saves dropped), live-review makes the kill montages and match reels of the H
recording (the same code as `clipper.py montage`, D298/D315) into the run folder's `montage/`, validates them and
publishes them. It needs the detector hits of the H recording: `detect` runs when the run folder has none and no pass
has run yet, even with the match gate off. Exit code policy: the montage never changes live-review's exit code (a
failure would make the studio report the whole job as failed and skip posting of the shorts). The outcome goes to the
log (`montage: NOT MADE (<reason>)`) and to `render.json` `montage` {status made|failed|skipped, reason, videos}. The
review job's stage list in the task panel gets `montage` at the end.

## D323 — Round end vs match end; game mode per match (2026-11-10, user: "Ujwalam needs to identify the match type itself")

Every VICTORY/DEFEAT banner closed a match, so round-based modes (Search and Destroy, Control, a half-time switch) split
one match into many (2026-11-09 recording: 14 segments for 6 matches + an open tail). The detector pass now records the
banner kind from the word's vertical position in the game area (pack 0.6.0, W1 `banner.kinds`, round centre y ~0.34,
match ~0.42; status unverified, one recording). Hits from older runs fall back to "a post-match screen follows within
followSec". Only banners classified as match ends close a match; a banner of unknown kind (recording ends too soon
after it) never does (Codex review). Round banners become `rounds` inside the match with per-round own kills, which
feeds `snd-round-multikill`. "SCORE LIMIT REACHED" on a round-style banner was a half-time side switch, not a match end:
a match end always shows the large banner. The game mode per match comes from on-screen evidence only (top-3 screen
mode name with on-screen spellings such as "SEARCH & DESTROY", new C1 mode cues, ranked "RATING n" score), and is
"unknown" with a reason when the evidence is missing or disagrees; it is never guessed. Open: the post-match lobby
header shows the mode but sits on the `summary` screen where no detector runs (screen-model change); own kill counts of
44 and 49 in two matches suggest a kill-feed dedup issue.

## D324 — Live updates, learning while streaming, scene builder from a reference (2026-11-10, user)

User: training data is learnt only while the user streams; every change must apply while the app runs, live on air,
reliably; a scene builder that builds and restyles scenes (and the app theme) from a reference image or video is a main
function. Approved plan: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` (LU1–LU8, LL1–LL5,
SB1–SB5). Order: LU8 live-soak gate and LU2 data hot-reload first. The libobs host is never swapped while live; its
updates are staged until the next stop. Learning store capped at 5 GB, oldest streams first. A local vision model for
layout reading is allowed if the hardware allows it (6 GB VRAM, never loaded while live), asked again before any install.

## D325 — Mode from the summary-screen header; own kill-count fixes (2026-11-10, user approved the screen-model change)

The post-match `summary` screen shows the game mode in its header (`VICTORY | <MODE>`) after most matches. Summary
screens may now run detectors, but only name-free context detectors (role context, nameRequired false), enforced by
`tools/game-validate.mjs`; menu, overlay and signal_loss screens still run none. New detector C2 reads the header
(pack 0.7.0, status unverified); its reads within `afterEndSec` of a match's end screens are one more evidence source
for `game_mode()`, as strong as the top-3 mode name, and disagreeing evidence still gives no mode. Own kill counts were
too high (Domination 44 for 20 on the summary card, match 1 8 for 4). Causes, all in the detector pass: ROI-band
boxes held by the roiEvery cadence overlapped the current kill-feed rows; a whole line merged into one OCR box with
the own name at its end read as a kill; victim keys taken from count digits, a second own-name box or the own-name
tail of a merged box; the BR feed read on MP frames after one stray BR cue. Fixed in code (no pack value changed);
each kill now records its feed and a match counts only the feed of its HUD family. Evidence:
`docs/evidence/2026-11-10-lobby-mode-and-kill-dedup.md`.

## D326 — Match reels cut only the streamer's own kills; spectate detector N3; impact-play reels (2026-11-10, user feedback F1/F4)

User feedback on a published reel: it showed the loadout swap, the round intro and another player's gameplay after the
streamer's death. Root cause (from frames): `match_reels` built its pieces from every signalled kill-feed hit, while
the match counts already used only the counted own kills. The BR-feed ROI reads the own name inside the custom weapon
name on the MP "select loadout" panel, which shows before each round and while dead and spectating; those hits made
pieces. Fix: `segment()` now records the counted kill times per match (`ownKillTimes`) and per round
(`roundKillTimes`), and reels cut only those. New detector N3 (pack 0.8.0, status unverified) reads the MP "you will
respawn next round" banner shown while spectating; kills inside an N3 span are not own kills (`spectateDetectors`) and
N3 is a death detector, so pieces are cut there. A Search and Destroy reel that qualifies only by a round multi-kill
(`pieces: qualifying-rounds`) shows only those rounds' own kills.

New reel kind `impact-play` (user wish F4): when the streamer's own IMPACT PLAY (M2) shows after the end screen, a
separate reel runs from the MVP animation through the impact-play camera to the results page (C2). Rule data is
`impactPlay` in `match-reels.json`; its timing values are agent values, proposed and unverified. It ships behind the
flag `impact-play-reels`, off by default, and posting does not upload this kind yet. Evidence:
`docs/evidence/2026-11-10-reel-own-kills-impact-play.md`.

## D327 — Stream settings, outputs panel, transitions, integrations and platform sign-in in the studio (2026-11-10, user)

User: the app connects to streaming platforms directly, not only through keys the user puts into Windows Credential
Manager by hand; plus four UI references (stream settings with outputs list, main-window outputs panel with switches,
transition settings per canvas, remote connections for the bots). Plan:
`docs/plan/2026-11-10-outputs-transitions-platform-connect.md`. Keys and tokens still live only in Credential Manager
(D-existing rule kept); the app now writes, reads, masks and removes them itself after a sign-in or a pasted key. The
remote-connections switch is off by default and LAN only. Platform sign-in gets a security review on the strongest model
plus a Codex second review before it is marked done.

Built (2026-11-10, branch `ui/outputs-transitions-integrations`, sections A–C; sign-in is on its own branch):
- The live plan comes from Settings > Stream when its flag is on; a value over a platform limit stops the start
  with the problem. Otherwise `alpha-live.json` is used as before. Changes apply at the next start.
- Each output keeps a Credential Manager key name `Ujwalam/stream/<id>`; the Edit window has a disabled "Connect"
  hook for the sign-in branch. No key is stored or shown by these pages.
- A live switch of one output needs "yes, on air" and stops or starts only that sink; the go-live authority and the
  other sinks are untouched (loopback test).
- Easing is a host formula per curve (`app/host/src/transition_ease.cpp`); the list is data
  (`data/transitions/easing.json`). Easing applies only to a fade; a cut or stinger refuses it.
- Virtual Camera is shown as "Not available in this build" (the host has no virtual camera method yet).
- The remote pairing token is new on every start, passed by environment only, never written to `integrations.json`.
Evidence: `docs/evidence/2026-11-10-outputs-transitions-integrations.md`.

## D328 — Data hot-reload and the live-soak gate (LU2, LU8; 2026-11-10, agent decision under D324)

Data files reload at their owning process through one data source (`services/common/data-reload.mjs`): a directory
watch with debounce plus a poll, schema check first; an invalid version keeps the last good one and is shown in the
task area (`data-<kind>` task) and the log at warn level, never error. Posting rules keep the last good version in a
running process; with no good version at all they still fail closed. A broken `flags.local.json` keeps the last flag
values instead of resetting them to the defaults, and so does one that gives a known flag a value other than true or
false (dropping only that value would turn a default-on feature on). Registry scene presets are not reloaded live: nothing running reads
them after launch (LU3 decides how a project picks up a changed preset). Game packs and the clip worker are out of
scope. The live-soak gate (`npm run soak`) runs from a staged copy of the runtime (`tools/soak/stage.mjs`) so it can
change data files without touching the repo; the host's overlay child gets only whitelisted environment variables, so
the stage's own profile points its data dir at the run. The gate needs a quiet machine: it refuses to start while Meld
Studio, an installed Ujwalam or a detector job runs, checks again every minute, and reports CPU per process next to
every lost frame, because the stack runs at BelowNormal and outside load shows up as render lag. The last segment of
each loopback stream may end one frame short at stream stop (encoder flush); that one step is reported apart and not
counted as a gap. Timestamp gaps are measured against the planned fps of the sink's rung, never the observed median.
The four streams youtube-h, youtube-v, twitch and kick are required by id (a plan without one fails), each live in
every sample and received in full; the recording must start, stay live and be probed like a stream.

## D329 — Device hot-plug: capture layers wait for a missing device; no feature flag (2026-11-10)

User bug: adding a capture-card layer after Ujwalam started failed with `HTTP 502: host-error (... no connected device
matches)` because Windows did not list the card at that moment. Now:

- The host watches device arrival and removal with `CM_Register_Notification` (cfgmgr32; capture, video, camera and
  audio interface classes). No window of any kind. Events are debounced (700 ms quiet, at most 3 s), then devices are
  listed again (list only, nothing opened). The watcher runs only with `--allow-devices` (D38) or `--test-hooks`.
- A capture layer whose device is not connected (no match, or two connected devices with the same name) is added and
  loaded as **waiting**: the `dshow_input` source exists with an empty device id and opens nothing. Adding no longer
  fails. A plain-English sentence says what is missing and what to do.
- Arrival: the waiting source gets the matched device id through `obs_source_update` (only that source). Removal: the
  source goes back to waiting and its last frame is cleared; the DirectShow graph is left to win-dshow. A loss is
  confirmed by a second listing 1 s later, so a USB re-enumeration blip does not drop the layer. A bound source stays
  bound while its device is still listed (a second card with the same name never steals it).
- Encoders, outputs, recording and the stream are never touched by a device event.
- The host publishes `host.status.devices` {seq, waiting, connected}; the UI server turns a moved seq into SSE
  `devices` + `layers`; the web page and the Qt studio reload the layer list ("waiting for device") and the add-layer
  device picker ("not connected"), also inside an open Add layer window.

**No feature flag.** Reasons: (1) the change replaces an error with a working add: there is no old behaviour worth
keeping behind a switch; (2) a device event only ever acts on a capture source whose own device came or went, and never
on encoders or outputs (the host test records over NVENC through plug, unplug, re-plug and a same-name second card,
with one file, full span and 30 fps); (3) without `--allow-devices` nothing changes at all (no watcher, capture layers
stay "forbidden"). Codex second review (2 x P2, fixed): removals are kept through the debounce, so a device that
leaves and returns with the same id is reactivated (that source only); a bind is "connecting" until the source
delivers a frame and is re-activated after 3, 6, 12 and 24 s without one (5 attempts), with a plain message. Not
done: a waiting state for WASAPI microphone and audio-output globals (they keep the current
behaviour). Real hot-plug with the user's card is UNVERIFIED until the user tests it. Evidence:
`docs/evidence/2026-11-10-device-hotplug.md`.

## D330 — Layer editing the way Meld and OBS users expect (2026-11-10, user request)

User (2026-11-10): deleting a layer, resizing and cropping it, and press-and-drag reordering in a scene were missing,
and the sliders only dragged (no click to a value, no typed value). Audit: delete existed but sat behind the scene-edit
flag (off), preview move/resize/crop existed behind the preview-edit flag (off), crop boxes were folded away, the
order buttons did not save, and the mixer volume was only sent on a slider release. Decided:
- Flag `preview-edit` is ON by default from now (the flag stays and can be switched off in Settings > Advanced). This
  is a recorded exception to "new features ship off" because the user asked for the feature; tests/flags.test.mjs
  lists it (ON_BY_DECISION). The live-lock is unchanged: while any output is live a press on the preview selects
  nothing (D233); on air, placement changes go through the inspector and "yes, on air".
- On the preview an edge handle stretches that side alone (aspect free, the moving edge snaps); Alt + edge still
  crops (D256); corners keep the aspect (Shift: free). The window shows move, size and rotate cursors over the
  selected layer.
- Deleting a layer and the saved layer order (Move up/down, menu, drag in the layer list; structure op `layer.move`,
  now also with `target` + `place` above|below) no longer need the scene-edit flag. Both stay refused while live
  (structure route); the studio asks before deleting; while live the list order falls back to the host's live-only
  `layers.move` with "yes, on air" as before. Removing a scene stays behind scene-edit. A delete cannot be undone (a
  structure edit clears the history, D240): the confirm is the guard.
- Crop: the project already stores `placements.<canvas>.crop` (D256), so no schema change or migration. The inspector
  shows the four crop boxes without a toggle.
- Sliders: one shared widget (app/studio/src/value_slider.*): a click jumps to that value, an editable number box
  (type + Enter), arrow keys and PageUp/PageDown step, the mouse wheel only acts while the slider has focus, one
  notch = one step. A mouse gesture commits on release only; key, wheel and number-box steps commit once after a
  250 ms pause; Enter commits at once. The Look panel and mixer sliders use it; the mixer sends the volume on every
  committed change, not only on a drag release.
- The control page matches the studio: Remove layer needs no flag, asks first, and is greyed while live; its order
  moves try the saved structure move first.
Evidence: `docs/evidence/2026-11-10-layer-editing.md`.

## D331 — Blurred game backdrop replaces the background layer, H and V, no feature flag (2026-11-10, user request)

User: "replace the current background layer in Ujwalam with a blurred copy of the game capture. it needs to fill in
the whole screen behind all layers". Decided:
- Both stream scene presets (Default H 0.6.0, Default V 0.5.0): the browser `background` layer (atmos-frame page) is
  removed. The bottom layer is `game-backdrop`: a `duplicate` of the game capture with a Gaussian blur, over the full
  canvas, cropped to cover the canvas without stretching (H: 16:9 source on a 16:9 canvas, no crop; V: crop 656 left
  and right, as before). The atmos-frame overlay itself stays in the repo (the hidden H `atmos-front` layer still uses
  it); it is only retired from these two scenes' background.
- No feature flag. This is a recorded exception to "new features ship behind a flag, off by default", because the user
  asked for it directly (as D330 did for preview-edit). The V backdrop was behind flag `layer-effects` (D224); it no
  longer is. The game's own rounded corners keep `effectsFlag: layer-effects` as before.
- Blur: V keeps strength 40 (sigma 20 source px, about 35.5 canvas px at the V scale 1.78). H uses strength 71 (sigma
  35.5 source px = 35.5 canvas px at scale 1), so both canvases show the same blur on screen. Proposed, UNVERIFIED on a
  real capture; tunable per layer in the Look panel (strength 1-100, no flag) and live through `layers.setEffects`.
  The host blur already works on a downscaled copy (it halves the texture up to 3 times until sigma <= 6.5 texels,
  then upscales), so no extra downscale step was added; cost in the evidence.
- Existing projects: a one-time scene upgrade `bg1` (services/project/scene-upgrades.mjs) runs when the studio starts
  and finds the alpha project on disk, before the project goes to the host. In each scene it finds the preset layer
  `<preset>/background` and puts the backdrop in its place in the stack (the V scene's existing, hidden backdrop is
  shown and moved there; the H backdrop is added). Only those layers change; the user's moved, edited and added layers
  stay. A copy of the file goes to `projects/_old/alpha-<stamp>.before-bg1.project.json` first. A project without the
  retired background (a new build, a second start, or a user who removed it) is not changed. A background that another
  layer or an audio source still uses is hidden, and its origin becomes `<preset>/background-retired-bg1`, so the
  upgrade does not run again. While the game capture is still a placeholder (unbound), that scene is left as it is
  and keeps its background; the upgrade runs on a later start, after the capture is bound. A V backdrop that was built
  as a placeholder is then turned into the real blurred duplicate in place (same id and box). A failed upgrade never
  blocks the start: the project loads as it is and the reason is logged.
- Live: the upgrade runs only at start, before the host load, so a running stream and its outputs are never touched.
  A studio that is already running gets the backdrop at its next start.
Evidence: `docs/evidence/2026-11-10-bg1-game-backdrop.md`.

## D332 — No typed confirmation; the click is the decision (2026-11-10, user decision)

User (2026-11-10): "No text type anywhere." "No misclick guard, end stream means end stream." "All clicks will be made
by user's decision." Decided:
- Every typed phrase ("yes", "yes, on air", "yes, upload", "go live anyway") and every "are you sure" question is gone
  from the studio, the control page and the server. Start stream, Stop stream, End all, close while live, delete a
  layer or scene, delete an output, bots, flags (on and off), project load, connections and YouTube upload act on the
  click.
- Live-lock gate (services/event-core/livelock/gate.mjs): an untainted write or on-air write from ui or api is allowed
  and dispatched at once (audit reason `ui-direct`). A write from rule, remote or system gets one pending confirmation
  with no phrase; it runs only on a click from ui or api. The two-step flow is removed; `panic.clear` is a direct ui/api
  click. Kept unchanged: chat can never write or confirm; taint (chat or alert provenance) forces the confirmation path
  and a tainted click cannot confirm; `forSource` binding; single-use confirm ids; the action hash (id, params, source,
  actor, live epoch); the epoch re-check at confirm and the guard's revalidate before dispatch; panic; idempotency
  keys; the audit (fail closed). `actions.confirm` still accepts an old client's `phrase` and ignores it.
- Readiness (flag readiness): a failed check no longer starts the stream. The answer lists the problems with a
  "Go live anyway" pending entry, confirmed by `{ pendingId }` only; the override is logged as before.
- Studio Settings is a draft across every page, feature flags included (on and off apply at Save). Cancel, Escape or
  the X with edits asks "Save changes / Discard / Cancel". This is not a misclick guard on an action: it keeps edits
  that Save would otherwise lose.
- Settings > Advanced (N2): one row per flag, a switch that shows ON / OFF in words, the flag name and its plain
  description from data/flags.json, built fresh inside the dialog (keeps the 2026-11-10 native-handle offset fix).
- AGENTS.md: the "Studio writes need yes" rule is replaced; agents still need the user's words in chat before studio
  writes or going live, and a live test still starts only on "start stream test".
Not changed: the preset id `live-lock-yes-on-air` (an id, renaming it is a registry migration), the release notes
of earlier alphas, and the terminal-only `services/event-core/audit/cli.mjs` purge prompt (a developer CLI, not app UI).
Also readiness warnings (no failed item) no longer stop the start; they come back in the answer's `warning` text.
Evidence: `docs/evidence/2026-11-10-n1-no-typed-confirm.md`.

## D333 — A live stream records H and V; live clipping fails readiness when it cannot run; its state is visible (2026-11-10, user request)

User: "make the app live stream ready as a priority with auto clipping feature while live and reel creation in the
background from clips as per existing rules." The kill montages and match reels need the portrait (V) recording,
and a live stream recorded only H, so reels from a stream were never made. Decided:
- V recording while live. The live plan (`data/outputs/alpha-live.json`) and Settings > Stream (H + V canvas mode)
  add a `record-v` file sink on the existing `vert` rung, crash-safe .mkv, named `<record name>-v` (for example
  `alpha-v-<stamp>.mkv`). No new encoder: sinks never own encoders, and the vert rung already encodes for YouTube V.
  Audio is encoded once and shared. Record starts both recordings; the replay buffer binding is unchanged.
- File targets take an optional plan-only `"optional": true`. When the plan streams and an optional recording's rung
  feeds no stream (for example YouTube V switched off with the D327 toggles or `--sinks`), that recording is dropped
  rather than adding an encoder or failing the plan. Settings "main" canvas mode has no portrait rung, so no V file.
- Disk cost: at the alpha-live bitrates (yt-h 17,000 kbps, vert 7,500 kbps, audio 160 kbps each) H alone is about
  7.2 GB (1024^3) per hour and H + V about 10.4 GB per hour, so V adds about 3.2 GB per hour. The readiness disk
  check now states hours left from the bitrates of the recordings set up, falling back to the data value
  (`disk.gbPerHour` 11). The fail and warn thresholds (22 GB, 44 GB) are unchanged: 22 GB is about 2.1 h of H + V.
- Readiness: when live clipping is wanted (flag `live-clips` on or Settings clips "while"), a missing clip Python,
  missing `services/clip/live_worker.py`, ffmpeg/ffprobe not on PATH, or a live clipper that did not start (for
  example no game layer or no capture device) or gave up after 5 restarts is a FAIL with a plain reason and the fix.
  A missing or stale launcher status is a warning. With clipping off the check passes or warns as before. Names and
  fixes are data (`data/live/readiness.json` `clips`).
- Visible state: the clips `status.json` carries the live clipper state (running, not running with reason,
  restarts) and the moments kept so far. The studio task panel shows a "Live clips" row while a stream or recording
  is watched, and a finished clip job notes "Reels not made: <reason>" when the montage was skipped, failed or
  could not run (no V recording).
- No feature flag. Same recorded exception as D330–D332: the user asked for it directly. No typed confirmation and
  no new "are you sure" (D332).
Not changed here: going live did not start recording by itself (D334 changes that).
Evidence: `docs/evidence/2026-11-10-lc1-live-clips-ready.md`.

## D334 — Record while live, on by default (2026-11-10, user request)

Same user request as D333 ("auto clipping feature while live and reel creation in the background from clips"). The
reels are cut from the H and V recordings, and Start stream did not record, so a stream made no reels unless Record
was also pressed. Decided:
- Setting Settings > Clips > "Record while live" (switch row with its explanation, N2 style), stored as
  `clips.recordLive` (true or false) in settings.json. **Default on**, because the user asked for reels from live
  streams directly. Switching it off restores the old behaviour.
- With it on, after a stream start the host accepted (the stop-wins checks passed), the UI server starts the
  recording (`record.start`: every record sink, H and V) if none is running, and remembers that it started it.
  When that stream ends (Stop stream, End all, or the status poll seeing no stream sink running) it stops that
  recording, so the launcher sees the finished recording and runs the after-stream review and montage job.
- A recording the user started by hand is never started again or stopped by this. A Record or Stop recording click
  during a recording started with the stream hands it back to the user.
- A failed `record.start` never fails or stops the stream: the answer carries a warning ("The stream is live, but it
  is not being recorded (...)") and the task panel a failed "Recording the stream for reels" row with the reason.
- A Stop or End all that arrives while `record.start` is on its way wins: the recording is stopped again at once.
  No start while Ujwalam is closing (the start is inside the closing-lock count). No confirmation (D332).
- Codex review of LC2:
  - The recording stops only when a fresh `outputs.status` shows no stream sink starting, live, reconnecting,
    retrying or stopping. A per-output Stop, or an End all still closing, keeps it, and the status poll stops it
    later.
  - Starts and stops run one at a time. Ownership is one object plus a generation counter, so a late answer never
    takes over the user's recording and never forgets a newer one.
  - Stop and End all never wait for a pending automatic `record.start`.
  - A Record or Stop recording click hands the recording to the user before it is sent to the host.
  - An automatic start takes the generation when it is queued, and is dropped if a click changed it before the
    start runs.
- Disk: about 10.4 GB (1024^3) per hour at the alpha-live bitrates (D333); the readiness disk check already counts
  the H and V recordings.
- No feature flag (same exception as D330–D333: the user asked for it directly).
Code: `services/studio-ui/record-live.mjs`, `server.mjs`, `user-settings.mjs`, the Qt Settings > Clips page.
Evidence: `docs/evidence/2026-11-10-lc1-live-clips-ready.md` (LC2 section).

## D335 — Preview mouse editing acts on the list's layer; drags coalesced; snapping is a setting, off by default (2026-11-10, user report F8-F10)

User (2026-11-10, alpha.21): "while a layer is selected from the layers that layer needs to move. now some other layer
is moving. hovering and resizing needs to optimised. snapping to the edge of preview should an an option that user
could turn on in settings as well." Decided:
- F8: the host editor's selection follows the studio's layer list through a new RPC `preview.select {canvas, layer |
  null}` (refused when editing is off, while live, during a drag, or for a layer that is not visible with a placement
  in the canvas's active scene). The studio sends it when its selection, canvas, scene or the layer's visibility
  changes, once per change. Press priority stays OBS: a press inside the selected layer's box or on its handles acts on
  it even under other layers; only a press outside it hit-tests the topmost layer. Such a press moves
  `host.status.previewSelection.seqs.<canvas>` (one seq per canvas, so a click on V never moves the H list); the
  studio's list then selects that layer (no echo: a selection the studio sent never moves the seq). A `preview.select`
  refused mid-drag (or busy, or live) is kept and sent once more when `previewSelection.dragging.<canvas>` is false
  (and not live); a newer selection replaces it; if that retry is refused too, the list goes back to the host's
  selection, so the list never shows one layer while the preview edits another (Codex review of 23e5289).
- F9: during a drag the drawn selection follows every mouse move, but the rectangle goes to libobs
  (Studio::layer_set_placement) at most once per 16 ms with the newest point; a 16 ms window timer sends a waiting
  point when the mouse rests, and the release always applies the final rectangle and records exactly one edit.
  Handle hit areas, the rotate-handle distance, the drag threshold, the snap distance and the drawn handles are in
  logical px (window DPI / 96), so they keep their size at 125 and 150 % scaling. Hover stays backend-free.
- F10: Settings > Preview has the switch "Snap to preview edges and other layers" with its explanation, default off
  (the user's words: an option to turn on). Stored as settings.json `ui.snap` (bool); the UI server keeps the host equal
  to it with `preview.setSnap {enabled}` (host.status `previewSnap`, host default off). On: D272 snapping (canvas edges
  and centre, other layers; Alt suspends). Off: no snapping; Alt only matters for the crop gesture.
Not done: a snap-distance setting (the triage row mentions one; the distance stays 8 px, D272). Real-mouse feel on the
user's screen is UNVERIFIED until the user tries it.
Evidence: `docs/evidence/2026-11-10-f8-preview-select-snap.md`.

## D344 — Reference themes T2–T5, bundled OFL fonts, font allowlist (2026-11-11, request R10, user answers 2026-11-10)

Plan: `docs/plan/2026-11-10-theme-framework.md` §2 A–D, §3.1, §5 rows T2–T5, §6. Built on the T1 framework (D336); no
framework code was added. Branch `theme/t2-t5-reference-themes`.

- **Fonts bundled (user answer §6.2).** Inter (daylight-blue, sand-teal), Barlow (copper-graphite) and Exo 2
  (teal-grid), all SIL Open Font Licence 1.1, licence texts checked and shipped beside the fonts (`data/fonts/`). The
  files are downloaded unmodified from the upstream repositories (file download only, nothing installed, nothing
  installed into Windows); sources, versions and SHA-256 are in `docs/third-party-notices.md`. Regular, semibold and bold
  only (the weights the packs use: 400, 600, 700). Inter and Exo 2 come from their own upstream releases as static
  files, because Google Fonts ships them only as variable fonts and Qt's weight selection on those is UNVERIFIED.
- **Loading.** `theme.cpp` `loadBundledFonts()` runs at studio start (before the first theme) and calls
  `QFontDatabase::addApplicationFont` for each `*.ttf` in `UJWALAM_FONTS_DIR`, `<app>/fonts` or the repo/install
  `data/fonts`. This process only. The probe reports `bundledFamilies`.
- **Allowlist rule change.** The packager's blanket font-file ban (D133 era, "none ship") becomes an allowlist: only the
  12 pinned files in `OFL_FONTS` / `OFL_FONT_LICENCE_SHA` (`tools/package/manifest.mjs`) ship, each pinned by SHA-256, and
  `build-alpha.mjs` fails if a staged font differs from its pin or a licence text is missing. Every other font file is
  still forbidden, and Microsoft fonts (Corbel, Consolas) stay forbidden by name as before.
- **Lint rule change (a check that flagged a verbatim third-party file).** The `trailing-ws` rule skips exactly the three
  licence paths in `OFL_FONT_LICENCES` (not a pattern), the same way it already skips vendored `.diff`/`.patch` files: they are
  byte-identical copies of upstream; their SHA-256 is pinned in `OFL_FONT_LICENCE_SHA` and checked by `build-alpha.mjs` and `tests/package-alpha.test.mjs`. Fonts register once per process (`loadBundledFonts` guard; Codex review). Any other file there is still checked
  (`tests/lint.test.mjs`).
- **Theme designs** (measurement to value per theme: `docs/evidence/2026-11-11-t2-t5-reference-themes.md`):
  - daylight-blue: rounded solid buttons with outline secondary, underline tabs, outline inputs, ring focus, plain
    switch, thin slider, rule section headers, raised cards with accent-tinted soft shadows (3 levels), airy density,
    faint layout columns.
  - copper-graphite: Barlow, caps on buttons, tabs and headings; pill metal buttons, pill tabs, inset wells, glow
    focus, bezel switch, thick inset slider with sphere handle and value bubble, raised metal cards and plate rows with
    copper gradient rims, inner-glow rim on the primary button.
  - sand-teal: neumorphic plates (light shadow up-left, dark shadow down-right), pill buttons, sunken fields, ring
    focus, labelled ON/OFF switch, thin slider with value bubble, caps headers, segmented tabs, plate rows, airy.
  - teal-grid: Exo 2, brass-bezel primary button (gradient rim plus inner glow), boxed tabs, filled inputs, glow focus,
    bezel switch, bracket headers and chips, framed cards, compact, blueprint grid with outer frame and ticks.
- **Judgement calls.** (1) Plain-button depth: the existing rule (2026-11-10) that plain buttons carry no depth effect
  stays for daylight-blue, copper-graphite and teal-grid. Sand Teal is the one exception: its neumorphic buttons are
  drawn only by a light and a dark shadow, so without the effect they would be invisible; measured cost 89 depth
  widgets against 27 in the headless probe, and High performance drops every depth effect. `tests/studio-themes.test.mjs`
  states the exception. (2) Approximations inside the T1 variants, no new variant: sand-teal tabs use `segmented` (the
  reference's raised container with an underlined selected tab would need an underline-in-container variant);
  teal-grid secondary buttons are teal-tinted, not coral (the tint colour is the accent); `filled` inputs for teal-grid
  follow the §3.1 table although the reference draws a full edge. (3) Pack fonts apply with the flag off too (the
  family is a v1 field); the components block and every v2 part still need the flag.
- **Switch contrast.** The base Switch gap T1 listed is fixed inside each pack by its switch variant (plain, labelled or
  bezel paint onAccent on the "on" side); the contrast test passes for all four in every state.
- Not done: the other five themes (T6); illustration from reference B stays dropped (§6.3). The package does not ship
  `data/themes` today (UNVERIFIED whether the installed studio finds packs another way), so the packaged fonts are
  loaded but only used when the packs ship.
Evidence: `docs/evidence/2026-11-11-t2-t5-reference-themes.md`.

## D338 — Learning signals become label rows in a local learning store (2026-11-11, LL2 of D324)

Spec: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` section B (approved, D324). LL2 plus the
parts of LL1 (store, cap) and LL5 (privacy scan) it needs. Decided:
- **Store:** `<dataDir>/learning-store/<session>/labels.jsonl`, one folder per stream session (LL1 adds its evidence to
  the same folders). JSON lines, append-only, not SQLite: the writers are three processes (launcher, UI server, the
  feedback collector child) and one appended line needs no lock or shared database; SQLite would need one database
  per owning process. A row is `{ v: 1, at, action, source, session, ref }` with action one of kept, deleted, posted,
  renamed, feedback and source one of my-clips, posting, hotkey, feedback-form, chat-feedback. `ref` holds short
  primitives only (file name, run, clip id, post id, moment id, message id). No event names, weights or windows.
- **Signals, hooked where they already happen (no new UI):**
  - My clips (the clips folder, listed in `<dataDir>/clips/uploads.json` by the clip pipeline): the launcher checks
    once at start and every minute. Gone with a same-identity file (NTFS file id; size + mtime otherwise) in a day
    folder of the same clips folder = renamed (old and new file name); gone otherwise = deleted; still there at the
    first check of a later app start than the one it was published in = kept (once per clip). Clips already missing
    the first time they are seen get no row. Session = the clip's run.
  - Posted: `uploadPost` (services/posting/youtube.mjs; Posts view, CLI and the auto-post chain all use it) after a
    finished upload. Session = the post's run. Posting approve/reject and title edits are not labelled (not in the
    list of signals; a title is not a clip rename).
  - Feedback hotkey (Ctrl+Alt+F): each new moment folder the host writes (source hotkey, session `day-<date>`); the
    feedback form's note adds a row with its tag and severity, never its text (source feedback-form).
  - Chat-feedback replies: the read-only collector (tools/collect-stream-feedback.mjs, run by the live test kit when
    a stream ends) adds one row per newly collected reply with the feedback file name, the message id and the
    platform, never the viewer name or text. Session `stream-<local start stamp>`.
- **Cap (LL1):** 5 GB for the whole store, whole session folders removed oldest first, never the latest one; run at
  launcher start and every tenth pass. Implemented now (cheap). Age is the session's start (`session.json`
  `createdAt`, written once with its first row), not its last write: a late row in an old session (a clip deleted
  days later) must not make the newest stream removable (Codex review).
- **Retries (Codex review):** a clip's or moment's state moves on only after its row is written, so a failed write is
  tried again on the next pass. Moments keep a checkpoint (the newest moment labelled; the host adds moments with the
  current time), never a trimmed list of ids, so old moments are never labelled twice.
- **Privacy (LL5):** clip file names in the store (rename rows) are the user's own words; they stay in the local store
  only and are never committed (store, gitignore and private scan below). The store is in the app data folder, never the repo; `learning-store/` is gitignored and the
  private scan's local rule refuses any path with a `learning-store/` folder at any depth and case (pre-commit,
  pre-push, history). Nothing is written to `data/labels/`; its rules are unchanged.
- **No flag:** pure background label writing with no visible effect; recorded exception to "behind a flag" as the
  LL2 brief allows. `services/learning` is added to the alpha package manifest.
Not done: LL1 evidence capture, LL3 review queue, LL4 training. Real use on a stream and on the user's clips folder is
UNVERIFIED. Evidence: `docs/evidence/2026-11-11-ll2-learning-signals.md`.

## D339 — Scene builder SB1–SB2: read a reference into typed data, rules first, behind `scene-builder` (2026-11-11, plan D324 section C)

Plan `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` section C (approved, D324), with the build
plan's §4.6 "Theme from media" and §4.7 "Theme → scene generator". Decided:
- SB1 input: a local image (.png .jpg .jpeg .webp .bmp .gif) or video (.mp4 .mov .m4v .mkv .webm) only. URLs,
  `file:` and network shares (also through a link or mapped drive) are refused; ffprobe/ffmpeg run hidden (D191)
  with `-protocol_whitelist file` and a demuxer fixed per extension (`-f`: mov, matroska, png/jpeg/webp/bmp pipe,
  gif), never guessed from the content, so a playlist, concat list or image-sequence pattern cannot open other
  files (.avi dropped). ffmpeg decodes `0:v:0`, the stream ffprobe measured. Width/height are the display size (the
  display rotation from side data or the rotate tag turns a quarter-turned video; autorotation on, so the frames
  match), and that size picks the analysis size and the H/V canvas. Frames × analysis pixels ≤ 40 M (refused
  above); frames are measured one at a time, keeping full measurements for the key frame only (Codex review). Frames
  are scaled (area filter) to a 960 px long side. A video is sampled at N evenly spaced times
  t_i = (i + 0.5) · duration / N (default 8, at most 64; one seek per sample; a time past the last frame's start
  moves back to it). `services/scene-builder/frames.mjs`.
- SB2 output is data only, typed by `data/schemas/reference-read.schema.json` (schemaVersion 1): base name of the
  file (never a folder), palette, style (type feel, corner radius, glow, shadow) and slots (game, camera, chat,
  alerts, graphics) with box fractions 0..1, a confidence 0..1 and the rule hits as evidence. It never changes a
  project or scene; SB3 builds scenes from it later.
- Palette: the §4.6 method ported from the legacy reference tool (OKLab, seeded k-means++ k = 8, WCAG contrast,
  lightness push), plus a merge of clusters closer than OKLab 0.03. Generic roles (background, surface, text,
  accent, accentAlt) with provenance extracted/derived; text prefers neutral clusters and is pushed to 4.5:1; no
  invented colours (a missing second accent is null). SB4 maps the roles onto the theme schema.
- Slots by rules: cells of about 1/48 of the long side classed busy / ui / soft; the game is the maximum-sum
  rectangle of busy cells, split at near-empty seams; other content is boxed on a half-cell grid, text-like boxes
  stacked under each other merge into one rail; camera (skin tones + texture + camera shape), chat (text lines,
  stacked cards, a tall rail at a side or a wide portrait rail), alerts (wide, centred, upper half, vivid fill; never
  a full-width band) and graphics (the rest). Motion in a video is evidence for the game, not a cell class (chat and
  camera move too).
- Style by rules: type weight from stroke/height of glyph-like marks (light < 0.08 ≤ regular < 0.12 ≤ bold < 0.17 ≤
  black), size on a 1080 px short side, polarity; font family is left null for the model. Corner radius sub-pixel
  (half-way crossings on the sides and the diagonal, 0.2 px corner bias measured on drawn corners), only on boxes
  with a whole outline. Glow = vivid marks (OKLab L ≥ 0.5, C ≥ 0.08) whose same-hue colour fades out on two sides or
  more; shadow = a darker band under a box that lightens outward.
- Local vision model: a typed hook only (`readReference(file, { model })`, adapter `{ id, local: true, analyze }`).
  Non-local adapters are refused; answers are shape-checked; a model slot replaces a rules slot of the same role
  only with a higher confidence; a failing model leaves the rules result with a note. Nothing is installed; no paid
  API. Choosing and installing a model needs the user's yes ("if the hardware allows it").
- Entry point for SB3/SB4: `readReference()` / `readFrames()` in `services/scene-builder/read.mjs`, and
  `node services/scene-builder/cli.mjs read <file> [--frames N] [--long-side PX] [--data-dir DIR]` (JSON on stdout,
  exit 2 while the flag is off). New flag `scene-builder`, off by default; no studio UI yet.
Tolerances on drawn fixtures: every slot side within 0.03 of the frame side; palette colours within OKLab 0.02 and
shares within 2 points; corner radius within max(3 px, 15 %) on a 1080 px short side. Results on real references are
UNVERIFIED until the user checks them.
Evidence: `docs/evidence/2026-11-11-sb1-sb2-reference-read.md`.

## D340 — Live evidence and low-confidence reads go to the learning store; an optional review in My clips (2026-11-11, LL1 and LL3 of D324)

Spec: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` section B (approved, D324). Builds on D338's
store (same folders, same 5 GB cap; no second store). Decided:
- **LL1 capture (live worker):** `services/clip/learning_capture.py` writes into
  `<dataDir>/learning-store/live-<live session stamp>/`: `evidence.jsonl` (one row per OCR'd frame that produced
  detector hits: hit rows in the detector pass format, the frame's mode and its OCR texts with score and box),
  `review.jsonl` (LL3 items) and `frames/<id>.jpg` (only for review items; no other frame is kept), plus
  `session.json` written once (the cap's age order, as store.mjs). Unchanged frames (diff gate) add nothing. The live
  loop only builds small dicts and puts them on an 8-item queue with `put_nowait`; a daemon thread writes (JPEG
  encoding with OpenCV on the CPU, appends). A full queue, a failed write or a full store drops the item; `frame()`
  only counts drops and the writer thread logs them (the first and every 100th; a failing log is ignored, Codex
  review). The writer keeps the whole store under the 5 GB cap: at start, on its own thread, it measures the other
  sessions and allows this one what is left minus a 16 MB margin for label rows. `frame()` never raises, and a store that cannot open only turns
  capture off. No model, no GPU work and no extra OCR are added (VRAM rule). No flag: background writing with no
  visible effect, as D338. `FrameScanner` now keeps its last OCR boxes and a `fresh` mark (no extra work).
- **LL3 queue, thresholds from data only:** unclassified-banner = a signalled W1 VICTORY/DEFEAT word whose height fits
  none of the pack's W1 `banner.kinds` (answers: the pack's kinds plus "not a banner"); ocr-low = a signalled hit read
  below `game.json` `ocr.minConfidence` (answers: the read or "wrong read", or a typed correction). That value is
  null in the CODM pack today, so **no ocr-low item is queued until the user sets it**; no threshold is invented.
  unknown-mode = a match of the stream's recording with an end screen whose game mode the match gate could not tell
  (`gameMode` null), queued by `clipper.py live-review --recording` after the stream, with one frame of the recording
  at its end screen (ffmpeg, post-stream); answers: the modes the pack names (S1 modeNames, C1/C2 cues, banner
  subtitles). "Match mode" is read as the game mode of a match (match_gate), not the HUD family mp/br. One item per
  appearance (a banner still on screen on the next frame is not queued again). Only signalled rows are looked at.
- **LL3 review:** `services/learning/review.mjs` lists unanswered items (newest 20 sessions, 200 items), serves an
  item's own `frames/<id>.jpg` only (every read must resolve, by realpath, inside the store; reads are async, bounded
  to 2 MB per file and cached by mtime and size, Codex review), and writes the answer as a D338 label row: action `confirmed` (new), source
  `review` (new), `ref { item, kind, detector, label, value, corrected }`. UI server routes
  `/ui/api/learning/review|frame|confirm`, 404 while the flag is off. The Qt studio owns My clips (its top-bar
  button), so the review is a **Review reads (N)** button beside it, shown only with the flag on and items queued,
  opening a non-modal window (list, frame, answer, Confirm, Close; Posts window patterns). The click is the decision
  (D332). New flag **`learning-review`**, off by default. Nothing waits for an answer; unanswered items stay until
  the cap removes their session.
- **Privacy (LL5):** frames and OCR texts (they can hold player names) live only in the local store, which is
  gitignored and refused by the private scan (D338). The review list does not carry OCR texts. Committed test
  fixtures are synthetic with placeholder texts.
Not done: LL4 training. Real use on a live stream and a real recording is UNVERIFIED. Evidence:
`docs/evidence/2026-11-11-ll1-ll3-capture-review.md`.

## D337 — Service swap while live: fronts, hand-off, rollback; behind the service-swap flag (2026-11-11, LU3)

Plan row LU3 (D324): the supervisor starts the new version of a service next to the old one, health-checks it, moves
the API over, then stops the old one; on a failed check it keeps the old one. Decided:
- **Stable ports.** The launcher owns a front (`services/supervisor/front.mjs`) on 127.0.0.1 for the event core and
  one for the studio UI server. Clients (studio window, browser, host, overlay child, LAN remote) only see the front
  ports; api.json names the front port. Tokens never change. The front rewrites Host/Origin only when they name the
  front, so the backends' own DNS-rebinding and same-origin checks run unchanged. WebSocket upgrades are refused.
- **Moving the API (0 events lost).** During a switch the front holds new requests (queued, not refused) and waits
  for requests in flight. Every open event stream gets a second upstream to the new backend whose frames are queued.
  The old event core then hands off: it stops taking events (Streamer.bot closed), drains the bus, ends its streams
  cleanly and closes its audit database (one writer per file). The new core, which started in standby (Streamer.bot
  connected, ingest buffered, no database), activates: it opens the database, continues the event ids above the old
  core's last id (id floor), takes over the live lock state and panic, and replays its buffer through dedupe (an event
  both cores saw is dropped as a duplicate). The front sends the queued frames, skipping ids not newer than the last
  one sent, and then pipes live. The client keeps its TCP connection.
- **Health check and rollback.** Core: the standby core answers core.status with the system token and is connected
  to Streamer.bot when the old one is. UI: HTTP answers. A new version that exits, hangs or fails its check is stopped
  and the old one never notices (kept-old). A failure during the hand-off re-activates the old core (restored-old).
- **UI server.** Side by side; the login sessions are copied over the IPC channel inside the switch, so the page
  stays logged in. Its event stream is carried by the front; each new server starts the stream with the whole state
  the page listens to (status, flags, edits) and `retry: 500`. Pending Allow clicks and the undo history are not
  carried (memory only): a pending confirmation must be clicked again, and undo starts empty after a swap.
- **Workers (live clipper, face worker).** Stop-start, not side by side: two clip workers would save every clip
  twice, the face link is one per host, and VRAM has no room for two (D1). The new worker must stay up for a health
  window; if it exits, the old version starts again (restored-old). The slot is built and tested; wiring it to the
  launcher's Python workers is not done yet (their own restart rules are in launch.mjs).
- **Never swapped while live:** the host (LU5) and the overlay server (a child of the host, which pins its ports and
  restarts it). Refused with that reason.
- **Trigger.** Only the process that started the launcher can ask, over its IPC channel:
  `{ t: 'ujwalam-swap', id, service, root }`; root is the folder of the new version and must hold the entry file.
  LU6 (live install) will use it. No port, no file, no chat path.
- **Flag.** `service-swap`, off by default, read at start (the fronts must exist before the services). Off: the
  services start exactly as before.
Limits: an event without a platform message id that both cores saw in the overlap can appear twice (dedupe needs an
id); if the new core fails while activating, the events it buffered are lost (double failure). Also fixed while
wiring this: the event-core serve parser took `--lan` as a value-taking option, so the launcher's `--lan` swallowed
the next argument (`--url` or `--lan-address`) and remote connections never switched on.
After the Codex review (same day):
- **One-time login key.** Only the first UI process gets the key. A replacement starts with key login off and takes
  the key's state (used or not, age, failures, lock) from the old process over IPC inside the switch, so a used login
  URL never works again after a swap. A studio-window rearm sent during a swap waits and goes to the process that
  serves after it.
- **Timed-out steps.** Each step gets an abort signal and is awaited before the rollback. A hand-over still running
  after a 30 s grace ends the swap as `failed` with nothing restored, so two cores are never activated.
- **Overflow.** A standby core whose buffer overflowed is never used: it fails its check, is refused before the
  hand-off and cannot activate.
Evidence: `docs/evidence/2026-11-11-lu3-service-swap.md`.

## D343 — Host updates wait for the stop; a live update is one click; versions on the control page (2026-11-11, LU5 and LU7, LU1 hashes)

Plan rows LU5 and LU7 (D324), built on LU3 (D337). Decided:
- **Flag.** No new flag: the existing `service-swap` (off by default, read at start) now covers the whole live-update
  queue. Reason: with one flag there is no setting in which an update while live skips the click, and the queue needs
  the same IPC channel LU3 opened. Its description in data/flags.json says what it now does.
- **Queue.** `services/supervisor/updates.mjs`, owned by the launcher. Updates still arrive only from the process that
  started the launcher (`{ t: 'ujwalam-swap', id, service, root }`, LU6 will use it). A click arrives only from a UI
  server process over its IPC channel (`ujwalam-update`), which only a logged-in page or the studio window can reach
  (session cookie, same origin, CSRF). The event core (chat, rules, the LAN remote) has no channel to the launcher, so
  chat, rules and agents can never trigger an update.
- **Live (busy).** The D334 rule widened to recordings: a fresh `outputs.status` shows a stream or record sink starting,
  live, reconnecting, retrying or stopping. A status that cannot be read counts as live. No host: not live.
- **Host (LU5).** While live, a host update is staged and never applied, not even on a click. The queue polls a fresh
  status (2 s) and applies it once everything has stopped: the old host is asked to exit, the new one starts from the
  release folder (`bin/ujwalam-host.exe`, `obs/`, the overlay server child `app/host/overlay/child.mjs`), must write its
  discovery file and load the project (alpha), else the previous host is started again (`restored-old`). A planned
  restart is not a crash (the crash supervisor ignores it). The overlay server is a child of the host: an update named
  `overlay-server` is a host update. A stand-in script host (tests) is replaced only by `bin/ujwalam-host.mjs`. A host
  part that did not change (LU1 hash equal to the running one) is answered `unchanged`.
- **Maintenance lock (Codex review, P1).** The queue's status check alone left a gap: a start could reach the host
  between the last `outputs.status` and `host.shutdown`. Now every `stream.start` and `record.start` the UI server sends
  to the host (clicks, confirmed actions, the automatic recording start, the per-output switch) first takes a lease
  from the launcher over the authority IPC channel and gives it back after the host answered (`gateStarts`,
  `createStartGate`). Before the host update the launcher holds the gate: new leases are refused at once (the start is
  not sent, `HOST_UPDATING`), then it waits for leases on their way (15 s, else the update goes back to waiting), then
  revokes the go-live authority (no stream recovery), then reads the last status. The gate stays held until the new
  host runs or the old one is back. A launcher that does not answer a lease refuses the start (fail closed). The
  launcher's own crash restarts are not gated: they cannot run during a planned restart (one host supervisor, busy).
  Codex re-review: a grant is tied to its request id; a grant that arrives after its request timed out is given back
  at once, and a release without an answer is sent again (growing wait, up to 30 s) while the link is up, so a lost
  message cannot block host updates for good. Active leases never expire on their own; a UI server that goes away
  gives back all its leases.
- **Integrity (Codex review, P1).** An update needs `release.json` with version, `n` >= 1 and the LU1 hash (file count
  and sha256) of each part it runs from; the host also `hostExeSha256`. No metadata: refused. The whole part is hashed
  (host: exe, OBS runtime, overlay child, projects; a service: services, data and overlay parts), copied into
  `<dataDir>/live/releases/<kind>-<n>-<hash>`, and the copy is hashed again; the update runs only from the copy, so the
  offered folder can change after the check without effect. Codex re-review: release.json is read once; that snapshot
  is checked, written into the copy and used for every later check (the copy's entry, its `n` against the running and
  the waiting release, the unchanged check), so a release.json that changes during the request cannot mix two
  releases. The copied files are made read-only. The host copy is hashed when the queue picks it, and again after the
  old host has exited, right before the new one is spawned (the same right before each startup candidate's spawn); a
  failure rejects it and the previous host (or the next candidate) starts. Out of scope: full immutability against a
  local writer. The data folder belongs to the same Windows user, who can clear read-only and change a file between
  the last hash and the spawn (milliseconds); that user can change the installed app as well. Copies that no record
  names are deleted at the next start.
- **Close with a staged host update; start trial (Codex review, P1).** `<dataDir>/live/host-update.json` (v2) keeps
  `pending` (the host release to try next: staged, or being applied), `good` (the last host release that got ready and
  loaded the project) and `rejected` (releases that failed: never tried again). The next start tries pending, then
  good, then the installed host; each try is a trial: it must write its discovery file and (alpha) load the project, or
  it is stopped (exit confirmed), recorded as rejected, and the next one starts. A candidate is used only while its `n`
  is newer than the installed release (a checkout counts as 0). Waiting service updates are dropped at a close (logged).
  Codex re-review: only the candidate's own failure rejects it (its hash right before the start, readiness, project
  load). A replacement aborted before the candidate ran (the old host did not exit, Ujwalam closing) keeps it pending
  in host-update.json and back in the queue; it is tried again at the next poll once nothing is live.
  Codex review of the merge: the replacement is one transaction. An exception anywhere after the old host stopped
  (the last hash cannot read a file, the switch, the start) never skips the previous host's restart; a replacement
  that was spawned is stopped with its exit confirmed first; the hash check never throws (an unreadable file is a
  problem like a wrong hash). The launcher answers which host runs (`running`: new, old, none, unknown) and the queue
  moves the shown versions only when the new one runs.
- **Services (LU7).** Not live: applied at once (the request is the user's own install action). Live: the update waits
  for one click, "Apply now" on the control page (D332: no typed phrase, no "are you sure"); the click runs the LU3
  swap while live. **Reversed after the Codex review (P2):** a waiting service is NOT applied at the stop; nothing
  applies it but its click (AGENTS: a system request waits for one click). Only the host is applied by the poll.
- **Studio window (merge with LU4, D346).** With the flag on, a `studio` swap request goes through this queue as the
  part `studio-window`: release.json with `n` and the LU1 `studio-window` hash is required (this checkout's dev build is
  not an update), the part is copied to `<dataDir>/live/releases/studio-<n>-<hash>` and checked, and LU4's studio
  slot swaps to the copy after the same entry check (`swapEntryOk`). Not live: at once. Live: one click, like the
  other services. The queue runs one update at a time (host replacement, service swaps and clicks), so a studio swap
  never overlaps a host replacement or another swap, and the maintenance lock is held only around a host replacement
  (a studio swap does not touch the host's outputs). A second swap request while one is being handled is refused,
  as in LU4. The control page's "Studio window" version follows the swapped release.
- **Order (Codex review, P2).** An update whose `n` is not newer than the running release of its part, or than a
  waiting update of the same part, is refused. A same-part waiting update is dropped before a newer one is applied at
  once or queued, so an older waiting item never runs after a newer one. One update runs at a time.
- **Confirmed exit (Codex review, P2).** A host is replaced only after its exit is confirmed (`stopHostChild`:
  `host.shutdown`, then the process tree, then a wait). If it is still running, the update is aborted with the host's
  state in the reason and nothing else starts; a new host that failed and does not exit is not joined by the old one.
- **Visible.** `<dataDir>/live/updates.json` (versions per part, waiting items in plain words, last 8 results; no paths)
  goes into the UI server's status snapshot (`updates`) and `GET /ui/api/updates`. The control page shows a "Versions
  and updates" card (host, overlay server, event core, control page server, studio window, data) and an "Updates
  waiting: N" pill. The studio window (Qt) does not show it yet: that needs a C++ change and a studio build.
- **Flags.** A test checks that every flag in data/flags.json has a `since` date and that every flag since 2026-11-10 is
  off by default.
- **LU1 (part).** The packager writes `parts` into release.json: per part (host, studio-window, services, overlay, data)
  the file count and a hash over the files' paths and hashes (`services/supervisor/parts.mjs`, moved from tools/package
  so the launcher can check a release; tools/package is not packaged). Not yet in a built alpha.
- Also fixed: `services/supervisor` was missing from the package (LU3's imports failed the import-closure check).
- `updates.json` writes retry a rename that Windows refuses while the UI server reads the file; the launcher's swap reply
  keeps the asker's `id` (the queue item id is sent as `item`).
Limits: a Start stream clicked while the host is replaced is refused ("the video engine (host) is being updated") and
must be clicked again; the live clipper and face worker are not updated by the queue (not wired, D337); a service copy
holds only the services, data and overlay parts of its release (enough for the event core and the UI server, checked
with real swaps in tests/service-swap-launcher.test.mjs).
Evidence: `docs/evidence/2026-11-11-lu5-lu7-host-staging.md`.

## D336 — Theme framework T1: components block (schema v2), variant fragments, flag theme-components (2026-11-11, user request R10)

Spec `docs/plan/2026-11-10-theme-framework.md` §3 and §5 row T1; the user's answers in §6. The user asked that each
theme be a full design (layout, shapes, type, components, effects), not a colour swap. T1 builds the framework only;
no theme is designed and no font is added here. Decided:
- **Schema v2** (`data/themes/theme.schema.json`): an optional top-level `components` block with enumerated variants
  only (button shape, style, secondary and caps; tabs; input; focus; switch; slider track, handle and value bubble;
  section header; card; list; chip; density). `additionalProperties: false` everywhere, so an unknown key or variant
  fails the schema, and the studio's `packProblem` refuses the same pack (it is not listed and cannot be applied).
  Typography gains `buttonCaps`, `tabCaps`, `headingCaps` and a type scale (h1, h2, subtitle, body, caption, button,
  6..28 pt). Background gains the `blueprint` and `columns` patterns and a `frame` (thin outer frame, optional corner
  and mid-edge ticks). Depth classes gain `highlight` (a light shadow), `inset` (inner shadow, always or pressed) and
  `rim` (gradient edge with an optional inner glow).
- **Flag `theme-components`**, off by default, switchable on the control page while live. Off: every v2 part is
  ignored (a v2 pack looks like its v1 parts; blueprint shows as grid, columns as no pattern) and the stylesheet is
  exactly the v1 one. On: the pack's variants apply; a pack without a `components` block keeps the same base
  stylesheet (the probe reports its hash; the test compares on and off) and only gets two rules for things that exist
  only with the flag: the error state of fields (no studio field sets it yet; the specimen shows it) and the slider's
  value bubble.
- **An empty variant is the base look.** Fragments are appended after the base stylesheet in `theme.cpp`
  (`componentQss`), so they override it rule for rule; derived colours (tint, well, metal ends and others) are mixed
  from the pack's tokens, never hardcoded, and mirrored in `tests/studio-theme-contrast.test.mjs`.
- **High performance stays flat**: no gradients (metal and sphere fall back to plain fills), no depth effects
  (highlight, inset and rim included), no switch halo.
- Painted widgets read their variant through `theme::component()` / `theme::componentFlag()`: Switch (plain,
  labelled, bezel), the ValueSlider value bubble, task chips (bracket chips show "[ text ]"). Round transport buttons
  and section headers are stylesheet-drawn, so their variants come from the fragments (`QPushButton#round`,
  `QGroupBox::title`, `QLabel#heading`) plus heading caps; no painted code was needed for them.
- **Density** goes through `theme::space()` / `theme::margins()` at the fixed spacing call sites (73 sites): compact
  0.75, normal 1, airy 1.25; the base values are kept on the layouts, so a switch re-applies them.
- **Caps are applied by font capitalisation** (the label text never changes, so tests and screen readers see the
  real words).
- **Specimen page**: Settings > Appearance > "Preview all components" (shown only with the flag on) opens one window
  with every component in every state; it follows a theme switch at once.
- **Contrast test scope**: every pack, every state (normal, hover, pressed, checked or selected, focus, error): text
  4.5:1, control parts and focus indicators 3:1. Disabled text is exempt (WCAG 1.4.3); borders that only decorate a
  filled control are not checked. Every variant in the schema must have a contrast table. Known base gaps, kept
  because T1 must not change existing looks: Tactical's warning text on the field colour (4.28:1), and the base
  Switch (knob and ON in the text colour on the accent track, below 3:1 in most packs). Every switch variant paints
  onAccent on the "on" side and passes on every pack; the base switch is fixed when the packs are redesigned (T2-T6).
- **v2 needs a components block** (Codex review of T1): every v2 rendering change (variants, caps, type scale, frame,
  blueprint and columns, depth highlight, inset and rim) applies only with the flag on AND a `components` block in the
  same pack. A pack with other v2 fields but no block keeps its v1 look with the flag on. Reason: the block is what
  marks a pack as designed for v2; the parity promise for packs without it then holds whatever they carry.
- **A flag switch re-parses the accepted pack** (Codex review of T1): the look keeps the JSON it was parsed from, and
  switching the flag parses that again instead of reading the file, so a newer file that live reload refused can
  never stop the switch (before, switching off after a refused edit left the component look on).
- Not in T1: elevation levels 1-5 (spec §3) and the per-theme designs and fonts (T2-T6).
Evidence: `docs/evidence/2026-11-11-t1-theme-framework.md`.

## D341 — Scene builder SB3: build new H and V scenes from a reference as a scene package, imported in isolation (2026-11-11, plan D324 section C)

Plan `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` row SB3 (approved, D324), build plan §4.7
("Theme → scene generator", "Isolated import"). Input: the SB2 typed read (D339). Decided:
- Output is a scene package (`data/schemas/scene-package.schema.json`): one scene-layout-preset per canvas plus
  bindings. The existing preset loader (`services/project/scene-preset.mjs`) applies it, so the import path is the one
  the built-in scenes already use. The importer (`services/project/scene-package.mjs`) adds ONE new scene holding the
  H and V layers (the host shows one active scene on every canvas, as the alpha project does), named
  "Built: <reference>" (rules `sceneNamePrefix`; "(2)" when taken), origin `scene-package/<package id>`.
- Never changes existing state: the input is never mutated; the existing state (whole input project) must hash
  (sha256 of canonical JSON) the same as the result minus the new scene and the overlay entries it added, or the
  import is refused. Dry run by default. Apply (after the Codex review) is a guarded transaction: refused while the
  studio has the data folder open (host.json / api.json with a live pid; the store has no lock), compare-and-swap
  against the exact bytes loaded right before a temp-file rename, an after-save check where a throw counts as a
  failure, and a restore of the loaded bytes (temp + rename) only while the file still holds what the import wrote;
  the shared .bak is never copied back. A project that loads only from its .bak or needs a migration is refused.
- Sources by reference: game and camera link to the project's existing capture layer as a `duplicate` (new preset
  layer type `link`; the device is opened once); with only a device, a capture layer on that device (the V one becomes
  a duplicate of the H one). Chat and alerts reuse the project's overlay entry (chat-list, alert-box) and that layer's
  settings, minus geometry; `canvas=`, size and `theme=` are set. No device is ever created. Matching order: the user's
  `--bind`, a built-in preset layer, the device bound to the alpha role, the only capture card; anything else is
  ambiguous and becomes a placeholder asking for `--bind`.
- Placeholders: a slot below `minConfidence` (0.5) or without a matching source is a transparent colour layer that
  keeps the geometry, listed in the diff with the reason. A binding lost between build and import is a placeholder too.
- Geometry: the reference's canvas takes the slot boxes (fractions). The game is never cropped (contain, both
  canvases); the camera covers its box with a centred crop of at most 40 % of a side, else contain. The other canvas
  follows `data/scene-builder/build-rules.json`: V inside the V safe zone (YouTube Shorts margins from
  `data/clip/targets.json`, the only V safe zone in the repo), game across the safe width, camera and alerts above,
  chat below; H a left column (camera, alerts, chat) beside the contained game. On a V reference, important slots
  outside the safe zone are warned and kept as drawn (warn only, like D231). Graphics are carried only on the
  reference canvas (listed as not carried), at most 8.
- Overlays use theme tokens: graphics are a new token panel page (`ujwalam-panel`: --glass, --steel, --radius-*,
  --ember-glow; radius class from the read mapped to the tokens); `--theme ID` passes the brand theme. The read's
  palette is not written as colours (SB4 makes a theme).
- Entry point: `node services/scene-builder/cli.mjs build <reference> --project FILE [--bind ROLE=ID]... [--theme ID]
  [--out PKG] [--apply] [--json]` and `import <PKG> --project FILE [--apply]`, behind the `scene-builder` flag (off
  by default). No studio-ui RPC: the studio server never takes a path from the page.
- `mergeCanvasScenes` moved from `services/studio-ui/alpha.mjs` to `scene-preset.mjs` unchanged (shared).
Tolerance on the drawn fixtures: every side within 0.03 of the canvas side (the game: contained, centred, one axis
within 0.03). Build rules, the V safe zone for live and the results on real references are UNVERIFIED.
Evidence: `docs/evidence/2026-11-11-sb3-build-scenes.md`.

## D342 — After a stream, a game pack check proposes a new pack version only when it beats the current one on held-out streams (2026-11-11, LL4 of D324)

Spec: `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` section B, row LL4 (approved, D324). Builds on
the D338 store and the D340 review answers. Decided:
- **Job and trigger:** `services/clip/pack_tune.py propose` runs as the last job of the launcher's clip queue
  (`services/studio-ui/record-clips.mjs`, job type `train`), queued when a stream's clip job ends (done or failed),
  only with the new flag **`learning-train`** on (off by default). Same queue as every clip job: one at a time, hidden
  (`windowsHide`), below normal, never started while a stream is live, stopped when a stream starts and run again
  after, kept across a restart. pack_tune.py also refuses while the live clipper is asked to watch
  (`clips/live-worker.json`) and when the flag is off (exit 3). Stdlib only: no model, no GPU, no OCR (VRAM rule).
- **Values tuned, and only these:** W1 `banner.kinds` `y0`/`y1` (from `unclassified-banner` answers: the item's OCR box
  whose text is the read word gives the centre y) and `game.json` `ocr.minConfidence` (from `ocr-low` answers: the
  read kept is right, `wrong read` or a typed correction is wrong; lowered only, since the review holds reads below the
  current value only). A banner range is widened only as far as the training answers need, never over a read answered
  as another kind or "not a banner", never into the other range. No detector, pattern, event name, weight or window is
  added or changed. `ocr.minConfidence` is null in the CODM pack, so no `ocr-low` read exists and that value is reported
  as "not set", never invented. Kept / deleted / posted / renamed clips, feedback rows and `unknown-mode` answers are
  counted in the run report but give no pack value: no row links a clip or a feedback moment to the read that made it.
- **Held-out test (existing rule):** split by session. Per value, the newest 2 sessions (by `session.json` start) that
  hold labels for it are held out and the older ones train. Metric: held-out accuracy (banner: the kind each confirmed
  read gets, "not a banner" = none; OCR: read taken as right iff score >= threshold, null = all taken as right).
  Offered only when the proposal's held-out accuracy is strictly higher than the current pack's and, for the banner
  ranges, no held-out evidence banner the current pack placed changes kind. Agent settings (proposed, not tuned, not
  pack values): at least 3 sessions with labels for the value (2 held out, 1 or more to train), at least 10 training
  and 6 held-out labels. Below that it proposes nothing and says why.
- **Candidate, never applied by itself:** `data/games/<id>/local/candidates/<stamp>-<version>.json` (gitignored by
  `data/games/*/local/`): changes, held-out score, evidence (label counts, session counts, dates), status
  `unverified`, the base file hashes and a changelog entry draft; `last-run.json` holds every run's report. The pack
  version is bumped by one patch step (a value change). `pack_tune.py approve --candidate <id>` (flag `learning-train`)
  writes the values, the version and the changelog entry, keeps the kind status `unverified` with a note, and refuses a
  candidate made from other pack files (hash or version changed) or one already approved. Approval is a command, not a
  studio window, in this step; the task panel note says when a candidate waits.
- **Codex review fixes:** `approve` refuses while the live clipper is asked to watch, the same check as `propose`.
  `propose` checks again after reading the pack, after each store session and before any write, and stops with
  nothing written when a stream starts. The base hashes are of the exact bytes parsed at the start (and approve's stale
  check uses the bytes it parses). `approve` is a recoverable transaction: every new file (both JSONs, the changelog,
  the candidate marked approved) is written as `<name>.ll4-new`, then a journal
  (`local/candidates/approve.journal.json`) lists the renames, then they run (the candidate last) and the journal is
  removed. A leftover journal is finished at the next start of any command, so a retry after a crash succeeds; stray
  `.ll4-new` files without a journal are removed. The changelog is replaced by rename, never truncated in place.
Not done: an approval button in the studio. Real use on a stream is UNVERIFIED (no real labels exist yet). Evidence:
`docs/evidence/2026-11-11-ll4-after-stream-train.md`.

## D345 — Scene builder SB4: a studio theme pack from a reference, contrast-checked, saved as a new custom theme only on --apply (2026-11-11, plan D324 section C)

Plan `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` row SB4 (approved, D324). Input: the SB2
typed read (D339). Output: a theme pack in the `data/themes` format, schema v2 with a components block (T1, D336).
Decided:
- **One check, shared.** The T1 contrast pairs, `derived()` and the check moved from
  `tests/studio-theme-contrast.test.mjs` to `services/studio-ui/theme-contrast.mjs` unchanged; the test imports it.
  A generated pack is checked by exactly the rules the shipped packs are (text 4.5:1, controls and focus 3:1, every
  state, the base look plus the variants it picks).
- **Colours (`services/scene-builder/theme.mjs` mapColours).** background -> bg, surface -> panel, text -> text,
  accent -> accent, as read. Every other token is derived from read colours and says how: field (surface, 0.035
  lightness toward the middle), border (surface mixed toward the text, at most 14 %, text keeps 4.5:1 on it), muted
  (text 35 % toward the background), accentHi (accent lightness +-0.10), onAccent (the background or the text colour,
  whichever gives the accent less to move), disabled (muted 45 % toward the background; exempt). No accent read: the
  most chromatic cluster, else the text colour (a neutral accent). danger and ok: a red or green cluster of the read
  (never the accent itself), else the semantic hue (OKLab 29 / 142 degrees) at the accent's lightness and chroma: the
  one place a hue is not from the picture, because a warning must read as a warning; it is labelled "convention".
  Dark or light follows the read's text polarity (a mid-tone ground goes by its text). Then each colour is pushed with
  the §4.6 maths (new `forceContrastAll` in `colour.mjs`: the same 0.01 lightness steps against several grounds, hue
  and chroma kept), and a settle loop pushes whatever still fails (the ink first, a face only when the ink cannot move
  or would oscillate); every push is reported with the pair that needed it. A pack that still fails is never written.
- **Variants (chooseVariants).** Corner radius class: none -> button sharp, tabs boxed, input filled, chip and section
  header bracket, slider handle bar, card framed (when no shadow); pill -> pill buttons and tabs; otherwise rounded,
  underline tabs, outline inputs. Studio radius = read radius at 1080 / 2 (2..16), small and large around it. Glow ->
  focus glow, bezel primary, outline plain buttons, bezel switch, glow on the primary button in the read glow colour,
  round controls when active, toasts. Shadow -> raised cards, solid buttons, focus ring, thick slider track, a black
  drop shadow on cards, primary and round controls, toasts, menus and the task panel (opacity from the read depth).
  Neither -> soft buttons, tinted plain buttons, focus border, flat cards, no depth. Type size -> density (small
  compact, large airy) and base size; weight -> heading weight and icon stroke. metal and neumorph are never picked
  (the rules read no surface texture). A style answer below confidence 0.5 keeps the base look for the keys it decides
  (left out of the pack). Motion, control sizes and padding are the studio defaults.
- **Where it goes.** The studio's user themes folder (`theme.cpp` searchDirs `<app data>/themes` =
  `%APPDATA%\Ujwalam Studio\themes`; `UJWALAM_THEMES_DIR` first, as in the studio; `--themes-dir` overrides). Never
  the built-in `data/themes` folder, never a built-in id, never over an existing file: a temp file is hard-linked into
  place (fails if the name appeared) and removed. The studio lists it as a custom theme; with `theme-components` off
  it draws the base look (no components, no fragments).
- **Entry point.** `node services/scene-builder/cli.mjs theme <reference> [--name N] [--themes-dir DIR] [--apply]
  [--json]`, behind the `scene-builder` flag. Dry run by default: prints every colour with where it came from, every
  push, the variants with why and the contrast result. `build --theme-from-reference` was skipped: `build --theme`
  passes an overlay brand theme id, a different theme system, so the link is not trivial.
Real references: every pack passes the check and loads in the headless studio with no stylesheet errors; the looks
themselves are UNVERIFIED (no human check yet). Evidence: `docs/evidence/2026-11-11-sb4-theme-from-reference.md`.

## D347 — Scene builder SB5: iterate. Save a studio scene as a package, edit a package, make similar variants (2026-11-11, plan D324 section C)

Plan `docs/plan/2026-11-10-live-updates-live-learning-scene-builder.md` row SB5: "the user adjusts in the studio (move,
resize, swap slot); 'similar' variants; save as a scene package. Done when: round trip build -> edit -> package ->
import." Decided:
- **The studio edit is the project's own placement.** The user moves and resizes in the studio as for any scene; SB5 adds
  no editor. `services/scene-builder/export.mjs` `packageFromScene(project, scene)` reads that scene back into a scene
  package (same format as SB3, D341): duplicate -> link (game or camera, by the layer's origin key), capture -> capture,
  overlay page -> browser (file and query), colour -> colour. Anything else (images, media, hidden layers, a link whose role
  is unknown, a second target for one role) is not carried and is listed with the reason; rotation, opacity and effects are
  dropped and named in the warnings. Slots are `confidence 1, from "edit"` (schema enum extended); the package carries a
  `lineage` note (parent, changes). Read only: the project is not touched.
- **Edit a package.** `iterate.mjs` `editPackage`: move, resize, place, swap (two layers trade boxes). Fractions of the
  canvas, all or nothing, the input package is never changed, the result has a new id and `(edited)` in its name. Capture
  and link layers re-fit on resize and swap with the build's fit (game contained, shape kept, never cropped further;
  camera cover with a centre crop of at most `camera.maxCrop`); a chat layer's width/height query follows its box. A box
  off the canvas or under 0.02 is refused; a V layer outside the safe zone is a warning, never moved silently.
- **Similar variants.** `similarVariants` (1..8, seeded: same package + same seed = same variants). Kinds: nudge-small,
  nudge-large (a few percent of the canvas), mirror (left to right) and mirror+nudge. A variant is kept only if every box
  stays on the canvas, a V layer inside the safe zone stays inside, no overlap grows, the game gets no more crop than it had,
  and it differs from the original and the other variants. They are data for the user to look at and import; nothing picks one.
- **Round trip.** build -> import (new scene) -> studio edit -> export -> import again: each import adds one new scene and
  the existing-state hash is unchanged (the earlier built scene is byte-for-byte untouched). Links bind by id, so a package
  imported into a different project falls back to placeholders (listed) unless the ids exist there.
- **Entry point and safety.** `node services/scene-builder/cli.mjs export|edit|variants` behind the `scene-builder` flag
  (off by default; exit 2 when off). These commands never write the project and never apply; they write only the
  package files named by `--out` / `--out-dir` (never over an existing file). Using a result is `import`, whose apply rules
  (studio closed, compare-and-swap, dry run first) are unchanged from D341. No studio write without the user's click.
- **Not done.** No studio UI for these (the studio server takes no file path from the page); the re-fit assumes a 1920x1080
  camera source when the package has none (UNVERIFIED against a real device format); a crop the user set in the studio on a
  camera is replaced by the centre crop after a resize or swap (a move keeps it); no check on a real stream.
Evidence: `docs/evidence/2026-11-11-sb5-iterate.md`.
## D346 — Studio window swap while live: the window is closed for the update, the new one reattaches to the running host (2026-11-11, LU4)

Plan row LU4 (D324): closing the studio for an update no longer stops the host; the new studio reattaches to the
running host (previews re-embed, state from the host); a normal close still stops everything (D280 kept). Decided:
- **A stop-start service.** `studio` joins the swappable services (`services/supervisor/swap.mjs`) with mode
  stop-start, slot `createStudioSlot` (`services/supervisor/slots.mjs`). Two windows never run at once, so there is
  never a second tray icon or a second set of previews; global hotkeys belong to the host and are not touched. Same
  flag (`service-swap`, off by default) and the same trigger as D337: `{ t: 'ujwalam-swap', service: 'studio', root }`
  from the launcher's parent only. root holds `studio/ujwalam-studio.exe` (staged or installed version), or is this
  checkout (its development build).
- **Swap close, not a user close.** With the flag on, the launcher starts the studio with a control pipe
  (`UJWALAM_STUDIO_CONTROL=1`, stdin). `swap-close` ends the window through `MainWindow::swapClose`: tray icon removed,
  exit code 75; no closeEvent, no task dialog, no quit lock. The launcher marks that exit as planned: it is written
  to studio-exits.jsonl with `swap: true` and nothing is stopped. Exit 0 (the user's close) still stops everything;
  any other unplanned exit is still a crash with the reopen rules of D280.
- **Reattach.** The launcher gives the UI server a new one-time key (`rearm`, as for a crash reopen), starts the new
  exe, which logs in, reads its state from the UI server and host.status as at any start, and embeds the H and V
  previews into its own slots (`preview.open` with the slot's window handle). The host drops the old embedded
  previews when the old slot windows are destroyed (WM_DESTROY) and keeps rendering, encoding and sending.
- **Health check and rollback.** The new window must print `studio attach: ready` and `studio attach: preview <c>
  embedded` for every preview the old one had, then stay up 1 s. A new build that exits or misses that (20 s ready,
  10 s previews) is stopped and the old version is started again (restored-old).
- **One swap at a time** over all services: a studio swap needs the UI server for its login key, so a UI swap and a
  studio swap never overlap.
- **Headless tests.** `UJWALAM_HEADLESS=1` + `UJWALAM_STUDIO_HIDDEN=1`: the launcher starts the studio, whose window
  is laid out and "shown" with `Qt::WA_DontShowOnScreen` (never on screen). The headless host now accepts an embedded
  preview only into a parent whose top-level window is hidden; a stand-alone preview and a visible parent stay
  refused. `UJWALAM_STUDIO_TEST_CLOSE_MS` (hidden only) makes the window take the user's close, and a
  `ujwalam-studio.test-crash` file beside the exe makes a build crash at start (headless only), for the tests.
- **The 20-swap stream test is opt-in** (`npm run test:studio-swap`, also `npm run soak:studio-swap`): it streams
  NVENC to four loopback listeners for a few minutes, too heavy for the hourly CI.
Limits: a window kept in the tray (D311) comes back as a normal window after a swap; open dialogs and unsaved field
edits in the old window are lost (the swap is the user's update click). Evidence:
`docs/evidence/2026-11-11-lu4-studio-swap.md`.
Codex review fixes (2026-11-11):
- **A user close during a swap stops the session (D280).** Exit 0 is the user's close, 75 a requested swap, anything
  else a crash. When the new window on probation (before ready, previews and the 1 s health wait are done), or the old
  one before it took `swap-close`, exits 0, the slot starts nothing more: no restore of the old version (result
  `failed`, or `kept-old` when the old one was closed), and `onUserClose` tells the launcher, which logs "studio window
  closed during a swap: stopping Ujwalam" and stops everything. A crash on probation still restores the old version.
  Test hook: a `ujwalam-studio.test-close` file beside a staged exe (text: ms after ready) closes only that build.
- **Headless embedded previews are never shown.** Checking the parent's top-level window only at `preview.open` let a
  parent shown later make the preview visible. Now, when headless, the embedded preview window is created without
  WS_VISIBLE and never shown (a child is visible only with its own WS_VISIBLE): WM_WINDOWPOSCHANGING drops
  SWP_SHOWWINDOW, WM_STYLECHANGING drops WS_VISIBLE, and the 200 ms refresh timer hides it if WS_VISIBLE got set any
  other way (ShowWindow under a hidden parent does that). The libobs display still renders into it. `preview.list`
  gains `shown` (its own WS_VISIBLE) and `visible`. `preview.testParent` (--test-hooks only) makes a never-shown parent
  window and tries ShowWindow, SetWindowPos and SetWindowLongPtr on the child for the test.

## D348 — Remaining five themes as full designs, T6 (2026-11-11, plan `docs/plan/2026-11-10-theme-framework.md` §4, §5 row T6)

Same pattern as D344. No framework code, no new variant, no new font file. Branch `theme/t6-remaining`. Packs changed:
studio-light, violet-night, neon-arcade, retro-wave, tactical.

- **Fonts: only the three bundled OFL families** (Inter, Barlow, Exo 2). The Windows-only families the packs named
  (Segoe UI, Bahnschrift, Trebuchet MS) are replaced; Segoe UI stays only as a fallback name, never as the face.
  studio-light and violet-night: Inter. neon-arcade: Exo 2. retro-wave and tactical: Barlow. Base sizes follow D344 (Barlow
  10.5 pt, Inter and Exo 2 10 pt).
- **Component language** (the plan's §4 table, as data):
  - studio-light: rounded solid buttons, outline secondary, underline tabs, outline inputs, ring focus, plain switch,
    thin slider, rule headers, raised cards, normal density, no glow (soft shadows only, as before).
  - violet-night: soft buttons, ghost secondary, segmented tabs, filled inputs, glow focus, plain switch, thin slider
    with value bubble, plain headers, raised cards, normal.
  - neon-arcade: sharp bezel buttons (caps) with a cyan rim and inner glow on the primary button, tinted secondary, boxed
    tabs, underline inputs, glow focus, bezel switch, bar handle, bracket headers, framed cards, compact.
  - retro-wave: pill metal buttons (caps), pill tabs, inset inputs, glow focus, labelled switch, thick inset slider with
    sphere handle and bubble, caps headers, raised cards with a chrome rim, plate rows, normal.
  - tactical: sharp solid buttons (caps), outline secondary, segmented tabs, filled inputs, border focus, plain switch,
    thick slider with bar handle, rule headers in caps, raised cards, bracket chips, compact, no glow on plain controls.
- **Plain buttons carry no depth effect** (the 2026-11-10 many-widgets rule): `depth.button` is `{}` in all five. This
  removes neon-arcade's hover glow, tactical's extrusion, retro-wave's hover glow and studio-light's soft shadow;
  `tests/studio-themes.test.mjs` now lists all eight packs under the rule (sand-teal remains the one stated exception).
- **Contrast.** The shared check passes for all nine packs in every state. Tactical's warning text `#ee6a50` on the
  field colour was 4.28:1; danger is now `#f47a5e` (4.89:1). `KNOWN_BASE_GAPS` in the contrast test is empty.
- **Tests.** The reference-theme probe suite covers the five packs (load, components block equals the file, density,
  font resolved by Qt, no stylesheet errors, specimen at 100, 125, 150 %). The two v1-fallback tests in the components
  suite, which used violet-night and retro-wave because they had no block, now strip the block from a copy.
Evidence: `docs/evidence/2026-11-11-t6-remaining-themes.md`.

## D349 — Live install: an install while Ujwalam runs goes next to it and is handed to the update queue (2026-11-11, LU6)

Plan row LU6 (D324), built on LU3 (D337), LU4 (D346) and LU5/LU7 (D343). Decided:
- **Running copy found by path.** `Install-Ujwalam.ps1` lists programs whose path or command line lies under the
  install root (System.Management, not by process name, not Get-CimInstance; the installer itself is left out). A
  program under a folder with a similar name does not count. If the list cannot be read, nothing is installed (exit 8).
- **Never a file of the running copy.** Live: the new version is copied and checked into its own folder as before;
  current.txt points the next start at it and previous.txt names the running one. A top-level file that a running
  program is or names (`ujwalam-start.exe` it runs from, `Ujwalam.cmd` a console runs: cmd.exe reads a running batch
  file again after a call) is kept and named in the output; an unchanged one is not touched. Reinstalling the version
  that runs is refused (exit 4), also with -Force (no rename of a running folder). A folder a running program uses is
  never offered for removal.
- **Hand-over channel.** With the flag `service-swap` on, the launcher listens on a named pipe with a random name
  (`\.\pipe\ujwalam-install-<32 hex>`) and a 64-hex token, both written owner-only (as api.json) to
  `<data>\core\live\install-channel.json` and removed at the stop. No TCP port. One JSON line in (`t`, token, root =
  the installed new version folder), one line out. A wrong token, a relative or missing root, or a folder without a
  release.json with `n` and part hashes is refused before anything is asked. The token is never printed or sent back.
  Trust line: the same as D343 (the user's own programs; chat, rules, the LAN remote and the event core have no path
  to it). The launcher's parent IPC (D337) stays as it was.
- **Same path as a parent request.** The channel asks the launcher's own `serveSwaps` over an in-process message
  channel (`localSwapAsker`), so every check of D337/D343/D346 runs unchanged: entry file, release.json with `n` and
  LU1 hashes, the checked private copy, newer than running and waiting, one update at a time. Nothing live: applied at
  once (the user's own install action). Live: a service waits for one click on Apply now; the host is staged and
  applied at the stop (LU5). The channel never applies anything itself and never skips the click.
- **Only what changed.** The queue now keeps the LU1 hashes each running part runs from (`runningParts`: the installed
  release at start, updated after each swap; the host hash of the host that runs). The plan, in order: event core and
  control page server when services, data or overlay pages changed (a data change alone swaps both: they read the data
  of their copy; LU2 hot-reload covers edits of the data files a running service already reads, not a new release); the studio window when its part changed and a studio window runs (a
  browser page: skipped, next start); the host when its part changed (the queue answers `unchanged` as before). An
  unknown running hash (a development checkout) counts as changed.
- **Without the flag** (or an older running version, or no answer): the installer says the new version runs from the
  next start. Install still succeeds (exit 0).
- **Fix found by the end-to-end test.** Clicking Apply now for the control page server's own update could never work:
  the swap's hand-over waits for every request in flight on the front, the click's own request included, so it always
  ended `kept-old` after 10 s. The UI server now answers that click first (202, `started`, plain words) and starts the
  swap once the answer has gone out; the page reconnects to the new server, which starts its event stream with the
  whole state. Other parts answer with the result as before.
Limits: the hand-over waits at most 10 minutes for the running launcher (a host replacement when nothing is live is
part of it). A top-level file that was kept is replaced only by an install while Ujwalam is closed. The end-to-end test
uses the fake host (a recording as the "live" output), not a real loopback stream: the real host's encoders are not
touched by any service swap (LU3, LU4 evidence), and the host part is only staged. Evidence:
`docs/evidence/2026-11-11-lu6-live-install.md`.
Codex review fixes (same day, 2 P2):
- **Path forms.** A command line may name the install with forward slashes (`C:/.../Ujwalam/<ver>/...`) or repeated
  separators; such a launcher was missed, and `-Force` could then rename its active folder. Paths and command lines are
  normalised (`/` read as ``, repeated separators as one) before the case-insensitive match, in both the running check
  and the in-use check.
- **Kept only when certain; current.txt last.** Every copy failure counted as "in use", so disk full, access denied or
  a missing launcher ended with exit 0 after current.txt had changed. Now a top-level file is kept only when a running
  program is or names it, or Windows reports a sharing or lock violation (32, 33; also when reading it for the hash).
  Any other failure, and a build without `Ujwalam.cmd` or `ujwalam-start.exe`, stops with exit 10. The top-level files
  are written before current.txt and previous.txt, so a failed install leaves them on the version that worked. A
  replacement is copied to `<file>.<pid>.new` in the same folder and swapped in with one File.Replace (a new file: one
  move); the temp file is removed on failure.
  Limit: an 8.3 short path on a command line (`C:UsersABCDEF~1...`) is not matched.

## D350 — Reel length: every montage and concatenated reel is at most 60 s, longer ones split into parts (2026-11-11, CL1)

User, 2026-11-11: "all montages and concatenated clips length cannot exceed 1 minute for now, if it gets more than 1 minute
split it into after. add the settings to customise clip length for different type of reels in-app." Decided:
- **Types and defaults (data).** `data/clip/reel-length.json`: kill montage (min 20, max 60), match reel (min 0, max 60),
  impact-play reel (min 10, max 60), short clip (min 10, max 60), live clip (min 20, max 60). The minimums are the values
  the code already used (`montage.json` minSec, `ranking.json` clip.minSec, the impact-play spec minSec, `live-clips.json`
  minClipSec); the match reel had none. `limitMaxSec` = 60 is the upper bound of every maximum.
- **Bound may be raised later.** 60 s is "for now" (the user's words). Raising it for long videos is one number
  (`limitMaxSec`) in that file, plus the maximums the user then sets; the Shorts line in `data/posting/limits.json` is a
  separate platform fact and not touched.
- **Split.** Montages, match reels and impact-play reels (the concatenated outputs): `services/clip/reel_length.py`
  `split_reel`. A part boundary is only between two pieces (a cut around one kill or a run of close kills, or the result
  screen), never inside one. Parts: ids `M01p1`, `M01p2`, files `..._kills-12-part-1-of-2_...`, labels "part N of M". A
  last part under the type's minimum takes pieces from the part before while that stays at or above the minimum;
  otherwise it is kept (no content dropped) and marked `belowMin`.
- **Trim.** A single piece longer than the maximum is cut to the maximum around its peak (the kill times for montages and
  match reels, the impact play for impact-play reels; the piece's middle when no peak is known) and the trim (from, to,
  peak, seconds dropped) is written in render.json and match-reels.json. This replaces the old "best window" cut of a
  long streak group in the montage planner, which dropped kills: a long group is now kept and split.
- **Posting.** Each part is a finished video with its own uploads.json row (kind unchanged, label with the part), so the
  auto-post chain packages and posts every part as its own reel (a Short at 60 s or less). Nothing in posting changed.
- **Settings.** Settings > Clips > REEL LENGTH (Qt studio): shortest and longest per type in whole seconds, Reset to
  defaults, Save changes / Discard like every page; a shortest above its longest or a longest above the bound is refused
  (page and server). Stored as `settings.json clips.reelLengths` (only types that differ from the default). Short clips
  and live clips use their minimum and maximum too (live: a window over the maximum is cut around the strongest medal).
  There is no Clips page on the control page, so no control-page equivalent.
- **No feature flag** (user-ordered cap). The old behaviour is reachable by raising a maximum up to 60 s.
- UNVERIFIED: a real recording rendered into parts (headless tests use synthetic pieces); the picture of the new group at
  real DPI.

## D354 — The default shortcut is the LIVE start (user, 2026-11-11)

The user could not stream from "Ujwalam (alpha)", which was the practice start (D281), and asked: "make the live shortcut the default". The installer now makes "Ujwalam (alpha)" with `--live --allow-devices` (stream targets set up; going live still needs a Start stream click and the readiness check) and "Ujwalam (alpha, practice)" with `--allow-devices` only. It removes the old "Ujwalam (alpha, LIVE)" shortcut. The studio's disabled-button tooltip names the new shortcut. The installed shortcuts were switched by hand on 2026-11-11, so this applies before the next build. Tests: package-alpha 18/18 (shortcut arguments read back through the shell).
## D351 — Instagram Live output: a V-canvas sink with a URL and key pasted per broadcast (2026-11-11, IG1)

Plan row IG1 (`docs/plan/` growth and Instagram plan, 2026-11-11). Flag `instagram-live`, off by default. Decided:
- **Limits as data.** `data/platforms/instagram.json`, from Instagram's own Live Producer page (published 2022-11-02,
  re-read 2026-11-11): 720x1280 9:16 recommended, 30 fps, video 2,250-6,000 Kbps, audio 44.1 kHz stereo up to 256 Kbps,
  key refreshed on each use. All recommendations, so warnings. Codec (H.264), AAC, keyframe interval (2 s), RTMP vs
  RTMPS, one audio track, CBR and the 4 h limit are not on the page: UNVERIFIED warnings. The schema gains optional
  `maxDurationSec`; `about.instagram.com` and `help.instagram.com` count as official sources.
- **Sink from V, never its own encoder.** The add-on (`data/outputs/addons/instagram-live.json`, outside the presets
  folder) adds sink `instagram` (priority 7, lowest). `services/outputs/instagram.mjs` reuses a V rung only if the
  validator reports nothing but UNVERIFIED_LIMIT / NOT_RECOMMENDED for it; the preset V rung (1080x1920, 7,500 kbps)
  does not fit, so one rung `ig-v` 720x1280@30 4,000 kbps CBR, 2 s GOP is added, GPU-scaled from V (fps lowered to a
  divisor of the canvas fps if needed; encoder and options copied from the plan's V rung). NVENC sessions stay probed
  by the host at configure. Audio is the plan's one shared track (48 kHz AAC 160 kbps, encoded once): the 44.1 kHz
  recommendation gives a NOT_RECOMMENDED warning, not a second encode.
- **Plan file.** With the flag on, the launcher writes `<data>/outputs/live-plan-instagram.json` (the plan in effect
  plus the sink and its target) and starts from it. Target: transport `auto`, `serverRef Ujwalam/stream/instagram-server`,
  `keyRef Ujwalam/stream/instagram`; the scheme follows the pasted URL.
- **Flag is start-only.** The flag is read at start and latched with the launched plan: switching it applies from the
  next start, never mid-stream. Switching Instagram on while live would add an encoder to the running graph, which the
  live-path rule does not allow; so this flag is an exception to "switchable from the control page while live". The
  user is being asked to confirm this exception (UNCONFIRMED until they answer). The launcher passes `--instagram-live`
  to the UI server when the configured plan has the instagram sink; readiness and key tracking follow that, not the
  flag's current value. The flag list marks a flag that differs from the running plan as "applies at next start"
  (Codex review).
- **Key per broadcast.** Pasted in Settings > Connections or the new Instagram box on the control page (needs
  `platform-connect`); both URL and key are required together; only Credential Manager holds them; only the last 4
  characters are shown. `<data>/outputs/instagram-key.json` keeps times only (`savedAt`, `startedAt`, `usedAt`), never
  a key, URL, hash or other derivative. Any start attempt counts as consuming the key: the UI server writes
  `startedAt` before it sends a Start that includes the instagram sink, and the status reconciliation (each poll,
  right before the readiness check, and at studio start) also sets it when the sink runs or its host start count
  (`attempts`) has grown, so a broadcast shorter than a poll or a start by another path is seen. Started and then seen
  not running (stop, failure, or the next studio start after a crash) sets `usedAt`; a start on its way is not judged.
  Pasting the key already stored keeps the state (a used key stays used): the stored key is read from Credential
  Manager and compared in memory in constant time (HMAC with a one-time random key, `timingSafeEqual`) before it is
  overwritten (Codex review). A key with `usedAt >= savedAt`, or never pasted through Ujwalam, fails readiness with
  the plain fix text (open Live Producer, copy the new URL and key, paste both). A `?` in the Instagram key is allowed
  (other platforms still warn).
- **Loopback first.** `app/host/tests/host-instagram-loopback.test.mjs` streams the instagram sink to a local ffmpeg
  RTMP listener and checks it with ffprobe against the platform file. No real Instagram test until the user says
  "start stream test".
- Left out: the Qt Settings > Connections page is unchanged (its generic rows show Instagram; a used key shows as not
  connected with the reason). No Instagram API is used (none starts a live).

## D355 — Studio UI moves to Qt Quick (QML), one agent, step by step (user, 2026-11-11)

- The user chose option 2 of the UI audit (Qt Quick), with no multi-agent work, much faster than 6–10 weeks, and no
  loss of quality. Plan: `docs/plan/2026-11-11-qml-studio-plan.md` (Q1 models, Q2 main window, Q3 settings, Q4 other
  screens, Q5 web page on the studio theme, Q6 switch after a real stream). Approved by the user on 2026-11-11.
- The QML studio ships behind the flag `studio-qml` (off by default). The widget studio stays the default until the
  parity checklist passes and a real stream has no high-severity feedback.

## D356 — The Instagram output flag applies at stream start only (user, 2026-11-11)

- An exception to "switchable while live": adding or removing the instagram sink means restarting the encoders, so
  `instagram-live` is read when a stream starts, and the control page shows "applies at next start" when it differs.
  Accepted by the user on 2026-11-11.
## D352 — Payoff-first reel hook: every reel opens on its strongest moment in the first 1–3 s (2026-11-11, ED1)

Growth plan ED1 (`docs/plan/2026-11-11-growth-content-instagram-plan.md`). Decided:
- **Where.** Kill montages, match reels, impact-play reels and live clips. Short clips are one moment already and are
  not changed. Core function `registry/functions/reel-hook.json` (format `post-render`, added to the function schema
  enum: a step on the reel plan before the render, with no layer), presets `reel-hook-payoff-first` (2 s teaser) and
  `reel-hook-quick-tease` (1 s), similar to each other. Data: `data/clip/reel-hook.json`; code
  `services/clip/reel_hook.py`, wired in `services/clip/clipper.py`.
- **Strategy per type (data, with the reason in the file).** Montage: **reorder**. Its pieces are separate kill runs, so
  moving the strongest run to the front keeps the order of the rest and adds no length; a teaser is added only when the
  peak is deeper than the window inside that piece and the teaser fits the cap. Match reel, impact-play reel, live clip:
  **teaser**. Each is one story in time order (a match, the lead-up to the play, the moments around a save), so a
  reorder would break it; a 1–3 s teaser of the peak plays first, then the reel from its start. The choice used
  (`already`, `reorder`, `reorder+teaser`, `teaser`, `none`) and its reason are in the reel row (`hook`).
- **Strongest moment.** The peak with the most kills in the window before it plus the medal weights in the window after
  it (multi-kill and streak medals from the existing medal reader; the impact-play medal is not a kill).
- **Hard rules.** The total, teaser included, stays within the D350 maximum: a teaser reel is split at maximum − teaser,
  so every part keeps room; a reorder adds nothing. A teaser never starts or ends on a death span (`rank.death_spans`);
  when every candidate overlaps a death the reel opens as before (`none`, reason recorded). CL1 split still holds and
  every part gets its own hook (parts keep their own peaks and medals, fixed in `reel_length.split_reel`/`trim`).
- **Hook score for AN2.** `hook.score` in render.json, match-reels.json and candidates.json rows, for every reel (hook on
  or off, so there is a baseline): kill in the first 3 s (.35), multi-kill (.25), medal (.2), motion (.2) where motion is
  the mean signalstats YDIF of the first 3 s of the rendered file above 3.0. Weights proposed, threshold UNVERIFIED on
  real footage.
- **Settings.** Settings > Clips > REEL OPENING (Qt studio): per type "Open with the best moment" (switch with visible
  text) and the teaser length 1–3 s, Reset to defaults, Save/Discard. Stored as `settings.json clips.reelHooks` (only
  changed types). Checked the same in Python and the studio server.
- **Flag** `reel-hook`, off by default (data/flags.json). Off: reels render exactly as before; only the score is added.
- UNVERIFIED: real recordings rendered with a hook; the motion threshold; the picture of the group at real DPI.

## D353 — Burned-in reel captions from local speech to text, confidence-gated, original script (2026-11-11, ED2)

Growth plan ED2. Decided:
- **Speech to text.** The existing local backends in `services/clip/clip_captions.py` (faster-whisper default, model
  `faster-whisper-small`; whisper.cpp optional). Task is `transcribe` (never `translate`), language auto-detected
  (`multilingual`), so the original script is kept; nothing is transliterated. Per-segment confidence:
  faster-whisper exp(avg_logprob) × (1 − no_speech_prob); whisper.cpp the mean token probability (`-ojf`).
- **Gate (data).** `data/clip/reel-captions.json`: `minConfidence` 0.55 (UNVERIFIED, proposed), `minSegmentSec` 0.3.
  Segments below it, without a confidence, or too short are kept in the transcript but hidden.
- **Font.** Bundled OFL fonts only (`data/fonts`, licences in `docs/licence-headers.md`); never a Microsoft font. The
  preset names the file; libass loads it from a `fonts` folder next to the render (`fontsdir`), so no system font is used.
  **No bundled font covers Malayalam** (Inter, Barlow, Exo 2 have no Malayalam glyphs; checked with a cmap reader that
  matches fontTools). Malayalam (and any script the font lacks) stays in the transcript, marked `fontMissing`, and is not
  burned, so there is no tofu and no fallback to a system font. A Malayalam OFL font is an install for the user to approve.
- **Placement.** Inside the V safe zone (intersection of the platform safe areas in `data/platforms`): margins left 65,
  right 140, bottom 670 on 1080×1920; cards of at most 3 words, 2 lines.
- **Editable transcript.** `transcript.json` next to the reel (segments with text, start, end, confidence, show, reason).
  `clipper.py recaption --id <reel>` re-renders from the stored pieces with the edited transcript and replaces published
  copies listed in published.json. An edited segment the user un-hides is burned.
- **Core function** `registry/functions/reel-captions.json` (format `post-render`) with presets `reel-captions-bold`
  (Inter Bold 72 px) and `reel-captions-barlow` (Barlow Bold 80 px), similar.
- **Flag** `reel-captions`, off by default.
- Not changed: the short-clip caption path (`clip_captions.to_ass`) still names "Arial" (a Microsoft font, resolved by
  libass from the system). Reported, not changed here.
- UNVERIFIED: caption quality and confidence on real stream audio, Malayalam/Manglish speech to text, whisper.cpp `-ojf`
  with a real binary, recaption of a live clip after its replay save was dropped (`--drop-used-saves` deletes the source).

## D357 — Preview overlays draw through libobs's persistent immediate buffer, never a throw-away one (2026-11-11, host crash)

- **Crash.** The host crashed (0xC0000005 in d3d11 `device_draw`, under `blur_render` / `wrap_render` in effects.cpp)
  when a shadow was switched on for a layer while that layer was selected in a preview. Same address and stack as the
  2026-11-10 crash; both logs show "This vertex shader requires a point buffer" in the seconds before.
- **Cause.** `preview.cpp` `solid_pass` (selection box, snap guides) used `gs_render_start(true)` + `gs_render_stop`.
  In libobs 32.1.2 that makes a vertex buffer, draws it and destroys it; the d3d11 `gs_vertexbuffer_destroy` clears
  only `lastVertexBuffer`, so `curVertexBuffer` still points at freed memory. A later draw that changes the vertex
  shader without loading its own buffer builds its input from that freed buffer.
- **Fix.** `gs_render_start(false)` (the persistent immediate buffer, 512 vertices; a quad that would pass the limit is
  left out, a selection box uses 60), and `gs_load_vertexbuffer(nullptr)` after each pass so nothing of ours stays
  loaded. Rule: host drawing code never uses `gs_render_start(true)`.
- **Test.** `host-preview-edit.test.mjs` "crash 2026-11-11": an embedded headless preview with the box selected, the
  effects switched five times (shadow, none, blur + shadow, shadow, none); the selection box is drawn (counter in
  `preview.list` `selectionDraws`), the host stays up, no "point buffer" line. The old build did not crash in the same
  test (freed memory is not always reused), so the test guards the draw path; the cause rests on the libobs source.

## D358 — Mixer volume, mute and CUE are saved in the project (user report, 2026-11-11)

- **Report.** The Game channel's volume, lowered in the mixer, was back at full after a restart.
- **Cause.** Only track routing (D273) was written back to the project file. `mixer.setVolume`, `mixer.setMute` and
  `mixer.setCue` changed the host only; the next start loaded `audio.sources[].volumeDb` 0, `muted` and `monitoring`
  from the file again. D222 had left CUE live-only on purpose; volume and mute were simply never saved.
- **Change.** The host answers these three calls with the project audio source (`audioSource`) and the value it
  applied (`volumeDb`, -100 for silence; `muted`; `monitoring`). The UI server's project sync saves them into that
  audio source (debounced, the same path as the layer edits). Supersedes D222's "CUE state is live-only".
- **Limit.** A mixer channel with no `audio.sources` entry (layer sound without a project audio source) stays
  live-only, as for track routing. Game and Mic in the alpha project have entries.

## D359 — Live clipping keeps its replay saves and the after-stream recording pass (user, 2026-11-11)

- **Question.** While live, the stream, the H and V recordings and the replay buffers share the three stream encoders
  (no double encoding). Two things repeat: each live save writes the last 60 s of H and V again (also in the
  recordings; deleted after the clip job used them), and the after-stream job runs detection over the whole H
  recording to find match edges, after the live clipper already read the game once a second.
- **Decision.** Kept as they are (user: "if the current setup works better - keep it that way, results are
  important"). The replay saves hold a moment even when no recording runs or the recording fails; the full-rate
  recording pass finds match edges more reliably than the 1-per-second live reads. Neither touches the live stream
  (saves are muxing only; the recording pass runs after every stream stopped, below normal priority).
- **Not built.** Marker-only saves while a recording runs; live match edges replacing the recording pass.

## D360 — The QML studio calls the UI server routes directly; no model extraction first (2026-11-11, plan Q1)

- **Change to the plan.** Q1 was to move the logic out of `main_window.cpp` into shared `QObject` models first. The
  widget studio's logic is mostly the order of its UI server calls and the rules around them (merge scenes by id,
  layer arguments per canvas, held actions, preview selection), not state machines. Moving it would touch the
  widget studio (the default, and the live path) for no gain to the user.
- **Decision.** The QML screens call the same UI server routes through the same `ApiClient` (bridge `QmlApi`), and
  keep the same rules in one QML state object (`app/studio/qml/Store.qml`), each rule commented with the widget
  function it mirrors. The widget studio is not changed. Q1 becomes the bridge: `QmlApi`, `QmlTheme` (theme packs
  through `theme.h`), the icon provider (`icons.h`), `PreviewView` (the host's preview in a native child window of
  the QML window).
- **One exe.** `ujwalam-studio.exe` holds both windows; `UJWALAM_STUDIO_QML=1` (set by the launcher while flag
  `studio-qml` is on) opens the QML one. The launcher's lines, swap close (exit 75), hidden and probe modes are the
  same. The exe now links Qt Quick, so the package ships the Qt Quick DLLs and imports for both windows.
- **On-air bar data.** The status snapshot gains `host.onAir` (stream and recording time, summed stream bitrate, per
  stream sink platform, state and bitrate), read from `outputs.status` only while something runs. Numbers and short
  ids only.
- **Close.** With tasks running and not live, the QML window asks: stop them and close, or do not close. Keeping them
  in the tray comes with Q4.

## D361 — Montage story structure: fast cut, title, one match as a story (user, 2026-11-11 evening)

- **User's words.** "before the title intro can be fast cut of kills from any matches, after title try to create a continuity like story and if not enough can use from other match as well, but don't re use that section in other videos if possible."
- **Decision.** Replaces "pieces of different matches may be joined" (2026-11-07/08) for the body of a montage: part 1 (before the title) is a short fast cut from any match (the D352 hook); part 2 is one match in time order, topped up from other matches of the session only when it has too few kills; a used section is recorded and not reused in another video when there is another choice. No result screen of another match inside a montage. Plan RP2 in `2026-11-12-reel-polish-music-learning.md`.

## D362 — Reel title card over a blurred background, music fading with it (user, 2026-11-11 evening)

- **Decision.** The streamer title (from the local profile, never committed) fades in and out over a blurred copy of the video, about 1.2–1.8 s; the music bed fades out as the title ends; the reel's end gets a few seconds of music fade. Flag `reel-title`, off by default. Plan RP4.

## D363 — Reel music from a local AI model, chosen after a licence and fit check (user, 2026-11-11 evening)

- **Decision.** The user chose a local AI music model over a built-in synthesizer. Before any install the agent reports the candidates (licence for monetised posting, disk, VRAM at 6 GB, speed, Windows wheels) and the user approves the pick and the install. Runs only after a stream, one model at a time. Plan RP3, RP3a.

## D364 — Self-learning applies changes on its own, inside limits the user approves (user, 2026-11-11 evening)

- **Decision.** Changes AN2 ("proposals only, never applies itself") to "auto within limits": the learning loop shifts the mix of reel kinds and edit choices toward what performs better, with a minimum share per kind, at most 15 points of change per week, every change logged with its numbers, a one-click undo and a weekly report. Kill rules, detector weights, privacy and posting targets stay changes the user approves. Plan RP5; waits for AN1 and auto-posting.

## D365 — BR kills from the own HUD text, knocks shown, a 30 s BR chain gap; live clips re-cut after the stream (agent, 2026-11-12, proposed)

- **Decision.** Fix for the user's report on the 2026-11-11 Battle Royale short (triage F2, plan CL2). Montage settings (`data/clip/montage.json`): the own-kill HUD text B2 "ELIMINATED" counts as an own kill (the BR kill feed B1 cannot read the own name in the V cutout), B2 "KNOCKED DOWN" is an action (shown in the cut, not counted as a kill), and kills in Battle Royale chain over up to 30 s (12 s stays for every other mode). After the stream, each live clip is re-cut from the recording's detector hits: every kill and knock of the chain its medal belongs to, the dead time between them cut, padded to the 20 s minimum from the build-up before the first kill; a chain seen by two clips goes to the clip whose save file holds most of it, and the other clip joins it.
- **Why.** The live window starts 17 s before the medal; in BR the medal's kills spanned 27 s, so the earlier kills were outside and 13 s of running stayed inside.
- **Status.** Values proposed from one session's footage (evidence `docs/evidence/2026-11-12-cl2-br-short-recut.md`); the user approves them after watching the re-cut.

## D366 — Each reel opens on one edited thumbnail frame, made locally (user, 2026-11-12)

- **Decision.** Every reel (short, montage, match reel) starts with one frame that acts as its thumbnail and is edited to show what the reel is about: the strongest moment of the reel as the picture, a short title from the reel's own facts (kind, kill count, medal), cleanly cropped for the platform frame. Made on the laptop only (ffmpeg plus the existing local OCR/detector data; no cloud service, no paid API). Plan RP6.
- **Why.** The user: "for each reel, there needs be a start frame which will need to act as the thumbnail, just 1 frame, this should be edited in a way to showcase what's the reel is about".

## D367 — Reel transitions: Cut or a 250 ms cross fade, captions keep the cut (agent, 2026-11-12)

- **Decision.** The join between the pieces of a reel is a setting (Settings > Clips, `clips.reelTransition`): Cut, or Cross fade (ffmpeg `xfade=fade` with `acrossfade`), default 250 ms, range 150–500 ms, never more than half the shortest piece. A reel with burned-in captions keeps the cut for now (the caption times follow the sum of the pieces). Behind flag `reel-transitions`, off by default. Plan RP1.
- **Why.** The user asked for a subtle cross fade as the first transition (2026-11-11); 250 ms is short enough to stay subtle and long enough to see. Each join makes the reel shorter by the overlap, which is recorded (`end`, `belowMin`).
- **Status.** Length proposed; evidence `docs/evidence/2026-11-12-rp1-reel-transitions.md`; the user confirms after watching reels made with the flag on.

## D368 — Reel start frame as thumbnail (RP6, 2026-11-12)

- **Decision.** Flag `reel-thumbnail` is ON by default (the user asked, 2026-11-12; it can be switched off in Settings > Advanced). Every reel opens on one edited frame (1/60 s) that acts as its cover: the picture of the reel's strongest moment (0.4 s after the heaviest medal, else the densest kills), colour lifted, a title (medal or result, kill count, mode) and the streamer brand from the local profile, all made locally with ffmpeg and a bundled font. Posting takes the cover from frame 0.
- **Why.** The user asked (2026-11-12) for a one-frame thumbnail per reel showing what the reel is about, processed locally.
- **Status.** Look, sizes, position and wording proposed (`data/clip/thumbnail.json`); evidence `docs/evidence/2026-11-12-rp6-thumbnail-start-frame.md`; the user confirms after watching reels made with the flag on.

## D369 — Reel title card (RP4, 2026-11-12)

- **Decision.** Behind flag `reel-title` (off), a reel shows the streamer title (the brand from the local profile) for 1.6 s right after its teaser (part 1 of a montage, the payoff-first hook of other reels), else at its start: a Gaussian-blurred copy of the reel, darkened to 55 %, with the title centred in the safe width, fading in over 450 ms and out over 350 ms (overlay rule). It is drawn inside the reel's own ffmpeg render; the length does not change; captions stay on top; Captions again keeps it. No brand in the profile, or a reel under 4 s: no title. Silent until RP3 adds the music bed.
- **Why.** The user asked (2026-11-11) for a streamer title fade over a blurred background after the fast-cut part of a montage. `boxblur` is not in the LGPL ffmpeg build, so the blur is `gblur`.
- **Status.** Durations, blur, darkness, size and position proposed (`data/clip/title.json`); evidence `docs/evidence/2026-11-12-rp4-title-card.md`; the user confirms after watching reels made with the flag on.

## D370 — Reel music beds: procedural first, ACE-Step later (RP3, 2026-11-12)

- **Decision.** Behind flag `reel-music` (off), a calm lofi bed plays under the start of a reel (ending with the RP4 title, else after 3 s) and its last 4 s. It is synthesised on this PC in plain Python (no model, no download), seeded per reel, at −20 dBFS peak, mixed under audio track 1 only, ducked by the game sound with a sidechain compressor; the length never changes. ACE-Step 1.5 (MIT weights, commercial use allowed per its model card) is the first AI generator to add later, after the user approves its install (Python 3.12 venv) and a benchmark here. MusicGen is ruled out (CC-BY-NC weights).
- **Why.** The user chose "procedural now, ACE-Step later" (2026-11-12) after the RP3a comparison; beds made by own code carry no licence risk on monetised channels and need no install.
- **Status.** Sound and levels proposed (`data/clip/music.json`); evidence `docs/evidence/2026-11-12-rp3-music-beds.md`; the user confirms after listening to reels made with the flag on.

## D371 — Growth data from YouTube, read only, local (AN1a, 2026-11-12)

- **Decision.** Behind flag `growth` (off), Ujwalam reads the user's own numbers for the videos it posted: the Data API (public state, views, likes, comments; `youtube.readonly`) and the Analytics API (minutes watched, average view duration and viewed %, likes, shares, subscribers gained; `yt-analytics.readonly`). The scopes are asked for only with the flag on, by both sign-in paths; a fetch fails closed without them. Numbers go to a local SQLite file `<data>/analytics/analytics.db` as snapshots with their age since the video went public; 24 h and 7 d are read from the first snapshot at or past that age. At most one fetch an hour unless forced. Nothing is posted or changed.
- **Why.** The user said yes to analytics (2026-11-11); RP5's learning needs results per posted reel (D364). Both scopes are read only; the data stays on the PC.
- **Status.** Built and tested with a faked Google; waiting for the user's Google setup and a real fetch. Evidence `docs/evidence/2026-11-12-an1a-growth-youtube-data.md`.

## D372 — Growth numbers window in the studio (AN1b, 2026-11-12)

- **Decision.** Behind the same flag `growth` (off), the Qt studio has a "Growth numbers..." window in the More menu (shown only with the flag on). It lists each posted video with its title, kind (montage, won-round reel, impact play, clip), time it went public, latest views, likes, average viewed %, shares and subscribers gained, and the 24 hour and 7 day checkpoints, in a sortable table. The studio reads through the Studio UI server (`GET /ui/api/growth`), which owns `analytics.db` (one SQLite owner per process); `POST /ui/api/growth/refresh` runs the AN1a collect (once an hour unless `force`; a second "Refresh now" button forces). Both fail closed with 404 `growth-off`. Not signed in, missing statistics permission and nothing posted each show a plain note pointing to Settings > Posting & growth and the setup notes. Read only: nothing is posted or changed on YouTube; the window is never needed while live or recording. No charts and no Instagram in this step.
- **Why.** AN1 asks for a Growth section as its own window; the numbers are what AN2's learning loop will use.
- **Status.** Built and tested with a seeded store and a faked Google; a real fetch stays UNVERIFIED until the user's Google setup is done. Evidence `docs/evidence/2026-11-12-an1b-growth-window.md`.

## D373 — Self-learning mix: Thompson sampling over reel choices, inside data-file limits (RP5 / AN2, 2026-11-13, agent, proposed)

- **Decision.** Behind flag `self-learning` (off), on top of `growth`, Ujwalam learns a mix of reel choices from the AN1 numbers and applies it on its own inside the D364 limits. Choices: reel kind (short, montage, won-reel, impact-play), montage length band (short < 30 s, mid 30-45 s, long >= 45 s), transition (cut, fade), title card (off, on), music bed (off, on), posting time (night, morning, afternoon, evening, local time the video went public). Each posted video is linked to the choices it was made with: `clipper.py publish` writes `choices` on each reel row of `uploads.json` (from the render record), packaging copies it into `post.json` `source.choices`, the learner joins the analytics rows to the posts by post id. Older posts without the record count only for kind, length and time.
- **Reward (per video, 0..1).** `r = 0.5 * min(avgViewedPct, 150) / 150 + 0.5 * views / (views + median views of the same platform at the same checkpoint)`, from the 7 day checkpoint when it has statistics, else the 24 hour one; a missing part counts as 0.5. Weights, cap and checkpoint rule in `data/clip/learning-mix.json` (`reward`). No number is invented: a video without a statistics checkpoint is left out.
- **Bandit.** Per choice Beta(1 + sum r, 1 + sum (1 - r)); the target share of a choice is how often its draw is highest in 4000 seeded draws (seed per week). The limits then apply (`data/clip/learning-mix.json` `limits`, D364 defaults): every choice keeps at least 10 %, a share moves at most 15 points, at most one change per 7 days; kill rules, detector weights, privacy, posting targets and daily caps, and feature flags never change.
- **Where it acts.** Montage planner (`services/clip/learning_mix.py`): per reel the transition, title card and music bed are drawn from the shares (seeded by reel id, recording and mix time) and can only be switched OFF for a reel, never on (a feature whose own flag or setting is off stays off); one length band per run sets the montage target length inside the user's min and max. Auto-post (`planAuto` `kindShares`): only the order inside each rule's daily cap follows the kind shares; the count and targets do not change. Posting time is learned and reported only; the publish schedule (D310, D314) is not changed.
- **Cold start.** Fewer than 8 posted videos with a statistics checkpoint: nothing changes, nothing is written, and the view and report say "N of 8 posted videos have their 24 hour numbers". A choice with fewer than 4 known videos keeps its shares. Before the first change, and after undoing it, the mix is not in use (`applied: false`) and planner and auto-post behave exactly as before.
- **Log and undo.** `<data>/learning/mix.json` (the mix in use) and `<data>/learning/mix-log.jsonl` (each change with the shares before and after, per-choice count, mean reward, Beta parameters and win probability, video count, formula and limits) in the app data, never committed. Undo = one call (`POST /ui/api/growth/mix/undo`, or `node services/learning/mix-cli.mjs undo`) restores the mix before the newest change still in effect. The weekly change runs after a successful Growth refresh (`POST /ui/api/growth/refresh`) or `mix-cli.mjs step`; `mix-cli.mjs report` prints the weekly report in plain English; `GET /ui/api/growth/mix` returns the mix, log and report text.
- **Review fixes (Codex, 2026-11-13).** The floor and the weekly cap hold together; when they cannot (a share below the floor by more than one step), that choice keeps its shares and the log says so. The state file is written first (temp + rename) and carries the log entry, so a failed log append is repaired on the next step or undo and a failed state write logs nothing (no lost undo). A record cut off by a failed append is dropped on read and the next append starts on a new line. Undo restores the earlier `changedAt`, so the planner's seeded picks are those of before. Only the last 64 KiB of the log are read.
- **Why.** D364 asked for auto-within-limits learning; Thompson sampling explores without a hand-tuned rate, the floor keeps every choice measurable, and the cap keeps a week of noise from swinging the output.
- **Status.** Proposed: the formula, cap of 150 %, minimum 8 videos, bands and draws are agent values. Tested with faked analytics only; no real YouTube numbers exist yet (the user's Google setup is pending). Evidence `docs/evidence/2026-11-13-rp5-self-learning.md`.

## D374 — Host watchdog: a frozen host is stopped and restarted; GPU device-loss and driver-reset report (2026-11-13)

- **Decision.**
  - The host reports graphics stalls and GPU device losses. It never restarts itself. The report lives in `gfx_watch.h`, `host.status.graphics` and the lock-free `host.alive`.
  - The launcher asks `host.alive` every 5 s. It calls the host stale after 30 s with no answer, or after 30 s with no video frame.
  - A stale host is always logged once. With flag `host-watchdog` on (off by default), the launcher kills the host's process tree. The existing crash path then restarts it: the same restart policy, project reload, and recording in a new file.
  - Once per incident, the launcher writes one task-bar entry and reads the Windows System log for an NVIDIA driver reset ("the graphics driver reset at HH:MM").
  - All numbers are in `data/live/host-watch.json` (status proposed).
- **Streams.** The watchdog never starts a stream itself. After its restart, the streams that were live come back only through the D303 stream-recovery rules: flag `stream-recovery`, this launcher's go-live authority, and the `data/live/recovery.json` gap limit. This counts as recovery of the user's own live session, not going live on its own:
  - The user had clicked Start for exactly those sinks.
  - The freeze, not the user, ended them.
  - With either flag off, nothing is restarted.
  - A stream that was not live is never started.
- **Why.**
  - On 2026-11-12 the graphics thread froze for about 3 hours unnoticed (19:03).
  - During a live stream the NVIDIA driver reset (21:42). The host crashed and stayed down until a manual restart at 22:00.
  - libobs rebuilds its D3D11 device only from `Present` with a preview swap chain. It never rebuilds encoders, and calls bcrash if the rebuild fails. A whole-host restart is therefore the reliable recovery.
- **Status.** Built; tested with a fake host and with a real host using a simulated stall. A real driver reset is UNVERIFIED. Evidence `docs/evidence/2026-11-13-gpu-reset-recovery.md`.
- **Review fixes (Codex, 2026-11-13).**
  - All elapsed times use a monotonic clock.
  - The liveness window starts when a restore has finished, not when the host starts.
  - In the host, `host.alive` reads atomics only; the checker logs without holding a lock.
  - The stall report is read as one consistent snapshot: a single-writer seqlock, still lock-free for `host.alive`. A stress test showed 0 torn reads (re-review). A read that runs out of retries reports `"snapshot": "busy"` with no stall fields, never mixed values.
  - The task-bar write is retried when the file is open elsewhere, and an older state never overwrites a newer one.

## D376 — Soft theme and ClearType text in the Qt studio (2026-11-13, agent)

- **Why.** The user said the themes look dated and the text does not look like ClearType, and asked for a redesign
  after a reference picture: soft raised plates, gentle shadows, a warm amber glow for what is on.
- **ClearType finding.** The studio already renders ClearType on screen (Qt DirectWrite follows the Windows setting).
  The offscreen test platform renders greyscale, so probe screenshots are no evidence of text quality; use the hidden
  native probe or the real screen. What looked soft is the bundled web fonts with default hinting at 9–10 pt.
- **Soft pack** (`data/themes/soft.json`):
  - Font Segoe UI, a Windows system font used at runtime only (no Microsoft font file is bundled).
  - New `typography.hinting` (`default | full | vertical | none`); Soft uses `full` (`QFont::PreferFullHinting`).
  - New `componentsAlways`: a pack built only from components uses its components block with flag `theme-components`
    off. The flag stays off by default; other packs are unchanged.
  - New `surface` block (faces, edges, wells, warm and glow colours, shadow layers, radii, room for the shadow),
    read only with the `soft` card variant. New variants: button `raised`, input `soft`, switch `knob`, card `soft`.
- **Painting.** `app/studio/src/soft.cpp` paints cards, small cards, rows with a switch, pills and round controls
  from an event filter behind the widget's own paint. No `QGraphicsEffect`: text always lands on an opaque face.
  Shadows are blurred once per kind, radius, tone and device pixel ratio and drawn as 9-slice pictures. Hover and press
  fade in the theme's fast time (≤ 150 ms). Reduced effects: no shadows; High performance: flat faces.
- **Appearance.** Soft is listed first. The default stays Violet Night: a new look is off until the user picks it.
- **Status.** Built and tested headless and with the hidden native probe; one real on-screen capture. Other display
  scales and a machine with ClearType off are UNVERIFIED. Evidence `docs/evidence/2026-11-13-soft-theme-cleartype.md`.

## D375 — Auto-post goes up scheduled, around the channel's own schedule, from the clips folder (2026-11-13, user request; agent values proposed)

- **Decision.** Every automatic YouTube upload goes up as a scheduled post (private with `status.publishAt`; YouTube Studio shows "Scheduled"). An automatic upload without a publish time never happens: with flag `post-schedule` off, or no free slot, the clip waits (`schedule-off`, `schedule-beyond-cap`, ...). `node services/posting/cli.mjs auto --run` no longer uploads; the chain does. User 2026-11-13: "upload the post as scheduled (not as private) ... check the already scheduled posts in youtube and schedule the posts according to work around the existing schedule. don't double post at the same time", then "build a posting schedule every one hour for the next 2 months", "use ~6/day and request more", "the schedule of posting should be able to be customised from within Ujwalam itself".
- **Slot rule (placement `fill-gaps`, default).** floor = now + minLeadHours + marginMinutes, rounded up to the `alignMinutes` grid (60 = whole hours, UTC). Taken times = every future scheduled post on the channel, channel videos that went public in the last 2 days, every time in the upload queue (uploaded, open session, failed, queued) and every slot given earlier in the same pass. A clip gets the earliest grid time >= floor that is at least `intervalHours` from every taken time; past `maxAheadDays` it waits. D314 retries use the same rule; other queued clips keep their times (no re-chain). `placement: after-last` keeps the D310 rule (latest taken + gap). `minGapMinutes` is retired. A sorted array with binary search gives 1440 hourly slots in a few ms.
- **Channel read.** Uploads list newest first; stops (complete) at the first page whose items were all added (`snippet.publishedAt`) more than `lookbackDays` (120) ago; fails closed on a read error or when `maxPages` (40 x 50) is hit first. Risk: a video uploaded more than 120 days ago but scheduled further ahead is not seen.
- **Values.** `data/posting/schedule.json`: gap 1 h, 60 days ahead, fill-gaps (user); alignMinutes 60, lookbackDays 120, maxPages 40 (agent). User overrides (gap 1..48 h, days ahead 1..730, placement, quota) in `<data>/posting/schedule.json`, applied on the next pass.
- **Default rules (no user rules file yet).** autoUpload on, all kinds (short, montage, won-reel, impact-play), minimum score = the ranker's own floor (`data/clip/ranking.json` minScore, 3) so every clip the clipper publishes qualifies and the oldest go first, uploads a day = what the quota fits: floor((10000 - 100) / (1600 + 50)) = 6 (`data/posting/quota.json`). Why: the user asked for all clips to post on a schedule within the quota; the quota, not a score, is the limit. A global `maxUploadsPerDay` counts across rules.
- **Source.** The clips folder (Settings > Folders > Finished clips, `<folder>/<YYYY-MM-DD>/`), oldest first by the clip's own time in its name; files with no package are packaged (`packageUploads`). A short from the folder has no score: it passes a rule whose minScore is not above the ranker floor.
- **Delete after posting (flag `post-delete-uploaded`, off, label "Delete posted clips forever").** The uploaded file is deleted permanently (no Recycle Bin) only when: the upload finished, `videos.list` says `uploadStatus: processed`, the ledger has this video id and sha256 as uploaded with the same publishAt as sent, the file is the post's source file, a regular file inside the clips folder by its real path (no link or junction), and its sha256 matches. Any doubt keeps it (failed, rejected, still processing, read error, mismatch). Each deletion: one line in `<data>/posting/deleted.jsonl` (file name, video id, time) and one task bar line per batch. Nothing while live.
- **Card.** Settings > Posting & growth > Auto-post (Qt, `app/studio/src/autopost_card.cpp`): upload on/off, kinds, minimum score, uploads a day (with "About N uploads a day fit"), gap, days ahead, placement, quota; "Next posting times" in local time (queue, channel, next free, "Scheduled"), Move and Remove for queued clips. Saved with Settings Save (one click, D332). Routes: `GET/POST /ui/api/posts/auto/settings`, `GET /ui/api/posts/auto/schedule[?fresh=1]`, `POST /ui/api/posts/auto/queue/move|remove`; the logic is in `services/posting/auto-settings.mjs`.
- **Codex review of f253771 (2026-11-13).** (1) The delete hashes the file through one open handle and records its device, file id, size and modified time from that handle; right before the unlink the path is looked up again (lstat) and its folder's real path resolved again; any change, a folder that no longer resolves inside the clips folder, or a UNC / `\\?\` / `\\.\` path keeps the file. Node cannot unlink by handle, so a swap in the microseconds between that last check and the unlink remains (residual risk, evidence doc). (2) A queued slot with no session is re-checked before its upload starts: a due item triggers a fresh channel read, and a slot now within the gap of a channel post or an earlier kept slot gets a new one by the same rule; a failed read keeps it waiting. (3) The page that ends the lookback scan is still status-checked (videos.list). (4)+(6) Persisted daily budget `<data>/posting/quota-day.json` (`services/posting/quota-budget.mjs`): every upload start or resume counts against `maxUploadsPerDay` (UTC day) and insert + thumbnail units (Pacific day, Google's reset); every Data API read (schedule reads, delete status checks, the card's fresh read) counts 1 unit; over budget the items wait ('daily-cap-reached' / 'quota-day-used'), no attempt used. The quota fit may be 0; the card then says no upload fits until the quota is raised. (5) Concurrent fresh reads from the card share one in-flight read.
- **Codex re-review of 3c8fd62 (2026-11-13).** (1) The verified clip is moved by one atomic rename under a random name into `<clips folder>/.ujwalam-deleting/`, checked again there by its own handle (file id, size, time, sha256) and only then unlinked; on a mismatch it goes back to its path if that is free, else stays in the holding folder (never overwritten or deleted). Residual: a writer of the holding folder guessing the random name within microseconds; a crash leaves the verified file in the holding folder. (2) Every counter change runs under an exclusive lock file (`wx`, stale after 30 s, busy after 3 s = blocked); check and charge are one step. (3) Reads are reserved before sending (a schedule read reserves 1 + 2 x maxPages and gives back the rest; other reads 1 each). (4) A malformed counter file blocks; only a valid counter from another day resets. (5) An absent user settings file uses the shipped quota; an unreadable or invalid one blocks the budget (the card still loads to fix it). (6) Upload admission keeps the read reserve (units + one upload <= quota - reserve), so a fit of 0 never uploads.
- **Codex 3rd review of bb4b11c (2026-11-13).** (1)+(4) The lock file and its stale takeover are removed. The counters live in `<data>/posting/quota-day.sqlite` (`node:sqlite`, stdlib): one row per kind and day, STRICT table with CHECK constraints, the same row check on every read. Every check-and-charge, refund and read is one `BEGIN IMMEDIATE ... COMMIT` with a 3 s busy timeout (busy = blocked); the OS releases SQLite's lock when the holder dies; every exception path rolls back and closes. The old `quota-day.json` is carried over once when valid; an invalid one blocks until fixed or removed. (2) A read reservation keeps its Pacific day: refunds go to that day only; a scan request sent after midnight Pacific reserves 1 unit on the new day first. (3) A held clip is put back with `fs.linkSync` (fails if the path is taken, never replaces), then the holding name is removed; if the link fails it stays in the holding folder.
- **Follow-up, not built.** Changing the time of a clip already uploaded (videos.update) — needs a full snippet round trip and a quota of 50 units per change.
- **Status.** Proposed. Fakes only (no upload, no real channel read). Evidence `docs/evidence/2026-11-13-auto-post-scheduled.md`.

## D377 — Edit output shows the bitrate the output really sends (2026-11-13, user report)
- **Report.** Settings > Stream, OUTPUTS: YouTube main shows 17000 kbps in the list, but Edit output showed 6000 kbps (greyed out). The 6000 was the dialog's built-in start value for "Its own bitrate", shown even when the box was off.
- **What went out (host log 2026-11-12, 19:07-20:33).** The YouTube main sink ran on the shared main rung: NVENC H.264 CBR 17000 kbps, 1920x1080, keyint 120. The 6000 kbps encoder in the same log is the Twitch/Kick re-encode rung, as set.
- **Fix.** Box off: Resolution and Bitrate show the shared canvas encoder (main, or portrait for a portrait output; Resolution hidden for portrait), greyed out, with a line "Sends the main canvas stream: N kbps, set under VIDEO". Box ticked: starts from the shared values and keeps its own after that. Saved setup unchanged (no `video` unless ticked).
- **Evidence.** `tests/studio-qt-d327.test.mjs` "Edit output: the Bitrate box shows what the output sends" (3 headless runs: shared, ticked, own).

## D378 — Stream above the canvas size: 2K on both YouTube outputs from the 1080p canvases (2026-11-13, user request)

- **Request.** "for now get the youtube both H and V to stream 2k resolution". The canvases stay 1920x1080 and 1080x1920 (the capture card is 1080p60); YouTube gives a 1440p stream its higher-quality encode.
- **Why it was refused.** Settings > Stream offered 1440p, but the validator (UPSCALE) and the host ("no upscaling") refuse a rung larger than its canvas, and the portrait size was fixed at 1080x1920. No stream setup was saved, so `alpha-live.json` (1080p) was in use.
- **Change.** Flag `stream-upscale` (off by default, page stream). With it on, every rung of the Settings > Stream plan carries `upscale: true`; the validator turns UPSCALE into info UPSCALED, still refusing a changed aspect ratio (UPSCALE_ASPECT); the host accepts a larger rung only with `upscale: true` and the canvas aspect ratio, scaled on the GPU (Lanczos, `obs_encoder_set_scaled_size`). New optional `video.portraitOutput` (1080x1920, 1440x2560, 2160x3840 from `data/stream/stream-options.json` `portraitResolutions`) with a "Portrait output resolution" box on the Stream page. Flag off: as before.
- **Values for the user's setup (agent).** 1440p main and 1440x2560 portrait, 24000 kbps each (YouTube's 1440p60 guidance; `data/platforms` max 50000). Upload need about 54 Mbps with the 6000 kbps Twitch/Kick rung: UNVERIFIED on the user's line. NVENC load of two 2K encodes plus the 1080p re-encode: UNVERIFIED until the loopback test (ffprobe + skipped-frame counts) passes; no real stream before "start stream test".
- **Evidence.** `tests/stream-setup.test.mjs` "D378: 2K on both YouTube outputs", `app/host/tests/host-api.test.mjs` (upscale accepted, non-boolean and wrong aspect refused).

## D379 — A refused live plan never keeps the studio from opening (2026-11-13, user report)

- **Report.** "ujwalam is not opening". Launcher log: `outputs plan refused: sink "instagram": no server address is stored in Windows Credential Manager target Ujwalam/stream/instagram-server`, exit 1, no window. Flag `instagram-live` was on with no Instagram server address.
- **Change.** `planForStart` (launch.mjs): Instagram Live is an add-on, so a refused plan is tried again without it; a live plan still refused opens the studio on the record plan (no stream targets). Each step is logged with its reason. An explicit `--outputs` plan still stops the start. Released in 0.1.0-alpha.28 with the data files the package check missed (`data/live/host-watch.json`, `data/counters.json`, reel data).

## D380 — Faster opening: the outputs plan and replay buffer are built once (2026-11-13, user report)

- **Report.** "the opening delay was prominent". Host log 2026-11-13 17:59: start 04.2, ready 07.7, `project.load` 3257 ms, window about 11.5 s after the click. The host built the outputs plan, ran the NVENC probe and started both replay buffers for the throwaway test card, stopped them at the project load (about 1.1 s) and built everything again.
- **Change.** Host flag `--defer-outputs` (passed by the alpha launcher, whose project load always follows): the `--outputs` plan is kept as the last configure params and the replay buffer is marked wanted, without building; the first `project.load` builds both once. A plan the host refuses is now logged after the load ("outputs not configured after the project load") and the record plan is configured instead, so the studio opens recording-only, never with a silent empty graph (Codex review). Saves about 2 s per start; other start costs (D3D and module load about 2 s) are libobs's own.
- **Evidence.** `app/host/tests/host-defer-outputs.test.mjs`, `tests/studio-ui-alpha.test.mjs` (alpha argv).

## D381 — Realism look: a per-pixel grade, not a neural filter (2026-11-13, user request; lead decision)

- **Ask.** A new scene from the default one in which the game capture and its duplicates get a realistic-graphics post-processing shader; can it run locally on this laptop (RTX 4050 Laptop, 6 GB VRAM) while NVENC encodes 2K H, 2K V and the 1080p re-encode?
- **Decision.** A neural "photoreal" filter is not feasible live: it needs most of the 6 GB and a large share of the GPU per frame, next to three NVENC sessions and the compositor, and the live-AI budget (whisper + C4) already holds the VRAM that is free while live. Instead: a cheap per-pixel "Realism grade" built from existing layer effects, behind flag `realism-look` (Settings > Editing, default off).
- **The grade.** Our own 33^3 .cube LUT `data/luts/realism-filmic.cube`, written by `tools/make-realism-lut.mjs` (deterministic; a test checks the committed file byte for byte): saturation tame on over-saturated colours (at most 18 % of chroma), a gentle filmic S-curve with a 0.01 black lift, a highlight shoulder above 0.75 (white at 0.97), slightly cool shadows and warm highlights (at most 1.2 %). On every game layer: LUT 0.85 (preset `fx-realism-grade`), sharpen 0.3, vignette 0.25 (size 0.55, softness 0.8, black). Values are proposed, tunable later in the effect editor.
- **New file base `luts`.** The app's shipped LUTs (`<app root>/data/luts`), read only; the host keeps every file inside the folder (resolve_file). Added to the host (model.cpp, methods.cpp), the project schema and validator, the host lib and the alpha load (`alphaBases`). The package ships `data/luts/*.cube`.
- **One click.** Scene right-click menu > Make realism scene (route op `scene.realism`): duplicates the scene as "<name> Realism" (id `<id>-realism`) and appends the three effects to every layer of the copy that shows the game capture (the role-bound game device, else the only capture card; the blurred backdrop copies included). The original scene is never changed. Refused while live, when the scene shows no game capture, or when a game layer would pass 6 effects. In the alpha project H and V share one scene, so one copy covers both canvases.
- **Unverified.** GPU cost next to the three encodes and the look on real footage: to be measured by the lead (host and fx tests were not run while the installed app was running).
- **Evidence.** `docs/evidence/2026-11-13-realism-look.md`.

## D382 — Scene hotkeys: studio-window keys first, global in-game keys later (2026-11-14, lead decision, plan Q4)

- **Ask.** Plan Q4 lists scene hotkeys; nothing exists in either studio window or the host (the host only has the global panic, feedback and marker keys).
- **Decision.** Step 1: Ctrl+1 to Ctrl+9 switch to the 1st to 9th scene of the scene list (its order on screen) while the studio window has focus, through the same route and rules as a click on the scene. Behind flag `scene-hotkeys` (Settings > Editing, default off; read live). The command palette shows each scene's key. Step 2 (deferred): global keys that work while the game has focus belong in the host hotkey table next to panic/feedback/marker, with a clash check against the Streamer.bot and Speaker.bot bindings and the game (AGENTS.md: no clashing hotkeys); that is host work on the live path and waits for the user's actual bindings.
- **Why.** Window keys cost nothing on the live path and help at the desk; in-game switching needs the clash check first.

## D383 — `npm test`: the studio-starting test files run at most 4 at a time (2026-11-14, lead decision)

- **Seen.** Five full CI runs in a row on 2026-11-14 failed the `test` step on QML or widget studio probe tests (theme switch, theme reload, High performance), each passing alone and under a made-up load of one other studio file. `node --test` ran every file at its default concurrency (15 at once on 16 threads); 39 of the 195 files start the software-drawn studio exe, and with many at once their windows starved each other past the probes' fixed deadlines (two probes of 6-14 s were killed at 40 s).
- **Decision.** `npm test` is `node tools/run-tests.mjs`: the files that import the studio build tool run in their own `node --test` with `--test-concurrency=4`, at the same time as all other files at the default concurrency. Every file still runs once. The output ends with a short summary naming the failing tests, because the CI keeps only the last lines of a failed step (a failure in run 1 had no name). The load-sensitive tests were also made to wait for the studio rather than the clock (they count their probe actions; the reload test waits for the studio log). The theme reload code now retries a pack file it cannot open yet (missing mid-rename or held by a scanner) instead of dropping that save.
- **Not changed.** The cloud workflow runs one file per job and is not affected.

## D384 — Studio redesign: RareUI and Sonner looks rebuilt natively in QML, as the new default look (2026-11-14, user)

- **Asked.** The user wants every RareUI component (21 items: components, text animations, Book 3d, Liquid Wave background, Image Expand Testimonial; MIT, React + Tailwind + Framer Motion) and Sonner's toasts (MIT) in the studio, replacing the default look.
- **Options weighed.** A React runtime (Electron or Qt WebEngine) would run the libraries directly but needs a complete overhaul: the libobs preview has to float as a native window over the web page or be copied into it, Chromium costs about 200-400 MB RAM plus GPU time on the 6 GB card while live, about 60 QML files and 39 studio test files would be rewritten, and it is a new install. A React control page only was the smaller option.
- **Decision (user, 2026-11-14).** Native QML redesign. Each piece is rebuilt from its MIT source as our own QML code with an MIT credit; shaders only through Qt's built-in ShaderEffect/MultiEffect; no new installs. 18 of the 21 RareUI items are built; Particle Card, Premium Profile Card and Image Expand Testimonial are skipped for now (user). The result is a dedicated RareUI theme (its own black, white, orange and lime) that becomes the default; the effects read theme tokens, so the current themes stay selectable and get the new components in their own colours. Bundled fonts only (user). Liquid Wave is the real fluid simulation (user), only when neither live nor recording. No UI sounds: Sound Text is visual, driven by the mixer level. The other answers are in the research doc's "Answers" section. While live or in High performance mode, shaders, particles, 3D and continuous animations fall back to plain styles. Sonner 2.0.8 was installed only in a scratch folder as a reading reference; it is not a project dependency.
- **Process.** Research doc `docs/plan/2026-11-14-rareui-redesign.md` first; the user approves it before building.

## D385 — Stream resolution switch and YouTube keys per quality (2026-11-15, user bug report)

- **Asked.** Critical bug report on alpha.29: switching the stream resolution is janky, choosing 2K or 4K gives errors "left and right", YouTube sign-in is not properly done. The user makes the 1080p, 2K and 4K stream keys in YouTube and wants to give them to the app, or have the app create and set up the 1080p, 2K or 4K stream itself: "it needs to be simple as that".
- **Causes found.** (1) Above the 1080p canvas, 2K and 4K were refused unless a separate switch (flag `stream-upscale`, D378) was on, and the refusal told the user to find it under FEATURES. (2) A new size kept the old bitrate (17000 kbps at 4K). (3) One key slot per output, so a 2K key and a 1080p key could not both be stored. (4) Settings > Connections read Credential Manager one target after another (about 0.4 s each, a PowerShell start), close to the studio's 10 s request time-out; the studio log shows three failed reads (`QIODevice::read ... device not open`) right after a key paste. (5) Settings said changes apply "the next time you go live"; the plan is in fact built when Ujwalam starts.
- **Decision.** Picking 2K or 4K is the decision: rungs above the canvas are scaled up (D378 path, same aspect) with no switch; flag `stream-upscale` is retired. A new size or frame rate sets the main bitrate YouTube recommends for it (data/platforms/youtube.json recommendedByResolution: 17000 / 34000 / 50000 kbps at 60 fps; other pairs keep the bitrate). Per-resolution keys are data (`data/stream/stream-options.json` qualityKeys + platforms[].keyPerQuality, YouTube only): an output sent at 1440p or larger uses `Ujwalam/stream/<output>-1440p`, at 2160p `<output>-2160p` (by the short side, so the portrait canvas too); up to 1080p the existing key `Ujwalam/stream/<output>` (no migration). Connections lists a 2K and a 4K row per YouTube output (live-checked as that output), with Paste key and Sign in with YouTube; "create new" there makes a reusable YouTube stream of that resolution and the setup frame rate, and the account's streams of that size are listed first. Settings > Stream shows, per YouTube output, which key the chosen size uses, whether it is stored, and Set key. Credential reads for the status run in parallel. The Save text says the truth: restart Ujwalam to stream with new settings (applying them without a restart touches the encoder graph and the replay buffer; separate step).
- **Codex review (2026-11-15).** (1) An output saved before D385 with an id like `youtube-h-1440p` would collide with a key row: fixed (no key row for an id already in use, and a key row never replaces a plan output). (2) A key made here is fixed to the setup's frame rate; switching 60 to 30 fps later keeps using it. YouTube still takes a stream that differs from the key's format and shows a notice in YouTube Studio (UNVERIFIED); recorded, not changed.
- **Not changed.** Keys stay in Windows Credential Manager only; no key in a file, log or response (presence and last 4 only). No going live without "start stream test". A live feature is done only after a real stream.

## D387 — Settings > Stream applies without a restart (2026-11-15, user bug report)

- **Asked.** Switching the stream resolution (1080p / 2K / 4K) in Settings > Stream only took effect after closing and reopening Ujwalam (D385 cause 5). The user approved applying a saved setup at once.
- **Cause.** The launcher built the live plan and configured the host only at start (`livePlanFile` -> `writePlanFile` -> host `--outputs`); Save only wrote `stream-setup.json`. The host already takes `outputs.configure` again at runtime (refused with CONFLICT while an output is active; it re-attaches the replay buffer itself), so no host change.
- **Decision.** One place for the live plan: `services/studio-ui/stream-apply.mjs` (`livePlanFile`, `planLive`, moved from launch.mjs; the launcher re-exports them). At every start the launcher writes `<data dir>/outputs/live-start.json` (paths and flags only: --live start with a real host, the plan file the UI server was given, the host's `--outputs` params file, Instagram add-on in the plan, a `--sinks` selection or Twitch bandwidth test, whether server-address schemes are read) and clears any pending mark. After a Save, the UI server plans exactly as the launcher would from those facts and calls `outputs.configure`, only when every output reads idle (unreadable state, an unknown sink state or a stream start in flight counts as busy), one apply at a time; on success the host's `--outputs` params file is rewritten too, so a host restart after a crash builds the new graph. A running stream or recording is never stopped: the setup is then pending (`<data dir>/stream-setup-pending.json`, survives a UI server swap) and Start stream applies it first while idle. Save answers `appliesAt` `now`, `next-go-live` (pending) or `next-start` (not a --live start, or a --sinks / bandwidth test start, whose selection a runtime apply would lose). A refused plan or host refusal puts the plan files back and stays pending.
- **Codex review (with D386).** A pending setup that cannot be applied at Start stream now refuses the start (`stream-setup-not-applied`, the reason in plain words; it stays pending) instead of going live on the old setup. If the host took the setup but its `--outputs` params file or `live-start.json` was not written, the setup stays pending, so the next Start stream applies it again. The UI server reads the plan in effect everywhere (Connections rows, readiness key list per run, YouTube outputs). Save text in Settings > Stream follows `appliesAt`.
- **Not changed.** No host change. Keys stay in Windows Credential Manager (only target names in the files). Nothing starts streaming on a Save. UNVERIFIED on the real host: NVENC session re-probe on a runtime reconfigure, a 4K (upscaled) rung built at runtime, the replay buffer re-attach after it; check on the laptop before calling it done.

## D386 — A fresh YouTube live event per go-live, copied from a template per output (2026-11-15, user request)

- **Asked.** The user wants a stable per-output YouTube setup: every go-live gets its own YouTube live event instead of the stream key's default event, with the title, description, privacy and the rest taken from a previous broadcast the user picks as the template. Copy everything. The vertical output (V) has its own template, separate from H. Twitch and Kick are not touched.
- **Decision.** Flag `youtube-events` (off by default; the routes also need `platform-connect`). `services/platform-connect/youtube-events.mjs` uses the Google sign-in that platform-connect already has (`connect().youtube`; scope `youtube`, so no new consent). Templates are the user's previous broadcasts (liveBroadcasts.list, newest first, at most 25, cached for 5 minutes). The choice for each YouTube output is the template id, its title, and an optional title the user sets: `<data dir>/youtube-events.json`, not secret, written atomically. Routes: `GET /ui/api/youtube/events`, `POST /ui/api/youtube/templates`, `POST /ui/api/youtube/event/set`. At Start stream, for each YouTube sink of that start, the template is read with its video. Then the stream whose key matches the stored key is found (a constant-time compare in memory; the key is never returned or logged). Then liveBroadcasts.insert runs with auto-start and auto-stop on and the monitor stream off. It copies title, description, privacy and made-for-kids, plus DVR, embed, record-from-start, latency and caption type. videos.update copies category, tags, default language and audio language. thumbnails.set copies the template's best thumbnail (https from i.ytimg.com only, 2 MB at most). Then bind. If videos.update or the thumbnail fails, that is a warning. If insert or bind fails, the start is refused. A YouTube sink with no template refuses the start before anything is made (`youtube-event-missing`). If any event fails, the events already made are deleted and the start is refused (`youtube-event-failed`, which names the output). The events are made before the stop-wins checks. A start refused before it reaches the host deletes them again (best effort); once the start was sent, an event is deleted only when a fresh status lists its output in a stopped state (a lost host answer can hide an output that went live; missing, malformed or unknown state keeps the event). An accepted start answers `youtubeEvents: [{ output, title, warnings }]`. The log holds counts and codes only.
- **Key not on the channel.** A pasted key that is not one of the channel's streams cannot be bound: `youtube-key-not-found` tells the user to pick or create the key under Settings > Connections (signed in).
- **Quota.** About 203 units per YouTube output per go-live (3 reads, then insert 50, videos.update 50, thumbnails.set 50, bind 50), so about 406 for H + V. That is out of the default 10 000 per day. Listing templates costs 1.
- **UNVERIFIED (no real stream yet).** Monitor stream off with auto-start on should go straight live when data arrives, with no testing stage. A copied thumbnail is YouTube's published image, possibly a smaller or re-encoded copy. Custom thumbnails need a verified channel; without one the copy is a warning. It is unknown whether YouTube applies the category, tags and languages to a broadcast that has not started.
- **Not changed.** Keys and tokens stay in Windows Credential Manager. No key, token or response body appears in a file, log or answer. Twitch and Kick starts make no YouTube call. No going live without "start stream test". A live feature is done only after a real stream.

## D388 — YouTube presets and in-app YouTube control, on by default, no flag (2026-11-15, user request)

- Asked by the user: "need the youtube streaming request with multple quality preset and all in all yourube control
  in-app ASAP". Choices (2026-11-15): named presets holding YouTube H and V size + bitrate + on/off + event template;
  in-app event details editing, live status panel, live chat (read every 15 s, send on click), past streams manager.
- The user forbade flag gating for it: "stop your flag based BS implementation that'll get user confused. use toggle
  function, the least something modern. turn this on by default as this is requested feature by default rather than
  flagging it". The `youtube-events` flag is retired; on/off lives as a visible toggle inside the YouTube window
  ("New YouTube event at every Go live", default on). This overrides the AGENTS.md "new features behind a flag, off by
  default" rule for user-requested features.
- fps is not part of a preset: the canvas fps is shared with Twitch and Kick, which the user said not to touch.
- Contract: `docs/plan/2026-11-15-youtube-control.md`. Built in three parallel parts (A presets, B control service and
  routes, C QML window), reviewed by the main session and Codex before merge.
- Codex second-opinion review (medium effort) found seven issues, all fixed with regression tests before merge:
  End/Delete of an event with no current-list entry while an output may be live (now checked on YouTube: only
  created/complete/revoked allowed while any YouTube output is not surely stopped or a start is in flight); a credential
  store read error at Go live streamed without the event (now refused, `youtube-signin-unknown`); a UNC or device
  thumbnail path (only drive-letter paths, real path re-checked); a switched-off output sharing the YouTube rung (now
  also refuses the preset); a failing chat look-up retried at the request rate (now waits 60 s); the stale clean-up
  could drop a newer event written meanwhile (keyed by output and event id); an empty description or tag list fell
  back to the template's (kept as real choices).
- UNVERIFIED until a real stream: monitorStream/autoStart, liveBroadcasts.update required fields, chat on a fresh
  chat, End lifecycle states, thumbnail upload (needs a verified channel). Residual: a mapped network drive letter is
  still accepted as a thumbnail path.
## D389 — Go live chooser, streamer-friendly outputs cards, UI design system (2026-11-15, user request)

- The user, after installing alpha.31: "keys are getting connected, but the go live implementation is bad". Answers:
  AI help = local model; theme = full UI overhaul; outputs = hard to use and layout jumps, "make it streamer friendly
  rather than a programmer or tech friendly, take inspiration from Meld Studio"; chooser = every Go live, last choice
  pre-selected. Contract: `docs/plan/2026-11-15-go-live-chooser.md`. On by default, no flag (D388 rule).
- Go live with a YouTube output on and signed in opens a chooser with four ways: use an event on your channel
  (`existing`, bound to the stream of the chosen quality's key, never deleted by Ujwalam on any failure), pick from past
  streams (`copy`, D386), new stream like the last one (`last`, newest completed broadcast of that output, resolved at
  Go live, up to 4 pages of the completed list), set up a new stream (`new`, fields checked like `event/set`). A quality
  per YouTube output (1080p / 1440p / 4K) picks the D385 key slot; a size without a stored key is greyed with "Add the
  key". Quality is applied only through the shared `saveSetup` path, only when the size changes (an unchanged size keeps
  the user's own bitrate; options shows that real bitrate, `null` with Settings > Stream off). The D388 shared-rung
  refusal applies: Twitch and Kick never change.
- "Help me write it": local model only (OpenAI-compatible server on 127.0.0.1 / localhost / ::1, default LM Studio
  `http://127.0.0.1:1234/v1/chat/completions`, `<dataDir>/ai-writer.json`), refused while anything is live or recording,
  re-checked right before the model call, and aborted by a stream or record start. Input: game name, the user's last 5
  titles, date, a hint; never chat text, viewer names or memory. Fallback smart-fill after 20 s or a bad answer.
- Outputs panel rewritten as destination cards ("Go live here" switch, plain status chip, duplicate-key warning,
  summary line, 1-2 column reflow, no size change while saving). `outputs-panel` is now ON by default (user-requested
  feature; the flag stays as a kill switch).
- UI design system C1: spacing / type / elevation / focus-ring / state / motion tokens; "Ujwalam light" and "Ujwalam
  night" replace Soft (a saved `soft` migrates to light); layered shadows without bands, still plain while live,
  recording or High performance; every U* control restyled; a headless layout probe (no item outside its parent, no
  clipped text, no overlaps) runs the main window and all 12 Settings pages in both themes at 1100x680 and 1920x1080 and
  found and fixed four overlaps. Main window layout overhaul (C2) follows.
- Built in three parallel tracks (A server Opus, B QML Sonnet, C design system Sonnet). Codex review of A (medium):
  no P1; four P2 fixed before merge (suggest racing a start, `last` reading only the first 50 broadcasts, key presence
  read from an inactive setup, the shown bitrate not being the one used). Main-session review found the window sent
  `thumbnailPath` where the server allows `thumbnail` (fixed; the test now checks the body against the server's field
  check).
- Found on the way: server tests built without a credential seam read the real Windows Credential Manager, so a laptop
  signed in to YouTube made 8 tests fail. Tests now get an in-memory store, and the sign-in service's default store is
  in-memory under `UJWALAM_HEADLESS=1`.
- UNVERIFIED until a real stream: `existing` mode sending contentDetails back whole with auto-start keeps the user's
  other event settings; LM Studio honours `ttl`; real-screen look of the new themes at the user's display scaling.

## D390 — Scenario scenes and screen/window capture layers (user, 2026-11-18)

- **Decision.** User request: scenes per scenario (gameplay, lobby / just chatting, screen share, starting soon / BRB /
  ending), each an H + V pair built from data templates through the SB3 builder; new scenes only. Project layer types
  `screen` (libobs `monitor_capture`; source `{display, cursor?}`) and `window` (`window_capture`; source
  `{window: "title:class:exe", match?: title|class|exe (default title), cursor?}`). One app window is the default for the
  screen-share scene; the whole screen stays available. Targets come from the read-only host RPC `capture.listTargets`.
- **Screen capture allowed.** win-capture loads only when the host starts with `--allow-screen-capture`, because loading
  it fetches the OBS compatibility list from obsproject.com and copies hook files into ProgramData (D28 kept it off). The
  user allowed it on 2026-11-18: the launcher passes the switch and the package ships win-capture.
- **Privacy.** Window titles are personal data: never logged by Ujwalam, never committed; a window layer is named after
  its program (exe). Shared packages (scene-builder build/edit/variants/export) keep only `:class:exe`
  (`shareablePackage()`); an import without a title gives a placeholder, never a guessed window. The default `title`
  match never shows another window of the same app: a closed window leaves the layer empty until the same title opens
  again (`exe`/`class` are explicit choices that can). Display ids are 1..127 printable ASCII (OBS copies them into a
  128-byte buffer). Codex review fixes `c75c5a0`. Evidence `docs/evidence/2026-11-18-capture-layers-and-transitions-host.md`.
- **Scenario templates.** Six templates in `data/scene-templates/` (gameplay, lobby / just chatting, screen share,
  starting soon, BRB, ending) with explicit H and V boxes; V boxes sit inside the V safe zone and the game is never
  cropped. Slot role `screen` links a project `window` layer (first choice) or `screen` layer, or creates one from a
  target picked from `capture.listTargets` (the id is looked up again; no target = placeholder). Holding screens are a
  message panel (`ujwalam-panel ?text=`) plus chat; no countdown yet. Studio: Add scene > "From a scenario…", a plain
  dry run, one-click Add (D332), off air only. Flag `scene-builder` is ON by default (a requested feature). Evidence
  `docs/evidence/2026-11-18-scenario-scenes.md`. UNVERIFIED: template boxes on a real stream; the target id format.

## D391 — More transitions and cyberpunk stingers; transitions ON by default (user, 2026-11-18)

- **Decision.** "Fancy transitions, default one cyberpunk colourful." Flag `transitions` is ON by default (a requested
  feature). Host types `slide {direction}`, `swipe {direction, swipeIn}`, `wipe {pattern, softness, invert}` (patterns
  from `data/transitions/luma-wipes.json`, the luma images OBS ships) and `fadeColor {color, pointPct}`, each with
  `durationMs` and fields allowed only on their type; `transitions.types` lists them for the UI. `pointPct` is 1..99
  (OBS's curve gives NaN audio at 0 and 100). A settings change builds a fresh transition and releases the old one off
  the channel (no in-place update: `fade_to_color` races its audio mix); a transition OBS cannot load is refused before
  any canvas change.
- **Stingers.** Three stingers drawn locally by `tools/make-stingers.mjs` (plain JS rasterizer, VP9 WebM with alpha,
  60 fps, 900 ms, silent): `neon-glitch` (default), `synthwave-sweep`, `cyan-grid`, data in
  `data/transitions/stingers/`, committed H and V files, packaged. Read with pathRef base `data`; the studio picks a
  built-in stinger by preset id only. Fully opaque at pointMs; measured at 2 flashes/s or fewer (limit 3).
- **Existing project.** A canvas whose transition is unset or still the Meld-imported fade is switched to neon-glitch
  once at the next start (copy in `projects/_old`, marker `projects/transition-defaults.json`, so a later choice is never
  overwritten). UNVERIFIED: the look on a real stream; alpha decode of VP9 in the host's stinger source.

## D392 — Scene builder reads references with a local vision model (user, 2026-11-18)

- **Decision.** The user approved installing a small vision model: `qwen/qwen3-vl-4b` in LM Studio (3.33 GB, downloaded
  2026-11-18). `services/scene-builder/vision.mjs` is the read hook's adapter: local address only (shared check
  `services/common/local-ai.mjs`), the middle frame as a PNG plus the rules' slots as text, boxes on a 0-1000 scale, model
  confidence capped at 0.85 so a sure rules slot is not replaced on a guess; LM Studio loads the model on demand and
  unloads it after 120 s idle (UNVERIFIED for every version). Never while live or recording (6 GB VRAM, D1). The rules
  result stands when the model is off, fails or answers out of shape. CLI `--ai`; the studio window follows.
  UNVERIFIED: a real read on the user's references.

## D393 — Scene music moods from the local procedural maker (user, 2026-11-18)

- **Decision.** MU1 of `docs/plan/2026-11-18-audio-mixer-music.md`. Scene music beds come from the local procedural
  maker `services/clip/scene_music.py` (numpy only, `reel_music.py` unchanged). The five moods the user chose are data:
  `data/music/moods/*.json`, schema `data/schemas/music-mood.schema.json`. They are starting-soon (hype synthwave),
  lobby (chill lofi), in-match (low dark ambient), brb (lofi) and ending (calm outro).
- **Beds.** Each bed is a seeded 48 kHz stereo 16-bit WAV of 3 to 4 minutes that loops seamlessly. The loop seam is
  checked: the step from the last sample to the first is compared with the 99.9th-percentile step.
- **Loudness.** Integrated LUFS (BS.1770-4, cross-checked against ffmpeg ebur128 to 0.1 LU): -20 starting-soon, -23
  lobby and brb, -24 ending, -30 in-match. Tolerance 1 LU, peak ceiling -1 dBFS.
- **Where it runs.** The library (about 180 MB, about 7 min of CPU) is made off air only, into the app data folder,
  never into the repo and never committed. The CLI refuses unless `tools/live-check.mjs` says off air.
- **Open.** The moods stay `proposed` until the user listens. Playback and scene wiring are MU2. ACE-Step comes later.
  Evidence `docs/evidence/2026-11-18-scene-music-moods.md`.

## D394 — Every transition type in the studio; AI read switch in the scene builder (user, 2026-11-18)

- **Transitions box.** It offers every host transition type per canvas, each with plain-word help: stinger (built-in id
  or own video), cut, fade, slide, swipe, wipe and colour fade. A type or wipe the host lists as unavailable is shown
  off with its reason.
- **Applies live.** A click applies on air as well as off air (D332; changes apply live, user 2026-11-15). The
  `live-locked` refusal on the transition route is removed.
- **Validation.** The server checks every transition with the project validator. Its numeric limits are exported as
  `TRANSITION_RANGES` and sent to the boxes.
- **Scene builder AI read switch.** It defaults on when LM Studio answers on 127.0.0.1:1234 with `qwen/qwen3-vl-4b` in
  `/v1/models`, and is off with a reason otherwise. It is never used while live or recording (D1, D392). The window
  states which reader was used.
- **Evidence.** `docs/evidence/2026-11-18-transitions-ui-and-builder-ai.md`.
- **UNVERIFIED.** A transition change mid-stream on a real stream; the `/v1/models` shape of the user's LM Studio.

## D395 — Late devices, waiting mixer strips, Try again, capture-card sound pairing (user bug reports, 2026-11-18)

- **Decision.** Merged from `fix/devices-mixer` (`732c98d`). A device missing at load is never dropped: its layer is a
  placeholder that connects by itself when the device appears (slow retry), and its sound is a waiting mixer strip
  with a plain message. "Try again" (`devices.rescan`) restarts the connect attempts. Preset capture placeholders are
  rebound to the user's devices at start and on Connect.
- **Mixer.** Strips come from the host's `mixer.list` plus the waiting rows, never doubled. Meters read
  `mixer.levels` (never waits) with peak hold. Volume goes up to +12 dB.
- **Connect.** It saves on a fresh read of the project (`projectSync.update`), undoes the host change when the save
  fails (`not-saved`), and a refresh asked for during a refresh runs once more.
- **Capture-card sound.** A card's "-Video" / "-Audio" pair is merged into one sound only when the device list holds
  exactly one of each for that product. Otherwise the sound is added with a warning.
- **Monitoring output.** It is switched only while no sound has CUE on. Codex round 2 (2 P1) found this still unsafe
  against libobs deferred source teardown and the loopback dedup reader. The fix is pending on a new branch; the
  proposal is to switch only where no audio sources exist.
- **Evidence.** `docs/evidence/2026-11-18-devices-and-mixer-fixes.md`. host-devices-late 6/6, host-api 16/16,
  studio-devices-mixer 14/14.
- **UNVERIFIED.** The runtime check of the monitoring gate; a real late-plugged capture card and microphone on the
  user's laptop.
## D396 — Ujwalam-Setup.exe and in-app update before P17 (D3 amendment; user, 2026-11-18)

- **Decision.** One per-user `Ujwalam-Setup.exe` installs, updates, repairs, rolls back and uninstalls from the build
  folder (`out\dist`). It is Win32 only, needs no admin rights and carries no payload: the verified zip sits next to
  it, is copied into a private work folder, hashed, and unpacked there with the system's tar. `Install-Ujwalam.ps1`
  runs hidden, and only if it matches the package's `SHA256SUMS.txt`.
- **Settings survive.** Every switch of the version pointer is preceded by a settings backup: every `*.json`/`*.key`
  under data, plus a consistent event-database snapshot. The newest 10 are kept, plus always the one that a rollback
  of the current version needs. A rollback restores it all or nothing:
  - the whole snapshot is checked first;
  - the database WAL is folded in;
  - the newer files go to a before-rollback backup;
  - files are swapped through a journal that undoes itself on any failure.

  Without a backup a rollback is refused; `-Force` keeps the current settings.
- **Safety.** One setup at a time (`install.lock`), and Ujwalam does not start while it is held. Rollback, repair
  over the running version and uninstall are refused while Ujwalam runs (found by path). An update while Ujwalam runs
  touches nothing it uses, and the new version runs from the next start. Uninstall keeps the user's data unless the
  box is ticked.
- **Update available.** The studio checks on start and on demand only. It never installs while live or recording, and
  asks again right before Setup starts.
- **Accepted risk until P17.** The package and Setup are unsigned and trusted as the user's own build folder;
  checksums catch damage only. Signing, MSI/MSIX and an Apps & features entry stay P17 work.
- **Evidence.** `docs/evidence/2026-11-18-setup-installer.md` (Codex: 6 P1 + 5 P2 + 1 P3, all fixed or argued).

## D397 — Idle load cuts (user, 2026-11-18: "focus on speed and efficiency without compromising quality")

- **Replay on air only.** The alpha replay buffer (60 s) runs only while a stream or recording is wanted (host config
  `replay.onAirOnly`, set by the launcher). Off air there is no replay encoder. Save clip and the feedback hotkey say
  "off air: the replay buffer runs only while you are live or recording". A stream sink that reconnects keeps the
  buffer attached, proven by a host test against a refused loopback port. A clip saved in the first 60 s of a stream
  covers only the time since going live.
- **Browser layers.** They render at 30 fps unless the layer's source asks for more (`fps` 1..240, never above the
  fastest canvas). Pages are not shut down while hidden: obs-browser already pauses hidden pages, and shutdown made
  pages 2-3 frames late on a cut and lost events that arrived while hidden (measured 2026-11-18).
- **Other cuts.** Previews stop drawing while hidden, minimised or zero size. Restore is UNVERIFIED: the user checks
  it by hand. The live clipper and face worker run only while wanted, through generation-bound worker slots. Polling
  is cut: a stat cache revalidated at least every 10 s, one `outputs.status` per tick, a 2 s idle tick.
- **Lock order.** In host outputs, `op_m_` is outermost; `m_` and `rp_m_` are never nested.
- **Evidence.** `docs/evidence/2026-11-18-idle-performance.md`. The perf-idle before/after numbers are pending a quiet
  GPU.

## D395 amendment — headphones output chosen at start only (2026-11-18)

- The audio monitoring output (`monitoringDevice`, headphones) is chosen once at host start, before any source
  exists. It is never switched on a running studio, because libobs 32.1.2 frees the device id without a lock its
  readers take (Codex round 2, checked against the OBS source). Headphones connected after the start are used from the
  next start, and the studio says so in one plain sentence.
- Connect saves only what the host built, and an undo is made from the file as it is now.
- A saved card input counts as the same device only when it is the listed input of a certain pair. The Windows
  ContainerId match is a follow-up.
## D398 — The QML studio is the only studio (user, 2026-11-18: "Yes, delete it")

- The Qt Widgets studio (38 files, about 14,090 lines in `app/studio/src`) and the `studio-qml` flag are removed, with
  the launcher's `qml` option and the soak tool's `--qml`. The parity checklist had reached 48/48.
- Accepted losses: the Soft painters, the component stylesheet variants and the specimen page (three widget tests
  with no QML twin). `packProblem` still refuses unknown variants in code.
- `ujwalam-studio.exe` 12.7 MB to 8.9 MB. Qt Widgets stays linked for the tray and system dialogs.
- Headless without a probe or hidden mode now exits 64 with a message.
- `studio-qml-layout` failed 24 of 29 on both trees: the Transitions box (D391/D394) ran past the side column. An
  empty type list has no height, Grid skips zero-size items and every later row moved a column; the colour swatches
  did not wrap. Fixed the same day (29/29).

## D399 — Audio tools: noise, gate, EQ, gain, compressor, limiter, ducking (AU1–AU3, 2026-11-18)

- Per-strip tools are libobs filters on the strip's source. Edits run on the graphics thread (the 32.1.2 video tick
  walks the filter list without the lock). New tools join switched off; removed tools are switched off first.
- "Clean voice" and "Loud room" are offered presets, applied only on a click (D332). Nothing changes a mic by itself.
- Ducking: `duck {on, source, amountDb 3..18, attackMs, releaseMs}` on libobs `compressor_filter` with a sidechain.
  Starts at -30 dBFS, drops `amountDb` at -10 dBFS voice peaks. Measured 11.71 dB for 12 set. Every sidechain change
  runs on the graphics thread; the filter stays off until the compressor has bound its sound (2 ticks) and is unbound
  before its sound is retired. Missing/waiting sound: off with a plain reason, reconnects without a rebuild.
- Sound files come from the media base only (resolved targets checked at open). An app name that matches two
  different programs is refused. `#` is refused in app names.
- Playlists count each file end once and stop as "unavailable" after one pass with no audio.
- UNVERIFIED: file-symlink case (no symlink right on this account), the live app scan on a real PC.

## D400 — Start-up time and taskbar grouping (user bug reports, 2026-11-19)

- Each process writes one `startup:` line (launcher, host, studio phases). Dev build, warm, practice: the studio
  window is spawned 4.6 s -> 3.4 s after the launcher starts; ready about 6.0 s -> 4.9 s.
- The data-folder ACL is not rewritten when it already passes the same final check (360 -> 65 ms). The skip also
  needs a full-control, propagating (OI+CI, no NP) grant on the folder and only inherited ACEs below it; anything
  else takes the full rewrite. Codex follow-ups, true of the full path as well: the owner is not checked (implicit
  WRITE_DAC), reparse points are not refused, a scan is not atomic. UNVERIFIED: icacls /save /T /C exit code on a
  partly unreadable tree.
- Last session's unfinished clip jobs wait 60 s after a start; a job of this session starts at once. The live
  clipper and face worker start 10 s after the host is ready, or at once when a stream or recording starts.
  Outputs, hotkeys, the panic key and the replay buffer are unchanged.
- One AppUserModelID `Ujwalam.Studio` for the studio, the host's preview windows and every app shortcut (also an
  existing taskbar pin to the launcher); the studio window's relaunch command pins the launcher. Setup has none.
  UNVERIFIED: the real taskbar, checked by the user after updating.

## D401 — MU2 scene music (2026-11-19)

- Per-scene `music {on, mood, volumeDb}` (-40..0 dB), off by default, no flag. At most one Music strip
  (`ffmpeg_source`), so the AU tools and ducking apply unchanged. Library `<dataDir>/music/<mood>.wav`, made off air.
- A host per-sample level filter (added on the graphics thread) does the fades. A fade transition splits its time;
  a cut is 25+25 ms. The same mood keeps playing. A changed bed is out-then-in on one source.
- Listen is host-owned (`music.preview`): a private source in no track, on the monitor only. An on-air gate is held
  by every sink while it is wanted or Starting/Live/Stopping, and by replay and the NVENC probe while they start. A
  hold mutes the preview at once; Listen is refused while any hold or active output exists. File work never runs
  under the gate.
- Codex reviewed it three times (2 P1 + 5 P2, then 2 High + 1 Medium, then 1 High); all fixed with tests.
  UNVERIFIED: real beds, Listen on a real device, a real stinger, a real mic, a real stream.

## D402 — Start-up phases 2 and 3 (2026-11-19)

- Phase 2: 19 dialogs and windows not on screen at start are made on first use (`LazyDialog.qml`); the studio's
  own start 1489 -> 1289 ms.
- Phase 3: the launcher spawns the studio before the event core (Windows, service-swap flag off;
  `UJWALAM_STUDIO_EARLY=0` turns it off). The key stays in the environment; the port arrives later on the studio's
  stdin, never from the network. The window shows only after login and the saved theme. Window ready 4031 -> 3348 ms.
- The early studio exits when its stdin pipe ends (launcher closed, crashed or killed), not through a job object, so
  helpers that must outlive the launcher are not caught. Login retries only refused/reset connections within one
  10 s deadline, then exits 77 so the launcher starts it the old way or relaunches it (Codex, 2026-11-19).
- Deferred: overlapping the NVENC probe (about 0.7 s) touches the encoder graph and needs its own review.
  UNVERIFIED: installed build, `ujwalam-start.exe`, `--live`, cold start, and the taskbar on an early window.

## D403 — Single-file Setup, backlog auto-post, recording cleanup (user, 2026-11-19)

- Setup: one `Ujwalam-Setup-<version>.exe` with everything a fresh PC needs (app, Node, VC++ runtime app-local,
  embeddable Python + clip/face workers). Anything downloadable (AI models) goes through an in-app download manager
  (resume, checksum, never while live). `out\dist` keeps the newest 2 builds.
- Auto-post backlog: every clip made so far goes to YouTube as scheduled posts, random 3-6 a day at random times
  09:00-23:00 local, >= 90 min apart, order shuffled with no two of the same kind back to back; quota and channel
  posts still respected. Posted clip files are deleted once YouTube has processed them (`post-delete-uploaded` on).
- Full recordings (H and V files) are deleted for good once every clip from them is rendered and the review run has
  finished; recordings still to be labelled are kept. Never while live; same safe-delete steps as posted clips; logged.
- Turned on in the user's install only after the build carrying them is installed.

## D404 — Single-file setup as built: bundled runtimes and the in-app download manager (2026-11-19)

User (2026-11-19): "installer needs to be a single file with everything that should be ready to go", "everything", and
"any downloadable needs to have a download manager within the app".

- `Ujwalam-Setup-<version>.exe` is one file: the setup program, the package zip and a trailer with both SHA-256s. It
  checks itself before it unpacks anything and refuses a damaged or cut-short file in plain words (exit 21). The build
  keeps the newest 2 setups in `out/dist` and logs what it deletes. The package zip and its .sha256 stay next to it
  so older installs (alpha.35's updater) find the update; `--drop-zip` removes them once none is left (Codex round 1).
- The package carries Node.js 26.12.1, Python 3.14.7 (embeddable) with the clip and face packages and the OCR models,
  FFmpeg 8.1 (LGPL build) and the Visual C++ runtime app-local: no admin rights, nothing else to install. Pins in
  `data/runtime/bundle.json`; licences in `docs/licence-headers.md` and the install's `notices/THIRD-PARTY.txt`.
- The in-app update installs a single-file setup from the update folder (zips still work).
- `download-manager` is ON by default (user-requested feature): Settings > Downloads fetches the optional models
  (`data/downloads/*.json`: the speech model for captions, the Face AI models) on a click, with resume, SHA-256 checks,
  retry, Pause and Cancel; never while live or recording. Settings > Clips and Editing offer the missing model.
- Evidence: `docs/evidence/2026-11-19-single-file-setup.md`. A run on a fresh PC is still UNVERIFIED.

## D405 — Backlog auto-post and recording cleanup as built (decided, 2026-11-19)

Decided: the user chose these settings on 2026-11-19 (random 3-6 a day, 09:00-23:00, 90 min apart; delete posted clips;
delete recordings once clipped and reviewed; keep the ones still to be labelled). This records how they were built.

- Schedule: `placement: random-daily` is the new default (`data/posting/schedule.json`): each local day 09:00-23:00
  gets a seeded count of 3-6 posts (`postsPerDayMin`/`Max`), at seeded minute times at least `minGapMinutes` (90)
  apart, also from the channel's own scheduled posts and the queue. The seed is written once to the user's
  `schedule.json` (`seed`) so the times stay put between runs. A user schedule that already says `fill-gaps` keeps it;
  the Auto-post card offers all three placements.
- Backlog order (random-daily only): seeded shuffle of every made clip, no two of the same kind back to back while
  another kind waits, the parts of a split reel next to each other in part order. The approval daily cap still applies.
- `delete-processed-recordings` ("Delete clipped recordings") is ON by default (user-requested). A recording's H
  and V files are deleted permanently only when: the flag is on; the studio is neither live nor recording (unknown =
  no); it has a finished clip job (`<data>/clips/jobs.jsonl`) and the latest of each job type ended with exit 0 and its
  reels made; no clip job for it runs, waits or asks; it is not ticked Keep for labelling (Settings > Clips >
  Recordings; an unreadable list keeps everything); and each file is inside the recordings folder, unchanged and not
  in use (`services/common/safe-delete.mjs`, shared with posted clips). Recordings with no recorded clip job (all made
  before this build) are never deleted. Each deletion is logged to `<data>/clips/deleted-recordings.jsonl`; one task
  bar line per batch says "Deleted N recordings, freed X GB". It runs once at start-up and after each clip job.
- Recordings with no clip job (user, 2026-11-20: "Delete if clips exist"). Real data: `alpha-<YYYYMMDD-HHMMSS>.mkv`
  (H) and `alpha-v-<YYYYMMDD-HHMMSS>.mkv` (V); the clips were made by the live clipper while recording. An H file counts
  as processed when at least one clip still in the clips folder has a name time (`<game>_<kind>_<YYYYMMDD-HHMMSS>_...`)
  inside [the time in the recording's name, the recording's last write], or when an older run folder's `render.json`
  names it and that run made a clip. It must also be finished: no output writes it, it was last written at least 10 min
  ago, and the live clipper is not running. Its V file (same time, `-v-` form; else `<stem>-v`) goes only with a
  qualifying H; a V with no H is kept; `replay/` is never touched. The entry records the files' identity at that time
  and is marked backfill. This also covers live-clipper sessions from now on (checked at start-up, after each clip job
  and every 15 min off air). Verdicts in `<data>/clips/backfill-recordings.jsonl` (`clips-exist (N clips in its time
  window)` or why kept). Dry run: `node services/studio-ui/recording-cleanup.mjs --dry-run --data <dir> --recordings
  <dir>` lists what would be deleted and kept, with sizes and reasons, and changes nothing.
- Custom posting times (user, 2026-11-20: "add the ability to setup custom schedule in app as well"): placement
  `custom` with exact local times per weekday and days off, filled in order, a clashing time skipped not moved; the
  Auto-post card edits them, and "What gets posted" edits the user's own rules in place (unknown rules and keys kept).
  Auto-post never fails silently: the card and the task bar say why nothing uploads.
- Evidence: `docs/evidence/2026-11-19-autopost-backlog-cleanup.md`.

## D406 — Long highlights video from each recorded session (decided, 2026-11-21)

Decided: the user chose this in an interview on 2026-11-20: a long highlights compilation from each session's H (16:9)
recording, the best moments (kills, streaks, wins) in time order, overlapping moments merged once, short transitions,
about 8-20 minutes; auto-posted as a normal YouTube video (not a Short), scheduled like the rest; the recording cleanup
waits until it is made; user-requested, so it ships ON.

- Flag `long-highlights-video` (clips page), ON by default (user-requested). Off: no long video, recordings do not wait.
- Data `data/clip/long-video.json` (status proposed): minSec 480, maxSec 1200, padSec 2, scores (per kill 1, streak bonus
  3 x medal score, won match 5), H frame 1920x1080, default cross fade 250 ms, 12 pieces per render batch.
- Moments: every kill group of the recording (clip_montage.groups over the detector hits, end screens dropped, never
  across a match boundary) as one window, plus each won match's result screen. Windows padded, then merged where they
  touch, so no footage is used twice. Over maxSec: the lowest-scored segment goes first. Under minSec: no video, with the
  reason in minutes.
- Render (`services/clip/long_video.py`, `clipper.py --long-video`, last step of the full run and of the review run with
  an H recording; never needs V): clip_montage.render_argv per batch of 12 pieces on NVENC (CPU retry as the reels),
  scaled into the H frame, cross fade (reel_transition when its flag is on, the user's Cut stays a cut; else the data
  default). Batches are joined with the concat demuxer, `-c copy`: the audio is encoded once. No flash effect is added.
  It runs inside the clip job, so the same gates hold: one job at a time, hidden, below normal, never while live or
  recording (a stream that starts stops the job). Status in `<run>/long/long.json` (made | skipped | off | failed).
- Published as `<game>_long-highlights_<stamp>_kills-N_01_h.mp4`, uploads.json kind `long-highlights`; posting packages it
  as youtube-video (horizontal), with its own template text; RULE_KINDS, the "What gets posted" editor and the rules
  template list it.
- Cleanup: the job record carries `longNotMade` (null = made or none to make); a string keeps the recording with reason
  `long-video-not-made`. A recording with no clip job (backfill) waits, while the flag is on, for
  `runs/<session>/long/long.json` made/skipped/off; no record is written meanwhile, so each pass checks again.
- Evidence: `docs/evidence/2026-11-21-long-highlights-video.md`. A real render on a real recording is UNVERIFIED.

Codex review (2026-11-21), all five fixed on the same branch:
- The long video is now its own clip job (`clipper.py long`, type `long`, task `long-<session>`), queued after the clip
  job in the same run folder. It never starts while a recording or a stream runs, and its whole process tree is killed
  when either starts (it runs again after). The other clip stages keep their old gate (live only), so clips are still
  made beside a plain local recording.
- Cleanup with the flag on needs proof from `runs/<session>/long/long.json` (made or skipped) for every record, old
  ones included; a missing or null `longNotMade`, `off` or `failed` keeps the recording. Backfill the same.
- The length plan counts the real joins: cross fades inside each 12-piece batch only (batch files are joined end to end
  with a short audio fade, no cross fade), so the video never exceeds maxSec as rendered.
- countClips counts `long/published.json`, so a long video alone reaches auto-post.
- Parts live in a per-attempt folder removed in finally; folders left by a kill are removed at the next start.

- Re-review: the plan keeps 2 s under maxSec and a probed file over maxSec is failed and removed; abandoned attempt folders are cleared at the start of every long step; long.json names its recording and, with the flag on, the current one supersedes a stale longNotMade.

## D407 — Facial mocap addendum accepted as the live-avatar part of the face AI plan (decided, 2026-11-21)

- User's answers (2026-11-21): merge into `2026-11-08-face-ai-design.md` and queue after the clip work; the avatar is
  made from the user's photo (8 Nov plan §5), not VRM or Live2D; Ujwalam tracks the face natively (no VMC bridge to an
  external app); the offline body-mocap track (RGB MoCap installed by the user, export watcher + clip template) is
  included; the F-M0 tracker spike may use a short private webcam recording, gitignored, never committed.
- Changed from the addendum as received: switching on is one click (D332, no typed "yes"); user-requested, so the flags
  ship on once each phase passes; personal names replaced by "the user".
- Needs the user's yes before use: `tf2onnx` (install) for the 52-value expression model.
- Plan: `docs/plan/2026-11-21-ujwalam-facial-mocap-addendum.md`.

## D408 — Clip music, name display and transitions; posting text, limits and growth timing (planned, 2026-11-21)

- Clip look (user 2026-11-20): plan `docs/plan/2026-11-21-clip-music-name-transitions.md` (FX1-FX6). The RP4 centre
  title card over blur is retired (the user did not pick it).
- Posting (user 2026-11-21): plan `docs/plan/2026-11-21-posting-text-schedule-growth.md` (PT1-PT5). The one hard
  schedule rule is 60 minutes from every scheduled video (channel and queue), re-checked before each upload; every other
  limit is the user's setting, posts a day up to 24 (the most a 1 h gap allows); growth-led timing changes apply only
  after the user's click.
- Order: posting PT first (the user's live complaint), then clip look FX.

## D409 — Posting PT2, PT3 and PT1 as built (decided, 2026-11-21)

As built from D408 and `docs/plan/2026-11-21-posting-text-schedule-growth.md`. Evidence:
`docs/evidence/2026-11-21-posting-text-schedule-growth.md`.

- PT2: `HARD_GAP_MINUTES = 60` in `services/posting/schedule.mjs` is the default and the floor in every placement. A
  saved gap below 60 reads as 60, and the card refuses it. A window may end at 24:00. A day stops one gap before the next
  day's window starts. `slotClash` checks the slot again right before each upload session. The channel is read again
  when the last read is older than `recheckMaxAgeMinutes` (10). A clash gives the clip a new slot. Posts a day go up to
  24 everywhere, and older 25..100 values read as 24.
- Quota: by default each upload counts against the separate upload allowance (`model: upload-bucket`, 100 a day, about
  50 units per cover). A quotaExceeded answer switches to the unit sum for that Pacific day and the next one
  (`posting/quota-model.json`). The clip waits without using up a try, and the task area says so in plain words. The
  upload allowance figure is UNVERIFIED against Google.
- PT3: the "Run auto-post now" request file starts a pass on the chain's next tick. It is refused while a stream is live or
  starting. The Posts window gains two actions. "Schedule next free slot" approves the clip and queues it at the
  planner's next free time. "Post now (public)" is the only path that sends `public`. It is refused within 60 min of any
  other post, while live, and for a clip that is in the queue.
- PT1: the post text comes from the clip facts (`reel_thumbnail.py facts()`, kept in `source.facts`). The lines live in
  `templates.json textPools` and `data/games/<id>/posting.json`. A line that needs a missing fact is never used. No line
  repeats within the last 20. Drafts the user has not edited are redrafted once (`source.textVersion` 2).
- PT5 (the post text card in Settings) and PT4 (growth suggestions) are not built yet. They come next.
- Codex fixes (review 2026-11-21). These replace the points above where they differ:
  - One reservation: `withScheduleLock` (`services/posting/auto-chain.mjs`, file `posting/schedule.lock`) covers both
    the chain and "Post now (public)". Each one checks a fresh channel read and the queue inside the lock, and records
    its time in the queue before it lets go. A public post is a queue item. It is `public-uploading` while it is sent,
    and the chain starts no session then. Once sent it is `public-done`, and its start and end times stay taken. If it
    is not sent, the hold is given back.
  - "Post now (public)" reads the channel just before it goes. A read that fails, is refused by the quota or is
    incomplete refuses the click, and nothing is sent. The 60-min check covers now up to the estimated end of the upload.
  - The chain reads the channel just before each new upload session. The pass's first read counts only for the first
    session. `recheckMaxAgeMinutes` is retired. An incomplete read fails closed.
  - The channel read now covers the whole uploads list. The `lookbackDays` stop is gone. Hitting `maxPages` counts as
    incomplete, so nothing is scheduled.
  - Quota: each upload's share now includes one full channel read at its worst (1 + 2 x maxPages = 81 units), so about
    5 a day fit under the unit sum and 24 under the bucket. A quotaExceeded answer blocks uploads until the next Pacific
    midnight (`exhaustedUntil` in `quota-model.json`). Under the fallback, the same day's earlier bucket uploads count
    1,600 units each again. A repeated answer never makes the fallback last longer.
  - Redraft: a draft from before the `editedByUser` marker is redrafted only if its text still exactly matches the old
    template, rendered again with its stored values (`legacyText` in `services/posting/index.mjs`). Any other draft,
    and one whose values cannot be found, is left as it is.
- Second Codex review (2026-11-21). These replace the points above where they differ:
  - "Post now (public)" is removed: the route, the Posts window button, `reservePublicNow`/`finishPublicNow` and the
    `public-uploading`/`public-done` states. No code path sends a video without a publishAt: `uploadVideo` and
    `uploadPost` refuse one with `publish-at-required` before any request.
  - The Upload button and `youtube upload` (CLI) now queue the clip at the next free time and ask for a pass. The
    auto-post chain is the only sender. With auto-post off the button is refused (`auto-post-off`), because nothing would
    send the clip.
  - One upload gate: every upload goes through `sendGated` (`auto-chain.mjs`). It applies the quota budget and records a
    quotaExceeded answer.
  - The whole chain pass runs in one lock hold. Before every new upload session, including the restart of an expired
    one, the chain reads the channel fully and checks the 60-min gap in that hold, with the time taken after the read.
    One read serves one new session. A saved session resumes only after a complete read in the same unreleased hold.
  - A malformed or partial read answer (items missing, an id with no details, no privacy status) counts as incomplete
    and fails closed: nothing is scheduled, the clip waits and no try is used. The read has a 30 s deadline
    (`READ_DEADLINE_MS`). Past it the read is incomplete and the request is aborted.
  - The lock holder writes a heartbeat every 5 s. Another holder takes the lock over only if the holder's process is gone
    or the heartbeat is older than 2 min (`LOCK_STALE_MS`, at least 3 read deadlines). A pass that loses the lock stops.
- Third Codex review (2026-11-21). These replace the points above where they differ:
  - The channel read takes its reference time from the clock after the last page comes back (`readAt`). Every public
    video that went public within the last 2 days counts, including one that went public during the read. The chain
    plans the slots from that later time.
  - A `nextPageToken` that is present but not a non-empty string, and a public video with a missing or invalid
    `videoPublishedAt`, make the read incomplete (fail closed). Only an absent token ends the list.
  - Lock takeover is atomic. The contender renames the stale lock file to a unique tombstone (only one rename can win).
    It then compares the tombstone with the exact content it judged stale, and only then deletes it. A file that does
    not match is put back with an exclusive create, never over a new lock. Release uses the same compare-before-delete
    step. The heartbeat only refreshes an existing file and never re-creates one.
  - Ownership (`hold.held()`) is checked after every channel read, right before any session starts or resumes, in
    `beforeNewSession` (including the expired-session restart) before and after its read, and before every chunk.
  - Every YouTube request has a deadline: the session start, the progress query and the thumbnail each get
    `REQUEST_MS` (60 s). Each chunk gets `CHUNK_REQUEST_MS` (10 min), on top of the scheduled chunk deadline. A request
    past its deadline fails that item for this pass with `request-timeout`. No try is used, the session is kept, and the
    item waits 5 min.
  - The whole lock hold is capped (`LOCK_MAX_HOLD_MS`, 60 min). At the cap the hold's requests are aborted, `held()`
    turns false, the lock file is released and the pass ends. The item in flight waits with `request-timeout`.
- Fourth Codex review (2026-11-21). These replace the points above where they differ:
  - One sender by design. The studio's posting chain (`createPostChain`, started once by
    `services/studio-ui/launch.mjs`) is the only code that starts upload sessions or sends chunks. `uploadPost` has no
    other caller. `cli.mjs youtube upload`, the Upload button and "Run auto-post now" only queue the clip and write the
    run-now request file (already so since the second review; checked again).
  - Inside that process an in-process mutex per lock file serialises passes. A second pass waits up to `waitMs`, then
    waits with `schedule-busy` (no try used).
  - The lock file stays only as a guard against a second sender process. A lock that is present and not provably ours
    is never taken over: the pass refuses with `sender-elsewhere`, and the task area says in plain words that another
    copy of Ujwalam holds the posting lock. The one exception is a lock whose process has ended, or this process's own
    leftover. Only the process that will then hold it removes it, under an exclusive claim file for that exact lock,
    followed by an exclusive create. Any failure on that path refuses. The tombstone rename, the heartbeat and
    `LOCK_STALE_MS` are gone.
  - The launcher has no single-instance guard (searched `launch.mjs` and the repo, 2026-11-21). A second studio on the
    same data folder is therefore refused by the file lock, not prevented from starting.
  - Every YouTube request, including the read of its answer's body, has one deadline (`timedFetch` with a `read`
    step): the session start, the progress query, every chunk, the cover and the status check (`checkUploadStatus`,
    which had none).
  - The chunk deadline is no longer a fixed 10 min. It is the chunk's size at the slower of the floor speed
    (`fallbackKbps` in `data/posting/schedule.json`) and the slowest chunk measured, plus `REQUEST_MS` (`chunkTimeoutMs`).
    A chunk that times out after Google has received more bytes resumes from Google's count with no try used. With no
    progress the item waits (`request-timeout`, no try used, session kept).
- Fifth Codex review (2026-11-21). These replace the points above where they differ:
  - The lock and the claim record their owner's pid and process start time. An owner is dead when its pid is gone,
    or when the pid now belongs to a process with another start time (pid reused; 5 s slack). A live pid whose start
    time cannot be read counts as not dead.
  - A crash between the claim and the exclusive create leaves a claim behind. If the claimant and the lock's holder
    are both dead, the pass still refuses, and the notice says a closed copy left its posting lock behind. Settings >
    Posting & growth > Auto-post then shows "Clear stuck posting lock" (one click, no confirm, D332). The click checks
    again that both files are the same ones with dead owners, removes the lock and then its claim, and asks for a pass.
    Nothing is removed automatically. A live claimant or a live lock holder is never cleared.
  - Sixth Codex review: taking the lock refuses whenever ANY claim file for it exists, even with the lock file
    absent. The clear runs in the in-process mutex. It re-verifies, then removes the lock only if it still has the
    exact verified content (otherwise nothing else is removed), and removes the claim LAST. A stuck lock is also one
    whose claim is dead and whose lock file is already gone. The click's id names both files as seen, so a click made
    on an older view is refused. A claim holding only a number (7b5c7ec format) reads as { pid, start unknown }: pid
    gone = dead, pid alive = alive.
  - Seventh Codex review: "stuck" is one general rule with no token matching. At least one claim file exists, every
    claim's claimant is dead, and the lock file is absent or held by a dead owner. The click id lists every claim name
    and the lock token as seen. The clear (in the mutex) re-verifies that same set, deletes the lock only if its content
    still matches, then deletes each dead claim last. Every crash point of the dead-lock replacement is therefore either
    sendable or offers Clear.
  - Eighth Codex review: the lock and the claim are created whole or not at all. The content goes to a unique temp file
    in the same folder (`<name>.<pid>.<rand>.tmp`), is fsynced, then hard-linked to the target (atomic and exclusive;
    EEXIST = lost); the temp is removed. The lock logic ignores `*.tmp`, and the chain removes such temp files older
    than 10 min when it starts. Files from older builds or other torn writes: an empty or unparseable claim or lock
    older than 60 s (`TORN_DEAD_MS`) counts as dead-owned, so the general stuck rule offers Clear (a torn lock with no
    claim included). Younger than 60 s counts as alive (wait).
  - Known item: the studio has no single-instance guard. A second studio's chain refuses through the lock
    (`sender-elsewhere`); it is not stopped from starting.

## D410 — Posting PT5 and PT4 as built (decided, 2026-11-21)

As built from D408 and `docs/plan/2026-11-21-posting-text-schedule-growth.md`. Evidence:
`docs/evidence/2026-11-21-posting-text-schedule-growth.md`. Nothing in D409 is weakened: the 60-minute floor, the
fail-closed channel reads, the single sender, the lock and publishAt on every upload are unchanged.

- PT5: Settings > Posting & growth gains a card "Post text and growth" next to the Auto-post card, with the same
  Save / Discard. The posts a day, window, gap (60 to 1440, floor 60), days off and "Run auto-post now" were already on
  the Auto-post card and stay there. New: tone (hype or clean), emoji on or off, the user's own hashtags (up to 10),
  a description footer (up to 500 characters), a preview on the three newest clips (read only), the share of each kind
  (whole percent, must add up to 100), growth suggestions on or off, and a line that says which quota model is in use
  and why.
- The settings live in `<data>/posting/prefs.json` (`services/posting/post-prefs.mjs`), next to the other posting
  settings, so they survive updates. Routes: `GET/POST /ui/api/posts/prefs` and `POST /ui/api/posts/prefs/preview`
  (read only). No new flag: the card is part of the posting flag, and growth suggestions are on by default.
- The defaults change no text: tone hype keeps the drafted lines as written and emoji are off by default. Clean replaces
  "!" and never adds an emoji. With hype and emoji on, one emoji per kind (`data/posting/text-style.json`) is added at
  the end of the title, only when it still fits the title limit. The prefs apply when a clip is packaged
  (`packageUploads`, `packageRun`); posts already made keep their text.
- Kind shares change only the order inside the daily cap (`mixOrder`), never the count or the gap. A learned RP5 mix
  wins when one is in use. Even shares (the default) keep the order exactly as before.
- PT4: `services/analytics/timing.mjs` reads the AN1 numbers already stored (`view()`: 24 h and 7 d checkpoints, views,
  averageViewPercentage, subscribersGained). No new scope and no Google request. It groups them by local time band,
  weekday and kind. With at least 8 posts that have a 24 h number, it proposes one change: the best band (at least 3
  posts and at least 10 % more 24 h views than the other posts), for example "Move 2 of your daily posts to
  18:00-21:00: +34 % 24 h views on 12 posts." Limits are in `data/posting/growth-timing.json` with source and date.
- The proposal is a record (`<data>/posting/growth-suggestion.json`) shown in the Posts window with Apply and Dismiss.
  Apply writes the user's schedule settings as placement custom (the same times each weekday), checked with the strict
  60-minute floor. It keeps the earlier file for Undo and logs to `growth-log.jsonl`. Undo puts the file back byte for
  byte. It refuses when the schedule was changed after Apply, so a later change is never overwritten. Dismiss hides the
  same proposal for 7 days.
- Exploration: at most 1 in 5 of the day's slots (rounded down; the config refuses more than 0.2) go to a band outside
  the best one. The band is picked by Thompson sampling as in RP5, using `betaDraw` and `seededRng` from
  `services/learning/mix.mjs`.
- UNVERIFIED: "24 h views" is the first stored fetch at least 24 h after the video went public, so it can be later than
  24 h. Viewer activity by hour is not read, because the report was not checked. The Analytics numbers arrive a day or
  two late.

### D410 addendum — Codex review of PT5/PT4 fixed (2026-11-21)

- Apply order: the record is saved first as `applying` (whole file as it was, the text to write, fsync and rename), then the schedule is replaced, then the record becomes `applied`. A stop in between is recovered on the next read: schedule unchanged means back to open; schedule written means applied with Undo offered.
- Each weekday keeps its own post count (a day with 0 stays 0). A proposal is refused (`no-room`) unless every slot fits with the gap, across midnight and into the next weekday too.
- Exploration (at most 1 in 5) is checked on the actual proposed times.
- The proposal stores a fingerprint of the schedule file it was made from. Apply refuses in plain words when the file changed since, and asks for a fresh suggestion.
- Own hashtags: #Shorts is refused. Footer: control characters refused (same rule as the post editor). Each emoji, footer and own hashtag is added only if the composed text still passes data/posting/limits.json (`limitsFit`); otherwise it is left out.
- The Apply text says what it replaces: "Replaces your random 3-6 a day with fixed times ... (Undo keeps your old schedule)."

## D411 — Clip look FX1-FX4 as built (decided, 2026-11-21)

User 2026-11-20: start/end music and transitions felt "unpleasant, low quality and dated"; the name card sat in the centre and blurred the gameplay; wanted more options while making clips and randomising from ticks in Settings. Built on branch claude/clip-look (not merged):

- **FX1 clip look** (`services/clip/clip_look.py`, `data/clip/look.json`, flag `clip-look`, ON): each reel gets one seeded pick of music mode, transition set and name style from the user's ticks in `settings.json` clips.look. Lock = always that style; randomise off = first tick; no ticks = that part off; no repeat of the last pick per group while another tick is free (history in `<data>/clips/look-history.json`).
- **FX2 name styles** (`services/clip/reel_title.py`, `data/clip/title.json` v2): lower third, corner tag, kinetic text reveal, drawn by libass (ASS `subtitles` filter), no blur or darkening. Entrances 233-250 ms, exits 217-267 ms (measured). The RP4 centre card is retired: an old record restyles to kinetic.
- **FX3 transition sets** (`services/clip/reel_transition.py` plan_set/beat_sync, `services/clip/reel_sfx.py`, `data/clip/transitions.json`): Punchy, Cinematic and Clean, with a kind per join (never the same twice in a row). Join sounds are made on this PC with numpy. Flash joins are at least 1 s apart, so the measured rate stays at or below 1.5 flashes/s (the limit is 3/s). Beat sync only moves a join earlier, by at most 0.25 s.
- **FX4 music library** (`services/clip/music_library.py`, `data/clip/music-library.json`): tracks come from the user's music folder, analysed off air with PyAV and numpy (tempo, beats, energy, drop, LUFS and a guessed mood that the user can change). Tracks are matched to the reel's energy and mood, seeded, and none of the last 3 repeats. Modes: intro-outro, drop (the track's drop lands on the strongest moment) and full-bed, at -16 LUFS by default (range -24 to -10). With no fitting track, the made-here bed (`reel_music`) is used. The game sound ducks the music, and audio is still encoded once.
- **Settings > Clips > Clip look** (QML) holds ticks per group, the mixing switch, "Always use" locks, the music folder and level, the join sounds and beat sync, and the name size and duration, all saved with Save/Discard. `user-settings.mjs` lookProblems mirrors the Python rules; both run `tests/fixtures/clip-look-cases.json`.
- **Per-clip choice** in "Make clips?": music, transitions and name can be set for that recording only ("As in Settings" by default). The choice is not saved. Path: answer.json, then job.look, then `UJWALAM_CLIP_LOOK`.
- Long video is unchanged: it keeps the cross fade or cut.
- Not started (each needs the user's yes): FX5 free music pack download and FX6 ACE-Step generation.
- Unverified: the look on real footage, NVENC renders (tests used the CPU encoder), the mood guess on real tracks, and HUD avoidance for corner and lower-third placement. Also: the logo is not drawn yet, and "theme" colour uses the fixed accent from title.json.
Evidence: `docs/evidence/2026-11-21-clip-look-fx1-fx4.md`.

**Codex review addendum (2026-11-21), all fixed with a test each:**

- Music folder: links, junctions and other reparse points are not followed. Each file's resolved path is checked against the resolved folder right before it is opened (analyse and render). The cache key is now path + size + `st_mtime_ns` + a hash of the first and last 64 KiB.
- Mix: game, music and join sounds go into one final limiter at -4 dBFS, run 4x oversampled (attack 20 ms, release 400 ms), in the one audio encode. The game keeps its level. Coincident full-scale peaks measured -2.5 dBTP after AAC.
- Timeline: flash spacing is checked again after beat sync trims (`respace`). Captions are made on the cross-faded timeline (`reel_captions.retime`), so reels with captions keep their transitions, join sounds and beat sync (live review and montage).
- Short tracks: drop and full-bed prefer a track as long as the reel. Otherwise the track loops on whole bars with a crossfade on the beat. No silence.
- Recaption keeps the folder track's plan. If the track is gone, the made-here bed is used and render.json says so (`fallback`, `was`).
- Switches: each part of the look obeys its own switch: music = `reel-music`, transitions = `reel-transitions`, name = `clip-look`. So that the music and transitions the user asked for are not lost, `reel-music` and `reel-transitions` are now ON by default (as `clip-look` already was).
- `--resume`: a kept reel keeps its stored row (look, music, transitions). Only newly rendered reels change the pick history.
- Analysis memory: FFT in batches of 256 frames, autocorrelation only over the BPM lags, mono decode, a 20 s loudness guide. A 240 s track peaks at 119 MB (traced).

**Codex verify addendum (2026-11-21):** six items were verified fixed. Two more were fixed, each with a test:
- A drop segment that starts past the loop end now starts at the same place inside the loop, so the bed is always full length. Test: a drop late in a short looped track has no gap.
- Each reel's row is saved to render.json (temp + rename) as soon as the reel is done, together with the stored rows of reels not reached yet. On `--resume`, a reel file without its row is rendered again with this run's decisions; it is never kept with guessed ones. Test: a montage run stopped after its reel loop keeps the row; resuming keeps it; with the row removed, the reel is rendered again.

Accepted residuals (not fixed): (a) a check-then-open race in the user's own music folder needs a local process actively swapping links, and such a process already runs with the user's rights; (b) a cache-key collision needs a same-size edit in the middle of the file plus a deliberately restored `mtime_ns`.

**Codex verify 2 (2026-11-21):** resume trusts a row only when it belongs to the reel file next to it. Each row stores `fileStamp` (the file's size and mtime in ns), and `--resume` keeps a reel only when the stamp matches the file. Before a reel renders, render.json is saved with that reel's old row removed. So an old row can never be paired with a newer file: not after a stop between the rename and the row, not when a fresh run renders over an earlier one, and not with an older row that has no stamp.

## D412 — Reel styles RS1-RS4 as built (decided, 2026-11-21)

User 2026-11-20: build a library of reel styles from example reels the user likes and use them on Ujwalam's own clips. Built on branch claude/reel-styles (not merged). Flag `reel-styles` is ON by default (the user asked for the feature).

- **RS1 analyser** (`services/clip/style_analyse.py`, `data/clip/reel-styles.json`): decodes each example at low resolution with PyAV and measures, with OpenCV: cuts (HSV histogram distance, 1 frame for hard cuts, 8 frames for gradual ones), the kind of each join (hard, fade, flash, whip), shot lengths, zoom pulses and speed ramps (tracked points with a scale and shift fit; overlays that stay still are left out of the fit), where on-screen text sits and for how long (RapidOCR, models already on the PC; the text itself is never stored), colour (Lab averages and contrast), and the music (tempo, energy and mood from `music_library`, with our own beat phase). Only numbers are kept. A 60 s 540x960 example takes about 63 s and peaks at about 217 MB on the CPU (bound: 150 s, 800 MB). It runs off air only, one at a time, at lower priority.
- **RS2 record and mapping** (`services/clip/reel_style.py`, schema `data/clip/reel-style.schema.json`): `<data>/clips/styles/<id>/style.json` v1 holds the example paths and SHA-256 (the videos are never copied), the measured numbers with their spread, the parts that could not be measured (with the reason) and the mapped style. The style is mapped onto Ujwalam's own effects: the pace, beat cuts, a transition mix close to a D411 set, the new core functions `zoom-pulse` and `speed-ramp` (registry, 2 presets each), the name style, a 17^3 LUT fitted against the user's own clip (capped: L ±12, a/b ±15, contrast 0.8-1.25) and the music energy target. Every mapped value can be tuned (seconds per shot, colour strength, zoom size, slow motion speed, music energy).
- **RS3 Settings > Clips > Reel styles** (QML card, `services/studio-ui/reel-styles.mjs`, `GET/POST /ui/api/reel-styles`): add a style (a name and full paths to the example videos), Analyse (off air; progress in the task area and on the card), the measured style in plain words plus what was left out, sliders with their own Save / Discard, "Preview on my clip" (the colour and zoom pulses on one of the user's clips, CPU, 540 px wide; pace, joins and music show on a whole reel) and a style per reel type (reels, impact plays, kill montages) saved with the dialog's Save. "Join the mix" lets a style take part in the D411 randomise. The rules live in Python only; Node checks only the shape. `clips.reelStyles` = `{ byType: { reel|impact|montage: id|null }, pool: [id] }`.
- **RS4 clipper** (`services/clip/clipper.py` `_style_pick`, `_style_render_plan`, `_reel_timeline(style=)`): each montage-loop reel (kill montage, won-match reel, impact play) gets its type's style, or a seeded pick with the pool while the clip look mixes. It applies the pace (long pieces cut into shots of the style's length; a kill is never cut through, and the first kill keeps room for its speed ramp), the style's joins (mostly hard cuts = cuts), zoom pulses on the kills away from the joins, one speed ramp on the first kill that fits (none under captions), the name style (only while the name part is on), the music energy target and the LUT (lut3d once in the graph, after the joins). The D411 limiter and the single audio encode are unchanged. With no style chosen, or the flag off, every reel is made exactly as before (same objects, same command line). Live clips (`live-clip`, the reel style) take it too, a single piece included: a styled live clip always renders through the pieces path.
- Unverified: everything on real footage and real example reels (all tests use synthetic videos); speed-ramp detection on real slow motion; the text position on real overlays; NVENC renders (tests used libopenh264 on the CPU because the studio was open); a cross dissolve or a fade between very different brightness can read as a flash; on fully saturated colours the LUT's gamut clipping moves `a` by up to about 4.
- **Codex review fixes (2026-11-21):** (1) analysis and preview are watched while they run: the studio reads `outputs.status` every 2 s and a stream or recording that starts ends the whole process tree (`killChildTree`, the `isLive`/`isRecording` rule record-clips uses for the D406 long video), and the analyser asks `clip_common.on_air()` every 90 frames and stops (unknown counts as on air); (2) example paths must be regular files on this PC's own fixed drive with no link on the way: network and device paths (`\\server`, `\\?\UNC`, `\\.\`, `\\?\`), mapped network, removable and virtual drives (`GetDriveTypeW`), links, junctions and other reparse points are refused, checked again right before each open in analysis and preview; (3) length (90 s) and size (500 MB) come from the container before any decode; the decode is capped in frames, wall-clock time (600 s per example) and memory (1500 MB), and the SHA-256 is bounded and stoppable too; (4) every loaded record is checked against `reel-style.schema.json` (stdlib checker, finite numbers only) and runtime limits (slow motion speed above 0 and in the tune range, zoom in < 600 ms and out < 400 ms, shot length in range); a broken record is never selectable and its card says why in plain words; (5) live clips use the style (above); (6) the preview goes to `%TEMP%\ujwalam-reel-style-preview` (never inside the style library), replaces the last one, and the folder is emptied when the studio starts and closes.
- **Codex verify fixes (2026-11-21):** (1) the guard runs on every decoded frame before any is skipped (a counter and a clock read each frame; on air and memory every 90 frames), capped at 240 decoded frames per second of the probed length, so crowded or repeated timestamps cannot bypass it; (2) examples open with the demuxer named from the extension only (mp4/mov/m4v = `mov`, mkv/webm = `matroska`; anything else refused), `protocol_whitelist=file` and mov `enable_drefs=0`, also for the sound pass (`music_library.decode(open_kw=)`); a playlist, concat list or other container under a video name is refused and opens no other file. Accepted residual, as D411's music folder: the file could be swapped between the path check and the open; (3) non-canvas live layouts (crop, fill, stack) render one piece of the save through their own geometry: they get the style's colour (LUT) only, and the clip row records `styleNotApplied` per layout in plain words ("style not applied: <layout> (... gets the colour only; pace, joins, zoom pulses and slow motion need the canvas layout)").
- **Codex verify, last two (2026-11-21):** (1) the studio has no per-clip row view; the clip notes reach the user through the Clips chip's tip (Store.qml clipsTipWords): record-clips reads the finished job's `render.json` clips (`clipStyles`), the server passes `last.styles { names, notApplied }` (capped, strings only), and the tip adds "Reel style: <name>" and each "Style not applied: <layout> (...)" line. The chip text itself does not change (no layout jump); (2) the sound passes (`music_library.decode` / `analyse`, optional `guard=None` for every other caller) tick the same guard per decoded sound frame (clock each frame; on air and memory every 90), with their own frame cap (400 sound frames per probed second, `guard.maxAudioFramesPerSec`) and the shared clock; a guard stop (`GuardStop`) is never swallowed as "no usable sound".
Evidence: `docs/evidence/2026-11-21-reel-styles-library.md`.

## D413 — BeatDrop montages plan approved, with the user's answers (decided, 2026-11-21)

The user approved `docs/plan/2026-11-21-beatdrop-montages.md` (BD1-BD7, LV1, RR1) on 2026-11-21 with these answers:

1. **Clean gameplay track: yes.** The capture-card source is recorded clean (no overlays, full 16:9 frame) next to the stream recording, for montages. It is a setting, ON. The disk use per hour is measured and shown.
2. **Music: an NCS library.** The user builds a local folder of NCS (NoCopyrightSounds) tracks. Ujwalam picks a random track (seeded, no repeat of the last few) and cuts the montage to it. Settings > Clips gets "Montage music": the folder, random or a fixed track, and the credit line. NCS's usage policy (ncs.io/usage-policy, read 2026-11-21) allows use on YouTube and Twitch, monetised, if the artist and song are credited in the description. So every post with an NCS track gets the credit added to its description automatically, from the track's credit record (artist, title, the NCS line; read from the file's tags or name, and editable). A post is never sent without its credit. Montages with a commercial song from any other folder are rendered only and never auto-posted. A Content ID claim on an NCS track is UNVERIFIED but possible: the posting chain notes any claim it sees and keeps the clip.
3. **Fonts: yes** to downloading two or three open-licence (OFL) display fonts. Each font is named with its licence before it is used, and recorded in `docs/licence-headers.md`.
4. **Match Replay check:** the user opens a replay when asked and answers with one word (see the plan, section 6.4). BD6 waits for that word.
5. **Order: yes.** BD1-BD3 and BD4 first, then BD5, BD7, LV1 and RR1, and BD6 after the replay answer.

## D414 — BeatDrop BD1 moment finder, BD2 song map and the NCS montage music library as built (decided, 2026-11-21)

Built on branch `claude/beatdrop-bd1` (not merged, not pushed). Evidence: `docs/evidence/2026-11-21-beatdrop-bd1-bd2.md`.

1. **BD1** `services/clip/moments.py`: gunshots (1-6 kHz spectral flux confirmed by a muzzle flash within 2 frames), hits and kills (kill time = first hit-marker frame), scope in/out, flicks, slides/jumps, third person. Game numbers are data in `data/games/codm/moments.json` with a schema. Off air only, guarded decode, BelowNormal, one job at a time, CPU. Synthetic fixture: every moment exact except third person (1 frame late).
2. **BD2** `services/clip/song_map.py`: beat grid, downbeats, sections, drops, transients as JSON numbers. Synthetic tracks: worst beat error 1.6 ms (limit 20 ms), drops within 1 ms.
3. **Montage music** (D413 item 2): Settings > Clips "Montage music", ON by default: a local folder, random (seeded, no repeat of the last 3 by default) or a fixed track, editable per-track credits under the data root. Posting adds the credit to the description; a library track without a complete credit is never packaged, approved or uploaded (fail closed, plain reason); a song from elsewhere is render only.
4. UNVERIFIED: real-footage and real-track accuracy, Content ID behaviour on NCS tracks, detector weights not yet used, the card not yet seen by the user in the running studio.
5. Codex review fixes (same day): music provenance comes from the render's own record (render.json clip `music`, carried into uploads.json and a `<video>.music.json` sidecar for the clips-folder scan); a montage whose music is unknown is not posted, a song from the D411 music folder is render only, made-here music posts as before. Song map: required local fixed-drive music folder, extension-named demuxer with the file protocol only, and the style guard through the whole job. Montage-music credits are keyed by the track's identity (size + SHA-256 of its first MB); a changed file loses its typed credit and needs review; the folder is read off air only, with the safe open. One heavy-job lock (clip_common.HeavyJobLock) for the detector pass, the moment finder and the song map.
6. Clips without a music record, every kind alike (montage, won-match reel, impact play, live clip; coordinator rule, same day): a clip rendered before records were kept counts as made here and posts as before only when the Clip look music folder (D411) was never set and no montage-music library track was ever picked (no pick history file); otherwise it is held as music-unknown with the reason "re-render to post: the song's source is not known". New renders always write a record: render.json carries `musicRecords: 1`, plain variants write `music: null`, and a clip entry without a record in such a render, or a record of an unknown shape, becomes `{source: unknown}` and is held (fail closed).
7. Codex verify fixes (same day): (a) the legacy pass of item 6 also needs the clip to be older than the provenance start, `<data>/clips/music-provenance.json` `since`, written once (temp file + fsync + link, first writer wins) by the first posting run, clipper run or publish step of this code and never moved; a clip's time is the later of its file's creation and change times; a newer clip with no record is held. (b) A montage-music track's identity is its size + the SHA-256 of the whole file, off air only, at most 200 MB and 30 s per file, stopped when a stream starts, cached by path + size + mtime_ns in `clips/montage-music/identity.json`; ids from the first-MB rule (this branch only, never shipped) are not carried over. (c) The heavy-job lock record is written to a temp file, flushed and linked into place; a lock is stale only when its pid is dead or was reused (process start time differs) or it has no readable record and is older than 60 s; a stale lock is moved aside and checked before it is dropped. (d) Manual run packaging (`cli.mjs package --run`, the auto chain's run step) goes through the same provenance + credit gate from the run's render.json; every package records `source.music` ({checked: 1, use: post|credit, library, trackId}) and approve and upload check it again; a package without it made after the provenance start is refused (`music-unchecked`), older packages pass as before. (e) The `<video>.music.json` sidecar carries the video's size and the SHA-256 of its first and last MiB; a missing or different binding reads as unknown (held). Residual, accepted: the data folder is the user's own, so someone with write access to it can rewrite both the video and its sidecar (the same trust as uploads.json). (f) The long-video render.json sets `musicRecords: 1` and `music: null` (it adds no music).
8. Second Codex verify (same day): (a) the heavy-job lock is an OS-held lock on a lock file that is never deleted (msvcrt.locking LK_NBLCK on a byte past the owner text on Windows, fcntl.flock LOCK_EX|LOCK_NB elsewhere), held for the job's life and freed by the kernel when the process ends; item 7(c)'s pid, start-time, torn and 60 s rules are gone. The pid, job and time written after locking are for the busy message only. (b) uploads.json rows carry the same video binding as the sidecar (size + SHA-256 of the first and last MiB). A row is trusted only while its binding matches the file, both in the clips-folder scan and when packaging straight from uploads.json. A row that does not match, or has no binding while the file is newer than the provenance start, is ignored; the sidecar decides, and no valid sidecar means unknown (held).
9. Third Codex verify (same day): (a) every music field of a clip (the record and any older `montageMusic` credit) comes only from a trusted source (`trustedRow` in clips-source.mjs). A row that does not describe its video contributes nothing, so a replaced video never inherits the row's old credit. A replacement with another library track waits for that track's own credit. (b) The auto-post folder scan runs only when no stream and no recording is active (unknown counts as active). Video bindings are cached by path + size + mtime_ns, so each file is hashed once while it stays the same.

## D415 — BeatDrop BD3 beat-locked planner and BD4 effects as built (decided, 2026-11-21)

Evidence: `docs/evidence/2026-11-21-beatdrop-bd3-bd4.md`. Plan: `docs/plan/2026-11-21-beatdrop-montages.md` sections 1.3, 5 (BD3, BD4) and 7.

1. **BD3 planner** `services/clip/beatdrop.py`: BD1 moments + a BD2 song map + an optional reel style (its mapped `cuts`: shotSec, ratePerMin, beatShare; else the defaults in `data/clip/beatdrop.json`) make a plan (data, schema `data/schemas/beatdrop-plan.schema.json`): cold open of calm pieces (third person, scope, any stretch with no kill or gunshot) cut on downbeats only and slowed, a title slot over the intro's last bars, the strongest kill exactly on the first drop, kills and gunshots on beats, flicks/slides/jumps on off-beats (share from the beat share), breakdowns as calm slow pieces with letterbox, an outro with hero and credits slots (title, hero and credits are empty placeholders for BD5). Game numbers (anchor kinds, calm kinds, the no-kill margin) are data in `data/games/codm/beatdrop.json` (unverified).
2. **Retiming**: every piece is a whole number of 60 fps output frames between beat-grid frames (exact joins, no drift); an anchored piece's source is placed so its moment frame lands on its beat frame, at speed 1 or slowed, never outside 0.5x-2x (otherwise the next moment is tried). Ragdoll slow motion (speed-ramp) starts at the kill frame, so the kill stays on its beat.
3. **Render path extended, not forked**: `clip_montage.render_argv` takes per piece `speed`, `outFrames` and `game` {gain, keep} (the game ducked under the music with full-level cut-outs around each gunshot and kill), `music.duck: None` (the bed mixed without the sidechain) and `fx` (the BD4 graph, once, after zoom and lut). Calls without these keys are unchanged. Still one audio encode with the D411 limiter. The long BeatDrop graph is passed with `-/filter_complex <file>` (Windows command-line limit).
4. **Music**: the NCS library pick (`montage_music.pick`, seeded, no repeat of the last N) when Settings > Clips > Montage music is on with a folder; else the made-here bed (reel_music) mapped by BD2. The clip entry in render.json always carries the music record (`musicRecords: 1`).
5. **Wiring**: `clipper.py beatdrop` (its own montage kind, `DIR/beatdrop/`), flag `beatdrop`, ON by default (user request 2026-11-21); off makes nothing and other reels are unchanged either way. Progress lines use the existing `montage` stage.
6. **BD4 core functions** (registry, 2 presets each, similar tags): `scope-zoom-transition`, `whip-pan` (6-10 frames), `impact-flash` (re-spaced on the final timeline: at least 0.34 s apart and at most 3 in any second, else a colour pulse), `rgb-split`, `shot-shake`, `letterbox` (in under 600 ms, out under 400 ms), `ragdoll-slowmo` (speed-ramp + zoom pulse), `bloom-grade` (glow + the reel style's LUT, lut3d once). Format post-render; params clamped to the manifests' safe ranges. The bundled LGPL ffmpeg has no `eq`, so saturation uses `hue=s`.
7. Measured on synthetic fixtures (evidence file): 48 of 48 rendered kills within one frame of a beat, first kill on the first drop (0.0 ms), montage flash peak 2.5/s (limit 3), one audio stream, NCS record in render.json. UNVERIFIED: real footage, real tracks, the look of the effects to the user, Content ID on NCS tracks; no studio UI for BeatDrop yet; posting does not pick up `DIR/beatdrop/` yet (no candidates.json).
8. **Codex review fixes (2026-11-21)**:
   - **Cut flashes**: the planner probes the mean relative luminance (WCAG, as flash-detect.mjs) at each cut edge (one small seek per edge, cached in `beatdrop-luma.json`). A jump of `flash.cutDelta` (0.1, darker side below 0.8) is a flash in the same 3/s budget: cuts always count, impact flashes near them become pulses, and a cut that is itself over budget gets a 3-frame luma-matched dissolve (`cut-soften`, a safety element, not a registry effect). The plan lists these cuts in `cuts`. After the render, `make()` measures the file with the fx-test analyser. Above the limit, or when it cannot be measured, the render is failed with the reason and the file is removed, never published.
   - **On-air guard during the render**: `clip_common.run_tool(stop=)` (new, `STOPPED_RC`) asks `live()` every poll (unknown counts as on air) and kills ffmpeg. The job ends `stopped: on air` with the part file removed. `clipper.py beatdrop` writes no render.json and exits 4 (`EXIT_ON_AIR`), so the job runs again later.
   - **The first drop wins**: `coldOpen.minSec` is a soft target. An earlier drop shortens the cold open (plan `log`). A drop earlier than `coldOpen.minBars` (2 bars) is recorded as `firstDropMissed` {at, reason} in the plan and the log. The kill then goes on the next drop (`song.dropAt`), and `song.firstDrop` is null, never relabelled.
   - **Lead-ins**: an anchored piece's source holds no other kill (either side), and no gunshot before the anchor beyond the no-kill margin. A piece that is too short at 0.5x moves on to the next moment.
9. **Codex verify of 416127e (2026-11-21)**: the flash budget and first-drop fixes were accepted. Accepted residual, not changed: gunshots within `noKillMarginSec` (0.6 s) before the anchor stay in the lead-in, because they are that kill's own burst. Fixed:
   - **Exit race**: `run_tool(stop=)` checks `stop()` once more after the child exits. On air (or unknown, as the caller's `stop()` decides) returns `STOPPED_RC` and discards the output.
   - **Every child guarded**: each brightness probe (now written to a temp file, read back, and removed) and the node flash check run through `run_tool` with the job's `stop`. `live()` is also checked between steps (after the music pick, after the song map, after planning, before and after the flash check). Any stop ends the whole job `stopped: on air`, clipper exits 4, and nothing is published (part files removed).
   - **Round 3 (Codex verify of c370e5c)**: `run_tool` puts every child in a kill-on-close job (`kill_on_close_job`) and ends the whole job on every stop path (stop, stall, timeout, exit), so node's ffmpeg dies with node. Both sweeps and the on-air cleanup now run inside `make()` while holding the heavy-job lock. clipper hands `make()` its render.json path and a `write_render` callback, which runs inside the lock before the old video is swept. A sweep matches only this code's own names, exactly `beatdrop-<12 hex>.mp4` and `.mp4.part` in its own folder, and never a file render.json references. The on-air cleanup removes only this run's own part file and probe file.
   - **Round 4 (Codex verify of d82c605)**: every `run_tool` child, guarded or not, starts suspended on Windows, joins its kill-on-close job and only then resumes, so nothing it starts escapes. If Windows refuses the job, a guarded run runs nothing and returns `NO_JOB_RC`. On other systems the child gets its own session and the whole group is killed. An unreadable or non-render render.json makes the sweep remove nothing, and this is logged (fail closed). The sweep also matches the 10-hex names of c370e5c.
   - **Round 5 (Codex verify of 629819c)**: there is no job-less path: if Windows refuses the job, every `run_tool` run, guarded or not, runs nothing and returns `NO_JOB_RC`. On POSIX the process group is killed after every exit, a normal exit included. Each wait is capped by the time left, and a child that ends after the deadline counts as timed out. `referenced()` returns an empty set only when render.json is absent. Any other read error, or a document that is not a full BeatDrop render.json, makes the sweep remove nothing. `NO_JOB_RC` makes the job end "not started": nothing is written or swept, the previous video stays, and clipper exits `EXIT_NOT_STARTED` (5), so the job runs again later.
   - **Round 6 (Codex verify of 53db411)**: the sweep needs positive evidence. It removes one of its own videos only when render.json names a different beatdrop video that exists, or a .part file when there is no render.json at all. Any other render.json removes nothing. The orphan sweep runs only after the render child has started. ffprobe (media_info) maps `NO_JOB_RC` to "not started", so clipper exits 5 and writes nothing. `host_running` treats an unknown tasklist result as running, so the work stays on the CPU.
   - **Video and record stay paired**: each render writes a new name, `beatdrop-<id>.mp4` (a hash of the plan, the music record and the time). render.json is written atomically pointing at it with its music record, and only then are the older videos removed (`beatdrop.sweep_videos`). Before each run, videos that render.json does not point at (crash orphans) are swept, so they are never published.

## D416 — BeatDrop BD5 titles, pin, hero and credits as built (decided, 2026-11-21)

Evidence: `docs/evidence/2026-11-21-beatdrop-bd5.md`. Plan: `docs/plan/2026-11-21-beatdrop-montages.md` sections 1, 3 and 5 (BD5).

1. **Slots filled** by `services/clip/beatdrop_titles.py` after planning: title ("<brand> presents" on the title slot's first downbeat, the song title from the intro's last downbeat to the drop), hero (player name, `hero-bw` black and white with a slow push-in that eases back), credits (the music record's credit exactly as `montage_music.credit_text` gives it, then the data lines). Brand and player from `data/profile.local.json` at run time; a missing or placeholder value leaves its line out (logged).
2. **Drawn in the one montage render**: an ASS file burned by libass after the BD4 effects, one event per output frame (10 ms edges map one-to-one onto 60 fps frames). Fonts only from the OFL set in data/fonts. Entrances under 600 ms, exits under 400 ms (checked on load and measured on the rendered frames).
3. **Pin**: the title tracked onto a flat surface per covered piece (OpenCV corners, pyramidal Lucas-Kanade with forward-backward check, RANSAC homography, CPU, low resolution, frame budget, on-air check between frames). Low confidence, a decode short, the budget used up, or a moving effect (zoom, slide, shake, hero push) under the title gives the screen-space title and a plan log line.
4. **Credits fit**: each credit line is wrapped to 92 % of the frame width (measured with the credit font's own advance widths through Pillow; a link is cut where it still fits), the size lowered only when the rows would pass 96 % of the height. Every character stays visible on H and V.
5. **Cleanup**: one try/finally from the music bed through the render removes the bed, LUT, graph and title files on any error.
6. Registry: `title-extrude`, `title-pin`, `hero-bw`, `credits-roll` with 5 presets. UNVERIFIED: real footage and replays, the look to the user, NVENC with titles.

## D418 — BeatDrop BD7a retakes, summary and the V cut as built (decided, 2026-11-21)

Evidence: `docs/evidence/2026-11-21-beatdrop-bd7a.md`. Plan: `docs/plan/2026-11-21-beatdrop-montages.md` section BD7 (engine side; the studio card is BD7b).

1. **Retakes change only what they name** (`beatdrop.retake` on the saved plan): cuts, beats, song start, slots and every other piece stay byte-identical. `swap` gives piece N the next candidate in its own queue on the same frames and beat (or the next calm stretch); `slower-intro` lowers the cold-open speed by one step on the same frames and source start, never below `speed.min`; `more-third-person` turns up to N body moves or gunshots (never a kill, never the drop) into calm shots, and their beat effects go with them; `another-take` re-chooses every piece except the drop with a seeded shuffle, and the drop keeps the strongest kill that fits (the first-drop rule). Numbers are in `data/clip/beatdrop.json` `retakes`. The plan records each retake (`retakes`: op plus seed, step, piece or pieces), so base plan plus retakes reproduce the result. Flash spacing runs again on the new timeline.
2. **Same song on a retake**: the render.json music record's NCS track is picked again by id (fixed), or the same seeded made-here bed is used. There is no new pick and no song map.
3. **Summary**: `beatdrop.summary(plan)` gives plain-word lines (for example "kill on the first drop at 0:08", "45 kills on beats", "5 third-person shots"). Calm pieces carry `near` (the calm moment kind they start at). The lines go into render.json `summary`.
4. **V cut from the same plan**: a second ffmpeg run with the same pieces, bed, LUT, effects and slots. Framing reuses the clip layouts (`clip_render.layout_chain` wraps `layout_graph` per piece; no second framing system). It uses `stream-v` (the V canvas recording, as V clips are cut) when the session has one, else `blurred-fill` of the H recording (the whole picture fitted, nothing cut off). The V title is in screen space (the pin track is in H pixels); credits wrap per frame (BD5). Each output encodes its audio once. Each file gets its own new name and its own flash check. Both stay .part until both are measured. A V flash fail drops only the V file (render.json error `beatdrop-v`); an H fail drops both.
5. **CLI**: `clipper.py beatdrop --retake <op> [--piece N] [--v-recording P]`. render.json lists files `beatdrop-h` and `beatdrop-v` (with geometry = layout id and its own flash), plus `summary` and `retakes`. Off air only, heavy-job lock, sweeps, music record and temp cleanup are unchanged.
6. UNVERIFIED: real footage, NVENC, the look of the V framing to the user, a made-here retake when `--max-sec` differs from the first render.
