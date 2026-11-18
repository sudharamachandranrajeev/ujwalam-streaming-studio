# 2026-11-18 Idle performance (studio open, off air)

Branch `perf/idle-load`. The user reported that the studio is laggy and uses too many resources while off air. An
audit found five causes. Each fix below is one commit with what changed, the expected effect and how to measure it.

Status: the code changes are built and unit-tested. The before/after numbers are NOT measured yet. The user's studio
was open while this was built, and a second host next to it reset the GPU on 2026-11-12, so no host GPU test ran. The
main session runs `tools/perf-idle.mjs` before and after on the merged build once the studio is closed.

## Measurement (all items)

`node tools/perf-idle.mjs --minutes 10` (see the script header for the options). It refuses to run when
`node tools/live-check.mjs` says live, or when the installed studio (`%LOCALAPPDATA%\Ujwalam\...` exe path) runs.
It starts the alpha studio headless and off air for N minutes, then prints one JSON line:

- CPU seconds and private working set per process (host, node, python, studio);
- GPU 3D and video-encode utilisation (nvidia-smi, else the Windows `GPU Engine` counters);
- the host's render lag and skipped frames from `host.status` (start and end of the run).

Plan: run it on `claude/alpha0-d1` (before) and on the merged branch (after), same minutes, same machine state.

## 1. Replay buffer only while live or recording

Before: the alpha host config had `replay: { seconds: 60, autoStart: true }`. The host started a replay buffer for H
and V at studio start: two replay outputs that keep the 2560x1440 and 1440x2560 rung encoders (or fallback NVENC
encoders) running and hold 60 s of video in RAM. Measured off air (2026-11-18): video encode at 65 % with nothing
live.

Change:

- Host config `replay.onAirOnly` (new, default false; `app/host/src/host_config.cpp`). With it, the autostarted
  replay buffer is armed but attaches only while some sink is wanted (a stream or recording started and not stopped;
  a retrying stream counts). `Outputs::start` and `Outputs::stop` re-check the gate; the output supervisor checks it
  once a second, so a sink that ends on its own (a recording that failed to start, retries used up) also stops it.
- An explicit `replay.start` stays a manual start: on at once, until `replay.stop` (tests and tools rely on it).
- `replay.status` gains `onAirOnly` and `waiting` (armed, off air, no output).
- Off air, `replay.save` answers `off air: the replay buffer runs only while you are live or recording`. The
  feedback hotkey (Ctrl+Alt+F) still writes `moment.json` and `log.txt`; the replay error in `moment.json` says the
  same. The Save clip button (Qt shell and QML) shows that sentence.
- The launcher writes `replay: { seconds: 60, autoStart: true, onAirOnly: true }` and prints the state.

Expected effect: off air, no replay encoder and no 60 s memory buffer: video encode near 0 %, about 2 NVENC sessions
and a few hundred MB of RAM fewer. While live or recording nothing changes: the replay binds to the rungs the sinks
already use. Side effect: the buffer starts empty at go-live, so a clip saved in the first 60 s of a stream is shorter.

Tests:

- `node --test --test-concurrency=1 tests/studio-ui-alpha.test.mjs`: 39 pass, 1 skipped, 0 fail (host config keys,
  launcher status line with the fake host).
- New `app/host/tests/host-replay-onair.test.mjs` (real host, NVENC): NOT RUN (studio open). Run it with the studio
  closed: `node --test app/host/tests/host-replay-onair.test.mjs`.
- `app/host/tests/host-a0-day2.test.mjs` (manual replay.start path, unchanged behaviour): NOT RUN (same reason).

Measure: `perf-idle` field `gpu.videoEncodePct` (before about 65 %), host private working set, NVENC sessions
(`host.status` `gpu.encoderSessions`).
