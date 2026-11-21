# SPDX-License-Identifier: GPL-3.0-or-later
"""RS2 reel style record and mapping (services/clip/reel_style.py, D412): the record rules (same fixture the Node schema
test validates: tests/fixtures/reel-style-example.json), the mapping onto the D411 look (transition set, name style,
zoom-pulse and speed-ramp presets, LUT, music energy), tuning, the analysis job (off air only, one at a time, examples
never copied), and the two new core functions rendered on the CPU (libopenh264) and measured back: zoom pulses at their
times and size with entrance < 600 ms and exit < 400 ms and no flash; a speed ramp that keeps the piece's length with the
sound in sync (or muted) and one audio stream; the LUT's colour shift. Synthetic values only."""

import json
import os
import re
import shutil
import sys
import tempfile
import unittest

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, "..", "..", "services", "clip"))
sys.path.insert(0, HERE)

import clip_common as cc  # noqa: E402

try:
    import av  # noqa: F401
    import cv2  # noqa: F401
    import numpy as np
    import style_fixtures as sf
except ImportError:
    np = None

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FIXTURE = os.path.join(HERE, "..", "fixtures", "reel-style-example.json")
ENC = ["-c:v", "libopenh264", "-b:v", "6000k", "-g", "60"]
AUD = ["-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"]
FRAME = {"width": 270, "height": 480}

import reel_style as rs  # noqa: E402

CFG = rs.load_config()


def measured(**over):
    m = {"cuts": {"ratePerMin": 40.0, "shotSec": 1.2, "shotP25": 1.0, "shotP75": 1.5, "beatShare": 0.7},
         "transitions": {"mix": {"hard": 0.2, "fade": 0.4, "flash": 0.4, "whip": 0.0}, "count": 10},
         "zooms": {"ratePerMin": 12.0, "scale": 1.15, "sec": 0.35, "inSec": 0.15, "outSec": 0.2, "shakePct": 0.3},
         "ramps": {"ratePerMin": 4.0, "factor": 0.5, "fromCutSec": 0.8},
         "text": {"perMin": 6.0, "sec": 1.5, "sizePct": 6.0, "cornerShare": 0.0, "afterCutSec": 0.4, "band": "bottom"},
         "colour": {"L": 50.0, "a": 3.0, "b": 12.0, "contrast": 15.0, "chroma": 20.0},
         "music": {"bpm": 128.0, "energyLevel": 0.8, "mood": "edm"}, "spread": {}, "omitted": []}
    m.update(over)
    return m


class RecordTests(unittest.TestCase):
    def test_fixture_is_valid_and_matches_the_mapping(self):
        with open(FIXTURE, encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(rs.style_problems(doc, CFG), [])
        again = rs.from_measured(doc["measured"], CFG)
        for p in rs.PARTS + ("summary",):
            self.assertEqual(doc[p], again[p], p)  # the committed fixture follows the code (Node checks the schema)

    def test_problems(self):
        ok = rs.new_style("my-style", "Fast cuts", ["C:/clips/a.mp4"], CFG)
        self.assertEqual(rs.style_problems(ok, CFG, analysed=False), [])
        self.assertIn("measured must be an object (run the analysis)", rs.style_problems(ok, CFG))
        cases = [
            (dict(ok, name=""), "name must be 1 to 40 characters"),
            (dict(ok, name="x" * 41), "name must be 1 to 40 characters"),
            (dict(ok, version=2), "version must be 1"),
            (dict(ok, id="Bad Id"), "id must be lower-case letters, digits and dashes (up to 40)"),
            (dict(ok, examples=[]), "examples must list 1 to 8 videos"),
            (dict(ok, examples=[{"path": "a.mp4"}] * 9), "examples must list 1 to 8 videos"),
            (dict(ok, examples=[{"path": "a.mp4", "sha256": "xyz"}]), "examples[0].sha256 must be 64 hex digits"),
            (dict(ok, examples=[{"path": "a.mp4", "frames": []}]), "examples[0] has unknown keys frames"),
            (dict(ok, tune={"speed": 1}), "unknown tune setting speed"),
            (dict(ok, tune={"lutStrength": 2}), "tune.lutStrength must be from 0 to 1"),
        ]
        for doc, msg in cases:
            self.assertIn(msg, rs.style_problems(doc, CFG, analysed=False), doc)
        with self.assertRaises(cc.ClipError):
            rs.new_style("x", "", ["a.mp4"], CFG)


class MappingTests(unittest.TestCase):
    def test_full_mapping(self):
        s = rs.from_measured(measured(), CFG)
        self.assertEqual(s["cuts"], {"shotSec": 1.2, "ratePerMin": 40.0, "beatCuts": True, "beatShare": 0.7})
        self.assertEqual(s["transitions"]["mode"], "set")
        self.assertEqual(s["transitions"]["set"], "cinematic")
        self.assertEqual(s["zooms"]["preset"], "zoom-pulse-kill-slam")
        self.assertEqual((s["zooms"]["inMs"], s["zooms"]["outMs"], s["zooms"]["on"]), (150, 200, "beats"))
        self.assertEqual(s["ramps"]["factor"], 0.5)
        self.assertTrue(s["ramps"]["unverified"])
        self.assertEqual((s["text"]["nameStyle"], s["text"]["position"]), ("lower-third", "lower-third"))
        self.assertEqual(s["colour"]["tone"], "warm")
        self.assertEqual(s["colour"]["lut"], "style.cube")
        self.assertEqual(s["music"]["energyLevel"], 0.8)
        self.assertEqual(s["summary"], "cuts every 1.2 s, 70 % on the beat, joins like cinematic, warm colour, "
                                       "zoom pulse on beats, slow motion to 50 % around moments, name as lower third, "
                                       "edm music")

    def test_nearest_set_and_hard_cuts(self):
        def tr(mix):
            return rs.from_measured(measured(transitions={"mix": mix, "count": 5}), CFG)["transitions"]
        self.assertEqual(tr({"hard": 0.0, "fade": 1.0, "flash": 0.0, "whip": 0.0})["set"], "clean")
        self.assertEqual(tr({"hard": 0.0, "fade": 0.0, "flash": 0.2, "whip": 0.8})["set"], "punchy")
        self.assertEqual(tr({"hard": 0.8, "fade": 0.2, "flash": 0.0, "whip": 0.0})["mode"], "hard")

    def test_text_corner_and_kinetic(self):
        t = rs.from_measured(measured(text={"perMin": 3, "sec": 2, "sizePct": 4, "cornerShare": 1.0, "band": "top"}), CFG)
        self.assertEqual((t["text"]["nameStyle"], t["text"]["position"]), ("corner-tag", "top-left"))
        k = rs.from_measured(measured(text={"perMin": 3, "sec": 2, "sizePct": 9, "cornerShare": 0.0, "band": "middle"}), CFG)
        self.assertEqual(k["text"]["nameStyle"], "kinetic")

    def test_unmeasured_parts_are_left_out(self):
        m = measured()
        for p in ("zooms", "ramps", "text", "music"):
            m.pop(p)
        s = rs.from_measured(m, CFG)
        for p in ("zooms", "ramps", "text", "music"):
            self.assertIsNone(s[p])
        self.assertNotIn("zoom", s["summary"])

    def test_clamps_keep_limits(self):
        s = rs.from_measured(measured(zooms={"ratePerMin": 5, "scale": 1.6, "inSec": 0.9, "outSec": 0.9},
                                      cuts={"shotSec": 0.1, "beatShare": None}), CFG)
        self.assertEqual(s["zooms"]["scale"], 1.25)
        self.assertLess(s["zooms"]["inMs"], 600)
        self.assertLess(s["zooms"]["outMs"], 400)
        self.assertEqual(s["cuts"]["shotSec"], 0.4)
        self.assertFalse(s["cuts"]["beatCuts"])

    def test_tuning(self):
        doc = dict(rs.from_measured(measured(), CFG), tune={"shotSec": 2.0, "lutStrength": 0.3, "zoomScale": 1.0,
                                                             "rampFactor": 0.8, "musicEnergy": 0.2})
        e = rs.effective(doc, CFG)
        self.assertEqual(e["cuts"]["shotSec"], 2.0)
        self.assertEqual(e["colour"]["strength"], 0.3)
        self.assertIsNone(e["zooms"])  # tuned to no zoom
        self.assertEqual(e["ramps"]["factor"], 0.8)
        self.assertEqual(e["music"]["energyLevel"], 0.2)
        self.assertEqual(doc["cuts"]["shotSec"], 1.2)  # the record itself is unchanged

    def test_pace_and_ramp_plan(self):
        ps = rs.pace([{"start": 10.0, "end": 16.0}], 1.0, keep=[13.2], gap_sec=0.5)
        self.assertGreater(len(ps), 2)
        self.assertTrue(any(p["start"] <= 13.2 < p["end"] for p in ps))  # the kill is kept
        self.assertLessEqual(sum(p["end"] - p["start"] for p in ps), 6.0)
        for a, b in zip(ps, ps[1:]):
            self.assertGreaterEqual(round(b["start"] - a["end"], 3), 0.5)
        r = rs.ramp_for({"factor": 0.5, "sec": 0.6}, {"start": 0.0, "end": 6.0}, 2.0)
        # slow part 0.6 s -> 1.2 s, catch-up at 2x: back on the clock at the catch-up end
        self.assertAlmostEqual(r["at"] + r["sec"] / r["factor"] + (r["catchUpEnd"] - r["at"] - r["sec"]) / r["catchUp"],
                               r["catchUpEnd"], places=3)
        self.assertIsNone(rs.ramp_for({"factor": 0.5, "sec": 0.6}, {"start": 0.0, "end": 2.0}, 1.5))

    def test_zoom_times_are_spaced_and_off_the_joins(self):
        z = rs.zoom_for({"scale": 1.1, "inMs": 150, "outMs": 200}, [1.0, 1.2, 3.0, 5.0], xd_times=[(4.9, 5.2)])
        self.assertEqual(z["times"], [1.0, 3.0])


class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ujw-rs2-")
        self.data = os.path.join(self.tmp, "data")
        import style_analyse as sa  # noqa: PLC0415
        self.sa = sa

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _style(self, paths):
        d = self.sa.style_dir(self.data, "fast-cuts")
        os.makedirs(d)
        cc.write_json_atomic(os.path.join(d, "style.json"), rs.new_style("fast-cuts", "Fast cuts", paths))
        return d

    def test_refuses_on_air_and_when_busy(self):
        self._style([os.path.join(self.tmp, "x.mp4")])
        with self.assertRaisesRegex(cc.ClipError, "off air"):
            self.sa.run_style(self.data, "fast-cuts", live=lambda: True)
        with self.assertRaisesRegex(cc.ClipError, "off air"):
            self.sa.run_style(self.data, "fast-cuts", live=lambda: None)  # unknown counts as on air
        lock = os.path.join(rs.styles_root(self.data), ".analyse.lock")
        with open(lock, "w") as f:
            f.write("1")
        with self.assertRaisesRegex(cc.ClipError, "another style analysis"):
            self.sa.run_style(self.data, "fast-cuts", live=lambda: False)

    @unittest.skipUnless(np is not None, "numpy/OpenCV/PyAV missing (use the project venv)")
    def test_analysis_writes_a_valid_record_and_never_copies(self):
        spec = {"w": 180, "h": 320, "fps": 30, "joins": ["hard", "fade", "hard"],
                "shots": [{"sec": 1.5, "hue": h, "speed": 2.0} for h in (10, 70, 130, 40)]}
        paths = []
        for i in range(2):
            p = os.path.join(self.tmp, f"ex{i}.mkv")
            sf.write(p, spec, audio=sf.beat_audio(6.0, 120.0))
            paths.append(p)
        d = self._style(paths)
        doc = self.sa.run_style(self.data, "fast-cuts", live=lambda: False, ocr=False)
        self.assertEqual(rs.style_problems(doc, CFG), [])
        self.assertEqual(sorted(os.listdir(d)), ["style.json"])  # nothing copied next to the record
        self.assertEqual(doc["examples"][0]["sha256"], self.sa.sha256_file(paths[0]))
        self.assertEqual(doc["cuts"]["shotSec"], 1.5)
        self.assertEqual(doc["measured"]["transitions"]["count"], 6)
        self.assertIn("text", {o["part"] for o in doc["measured"]["omitted"]})
        self.assertIsNone(doc["text"])
        self.assertFalse(os.path.exists(os.path.join(rs.styles_root(self.data), ".analyse.lock")))
        self.assertEqual(rs.load_style(self.data, "fast-cuts")["name"], "Fast cuts")

    def _analysed(self, sid, **over):
        with open(FIXTURE, encoding="utf-8") as f:
            doc = dict(json.load(f), id=sid, name=sid.title(), **over)
        d = os.path.join(rs.styles_root(self.data), sid)
        os.makedirs(d, exist_ok=True)
        cc.write_json_atomic(os.path.join(d, "style.json"), doc)
        return doc

    def test_pick_follows_the_settings_and_the_flag(self):
        """RS4: the style chosen for the type; the pool joins only while the clip look mixes; flag off = no style."""
        self.assertIsNone(rs.pick(self.data, "reel"))  # no settings: reels are made as before
        for sid in ("warm", "cool", "calm"):
            self._analysed(sid)
        settings = {"clips": {"reelStyles": {"byType": {"reel": "warm"}, "pool": ["cool", "calm"]}, "look": {"randomise": False}}}
        cc.write_json_atomic(os.path.join(self.data, cc.SETTINGS_FILE), settings)
        self.assertEqual(rs.pick(self.data, "reel", ("a",))["id"], "warm")
        self.assertIsNone(rs.pick(self.data, "montage"))
        self.assertIsNone(rs.pick(self.data, "story"))
        settings["clips"]["look"]["randomise"] = True
        cc.write_json_atomic(os.path.join(self.data, cc.SETTINGS_FILE), settings)
        got = {rs.pick(self.data, "reel", (f"clip-{i}",))["id"] for i in range(30)}
        self.assertEqual(got, {"warm", "cool", "calm"})
        self.assertEqual(rs.pick(self.data, "reel", ("same",))["id"], rs.pick(self.data, "reel", ("same",))["id"])  # seeded
        self.assertEqual(rs.pick(self.data, "montage", ("x",))["id"] in {"cool", "calm"}, True)  # the pool alone
        cc.write_json_atomic(os.path.join(self.data, cc.LOCAL_FLAGS), {"flags": {"reel-styles": False}})
        self.assertIsNone(rs.pick(self.data, "reel", ("a",)))

    def test_create_and_tune(self):
        ex = os.path.join(self.tmp, "Liked Reel.MP4")
        with open(ex, "wb") as f:
            f.write(b"x")
        doc = rs.create(self.data, " My  style ", [ex])
        self.assertEqual((doc["id"], doc["name"]), ("my-style", "My style"))
        self.assertEqual(sorted(os.listdir(os.path.join(rs.styles_root(self.data), "my-style"))), ["style.json"])
        self.assertEqual(rs.create(self.data, "My style", [ex])["id"], "my-style-2")
        for paths, msg in (([], "add 1 to"), (["rel.mp4"], "full path"), ([ex, ex], "twice"),
                           ([os.path.join(self.tmp, "a.txt")], "not a video"), ([os.path.join(self.tmp, "no.mp4")], "not found")):
            with self.assertRaisesRegex(cc.ClipError, msg):
                rs.create(self.data, "x", paths)
        with self.assertRaisesRegex(cc.ClipError, "not analysed"):
            rs.save_tune(self.data, "my-style", {"shotSec": 1.0})
        self._analysed("warm")
        with self.assertRaisesRegex(cc.ClipError, "shotSec must be"):
            rs.save_tune(self.data, "warm", {"shotSec": 99})
        self.assertEqual(rs.save_tune(self.data, "warm", {"shotSec": 0.8, "zoomScale": None})["tune"], {"shotSec": 0.8})
        c = rs.card(rs.load_style(self.data, "warm"))
        self.assertEqual(c["values"]["shotSec"], 0.8)
        self.assertNotIn("measured", c)  # the card carries numbers and words only


@unittest.skipUnless(np is not None and HAVE_FFMPEG, "numpy/OpenCV/PyAV or ffmpeg missing")
class RenderTests(unittest.TestCase):
    """CPU renders (libopenh264), tiny frames, measured back with the RS1 analyser."""

    @classmethod
    def setUpClass(cls):
        import clip_montage as mont  # noqa: PLC0415
        import style_analyse as sa  # noqa: PLC0415
        cls.mont, cls.sa = mont, sa
        cls.tmp = tempfile.mkdtemp(prefix="ujw-rs2r-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        spec = {"w": 270, "h": 480, "fps": 30, "shots": [{"sec": 10.0, "hue": 100, "speed": 3.0}]}
        sf.write(cls.src, spec, audio=sf.beat_audio(10.0, 120.0), codec="libx264", crf=16)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, name, pieces, **kw):
        argv = self.mont.render_argv("ffmpeg", self.src, pieces, FRAME, ENC, AUD, 80, name, **kw)
        r = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-600:])
        return os.path.join(self.tmp, name)

    def probe(self, path):
        return cc.probe("ffprobe", path)

    def test_zoom_pulse_measures_back(self):
        z = {"times": [2.0, 5.0], "scale": 1.15, "inSec": 0.15, "outSec": 0.2}
        out = self.render("zoom.mp4", [{"start": 0.0, "end": 8.0}], zoom=z)
        r = self.sa.analyse_video(out, ocr=False)
        p = r["zooms"]["pulses"]
        self.assertEqual(len(p), 2, p)
        for got, t in zip(p, z["times"]):
            self.assertLessEqual(abs(got["t"] - t), 0.1, got)
            self.assertLessEqual(abs(got["scale"] - 1.15), 0.03, got)
            self.assertLess(got["inSec"], 0.6)
            self.assertLess(got["outSec"], 0.4)
        self.assertEqual(r["transitions"]["events"], [])  # no cut and no flash from a zoom
        print(f"\nzoom pulses measured: {p}")

    def test_speed_ramp_keeps_length_and_sync(self):
        piece = {"start": 0.0, "end": 6.0}
        rp = rs.ramp_for({"factor": 0.5, "sec": 0.6}, piece, 2.0)
        out = self.render("ramp.mp4", [dict(piece, ramp=rp)])
        j = self.probe(out)
        v = next(s for s in j["streams"] if s["codec_type"] == "video")
        a = [s for s in j["streams"] if s["codec_type"] == "audio"]
        self.assertEqual(len(a), 1)  # audio encoded once, one stream
        self.assertAlmostEqual(float(v["duration"]), 6.0, delta=0.05)
        self.assertAlmostEqual(float(a[0]["duration"]), 6.0, delta=0.06)
        r = self.sa.analyse_video(out, ocr=False)
        slow = [x for x in r["ramps"]["ramps"] if x["factor"] <= 0.6]
        self.assertTrue(slow, r["ramps"])
        self.assertLessEqual(abs(slow[0]["t"] - rp["at"]), 0.4, (slow, rp))
        self.assertLessEqual(abs(slow[0]["factor"] - 0.5), 0.08, slow)
        print(f"\nspeed ramp measured: {r['ramps']['ramps']} (planned at {rp['at']} s, factor 0.5)")

    def test_speed_ramp_mute(self):
        piece = {"start": 0.0, "end": 6.0}
        rp = dict(rs.ramp_for({"factor": 0.5, "sec": 0.6}, piece, 2.0), audio="mute")
        out = self.render("ramp-mute.mp4", [dict(piece, ramp=rp)])
        pcm = os.path.join(self.tmp, "m.raw")
        cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", out, "-f", "s16le", "-ac", "1", "-ar", "8000", pcm],
                    timeout=120)
        x = np.fromfile(pcm, dtype="<i2").astype(float)
        sr = 8000
        inside = x[int((rp["at"] + 0.1) * sr):int((rp["catchUpEnd"] - 0.1) * sr)]
        outside = x[int(0.2 * sr):int((rp["at"] - 0.1) * sr)]
        self.assertLess(np.sqrt(np.mean(inside ** 2)), 0.01 * np.sqrt(np.mean(outside ** 2)) + 1.0)

    def test_lut_colour_shift_measures_back(self):
        ref = rs.clip_colour(self.src, [{"start": 0.0, "end": 4.0}])
        self.assertIsNotNone(ref)
        style_colour = {"L": ref["L"], "a": ref["a"] + 6.0, "b": ref["b"] + 10.0, "contrast": ref["contrast"]}
        shift = rs.write_lut(os.path.join(self.tmp, "style.cube"), style_colour, 0.8, ref)
        self.assertEqual((shift["a"], shift["b"]), (4.8, 8.0))
        out = self.render("lut.mp4", [{"start": 0.0, "end": 4.0}], lut="style.cube")
        got = rs.clip_colour(out, [{"start": 0.0, "end": 4.0}])
        print(f"\nLUT: planned a {shift['a']:+.2f} b {shift['b']:+.2f}; measured a {got['a'] - ref['a']:+.2f} "
              f"b {got['b'] - ref['b']:+.2f}")
        self.assertLessEqual(abs((got["a"] - ref["a"]) - shift["a"]), 1.5)
        self.assertLessEqual(abs((got["b"] - ref["b"]) - shift["b"]), 1.5)
        with open(os.path.join(self.tmp, "style.cube"), encoding="ascii") as f:
            txt = f.read()
        self.assertIn("LUT_3D_SIZE 17", txt)
        self.assertEqual(len([ln for ln in txt.splitlines() if re.match(r"^[0-9.]+ [0-9.]+ [0-9.]+$", ln)]), 17 ** 3)

    def test_preview_on_my_clip(self):
        """RS3 "Preview on my clip": the style's colour and zoom pulses on the user's clip, CPU, 540 px wide."""
        data = os.path.join(self.tmp, "data")
        with open(FIXTURE, encoding="utf-8") as f:
            doc = dict(json.load(f), id="warm")
        d = os.path.join(rs.styles_root(data), "warm")
        os.makedirs(d, exist_ok=True)
        cc.write_json_atomic(os.path.join(d, "style.json"), doc)
        out = os.path.join(d, "preview.mp4")
        r = rs.preview(data, "warm", os.path.abspath(self.src), out, seconds=6.0)
        j = self.probe(out)
        v = next(s for s in j["streams"] if s["codec_type"] == "video")
        self.assertEqual(int(v["width"]), 540)
        self.assertAlmostEqual(float(v["duration"]), 6.0, delta=0.1)
        self.assertEqual(len([s for s in j["streams"] if s["codec_type"] == "audio"]), 1)
        self.assertEqual(r["zoomTimes"], [1.5, 4.0] if doc["zooms"] else [])
        self.assertIsNotNone(r["shift"])
        with self.assertRaisesRegex(cc.ClipError, "choose one of your clips"):
            rs.preview(data, "warm", "relative.mp4", out)

if __name__ == "__main__":
    unittest.main()
