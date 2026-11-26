# Error-code audit, route audit, silent drops, BeatDrop trace (2026-11-27)

Branch `fix/error-code-audit` (from 4c5d53cb). Focused tests only; no full CI, no GPU tests.

## 1. Host error codes
- The studio host client (`services/studio-ui/backends.mjs` rpc) rejects with `code: "RPC_<n>"`; `app/host/lib/client.mjs` (HostClient) uses the number.
- New shared `isHostError(e, code)` in backends.mjs accepts both. Now used in: music-routes.mjs (-32602, -32009), scene-layers.mjs (-32004), host-watch.mjs (-32601; was number only), readiness.mjs (-32601), server.mjs (project.load retry on -32009).
- Test fakes changed to the real form: scene-music-routes, studio-qml-editing, studio-qml-scene-music, studio-ui-mixer-routing, host-watch.
- Note: host-watch's probe uses HostClient (number), so it was not a live bug; the helper makes it safe either way.

## 2. QML Api routes vs server
- Script compared every `Api.get/post("ui/api/...")` literal in app/studio/qml with route literals in services/studio-ui: all exist. Three apparent misses (scene-templates/*, connect/check|choose|cancel) are handled through a constant / `connectRoute` op switch.
- Body keys of every literal-body `Api.post` were checked against the handlers (heuristic, then manual on 18 flagged): the server rejects unknown keys with 400 (`only`, NOTE_KEYS, schema), none are silently dropped. No mismatch found. UNVERIFIED: posts with a non-literal body (e.g. TaskWindow `body`) and dynamic path suffixes were not checked by script.

## 3. record-clips readControls silent drops (fixed: logged once each)
- Request from an earlier launcher ignored with no log.
- Status write failure undid the requests with no log.
- tasks.mjs listTaskControls deleted an invalid control file with no trace (new `onBad` callback).

## 4. BeatDrop never ran
Cause: record-clips.mjs queued BeatDrop only when `done.type === 'full'`. The user's settings (core/settings.json) have `clips.recording = "while"` and `clips.live = "while"`, which queue `review` jobs, never `full`. So the trigger never fired (flag `beatdrop` default on; unaffected). Fix: also trigger after a `review` job that has an H recording; a log line now says when it is skipped for no detector hits. UNVERIFIED: that live-review with `--recording` writes a non-empty detector-hits.jsonl in the run folder (clipper.py says "detect + segment in live-review"); if not, the new log line will show it. No real run done.

## Tests (node --test, focused)
115 pass (error-code set: 8 files); 47 pass (beatdrop-review, task-controls-drop, task-manager-jobs).
