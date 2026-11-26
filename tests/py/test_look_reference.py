# SPDX-License-Identifier: GPL-3.0-or-later
"""RL5 New look from a reference (services/clip/look_reference.py, D445).

- A synthetic reference with a known colour cast (a neutral grey gradient pushed by Lab a = +6, b = -9, mid
  brightness, L spread 20) gives a look whose LUT puts the same cast on the neutral gradient: within TOL_AB (1.5) Lab
  units on a and b together and TOL_L (1.5) on L.
- A cast beyond the Reel styles caps is capped (b shift at most 15).
- The look is saved in <data>/looks as user-<name>.json + .cube only; nothing of the reference (path, file name,
  picture) is kept; the loader merges it after the built-in looks; the nearest built-in look gives the effects.
- A shift equal to a built-in look's own LUT shift picks that look (distance 0).
- A short synthetic video works the same way.
Synthetic pictures only; studio-safe (CPU, no GPU, no window)."""

import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(REPO, "services", "clip"))

try:
    import cv2
    import numpy as np
except ImportError:
    np = None

import clip_realism as cr  # noqa: E402
import look_reference as lr  # noqa: E402

TOL_AB = 1.5
TOL_L = 1.5


def _gradient(cast_a=0.0, cast_b=0.0, w=320, h=180):
    """BGR uint8: L from 15.4 to 84.6 across (mean 50, spread 20), a and b = the cast."""
    L = np.tile(np.linspace(50 - 34.64, 50 + 34.64, w, dtype=np.float32), (h, 1))
    lab = np.stack([L, np.full_like(L, cast_a), np.full_like(L, cast_b)], axis=-1)
    bgr = cv2.cvtColor(lab, cv2.COLOR_Lab2BGR)
    return (np.clip(bgr, 0, 1) * 255 + 0.5).astype(np.uint8)


def _lab_mean(bgr_u8):
    lab = cv2.cvtColor(bgr_u8.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab).reshape(-1, 3)
    return lab.mean(axis=0)


def _through(look, data_dir, bgr_u8):
    n, rows = cr.read_cube(cr.lut_path(look, data_dir))
    rgb = bgr_u8[..., ::-1].astype(np.float64) / 255.0
    out = lr.apply_lut(n, rows, rgb)
    return (np.clip(out[..., ::-1], 0, 1) * 255 + 0.5).astype(np.uint8)


@unittest.skipIf(np is None, "numpy / OpenCV missing")
class FromReferenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ujw-rl5-")
        self.data = os.path.join(self.tmp, "data")
        os.makedirs(self.data)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ref(self, name, img):
        p = os.path.join(self.tmp, name)
        ok, buf = cv2.imencode(".png", img)
        self.assertTrue(ok)
        buf.tofile(p)
        return p

    def test_known_cast_is_reproduced_within_tolerance(self):
        ref = self._ref("teal reference.png", _gradient(6.0, -9.0))
        r = lr.make_look(self.data, ref, "Teal test")
        lk = r["look"]
        self.assertEqual(lk["id"], "user-teal-test")
        self.assertEqual(lk["effects"][0], {"type": "lut", "file": {"base": "userluts", "rel": "user-teal-test.cube"}, "amount": 1.0})
        self.assertAlmostEqual(r["measured"]["a"], 6.0, delta=0.6)
        self.assertAlmostEqual(r["measured"]["b"], -9.0, delta=0.6)
        neutral = _gradient(0.0, 0.0)
        got, src = _lab_mean(_through(lk, self.data, neutral)), _lab_mean(neutral)
        err_ab = float(np.hypot(got[1] - 6.0, got[2] - (-9.0)))
        print(f"\nRL5 cast check: wanted a=+6.00 b=-9.00, got a={got[1]:+.2f} b={got[2]:+.2f} (ab error {err_ab:.2f}),"
              f" L {src[0]:.2f} -> {got[0]:.2f}; based on {r['basedOn']['name']} (distance {r['basedOn']['distance']})")
        self.assertLessEqual(err_ab, TOL_AB)
        self.assertLessEqual(abs(got[0] - src[0]), TOL_L)

    def test_black_bars_are_left_out_and_brightness_moves_by_half(self):
        img = _gradient(5.0, -6.0, 180, 320)
        framed = np.zeros((640, 360, 3), np.uint8)
        framed[160:480, 90:270] = img  # a vertical reel on a black frame
        a = lr.measure_reference(self._ref("plain.png", img))
        b = lr.measure_reference(self._ref("framed.png", framed))
        for k in ("L", "a", "b", "contrast"):
            self.assertAlmostEqual(a[k], b[k], delta=0.5, msg=k)
        # a dark reference (mean L 30, no cast): the LUT darkens by half the difference (-10), not by all of it
        dark = _gradient(0.0, 0.0)
        dark_lab = cv2.cvtColor(dark.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab)
        dark_lab[..., 0] -= 20
        dark_img = (np.clip(cv2.cvtColor(dark_lab, cv2.COLOR_Lab2BGR), 0, 1) * 255 + 0.5).astype(np.uint8)
        r = lr.make_look(self.data, self._ref("dark.png", dark_img), "Dark")
        got, src = _lab_mean(_through(r["look"], self.data, _gradient())), _lab_mean(_gradient())
        self.assertAlmostEqual(float(got[0] - src[0]), lr.TONE_SHARE * (r["measured"]["L"] - 50.0), delta=TOL_L)

    def test_cast_beyond_the_caps_is_capped(self):
        ref = self._ref("blue.png", _gradient(0.0, -30.0))
        r = lr.make_look(self.data, ref, "Very blue")
        self.assertAlmostEqual(r["look"]["measured"]["shift"]["b"], -15.0, delta=0.01)
        got = _lab_mean(_through(r["look"], self.data, _gradient()))
        self.assertGreater(got[2], -15.0 - TOL_AB)
        self.assertLess(got[2], -15.0 + TOL_AB)

    def test_saved_in_the_data_folder_only_numbers_kept_and_merged(self):
        ref = self._ref("secret-name-reference.png", _gradient(4.0, 5.0))
        r = lr.make_look(self.data, ref, "  Warm   one  ")
        d = os.path.join(self.data, "looks")
        self.assertEqual(sorted(os.listdir(d)), ["user-warm-one.cube", "user-warm-one.json"])
        with open(os.path.join(d, "user-warm-one.json"), encoding="utf-8") as f:
            txt = f.read()
        self.assertNotIn("secret-name", txt)
        self.assertNotIn(self.tmp.replace("\\", "\\\\"), txt)
        lk = json.loads(txt)
        self.assertEqual(lk["name"], "Warm one")
        near = cr.look_by_id(r["basedOn"]["id"])
        self.assertEqual(lk["effects"][1:], near["effects"][1:], "effects start from the nearest built-in look")
        self.assertEqual(lk["backdrop"], near["backdrop"])
        self.assertIn(near["name"], lk["summary"])
        self.assertEqual(len(lk["swatch"]), 5)
        merged = cr.load_looks(user_dir=cr.user_looks_dir(self.data))
        self.assertEqual(merged[-1]["id"], "user-warm-one")
        self.assertEqual([x["id"] for x in merged[:-1]], [x["id"] for x in cr.load_looks()])
        # a second look with the same name gets its own id; a user file in data/looks would be skipped
        r2 = lr.make_look(self.data, ref, "Warm one")
        self.assertEqual(r2["look"]["id"], "user-warm-one-2")
        self.assertEqual(cr.load_looks(), [x for x in cr.load_looks() if not x["id"].startswith("user-")])

    def test_reels_pick_and_render_plan_use_the_own_look(self):
        r = lr.make_look(self.data, self._ref("r.png", _gradient(3.0, -4.0)), "Reel one")
        with open(os.path.join(self.data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"realismLooks": {"byType": {"reel": {"mode": "one", "look": "user-reel-one", "ticks": []}}}}}, f)
        lk, rec = cr.pick(self.data, "reel")
        self.assertEqual((lk["id"], rec), ("user-reel-one", {"mode": "one"}))
        wd = os.path.join(self.tmp, "wd")
        os.makedirs(wd)
        frag, prec = cr.plan(lk, wd, {"width": 1080, "height": 1920}, ("x",), data_dir=self.data)
        self.assertEqual(prec["lutAmount"], 1.0)
        self.assertTrue(os.path.isfile(os.path.join(wd, cr.LUT_FILE)))
        self.assertIn("lut3d", frag)
        self.assertEqual(r["look"]["effects"][1:], lk["effects"][1:])
        with self.assertRaises(cr.ClipError):
            cr.lut_path(lk)  # an own look needs the data folder

    def test_nearest_builtin_by_colour_distance(self):
        looks = cr.load_looks()
        for lk in looks:
            e = lk["effects"][0]
            n, rows = cr.read_cube(cr.lut_path(lk))
            s = lr.lut_shift(n, rows, e.get("amount", 1.0))
            near, dist = lr.nearest_builtin(s, looks)
            self.assertEqual(near["id"], lk["id"])
            self.assertAlmostEqual(dist, 0.0, places=6)

    def test_short_video_reference(self):
        p = os.path.join(self.tmp, "ref.mp4")
        try:
            import av
        except ImportError:
            self.skipTest("PyAV missing")
        img = _gradient(-5.0, 7.0, 320, 180)
        with av.open(p, "w") as c:
            st = c.add_stream("mpeg4", rate=10)
            st.width, st.height, st.pix_fmt = 320, 180, "yuv420p"
            st.bit_rate = 4_000_000
            for _ in range(20):
                for pk in st.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                    c.mux(pk)
            for pk in st.encode():
                c.mux(pk)
        m = lr.measure_reference(p)
        self.assertAlmostEqual(m["a"], -5.0, delta=1.5)
        self.assertAlmostEqual(m["b"], 7.0, delta=1.5)

    def test_refusals(self):
        with self.assertRaises(cr.ClipError):
            lr.measure_reference(os.path.join(self.tmp, "missing.png"))
        bad = os.path.join(self.tmp, "not.png")
        with open(bad, "wb") as f:
            f.write(b"not a picture")
        with self.assertRaises(cr.ClipError):
            lr.measure_reference(bad)
        playlist = os.path.join(self.tmp, "x.m3u8")
        with open(playlist, "w") as f:
            f.write("#EXTM3U\n")
        with self.assertRaises(cr.ClipError):
            lr.measure_reference(playlist)
        self.assertEqual(os.listdir(self.data), [])

    def test_swatch_refs_match_the_lut_tool(self):
        with open(os.path.join(REPO, "tools", "make-look-luts.mjs"), encoding="utf-8") as f:
            src = f.read()
        m = re.search(r"SWATCH_REFS = Object\.freeze\((\[.*?\]\])\)", src)
        self.assertIsNotNone(m)
        self.assertEqual([tuple(x) for x in json.loads(m.group(1))], list(lr.SWATCH_REFS))


if __name__ == "__main__":
    unittest.main()
