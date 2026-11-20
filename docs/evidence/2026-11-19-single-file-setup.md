# 2026-11-19 Single-file setup: everything bundled, in-app download manager

User request (2026-11-19): "installer needs to be a single file with everything that should be ready to go", "everything",
and "any downloadable needs to have a download manager within the app". Goal: on a fresh Windows 11 x64 PC with nothing
else installed, one `Ujwalam-Setup-<version>.exe` installs Ujwalam, and then the user can stream, record, use the studio
and overlays, and make clips.

Status: in progress (steps 1-5 below). Each step is committed on branch `claude/single-file-setup`.

## Step 1: runtime dependency inventory (2026-11-19)

Read from the code at 976c4af (`claude/alpha0-d1`) and the dev PC. "Today" is how alpha.35 gets each item.

| # | Dependency | Who needs it | Today | Decision |
|---|---|---|---|---|
| 1 | Node.js >= 22.13 (`release.json nodeMin`) | launcher (`run-installed.mjs`), every Node service, `Install-Ujwalam.ps1` helpers (settings backup) | system Node on PATH (dev PC: 26.12.1 at `C:\Program Files\nodejs`); `Ujwalam.cmd`, `ujwalam-start.exe` (`SearchPathW` on PATH) and the installer refuse without it | **Bundle** `runtime/node/node.exe` 26.12.1 (copy of the official installed binary, SHA-256 recorded) + its `LICENSE` (MIT) |
| 2 | Microsoft Visual C++ 2015-2022 x64 runtime (`msvcp140*.dll`, `vcruntime140*.dll`, `concrt140.dll`) | `bin/ujwalam-host.exe`, OBS runtime DLLs and helper exes, `studio/ujwalam-studio.exe` + Qt, `ujwalam-start.exe`, onnxruntime / OpenCV in Python | installer reads the registry and refuses without the system-wide redistributable | **Bundle app-local**: the `Microsoft.VC143.CRT` DLLs from the VS 2022 Build Tools redist folder (14.44.35112) copied next to every exe folder that needs them. No `vc_redist` run, no UAC. Setup.exe itself links the CRT statically |
| 3 | Python 3.14.7 | clip maker (`services/clip/clipper.py`, `live_worker.py`, `pack_tune.py`), face worker (`services/face/face_worker.py`) | not shipped (D283): `-ClipMaker <repo>` makes the install use the repo's `.venv-gpu` / `.venv` (about 550 MB) | **Bundle** the python.org embeddable zip 3.14.7 (amd64) as `runtime/python/`, pinned by SHA-256 |
| 4 | Python packages | clip: numpy, opencv-python-headless, rapidocr (+ onnxruntime), faster-whisper (+ ctranslate2, av, tokenizers, huggingface_hub); face: onnxruntime-directml, numpy, opencv | `.venv-gpu` on the dev PC (onnxruntime-directml 1.24.4 + the OCR and whisper locks) | **Bundle** into `runtime/python/Lib/site-packages` from a new hash-locked file `services/clip/requirements-bundle.lock.txt` (= `.venv-gpu` freeze; win_amd64 cp314 / py3 wheels from PyPI, SHA-256 each) |
| 5 | Python sources | `services/clip/*.py`, `services/face/*.py` | not in the zip (`*.py` skipped) | **Ship** them (tests and fixtures stay out) |
| 6 | Data the Python workers read | `data/clip/*.json`, `data/games/<id>/*.json` (game packs, committed, no `local/`), `data/games/*.schema.json`, `data/models/face-ai.json`, `data/flags.json`, `data/fonts` | partly shipped (Node needs some of `data/clip`) | **Ship** all of `data/clip/*.json` and the committed game-pack JSON; `data/games/<id>/local/` stays forbidden |
| 7 | ffmpeg / ffprobe (exe + shared DLLs) | clipper (`clip_common.find_tool`: PATH), posting (`ffprobe`), scene builder and media info (`FFMPEG`/`FFPROBE` or PATH) | not shipped; dev PC has BtbN `n8.1.3-9-g29e619e767-win64-lgpl-shared-8.1` from winget on PATH | **Bundle** `runtime/ffmpeg/` = that BtbN LGPL shared build (`ffmpeg.exe`, `ffprobe.exe`, the 7 DLLs; not `ffplay.exe`) + its `LICENSE.txt`; the launcher puts it first on the children's PATH and sets `FFMPEG`/`FFPROBE` |
| 8 | RapidOCR models: `PP-OCRv6_det_small.onnx`, `PP-OCRv6_rec_small.onnx`, `ch_ppocr_mobile_v2.0_cls_mobile.onnx` (about 32 MB) | clip maker OCR (kill feed, names) | fetched by `rapidocr` at first use from modelscope.cn into its package folder (the wheel ships only `.gitkeep`) | **Bundle** (clipping must work offline right after install): fetched at build time from the pinned modelscope URLs in rapidocr 3.10.0 `default_models.yaml` and checked against the SHA-256 listed there |
| 9 | faster-whisper `small` (CTranslate2, about 486 MB: `model.bin`, `config.json`, `tokenizer.json`, `vocabulary.txt`) | reel captions (`reel_captions.model_path`: `<data>/models/<model>`) | placed by hand outside the repo (docs/evidence/2026-11-03-f6-whisper-captions.md) | **Download manager** item (optional: captions only; clips work without it) |
| 10 | Face AI models (`data/models/face-ai.json`: selfie segmentation x2, MODNet, RVM, YuNet ...) | face worker (flag `face-ai`) | `services/face/fetch_models.py` at first use into `data/models/face` inside the repo/install dir | **Download manager** items, stored under the user's data root (never the install dir) |
| 11 | OBS runtime subset, Qt 6.8.3 kit, CEF | host, studio, browser sources | already in the zip | unchanged |
| 12 | Windows components (`tar.exe`, Windows PowerShell 5.1, D3D11, WASAPI, Media Foundation) | Setup unpack, installer, host | part of Windows 11 | not bundled; recorded as system requirements |
| 13 | Streamer.bot / Speaker.bot | chat bridge, Kick, TTS | the user's own apps | not bundled (external apps the user runs; Ujwalam works without them, `--mock` covers tests) |

Everything not named above is Node stdlib (no `node_modules` ships) or already in the package.

Layout inside the package (all under the version folder, so update and rollback keep working per version):

```
runtime/node/node.exe, LICENSE
runtime/python/python.exe, python314.zip, *.pyd, python314._pth, Lib/site-packages/...
runtime/ffmpeg/ffmpeg.exe, ffprobe.exe, *.dll, LICENSE.txt
<every exe folder>/msvcp140*.dll, vcruntime140*.dll, concrt140.dll
```

Build inputs are cached under `out/runtime-cache/` (gitignored) with versions and SHA-256s in `data/runtime/bundle.json`.

## Step 2: bundled runtimes, no admin rights (2026-11-19)

Pins: `data/runtime/bundle.json`. Builder: `tools/package/runtime-bundle.mjs` (`prepareRuntime`, called by
`tools/package/build-alpha.mjs`). Cache: `out/runtime-cache/` (gitignored).

| Runtime | Version | Source | Check |
|---|---|---|---|
| Node.js | 26.12.1 | `https://nodejs.org/dist/v26.12.1/node-v26.12.1-win-x64.zip` | zip SHA-256 `b3efd5c7...e2b4` = nodejs.org `SHASUMS256.txt`; the `node.exe` inside (`1c63f141...84ed`, 105,319,752 bytes) is byte-identical to the dev PC's installed 26.12.1 |
| Python embeddable | 3.14.7 amd64 | `https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip` | SHA-256 `d297e5ff...1f15` computed at first download (python.org shows no SHA-256 on the page; sigstore not checked: UNVERIFIED) |
| Python packages | 38 wheels (`services/clip/requirements-bundle.lock.txt`) | PyPI, `pip download --only-binary :all:` cp314 win_amd64 | `pip install --no-index --require-hashes --no-deps --target`; every hash shared with the OCR and whisper locks matches them; 3 new: onnxruntime-directml 1.24.4, sympy 1.14.0, mpmath 1.3.0 |
| RapidOCR models | PP-OCRv6 det/rec small, PP-OCRv4 cls mobile v2.0 | modelscope.cn RapidOCR v3.10.0 | SHA-256s as listed in rapidocr's `default_models.yaml`, equal to the dev `.venv-gpu` copies |
| FFmpeg | n8.1.3-9-g29e619e767 LGPL shared | build PC (winget BtbN.FFmpeg.LGPL.Shared.8.1) | each of 9 files + LICENSE.txt pinned |
| VC++ runtime | 14.44.35112 | VS 2022 Build Tools `VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT` | 10 DLLs pinned; copied next to the version folder top, `bin/`, `studio/`, `obs/bin/64bit/`, `obs/obs-plugins/64bit/`, `runtime/python/` |

Changes:

- Package: `runtime/node`, `runtime/python` (embeddable + site-packages without package test suites, `python314._pth` =
  `python314.zip`, `.`, `Lib\site-packages`; no `import site`, no user site), `runtime/ffmpeg`, the CRT DLLs; the clip and
  face workers' `.py` files, every `data/clip/*.json`, the committed game packs (`data/games/<id>/*.json`; `local/`
  forbidden), `data/models/face-ai.json`. Allowlist and forbidden rules updated (`tools/package/manifest.mjs`); the
  extension rule is lifted only inside `runtime/python/Lib/site-packages/` (certifi's public `cacert.pem`). The private
  term scan skips third-party runtime files, as it skips the OBS runtime.
- `release.json` gains `runtime` (versions). `notices/THIRD-PARTY.txt` lists the bundled runtimes and their licence files.
- `Install-Ujwalam.ps1`: for a build with `runtime`, uses `runtime\node\node.exe` (also for the settings backup helper
  and rollback) and skips the system Node.js and VC++ registry checks. Older builds: unchanged checks.
- `Ujwalam.cmd` and `ujwalam-start.exe`: run the build's `runtime\node\node.exe`, else Node.js on PATH. `ujwalam-start.exe`
  now links the C++ runtime statically (imports only KERNEL32, USER32, SHELL32) because its copy in the install root
  has no app-local DLLs beside it.
- Launcher (`run-installed.mjs`): `runtime\ffmpeg` first on PATH for every child, and `FFMPEG`/`FFPROBE` set.
- Python lookup (`record-clips.mjs pythonIn`, `launch.mjs liveClipsSpec/faceSpec`): `.venv-gpu`, `.venv`, then
  `runtime\python\python.exe` (GPU: onnxruntime-directml). `-ClipMaker` stays only as a developer override.

Evidence (2026-11-19, dev PC, off air):

- `node tools/package/runtime-bundle.mjs`: 4753 runtime files, 749 MiB, 8 s with a warm cache (3432 files after the
  package test suites are left out).
- `node tools/package/build-alpha.mjs --force`: exit 0 in 38 s; zip 469.0 MiB, 5210 files, 1111.4 MiB unpacked
  (alpha.35 without runtimes: 171 MiB).
- Fresh install with PATH = `C:\Windows\System32;C:\Windows;...\WindowsPowerShell\v1.0` (no Node, no Python, no ffmpeg):
  `Install-Ujwalam.ps1 -InstallRoot <temp> -NoShortcuts` -> "Node.js 26.12.1: bundled", "Visual C++ x64 runtime
  14.44.35112: bundled next to the programs", "checksums ok", exit 0.
- Installed `runtime\python\python.exe -I services\clip\clipper.py --help`: usage printed. With `runtime\ffmpeg` on PATH:
  `clip_common.find_tool('ffmpeg')` -> the bundled ffmpeg; `RapidOCR()` loads the bundled `PP-OCRv6_det_small.onnx` and
  runs (no download); `onnxruntime.get_available_providers()` -> `DmlExecutionProvider, CPUExecutionProvider`.
- Tests (one file each, `UJWALAM_HEADLESS=1`, BelowNormal): package-alpha, record-clips, live-install-launcher,
  service-swap-launcher, studio-ui-alpha, studio-ui-connect, studio-ui-readiness, instagram-live: all pass.

## Step 3: one file (2026-11-19)

- `app/setup/src/setup.cpp`: `Ujwalam-Setup-<version>.exe` = the setup program + the package zip + a 160-byte trailer
  (magic, format 1, program size, zip size, the zip's SHA-256, the program part's SHA-256, version, end magic).
  Setup reads the trailer, hashes the program part, copies the zip out of itself into the private work folder while
  hashing it, hashes the copy again, and only then unpacks it with Windows' `tar.exe`. A flipped byte, a cut-short file
  or a missing trailer on a single-file setup gives exit 21 (since the Codex review: at any size, see below): "This setup file is damaged or incomplete (it does not
  match the checksum built into it). Download or copy Ujwalam-Setup again and check it against its .sha256 file.
  Nothing was changed." The plain program (the copy in the install root, used for repair, roll back and uninstall)
  still installs a zip next to it or `--package <zip>`, and now also finds a `Ujwalam-Setup-<version>.exe` in its
  folder or the update folder (`--package` takes either).
- `tools/package/single-setup.mjs` writes the exe (temp file, one rename) and `<exe>.sha256`, and keeps the newest 2
  setups in `out/dist` by version, logging each deletion. `build-alpha.mjs` folds the zip in and (since the Codex review,
  see below) keeps the zip and its `.sha256` next to it: the in-app update (`services/studio-ui/setup-update.mjs`) now prefers a single-file setup
  in the update folder (checked against its `.sha256`) and runs it with `--update --quiet --next-start`; zips still work.
- Defender: the exe keeps its version info, icon and `asInvoker` manifest; the payload is a plain zip after the PE
  image (not a PE section, not compressed code). An exe that carries an archive is the shape Defender's ML verdicts
  have flagged before (`Bearfoos.A!ml` on the host exe, 2026-11): UNVERIFIED until the first real download is scanned.

Measured (dev PC, off air, warm runtime cache): build `node tools/package/build-alpha.mjs --force` 39 s in all, of which
writing the single file 1.4 s. `Ujwalam-Setup-0.1.0-alpha.35.exe` 469.3 MiB (492,117,149 bytes; the zip inside 469.1 MiB,
5210 files, 1111.4 MiB unpacked). Install from it, PATH = System32 + Windows + PowerShell only: exit 0 in 37 s.

Solid compression tried: `tar --format 7zip` LZMA2 level 6 on the same tree: 336.3 MiB (-28 %), but 309 s to build and
15 s to unpack (zip: 4 s). Not used: build and install speed come first, and Windows' `tar.exe` reads the zip fast.

Fresh-install checks (temp install root and temp data root; PATH stripped of Node, Python and ffmpeg):

- the installed launcher (`runtime\node\node.exe tools\package\run-installed.mjs --mock --no-open --stop-on-stdin`,
  `UJWALAM_HEADLESS=1`) starts, serves, and stops on stdin with exit 0;
- a clip worker smoke job on the bundled Python: a 6 s 1080p test video made with the bundled ffmpeg (`h264_nvenc`),
  then `clipper.py detect` -> exit 0, "0 hit(s), 0 with signal, from 6 OCR frames at 1.0 fps in 5.1 s", output files
  written. The bundled ffmpeg is the LGPL build: no `libx264` (GPL); the clipper encodes with `h264_nvenc` (it has
  `h264_mf`, `h264_amf` and `h264_qsv` too). `services/clip/build_cache.py` (a developer tool) falls back to `libx264`
  without NVENC and would need a change on a PC without NVIDIA.
- Tests: `tests/setup-installer.test.mjs` 13/13 (new: trailer round trip and keep-newest-2; the single-file exe
  installs what it carries, an update keeps every setting, a flipped payload byte, a flipped program byte and a cut-short
  file are each refused with exit 21 and nothing changed, also when given to the plain program as `--package`; the
  installed plain program finds the single file in the update folder). `package-alpha` 20 pass 1 skipped (e2e build),
  `live-install` 13/13, `live-install-launcher` 1/1.

## Step 4: in-app download manager (2026-11-19)

- Data: `data/downloads/speech-captions.json` (faster-whisper small, 4 files, 463.7 MiB, Systran/faster-whisper-small
  pinned at revision 536b0662, MIT) and `data/downloads/face-ai.json` (the 7 Face AI files, 30.3 MiB, the same URLs and
  SHA-256s as `data/models/face-ai.json`; Face Mesh comes from its pinned archive). Each item: name, plain-words purpose,
  what needs it, size, URL, SHA-256, licence, checked date.
- Service `services/studio-ui/downloads.mjs`, routes `GET/POST /ui/api/downloads`: one download at a time; resume with
  HTTP Range from `<data root>\downloads\partial\<id>\`; a server that ignores Range restarts the file; SHA-256 and size
  checked per file (a miss: deleted, fetched once more, then a plain failure); 3 retries on network errors; Pause keeps
  the partial files, Cancel deletes them; finished files go to `<data root>\models\...` (never the install folder) with a
  marker. Never while live: start/resume refused while live, recording or when the host cannot be read; a running
  download pauses itself when either starts (2 s check, off the stream path). https only (http only on 127.0.0.1).
- Where the workers look: reel captions `<data root>\models\faster-whisper-small` (unchanged `model_path`); the face
  worker reads `UJWALAM_MODELS_DIR\face`, which the installed launcher sets to `<data root>\models` (a checkout keeps
  `data/models/face`).
- Studio: Settings > Downloads (`DownloadsList.qml`: what each item is for, size, licence, progress bar, Download /
  Pause / Resume / Cancel, fixed row height, polls once a second only while something downloads). Settings > Clips
  offers the speech model and Settings > Editing the Face AI models while they are missing.
- Flag `download-manager`, ON by default (proposed D403).

Tests: `tests/downloads.test.mjs` 7/7, three runs in a row (manifests; dropped connection resumed with Range plus a
redirect; bad checksum fetched twice then refused with nothing kept; server ignoring Range; pause/resume/cancel; refused
while live, pauses when the stream starts, host unknown refused, flag off refused; archive members). No real model was
downloaded from the internet in this session: UNVERIFIED against the real hosts.
## Codex review round 1 (2026-11-20)

1. Download queue (P1): `pump()` reads the host status before every start. Live, recording or unknown: the item and
   every queued item are paused with the "Paused because the stream or a recording started" message; a running item
   that pauses for the stream also pauses the queue. Test: 2 queued, the stream starts during the first, no request for
   the second is ever made, and Resume is refused (409) while still live.
2. Transition zip (P2): installs from alpha.35 and older update only from `ujwalam-*-win64.zip` in the update folder.
   `build-alpha.mjs` now keeps the zip and its `.sha256` next to the single setup by default (`--drop-zip` removes them
   once no such install is left). Test (package-alpha): the default keeps the zip, and the kept name matches the
   alpha.35 updater's pattern.
3. Download integrity (P2): a finished part from an earlier run is hashed again before use (a mismatch is deleted and
   fetched again), each file is hashed once more right before it moves into place, and the ready marker records the
   SHA-256, size and modification time per file, so a file changed in place with the same length is no longer ready.
   Test: a finished part with the same length but other bytes is fetched again on resume; a ready file changed in place
   reads as missing.
4. Cut-short single exe (P2): the 16 MiB rule is gone. `single-setup.mjs` sets a mark (`UJWSINGLE:0` -> `:1`) in the
   copy of the program it puts in front of the package (the build fails unless the mark is there exactly once; the
   program's hash in the trailer is of the marked copy). Setup reads the mark from its own memory, so a single-file
   setup whose trailer cannot be read is refused with exit 21 at any size and never falls back to a package next to it.
   Test: B (3 MiB stand-in package) cut to 1 MiB with a good zip of B next to it: exit 21, nothing installed, also as
   `--package` to the plain program.
5. Test guard: `tests/helpers/data-root-guard.mjs` refuses `%LOCALAPPDATA%\Ujwalam` (and anything outside the temp
   folder) as a test data or install root; the downloads and setup-installer helpers go through it, and setup children
   get a temp `LOCALAPPDATA`.

Runs (off air per `tools/live-check.mjs`, one file at a time, BelowNormal, `UJWALAM_HEADLESS=1`, setup rebuilt with
`npm run build:setup`, 282,112 bytes, mark present once): `downloads` 10/10 (three runs in a row), `setup-installer`
13/13, `package-alpha` 21 pass 1 skipped (e2e build), `live-install` 13/13.
## Codex review round 2 (2026-11-20)

1. Abort during a hash (P1): file hashes read 1 MiB chunks and check the abort signal between chunks; the signal is
   checked again before each move into place, before the ready marker is written and before the item is marked ready.
   Tests (one per cause: stream starts, Pause, Cancel): a 5 MiB part finished in an earlier run is being rehashed;
   the abort stops the hash before the last chunk, the item ends paused (or cancelled), nothing is moved into place,
   no marker is written, nothing is fetched.
2. Content proof (P2): the cheap ready check for the studio's list now compares SHA-256, size, modification time (ms)
   and the file id (ino). Before first use in each app run, `verifyOnUse` hashes every file (cached per process by
   path, size, time and id); a mismatch removes the marker, so the item reads as missing and the download is offered.
   The face worker start goes through it (`modelUsable('face-ai-models')`, installed builds only: a checkout keeps its
   models in data/models). Test: a file rewritten in place with the same size and its time restored passes the cheap
   check, fails the first-use check and then reads as missing; a re-download passes; a removed file fails the gate.
   The speech-captions model is gated too (commit after round 2): each clip job checks it first (ecord-clips.mjs);
   a failure skips only the captions (UJWALAM_REEL_CAPTIONS=off for that job), the job runs, and the log and task bar
   say to download the speech model in Settings > Downloads.

Runs (off air, one file at a time, BelowNormal, `UJWALAM_HEADLESS=1`): `downloads` 14/14 five runs in a row,
`setup-installer` 13/13.
## Codex review round 3 (2026-11-20)

1. Gate after a download: `createModelGate` re-arms a failed check when the item's ready marker changes (the Downloads
   page runs in the UI server process, so the launcher watches the marker on its 5 s sync); the face worker then starts.
   The speech model is checked per clip job, so the next job after a download has captions. Tests: the gate fails,
   a marker appears, it checks again and passes; a second clip job after a failed one runs with captions.
2. Marker race: the first-use check removes the marker only when it is still the one it read, and is skipped for an
   item this process is downloading. Test: a newer marker written during the hash stays.
3. All or nothing: every file is checked first, then all are moved in one synchronous step, then the marker is written.
   Test: an abort during the final check of the second file moves nothing; resume fetches nothing again and ends ready.

Runs (off air, one file at a time, BelowNormal, `UJWALAM_HEADLESS=1`): `downloads` 17/17 three runs in a row,
`record-clips` 25/25, `setup-installer` 13/13.