# 2026-11-18: clip scan speed, reader watchdog and resume checkpoint

Result: **PASS** on test clips and on a real stream recording (10 min of a 2026-11-17 recording, old vs new code:
identical hits, 1.41x faster; see "Real recording").

The post-stream clip job ("Finding the best moments": `clipper.py live-review` -> `cmd_detect` ->
`detector_pass.run_pass`) read about 14 frames/min on a 2560x1440 60 fps recording and stopped for minutes at a
time. Cause: the CPU video decoder was starved. Fix: GPU decode while off air, frames bit-identical to the CPU
path. Also added: a watchdog that restarts a stalled reader, and a resume checkpoint, so a job cut short goes on
from where it stopped.

## Root cause

The pass keeps 1 frame per second (`select` on the first frame of each 1 s bucket). ffmpeg must still decode all
60 frames of each second, on the CPU, with `-threads 2`, at below-normal priority.

Cost per kept frame (decode only, test clips below, CPU at 40-90 % busy from other work on the laptop):

| clip | CPU decode, CPU-s per kept frame | CPU decode, frames/min | CUDA decode, CPU-s per kept frame |
|---|---|---|---|
| H.264 1440p60 40 Mbps | 1.21-1.45 | 43-75 | 0.044-0.073 |
| HEVC 1440p60 40 Mbps | 2.09 | 30-37 | 0.044 |

At below-normal priority, ffmpeg gets these CPU-seconds only when no normal-priority work wants the cores. The
user's running job was observed passively (read-only process counters, nothing touched), 2026-11-18, with other
agents building and testing at the same time:

- In 20 s, ffmpeg wrote 14.1 MB of frames (about 2 frames of 1890x1304 BGR, 7.39 MB each) and used 3.2 CPU-s.
  That is about 6 frames/min.
- ffmpeg had 55 threads. In 3 samples, 2 threads were **Ready** (runnable, waiting for a core) or Running, and 53
  were waiting. The Python worker's threads were waiting (the main thread in the pipe read, as in the stack dump).
- System CPU was 40-67 %.

So ffmpeg is the bottleneck. Its runnable threads wait for a CPU, while Python waits for ffmpeg. Both processes
look idle in short samples. This matches the reported zero CPU over 5 s. Power throttling (EcoQoS) adds to it:
the OCR process already opts out of throttling (`no_power_throttling`), but ffmpeg did not. Opting ffmpeg out alone
gave only about 10 % (H.264, 69 -> 78 frames/min decode).

OCR is not the cause on the user's job: the Python worker used 331 CPU-s in 37 min, against 570 CPU-s for ffmpeg.
Its OCR runs on the GPU (DirectML).

Ruled out, or minor:

| option | measured | decision |
|---|---|---|
| `-skip_frame noref` (CPU) | HEVC 2.09 -> 1.47 CPU-s per frame; H.264 1.45 -> 1.21 | not used: still CPU-bound, and it changes which source frame starts a bucket |
| seek per sample / keyframes only | recordings use a 2 s GOP, so 1 fps needs non-key frames; an accurate seek still decodes from the keyframe | not used |
| larger pipe reads | the pipe moves 7.4 MB per kept frame, about 230 reads of 32 KB; not the limit | unchanged |
| scale down before the pipe | would change detector crops and boxes | not used |
| `-hwaccel cuda` with download of every frame | HEVC 0.18 CPU-s per frame, 286 frames/min | slower than keeping frames on the GPU |
| `-hwaccel cuda -hwaccel_output_format cuda`, download only the kept frame | HEVC 0.044 CPU-s per frame, 702 frames/min | **used** |
| `-hwaccel d3d11va -hwaccel_output_format d3d11`, same | HEVC 0.076 CPU-s per frame, 370 frames/min | fallback after CUDA |

## The fix

`services/clip/frame_reader.py` (new), used by `detector_pass.run_pass`:

- Decoder order `auto` (new setting `decode` in `data/clip/detector-pass.json`; `cpu` forces the CPU): CUDA, then
  D3D11VA, then CPU. The filter chain is
  `select=...,hwdownload,format=nv12,format=yuv420p,crop=...`. Frames stay on the GPU through `select`, and only
  the kept frame is downloaded.
- The `format=yuv420p` repack makes the BGR frames **bit-identical** to the CPU path. Measured on both clips: 12 of
  12 and 6 of 6 frames identical, max difference 0. Without the repack, nv12 -> bgr24 differed by up to 104 levels
  (mean 1.6). So detector crops and boxes are unchanged.
- The GPU is used only while the studio is off air. `clip_common.on_air()` applies the rule of
  `tools/live-check.mjs` (both changed after review, see "Review fixes"): the newest host log's sink states, read
  whatever the log's age, plus whether the installed host process is running. Unknown counts as on air. While on a
  GPU decoder, the reader checks every 5 s. When the studio goes on air, it moves to the CPU at the next frame. Test runs (`UJWALAM_HEADLESS=1`) never use the GPU decoder. A failing GPU decoder
  (driver, 10-bit input, missing device) falls through to the next one from the next frame. The existing rules
  stay: below-normal priority, `-threads 2`, `HeavyJobLock`, OCR process throttling off. In addition, ffmpeg is now
  opted out of power throttling too.

### Before / after (frames/min on the test clips, 60 s each, the user's job and other agents' work running)

Decode only (`FrameReader`, before = CPU decode with throttling as before, after = `auto`):

| clip | before | after | factor |
|---|---|---|---|
| H.264 1440p60 | 75.2 | 390.2 (CUDA) | 5.2x |
| HEVC 1440p60 | 36.9 | 451.8 (CUDA) | 12.2x |

Whole pass (decode + band OCR on DirectML, 20 frames from t=5 s). On these noise clips every frame changes, so
every frame gets OCR, and OCR is the bottleneck:

| clip | before | after |
|---|---|---|
| H.264 | 47.0 | 58.7 |
| HEVC | 31.4 | 31.4 |

A real recording has mostly unchanged bands, which the diff gate skips. OCR then costs less, and decode is the
larger share. UNVERIFIED on a real recording.

## Real recording (2026-11-18, after the user closed Ujwalam)

Recording: a 2026-11-17 stream recording, read only (path not committed). ffprobe: H.264 High, 8-bit yuv420p,
2560x1440, 60 fps, 34 Mbps, 1375.7 s, 2 s GOP, B-frames. Segment: 400-1000 s (600 kept frames). Layout from the
studio project (crop 1890x1304), settings as shipped (`rois` mode, diff gate 0.2). Output to a temp folder.
Old = `services/clip` of the main checkout (CPU decode). New = this branch at 59f1618 (decoder `auto`).

| | old | new |
|---|---|---|
| wall | 426.0 s | 302.0 s |
| frames/min | 84.5 | 119.2 |
| OCR time | 331.8 s | 270.0 s |
| wait for the next frame | 57.3 s | 1.2 s |
| Python CPU | 391.4 CPU-s | 325.5 CPU-s |
| ffmpeg CPU | 630.8 CPU-s | 22.5 CPU-s |
| system CPU avg / max | 61.6 % / 99.5 % | 47.7 % / 94 % |
| GPU util avg / NVDEC avg | 20 % / 0 % | 20 % / 26 % |
| VRAM max | 1882 MB | 2144 MB |
| decoder | CPU | CUDA, 0 restarts |

- `detector-hits.jsonl` and `match-stats.json`: byte-identical (SHA-256). Both: 96 hits, 9 signal hits, 598 of 600
  frames with OCR, 2 diff-gate skips.
- Root cause confirmed: the CPU decode costs 1.05 CPU-s per kept frame (630.8 for 600). On this run the laptop was
  otherwise quiet, so the old code waited only 57 s for frames; on the user's busy job the same CPU work was starved
  (6-14 frames/min). With CUDA it is 0.04 CPU-s per frame and 1.2 s of waiting.
- Load: other agents' test hosts and a dev studio from worktrees ran (not the installed app; live-check: off air).
  System idle at sample times was 13-23 %.

### Where the time goes now

OCR is 89 % of the new wall time. The diff gate skips almost nothing on real gameplay: 598 of 600 frames change
enough in some band. Profile on 120 s of the same recording (new code, DirectML on the RTX 4050): 0.39 s OCR per
frame, of which text detection 0.27 s (5.7 band crops per frame, one DirectML call each; 75 % inside the session,
the rest pre-processing) and recognition 0.11 s (one batched call, 22 lines per frame).

- DirectML runs on the NVIDIA adapter (Windows GPU counters, by process), not the Intel one. Forcing `device_id` 0
  made ONNX Runtime fall back to the CPU: 3.3 s per frame against 0.81 s (all 11 bands), so the default is right.
- Within-frame parallel detection (bands split over 2 detector sessions in threads, then one recognition call):
  identical boxes and text on 30 frames (330 crops), 1.23x faster on OCR; 3 sessions 1.14x. With extra sessions
  loaded, the serial path in the same process also slowed (2.9-3.3 s per frame of 11 bands, against 0.81 s with one
  session), so the real gain is uncertain. Not shipped: see "Options".

### Stages after detect

Montage from the segment's hits, cut from the V recording, the user's app data settings, NVENC: 1 reel of 20 s
(4 kills) in 8.0 s, validation 2.6 s; NVENC 53-100 % during the cut, GPU 2-37 %. The match gate and planning take
under 0.2 s. A full recording (23 min) makes 2-4 such reels: well under a minute, against about 12 min of detect.
These stages are not slow.

## Options (measured, not shipped)

| option | effect | why not shipped |
|---|---|---|
| parallel band detection, 2 sessions | OCR 1.23x faster, results identical on 30 frames; 3 sessions 1.14x | small, uncertain gain (extra sessions slowed the serial path too); a second DirectML session adds VRAM |
| higher diff gate | fewer frames with OCR | changes hits; needs a check on the held-out labelled sessions |
| `roiDetScale` < 1 | detector cost falls with pixel count | changes boxes; same check needed |
| `roiTextFilter` on | fewer lines recognised | changes results; same check needed |

None of the result-changing options was validated on `data/labels/` held-out sessions in this task, so all stay
off.

## Watchdog

A reader thread moves whole frames from the pipe into a 2-slot queue. The pass waits on the queue with a 1 s poll.

- Stall: no frame for 90 s (120 s before the first frame of a run). The slowest measured average is 4.3 s per
  frame (the user's starved job), so 90 s is about 20 times that. Time the caller spends on a frame (OCR) does not
  count. On a stall, ffmpeg is killed and started again with `-ss` at the next frame not yet read. A stalled GPU
  decoder is not used again in this pass.
- After 3 restarts without a frame in between, or 10 restarts in all, the pass raises `ClipError`, for example:
  "The video reader stopped at 12:34 of the recording: no new frame for 90 s, 3 restart(s) did not help. Close
  other heavy programs and start the clip job again."
- Every reader event writes a plain line to the job log and a `ujwalam-progress` line (stage `detect`, the same
  done count, the note). Examples: "reading the video on the GPU", "no new frame for 90 s; restarting the video
  reader at 12:34 (1 of 3)", "the studio went on air; reading the video on the CPU". The Tasks panel warns after
  180 s without a line (`data/studio/tasks.json`). The watchdog acts at 90 s, so a stall shows a line before the
  warning.
- The run summary (`detector-pass.json`) gains `reader: {decoders, restarts, stalls, fallbacks}`.

## Resume checkpoint (user, 2026-11-18)

A job cut short (Stop, Ujwalam closed, crash) is queued again at the next start (`record-clips.mjs`). Its detector
pass now goes on from where it stopped:

- Every 30 s (`CHECKPOINT_EVERY_SEC`), and when the watchdog gives up, `run_pass` writes
  `<job out folder>/detector-pass.checkpoint.npz` plus an append-only `detector-pass.checkpoint.npz.rows` (JSON
  lines). The npz holds the frames read, the source time of the last frame read, the scanner state (diff-gate
  frame, band states, mode, held hits, kill counter, stats) and the byte length of the rows file that belongs to it.
  Each save appends only the hit rows and S1 readings that are new since the last save (fsync), then replaces the
  npz atomically (temp file + `os.replace`). A load reads the rows file up to the recorded length and cuts off a
  torn tail. Arrays are loaded with `allow_pickle=False`, so there are no pickles.
- The key: recording path, size and mtime; the crop; fps; a hash of every other detector setting (not `decode`,
  which gives identical frames); a hash of the whole game pack's content (not its version number, so an edited
  pack starts fresh); a hash of the profile names; the layout; and the segment. On a re-run with a matching key,
  the saved state is restored, and ffmpeg starts at the next 1 s bucket after the last frame's source time. This is
  the watchdog's restart path (`FrameReader(first_index=..., first_pts=...)`).
- A mismatched or corrupt checkpoint is deleted, and the scan starts fresh.
- The checkpoint is deleted when the pass completes.
- Progress lines start at the resumed count ("going on from 0:06"). `cmd_detect` skips its 0-of-N line when a
  checkpoint exists.
- The checkpoint can hold OCR text (held band boxes, kill-feed keys). It stays in the job's local output folder,
  which `check_out_dir` keeps out of the repo or gitignored, and it is deleted on completion.

## Review fixes (second-opinion review of 59f1618)

Each finding was checked against the code first; all were real.

- On air from log freshness (P1): a live host that logs nothing for 120 s counted as off air. Now: sink states from
  the newest host log whatever its age; a log that ends with `[host] exit` is off air; otherwise a live sink counts
  as on air while the installed host (`%LOCALAPPDATA%\Ujwalam\...\ujwalam-host.exe`, matched by path) is running.
  If the process check fails, the state is unknown, and the CPU is used (`live-check.mjs` exits 2). Checked every
  5 s before each GPU segment. The log is read incrementally (offset cache). `tools/live-check.mjs` uses the same
  rule.
- Restart seek by frame count (P2): after an empty 1 s bucket (a gap in the source), `-ss start + i/fps` landed on
  a bucket already read. ffmpeg now reports each kept frame's source time (`-stats_enc_pre`, `{pts} {tb}` with the
  demuxer time base); a restart seeks to the next bucket after the last frame's source time. Tested on a clip with a
  gap: no frame read twice.
- Exit after end of output (P2): end-of-pipe now waits up to 10 s for ffmpeg's exit code. Exit 0 ends the run; a
  GPU error falls back; a CPU error is a restart and, if restarts do not help, a plain `ClipError` (it was taken as
  a finished run).
- Pipe close blocking (P2): cleanup ends the whole ffmpeg tree (`taskkill /T /F` from System32, hidden), then
  kills and waits, joins the pump threads, and closes a pipe only when its thread has ended.
- Checkpoint key on pack version (P2): now a hash of the pack's content.
- Popen before the cleanup guard (P3): the guard starts right after Popen; only started threads are joined.
- Whole-history checkpoint writes and whole-log reads (P3): both incremental (append-only rows file; log offset).

## Tests (one file at a time, off air checked with `tools/live-check.mjs`, `UJWALAM_HEADLESS=1`)

- After the review fixes: `tests/py/test_clip_frame_reader.py` 31 tests OK (25 s); `tests/live-check.test.mjs`
  4 tests OK. New: a failing CPU run ends in a plain error; end of output waits for the exit code; a stalled
  reader is ended and reaped; a restart after an empty bucket reads no frame twice; on-air rules (quiet log still
  live, host gone, exit line, unknown); the installed host found by path; one rows line per save; a torn save is
  ignored; an edited pack starts fresh. Re-run, all OK: `test_clip_detector_pass.py` (37),
  `test_clip_match_gate.py` (37), `test_clip_live_review_gate.py` (6), `test_clip_live_montage.py` (6),
  `test_render_watch.py` (10) on `.venv-gpu`; `test_g1_detector_pass.py` (1), `test_g1_ocr.py` (8) on `.venv`;
  `node --test tests/record-clips.test.mjs tests/live-check.test.mjs` (25). `node tools/lint.mjs`: 0 findings.
- First version: `tests/py/test_clip_frame_reader.py` (new), 24 tests, OK, 21 s (`.venv-gpu`):
  - Watchdog with a fake ffmpeg: a clean run; a stall restarted at the next frame with `-ss`; restarts that do not
    help end in a plain `ClipError`; the total cap; a slow caller is not a stall; segment times across a restart.
  - Decoders: GPU failures fall back to the CPU; a GPU failure midway goes on from the next frame; on air uses the
    CPU; going on air moves to the CPU with no frame lost or read twice; a stalled GPU run moves on; the argv of
    each decoder; test runs never use the GPU.
  - `on_air` rules match `live-check.mjs`.
  - Real ffmpeg (CPU, generated clip): same frames as `g1_scan.decode_frames`, and a restart with `-ss` behind a
    proxy that hangs gives the same frames.
  - `run_pass` forwards reader events as progress lines; summary `reader` stats.
  - Resume, with the real `FrameScanner` and fake OCR: a kill at frame 6 and a re-run give the same
    `detector-hits.jsonl`, `match-stats.json` and summary counts as an uninterrupted run, in both `full` and
    `rois` modes. ffmpeg restarts at `-ss 6.000`, progress starts at 6, and the checkpoint is gone afterwards. A
    changed recording mtime, changed settings or a corrupt file each start fresh. A watchdog failure leaves a
    usable checkpoint.
- Re-run, all OK: `test_clip_detector_pass.py` (37), `test_clip_match_gate.py` (37), `test_clip_live_review_gate.py`
  (6), `test_clip_live_montage.py` (6), `test_render_watch.py` (10) on `.venv-gpu`; `test_g1_detector_pass.py` (1)
  and `test_g1_ocr.py` (8) on `.venv` (CPU OCR); `node --test tests/record-clips.test.mjs` (21).
- `node tools/lint.mjs`: 0 findings.
- Not run: the full `npm run ci` (the user's studio was open; agent rule), and the other Python test files.

## How measured

- Test clips (scratchpad, not committed): `ffmpeg -f lavfi -i testsrc2=s=2560x1440:r=60:d=60 -vf
  noise=alls=12:allf=t -c:v h264_nvenc|hevc_nvenc -preset p4 -rc cbr -b:v 40M -g 120 -bf 2`. 2 s GOP and
  2 B-frames, like the host's recording settings (`keyint_sec`, `bf` 2). Crop 1890x1304 at 604,54, as in the
  user's job.
- Scratch drivers (not committed): a decode-only reader (raw ffmpeg argv, below-normal priority, child CPU time
  from `GetProcessTimes`), a frame comparer, a `FrameReader` rate bench, and a `run_pass` bench. Each GPU run was
  under 30 s.
- Laptop: i7-12650H (16 threads), RTX 4050 Laptop 6 GB, ffmpeg n8.1.3. The studio was open off air. The user's
  clip job and other agents' builds and tests ran at the same time, so the rates vary between runs: the CPU decode
  of the H.264 clip ranged from 43 to 75 frames/min.

## Not verified / risks

- Real-recording identity was measured on one 10 min segment of one 8-bit recording. A 10-bit recording fails the
  GPU path at `format=nv12`, and the reader falls back to the CPU (tested with a fake ffmpeg only).
- The identity run was repeated after the review fixes (stats options, source-time seek): the same SHA-256 for both
  files, 291.3 s, 123.6 frames/min, CUDA, 0 restarts, ffmpeg 23.1 CPU-s, VRAM max 1967 MB.
- GPU decode while the studio is open off air uses NVDEC and some VRAM next to the host. NVDEC is a separate engine
  from NVENC and from the compositor. Its effect on an open studio's preview was not measured.
- On air needs the installed host's path under `%LOCALAPPDATA%\Ujwalam`. A dev host run from a worktree that goes
  live is not seen. The user streams from the installed app.
- The first run after this change on the user's app needs the main checkout updated. The installed app runs the
  clip workers from the main checkout.
- Checkpoint size and write time on a real 2-hour run are not measured. Band arrays are 1/4-scale grey, and the hit
  rows grow with the recording.
