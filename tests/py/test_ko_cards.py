# SPDX-License-Identifier: GPL-3.0-or-later
"""D439 K.O. cards on the long highlights video (services/clip/long_teaching.py, registry ko-card + presets, data
long-video.json teaching.koCards, Settings > Clips clips.look.cards). Synthetic moments only. Done when: each of the
five styles is a registry preset whose ASS keeps every move inside the entrance (< 600 ms) or the exit (< 400 ms);
the pick is seeded (same seed, same list) and never repeats the last two while another style is free; the wording
table fits kills, streaks and wins; no ticks = no cards; a real ffmpeg/libass burn of all five styles runs and the fx
test analyser counts no flash over 3 per second. The look on a real long video is UNVERIFIED (by eye)."""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import beatdrop_fx as bfx  # noqa: E402
import clip_common as cc  # noqa: E402
import long_teaching as lt  # noqa: E402
import long_video as lv  # noqa: E402
import reel_captions as rcap  # noqa: E402

NOWIN = 0x08000000 if os.name == "nt" else 0
FRAME = {"width": 1920, "height": 1080}
_T = re.compile(r"\\t\((\d+),(\d+),")
_MOVE = re.compile(r"\\move\([^)]*,(\d+),(\d+)\)")


def _ctx():
    tcfg = lt.check(lv.load_config()["teaching"])
    return tcfg, lt.caption_style(rcap.load_config(), tcfg)


def _windows(text):
    return [(int(a), int(b)) for a, b in _T.findall(text)] + [(int(a), int(b)) for a, b in _MOVE.findall(text)]


class Registry(unittest.TestCase):
    def test_five_distinct_presets_of_one_function(self):
        m = bfx.manifest(lt.KO_FUNCTION)
        self.assertEqual(m["flashesPerSec"], 0)
        self.assertEqual(m["format"], "post-render")
        anims = set()
        for st in lt.KO_STYLES:
            pr = bfx.preset(f"ko-card-{st}")
            self.assertEqual(pr["function"], lt.KO_FUNCTION)
            self.assertEqual(pr["tags"]["flashes"], "none")
            anims.add(lt.ko_params(st)["anim"])
        self.assertEqual(len(lt.KO_STYLES), 5)
        self.assertEqual(len(anims), 5, "each style is its own animation")

    def test_look_options_match_the_presets(self):
        import clip_look as look  # noqa: PLC0415
        cfg = look.load_config()
        self.assertEqual([o["id"] for o in cfg["groups"]["cards"]["options"]], list(lt.KO_STYLES))
        self.assertEqual(cfg["defaults"]["cards"]["styles"], list(lt.KO_STYLES))
        self.assertEqual(cfg["historyN"]["cards"], 2)


class Timing(unittest.TestCase):
    def test_every_style_inside_the_overlay_rule(self):
        tcfg, _ = _ctx()
        kc = tcfg["koCards"]
        for st in lt.KO_STYLES:
            p = lt.ko_params(st)
            fin, fout = int(p["inMs"]), int(p["outMs"])
            self.assertLess(fin, 600)
            self.assertLess(fout, 400)
            for d_ms in (2400, 1200):  # a full card and one cut short by a short moment
                with self.subTest(style=st, d_ms=d_ms):
                    lines = lt._ko_lines(p["anim"], p, "DOUBLE K.O.", "2 kills", 960, 260, 100, d_ms, kc, "#FF3366")
                    self.assertTrue(lines)
                    for _layer, until, _sty, text in lines:
                        self.assertEqual(text.count("{"), text.count("}"), text)
                        for a, b in _windows(text):
                            self.assertLessEqual(a, b)
                            inside_in = b <= fin
                            inside_out = a >= d_ms - fout and b <= d_ms
                            self.assertTrue(inside_in or inside_out, f"{st}: move {a}-{b} ms outside in/out")
                        if until is not None:
                            self.assertLessEqual(until, fin, "a helper layer ends with the entrance")

    def test_events_are_whole_centiseconds_and_keep_their_exit(self):
        tcfg, style = _ctx()
        chunk = [{"start": 0.0, "end": 1.937, "kills": 3, "kinds": ["kills"]}]  # card cut to the moment
        _s, ev = lt.chapter_events(chunk, 1, 0.0, FRAME, tcfg, style, "#FF3366", seed="x")
        self.assertTrue(ev)
        for e in ev:
            f = e.split(",", 9)
            t0, t1 = (sum(float(x) * k for x, k in zip(t.split(":"), (3600, 60, 1))) for t in (f[1], f[2]))
            ends = [b for _a, b in _windows(f[9])]
            self.assertLessEqual(max(ends), round((t1 - t0) * 1000) + 1)


class Picks(unittest.TestCase):
    def test_seeded_and_never_the_last_two(self):
        a = lt.ko_picks("rec-2026-11-22.mkv", 40, lt.KO_STYLES)
        self.assertEqual(a, lt.ko_picks("rec-2026-11-22.mkv", 40, lt.KO_STYLES))
        self.assertNotEqual(a, lt.ko_picks("another.mkv", 40, lt.KO_STYLES))
        self.assertGreaterEqual(len(set(a)), 4, "the mix is used")
        for i in range(2, len(a)):
            self.assertNotIn(a[i], a[i - 2:i])
        self.assertEqual(lt.ko_picks("x", 20, lt.KO_STYLES)[:7], lt.ko_picks("x", 7, lt.KO_STYLES))  # batch slices

    def test_weights_and_small_sets(self):
        self.assertEqual(set(lt.ko_picks("s", 9, ["slam"])), {"slam"})
        two = lt.ko_picks("s", 9, ["slam", "stamp"])
        self.assertEqual(set(two), {"slam", "stamp"})
        heavy = lt.ko_picks("s", 300, ["slam", "slash", "glitch"], {"slam": 10, "slash": 1, "glitch": 1}, avoid_n=0)
        self.assertGreater(heavy.count("slam"), 200)
        self.assertEqual(lt.ko_picks("s", 5, []), [])

    def test_batches_continue_the_video_sequence(self):
        tcfg, style = _ctx()
        segs = [{"start": i * 20.0, "end": i * 20.0 + 10.0, "kills": 1, "kinds": ["kills"]} for i in range(6)]
        whole, parts = [], []
        lt.chapter_events(segs, 1, 0.0, FRAME, tcfg, style, "#FF3366", seed="r", picked=whole)
        lt.chapter_events(segs[:3], 1, 0.0, FRAME, tcfg, style, "#FF3366", seed="r", picked=parts)
        lt.chapter_events(segs[3:], 4, 0.0, FRAME, tcfg, style, "#FF3366", seed="r", picked=parts)
        self.assertEqual(whole, parts)
        self.assertEqual(whole, lt.ko_picks("r", 6, lt.KO_STYLES))


class Wording(unittest.TestCase):
    def test_table(self):
        kc = lv.load_config()["teaching"]["koCards"]
        cases = [({"kills": 1, "kinds": ["kills"]}, ("K.O.", None)),
                 ({"kills": 2, "kinds": ["kills"]}, ("DOUBLE K.O.", None)),
                 ({"kills": 3, "kinds": ["kills"]}, ("TRIPLE K.O.", None)),
                 ({"kills": 4, "kinds": ["kills"]}, ("QUAD K.O.", None)),
                 ({"kills": 6, "kinds": ["kills"]}, ("RAMPAGE", "6 kills")),
                 ({"kills": 3, "kinds": ["kills", "streak"]}, ("STREAK", "streak · 3 kills")),
                 ({"kills": 2, "kinds": ["kills", "win"]}, ("WON", "2 kills · won match")),
                 ({"kills": 0, "kinds": ["win"]}, ("WON", "won match")),
                 ({"kills": 0, "kinds": []}, ("HIGHLIGHT", "highlight"))]
        for seg, want in cases:
            with self.subTest(seg=seg):
                self.assertEqual(lt.ko_word(seg, kc), want)
        self.assertIn("proposal", kc["wordsSource"])


class Settings(unittest.TestCase):
    def test_no_ticks_no_cards_and_order_kept(self):
        tcfg, style = _ctx()
        chunk = [{"start": 0.0, "end": 8.0, "kills": 2, "kinds": ["kills"]}]
        self.assertEqual(lt.chapter_events(chunk, 1, 0.0, FRAME, tcfg, style, "#FF3366", card_styles=[]), ([], []))
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(lt.card_choice(d)[0], list(lt.KO_STYLES))  # no settings file: every style
            with open(os.path.join(d, cc.SETTINGS_FILE), "w", encoding="utf-8") as f:
                json.dump({"clips": {"look": {"cards": {"styles": ["stamp", "slam"]}}}}, f)
            self.assertEqual(lt.card_choice(d)[0], ["slam", "stamp"])
            with open(os.path.join(d, cc.SETTINGS_FILE), "w", encoding="utf-8") as f:
                json.dump({"clips": {"look": {"cards": {"styles": []}}}}, f)
            self.assertEqual(lt.card_choice(d)[0], [])
            with open(os.path.join(d, cc.SETTINGS_FILE), "w", encoding="utf-8") as f:
                json.dump({"clips": {"look": {"cards": {"styles": ["wobble"]}}}}, f)  # invalid: the defaults
            self.assertEqual(lt.card_choice(d)[0], list(lt.KO_STYLES))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("node"), "needs ffmpeg and node")
class Burn(unittest.TestCase):
    def test_all_five_styles_burn_and_never_flash(self):
        """Five 2.6 s moments, one per style (all ticked, seeded), burned by libass at 1280x720; the fx test analyser
        (flash-detect.mjs) measures the rendered frames."""
        import beatdrop as bd  # noqa: PLC0415
        tcfg, style = _ctx()
        frame = {"width": 1280, "height": 720}
        segs = [{"start": i * 2.6, "end": (i + 1) * 2.6, "kills": i + 1, "kinds": ["kills"]} for i in range(5)]
        order = list(lt.KO_STYLES)
        picked = []
        with tempfile.TemporaryDirectory() as d:
            styles_lines, events = [], []
            for i, st in enumerate(order):  # moment i drawn in style i: the cards of a one-style pass at moment i
                got = []
                sl, ev = lt.chapter_events(segs, 1, 0.0, frame, tcfg, style, "#FF3366", card_styles=[st], seed="burn",
                                           picked=got)
                styles_lines = sl
                events += [e for e in ev if e.split(",")[1] == lt.caps._ts(i * 2.6)]
                picked.append(got[i])
            extra = (styles_lines, events)
            self.assertEqual(picked, order)
            ass, fd, _n = rcap.write_ass({"segments": []}, frame, tcfg["safe"], style, d, 13.0, extra=extra)
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                                "testsrc2=size=1280x720:rate=30:duration=13", "-vf", f"subtitles={ass}:fontsdir={fd}",
                                "-c:v", "libopenh264", "-b:v", "4M", "out.mp4"], cwd=d, capture_output=True, text=True,
                               timeout=300, creationflags=NOWIN)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            res = bd.measure_flash(os.path.join(d, "out.mp4"), {"width": 320, "height": 180}, fps=30)
        self.assertTrue(res["pass"], res)
        self.assertLessEqual(res["peakFlashesPerSecond"], 3)


if __name__ == "__main__":
    unittest.main()
