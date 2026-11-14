# 2026-11-14 — QML studio parity checklist (plan Q4)

Source: read-only sweep of the widget studio (`app/studio/src/`) against the QML studio (`app/studio/qml/`) on
2026-11-14, Settings excluded (Q3 done). Q4 is done when every row is ticked: present in QML with a QML probe test, or
marked "dropped" with the reason. Order = build order (live use first). Widget file:line refs are in the sweep notes of
the 2026-11-14 handover session.

## A. Live controls and safety
- [x] Go live / Record buttons, LIVE and Recording chips, bitrate chip (Q2)
- [x] Confirm window for held actions (Q2)
- [x] Save clip (host `replay.save`) and Mark moment (host `marker.add`) buttons (Q4 A, `tests/studio-qml-controls.test.mjs`)
- [x] Alert strip (flag `live-test-kit`, status `alerts`, at most 8 lines) (Q4 A, `tests/studio-qml-controls.test.mjs`)
- [x] Close with tasks running: add "Keep running in the tray" and the per-task time text; tray icon, task list, Stop all
      and quit, quit lock while live (`ui/api/quit/*`, `ui/api/tasks/stop`) (Q4 A, `tests/studio-qml-tray.test.mjs` 14/14)
- [x] Task chip and task panel (stage, percent, time left, stuck warning, Stop, Clear finished) and toasts (Q4 A,
      `tests/studio-qml-tasks.test.mjs` 7/7)

## B. Editing
- [x] Undo / Redo buttons and Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (`ui/api/edits*`)
- [x] Arrow-key nudge (1 px, Shift 10 px; off while live); the held "confirm" answer cancel is not probed (the key is off while live, so the server never holds one)
- [x] Layer menu and keys: Rename (F2), Duplicate (Ctrl+D), move up/down/top/bottom, Copy / Paste look
- [x] Layer reorder by drag (press-and-drag; no press-and-hold pick-up, see evidence)
- [x] Scene menu and keys: Rename (F2), Duplicate, Make realism scene (flag `realism-look`), Delete; menu on empty space
- [x] Inspector: X, Y, width, height, rotation, crop, Apply, Undo changes (host `layers.setPlacement`)
      (`InspectorPanel.qml` under the layers; `tests/studio-qml-editing.test.mjs` inspector tests 3/3, file 29/29)
- [x] Look panel (shape, filters, camera, blend, shadow and glow; host `layers.setEffects`) (`LookPanel.qml` from the
      shared table `fx_types.h` via `Api.fxTypes()`; `UValueSlider.qml` slider + number box; editing Look tests 3/3)
- [x] Advanced effects list (flag `effect-editor`, max 6) (`LookPanel.qml` ADVANCED EFFECTS: add, up, down, remove,
      form, Apply sends the list once, Revert sends nothing; editing tests 2/2)
- [x] Preview selection: retry a refused selection after a drag ends (`Store.qml`; a refused retry puts the list back
      to the host's; editing tests 2/2, file 37/37)
- [x] Volume: typed dB box, wheel only with focus (`UValueSlider` in the mixer; `USlider` takes the wheel only with
      focus; editing volume test: typed -6 sent once, unfocused wheel sends nothing, two focused notches -> -8)
- [x] Preview "Own window" and "To front" buttons (host `preview.open` / `preview.focus`; under each preview, never over it;
      `tests/studio-qml-controls.test.mjs`)

## C. Clips and posts
- [x] Clips chip with plain-words state; "Make clips?" question after a recording or stream; first-run Settings
      (`tests/studio-qml-clips.test.mjs` 5/5; the question and first-run Settings open only on a window the user sees,
      as in the widget; the probe puts the question with clips-ask). Review reads (N) beside My clips (`studio-qml-review` 5/5)
- [x] My clips folder button (`ui/api/clips/open`) (`tests/studio-qml-clips.test.mjs`)
- [x] More menu (flag-gated items): Import, Feedback, Posts, Growth numbers, Report, in the widget order with its tips
      (`tests/studio-qml-more-windows.test.mjs` 9/9). Review reads goes beside My clips, as in the widget (row below)
- [x] Posts window (flag `posting`): review, Approve, Reject, Save, Open folder, Upload as private, Check status, Retry
      (`tests/studio-qml-posts.test.mjs` 4/4; Upload is read as enabled/disabled only, never pressed in a test)
- [x] Growth numbers window (flag `growth`) (`65f6e08`, `tests/studio-qml-growth.test.mjs` 5/5)
- [x] Review reads window (flag `learning-review`) (`03cc9ff`, `tests/studio-qml-review.test.mjs` 4/4)
- [x] Import Meld session window (`tests/studio-qml-more-windows.test.mjs`)
- [x] Feedback notes window (`tests/studio-qml-more-windows.test.mjs`)
- [x] Report a problem window (flag `report-button`; only an https://github.com/ link opens, `Api.openLink`)
      (`tests/studio-qml-more-windows.test.mjs`; 7/7 for the three windows)

## D. Panels shown by flags
- [x] Outputs panel in the main window (flag `outputs-panel`) (`OutputsPanel.qml`; `tests/studio-qml-outputs-bots.test.mjs`:
      offline switch saves, live switch stops only that output on the click, + opens Settings > Stream)
- [x] Bots box (flag `bot-manager`) (`BotsPanel.qml`; same test file, 5/5 with the Outputs tests)
- [x] Transitions box in the main window (flag `transitions`) (`TransitionsPanel.qml`: cut, fade with duration, stinger
      with video, point and sound; refused while live; `tests/studio-qml-transitions.test.mjs`)
- [x] Edit scenes and layers box (flag `scene-edit`): dropped in Q2, one Add/Delete place

## E. Help
- [x] "?" help button and help panel (How clips are made, Posting your clips, Show me, Replay tour) (`HelpPanel.qml`)
- [x] Welcome tour (coach marks) and focused tours (clips, posting) (`Guide.qml`, `GuideBubble.qml`; tour text from
      `data/guide/tour.json`, which now says one click, not a typed confirmation, D332)
- [x] Hints (6, auto-hide, dismiss saved) and Settings > Help & tips (tips on/off, reset, replay)
      (`tests/studio-qml-guide.test.mjs`)

## F. Status and look
- [x] Stats: session time, GPU, CPU, FPS with history lines (`StatsPanel.qml` under the side column; the top-bar stats
      chip removed as in the widget, D287; `tests/studio-qml-controls.test.mjs`)
- [x] Status bar in plain words: "UI server not reachable" distinct from "Host not running"; theme-reload error toast
      (`tests/studio-qml-controls.test.mjs`, `tests/studio-qml-themes.test.mjs`)
- [x] Theme tests twinned (`studio-qt-themes`, soft, components, reference themes, reload). Done: `studio-qml-themes`
      (16 tests: every pack's shot and colours, saved/unknown theme at start, live switch, performance, custom folder,
      file reload, each pack's font really loaded, the rejected-reload toast). Not twinned:
      soft painters, component variants and the specimen page are widget-stylesheet features the QML style does not
      have; they come back as a QML design item if the QML studio needs them (the widget tests keep guarding the widgets)

## G. New in QML (plan Q4)
- [x] Command palette, Ctrl+K (`cdd4f11`, `tests/studio-qml-palette.test.mjs` 6/6)
- [x] Palette: Save clip, Mark moment (Q4 A); Undo, Redo, rename and duplicate of the selected layer and of this scene (Q4 B);
      every More menu window (Growth numbers, Review reads, Import Meld session, Feedback notes, Posts, Report a problem;
      each behind its flag)
- [x] Scene hotkeys step 1: Ctrl+1..9 in the studio window, flag scene-hotkeys (D382). Step 2 (global in-game keys, host, clash check) deferred
- [x] Scene builder in the studio (flag `scene-builder`): More > "New scene from a reference…" (`SceneBuilderWindow.qml`),
      routes `services/studio-ui/scene-builder-routes.mjs` (dry-run build in plain words, one-click add, off air only,
      existing state unchanged by hash); `tests/studio-ui-scene-builder.test.mjs` 1/1, `tests/studio-qml-scene-builder.test.mjs` 3/3

## H. Test twins still missing
Done: `studio-tray`, `studio-qt-growth`, `studio-qt-learning-review`, `studio-qt-themes` and reload, the outputs-panel
part of `studio-qt-d327` (`studio-qml-outputs-bots`), `scene-builder-theme`'s studio probe (`studio-qml-themes`: an SB4
pack loads with its colours; component variants are widget-only).

`studio-qt-shell` (73 tests), mapped test by test 2026-11-14: most are covered by the QML files (some partly),
3 are widget-only (QDialog/native-handle lifecycle). Still missing or partial in QML:
- [x] launch key single use (exit 77) and 127.0.0.1-only URL (exit 64) (`studio-qml-shell`)
- [x] default state: flag ids equal `data/flags.json`, defaults off, panels shown/hidden by flag, clip settings defaults
      (`studio-qml-shell`)
- [x] Settings: match filter saved through the settings route (plain words on refusal, the rest saved again without
      it); `ui.motion` read at start and `UJWALAM_REDUCE_MOTION` override; snap off by default, a draft until Save, off
      again; Editing page hint (Layer effects on the Editing page with its summary, no own page) (`studio-qml-settings`)
- [x] flag switch: design difference, not a gap. In QML a flag is a Settings draft applied at Save, one click and no
      text window (`studio-qml-settings` "a real click on a flag switch changes the draft only"); the unknown-flag
      refusal is the flags service's (`flags.test.mjs` "unknown id and non-boolean are refused")
- [x] preview selection: list pick sends `preview.select` once; a hidden layer selects none; host editing off sends
      nothing; a preview click selects in the list with no echo; a V click leaves the H list (`studio-qml-editing`)
- [x] sliders: click jumps and a key steps (Look radius); volume sent once on release; press-hold-drag commits once
      (`studio-qml-editing`, real mouse and key events through the new `drag:` and `key:` probe actions). The held
      spin box has no twin: the QML number box is a typed field (Enter commits), it has no step arrows
- [x] Add layer: text and camera layer with scene editing off; colour needs #RRGGBB (window stays open, nothing sent);
      Add scene says which canvases (`studio-qml-editing`)
- [x] trash button greyed while live with its reason (the reason shows on hover over the greyed button)
      (`studio-qml-editing`)
