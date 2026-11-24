# SPDX-License-Identifier: GPL-3.0-or-later
"""D406 long highlights video: moments merged once (no footage twice), the length cap drops the lowest-scored moments
first, a too-short session gets none with a plain reason, the render batches pieces and joins them without
re-encoding (audio encoded once), and the published file is named long-highlights ... _h.mp4. Synthetic hits and fake
ffmpeg runs only; no real render."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_names as names  # noqa: E402
import clip_publish as pub  # noqa: E402
import long_video as lv  # noqa: E402
import reel_transition as rt  # noqa: E402

RANKING = cc.load_config("ranking")
MCFG = cc.load_config("montage")
CFG = lv.load_config()
FADE = {"kind": "fade", "xfade": "fade", "ms": 250}


def m(start, end, score, kills=1, kind="kills"):
    return {"start": float(start), "end": float(end), "score": float(score), "kills": kills, "kind": kind}


def used_seconds(segs):
    """Every covered second, counted once per segment: equal to the union only when no two segments overlap."""
    return sum(g["end"] - g["start"] for g in segs)


def union_seconds(segs):
    tot, last = 0.0, None
    for g in sorted(segs, key=lambda x: x["start"]):
        s, e = g["start"], g["end"]
        if last is not None and s < last:
            s = last
        if e > s:
            tot += e - s
        last = max(last or e, e)
    return tot


class Config(unittest.TestCase):
    def test_band_and_flag(self):
        self.assertEqual((CFG["minSec"], CFG["maxSec"]), (480, 1200))  # about 8-20 minutes (user 2026-11-20)
        self.assertEqual(CFG["flag"], lv.FLAG)
        self.assertEqual(lv.FLAG, "long-highlights-video")

    def test_flag_default_on(self):
        with open(os.path.join(os.path.dirname(__file__), "..", "..", "data", "flags.json"), encoding="utf-8") as f:
            row = next(x for x in json.load(f)["flags"] if x["id"] == lv.FLAG)
        self.assertIs(row["default"], True)
        self.assertEqual(row["page"], "clips")
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(lv.on(d))
            with open(os.path.join(d, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                json.dump({"flags": {lv.FLAG: False}}, f)
            self.assertFalse(lv.on(d))

    def test_transition_is_a_fade_or_cut_never_a_flash(self):
        with tempfile.TemporaryDirectory() as d:
            tr = lv.transition(d, CFG, rt)  # reel-transitions off by default: the data default
            self.assertEqual(tr["xfade"], "fade")
            self.assertLessEqual(tr["ms"], 500)
            with open(os.path.join(d, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                json.dump({"flags": {rt.FLAG: True}}, f)
            with open(os.path.join(d, cc.SETTINGS_FILE), "w", encoding="utf-8") as f:
                json.dump({"clips": {"reelTransition": {"kind": "cut", "ms": 0}}}, f)
            self.assertIsNone(lv.transition(d, CFG, rt))  # the user's Cut stays a cut


class Merge(unittest.TestCase):
    def test_overlapping_windows_merge_once(self):
        moms = [m(100, 110, 2), m(108, 120, 3), m(119, 125, 1), m(300, 310, 4)]
        segs = lv.merge(moms, 2.0, 3600)
        self.assertEqual([(g["start"], g["end"]) for g in segs], [(98.0, 127.0), (298.0, 312.0)])
        self.assertEqual(segs[0]["score"], 6.0)
        self.assertEqual(segs[0]["moments"], 3)
        self.assertAlmostEqual(used_seconds(segs), union_seconds(segs))  # no second is used twice

    def test_padding_that_touches_merges_and_stays_inside_the_recording(self):
        segs = lv.merge([m(1, 5, 1), m(8, 12, 1), m(95, 99, 1)], 2.0, 100)
        self.assertEqual([(g["start"], g["end"]) for g in segs], [(0.0, 14.0), (93.0, 100.0)])

    def test_unsorted_input_comes_out_in_time_order(self):
        segs = lv.merge([m(500, 510, 1), m(10, 20, 1), m(200, 210, 1)], 1.0, 3600)
        self.assertEqual([g["start"] for g in segs], sorted(g["start"] for g in segs))


class Fit(unittest.TestCase):
    def test_lowest_scored_dropped_first_until_it_fits(self):
        segs = [dict(m(i * 100, i * 100 + 60, s), kinds=["kills"], moments=1) for i, s in enumerate([5, 1, 9, 2, 7])]
        keep, dropped = lv.fit(segs, 200, None)  # 5 x 60 s = 300 s; cut: 200 s
        self.assertEqual([g["score"] for g in dropped], [1.0, 2.0])
        self.assertEqual([g["score"] for g in keep], [5.0, 9.0, 7.0])  # time order kept
        self.assertLessEqual(lv.video_seconds(keep, None), 200)

    def test_crossfade_shortens_the_video(self):
        segs = [dict(m(i * 100, i * 100 + 10, 1), kinds=["kills"], moments=1) for i in range(4)]
        self.assertAlmostEqual(lv.video_seconds(segs, FADE), 40 - 3 * 0.25)

    def test_batch_joins_have_no_crossfade_so_the_cap_holds_as_rendered(self):
        # Codex D406 P2: 13 pieces in batches of 12 have 11 cross-faded joins, not 12; the plan must count that
        segs = [dict(m(i * 1000, i * 1000 + 1203 / 13, 1), kinds=["kills"], moments=1) for i in range(13)]
        self.assertAlmostEqual(lv.video_seconds(segs, FADE, 12), sum(g["end"] - g["start"] for g in segs) - 11 * 0.25)
        self.assertGreater(lv.video_seconds(segs, FADE, 12), lv.video_seconds(segs, FADE))
        keep, dropped = lv.fit(segs, 1200, FADE, 12)
        self.assertLessEqual(lv.video_seconds(keep, FADE, 12), 1200)
        self.assertEqual(len(dropped), 1, "the one-batch count would have kept all 13 and rendered past the cap")
        self.assertAlmostEqual(lv.video_seconds(segs, FADE), 1200)  # the old count: fits exactly ...
        self.assertAlmostEqual(lv.video_seconds(segs, FADE, 12), 1200.25)  # ... but renders 0.25 s past the cap


class Plan(unittest.TestCase):
    def _cfg(self, **kw):
        return dict(CFG, **kw)

    def test_too_short_session_gets_none_with_a_plain_reason(self):
        hits = [{"t": 600.0, "detector": "M5", "label": "x", "signal": True}]
        p = lv.plan(hits, RANKING, MCFG, 3600, [], CFG, FADE)
        self.assertEqual(p["status"], "skipped")
        self.assertIn("a long video needs at least 8 minutes", p["reason"])

    def test_no_moments(self):
        p = lv.plan([], RANKING, MCFG, 3600, [], CFG, FADE)
        self.assertEqual(p, {"status": "skipped", "reason": "no kills or wins were found in the recording", "moments": 0})

    def test_kills_and_a_win_planned_in_time_order_and_capped(self):
        # kill groups every 60 s (each ~4.5 s + pads) and one won match whose result screen is a moment
        hits = [{"t": 30.0 + 60 * i, "detector": "M5", "label": "x", "signal": True} for i in range(200)]
        matches = [{"index": 0, "start": 0.0, "end": 12100.0, "endScreenAt": 12050.0, "resultAt": 12051.0,
                    "result": "VICTORY"}]
        cfg = self._cfg(minSec=60, maxSec=300)
        p = lv.plan(hits, RANKING, MCFG, 12100, matches, cfg, FADE)
        self.assertEqual(p["status"], "planned")
        self.assertLessEqual(p["seconds"], 300)
        self.assertGreater(p["dropped"], 0)
        starts = [g["start"] for g in p["segments"]]
        self.assertEqual(starts, sorted(starts))
        self.assertIn("win", p["segments"][-1]["kinds"])  # the win scores highest: never dropped first
        self.assertAlmostEqual(used_seconds(p["segments"]), union_seconds(p["segments"]))


class Render(unittest.TestCase):
    def test_batches_then_join_with_one_audio_encode(self):
        segs = [{"start": i * 100.0, "end": i * 100.0 + 20, "kills": 1} for i in range(30)]
        calls = []

        def render_job(mk, enc, wd, part, what):
            argv = mk(enc)
            calls.append(argv)
            open(os.path.join(wd, part), "wb").close()
            return subprocess.CompletedProcess(argv, 0, "", ""), enc

        def run_tool(argv, cwd=None, timeout=None):
            calls.append(argv)
            open(os.path.join(cwd, argv[-1]), "wb").close()
            return subprocess.CompletedProcess(argv, 0, "", "")
        enc = {"h264_nvenc": ["-c:v", "h264_nvenc"]}
        with tempfile.TemporaryDirectory() as wd:
            ok, exp, err = lv.render("ffmpeg", "C:/rec/h.mkv", segs, CFG["frame"], "h264_nvenc", wd, 2, 80, FADE, 12,
                                     render_job, run_tool, enc, ["-c:a", "aac"])
            self.assertTrue(ok, err)
            self.assertEqual(os.listdir(wd), [lv.FILE])  # parts and the list removed
        self.assertEqual(len(calls), 4)  # 12 + 12 + 6 pieces, then one join
        for argv in calls[:3]:
            self.assertIn("h264_nvenc", argv)
            self.assertEqual(argv[argv.index("-c:a") + 1], "pcm_s24le")  # the parts keep their sound as PCM ...
            self.assertNotIn("aac", argv)
            self.assertIn("scale=1920:1080:force_original_aspect_ratio=decrease", " ".join(argv))
            self.assertIn("xfade=transition=fade", " ".join(argv))
        join = calls[3]
        self.assertEqual(join[join.index("-c:v") + 1], "copy")  # the picture is copied when joined ...
        self.assertEqual(join[join.index("-c:a") + 1], "aac")  # ... and the sound encoded once (no AAC delay per join)
        self.assertAlmostEqual(exp, 600 - 0.25 * (11 + 11 + 5))

    def test_failed_part_leaves_nothing(self):
        def render_job(mk, enc, wd, part, what):
            return subprocess.CompletedProcess([], 1, "", "boom"), enc
        with tempfile.TemporaryDirectory() as wd:
            ok, _, err = lv.render("ffmpeg", "x.mkv", [{"start": 0, "end": 10, "kills": 1}], CFG["frame"], "e", wd, 1,
                                   80, None, 12, render_job, None, {"e": []}, [])
            self.assertFalse(ok)
            self.assertIn("did not render", err)
            self.assertEqual(os.listdir(wd), [])

    def test_an_exception_or_an_earlier_kill_leaves_no_part_files(self):
        # Codex D406 P2: parts live in a per-attempt folder removed in finally; a folder left by a kill goes next start
        def render_job(mk, enc, wd, part, what):
            open(os.path.join(wd, part), "wb").close()
            raise RuntimeError("killed")
        with tempfile.TemporaryDirectory() as wd:
            os.makedirs(os.path.join(wd, lv.ATTEMPT_PREFIX + "old"))
            open(os.path.join(wd, lv.ATTEMPT_PREFIX + "old", "part-000.mp4"), "wb").close()
            with self.assertRaises(RuntimeError):
                lv.render("ffmpeg", "x.mkv", [{"start": 0, "end": 10, "kills": 1}], CFG["frame"], "e", wd, 1,
                          80, None, 12, render_job, None, {"e": []}, [])
            self.assertEqual(os.listdir(wd), [])

    def test_cap_is_enforced_on_the_probed_file_and_planned_with_a_margin(self):
        # Codex D406 re-review: the tolerance never lets a file over maxSec through; the plan leaves room for rounding
        cfg = dict(CFG, maxSec=1200)
        self.assertTrue(lv.duration_ok(1201, 1200))  # inside the duration tolerance ...
        self.assertTrue(lv.over_cap(1201, cfg))  # ... but over the cap: failed, not published
        self.assertFalse(lv.over_cap(1200, cfg))
        segs = [dict(m(i * 1000, i * 1000 + 100, 1), kinds=["kills"], moments=1) for i in range(13)]  # 1300 s
        keep, _ = lv.fit(segs, cfg["maxSec"] - lv.CAP_MARGIN_SEC, FADE, 12)
        self.assertLessEqual(lv.video_seconds(keep, FADE, 12), 1200 - lv.CAP_MARGIN_SEC)

    def test_duration_tolerance(self):
        self.assertTrue(lv.duration_ok(900.9, 900))
        self.assertFalse(lv.duration_ok(890, 900))


class Step(unittest.TestCase):
    """clipper._long_video always writes DIR/long/long.json (the studio keeps the recording until it says made,
    skipped or off) and never raises."""

    def _run(self, d, **kw):
        import argparse
        import clipper  # noqa: PLC0415
        a = argparse.Namespace(out=os.path.join(d, "run"), data_dir=d, recording=None, **kw)
        os.makedirs(a.out, exist_ok=True)
        st = clipper._long_video(a)
        with open(os.path.join(a.out, lv.SUBDIR, lv.STATUS), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["status"], st["status"])
        return st

    def test_flag_off(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                json.dump({"flags": {lv.FLAG: False}}, f)
            self.assertEqual(self._run(d)["status"], "off")

    def test_abandoned_attempts_cleared_on_every_path(self):
        # Codex D406 re-review: a retry that ends early (flag off, no recording) still removes a killed attempt's folder
        for flag in (False, True):
            with tempfile.TemporaryDirectory() as d:
                with open(os.path.join(d, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                    json.dump({"flags": {lv.FLAG: flag}}, f)
                old = os.path.join(d, "run", lv.SUBDIR, "clips", lv.CLIP_ID, lv.ATTEMPT_PREFIX + "x")
                os.makedirs(old)
                open(os.path.join(old, "part-000.mp4"), "wb").close()
                self.assertIn(self._run(d)["status"], ("off", "skipped"))
                self.assertFalse(os.path.exists(old))

    def test_status_names_its_recording(self):
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "h.mkv")
            open(rec, "wb").close()
            import argparse
            import clipper  # noqa: PLC0415
            a = argparse.Namespace(out=os.path.join(d, "run"), data_dir=d, recording=rec, detect_ran=True)
            os.makedirs(a.out, exist_ok=True)
            st = clipper._long_video(a)
            self.assertEqual(st["recording"], "h.mkv")
            self.assertEqual(st["recordingPath"], os.path.abspath(rec))  # Codex D406: bound to the file, not its name
            self.assertEqual(sorted(st["recordingId"]), ["ino", "mtimeNs", "size"])
            self.assertEqual(st["recordingId"]["size"], "0")

    def test_no_recording(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self._run(d), dict(self._run(d), status="skipped", reason="the stream was not recorded"))

    def test_error_is_a_failed_status(self):
        with tempfile.TemporaryDirectory() as d:
            rec = os.path.join(d, "h.mkv")
            open(rec, "wb").close()
            import argparse
            import clipper  # noqa: PLC0415
            a = argparse.Namespace(out=os.path.join(d, "run"), data_dir=d, recording=rec, detect_ran=True)
            os.makedirs(a.out, exist_ok=True)
            st = clipper._long_video(a)  # no detector hits in the run folder
            self.assertEqual(st["status"], "failed")
            self.assertIn("no detector hits", st["reason"])


class Names(unittest.TestCase):
    def test_kind_and_h_canvas(self):
        self.assertEqual(pub.kind_of("X1", lv.TOOL), "long-highlights")
        rdoc = {"tool": lv.TOOL, "recording": "alpha-20261118-200000.mkv",
                "clips": [{"id": "X1", "start": 0.0, "end": 900.0, "labels": [],
                           "pieces": [{"start": 60.0, "end": 80.0, "kills": 3}, {"start": 200.0, "end": 230.0, "kills": 4}],
                           "files": [{"layout": lv.LAYOUT, "file": lv.FILE}]}]}
        (_, _, kind, when, label, canvas), = pub.name_rows(rdoc, "codm", {})
        self.assertEqual((kind, label, canvas), ("long-highlights", "kills-7", "h"))
        name = names.clip_name("codm", kind, when, label, 1, canvas)
        self.assertRegex(name, names.NAME_RE)
        self.assertTrue(name.startswith("codm_long-highlights_20261118-200100_kills-7_01_h"))


if __name__ == "__main__":
    unittest.main()
