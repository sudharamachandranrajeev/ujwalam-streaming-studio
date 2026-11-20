# Licence headers and publishing rules

Ujwalam is licensed GPL-3.0-or-later (`LICENSE`, `package.json`). `LICENSE` carries the full verbatim GPL-3.0 text (2026-11-05, superseding the 2026-11-04 GPL-2.0 text: the bundled FFmpeg build was verified GPL-3.0-or-later, see `docs/evidence/2026-11-05-licence-verification.md`).

Third-party packages and model files (OCR worker, from P2a A5) are listed with their licences in `docs/third-party-notices.md`.

D3 (personal tool vs product) is settled as "personal first, product-ready architecture", but distribution (installer, GPL release) is deferred to P17, so licence work here is preparation only.

## Header rule

Every source file starts with an SPDX header in the language's comment form:

| Language | Header |
|---|---|
| JS / MJS / TS / C / C++ / QML | `// SPDX-License-Identifier: GPL-3.0-or-later` |
| Python / shell / YAML / TOML | `# SPDX-License-Identifier: GPL-3.0-or-later` |
| HTML / XML | `<!-- SPDX-License-Identifier: GPL-3.0-or-later -->` |
| CSS | `/* SPDX-License-Identifier: GPL-3.0-or-later */` |
| PowerShell | `# SPDX-License-Identifier: GPL-3.0-or-later` |

JSON cannot carry comments; its licence is covered by the repo `LICENSE`. Files under `legacy/` are not headered (read-only reference).

## Never publish

- `legacy/`: private reference copy of Meld Schenanigans; never distributed. It may contain personal paths and channel details.
- Microsoft fonts **Corbel** and **Consolas**: not redistributable. Themes reference them by name only; never bundle the files.
- Fonts that do ship (D344, 2026-11-11): only the pinned SIL OFL 1.1 files in `data/fonts/` (Inter, Barlow, Exo 2), each with its licence text; the packager's font ban is an allowlist of exactly those files (`OFL_FONTS` in `tools/package/manifest.mjs`). Any other font file stays forbidden.
- Excluded from the legacy copy and never to be committed: `engage/logs/`, `engage/memory/` (viewer data), `brand/secrets.local.js`, `.claude/settings.local.json`.

## Fonts found in `legacy/brand/fonts/`

| File family | Licence evidence in repo | Status |
|---|---|---|
| Black Ops One (`BlackOpsOne-Latin-400.woff2`) | `LICENSE-BlackOpsOne-OFL.txt` states SIL OFL 1.1 | OFL believed; text present in legacy, still UNVERIFIED until compared with upstream |
| Baloo Chettan 2 (Latin + Malayalam, 500/700/800) | `LICENSE-BalooChettan2-OFL.txt` states SIL OFL 1.1 | OFL believed; UNVERIFIED |
| Alfa Slab One (`AlfaSlabOne-Latin-400.woff2`) | `LICENSE-AlfaSlabOne-OFL.txt` states SIL OFL 1.1 | OFL believed; UNVERIFIED |
| Luckiest Guy (`LuckiestGuy-Latin-400.woff2`) | `LICENSE-LuckiestGuy.txt` is the Apache License 2.0 text | Apache-2.0 believed; UNVERIFIED |

All four are UNVERIFIED: the licence file names a licence, but the woff2 subsets were not checked against upstream. Verify before any distribution. If a font is bundled, ship its licence file beside it.

## Bundled runtimes (single-file setup, 2026-11-19)

The package carries these third-party runtimes so a PC needs nothing else (pins and SHA-256s: `data/runtime/bundle.json`;
inventory: `docs/evidence/2026-11-19-single-file-setup.md`). The installed copy lists them in `notices/THIRD-PARTY.txt`
and ships each licence text next to the files.

| Runtime | Where in the install | Licence | Licence text shipped |
|---|---|---|---|
| Node.js 26.12.1 (official win-x64 zip) | `runtime/node/` | MIT (plus the third-party licences listed in Node's own LICENSE) | `runtime/node/LICENSE` |
| Python 3.14.7 embeddable (python.org) | `runtime/python/` | PSF-2.0 | `runtime/python/LICENSE.txt` |
| Python packages (`services/clip/requirements-bundle.lock.txt`) | `runtime/python/Lib/site-packages/` | per package (BSD, MIT, Apache-2.0, MPL-2.0, PSF, LGPL for none); onnxruntime-directml MIT with DirectML redistributable terms (UNVERIFIED: re-read `onnxruntime/ThirdPartyNotices.txt` before any public release) | each `*.dist-info/` |
| RapidOCR / PaddleOCR ONNX models | `runtime/python/Lib/site-packages/rapidocr/models/` | Apache-2.0 | rapidocr's dist-info |
| FFmpeg n8.1.3 BtbN LGPL shared build | `runtime/ffmpeg/` | LGPL-2.1-or-later (no GPL or nonfree parts in that build) | `runtime/ffmpeg/LICENSE.txt` |
| Microsoft Visual C++ runtime 14.44.35112 (`Microsoft.VC143.CRT`) | next to every exe folder | Microsoft Visual Studio licence terms, "Distributable Code" | see below |

Visual C++ runtime, app-local: the Visual Studio 2022 licence terms list the files in the Visual Studio `VC\Redist`
folder as Distributable Code that may be copied and distributed in object code form with an application, including
app-local deployment next to the program (Microsoft Learn: "Redistributing Visual C++ Files", "Distributable Code for
Visual Studio 2022"). Conditions kept: only the unmodified files from `VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT`
ship, only with Ujwalam, never the debug (`debug_nonredist`) files. Microsoft notes that app-local copies are not
serviced by Windows Update, so each Ujwalam build carries the current redist files. No system-wide `vc_redist` install,
no admin rights. Checked 2026-11-19; legal wording UNVERIFIED (not legal advice).
