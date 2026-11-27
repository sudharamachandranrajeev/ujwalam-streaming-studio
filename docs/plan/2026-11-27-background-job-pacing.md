# Background job pacing: clip work gives the PC back to the user (2026-11-27, DRAFT)

User (2026-11-27): "monitor it till the end and learn and then build an efficient way to manage resources on this pc
while these tasks are running without hogging all the pc resources."

Status: DRAFT. Measured numbers are filled in from the monitoring run (section 1) when the job ends; the plan waits for
the user's yes before any build.

## 1. What was measured (installed alpha.49, review job of a 60-minute recording, 2026-11-27)

Sampler: `C:\AI\Claude\_data\Ujwalam\scratch\2026-11-27-task-monitor\sample2.ps1` (every 5 s, read-only).

Interim (final numbers TODO when the job ends):

| Resource | Ujwalam | Whole PC |
| --- | --- | --- |
| GPU video decoder (NVDEC) | clip job's ffmpeg (`-hwaccel cuda`) | 74-94 % |
| GPU 3D | | 9-37 % |
| VRAM | | ~2.4 of 6 GB |
| CPU | ~12 % (clipper ~7, host ~3) | 20-50 % (the rest is other apps) |
| Disk read | ffmpeg ~7 MB/s | 6-8 MB/s |
| RAM | ~2 GB working set over all processes | ~17.6 GB free |

Already in place: the clip job and its children run at below-normal priority, in Windows background mode (low disk and
memory priority, post-stream jobs), ffmpeg capped at 2-4 threads, one heavy job at a time, heavy jobs wait until no
stream or recording runs (`needsIdle`, `outputsOnAir`). The live clipper and face worker idle at ~0 % CPU and 24-60 MB.

Learned:
- The load is the GPU decoder and the disk, not the CPU. CPU priority and background mode do nothing for the GPU, so a
  game, a video or a second app that uses the GPU competes with the clip job at full strength.
- Measuring with WMI (`Win32_Process` per sample) cost more CPU than the job itself; any monitor built in must use
  cheap calls only.

## 2. Proposal: pace in `run_tool`

One place: `services/clip/clip_common.py` `run_tool`, which every clip child (ffmpeg, OCR, render) already goes
through. It already starts each child suspended inside a kill-on-close job object and polls every 2 s (`stop`).

Each poll it reads the user's state with three cheap Win32 calls (no process, no WMI):

| Signal | Call | Meaning |
| --- | --- | --- |
| Away | `GetLastInputInfo` | no keyboard or mouse for N s |
| Busy | `SHQueryUserNotificationState` | a full-screen game (D3D full screen), presentation mode or busy |
| On battery | `GetSystemPowerStatus` | unplugged laptop |

and picks one of three paces:

- **Full** (user away, plugged in): runs as today.
- **Gentle** (user active at the PC): duty cycle, the child runs about 1 s then is suspended about 3 s
  (`NtSuspendProcess` / `NtResumeProcess`, already used for start-up). GPU decode, disk and CPU all drop to about a
  quarter, because a suspended ffmpeg issues no work at all.
- **Hold** (full-screen game, presentation, or on battery below a set level): the child stays suspended until the state
  ends. A stream or recording still stops the job as today.

Details:
- The stall watchdog (`stall_sec`) counts only running time, so a paced child is never killed as hung.
- The pace values (away seconds, duty cycle, battery level) live in `data/clip/pacing.json`, not in code.
- The task panel shows the pace in plain words: "Going slowly while you use the PC", "Paused while a game is full
  screen", "Full speed (you are away)".
- Settings > Clips gets one switch, on by default (a requested feature): "Go easy while I use the PC".
- The live clipper is never paced (it must keep up with the stream).

## 3. Proof

- Unit tests: pace choice from the three signals (pure function), the duty cycle and the stall watchdog with a fake
  child.
- Real run: the same 60-minute review with the user away and then active; the sampler shows NVDEC and disk dropping by
  about half while active and the job still finishing; total time recorded.

## 4. User decisions (2026-11-27)

- Gentle pace: quarter speed (child runs ~1 s, suspended ~3 s) while the user is active.
- Hold: yes, the job waits while a full-screen game or presentation runs or the laptop is on battery, and resumes on its own.
- Also: the task chip spinner steps at 8-12 frames per second instead of ~60.
