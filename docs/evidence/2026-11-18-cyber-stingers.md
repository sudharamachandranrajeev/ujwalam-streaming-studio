# 2026-11-18 Cyberpunk stingers, default transition (D391, stinger part)

Status: generator, three presets, six WebM files, tests pass (node only). Not run: host, Qt studio tests, full CI, a real stream. UNVERIFIED: how it looks on a real stream and in the libobs stinger source (alpha decode by obs-ffmpeg), until the user sees one.

## What was built

- `tools/make-stingers.mjs`: plain-JS rasterizer, no dependencies. Draws RGBA frames (1-D colour table along a diagonal sweep axis plus grid, data bars, scanlines, RGB-split glitch rows), pipes raw frames to ffmpeg (`libvpx-vp9`, `-pix_fmt yuva420p`, `-auto-alt-ref 0`, bitexact flags, 60 fps, hidden child). No fonts, no downloads, silent.
- Presets (data, not code): `data/transitions/stingers/<id>.json`: `neon-glitch` (default; yellow/cyan/magenta), `synthwave-sweep` (orange/pink/violet), `cyan-grid` (cyan/teal). Each: 900 ms, 60 fps, `pointMs` 450, palette, timing, shape, glitch, tags.
- Outputs, committed (media is binary in `.gitattributes`): `<id>-h.webm` 1920x1080, `<id>-v.webm` 1080x1920 (V size from `createProject`).
- Registry: `registry/functions/scene-transition-stinger.json` (+ 3 presets `stinger-<id>`, similar tags, status in-progress, flashesPerSec 2). `npm run validate:registry`: OK.
- Packaging: `tools/package/manifest.mjs` ships `data/transitions` (`.json`, `.webm`) and exempts exactly `data/transitions/stingers/<id>-<h|v>.webm` from the "no media" rule; `tests/package-alpha.test.mjs` covers it. Chosen over generate-at-package-time: no ffmpeg needed for a build, same bytes every time.
- Host path: base `data` is now given at the alpha project load (`alphaBases({ appDataDir })`, only from `launch.mjs`), rel `transitions/stingers/<id>-<h|v>.webm`.
- Studio UI server: `POST /ui/api/project/transition` accepts `{ canvas, type: "stinger", preset: "<id>" }` (preset id only; `file`/`pointMs` with it are refused; unknown id -> 409 `unknown-stinger`). `GET .../transitions` lists `stingers: [{ id, label, description, pointMs, default }]` and never a path. Control page: new "Built-in stinger" type with a preset list.
- Default: flag `transitions` default true; new alpha projects use `neon-glitch` on both canvases; one-time migration of an existing alpha project (below).

## Checks

All commands from the worktree, node only (no host, no GPU, no window).

- `node tools/make-stingers.mjs` (about 35 s for all six, ffmpeg 8.1.3 LGPL, `libvpx-vp9`):

  | file | size (bytes) | frames |
  |---|---|---|
  | neon-glitch-h.webm | 428130 | 54 |
  | neon-glitch-v.webm | 391102 | 54 |
  | synthwave-sweep-h.webm | 206998 | 54 |
  | synthwave-sweep-v.webm | 194597 | 54 |
  | cyan-grid-h.webm | 520171 | 54 |
  | cyan-grid-v.webm | 478936 | 54 |

- `node --test tests/transitions-stingers.test.mjs`: 26/26. Per file: committed and 10 kB..1.5 MB; first and last frame alpha max <= 4; frames 26, 27, 28 (pointMs 450 at 60 fps = frame 27, +-1) alpha min >= 250 (decoded with `libvpx-vp9` so alpha is kept); ffprobe size, 54 frames, 60/1.
- Flash safety, same test, repo detector `services/overlay-server/flash-detect.mjs` (WCAG 2.3.1 general+red, 26 regions, limit 3 per second). The clip is composited over black, mid grey, white, and a black-to-white scene swap at pointMs (worst case). Peak flashes per second:

  | preset | canvas | black | grey | white | swap |
  |---|---|---|---|---|---|
  | neon-glitch | H | 2 | 2 | 1 | 1.5 |
  | neon-glitch | V | 2 | 2 | 1 | 1.5 |
  | synthwave-sweep | H | 2 | 1 | 1 | 1.5 |
  | synthwave-sweep | V | 2 | 1 | 1 | 1.5 |
  | cyan-grid | H | 2 | 1 | 1 | 1.5 |
  | cyan-grid | V | 2 | 1 | 1 | 1.5 |

  A first version (bars staggered in time, so each bar made its own bump of light) measured 4 per second and failed; the bars are now glued to the base slab by distance (one bump per pass).
- `node --test tests/transitions-stinger-defaults.test.mjs`: 8/8 (presets, flag default, imported-fade detection, new project default and base `data`, migration, marker, `prepareAlphaProject`, studio form by id only).
- `node --test tests/package-alpha.test.mjs tests/studio-ui-alpha.test.mjs tests/studio-ui-transitions.test.mjs tests/studio-ui-flags-feedback.test.mjs`: pass (together with the above: 112/112 of 114 counted, 0 failed, 2 skipped by the suites themselves).
- `node tools/lint.mjs`: 0 findings. `node tools/registry-validate.mjs registry`: OK.
- `node --test tests/project-*.test.mjs tests/studio-ui-*.test.mjs tests/registry*.test.mjs tests/package-alpha.test.mjs`: 506/512 before the last two test fixes; the 3 failures in `studio-ui-quit-lock.test.mjs` also fail on the untouched main checkout (pre-existing), the 1 flags-list test was fixed (transitions listed as on by D391).

## What changes for an existing project (alpha project)

At the next studio start (before the host load, so a running stream is never touched), once:

1. If `<dataDir>/projects/transition-defaults.json` exists: nothing.
2. Else each canvas whose transition is unset, or the plain Meld-imported fade (H 2006 ms / V 1000 ms, no easing, no mirror), becomes the `neon-glitch` stinger (`base data`, 450 ms point). A cut, another fade length, a fade with easing or a stinger of the user stays.
3. A copy of the project first goes to `projects/_old/alpha-<stamp>.before-tr1.project.json`.
4. The marker file is written whether or not anything changed, so a later choice (even going back to that exact fade) is never overwritten. (A sidecar, because the project schema and the host reject extra keys.) A project that does not load is left alone and gets no marker.
5. With the flag on (now the default) the stinger plays on every scene switch. A `flags.local.json` entry that turns `transitions` off still wins.

A Meld-import project (`meld-import-*.project.json`) is not migrated: its load has no `data` base, so a built-in stinger chosen there would be refused by the host and that canvas cuts.

## Limits and open items

- UNVERIFIED on a real stream: look, timing, and that obs-ffmpeg decodes the alpha of the VP9 files in the stinger source (the earlier stinger test used VP8 without alpha).
- The native Qt Transitions box (`app/studio/qml/TransitionsPanel.qml`) still offers only videos from the stream assets folder; built-in stingers are chosen on the control page (and by the migration). Needs a QML change and a studio build.
- Tests that assume flag `transitions` starts off were changed to turn it off first (`tests/studio-qt-shell.test.mjs`, `tests/studio-qml-transitions.test.mjs`); NOT RUN (they start the Qt studio).
- `tests/flags.test.mjs` needs the decision log entry D391 (it must name `transitions` and "ON by default"); until the main session adds it, that one test fails.
- Base `data` is the whole app data folder (read only). The host only plays video files as a stinger and keeps paths inside the base; the page can only name a preset id.
