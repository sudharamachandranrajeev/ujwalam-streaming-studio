# 2026-11-18 — Widget studio removed; the QML window is the only studio

Result: PASS for the build and the twinned tests. Four QML probe files fail; see "Failures" below. They are not
caused by this change (UNVERIFIED for studio-qml-layout and studio-qml-chat).

The user said yes on 2026-11-18. The parity checklist was 48/48
(`docs/plan/2026-11-14-qml-parity-checklist.md`).

## What changed

- Deleted 38 widget files from `app/studio/src` (14,090 lines): main_window, stream_pages, coach, soft, autopost_card,
  guide, help_panel, add_dialogs, connections_page, depth, specimen, value_slider, look_panel, appearance,
  interaction, switch_widget, layer_list, hints, stats_cards (.cpp and .h each).
- Trimmed the kept files (2,725 lines out, 105 in):
  - `main.cpp`: QML for every mode.
  - `theme.cpp`/`.h`: palette, font, pack load, live reload, components and accessors. No stylesheet.
  - `motion`: mode, animations and run.
  - `taskbar`: tasktime and SmoothBar.
  - `icons`: no `make`.
  - `tray.cpp`: plain spacing values.
- `kSwapExitCode = 75` moved to `QmlStudio`.
- Plain headless with no probe and no hidden mode now exits 64. The old "studio smoke" mode is gone.
- Flag `studio-qml` removed. A `flags.local.json` that still has it loads without error (`tests/flags.test.mjs`).
- `--qml` dropped from the launcher and the soak tool.
- Deleted 13 widget tests (2,941 lines) and `tests/fixtures/themes/soft-plates.json`.

Accepted losses (the user agreed): the Soft painters, the component stylesheet variants and the specimen page.
The tray's lists no longer follow the pack's density.

## Build (clean, 4 jobs, BelowNormal)

```
node app/studio/tools/build.mjs   (out/studio/build deleted first, CMAKE_BUILD_PARALLEL_LEVEL=4)
```

| | ninja steps | time | ujwalam-studio.exe |
|---|---|---|---|
| before (ab54d81) | 200 | 223.1 s | 12,711,936 bytes |
| after | 181 | 76.3 s (another run under load: 130.4 s) | 8,929,792 bytes (-30%) |

The build time varies with machine load. Only the exe size is a firm number.

## Tests (one file at a time, `--test-concurrency=1`, BelowNormal, UJWALAM_HEADLESS=1)

```
node --test --test-concurrency=1 --test-timeout=300000 <file>
```

Passed:
- flags 10/10
- studio-ui-alpha 38/39 (1 skipped)
- scene-builder-theme 17/17
- normal-windows 5/5
- guide 14/14
- studio-themes 10/10
- run-tests 4/4
- package-alpha 20/21 (1 skipped)
- studio-theme-contrast 6/6
- studio-swap-stream 1/2 (1 skipped: the stream test)
- studio-qml-clips 5, connections 15, controls 8, editing 46, golive 11, growth 5, guide 11
- studio-qml-outputs-bots 5, outputs-cards 7, palette 7, posting 12, posts 4, review 5, scenarios 6, scene-builder 4
- studio-qml-settings 19, stream 16, tasks 7, themes 18, transitions 14, tray 14, youtube-window 10
- rareui-slice1 19, rareui-slice2 17
- studio-crash-capture 4/4, studio-swap-launcher 9/9

Failures:
- `studio-qml-shell` 4/5: the defaults test lists the default-on flags without `transitions`, which is on by default
  since D391. Not caused by this change.
- `studio-qml-more-windows` 8/9: the expected More menu list is older than the current menu. Not caused by this change.
- `studio-qml-layout` 5/29: overlap and cut-off checks for ujwalam-light and ujwalam-night. UNVERIFIED whether this
  fails before the change too. No QML was edited here, and the theme accessors QML reads are unchanged.
- `studio-qml-chat` 9/10: the Settings Cancel / Save changes dialog test (80 s, under load). UNVERIFIED (timing).

Not run: the full `npm run ci` and host GPU tests (the task's rules).

## Deleted tests and their QML twins

| Deleted | QML twin |
|---|---|
| studio-qt-alerts | studio-qml-controls |
| studio-qt-autopost | studio-qml-posting |
| studio-qt-connect-button | studio-qml-connections, studio-qml-stream |
| studio-qt-d327 | studio-qml-chat, outputs-bots, stream, transitions |
| studio-qt-growth | studio-qml-growth |
| studio-qt-learning-review | studio-qml-review |
| studio-qt-shell | studio-qml-shell, clips, controls, editing, guide, outputs-bots, settings, tasks |
| studio-qt-theme-reload | studio-qml-themes |
| studio-qt-themes | studio-qml-themes, studio-qml-settings |
| studio-tray | studio-qml-tray |
| studio-qt-soft-theme | none (accepted loss) |
| studio-qt-theme-components | none (accepted loss) |
| studio-qt-theme-reference-themes | none (accepted loss) |
