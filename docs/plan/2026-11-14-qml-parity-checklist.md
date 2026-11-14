# 2026-11-14 — QML studio parity checklist (plan Q4)

Source: read-only sweep of the widget studio (`app/studio/src/`) against the QML studio (`app/studio/qml/`) on
2026-11-14, Settings excluded (Q3 done). Q4 is done when every row is ticked: present in QML with a QML probe test, or
marked "dropped" with the reason. Order = build order (live use first). Widget file:line refs are in the sweep notes of
the 2026-11-14 handover session.

## A. Live controls and safety
- [x] Go live / Record buttons, LIVE and Recording chips, bitrate chip (Q2)
- [x] Confirm window for held actions (Q2)
- [ ] Save clip (host `replay.save`) and Mark moment (host `marker.add`) buttons
- [ ] Alert strip (flag `live-test-kit`, status `alerts`, at most 8 lines)
- [ ] Close with tasks running: add "Keep running in the tray" and the per-task time text; tray icon, task list, Stop all
      and quit, quit lock while live (`ui/api/quit/*`, `ui/api/tasks/stop`)
- [ ] Task chip and task panel (stage, percent, time left, stuck warning, Stop, Clear finished) and toasts

## B. Editing
- [x] Undo / Redo buttons and Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (`ui/api/edits*`)
- [x] Arrow-key nudge (1 px, Shift 10 px; off while live); the held "confirm" answer cancel is not probed (the key is off while live, so the server never holds one)
- [x] Layer menu and keys: Rename (F2), Duplicate (Ctrl+D), move up/down/top/bottom, Copy / Paste look
- [x] Layer reorder by drag (press-and-drag; no press-and-hold pick-up, see evidence)
- [x] Scene menu and keys: Rename (F2), Duplicate, Make realism scene (flag `realism-look`), Delete; menu on empty space
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
- [ ] Posts window (flag `posting`): review, Approve, Reject, Save, Open folder, Upload as private, Check status, Retry
- [ ] Growth numbers window (flag `growth`)
- [ ] Review reads window (flag `learning-review`)
- [ ] Import Meld session window
- [ ] Feedback notes window
- [ ] Report a problem window (flag `report-button`)

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
- [ ] Theme tests twinned (`studio-qt-themes`, soft, components, reference themes, reload)

## G. New in QML (plan Q4)
- [x] Command palette, Ctrl+K (`cdd4f11`, `tests/studio-qml-palette.test.mjs` 6/6)
- [ ] Palette: layer commands, Save clip, Mark moment, Undo, the More menu windows (done in Q4 B: Undo, Redo, rename and duplicate of the selected layer and of this scene)
- [ ] Scene hotkeys (nothing exists in either UI; needs a design: studio window keys vs host global hotkeys)
- [ ] Scene builder in the studio (today CLI only, `services/scene-builder/cli.mjs`, flag `scene-builder`; no UI server route)

## H. Test twins still missing
`studio-qt-shell` (73 tests; QML twin has 3), `studio-tray`, `studio-qt-alerts`, `studio-qt-growth`,
`studio-qt-learning-review`, the outputs-panel part of `studio-qt-d327`, the theme tests, `scene-builder-theme`.
