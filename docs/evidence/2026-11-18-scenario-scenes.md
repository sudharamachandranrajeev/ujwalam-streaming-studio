# Scenario scenes (D390, scenario part)

Date: 2026-11-18. Branch `feat/scenario-scenes`. Status: unverified on a real stream (no live use yet).

User request: "Different scenes for different scenarios: gameplay, in lobby just chatting, showing off PC screen/apps
for videos, and starting soon / BRB / ending." Each scenario makes one H scene and one V scene (V inside the V safe
zone, game never cropped).

## What was built

- Templates as data: `data/scene-templates/{gameplay,lobby,screen-share,starting-soon,brb,ending}.json`, schema
  `data/schemas/scene-template.schema.json`. Each template lists the slot boxes of H and of V explicitly (the auto
  H to V rule is not used). Roles: game, camera, chat, alerts, graphics (message panel) and the new role `screen`.
- Adapter `services/scene-builder/scenarios.mjs`: one reference-read shaped object per canvas (confidence 1), each
  built by the existing `buildPackage`; only that canvas's preset is kept; both are merged into one scene package
  (scene name = the template's `sceneName`, e.g. "Gameplay", "Lobby", "Screen share"). The existing importer
  (`planScenePackage`) adds it as a NEW namespaced scene; existing state hash is checked inside it.
- Role `screen` (`sources.mjs`, `build.mjs`): links an existing project layer of type `window` (first) or `screen`
  (shown as a duplicate), or creates a NEW `window` / `screen` layer from a target the user picked
  (`bind.screen = { create: { type, source, content? } }`). No target and no layer: a placeholder with the reason.
  Fit is always `contain` (never cropped). Layer contract coded against (not on this branch's schema):
  `window: { window, match, cursor }`, `screen: { display, cursor }`.
- `scene-preset.mjs`: preset layer types `window` / `screen` emit the layer with `target` as its source.
  `scene-package.schema.json` and `reference-read.schema.json` accept role `screen`, layer types `window` / `screen`
  and a `target` object; reference-read slots accept an optional `text` (panel message, 80 characters).
- Holding screens (starting soon, BRB, ending): the `ujwalam-panel` overlay page now shows an optional `text=`
  message (`textContent`, tokens only, no innerHTML). No countdown: no existing overlay does one, so these are a
  message plus chat only (camera left out). The message text can be edited later through the `text` build param.
- Studio routes (`services/studio-ui/scene-builder-routes.mjs`, no flag): `GET /ui/api/scene-templates`,
  `GET /ui/api/scene-templates/targets` (read only, host `capture.listTargets`; `available:false` when the host has no
  such call), `POST .../build {template, text?, bind?:{screen:{kind,target}}}` (dry run in plain words; the target id is
  looked up in the host list again), `POST .../apply {}` (one click, no typed phrase, no "are you sure"; off air only).
  The fake host answers `capture.listTargets` with placeholders ("Example App", "Display 1").
- QML: `ScenarioWindow.qml` (grid of six cards with a tiny H and V drawing from the template boxes; for screen share a
  Window (default) / Whole screen choice and the host list; plan in plain words; Add scene). Add scene dialog has a
  "From a scenario..." button. Fixed card size and a reserved picker row, so nothing jumps.
- Flag `scene-builder` default ON (`data/flags.json`, user-requested feature); flag default tests updated.

## Tests (all run at BelowNormal, one file at a time, `--test-concurrency=1`, off air checked with tools/live-check.mjs)

| File | Result |
| --- | --- |
| `tests/scene-scenarios.test.mjs` | 24 pass, 2 skipped (need the capture branch schema) |
| `tests/studio-ui-scene-templates.test.mjs` | 3 pass, 2 skipped (need the capture branch schema) |
| `tests/studio-qml-scenarios.test.mjs` (headless probe, fake host) | 5 pass, 1 skipped (needs the capture branch schema) |
| `tests/scene-builder-build.test.mjs`, `scene-builder-iterate.test.mjs`, `scene-builder-reference.test.mjs`, `scene-builder-theme.test.mjs` | pass |
| `tests/studio-ui-scene-builder.test.mjs`, `tests/studio-ui-flags-feedback.test.mjs`, `tests/live-updates.test.mjs` | pass |
| `tests/studio-qml-scene-builder.test.mjs` (headless probe) | 3 pass |
| `tests/studio-qml-shell.test.mjs` (names "defaults: every flag", "one Add/Delete place") | pass |
| `tests/flags.test.mjs` | 1 FAIL until the decision text is in the log (see below) |

What the node tests prove, per template: package valid against the schema; H and V layers within 3 % of the template
boxes; V layers inside the YouTube Shorts safe zone and V template boxes do not overlap; placeholders listed with
reasons (screen share without a window, a project without chat); state hash of the project unchanged after the dry
run and after the import (`withoutAdded`); holding screens carry `text=`; chat sized per canvas.

## Not run

- Full CI, GPU tests, host tests, the whole QML suite (only the files above), `studio-qt-shell` (widget shell).
- The 5 gated tests (import of a window / screen layer through `planScenePackage`, route build with a picked window
  or screen, QML add of a screen share with a picked window): the project schema does not know layer types `window`
  and `screen` here.
- Nothing on a real stream, nothing against a real `capture.listTargets` (the contract `id` field is assumed to be the
  OBS window spec `title:class:exe`; UNVERIFIED).

## Depends on the capture / host branch

1. Project schema (`data/schemas/project.schema.json`) layer types `window` and `screen` with the contract above.
   Until merged, a screen share with a picked target fails the plan with `build-failed` (the project does not validate).
   A screen share with no target is not affected (placeholder).
2. Host `capture.listTargets` (read only) and `layers.addFromProject` for `window` / `screen` layers.
3. `tests/flags.test.mjs` needs a decision section `## D390 ...` in `docs/plan/2026-10-29-v1-decisions.md` that names
   `scene-builder` and says "ON by default".

## Risks

- Template boxes are the agent's first proposal (status unverified), not checked on a stream.
- A V game in 9:16 inside the safe zone is small by the never-crop rule.
- If `capture.listTargets` `id` is not the OBS window spec, window capture would point at the wrong target.
- `scene-builder` is on by default now: More > "New scene from a reference" shows for everyone.

## Files

Created: `data/scene-templates/*.json` (6), `data/schemas/scene-template.schema.json`,
`services/scene-builder/scenarios.mjs`, `app/studio/qml/ScenarioWindow.qml`, `tests/scene-scenarios.test.mjs`,
`tests/studio-ui-scene-templates.test.mjs`, `tests/studio-qml-scenarios.test.mjs`, this file.
Changed: `data/scene-builder/build-rules.json`, `data/schemas/{reference-read,scene-package}.schema.json`,
`data/flags.json`, `services/scene-builder/{build,sources}.mjs`, `services/project/{scene-preset,scene-package}.mjs`,
`services/overlay-server/pages/ujwalam-panel/index.html`, `services/studio-ui/{scene-builder-routes,backends}.mjs`,
`app/studio/CMakeLists.txt`, `app/studio/qml/{AddSceneDialog,Main}.qml`, tests `flags`, `live-updates`,
`studio-ui-flags-feedback`, `studio-ui-scene-builder`, `studio-qt-shell`, `studio-qml-shell`, `studio-qml-scene-builder`,
`scene-builder-reference`, `scene-builder-theme`.
