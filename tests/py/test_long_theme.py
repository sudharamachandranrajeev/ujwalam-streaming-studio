# SPDX-License-Identifier: GPL-3.0-or-later
"""Long-video theme selection, batch continuity and posting provenance at the shared long-job entry point."""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_loudness as loud  # noqa: E402
import clip_publish  # noqa: E402
import clipper  # noqa: E402
import detector_pass as detector  # noqa: E402
import long_teaching  # noqa: E402
import long_theme  # noqa: E402
import long_video as lv  # noqa: E402
import scene_music  # noqa: E402


class Theme(unittest.TestCase):
    def test_no_override_uses_the_old_path(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(long_theme.active(d, {}))
            with long_theme.soundtrack(None, "example", d, lv.ATTEMPT_PREFIX) as result:
                self.assertEqual(result, (None, None))
            self.assertEqual(os.listdir(d), [])

    def test_off_air_required_only_for_synthesis(self):
        for live in (True, None):
            with patch.object(long_theme, "on_air", return_value=live), self.assertRaisesRegex(cc.ClipError, "off-air"):
                with long_theme.soundtrack({}, "example", "", lv.ATTEMPT_PREFIX):
                    self.fail("started synthesis")

    def test_long_job_uses_one_theme_for_the_edit_and_all_audio_passes(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            rec = root / "example.mkv"
            rec.touch()
            out = root / "run"
            out.mkdir()
            (root / cc.LOCAL_FLAGS).write_text(json.dumps({"flags": {long_theme.FLAG: True}}), encoding="utf-8")
            (out / detector.SUMMARY).write_text(json.dumps({"recording": rec.name}), encoding="utf-8")
            hits = [{"t": t, "detector": "M5", "label": "x", "signal": True} for t in (20, 50, 80)]
            (out / detector.HITS).write_text("\n".join(map(json.dumps, hits)), encoding="utf-8")
            a = argparse.Namespace(out=str(out), recording=str(rec), data_dir=d, ranking=None, encoder="libopenh264")
            cfg = dict(lv.load_config(), minSec=2, maxSec=60, batchPieces=2)
            theme = long_theme.active(d, cfg)
            matches, _ = clipper._reel_matches(a, str(out / detector.HITS), 100)
            planned = lv.plan(hits, cc.load_config("ranking"), cc.load_config("montage"), 100,
                              matches, dict(cfg, padSec=theme["padSec"]), theme["transition"])
            expected = planned["seconds"]
            probes, renders, cards = [], [], []

            def generate(_mood, seed, path, bars):
                with wave.open(path, "wb") as wav:
                    wav.setparams((2, 2, 48000, 0, "NONE", "uncompressed"))
                    wav.writeframes(bytes(48000 * 4))
                return {"seed": seed, "lufs": -33, "bars": bars}

            def fake_job(builder, encoder, folder, name, what):
                argv = builder(encoder)
                renders.append(argv)
                cards.append((Path(folder) / "captions.ass").read_text(encoding="utf-8"))
                (Path(folder) / name).touch()
                return subprocess.CompletedProcess(argv, 0, "", ""), encoder

            def fake_run(argv, cwd, timeout):
                if argv[-1] == "-":
                    probes.append(argv)
                    lufs = -14 if "volume=26.00dB,aresample" in " ".join(argv) else -40
                    return subprocess.CompletedProcess(argv, 0, "", f"Integrated loudness:\n I: {lufs} LUFS\n")
                (Path(cwd) / argv[-1]).touch()
                return subprocess.CompletedProcess(argv, 0, "", "")

            info = {"duration": 100, "width": 1920, "height": 1080, "has_audio": True, "audio_tracks": 2}
            check = {"ok": True, "issues": [], "facts": {"duration": expected}}
            with (patch.object(long_theme, "on_air", return_value=False), patch.object(scene_music, "generate", generate),
                  patch.object(lv, "load_config", return_value=cfg), patch.object(clipper, "_tools", return_value=("ffmpeg", "ffprobe")),
                  patch.object(clipper, "media_info", return_value=info), patch.object(clipper, "_render_job", fake_job),
                  patch.object(clipper.rnd, "run_tool", fake_run), patch.object(clipper.val, "validate_file", return_value=check),
                  patch.object(clipper, "_loud_check", side_effect=lambda ffmpeg, path, entry, kind: entry),
                  patch.dict(os.environ, {"UJWALAM_REEL_CAPTIONS": "off"})):
                self.assertEqual(clipper.cmd_long(a), 0)
            doc = cc.load_json(str(out / lv.SUBDIR / clipper.RENDER))
            self.assertEqual(doc["theme"], {"id": theme["id"], "version": theme["version"]})
            self.assertEqual(doc["transition"], theme["transition"])
            clip = doc["clips"][0]
            self.assertEqual(clip["pieces"], planned["segments"])
            self.assertEqual(clip_publish.music_provenance(clip, records=True)["source"], "generated")
            self.assertEqual(clip["music"]["mixTargetLufs"], -52)
            self.assertEqual(clip["music"]["bedGainDb"], -19)
            self.assertEqual(len(clip["cardStyles"]), 3)
            self.assertTrue(set(clip["cardStyles"]).issubset(theme["cardStyles"]))
            self.assertEqual(len(renders), 2)
            self.assertIn("xfade=transition=slideleft", " ".join(renders[0]))
            for argv, ass in zip(renders, cards):
                g = " ".join(argv)
                self.assertRegex(g, r"colorbalance=[^\[]*:pl=1,format=yuv420p\[", "graded picture back to 4:2:0")
                self.assertIn("alimiter=", g)
                self.assertIn(":latency=1,", g, "no look-ahead delay at the batch joins")
                self.assertIn("[aout1]", argv)
                self.assertIn(long_teaching._colour(theme["palette"]["accent"]), ass)
                self.assertIn(loud.probe_argv(argv), probes)
            start = round(lv.video_seconds(clip["pieces"][:2], theme["transition"]) * 48000) % 48000
            self.assertNotEqual(start, 0)
            self.assertIn(f"atrim=start_sample={start}:", " ".join(renders[1]))
            self.assertFalse(list((out / lv.SUBDIR).glob(lv.ATTEMPT_PREFIX + "*")))


class AstraReview(unittest.TestCase):
    def test_card_styles_merge_in_video_order_and_a_dropped_overlay_has_none(self):
        infos = [{"status": "off", "cards": 2, "chapters": 2, "cardStyles": ["a", "b"]},
                 {"status": "off", "cards": 1, "chapters": 1, "cardStyles": ["c"]},
                 {"status": "failed", "cards": 0, "chapters": 0}]  # a batch with no overlay at all
        self.assertEqual(long_teaching.merge_info(infos)["cardStyles"], ["a", "b", "c"])
        self.assertEqual(long_teaching.merge_info([])["cardStyles"], [])

    def test_a_second_long_render_leaves_the_running_one_alone(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / lv.SUBDIR
            out.mkdir()
            busy = out / (lv.ATTEMPT_PREFIX + "running")
            busy.mkdir()
            a = argparse.Namespace(out=d, recording=None, data_dir=d)
            with cc.HeavyJobLock(str(out), job="long video"):
                with patch.object(clipper, "_long_video_steps", side_effect=AssertionError("must not start")):
                    status = clipper._long_video(a)
            self.assertEqual(status["status"], "failed")
            self.assertIn("another long video", status["reason"])
            self.assertTrue(busy.is_dir(), "the running render's soundtrack folder is kept")
            self.assertFalse((out / lv.STATUS).exists(), "the running render owns long.json")
