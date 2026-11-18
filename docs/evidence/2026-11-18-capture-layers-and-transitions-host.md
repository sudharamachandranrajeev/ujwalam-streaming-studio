# 2026-11-18 Screen and window capture layers, four more scene transitions (host side, D390/D391 proposed)

Status: host built, schema/validator/UI server tests pass. **Host tests NOT RUN**: the user's studio held the GPU during this work, so nothing that starts the host was run. Not yet used on a real stream. Screen and window capture are switched off unless the host starts with `--allow-screen-capture`; the studio launcher does not pass it yet (needs the user's yes, see Risks).

Branch `feat/capture-transitions-host`.

## What was built

### D390: screen and window layers

- Project layer types `screen` (libobs `monitor_capture`) and `window` (`window_capture`):
  - `screen` source `{ display, cursor? }`: `display` is an id from `capture.listTargets`, 1..512 characters, no control characters. `cursor` is absent = true.
  - `window` source `{ window, match?, cursor? }`: `window` is the OBS spec `title:class:exe` (OBS encodes `:` as `#3A` and `#` as `#22` inside a part), and the exe part is not empty. `match` is `title`, `class` or `exe`; absent = `exe`, the OBS window priority. `cursor` is absent = true.
  - Window is the safer choice: it shows one app, not everything on the display.
- Host settings used, from OBS 32.1.2 `plugins/win-capture`:
  - `monitor_capture`: `monitor_id`, `capture_cursor`, `method` 0 (auto), `force_sdr` false.
  - `window_capture`: `window`, `priority` (class 0, title 1, exe 2), `cursor`, `method` 0, `client_area` true, `compatibility` false, `capture_audio` false, `force_sdr` false.
- RPC `capture.listTargets` returns `{ displays: [{id, name, width, height}], windows: [{id, title, exe}] }`. It is read-only:
  - It uses `obs_get_source_properties` (property lists only), so no source is created and nothing is captured.
  - It skips the `DUMMY` display entry. Width and height are parsed from the OBS label `name: WxH @ x,y`.
  - It logs counts only.
- Switch `--allow-screen-capture`:
  - Without it, win-capture stays on the disabled module list, as it was.
  - Both layer types then plan as unavailable `forbidden`, with a plain-language message for the layer list.
  - `capture.listTargets` returns -32001.
  - With the switch but no module, both layer types plan as `unavailable`, and `capture.listTargets` returns -32004.
  - `host.info` and `host.status` flags report `allowScreenCapture`.
- Live add: `layers.addFromProject` uses the same model path. `services/project/structure.mjs` `addLayer` takes kinds `screen {display}` and `window {window, match?}`. A window layer is named after its exe, never its title. The UI server's structure route accepts `display`, `window` and `match`.
- UI server allowlist: `capture.listTargets` and `transitions.types` take no parameters and have no confirm. The fake backend lists none.

### D391: slide, swipe, wipe, fadeColor

- `transitions.set` takes the four new types. Each takes `durationMs` 0..10000, with these fields:

  | Type | Fields | OBS source |
  |---|---|---|
  | `slide` | `direction` left/right/up/down | `slide_transition` (`direction`) |
  | `swipe` | `direction`, `swipeIn` | `swipe_transition` (`direction`, `swipe_in`) |
  | `wipe` | `pattern` (luma wipe id), `softness` 0..1 (default 0.03), `invert` | `wipe_transition` (`luma_image` = `<id>.png`, `luma_softness`, `luma_invert`) |
  | `fadeColor` | `color` `#rrggbb`, `pointPct` 0..100 (default 50) | `fade_to_color_transition` (`color` ABGR, `switch_point`) |

- A field of another type is refused with -32602. So are stinger fields on these types and `easing` on anything but a fade.
- The host checks the wipe image exists (`obs_find_module_file`).
- One second transition object per canvas sits on channel 0, swapped like the stinger. Switching kinds releases the old object once it is off the channel, and cut or fade releases it. Cut, fade and stinger behaviour is unchanged.
- `transitions.get` and `host.status` report each type's own fields. The colour is reported in upper case.
- `transitions.types` returns `{ types: [{type, fields, available}], wipes: [ids] }`. `wipes` holds the ids from the module's `wipes.json` whose file is present.
- `data/transitions/luma-wipes.json` lists the 34 images OBS 32.1.2 ships: id = file name without `.png`, the file, and the en-US label. Each file was checked to exist in the runtime.
- Project schema and validator:
  - The transition type enum gains the four types, with `allOf` if/then so each field appears only on its type.
  - `direction` is required for slide and swipe, `pattern` for wipe, `color` for fadeColor.
- UI server `transitionSync` applies the four types from the project, through the existing `transitions` flag, which is off by default.
  - A refused one cuts and is not asked for again, the same as a stinger.
  - A colour that differs only in case is not set again.
- Not done (UI agent's job): the transition form endpoint `POST /ui/api/project/transition` (`transitionEditRun`) and its `transitionChoices` still offer cut, fade and stinger only. So do the QML picker, `data/transitions/easing.json` `types` and the Qt studio `main_window.cpp` combo.

## Commands and results

- Host build: `node app/host/tools/build.mjs`, BelowNormal priority, 4 jobs. Exit 0, `built ...\out\host\build\ujwalam-host.exe`. The only warning is the existing C4996 `obs_add_data_path` deprecation.
- `node --test tests/project-schema.test.mjs tests/project-import-meld.test.mjs tests/project-structure.test.mjs tests/studio-ui-transitions.test.mjs`: 191/191 pass, before the structure and sync tests were added.
- `node --test tests/project-*.test.mjs tests/studio-ui-*.test.mjs tests/studio-project-sync.test.mjs`: 513 tests, 509 pass, 3 fail, all in `tests/studio-ui-quit-lock.test.mjs`. The same 3 fail on the base commit with these changes stashed (`git stash`; 2 pass, 3 fail), so they predate this work and do not come from it. Likely cause: the running studio. UNVERIFIED.
  - New: 17 transition and 10 screen/window schema/validator rejections, plus 3 accept tests (the types, the layers, and the luma wipe list shape with every id passing the schema).
  - New: addLayer screen/window cases.
  - New: allowlist entries.
  - New: a `transitionSync` test (fadeColor applied with its fields, refused wipe not retried, colour case).
- `node tools/lint.mjs`: 0 findings.
- Commit hook `node tools/ci.mjs --quick`: see the commit log. It runs builds, lint and scans only.

## NOT RUN (the main session runs these after the studio closes)

- `node --test app/host/tests/host-transitions-d391.test.mjs` (NVENC recording, ffmpeg):
  - types list matching the data file;
  - set and get with defaults;
  - 16 refusals;
  - kind swapping;
  - recorded slide, swipe and wipe, about 30 in-between frames each;
  - slide-left direction;
  - fadeColor passing through red.
- `node --test app/host/tests/host-screen-capture.test.mjs`:
  - Part 1, always: off by default, listTargets -32001, layers forbidden, 8 bad specs -32602.
  - Part 2 needs `UJWALAM_SCREEN_CAPTURE_TESTS=1` because it loads win-capture: network fetch and ProgramData hooks. It checks the listTargets shape on the real desktop, that a screen and a window layer load live, and live add.
- `node --test app/host/tests/host-transitions.test.mjs`: the unknown-type check now uses `zoom`, because `wipe` is a type.
- `node --test app/host/tests/host-api.test.mjs`:
  - `allowScreenCapture` false by default;
  - win-capture still disabled;
  - the new methods refused for the markers and clips roles.
- `node --test app/host/tests/host-stinger.test.mjs`: regression for the shared second-transition slot.
- Full `npm run ci`.

## UNVERIFIED

- The OBS meaning of slide `direction: left`. The test expects the new scene to come in from the right.
- That the `monitor_capture` label always carries `WxH @ x,y`. If it does not, width and height are 0.
- `obs_get_source_properties` for `window_capture` filling the window list without a source. It reads the code path in OBS 32.1.2 `window-capture.c` `wc_properties` with null data, which is null-safe.
- Whether loading win-capture with `--allow-screen-capture` opens any window or console. Its offsets helper uses `CREATE_NO_WINDOW` in the OBS source.
- The exact error messages for bad `cursor` values (the tests match `/cursor/`).

## Risks

- **Privacy and network (needs the user's yes):**
  - win-capture fetches `https://obsproject.com/obs2_update/win-capture` at load (D28 kept it off for this reason) and copies graphics hooks to ProgramData.
  - Screen capture shows everything on a display, including chat, notifications and other apps.
  - That is why it sits behind an explicit host switch that the launcher does not pass.
- **Packaging:** the alpha package (`tools/package/build-alpha.mjs`, plugin whitelist) does not ship `win-capture.dll` or its data. A packaged studio cannot use these layers until it is added, after the user's yes.
- **OBS logging:** OBS's own window-capture code logs the captured window's exe name at info level and its class at debug level, but not the title. The host's own logs never hold titles.
- **Window titles in project files:** the `window` spec holds the title. Project files are local user data and never committed; fixtures use placeholders only.
- **Second transition swap while a transition runs:** this follows the stinger path, so a type change mid-transition swaps on the next scene switch. Not tested on air.

## Files

- Host:
  - `app/host/src/screen_capture.{h,cpp}` (new);
  - `model.{h,cpp}`, `studio.{h,cpp}`, `methods.cpp`, `main.cpp`, `app.h`, `obs_runtime.{h,cpp}`;
  - `app/host/CMakeLists.txt`.
- Host tests:
  - `app/host/tests/host-screen-capture.test.mjs` (new), `host-transitions-d391.test.mjs` (new);
  - `host-transitions.test.mjs`, `host-api.test.mjs`.
- Project and UI:
  - `data/schemas/project.schema.json`, `data/transitions/luma-wipes.json` (new);
  - `services/project/validate.mjs`, `services/project/structure.mjs`;
  - `services/studio-ui/server.mjs`, `services/studio-ui/backends.mjs`.
- Tests: `tests/project-schema.test.mjs`, `tests/project-structure.test.mjs`, `tests/studio-ui-server.test.mjs`, `tests/studio-ui-transitions.test.mjs`.
