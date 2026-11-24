# SPDX-License-Identifier: GPL-3.0-or-later
"""ED2 burned-in captions (services/clip/reel_captions.py, D353): confidence threshold as data, original script kept,
bundled OFL font only (and what it cannot draw is not burned), V safe zone, transcript stored and editable, recaption
renders the reel again with the edited text. Synthetic audio and video only; the speech to text is injected (real
model quality is UNVERIFIED and belongs to STT-ML). ffmpeg cases skip without ffmpeg."""

import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_captions as caps  # noqa: E402
import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import clipper  # noqa: E402
import reel_captions as rcap  # noqa: E402
import reel_length as rl  # noqa: E402

CFG = rcap.load_config()
STYLE = rcap.load_style(CFG)
SAFE = caps.safe_area(cc.load_config("targets"))
FRAME = {"width": 1080, "height": 1920}
FONT = os.path.join(rcap.FONTS_DIR, STYLE["fontFile"])
CPS = rcap.font_codepoints(FONT)
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
ML = "നല്ല കളി"  # Malayalam words (synthetic, no real speech)
try:
    from fontTools.ttLib import TTFont  # noqa: PLC0415 (dev check only; not a runtime dependency)
except ImportError:
    TTFont = None


def seg(a, b, text, conf):
    return {"start": a, "end": b, "text": text, "confidence": conf}


class FontTests(unittest.TestCase):
    def test_only_bundled_ofl_fonts_and_no_microsoft_font(self):
        self.assertTrue(STYLE["fontFile"] in os.listdir(rcap.FONTS_DIR))
        for p in ("reel-captions-bold", "reel-captions-barlow"):
            st = rcap.load_style(dict(CFG, preset=p))
            self.assertNotIn(st["fontFamily"].lower(), ("arial", "corbel", "consolas", "segoe ui", "nirmala ui"))

    @unittest.skipUnless(TTFont, "fontTools not importable")
    def test_cmap_reader_matches_fonttools(self):
        for f in sorted(os.listdir(rcap.FONTS_DIR)):
            if f.endswith(".ttf"):
                p = os.path.join(rcap.FONTS_DIR, f)
                self.assertEqual(rcap.font_codepoints(p), set(TTFont(p).getBestCmap()), f)

    def test_only_the_script_font_covers_malayalam(self):
        # D353 finding, then C4 (user yes 2026-11-24): Baloo Chettan 2 is the one bundled font that draws Malayalam
        for f in sorted(os.listdir(rcap.FONTS_DIR)):
            if f.endswith(".ttf"):
                p = os.path.join(rcap.FONTS_DIR, f)
                draws = not rcap.missing_scripts(ML, rcap.font_codepoints(p))
                self.assertEqual(draws, f == "BalooChettan2-Variable.ttf", f)
                self.assertTrue(rcap.covers(p, "Latin"), f)

    def test_presets_list_the_malayalam_font(self):
        for p in ("reel-captions-bold", "reel-captions-barlow"):
            st = rcap.load_style(dict(CFG, preset=p))
            self.assertEqual([x["script"] for x in st["scriptFonts"]], ["Malayalam"])

    @unittest.skipUnless(TTFont, "fontTools not importable")
    def test_a_full_line_fits_the_safe_width(self):
        t = TTFont(FONT)
        cm, hm, upm = t.getBestCmap(), t["hmtx"], t["head"].unitsPerEm
        line = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[:STYLE["maxCharsPerLine"]]
        width = sum(hm[cm[ord(c)]][0] for c in line) * STYLE["sizePx"] / upm + 2 * STYLE["outlinePx"]
        self.assertLessEqual(width, FRAME["width"] - SAFE["left"] - SAFE["right"])
        height = STYLE["maxLines"] * STYLE["sizePx"] * 1.25 + 2 * STYLE["outlinePx"]
        self.assertLessEqual(height, FRAME["height"] - SAFE["top"] - SAFE["bottom"])


class TranscriptTests(unittest.TestCase):
    def test_threshold_and_script_marks(self):
        rows = rcap.mark([seg(0, 1, "nice shot bro", 0.9), seg(1, 2, "mumble", 0.2), seg(2, 3, "no conf", None),
                          seg(3, 4, ML + " clutch", 0.95), seg(4, 4.1, "ok", 0.99)], CFG, CPS, duration=10)
        self.assertEqual([r["show"] for r in rows], [True, False, False, True, False])
        self.assertIn("below", rows[1]["hidden"])
        self.assertIn("no confidence", rows[2]["hidden"])
        self.assertEqual(rows[3]["fontMissing"], ["Malayalam"])
        self.assertEqual(rows[3]["text"], ML + " clutch", "the original script is kept, never transliterated")

    def test_ass_has_only_shown_drawable_text_inside_the_safe_zone(self):
        tr = {"segments": rcap.mark([seg(0, 2, "what a triple kill that was", 0.9), seg(2, 3, "low", 0.1),
                                     seg(3, 5, ML, 0.9), seg(5, 6, "{\\b1}x", 0.9)], CFG, CPS)}
        text, n = rcap.to_ass(tr, FRAME, SAFE, STYLE, duration=6)
        self.assertNotIn("low", text.split("[Events]")[1])
        self.assertNotIn(ML, text)
        self.assertNotIn("{\\b1}", text, "speech text cannot inject ASS overrides")
        style = next(x for x in text.splitlines() if x.startswith("Style: Reel,"))
        f = style.split(",")
        self.assertEqual((f[1], f[2]), (STYLE["fontFamily"], str(STYLE["sizePx"])))
        self.assertEqual(f[-4:], [str(SAFE["left"]), str(SAFE["right"]), str(SAFE["bottom"]), "1"])
        self.assertEqual(f[18], "2", "bottom centre")
        cards = [x for x in text.splitlines() if x.startswith("Dialogue:")]
        self.assertEqual(n, len(cards))
        for c in cards[:2]:
            words = c.split(",,", 1)[1].replace("\\N", " ").split()
            self.assertLessEqual(len(words), STYLE["maxWordsPerCard"])

    def test_edited_transcript_is_used_as_is(self):
        tr = {"segments": rcap.mark([seg(0, 2, "wrong words", 0.9), seg(2, 3, "hidden one", 0.1)], CFG, CPS)}
        tr["segments"][0]["text"] = "right words"
        tr["segments"][1]["show"] = True  # the user shows a low-confidence line after fixing it
        text, n = rcap.to_ass(tr, FRAME, SAFE, STYLE)
        self.assertIn("right words", text)
        self.assertIn("hidden one", text)
        self.assertNotIn("wrong", text)
        tr["segments"][0]["text"] = ML  # an edit into Malayalam: drawn in the script font (C4)
        text, _ = rcap.to_ass(rcap.refresh_hidden(tr, STYLE), FRAME, SAFE, STYLE)
        self.assertIn(ML.split()[0], text)
        tr["segments"][0]["text"] = "வணக்கம்"  # Tamil: no bundled font draws it, so it is not burned
        text, _ = rcap.to_ass(rcap.refresh_hidden(tr, STYLE), FRAME, SAFE, STYLE)
        self.assertNotIn("வணக்கம்", text)
        self.assertEqual(tr["segments"][0]["fontMissing"], ["Tamil"])

    def test_manglish_line_burns_in_the_script_font(self):
        """C4: a Malayalam or mixed line is drawn whole in Baloo Chettan 2; an English line keeps the main font."""
        rows = rcap.mark([seg(0, 2, "nice shot", 0.9), seg(2, 4, ML + " clutch", 0.9)], CFG, rcap.glyph_check(STYLE))
        self.assertFalse(any(r.get("fontMissing") for r in rows))
        text, n = rcap.to_ass({"segments": rows}, FRAME, SAFE, STYLE)
        cards = [x for x in text.splitlines() if x.startswith("Dialogue:")]
        self.assertFalse(cards[0].split(",", 9)[9].startswith("{"), "English: the preset's font")
        ml = [c for c in cards if "clutch" in c or ML.split()[0] in c]
        self.assertTrue(ml and all(c.split(",", 9)[9].startswith("{\\fnBaloo Chettan 2}") for c in ml))
        words = [{"start": 2.0, "end": 2.5, "text": ML.split()[0]}, {"start": 2.5, "end": 3.0, "text": ML.split()[1]},
                 {"start": 3.0, "end": 4.0, "text": "clutch"}]
        rows[1]["words"] = words
        text, _ = rcap.to_ass({"segments": rows[1:]}, FRAME, SAFE, STYLE, highlight="#FFD400")
        for c in [x for x in text.splitlines() if x.startswith("Dialogue:")]:
            body = c.split(",", 9)[9]
            self.assertTrue(body.startswith("{\\fnBaloo Chettan 2}"), body)
            if "\\r" in body:
                self.assertIn("{\\r\\fnBaloo Chettan 2}", body, "the reset after the lit word keeps the script font")
        with tempfile.TemporaryDirectory() as d:
            rcap.write_ass({"segments": rows}, FRAME, SAFE, STYLE, d)
            self.assertEqual(sorted(os.listdir(os.path.join(d, rcap.FONT_SUBDIR))),
                             sorted([STYLE["fontFile"], "BalooChettan2-Variable.ttf"]))

    def test_faster_whisper_confidence(self):
        self.assertAlmostEqual(caps.segment_confidence(0.0, 0.0), 1.0)
        self.assertAlmostEqual(caps.segment_confidence(-0.6931, 0.5), 0.25, places=3)
        self.assertIsNone(caps.segment_confidence(None, 0.1))

    def test_whisper_cpp_full_json_confidence(self):
        j = {"transcription": [{"offsets": {"from": 0, "to": 1000}, "text": " hi",
                                "tokens": [{"text": "[_BEG_]", "p": 0.1}, {"text": " hi", "p": 0.8}, {"text": "!", "p": 0.6}]},
                               {"offsets": {"from": 1000, "to": 2000}, "text": " no tokens"}]}
        rows = caps.parse_whisper_cpp_json(j)
        self.assertAlmostEqual(rows[0]["confidence"], 0.7)
        self.assertNotIn("confidence", rows[1])


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg/ffprobe not on PATH")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ed2-")
        cls.src = os.path.join(cls.tmp, "v.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x202020:s=540x960:r=30:d=12",
                         "-f", "lavfi", "-i", "sine=f=300:d=12", "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src],
                        timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _frame(self, name, t):
        import subprocess  # noqa: PLC0415
        out = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{t:.2f}", "-i", os.path.join(self.tmp, name),
                              "-frames:v", "1", "-vf", "scale=270:480", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                             capture_output=True, timeout=120, **cc.child_kwargs(**cc.NO_WINDOW))
        self.assertEqual(out.returncode, 0)
        return out.stdout

    def test_transcript_on_the_reel_timeline_and_burned_inside_the_safe_zone(self):
        pieces = [{"start": 6.0, "end": 8.0, "kills": 0, "teaser": True}, {"start": 1.0, "end": 9.0, "kills": 1}]
        wd = os.path.join(self.tmp, "M01")
        os.makedirs(wd, exist_ok=True)
        seen = {}

        def fake(backend, wav, opts):
            seen["opts"] = opts
            seen["dur"] = cc.media_info("ffprobe", wav)["duration"]
            return [seg(0.2, 1.8, "TEASER LINE", 0.9), seg(3.0, 6.0, "LOW ONE", 0.1), seg(6.5, 9.5, ML, 0.9)], \
                {"backend": backend, "status": "ok", "language": "en"}

        tr, info = rcap.make_transcript("ffmpeg", self.src, pieces, CFG, STYLE, {"whisper_model": "m"}, wd, 10.0,
                                        transcribe=fake)
        self.assertAlmostEqual(seen["dur"], 10.0, delta=0.1, msg="the joined audio is the reel's own timeline")
        self.assertEqual(seen["opts"]["full_json"], True)
        self.assertIs(seen["opts"]["multilingual"], True)
        self.assertTrue(os.path.isfile(os.path.join(wd, rcap.TRANSCRIPT)))
        self.assertEqual(info["shown"], 2, "the teaser line and the Malayalam line (C4 script font)")
        ass, fdir, n = rcap.write_ass(tr, FRAME, SAFE, STYLE, wd, 10.0)
        self.assertEqual((ass, fdir), ("captions.ass", "fonts"))
        self.assertGreaterEqual(n, 2)
        argv = mont.render_argv("ffmpeg", self.src, pieces, FRAME, ["-c:v", "libopenh264"], ["-c:a", "aac"], 80,
                                "cap.mp4", max_sec=10, captions=ass, fontsdir=fdir)
        r = cc.run_tool(argv, cwd=wd, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = mont.render_argv("ffmpeg", self.src, pieces, FRAME, ["-c:v", "libopenh264"], ["-c:a", "aac"], 80,
                                "plain.mp4", max_sec=10)
        self.assertEqual(cc.run_tool(argv, cwd=wd, timeout=600).returncode, 0)
        a = self._frame(os.path.join("M01", "cap.mp4"), 1.0)
        b = self._frame(os.path.join("M01", "plain.mp4"), 1.0)
        w, h = 270, 480
        sx = w / FRAME["width"]
        changed = [(i % w, i // w) for i in range(w * h) if abs(a[i] - b[i]) > 40]
        self.assertTrue(changed, "the caption is burned in")
        xs, ys = [c[0] for c in changed], [c[1] for c in changed]
        self.assertGreaterEqual(min(xs), int(SAFE["left"] * sx) - 1)
        self.assertLessEqual(max(xs), w - int(SAFE["right"] * sx) + 1)
        self.assertGreaterEqual(min(ys), int(SAFE["top"] * sx) - 1)
        self.assertLessEqual(max(ys), h - int(SAFE["bottom"] * sx) + 1)
        c = self._frame(os.path.join("M01", "cap.mp4"), 4.0)
        d = self._frame(os.path.join("M01", "plain.mp4"), 4.0)
        self.assertFalse(any(abs(c[i] - d[i]) > 40 for i in range(w * h)), "a low-confidence line is not burned")

    def test_recaption_renders_again_with_the_edited_transcript(self):
        out = os.path.join(self.tmp, "run")
        wd = os.path.join(out, "clips", "M01")
        os.makedirs(wd, exist_ok=True)
        data = os.path.join(self.tmp, "data")
        os.makedirs(data, exist_ok=True)
        with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-captions": True}}, f)
        pieces = [{"start": 1.0, "end": 7.0, "kills": 1}]
        shutil.copyfile(self.src, os.path.join(wd, "montage-v.mp4"))
        cc.write_json_atomic(os.path.join(out, "render.json"), {
            "tool": "clipper.montage", "frame": {"width": 540, "height": 960}, "vRecordingPath": self.src,
            "audioFadeMs": 80, "clips": [{"id": "M01", "start": 0.0, "end": 6.0, "pieces": pieces,
                                          "captions": {"status": "ok"},
                                          "files": [{"layout": "montage-v", "file": "montage-v.mp4", "geometry": "canvas"}]}]})
        cc.write_json_atomic(os.path.join(wd, rcap.TRANSCRIPT), {"version": 1, "edited": True, "segments": [
            {"start": 0.5, "end": 3.0, "text": "EDITED LINE", "confidence": 0.3, "show": True, "hidden": None}]})
        rc = clipper.main(["--data-dir", data, "recaption", "--out", out, "--id", "M01", "--encoder", "libopenh264"])
        self.assertEqual(rc, 0)
        row = cc.load_json(os.path.join(out, "render.json"))["clips"][0]
        self.assertEqual((row["captions"]["cards"], row["captions"]["burned"]), (1, True))
        self.assertIn("recaptionedAt", row["captions"])
        self.assertFalse(os.path.isdir(os.path.join(wd, "fonts")), "the font copy is removed after the render")
        dur = cc.media_info("ffprobe", os.path.join(wd, "montage-v.mp4"))["duration"]
        self.assertAlmostEqual(dur, 6.0, delta=0.15)
        # captions off: recaption refuses
        with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-captions": False}}, f)
        self.assertEqual(clipper.main(["--data-dir", data, "recaption", "--out", out, "--id", "M01"]), 1)

    def test_recaption_keeps_the_reel_length_after_the_maximum_is_lowered(self):
        out = os.path.join(self.tmp, "run-long")
        wd = os.path.join(out, "clips", "M01")
        os.makedirs(wd, exist_ok=True)
        data = os.path.join(self.tmp, "data-long")
        os.makedirs(data, exist_ok=True)
        with open(os.path.join(data, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-captions": True}}, f)
        pieces = [{"start": 1.0, "end": 11.0, "kills": 1} for _ in range(3)]  # a 30 s reel
        r = cc.run_tool(mont.render_argv("ffmpeg", self.src, pieces, {"width": 540, "height": 960},
                                         ["-c:v", "libopenh264"], ["-c:a", "aac"], 80, "montage-v.mp4"), cwd=wd, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        before = cc.media_info("ffprobe", os.path.join(wd, "montage-v.mp4"))["duration"]
        self.assertAlmostEqual(before, 30.0, delta=0.15)
        # the user lowers the montage maximum to 20 s after the reel was made
        with open(os.path.join(data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"reelLengths": {"montage": {"minSec": 20, "maxSec": 20}}}}, f)
        self.assertEqual(rl.effective_limits(data)["montage"]["maxSec"], 20)
        cc.write_json_atomic(os.path.join(out, "render.json"), {
            "tool": "clipper.montage", "frame": {"width": 540, "height": 960}, "vRecordingPath": self.src,
            "audioFadeMs": 80, "clips": [{"id": "M01", "start": 0.0, "end": 30.0, "pieces": pieces,
                                          "captions": {"status": "ok"},
                                          "files": [{"layout": "montage-v", "file": "montage-v.mp4", "geometry": "canvas"}]}]})
        cc.write_json_atomic(os.path.join(wd, rcap.TRANSCRIPT), {"version": 1, "edited": True, "segments": [
            {"start": 25.0, "end": 28.0, "text": "LATE LINE", "confidence": 0.9, "show": True, "hidden": None}]})
        rc = clipper.main(["--data-dir", data, "recaption", "--out", out, "--id", "M01", "--encoder", "libopenh264"])
        self.assertEqual(rc, 0)
        after = cc.media_info("ffprobe", os.path.join(wd, "montage-v.mp4"))["duration"]
        self.assertAlmostEqual(after, before, delta=0.15, msg="no cut from the current maximum setting")


class TimelineTests(unittest.TestCase):
    """Codex review of D411: captions are laid on the overlapping (cross-faded) timeline, so transitions stay."""

    def test_retime_onto_the_output_timeline(self):
        ps = [{"start": 10.0, "end": 14.0}, {"start": 20.0, "end": 24.0}]
        doc = {"segments": [{"start": 1.0, "end": 2.0, "text": "a"},  # piece 1
                            {"start": 3.5, "end": 4.6, "text": "b"},  # runs over the join
                            {"start": 5.0, "end": 6.0, "text": "c"}]}  # piece 2
        out = rcap.retime(doc, ps, ps, 0.25)
        self.assertEqual(out["timeline"], "output")
        seg = [(round(s["start"], 3), round(s["end"], 3)) for s in out["segments"]]
        self.assertEqual(seg[0], (1.0, 2.0))
        self.assertEqual(seg[-1], (4.75, 5.75), "piece 2 starts 0.25 s earlier (the join overlaps)")
        self.assertLessEqual(seg[1][1], 4.6 - 0.25 + 1e-6, "a caption over the join ends in the next piece")
        self.assertIs(rcap.retime(out, ps, ps, 0.25), out, "already on the output timeline: unchanged")
        trimmed = [dict(ps[0], end=13.8), ps[1]]  # beat sync trimmed the first tail
        late = rcap.retime({"segments": [{"start": 4.2, "end": 4.8, "text": "d"}]}, ps, trimmed, 0.25)
        self.assertAlmostEqual(late["segments"][0]["start"], 3.8 - 0.25 + 0.2, places=3)
        with self.assertRaises(ValueError):
            rcap.retime(doc, ps, ps[:1], 0.25)

    def test_recaption_falls_back_when_the_folder_track_is_gone(self):
        d = tempfile.mkdtemp(prefix="fx4r-")
        try:
            ps = [{"start": 0.0, "end": 8.0, "kills": 1}, {"start": 12.0, "end": 20.0, "kills": 1}]
            row = {"music": {"source": "folder", "track": "gone1", "mode": "full-bed", "total": 15.8, "levelDb": -16,
                             "segments": [{"at": 0, "from": 0, "len": 15.8, "fadeIn": 0.1, "fadeOut": 1}]}}
            mus, rec = clipper._recaption_music(os.path.join(d, "data"), d, row, ps, 0.2, "M9")
            self.assertEqual(rec["source"], "made-here")
            self.assertEqual(rec["was"], "gone1")
            self.assertIn("gone", rec["fallback"])
            self.assertTrue(os.path.isfile(os.path.join(d, mus["file"])), "a bed is made, no KeyError on seed")
        finally:
            shutil.rmtree(d, ignore_errors=True)



class ModelChoice(unittest.TestCase):
    """C3 (user yes 2026-11-24): large-v3-turbo on the GPU off air when downloaded, else the small CPU model."""

    def _root(self, d, *models):
        data = os.path.join(d, "event-core")
        for m in models:
            os.makedirs(os.path.join(d, "models", m))
        return data

    def test_gpu_model_only_off_air_and_when_downloaded(self):
        gpu = CFG["gpuModel"]["model"]
        with tempfile.TemporaryDirectory() as d:
            data = self._root(d, CFG["model"], gpu)
            o = rcap.model_opts(data, CFG, live=False)
            self.assertEqual((os.path.basename(o["whisper_model"]), o["device"]), (gpu, "cuda"))
            self.assertEqual(os.path.basename(o["fallback"]["whisper_model"]), CFG["model"])
            self.assertEqual(rcap.model_opts(data, CFG, live=True)["device"], "cpu", "on air: the CPU model")
            with patch.object(rcap, "on_air", return_value=None):  # not known: treated as on air
                self.assertEqual(rcap.model_opts(data, CFG)["device"], "cpu")
            self.assertEqual(rcap.model_opts(data, CFG, "x/given", live=False),
                             {"whisper_model": "x/given", "device": "cpu", "compute_type": "int8"})
        with tempfile.TemporaryDirectory() as d:
            o = rcap.model_opts(self._root(d, CFG["model"]), CFG, live=False)
            self.assertEqual((os.path.basename(o["whisper_model"]), o["device"]), (CFG["model"], "cpu"))

    def test_a_failed_gpu_run_falls_back_to_the_cpu_model(self):
        import types
        calls = []

        class Seg:
            start, end, text, avg_logprob, no_speech_prob, words = 0.0, 1.0, " hi", 0.0, 0.0, None

        class Model:
            def __init__(self, model, device, **kw):
                calls.append((os.path.basename(model), device))
                self.device = device

            def transcribe(self, wav, **kw):
                if self.device == "cuda":
                    raise RuntimeError("CUDA out of memory")
                return iter([Seg()]), types.SimpleNamespace(language="en")
        fake = types.ModuleType("faster_whisper")
        fake.WhisperModel = Model
        opts = {"whisper_model": "m/turbo", "device": "cuda", "compute_type": "int8_float16",
                "fallback": {"whisper_model": "m/small", "device": "cpu", "compute_type": "int8"}}
        with patch.dict(sys.modules, {"faster_whisper": fake}):
            segs, info = caps.transcribe("faster-whisper", "a.wav", opts)
            self.assertEqual(calls, [("turbo", "cuda"), ("small", "cpu")])
            self.assertEqual((info["model"], info["device"], len(segs)), ("small", "cpu", 1))
            with self.assertRaises(RuntimeError):  # no fallback: the error is reported as before
                caps.transcribe("faster-whisper", "a.wav", dict(opts, fallback=None))


class SubtitleFiles(unittest.TestCase):
    """C1 (user yes 2026-11-24): SRT and VTT from the transcript, beside the reel and the published video."""

    def test_srt_and_vtt_of_the_shown_lines(self):
        tr = {"segments": rcap.mark([seg(0.5, 2, "nice  shot", 0.9), seg(2, 3, "low", 0.1), seg(3, 4.25, ML, 0.9),
                                     seg(5, 9, "a <b> & c", 0.9)], CFG, CPS)}
        cues = rcap.subtitle_cues(tr, duration=6)
        self.assertEqual(cues, [(0.5, 2.0, "nice shot"), (3.0, 4.25, ML), (5.0, 6.0, "a <b> & c")],
                         "hidden lines out, a line the burn font cannot draw kept, cut at the reel's end")
        srt = rcap.to_srt(cues)
        self.assertTrue(srt.startswith("1\n00:00:00,500 --> 00:00:02,000\nnice shot\n\n2\n00:00:03,000 --> 00:00:04,250\n"))
        vtt = rcap.to_vtt(cues)
        self.assertTrue(vtt.startswith("WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nnice shot\n"))
        self.assertIn("a &lt;b&gt; &amp; c", vtt)
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(rcap.write_subtitles(tr, d, 6), 3)
            self.assertEqual(sorted(os.listdir(d)), sorted(rcap.SUBS))
            with open(os.path.join(d, "captions.srt"), encoding="utf-8") as f:
                self.assertEqual(f.read(), srt)
            for x in tr["segments"]:
                x["show"] = False  # the user hides every line: no stale caption file stays
            self.assertEqual(rcap.write_subtitles(tr, d), 0)
            self.assertEqual(os.listdir(d), [])

    def test_published_video_gets_its_own_named_caption_files(self):
        import clip_publish as pub
        with tempfile.TemporaryDirectory() as d:
            clip = os.path.join(d, "work", "clips", "M1")
            os.makedirs(clip)
            with open(os.path.join(clip, "captions.srt"), "w", encoding="utf-8") as f:
                f.write("1\n")
            day = os.path.join(d, "out")
            os.makedirs(day)
            out = pub._publish_subtitles(clip, os.path.join(day, "game-reel-01.mp4"))
            self.assertEqual(out, [os.path.join(day, "game-reel-01.srt")])
            self.assertEqual(pub._publish_subtitles(os.path.join(d, "none"), os.path.join(day, "x.mp4")), [])


if __name__ == "__main__":
    unittest.main()
