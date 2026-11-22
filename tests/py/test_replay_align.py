# SPDX-License-Identifier: GPL-3.0-or-later
"""Unit tests for services/clip/replay_align.py (BD6 replay alignment, D431).

Synthetic signals always: noise bursts on a quiet bed, shifted, slowed to 0.5x and paused. The real-fixture test
runs only when UJWALAM_REPLAY_FIXTURES points at a folder of replay passes (local only, never committed); it prints
the offset and confidence of every pair. Needs numpy and PyAV (project venv); skipped on a python without them.
Run: .venv-gpu/Scripts/python.exe -I -m unittest discover -s tests/py -t tests/py -p "test_replay_align.py" -v
"""

import glob
import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIP = os.path.join(_HERE, "..", "..", "services", "clip")


def _load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_CLIP, name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ra = _load("replay_align")
np = ra.np
SR = ra.SR


def _match(seconds=60.0, seed=1):
    """An invented 'match' soundtrack: quiet noise bed plus random bursts (shots) of varied length and pitch."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    x = rng.normal(0, 0.003, n).astype(np.float32)
    t = 0.2
    while t < seconds - 0.3:
        ln = int(rng.uniform(0.03, 0.25) * SR)
        i = int(t * SR)
        f = rng.uniform(200, 3000)
        k = np.arange(min(ln, n - i))
        burst = rng.normal(0, 1, k.size) * 0.3 + np.sin(2 * np.pi * f * k / SR)
        x[i:i + k.size] += (burst * np.exp(-k / (0.3 * max(ln, 1)))).astype(np.float32) * rng.uniform(0.1, 0.6)
        t += rng.uniform(0.08, 0.9)
    return x


def _remix(x, seed=7):
    """Same events, another mix: level change, other noise bed (as HUD/camera passes differ)."""
    rng = np.random.default_rng(seed)
    return (0.6 * x + rng.normal(0, 0.004, x.size)).astype(np.float32)


def _slow(x, rate):
    """Time-stretch by plain resampling (pitch drops too), replay = pass * rate."""
    n_out = int(len(x) / rate)
    return np.interp(np.arange(n_out) * rate, np.arange(len(x)), x).astype(np.float32)


def _item(x):
    return {"env": ra.onset_envelope(x), "level": ra.frame_energy(x), "duration": len(x) / SR}


@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class Synthetic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.full = _match(60.0)
        cls.ref = _item(cls.full)

    def test_shift(self):
        start = 17.37
        p = _remix(self.full[int(start * SR):int((start + 25) * SR)])
        res = ra.align_pair(self.ref["env"], _item(p)["env"], rate="auto")
        self.assertEqual(res["rate"], 1.0)
        self.assertAlmostEqual(res["offset"], start, delta=0.02)
        self.assertGreater(res["r"], 0.6)
        self.assertGreater(res["margin"], 0.2)

    def test_lead_in_before_replay(self):
        # the pass starts with 3 s of menu noise before the replay begins at 5.0 s
        rng = np.random.default_rng(3)
        lead = rng.normal(0, 0.003, 3 * SR).astype(np.float32)
        p = np.concatenate([lead, _remix(self.full[5 * SR:35 * SR])])
        pmap, glob = ra.build_map(self.ref, _item(p), rate=1.0)
        self.assertAlmostEqual(glob["offset"], 2.0, delta=0.03)
        self.assertAlmostEqual(pmap.pass_to_replay(10.0), 12.0, delta=0.05)

    def test_half_speed_detected(self):
        start = 10.0
        p = _slow(_remix(self.full[int(start * SR):int((start + 20) * SR)]), 0.5)
        res = ra.align_pair(self.ref["env"], _item(p)["env"], rate="auto")
        self.assertEqual(res["rate"], 0.5)
        self.assertAlmostEqual(res["offset"], start, delta=0.05)
        pmap, _ = ra.build_map(self.ref, _item(p), rate="auto")
        self.assertAlmostEqual(pmap.pass_to_replay(20.0), start + 10.0, delta=0.08)
        self.assertAlmostEqual(pmap.replay_to_pass(start + 10.0), 20.0, delta=0.16)

    def test_given_rate(self):
        p = _slow(_remix(self.full[8 * SR:28 * SR]), 0.5)
        res = ra.align_pair(self.ref["env"], _item(p)["env"], rate=0.5)
        self.assertEqual(res["rate"], 0.5)
        self.assertAlmostEqual(res["offset"], 8.0, delta=0.05)

    def test_pause_splits_segments(self):
        # 0-14 s of replay from 4 s, a 3.5 s silent frozen pause, then the replay carries on
        a = _remix(self.full[4 * SR:18 * SR])
        pause = np.zeros(int(3.5 * SR), np.float32)
        b = _remix(self.full[18 * SR:40 * SR], seed=9)
        p = np.concatenate([a, pause, b])
        pmap, glob = ra.build_map(self.ref, _item(p), rate=1.0)
        segs = pmap.segments
        self.assertEqual(len(segs), 2, segs)
        self.assertAlmostEqual(segs[0]["replay_t0"], 4.0, delta=0.05)
        self.assertAlmostEqual(segs[1]["pass_t0"], 17.5, delta=0.3)
        self.assertAlmostEqual(segs[1]["replay_t0"] - segs[1]["pass_t0"], 0.5, delta=0.05)
        self.assertEqual(glob["gaps"][0]["found_by"], "quiet")
        self.assertIsNone(pmap.pass_to_replay(16.0))  # inside the pause
        self.assertAlmostEqual(pmap.pass_to_replay(30.0), 30.5, delta=0.05)
        self.assertAlmostEqual(pmap.replay_to_pass(30.5), 30.0, delta=0.05)

    def test_null_pair_low_confidence(self):
        other = _match(30.0, seed=42)
        res = ra.align_pair(self.ref["env"], _item(other)["env"], rate="auto")
        self.assertLess(res["margin"], ra.MIN_MARGIN)
        pmap, glob = ra.build_map(self.ref, _item(other), rate=1.0)
        self.assertFalse(glob["aligned"])

    def test_silence_without_pause_is_not_a_break(self):
        # a quiet stretch inside the replay itself (no pause): the offset must not change across it
        x = _remix(self.full[6 * SR:36 * SR]).copy()
        x[12 * SR:int(13.2 * SR)] = 0
        pmap, glob = ra.build_map(self.ref, _item(x), rate=1.0)
        self.assertEqual(len(pmap.segments), 1, pmap.segments)
        self.assertAlmostEqual(pmap.pass_to_replay(20.0), 26.0, delta=0.05)

    def test_match_time_mapping(self):
        pmap = ra.PassMap([{"pass_t0": 0.0, "pass_t1": 40.0, "replay_t0": 12.0, "rate": 0.5, "r": 1}],
                          match_offset=100.0)
        self.assertAlmostEqual(pmap.replay_to_match(12.0), 112.0)
        self.assertAlmostEqual(pmap.match_to_pass(122.0), 20.0)
        self.assertIsNone(pmap.match_to_pass(500.0))

    def test_clock_parse_and_fit(self):
        self.assertEqual(ra.parse_clock("MATCH TIME 04:45", r"(?P<m>\d{1,2}):(?P<s>\d{2})"), 285)
        self.assertEqual(ra.parse_clock("01:11 08:34", r"(?P<m>\d{1,2}):(?P<s>\d{2})"), 71)
        self.assertIsNone(ra.parse_clock("TARGET 150", r"(?P<m>\d{1,2}):(?P<s>\d{2})"))
        pmap = ra.PassMap([{"pass_t0": 0.0, "pass_t1": 50.0, "replay_t0": 3.0, "rate": 1.0, "r": 1}])
        reads = [(t, int(t + 3.0 + 200.3)) for t in (1, 5, 9, 13, 17, 21)]  # floored clock, true offset 200.3
        fit = ra.fit_clock(reads, pmap, 1.0)
        self.assertAlmostEqual(fit["offset"], 200.3, delta=0.6)
        self.assertEqual(fit["agree"], 6)

    def test_clock_regions_are_data(self):
        regs = ra.load_clock_regions("codm")
        self.assertTrue(regs)
        for r in regs:
            self.assertIn("pattern", r)
            self.assertTrue(0 <= r["box"]["x0"] < r["box"]["x1"] <= 1)


@unittest.skipUnless(np is not None and os.environ.get("UJWALAM_REPLAY_FIXTURES"),
                     "set UJWALAM_REPLAY_FIXTURES to the local replay folder to run")
class RealFixtures(unittest.TestCase):
    def test_pairs(self):
        files = sorted(glob.glob(os.path.join(os.environ["UJWALAM_REPLAY_FIXTURES"], "replay-*.mkv")))
        self.assertGreaterEqual(len(files), 2)
        passes = [f for f in files if "-FULL-" not in os.path.basename(f)]
        ref_path = passes[0]  # first pass defines replay time; the full-match file is reported, not required
        ref = ra.analyse(ref_path)
        for f in files:
            if f == ref_path:
                continue
            pmap, glob_res = ra.build_map(ref, ra.analyse(f))
            tag = os.path.basename(f).split("-2")[0]
            segs = [(s["pass_t0"], s["pass_t1"], s["replay_t0"], s["rate"], s["r"]) for s in pmap.segments] \
                if pmap else None
            print(f"\n{tag}: {glob_res} segments={segs}")
            self.assertIsNotNone(glob_res, tag)
