# SPDX-License-Identifier: GPL-3.0-or-later
"""RL4 realism looks on reels (services/clip/clip_realism.py, clip_montage.render_argv realism=, clipper, D445).

- The look library as the studio reads it; the clips.realismLooks settings model (same rules as user-settings.mjs).
- The seeded pick: one look, or random from the ticks; the same reel draws the same look every time.
- The ffmpeg filter strings: every amount comes from the look JSON (golden strings at 1080x1920).
- The mixed LUT (the look's .cube mixed with the identity by its amount).
- clip_montage.render_argv: no realism = the very same argv as before; with it, the fragment once on the joined picture.
- A real render (libopenh264, 270x480, 3 s synthetic bars + tone; skip without ffmpeg or numpy): the colour of each
  swatch reference bar moves the way the look's swatch says, at most 3 flashes/s, one audio stream, and the audio is
  bit-identical to the same reel made without the look.
Synthetic pictures and tones only; studio-safe (CPU encoder)."""

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "services", "clip"))
sys.path.insert(0, HERE)

import clip_montage as mont  # noqa: E402
import clip_realism as cr  # noqa: E402

try:
    import numpy as np
    from test_reel_transition_sets import flashes_per_second
except ImportError:
    np = None

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
ENC = ["-c:v", "libopenh264", "-b:v", "6000k", "-g", "60"]
AUD = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]
SWATCH_REFS = [(0.15, 0.15, 0.15), (0.87, 0.65, 0.52), (0.33, 0.47, 0.22), (0.45, 0.62, 0.85), (0.8, 0.12, 0.1)]
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def _settings(data, value):
    os.makedirs(data, exist_ok=True)
    with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
        json.dump({"clips": {"realismLooks": value}}, f)


class LibraryAndSettingsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ujw-rl4-")
        self.looks = cr.load_looks()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_library(self):
        ids = [x["id"] for x in self.looks]
        self.assertEqual(ids[0], "filmic")
        self.assertEqual(set(ids), {"filmic", "cinematic", "cold-high-key", "dark-cinematic", "gritty-war", "hdr-vivid", "night-neon"})
        for lk in self.looks:
            self.assertTrue(os.path.isfile(os.path.join(cr.LUTS_DIR, lk["effects"][0]["file"]["rel"])), lk["id"])

    def test_broken_file_skipped(self):
        d = os.path.join(self.tmp, "looks")
        os.makedirs(d)
        with open(os.path.join(d, "bad.json"), "w") as f:
            f.write("{not json")
        with open(os.path.join(d, "wrong-name.json"), "w") as f:
            json.dump(dict(self.looks[0], id="other"), f)
        with open(os.path.join(d, "filmic.json"), "w") as f:
            json.dump(self.looks[0], f)
        self.assertEqual([x["id"] for x in cr.load_looks(d)], ["filmic"])

    def test_problems(self):
        ok = {"byType": {"reel": {"mode": "one", "look": "cinematic", "ticks": []},
                         "impact": {"mode": "random", "look": None, "ticks": ["filmic", "night-neon"]},
                         "montage": {"mode": "off"}}}
        self.assertEqual(cr.problems(ok), [])
        self.assertEqual(cr.problems(ok, [x["id"] for x in self.looks]), [])
        self.assertEqual(cr.problems({}), [])
        bad = [({"byType": {"long": {"mode": "off"}}}, "unknown reel type"),
               ({"byType": {"reel": {"mode": "sometimes"}}}, "mode must be"),
               ({"byType": {"reel": {"mode": "one"}}}, "needs the look"),
               ({"byType": {"reel": {"mode": "one", "look": "../x"}}}, "look id"),
               ({"byType": {"reel": {"mode": "random", "ticks": ["a1", "a1"]}}}, "different look ids"),
               ({"byType": {"reel": {"mode": "off", "extra": 1}}}, "unknown"),
               ({"pool": []}, "unknown clips.realismLooks setting pool"),
               ([], "must be an object")]
        for v, msg in bad:
            self.assertIn(msg, "; ".join(cr.problems(v)), v)
        self.assertIn("unknown look", "; ".join(cr.problems({"byType": {"reel": {"mode": "one", "look": "gone"}}}, ["filmic"])))

    def test_effective_defaults_off(self):
        self.assertEqual(cr.effective(None), {t: {"mode": "off", "look": None, "ticks": []} for t in cr.REEL_TYPES})
        _settings(self.tmp, {"byType": {"reel": {"mode": "sometimes"}}})  # a bad value is all off, never a crash
        self.assertEqual(cr.effective(self.tmp)["reel"]["mode"], "off")
        _settings(self.tmp, {"byType": {"montage": {"mode": "one", "look": "gritty-war"}}})
        e = cr.effective(self.tmp)
        self.assertEqual((e["montage"]["mode"], e["montage"]["look"], e["reel"]["mode"]), ("one", "gritty-war", "off"))

    def test_pick(self):
        _settings(self.tmp, {"byType": {"reel": {"mode": "one", "look": "cinematic"},
                                        "impact": {"mode": "random", "ticks": ["filmic", "night-neon", "gritty-war"]},
                                        "montage": {"mode": "random", "ticks": ["not-installed"]}}})
        lk, rec = cr.pick(self.tmp, "reel", ("R1", "v.mkv"))
        self.assertEqual((lk["id"], rec["mode"]), ("cinematic", "one"))
        self.assertEqual(cr.pick(self.tmp, "nope", ("x",)), (None, None))
        lk, rec = cr.pick(self.tmp, "montage", ("M1",))
        self.assertIsNone(lk)
        self.assertIn("no ticked look", rec["skipped"])
        drawn = {}
        for i in range(40):
            a, rec = cr.pick(self.tmp, "impact", (f"I{i}", "v.mkv"))
            b, _ = cr.pick(self.tmp, "impact", (f"I{i}", "v.mkv"))
            self.assertEqual(a["id"], b["id"], "a re-render draws the same look")
            self.assertEqual(rec["from"], ["filmic", "night-neon", "gritty-war"])
            drawn[a["id"]] = drawn.get(a["id"], 0) + 1
        self.assertEqual(set(drawn), {"filmic", "night-neon", "gritty-war"}, drawn)
        _settings(self.tmp, {"byType": {"reel": {"mode": "one", "look": "gone"}}})
        lk, rec = cr.pick(self.tmp, "reel", ("R1",))
        self.assertIsNone(lk)
        self.assertIn("not installed", rec["skipped"])


def _look(i):
    return cr.look_by_id(i)


class FilterTests(unittest.TestCase):
    def test_filmic_golden(self):
        frag, steps = cr.filter_graph(_look("filmic"), 1080, 1920, 7)
        self.assertEqual(frag, "[rin]" + cr.CLEAN + ",format=gbrp,lut3d=file=realism.cube:interp=tetrahedral,format=yuv444p,"
                         "cas=strength=0.300:planes=1,vignette=angle=0.2814:eval=init,format=yuv420p[rout]")
        self.assertEqual(steps, ["clean", "lut", "sharpen", "vignette"])

    def test_cinematic_bloom_grain(self):
        frag, steps = cr.filter_graph(_look("cinematic"), 1080, 1920, 12345)
        self.assertEqual(frag, "[rin]" + cr.CLEAN + ",format=gbrp,lut3d=file=realism.cube:interp=tetrahedral[rl0];"
                         "[rl0]split=2[rla][rlb];"
                         "[rlb]scale=540:960:flags=bilinear,lutrgb=r='clip((val-204)*255/51,0,255)':g='clip((val-204)*255/51,0,255)':"
                         "b='clip((val-204)*255/51,0,255)',gblur=sigma=8.10:steps=2,scale=1080:1920:flags=bilinear,format=gbrp[rlg];"
                         "[rla][rlg]blend=all_mode=screen:all_opacity=0.300,format=yuv444p,vignette=angle=0.3508:eval=init,"
                         "noise=c0s=4:c0f=t+u:all_seed=12345,format=yuv420p[rout]")
        self.assertEqual(steps, ["clean", "lut", "bloom", "vignette", "grain"])

    def test_amounts_from_the_look(self):
        frag, steps = cr.filter_graph(_look("night-neon"), 1080, 1920, 1)
        self.assertIn("rgbashift=rh=-2:bh=2:edge=smear", frag)  # 0.3 x 0.5 % x 1080 = 1.6 -> 2 px
        self.assertIn("blend=all_mode=screen:all_opacity=0.900", frag)  # 2 x 0.45
        self.assertIn("val-153", frag)  # threshold 0.6
        self.assertIn("chromatic 2px", steps)
        frag, _ = cr.filter_graph(_look("hdr-vivid"), 1080, 1920, 1)
        self.assertIn("unsharp=lx=13:ly=13:la=0.450:cx=3:cy=3:ca=0", frag)  # 2.5 % of 1080 = 27 -> capped at 13 (ffmpeg: lx + ly <= 25)
        frag, _ = cr.filter_graph(_look("gritty-war"), 1080, 1920, 1)
        self.assertIn("unsharp=lx=13:ly=13:la=0.300", frag)
        self.assertIn("noise=c0s=12:", frag)  # 0.18 x 64
        self.assertLess(frag.index("unsharp"), frag.index("noise=c0s"), "grain last: never sharpened")
        frag, steps = cr.filter_graph(_look("night-neon"), 270, 480, 1)
        self.assertNotIn("rgbashift", frag, "a fringe under 1 px is left out")
        for lk in cr.load_looks():  # every look's fragment ends in 4:2:0 and has only its own labels
            frag, _ = cr.filter_graph(lk, 1080, 1920, 1)
            self.assertTrue(frag.endswith("format=yuv420p[rout]"), lk["id"])
            import re  # noqa: PLC0415
            self.assertEqual({x for x in re.findall(r"\[([a-z0-9]+)\]", frag)} - {"rin", "rout"},
                             {"rl0", "rla", "rlb", "rlg"} if any(e["type"] == "bloom" for e in lk["effects"]) else set(), lk["id"])

    def test_vignette_matches_host_corner(self):
        for lk in cr.load_looks():
            for e in lk["effects"]:
                if e["type"] != "vignette":
                    continue
                t = max(0.0, min(1.0, (1.0 - e["size"]) / e["softness"]))
                host = 1.0 - e["amount"] * t * t * (3 - 2 * t)
                self.assertAlmostEqual(math.cos(cr.vignette_angle(e)) ** 4, host, places=6, msg=lk["id"])
        self.assertIsNone(cr.vignette_angle({"amount": 0.0, "size": 0.5, "softness": 0.5}))

    def test_mixed_lut(self):
        tmp = tempfile.mkdtemp(prefix="ujw-rl4-lut-")
        try:
            lk = _look("dark-cinematic")
            out = os.path.join(tmp, "x.cube")
            self.assertEqual(cr.write_lut(out, lk), 0.9)
            n, src = cr.read_cube(os.path.join(cr.LUTS_DIR, lk["effects"][0]["file"]["rel"]))
            n2, mixed = cr.read_cube(out)
            self.assertEqual(n, n2)
            for i in (0, 1234, n ** 3 - 1):
                ident = ((i % n) / (n - 1), ((i // n) % n) / (n - 1), (i // (n * n)) / (n - 1))
                for c in range(3):
                    self.assertAlmostEqual(mixed[i][c], ident[c] + (src[i][c] - ident[c]) * 0.9, places=5)
            off = dict(lk, effects=[dict(lk["effects"][0], amount=0.0)] + lk["effects"][1:])
            cr.write_lut(out, off)
            _, ident_rows = cr.read_cube(out)
            self.assertAlmostEqual(ident_rows[n * n * 5 + n * 3 + 7][0], 7 / (n - 1), places=5)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class MontageGraphTests(unittest.TestCase):
    PIECES = [{"start": 0.0, "end": 1.5, "kills": 1}, {"start": 1.5, "end": 3.0, "kills": 1}]
    FRAME = {"width": 270, "height": 480}

    def argv(self, **kw):
        return mont.render_argv("ffmpeg", "src.mp4", self.PIECES, self.FRAME, ENC, AUD, 30, "out.mp4", **kw)

    def graph(self, **kw):
        a = self.argv(**kw)
        return a[a.index("-filter_complex") + 1]

    def test_no_realism_unchanged(self):
        self.assertEqual(self.argv(), self.argv(realism=None))
        g = self.graph(lut="style.cube")
        self.assertIn("[vgr]lut3d=file=style.cube:interp=tetrahedral,format=yuv420p[vfin]", g)

    def test_realism_once_after_the_joins(self):
        frag, _ = cr.filter_graph(_look("cinematic"), 270, 480, 3)
        g = self.graph(realism=frag)
        self.assertEqual(g.count("lut3d="), 1)
        self.assertIn("[vgr]" + cr.CLEAN, g)
        self.assertIn("format=yuv420p[vfin]", g)
        self.assertNotIn("[rin]", g)
        self.assertNotIn("[rout]", g)
        z = {"times": [1.0], "scale": 1.1, "inSec": 0.15, "outSec": 0.2}
        g = self.graph(realism=frag, zoom=z, fx="[fxin]null[fxout]")
        self.assertIn("format=yuv420p[vpost];[vpost]" + cr.CLEAN, g)  # zoom first, then the look, then the effects
        self.assertIn("format=yuv420p[vst1];[vst1]null[vfin]", g)


def _run(argv, cwd=None):
    return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)


def make_source(path, w=270, h=480, sec=3.0):
    """Five swatch reference bars across the middle (left 3/4 of the width), a moving test pattern in the right quarter
    (so the clean-up and grain see motion), and a 440 Hz tone."""
    bh = h // 10
    parts, ins = [], ["-f", "lavfi", "-i", f"color=c=0x808080:s={w}x{h}:r=30:d={sec}"]
    for i, (r, g, b) in enumerate(SWATCH_REFS):
        ins += ["-f", "lavfi", "-i", f"color=c=0x{round(r * 255):02x}{round(g * 255):02x}{round(b * 255):02x}:s={w * 3 // 4}x{bh}:r=30:d={sec}"]
    ins += ["-f", "lavfi", "-i", f"testsrc2=s={w // 4}x{h}:r=30:d={sec}", "-f", "lavfi", "-i", f"sine=f=440:r=48000:d={sec}"]
    cur = "[0:v]"
    for i in range(5):
        parts.append(f"{cur}[{i + 1}:v]overlay=0:{h // 4 + i * bh}[b{i}]")
        cur = f"[b{i}]"
    parts.append(f"{cur}[6:v]overlay={w * 3 // 4}:0,format=yuv420p[v]")
    r = _run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", ";".join(parts), "-map", "[v]", "-map", "7:a",
              "-ac", "2", *ENC, *AUD, "-shortest", path])
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-400:])
    return bh


def frames_of(path, w, h):
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True,
                       stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    return np.frombuffer(r.stdout, np.uint8).reshape(-1, h, w, 3)


def audio_md5(path):
    return _run(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a", "-c", "copy", "-f", "md5", "-"]).stdout.strip()


def audio_streams(path):
    r = _run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path])
    return len([x for x in r.stdout.split() if x.strip()])


def bar_colours(frames, h, w, bh):
    """Mean RGB (0..1) of the middle of each bar (away from the vignette's edge and the bar borders), over frames."""
    out = []
    for i in range(5):
        y0 = h // 4 + i * bh + bh // 3
        out.append(frames[:, y0:y0 + bh // 3, w // 4:w // 2].reshape(-1, 3).mean(axis=0) / 255.0)
    return out


def identity_of(look):
    """The same pipeline (clean-up, RGB round trip, LUT at amount 0) with no colour change: the baseline the colour
    part is measured against (the RGB round trip alone moves a flat colour by about 1/255)."""
    return dict(look, effects=[dict(look["effects"][0], amount=0.0)])


def colour_only(look):
    """The look with its place-dependent and light-dependent effects left out (vignette, bloom, grain, chromatic): the
    swatch says what the colour part does to a flat colour; the vignette darkens the bars by up to 5 % off centre and
    bloom brightens the brightest bar, either of which is larger than some swatch shifts (2-3 %)."""
    return dict(look, effects=[e for e in look["effects"] if e["type"] not in ("vignette", "bloom", "grain", "chromatic")])


def swatch_direction(look, plain, graded):
    """Per reference bar: the cosine between the measured colour change and the look's swatch change, with the
    swatch change's size; bars the look barely moves (< 4/255) are left out."""
    res = []
    for i, ref in enumerate(SWATCH_REFS):
        want = np.array([int(look["swatch"][i][k:k + 2], 16) / 255.0 for k in (1, 3, 5)]) - np.array(ref)
        got = graded[i] - plain[i]
        if np.linalg.norm(want) < 4 / 255:
            continue
        res.append((i, float(np.dot(want, got) / (np.linalg.norm(want) * max(np.linalg.norm(got), 1e-6))),
                    float(np.linalg.norm(want)), float(np.linalg.norm(got))))
    return res


@unittest.skipUnless(np is not None and HAVE_FFMPEG, "numpy or ffmpeg missing (use the project venv)")
class RenderTests(unittest.TestCase):
    W, H = 270, 480

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ujw-rl4-render-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        cls.bh = make_source(cls.src, cls.W, cls.H)
        cls.plain = cls.render(None, "plain.mp4")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def render(cls, look, name):
        pieces = [{"start": 0.0, "end": 1.5, "kills": 1}, {"start": 1.5, "end": 3.0, "kills": 1}]
        frag = None
        if look:
            frag, _ = cr.plan(look, cls.tmp, {"width": cls.W, "height": cls.H}, ("R1", "src.mp4"))
        argv = mont.render_argv("ffmpeg", cls.src, pieces, {"width": cls.W, "height": cls.H}, ENC, AUD, 30, name,
                                audio_tracks=1, realism=frag)
        r = _run(argv, cwd=cls.tmp)
        cr.cleanup(cls.tmp)
        if r.returncode != 0:
            raise AssertionError(r.stderr[-600:])
        return os.path.join(cls.tmp, name)

    def test_every_look(self):
        plain_f = frames_of(self.plain, self.W, self.H)
        plain_c = bar_colours(plain_f, self.H, self.W, self.bh)
        md5 = audio_md5(self.plain)
        for lk in cr.load_looks():
            with self.subTest(look=lk["id"]):
                out = self.render(lk, f"{lk['id']}.mp4")
                self.assertEqual(audio_streams(out), 1)
                self.assertEqual(audio_md5(out), md5, "the sound is the same as without the look")
                f = frames_of(out, self.W, self.H)
                self.assertEqual(len(f), len(plain_f))
                self.assertLessEqual(flashes_per_second(f, 60), 3.0)
                c = self.render(colour_only(lk), f"{lk['id']}-colour.mp4")
                base = bar_colours(frames_of(self.render(identity_of(lk), "identity.mp4"), self.W, self.H), self.H, self.W, self.bh)
                d = swatch_direction(lk, base, bar_colours(frames_of(c, self.W, self.H), self.H, self.W, self.bh))
                self.assertTrue(d, "the look moves at least one reference colour")
                for i, cos, want, got in d:
                    self.assertGreater(cos, 0.8, f"bar {i}: the colour moves the way the swatch says ({d})")
                    self.assertTrue(0.4 * want <= got <= 2.0 * want, f"bar {i}: by about as much ({d})")


if __name__ == "__main__":
    unittest.main()
