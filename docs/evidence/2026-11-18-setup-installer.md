# 2026-11-18 Setup installer: Ujwalam-Setup.exe, settings safety, Update available

Branch `feat/setup-installer` (worktree). Status: **tests pass; the GUI window and the studio button are not yet tried
by the user (UNVERIFIED on screen).** Proposed decision for the D3 exception: see the end.

## What was built

- `app/setup/` — `Ujwalam-Setup.exe`, Win32 only (no Qt), MSVC + CMake, static C++ runtime. It is 260 KiB and imports
  only Windows DLLs (bcrypt, comctl32, gdi32, kernel32, shell32, user32). It has a full VERSIONINFO, the app icon and an
  `asInvoker` manifest (never elevates; without it, Windows' installer detection would elevate an exe named "Setup").
  Build: `npm run build:setup` (vcvars via vswhere, `-j 4`, below-normal priority) into `out/setup/build`.
- The package is **not** inside the exe. Setup reads `ujwalam-<version>-win64.zip` and its `.zip.sha256` from the
  folder Setup sits in, or from `updateFolder` in `data\ujwalam.json`, or from `--package`. Why: an exe that carries
  and unpacks an archive is the shape Defender's ML verdicts flag (D249 history), and an appended payload means a
  custom unpacker. Next to the zip, Setup only hashes (BCrypt SHA-256), unpacks with `%SystemRoot%\System32\tar.exe`
  and runs the tested `Install-Ujwalam.ps1` with `-AdoptPackage`, hidden (`CREATE_NO_WINDOW`), streaming its lines
  into a small progress window.
- `tools/package/settings-backup.mjs` — backup, restore and verify, run by `Install-Ujwalam.ps1`.
- `Install-Ujwalam.ps1` — new switches: `-Repair`, `-Uninstall [-DeleteData]`, `-UpdateFolder`, `-AdoptPackage`,
  `-NoHandOver`. A settings backup runs before every pointer switch. Rollback restores settings. Running detection
  uses paths only and skips the installer's own parent (Setup). There is a Start-menu entry "Ujwalam setup (update,
  repair, uninstall)". New exit codes: 11 (uninstall refused, Ujwalam runs), 12 (rollback refused, Ujwalam runs),
  13 (settings backup or restore failed, or no backup for a rollback), 14 (another setup is working).
- `npm run package:alpha` puts `Ujwalam-Setup.exe` in the zip (top level, a SHA256SUMS entry, so the install root
  gets a copy) and next to the zips in `out/dist`, with a `.sha256`. It fails closed when Setup is not built.
- Studio: `services/studio-ui/setup-update.mjs` (`GET/POST /ui/api/setup/update`) plus `app/studio/qml/UpdateButton.qml`
  in the on-air bar, and **More > Check for updates**. The studio checks on start and on demand only. While an
  install runs it re-reads every 3 s until the install ends.

## Settings inventory (read from the user's install, names only, 2026-11-18)

| Where | What | Backed up | Survives update/rollback |
|---|---|---|---|
| `data/core/*.json` | settings, flags.local, host-config, host, stream-setup, connections, integrations, system, youtube-events, youtube-live | yes | yes (data is outside version folders; restored on rollback) |
| `data/core/pseudo.key` | pseudonym key | yes | yes |
| `data/core/event-core.db` (+wal/shm) | audit DB, forward-only migrations (`SCHEMA_TOO_NEW` on older code) | VACUUM INTO snapshot | rollback first folds the WAL into the file (checkpoint), then backs it up (before-rollback) and swaps in the snapshot |
| `data/core/projects/*.json`, `*.bak`, `_old/` | projects and the D391 migration copies | yes | yes |
| `data/core/{outputs,posting,clips,learning-store,tasks}/*.json` | output, posting and clip records | yes (json only, ≤ 4 MiB each) | yes |
| `data/host/*.json`, `host/obs-config/*.json` | host module config | yes | yes |
| `data/bots/*.json`, `data/ujwalam.json`, `data/profile.local.json` (+`.bak-*`) | bots, launcher config, profile | yes (`.bak-*` profile copies: no, they are not .json) | yes |
| `data/core/api.json` | API token, made fresh each start | no | regenerated |
| logs, `core/live`, `host/live`, `core/live-clips`, `diag`, `feedback` | runtime state | no | untouched |
| media: clips mp4, posting mp4, recordings mkv, CEF cache | large files | no | untouched (never inside a version folder) |
| Windows Credential Manager `Ujwalam/*` (16 entries) | stream keys, tokens | hashes of the target names only | verified present after install; never read |
| `%APPDATA%\Ujwalam Studio\themes`, `%LOCALAPPDATA%\Ujwalam Studio\cache` | Qt custom themes, pipeline cache | no (outside the install root) | untouched by install and uninstall |

There is no registry use and no QSettings. Inside a version folder, the only file not in `SHA256SUMS.txt` is
`bin/debug.log` (a CEF debug log). It is harmless; `-Repair` ignores extra files.

## Codex review of c505cc4 (2026-11-18): findings and fixes

The branch was rebased onto `claude/alpha0-d1` (1bcb7de) first. Each finding was checked against the code; all of them
held. Two are fixed by argument as well as by code (1, 4).

| # | Finding | Fix |
|---|---|---|
| 1 (P1) | The live check runs once; Setup alone never checks | The route asks again right before Setup starts (after the package hash). Argued: the install itself never touches the running studio. Live install (D349) replaces nothing in use, and the switch writes only `current.txt`/`previous.txt`, which only `ujwalam-start.exe`/`Ujwalam.cmd` read, at start. Data is restored only by a rollback. A rollback, a repair over the running version and an uninstall all refuse while Ujwalam runs (by path), under the new lock (7), so nothing can start in between. |
| 2 (P1) | Rollback restored file by file; the WAL was moved aside | `restore()` is all or nothing. It checks the whole snapshot first (SHA-256 of every file, safe paths only). It checkpoints the live database (`wal_checkpoint(TRUNCATE)`; it refuses if the database is busy or the WAL stays non-empty) and takes the before-rollback backup. Then it stages every file next to the backups, checks the staged copies, and swaps each file with one rename, following a journal. Any error undoes the swaps. An interrupted restore (journal "swapping") is undone by the next backup or restore run. |
| 3 (P1) | Ten repairs could prune the only rollback snapshot; a missing one reported success | Prune keeps the newest 10 **plus** the pinned snapshot: `Install-Ujwalam.ps1` passes the previous to current pair on every backup, and a restore pins the roll-forward snapshot. `restore` exits 3 when there is no snapshot. The installer then refuses the rollback (13) with the pointers unchanged, and `-Rollback -Force` switches anyway with the current settings left as they are. Node or the helper missing also refuses now. |
| 4 (P1) | The zip's script runs before the inner check; the studio runs whatever Setup.exe is in the build folder | **Accepted risk** (the user's own build folder; signing is P17, D3). Anyone who can write `out\dist` can change Ujwalam itself, so checksums detect damage, not an attacker. Cheap checks added: Setup runs `Install-Ujwalam.ps1` only when it matches its line in the package's `SHA256SUMS.txt` (21 otherwise). The studio runs the build folder's `Ujwalam-Setup.exe` only when it matches its `.sha256`, and otherwise falls back to the installed copy. |
| 5 (P1) | Hash and unpack read the zip separately (TOCTOU) | The zip is copied into Setup's own work folder; the copy is hashed and the copy is unpacked. |
| 6 (P1) | A predictable `.setup-<pid>` could be a junction | The work folder is `.setup-<pid>-<16 random hex>`, made with `CreateDirectory`, which fails on any existing name or link, and it is checked not to be a reparse point. The same applies to the temp folders of uninstall and relaunch. `removeTree` removes a link at the top as a link and never walks into one. `-Uninstall` removes a junctioned `.setup-*`/version folder as a link (Windows PowerShell's `Remove-Item -Recurse` would empty its target). |
| 7 (P2) | No install-root lock | `Install-Ujwalam.ps1` holds `<root>\install.lock` (no sharing, delete-on-close) for every install, repair, rollback and uninstall. A second one stops with 14. `run-installed.mjs` refuses to start: "Ujwalam setup is installing, updating, repairing or rolling back right now. Nothing was started…" The lock is gone when the script ends, even when killed. |
| 8 (P2) | `updateFolder` was written before the checks; a retry said "already installed" | `-UpdateFolder` is checked first and written only after the switch. A version folder that `current.txt` does not name is reused when it is the same build and intact (its `SHA256SUMS.txt` is the package's). Otherwise it is kept aside as `.replaced-<time>` and installed again. |
| 9 (P2) | Big files and unreadable folders were silent; `UJWALAM_DATA_ROOT` was ignored | A settings file over 4 MiB is named in the output and in `backup.json` (`skipped`); it stays as it is on a rollback. An unreadable folder stops the backup, and so the install (13). The installer and Setup resolve the data root like the launcher: `UJWALAM_DATA_ROOT`, else `<root>\data`. |
| 10 (P2) | Setup's automatic `-Rollback` after a shortcut failure is refused while the studio runs | Removed. After the switch the installer finishes the job: a shortcut that cannot be written is a warning ("installed and works; Repair puts it back"), exit 0, and the same goes for saving `updateFolder`. Before the switch every failure leaves the old version in place. |
| 11 (P2) | A synchronous spawn throw left `installing` stuck | The exe is resolved once per POST. A throw clears `installing`, records the reason in `last`, and answers 500 `not-started`; a retry is possible. |
| 12 (P3) | GUI mode exited 0 after a failure | The window mode returns the last action's exit code. |

## Tests (each file alone, `node --test`, BelowNormal, after `node tools/live-check.mjs` = off air)

After the Codex review fixes (rebased on 1bcb7de, Setup rebuilt):

```
tests/setup-installer.test.mjs         pass 11 fail 0
tests/package-alpha.test.mjs           pass 20 fail 0 skipped 1 (full build E2E: set UJWALAM_PACKAGE_E2E=1)
tests/live-install.test.mjs            pass 12 fail 0
tests/live-install-launcher.test.mjs   pass 1  fail 0
tests/studio-ui-server.test.mjs        pass 40 fail 0
tests/lint.test.mjs                    pass 35 fail 0
node tools/lint.mjs                    0 finding(s)
```

First round (c505cc4): setup-installer 7/7, package-alpha 18 pass 3 skipped, `qmllint --bare UpdateButton.qml
OnAirBar.qml` exit 0.

New in `tests/setup-installer.test.mjs` for the review:
- Restore all or nothing: a failure at the 5th rename leaves every file as B's and removes the staging folder. A
  journal left "swapping" (power loss) is undone by the next run.
- WAL: a row that lives only in `event-core.db-wal` (copied while open, as after a crash) ends up in the
  before-rollback backup and comes back on roll-forward.
- Pin: after an update and 12 repairs, the update's snapshot is still there (11 kept). Unpinned, it is gone and
  `restore` reports `missing` with nothing changed. A file over 4 MiB is named in `skipped` (result and `backup.json`).
- Damaged snapshot: refused before any file changes or any before-rollback backup is taken.
- Installer: with `install.lock` held by another process, install and uninstall stop with 14 and `installBusy()` (the
  launcher's check) is true. Killing the holder releases it. A failed settings backup (13) leaves `current.txt` and
  every setting, `updateFolder` included, unchanged. The retry with a good package keeps the broken folder aside and
  installs; `updateFolder` is written then. A rollback with its backup deleted is refused (13); `-Force` switches and
  keeps the settings. A junction named `.setup-*` is removed as a link on uninstall, and its target's file stays.
- Setup: a zip whose `Install-Ujwalam.ps1` does not match its `SHA256SUMS.txt` is refused (21), and the work folder is
  removed.
- Route: a build-folder `Ujwalam-Setup.exe` without a matching `.sha256` is not run. A stream that starts during the
  package check is caught by the second ask (409, no spawn). A spawn that throws leaves nothing "installing", reports
  500 `not-started`, and a retry is possible.

`tests/setup-installer.test.mjs` covers:
- What is in and out of a backup.
- Update A to B: no file changes.
- B migrates a project, changes settings, adds a file and moves the DB to schema 6.
- Rollback: A's files and DB (schema 5) are back, B's copies are kept, and B's own new file stays.
- Roll forward: B's settings and DB are back.
- A tampered backup is refused. Pruning keeps the newest N and never removes a folder it did not make.
- The `Install-Ujwalam.ps1` run, in order:
  1. Install A, write the data, update to B: "settings backup: 19 files and the event database" and "settings kept:
     all 20 files". The data folder is byte-identical.
  2. Roll back: "20 files put back".
  3. Rollback and uninstall are refused while a program runs under the root (codes 12 and 11).
  4. Repair: intact first, then damaged and fixed.
  5. Uninstall keeps the data; shortcuts and program files go.
  6. Reinstall over the kept data: a backup with reason install.
  7. `-Uninstall -DeleteData` removes the root.
- `Ujwalam-Setup.exe --quiet`:
  - Installs from a zip and remembers the update folder.
  - Updates by discovering the zip through that folder; nothing is lost.
  - Refuses an older package (26), a bad checksum (21) and a missing zip (21).
  - Rollback restores the settings. Uninstall keeps the data. Bad arguments give 23; nothing installed gives 24.
- PE checks: imports, version strings, asInvoker.
- Route, with seams: newest verified package only; `no-setup`; `not-verified`; refused while live, while recording, or
  when the state is unknown; one install at a time; exit-code messages; a checkout run reports `not-installed`.

### Real package, temp install root

`build-alpha.mjs --out-dir %TEMP%\ujw-pkg-dry` (studio exes from the main checkout's build) produced:
- `ujwalam-0.1.0-alpha.34-win64.zip` (180 MB) with its `.zip.sha256`
- `Ujwalam-Setup.exe` and `Ujwalam-Setup.exe.sha256`

`Ujwalam-Setup.exe --quiet --install --install-root %TEMP%\ujw-real-install\Ujwalam --no-shortcuts` exit 0 in 24 s:

```
package checksum ok (SHA-256 6a020e85e56fc372...)
Node.js 26.12.1 (needs 22.13.0): ok
Visual C++ x64 runtime 14.51.36247 (needs 14.44.0): ok
checksums ok
stream keys and sign-ins in Windows Credential Manager: 16 (names checked, never read)
installed: current 0.1.0-alpha.34
settings kept: all 1 files are in place; stream keys and sign-ins: 16 of 16 still in Credential Manager
```

Then `--quiet --uninstall --delete-data` exit 0: the root was removed. No process was left running, and the temp
folders were deleted.

## Not run

- Full `npm run ci` (the user's studio may be open; rule) and the host/GPU tests.
- `tests/studio-qml-more-windows.test.mjs`: its expected More items now include `updates`. It needs the studio built
  from this branch, which was not done in the worktree.
- The Setup window (GUI mode) and the uninstall question were never shown: tests stay windowless. Manual check below.
- The studio's Update available button on screen, and an install through it against a real install.

## Manual steps for the user

1. In the main checkout, after merge: `npm run build:setup`, `npm run build:studio`, `npm run package:alpha`.
2. Double-click `out\dist\Ujwalam-Setup.exe`. It shows Installed alpha.33 and Package alpha.N, with **Update to
   alpha.N**. One click runs the update. Ujwalam may be open; the new version runs from the next start.
3. If Defender flags `Ujwalam-Setup.exe` (unsigned, new hash each build), use the same steps as the host (D249):
   - submit a false-positive report;
   - add a Defender exclusion for `C:\AI\Claude\Ujwalam\out\` only if needed.

## Risks

- Defender ML on a new unsigned exe named Setup. Mitigations: version info, an icon, an asInvoker manifest, no
  payload, no packer, and only Windows DLLs. There is still no signature.
- A repair of a damaged copy leaves a `<version>.replaced-<time>` folder; uninstall removes it.
- A custom `-InstallRoot` without `UJWALAM_DATA_ROOT` uses `<root>\data`, while the launcher's default is
  `%LOCALAPPDATA%\Ujwalam\data`. The two agree for the default root, which is the only one Setup uses unless it is
  given `--install-root` (tests).
- Accepted (finding 4): the package and Setup are unsigned and trusted because they sit in the user's own build folder.
  Checksums catch damage, not an attacker who can write that folder. Signing is P17 (D3).
- The lock applies to versions from this one on. A rollback to an older version leaves that version's launcher
  without the lock check, but the rollback itself still holds the lock while it runs.
- The windowless start (`ujwalam-start.exe`) shows no message box by design (D191 era); while Setup holds the lock,
  the refusal goes to the launcher log. Setup's own window shows the work in progress.
- A rollback puts older settings back on purpose. The newer ones are kept in a before-rollback backup, and rolling
  forward restores them.
- There is no Apps & features entry (it would need registry writes). The Start-menu "Ujwalam setup" entry replaces it.
- An uninstall started from the copy inside the install root relaunches from `%TEMP%\ujwalam-uninstall-<pid>-<random>\`. That
  copy is left there; Windows' temp cleanup removes it.
- An Update click while a build is rewriting `out\dist`: Setup verifies the zip checksum again before it unpacks.

## Proposed decision (for the decisions file; not written there)

> **D3 amendment: Ujwalam-Setup.exe before P17 (2026-11-18, user request).**
>
> One per-user `Ujwalam-Setup.exe` is allowed before P17. It installs, updates, repairs, rolls back and uninstalls
> from the build folder (`out\dist`).
>
> - It is Win32 only, with no admin rights and no payload: the verified zip sits next to it, it unpacks with the
>   system's tar, and it runs `Install-Ujwalam.ps1` hidden.
> - Every switch of the version pointer is preceded by a settings backup. The newest 10 are kept, plus always the one
>   a rollback of the current version needs.
> - A rollback restores that backup all or nothing: the whole snapshot is checked first, the database's log is folded
>   in, the newer files are kept in a before-rollback backup, and the files are swapped through a journal that undoes
>   itself on any failure. With no backup a rollback is refused (`-Force` keeps the current settings).
> - One setup at a time (`install.lock`); Ujwalam does not start while it is held. A rollback, repair over the running
>   version, or uninstall is refused while Ujwalam runs. An update while Ujwalam runs touches nothing it uses and runs
>   from the next start.
> - Uninstall keeps the user's data unless the user ticks the box.
> - The studio offers "Update available" for a newer verified package. It checks on start and on demand only. It
>   never installs while live or recording, and asks again right before Setup starts. The update runs from the next
>   start.
> - Accepted risk until P17: the package and Setup are unsigned and trusted as the user's own build folder; checksums
>   catch damage only.
> - Signing, an MSI/MSIX and an Apps & features entry stay P17 work.
