# 2026-11-14 — Q4: More menu windows in the QML studio

Plan Q4, parity checklist section C. QML twins of the widget studio's More menu windows, each in its own window
(`Popup.Window`; drawn inside the never-shown window in hidden test mode), each in the command palette behind the same
flag as its widget menu entry.

| Window | QML file | Server routes | Flag |
|---|---|---|---|
| Growth numbers | `GrowthWindow.qml` | `ui/api/growth`, `ui/api/growth/refresh` | `growth` |
| Review reads | `ReviewWindow.qml` | `ui/api/learning/review`, `/frame`, `/confirm` | `learning-review` |
| Feedback notes | `FeedbackWindow.qml` | `ui/api/feedback`, `ui/api/feedback/note` | none (as the widget) |
| Report a problem | `ReportDialog.qml` | `ui/api/report-url` | `report-button` |
| Import Meld session | `ImportWindow.qml` | `ui/api/project/import-meld`, `ui/api/project/load` | none (as the widget) |
| Posts | `PostsWindow.qml` | `ui/api/posts*` (list, edit, status, open, auto, auto/preview, queue/retry, youtube/status, upload, check) | `posting` |

Safety kept from the widget:
- Report: the server builds and redacts the link; the new `QmlApi::openLink` opens only a strict-mode `https://github.com/`
  URL (anything else: `refused`), and never opens a browser under `UJWALAM_HEADLESS=1` (`headless`). Nothing is sent from
  the studio.
- Import never changes existing scenes; Load goes through `ui/api/project/load`, and a held live change asks through the
  confirm window (`store.confirmNeeded`).
- Posts: Upload as private is enabled only when signed in and the package is approved; the server re-checks that nothing
  is live. The dry run of the auto-post rules writes and sends nothing. The tests never press Upload.
- Found while building: an action's outcome (Retry now, Upload, Check status) was replaced by the list text when the list
  reloaded (the widget has the same order). The QML window keeps the outcome on the info line.

## Evidence

Headless probe (`UJWALAM_HEADLESS=1`, offscreen platform, never on a screen), real UI server, fake host, temp folders:

```
node --test --test-concurrency=1 tests/studio-qml-more-windows.test.mjs tests/studio-qml-posts.test.mjs
  tests 11, pass 11, fail 0      (Feedback 2, Report 3, Import 2, Posts 4)
node --test --test-concurrency=1 tests/studio-qml-posts.test.mjs tests/studio-qml-tray.test.mjs tests/studio-qml-palette.test.mjs
  tests 25, pass 25, fail 0
```

Growth 5/5 and Review 4/4: see their commits (`65f6e08`, `03cc9ff`).

A QML pitfall found: `Dialog.result` is a FINAL property, so a Dialog cannot declare its own `result` (the window failed
to load: "Cannot override FINAL property"). The Report window names it `outcome`.
