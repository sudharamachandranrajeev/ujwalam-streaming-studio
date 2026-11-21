# SPDX-License-Identifier: GPL-3.0-or-later
"""BD1 moment finder (services/clip/moments.py, D414). One synthetic recording made here (no real footage): a textured
scene with two gunshots (a click in the sound + a white muzzle flash in the weapon area on the same frame), a hit
marker (white X at the centre) 0.5 s before a "+N" detector hit, a scope (dark ring, bright centre), a flick (fast
sideways pan), a jump (camera up, then down) and a third-person stretch (the camera pans while a body in the lower
middle stays still). Done when (plan section 7, synthetic part): every moment within 2 frames of the truth. Also: the
data file follows its schema rules, nothing runs on air, and the guard stops a run that goes on air. Real-footage
accuracy is UNVERIFIED. Needs numpy, OpenCV and PyAV (the project venv)."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:
    import av  # noqa: F401
    import cv2
    import numpy as np
except ImportError:
    np = None

FPS, W, H, SR = 30, 640, 360, 48000
TRUTH = {"gunshot": [15, 36], "kill": [39], "hit": [39], "scope-in": [75], "scope-out": [105], "flick": [120], "jump": [150],
         "third-person": [180]}
N = 240  # 8 s


def _scene_canvas():
    rng = np.random.default_rng(5)
    noise = rng.uniform(0, 1, (H * 3 // 8 + 1, W * 3 // 8 + 1)).astype(np.float32)
    big = cv2.GaussianBlur(cv2.resize(noise, (W * 3, H * 3), interpolation=cv2.INTER_CUBIC), (0, 0), 5)
    big = (big - big.min()) / (big.max() - big.min())
    return (60 + 120 * big).astype(np.uint8)


def _offsets():
    """Camera offset (ox, oy) per frame: still, then a flick at 120 (4 frames x 40 px), a jump at 150 (3 up, 3 down),
    and a slow pan from 180 (8 px per frame)."""
    ox = oy = 0.0
    out = []
    for f in range(N):
        if 120 <= f < 124:
            ox += 40
        if 150 <= f < 153:
            oy -= 22
        elif 153 <= f < 156:
            oy += 22
        if 180 <= f < 225:
            ox += 8
        out.append((ox, oy))
    return out


def make_frames():
    canvas = _scene_canvas()
    body = np.random.default_rng(9).integers(20, 200, (int(0.44 * H), int(0.24 * W))).astype(np.uint8)
    for f, (ox, oy) in enumerate(_offsets()):
        x0, y0 = int(W + ox), int(H + oy)
        g = canvas[y0:y0 + H, x0:x0 + W].copy()
        if f in (15, 16, 36, 37):  # muzzle flash
            g[int(0.55 * H):int(0.85 * H), int(0.55 * W):int(0.82 * W)] = 255
        if 39 <= f < 43:  # hit marker: a white X at the centre
            cx, cy = W // 2, H // 2
            for d in (-1, 1):
                cv2.line(g, (cx - 22, cy - 22 * d), (cx - 6, cy - 6 * d), 255, 4)
                cv2.line(g, (cx + 6, cy + 6 * d), (cx + 22, cy + 22 * d), 255, 4)
        if 75 <= f < 105:  # scope: black outside a circle, bright inside
            yy, xx = np.mgrid[0:H, 0:W]
            r = np.hypot(xx - W / 2, yy - H / 2) / H
            g = np.where(r > 0.33, 8, np.clip(g.astype(int) + 40, 0, 215)).astype(np.uint8)
        if 180 <= f < 225:  # third person: the body stays put in the lower middle
            g[int(0.53 * H):int(0.53 * H) + body.shape[0], int(0.38 * W):int(0.38 * W) + body.shape[1]] = body
        yield cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)


def make_audio():
    n = int(N / FPS * SR)
    rng = np.random.default_rng(3)
    x = 0.02 * np.sin(2 * np.pi * 110 * np.arange(n) / SR) + 0.002 * rng.standard_normal(n)
    for f in TRUTH["gunshot"]:
        i = int(f / FPS * SR)
        ln = int(0.03 * SR)
        x[i:i + ln] += 0.8 * rng.uniform(-1, 1, ln) * np.exp(-np.arange(ln) / (0.006 * SR))
    return x


def write_recording(path):
    with av.open(path, "w") as c:
        vs = c.add_stream("ffv1", rate=FPS)
        vs.width, vs.height, vs.pix_fmt = W, H, "yuv444p"
        as_ = c.add_stream("pcm_s16le", rate=SR)
        as_.layout = "mono"
        for img in make_frames():
            for p in vs.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                c.mux(p)
        for p in vs.encode():
            c.mux(p)
        pcm = np.clip(np.rint(make_audio() * 32767), -32768, 32767).astype(np.int16)
        for i in range(0, len(pcm), 1024):
            fr = av.AudioFrame.from_ndarray(pcm[None, i:i + 1024], format="s16", layout="mono")
            fr.sample_rate = SR
            for p in as_.encode(fr):
                c.mux(p)
        for p in as_.encode():
            c.mux(p)


@unittest.skipUnless(np is not None, "numpy/OpenCV/PyAV missing (use the project venv)")
class MomentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import moments  # noqa: PLC0415
        cls.mo = moments
        cls.cfg = moments.load_config("codm")
        cls.tmp = tempfile.mkdtemp(prefix="ujw-moments-")
        cls.rec = os.path.join(cls.tmp, "rec.mkv")
        write_recording(cls.rec)
        cls.hits = os.path.join(cls.tmp, "hits.jsonl")
        with open(cls.hits, "w", encoding="utf-8") as f:
            f.write(json.dumps({"t": 39 / FPS + 0.5, "detector": "M4", "label": "+100", "role": "positive"}) + "\n")
            f.write(json.dumps({"t": 39 / FPS + 0.9, "detector": "M5", "label": "kill", "role": "positive"}) + "\n")
        cls.res = moments.find_moments(cls.rec, cls.cfg, cls.hits, live=lambda: False)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def frames_of(self, kind):
        return [m["frame"] for m in self.res["moments"] if m["kind"] == kind]

    def test_every_moment_within_two_frames(self):
        report = {}
        for kind, want in TRUTH.items():
            got = self.frames_of(kind)
            report[kind] = (want, got)
            for w in want:
                self.assertTrue(any(abs(g - w) <= 2 for g in got), f"{kind}: want frame {w}, got {got}")
            # precision on the fixture: nothing found where nothing happened
            for g in got:
                self.assertTrue(any(abs(g - w) <= 2 for w in want), f"{kind}: extra at frame {g}")
        print("moments truth vs found:", json.dumps(report))

    def test_moment_shape(self):
        for m in self.res["moments"]:
            self.assertEqual(m["status"], "unverified")
            self.assertIn(m["kind"], self.mo.KINDS)
            self.assertTrue(0.0 <= m["strength"] <= 1.0)
            self.assertAlmostEqual(m["t"], m["frame"] / FPS, places=2)
        kill = [m for m in self.res["moments"] if m["kind"] == "kill"][0]
        self.assertTrue(kill["source"].startswith("hit-marker+"), kill)
        self.assertEqual(self.res["frames"], N)

    def test_kill_without_marker_uses_detector_time(self):
        fp = {"t": [i / FPS for i in range(90)], "hitmark": [0.0] * 90, "fps": FPS}
        ms = self.mo.hits_and_kills(fp, self.cfg, [{"t": 2.0, "detector": "B1"}])
        self.assertEqual([(m["kind"], m["frame"]) for m in ms], [("kill", 60)])

    def test_unconfirmed_sound_is_not_a_gunshot(self):
        fp = {"t": [i / FPS for i in range(30)], "weapon": [80.0] * 30, "fps": FPS}
        shots, un = self.mo.gunshots(fp, [(0.5, 5.0)], self.cfg)
        self.assertEqual((shots, un), ([], 1))

    def test_refused_on_air(self):
        with self.assertRaises(self.mo.ClipError):
            self.mo.find_moments(self.rec, self.cfg, live=lambda: True)
        with self.assertRaises(self.mo.ClipError):  # unknown counts as on air
            self.mo.find_moments(self.rec, self.cfg, live=lambda: None)

    def test_guard_stops_when_going_on_air(self):
        state = {"n": 0}

        def live():
            state["n"] += 1
            return state["n"] > 1  # off air at the start, on air at the first check during the decode

        cfg = json.loads(json.dumps(self.cfg))
        cfg["guard"]["checkEveryFrames"] = 30
        with self.assertRaises(self.mo.sa.GuardStop):
            self.mo.find_moments(self.rec, cfg, live=live)

    def test_frame_cap(self):
        g = self.mo.make_guard(self.cfg, 0.1, None)
        g.max_frames = 10
        with self.assertRaises(self.mo.sa.GuardStop):
            self.mo.frame_pass(self.rec, self.cfg, g)

    def test_config_rules(self):
        c = self.cfg
        self.assertEqual(c["status"], "unverified")
        for b in (c["gunshot"]["weaponZone"], c["hitmarker"]["zone"], c["thirdPerson"]["bodyZone"]):
            self.assertTrue(0 <= b["x0"] < b["x1"] <= 1 and 0 <= b["y0"] < b["y1"] <= 1)
        self.assertLess(c["scope"]["centreRadius"], c["scope"]["ringInner"])
        self.assertLess(c["scope"]["ringInner"], c["scope"]["ringOuter"])


if __name__ == "__main__":
    unittest.main()
