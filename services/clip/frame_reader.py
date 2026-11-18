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
   and started again with -ss at the next frame not yet read. An ffmpeg run that ends with an error is restarted the
   same way (a GPU decoder is then dropped for the CPU). After max_restarts restarts without a frame in between (or
   max_total restarts in all) the reader raises ClipError with a plain message. The GPU is checked before each run,
   and while on a GPU decoder every air_check_sec: when the studio went on air the reader moves to the CPU at the
   next frame.

Frame times are recording times: start + i/fps for the i-th frame read, also across restarts. A restart seeks to
the 1/fps bucket after the last frame read, found from that frame's source timestamp (ffmpeg reports one per frame
on stderr), so no frame is read twice even where a bucket is empty. first_index / first_pts (the detector pass's
resume checkpoint) start the count and the first ffmpeg run at a later frame: the same seek as a watchdog restart.
"""

from __future__ import annotations

import math
import os
import queue
import re
import subprocess
import sys
import threading
import time

import g1_scan
from clip_common import ClipError, end_job, end_job_members, kill_on_close_job, on_air

GPU_DECODERS = ("cuda", "d3d11va")
AUTO = GPU_DECODERS + ("cpu",)
_HW_FORMAT = {"cuda": "cuda", "d3d11va": "d3d11"}

# Measured on the 2026-11-18 test clips (evidence file): GPU 0.1-0.3 s per kept frame, CPU 0.7-2.1 s, and 4.3 s
# per frame on the user's starved run. 90 s without a frame is about 20 times the slowest measured average.
STALL_SEC = 90.0
FIRST_FRAME_SEC = 120.0  # ffmpeg start, the input seek and the GPU set-up come before the first frame
MAX_RESTARTS = 3         # restarts in a row without a frame in between
MAX_TOTAL_RESTARTS = 10
AIR_CHECK_SEC = 2.0      # GPU runs: a watcher thread checks on_air this often (it reads only new log bytes)
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
    # One "pts timebase" line per kept frame on stderr, in the demuxer's time base (exact source timestamps): a
    # restart or resume seeks past the last frame read by its timestamp, not by its count (an empty 1/fps bucket
    # would otherwise give one frame twice).
    return cmd + ["-an", "-vf", ",".join(vf), "-fps_mode", "passthrough", "-enc_time_base:v", "demux",
                  "-stats_enc_pre", "pipe:2", "-stats_enc_pre_fmt", "{pts} {tb}",
                  "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]


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
                 clock=time.monotonic, first_index=0, first_pts=None):
        # frames already read and the last one's source timestamp (resume checkpoint): the first run seeks past them
        self.first_index = self.i = int(first_index)
        self.last_pts = None if first_pts is None else float(first_pts)
        self.path, self.fps, self.crop, self.start, self.dur = path, float(fps), crop, start, dur
        self.decoders = tuple(decoders)
        self.gpu_ok = gpu_ok if gpu_ok is not None else default_gpu_ok
        self.on_event = on_event or (lambda kind, info: None)
        self.stall_sec, self.first_sec = float(stall_sec), float(first_sec)
        self.max_restarts, self.max_total = int(max_restarts), int(max_total)
        self.air_check_sec, self.poll_sec = float(air_check_sec), float(poll_sec)
        self.popen = popen or (lambda argv: subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                                             stdin=subprocess.DEVNULL,
                                                             **g1_scan.child_kwargs(**g1_scan.NO_WINDOW)))
        self.clock = clock
        if size is None:
            if crop:
                size = (crop[2] - crop[0], crop[3] - crop[1])
            else:
                size = g1_scan.probe_size(path)
        self.w, self.h = size
        self.failed = set()  # GPU decoders that failed in this pass: not tried again
        self.ambiguous = False  # a frame's source timestamp was missing or invalid: the next seek is not guessed
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

    def _seek(self, base, i):
        """Where the next ffmpeg run starts: the start of the 1/fps bucket after the last frame read, from its source
        timestamp (self.last_pts, seconds from the file start); base + i/fps when no frame was read yet, or the
        caller resumes without a timestamp (a reader without timestamps). Rounded up to the millisecond ffmpeg is
        given, never down (a rounded-down seek could select the frame already read). Raises ClipError when the last
        frame's timestamp was missing or invalid: then which frame comes next is not known, and it is not guessed."""
        if self.ambiguous:
            raise ClipError(f"The video reader lost track of the frames at {clock_text(base + i / self.fps)} of the "
                            "recording (ffmpeg gave no valid time for a frame), so it cannot go on without reading a "
                            "frame twice or skipping one. Start the clip job again; it goes on from its last save.")
        if self.last_pts is None:
            ss = base + i / self.fps
        else:
            b = math.floor(max(self.last_pts - base, 0.0) * self.fps + 1e-6)
            ss = base + (b + 1) / self.fps
        return math.ceil(ss * 1000 - 1e-6) / 1000

    def position(self):
        """(frames read, source timestamp of the last one or None): what a resume checkpoint keeps. ambiguous: the
        timestamp is missing although ffmpeg reports them (a checkpoint is then not written)."""
        return self.i, self.last_pts

    def _watch(self, done, aired, job, p):
        """GPU run watcher (review round 2): every air_check_sec, independent of the caller (a long OCR step) and of
        the end-of-output wait: the studio going on air (or unknown) ends the GPU ffmpeg tree at once. The pass then
        goes on with the CPU decoder from the last frame it took."""
        while not done.wait(self.air_check_sec):
            try:
                ok = self.gpu_ok()
            except Exception:  # noqa: BLE001  a failing check is "unknown": off the GPU
                ok = False
            if not ok:
                aired.set()
                _kill(p, job)
                return

    def __iter__(self):
        import numpy as np
        n = self.w * self.h * 3
        base = self.start or 0.0
        end = base + self.dur if self.dur is not None else None
        self.i = self.first_index  # frames read so far (resume: the checkpoint's count)
        in_a_row = 0    # restarts since the last frame
        failure = None  # the last run's error, when it ended badly with no frame left to read after it
        while True:
            ss = self._seek(base, self.i)
            if end is not None and ss >= end - 1e-9:
                if failure:
                    raise ClipError(f"The video reader stopped at {clock_text(ss)} of the recording: {failure} after "
                                    "the last frame, so the frames read cannot be trusted. Start the clip job again.")
                return
            decoder = self._pick()
            argv = decode_argv(self.path, self.fps, self.crop, ss or None, None if end is None else end - ss, decoder)
            self.stats["decoders"].append(decoder)
            self._event("decoder", decoder, ss, f"reading the video on the {'GPU' if decoder != 'cpu' else 'CPU'}")
            p = self.popen(argv)
            pump = errs = watch = job = None
            stop, done, aired = threading.Event(), threading.Event(), threading.Event()
            pts = []  # source timestamps of this run's frames (seconds after ss; None = invalid), from stderr
            got = 0
            outcome = None  # "eof" | "short" | "stalled" | "on-air"
            rc = None
            try:
                job = kill_on_close_job(getattr(p, "_handle", None))
                power_throttling_off(p)
                q = queue.Queue(maxsize=2)
                t = threading.Thread(target=_pump, args=(p.stdout, n, q, stop), name="frame-pump", daemon=True)
                t.start()
                pump = t
                if getattr(p, "stderr", None) is not None:
                    t = threading.Thread(target=_stamps, args=(p.stderr, pts), name="frame-pts", daemon=True)
                    t.start()
                    errs = t
                if decoder != "cpu":
                    t = threading.Thread(target=self._watch, args=(done, aired, job, p), name="frame-air", daemon=True)
                    t.start()
                    watch = t
                last = last_air = self.clock()
                while outcome is None:
                    if aired.is_set():
                        outcome = "on-air"
                        break
                    try:
                        buf = q.get(timeout=self.poll_sec)
                    except queue.Empty:
                        buf = False
                    now = self.clock()
                    if buf is None or buf is SHORT:
                        # stdout ended: wait for ffmpeg to exit on its own, so its exit code tells a clean end from
                        # an error (never killed here: that would look like a failure)
                        try:
                            rc = p.wait(timeout=max(self.stall_sec, 10.0))
                            outcome = "short" if buf is SHORT else "eof"
                        except subprocess.TimeoutExpired:
                            outcome = "stalled"
                        if aired.is_set():
                            outcome = "on-air"
                        break
                    if buf is not False:
                        if aired.is_set():
                            outcome = "on-air"  # taken after the watcher ended the run: not used
                            break
                        t = base + self.i / self.fps
                        self._take_stamp(pts, got, ss, errs)
                        self.i += 1
                        got += 1
                        in_a_row = 0
                        failure = None
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
                done.set()
                if watch is not None:
                    watch.join(timeout=10)  # before the job is closed: the watcher may be ending it
                _end(p, (pump, errs), job)
            t_at = base + self.i / self.fps
            if outcome == "on-air":
                self._event("on-air", decoder, t_at, "the studio went on air; reading the video on the CPU")
                continue
            if outcome in ("eof", "short"):
                if not rc and outcome == "eof":
                    if errs is not None and got and len(pts) != got:
                        self.ambiguous = True  # a stamp line was lost: the times of this run's frames are not known
                    return  # clean end of the recording (or of the segment)
                why = (f"ffmpeg ended with an error (exit {rc})" if rc else "ffmpeg sent a partial frame")
                failure = why
                if decoder != "cpu":
                    self.failed.add(decoder)
                    self.stats["fallbacks"] += 1
                    self._event("fallback", decoder, t_at, f"the {decoder} decoder failed ({why}); "
                                                           "going on with the next decoder")
                    continue
                # the CPU decoder failed: restarted at the next frame like a stall, then a plain error
            else:
                self.stats["stalls"] += 1
                if decoder != "cpu":
                    self.failed.add(decoder)
                why = f"no new frame for {self.stall_sec if got else max(self.stall_sec, self.first_sec):.0f} s"
            self.stats["restarts"] += 1
            in_a_row += 1
            if in_a_row > self.max_restarts or self.stats["restarts"] > self.max_total:
                raise ClipError(f"The video reader stopped at {clock_text(t_at)} of the recording: {why}, "
                                f"{self.stats['restarts'] - 1} restart(s) did not help. "
                                "Close other heavy programs and start the clip job again.")
            self._event("stalled", decoder, t_at, f"{why}; restarting the video reader "
                                                  f"at {clock_text(t_at)} ({in_a_row} of {self.max_restarts})")

    def _take_stamp(self, pts, got, ss, errs):
        """The source timestamp of the frame just taken (the got-th of this run). A run without a stamp thread (a
        caller's reader without timestamps) keeps last_pts None and seeks by count. With stamps, a missing or invalid
        one, or one not after the previous frame's, makes the position ambiguous: the next seek then fails."""
        if errs is None:
            self.last_pts = None
            return
        _wait_for(pts, got + 1, errs, 2.0)
        v = pts[got] if len(pts) > got else None
        if v is None or (self.last_pts is not None and ss + v <= self.last_pts + 1e-6):
            self.ambiguous = True
            self.last_pts = None
            return
        self.last_pts = ss + v


SHORT = object()  # _pump: the pipe ended inside a frame
_STAMP = re.compile(r"^(-?\d+) (-?\d+)/(-?\d+)$")
NOPTS = -(2 ** 62)  # ffmpeg's missing timestamp is INT64_MIN; anything this low is not a time


def _stamps(stderr, out):
    """stderr thread: "pts num/den" lines (decode_argv) appended to out as seconds, or None for an invalid one (no
    timestamp, a zero or negative time base): one entry per kept frame either way. Any other line (an ffmpeg error)
    goes on to this process's stderr, the job log."""
    try:
        for raw in iter(stderr.readline, b""):
            line = raw.decode("utf-8", "replace").strip()
            m = _STAMP.match(line)
            if m:
                v, num, den = (int(x) for x in m.groups())
                out.append(v * num / den if v > NOPTS and num > 0 and den > 0 else None)
            elif line:
                print(line, file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def _wait_for(pts, k, thread, limit):
    """Wait (up to limit s) until pts holds k timestamps. ffmpeg writes a frame's line before the frame itself, so
    this is at most a thread switch; a missing line leaves the timestamp unknown (the position is then ambiguous)."""
    t0 = time.monotonic()
    while len(pts) < k and thread.is_alive() and time.monotonic() - t0 < limit:
        time.sleep(0.002)


def _pump(stdout, n, q, stop):
    """Reader thread: whole frames from the pipe into q; then None at a clean end of the pipe (on a frame boundary),
    SHORT when it ended inside a frame (or a read failed)."""
    end = None
    try:
        while not stop.is_set():
            buf = stdout.read(n)
            if len(buf) < n:
                end = SHORT if buf else None
                break
            while not stop.is_set():
                try:
                    q.put(buf, timeout=0.5)
                    break
                except queue.Full:
                    pass
    except (OSError, ValueError):
        end = SHORT
    while not stop.is_set():
        try:
            q.put(end, timeout=0.5)
            return
        except queue.Full:
            pass


def _kill(p, job=None):
    """End an ffmpeg run's whole tree now: its kill-on-close job when it has one, else taskkill /T /F (System32,
    no window), then a plain kill."""
    if job is not None:
        try:
            end_job_members(job)
        except OSError:
            pass
    elif os.name == "nt" and p.poll() is None:
        root = os.environ.get("SystemRoot", "")
        exe = os.path.join(root, "System32", "taskkill.exe") if root else ""
        if exe and os.path.isfile(exe):
            try:
                subprocess.run([exe, "/T", "/F", "/PID", str(p.pid)], capture_output=True, timeout=30,
                               creationflags=g1_scan.NO_WINDOW.get("creationflags", 0))
            except (OSError, subprocess.SubprocessError):
                pass
    if p.poll() is None:
        try:
            p.kill()
        except OSError:
            pass


def _end(p, threads=(), job=None):
    """Stop an ffmpeg run, reap it, then close its pipes. The run's job (kill_on_close_job) is ended whether or not
    ffmpeg itself already exited, so no process of the tree runs on; without a job a still running child gets
    taskkill /T /F. A pipe is closed only after its reader thread has ended (closing a pipe another thread is blocked
    reading would block here for good); one that still lives keeps its pipes (a leak, not a hang)."""
    _kill(p, job)
    try:
        p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass
    end_job(job)
    for t in threads:
        if t is not None:
            t.join(timeout=5)
    for pipe, t in ((getattr(p, "stdout", None), threads[0] if threads else None),
                    (getattr(p, "stderr", None), threads[1] if len(threads) > 1 else None)):
        if pipe is None or (t is not None and t.is_alive()):
            continue
        try:
            pipe.close()
        except (OSError, ValueError):
            pass
