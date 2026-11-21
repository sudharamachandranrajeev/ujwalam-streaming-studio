# SPDX-License-Identifier: GPL-3.0-or-later
"""RS4 reel styles in the clipper (services/clip/clipper.py _style_pick / _style_render_plan / _reel_timeline, D412).

- No style chosen (or flag off): the reel's pieces, look and timeline are the very same objects as before.
- A chosen style: pace (shots of the style's length, kills kept), the name style, the music energy target, the style's
  joins, zoom pulses on the kills off the joins, one speed ramp (not with captions) and the LUT fitted to the reel.
- A reel rendered on the CPU (libopenh264, tiny frames) with a style measures back close to it with the RS1 analyser:
  the joins are the style's (3 of 3 soft joins, at least 2 measured as fades), the zoom pulses sit at the planned times (within 0.15 s) and
  the colour shift matches the LUT's (b within 2.0; a within 4.5 on fully saturated synthetic hues, gamut clipping).
Synthetic footage only; studio-safe (no GPU)."""

import json
import os
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


def _reel():
    return {"pieces": [{"start": 0.5, "end": 3.5, "kills": 1}, {"start": 4.5, "end": 7.5, "kills": 1},
                       {"start": 8.5, "end": 11.5, "kills": 1}, {"start": 12.5, "end": 15.5, "kills": 1}],
            "seconds": 12.0, "peaks": [2.0, 6.0, 10.0, 14.0], "kills": 4}


@unittest.skipUnless(np is not None, "numpy/OpenCV/PyAV missing (use the project venv)")
class ClipperStyleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import clip_montage as mont  # noqa: PLC0415
        import clipper  # noqa: PLC0415
        import reel_style as rs  # noqa: PLC0415
        import reel_transition as rt  # noqa: PLC0415
        cls.cl, cls.rs, cls.rt, cls.mont = clipper, rs, rt, mont

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ujw-rs4-")
        self.data = os.path.join(self.tmp, "data")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _style(self, **over):
        with open(FIXTURE, encoding="utf-8") as f:
            doc = dict(json.load(f), id="warm", name="Warm", **over)
        d = os.path.join(self.rs.styles_root(self.data), "warm")
        os.makedirs(d, exist_ok=True)
        cc.write_json_atomic(os.path.join(d, "style.json"), doc)
        cc.write_json_atomic(os.path.join(self.data, cc.SETTINGS_FILE), {"clips": {"reelStyles": {"byType": {"montage": "warm"}}}})
        return doc

    def test_no_style_changes_nothing(self):
        m, pk = _reel(), {"name": "corner-tag", "music": None}
        for ex in ({}, {"reelStyles": None}, {"reelStyles": self.data}):
            sty, m2, pk2 = self.cl._style_pick(ex, "montage", m, pk, "M1", "rec.mp4")
            self.assertIsNone(sty)
            self.assertIs(m2, m)
            self.assertIs(pk2, pk)
            out = self.cl._style_render_plan(sty, m, 0.0, "x.mp4", self.tmp)
            self.assertEqual(out, (m, None, None, None))
        self._style()
        self.assertIsNone(self.cl._style_pick({"reelStyles": self.data}, "impact-play", m, pk, "I1")[0])  # not chosen for impact
        argv_plain = self.mont.render_argv("ffmpeg", "src.mp4", m["pieces"], FRAME, ENC, AUD, 80, "a.mp4")
        argv_none = self.mont.render_argv("ffmpeg", "src.mp4", m["pieces"], FRAME, ENC, AUD, 80, "a.mp4", zoom=None, lut=None)
        self.assertEqual(argv_plain, argv_none)
        self.assertNotIn("lut3d", " ".join(argv_plain))
        self.assertNotIn("zoompan", " ".join(argv_plain))

    def test_a_chosen_style_plans_pace_name_music_joins_zoom_ramp_and_lut(self):
        self._style()
        m, pk = _reel(), {"name": "corner-tag", "music": "drop"}
        long = {"pieces": [{"start": 0.0, "end": 6.0, "kills": 1}, {"start": 8.0, "end": 14.0, "kills": 1}],
                "seconds": 12.0, "peaks": [2.0, 10.0]}
        lp = self.cl._style_pick({"reelStyles": self.data}, "montage", long, pk, "M1", "rec.mp4")[1]["pieces"]
        self.assertGreater(len(lp), 2)  # 6 s pieces cut into shots of about 1.2 s
        for k in long["peaks"]:
            self.assertTrue(any(p["start"] <= k < p["end"] for p in lp), k)  # never cut through (or past) a kill
        sty, m2, pk2 = self.cl._style_pick({"reelStyles": self.data}, "montage", m, pk, "M1", "rec.mp4")
        self.assertEqual(sty["id"], "warm")
        for k in m["peaks"]:
            self.assertTrue(any(p["start"] <= k < p["end"] for p in m2["pieces"]), k)  # never cut through a kill
        self.assertEqual((pk2["name"], pk2["nameFrom"]), ("lower-third", "style"))
        self.assertEqual(m2["styleMusicEnergy"], sty["music"]["energyLevel"])
        self.assertIsNone(self.cl._style_pick({"reelStyles": self.data}, "montage", m, {"name": None}, "M1")[2]["name"])
        tr = self.rs.transitions_for(sty["transitions"], m2["pieces"], "M1|rec.mp4", self.rt)
        self.assertTrue(tr and tr.get("setFrom") == "cinematic")
        xd = self.mont.crossfade_sec(m2["pieces"], tr)
        m3, zoom, lut, rec = self.cl._style_render_plan(sty, m2, xd, "missing.mp4", self.tmp)
        self.assertEqual(lut, "style.cube")
        self.assertTrue(os.path.isfile(os.path.join(self.tmp, "style.cube")))
        self.assertTrue(zoom and zoom["times"])
        for t in zoom["times"]:
            self.assertFalse(any(a - 0.2 <= t <= b + 0.15 for a, b in self.rs.join_windows(m3["pieces"], xd)), t)
        self.assertFalse(any(p.get("ramp") for p in m3["pieces"]))  # 3 s pieces: no room for a ramp, none forced
        sl, ml, pl = self.cl._style_pick({"reelStyles": self.data}, "montage", long, pk, "M1", "rec.mp4")
        mr = self.cl._style_render_plan(sl, ml, 0.0, "missing.mp4", self.tmp)[0]
        self.assertEqual(sum(1 for p in mr["pieces"] if p.get("ramp")), 1)  # the first kill's shot is held for it
        self.assertEqual(rec["id"], "warm")
        m4 = self.cl._style_render_plan(sty, m2, xd, "missing.mp4", self.tmp, captions=True)[0]
        self.assertFalse(any(p.get("ramp") for p in m4["pieces"]))  # no slow motion under captions
        self.cl._style_cleanup(self.tmp)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "style.cube")))

    def test_style_off_by_flag(self):
        self._style()
        cc.write_json_atomic(os.path.join(self.data, cc.LOCAL_FLAGS), {"flags": {"reel-styles": False}})
        self.assertIsNone(self.cl._style_pick({"reelStyles": self.data}, "montage", _reel(), None, "M1")[0])

    def test_live_clip_takes_the_style_single_piece_too(self):
        """Codex RS review: live clips (type live-clip = the reel style) get pace, zoom, ramp and LUT, a single piece
        included: a styled clip renders through the pieces path, and that render carries the zoom and the LUT."""
        self._style()
        cc.write_json_atomic(os.path.join(self.data, cc.SETTINGS_FILE), {"clips": {"reelStyles": {"byType": {"reel": "warm"}}}})
        one = {"pieces": [{"start": 0.0, "end": 8.0, "kills": 2}], "seconds": 8.0, "peaks": [2.0, 6.0], "hook": {}}
        sty, m, _pk = self.cl._style_pick({"reelStyles": self.data}, "live-clip", one, None, "L1", "save.mp4")
        self.assertEqual(sty["id"], "warm")
        self.assertGreater(len(m["pieces"]), 1)  # an 8 s single piece is paced into shots
        m2, zoom, lut, rec = self.cl._style_render_plan(sty, m, 0.0, "missing.mp4", self.tmp)
        self.assertEqual(lut, "style.cube")
        seen = {}
        real = self.cl._render_job
        def fake(mk, encoder, wd, part, what):
            seen["argv"] = " ".join(mk(encoder))
            raise cc.ClipError("stop here")
        self.cl._render_job = fake
        try:
            with self.assertRaises(cc.ClipError):
                self.cl._render_pieces("ffmpeg", "save.mp4", m2["pieces"], FRAME, "libopenh264", self.tmp, "v",
                                       {"has_audio": True, "audio_tracks": 1}, 80, 30.0, zoom=zoom, lut=lut)
        finally:
            self.cl._render_job = real
        self.assertEqual(seen["argv"].count("lut3d="), 1)
        if zoom:
            self.assertIn("zoompan", seen["argv"])
        import inspect  # noqa: PLC0415 - the live review path wires it (a styled clip always takes the pieces path)
        src = inspect.getsource(self.cl)
        self.assertIn('_style_pick(ex, "live-clip"', src)
        self.assertIn("or sty is not None)", src)
        self.assertIn("ttl, mus, zoom=zoom, lut=lut)", src)
        self.cl._style_cleanup(self.tmp)

    def test_non_canvas_live_layouts_get_the_colour_and_a_plain_note(self):
        """Codex RS verify: crop, fill and stack layouts render one piece of the save through their own geometry: the
        style's colour (LUT) is applied there; pace, joins, zoom pulses and slow motion are not, and the clip row says
        so in plain words per layout."""
        import clip_render as rnd  # noqa: PLC0415
        seen = []
        real = rnd.run_tool
        rnd.run_tool = lambda argv, **k: seen.append(" ".join(argv)) or type("R", (), {"returncode": 1, "stderr": "stop"})()
        try:
            for kind in ("crop", "fill", "canvas"):
                with self.assertRaises(cc.ClipError):
                    rnd.render_variant("ffmpeg", "save.mp4", {"width": 1920, "height": 1080, "has_audio": True},
                                       {"id": "L1", "start": 1.0, "end": 9.0}, {"id": f"v-{kind}", "kind": kind}, FRAME,
                                       "libopenh264", self.tmp, lut="style.cube")
            with self.assertRaises(cc.ClipError):
                rnd.render_variant("ffmpeg", "save.mp4", {"width": 1920, "height": 1080, "has_audio": True},
                                   {"id": "L1", "start": 1.0, "end": 9.0}, {"id": "v-crop", "kind": "crop"}, FRAME,
                                   "libopenh264", self.tmp)
        finally:
            rnd.run_tool = real
        for a in seen[:3]:
            self.assertEqual(a.count("lut3d=file=style.cube"), 1)
        self.assertNotIn("lut3d", seen[3])  # no style: the command line as before
        n = self.cl._style_skip_note({"id": "v-crop", "kind": "crop"})
        self.assertEqual(n["layout"], "v-crop")
        self.assertEqual(n["note"], "style not applied: v-crop (crop layout gets the colour only; pace, joins, zoom "
                                    "pulses and slow motion need the canvas layout)")
        import inspect  # noqa: PLC0415
        src = inspect.getsource(self.cl)
        self.assertIn("frame, encoder, wd, lut=lut)", src)
        self.assertIn('**({"styleNotApplied": style_skips} if style_skips else {})', src)

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg missing")
    def test_rendered_reel_measures_back_close_to_the_style(self):
        import style_analyse as sa  # noqa: PLC0415
        src = os.path.join(self.tmp, "rec.mp4")
        spec = {"w": 270, "h": 480, "fps": 30, "joins": ["hard", "hard", "hard"],
                "shots": [{"sec": 4.0, "hue": h, "speed": 3.0} for h in (10, 70, 130, 40)]}
        sf.write(src, spec, audio=sf.beat_audio(16.0, 120.0), codec="libx264", crf=16)
        tr_all_fades = {"mix": {"hard": 0.0, "fade": 1.0, "flash": 0.0, "whip": 0.0}, "mode": "set", "set": "cinematic",
                        "weights": {"fade": 1.0, "flash": 0.0, "whip": 0.0}}
        self._style(transitions=tr_all_fades, ramps=None, tune={"shotSec": 4.0})
        m = _reel()
        sty, m2, _pk = self.cl._style_pick({"reelStyles": self.data}, "montage", m, None, "M1", "rec.mp4")
        self.assertEqual(len(m2["pieces"]), 4)  # tuned to 4 s shots: no extra cuts, one join per hue change
        tr = self.rs.transitions_for(sty["transitions"], m2["pieces"], "M1|rec.mp4", self.rt)
        xd = self.mont.crossfade_sec(m2["pieces"], tr)
        m3, zoom, lut, rec = self.cl._style_render_plan(sty, m2, xd, src, self.tmp)
        argv = self.mont.render_argv("ffmpeg", src, m3["pieces"], FRAME, ENC, AUD, 80, "reel.mp4", transition=tr,
                                     zoom=zoom, lut=lut)
        self.assertEqual(" ".join(argv).count("lut3d="), 1)  # the LUT once in the graph
        r = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr[-600:])
        out = os.path.join(self.tmp, "reel.mp4")
        j = cc.probe("ffprobe", out)
        self.assertEqual(len([s for s in j["streams"] if s["codec_type"] == "audio"]), 1)  # audio encoded once
        got = sa.analyse_video(out, ocr=False)
        kinds = [e["kind"] for e in got["transitions"]["events"]]
        print("\nplanned joins:", tr)
        print(f"\nRS4 reel: joins measured {kinds}; zoom planned {zoom['times'] if zoom else None}, measured "
              f"{[p['t'] for p in got['zooms']['pulses']]}; LUT planned {rec.get('colour')}")
        self.assertEqual(len(kinds), 3, got["transitions"])
        # every join is soft (no hard cut, no whip); most read as fades. A cross fade between shots of very different
        # brightness can read as a flash (RS1 limit, measured 2026-11-21: 2 of 3 fades, 1 flash; UNVERIFIED on real reels)
        self.assertTrue(all(x in ("fade", "dissolve") for x in tr["joins"]), tr)
        self.assertFalse({"hard", "whip"} & set(kinds), kinds)
        self.assertGreaterEqual(kinds.count("fade"), 2, kinds)
        if zoom:
            for t in zoom["times"]:
                self.assertTrue(any(abs(p["t"] - t) <= 0.15 for p in got["zooms"]["pulses"]), (t, got["zooms"]["pulses"]))
        # colour: each piece measured against the same piece of the source
        src_c = self.rs.clip_colour(src, m3["pieces"])
        outs, acc = [], 0.0
        for p in m3["pieces"]:
            d = p["end"] - p["start"]
            outs.append({"start": acc + 0.6, "end": acc + d - 0.6})
            acc += d - xd
        out_c = self.rs.clip_colour(out, outs)
        # b carries the style's main shift (-10.5 here) and lands within 2.0; on these fully saturated synthetic hues the
        # LUT's gamut clipping moves a by up to about 4 (measured 2026-11-21: planned -1.0, got +2.8). RS2 measures the
        # LUT alone on a mid-saturated clip within 1.5 for both.
        self.assertLessEqual(abs((out_c["b"] - src_c["b"]) - rec["colour"]["b"]), 2.0, (out_c, src_c, rec["colour"]))
        self.assertLessEqual(abs((out_c["a"] - src_c["a"]) - rec["colour"]["a"]), 4.5, (out_c, src_c, rec["colour"]))


if __name__ == "__main__":
    unittest.main()
