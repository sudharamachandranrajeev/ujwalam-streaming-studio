# SPDX-License-Identifier: GPL-3.0-or-later
"""BD2 song map (services/clip/song_map.py, D414). Synthetic tracks made here (no real music): kicks on a known beat
grid (louder on the downbeat), off-beat hats, and sections of known loudness (intro, build, drop, breakdown, drop,
outro). Done when (plan section 7, synthetic part): beat grid within 20 ms of the truth and the drops found. Also: the
output follows data/schemas/song-map.schema.json's rules (numbers and section names only), and nothing runs on air.
Real tracks UNVERIFIED. Needs numpy + PyAV (the project venv)."""

import json
import os
import shutil
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:
    import av  # noqa: F401
    import numpy as np
except ImportError:
    np = None

SR = 48000


def make_track(path, bpm, phase, gains, bass_bars):
    """gains: one level per bar (4 beats); bass_bars: bars with a sub bass line. -> (beat times, bar start times)."""
    period = 60.0 / bpm
    bars = len(gains)
    n = int((phase + bars * 4 * period + 1.0) * SR)
    x = np.zeros(n)
    rng = np.random.default_rng(7)
    beats = []
    for b in range(bars):
        for q in range(4):
            t = phase + (4 * b + q) * period
            beats.append(t)
            i = int(round(t * SR))
            ln = min(n - i, int(0.2 * SR))
            tt = np.arange(ln) / SR
            amp = (1.0 if q == 0 else 0.6) * gains[b]
            x[i:i + ln] += amp * np.sin(2 * np.pi * (50 + 90 * np.exp(-tt / 0.03)) * tt) * np.exp(-tt / 0.08)
            j = int(round((t + period / 2) * SR))
            h = min(n - j, int(0.02 * SR))
            x[j:j + h] += 0.25 * gains[b] * rng.uniform(-1, 1, h) * np.exp(-np.arange(h) / (0.004 * SR))
            if b in bass_bars:
                ln2 = min(n - i, int(period * SR))
                x[i:i + ln2] += 0.25 * np.sin(2 * np.pi * 55 * np.arange(ln2) / SR)
    x = x / np.max(np.abs(x)) * 0.9
    pcm = np.clip(np.rint(np.repeat(x[:, None], 2, axis=1) * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return beats, [phase + 4 * b * period for b in range(bars)]


TRACKS = {
    "a": {"bpm": 120.0, "phase": 0.31,
          "gains": [0.15] * 4 + [0.17, 0.22, 0.28, 0.35] + [1.0] * 8 + [0.15] * 4 + [1.0] * 8 + [0.12] * 4,
          "bass": set(range(8, 16)) | set(range(20, 28)), "drops": [8, 20],
          "kinds": ["intro", "build", "drop", "breakdown", "drop", "outro"]},
    "b": {"bpm": 140.0, "phase": 0.12, "gains": [0.15] * 4 + [1.0] * 8 + [0.15] * 4,
          "bass": set(range(4, 12)), "drops": [4], "kinds": ["intro", "drop", "outro"]},
}


@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class SongMapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import song_map  # noqa: PLC0415
        cls.sm = song_map
        cls.tmp = tempfile.mkdtemp(prefix="ujw-songmap-")
        cls.res, cls.truth = {}, {}
        for k, spec in TRACKS.items():
            p = os.path.join(cls.tmp, f"{k}.wav")
            cls.truth[k] = make_track(p, spec["bpm"], spec["phase"], spec["gains"], spec["bass"])
            cls.res[k] = song_map.song_map(p, live=lambda: False)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_beat_grid_within_20_ms(self):
        for k, r in self.res.items():
            beats, _bars = self.truth[k]
            got = np.asarray(r["beats"])
            p = 60.0 / TRACKS[k]["bpm"]
            got = got[(got >= beats[0] - p / 2) & (got <= beats[-1] + p / 2)]  # the grid runs on over the silent tail
            err = [float(np.min(np.abs(got - b))) * 1000 for b in beats]
            print(f"track {k}: bpm {r['bpm']} (truth {TRACKS[k]['bpm']}), max beat error {max(err):.2f} ms, "
                  f"mean {np.mean(err):.2f} ms, fit rms {r['fit']['rmsMs']} ms")
            self.assertLessEqual(max(err), 20.0, k)
            self.assertLessEqual(abs(len(got) - len(beats)), 1, k)

    def test_downbeats_and_drops(self):
        for k, r in self.res.items():
            _beats, bars = self.truth[k]
            db = np.asarray(r["downbeats"])
            for b in bars:
                self.assertLessEqual(float(np.min(np.abs(db - b))), 0.02, f"{k}: downbeat at {b}")
            want = [bars[i] for i in TRACKS[k]["drops"]]
            self.assertEqual(len(r["drops"]), len(want), f"{k}: {r['drops']} vs {want}")
            for d, w in zip(r["drops"], want):
                self.assertLessEqual(abs(d - w), 0.05, f"{k}: drop {d} vs {w}")
            print(f"track {k}: drops {r['drops']} (truth {[round(w, 3) for w in want]})")

    def test_sections(self):
        for k, r in self.res.items():
            self.assertEqual([s["kind"] for s in r["sections"]], TRACKS[k]["kinds"], json.dumps(r["sections"]))
            self.assertEqual(r["sections"][0]["start"], 0.0)
            self.assertEqual(r["sections"][-1]["end"], r["duration"])

    def test_transients_are_real_hits(self):
        """Every strong transient is a kick or a hat of the fixture, timed within 20 ms; kicks are marked on a beat."""
        for k, r in self.res.items():
            beats, _bars = self.truth[k]
            p = 60.0 / TRACKS[k]["bpm"]
            hits = np.asarray(beats + [b + p / 2 for b in beats])
            self.assertTrue(r["transients"], k)
            for t in r["transients"]:
                self.assertLessEqual(float(np.min(np.abs(hits - t["t"]))), 0.02, f"{k}: {t}")
                self.assertEqual(t["onBeat"], float(np.min(np.abs(np.asarray(beats) - t["t"]))) <= 0.05, f"{k}: {t}")

    def test_output_shape(self):
        allowed = {"version", "duration", "bpm", "period", "phase", "beatsPerBar", "fit", "beats", "downbeats", "sections", "drops", "transients"}
        for r in self.res.values():
            self.assertEqual(set(r), allowed)
            for s in r["sections"]:
                self.assertIn(s["kind"], self.sm.SECTION_KINDS)
            json.dumps(r, allow_nan=False)

    def test_refused_on_air(self):
        p = os.path.join(self.tmp, "a.wav")
        with self.assertRaises(self.sm.ClipError):
            self.sm.song_map(p, live=lambda: True)
        with self.assertRaises(self.sm.ClipError):
            self.sm.song_map(p, live=lambda: None)

    def test_root_rule(self):
        other = tempfile.mkdtemp(prefix="ujw-songmap-root-")
        try:
            with self.assertRaises(self.sm.ClipError):
                self.sm.song_map(os.path.join(self.tmp, "a.wav"), root=other, live=lambda: False)
        finally:
            shutil.rmtree(other, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
