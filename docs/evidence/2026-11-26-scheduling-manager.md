# Scheduling manager SM1-SM4, 2026-11-26

Plan: `docs/plan/2026-11-25-scheduling-manager.md`. Checked: headless probes (UJWALAM_HEADLESS=1), real UI server, fake host,
placeholder clips, no network, studio not running (`node tools/live-check.mjs`: off air).

Commands and results:
- `node --test tests/studio-ui-schedule-manager.test.mjs`: 4 pass (list route, brief answers, Instagram Post now / Retry, refused while live).
- `node --test tests/studio-qml-schedule-manager.test.mjs`: 9 pass (read only while open, list by day, panel / own window / dock / X,
  search and filters and sort, one request per click for Move / Remove / Upload now / Retry / Instagram, bulk day move with Undo,
  remove all failed, 1000 posts: fewer than 60 rows built, read applied in under 250 ms, Settings button).
- `node --test tests/studio-qml-posting.test.mjs tests/studio-qml-more-windows.test.mjs`: pass (Settings has no per-post row; the More menu has Scheduled posts).

Notes:
- YouTube "Post now" is "Upload now": it uses the existing Retry-now route (uploads at once; the video still goes public at its time).
- Instagram rows have Post now / Retry only (the Instagram queue has no move or remove).
- UNVERIFIED: looks and layout on a real screen (all checks were headless); the 30 s refresh timer while open.

Files: services/posting/schedule-manager.mjs, services/studio-ui/server.mjs, app/studio/qml/Schedule{Center,View,Window}.qml,
Main.qml, OnAirBar.qml, Store.qml, SettingsPosting.qml, app/studio/CMakeLists.txt, and the tests named above.
