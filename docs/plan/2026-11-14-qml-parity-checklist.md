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
- [ ] Undo / Redo buttons and Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (`ui/api/edits*`)
- [ ] Arrow-key nudge (1 px, Shift 10 px; off while live)
- [ ] Layer menu and keys: Rename (F2), Duplicate (Ctrl+D), move up/down/top/bottom, Copy / Paste look
- [ ] Layer reorder by drag
- [ ] Scene menu and keys: Rename (F2), Duplicate, Make realism scene (flag `realism-look`), Delete; menu on empty space
- [ ] Inspector: X, Y, width, height, rotation, crop, Apply, Undo changes (host `layers.setPlacement`)
- [ ] Look panel (shape, filters, camera, blend, shadow and glow; host `layers.setEffects`)
- [ ] Advanced effects list (flag `effect-editor`, max 6)
- [ ] Preview selection: retry a refused selection after a drag ends
- [ ] Volume: typed dB box, wheel only with focus
- [ ] Preview "Own window" and "To front" buttons

## C. Clips and posts
- [ ] Clips chip with plain-words state; "Make clips?" question after a recording or stream; first-run Settings
- [ ] My clips folder button (`ui/api/clips/open`)
- [ ] More menu (flag-gated items)
- [x] Posts window (flag `posting`): review, Approve, Reject, Save, Open folder, Upload as private, Check status, Retry
      (`tests/studio-qml-posts.test.mjs` 4/4; Upload is read as enabled/disabled only, never pressed in a test)
- [x] Growth numbers window (flag `growth`) (`65f6e08`, `tests/studio-qml-growth.test.mjs` 5/5)
- [x] Review reads window (flag `learning-review`) (`03cc9ff`, `tests/studio-qml-review.test.mjs` 4/4)
- [x] Import Meld session window (`tests/studio-qml-more-windows.test.mjs`)
- [x] Feedback notes window (`tests/studio-qml-more-windows.test.mjs`)
- [x] Report a problem window (flag `report-button`; only an https://github.com/ link opens, `Api.openLink`)
      (`tests/studio-qml-more-windows.test.mjs`; 7/7 for the three windows)

## D. Panels shown by flags
- [ ] Outputs panel in the main window (flag `outputs-panel`)
- [ ] Bots box (flag `bot-manager`)
- [ ] Transitions box in the main window (flag `transitions`) — or dropped: Settings > Transitions covers it
- [x] Edit scenes and layers box (flag `scene-edit`): dropped in Q2, one Add/Delete place

## E. Help
- [ ] "?" help button and help panel (How clips are made, Posting your clips, Show me, Replay tour)
- [ ] Welcome tour (coach marks) and focused tours (clips, posting)
- [ ] Hints (6, auto-hide, dismiss saved)

## F. Status and look
- [ ] Stats: session time, GPU, CPU, FPS with history lines (today one text chip)
- [ ] Status bar in plain words: "UI server not reachable" distinct from "Host not running"; theme-reload error toast
- [ ] Theme tests twinned (`studio-qt-themes`, soft, components, reference themes, reload). Done: `studio-qml-themes`
      (16 tests: every pack's shot and colours, saved/unknown theme at start, live switch, performance, custom folder,
      file reload, each pack's font really loaded). Left: the rejected-reload toast (needs the QML toasts). Not twinned:
      soft painters, component variants and the specimen page are widget-stylesheet features the QML style does not
      have; they come back as a QML design item if the QML studio needs them (the widget tests keep guarding the widgets)

## G. New in QML (plan Q4)
- [x] Command palette, Ctrl+K (`cdd4f11`, `tests/studio-qml-palette.test.mjs` 6/6)
- [ ] Palette: layer commands, Undo (track B). Done: Save clip, Mark moment (Q4 A) and every More menu window
      (Growth numbers, Review reads, Import Meld session, Feedback notes, Posts, Report a problem; each behind its flag)
- [x] Scene hotkeys step 1: Ctrl+1..9 in the studio window, flag scene-hotkeys (D382). Step 2 (global in-game keys, host, clash check) deferred
- [ ] Scene builder in the studio (today CLI only, `services/scene-builder/cli.mjs`, flag `scene-builder`; no UI server route)

## H. Test twins still missing
`studio-qt-shell` (73 tests; QML twin has 3, plus the clip/mark and task parts in Q4 A), the outputs-panel part of
`studio-qt-d327`, `scene-builder-theme`. (Done: `studio-tray`, `studio-qt-growth`, `studio-qt-learning-review`, `studio-qt-themes` and reload.)
