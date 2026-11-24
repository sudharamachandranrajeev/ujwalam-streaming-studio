# SPDX-License-Identifier: GPL-3.0-or-later
"""Watched frame reader of the post-stream detector pass (services/clip/frame_reader.py; 2026-11-18: the clip job read
about 14 frames/min and stalled for minutes, docs/evidence/2026-11-18-clip-scan-speed.md).

The watchdog, restart, fallback and on-air cases use a fake ffmpeg: small Python children that write raw frames
(4x2 px) on stdout, hang, or fail. The real-ffmpeg cases decode a small generated clip on the CPU only (no GPU in
tests) and check that a restart with -ss gives the same frames as one run."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402

try:
    import numpy as np  # noqa: F401
    import frame_reader as fr  # noqa: E402
    import g1_scan  # noqa: E402
    HAVE_NP = True
except ImportError:  # the plain test:py Python has no numpy
    HAVE_NP = False

PY = sys.executable
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
W, H = 4, 2
N = W * H * 3

# A fake ffmpeg run: writes `frames` frames (byte value = first + k), `delay` s apart, each after its "pts tb" line
# on stderr (as decode_argv asks ffmpeg for), then hangs for `hang` s (0: no hang) and exits with `rc`. A plan with
# a 5th value closes stdout first and exits that many seconds later (end of output before the exit).
FAKE = r"""
import sys, time
first, frames, delay, hang, rc = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])
size, div, fps, late = int(sys.argv[6]), int(sys.argv[7]), float(sys.argv[8]), float(sys.argv[9])
bad, short = int(sys.argv[10]), int(sys.argv[11])
out = sys.stdout.buffer
for k in range(frames):
    sys.stderr.write("-9223372036854775808 1/1000\n" if k == bad else f"{round(k / fps * 1000)} 1/1000\n")
    sys.stderr.flush()
    out.write(bytes([((first + k) // div) % 256]) * size)
    out.flush()
    time.sleep(delay)
if short:
    out.write(b"x" * (size // 2))
    out.flush()
if hang:
    time.sleep(hang)
if late:
    out.close()
    time.sleep(late)
sys.exit(rc)
"""


class FakeFfmpeg:
    """popen for FrameReader: run k gets plans[k] = (frames, delay, hang, rc[, late]); every byte of frame i (counted
    from the frame its -ss points at) is i // div, so the test sees which frames each run gave."""

    def __init__(self, plans, fps=1.0, size=N, div=1, bad=-1, short=False):
        self.plans, self.fps, self.size, self.div, self.argvs = list(plans), fps, size, div, []
        self.bad, self.short = bad, short  # first run only: frame `bad` gets ffmpeg's no-timestamp value; a half frame

    def __call__(self, argv):
        self.argvs.append(argv)
        frames, delay, hang, rc, *late = self.plans.pop(0)
        ss = float(argv[argv.index("-ss") + 1]) if "-ss" in argv else 0.0
        first = int(round(ss * self.fps))
        return subprocess.Popen([PY, "-I", "-c", FAKE, str(first), str(frames), str(delay), str(hang), str(rc),
                                 str(self.size), str(self.div), str(self.fps), str(late[0] if late else 0),
                                 str(self.bad if len(self.argvs) == 1 else -1), str(int(self.short))],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, **NO_WINDOW)


def reader(fake, **kw):
    opts = dict(size=(W, H), decoders=("cpu",), gpu_ok=lambda: False, stall_sec=0.6, first_sec=0.6, poll_sec=0.05,
                air_check_sec=0.1, popen=fake)
    opts.update(kw)
    return fr.FrameReader("rec.mkv", 1.0, **opts)


def values(frames):
    return [(round(t, 3), int(img[0, 0, 0])) for t, img in frames]


@unittest.skipUnless(HAVE_NP, "needs numpy")
class WatchdogTests(unittest.TestCase):
    def test_a_clean_run_reads_every_frame(self):
        fake = FakeFfmpeg([(5, 0, 0, 0)])
        self.assertEqual(values(reader(fake)), [(float(i), i) for i in range(5)])
        self.assertNotIn("-ss", fake.argvs[0])

    def test_a_stalled_run_is_restarted_at_the_next_frame(self):
        events = []
        fake = FakeFfmpeg([(3, 0, 60, 0), (2, 0, 0, 0)])
        t0 = time.monotonic()
        got = values(reader(fake, on_event=lambda k, i: events.append((k, i))))
        self.assertLess(time.monotonic() - t0, 20)
        self.assertEqual(got, [(float(i), i) for i in range(5)])
        self.assertEqual(fake.argvs[1][fake.argvs[1].index("-ss") + 1], "3.000")
        stalled = [i for k, i in events if k == "stalled"]
        self.assertEqual(len(stalled), 1)
        self.assertEqual(stalled[0]["t"], 3.0)
        self.assertIn("restarting the video reader at 0:03 (1 of 3)", stalled[0]["note"])

    def test_restarts_that_do_not_help_end_in_a_plain_error(self):
        fake = FakeFfmpeg([(2, 0, 60, 0)] + [(0, 0, 60, 0)] * 5)
        got = []
        with self.assertRaises(cc.ClipError) as e:
            for t, img in reader(fake, max_restarts=2):
                got.append(t)
        self.assertEqual(got, [0.0, 1.0])
        self.assertEqual(len(fake.argvs), 3, "one run and two restarts")
        msg = str(e.exception)
        self.assertIn("The video reader stopped at 0:02 of the recording", msg)
        self.assertIn("2 restart(s) did not help", msg)

    def test_the_total_restart_cap_holds_even_with_progress_between(self):
        fake = FakeFfmpeg([(1, 0, 60, 0)] * 6)
        with self.assertRaises(cc.ClipError):
            list(reader(fake, max_restarts=3, max_total=4))
        self.assertEqual(len(fake.argvs), 5)

    def test_a_slow_caller_is_not_a_stall(self):
        # OCR time on a frame is the caller's: the watchdog measures only the wait for the next frame
        fake = FakeFfmpeg([(3, 0, 0, 0)])
        got = []
        for t, img in reader(fake, stall_sec=0.3, first_sec=5):
            time.sleep(0.8)
            got.append(t)
        self.assertEqual(got, [0.0, 1.0, 2.0])
        self.assertEqual(len(fake.argvs), 1)

    def test_a_cpu_run_that_fails_is_restarted_then_ends_in_a_plain_error(self):
        # review 2026-11-18: a CPU ffmpeg error used to end the pass as if the recording had ended
        fake = FakeFfmpeg([(2, 0, 0, 1), (1, 0, 0, 0)])
        self.assertEqual(values(reader(fake)), [(0.0, 0), (1.0, 1), (2.0, 2)])
        self.assertEqual(fake.argvs[1][fake.argvs[1].index("-ss") + 1], "2.000")
        fake = FakeFfmpeg([(2, 0, 0, 1)] + [(0, 0, 0, 1)] * 3)
        with self.assertRaises(cc.ClipError) as e:
            list(reader(fake, max_restarts=2))
        self.assertIn("ffmpeg ended with an error (exit 1)", str(e.exception))

    def test_end_of_output_waits_for_the_exit_code(self):
        # stdout closes 0.4 s before ffmpeg exits: not killed in between (a clean end is not a GPU failure)
        fake = FakeFfmpeg([(2, 0, 0, 0, 0.4)])
        r = reader(fake, decoders=fr.AUTO, gpu_ok=lambda: True)
        self.assertEqual(len(list(r)), 2)
        self.assertEqual((r.stats["decoders"], r.stats["fallbacks"]), (["cuda"], 0))

    def test_the_reader_is_ended_and_reaped_after_a_stall(self):
        procs = []
        fake = FakeFfmpeg([(1, 0, 60, 0), (1, 0, 0, 0)])

        def popen(argv):
            procs.append(fake(argv))
            return procs[-1]
        self.assertEqual(len(list(reader(popen))), 2)
        self.assertTrue(all(p.poll() is not None for p in procs))
        self.assertTrue(procs[0].stdout.closed and procs[0].stderr.closed)

    def test_a_segment_keeps_recording_times_across_a_restart(self):
        fake = FakeFfmpeg([(2, 0, 60, 0), (5, 0, 0, 0)])
        got = values(reader(fake, start=10.0, dur=4.0))
        self.assertEqual([t for t, _ in got][:4], [10.0, 11.0, 12.0, 13.0])
        a0, a1 = fake.argvs
        self.assertEqual((a0[a0.index("-ss") + 1], a0[a0.index("-t") + 1]), ("10.000", "4.000"))
        self.assertEqual((a1[a1.index("-ss") + 1], a1[a1.index("-t") + 1]), ("12.000", "2.000"))


@unittest.skipUnless(HAVE_NP, "needs numpy")
class DecoderChoiceTests(unittest.TestCase):
    def test_gpu_failures_fall_back_to_the_cpu(self):
        events = []
        fake = FakeFfmpeg([(0, 0, 0, 1), (0, 0, 0, 1), (3, 0, 0, 0)])
        r = reader(fake, decoders=fr.AUTO, gpu_ok=lambda: True, on_event=lambda k, i: events.append(k))
        self.assertEqual([t for t, _ in r], [0.0, 1.0, 2.0])
        self.assertEqual(r.stats["decoders"], ["cuda", "d3d11va", "cpu"])
        self.assertIn("cuda", fake.argvs[0])
        self.assertNotIn("-hwaccel", fake.argvs[2])
        self.assertEqual(events.count("fallback"), 2)

    def test_a_gpu_failure_midway_goes_on_from_the_next_frame(self):
        fake = FakeFfmpeg([(2, 0, 0, 1), (3, 0, 0, 0)])
        r = reader(fake, decoders=fr.AUTO, gpu_ok=lambda: True)
        self.assertEqual(values(r), [(float(i), i) for i in range(5)])
        self.assertEqual(r.stats["decoders"], ["cuda", "d3d11va"])
        self.assertEqual(fake.argvs[1][fake.argvs[1].index("-ss") + 1], "2.000")

    def test_on_air_uses_the_cpu(self):
        fake = FakeFfmpeg([(2, 0, 0, 0)])
        r = reader(fake, decoders=fr.AUTO, gpu_ok=lambda: False)
        self.assertEqual(len(list(r)), 2)
        self.assertEqual(r.stats["decoders"], ["cpu"])

    def test_going_on_air_moves_the_reader_to_the_cpu(self):
        state = {"ok": True}
        events = []
        fake = FakeFfmpeg([(10, 0.25, 0, 0), (10, 0, 0, 0)])
        r = reader(fake, decoders=fr.AUTO, gpu_ok=lambda: state["ok"], on_event=lambda k, i: events.append(k),
                   stall_sec=5, first_sec=5)
        got = []
        for t, img in r:
            got.append((t, int(img[0, 0, 0])))
            if len(got) == 2:
                state["ok"] = False
            if len(got) == 6:
                break
        self.assertEqual(got, [(float(i), i) for i in range(6)], "no frame lost or read twice")
        self.assertEqual(r.stats["decoders"], ["cuda", "cpu"])
        self.assertIn("on-air", events)

    def test_a_stalled_gpu_run_restarts_on_the_next_decoder(self):
        fake = FakeFfmpeg([(1, 0, 60, 0), (2, 0, 0, 0)])
        r = reader(fake, decoders=fr.AUTO, gpu_ok=lambda: True)
        self.assertEqual(len(list(r)), 3)
        self.assertEqual(r.stats["decoders"], ["cuda", "d3d11va"])

    def test_the_watcher_ends_a_gpu_run_while_the_caller_is_busy(self):
        # review round 2: going on air during a long OCR step ends the GPU ffmpeg at once, not at the next frame
        state = {"ok": True}
        procs = []
        fake = FakeFfmpeg([(10, 0.05, 0, 0), (10, 0, 0, 0)])

        def popen(argv):
            procs.append(fake(argv))
            return procs[-1]
        r = reader(popen, decoders=fr.AUTO, gpu_ok=lambda: state["ok"], stall_sec=5, first_sec=5, air_check_sec=0.1)
        got = []
        for t, img in r:
            got.append((t, int(img[0, 0, 0])))
            if len(got) == 2:
                state["ok"] = False
                t0 = time.monotonic()
                while procs[0].poll() is None and time.monotonic() - t0 < 5:
                    time.sleep(0.02)
                self.assertIsNotNone(procs[0].poll(), "the GPU ffmpeg ended while the caller held the frame")
            if len(got) == 5:
                break
        self.assertEqual(got, [(float(i), i) for i in range(5)], "no frame lost or read twice")
        self.assertEqual(r.stats["decoders"], ["cuda", "cpu"])

    def test_a_failure_after_the_last_frame_is_not_success(self):
        # review round 2: a nonzero exit after a segment's last frame used to end the pass as complete
        fake = FakeFfmpeg([(3, 0, 0, 1)])
        with self.assertRaises(cc.ClipError) as e:
            list(reader(fake, start=0.0, dur=3.0))
        self.assertIn("after the last frame", str(e.exception))
        fake = FakeFfmpeg([(3, 0, 0, 0)], short=True)
        with self.assertRaises(cc.ClipError):
            list(reader(fake, start=0.0, dur=3.0))

    def test_a_missing_timestamp_is_not_guessed(self):
        # review round 2: frame 1 has ffmpeg's "no timestamp" value; the run stalls after frame 2: no restart guess
        fake = FakeFfmpeg([(3, 0, 60, 0), (3, 0, 0, 0)], bad=1)
        r = reader(fake)
        with self.assertRaises(cc.ClipError) as e:
            list(r)
        self.assertIn("lost track of the frames", str(e.exception))
        self.assertTrue(r.ambiguous)
        self.assertEqual(len(fake.argvs), 1)

    def test_stamp_lines(self):
        import io
        out = []
        fr._stamps(io.BytesIO(b"1000 1/1000\n5 1/0\n-9223372036854775808 1/1000\n2 0/1\n"), out)
        self.assertEqual(out, [1.0, None, None, None])

    def test_the_seek_is_rounded_up(self):
        r = reader(FakeFfmpeg([]))
        self.assertEqual(r._seek(10.0004, 0), 10.001)
        r.last_pts = 12.0
        self.assertEqual(r._seek(0.0, 12), 13.0)

    def test_decode_setting(self):
        self.assertEqual(fr.decoders_for("auto"), fr.AUTO)
        self.assertEqual(fr.decoders_for(None), fr.AUTO)
        self.assertEqual(fr.decoders_for("cpu"), ("cpu",))
        with self.assertRaises(cc.ClipError):
            fr.decoders_for("gpu")

    def test_gpu_argv_downloads_only_the_kept_frame(self):
        a = fr.decode_argv("r.mkv", 1.0, crop=(604, 54, 2494, 1358), decoder="cuda")
        self.assertEqual(a[a.index("-hwaccel") + 1:a.index("-hwaccel") + 4], ["cuda", "-hwaccel_output_format", "cuda"])
        vf = a[a.index("-vf") + 1]
        self.assertEqual(vf, g1_scan.bucket_select(1.0) + ",hwdownload,format=nv12,format=yuv420p,crop=1890:1304:604:54")
        d = fr.decode_argv("r.mkv", 1.0, decoder="d3d11va")
        self.assertEqual(d[d.index("-hwaccel_output_format") + 1], "d3d11")
        c = fr.decode_argv("r.mkv", 1.0, crop=(604, 54, 2494, 1358))
        self.assertNotIn("-hwaccel", c)
        self.assertEqual(c[c.index("-vf") + 1], g1_scan.bucket_select(1.0) + ",crop=1890:1304:604:54")

    def test_test_runs_never_use_the_gpu(self):
        self.assertFalse(fr.default_gpu_ok({"UJWALAM_HEADLESS": "1"}))


class OnAirTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="ujw-air-")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def log(self, name, text, age=0, mode="w"):
        p = os.path.join(self.dir, name)
        with open(p, mode, encoding="utf-8") as f:
            f.write(text)
        t = time.time() - age
        os.utime(p, (t, t))

    def test_rules_match_live_check(self):
        import datetime

        def utc(*a):  # installed_hosts gives UTC-aware start times; the log names are UTC
            return datetime.datetime(*a, tzinfo=datetime.timezone.utc)
        s1 = utc(2026, 11, 18, 19, 15, 3)
        s2 = utc(2026, 11, 18, 21, 0, 0)
        a, b = "host-2026-11-18T19-15-04.log", "host-2026-11-18T21-00-01.log"
        up = lambda: [s1]  # noqa: E731
        self.assertFalse(cc.on_air(self.dir, lambda: []), "no installed host runs: off air, whatever the logs say")
        self.assertIsNone(cc.on_air(self.dir, lambda: None), "the host cannot be checked: unknown")
        self.assertIsNone(cc.on_air(os.path.join(self.dir, "missing"), up), "a host runs and its logs are missing")
        self.assertIsNone(cc.on_air(self.dir, up), "a host runs and has no log: unknown")
        self.log(a, "[host] sink yt-h live\n")
        self.assertTrue(cc.on_air(self.dir, up))
        self.log(a, "[host] sink yt-h stopped\n", mode="a")
        self.assertFalse(cc.on_air(self.dir, up), "read on from where the last call stopped")
        self.log(a, "[host] sink rec live\n[host] sink rec dropped\n", mode="a")
        self.assertTrue(cc.on_air(self.dir, up), "dropped (retrying) stays on air")
        self.log(a, "[host] rpc host.alive\n", age=3600, mode="a")
        self.assertTrue(cc.on_air(self.dir, up), "review 2026-11-18: a quiet log during a long stream is still live")
        self.log(b, "[host] sink twitch stopped\n")
        self.assertTrue(cc.on_air(self.dir, up), "a newer log of another host does not hide this host's state")
        self.assertFalse(cc.on_air(self.dir, lambda: [s2]), "each host reads its own log")
        self.assertIsNone(cc.on_air(self.dir, lambda: [s1 + datetime.timedelta(hours=5)]), "no log of this host")
        self.log(a, "[host] exit 0\n", age=3600, mode="a")
        self.assertFalse(cc.on_air(self.dir, up), "the host closed")

    def test_the_log_name_is_utc_in_summer_time_too(self):
        """Astra review: the host names its log in UTC; a local reading missed it by an hour under summer time. Codex:
        in the repeated autumn hour (UK 2026-10-25 01:00-02:00 local happens twice) only UTC tells the hosts apart."""
        import datetime
        utc = datetime.timezone.utc
        start = datetime.datetime(2026, 7, 18, 19, 15, 3, tzinfo=utc)
        self.assertEqual(cc.log_for_start(["host-2026-07-18T19-15-04.log"], start), "host-2026-07-18T19-15-04.log")
        first, second = "host-2026-10-25T00-30-00.log", "host-2026-10-25T01-30-00.log"  # both 01:30 on a UK clock
        self.assertEqual(cc.log_for_start([first, second], datetime.datetime(2026, 10, 25, 1, 30, 1, tzinfo=utc)), second)
        self.assertEqual(cc.log_for_start([first, second], datetime.datetime(2026, 10, 25, 0, 30, 1, tzinfo=utc)), first)

    def test_a_replaced_log_is_read_from_the_start(self):
        import datetime
        up = lambda: [datetime.datetime(2026, 11, 18, 19, 15, 3, tzinfo=datetime.timezone.utc)]  # noqa: E731
        name = "host-2026-11-18T19-15-03.log"
        self.log(name, "[host] sink yt-h live\n" + "x" * 200 + "\n")
        self.assertTrue(cc.on_air(self.dir, up))
        os.remove(os.path.join(self.dir, name))
        self.log(name, "[host] sink yt-h stopped\n" + "y" * 400 + "\n")  # longer than the old offset
        self.assertFalse(cc.on_air(self.dir, up), "review round 2: same path, new file")

    @unittest.skipUnless(os.name == "nt", "Windows")
    def test_the_installed_host_is_found_by_path(self):
        self.assertFalse(cc.installed_host_running(self.dir), "no host under this folder")
        self.assertIsInstance(cc.installed_hosts(self.dir), list)
        self.assertIsInstance(cc.installed_hosts(self.dir), list, "a second call works too (ctypes types per call)")
        self.assertIn(cc.on_air(self.dir), (False, None))


@unittest.skipUnless(HAVE_NP and shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs numpy and ffmpeg")
class RealFfmpegTests(unittest.TestCase):
    """CPU decode of a generated clip (no GPU in tests)."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix="ujw-reader-")
        cls.clip = os.path.join(cls.dir, "t.mkv")
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i",
                        "testsrc2=size=320x180:rate=60:duration=8", "-c:v", "libopenh264", "-g", "120",
                        "-pix_fmt", "yuv420p", cls.clip], check=True, **NO_WINDOW)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def test_same_frames_as_decode_frames(self):
        crop = (20, 10, 300, 170)
        ref = list(g1_scan.decode_frames(self.clip, 1.0, crop=crop))
        got = list(fr.FrameReader(self.clip, 1.0, crop=crop, decoders=("cpu",), gpu_ok=lambda: False))
        self.assertEqual([t for t, _ in got], [t for t, _ in ref])
        for (_, a), (_, b) in zip(got, ref):
            self.assertTrue(np.array_equal(a, b))

    def test_a_restart_with_seek_gives_the_same_frames(self):
        # the first run is real ffmpeg behind a proxy that passes 3 frames on and then hangs: the watchdog restarts
        # real ffmpeg at -ss 3
        n = 280 * 160 * 3
        proxy = ("import subprocess,sys,time\n"
                 f"p=subprocess.Popen(sys.argv[1:],stdout=subprocess.PIPE,stdin=subprocess.DEVNULL,creationflags={NO_WINDOW.get('creationflags', 0)})\n"
                 f"for _ in range(3):\n sys.stdout.buffer.write(p.stdout.read({n})); sys.stdout.buffer.flush()\n"
                 "p.kill()\ntime.sleep(60)\n")
        argvs = []

        def popen(argv):
            argvs.append(argv)
            cmd = [PY, "-I", "-c", proxy] + argv if len(argvs) == 1 else argv
            return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                    **NO_WINDOW)

        crop = (20, 10, 300, 170)
        ref = list(g1_scan.decode_frames(self.clip, 1.0, crop=crop))
        got = list(fr.FrameReader(self.clip, 1.0, crop=crop, decoders=("cpu",), gpu_ok=lambda: False, popen=popen,
                                  stall_sec=2, first_sec=20, poll_sec=0.1))
        self.assertEqual(len(argvs), 2)
        self.assertEqual([t for t, _ in got], [t for t, _ in ref])
        for (t, a), (_, b) in zip(got, ref):
            self.assertLess(float(np.abs(a.astype(np.int16) - b.astype(np.int16)).mean()), 0.5, t)

    def test_a_restart_after_an_empty_bucket_reads_no_frame_twice(self):
        # review 2026-11-18: frames at 0.0 and 3.0 s (buckets 1 and 2 empty); after 2 frames a seek by count (-ss 2)
        # gave the 3.0 s frame again. The restart now seeks past the last frame's own timestamp (-ss 4).
        gap = os.path.join(self.dir, "gap.mkv")
        subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10:duration=8",
                        "-vf", "select='not(between(t,1.0,2.99))'", "-fps_mode", "passthrough", "-c:v", "libopenh264",
                        gap], check=True, **NO_WINDOW)
        n = 160 * 90 * 3
        proxy = ("import subprocess,sys,time\n"
                 f"p=subprocess.Popen(sys.argv[1:],stdout=subprocess.PIPE,stdin=subprocess.DEVNULL,creationflags={NO_WINDOW.get('creationflags', 0)})\n"
                 f"for _ in range(2):\n sys.stdout.buffer.write(p.stdout.read({n})); sys.stdout.buffer.flush()\n"
                 "time.sleep(0.5)\np.kill()\ntime.sleep(60)\n")
        argvs = []

        def popen(argv):
            argvs.append(argv)
            cmd = [PY, "-I", "-c", proxy] + argv if len(argvs) == 1 else argv
            return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                    **NO_WINDOW)

        ref = list(fr.FrameReader(gap, 1.0, decoders=("cpu",), gpu_ok=lambda: False))
        self.assertEqual(len(ref), 6)
        got = list(fr.FrameReader(gap, 1.0, decoders=("cpu",), gpu_ok=lambda: False, popen=popen, stall_sec=2,
                                  first_sec=20, poll_sec=0.1))
        self.assertEqual(argvs[1][argvs[1].index("-ss") + 1], "4.000")
        self.assertEqual([t for t, _ in got], [t for t, _ in ref])
        for (t, a), (_, b) in zip(got, ref):
            self.assertTrue(np.array_equal(a, b), t)


@unittest.skipUnless(HAVE_NP, "needs numpy")
class RunPassTests(unittest.TestCase):
    """detector_pass.run_pass forwards reader events as progress lines (the Tasks panel's stall warning)."""

    def test_watchdog_events_reach_the_progress_line(self):
        import detector_pass as dp

        class Scanner:
            regions, unthrottled = "full", False

            def __init__(self, *a, **k):
                self.stats = {"frames": 0, "ocrFrames": 0, "diffGateSkips": 0, "ocrSeconds": 0.0}

            def scan(self, t, img):
                self.stats["frames"] += 1
                return []

            def match_stats(self):
                return {"readings": [], "ownKills": {"times": []}}

        saved = dp.FrameScanner
        dp.FrameScanner = Scanner
        lines, logs = [], []
        try:
            with tempfile.TemporaryDirectory() as d:
                layout = {"frame": [W, H], "game": [0, 0, W, H], "visible": [0, 0, W, H]}
                fake = FakeFfmpeg([(2, 0, 60, 0), (2, 0, 0, 0)])
                settings = {"fps": 1.0, "mergeGapSec": 2.5, "decode": "cpu"}
                summ = dp.run_pass("rec.mkv", d, settings, {"version": "t"}, [], layout, progress=logs.append,
                                   progress_line=lambda *a: lines.append(a), total_frames=4,
                                   reader_opts={"popen": fake, "gpu_ok": lambda: False, "stall_sec": 0.5,
                                                "first_sec": 0.5, "poll_sec": 0.05})
                self.assertTrue(os.path.exists(os.path.join(d, dp.HITS)))
        finally:
            dp.FrameScanner = saved
        self.assertEqual(summ["frames"], 4)
        self.assertEqual(summ["reader"], {"decoders": ["cpu", "cpu"], "restarts": 1, "stalls": 1, "fallbacks": 0})
        notes = [a[2] for a in lines if len(a) == 3]
        self.assertTrue(any("restarting the video reader" in s for s in notes), notes)
        self.assertTrue(any("reading the video on the CPU" in s for s in notes), notes)
        self.assertEqual(lines[-1][:2], (4, 4))
        self.assertTrue(any("restarting" in s for s in logs))


try:
    import cv2  # noqa: F401
    HAVE_CV = HAVE_NP
except ImportError:
    HAVE_CV = False


class Killed(Exception):
    """Stands in for the process being killed (Stop, Ujwalam closed): nothing after it runs."""


@unittest.skipUnless(HAVE_CV, "needs numpy and cv2")
class ResumeTests(unittest.TestCase):
    """Resume checkpoint (user 2026-11-18): a pass cut short goes on from its last checkpoint with the same final
    result as an uninterrupted pass. Real FrameScanner state (diff gate, bands, mode, kill counter) with the OCR
    replaced by a fake that reads text from the frame's pixel value; fake ffmpeg frames."""

    FW, FH, FRAMES = 320, 180, 14

    def setUp(self):
        import detector_pass as dp
        import game_pack
        self.dp = dp
        self.dir = tempfile.mkdtemp(prefix="ujw-resume-")
        self.rec = os.path.join(self.dir, "rec.mkv")
        with open(self.rec, "wb") as f:
            f.write(b"not a video; the fake ffmpeg ignores it")
        _, self.settings, _ = dp.load_settings()
        self.pack = game_pack.load_pack(dp.pack_path(self.settings))
        self.layout = {"frame": [self.FW, self.FH], "game": [0, 0, self.FW, self.FH], "visible": [0, 0, self.FW, self.FH]}
        self.saved = (g1_scan.ocr, dp.ocr_crops, dp.CHECKPOINT_EVERY_SEC)

        def text_for(v):
            return ["Triple Kill", "KILLCAM", "VICTORY", "+50"][v % 4] if v % 3 else None

        def fake_ocr(img):
            t = text_for(int(img[0, 0, 0]))
            return ([{"text": t, "score": 0.95, "x0": 100.0, "y0": 20.0, "x1": 220.0, "y1": 40.0}] if t else []), 1.0

        def fake_crops(crops, det_scale=1.0, keep=None):
            out = []
            for c in crops:
                t = text_for(int(c[0, 0, 0]))
                out.append([{"text": t, "score": 0.9, "x0": 1.0, "y0": 1.0, "x1": 30.0, "y1": 9.0}] if t else [])
            return out
        g1_scan.ocr = fake_ocr
        dp.ocr_crops = fake_crops
        dp.CHECKPOINT_EVERY_SEC = 0.0  # a checkpoint after every frame, so a kill at frame k resumes at k

    def tearDown(self):
        g1_scan.ocr, self.dp.ocr_crops, self.dp.CHECKPOINT_EVERY_SEC = self.saved
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_pass(self, out, plans, settings, kill_at=None, lines=None):
        fake = FakeFfmpeg(plans, size=self.FW * self.FH * 3, div=2)
        lines = [] if lines is None else lines

        def line(done, total, note=None):
            lines.append((done, total, note))
            if kill_at is not None and done >= kill_at:
                raise Killed()
        self.dp.PROGRESS_EVERY_SEC, saved = 0.0, self.dp.PROGRESS_EVERY_SEC
        try:
            summ = self.dp.run_pass(self.rec, out, settings, self.pack, ["Zorbo~QX"], self.layout, progress=None,
                                    progress_line=line, total_frames=self.FRAMES,
                                    reader_opts={"popen": fake, "gpu_ok": lambda: False, "stall_sec": 5,
                                                 "first_sec": 5, "poll_sec": 0.05})
        finally:
            self.dp.PROGRESS_EVERY_SEC = saved
        return summ, fake

    def results(self, out):
        with open(os.path.join(out, self.dp.HITS), encoding="utf-8") as f:
            hits = f.read()
        with open(os.path.join(out, "match-stats.json"), encoding="utf-8") as f:
            stats = json.load(f)
        return hits, stats

    def check_resume(self, regions, torn=False):
        settings = dict(self.settings, ocrRegions=regions)
        full = os.path.join(self.dir, f"full-{regions}")
        whole, _ = self.run_pass(full, [(self.FRAMES, 0, 0, 0)], settings)
        cut = os.path.join(self.dir, f"cut-{regions}")
        with self.assertRaises(Killed):
            self.run_pass(cut, [(self.FRAMES, 0, 0, 0)], settings, kill_at=6)
        self.assertTrue(os.path.exists(os.path.join(cut, self.dp.CHECKPOINT)))
        with open(os.path.join(cut, self.dp.CHECKPOINT + ".rows"), "rb") as f:
            self.assertEqual(len(f.read().splitlines()), 6, "each save appends one line; nothing is rewritten")
        if torn:
            with open(os.path.join(cut, self.dp.CHECKPOINT + ".rows"), "ab") as f:
                f.write(b'{"rows": [{"cut short')  # a save killed after part of its rows line: not committed
        lines = []
        summ, fake = self.run_pass(cut, [(self.FRAMES - 6, 0, 0, 0)], settings, lines=lines)  # the recording's rest
        self.assertEqual(fake.argvs[0][fake.argvs[0].index("-ss") + 1], "6.000", "ffmpeg starts at the next frame")
        self.assertEqual(lines[0][0], 6, "progress starts at the resumed count")
        self.assertIn("going on from 0:06", lines[0][2])
        self.assertEqual(summ["resumedAtFrame"], 6)
        self.assertEqual(self.results(cut), self.results(full))
        for k in ("frames", "ocrFrames", "diffGateSkips", "hits", "signalHits", "perDetector", "matchStats"):
            self.assertEqual(summ[k], whole[k], k)
        self.assertFalse(os.path.exists(os.path.join(cut, self.dp.CHECKPOINT)), "deleted when complete")
        self.assertGreater(whole["hits"], 0)

    def test_resume_gives_the_same_result_full_frame(self):
        self.check_resume("full")

    def test_resume_gives_the_same_result_rois(self):
        self.check_resume("rois")

    def test_a_save_cut_short_is_ignored_on_resume(self):
        self.check_resume("rois", torn=True)

    def test_an_edited_pack_starts_fresh(self):
        # review 2026-11-18: a rule or ROI edited in place keeps the pack version; the key hashes the content
        def edit(_):
            self.pack["detectors"][0]["note"] = "edited in place"
        self.cut_then(edit)

    def cut_then(self, change):
        out = os.path.join(self.dir, "cut")
        with self.assertRaises(Killed):
            self.run_pass(out, [(self.FRAMES, 0, 0, 0)], self.settings, kill_at=5)
        change(os.path.join(out, self.dp.CHECKPOINT))
        lines = []
        summ, fake = self.run_pass(out, [(self.FRAMES, 0, 0, 0)], self.settings, lines=lines)
        self.assertNotIn("-ss", fake.argvs[0], "a fresh scan from the start")
        self.assertNotIn("resumedAtFrame", summ)
        self.assertEqual(summ["frames"], self.FRAMES)
        self.assertFalse(os.path.exists(os.path.join(out, self.dp.CHECKPOINT)))

    def test_a_changed_recording_starts_fresh(self):
        def touch(_):
            t = time.time() + 120
            os.utime(self.rec, (t, t))
        self.cut_then(touch)

    def test_other_settings_start_fresh(self):
        self.settings = dict(self.settings)

        def other(_):
            self.settings["diffGate"] = float(self.settings["diffGate"]) + 0.1
        self.cut_then(other)

    def test_a_corrupt_checkpoint_starts_fresh(self):
        def garble(path):
            with open(path, "r+b") as f:
                f.seek(10)
                f.write(b"garbage" * 20)
        self.cut_then(garble)

    def test_rows_not_written_with_the_checkpoint_start_fresh(self):
        # review round 2: the npz holds the SHA-256 of the rows it commits; other rows of the same length are not used
        def swap(path):
            with open(path + ".rows", "r+b") as f:
                data = f.read()
                f.seek(0)
                swapped = data.replace(b'"t": 3.0', b'"t": 9.0', 1)
                self.assertNotEqual(swapped, data)
                f.write(swapped)  # still valid JSON lines of the same length and counts
        self.cut_then(swap)

    def test_one_pass_per_output_folder(self):
        out = os.path.join(self.dir, "locked")
        with self.dp.OutputLock(out):
            with self.assertRaises(cc.ClipError) as e:
                self.run_pass(out, [(self.FRAMES, 0, 0, 0)], self.settings)
        self.assertIn("Another clip job", str(e.exception))
        summ, _ = self.run_pass(out, [(self.FRAMES, 0, 0, 0)], self.settings)  # free again
        self.assertEqual(summ["frames"], self.FRAMES)

    def test_a_watchdog_failure_keeps_the_checkpoint(self):
        self.dp.CHECKPOINT_EVERY_SEC = 3600.0  # only the failure itself saves
        out = os.path.join(self.dir, "wd")
        fake = FakeFfmpeg([(4, 0, 60, 0)] + [(0, 0, 60, 0)] * 3, size=self.FW * self.FH * 3, div=2)
        with self.assertRaises(cc.ClipError):
            self.dp.run_pass(self.rec, out, self.settings, self.pack, [], self.layout, progress=None,
                             reader_opts={"popen": fake, "gpu_ok": lambda: False, "stall_sec": 0.4, "first_sec": 0.4,
                                          "poll_sec": 0.05, "max_restarts": 1})
        got = self.dp.Checkpoint(os.path.join(out, self.dp.CHECKPOINT),
                                 self.dp.checkpoint_key(self.rec, [0, 0, self.FW, self.FH], self.settings, self.pack,
                                                        [], self.layout, None, None)).load()
        self.assertIsNotNone(got)
        self.assertEqual(got[:2], (4, 3.0), "4 frames read, the last at 3.0 s")


if __name__ == "__main__":
    unittest.main()
