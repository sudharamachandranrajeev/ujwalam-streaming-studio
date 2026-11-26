# 2026-11-27 Overlay copy URLs (layers.addFromProject)

Branch `fix/overlay-copy-urls` (from `codex/reel-mix-long-video` 502fb924). Status: tests pass; not yet used on a real stream.

## Problem

A layer added live through the host RPC `layers.addFromProject` got no overlay page URL: only `project.load` /
`project.plan` took `browserUrls` / `relayScope`. A realism scene, a duplicated scene or a scene-builder scene that
copies an overlay layer showed that layer only after the next full restart (the UI skipped it into `later` on -32004).

## Change

- Host (`app/host/src/methods.cpp`): `layers.addFromProject` accepts optional `browserUrls` and `relayScope`, parsed by
  the same `load_options()` as `project.load` (same limits; `bases` / `skipUnavailable` are still refused there). The
  overlay ports still come from the host's own overlay server, never from the caller.
- Host (`app/host/src/studio.cpp`, `studio.h`): `Studio::layer_add_model(doc, scene, layer, const LoadOptions *urls)`
  merges the sent URLs over the last load's options for this build; they are kept in `last_opts_` only when the layer
  is built (later rescans and adds reuse them). The relay scope is taken only when no relay scope was set before. The
  URL check in `model.cpp` (URL must point at the layer's own overlay page) is unchanged.
- Host lib (`app/host/lib/project.mjs`): new `overlayParams(client, project)` (overlay.status ports -> `overlayUrls`),
  now also used by `project.load` / `project.plan` params. One URL builder.
- UI server: `addLayerParams(host, params)` in `services/studio-ui/scene-layers.mjs` adds the URLs (catches any
  failure and sends the params as before). Used by every `layers.addFromProject` caller: `createSceneInHost`,
  `server.mjs` layer.add / layer.duplicate, `device-routes.mjs` Connect and its undo. The -32004 skip stays as the
  fallback when the overlay server is not running.

## Tests

- `npm run build:host`: built `out/host/build/ujwalam-host.exe`.
- `node --test app/host/tests/host-browser.test.mjs app/host/tests/host-structure.test.mjs` (UJWALAM_HEADLESS=1):
  13/13 pass. New: `layers.addFromProject: browserUrls / relayScope validated like project.load; an overlay copy is
  built with its URL` (bad relayScope, non-string URL, long id, `bases` -> -32602; no URL -> -32004; a URL for another
  overlay -> -32004; URLs from overlayParams -> built, original `gg` still listed, relay still `effects`).
- `node --test tests/realism-look.test.mjs`: 10/10 pass. New: scene.realism and scene.duplicate with an overlay layer
  send the URL (static port and feed port from overlay.status), response has no `later`; with overlay.status failing
  the copy goes to `later` (1) and the scene is still saved.
- 17 node test files touching structure / devices / rebind / scene builder: 176 tests, 174 pass, 0 fail.
- Pre-commit `ci --quick`: 9/9 passed on both commits.

## UNVERIFIED

- Not tried in the running studio or on a real stream.
- Scene-builder route: it goes through `createSceneInHost` (covered by the same helper), not tested end to end.
- Device Connect path: wired, covered only by the existing tests (no overlay layer in them).

## Review round 2 (branch `fix/overlay-copy-urls-r2`)

- Relay scope (medium): the relay is never rebuilt on air; it feeds every overlay page already shown. When a display
  page (chat-list, alert-box) is added while the relay is effects-only, the layer is built and the reply carries
  `note: "This overlay shows fully after the next start."`; the UI server passes `note` in the structure reply. Chosen
  over "rebuild when not live" because "not live" is not known inside Studio and a rebuild would briefly drop the feed
  for the pages on screen; the next full load picks the right scope anyway.
- Stale ports (medium): with sent URLs the ports are always the RPC layer's fresh ones (0 when the overlay server is
  down), so the layer reports -32004 and the UI's later-fallback applies. Stale ports are never written back.
- `browser_urls` is replaced by the sent set (the UI sends every overlay layer of the document), not grown.
- `make_relay` after the layer is built is wrapped: a failure is logged and noted, the reply and `model_doc_` stay
  consistent with what is on air.
- UI: `overlayExtra(host, project)` is called once per operation (createSceneInHost, device Connect re-adds, its undo)
  and logs its error before falling back.
- Thread safety (checked by reading): `Studio::load` (which calls `load_model`, `last_opts_ = o`),
  `devices_rescan` and `layer_add_model` each take `std::lock_guard<std::recursive_mutex> lk(m_)`.

Tests (round 2): host-browser + host-structure 14/14 pass, new test `layers.addFromProject r2` (display page under the
effects relay: built, note returned, relay still `effects`; overlay child killed with the old ports saved: -32004).
realism-look: one overlay.status per multi-layer scene, host note reaches the reply.

UNVERIFIED (round 2): the make_relay failure path is not reachable in a test (only on browser-source create failure).

## Live path

A layer already on air is not touched: the change only affects the layer being added. `last_opts_` gains the sent URLs
(same values the launcher would build) and keeps the existing relay scope.
