# D443 T1: local model runner (2026-11-24)

Branch `claude/d443-t1-runner` (from `43719a92`). Plan: `docs/plan/2026-11-24-ai-post-text-voice.md` (T1).
Decision: D443 in `docs/plan/2026-10-29-v1-decisions.md` (flag `local-ai-model` ON by default, user-requested).

## What was built

| Item | Where |
|---|---|
| Pinned downloads (Settings > Downloads): `local-model-server` (llama.cpp b12675, Windows CUDA 12.4 x64 + CUDA 12.4 runtime, 28 archive members, 1 390 996 253 bytes unpacked) and `local-model-qwen3-vl` (Qwen3-VL-4B-Instruct Q4_K_M + Q8_0 vision projector, 2 951 255 968 bytes) | `data/downloads/local-model.json` |
| Runner config: file names, layer count, context 8192, `gpuLayers: auto`, VRAM need, idle and timeouts | `data/ai/local-model.json` |
| Runner: llama-server on a free port on 127.0.0.1 (`services/common/local-ai.mjs`), `/health` wait, `withModel(fn)` (stops after the batch; `keep` = idle stop after `idleMs`), fresh on-air read before every start and again once loaded (unknown = on air), watch every 2 s that stops the server when a stream or recording starts, refuses while an Ujwalam Python process holds the GPU (GPU Whisper), GPU layers from free VRAM, one CPU retry after a failed GPU start, `windowsHide` on every child, server output kept in memory only | `services/local-model/runner.mjs` |
| `chatJson`: images (base64 data URLs) + text, `response_format` `json_schema` (llama-server turns it into a grammar) or `json_object`, timeout, typed `LocalModelError` (`timeout`, `http`, `bad-json`, `unreachable`, `not-local`) | same file |
| Flag `local-ai-model` (Settings > Advanced), default on (`onBy: D443`) | `data/flags.json` |

## Pinned files

| File | Source | Bytes | SHA-256 | Licence |
|---|---|---|---|---|
| llama-b12675-bin-win-cuda-12.4-x64.zip | github.com/ggml-org/llama.cpp release b12675 | 358131652 | 8eea9d965dc82d8f5ef151b4140e5c85d203ed378804b1d8eb37bca4449ad515 | MIT (GitHub API `license.spdx_id`); LLVM OpenMP Apache-2.0 WITH LLVM-exception (file in zip) |
| cudart-llama-bin-win-cuda-12.4-x64.zip | same release | 391443627 | 8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6 | NVIDIA CUDA EULA, redistributable runtime DLLs |
| Qwen3VL-4B-Instruct-Q4_K_M.gguf | huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF @ 1cd86afb | 2497281664 | 66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a | Apache-2.0 (model card) |
| mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf | same | 453974304 | 30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d | Apache-2.0 |

Every SHA-256 was measured after download (`Get-FileHash`) and equals the GitHub release digest or the Hugging Face
LFS hash. Each extracted member's size and SHA-256 is in the manifest. Dev copy: `C:\AI\Claude\_data\Ujwalam\models`
(`llama-server`, `qwen3-vl-4b`); the installed app gets them in `<data root>\models` through the Downloads page.
`llama-server.exe --version`: `1.0.0-dev (build 12675, commit c212d25ad)`.

## Tests

```
node --test tests/local-model-runner.test.mjs tests/downloads.test.mjs tests/flags.test.mjs
# tests 40  # pass 40  # fail 0
node tools/lint.mjs <changed files>
lint: 0 finding(s)
```

`tests/local-model-runner.test.mjs` uses `tests/helpers/fake-llama-server.mjs` (no GPU): start + health wait + image
call + stop, keep + idle stop, refusal when live / recording / unknown (nothing spawned), off / missing file / GPU busy,
a stream starting stops the server and the next use fails `on-air`, GPU fail then CPU retry (layers 999 then 0), GPU
busy unknown runs on the CPU, `chatJson` errors. The commit hook's quick CI passed 9/9 on both commits.

## GPU smoke run (manual, this laptop, RTX 4050 Laptop 6 GB, driver 621.01)

`node tools/live-check.mjs` = off air before each run. Script (scratch): start via `withModel`, one 320x180 PNG
(three coloured bands, synthetic) + prompt with a JSON schema, stop. VRAM sampled with nvidia-smi every 250 ms.
Another project's process (not Ujwalam) held 1.3 to 3.3 GB of VRAM during the runs, so the base moved.

| Run | Layers | Start (ms) | Call (ms) | VRAM base / peak (MiB) | Model share (MiB) |
|---|---|---|---|---|---|
| auto (2615 MiB free) | 15 (partial) | 8444 | 7888 | 3675 / 5111 | ~1436 |
| full GPU | 999 | 6902 | 2802 | 1301 / 5772 | 4471 |
| CPU | 0 | 5585 | 14929 | 1391 / 1753 | 362 (CUDA context) |

Answer each time: `{"description":"A flag with three vertical stripes of red, green, and blue.","colours":["red","green","blue"],"hasText":false}`.
After every run the server was gone (`running: false`, no llama-server process). `vramNeedMiB` was set to 4700 from
the full-GPU share (4471 MiB at context 8192).

## Gaps

- The CPU retry after a real CUDA failure was tested with the fake server only; on the laptop the GPU start worked.
- GPU busy check: any Python process under `%LOCALAPPDATA%\Ujwalam` or this checkout listed by nvidia-smi as a
  compute app. nvidia-smi on this driver lists processes without memory figures; a GPU Whisper run was not tried
  next to it (UNVERIFIED).
- The CPU mode still creates a CUDA context (~360 MiB); a CPU-only build was not pinned (no install beyond the two approved).
- Not wired into a caller yet (T2 post text uses it); no Settings text beyond the flag row; no studio server route.
- Auto layers use a linear share of `layers` (37) for partial offload; the 15-layer run fitted with ~800 MiB to spare.
