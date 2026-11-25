# 2026-11-25 Studio crash (pure virtual call), close button, GUI stalls and the stats clock

User report (alpha.43, recording 2026-11-25 20:21-21:27 UTC): the close button works only sometimes; the app feels slow;
the stats card showed "00:04:17 Recording" during a 66-minute recording.

## 1. Crash: lag monitor read a deleted object (fixed, commit deee0209)

- Evidence: 4 crash reports during the recording (20:29:00, 20:35:34, 21:06:32, 21:07:02), all `kind: pure virtual
  function call`, `#00 ujwalam-studio.exe+0x732a4`, `#02 +0x2f6d4`, then `QCoreApplication::notifyInternal2` /
  `sendPostedEvents`. The launcher log has a line for each one: "Qt shell ended unexpectedly (exit 0xc0000409) ...
  Reopening the window in 2 s".
- Symbols: the installed alpha.43 exe's CodeView GUID `510E6EE3-6C20-4FE1-B46BD096C6DAB6B9` (age 187) matches
  `out/studio/build/ujwalam-studio.pdb` (same GUID, age 188: one later incremental link, a QML-only commit). The code
  bytes at all four offsets are identical in the installed exe and the build-folder exe (64-byte compare). Resolved
  with MSVC `llvm-symbolizer`: `+0x2f6d4` = `lagmon::TimedApplication<QApplication>::notify`, `lag_monitor.h:123`;
  `+0x732a4` = the crash reporter's `on_purecall`. The alpha.41 and alpha.42 reports (5 since 2026-11-22, the day the
  lag monitor came in with D432) symbolise to the same line.
- Root cause: `notify` called `receiver->metaObject()` after `Base::notify(receiver, e)`. When an event of 20 ms or more
  deleted its receiver (a deferred delete, a window destroyed in its own handler), this was a virtual call on freed
  memory. The studio window died and came back 2 s later.
- Fix (`app/studio/src/lag_monitor.h`): a `QPointer` taken before delivery and the event type read before delivery;
  only a living receiver is named, a deleted one is logged as "(deleted object)".
- Close button: the crash is the likely reason the close button "did nothing" (window gone, reopened by the launcher).
  UNVERIFIED that the 4 crashes were close clicks: the studio log does not record clicks. The close path itself
  (`Main.qml` `onClosing`) is synchronous and short: the close dialog when tasks run and not live, otherwise
  `Qt.callLater(Qt.quit)`.

## 2. Stats clock (fixed, commit 2827473d)

- Root cause: `StatsPanel.qml` set `since = Date.now()` on the first status that showed live/recording, so each reopened
  window (crash) started at 00:00:00.
- Fix: `host.status` returns `streamMs` and `recordMs` (`Outputs::clocks`, the same clocks markers use; null when none
  runs) (`app/host/src/methods.cpp`); the UI server passes them in `ui/api/status` (`services/studio-ui/server.mjs`);
  StatsPanel shows the stream clock while live, else the record clock, ticking every second and resynced when it drifts
  more than 1.5 s. Fake host has the same clocks (`sessionAgeMs` for tests).
- Before: probe with a recording that started 1 h before the window: `"session":"00:00:29"`. After: `"01:00:30"`.

## 3. GUI-thread stalls (measured; not fixed)

Measured with a headless probe (fake host, recording on, 12 tasks updating every 500 ms, 30 s; script kept in
`C:\AI\Claude\_data\Ujwalam\scratch\lag-measure.mjs`):

| | before | after |
|---|---|---|
| `ui/api/status` callback, per poll | avg 12 ms, max 18 ms | avg 13 ms, max 16 ms |
| largest gap | 231 ms (first answer at start-up) | 224 ms |
| frames rendered in 30 s with a task running | 1884 (none running: 59) | unchanged |

- The 200-320 ms `ui/api/status` gaps in the user's logs do not reproduce with the fake host (12-18 ms). The likely
  cause is the user's real status during a recording plus a JavaScript garbage-collection pass under load. UNVERIFIED.
- Found: while any task runs, the task chip's spinner or breathing dot (`TaskChip.qml`) animates without stopping, so the
  whole studio window is redrawn at about 60 frames per second for the whole recording (1884 frames in 30 s, against
  59 when idle). This is the biggest piece of GUI-thread work measured. It is not changed here because a lower frame rate
  changes how the spinner looks. Proposed: step the indicators with an 8-12 Hz timer.
- Start-up: the window build after a reopen took 6.0 s on the laptop during the recording (studio log 21:06:42,
  `qml 5968`); 0.2 s headless here. Not changed.

## Tests

- `node --test tests/studio-qml-controls.test.mjs`: 9/9 pass (new: a window opened on a recording 1:02:03 old shows
  01:02:xx; live and recording show the stream clock).
- `node --test --test-name-pattern="GUI-thread budget" tests/studio-qml-settings.test.mjs`: 1/1 pass.
- `node --test app/host/tests/host-api.test.mjs`: 16/16 pass (status keys `streamMs`/`recordMs`; `recordMs` runs while
  recording, `streamMs` null).
- `node tools/lint.mjs`: 0 findings. Commit hooks: quick CI 9/9 for both commits.
- No regression test reproduces the crash itself: it needs freed memory to hold a stale vtable. Verified by code reading
  and the symbolised stacks.

## Needs a device test (UNVERIFIED)

- Installed build with these fixes: record for about an hour, close and reopen the window several times; expect no
  `studio-crash-*` reports, close works on every click, and the stats card shows the full recording time.
