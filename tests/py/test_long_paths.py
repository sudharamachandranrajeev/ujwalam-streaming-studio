# SPDX-License-Identifier: GPL-3.0-or-later
"""LV1c (D423): movement paths on the long highlights video (services/clip/long_paths.py). Synthetic frames only: a
red name-tag-like bar moving over a grey picture. Tracking accuracy on the user's footage is UNVERIFIED."""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:  # tracking needs numpy and OpenCV (the shipped runtime has both; CI's plain Python may not)
    import cv2  # noqa: F401
    import numpy as np
except ImportError:
    np = None
NEEDS_CV = unittest.skipUnless(np is not None, "needs numpy and OpenCV")

import long_paths as lp  # noqa: E402
import long_teaching as lt  # noqa: E402
import long_video as lv  # noqa: E402
import reel_captions as rcap  # noqa: E402

NOWIN = 0x08000000 if os.name == "nt" else 0
W, H = 480, 270
FRAME = {"width": 1920, "height": 1080}


def spec():
    return lp.load_game("codm")[0]


def pcfg(**kw):
    return dict(lt.check(lv.load_config()["teaching"])["paths"], **kw)


def tag(img, x, y, colour=(230, 30, 30)):
    """A name-tag-like mark centred at (x, y): four 'letters' 3 px wide with 1 px gaps (joinPx closes them)."""
    for k in range(4):
        x0 = int(x) - 8 + k * 4
        img[int(y) - 2:int(y) + 2, x0:x0 + 3] = colour


def frames_along(path, extra=None):
    out = []
    for i, (x, y) in enumerate(path):
        f = np.full((H, W, 3), 90, np.uint8)
        tag(f, x, y)
        for ex in (extra or []):
            tag(f, *ex(i))
        out.append(f)
    return out


@NEEDS_CV
class Track(unittest.TestCase):
    def test_spec_is_game_data(self):
        s = spec()
        self.assertEqual(s["status"], "unverified")
        self.assertEqual(lp.load_game("../codm"), (None, []), "a game id is never a path")
        self.assertEqual(lp.load_game("nogame")[0], None)

    def test_letters_join_into_one_tag(self):
        f = np.full((H, W, 3), 90, np.uint8)
        tag(f, 100, 50)
        pts = lp.tag_points(f, spec())
        self.assertEqual(len(pts), 1)
        self.assertAlmostEqual(pts[0][0], 99.5, delta=1.5)
        g = np.full((H, W, 3), 90, np.uint8)
        g[40:60, 40:200] = (230, 30, 30)  # a big red area is not a tag
        tag(g, 300, 100, colour=(30, 30, 230))  # nor is a blue one
        self.assertEqual(lp.tag_points(g, spec()), [])

    def test_follows_the_tag_back_from_the_kill(self):
        path = [(140 + 3 * i, 90 + i) for i in range(30)]  # ends near the centre (230, 119)
        frames = frames_along(path, extra=[lambda i: (60, 230)])  # a second tag far from the crosshair
        pts, info = lp.track(frames, spec(), pcfg())
        self.assertEqual(len(pts), 30, info)
        for (f, x, y), (px, py) in zip(pts, path):
            self.assertLess(abs(x - (px - 0.5)) + abs(y - (py - 0.5)), 3.0, f)
        self.assertTrue(lp.confident(pts, (W, H), pcfg()))

    def test_crosshair_is_the_game_centre(self):
        # the game fills the left half of the canvas: its crosshair is at x 120, not the canvas centre 240
        path = [(60 + 2 * i, 100 + i) for i in range(30)]  # ends at (118, 129)
        frames = frames_along(path, extra=[lambda i: (236, 133)])  # a tag at the canvas centre
        area = lp.game_area((W, H), (1920, 1080), {"game": [0, 0, 960, 1080], "visible": [0, 0, 960, 1080]})
        self.assertEqual(area, (0.0, 0.0, 240.0, 270.0))
        cut = lp.game_area((W, H), (1920, 1080), {"game": [-480, 0, 1920, 1080], "visible": [0, 0, 1440, 1080]})
        self.assertEqual((cut[0] + cut[2]) / 2, 120.0, "the crosshair stays at the whole game's centre when cut")
        pts, _ = lp.track(frames, spec(), pcfg(), area=area)
        self.assertLess(abs(pts[-1][1] - 117.5), 2)
        pts, _ = lp.track(frames, spec(), pcfg())
        self.assertGreater(pts[-1][1], 200, "without the area the canvas centre tag is taken")

    def test_no_tag_at_the_crosshair_no_path(self):
        frames = frames_along([(40, 40)] * 20)
        self.assertEqual(lp.track(frames, spec(), pcfg())[0], [])

    def test_lost_for_too_long_stops_and_a_jump_is_not_followed(self):
        path = [(140 + 3 * i, 120) for i in range(30)]
        frames = frames_along(path)
        for i in range(5, 12):  # gone for 7 frames (lostFrames 4)
            frames[i][:] = 90
        pts, _ = lp.track(frames, spec(), pcfg())
        self.assertEqual(pts[0][0], 12, "tracking ends at the gap")
        jumpy = frames_along([(140 + 3 * i, 120) if i > 10 else (400, 30) for i in range(30)])
        pts, _ = lp.track(jumpy, spec(), pcfg())
        self.assertEqual(pts[0][0], 11, "a tag far away is another enemy")

    def test_hud_and_outside_the_game_are_masked(self):
        keep = lp.keep_mask((W, H), (1920, 1080), None, [{"x0": 0.4, "y0": 0.4, "x1": 0.6, "y1": 0.6}])
        f = np.full((H, W, 3), 90, np.uint8)
        tag(f, 240, 135)
        self.assertEqual(lp.tag_points(f, spec(), keep), [])
        keep = lp.keep_mask((W, H), (1920, 1080), {"game": [0, 0, 960, 1080], "visible": [0, 0, 960, 1080]}, [])
        g = np.full((H, W, 3), 90, np.uint8)
        tag(g, 400, 100)  # right half: outside the game
        self.assertEqual(lp.tag_points(g, spec(), keep), [])

    def test_confidence_needs_points_and_travel(self):
        still = [(i, 200.0, 100.0) for i in range(40)]
        self.assertFalse(lp.confident(still, (W, H), pcfg()), "a tag that did not move draws nothing")
        self.assertFalse(lp.confident([(0, 0.0, 0.0), (1, 200.0, 0.0)], (W, H), pcfg()), "too few points")

    def test_smooth_and_frame_mapping(self):
        pts = [(i, float(i % 2) * 10, 0.0) for i in range(9)]
        sm = lp.smooth(pts, 3)
        self.assertEqual(len(sm), 9)
        self.assertLess(max(p[1] for p in sm[1:-1]) - min(p[1] for p in sm[1:-1]), 10)
        self.assertEqual(lp.to_frame([(0, 240.0, 135.0)], (W, H), (1920, 1080), FRAME), [(0, 960.0, 540.0)])
        x = lp.to_frame([(0, 0.0, 0.0)], (W, H), (1440, 1080), FRAME)[0][1]
        self.assertAlmostEqual(x, 240.0, msg="a 4:3 recording is pillarboxed")


class Draw(unittest.TestCase):
    def test_draw_on_events(self):
        pts = [(i, 100.0 + 10 * i, 200.0) for i in range(10)]
        ev = lp.path_events(pts, 30.0, 5.0, 100.0, pcfg(stepFrames=2, holdSec=0.8, fadeMs=300))
        lines = [e for e in ev if ",Path," in e]
        self.assertEqual(len(lines), 5)  # points 1, 3, 5, 7, 9
        self.assertTrue(lines[0].startswith("Dialogue: 2,0:00:05.03"))
        self.assertIn("\\fad(0,300)", lines[-1])
        self.assertNotIn("\\fad", lines[0])
        self.assertIn("m 100 200 l 110 200 100 200", lines[0])  # out and back: a stroke, not a filled shape
        self.assertEqual(len([e for e in ev if ",PathDot," in e]), 5)
        capped = lp.path_events(pts, 30.0, 5.0, 5.2, pcfg(stepFrames=2))
        self.assertTrue(all(e.split(",")[2] <= "0:00:05.20" for e in capped), "nothing after t_max")
        self.assertEqual(lp.path_events(pts[:1], 30.0, 0.0, 9.0, pcfg()), [])

    @NEEDS_CV
    def test_batch_paths_with_a_fake_decode(self):
        path = [(140 + 3 * i, 90 + i) for i in range(30)]
        seen = []

        def dec(start, sec):
            seen.append((round(start, 3), round(sec, 3)))
            return frames_along(path)
        pctx = {"pcfg": pcfg(trackSec=1.0), "spec": spec(), "hud": [], "layout": None, "rec_size": (1920, 1080),
                "accent": "#FF3366"}
        chunk = [{"start": 100.0, "end": 110.0, "lastKills": [104.0, 106.0]},
                 {"start": 200.0, "end": 210.0, "lastKills": []},
                 {"start": 300.0, "end": 301.0, "lastKills": [300.1]}]
        st, ev, n = lp.batch_paths("ffmpeg", "rec.mkv", chunk, [0.0, 9.75, 19.5], 0.25, FRAME, pctx, ".", decode_fn=dec)
        # two fights (2 s apart > trackSec + holdSec): two paths; the kill before the third moment's cross fade in
        # is skipped, never moved (Codex)
        self.assertEqual(n, 2)
        self.assertEqual(seen, [(103.0, 1.033), (105.0, 1.033)])
        self.assertEqual(len(st), 2)
        self.assertTrue(ev[0].startswith("Dialogue: 2,0:00:03.0"))

    def test_path_kills(self):
        c = pcfg(trackSec=2.5, holdSec=0.8, minPoints=15, fps=30)  # a window needs 0.5 s
        self.assertEqual(lp.path_kills([10.0, 11.0, 12.0], 0.0, 20.0, c), [(7.5, 10.0), (10.8, 12.0)],
                         "a kill too soon after a path is skipped; the next one that fits gets its own")
        self.assertEqual(lp.path_kills([10.0, 14.0], 0.0, 20.0, c), [(7.5, 10.0), (11.5, 14.0)])
        self.assertEqual(lp.path_kills([10.0, 12.0], 0.0, 20.0, c), [(7.5, 10.0), (10.8, 12.0)],
                         "kills of two merged moments 2 s apart both get a path (Codex verify)")
        self.assertEqual(lp.path_kills([19.9], 0.0, 19.75, c), [], "a kill in the cross fade out is skipped")
        self.assertEqual(lp.path_kills([1.0], 0.5, 9.0, c), [(0.5, 1.0)])
        self.assertEqual(lp.path_kills([0.7], 0.5, 9.0, c), [], "too short a window")

    def test_event_times_count_from_the_decode_start(self):
        pts = [(30 + i, 100.0 + 10 * i, 200.0) for i in range(10)]  # the tag was found 1 s into the window
        ev = lp.path_events(pts, 30.0, 5.0, 100.0, pcfg(stepFrames=2))
        self.assertTrue(ev[0].startswith("Dialogue: 2,0:00:06.03"), ev[0])

    @NEEDS_CV
    def test_overlay_carries_the_paths_and_survives_a_failure(self):
        cfg = lv.load_config()
        tcfg = lt.check(cfg["teaching"])
        path = [(140 + 3 * i, 90 + i) for i in range(30)]
        ctx = {"tcfg": tcfg, "style": lt.caption_style(rcap.load_config(), tcfg), "accent": "#FF3366", "ccfg": None,
               "opts": {}, "paths": {"pcfg": pcfg(trackSec=1.0), "spec": spec(), "hud": [], "layout": None,
                                     "rec_size": (1920, 1080), "accent": "#FF3366"}}
        chunk = [{"start": 0.0, "end": 10.0, "kills": 1, "kinds": ["kills"], "lastKills": [5.0]}]
        with tempfile.TemporaryDirectory() as d:
            ass, _, info = lt.batch_overlay("ffmpeg", "rec.mkv", chunk, 1, None, FRAME, d, ctx,
                                            decode=lambda s, n: frames_along(path))
            self.assertEqual(info["paths"], 1)
            with open(os.path.join(d, ass), encoding="utf-8") as f:
                text = f.read()
            self.assertIn("Style: Path,", text)
            self.assertIn(",Path,", text)

            def boom(s, n):
                raise RuntimeError("decoder gone")
            ass, _, info = lt.batch_overlay("ffmpeg", "rec.mkv", chunk, 1, None, FRAME, d, ctx, decode=boom)
            self.assertIsNotNone(ass, "the chapter card is still drawn")
            self.assertEqual((info["paths"], info["chapters"]), (0, 1))
            self.assertIn("paths not drawn", info["reason"])

    def test_context(self):
        with tempfile.TemporaryDirectory() as d:
            c = lt.context(d, lv.load_config(), rec_size=(1920, 1080), game="codm")
            self.assertEqual(c["paths"]["spec"]["status"], "unverified")
            self.assertIsNone(lt.context(d, lv.load_config(), rec_size=(1920, 1080))["paths"], "no game: no paths")
            self.assertEqual(lt.merge_info([{"status": "off", "paths": 2}])["paths"], 2)


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class Burn(unittest.TestCase):
    def test_libass_draws_the_path(self):
        """The path ASS burned on a black 320x180 picture: accent pixels appear along the path, none before it."""
        frame = {"width": 320, "height": 180}
        cfg = pcfg(stepFrames=2, holdSec=0.5, strokePx=6)
        pts = [(i, 40.0 + 8 * i, 90.0) for i in range(20)]
        ev = lp.path_events(pts, 10.0, 0.5, 4.0, cfg)
        script = ("[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n\n[V4+ Styles]\n"
                  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
                  "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
                  "Alignment, MarginL, MarginR, MarginV, Encoding\n" + "\n".join(lp.path_styles(cfg, "#FF00FF"))
                  + "\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                  + "\n".join(ev) + "\n")
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "p.ass"), "w", encoding="utf-8") as f:
                f.write(script)
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                                f"color=c=black:size=320x180:rate=10:duration=3", "-vf", "subtitles=p.ass",
                                "-f", "rawvideo", "-pix_fmt", "rgb24", "out.rgb"], cwd=d, capture_output=True,
                               timeout=120, creationflags=NOWIN)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            raw = open(os.path.join(d, "out.rgb"), "rb").read()
        n = 320 * 180 * 3
        frames = [raw[i * n:(i + 1) * n] for i in range(len(raw) // n)]

        def accent_cols(f):
            cols = set()
            for k in range(0, len(f), 3):
                if f[k] > 180 and f[k + 1] < 90 and f[k + 2] > 180:
                    cols.add((k // 3) % 320)
            return cols
        self.assertEqual(accent_cols(frames[2]), set(), "nothing before the path starts")
        early, late = accent_cols(frames[8]), accent_cols(frames[22])
        self.assertTrue(early and late)
        self.assertGreater(max(late), max(early) + 40, "the path grows with the action")


if __name__ == "__main__":
    unittest.main()
