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


def _ffprobe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries",
                        "stream=codec_type,width,height:format=duration", "-of", "json", path],
                       capture_output=True, text=True, creationflags=tb.NOWIN)
    return json.loads(r.stdout)


@unittest.skipUnless(tb.np is not None and tb.HAVE_TOOLS, "needs numpy/PyAV, ffmpeg, ffprobe and node")
class RenderedRetakeTests(unittest.TestCase):
    """clipper.py beatdrop on the synthetic recording: H + V from one plan (V canvas sibling), then --retake swap
    (the given V recording does not exist: the blurred-fill fallback of the H recording)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ujw-bd7-")
        cls.data = os.path.join(cls.tmp, "data")
        music = os.path.join(cls.tmp, "music")
        os.makedirs(cls.data)
        os.makedirs(music)
        tb.write_click_track(os.path.join(music, "Test Artist - Click Drop [NCS Release].wav"))
        cls.rec = os.path.join(cls.tmp, "s-h-1.mkv")
        tb.write_recording(cls.rec)
        shutil.copyfile(cls.rec, os.path.join(cls.tmp, "s-v-1.mkv"))  # the V canvas sibling (canvas layout path)
        cls.out = os.path.join(cls.tmp, "run")
        os.makedirs(cls.out)
        with open(os.path.join(cls.out, "moments.json"), "w", encoding="utf-8") as f:
            json.dump(tb.moments_doc(), f)
        with open(os.path.join(cls.data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"montageMusic": {"on": True, "folder": music, "mode": "random", "avoidLast": 3}}}, f)
        with open(os.path.join(cls.data, "flags.local.json"), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-styles": False}}, f)
        cls.profile = os.path.join(cls.tmp, "profile.json")
        with open(cls.profile, "w", encoding="utf-8") as f:
            json.dump({"streamer": {"brand": "Test Brand", "name": "Test Streamer"},
                       "games": {"codm": {"ign": "TestPlayer"}}}, f)
        cls.wd = os.path.join(cls.out, "beatdrop", "clips", "B1")
        cls.p1 = cls._run()
        cls.doc1, cls.plan1 = cls._read()
        # the retake below renders new file names and sweeps these videos: measure them now
        cls.probe1, cls.vflash1 = {}, None
        if cls.doc1:
            for f in cls.doc1["clips"][0]["files"]:
                cls.probe1[f["layout"]] = _ffprobe(os.path.join(cls.wd, f["file"]))
                if f["layout"] == "beatdrop-v":
                    cls.vflash1 = tb.flash_measure(os.path.join(cls.wd, f["file"]))
        cls.swap_piece = 1
        if cls.plan1:
            cls.swap_piece = 1 + next(i for i, p in enumerate(cls.plan1["pieces"]) if p["part"] == "body"
                                      and p["anchor"] and p["anchor"]["kind"] == "kill")
        cls.p2 = cls._run("--retake", "swap", "--piece", str(cls.swap_piece),
                          "--v-recording", os.path.join(cls.tmp, "none-v.mkv"))
        cls.doc2, cls.plan2 = cls._read()

    @classmethod
    def _run(cls, *extra):
        env = dict(os.environ, UJWALAM_DATA_ROOT=cls.data, UJWALAM_HEADLESS="1")
        return subprocess.run([sys.executable, "-I", os.path.join(CLIP, "clipper.py"), "--data-dir", cls.data,
                               "beatdrop", "--out", cls.out, "--recording", cls.rec, "--encoder", "libopenh264",
                               "--width", str(tb.W), "--height", str(tb.H), "--max-sec", "60",
                               "--profile", cls.profile, *extra],
                              capture_output=True, text=True, timeout=1800, env=env, creationflags=tb.NOWIN)

    @classmethod
    def _read(cls):
        try:
            with open(os.path.join(cls.out, "beatdrop", "render.json"), encoding="utf-8") as f:
                doc = json.load(f)
            with open(os.path.join(cls.wd, "beatdrop-plan.json"), encoding="utf-8") as f:
                return doc, json.load(f)
        except (OSError, ValueError):
            return None, None

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _files(self, doc):
        return {f["layout"]: f for f in doc["clips"][0]["files"]}

    def test_h_and_v_from_one_plan(self):
        self.assertEqual(self.p1.returncode, 0, self.p1.stderr[-1500:])
        fs = self._files(self.doc1)
        self.assertEqual(set(fs), {"beatdrop-h", "beatdrop-v"}, self.doc1["clips"][0].get("errors"))
        self.assertEqual(fs["beatdrop-v"]["geometry"], "stream-v", "the V canvas recording, framed as V clips are")
        total = self.plan1["total"]
        for lay, (w, h) in (("beatdrop-h", (tb.W, tb.H)), ("beatdrop-v", (tb.W * 9 // 16 // 2 * 2, tb.W))):
            info = self.probe1[lay]
            kinds = [s["codec_type"] for s in info["streams"]]
            self.assertEqual(kinds.count("audio"), 1, lay)
            v = next(s for s in info["streams"] if s["codec_type"] == "video")
            self.assertEqual((v["width"], v["height"]), (w, h), lay)
            self.assertAlmostEqual(float(info["format"]["duration"]), total, delta=0.1, msg=lay)
        vf = self.vflash1
        print(f"BD7 V: flash peak {vf['peakFlashesPerSecond']}/s over {vf['frames']} frames; summary "
              f"{self.doc1['clips'][0]['summary']}")
        self.assertTrue(vf["pass"])
        self.assertTrue(fs["beatdrop-v"]["flash"]["pass"])
        self.assertTrue(self.doc1["clips"][0]["summary"][0].startswith("kill on the first drop at"))

    def test_v_is_9_16(self):
        v = next(s for s in self.probe1["beatdrop-v"]["streams"] if s["codec_type"] == "video")
        self.assertAlmostEqual(v["width"] / v["height"], 9 / 16, delta=0.01)

    def test_retake_swap_changes_only_that_piece_and_renders_both(self):
        self.assertEqual(self.p2.returncode, 0, self.p2.stderr[-1500:])
        i = self.swap_piece - 1
        self.assertEqual(self.plan2["retakes"], [{"op": "swap", "piece": self.swap_piece}])
        for k, (a, b) in enumerate(zip(self.plan1["pieces"], self.plan2["pieces"])):
            if k == i:
                self.assertNotEqual(a["anchor"]["frame"], b["anchor"]["frame"])
                self.assertEqual(a["anchor"]["outFrame"], b["anchor"]["outFrame"])
            else:
                self.assertEqual(_dump(a), _dump(b), f"piece {k + 1}")
        for s in ("title", "hero", "credits"):
            for k in ("start", "end"):
                self.assertEqual(self.plan1["slots"][s][k], self.plan2["slots"][s][k])
        self.assertEqual(self.doc1["clips"][0]["music"], self.doc2["clips"][0]["music"], "the same song")
        fs1, fs2 = self._files(self.doc1), self._files(self.doc2)
        self.assertEqual(set(fs2), {"beatdrop-h", "beatdrop-v"}, self.doc2["clips"][0].get("errors"))
        self.assertEqual(fs2["beatdrop-v"]["geometry"], "blurred-fill", "no V recording: the H recording, fitted")
        for lay in fs2:
            self.assertNotEqual(fs1[lay]["file"], fs2[lay]["file"], "a new name per render")
            self.assertFalse(os.path.exists(os.path.join(self.wd, fs1[lay]["file"])), "the old file is swept")
        self.assertIn(f"retake: piece swapped ({self.swap_piece})", self.doc2["clips"][0]["summary"])
        left = sorted(f for f in os.listdir(self.wd) if f.endswith((".part", ".wav", ".ass", ".cube", ".txt")))
        self.assertEqual(left, [], "temp files cleaned up")

    def test_piece_without_retake_is_refused(self):
        p = self._run("--piece", "2")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("--piece goes with --retake swap", p.stderr)


if __name__ == "__main__":
    unittest.main()
