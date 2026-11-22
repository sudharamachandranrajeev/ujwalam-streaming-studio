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
            return "captions.ass", "fonts"
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
                                   render_job, run_tool, {"e": []}, [], overlay=lambda c, f, a: ("captions.ass", "fonts"),
                                   overlay_failed=lambda i, e: failed.append((i, e)))
            self.assertTrue(ok, err)
        self.assertEqual(len(calls), 2)
        self.assertNotIn("subtitles=", " ".join(calls[1]))
        self.assertEqual(failed, [(0, "libass: bad")])


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


if __name__ == "__main__":
    unittest.main()
