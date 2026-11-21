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

    def test_user_folder_song_is_marked_for_the_gate(self):
        _, ups = self._run({"source": "folder", "track": "my-song.mp3"})
        self.assertTrue(all(u["music"]["source"] == "user-folder" for u in ups))  # posting never auto-posts these


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
