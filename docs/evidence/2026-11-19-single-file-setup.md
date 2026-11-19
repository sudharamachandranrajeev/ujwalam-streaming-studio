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
