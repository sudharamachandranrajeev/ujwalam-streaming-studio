# Transitions in the studio and the AI read in the scene builder (D394 proposed)

Date: 2026-11-18. Branch `feat/transitions-ui`, based on `claude/alpha0-d1` (rebased onto ca3caca). Headless probes only
(`UJWALAM_HEADLESS=1`), fake host, fake model server. No GPU host test, no full CI run beyond the commit hook, no model
loaded, no real call to LM Studio, nothing live.

## Task 1: transitions

- `GET /ui/api/project/transitions` now also returns `kinds` (id, label, plain help, own fields, `available`, `reason`),
  `wipes` (id, readable label from `data/transitions/luma-wipes.json`, `available`), `directions` and `ranges`.
  Availability comes from the host's read-only `transitions.types`; a host that does not answer leaves everything offered.
- `POST /ui/api/project/transition` takes slide, swipe, wipe and fadeColor with their own fields. Every transition is built,
  put into the project and run through `validateProject` (the one rule set); any problem on the transition is a 400. A wipe
  id must be in luma-wipes.json and in the host's list, a type the host lists as unavailable is a 409 `type-unavailable`.
  The numeric limits are the validator's `TRANSITION_RANGES` (new export, used by the validator itself), sent to the page.
- A click now applies on air as well (D332): the `live-locked` refusal is gone from this route (only a host that does not
  answer refuses). The studio panel no longer switches off while live.
- QML `TransitionsPanel.qml`: canvas H or V, type buttons (each with a tip; a type the engine lacks is off, the reason is
  written under the buttons), what the chosen type does, duration, stinger picker (built-in `neon-glitch`,
  `synthwave-sweep`, `cyan-grid` by id, plus the stream assets videos), direction, "Swipe in" switch, wipe pattern with
  readable names, softness, "Invert the pattern" switch, colour with swatches, colour point. Every row is always present
  and a row that does not belong to the type is off, so the box keeps its height. Toggles carry their words.
- `SettingsTransitions.qml`: a type it does not edit (stinger, slide, swipe, wipe, colour fade) is kept as it is and now
  shows its own name; Save never sends a bare `{canvas, type}` for it.
- `data/transitions/easing.json`: new `kinds` list (labels and help). The old `types` list is unchanged (Settings uses it).
- Old Qt widget combo (`app/studio/src/main_window.cpp`, `stream_pages.cpp`): not touched, still cut, fade, stinger.

## Task 2: SB6

- `GET /ui/api/scene-builder` returns `ai: { available, on, model, reason? }`. It asks `GET /v1/models` on 127.0.0.1:1234
  (lists models, loads none). Off with a plain reason when LM Studio does not answer, when the picture model is not in
  its list, while live and while recording (then it does not ask at all).
- `POST /ui/api/scene-builder/build {file, ai?}`: with `ai: true` and the card free, `visionAdapter()` is passed as the
  read hook's model. While recording the rules result is built and `detector.skipped` says why. The answer carries
  `detector: { used: 'rules'|'model', model, asked, skipped? }`; a model failure stays in `notes` ("model ... failed").
  Building while live is refused as before.
- QML `SceneBuilderWindow.qml`: switch "Use the local AI model to read the picture", on when the model answers, off and
  disabled with the reason otherwise; a fixed-height line says which reader was used.

## Tests (one file at a time, `--test-concurrency=1`, BelowNormal)

All use a fake fetch or a fake host. Results after the rebase onto ca3caca: `studio-ui-transitions-d394`, `studio-ui-transitions`
and `project-schema` 153 pass, 0 fail (one run); `studio-qml-scene-builder` 4 of 4 pass; `studio-qml-transitions` 14 of 14 pass
(studio rebuilt with `node app/studio/tools/build.mjs` first). `studio-ui-scene-builder` 2 of 2 passed before the rebase
(the rebase did not touch that route).

| File | What it checks |
|---|---|
| `tests/studio-ui-transitions-d394.test.mjs` (new) | kinds, wipes, availability and reasons, validator-backed 400s, ranges, built-in stinger by id, applies live, older host |
| `tests/studio-ui-transitions.test.mjs` | existing transition tests; the live assertion now expects 200 |
| `tests/studio-ui-scene-builder.test.mjs` | existing builder route test plus the AI switch test (fake model server) |
| `tests/studio-qml-transitions.test.mjs` | box probes for every new type, rows off not hidden, live applies; Settings page unchanged |
| `tests/studio-qml-scene-builder.test.mjs` | AI switch on, off by the user, off with reason, off while live; detector line |

## Not verified

- A real look at the box on screen (headless probe only), a real LM Studio answer, a real stream.
- The old Qt widget panels (not changed).
