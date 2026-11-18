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
  13 (settings backup failed).
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
| `data/core/event-core.db` (+wal/shm) | audit DB, forward-only migrations (`SCHEMA_TOO_NEW` on older code) | VACUUM INTO snapshot | rollback restores the snapshot; the newer -wal/-shm move into the before-rollback backup |
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

## Tests (each file alone, `node --test`, BelowNormal, after `node tools/live-check.mjs` = off air)

```
tests/setup-installer.test.mjs         pass 7  fail 0
tests/package-alpha.test.mjs           pass 18 fail 0 skipped 3 (full build E2E gate, start stub and studio icon: studio not built in the worktree)
tests/live-install-launcher.test.mjs   pass 1  fail 0
tests/lint.test.mjs                    pass 35 fail 0
tests/studio-ui-server.test.mjs        pass 40 fail 0
node tools/lint.mjs                    0 finding(s)
qmllint --bare UpdateButton.qml OnAirBar.qml   exit 0
```

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
- `UJWALAM_DATA_ROOT` is not honoured by the installer: backups cover `<install root>\data` only, the same as before.
- A rollback puts older settings back on purpose. The newer ones are kept in a before-rollback backup, and rolling
  forward restores them.
- There is no Apps & features entry (it would need registry writes). The Start-menu "Ujwalam setup" entry replaces it.
- An uninstall started from the copy inside the install root relaunches from `%TEMP%\ujwalam-uninstall-<pid>\`. That
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
> - Every switch of the version pointer is preceded by a settings backup (newest 10 kept). A rollback restores it,
>   and the newer copies are kept.
> - Uninstall keeps the user's data unless the user ticks the box.
> - The studio offers "Update available" for a newer verified package. It checks on start and on demand only, never
>   installs while live or recording, and the update runs from the next start.
> - Signing, an MSI/MSIX and an Apps & features entry stay P17 work.
