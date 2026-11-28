# 2026-11-28 Self-opening popups moved to FloatSurface

Branch `fix/float-self-open`, from `codex/reel-mix-long-video` (feb9981f). Background:
`docs/evidence/2026-11-27-click-loss-fix.md`, `docs/evidence/2026-11-27-popup-click-steal.md` (an earlier, uncommitted
audit with the same result, read and reused).

Rule: Qt 6.8 sends mouse input to the newest open popup window. A popup window that opens without a user click takes
the clicks of the popup the user is using. Dialogs the user opens and closes with a click are fine.

## Audit: every Popup.Window user in app/studio/qml

A = can open without a user click. B = opens only from a direct click or key.

| File | Opens from | Class | Action |
|---|---|---|---|
| ClipsAsk | `Store.takeClips` on the status poll, after a stream or recording ends (`clipsAsk` signal, `Main.qml` `onClipsAsk`) | A | Moved to FloatSurface |
| SettingsDialog (main) | user click; once at first run from the status poll (`settingsWanted("")` in `Store.takeClips`) | B, one A path | Not moved (below) |
| ConfirmDialog | `confirmNeeded`: always the answer to a click (Store, EditOps, LookPanel, InspectorPanel, OutputsPanel, ImportWindow, BotsPanel all call it from a click callback) | B | Left; modal |
| CloseDialog | window close, tray quit | B | Left |
| GoLiveDialog | Go live click, after the HTTP answer | B | Left |
| ReportDialog, FeedbackWindow, GrowthWindow, ReviewWindow, PostsWindow, ImportWindow, YoutubeWindow, BeatDropWindow, SceneBuilderWindow, ScenarioWindow, LookReferenceDialog, OutputDialog, ClipsFromRecording | menu item, button or palette entry | B | Left |
| AddLayer/AddScene/AddAudio dialogs, AudioToolsWindow, SceneMusicWindow, NameDialog | click on a menu or panel button | B | Left |
| CommandPalette | Ctrl+K | B | Left |
| UMenu (context menus) | click, closes on outside click | B | Left |
| Main.qml `ToolTip.toolTip` | hover | B (user driven) | Left; UNVERIFIED |
| TaskCenter (panel, toasts), ScheduleCenter | store signals | A | Already FloatSurface (2026-11-27) |

Checked and not popup windows: the Guide (item in the studio window), alerts, `TrayFlow` (opens nothing), Theme
"rejected" notice (goes through `TaskCenter.notice`). `youtubeEventsWanted` (Store, after a Start answer) opens the
YouTube window as the answer to the user's Go live click: B.

## Not moved

- SettingsDialog first run: about 900 lines, nested modal question, many combo boxes. It opens by itself once, at first
  start only. The only other surfaces then are task toasts (tool windows, not popups), so no older popup exists to lose
  clicks. Moving it risks look and keyboard changes for a once-only case. Flagged, not changed.

## Change

`app/studio/qml/ClipsAsk.qml` is an `Item` holding a `FloatSurface` (frameless tool window owned by the studio window).
Kept: objectNames (`clipsAsk`, `clipsAskRemember`, `clipsAskNo`, `clipsAskYes`, `clipsAskLook_*`), words, Theme tokens, the
Dialog's look (panel with border, 18 px title row, 12 px content inset, 60 px footer), width min(480, window - 40),
centred over the studio window, `takesFocus` (keyboard for Escape), hidden test mode (drawn inside the window,
`inWindow` false). Escape = Not now through a `Shortcut`. `store.clipsAsking` is true from `put` until the answer.
`LazyDialog` needed no change (its Loader fills the window, which the surface centres in). Probe: `clips-ask`,
`clips-answer`, `clips-look` as before; new `clips-click:<yes|no>` presses the real button; probe adds `inWindow`,
`surfaceOpened`.

## Tests

- `tests/studio-float-self-open.test.mjs` (static, no studio): the self-opening files use FloatSurface and contain no
  Popup.Window; ClipsAsk keeps names, Escape shortcut, focus and centring.
- `tests/studio-qml-clips.test.mjs`: new test, the surface is drawn in the hidden window and the real buttons answer.

Why no headless click-steal test: the offscreen headless run uses Popup.Item, which has no popup chain, so the loss
cannot occur there (see 2026-11-27-click-loss-fix.md). It needs real Windows windows and system mouse input.

## Results

```
$ node --test tests/studio-float-self-open.test.mjs
ℹ tests 4   ℹ pass 4   ℹ fail 0
$ git commit (hook: ci --quick)
build PASS, lint PASS, build-host PASS, build-studio PASS (compiles the QML), validate-* PASS, private-scan PASS, legacy-verify PASS
ci: 9/9 passed
```

## UNVERIFIED

- `tests/studio-qml-clips.test.mjs` (including the new test) was NOT run: the studio restriction was in force. The CI log
  `2026-11-28-ci-a54.log` never got a `ci: N/N` line (its CI process ended at 11:17 with only bench lines), and other
  `ujwalam-studio.exe` test processes were running from the main checkout, so no studio was launched from this branch.
  Run: `node --test tests/studio-qml-clips.test.mjs` after `node app/studio/tools/build.mjs`.
- Real-window behaviour (tool window placement, Escape through the Shortcut in a non-popup window, combo box popups
  inside a tool window, transparent rendering and scaling on the user's displays, click routing with a user popup
  open) is UNVERIFIED. The 2026-11-27 harness (Win32, system mouse input) shows the fix shape works for panels.
- Tooltips: not checked whether a tooltip window opened after a popup can take its click.
