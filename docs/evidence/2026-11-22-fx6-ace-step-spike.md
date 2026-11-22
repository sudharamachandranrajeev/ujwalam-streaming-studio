# FX6 spike: ACE-Step 1.5 local music on the RTX 4050 Laptop (6 GB), 2026-11-22

Plan: `docs/plan/2026-11-21-clip-music-name-transitions.md` §3.4 (Local AI music, FX6). The user approved the install
on 2026-11-22 ("4. yes"). Status: spike PASS on time, VRAM and tempo; quality is the user's call (samples below are
local only).

## Install (outside the repo, nothing committed)

| Item | Value |
|---|---|
| uv | 0.13.9, official release zip `uv-x86_64-pc-windows-msvc.zip`, SHA-256 `edd61f7f…8e1beb` checked, in `_vendor/uv-0.13.9` (no piped install script) |
| ACE-Step code | `github.com/ACE-Step/ACE-Step-1.5` at `ca1e85fe9430179831e6bc6be790c332190a3866` (2026-08-29), MIT, in `_vendor/ace-step-1.5` |
| Python env | `uv sync --python 3.12` (uv-managed CPython 3.12 under `_vendor/uv-python`, cache `_vendor/uv-cache`, about 5 GB): torch 2.7.1+cu128, CUDA 12.8 |
| Weights | Hugging Face `ACE-Step/Ace-Step1.5` at `19671f406d603126926c1b7e2adc169acbcade22` (licence field `mit`; the card allows commercial use of generated music). Only `acestep-v15-turbo` (4.46 GB), `Qwen3-Embedding-0.6B` (1.12 GB), `vae` (0.31 GB): 5.9 GB. The 1.7B LM was not downloaded (it does not fit beside the DiT on 6 GB). Telemetry off, offline at run time (`HF_HUB_OFFLINE=1`). |

## Run

Script (scratchpad, not committed): DiT only (no LM handler), `initialize_service(config_path="acestep-v15-turbo",
device="cuda", offload_to_cpu=True, quantization="int8_weight_only")` (the project's documented ≤6 GB settings),
`generate_music` with `caption`, `bpm`, `duration=30`, `instrumental=True`, `thinking=False`, `use_cot_metas=False`,
batch 1, WAV. Off air, studio closed, no other GPU job, BelowNormal priority. Whole-GPU memory sampled with
`nvidia-smi` every 0.5 s (hidden window).

| Target | Caption (short) | Asked BPM | Generated in | torch peak | Library analysis (music_library.analyse) |
|---|---|---|---|---|---|
| phonk | dark phonk, cowbell, distorted 808 | 140 | 6.1 s | 4245 MB | 140.31 BPM, 30.0 s, drop at 9.0 s, mood guess "edm" |
| edm | EDM drop, supersaw lead | 128 | 5.8 s | 4410 MB | 127.60 BPM, 30.0 s, drop at 14.0 s, mood "edm" |
| lo-fi | lo-fi hip hop, dusty drums | 85 | 5.4 s | 4408 MB | 85.18 BPM, 30.0 s, drop at 18.9 s, mood "lo-fi" |

Model load 4.3 s. Whole-GPU peak 5440 MB of 6141 MB (desktop included).

First attempt without offload and INT8 (bf16 fully on the GPU): the first track took 31.3 s at a 5809 MB whole-GPU
peak, then the next two refused to start (ACE-Step's own pre-flight: 0.65 GB free, 0.8 GB needed). So the offload +
INT8 settings are required here, not optional.

## Findings

- Generation is fast enough to make a bed per reel off air (about 6 s per 30 s track after a 4 s load).
- The requested tempo is met within 0.5 BPM, so a generated track can be cut on the reel's beat grid without retiming.
- 5.4 GB of 6.1 GB while generating: it can never run beside a stream, a recording, the studio previews or the
  live-AI sidecar (D1, VRAM rule). Generation must be its own heavy job, model unloaded after.
- Mood guesses from the library are a guess (phonk read as "edm"); the generated track's target mood should be
  recorded from the request, not re-guessed.

## UNVERIFIED

- Musical quality and whether the user likes it (samples are local, in the session scratchpad `fx6-out/`).
- Longer tracks (60–120 s) and their VRAM; the docs claim up to 10 min on this tier.
- Generation while the studio is merely open (not live): not tested, and not planned.
- Content ID behaviour of generated music on YouTube.

## Next (FX6 build)

Generation for unmatched targets: when no folder or pack track scores above the threshold and the AI source is
ticked, make one track for the reel's target (tempo from the pick, mood and energy in the caption) off air in the clip
job, store it in `<data>/music/generated/` with its prompt, seed and licence note, and record `source: "made-here"`
with `generator: "ace-step-1.5"` so posting treats it as made here. Never while live; one heavy job; a failure falls
back to the made-here bed.
