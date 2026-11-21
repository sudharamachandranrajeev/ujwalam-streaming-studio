# SPDX-License-Identifier: GPL-3.0-or-later
"""RS1 reel style analyser (services/clip/style_analyse.py, D412): synthetic example videos with known cuts (hard,
cross-fade, flash, whip), zoom pulses, a speed ramp, burned-in text boxes, a colour cast and a tone track on a 120 BPM
beat are measured back within stated tolerances; parts that cannot be measured are left out with a reason; a 60 s
example analyses within a stated time and memory bound on the CPU. Needs numpy, OpenCV, PyAV, RapidOCR (project venv).

Tolerances (stated here and in docs/evidence/2026-11-21-reel-styles-library.md):
- cut time: within 1 frame (hard) or 2 frames (gradual) of the made cut; every cut found, no extra cut; kind exact
- beat share: 1.0 when every cut is on a beat
- zoom pulse: peak time within 0.1 s, size within 0.02
- speed ramp: found within 0.35 s, slow/fast factor within 0.05 (UNVERIFIED on real footage)
- text: every box found, start and length within one sample step (0.5 s), band and corner exact, height within 3 % of
  the frame height of the drawn label
- colour: Lab a and b medians within 1.5 of the values measured on the frames before encoding
- 60 s, 540x960, 30 fps (H.264): under 150 s wall time and 800 MB peak working set
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "services", "clip"))
sys.path.insert(0, HERE)

try:
    import av  # noqa: F401
    import cv2
    import numpy as np
    import rapidocr  # noqa: F401
    import style_fixtures as sf
except ImportError:
    np = None

FPS = 30
NO_WINDOW = (subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name == "nt" else 0
SPEC = {"w": 270, "h": 480, "fps": FPS, "joinFrames": 8,
        "shots": [{"sec": 2.0, "hue": 10, "speed": 2.0},
                  {"sec": 1.5, "hue": 60, "speed": 2.0, "zooms": [{"at": 0.75, "scale": 1.15, "inSec": 0.15, "outSec": 0.2}]},
                  {"sec": 2.0, "hue": 110, "speed": 4.0, "ramp": {"at": 1.0, "speed": 1.0}},
                  {"sec": 1.5, "hue": 160, "speed": 2.0},
                  {"sec": 2.0, "hue": 30, "speed": 2.0, "zooms": [{"at": 1.0, "scale": 1.2, "inSec": 0.15, "outSec": 0.2}]},
                  {"sec": 1.0, "hue": 90, "speed": 2.0},
                  {"sec": 2.0, "hue": 140, "speed": 2.0}],
        "joins": ["hard", "fade", "flash", "whip", "hard", "fade"],
        "texts": [{"start": 0.5, "sec": 1.5, "box": [0.1, 0.72, 0.9, 0.80]},
                  {"start": 5.7, "sec": 1.0, "box": [0.04, 0.04, 0.36, 0.11]}],
        "cast": {"b": 12}}
ZOOM_TRUTH = [(2.75, 1.15), (8.0, 1.2)]
RAMP_TRUTH = (4.5, 0.25)


def truth_colour(spec):
    a, b = [], []
    for img in sf.frames(spec):
        h, w = img.shape[:2]
        small = cv2.resize(img, (96, int(round(96 * h / w / 2)) * 2), interpolation=cv2.INTER_AREA)
        lab = cv2.cvtColor(small.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab)
        a.append(float(lab[..., 1].mean()))
        b.append(float(lab[..., 2].mean()))
    return float(np.median(a)), float(np.median(b))


@unittest.skipUnless(np is not None, "numpy/OpenCV/PyAV/RapidOCR missing (use the project venv)")
class AnalyseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import style_analyse as sa  # noqa: PLC0415
        cls.sa = sa
        cls.cfg = sa.load_config()
        cls.tmp = tempfile.mkdtemp(prefix="ujw-rs1-")
        cls.path = os.path.join(cls.tmp, "example.mkv")
        sf.write(cls.path, SPEC, audio=sf.beat_audio(12.0, 120.0))
        cls.r = sa.analyse_video(cls.path, cls.cfg)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_cuts_and_kinds(self):
        truth = sf.cut_truth(SPEC)
        ev = self.r["transitions"]["events"]
        self.assertEqual(len(ev), len(truth), ev)
        for e, (t, kind) in zip(ev, truth):
            tol = (1.0 if kind == "hard" else 2.0) / FPS + 1e-3
            self.assertLessEqual(abs(e["t"] - t), tol, (e, t))
            self.assertEqual(e["kind"], kind, (e, t))
        self.assertEqual(self.r["cuts"]["count"], 6)
        self.assertAlmostEqual(self.r["cuts"]["ratePerMin"], 30.0, delta=0.5)
        self.assertEqual(self.r["transitions"]["mix"], {"hard": 0.333, "fade": 0.333, "flash": 0.167, "whip": 0.167})
        self.assertAlmostEqual(self.r["cuts"]["shotSec"], 2.0, delta=1.0 / FPS + 1e-3)

    def test_beats(self):
        self.assertAlmostEqual(self.r["music"]["bpm"], 120.0, delta=2.0)
        self.assertEqual(self.r["cuts"]["beatShare"], 1.0)

    def test_zoom_pulses(self):
        p = self.r["zooms"]["pulses"]
        self.assertEqual(len(p), len(ZOOM_TRUTH), p)
        for got, (t, s) in zip(p, ZOOM_TRUTH):
            self.assertLessEqual(abs(got["t"] - t), 0.1, got)
            self.assertLessEqual(abs(got["scale"] - s), 0.02, got)
            self.assertLess(got["inSec"], 0.6)
            self.assertLess(got["outSec"], 0.4)

    def test_speed_ramp(self):
        rp = self.r["ramps"]["ramps"]
        self.assertEqual(len(rp), 1, rp)
        self.assertLessEqual(abs(rp[0]["t"] - RAMP_TRUTH[0]), 0.35, rp)
        self.assertLessEqual(abs(rp[0]["factor"] - RAMP_TRUTH[1]), 0.05, rp)

    def test_text_boxes(self):
        tx = self.r["text"]["texts"]
        self.assertEqual(len(tx), 2, tx)
        step = self.cfg["analyse"]["text"]["stepSec"]
        for got, want, band, corner in zip(tx, SPEC["texts"], ("bottom", "top"), (False, True)):
            self.assertLessEqual(abs(got["start"] - want["start"]), step + 1e-3, got)
            self.assertLessEqual(abs(got["sec"] - want["sec"]), step + 1e-3, got)
            self.assertEqual(got["band"], band)
            self.assertEqual(got["corner"], corner)
            # the reader's box sits between the letters (60 % of the label) and the whole dark label
            self.assertLessEqual(abs(got["sizePct"] - 100.0 * (want["box"][3] - want["box"][1])), 3.0, got)
        self.assertNotIn("GG", json.dumps(self.r))  # the text itself is never kept

    def test_colour_cast(self):
        a, b = truth_colour(SPEC)
        self.assertLessEqual(abs(self.r["colour"]["a"] - a), 1.5, (self.r["colour"], a, b))
        self.assertLessEqual(abs(self.r["colour"]["b"] - b), 1.5, (self.r["colour"], a, b))
        self.assertGreater(self.r["colour"]["b"], 15)  # the warm cast is seen

    def test_numbers_only(self):
        def walk(v):
            if isinstance(v, dict):
                for x in v.values():
                    walk(x)
            elif isinstance(v, list):
                for x in v:
                    walk(x)
            else:
                self.assertTrue(v is None or isinstance(v, (int, float, bool, str)), type(v))
                if isinstance(v, str):
                    self.assertLess(len(v), 200)
        walk(self.r)
        json.dumps(self.r)

    def test_quiet_single_shot_has_no_cuts_zooms_or_ramps(self):
        spec = {"w": 270, "h": 480, "fps": FPS, "shots": [{"sec": 8.0, "hue": 40, "speed": 2.0}]}
        p = os.path.join(self.tmp, "plain.mkv")
        sf.write(p, spec)
        r = self.sa.analyse_video(p, self.cfg, ocr=False)
        self.assertEqual(r["cuts"]["count"], 0)
        self.assertEqual(r["zooms"]["pulses"], [])
        self.assertEqual(r["ramps"]["ramps"], [])
        parts = {o["part"] for o in r["omitted"]}
        self.assertEqual(parts, {"music", "beatShare", "text"})  # no sound, no cuts, text reading off
        self.assertTrue(all(o["reason"] for o in r["omitted"]))
        self.assertIsNone(r["music"])
        self.assertNotIn("beatShare", r["cuts"])

    def test_merge_takes_the_median_with_spread(self):
        a = json.loads(json.dumps(self.r))
        b = json.loads(json.dumps(self.r))
        c = json.loads(json.dumps(self.r))
        b["cuts"]["shotSec"], c["cuts"]["shotSec"] = 1.0, 3.0
        c["music"] = None
        c["omitted"] = [{"part": "music", "reason": "no usable sound"}]
        m = self.sa.merge([a, b, c], self.cfg)
        self.assertEqual(m["cuts"]["shotSec"], a["cuts"]["shotSec"])
        self.assertEqual(m["spread"]["cuts"]["shotSec"], [1.0, 3.0])
        self.assertEqual(m["transitions"]["count"], 18)
        self.assertAlmostEqual(m["music"]["bpm"], a["music"]["bpm"])
        none = self.sa.merge([c], self.cfg)
        self.assertNotIn("music", none)
        self.assertIn({"part": "music", "reason": "no usable sound"}, none["omitted"])


@unittest.skipUnless(np is not None, "numpy/OpenCV/PyAV/RapidOCR missing (use the project venv)")
class BoundTests(unittest.TestCase):
    def test_60_s_example_within_time_and_memory(self):
        tmp = tempfile.mkdtemp(prefix="ujw-rs1b-")
        try:
            shots, joins = [], []
            kinds = ["hard", "fade", "flash", "whip"]
            for i in range(30):
                shots.append({"sec": 2.0, "hue": (i * 37) % 180, "speed": 3.0,
                              "zooms": [{"at": 1.0, "scale": 1.12, "inSec": 0.15, "outSec": 0.2}] if i % 3 == 0 else []})
                if i:
                    joins.append(kinds[i % 4] if kinds[i % 4] != "flash" or i % 8 == 2 else "hard")
            spec = {"w": 540, "h": 960, "fps": FPS, "shots": shots, "joins": joins,
                    "texts": [{"start": 4.0 * k + 0.5, "sec": 1.5, "box": [0.1, 0.72, 0.9, 0.8]} for k in range(15)]}
            p = os.path.join(tmp, "long.mp4")
            sf.write(p, spec, audio=sf.beat_audio(60.0, 120.0), codec="libx264")
            clip = os.path.abspath(os.path.join(HERE, "..", "..", "services", "clip"))
            code = (f"import sys; sys.path.insert(0, {clip!r}); import style_analyse as s; "
                    f"sys.exit(s.main(['--video', {p!r}]))")
            r = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, timeout=600,
                               creationflags=NO_WINDOW)
            self.assertEqual(r.returncode, 0, r.stderr[-400:])
            out = json.loads(r.stdout.strip().splitlines()[-1])
            print(f"\n60 s example: {out['wallSec']} s wall, {out['peakMb']} MB peak, "
                  f"{out['result']['cuts']['count']} cuts, {len(out['result']['zooms']['pulses'])} pulses, "
                  f"{len(out['result']['text']['texts'])} texts")
            self.assertLess(out["wallSec"], 150.0)
            self.assertIsNotNone(out["peakMb"])
            self.assertLess(out["peakMb"], 800.0)
            self.assertAlmostEqual(out["result"]["seconds"], 60.0, delta=0.1)
            self.assertEqual(out["result"]["cuts"]["count"], 29)
            self.assertEqual(len(out["result"]["zooms"]["pulses"]), 10)  # every third shot has one
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
