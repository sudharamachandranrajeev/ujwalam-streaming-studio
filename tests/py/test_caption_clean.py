# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T5: the clean-up step around the local model (services/clip/reel_captions.py clean_transcript). The model itself
is the Node side (tests/caption-clean.test.mjs); here the Node call is injected. Timing is sacred; any failure keeps
the transcript; the cleaned text reaches captions.srt and captions.vtt."""

import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import reel_captions as rcap  # noqa: E402


def _doc():
    return {"segments": [{"start": 0.0, "end": 1.0, "text": "adipolli", "show": True}]}


def _result(out):
    return type("R", (), {"returncode": 0, "stdout": out, "stderr": ""})()


class CleanStepTest(unittest.TestCase):
    def test_clean_flags_need_both_switches(self):
        with patch.object(rcap, "flag_on", side_effect=lambda d, f: f == "ai-captions"):
            self.assertIsNone(rcap.clean_flags("x"))
        with patch.object(rcap, "flag_on", return_value=True):
            self.assertEqual(rcap.clean_flags("x"), ["local-ai-model", "ai-captions"])
        self.assertIsNone(rcap.clean_flags(None))

    def test_no_flags_or_failure_keeps_the_transcript(self):
        doc = _doc()
        self.assertEqual(rcap.clean_transcript(doc, ".", None), (doc, None))
        with tempfile.TemporaryDirectory() as wd:
            cc.write_json_atomic(os.path.join(wd, rcap.TRANSCRIPT), doc)

            def boom(*a, **k):
                raise OSError("no node")
            out, st = rcap.clean_transcript(doc, wd, ["a"], node="node", run=boom)
            self.assertIs(out, doc)
            self.assertEqual(st["status"], "failed")

    def test_changed_timing_is_refused_and_file_restored(self):
        doc = _doc()
        with tempfile.TemporaryDirectory() as wd:
            p = os.path.join(wd, rcap.TRANSCRIPT)
            cc.write_json_atomic(p, doc)

            def fake(argv, **k):
                cc.write_json_atomic(p, {"segments": [{"start": 0.0, "end": 2.0, "text": "Adipoli", "show": True}]})
                return _result('{"status": "cleaned"}\n')
            out, st = rcap.clean_transcript(doc, wd, ["a"], node="node", run=fake)
            self.assertIs(out, doc)
            self.assertEqual(st["reason"], "timing changed")
            self.assertEqual(cc.load_json(p)["segments"][0]["end"], 1.0)

    def test_cleaned_text_reaches_the_subtitle_files(self):
        doc = _doc()
        with tempfile.TemporaryDirectory() as wd:
            p = os.path.join(wd, rcap.TRANSCRIPT)

            def fake(argv, **k):
                cc.write_json_atomic(p, {"segments": [{"start": 0.0, "end": 1.0, "text": "Adipoli!",
                                                       "rawText": "adipolli", "show": True}]})
                return _result('{"status": "cleaned", "changed": 1}\n')
            out, st = rcap.clean_transcript(doc, wd, ["a"], node="node", run=fake)
            self.assertEqual(st["status"], "cleaned")
            rcap.write_subtitles(out, wd)
            for name in rcap.SUBS:
                with open(os.path.join(wd, name), encoding="utf8") as f:
                    self.assertIn("Adipoli!", f.read())

    def test_make_transcript_cleans_before_returning(self):
        seen = []

        def cleaner(doc, workdir, flags):
            seen.append(flags)
            return dict(doc, segments=[dict(doc["segments"][0], text="Hello.")]), {"status": "cleaned"}
        cfg, style = rcap.load_config(), rcap.load_style(rcap.load_config())
        segs = [{"start": 0.0, "end": 1.0, "text": "hello", "confidence": 0.9}]
        with tempfile.TemporaryDirectory() as wd, patch.object(rcap, "run_tool") as rt:
            rt.return_value = type("R", (), {"returncode": 0})()
            wav = os.path.join(wd, "unused")  # the wav check needs a file: make the injected run create it

            def make_wav(argv, **k):
                with open(argv[-1], "wb") as f:
                    f.write(b"x")
                return type("R", (), {"returncode": 0})()
            rt.side_effect = make_wav
            doc, info = rcap.make_transcript("ffmpeg", "src", [{"start": 0, "end": 1}], cfg, style, {}, wd, 1.0,
                                             transcribe=lambda b, w, o: (segs, {"status": "ok"}),
                                             clean=["a"], cleaner=cleaner)
        self.assertEqual(seen, [["a"]])
        self.assertEqual(doc["segments"][0]["text"], "Hello.")
        self.assertEqual(info["clean"]["status"], "cleaned")
        del wav


if __name__ == "__main__":
    unittest.main()
