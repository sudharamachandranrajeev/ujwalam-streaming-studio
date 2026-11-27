# Caption GPU hang froze a review job (2026-11-27)

Status: unit tests pass with fakes. Real run PENDING (needs the installed app and a recording; no GPU run was made).

## What happened

Installed alpha.49, review job of a 60-minute recording. The run log showed
`captions: faster-whisper-large-v3-turbo on the GPU failed (RuntimeError); using faster-whisper-small on the CPU`,
then `clip L01 done`, then nothing. The clipper used 0 CPU for over 6 minutes, all threads waiting, no child process,
only `clips/L02/tmp*/reel.wav` written, VRAM up about 0.9 GB. For clip L02, `clip_captions.transcribe` tried the GPU
model again inside the clipper process and the native call (ctranslate2/CUDA) hung instead of raising. A hung native
call cannot be interrupted in-process, and run_tool's stall watchdog only covers child processes.

## Fix

1. **Sticky fallback** (`services/clip/clip_captions.py`, `_GPU_FAILED`): once the GPU caption model fails in a
   process, every later clip in that run uses the CPU model directly. The GPU is never tried again in that run.
2. **Child process with a time limit**: faster-whisper runs in a child (`run_tool`: no console window, kill-on-close
   job, the whole tree ends). Limit = `isolate.setupSec` + `isolate.perAudioSec` x the clip audio's length, from
   `data/clip/reel-captions.json` (300 s + 4 x audio s; first guess, UNVERIFIED). The result comes back as a JSON file
   (`{segments, language}` or `{error}`), so the segments and the transcript format are unchanged. A GPU child that
   fails or is killed falls back to the CPU model; a CPU child that is killed leaves that clip without captions
   (status `unavailable`, logged in plain words) and the job goes on. The parent no longer imports faster_whisper when
   isolation is on, so it never loads CUDA itself.
3. **Error text in the log**: the first line of the error, cut to 160 characters, e.g.
   `... on the GPU failed (RuntimeError: CUDA failed with error out of memory); using ... on the CPU`.

Scope: the reel-captions path (`reel_captions.make_transcript`) passes `isolate`. The older per-clip `--captions`
path in `clipper.py` (line ~470) does not, and keeps the in-process run with the sticky fallback.

## Tests

`C:\AI\Claude\Ujwalam\.venv-gpu\Scripts\python.exe -I tests\py\<file>.py`

| File | Result |
|---|---|
| test_caption_gpu_hang.py (new) | Ran 7, OK |
| test_reel_captions.py | Ran 20, OK (skipped=2) |
| test_caption_seam.py | Ran 2, OK (skipped=1: real model not set) |
| test_caption_clean.py | Ran 5, OK |

New cases: GPU tried once then CPU for 3 clips; error text logged once, first line only; a hung child (sleep 120 s)
killed after 2 s, three children in total (GPU once, CPU for L01 and L02), none alive afterwards, job returns; a child
result read back unchanged; a failing child's error text logged and the CPU used.

## Pending

Real run: a review job on the installed build where the GPU model fails, to confirm the next clips go straight to
the CPU and the job finishes. Measure real child times to set `setupSec` and `perAudioSec`.
