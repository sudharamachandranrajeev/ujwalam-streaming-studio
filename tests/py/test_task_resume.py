# SPDX-License-Identifier: GPL-3.0-or-later
"""D442: a clip job paused or stopped part-way keeps the clips it finished (clipper done-row.json per clip), and a
long highlights video keeps the batches it saved (long-parts/ with a manifest per part). Codex review findings 4, 5,
9, 11, 12: the keys hold the inputs' identity, a marker only vouches for the media it was written for, a fallback
batch is never kept, and the safe point line is printed only after the record is committed."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "services", "clip"))
import clip_common  # noqa: E402
import clipper  # noqa: E402
import long_video  # noqa: E402


def _write(p, data=b"x"):
    with open(p, "wb") as f:
        f.write(data)


def _bump_mtime(p):
    s = os.stat(p)
    os.utime(p, ns=(s.st_atime_ns, s.st_mtime_ns + 5_000_000_000))


class ClipRowResume(unittest.TestCase):
    LAY = [{"id": "v-full", "input": "v", "crop": [0, 0, 1080, 1920]}]

    def test_kept_only_with_the_same_inputs_and_every_file_there(self):
        c = {"id": "c01", "start": 10, "end": 30}
        key = clipper._row_key(c, self.LAY, "h264_nvenc", {"w": 1080}, "3", "none")
        self.assertEqual(key, clipper._row_key(c, self.LAY, "h264_nvenc", {"w": 1080}, "3", "none"))
        self.assertNotEqual(key, clipper._row_key(dict(c, end=31), self.LAY, "h264_nvenc", {"w": 1080}, "3", "none"))
        row = {"id": "c01", "files": [{"layout": "v-full", "file": "v.mp4"}], "errors": []}
        with tempfile.TemporaryDirectory() as wd:
            self.assertIsNone(clipper._done_row(wd, key), "no record: make it")
            self.assertFalse(clipper._save_done_row(wd, key, row), "no video: no record")
            open(os.path.join(wd, "v.mp4"), "wb").close()
            self.assertFalse(clipper._save_done_row(wd, key, row), "an empty video: no record")
            _write(os.path.join(wd, "v.mp4"))
            self.assertTrue(clipper._save_done_row(wd, key, row))
            self.assertEqual(clipper._done_row(wd, key), dict(row, resumed=True))
            self.assertIsNone(clipper._done_row(wd, "other"), "other inputs")
            clipper._save_done_row(wd, key, dict(row, errors=[{"layout": "h"}]))
            self.assertIsNone(clipper._done_row(wd, key), "a clip with errors is made again")

    def test_key_holds_source_identity_and_effective_layout_and_captions(self):  # finding 4
        c = {"id": "c01", "start": 10, "end": 30}
        with tempfile.TemporaryDirectory() as d:
            h = os.path.join(d, "h.mkv")
            _write(h, b"one")
            k = lambda lay=self.LAY, cap="on", src=None: clipper._row_key(  # noqa: E731
                c, lay, "h264_nvenc", {"w": 1080}, "3", cap, None, src or {"h": clipper._file_identity(h)})
            k0 = k()
            self.assertNotEqual(k0, k(lay=[dict(self.LAY[0], crop=[0, 0, 1000, 1920])]), "a new crop, same version")
            self.assertNotEqual(k0, k(cap="off"), "other caption settings")
            _write(h, b"two-longer")
            self.assertNotEqual(k0, k(), "the recording was replaced at the same path")

    def test_marker_does_not_vouch_for_replaced_media(self):  # finding 11
        row = {"id": "c01", "files": [{"layout": "v-full", "file": "v.mp4"}], "errors": []}
        with tempfile.TemporaryDirectory() as wd:
            _write(os.path.join(wd, "v.mp4"))
            self.assertTrue(clipper._save_done_row(wd, "k", row))
            _write(os.path.join(wd, "v.mp4"), b"y")
            _bump_mtime(os.path.join(wd, "v.mp4"))
            self.assertIsNone(clipper._done_row(wd, "k"), "the file was written after the marker")
            self.assertTrue(clipper._save_done_row(wd, "k", row))
            clipper._drop_done_row(wd)
            self.assertFalse(os.path.exists(os.path.join(wd, clipper.DONE_ROW)), "the marker goes before a re-render")


class LongPartResume(unittest.TestCase):
    def test_key_holds_recording_identity_and_song_content_not_its_path(self):  # finding 5
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "rec.mkv")
            _write(src, b"rec-a")
            a, b = os.path.join(d, "t1", "song.wav"), os.path.join(d, "t2", "song.wav")
            for p in (a, b):
                os.makedirs(os.path.dirname(p))
                _write(p, b"same song")
            k = lambda bed, s=src, enc="h264_nvenc": long_video.part_key(  # noqa: E731
                [{"start": 1, "end": 2, "kills": 1}], {"w": 1920}, 2, 300, None, -3.0, bed, None, {}, src=s, encoder=enc)
            self.assertEqual(k({"file": a, "start": 0}), k({"file": b, "start": 0}), "a new temp path, the same song")
            _write(b, b"other song")
            self.assertNotEqual(k({"file": a, "start": 0}), k({"file": b, "start": 0}), "another song")
            k0 = k(None)
            self.assertNotEqual(k0, k(None, enc="libx264"), "the encoder asked for is part of the render")
            _write(src, b"rec-b-replaced")
            self.assertNotEqual(k0, k(None), "another recording at the same path")

    def test_manifest_binds_the_media_and_goes_first(self):  # finding 11
        with tempfile.TemporaryDirectory() as adir:
            p = os.path.join(adir, "part-000.mov")
            _write(p)
            long_video.commit_part(adir, "part-000.mov", "k")
            self.assertTrue(long_video.part_done(adir, "part-000.mov", "k"))
            self.assertFalse(long_video.part_done(adir, "part-000.mov", "other"))
            _write(p, b"yy")
            _bump_mtime(p)
            self.assertFalse(long_video.part_done(adir, "part-000.mov", "k"), "media written after the manifest")
            long_video.drop_part(adir, "part-000.mov")
            self.assertEqual(os.listdir(adir), [])

    def test_fallback_batch_is_not_kept_and_safe_point_follows_the_manifest(self):  # findings 12, 9
        class R:
            def __init__(self, rc):
                self.returncode, self.stderr = rc, "boom"
        calls, seen = [], []

        def render_job(mk, enc, adir, part, what):
            calls.append(what)
            ok = "without captions" in what or len(calls) > 2
            if ok:
                _write(os.path.join(adir, part))
            return R(0 if ok else 1), enc

        def on_part(n):  # the manifest of a normally made part exists when the studio is told
            names = sorted(os.listdir(adir_holder[0]))
            seen.append((n, any(x.endswith(long_video.MANIFEST_SUFFIX) for x in names)))
        adir_holder = []
        with tempfile.TemporaryDirectory() as wd:
            adir_holder.append(os.path.join(wd, long_video.PARTS_DIR))
            segs = [{"start": 0, "end": 1, "kills": 1}]
            ov = lambda chunk, first, folder: {"fx": "[fxin]null[fxout]"}  # noqa: E731
            run_tool = lambda argv, cwd, timeout: R(1)  # noqa: E731 - the join fails: parts stay for the check
            long_video.render("ffmpeg", "src.mkv", segs, {"w": 1920}, "x", wd, 1, 0, None, 10, render_job, run_tool,
                              {"x": []}, [], overlay=ov, on_part=on_part)
            self.assertIn("without captions", calls[-1])
            self.assertEqual(seen, [], "a fallback part has no manifest and is no safe point")
            self.assertFalse(long_video.part_done(adir_holder[0], "part-000.mov", "any"))


class SafePointLine(unittest.TestCase):
    def test_distinct_line_and_known_stages_only(self):  # finding 9
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            clip_common.safepoint_line("render", 3)
        line = err.getvalue().strip()
        self.assertTrue(line.startswith(clip_common.SAFEPOINT_PREFIX))
        self.assertEqual(json.loads(line[len(clip_common.SAFEPOINT_PREFIX):]), {"stage": "render", "done": 3})
        with self.assertRaises(ValueError):
            clip_common.safepoint_line("candidates", 1)

class RoundTwo(unittest.TestCase):
    """Codex round 2 on the resume records."""

    def test_caption_key_follows_the_model_files(self):
        with tempfile.TemporaryDirectory() as d:
            m = os.path.join(d, "model")
            os.makedirs(m)
            _write(os.path.join(m, "model.bin"), b"small")
            k0 = clipper._caption_assets({"whisper_model": m})
            self.assertEqual(k0, clipper._caption_assets({"whisper_model": m}))
            _write(os.path.join(m, "model.bin"), b"another model")
            _bump_mtime(os.path.join(m, "model.bin"))
            self.assertNotEqual(k0, clipper._caption_assets({"whisper_model": m}), "replaced in place")

    def test_no_marker_without_expected_outputs_and_sidecars_are_bound(self):
        with tempfile.TemporaryDirectory() as wd:
            self.assertFalse(clipper._save_done_row(wd, "k", {"id": "c", "files": [], "errors": []}))
            self.assertFalse(os.path.exists(os.path.join(wd, clipper.DONE_ROW)))
            row = {"id": "c", "files": [{"layout": "v", "file": "v.mp4"}], "errors": []}
            _write(os.path.join(wd, "v.mp4"))
            _write(os.path.join(wd, "captions.srt"), b"1")
            self.assertTrue(clipper._save_done_row(wd, "k", row))
            self.assertIsNotNone(clipper._done_row(wd, "k"))
            os.remove(os.path.join(wd, "captions.srt"))
            self.assertIsNone(clipper._done_row(wd, "k"), "a removed subtitle file")
            self.assertTrue(clipper._save_done_row(wd, "k", row))
            _write(os.path.join(wd, "captions.vtt"), b"x")
            self.assertIsNone(clipper._done_row(wd, "k"), "a subtitle file that was not there")

    def test_review_key_ignores_look_history(self):
        ex = {"look": {"cfg": 1, "history": [1]}, "cap_on": True}
        self.assertEqual(clipper._stable_extras(ex), clipper._stable_extras(dict(ex, look={"cfg": 1, "history": [1, 2]})))
        self.assertNotEqual(clipper._stable_extras(ex), clipper._stable_extras(dict(ex, look={"cfg": 2, "history": [1]})))

    def test_recording_mtime_and_overlay_files_from_the_batch_folder(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "rec.mkv")
            _write(src, b"rec")
            adir = os.path.join(d, "parts")
            os.makedirs(os.path.join(adir, "fonts"))
            _write(os.path.join(adir, "captions.ass"), b"cue one")
            _write(os.path.join(adir, "fonts", "a.ttf"), b"font a")
            k = lambda: long_video.part_key([], {}, 1, 0, None, None, None, None,  # noqa: E731
                                            {"ass": "captions.ass", "fontsdir": "fonts"}, src=src, base=adir)
            k0 = k()
            _bump_mtime(src)
            k1 = k()
            self.assertNotEqual(k0, k1, "an in-place edit changes the mtime")
            _write(os.path.join(adir, "captions.ass"), b"cue two")
            k2 = k()
            self.assertNotEqual(k1, k2, "a relative ASS is read from the batch folder")
            _write(os.path.join(adir, "fonts", "a.ttf"), b"font b")
            self.assertNotEqual(k2, k(), "the fonts are part of the key")

    def test_degraded_overlay_gets_no_manifest(self):
        class R:
            returncode, stderr = 0, ""
        seen = []

        def render_job(mk, enc, adir, part, what):
            _write(os.path.join(adir, part))
            return R(), enc
        with tempfile.TemporaryDirectory() as wd:
            adir = os.path.join(wd, long_video.PARTS_DIR)
            ov = lambda chunk, first, folder: {"ass": None, "degraded": True}  # noqa: E731
            fail_join = lambda argv, cwd, timeout: type("F", (), {"returncode": 1, "stderr": "x"})()  # noqa: E731

            def on_part(n):
                seen.append(n)
            long_video.render("ffmpeg", "src.mkv", [{"start": 0, "end": 1, "kills": 1}], {"w": 1}, "x", wd, 1, 0, None,
                              10, render_job, fail_join, {"x": []}, [], overlay=ov, on_part=on_part)
            self.assertEqual(seen, [], "no safe point for a batch whose overlay was prepared only in part")
            self.assertFalse(os.path.exists(adir) and any(n.endswith(long_video.MANIFEST_SUFFIX) for n in os.listdir(adir)))


if __name__ == "__main__":
    unittest.main()
