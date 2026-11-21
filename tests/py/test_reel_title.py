# SPDX-License-Identifier: GPL-3.0-or-later
"""FX2 name display (services/clip/reel_title.py, D411; replaces the RP4 centre card over blur): the config limits,
when the name starts, the three styles' ASS (no blur anywhere), the filter graph (libass, no blur filter), and real
renders (ffmpeg cases skip without ffmpeg; libopenh264, 360x640, a few seconds): the picture away from the name is the
plain reel (never blurred), and the entrance (< 600 ms) and exit (< 400 ms) measured from the rendered frames.
Synthetic pictures, times and a placeholder brand only."""

import os
import re
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import reel_title as rt  # noqa: E402

CFG = rt.load_config()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FRAME = {"width": 360, "height": 640}
SAFE = {"top": 20, "bottom": 60, "left": 12, "right": 24}
BLUR = re.compile(r"\\blur|\\be\d|gblur|boxblur|avgblur|smartblur", re.I)


def piece(a, b, **kw):
    return dict({"start": float(a), "end": float(b), "kills": 1}, **kw)


def name(style, **kw):
    return dict({"style": style, "variant": "scale-punch", "position": "auto", "colour": "theme", "sizePct": 100,
                 "durationSec": 2.0}, **kw)


class DataTests(unittest.TestCase):
    def test_flags(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags[rt.LOOK_FLAG]["default"], True, "the name display ships on with the clip look")
        self.assertIs(flags[rt.FLAG]["default"], False, "the old reel-title switch stays off")
        self.assertNotIn("blur", CFG)

    def test_overlay_limits(self):
        for s in rt.STYLES:
            for n in (1, 8, CFG["maxChars"]):
                self.assertLess(rt.entrance_ms(s, CFG["styles"][s], n), 600, (s, n))
            self.assertLess(CFG["styles"][s]["exitMs"], 400, s)

    def test_bad_config_is_refused(self):
        bad = dict(CFG, styles=dict(CFG["styles"], kinetic=dict(CFG["styles"]["kinetic"], exitMs=450)))
        for b in (bad, dict(CFG, fontFile="Nope.ttf")):
            d = tempfile.mkdtemp(prefix="fx2-")
            p = os.path.join(d, "t.json")
            cc.write_json_atomic(p, b)
            with self.assertRaises(cc.ClipError):
                rt.load_config(p)
            shutil.rmtree(d, ignore_errors=True)


class PlanTests(unittest.TestCase):
    def test_name_starts_after_the_teaser(self):
        ps = [piece(50, 53, teaser=True), piece(10, 20), piece(30, 40)]
        self.assertEqual(rt.timeline(ps, 0.0), (3.0, 23.0))
        start, total = rt.timeline(ps, 0.25)
        self.assertAlmostEqual(start, 2.75)
        self.assertAlmostEqual(total, 22.5)

    def test_styles(self):
        ps = [piece(50, 53, teaser=True), piece(10, 20)]
        lt = rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE, name("lower-third"))
        self.assertEqual((lt["start"], lt["end"], lt["align"]), (3.0, 5.0, 1))
        self.assertGreater(lt["y"], FRAME["height"] / 2, "bottom area")
        ct = rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE, name("corner-tag"))
        self.assertEqual((ct["end"], ct["align"]), (13.0, 7), "the corner tag stays to the end, top-left")
        kn = rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE, name("kinetic"))
        self.assertLess(kn["y"], FRAME["height"] / 2, "upper third")
        self.assertEqual(rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE)["style"], "kinetic", "default")
        big = rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE, name("kinetic", sizePct=150))
        self.assertGreater(big["size"], kn["size"])
        mine = rt.plan(ps, 0.0, CFG, "Brand", FRAME, SAFE, name("lower-third", colour="#00AAFF", position="top-right"))
        self.assertEqual((mine["accent"], mine["align"]), ("#00AAFF", 9))
        self.assertEqual(lt["accent"], CFG["themeAccent"])

    def test_no_brand_no_name(self):
        for b in (None, "", "   ", "<brand>", 5):
            self.assertIsNone(rt.plan([piece(10, 20)], 0.0, CFG, b, FRAME, SAFE), repr(b))
        self.assertIsNone(rt.plan([piece(10, 20)], 0.0, CFG, "Brand", FRAME, SAFE, name("centre-card")))

    def test_short_reel_and_no_room(self):
        self.assertIsNone(rt.plan([piece(10, 12)], 0.0, CFG, "Brand", FRAME, SAFE))
        rec = rt.plan([piece(50, 56, teaser=True), piece(10, 12)], 0.0, CFG, "Brand", FRAME, SAFE)
        self.assertEqual(rec["start"], 0.0)

    def test_text_is_cleaned_cut_and_shrunk(self):
        rec = rt.plan([piece(10, 20)], 0.0, CFG, "A\nB\x00 " + "x" * 60, FRAME, SAFE)
        self.assertNotRegex(rec["text"], r"[\x00-\x1f]")
        self.assertLessEqual(len(rec["text"]), CFG["maxChars"])
        small = rt.plan([piece(10, 20)], 0.0, CFG, "X" * 24, FRAME, SAFE)["size"]
        self.assertLess(small, rt.plan([piece(10, 20)], 0.0, CFG, "X", FRAME, SAFE)["size"])

    def test_old_rp4_record_becomes_kinetic(self):
        old = {"text": "Brand", "start": 3.0, "end": 4.6, "size": 45, "border": 4, "left": 12, "safeWidth": 324,
               "fadeInMs": 450, "fadeOutMs": 350}
        rec = rt.restyle(old, CFG, FRAME, SAFE)
        self.assertEqual((rec["style"], rec["start"], rec["end"]), ("kinetic", 3.0, 4.6))


class AssTests(unittest.TestCase):
    def test_no_blur_in_any_style(self):
        ps = [piece(1, 4, teaser=True), piece(5, 12)]
        for s in rt.STYLES:
            for v in ("scale-punch", "slice-in"):
                ass = rt.to_ass(rt.plan(ps, 0.0, CFG, "Brand {x}\\N", FRAME, SAFE, name(s, variant=v)), CFG)
                self.assertNotRegex(ass, BLUR, (s, v))
                self.assertIn("Exo 2", ass)
                self.assertNotIn("{x}", ass, "override blocks in the text are neutralised")
                self.assertIn("\\fad(", ass)

    def test_letters_enter_one_by_one(self):
        rec = rt.plan([piece(1, 12)], 0.0, CFG, "ABCD", FRAME, SAFE, name("kinetic"))
        ass = rt.to_ass(rec, CFG)
        starts = [int(x) for x in re.findall(r"\\t\((\d+),\d+,\\alpha&H00&", ass)]
        self.assertEqual(len(starts), 4)
        self.assertEqual(starts, sorted(starts))
        self.assertLess(starts[-1] + CFG["styles"]["kinetic"]["letterMs"], 600)

    def test_graph_uses_libass_and_no_blur(self):
        ps = [piece(1, 4, teaser=True), piece(5, 9), piece(10, 12)]
        d = {"ass": "name.ass", "fontsdir": "title-fonts"}
        g = mont.render_argv("ffmpeg", "s.mp4", ps, FRAME, [], [], 80, "o.mp4", title=d)
        g = g[g.index("-filter_complex") + 1]
        self.assertIn("[vjoin]subtitles=name.ass:fontsdir=title-fonts[vout]", g)
        self.assertNotRegex(g, BLUR)
        g2 = mont.render_argv("ffmpeg", "s.mp4", ps, FRAME, [], [], 80, "o.mp4", title=d, captions="c.ass", thumbnail="t.png")
        g2 = g2[g2.index("-filter_complex") + 1]
        self.assertIn("subtitles=name.ass:fontsdir=title-fonts[vcat]", g2)
        self.assertIn("[vcat]subtitles=c.ass[vcap]", g2)


class WiringTests(unittest.TestCase):
    def test_clipper_title_helper(self):
        import clipper  # noqa: PLC0415
        d = tempfile.mkdtemp(prefix="fx2-")
        try:
            ps = [piece(1, 4, teaser=True), piece(5, 9)]
            self.assertEqual(clipper._title(d, ps, 0.0, FRAME, {"title": None, "safe": SAFE}), (None, None), "flag off")
            self.assertEqual(clipper._title(d, ps, 0.0, FRAME, {"title": CFG, "tbrand": None, "safe": SAFE}), (None, None))
            ttl, rec = clipper._title(d, ps, 0.0, FRAME, {"title": CFG, "tbrand": "Brand", "safe": SAFE})
            self.assertEqual((rec["start"], rec["style"], ttl["ass"]), (3.0, "kinetic", rt.ASS_FILE))
            self.assertTrue(os.path.isfile(os.path.join(d, ttl["fontsdir"], CFG["fontFile"])))
            lk = {"look": {"name": {"position": "auto", "colour": "theme", "sizePct": 100, "durationSec": 2.0}}}
            ex = {"title": CFG, "tbrand": "Brand", "safe": SAFE, "look": lk}
            _, rec = clipper._title(d, ps, 0.0, FRAME, ex, {"name": "corner-tag", "variant": "slice-in"})
            self.assertEqual(rec["style"], "corner-tag")
            self.assertEqual(clipper._title(d, ps, 0.0, FRAME, ex, {"name": None}), (None, None), "no ticks: no name")
            rt.cleanup(d)
            self.assertEqual(os.listdir(d), [], "the ASS file and the font copy are removed after the render")
        finally:
            shutil.rmtree(d, ignore_errors=True)


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    """Source: a dark grey picture with a sharp white grid (a blur would smear it), 9 s, 30 fps, and a tone."""
    PS = [piece(1, 3, teaser=True), piece(4, 8)]

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="fx2-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x303030:s=360x640:r=30:d=9",
                         "-f", "lavfi", "-i", "sine=f=440:d=9", "-vf", "drawgrid=w=24:h=24:t=2:c=white",
                         "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src], timeout=300)
        assert r.returncode == 0, r.stderr
        cls.render("plain.mp4", None)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def render(cls, out, rec):
        d = rt.prepare(cls.tmp, rec, CFG) if rec else None
        argv = mont.render_argv("ffmpeg", cls.src, cls.PS, FRAME, ["-c:v", "libopenh264", "-b:v", "4000k"], ["-c:a", "aac"],
                                80, out, title=d)
        res = cc.run_tool(argv, cwd=cls.tmp, timeout=600)
        rt.cleanup(cls.tmp)
        assert res.returncode == 0, res.stderr

    def gray(self, out, t, crop):
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{t:.3f}", "-i", os.path.join(self.tmp, out),
                         "-frames:v", "1", "-vf", f"crop={crop},format=gray", "-f", "rawvideo", "-y", "g.raw"],
                        cwd=self.tmp, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(os.path.join(self.tmp, "g.raw"), "rb") as f:
            return f.read()

    def yavg_series(self, out):
        p = os.path.join(self.tmp, "y.txt")
        if os.path.exists(p):
            os.remove(p)
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-i", out, "-vf",
                         "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=y.txt", "-f", "null", "-"],
                        cwd=self.tmp, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        ts, ys = [], []
        with open(p, encoding="utf-8") as f:
            for line in f:
                m = re.search(r"pts_time:([\d.]+)", line)
                if m:
                    ts.append(float(m.group(1)))
                m = re.search(r"YAVG=([\d.]+)", line)
                if m:
                    ys.append(float(m.group(1)))
        return ts, ys

    def timings(self, rec, out):
        """(entrance s, exit s) from the frames: the name's share of the picture's mean luma against the plain reel."""
        self.render(out, rec)
        ts, ys = self.yavg_series(out)
        _, ps = self.yavg_series("plain.mp4")
        n = min(len(ys), len(ps))
        diff = [abs(ys[i] - ps[i]) for i in range(n)]
        ts = ts[:n]
        s, e = rec["start"], rec["end"]

        def at(t):
            return diff[min(range(n), key=lambda i: abs(ts[i] - t))]
        settled = at(s + 0.8)
        self.assertGreater(settled, 0.3, "the name is visible")
        moving = [ts[i] for i in range(n) if s - 0.05 <= ts[i] <= s + 1.0 and abs(diff[i] - settled) > 0.08 * settled]
        entrance = (max(moving) + 1 / 30 - s) if moving else 0.0
        before = at(e - 0.45)
        gone = [ts[i] for i in range(n) if e - 0.45 <= ts[i] <= e + 0.3 and diff[i] < 0.08 * before]
        held = [ts[i] for i in range(n) if e - 0.45 <= ts[i] <= e and abs(diff[i] - before) <= 0.08 * before]
        exit_ = min(gone) - max(held)
        return entrance, exit_

    def test_entrance_and_exit_measured(self):
        for st in rt.STYLES:
            rec = rt.plan(self.PS, 0.0, CFG, "BRAND", FRAME, SAFE, name(st))
            if st == "corner-tag":  # measured on a 2 s window too (stays the whole clip otherwise)
                rec = rt.restyle(dict(rec, end=rec["start"] + 2.0), CFG, FRAME, SAFE)
            ent, ex = self.timings(rec, f"{st}.mp4")
            self.assertLess(ent, 0.6 + 1 / 30, f"{st} entrance {ent:.3f}s")
            self.assertLess(ex, 0.4 + 1 / 30, f"{st} exit {ex:.3f}s")
            self.assertGreater(ex, 0.1, f"{st} fades out, no pop")

    def test_picture_away_from_the_name_is_not_blurred(self):
        for st, crop in (("lower-third", "360:200:0:40"), ("kinetic", "360:200:0:400"), ("corner-tag", "360:200:0:400")):
            rec = rt.plan(self.PS, 0.0, CFG, "BRAND", FRAME, SAFE, name(st))
            self.render(f"nb-{st}.mp4", rec)
            t = rec["start"] + 1.0
            a, b = self.gray("plain.mp4", t, crop), self.gray(f"nb-{st}.mp4", t, crop)
            self.assertEqual(len(a), len(b))
            mad = sum(abs(x - y) for x, y in zip(a, b)) / len(a)
            self.assertLess(mad, 3.0, f"{st}: the grid away from the name is unchanged (mean abs diff {mad:.2f})")


if __name__ == "__main__":
    unittest.main()
