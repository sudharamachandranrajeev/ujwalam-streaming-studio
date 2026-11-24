# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T6: excitement score (services/clip/excitement.py). Baseline/rise math, loudness and pitch features on generated
tones, phrase matching (shared samples with the live side), combine, events into the clip ranking, model missing or
failing = graceful, flag off = ranking unchanged. Generated signals and invented lines only, no user media. The real
model smoke runs only when the pinned model file is in UJWALAM_T6_MODEL_DIR (off air, CPU)."""

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import numpy as np  # noqa: E402

import clip_rank as rank  # noqa: E402
import excitement as exc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "fixtures", "voice-phrases.json"), encoding="utf-8") as _f:
    SAMPLES = json.load(_f)["samples"]
CFG = exc.load_config()
SR = 16000


def tone(hz, db, sec=1.0):
    t = np.arange(int(SR * sec)) / SR
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * hz * t)).astype(np.float32)


class Config(unittest.TestCase):
    def test_unverified_and_weights(self):
        self.assertEqual(CFG["status"], "unverified")
        self.assertIsNone(CFG["approvedBy"])
        for k in ("weights", "rank", "live"):
            self.assertEqual(CFG[k]["status"], "unverified")
        self.assertEqual(set(exc.PARTS) <= set(CFG["weights"]), True)

    def test_class_indexes_match_class_map(self):
        # indexes from yamnet_class_map.csv at the pinned revision (evidence); spot-check the ranges
        for idx in sum(CFG["events"]["classes"].values(), []):
            self.assertTrue(0 <= idx < 521)


class Phrases(unittest.TestCase):
    def test_shared_samples(self):
        c = exc.compile_phrases(CFG)
        for s in SAMPLES:
            self.assertEqual(exc.match_phrases(s["text"], c), s["want"], s["text"])

    def test_segments_to_seconds_with_word_times(self):
        c = exc.compile_phrases(CFG)
        segs = [{"start": 10.2, "end": 14.0, "text": "ok ok adipoli", "words": [{"start": 10.2, "word": "ok"}, {"start": 12.7, "word": "adipoli"}]},
                {"start": 20.0, "end": 21.0, "text": "nothing"}, {"start": 30.4, "end": 31.0, "text": "സൂപ്പർ"}]
        hits, n = exc.phrase_seconds(segs, 60, c)
        self.assertEqual(hits, {12: ["adipoli"], 30: ["super"]})
        self.assertEqual(n, 2)


class Rise(unittest.TestCase):
    def test_learning_then_rise(self):
        vals = [-30.0, -31.0, -29.0] * 10 + [-10.0]
        out = exc.rolling_rise(vals, -50, 600, 20, 1.5, 4.0)
        self.assertTrue(all(v == 0.0 for v in out[:20]))  # still learning
        self.assertLess(max(out[20:30]), 0.25)  # normal wobble is far from a rise
        self.assertEqual(out[30], 1.0)

    def test_silence_not_in_baseline_and_baseline_rolls(self):
        vals = [None, -80.0] * 50 + [-30.0] * 25 + [-30.0]
        out = exc.rolling_rise(vals, -50, 600, 20, 1.5, 4.0)
        self.assertEqual(out[-1], 0.0)
        # a short baseline window forgets: a speaker who got louder for good is not "rising" forever
        vals = [-30.0] * 30 + [-15.0] * 40
        out = exc.rolling_rise(vals, -50, 20, 10, 1.5, 4.0)
        self.assertEqual(out[30], 1.0)
        self.assertEqual(out[-1], 0.0)

    def test_features_on_tones(self):
        db, hz = exc.frame_features(tone(150, -20), SR, 75, 500, -50)
        self.assertAlmostEqual(db, -20, delta=0.5)
        self.assertAlmostEqual(hz, 150, delta=5)
        db, hz = exc.frame_features(tone(300, -20), SR, 75, 500, -50)
        self.assertAlmostEqual(hz, 300, delta=10)
        self.assertEqual(exc.frame_features(tone(150, -70), SR, 75, 500, -50), (None, None))

    def test_voice_parts_louder_and_higher(self):
        secs = [tone(140, -30)] * 30 + [tone(280, -12)]
        lr, pr, st = exc.voice_parts(lambda i: secs[i], len(secs), CFG["voice"])
        self.assertEqual(st["voicedSec"], 31)
        self.assertEqual(lr[-1], 1.0)
        self.assertEqual(pr[-1], 1.0)
        self.assertEqual(lr[25], 0.0)


class Combine(unittest.TestCase):
    def test_missing_parts_left_out(self):
        w = {"loudRise": 0.5, "pitchRise": 0.0, "phrase": 0.5, "event": 0.2, "chat": 0.1}
        s = exc.combine({"loudRise": [1.0, 0.0], "phrase": [0.0, 1.0], "event": None, "chat": None, "pitchRise": [1, 1]}, w, 2)
        self.assertEqual(s, [0.5, 0.5])
        self.assertEqual(exc.combine({k: None for k in exc.PARTS}, w, 3), [0.0, 0.0, 0.0])

    def test_chat_part(self):
        self.assertIsNone(exc.chat_part(None, CFG["chat"]))
        p = exc.chat_part([0] * 100 + [5] * 5, CFG["chat"])
        self.assertEqual(p[50], 0.0)
        self.assertEqual(p[-1], 1.0)

    def test_event_part(self):
        self.assertEqual(exc.event_part({"laughter": [0.1, 0.6], "shout": [0.25, 0.0]}, 2, 0.5), [0.5, 1.0])


class Ranking(unittest.TestCase):
    def _cfg(self):
        with open(os.path.join(HERE, "..", "..", "data", "clip", "ranking.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_events_and_order_follow_the_score(self):
        score = [0.0] * 600
        score[100], score[400] = 0.6, 0.95
        ev = exc.excitement_events(score, {}, CFG["rank"])
        self.assertEqual([e["t"] for e in ev], [100.5, 400.5])
        # ranking.json minScore (3) keeps excitement-only windows out; the order is checked with it at 0
        self.assertEqual(rank.build_candidates(ev, 600, self._cfg()), [])
        cands = rank.build_candidates(ev, 600, dict(self._cfg(), minScore=0))
        self.assertEqual(len(cands), 2)
        self.assertEqual(cands[0]["anchor"], 400.5)  # the more excited moment ranks first
        exc.attach_scores(cands, score)
        self.assertEqual(cands[0]["excitement"], 0.95)

    def test_phrase_events_gap(self):
        ev = exc.excitement_events([0.0] * 100, {10: ["super"], 20: ["scene"], 50: ["adipoli"]}, CFG["rank"])
        self.assertEqual([(e["kind"], e["t"]) for e in ev], [("voice.phrase", 10.5), ("voice.phrase", 50.5)])
        # a marker phrase alone still makes a candidate (strong signal, like a marker), minScore notwithstanding
        cands = rank.build_candidates(ev, 100, self._cfg())
        self.assertEqual(len(cands), 2)

    def test_excitement_adds_to_a_moment_and_reorders(self):
        cfg = self._cfg()
        base = [{"t": 100.0, "kind": "marker.hotkey", "w": 1.0, "strength": 1.0, "detail": {}, "win": "marker"},
                {"t": 400.0, "kind": "marker.hotkey", "w": 1.0, "strength": 1.0, "detail": {}, "win": "marker"}]
        before = rank.build_candidates(base, 600, cfg)
        self.assertEqual(before[0]["anchor"], 100.0)  # tie: earlier first
        score = [0.0] * 600
        score[399] = 0.9
        after = rank.build_candidates(base + exc.excitement_events(score, {}, CFG["rank"]), 600, cfg)
        self.assertEqual(after[0]["anchor"], 400.0)

    def test_moment_score(self):
        self.assertEqual(exc.moment_score([0.1, 0.9, 0.2], 0, 1), 0.1)
        self.assertEqual(exc.moment_score([0.1, 0.9, 0.2], 0.5, 2.2), 0.9)
        self.assertEqual(exc.moment_score([], 0, 5), 0.0)


class Analyse(unittest.TestCase):
    def setUp(self):
        self.wd = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.wd, ignore_errors=True)

    def _fake_ffmpeg(self, wave):
        def run_tool(argv, timeout=None):
            (np.clip(wave, -1, 1) * 32767).astype("<i2").tofile(argv[-1])
            return type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        return run_tool

    def test_no_model_is_graceful_and_wave_removed(self):
        wave = np.concatenate([tone(140, -30)] * 30 + [tone(280, -10)] * 2)
        score, hits, st = exc.analyse("rec.mkv", 32, ffmpeg="ffmpeg", run_tool=self._fake_ffmpeg(wave), wd=self.wd,
                                      models_dir=os.path.join(self.wd, "none"), chat_counts=None, transcript=None, cfg=CFG)
        self.assertEqual(st["parts"]["event"], "model not downloaded")
        self.assertEqual(st["used"], ["loudRise", "pitchRise"])
        self.assertGreater(score[30], 0.9)
        self.assertFalse(os.path.exists(os.path.join(self.wd, "excitement.s16")))

    def test_model_load_failure_and_decode_failure(self):
        def boom(_p):
            raise RuntimeError("bad model")
        with patch.object(exc, "pinned_file", return_value=("x.onnx", "sha")):
            _, _, st = exc.analyse("r", 5, ffmpeg="f", run_tool=self._fake_ffmpeg(np.zeros(SR * 5)), wd=self.wd,
                                   models_dir=self.wd, cfg=CFG, events_factory=boom)
        self.assertEqual(st["parts"]["event"], "model load failed: RuntimeError")
        fail = lambda argv, timeout=None: type("R", (), {"returncode": 1})()  # noqa: E731
        score, _, st = exc.analyse("r", 5, ffmpeg="f", run_tool=fail, wd=self.wd, models_dir=self.wd, cfg=CFG,
                                   transcript=[{"start": 2.0, "end": 3.0, "text": "pwolich"}])
        self.assertEqual(st["used"], ["phrase"])
        self.assertEqual(score[2], 1.0)

    def test_fake_model_session(self):
        class Sess:
            def get_inputs(self):
                return [type("I", (), {"name": "waveform"})()]

            def run(self, _o, feed):
                n = int(feed["waveform"].size / SR / 0.48)
                s = np.zeros((n, 521), dtype=np.float32)
                s[4:6, 13] = 0.9  # laughter around second 2
                return [s]
        with patch.object(exc, "pinned_file", return_value=("x.onnx", "sha")):
            score, _, st = exc.analyse("r", 10, ffmpeg="f", run_tool=self._fake_ffmpeg(np.zeros(SR * 10)), wd=self.wd,
                                       models_dir=self.wd, cfg=CFG, events_factory=lambda p: Sess())
        self.assertIn("event", st["used"])
        self.assertEqual(st["parts"]["event"]["secondsOver"], 1)  # frames 4 and 5 both centre in second 2
        self.assertGreater(max(score), 0)

    def test_pinned_file_checks(self):
        md = os.path.join(self.wd, "models", "audio-events")
        os.makedirs(md)
        self.assertEqual(exc.pinned_file(os.path.join(self.wd, "models"), CFG), (None, "model not downloaded"))
        with open(os.path.join(md, "yamnet.onnx"), "wb") as f:
            f.write(b"x" * 10)
        self.assertEqual(exc.pinned_file(os.path.join(self.wd, "models"), CFG)[1], "model size differs")


class ClipperWiring(unittest.TestCase):
    def test_flag_off_means_no_excitement(self):
        import clipper  # noqa: PLC0415
        a = type("A", (), {"data_dir": None, "no_audio": False, "recording": "r", "out": tempfile.gettempdir(), "transcript": None})()
        with patch.object(clipper, "flag_on", return_value=False), patch.object(exc, "analyse") as an:
            x, st = clipper._excitement(a, "ffmpeg", 10, {"has_audio": True}, None)
        self.assertIsNone(x)
        self.assertEqual(st["reason"], "flag off")
        an.assert_not_called()

    def test_failure_never_breaks_the_run(self):
        import clipper  # noqa: PLC0415
        a = type("A", (), {"data_dir": None, "no_audio": False, "recording": "r", "out": tempfile.gettempdir(), "transcript": None})()
        with patch.object(clipper, "flag_on", return_value=True), patch.object(exc, "analyse", side_effect=RuntimeError("x")):
            x, st = clipper._excitement(a, "ffmpeg", 10, {"has_audio": True}, None)
        self.assertIsNone(x)
        self.assertEqual(st["reason"], "failed: RuntimeError")

    def test_no_stream_or_host_calls(self):
        with open(exc.__file__, encoding="utf-8") as f:
            src = f.read()
        for bad in ("urllib", "http", "socket", "marker.add", "replay.save", "HostLink"):
            self.assertNotIn(bad, src)


@unittest.skipUnless(os.environ.get("UJWALAM_T6_MODEL_DIR"), "real model smoke: set UJWALAM_T6_MODEL_DIR")
class RealModelSmoke(unittest.TestCase):
    def test_cpu_inference_timing(self):
        md = os.environ["UJWALAM_T6_MODEL_DIR"]
        path, sha = exc.pinned_file(md, CFG)
        self.assertIsNotNone(path, sha)
        ae = exc.AudioEvents(CFG, path)
        t0 = time.perf_counter()
        self.assertTrue(ae.load(), ae.reason)
        load = time.perf_counter() - t0
        rng = np.random.default_rng(1)
        wave = np.concatenate([tone(220, -25, 30), (rng.standard_normal(SR * 30) * 0.05).astype(np.float32)])
        t0 = time.perf_counter()
        probs = ae.second_probs(wave, SR)
        run = time.perf_counter() - t0
        print(f"\nyamnet cpu: load {load:.2f}s, 60s audio {run:.2f}s, max laughter {max(probs['laughter']):.3f} "
              f"shout {max(probs['shout']):.3f}")
        self.assertEqual(len(probs["laughter"]), 60)
        self.assertLess(run, 30)


if __name__ == "__main__":
    unittest.main()
