# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T3 (services/clip/reel_cover.py): the hook split and a real render on a synthetic frame (skips without
ffmpeg)."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import reel_cover as rc  # noqa: E402
import reel_thumbnail as th  # noqa: E402

CFG = th.load_config()
HAVE = bool(shutil.which("ffmpeg"))


class SplitTests(unittest.TestCase):
    def test_short_hook_one_line_upper_cased(self):
        self.assertEqual(rc.split_hook("no way", CFG), ["NO WAY"])

    def test_long_hook_two_lines_within_max_chars(self):
        ls = rc.split_hook("clutch finish again", CFG)
        self.assertEqual(ls, ["CLUTCH FINISH", "AGAIN"])
        self.assertTrue(all(len(x) <= 18 for x in ls))

    def test_unfit_or_empty_gives_nothing(self):
        self.assertEqual(rc.split_hook("abcdefghijklmnopqrstuvwxyz", CFG), [])
        self.assertEqual(rc.split_hook("   ", CFG), [])
        self.assertEqual(rc.split_hook("aaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbb cccccccccccccccc", CFG), [])

    def test_unsafe_characters_dropped(self):
        self.assertEqual(rc.split_hook("no:way{x}", CFG), ["NOWAYX"])


@unittest.skipUnless(HAVE, "ffmpeg missing")
class RenderTests(unittest.TestCase):
    def test_real_jpeg_from_a_synthetic_video(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get("UJWALAM_TEST_TMP") or None) as d:
            v = os.path.join(d, "v.mp4")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=10:duration=3", v],
                           check=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            out = os.path.join(d, "cover.jpg")
            rec = rc.make("ffmpeg", v, 1.5, "no way", out, d)
            self.assertEqual(rec.get("lines"), ["NO WAY"], rec)
            self.assertTrue(os.path.getsize(out) > 1000)
            with open(out, "rb") as f:
                self.assertEqual(f.read(2), b"\xff\xd8")
            self.assertEqual([n for n in os.listdir(d) if n.startswith("cover-") or n.endswith(".part.jpg")], [])
            self.assertIn("error", rc.make("ffmpeg", v, 1.5, "abcdefghijklmnopqrstuvwxyz", out, d))


if __name__ == "__main__":
    unittest.main()
