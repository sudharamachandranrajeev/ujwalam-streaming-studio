# SPDX-License-Identifier: GPL-3.0-or-later
"""BD7c: a BeatDrop render (DIR/beatdrop/render.json, tool clipper.beatdrop) publishes like a montage: kind montage,
label kills-N from the plan's own count, H and V canvas names, its music record carried to uploads.json (the posting
gate: a user-folder song is never auto-posted), and tidy sees the beatdrop sub-run. Data only, no ffmpeg."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_names as names  # noqa: E402
import clip_publish as pub  # noqa: E402


def rdoc(music, files=("beatdrop-h", "beatdrop-v")):
    return {"tool": "clipper.beatdrop", "recording": "rec-h-20261121-200000.mkv", "musicRecords": 1,
            "clips": [{"id": "B1", "kind": "beatdrop", "start": 0.0, "end": 42.5, "music": music,
                       "beatdrop": {"stats": {"pieces": 9, "kills": 6}},
                       "files": [{"layout": lay, "file": f"beatdrop-x.{lay[-1]}.mp4", "geometry": "canvas"}
                                 for lay in files]}]}


class Names(unittest.TestCase):
    def test_kind_label_and_canvas(self):
        self.assertEqual(pub.kind_of("B1", "clipper.beatdrop"), "montage")
        self.assertEqual(pub.kind_of("B1", "clipper.render"), "short")  # only the BeatDrop tool's B ids
        rows = pub.name_rows(rdoc({"source": "made-here", "seed": 1}), "codm", {})
        got = [(kind, label, canvas) for _, _, kind, _, label, canvas in rows]
        self.assertEqual(got, [("montage", "kills-6", "h"), ("montage", "kills-6", "v")])
        for _, _, kind, when, label, canvas in rows:
            self.assertRegex(names.clip_name("codm", kind, when, label, 1, canvas), names.NAME_RE)


class Publish(unittest.TestCase):
    def _run(self, music):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        work = os.path.join(tmp.name, "run", "beatdrop")
        doc = rdoc(music)
        os.makedirs(os.path.join(work, "clips", "B1"))
        for f in doc["clips"][0]["files"]:
            with open(os.path.join(work, "clips", "B1", f["file"]), "wb") as fh:
                fh.write(b"video " + f["layout"].encode())
        with open(os.path.join(work, "render.json"), "w", encoding="utf-8") as fh:
            json.dump(doc, fh)
        with open(os.path.join(work, "report.json"), "w", encoding="utf-8") as fh:
            json.dump({"results": [{"id": "B1", "file": f["file"], "ok": True} for f in doc["clips"][0]["files"]]}, fh)
        data = os.path.join(tmp.name, "data")
        rows = pub.publish(work, os.path.join(tmp.name, "clips"), data, "codm", {}, run_name="run")
        with open(os.path.join(data, pub.UPLOADS), encoding="utf-8") as fh:
            return rows, json.load(fh)["files"]

    def test_both_files_reach_uploads_with_the_music_record(self):
        rows, ups = self._run({"source": "ncs", "trackId": "t1", "credit": "Song - Artist [NCS Release]"})
        self.assertEqual(len(rows), 2)
        self.assertEqual({u["kind"] for u in ups}, {"montage"})
        self.assertEqual({u["label"] for u in ups}, {"kills-6"})
        self.assertTrue(all(u["music"]["source"] == "ncs" and u["music"]["trackId"] == "t1" for u in ups))
        self.assertTrue(all(os.path.isfile(u["file"] + pub.MUSIC_SIDECAR) for u in ups))
        self.assertEqual(sorted(os.path.basename(u["file"]).split(".")[0][-1] for u in ups), ["h", "v"])

    def test_a_retake_is_a_new_video_and_supersedes_the_earlier_ones(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        work, data, to = (os.path.join(tmp.name, x) for x in ("run/beatdrop", "data", "clips"))
        os.makedirs(os.path.join(work, "clips", "B1"))

        def render(name, music, body):
            doc = rdoc(music, files=("beatdrop-h",))
            doc["clips"][0]["files"][0]["file"] = name
            with open(os.path.join(work, "clips", "B1", name), "wb") as fh:
                fh.write(body)
            for fn, obj in (("render.json", doc), ("report.json", {"results": [{"id": "B1", "file": name, "ok": True}]})):
                with open(os.path.join(work, fn), "w", encoding="utf-8") as fh:
                    json.dump(obj, fh)
            return pub.publish(work, to, data, "codm", {}, run_name="run")

        def uploads():
            with open(os.path.join(data, pub.UPLOADS), encoding="utf-8") as fh:
                return json.load(fh)["files"]
        first = render("beatdrop-a.mp4", {"source": "made-here", "seed": 1}, b"first take")
        self.assertEqual(len(first), 1)
        self.assertEqual(render("beatdrop-a.mp4", {"source": "made-here", "seed": 1}, b"first take"), [])  # same render
        # a retake: a new video beside it; the published bytes of the first are never touched; the first is superseded
        second = render("beatdrop-b.mp4", {"source": "folder", "track": "x.mp3"}, b"second take!")
        self.assertEqual(len(second), 1)
        self.assertNotEqual(second[0]["file"], first[0]["file"])
        with open(first[0]["file"], "rb") as fh:
            self.assertEqual(fh.read(), b"first take")
        by = {u["file"]: u for u in uploads()}
        self.assertEqual(by[first[0]["file"]]["supersededBy"], second[0]["file"])
        self.assertNotIn("supersededBy", by[second[0]["file"]])
        self.assertEqual(by[second[0]["file"]]["music"], {"source": "user-folder", "track": "x.mp3"})
        # a third take supersedes both earlier ones (each points at the newest)
        third = render("beatdrop-c.mp4", {"source": "made-here", "seed": 2}, b"third")
        by = {u["file"]: u for u in uploads()}
        self.assertEqual({by[x[0]["file"]].get("supersededBy") for x in (first, second)}, {third[0]["file"]})
        self.assertEqual(len(by), 3)
        # a publish that stopped after published.json: the next publish lists the newest take and supersedes the rest
        only_first = {k: v for k, v in by[first[0]["file"]].items() if k != "supersededBy"}
        with open(os.path.join(data, pub.UPLOADS), "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "files": [only_first]}, fh)
        self.assertEqual(render("beatdrop-c.mp4", {"source": "made-here", "seed": 2}, b"third"), [])  # same render
        by = {u["file"]: u for u in uploads()}
        self.assertEqual(by[first[0]["file"]].get("supersededBy"), third[0]["file"])
        self.assertIn(third[0]["file"], by)
        self.assertNotIn("supersededBy", by[third[0]["file"]])
    def test_a_row_from_before_bd7c_without_source_is_the_same_render(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        work = os.path.join(tmp.name, "beatdrop")
        os.makedirs(os.path.join(work, "clips", "B1"))
        doc = rdoc({"source": "made-here", "seed": 1}, files=("beatdrop-h",))
        name = doc["clips"][0]["files"][0]["file"]
        with open(os.path.join(work, "clips", "B1", name), "wb") as fh:
            fh.write(b"v")
        pubd = os.path.join(tmp.name, "old.mp4")
        with open(pubd, "wb") as fh:
            fh.write(b"v")
        for fn, obj in (("render.json", doc), ("report.json", {"results": [{"id": "B1", "file": name, "ok": True}]}),
                        (pub.PUBLISHED, {"files": [{"id": "B1", "layout": "beatdrop-h", "file": pubd}]})):
            with open(os.path.join(work, fn), "w", encoding="utf-8") as fh:
                json.dump(obj, fh)
        self.assertEqual(pub.publish(work, os.path.join(tmp.name, "clips"), os.path.join(tmp.name, "d"), "codm", {}), [])

    def test_uploads_list_lock_and_unreadable_list(self):
        from clip_common import ClipError  # noqa: PLC0415
        with tempfile.TemporaryDirectory() as data:
            p = os.path.join(data, pub.UPLOADS)
            os.makedirs(os.path.dirname(p))
            with open(p + ".lock", "w"):
                pass  # a live writer holds it
            with self.assertRaises(ClipError):
                with pub.uploads_lock(data, wait_sec=0.2):
                    pass
            os.utime(p + ".lock", (0, 0))  # a writer that died: taken over
            with pub.uploads_lock(data, wait_sec=0.2):
                self.assertTrue(os.path.isfile(p + ".lock"))
            self.assertFalse(os.path.exists(p + ".lock"))
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("{broken")
            row = {"file": "x.mp4", "kind": "montage", "label": "kills-1", "seconds": 1.0}
            with self.assertRaises(ClipError):
                pub.add_uploads(data, [row])
            with open(p, encoding="utf-8") as fh:
                self.assertEqual(fh.read(), "{broken")  # never replaced (its posted records would be lost)

    def test_user_folder_song_is_marked_for_the_gate(self):
        _, ups = self._run({"source": "folder", "track": "my-song.mp3"})
        self.assertTrue(all(u["music"]["source"] == "user-folder" for u in ups))  # posting never auto-posts these


class Validate(unittest.TestCase):
    def test_each_file_is_checked_against_its_own_frame_without_captions(self):
        import argparse  # noqa: PLC0415
        from unittest import mock  # noqa: PLC0415
        import clipper  # noqa: PLC0415
        doc = rdoc({"source": "made-here", "seed": 1})
        doc["frame"] = {"width": 1920, "height": 1080}
        doc["clips"][0]["files"][1]["frame"] = {"width": 1080, "height": 1920}
        seen = []

        def fake(_ff, _fp, path, exp, frame, *_a, **_k):
            seen.append((os.path.basename(path), exp, frame))
            return {"ok": True, "issues": [], "audio": {"tracks": 1, "loudness": []}}
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "render.json"), "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
            with mock.patch.object(clipper, "_tools", return_value=("ffmpeg", "ffprobe")), \
                    mock.patch.object(clipper.val, "validate_file", fake):
                rc = clipper.cmd_validate(argparse.Namespace(out=tmp, targets=None, no_decode=True))
            with open(os.path.join(tmp, "report.json"), encoding="utf-8") as fh:
                rep = json.load(fh)
        self.assertEqual(rc, 0)
        self.assertEqual([s[2] for s in seen], [{"width": 1920, "height": 1080}, {"width": 1080, "height": 1920}])
        self.assertEqual({s[1] for s in seen}, {42.5})
        self.assertEqual([r["captions"] for r in rep["results"]], [None, None])


class Tidy(unittest.TestCase):
    def test_beatdrop_sub_run_is_seen(self):
        with tempfile.TemporaryDirectory() as tmp:
            sub = os.path.join(tmp, "rec-h-20261121-200000", "beatdrop")
            os.makedirs(os.path.join(sub, "clips", "B1"))
            doc = rdoc({"source": "made-here", "seed": 1}, files=("beatdrop-h",))
            with open(os.path.join(sub, "render.json"), "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
            with open(os.path.join(sub, "clips", "B1", doc["clips"][0]["files"][0]["file"]), "wb") as fh:
                fh.write(b"v")
            plan = pub.tidy_plan(None, tmp, None, "codm", {})
            self.assertTrue(any(x["src"].endswith(doc["clips"][0]["files"][0]["file"]) for x in plan), plan)


if __name__ == "__main__":
    unittest.main()
