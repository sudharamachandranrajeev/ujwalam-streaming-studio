# SPDX-License-Identifier: GPL-3.0-or-later
"""LV1a (D421): word-by-word captions and chapter cards on the long highlights video (services/clip/long_teaching.py,
reel_captions word highlight, clip_captions word times). Synthetic data only: no real speech, no real footage. Word
timing on real stream speech and the look on a real long video are UNVERIFIED."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_captions as caps  # noqa: E402
import clip_common as cc  # noqa: E402
import long_teaching as lt  # noqa: E402
import long_video as lv  # noqa: E402
import reel_captions as rcap  # noqa: E402

NOWIN = 0x08000000 if os.name == "nt" else 0
FADE = {"kind": "fade", "xfade": "fade", "ms": 250}


def _tok(text, a, b, p=0.9):
    return {"text": text, "offsets": {"from": a, "to": b}, "p": p}


def _words(*items):
    return [{"start": a, "end": b, "text": t} for t, a, b in items]


def _ctx(ccfg=None):
    cfg = lv.load_config()
    tcfg = lt.check(cfg["teaching"])
    return {"tcfg": tcfg, "style": lt.caption_style(rcap.load_config(), tcfg), "accent": "#FF3366", "ccfg": ccfg,
            "opts": {}}


class Words(unittest.TestCase):
    def test_tokens_become_words(self):
        seg = {"offsets": {"from": 0, "to": 2000}, "text": " good game everyone",
               "tokens": [_tok("[_BEG_]", 0, 0), _tok(" good", 0, 400), _tok(" ga", 500, 700), _tok("me", 700, 900),
                          _tok(" every", 1000, 1400), _tok("one", 1400, 1800), _tok("[_TT_90]", 1800, 1800)]}
        rows = caps.parse_whisper_cpp_json({"transcription": [seg]})
        self.assertEqual([w["text"] for w in rows[0]["words"]], ["good", "game", "everyone"])
        self.assertEqual((rows[0]["words"][1]["start"], rows[0]["words"][1]["end"]), (0.5, 0.9))

    def test_no_tokens_no_words(self):
        rows = caps.parse_whisper_cpp_json({"transcription": [{"offsets": {"from": 0, "to": 900}, "text": "hi"}]})
        self.assertNotIn("words", rows[0])
        bad = {"offsets": {"from": 0, "to": 900}, "text": "hi", "tokens": [{"text": " hi", "p": 0.9}]}
        self.assertNotIn("words", caps.parse_whisper_cpp_json({"transcription": [bad]})[0])

    def test_mark_keeps_words_inside_the_segment(self):
        rows = rcap.mark([{"start": 0, "end": 1.0, "text": "a b", "confidence": 0.9,
                           "words": _words(("a", 0.0, 0.4), ("b", 0.5, 1.3), ("c", 1.2, 1.4))}],
                         {"minConfidence": 0.5}, set(map(ord, "abc")))
        self.assertEqual(rows[0]["words"], _words(("a", 0.0, 0.4), ("b", 0.5, 1.0)))

    def test_retime_moves_words_across_a_join(self):
        doc = {"segments": [{"start": 9.0, "end": 11.0, "text": "x y", "show": True,
                             "words": _words(("x", 9.0, 9.8), ("y", 10.2, 11.0))}]}
        pieces = [{"start": 100.0, "end": 110.0}, {"start": 200.0, "end": 210.0}]
        out = rcap.retime(doc, pieces, pieces, 0.25)
        s = out["segments"][0]
        self.assertEqual((s["start"], s["end"]), (9.0, 10.75))
        self.assertEqual([(w["start"], w["end"]) for w in s["words"]], [(9.0, 9.8), (9.95, 10.75)])

    def test_a_word_starting_on_the_join_starts_with_the_next_piece(self):
        # Codex D421: a start exactly on the join belongs to the piece after it (else it is drawn a cross fade late)
        doc = {"segments": [{"start": 9.0, "end": 11.0, "text": "x y", "show": True,
                             "words": _words(("x", 9.0, 10.0), ("y", 10.0, 11.0))}]}
        pieces = [{"start": 100.0, "end": 110.0}, {"start": 200.0, "end": 210.0}]
        s = rcap.retime(doc, pieces, pieces, 0.25)["segments"][0]
        self.assertEqual([(w["start"], w["end"]) for w in s["words"]], [(9.0, 10.0), (9.75, 10.75)])

    def test_captions_never_overlap_after_a_join(self):
        # Codex D421 verify: a segment starting on the join moves back over the cross fade; the one before ends there
        doc = {"segments": [{"start": 8.0, "end": 10.0, "text": "a b", "show": True,
                             "words": _words(("a", 8.0, 9.0), ("b", 9.5, 10.0))},
                            {"start": 10.0, "end": 11.0, "text": "c", "show": True, "words": _words(("c", 10.0, 11.0))}]}
        pieces = [{"start": 100.0, "end": 110.0}, {"start": 200.0, "end": 210.0}]
        a, b = rcap.retime(doc, pieces, pieces, 0.25)["segments"]
        self.assertEqual((a["end"], b["start"]), (9.75, 9.75))
        self.assertEqual([(w["start"], w["end"]) for w in a["words"]], [(8.0, 9.0), (9.5, 9.75)])
        doc["segments"][1]["show"] = False  # a hidden caption is never drawn: it cuts nothing short (Codex)
        a, _ = rcap.retime(doc, pieces, pieces, 0.25)["segments"]
        self.assertEqual(a["end"], 10.0)

    def test_cards_inside_a_segment_never_overlap(self):
        st = dict(Highlight.STYLE, maxWordsPerCard=1)
        seg = {"start": 0.0, "end": 2.0, "text": "x y", "show": True, "words": _words(("x", 0.0, 1.2), ("y", 1.0, 2.0))}
        ev = rcap._highlight_events(seg, 0.0, 2.0, st, "&H00FF0000")
        self.assertTrue(ev[0].startswith("Dialogue: 0,0:00:00.00,0:00:01.00,"))


class Highlight(unittest.TestCase):
    STYLE = {"fontFamily": "F", "sizePx": 50, "textColour": "#FFFFFF", "outlineColour": "#000000", "outlinePx": 3,
             "shadowPx": 0, "maxWordsPerCard": 4, "maxCharsPerLine": 12, "maxLines": 2}
    SAFE = {"left": 10, "right": 10, "bottom": 20}

    def test_word_cards(self):
        ws = _words(*[(t, i, i + 0.5) for i, t in enumerate(["one", "two", "three", "four", "five", "six"])])
        self.assertEqual(rcap.word_cards(ws, 4, 12, 2), [[[0, 1], [2, 3]], [[4, 5]]])
        self.assertEqual(rcap.word_cards(_words(("averyveryverylongword", 0, 1), ("x", 1, 2)), 4, 12, 2),
                         [[[0], [1]]])

    def test_one_event_per_word_with_the_accent_on_it(self):
        seg = {"start": 0.0, "end": 2.0, "text": "nice shot man", "show": True,
               "words": _words(("nice", 0.0, 0.5), ("shot", 0.6, 1.1), ("man", 1.2, 1.8))}
        text, n = rcap.to_ass({"segments": [seg]}, {"width": 1920, "height": 1080}, self.SAFE, self.STYLE,
                              highlight="#FF3366")
        ev = [x for x in text.splitlines() if x.startswith("Dialogue:")]
        self.assertEqual(n, 1)
        self.assertEqual(len(ev), 3)
        acc = rcap._ass_colour("#FF3366")
        for e, w in zip(ev, ("nice", "shot", "man")):
            self.assertIn(f"{{\\1c{acc}}}{w}{{\\r}}", e)
            self.assertEqual(e.count("\\1c"), 1)
        self.assertTrue(ev[0].startswith("Dialogue: 0,0:00:00.00,0:00:00.60"))
        self.assertTrue(ev[2].startswith("Dialogue: 0,0:00:01.20,0:00:01.80"))

    def test_edited_text_or_no_highlight_gives_plain_cards(self):
        seg = {"start": 0.0, "end": 2.0, "text": "nice shot buddy", "show": True,
               "words": _words(("nice", 0.0, 0.5), ("shot", 0.6, 1.1), ("man", 1.2, 1.8))}
        for hl in ("#FF3366", None):
            text, n = rcap.to_ass({"segments": [seg]}, {"width": 1920, "height": 1080}, self.SAFE, self.STYLE,
                                  highlight=hl)
            self.assertNotIn("\\1c", text)
            self.assertEqual(n, 1)


class Chapters(unittest.TestCase):
    def test_labels(self):
        self.assertEqual(lt.label({"kills": 3, "kinds": ["kills"]}), "3 kills")
        self.assertEqual(lt.label({"kills": 1, "kinds": ["kills"]}), "1 kill")
        self.assertEqual(lt.label({"kills": 5, "kinds": ["kills", "streak"]}), "streak · 5 kills")
        self.assertEqual(lt.label({"kills": 2, "kinds": ["kills", "win"]}), "2 kills · won match")
        self.assertEqual(lt.label({"kills": 0, "kinds": ["win"]}), "won match")

    def test_timing_rule_is_checked(self):
        t = lv.load_config()["teaching"]
        lt.check(t)
        for k, v in (("entranceMs", 600), ("exitMs", 400), ("sec", 0.5)):
            bad = json.loads(json.dumps(t))
            bad["chapters"][k] = v
            with self.assertRaises(cc.ClipError):
                lt.check(bad)

    def test_cards_numbered_and_inside_each_moment(self):
        ctx = _ctx()
        chunk = [{"start": 10.0, "end": 30.0, "kills": 2, "kinds": ["kills"]},
                 {"start": 50.0, "end": 51.0, "kills": 1, "kinds": ["kills"]},  # too short for a card
                 {"start": 90.0, "end": 100.0, "kills": 0, "kinds": ["win"]}]
        xd = 0.25
        styles, ev = lt.chapter_events(chunk, 13, xd, {"width": 1920, "height": 1080}, ctx["tcfg"], ctx["style"],
                                       ctx["accent"])
        self.assertTrue(styles[0].startswith("Style: Chapter,"))
        self.assertEqual(len(ev), 2)
        self.assertIn("}13{", ev[0])
        self.assertIn("2 kills", ev[0])
        self.assertIn("}15{", ev[1])  # numbering counts the skipped moment
        self.assertIn("won match", ev[1])
        starts = lt.piece_starts(chunk, xd)
        self.assertEqual(starts, [0.0, 19.75, 20.5])
        # after the cross fade in (Codex): never over the moment before
        self.assertTrue(ev[0].startswith(f"Dialogue: 1,{caps._ts(0.0)},{caps._ts(ctx['tcfg']['chapters']['sec'])},"))
        self.assertTrue(ev[1].startswith(f"Dialogue: 1,{caps._ts(20.75)},"))
        ch = ctx["tcfg"]["chapters"]
        self.assertIn(f"\\fad({ch['entranceMs']},{ch['exitMs']})", ev[0])

    def test_chapters_burn_without_captions(self):
        ctx = _ctx()
        chunk = [{"start": 0.0, "end": 8.0, "kills": 1, "kinds": ["kills"]}]
        with tempfile.TemporaryDirectory() as d:
            ass, fd, info = lt.batch_overlay("ffmpeg", "rec.mkv", chunk, 1, FADE, {"width": 1920, "height": 1080}, d,
                                             ctx)
            self.assertEqual((ass, fd), (rcap.ASS_NAME, rcap.FONT_SUBDIR))
            self.assertEqual((info["status"], info["chapters"], info["cards"]), ("off", 1, 0))
            with open(os.path.join(d, ass), encoding="utf-8") as f:
                text = f.read()
            self.assertIn("Style: Chapter,", text)
            self.assertLess(text.index("Style: Chapter,"), text.index("[Events]"))
            self.assertTrue(os.path.isfile(os.path.join(d, fd, ctx["style"]["fontFile"])))

    def test_any_caption_error_leaves_the_cards(self):
        # Codex D421: a model load error (any exception) never stops the video
        ctx = _ctx(ccfg=dict(rcap.load_config()))
        chunk = [{"start": 0.0, "end": 8.0, "kills": 1, "kinds": ["kills"]}]

        def boom(*_a, **_k):
            raise RuntimeError("model failed to load")
        orig = rcap.make_transcript
        rcap.make_transcript = boom
        try:
            with tempfile.TemporaryDirectory() as d:
                ass, _, info = lt.batch_overlay("ffmpeg", "rec.mkv", chunk, 1, FADE, {"width": 1920, "height": 1080},
                                                d, ctx)
        finally:
            rcap.make_transcript = orig
        self.assertEqual((ass, info["status"], info["chapters"]), (rcap.ASS_NAME, "failed", 1))
        self.assertIn("model failed", info["reason"])

    def test_a_caption_that_cannot_be_written_leaves_the_cards(self):
        ctx = _ctx(ccfg=dict(rcap.load_config()))
        chunk = [{"start": 0.0, "end": 8.0, "kills": 1, "kinds": ["kills"]}]
        doc = {"segments": [{"start": 1.0, "end": 2.0, "text": "hi", "show": True}]}
        orig_mt, orig_to = rcap.make_transcript, rcap.to_ass
        rcap.make_transcript = lambda *a, **k: (doc, {"backend": "b", "status": "ok"})

        def to_ass(transcript, *a, **k):
            if transcript.get("segments"):
                raise KeyError("bad word")
            return orig_to(transcript, *a, **k)
        rcap.to_ass = to_ass
        try:
            with tempfile.TemporaryDirectory() as d:
                ass, _, info = lt.batch_overlay("ffmpeg", "rec.mkv", chunk, 1, FADE, {"width": 1920, "height": 1080},
                                                d, ctx)
        finally:
            rcap.make_transcript, rcap.to_ass = orig_mt, orig_to
        self.assertEqual((ass, info["status"], info["chapters"], info["cards"]), (rcap.ASS_NAME, "failed", 1, 0))

    def test_transcript_gets_the_input_length(self):
        # Codex D421: the transcript is on the pieces-back-to-back timeline, so it is cut at their total, not the output
        ctx = _ctx(ccfg=dict(rcap.load_config()))
        chunk = [{"start": 0.0, "end": 10.0, "kills": 1, "kinds": ["kills"]},
                 {"start": 50.0, "end": 60.0, "kills": 1, "kinds": ["kills"]}]
        seen = {}

        def fake(ffmpeg, src, pieces, cfg, style, opts, workdir, duration=None, transcribe=None, words=False):
            seen.update(duration=duration, words=words)
            return None, {"backend": "b", "status": "ok"}
        orig = rcap.make_transcript
        rcap.make_transcript = fake
        try:
            with tempfile.TemporaryDirectory() as d:
                lt.batch_overlay("ffmpeg", "rec.mkv", chunk, 1, FADE, {"width": 1920, "height": 1080}, d, ctx)
        finally:
            rcap.make_transcript = orig
        self.assertEqual(seen, {"duration": 20.0, "words": True})

    def test_flag_off_means_no_overlay(self):
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, cc.LOCAL_FLAGS), "w", encoding="utf-8") as f:
                json.dump({"flags": {lt.FLAG: False}}, f)
            self.assertIsNone(lt.context(d, lv.load_config()))
            os.remove(os.path.join(d, cc.LOCAL_FLAGS))
            ctx = lt.context(d, lv.load_config())
            self.assertIsNotNone(ctx)
            self.assertIsNone(ctx["ccfg"], "no speech model in a bare data folder: chapter cards only")

    def test_merge_info(self):
        self.assertEqual(lt.merge_info([])["captions"]["status"], "off")
        m = lt.merge_info([{"status": "ok", "backend": "b", "cards": 2, "chapters": 3},
                           {"status": "failed", "backend": "b", "reason": "x", "cards": 0, "chapters": 1}])
        self.assertEqual((m["captions"]["status"], m["captions"]["cards"], m["chapters"]), ("partial", 2, 4))
        self.assertEqual(m["captions"]["reason"], "x")

    def test_render_passes_each_batch_its_overlay(self):
        segs = [{"start": i * 100.0, "end": i * 100.0 + 20, "kills": 1, "kinds": ["kills"]} for i in range(5)]
        calls, seen = [], []

        def render_job(mk, enc, wd, part, what):
            calls.append(mk(enc))
            open(os.path.join(wd, part), "wb").close()
            return subprocess.CompletedProcess([], 0, "", ""), enc

        def run_tool(argv, cwd=None, timeout=None):
            open(os.path.join(cwd, argv[-1]), "wb").close()
            return subprocess.CompletedProcess(argv, 0, "", "")

        def overlay(chunk, first, adir):
            seen.append((len(chunk), first))
            return {"ass": "captions.ass", "fontsdir": "fonts", "fx": None}
        with tempfile.TemporaryDirectory() as wd:
            ok, _, err = lv.render("ffmpeg", "h.mkv", segs, {"width": 1920, "height": 1080}, "e", wd, 1, 80, FADE, 2,
                                   render_job, run_tool, {"e": []}, [], overlay=overlay)
            self.assertTrue(ok, err)
        self.assertEqual(seen, [(2, 1), (2, 3), (1, 5)])
        for argv in calls:
            self.assertIn("subtitles=captions.ass:fontsdir=fonts", " ".join(argv))

    def test_a_batch_whose_overlay_fails_is_made_without_it(self):
        # Codex D421: a burn failure (libass, a bad font) renders that batch again with no overlay, and says so
        segs = [{"start": 0.0, "end": 20.0, "kills": 1, "kinds": ["kills"]}]
        calls, failed = [], []

        def render_job(mk, enc, wd, part, what):
            argv = mk(enc)
            calls.append(argv)
            if "subtitles=" in " ".join(argv):
                return subprocess.CompletedProcess([], 1, "", "libass: bad"), enc
            open(os.path.join(wd, part), "wb").close()
            return subprocess.CompletedProcess([], 0, "", ""), enc

        def run_tool(argv, cwd=None, timeout=None):
            open(os.path.join(cwd, argv[-1]), "wb").close()
            return subprocess.CompletedProcess(argv, 0, "", "")
        with tempfile.TemporaryDirectory() as wd:
            ok, _, err = lv.render("ffmpeg", "h.mkv", segs, {"width": 1920, "height": 1080}, "e", wd, 1, 80, FADE, 12,
                                   render_job, run_tool, {"e": []}, [],
                                   overlay=lambda c, f, a: {"ass": "captions.ass", "fontsdir": "fonts", "fx": FX},
                                   overlay_failed=lambda i, e: failed.append((i, e)))
            self.assertTrue(ok, err)
        self.assertEqual(len(calls), 2)
        self.assertIn("lvcc", " ".join(calls[0]))
        self.assertNotIn("subtitles=", " ".join(calls[1]))
        self.assertNotIn("lvcc", " ".join(calls[1]), "the retry drops the callouts too")
        self.assertEqual(failed, [(0, "libass: bad")])


FRAME = {"width": 1920, "height": 1080}
FX = "[fxin]split=2[lvcb][lvcs];[lvcs]null[lvcc];[lvcb][lvcc]overlay[fxout]"
PACK = {"detectors": [{"id": "M5", "rois": [{"id": "killfeed", "x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96,
                                             "status": "verified"}]},
                      {"id": "X9", "rois": [{"id": "killfeed", "x0": 0.1, "y0": 0.1, "x1": 0.2, "y1": 0.2,
                                             "status": "unverified"}]}]}


class Callouts(unittest.TestCase):
    """LV1b (D422): the kill feed callout after each medal."""

    def ocfg(self, **kw):
        return dict(lt.check(lv.load_config()["teaching"])["callouts"], **kw)

    def test_box_only_from_a_verified_region(self):
        self.assertEqual(lt.callout_box(PACK, self.ocfg()), {"x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96})
        self.assertIsNone(lt.callout_box(PACK, self.ocfg(detector="X9")), "an unverified region is never framed")
        self.assertIsNone(lt.callout_box(PACK, self.ocfg(roi="banner")))
        self.assertIsNone(lt.callout_box(None, self.ocfg()))

    def test_windows_follow_the_medals_and_skip_cross_fades(self):
        oc = self.ocfg(delaySec=0.4, sec=2.4, minSec=1.2)
        chunk = [{"start": 100.0, "end": 110.0, "medals": [103.0, 104.0, 109.5]},
                 {"start": 200.0, "end": 206.0, "medals": [199.0, 200.0]}]
        # piece 2 starts at 10 - 0.25 = 9.75 on the output; its medal at 200 would show at 10.15, after the cross fade
        self.assertEqual(lt.callout_windows(chunk, 0.25, oc), [(3.4, 5.8), (10.15, 12.55)])
        # 104 overlaps the first, 109.5 is cut by the cross fade out (under minSec), 199 is outside the moment

    def test_no_medals_no_callouts(self):
        chunk = [{"start": 0.0, "end": 10.0, "medals": []}, {"start": 50.0, "end": 60.0}]
        self.assertEqual(lt.callout_windows(chunk, 0.25, self.ocfg()), [])
        self.assertIsNone(lt.callout_fx([], {"x0": 0, "y0": 0, "x1": 1, "y1": 1}, FRAME, self.ocfg(), "#FF3366"))

    def test_fx_crops_frames_and_places_inside_safe(self):
        oc = dict(self.ocfg(scale=1.4, borderPx=6, glowPx=10, glowShade=0.5, at={"x": 0.5, "y": 0.28}),
                  margin={"left": 96, "right": 96, "top": 64, "bottom": 72})
        fx = lt.callout_fx([(1.0, 2.0), (5.0, 6.5)], {"x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96}, FRAME, oc,
                           "#FF3366")
        self.assertTrue(fx.startswith("[fxin]") and fx.endswith("[fxout]"))
        self.assertIn("crop=576:130:538:906", fx)  # even sizes and offsets (yuv420p)
        self.assertIn("scale=806:182", fx)
        self.assertIn("color=0xFF3366", fx)
        self.assertIn("color=0x7F1933", fx)  # the halo: the accent at half brightness
        self.assertIn("between(t,1.000,2.000)+between(t,5.000,6.500)", fx)
        tw = 806 + 2 * 16
        self.assertIn(f"overlay=x={960 - tw // 2}:y=302:", fx)
        oc["at"] = {"x": 0.99, "y": 0.99}  # pushed into the safe area, never off the frame
        fx = lt.callout_fx([(1.0, 2.0)], {"x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96}, FRAME, oc, "#FF3366")
        self.assertIn(f"overlay=x={1920 - 96 - tw}:y={1080 - 72 - (182 + 32)}:", fx)

    def test_card_shrinks_to_fit_the_safe_area(self):
        oc = dict(self.ocfg(scale=3.0, borderPx=6, glowPx=10, at={"x": 0.5, "y": 0.5}),
                  margin={"left": 96, "right": 96, "top": 64, "bottom": 72})
        fx = lt.callout_fx([(1.0, 2.0)], {"x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 0.5}, FRAME, oc, "#FF3366")
        import re
        sw, sh = map(int, re.search(r"scale=(\d+):(\d+)", fx).groups())
        self.assertLessEqual(sw + 32, 1920 - 192)
        self.assertLessEqual(sh + 32, 1080 - 136)
        x, y = map(int, re.search(r"overlay=x=(\d+):y=(\d+)", fx).groups())
        self.assertGreaterEqual(x, 96)
        self.assertGreaterEqual(y, 64)

    def test_bad_geometry_never_stops_the_video(self):
        with tempfile.TemporaryDirectory() as d:
            c = lt.context(d, lv.load_config(), pack=PACK, rec_size=(None, None), game="codm")
            self.assertEqual((c["box"], c["paths"]), (None, None))
            bad = {"detectors": [{"id": "M5", "rois": [{"id": "killfeed", "x0": "a", "y0": 0, "x1": 1, "y1": 1,
                                                         "status": "verified"}]}]}
            self.assertIsNone(lt.context(d, lv.load_config(), pack=bad, rec_size=(1920, 1080))["box"])

    def test_bad_settings_are_refused(self):
        t = lv.load_config()["teaching"]
        for bad in ({"minSec": 3.0}, {"scale": 0}, {"glowShade": 2}):
            with self.assertRaises(cc.ClipError):
                lt.check(dict(t, callouts=dict(t["callouts"], **bad)))
        with self.assertRaises(cc.ClipError):
            lt._hex("red")

    def test_batch_callouts_and_merge(self):
        ctx = dict(_ctx(), box={"x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96})
        chunk = [{"start": 0.0, "end": 10.0, "medals": [2.0]}]
        fx, n = lt.batch_callouts(chunk, FADE, FRAME, ctx)
        self.assertEqual(n, 1)
        self.assertIn("lvcc", fx)
        self.assertEqual(lt.batch_callouts(chunk, FADE, FRAME, dict(ctx, box=None)), (None, 0))
        self.assertEqual(lt.merge_info([{"status": "off", "callouts": 2}, {"status": "off", "callouts": 1}])["callouts"], 3)
        self.assertEqual(lt.merge_info([])["callouts"], 0)

    def test_context_reads_the_box_from_the_pack(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertAlmostEqual(lt.context(d, lv.load_config(), pack=PACK, rec_size=(1920, 1080))["box"]["x0"], 0.28)
            self.assertIsNone(lt.context(d, lv.load_config(), rec_size=(1920, 1080))["box"], "no game pack: no callouts")
            self.assertIsNone(lt.context(d, lv.load_config(), pack=PACK)["box"], "no recording size: no callouts")
            # Codex LV1b: odd detect summary data never stops the video (a non-object layout counts as none)
            for lay in ([1], "x", 5, {"game": {"a": 1}, "visible": [0]}):
                ctx = lt.context(d, lv.load_config(), pack=PACK, layout=lay, rec_size=(1920, 1080), game=["codm"])
                self.assertIsNone(ctx["paths"])
            self.assertAlmostEqual(lt.context(d, lv.load_config(), pack=PACK, layout=[1],
                                              rec_size=(1920, 1080))["box"]["x0"], 0.28)

    def test_frame_box_follows_the_game_area(self):
        roi = {"x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96}
        # the game fills a 1920x1080 recording: the region keeps its fractions
        b = lt.frame_box(roi, None, (1920, 1080), FRAME)
        self.assertAlmostEqual(b["x0"], 0.28)
        self.assertAlmostEqual(b["y1"], 0.96)
        # a 2560x1440 canvas with the game in its left 1920x1080: fractions of the game, then scaled into the frame
        lay = {"game": [0, 0, 1920, 1080], "visible": [0, 0, 1920, 1080]}
        b = lt.frame_box(roi, lay, (2560, 1440), FRAME)
        self.assertAlmostEqual(b["x0"], 0.28 * 1920 / 2560)
        self.assertAlmostEqual(b["y0"], 0.84 * 1080 / 1440)
        # a 4:3 recording is pillarboxed into the 16:9 frame
        b = lt.frame_box({"x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0}, None, (1440, 1080), FRAME)
        self.assertAlmostEqual(b["x0"], 240 / 1920)
        self.assertAlmostEqual(b["x1"], 1680 / 1920)
        # a region cut off by the visible part is clipped; one wholly outside is None
        lay = {"game": [0, 0, 1920, 1080], "visible": [0, 0, 1920, 1000]}
        self.assertAlmostEqual(lt.frame_box(roi, lay, (1920, 1080), FRAME)["y1"], 1000 / 1080)
        lay = {"game": [0, 0, 1920, 1080], "visible": [0, 0, 1920, 800]}
        self.assertIsNone(lt.frame_box(roi, lay, (1920, 1080), FRAME))
        self.assertIsNone(lt.frame_box(None, None, (1920, 1080), FRAME))

    def test_medals_reach_the_segments(self):
        merged = lv.merge([{"start": 10.0, "end": 20.0, "score": 1, "kills": 1, "kind": "kills", "medals": [15.0]},
                           {"start": 19.0, "end": 30.0, "score": 1, "kills": 1, "kind": "kills", "medals": [25.0]}],
                          lv.load_config()["padSec"], 100.0)
        self.assertEqual(merged[0]["medals"], [15.0, 25.0])


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class Burn(unittest.TestCase):
    def test_libass_reads_the_chapter_and_word_script(self):
        """A 2 s test picture with the chapter card and a highlighted caption burned: libass parses the script."""
        ctx = _ctx()
        chunk = [{"start": 0.0, "end": 2.0, "kills": 3, "kinds": ["kills"]}]
        doc = {"segments": [{"start": 0.2, "end": 1.8, "text": "nice shot", "show": True,
                             "words": _words(("nice", 0.2, 0.8), ("shot", 0.9, 1.6))}]}
        with tempfile.TemporaryDirectory() as d:
            extra = lt.chapter_events(chunk, 1, 0.0, {"width": 320, "height": 180}, ctx["tcfg"], ctx["style"],
                                      ctx["accent"])
            ass, fd, n = rcap.write_ass(doc, {"width": 320, "height": 180}, ctx["tcfg"]["safe"], ctx["style"], d, 2.0,
                                        highlight=ctx["accent"], extra=extra)
            self.assertEqual(n, 1)
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                                "testsrc=size=320x180:rate=10:duration=2", "-vf", f"subtitles={ass}:fontsdir={fd}",
                                "-c:v", "libopenh264", "out.mp4"], cwd=d, capture_output=True, text=True,
                               timeout=120, creationflags=NOWIN)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            self.assertGreater(os.path.getsize(os.path.join(d, "out.mp4")), 0)

    def test_callout_fx_runs_in_ffmpeg(self):
        """LV1b: the callout graph on a 2 s test picture; the card's border colour is in the frame while it shows."""
        frame = {"width": 320, "height": 180}
        oc = dict(lt.check(lv.load_config()["teaching"])["callouts"], scale=1.4, borderPx=4, glowPx=4,
                  margin={"left": 8, "right": 8, "top": 8, "bottom": 8})
        fx = lt.callout_fx([(0.5, 1.5)], {"x0": 0.28, "y0": 0.84, "x1": 0.58, "y1": 0.96}, frame, oc, "#FF00FF")
        graph = "[0:v]null[fxin];" + fx.replace("[fxout]", "[o]")
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                                "color=c=black:size=320x180:rate=10:duration=2", "-filter_complex", graph, "-map", "[o]",
                                "-f", "rawvideo", "-pix_fmt", "rgb24", "out.rgb"], cwd=d, capture_output=True,
                               timeout=120, creationflags=NOWIN)
            self.assertEqual(r.returncode, 0, r.stderr[-800:])
            raw = open(os.path.join(d, "out.rgb"), "rb").read()
        n = 320 * 180 * 3
        frames = [raw[i * n:(i + 1) * n] for i in range(len(raw) // n)]
        self.assertEqual(len(frames), 20)
        def accent_px(f):  # magenta after the yuv420p round trip: red and blue high, green low
            return sum(1 for r, g, b in zip(f[0::3], f[1::3], f[2::3]) if r > 180 and g < 90 and b > 180)
        self.assertEqual(accent_px(frames[2]), 0, "hidden before the window")
        self.assertGreater(accent_px(frames[10]), 500, "the accent border shows inside the window")
        self.assertEqual(accent_px(frames[18]), 0, "hidden after the window")


class SummaryReadTests(unittest.TestCase):
    """Codex LV1b: the detect summary is outside data; an odd one never stops the long video."""

    def test_gate_pack_with_odd_summaries(self):
        import argparse  # noqa: PLC0415

        import clipper  # noqa: PLC0415
        import detector_pass as dp  # noqa: PLC0415
        for doc in ({"game": ["codm"]}, {"game": {"id": 1}}, {"game": 5}, [1], None, "x"):
            with self.subTest(doc=doc), tempfile.TemporaryDirectory() as d:
                with open(os.path.join(d, dp.SUMMARY), "w", encoding="utf-8") as f:
                    json.dump(doc, f)
                pack = clipper._gate_pack(argparse.Namespace(out=d))  # the default game's pack, or None
                self.assertTrue(pack is None or isinstance(pack, dict))


if __name__ == "__main__":
    unittest.main()
