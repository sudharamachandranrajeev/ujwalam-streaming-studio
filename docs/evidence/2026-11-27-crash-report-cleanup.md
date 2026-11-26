# Crash report cleanup (2026-11-27)

User choice 2026-11-27: the app clears old crash reports by itself (option b).

## Problem found

The crash reporter (`app/host/src/crash.cpp`, shared by host and studio) stops writing once `kMaxReports` (10)
report files are in the logs folder, and deleted nothing. The installed studio had exactly 10
`studio-crash-*.txt` (alpha.43 and older, 2026-11-17 to 2026-11-25), so the next studio crash would have left no report.

## Change

`crash::install` now, before counting:

1. deletes `<prefix>*.txt` reports whose last write is older than `kKeepDays` (14);
2. then deletes the oldest (name order = UTC time order) until one more report fits under 10.

A report that cannot be deleted stops the cleanup; the limit then holds and nothing is written (as before). A crash
loop stays bounded: each start frees at most one slot, each crash fills one. Only files matching the program's
report prefix are touched. `Status.removed` is logged by the host (`main.cpp`) and the studio (`studio_log.cpp`).

## Evidence

- `npm run build:studio`, `npm run build:host`: built.
- `node --test tests/studio-crash-capture.test.mjs`: 6/6 pass, including the new
  "reports older than 14 days are deleted at start; recent ones and other files stay" and
  "ten recent reports: the oldest goes, so the next crash is still written".
- `node --test app/host/tests/host-crash-report.test.mjs`: 9/9 pass. The old "10 reports: write nothing, delete
  nothing" test is split into "10 recent: oldest deleted, new written" and "10 read-only: nothing written, none
  changed".
- `node tools/lint.mjs`: 0 findings.

UNVERIFIED: the installed app's own folder is cleaned only after the user installs a build with this change.
