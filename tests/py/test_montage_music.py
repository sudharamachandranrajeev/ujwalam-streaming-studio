# SPDX-License-Identifier: GPL-3.0-or-later
"""Montage music, the NCS library (services/clip/montage_music.py, D413 item 2, D414): credits from tags or from the
"Artist - Title [NCS Release]" file name, user edits kept on a rescan, the folder rule, random (seeded, no repeat of the
last N) and fixed picks, the render's music record (no credit = credit None), and the Codex BD review fixes: credits
keyed by the track's identity (a changed file loses its typed credit and is marked for review), scans off air only,
tags read through the safe open. Files here are small stand-ins (each with its own bytes) made in a temp folder; tags
are passed in, so no audio is decoded."""

import importlib.util
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

    def test_identity_is_the_whole_file_cached_bounded_and_stoppable(self):
        """Codex verify: two files with the same size and first MiB but another ending get other ids; the hash is
        cached by path + size + mtime_ns; it stops on air mid-file and refuses a file over identity.maxBytes."""
        a, b = os.path.join(self.tmp, "a.mp3"), os.path.join(self.tmp, "b.mp3")
        head = b"x" * (2 * mm.CHUNK)
        with open(a, "wb") as f:
            f.write(head + b"tail-one")
        with open(b, "wb") as f:
            f.write(head + b"tail-two")
        self.assertNotEqual(mm._id(a, self.cfg, OFF), mm._id(b, self.cfg, OFF))
        cache = {}
        tid = mm._id(a, self.cfg, OFF, cache)
        calls = []
        self.assertEqual(mm._id(a, self.cfg, lambda: calls.append(1) or True, cache), tid, "cached: no read, no on-air ask")
        self.assertEqual(calls, [])
        st = os.stat(a)
        os.utime(a, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
        with self.assertRaises(mm.ClipError):  # changed: hashed again, and now on air -> stopped
            mm._id(a, self.cfg, lambda: True, cache)
        big = os.path.join(self.tmp, "big.mp3")
        with open(big, "wb") as f:
            f.write(b"y" * (40 * mm.CHUNK))
        n = []
        def turns_live():
            n.append(1)
            return len(n) > 1
        with self.assertRaises(mm.ClipError) as e:  # a stream starts mid-file: stopped at the next check
            mm._id(big, self.cfg, turns_live)
        self.assertIn("off air", str(e.exception))
        small = dict(self.cfg, identity=dict(self.cfg["identity"], maxBytes=mm.CHUNK))
        with self.assertRaises(mm.ClipError):
            mm._id(big, small, OFF)
        doc = mm.scan(self.data, self.folder, self.cfg, tags=tags, live=OFF)
        saved = mm.load_json(os.path.join(self.data, *self.cfg["identity"]["cache"].split("/")))["files"]
        self.assertEqual(sorted(v["id"] for v in saved.values()), sorted(doc["tracks"]))

    def test_scan_off_air_only(self):
        for live in (lambda: True, lambda: None, None):
            with self.assertRaises(mm.ClipError):
                mm.scan(self.data, self.folder, self.cfg, tags=tags, live=live)
        with self.assertRaises(mm.ClipError):
            mm.pick(self.data, self.folder, {"on": True, "folder": self.folder}, ["x"], self.cfg, live=lambda: True)

    @unittest.skipUnless(importlib.util.find_spec("av") is not None, "needs PyAV (the shipped runtime has it)")
    def test_tags_read_through_the_safe_open(self):
        """Only the named demuxers: a playlist, a text file or a broken song gives no tags, never another file."""
        self.assertEqual(mm.read_tags(os.path.join(self.folder, "notes.txt")), {})
        bad = os.path.join(self.folder, "list.m3u")
        with open(bad, "w", encoding="utf-8") as f:
            f.write(os.path.join(self.folder, "untitled.mp3") + "\n")
        self.assertEqual(mm.read_tags(bad), {})
        self.assertEqual(mm.read_tags(os.path.join(self.folder, "untitled.mp3")), {})


BAR = "｜"
NCS_OK = f"Aero Chord feat. DDARK - Shootin Stars {BAR} Trap {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus"
NCS_NOGENRE_PLAIN = "Cartoon, Jéja - C U Again ft. Mikk Mäe (Cartoon, Jéja, Futuristik VIP) | NCS - Copyright Free Music [NJNp6DnAAIo].opus"
NCS_HOUSE = f"1aevne, baby.murcielaga - i just like you {BAR} Outsider House {BAR} NCS - Copyright Free Music [gvvMAxH3yV4].opus"


class NcsFilenameTests(unittest.TestCase):
    """D417: strict NCS file-name credit."""

    def setUp(self):
        self.cfg = mm.load_config()

    def test_accept(self):
        a = mm.parse_ncs_name(NCS_OK, self.cfg)
        self.assertEqual(a, {"artist": "Aero Chord feat. DDARK", "title": "Shootin Stars", "genre": "Trap", "youtubeId": "PTF5xgT-pm8"})
        b = mm.parse_ncs_name(NCS_NOGENRE_PLAIN, self.cfg)
        self.assertEqual((b["artist"], b["title"], b["youtubeId"], "genre" in b),
                         ("Cartoon, Jéja", "C U Again ft. Mikk Mäe (Cartoon, Jéja, Futuristik VIP)", "NJNp6DnAAIo", False))
        c = mm.parse_ncs_name(NCS_HOUSE, self.cfg)
        self.assertEqual((c["artist"], c["genre"]), ("1aevne, baby.murcielaga", "Outsider House"))
        self.assertIsNotNone(mm.parse_ncs_name(NCS_OK.replace(BAR, "|"), self.cfg))

    def test_reject_table(self):
        ok = NCS_OK
        rej = {
            "no marker": f"A - B {BAR} Trap {BAR} Copyright Free Music [PTF5xgT-pm8].opus",
            "marker wrong case": ok.replace("NCS - Copyright", "ncs - copyright"),
            "no id": f"A - B {BAR} Trap {BAR} NCS - Copyright Free Music.opus",
            "short id": ok.replace("PTF5xgT-pm8", "PTF5xgT-pm"),
            "long id": ok.replace("PTF5xgT-pm8", "PTF5xgT-pm8x"),
            "bad id char": ok.replace("PTF5xgT-pm8", "PTF5xgT-p!8"),
            "junk after": ok.replace(".opus", " (1).opus"),
            "junk before id": ok.replace("[PTF", "x [PTF"),
            "extra bar": f"A - B {BAR} X {BAR} Trap {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus",
            "no artist split": f"Just A Title {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus",
            "bidi": ok.replace("Shootin", "Shoot‮in"),
            "isolate": ok.replace("Shootin", "⁧Shootin"),
            "zero width": ok.replace("Aero", "Ae​ro"),
            "control": ok.replace("Shootin", "Shoot\nin"),
            "brace": ok.replace("Shootin", "{Shootin}"),
            "angle": ok.replace("Shootin", "<b>Shootin"),
            "wrong ext": ok.replace(".opus", ".txt"),
            "no ext": ok[:-5],
            "plain own": "Alpha Artist - First Song [NCS Release].mp3",
            "long name": "A" * 400 + f" - B {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus",
            "long artist": "A" * 130 + f" - B {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus",
            "long title": "A - " + "B" * 170 + f" {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus",
            "long genre": f"A - B {BAR} " + "G" * 70 + f" {BAR} NCS - Copyright Free Music [PTF5xgT-pm8].opus",
            "not a string": None,
            "soft hyphen": ok.replace("Aero", "Ae­ro"),
            "c1 control": ok.replace("Aero", "Ae\u0085ro"),
            "word joiner range": ok.replace("Aero", "Ae⁤ro"),
            "tag character": ok.replace("Aero", "Ae\U000e0001ro"),
            "private use": ok.replace("Aero", "Aero"),
            "hangul filler": ok.replace("Aero", "Aeㅤro"),
            "line separator": ok.replace("Aero", "Ae ro"),
            "paragraph separator": ok.replace("Aero", "Ae ro"),
        }
        for why, name in rej.items():
            self.assertIsNone(mm.parse_ncs_name(name, self.cfg), why)

    def test_refused_ncs_name_gets_no_loose_name_credit(self):
        # Codex D417 review: a strict-refused NCS-marked name must not fall back to the loose "Artist - Title" parser
        tmp = tempfile.mkdtemp(prefix="ujw-ncs-")
        try:
            folder = os.path.join(tmp, "m")
            os.makedirs(folder)
            bad = NCS_OK.replace("Aero", "Ae​ro")
            loose = "Plain Artist - Plain­ Song.mp3"
            for n in (bad, loose):
                with open(os.path.join(folder, n), "wb") as f:
                    f.write(n.encode("utf-8"))
            rows = {r["file"]: r for r in mm.view(mm.scan(os.path.join(tmp, "d"), folder, self.cfg, tags=lambda p: {}, live=OFF), self.cfg)}
            self.assertEqual((rows[bad]["source"], rows[bad]["complete"]), ("none", False))
            # the loose parser still credits an unmarked name, without the invisible character
            self.assertEqual((rows[loose]["source"], rows[loose]["title"], rows[loose]["complete"]), ("file name", "Plain Song", True))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_invisible_characters_make_a_credit_incomplete(self):
        for ch in ("​", "­", "\u0085", "﻿", " ", " "):
            self.assertFalse(mm.complete({"artist": f"A{ch}B", "title": "T"}, self.cfg), repr(ch))

    def test_disabled_by_data(self):
        cfg = dict(self.cfg, ncsFilename=dict(self.cfg["ncsFilename"], enabled=False))
        self.assertIsNone(mm.parse_ncs_name(NCS_OK, cfg))

    def test_credit_text_exact(self):
        n = mm.parse_ncs_name(NCS_OK, self.cfg)
        c = mm.ncs_credit(n, self.cfg)
        self.assertEqual(mm.credit_text(c, self.cfg, "ncs-filename"),
                         "Music: Aero Chord feat. DDARK - Shootin Stars [NCS Release]\nMusic provided by NoCopyrightSounds\n"
                         "Watch: https://youtu.be/PTF5xgT-pm8")
        # another origin keeps the old template
        self.assertTrue(mm.credit_text(c, self.cfg).startswith("Song: "))

    def test_scan_pick_record_and_sidecar_fields(self):
        tmp = tempfile.mkdtemp(prefix="ujw-ncs-")
        try:
            folder = os.path.join(tmp, "m")
            os.makedirs(folder)
            for n in (NCS_OK, "My Own Song.mp3"):
                with open(os.path.join(folder, n), "wb") as f:
                    f.write(n.encode("utf-8"))
            rows = {r["file"]: r for r in mm.view(mm.scan(os.path.join(tmp, "d"), folder, self.cfg, tags=lambda p: {}, live=OFF), self.cfg)}
            self.assertEqual((rows[NCS_OK]["source"], rows[NCS_OK]["complete"]), ("ncs-filename", True))
            self.assertEqual(rows[NCS_OK]["link"], "https://youtu.be/PTF5xgT-pm8")
            self.assertEqual(rows["My Own Song.mp3"]["source"], "none")
            tr = mm.pick(os.path.join(tmp, "d"), folder, {"mode": "fixed", "fixedTrack": rows[NCS_OK]["id"], "folder": folder},
                         ["s"], self.cfg, live=OFF, tags=lambda p: {})  # CI's plain Python has no PyAV
            rec = mm.music_record(tr, self.cfg)
            self.assertEqual(rec["source"], "ncs-filename")
            self.assertEqual(rec["ncs"], {"artist": "Aero Chord feat. DDARK", "title": "Shootin Stars", "genre": "Trap", "youtubeId": "PTF5xgT-pm8"})
            self.assertEqual(rec["credit"]["link"], "https://youtu.be/PTF5xgT-pm8")
            # a tampered stored record cannot change the credit: it is re-read from the file name
            tr2 = dict(tr, credit={"artist": "Evil", "title": "X", "line": "L", "link": "https://evil.example/"})
            self.assertEqual(mm.music_record(tr2, self.cfg)["credit"]["artist"], "Aero Chord feat. DDARK")
            # a record whose file name no longer parses has no credit (never sent)
            self.assertIsNone(mm.music_record(dict(tr, file="renamed.opus"), self.cfg)["credit"])
            # the publish step keeps the source and the parsed fields for the sidecar
            import clip_publish as cp  # noqa: PLC0415
            prov = cp.music_provenance({"music": rec})
            self.assertEqual((prov["source"], prov["trackId"], prov["ncs"]["youtubeId"]), ("ncs-filename", tr["id"], "PTF5xgT-pm8"))
            # an edited credit becomes a plain "ncs" record again
            mm.set_credit(os.path.join(tmp, "d"), tr["id"], {"artist": "A", "title": "B", "line": "L", "link": ""}, self.cfg)
            edited = mm.load_credits(os.path.join(tmp, "d"), self.cfg)["tracks"][tr["id"]]
            self.assertNotIn("ncs", edited)
            self.assertEqual(edited["source"], "edited")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
