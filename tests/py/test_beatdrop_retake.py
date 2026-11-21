# SPDX-License-Identifier: GPL-3.0-or-later
"""BD7a (D418): BeatDrop retakes, the plain-word summary and the V (9:16) render from the same plan
(services/clip/beatdrop.py retake/summary/make vertical=, clipper.py beatdrop --retake).

Done when (plan docs/plan/2026-11-21-beatdrop-montages.md, BD7): one-click retakes change only what they name; H and
V renders from one plan. Synthetic fixtures from test_beatdrop (no real footage, no real music). Real footage, NVENC
and the look of the V framing UNVERIFIED."""

import copy
import json
import os
import subprocess
import sys
import tempfile
import shutil
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import test_beatdrop as tb  # noqa: E402  - the synthetic fixtures

REPO, CLIP = tb.REPO, tb.CLIP


def _dump(x):
    return json.dumps(x, sort_keys=True)


def _schema():
    with open(os.path.join(REPO, "data", "schemas", "beatdrop-plan.schema.json"), encoding="utf-8") as f:
        return json.load(f)


@unittest.skipUnless(tb.np is not None, "numpy/PyAV missing (use the project venv)")
class RetakePlanTests(unittest.TestCase):
    """Retakes on data only (no render)."""

    @classmethod
    def setUpClass(cls):
        import beatdrop  # noqa: PLC0415
        import reel_style  # noqa: PLC0415
        cls.bd, cls.rs = beatdrop, reel_style
        cls.md = tb.moments_doc()
        cls.pl = beatdrop.plan(cls.md, tb.smap_fixture(), max_sec=60)
        cls.cfg = beatdrop.load_config()

    def _same_frame(self, a, b):
        self.assertEqual(a["part"], b["part"])
        self.assertEqual(a["outStart"], b["outStart"])
        self.assertEqual(a["outFrames"], b["outFrames"])

    def _check_common(self, new, changed):
        """Everything but the changed pieces (and the effects/cuts/stats/log/retakes bookkeeping) is identical."""
        pl = self.pl
        self.assertEqual(self.rs.schema_problems(new, _schema(), "plan"), [])
        for k in ("songStart", "total", "frames", "song", "targets", "slots", "fps"):
            self.assertEqual(_dump(new[k]), _dump(pl[k]), k)
        self.assertEqual(len(new["pieces"]), len(pl["pieces"]))
        for i, (a, b) in enumerate(zip(pl["pieces"], new["pieces"])):
            self._same_frame(a, b)
            if i not in changed:
                self.assertEqual(_dump(a), _dump(b), f"piece {i + 1} must not change")
        drop = next(p for p in new["pieces"] if p["part"] == "drop")
        self.assertEqual(drop["anchor"]["kind"], "kill", "the first-drop rule: a kill on the drop")
        self.assertEqual(drop["anchor"]["outFrame"], round(new["song"]["dropAt"] * 60))
        for p in new["pieces"]:
            self.assertGreaterEqual(p["speed"], self.cfg["speed"]["min"])
            self.assertLessEqual(p["speed"], self.cfg["speed"]["max"])
            if p.get("anchor") is None:
                s0, s1 = p["src"]["start"], p["src"]["end"]
                self.assertFalse(any(s0 - 0.01 <= k / tb.FPS <= s1 + 0.01 for k in tb.KILLS), f"no kill in calm {p}")
        spans = sorted((p["src"]["start"], p["src"]["end"]) for p in new["pieces"] if p.get("anchor"))
        for (a0, a1), (b0, b1) in zip(spans, spans[1:]):
            self.assertLessEqual(a1, b0 + 1e-6, "anchored source spans never overlap")
        anchors = [(p["anchor"]["kind"], p["anchor"]["frame"]) for p in new["pieces"] if p.get("anchor")]
        self.assertEqual(len(anchors), len(set(anchors)), "a moment is used once")

    def test_swap_changes_only_the_named_piece(self):
        i = next(i for i, p in enumerate(self.pl["pieces"]) if p["part"] == "body" and p["anchor"]
                 and p["anchor"]["kind"] == "kill")
        new = self.bd.retake(self.pl, "swap", self.md, piece=i + 1)
        self._check_common(new, {i})
        a, b = self.pl["pieces"][i], new["pieces"][i]
        self.assertNotEqual(a["anchor"]["frame"], b["anchor"]["frame"])
        self.assertEqual(a["anchor"]["outFrame"], b["anchor"]["outFrame"], "the new moment lands on the same beat")
        self.assertTrue(b["anchor"]["onBeat"])
        self.assertEqual(new["retakes"], [{"op": "swap", "piece": i + 1}])
        self.assertNotIn("retakes", self.pl, "the saved plan is not modified")

    def test_swap_a_calm_piece_and_the_drop(self):
        new = self.bd.retake(self.pl, "swap", self.md, piece=1)
        self._check_common(new, {0})
        self.assertNotEqual(new["pieces"][0]["src"], self.pl["pieces"][0]["src"])
        di = next(i for i, p in enumerate(self.pl["pieces"]) if p["part"] == "drop")
        new = self.bd.retake(self.pl, "swap", self.md, piece=di + 1)
        self._check_common(new, {di})
        self.assertNotEqual(new["pieces"][di]["anchor"]["frame"], tb.KILLS[7])

    def test_swap_needs_a_valid_piece(self):
        from clip_common import ClipError  # noqa: PLC0415
        for bad in (None, 0, len(self.pl["pieces"]) + 1, True):
            with self.assertRaises(ClipError):
                self.bd.retake(self.pl, "swap", self.md, piece=bad)
        with self.assertRaises(ClipError):
            self.bd.retake(self.pl, "faster", self.md)

    def test_slower_intro_changes_only_the_cold_open(self):
        new = self.bd.retake(self.pl, "slower-intro", self.md)
        co = {i for i, p in enumerate(self.pl["pieces"]) if p["part"] == "cold-open"}
        self._check_common(new, co)
        step = self.cfg["retakes"]["slowerIntro"]["speedStep"]
        for i in co:
            a, b = self.pl["pieces"][i], new["pieces"][i]
            self.assertAlmostEqual(b["speed"], max(self.cfg["speed"]["min"], a["speed"] - step))
            self.assertEqual(a["src"]["start"], b["src"]["start"])
            self.assertLess(b["src"]["end"], a["src"]["end"])
        self.assertEqual(_dump(new["effects"]), _dump(self.pl["effects"]), "same effects")
        # down to the floor, then a clear refusal
        from clip_common import ClipError  # noqa: PLC0415
        cur = new
        for _ in range(10):
            try:
                cur = self.bd.retake(cur, "slower-intro", self.md)
            except ClipError as e:
                self.assertIn("slowest safe speed", str(e))
                break
        else:
            self.fail("slower-intro never reached the floor")
        self.assertTrue(all(p["speed"] == self.cfg["speed"]["min"] for p in cur["pieces"] if p["part"] == "cold-open"))

    def test_more_third_person_changes_only_moves(self):
        new = self.bd.retake(self.pl, "more-third-person", self.md)
        conv = [n - 1 for n in new["retakes"][0]["pieces"]]
        self.assertTrue(1 <= len(conv) <= self.cfg["retakes"]["moreThirdPerson"]["convert"])
        self._check_common(new, set(conv))
        for i in conv:
            a, b = self.pl["pieces"][i], new["pieces"][i]
            self.assertEqual(a["part"], "body")
            self.assertNotEqual(a["anchor"]["kind"], "kill")
            self.assertIsNone(b["anchor"])
            self.assertEqual(b["game"]["gain"], self.cfg["audio"]["calmGain"])
            t = a["anchor"]["outT"]
            self.assertFalse(any(e["fn"] in ("shot-shake", "impact-flash") and abs(e["at"] - t) < 1e-6
                                 for e in new["effects"]), "the moved piece's beat effects go with it")
        self.assertEqual(new["stats"]["kills"], self.pl["stats"]["kills"])

    def test_another_take_reseeds_all_but_the_drop_and_is_reproducible(self):
        a = self.bd.retake(self.pl, "another-take", self.md)
        b = self.bd.retake(self.pl, "another-take", self.md)
        self.assertEqual(_dump(a), _dump(b), "same seed, same take")
        di = next(i for i, p in enumerate(self.pl["pieces"]) if p["part"] == "drop")
        self._check_common(a, set(range(len(self.pl["pieces"]))) - {di})
        self.assertEqual(_dump(a["pieces"][di]), _dump(self.pl["pieces"][di]))
        diff = sum(1 for x, y in zip(self.pl["pieces"], a["pieces"]) if _dump(x) != _dump(y))
        self.assertGreater(diff, len(self.pl["pieces"]) // 3, "a different choice for the whole edit")
        for x, y in zip(self.pl["pieces"], a["pieces"]):
            self.assertEqual(bool(x.get("anchor")), bool(y.get("anchor")))
            if x.get("anchor"):
                self.assertEqual(x["anchor"]["outFrame"], y["anchor"]["outFrame"])
                self.assertEqual(x["anchor"]["onBeat"], y["anchor"]["onBeat"])
        c = self.bd.retake(a, "another-take", self.md)
        self.assertEqual(c["retakes"], [{"op": "another-take", "seed": 1}, {"op": "another-take", "seed": 2}])
        self.assertNotEqual(_dump(c["pieces"]), _dump(a["pieces"]))

    def test_retakes_are_recorded_and_capped(self):
        from clip_common import ClipError  # noqa: PLC0415
        cfg = copy.deepcopy(self.cfg)
        cfg["retakes"]["max"] = 2
        x = self.bd.retake(self.pl, "swap", self.md, cfg=cfg, piece=1)
        x = self.bd.retake(x, "another-take", self.md, cfg=cfg)
        self.assertEqual([r["op"] for r in x["retakes"]], ["swap", "another-take"])
        with self.assertRaises(ClipError):
            self.bd.retake(x, "swap", self.md, cfg=cfg, piece=1)

    def test_flash_spacing_holds_after_a_retake(self):
        x = self.bd.retake(self.pl, "another-take", self.md)
        flashes = sorted(e["at"] for e in x["effects"] if e["fn"] == "impact-flash" and e.get("mode") == "flash")
        for i, t in enumerate(flashes):
            self.assertLessEqual(sum(1 for u in flashes[:i + 1] if t - u < 1.0), self.cfg["flash"]["maxPerSec"])
        # re-running the spacing on an unchanged timeline changes nothing
        same = self.bd.retake(self.pl, "slower-intro", self.md)
        self.assertEqual(_dump(same["effects"]), _dump(self.pl["effects"]))

    def test_summary_of_the_fixture(self):
        s = self.bd.summary(self.pl)
        kills = sum(1 for p in self.pl["pieces"] if p.get("anchor") and p["anchor"]["kind"] == "kill"
                    and p["anchor"]["onBeat"])
        drop = self.pl["song"]["dropAt"]
        self.assertEqual(s[0], f"kill on the first drop at 0:{int(round(drop)):02d}")
        self.assertIn(f"{kills} kills on beats", s)
        tp = sum(1 for p in self.pl["pieces"] if p.get("near") == "third-person")
        self.assertGreater(tp, 0)
        self.assertIn(f"{tp} third-person shot{'s' if tp != 1 else ''}", s)
        self.assertTrue(s[-1].endswith("long"), s)
        self.assertTrue(all(isinstance(x, str) and len(x) < 80 for x in s))
        print("BD7 summary:", s)
        r = self.bd.summary(self.bd.retake(self.pl, "swap", self.md, piece=1))
        self.assertEqual(r[-1], "retake: piece swapped (1)")


@unittest.skipUnless(tb.np is not None, "numpy/PyAV missing (use the project venv)")
class VerticalGraphTests(unittest.TestCase):
    """The V cut reuses the clip layouts (clip_render.layout_graph) per piece: data only."""

    def test_layout_chain_per_piece_and_old_calls_unchanged(self):
        import beatdrop  # noqa: PLC0415
        import clip_render as rnd  # noqa: PLC0415
        pl = beatdrop.plan(tb.moments_doc(), tb.smap_fixture(), max_sec=60)
        with open(os.path.join(REPO, "data", "clip", "layouts.json"), encoding="utf-8") as f:
            lay = next(x for x in json.load(f)["layouts"] if x["id"] == "blurred-fill")
        frame = {"width": 180, "height": 320}
        h = beatdrop.render_argv(pl, "ffmpeg", "rec.mkv", {"width": 320, "height": 180}, ["-c:v", "x"], ["-c:a", "aac"],
                                 "music.wav", "o.mp4")
        v = beatdrop.render_argv(pl, "ffmpeg", "rec.mkv", frame, ["-c:v", "x"], ["-c:a", "aac"], "music.wav", "v.mp4",
                                 layout={"layout": lay, "iw": 320, "ih": 180})
        g = v[v.index("-filter_complex") + 1]
        n = len(pl["pieces"])
        self.assertEqual(sum(g.count(f"[bgb_p{i}]") for i in range(n)), 2 * n, "one blurred fill per piece")
        self.assertIn("[bg_p0]", g)
        self.assertIn(f"[bg_p{n - 1}]", g)
        self.assertNotIn("[bg]", g)
        self.assertEqual(v.count("-c:a"), 1, "one audio encode")
        hg = h[h.index("-filter_complex") + 1]
        self.assertNotIn("[bgb_p0]", hg)
        self.assertEqual(hg.count("gblur"), g.count("gblur") - n, "the H graph is the old one")


if __name__ == "__main__":
    unittest.main()
