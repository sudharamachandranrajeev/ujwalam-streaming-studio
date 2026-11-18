# SPDX-License-Identifier: GPL-3.0-or-later
"""MU1 scene music moods (services/clip/scene_music.py): the mood manifests and their schema, determinism (same seed =
same bytes), the loop seam (no click), the loudness target per mood (measured again from the written WAV), the WAV
format, and the CLI (refuses while live or when it cannot tell, never writes into the repo). Clips are 2 bars, a few
seconds. Needs numpy (the project venv); skipped without it."""

import copy
import hashlib
import json
import math
import os
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:
    import numpy as np
except ImportError:  # a bare interpreter
    np = None

import clip_common as cc  # noqa: E402

if np is not None:
    import scene_music as sm  # noqa: E402

MOODS = ("starting-soon", "lobby", "in-match", "brb", "ending")
BARS = 2


def read_wav(path):
    with wave.open(path, "rb") as w:
        info = (w.getnchannels(), w.getsampwidth(), w.getframerate())
        raw = w.readframes(w.getnframes())
    return info, np.frombuffer(raw, dtype="<i2").reshape(-1, 2)


@unittest.skipIf(np is None, "numpy not available")
class Manifests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.moods = sm.load_moods()
        cls.schema = cc.load_json(sm.SCHEMA_FILE)

    def test_the_five_moods_exist_and_validate(self):
        self.assertEqual(sorted(self.moods), sorted(MOODS))
        for m in self.moods.values():
            sm.validate_manifest(m, self.schema)

    def test_file_name_must_equal_id(self):
        with tempfile.TemporaryDirectory() as d:
            m = copy.deepcopy(self.moods["lobby"])
            with open(os.path.join(d, "other.json"), "w", encoding="utf-8") as f:
                json.dump(m, f)
            with self.assertRaises(cc.ClipError):
                sm.load_moods(d)

    def test_bad_manifests_are_refused(self):
        base = self.moods["lobby"]
        cases = []
        m = copy.deepcopy(base); del m["loudness"]; cases.append(("missing loudness", m))
        m = copy.deepcopy(base); m["surprise"] = 1; cases.append(("unknown property", m))
        m = copy.deepcopy(base); m["loudness"]["targetLufs"] = 3; cases.append(("target above range", m))
        m = copy.deepcopy(base); m["tempo"]["minBpm"] = 30; cases.append(("tempo below range", m))
        m = copy.deepcopy(base); m["tempo"] = {"minBpm": 90, "maxBpm": 80}; cases.append(("min above max", m))
        m = copy.deepcopy(base); m["drums"] = "polka"; cases.append(("unknown drum pattern", m))
        m = copy.deepcopy(base); m["instruments"]["theremin"] = {"level": 0.5}; cases.append(("unknown instrument", m))
        m = copy.deepcopy(base); m["progressions"][0]["chords"][0]["type"] = "nope"; cases.append(("undefined chord", m))
        m = copy.deepcopy(base); m["version"] = "one"; cases.append(("bad version", m))
        m = copy.deepcopy(self.moods["in-match"]); m["instruments"]["kick"] = {"level": 0.5}; cases.append(("kick with no drums", m))
        for name, bad in cases:
            with self.subTest(name):
                with self.assertRaises(cc.ClipError):
                    sm.validate_manifest(bad, self.schema)

    def test_in_match_is_the_quietest(self):
        t = {k: m["loudness"]["targetLufs"] for k, m in self.moods.items()}
        for k in MOODS:
            if k != "in-match":
                self.assertGreaterEqual(t[k] - t["in-match"], 3.0, k)


@unittest.skipIf(np is None, "numpy not available")
class Meter(unittest.TestCase):
    def test_sine_reads_its_known_loudness(self):
        t = np.arange(sm.SR * 3) / sm.SR
        x = 0.1 * np.sin(2 * math.pi * 1000.0 * t)
        # BS.1770: a 1 kHz sine at -20 dBFS peak on both channels reads about -20 LUFS (K-weighting is near +0.7 dB there).
        self.assertAlmostEqual(sm.measure_lufs(np.stack([x, x], axis=1)), -20.0, delta=0.3)

    def test_gain_moves_loudness_one_to_one(self):
        t = np.arange(sm.SR * 2) / sm.SR
        x = np.stack([0.1 * np.sin(2 * math.pi * 440.0 * t)] * 2, axis=1)
        self.assertAlmostEqual(sm.measure_lufs(x * 0.5) - sm.measure_lufs(x), -6.02, delta=0.02)

    def test_silence_is_the_floor(self):
        self.assertEqual(sm.measure_lufs(np.zeros((sm.SR, 2))), -70.0)

    def test_seam_check_sees_a_click(self):
        t = np.arange(4800)
        smooth = np.rint(8000 * np.sin(2 * math.pi * t / 4800)).astype("<i2")  # one whole period: a perfect loop
        good = np.stack([smooth, smooth], axis=1)
        self.assertLess(sm.seam_stats(good)["seamRatio"], 1.0)
        bad = np.stack([smooth + 6000, smooth + 6000], axis=1)
        bad[-1] = [-6000, -6000]  # the end jumps away from the start
        self.assertGreater(sm.seam_stats(bad)["seamRatio"], 1.0)


@unittest.skipIf(np is None, "numpy not available")
class Beds(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.moods = sm.load_moods()
        cls.dir = tempfile.TemporaryDirectory()
        cls.recs, cls.files = {}, {}
        for i in MOODS:
            p = os.path.join(cls.dir.name, i + ".wav")
            cls.recs[i] = sm.generate(cls.moods[i], 7, p, bars=BARS)
            cls.files[i] = p

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def test_same_seed_same_bytes(self):
        p = os.path.join(self.dir.name, "again.wav")
        again = sm.generate(self.moods["lobby"], 7, p, bars=BARS)
        self.assertEqual(again["sha256"], self.recs["lobby"]["sha256"])
        with open(p, "rb") as f, open(self.files["lobby"], "rb") as g:
            self.assertEqual(f.read(), g.read())

    def test_other_seed_other_bed(self):
        p = os.path.join(self.dir.name, "other.wav")
        other = sm.generate(self.moods["starting-soon"], 8, p, bars=BARS)
        self.assertNotEqual(other["sha256"], self.recs["starting-soon"]["sha256"])

    def test_format_is_48k_stereo_16_bit(self):
        for i in MOODS:
            info, pcm = read_wav(self.files[i])
            self.assertEqual(info, (2, 2, 48000), i)
            self.assertGreater(len(pcm) / 48000, 3.0, i)
            self.assertAlmostEqual(self.recs[i]["durationSec"], len(pcm) / 48000, places=3)

    def test_loop_seam_has_no_click(self):
        for i in MOODS:
            _, pcm = read_wav(self.files[i])
            s = sm.seam_stats(pcm)
            # the step from the last sample to the first is no bigger than the 99.9th percentile of every other step
            self.assertLessEqual(s["seamRatio"], 1.0, f"{i}: {s}")
            self.assertEqual(s, {k: self.recs[i][k] for k in s}, i)

    def test_tails_wrap_so_the_start_is_not_cold(self):
        # the bed is a ring: a note that runs past the end is heard again at the start, never cut
        for i in ("lobby", "ending"):
            _, pcm = read_wav(self.files[i])
            self.assertGreater(int(np.abs(pcm[:2400].astype(int)).max()), 0, i)
            self.assertGreater(int(np.abs(pcm[-2400:].astype(int)).max()), 0, i)

    def test_loudness_target_per_mood(self):
        for i in MOODS:
            _, pcm = read_wav(self.files[i])
            got = sm.measure_lufs(pcm.astype(float) / 32768.0)  # measured again from the file
            ld = self.moods[i]["loudness"]
            self.assertAlmostEqual(got, ld["targetLufs"], delta=ld["toleranceLu"], msg=i)
            self.assertAlmostEqual(got, self.recs[i]["lufs"], delta=0.01, msg=i)
            self.assertLessEqual(self.recs[i]["peakDb"], ld["peakCeilingDb"] + 0.01, i)

    def test_in_match_is_quieter_than_the_rest_as_written(self):
        for i in MOODS:
            if i != "in-match":
                self.assertLess(self.recs["in-match"]["lufs"], self.recs[i]["lufs"] - 3.0, i)

    def test_full_duration_bar_count(self):
        # no bars override: the length follows the duration, rounded to whole bars
        x, info = sm.render(self.moods["ending"], 3, duration=8)
        bar_sec = 240.0 / info["bpm"]
        self.assertLessEqual(abs(len(x) / 48000 - 8), bar_sec / 2 + 0.01)
        self.assertEqual(len(x) % (info["bars"]), 0)


@unittest.skipIf(np is None, "numpy not available")
class Cli(unittest.TestCase):
    def run_cli(self, out, live, extra=()):
        log = []
        code = sm.main(["--out", out, "--duration", "3", *extra], live_check=lambda: live, log=log.append)
        return code, log

    def test_refuses_while_live(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "lib")
            code, log = self.run_cli(out, ("live", "LIVE (youtube-h)"), ["--mood", "lobby"])
            self.assertEqual(code, sm.EXIT_REFUSED)
            self.assertIn("refused", log[0])
            self.assertFalse(os.path.exists(out))

    def test_refuses_when_it_cannot_tell(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "lib")
            code, _ = self.run_cli(out, ("unknown", "no host log"), ["--mood", "lobby"])
            self.assertEqual(code, sm.EXIT_REFUSED)
            self.assertFalse(os.path.exists(out))

    def test_refuses_to_write_into_the_repo(self):
        out = os.path.join(cc.REPO_ROOT, "tmp-scene-music-should-not-exist")
        code, log = self.run_cli(out, ("off", "off air"), ["--mood", "lobby"])
        self.assertEqual(code, 1)
        self.assertIn("outside the repo", log[0])
        self.assertFalse(os.path.exists(out))

    def test_unknown_mood_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            code, log = self.run_cli(os.path.join(d, "lib"), ("off", "off air"), ["--mood", "polka"])
            self.assertEqual(code, 1)
            self.assertIn("unknown mood", log[-1])

    def test_off_air_writes_the_library_and_index(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "lib")
            code, _ = self.run_cli(out, ("off", "off air"), ["--mood", "lobby", "--mood", "in-match", "--seed", "4"])
            self.assertEqual(code, 0)
            with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
                idx = json.load(f)
            self.assertEqual([r["mood"] for r in idx["files"]], ["lobby", "in-match"])
            for r in idx["files"]:
                path = os.path.join(out, r["file"])
                with open(path, "rb") as f:
                    self.assertEqual(hashlib.sha256(f.read()).hexdigest(), r["sha256"])
                for k in ("seed", "durationSec", "lufs", "targetLufs", "bytes", "seamRatio", "moodVersion"):
                    self.assertIn(k, r)
            # the index is reproducible: a second run gives the same index
            code2, _ = self.run_cli(out, ("off", "off air"), ["--mood", "lobby", "--mood", "in-match", "--seed", "4"])
            self.assertEqual(code2, 0)
            with open(os.path.join(out, "index.json"), encoding="utf-8") as f:
                self.assertEqual(json.load(f), idx)


if __name__ == "__main__":
    unittest.main()
