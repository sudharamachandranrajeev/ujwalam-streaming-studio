# SPDX-License-Identifier: GPL-3.0-or-later
"""Watched frame reader for the post-stream detector pass (2026-11-18, docs/evidence/2026-11-18-clip-scan-speed.md).

Same frames as g1_scan.decode_frames (the first frame of each 1/fps bucket, cropped, BGR), with three changes:

1. Hardware decode. The pass keeps one frame per second but ffmpeg must decode all 60 per second. On the CPU a
   2560x1440 60 fps recording costs 1.2-2.1 CPU-seconds per kept frame, at below-normal priority, so other work on the
   laptop starved the decoder (2026-11-18: about 14 frames/min, gaps over 3 minutes). With decoders "auto" the reader
   decodes on the GPU (NVDEC through CUDA, else D3D11VA), keeps the frames on the GPU through the select filter and
   downloads only the kept frame. The GPU is used only while the studio is off air (clip_common.on_air, the rule of
   tools/live-check.mjs); on air, or when a GPU decoder fails, it decodes on the CPU as before.
2. The ffmpeg child is opted out of Windows power throttling (EcoQoS), as the OCR process already is
   (detector_pass.no_power_throttling). Priority stays below normal.
3. Watchdog. A reader thread moves frames from the pipe into a small queue; the caller waits on the queue with a
   timeout. When no frame arrives for stall_sec (first_sec before the first frame of an ffmpeg run), ffmpeg is killed
   and started again with -ss at the next frame not yet read. After max_restarts restarts without a frame in between
   (or max_total restarts in all) the reader raises ClipError with a plain message. While on a GPU decoder the
   reader checks every air_check_sec whether the studio went on air and then moves to the CPU at the next frame.

Frame times are recording times: start + i/fps for the i-th frame read, also across restarts. first_index (the
detector pass's resume checkpoint) starts the count, and the first ffmpeg run, at a later frame: the same seek as a
watchdog restart.
"""

from __future__ import annotations

import os
import queue
import subprocess
import threading
import time

import g1_scan
from clip_common import ClipError, on_air

GPU_DECODERS = ("cuda", "d3d11va")
AUTO = GPU_DECODERS + ("cpu",)
_HW_FORMAT = {"cuda": "cuda", "d3d11va": "d3d11"}

# Measured on the 2026-11-18 test clips (evidence file): GPU 0.1-0.3 s per kept frame, CPU 0.7-2.1 s, and 4.3 s
# per frame on the user's starved run. 90 s without a frame is about 20 times the slowest measured average.
STALL_SEC = 90.0
FIRST_FRAME_SEC = 120.0  # ffmpeg start, the input seek and the GPU set-up come before the first frame
MAX_RESTARTS = 3         # restarts in a row without a frame in between
MAX_TOTAL_RESTARTS = 10
AIR_CHECK_SEC = 30.0
POLL_SEC = 1.0


def decoders_for(setting):
    """Decoder order from the detector-pass setting `decode`: "auto" (GPU, then CPU) or "cpu"."""
    if setting in (None, "auto"):
        return AUTO
    if setting == "cpu":
        return ("cpu",)
    raise ClipError(f"detector pass: unknown decode setting {setting!r} (auto or cpu)")


def decode_argv(path, fps, crop=None, start=None, dur=None, decoder="cpu"):
    """ffmpeg argv for one run: bucket select (g1_scan.bucket_select), crop, raw BGR on stdout. On a GPU decoder the
    frames stay on the GPU through select and only the kept ones are downloaded (hwdownload). A 10-bit recording
    fails at format=nv12; the reader then goes on with the next decoder."""
    vf = [g1_scan.bucket_select(fps)]
    cmd = g1_scan.ffmpeg_base()
    if decoder in GPU_DECODERS:
        cmd += ["-hwaccel", decoder, "-hwaccel_output_format", _HW_FORMAT[decoder]]
        # nv12 repacked to yuv420p (lossless) before crop and the BGR conversion: then the BGR frames are bit-identical
        # to the CPU path's (measured, evidence file). Straight nv12 -> bgr24 differs (mean 1.6, max 104 levels).
        vf.append("hwdownload,format=nv12,format=yuv420p")
    elif decoder != "cpu":
        raise ValueError(f"unknown decoder {decoder}")
    if crop:
        x0, y0, x1, y1 = crop
        vf.append(f"crop={x1 - x0}:{y1 - y0}:{x0}:{y0}")
    if start:
        cmd += ["-ss", f"{start:.3f}"]
    cmd += ["-i", path]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    return cmd + ["-an", "-vf", ",".join(vf), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]


def power_throttling_off(proc):
    """Opt a started child out of Windows execution-speed power throttling (EcoQoS). True when applied."""
    handle = getattr(proc, "_handle", None)
    if os.name != "nt" or handle is None:
        return False
    import ctypes
    from ctypes import wintypes

    class _State(ctypes.Structure):
        _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]
    k = ctypes.windll.kernel32
    k.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    st = _State(1, 1, 0)  # PROCESS_POWER_THROTTLING_CURRENT_VERSION, EXECUTION_SPEED controlled, state off
    return bool(k.SetProcessInformation(int(handle), 4, ctypes.byref(st), ctypes.sizeof(st)))


def default_gpu_ok(env=None):
    """GPU decode is allowed while the studio is off air (on_air() False; unknown counts as on air). Test runs
    (UJWALAM_HEADLESS=1) never use it, so CI next to an open studio stays off the GPU."""
    if (env if env is not None else os.environ).get("UJWALAM_HEADLESS") == "1":
        return False
    return on_air() is False


def clock_text(sec):
    sec = max(0, int(sec))
    return f"{sec // 3600}:{sec // 60 % 60:02d}:{sec % 60:02d}" if sec >= 3600 else f"{sec // 60}:{sec % 60:02d}"


class FrameReader:
    """Iterate (t_sec, bgr ndarray). See the module doc. size: (w, h) of the decoded (cropped) frame; probed when
    not given. gpu_ok(): True when the GPU may be used now (default: off air). on_event(kind, info): "decoder" (a run
    starts), "fallback" (a GPU run failed), "stalled", "on-air"; info holds decoder, t, restarts and a plain note."""

    def __init__(self, path, fps, crop=None, start=None, dur=None, decoders=("cpu",), size=None, gpu_ok=None,
                 on_event=None, stall_sec=STALL_SEC, first_sec=FIRST_FRAME_SEC, max_restarts=MAX_RESTARTS,
                 max_total=MAX_TOTAL_RESTARTS, air_check_sec=AIR_CHECK_SEC, poll_sec=POLL_SEC, popen=None,
                 clock=time.monotonic, first_index=0):
        self.first_index = int(first_index)  # frames already read (resume checkpoint): the first ffmpeg run seeks past them
        self.path, self.fps, self.crop, self.start, self.dur = path, float(fps), crop, start, dur
        self.decoders = tuple(decoders)
        self.gpu_ok = gpu_ok if gpu_ok is not None else default_gpu_ok
        self.on_event = on_event or (lambda kind, info: None)
        self.stall_sec, self.first_sec = float(stall_sec), float(first_sec)
        self.max_restarts, self.max_total = int(max_restarts), int(max_total)
        self.air_check_sec, self.poll_sec = float(air_check_sec), float(poll_sec)
        self.popen = popen or (lambda argv: subprocess.Popen(argv, stdout=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                                             **g1_scan.child_kwargs(**g1_scan.NO_WINDOW)))
        self.clock = clock
        if size is None:
            if crop:
                size = (crop[2] - crop[0], crop[3] - crop[1])
            else:
                size = g1_scan.probe_size(path)
        self.w, self.h = size
        self.failed = set()  # GPU decoders that failed in this pass: not tried again
        self.stats = {"restarts": 0, "stalls": 0, "fallbacks": 0, "decoders": []}

    def _pick(self):
        for d in self.decoders:
            if d in self.failed:
                continue
            if d in GPU_DECODERS and not self.gpu_ok():
                continue
            return d
        return "cpu"

    def _event(self, kind, decoder, t, note):
        self.on_event(kind, {"decoder": decoder, "t": round(t, 3), "restarts": self.stats["restarts"], "note": note})

    def __iter__(self):
        import numpy as np
        n = self.w * self.h * 3
        base = self.start or 0.0
        end = base + self.dur if self.dur is not None else None
        i = self.first_index  # frames read so far; the next one is at base + i / fps (restart and resume both seek there)
        in_a_row = 0    # restarts since the last frame
        while True:
            t_next = base + i / self.fps
            if end is not None and t_next >= end - 1e-9:
                return
            decoder = self._pick()
            argv = decode_argv(self.path, self.fps, self.crop, t_next or None, None if end is None else end - t_next,
                               decoder)
            self.stats["decoders"].append(decoder)
            self._event("decoder", decoder, t_next, f"reading the video on the {'GPU' if decoder != 'cpu' else 'CPU'}")
            p = self.popen(argv)
            power_throttling_off(p)
            q = queue.Queue(maxsize=2)
            stop = threading.Event()
            pump = threading.Thread(target=_pump, args=(p.stdout, n, q, stop), name="frame-pump", daemon=True)
            pump.start()
            got = 0
            started = last = last_air = self.clock()
            outcome = None  # "eof" | "stalled" | "on-air"
            try:
                while outcome is None:
                    try:
                        buf = q.get(timeout=self.poll_sec)
                    except queue.Empty:
                        buf = False
                    now = self.clock()
                    if buf is None:
                        outcome = "eof"
                        break
                    if buf is not False:
                        t = base + i / self.fps
                        i += 1
                        got += 1
                        in_a_row = 0
                        yield t, np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3)
                        now = last = self.clock()  # the caller's time on the frame (OCR) is not the reader's silence
                    if now - last >= (self.stall_sec if got else max(self.stall_sec, self.first_sec)):
                        outcome = "stalled"
                    elif decoder != "cpu" and now - last_air >= self.air_check_sec:
                        last_air = now
                        if not self.gpu_ok():
                            outcome = "on-air"
            finally:
                stop.set()
                _end(p)
                pump.join(timeout=5)
            t_at = base + i / self.fps
            if outcome == "eof":
                rc = p.returncode
                if rc and decoder != "cpu":
                    self.failed.add(decoder)
                    self.stats["fallbacks"] += 1
                    self._event("fallback", decoder, t_at, f"the {decoder} decoder failed (exit {rc}); "
                                                           "going on with the next decoder")
                    continue
                return  # the CPU decoder ending (also with an error) ends the pass, as before
            if outcome == "on-air":
                self._event("on-air", decoder, t_at, "the studio went on air; reading the video on the CPU")
                continue
            # stalled
            self.stats["stalls"] += 1
            self.stats["restarts"] += 1
            in_a_row += 1
            if decoder != "cpu":
                self.failed.add(decoder)
            waited = self.stall_sec if got else max(self.stall_sec, self.first_sec)
            if in_a_row > self.max_restarts or self.stats["restarts"] > self.max_total:
                raise ClipError(f"The video reader stopped at {clock_text(t_at)} of the recording: no new frame for "
                                f"{waited:.0f} s, {self.stats['restarts'] - 1} restart(s) did not help. "
                                "Close other heavy programs and start the clip job again.")
            self._event("stalled", decoder, t_at, f"no new frame for {waited:.0f} s; restarting the video reader "
                                                  f"at {clock_text(t_at)} ({in_a_row} of {self.max_restarts})")


def _pump(stdout, n, q, stop):
    """Reader thread: whole frames from the pipe into q; None at the end (EOF, short read or a closed pipe)."""
    try:
        while not stop.is_set():
            buf = stdout.read(n)
            if len(buf) < n:
                break
            while not stop.is_set():
                try:
                    q.put(buf, timeout=0.5)
                    break
                except queue.Full:
                    pass
    except (OSError, ValueError):
        pass
    while not stop.is_set():
        try:
            q.put(None, timeout=0.5)
            return
        except queue.Full:
            pass


def _end(p):
    """Stop an ffmpeg run (no-op when it already ended) and reap it."""
    if p.poll() is None:
        try:
            p.kill()
        except OSError:
            pass
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    try:
        p.stdout.close()
    except (OSError, ValueError):
        pass
