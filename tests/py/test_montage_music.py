# SPDX-License-Identifier: GPL-3.0-or-later
"""Montage music, the NCS library (services/clip/montage_music.py, D413 item 2, D414): credits from tags or from the
"Artist - Title [NCS Release]" file name, user edits kept on a rescan, the folder rule, random (seeded, no repeat of the
last N) and fixed picks, the render's music record (no credit = credit None), and the Codex BD review fixes: credits
keyed by the track's identity (a changed file loses its typed credit and is marked for review), scans off air only,
tags read through the safe open. Files here are small stand-ins (each with its own bytes) made in a temp folder; tags
are passed in, so no audio is decoded."""

import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import montage_music as mm  # noqa: E402

NAMES = ["Alpha Artist - First Song [NCS Release].mp3", "Beta & Gamma - Second Song [NCS Release].mp3",
         "Delta - Third.mp3", "untitled.mp3", "notes.txt"]


def OFF():
    return False


def tags(path):
    return {"artist": "Tag Artist", "title": "Tag Title"} if os.path.basename(path).startswith("Delta") else {}


class MontageMusicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ujw-mm-")
        self.data = os.path.join(self.tmp, "data")
        self.folder = os.path.join(self.tmp, "ncs")
        os.makedirs(self.folder)
        for n in NAMES:
            with open(os.path.join(self.folder, n), "wb") as f:
                f.write(n.encode("utf-8"))  # own bytes: own identity
        self.cfg = mm.load_config()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def rows(self):
        return {r["file"]: r for r in mm.view(mm.scan(self.data, self.folder, self.cfg, tags=tags, live=OFF), self.cfg)}

    def test_credits_from_name_and_tags(self):
        r = self.rows()
        self.assertNotIn("notes.txt", r)
        a = r[NAMES[0]]
        self.assertEqual((a["artist"], a["title"], a["source"], a["complete"]), ("Alpha Artist", "First Song", "file name", True))
        self.assertEqual(r[NAMES[1]]["artist"], "Beta & Gamma")
        self.assertEqual((r["Delta - Third.mp3"]["artist"], r["Delta - Third.mp3"]["source"]), ("Tag Artist", "tags"))
        self.assertEqual((r["untitled.mp3"]["complete"], r["untitled.mp3"]["source"]), (False, "none"))
        self.assertEqual(a["line"], "Music provided by NoCopyrightSounds")

    def test_edit_kept_on_rescan(self):
        tid = self.rows()["untitled.mp3"]["id"]
        mm.set_credit(self.data, tid, {"artist": "Real Artist", "title": "Real Song", "line": "Music provided by NoCopyrightSounds",
                                       "link": "https://ncs.io/example"}, self.cfg)
        r = self.rows()["untitled.mp3"]
        self.assertEqual((r["artist"], r["edited"], r["complete"], r["source"]), ("Real Artist", True, True, "edited"))

    def test_bad_credit_refused(self):
        tid = self.rows()["untitled.mp3"]["id"]
        for c in ({"artist": "", "title": "x"}, {"artist": "a<b", "title": "x"}, {"artist": "a", "title": "x", "link": "http://x"},
                  {"artist": "a", "title": "x", "extra": "y"}, {"artist": "a" * 200, "title": "x"}):
            with self.assertRaises(mm.ClipError):
                mm.set_credit(self.data, tid, c, self.cfg)
        with self.assertRaises(mm.ClipError):
            mm.set_credit(self.data, "0" * 16, {"artist": "a", "title": "b"}, self.cfg)

    def test_credit_text(self):
        t = mm.credit_text({"artist": "A", "title": "B", "line": "Music provided by NoCopyrightSounds", "link": ""}, self.cfg)
        self.assertEqual(t, "Song: A - B [NCS Release]\nMusic provided by NoCopyrightSounds")

    def test_folder_rule(self):
        self.assertIsNone(mm.folder_problem(self.folder))
        self.assertIn("full path", mm.folder_problem("ncs"))
        self.assertEqual(mm.folder_problem(os.path.join(self.folder, NAMES[0])), "not a folder")
        self.assertEqual(mm.folder_problem(os.path.join(self.tmp, "nope")), "folder not found")
        self.assertIn("network", mm.folder_problem("\\\\server\\share"))
        self.assertIn("fixed drive", mm.folder_problem(self.folder, drive_type=lambda r: 2))

    def test_random_no_repeat_and_fixed(self):
        s = {"on": True, "folder": self.folder, "mode": "random", "avoidLast": 3}
        orig = mm.read_tags
        mm.read_tags = tags
        try:
            picks = [mm.pick(self.data, self.folder, s, ["run", i], self.cfg, live=OFF)["id"] for i in range(8)]
            for i in range(3, 8):  # 4 tracks, avoid the last 3: never one of the 3 before
                self.assertNotIn(picks[i], picks[i - 3:i], picks)
            again = mm.pick(os.path.join(self.tmp, "data2"), self.folder, s, ["run", 0], self.cfg, live=OFF)["id"]
            self.assertEqual(again, picks[0], "seeded: the same seed, same history = same track")
            fixed = self.rows()[NAMES[1]]["id"]
            f = mm.pick(self.data, self.folder, dict(s, mode="fixed", fixedTrack=fixed), ["x"], self.cfg, live=OFF)
            self.assertEqual((f["id"], f["credit"]["artist"]), (fixed, "Beta & Gamma"))
            self.assertIsNone(mm.pick(self.data, self.folder, dict(s, on=False), ["x"], self.cfg, live=OFF))
            self.assertIsNone(mm.pick(self.data, self.folder, dict(s, mode="fixed", fixedTrack="f" * 16), ["x"], self.cfg, live=OFF))
        finally:
            mm.read_tags = orig

    def test_music_record(self):
        ok = mm.music_record({"id": "a" * 16, "credit": {"artist": "A", "title": "B", "line": "L", "link": ""}}, self.cfg)
        self.assertEqual((ok["source"], ok["trackId"], ok["credit"]["artist"]), ("ncs", "a" * 16, "A"))
        bad = mm.music_record({"id": "a" * 16, "credit": {"artist": "", "title": "B", "line": "L", "link": ""}}, self.cfg)
        self.assertIsNone(bad["credit"])

    def test_credit_follows_the_track_not_the_name(self):
        """Codex BD review: the same bytes in another folder keep the credit; other bytes under the same name do not."""
        tid = self.rows()["untitled.mp3"]["id"]
        mm.set_credit(self.data, tid, {"artist": "Real Artist", "title": "Real Song", "line": "L", "link": ""}, self.cfg)
        other = os.path.join(self.tmp, "copy")
        os.makedirs(other)
        shutil.copy(os.path.join(self.folder, "untitled.mp3"), os.path.join(other, "renamed.mp3"))
        r = {x["file"]: x for x in mm.view(mm.scan(self.data, other, self.cfg, tags=tags, live=OFF), self.cfg)}
        self.assertEqual((r["renamed.mp3"]["id"], r["renamed.mp3"]["artist"]), (tid, "Real Artist"), "same song: same credit")
        mm.scan(self.data, self.folder, self.cfg, tags=tags, live=OFF)
        with open(os.path.join(self.folder, "untitled.mp3"), "wb") as f:
            f.write(b"another song under the same name")
        r = self.rows()["untitled.mp3"]
        self.assertNotEqual(r["id"], tid)
        self.assertEqual((r["artist"], r["complete"], r["review"], r["source"]), ("", False, True, "changed"))
        self.assertNotIn(tid, {x["id"] for x in self.rows().values()}, "the old typed credit is dropped, not kept as missing")

    def test_scan_off_air_only(self):
        for live in (lambda: True, lambda: None, None):
            with self.assertRaises(mm.ClipError):
                mm.scan(self.data, self.folder, self.cfg, tags=tags, live=live)
        with self.assertRaises(mm.ClipError):
            mm.pick(self.data, self.folder, {"on": True, "folder": self.folder}, ["x"], self.cfg, live=lambda: True)

    def test_tags_read_through_the_safe_open(self):
        """Only the named demuxers: a playlist, a text file or a broken song gives no tags, never another file."""
        self.assertEqual(mm.read_tags(os.path.join(self.folder, "notes.txt")), {})
        bad = os.path.join(self.folder, "list.m3u")
        with open(bad, "w", encoding="utf-8") as f:
            f.write(os.path.join(self.folder, "untitled.mp3") + "\n")
        self.assertEqual(mm.read_tags(bad), {})
        self.assertEqual(mm.read_tags(os.path.join(self.folder, "untitled.mp3")), {})


if __name__ == "__main__":
    unittest.main()
