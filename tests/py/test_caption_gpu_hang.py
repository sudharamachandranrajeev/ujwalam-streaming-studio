# SPDX-License-Identifier: GPL-3.0-or-later
"""Caption GPU hang (installed alpha.49, 2026-11-27): a review job froze when clip L02 tried the GPU caption model again
after it had failed for clip L01, and the native call hung. Fakes only (no model, no GPU):
  sticky     once the GPU model failed in a process, later clips use the CPU model directly (GPU tried once);
  hang       a child that never finishes is killed after its limit; the clip gets no captions and the job goes on;
  error      the log line carries the error's text (first line, cut), not only its type name."""

import io
import json
import os
import sys
import tempfile
import time
import types
import unittest
import wave
from contextlib import redirect_stderr
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_captions as caps  # noqa: E402
import reel_captions as rcap  # noqa: E402

GPU = {"whisper_model": "m/turbo", "device": "cuda", "compute_type": "int8_float16",
       "fallback": {"whisper_model": "m/small", "device": "cpu", "compute_type": "int8"}}


class Seg:
    start, end, text, avg_logprob, no_speech_prob, words = 0.0, 1.0, " hi", 0.0, 0.0, None


def fake_module(calls, gpu_error):
    class Model:
        def __init__(self, model, device, **kw):
            calls.append((os.path.basename(model), device))
            self.device = device

        def transcribe(self, wav, **kw):
            if self.device == "cuda":
                raise gpu_error
            return iter([Seg()]), types.SimpleNamespace(language="en")
    m = types.ModuleType("faster_whisper")
    m.WhisperModel = Model
    return m


def write_wav(path, sec):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * int(16000 * sec))


class StickyFallback(unittest.TestCase):
    def setUp(self):
        caps.reset_gpu_failure()

    def tearDown(self):
        caps.reset_gpu_failure()

    def test_gpu_tried_once_then_cpu_for_every_later_clip(self):
        calls = []
        err = RuntimeError("CUDA failed with error out of memory\nsecond line of detail")
        buf = io.StringIO()
        with patch.dict(sys.modules, {"faster_whisper": fake_module(calls, err)}), redirect_stderr(buf):
            for _ in range(3):  # L01, L02, L03
                segs, info = caps.transcribe("faster-whisper", "a.wav", dict(GPU))
                self.assertEqual((info["status"], info["device"], len(segs)), ("ok", "cpu", 1))
        self.assertEqual(calls, [("turbo", "cuda"), ("small", "cpu"), ("small", "cpu"), ("small", "cpu")])
        log = buf.getvalue()
        self.assertEqual(log.count("on the GPU failed"), 1, "logged once, when it failed")
        self.assertIn("RuntimeError: CUDA failed with error out of memory", log, "the error text, not just its type")
        self.assertNotIn("second line", log, "first line only")

    def test_error_line_is_cut(self):
        self.assertEqual(caps.error_line(RuntimeError("x" * 500))[-3:], "...")
        self.assertLessEqual(len(caps.error_line(RuntimeError("x" * 500))), 160)
        self.assertEqual(caps.error_line(RuntimeError()), "")

    def test_without_a_fallback_the_error_is_raised_and_not_remembered(self):
        calls = []
        with patch.dict(sys.modules, {"faster_whisper": fake_module(calls, RuntimeError("boom"))}):
            with self.assertRaises(RuntimeError):
                caps.transcribe("faster-whisper", "a.wav", dict(GPU, fallback=None))
        self.assertEqual(caps._GPU_FAILED, [])


class HungChild(unittest.TestCase):
    def setUp(self):
        caps.reset_gpu_failure()
        self.tmp = tempfile.mkdtemp(prefix="caphang-")
        self.wav = os.path.join(self.tmp, "reel.wav")
        write_wav(self.wav, 1.0)
        self.pidfile = os.path.join(self.tmp, "pids.txt")

    def tearDown(self):
        caps.reset_gpu_failure()
        import shutil  # noqa: PLC0415
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _hang_argv(self, req_path):
        code = (f"import os, time; open({self.pidfile!r}, 'a').write(str(os.getpid()) + '\\n'); time.sleep(120)")
        return [sys.executable, "-I", "-c", code]

    @staticmethod
    def _alive(pid):
        if os.name == "nt":
            import ctypes  # noqa: PLC0415
            k = ctypes.WinDLL("kernel32")
            h = k.OpenProcess(0x1000 | 0x00100000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
            if not h:
                return False
            try:
                return k.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT: still running
            finally:
                k.CloseHandle(h)
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def test_a_hung_child_is_killed_and_the_job_goes_on(self):
        iso = {"setupSec": 1.5, "perAudioSec": 0.5}  # 1.5 + 0.5 x 1 s of audio = 2 s
        self.assertAlmostEqual(caps.child_limit(iso, self.wav), 2.0, places=2)
        buf = io.StringIO()
        t0 = time.monotonic()
        with patch.object(caps, "_child_argv", self._hang_argv), patch("importlib.util.find_spec", return_value=True), \
                redirect_stderr(buf):
            segs, info = caps.transcribe("faster-whisper", self.wav, dict(GPU, isolate=iso))  # L01: GPU, then CPU
            segs2, info2 = caps.transcribe("faster-whisper", self.wav, dict(GPU, isolate=iso))  # L02: CPU only
        took = time.monotonic() - t0
        self.assertEqual((segs, info["status"]), ([], "unavailable"))
        self.assertIn("stopped after 2 s", info["reason"])
        self.assertEqual((segs2, info2["status"]), ([], "unavailable"))
        self.assertLess(took, 30, "three children of 2 s each, not 120 s sleeps")
        with open(self.pidfile, encoding="utf-8") as f:
            pids = [int(x) for x in f.read().split()]
        self.assertEqual(len(pids), 3, "GPU once, CPU for L01 and L02; the GPU is not tried again")
        self.assertFalse([p for p in pids if self._alive(p)], "every hung child was killed")
        log = buf.getvalue()
        self.assertIn("on the GPU failed (CaptionTimeout: speech to text did not finish in 2 s)", log)
        self.assertEqual(log.count("this clip has no captions, the job goes on"), 2)

    def test_a_child_result_comes_back_as_before(self):
        # the child writes the result file the real child would write; the parent reads it unchanged
        def ok_argv(req_path):
            code = ("import json, sys; r = json.load(open(sys.argv[1], encoding='utf-8')); "
                    "json.dump({'segments': [{'start': 0.0, 'end': 1.0, 'text': 'hi', 'confidence': 1.0}], "
                    "'language': 'en'}, open(r['out'], 'w', encoding='utf-8'))")
            return [sys.executable, "-I", "-c", code, req_path]
        with patch.object(caps, "_child_argv", ok_argv), patch("importlib.util.find_spec", return_value=True):
            segs, info = caps.transcribe("faster-whisper", self.wav, dict(GPU, isolate={"setupSec": 60}))
        self.assertEqual(segs, [{"start": 0.0, "end": 1.0, "text": "hi", "confidence": 1.0}])
        self.assertEqual((info["status"], info["device"], info["model"], info["language"]), ("ok", "cuda", "turbo", "en"))

    def test_a_failing_child_reports_its_error_text(self):
        def bad_argv(req_path):
            code = ("import json, sys; r = json.load(open(sys.argv[1], encoding='utf-8')); "
                    "json.dump({'error': 'RuntimeError: cuDNN failed to initialize'}, open(r['out'], 'w')); sys.exit(1)")
            return [sys.executable, "-I", "-c", code, req_path]
        buf = io.StringIO()
        seen = []

        def argv(req_path):
            with open(req_path, encoding="utf-8") as f:
                seen.append(json.load(f)["opts"]["device"])
            return bad_argv(req_path) if seen[-1] == "cuda" else self._ok(req_path)
        with patch.object(caps, "_child_argv", argv), patch("importlib.util.find_spec", return_value=True), \
                redirect_stderr(buf):
            segs, info = caps.transcribe("faster-whisper", self.wav, dict(GPU, isolate={"setupSec": 60}))
        self.assertEqual(seen, ["cuda", "cpu"])
        self.assertEqual((info["status"], info["device"]), ("ok", "cpu"))
        self.assertIn("on the GPU failed (RuntimeError: cuDNN failed to initialize)", buf.getvalue())

    @staticmethod
    def _ok(req_path):
        code = ("import json, sys; r = json.load(open(sys.argv[1], encoding='utf-8')); "
                "json.dump({'segments': [], 'language': None}, open(r['out'], 'w'))")
        return [sys.executable, "-I", "-c", code, req_path]

    def test_the_data_file_turns_isolation_on(self):
        cfg = rcap.load_config()
        self.assertGreater(cfg["isolate"]["setupSec"], 0)
        self.assertGreater(cfg["isolate"]["perAudioSec"], 0)


if __name__ == "__main__":
    unittest.main()
