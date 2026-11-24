# 2026-11-24 Clean-PC check of the single-file setup in Windows Sandbox

Release item (D443 plan, `docs/plan/2026-11-24-ai-post-text-voice.md`, "Release items"): every release build is checked
on a clean Windows in Windows Sandbox (the user enabled it, 2026-11-24): install, first start, model download, uninstall.

## Harness (commit facf2de3)

`node tools/package/sandbox/sandbox-check.mjs [--setup FILE] [--download ID]`

- Refuses unless off air (`tools/live-check.mjs`), no other Sandbox is running, and the setup matches its `.sha256`.
- The Sandbox sees the setup's folder and `tools/package/sandbox/` read-only, and writes only the out folder
  (`C:\AI\Claude\_data\Ujwalam\scratch\sandbox-<version>-<time>`). vGPU on, networking on, 6 GiB, no microphone, camera,
  clipboard or printer.
- `in-sandbox.ps1` (inside, as the Sandbox user):
  1. install: the setup is copied to Downloads and run `--install --quiet`; exit 0, `current.txt` names a version
     folder with `release.json`, `ujwalam-start.exe` and the `Ujwalam-Setup.exe` copy in the install root, desktop and
     Start-menu shortcuts, bundled `runtime\node\node.exe`.
  2. first start: the desktop shortcut's own target and arguments; the launcher log must show `[studio] UI at
     http://127.0.0.1:<port>/` and `[studio] libobs host started`, and a studio window must exist; a screenshot is
     taken; the window is closed and every program under the install root must end within 60 s (found by path).
  3. download: `download-check.mjs` with the installed Node and the installed `downloads.mjs` (the code behind
     Settings > Downloads) fetches one catalogue item from the real host, pauses at a quarter, resumes (HTTP Range),
     and must end ready and pass the before-first-use SHA-256 check. The host status is a stub that says off air.
  4. uninstall: `<install root>\Ujwalam-Setup.exe --uninstall --quiet`; version folder, `current.txt`, launcher and
     shortcuts gone, data folder kept.
- Results: `results.json` (per step: ok, seconds, details), setup logs, launcher and host logs, `first-start.png`.

Not covered: the download is driven from the module, not by clicks in Settings > Downloads (the page's one-time login
key belongs to the studio window); SmartScreen/Mark-of-the-Web on a browser download (the copy has no zone mark).

Trial on the dev PC (off air): `download-check.mjs --install <repo> --data <scratch> --id face-ai-models`: ok, 31,723,029
bytes, paused at 13,909,471 and resumed, ready and verified in 6.6 s. `node --test tests/sandbox-check.test.mjs` 1/1.

## Runs

| Setup | Date | install | first start | download | uninstall | Notes |
|---|---|---|---|---|---|---|
| 0.1.0-alpha.41 | 2026-11-24 | pending | pending | pending | pending | running |
