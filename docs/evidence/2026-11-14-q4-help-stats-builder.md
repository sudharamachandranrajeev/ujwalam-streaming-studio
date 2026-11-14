# Q4 rows B, D, E, F, G: help, tours, stats, Advanced effects, preview retry, Transitions box, scene builder (QML studio) — 2026-11-14

Plan: `docs/plan/2026-11-11-qml-studio-plan.md` Q4; checklist `docs/plan/2026-11-14-qml-parity-checklist.md`. QML twins
of the widget's help panel, tours and hints (`guide.cpp`), stats cards (D287), ADVANCED EFFECTS box, preview selection
retry (`main_window.cpp`), plus the scene builder in the studio (new: until now command line only). Status: verified by
headless probe tests (fake host, real UI server) and a route test. Not yet seen on the real screen (Q5, the user's).

## What was built

- Help and guide: `HelpPanel.qml`, `Guide.qml`, `GuideBubble.qml`, `GuideClose.qml` (the ? button, welcome tour, clips
  and posting tours, 6 hints with auto-hide and "Don't show again", Settings > Help & tips). The "first task" hint now
  waits for a running or waiting task: the done preview-open tasks at start are not a job.
- `StatsPanel.qml`: session time ("Not live" off air, a running clock and "On air" / "Recording"), FPS, GPU and CPU
  with 90-sample history lines, between the side column and the mixer. The top-bar stats chip is gone (D287).
- Status line: a UI server that does not answer is said as such, not as "Host not running"; theme reload refusal toast.
- `LookPanel.qml` Advanced effects (flag `effect-editor`): ordered list, add, up, down, remove, per-type form, at most 6,
  Apply sends the whole list once (`layers.setEffects`), Revert sends nothing.
- `Store.qml` preview selection retry: a selection the host refused during a drag is sent again once that preview is
  not dragging; a newer selection replaces it; a refused retry puts the list back to the host's.
- `PreviewArea.qml` Own window / To front; `TransitionsPanel.qml` (flag `transitions`).
- Scene builder in the studio (flag `scene-builder`): `services/studio-ui/scene-builder-routes.mjs`
  (`GET /ui/api/scene-builder`, `POST .../build {file}` dry run with the plan in plain words, `POST .../apply {}`),
  `SceneBuilderWindow.qml` from More > "New scene from a reference…". Only files of the stream assets folder; off air
  only; apply adds the scene to the host first (H, V, then the layers bottom first), then to the project file; existing
  scenes, layers, devices and settings unchanged (the import rule, checked by hash); one click, no typed phrase (D332).

## Evidence

Studio built with `node app/studio/tools/build.mjs`. Tests run one file at a time at BelowNormal priority with
`--test-concurrency=1`; the user's installed studio was running, so no full CI and no GPU tests.

```
node --test --test-concurrency=1 tests/studio-qml-guide.test.mjs          -> tests 11, pass 11, fail 0
node --test --test-concurrency=1 tests/studio-qml-controls.test.mjs       -> tests 8, pass 8, fail 0 (stats, status line)
node --test --test-concurrency=1 tests/studio-qml-editing.test.mjs        -> tests 37, pass 37, fail 0 (Advanced, retry)
node --test --test-concurrency=1 tests/studio-qml-transitions.test.mjs    -> tests 13, pass 13, fail 0
node --test --test-concurrency=1 tests/studio-qml-themes.test.mjs         -> 16 of 17 in the batch; the reload test failed
     (see below), then reload 1/1, custom + SB4 pack 2/2 after the fix
node --test --test-concurrency=1 tests/studio-ui-scene-builder.test.mjs   -> tests 1, pass 1, fail 0
node --test --test-concurrency=1 tests/studio-qml-scene-builder.test.mjs  -> 3 tests: flag 1/1 (first run), add + live 2/2
```

Two test fixes on the way:
- The status-line test used a port with nothing on it, so the studio could not log in and exited 77 before it could
  show anything. It now uses a server that lets the studio log in and then drops every request.
- Theme reload toast: in the batch the broken theme file was replaced by the fixed one before the busy software-rendered
  window read it, so no refusal was said. Run alone, the toast shows once (log: `theme: lu-reload.json not applied ...
  not valid JSON`; toastLog `['Theme not applied: the file has a problem']`). The broken version now stays 3.5 s.

Route test covers: flag off 404 on every route; the list holds only the assets folder's picture; a made-up path
(`../p.project.json`) refused `unknown-reference`; extra keys 400; `nothing-built` before a build; `live-locked` for
build and apply; dry run writes nothing and sends nothing; a host refusal (502) saves nothing and keeps the build;
apply sends `scenes.create` H then V then `layers.addFromProject` per layer for the new id; the file gains exactly one
scene; `stateHash(withoutAdded(saved))` equals the hash before; the project validates; the build is used up.

## Row H: test twins of `studio-qt-shell` (same day, later)

Built for them: the trash button is greyed while live with "Not while live" (shown on hover over a wrapper, since a
disabled Qt Quick button gets no hover); new probe actions `drag:<from>[~<to>]:<objectName>` (a real mouse press, an
optional held drag in 8 moves, the release) and `key:<Key>:<objectName>` (focus, then a real key) in `qml_studio.cpp`;
the Look sliders are named `lookSlider:<type>/<key>`.

```
node --test --test-concurrency=1 tests/studio-qml-shell.test.mjs     -> tests 5, pass 5 (launch key once, URL, defaults)
node --test --test-concurrency=1 tests/studio-qml-settings.test.mjs  -> 18 of 19 in the batch; the new refusal test
     failed on the test's own front server (Host and Origin not passed on, then a wrong expectation), then 2/2 after
     the fix (match filter saved; an older server's refusal: "Settings saved, except the match filter: ...")
node --test --test-concurrency=1 tests/studio-qml-editing.test.mjs   -> 43 of 44 in the batch; then the changed and
     new tests 4/4 (preview click without echo, trash while live, slider click/type/key, volume click and hold-drag)
```

Test fix: "a click on the preview selects it in the list" counted host.status calls, but the UI server polls the host
itself every 50 ms, so the click was in the status before the window started. The click now comes 1 s after the
window's first `preview.select`.

Slider results: Look radius click at 0.9 jumps past 13, typed 12 is sent, Right sends 13; volume click at a quarter of
-60..0 sends -45 once; press at a quarter, hold and drag to three quarters sends only -15 on release. Not twinned: the
widget's held spin-box arrows (the QML number box is a typed field, no arrows).

## Not covered

- The real-screen look (Q5).
- The scene builder with a real video reference (the route reads videos the same way as the command line; tested there).
