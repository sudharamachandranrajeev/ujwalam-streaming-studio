# SPDX-License-Identifier: GPL-3.0-or-later
"""RR1 countdown reel (services/clip/countdown.py, D424): the config check (overlay timing rule, colours, card length),
display names, the item pick across runs (vertical single plays only, score then kills, one per file, missing files
skipped, its own output never ranked), the user's list, the timeline, the combined music record, the card's ASS
events, the ffmpeg graph, and a real render (libopenh264, 108x192, three synthetic clips; skip without ffmpeg): the
length, one audio stream, the stop when a stream starts. Synthetic pictures and tones only."""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import countdown as cd  # noqa: E402

CFG = cd.load_config()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
HAVE_PIL = importlib.util.find_spec("PIL") is not None  # the card text widths (the shipped runtime has Pillow)


def cfg(**over):
    c = json.loads(json.dumps(CFG))
    for k, v in over.items():
        cur = c
        *path, last = k.split("__")
        for p in path:
            cur = cur[p]
        cur[last] = v
    return c


def fake_width(s, size):
    return len(s) * size * 0.5


class CheckTests(unittest.TestCase):
    def test_shipped_config_passes(self):
        c = cfg()
        self.assertIs(cd.check(c), c)

    def test_overlay_rule(self):
        for bad in ({"numeral__popMs": 600}, {"name__assembleMs": 650}, {"exitMs": 400}):
            with self.subTest(bad=bad), self.assertRaises(cc.ClipError):
                cd.check(cfg(**bad))

    def test_card_too_short_for_entrance_and_exit(self):
        with self.assertRaises(cc.ClipError):
            cd.check(cfg(cardSec=0.9))

    def test_items_and_join_limits(self):
        for bad in ({"items": 11}, {"minItems": 1}, {"minItems": 6}, {"join__ms": 1000}, {"clipMinSec": 8.0}):
            with self.subTest(bad=bad), self.assertRaises(cc.ClipError):
                cd.check(cfg(**bad))

    def test_bad_colour(self):
        with self.assertRaises(cc.ClipError):
            cd.check(cfg(rankColours=["#FFD400", "red", "#000000", "#111111", "#222222"]))


class NameTests(unittest.TestCase):
    def test_clean_name(self):
        self.assertEqual(cd.clean_name("{\\b1}Triple\tKill\x00", 22), "b1Triple Kill")
        self.assertEqual(cd.clean_name("A" * 30, 22), "A" * 22)
        self.assertEqual(cd.clean_name("   ", 22), "Play")
        self.assertEqual(cd.clean_name(None, 22), "Play")

    def test_display_name(self):
        self.assertEqual(cd.display_name("triple-kill", 3, "short"), "Triple Kill")
        self.assertEqual(cd.display_name("double_kill", 0, "short"), "Double Kill")
        self.assertEqual(cd.display_name(None, 1, "short"), "1 Kill")
        self.assertEqual(cd.display_name(None, 4, "short"), "4 Kills")
        self.assertEqual(cd.display_name(None, 0, "impact-play"), "Impact Play")
        self.assertEqual(cd.display_name(None, 0, "short"), "Highlight")


def write_run(root, run, sub, tool, clips, records=True):
    d = os.path.join(root, "clips", "runs", run, *([sub] if sub else []))
    os.makedirs(d, exist_ok=True)
    doc = {"tool": tool, "recording": "rec-v-20261120-200000.mkv", "clips": []}
    if records:
        doc["musicRecords"] = 1
    for c in clips:
        row = {k: v for k, v in c.items() if k not in ("make", "layout")}
        row["files"] = [{"layout": c.get("layout", "full-v"), "file": f"{c['id']}.mp4", "geometry": "canvas"}]
        if c.get("make", True):
            os.makedirs(os.path.join(d, "clips", c["id"]), exist_ok=True)
            with open(os.path.join(d, "clips", c["id"], f"{c['id']}.mp4"), "wb") as f:
                f.write(b"x")
        doc["clips"].append(row)
    with open(os.path.join(d, "render.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f)
    return d


class PickTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="rr1-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_best_five_lowest_first(self):
        write_run(self.root, "run-a", None, "clipper", [
            {"id": "L1", "score": 5.0, "labels": ["triple-kill"], "music": None},
            {"id": "L2", "score": 9.0, "labels": [], "music": None},
            {"id": "L3", "score": 1.0, "labels": [], "music": None},
            {"id": "L4", "score": 7.0, "labels": [], "music": None, "make": False},  # file gone: skipped
            {"id": "L5", "score": 8.0, "labels": [], "music": None, "layout": "beatdrop-h"},  # H: skipped
        ])
        write_run(self.root, "run-b", "montage", "clipper.montage", [
            {"id": "I1", "score": 6.0, "labels": ["VICTORY"], "music": {"source": "made-here", "seed": 1}},
            {"id": "M1", "score": 99.0, "labels": [], "music": None},  # montage: not a ranked item
        ])
        write_run(self.root, "run-c", None, "clipper.countdown", [{"id": "R1", "score": 50.0, "music": None,
                                                                    "layout": "countdown-v"}])
        write_run(self.root, "run-d", None, "clipper", [{"id": "L1", "score": 2.0, "labels": [], "music": None}])
        items = cd.pick_items(self.root, cfg())
        self.assertEqual([i["file"].replace("\\", "/").split("/runs/")[1] for i in items],
                         ["run-a/clips/L3/L3.mp4", "run-d/clips/L1/L1.mp4", "run-a/clips/L1/L1.mp4",
                          "run-b/montage/clips/I1/I1.mp4", "run-a/clips/L2/L2.mp4"])
        self.assertEqual([i["name"] for i in items], ["Highlight", "Highlight", "Triple Kill", "Victory", "Highlight"])
        self.assertEqual(items[3]["music"], {"source": "generated"})

    def test_too_few(self):
        write_run(self.root, "run-a", None, "clipper", [{"id": "L1", "score": 1.0, "music": None},
                                                         {"id": "L2", "score": 2.0, "music": None}])
        with self.assertRaises(cc.ClipError):
            cd.pick_items(self.root, cfg())

    def test_no_runs_folder(self):
        with self.assertRaises(cc.ClipError):
            cd.pick_items(self.root, cfg())

    def test_unreadable_render_json_skipped(self):
        write_run(self.root, "run-a", None, "clipper", [{"id": f"L{i}", "score": float(i), "music": None}
                                                         for i in range(1, 4)])
        os.makedirs(os.path.join(self.root, "clips", "runs", "run-b"))
        with open(os.path.join(self.root, "clips", "runs", "run-b", "render.json"), "w") as f:
            f.write("[not json")
        with open(os.path.join(self.root, "clips", "runs", "run-c"), "w") as f:  # a stray file, not a folder
            f.write("x")
        self.assertEqual(len(cd.pick_items(self.root, cfg())), 3)

    def test_user_items(self):
        files = []
        for n in ("a", "b", "c"):
            p = os.path.join(self.root, n + ".mp4")
            with open(p, "wb") as f:
                f.write(b"x")
            files.append(p)
        lst = os.path.join(self.root, "list.json")
        with open(lst, "w", encoding="utf-8") as f:
            json.dump([{"file": files[0], "name": "Best {one}"}, {"file": files[1], "name": "Two"},
                       {"file": files[2]}], f)
        items = cd.user_items(lst, cfg())
        self.assertEqual([i["name"] for i in items], ["Play", "Two", "Best one"])
        self.assertNotIn("music", items[0])  # a user's list has no records: the reel's music is unknown
        with open(lst, "w", encoding="utf-8") as f:
            json.dump([{"file": files[0]}, {"file": os.path.join(self.root, "gone.mp4")}], f)
        with self.assertRaises(cc.ClipError):
            cd.user_items(lst, cfg())
        with open(lst, "w", encoding="utf-8") as f:
            json.dump({"file": files[0]}, f)
        with self.assertRaises(cc.ClipError):
            cd.user_items(lst, cfg())


class MusicTests(unittest.TestCase):
    def test_combined(self):
        import clip_publish as pub
        n = {"music": None}
        g = {"music": {"source": "generated"}, "musicRaw": {"source": "made-here", "seed": 1}}
        raw = {"source": "ncs", "trackId": "t1", "credit": "c"}
        ncs = {"music": {"source": "ncs", "trackId": "t1", "credit": "c"}, "musicRaw": raw}
        none = {"music": {"source": "none"}, "musicRaw": None}
        self.assertIsNone(cd.combined_music([none]))
        self.assertIsNone(cd.combined_music([]))
        self.assertEqual(cd.combined_music([n, n]), {"source": "unknown"})  # an old render without a record
        self.assertIsNone(cd.combined_music([none, none]))
        made = cd.combined_music([none, g])
        self.assertEqual(pub.music_provenance({"music": made}, True), {"source": "generated"})  # read back as made here
        self.assertEqual(cd.combined_music([none, ncs, g, ncs]), raw)
        self.assertEqual(pub.music_provenance({"music": cd.combined_music([ncs])}, True), ncs["music"])
        other = {"music": {"source": "ncs", "trackId": "t1", "credit": None},
                 "musicRaw": {"source": "ncs", "trackId": "t1", "credit": None}}  # same track, credit missing
        self.assertEqual(cd.combined_music([ncs, other]), {"source": "unknown"})
        self.assertEqual(cd.combined_music([none, {"music": {"source": "user-folder", "track": "x"}}]),
                         {"source": "unknown"})
        self.assertEqual(cd.combined_music([none, {}]), {"source": "unknown"})
        self.assertEqual(pub.music_provenance({"music": {"source": "unknown"}}, True), {"source": "unknown"})

    def test_combined_free_pack(self):
        """D427: reels with the same free-pack track (each planned its own way) post with its credit; two pack
        tracks, or a pack track next to an NCS one or a folder track, stay unknown."""
        import clip_publish as pub
        credit = {"artist": "A", "title": "T", "licence": "CC0-1.0", "link": "https://freemusicarchive.org/music/a/"}

        def pk(tid, seg, cr=credit):
            raw = {"source": "pack", "trackId": tid, "credit": cr, "track": tid, "segments": [seg], "score": 0.7}
            return {"music": pub.music_provenance({"music": raw}, True), "musicRaw": raw}
        g = {"music": {"source": "generated"}, "musicRaw": {"source": "made-here", "seed": 1}}
        none = {"music": {"source": "none"}, "musicRaw": None}
        a1, a2, b = pk("p1", {"at": 0}), pk("p1", {"at": 3}), pk("p2", {"at": 0})
        got = cd.combined_music([none, a1, g, a2])
        self.assertEqual(got, {"source": "pack", "trackId": "p1", "credit": credit})
        self.assertEqual(pub.music_provenance({"music": got}, True), {"source": "pack", "trackId": "p1", "credit": credit})
        self.assertEqual(cd.combined_music([a1, b]), {"source": "unknown"})
        self.assertEqual(cd.combined_music([a1, pk("p1", {"at": 0}, None)]), {"source": "unknown"})
        ncs = {"music": {"source": "ncs", "trackId": "t1", "credit": "c"}, "musicRaw": {"source": "ncs", "trackId": "t1", "credit": "c"}}
        self.assertEqual(cd.combined_music([a1, ncs]), {"source": "unknown"})
        self.assertEqual(cd.combined_music([a1, {"music": {"source": "user-folder", "track": "x"}}]), {"source": "unknown"})


ITEMS = [{"file": "c.mp4", "name": "Three"}, {"file": "b.mp4", "name": "Two"}, {"file": "a.mp4", "name": "One"}]


class TimelineTests(unittest.TestCase):
    def test_parts_and_starts(self):
        parts, xd, total = cd.timeline(ITEMS, [5.0, 9.0, 3.0], [True, False, True], cfg())
        self.assertAlmostEqual(xd, 0.22)
        self.assertEqual([(p["kind"], p["rank"]) for p in parts],
                         [("card", 3), ("clip", 3), ("card", 2), ("clip", 2), ("card", 1), ("clip", 1)])
        self.assertEqual([p["sec"] for p in parts], [1.6, 5.0, 1.6, 7.0, 1.6, 3.0])  # 9 s capped at clipMaxSec
        self.assertEqual([p["audio"] for p in parts], [False, True, False, False, False, True])
        self.assertEqual([p["start"] for p in parts], [0.0, 1.38, 6.16, 7.54, 14.32, 15.7])
        self.assertAlmostEqual(total, 1.6 * 3 + 15.0 - 5 * 0.22, places=3)

    def test_too_short_clip(self):
        with self.assertRaises(cc.ClipError):
            cd.timeline(ITEMS, [5.0, 1.5, 3.0], [True] * 3, cfg())

    def test_join_kinds_cycle(self):
        self.assertEqual(cd.join_kinds(5, cfg()), ["slideup", "slideleft", "slidedown", "slideright", "slideup"])


class CardTests(unittest.TestCase):
    def parts(self):
        return cd.timeline(ITEMS, [5.0, 5.0, 5.0], [True] * 3, cfg())

    def test_first_card(self):
        parts, xd, _ = self.parts()
        ev = cd.card_events(parts[0], "Big Win", xd, cfg(), width=fake_width)
        self.assertEqual(len(ev), 1 + 6)  # the numeral and one event per letter (the space draws nothing)
        self.assertIn("}#3", ev[0])
        self.assertIn("\\1c&H00D6E62E", ev[0])  # rank 3: rankColours[2] #2EE6D6 as ASS &HAABBGGRR
        self.assertTrue(all(",0:00:00.00," in e for e in ev))  # the first card starts at once
        self.assertTrue(all("\\fad(0,250)" in e for e in ev))

    def test_later_card_waits_for_its_join(self):
        parts, xd, _ = self.parts()
        ev = cd.card_events(parts[2], "AB", xd, cfg(), width=fake_width)
        self.assertTrue(ev[0].startswith(f"Dialogue: 1,{cd.caps._ts(parts[2]['start'] + xd)},"))
        self.assertIn(f",{cd.caps._ts(parts[2]['start'] + parts[2]['sec'] - xd / 2)},", ev[0])

    def test_letters_move_into_place_inside_the_frame(self):
        parts, xd, _ = self.parts()
        c = cfg()
        name = "W" * 22
        ev = cd.card_events(parts[0], name, xd, c, width=fake_width)
        ends = []
        for e in ev[1:]:
            mv = e.split("\\move(")[1].split(")")[0].split(",")
            ends.append(int(mv[2]))
            self.assertEqual(mv[4:], ["0", str(c["name"]["assembleMs"])])
        self.assertGreaterEqual(min(ends), c["safe"]["left"] // 2)
        self.assertLessEqual(max(ends), c["frame"]["width"] - c["safe"]["right"] // 2)
        self.assertEqual(ends, sorted(ends))

    def test_same_seed_same_scatter(self):
        parts, xd, _ = self.parts()
        a = cd.card_events(parts[0], "Seed", xd, cfg(), width=fake_width)
        b = cd.card_events(parts[0], "Seed", xd, cfg(), width=fake_width)
        self.assertEqual(a, b)

    def test_ass_file(self):
        parts, xd, _ = self.parts()
        s = cd.to_ass(parts, ITEMS, xd, cfg(), width=fake_width)
        self.assertIn("PlayResX: 1080", s)
        self.assertIn("Style: Numeral,Anton,", s)
        self.assertEqual(s.count("}#"), 3)
        self.assertEqual(sum(1 for line in s.splitlines() if ",Name,," in line), len("Three") + len("Two") + len("One"))


class GraphTests(unittest.TestCase):
    def test_argv(self):
        items = [{"file": f"{n}.mp4", "name": n} for n in ("c", "b", "a")]
        parts, xd, _ = cd.timeline(items, [5.0, 5.0, 5.0], [True, False, True], cfg())
        argv = cd.render_argv("ffmpeg", items, parts, xd, cfg(), ["-c:v", "x"], ["-c:a", "aac"], "o.mp4.part",
                              ass="countdown.ass", fontsdir="countdown-fonts")
        self.assertEqual([argv[i + 1] for i, a in enumerate(argv) if a == "-i"], ["c.mp4", "b.mp4", "a.mp4"])
        g = argv[argv.index("-filter_complex") + 1]
        self.assertEqual(g.count("xfade="), 5)
        self.assertEqual(g.count("acrossfade="), 5)
        for p in parts[1:]:
            self.assertIn(f":offset={p['start']:.3f}", g)
        self.assertNotIn("[1:a:0]", g)  # the silent clip gets generated silence
        self.assertEqual(g.count("aevalsrc="), 4)
        # the text is burned last, then the output is pinned to 4:2:0 (joins and libass may hand back yuv444p)
        self.assertTrue(g.endswith("[vj]subtitles=countdown.ass:fontsdir=countdown-fonts[vf];[vf]format=yuv420p[vout]"))
        g2 = cd.render_argv("ffmpeg", items, parts, xd, cfg(), ["-c:v", "x"], ["-c:a", "aac"], "o.mp4.part")
        g2 = g2[g2.index("-filter_complex") + 1]  # no text: the last join feeds the format step directly
        self.assertIn(f":offset={parts[-1]['start']:.3f}[vf]", g2)
        self.assertTrue(g2.endswith(";[vf]format=yuv420p[vout]"))
        self.assertEqual(argv[-3:], ["-f", "mp4", "o.mp4.part"])

    def test_sound_start_against_picture(self):
        sf = cd.stream_facts
        self.assertEqual(sf({"streams": [{"codec_type": "video", "start_time": "1.000", "duration": "4.0"},
                                         {"codec_type": "audio", "start_time": "0.000"}]}), (4.0, True, -1.0))
        self.assertEqual(sf({"streams": [{"codec_type": "video", "start_time": "0", "duration": "3"},
                                         {"codec_type": "audio", "start_time": "0.5"}]}), (3.0, True, 0.5))
        self.assertEqual(sf({"streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
                             "format": {"duration": "6"}}), (6.0, True, 0.0))
        self.assertEqual(sf({"streams": [{"codec_type": "video", "start_time": "0", "duration": "N/A"}],
                             "format": {"duration": "5"}}), (5.0, False, 0.0))
        # Codex RR1: a 5 s file whose picture runs 2-5 s (Matroska, no stream length): 3 s of picture, not 5
        self.assertEqual(sf({"streams": [{"codec_type": "video", "start_time": "2"},
                                         {"codec_type": "audio", "start_time": "0"}],
                             "format": {"start_time": "0", "duration": "5"}}), (3.0, True, -2.0))
        self.assertEqual(sf({"streams": [{"codec_type": "audio"}]}), (0.0, True, 0.0))
        # Matroska: the picture's own DURATION tag, not the container's 10 s (sound runs longer)
        self.assertEqual(sf({"streams": [{"codec_type": "video", "start_time": "0", "tags": {"DURATION": "00:00:03.000000000"}},
                                         {"codec_type": "audio", "start_time": "0", "tags": {"DURATION": "00:00:10.0"}}],
                             "format": {"duration": "10"}}), (3.0, True, 0.0))
        # Codex RR1: the tag is the track's end, so a picture from 2 s to 5 s is 3 s long (seen on a real ffmpeg mkv)
        self.assertEqual(sf({"streams": [{"codec_type": "video", "start_time": "2.000000", "tags": {"DURATION": "00:00:05.000000000"}},
                                         {"codec_type": "audio", "start_time": "0.000000", "tags": {"DURATION": "00:00:05.023000000"}}],
                             "format": {"start_time": "0", "duration": "5.023"}}), (3.0, True, -2.0))
        items = [{"file": f"{n}.mp4", "name": n} for n in ("c", "b")]
        offs = {"c.mp4": 0.5, "b.mp4": -1.0}
        parts, xd, _ = cd.plan(items, lambda f: {"streams": [
            {"codec_type": "video", "start_time": "0", "duration": "5"},
            {"codec_type": "audio", "start_time": str(offs[f])}]}, cfg())
        g = cd.render_argv("ffmpeg", items, parts, xd, cfg(), [], [], "o.mp4")
        g = g[g.index("-filter_complex") + 1]
        self.assertIn("[0:a:0]asetpts=PTS-STARTPTS,adelay=500:all=1,atrim=duration=5.000", g)
        self.assertIn("[1:a:0]asetpts=PTS-STARTPTS,atrim=start=1.000,asetpts=PTS-STARTPTS,atrim=duration=5.000", g)

    def test_no_text(self):
        items = [{"file": f"{n}.mp4", "name": n} for n in ("c", "b")]
        parts, xd, _ = cd.timeline(items, [5.0, 5.0], [True, True], cfg())
        argv = cd.render_argv("ffmpeg", items, parts, xd, cfg(), [], [], "o.mp4")
        g = argv[argv.index("-filter_complex") + 1]
        self.assertNotIn("subtitles=", g)
        self.assertIn("[vout]", g)


class MakeGuardTests(unittest.TestCase):
    def test_on_air_before_start(self):
        d = tempfile.mkdtemp(prefix="rr1-")
        try:
            for live in (lambda: True, lambda: None, None):
                r = cd.make(ITEMS, os.path.join(d, "w"), "ffmpeg", "ffprobe", [], [], cfg(), live=live, lock_dir=d)
                self.assertEqual(r["status"], cd.STOPPED_ON_AIR)
            self.assertFalse(os.path.exists(os.path.join(d, "w")))
        finally:
            shutil.rmtree(d, ignore_errors=True)


class FlashRetryTests(unittest.TestCase):
    """D428: make_auto with a fake render (make()'s result shape) and a fake re-pick; no ffmpeg."""

    def setUp(self):
        self.pool = [f"p{i}.mp4" for i in range(7)]  # best first
        self.picks = []

    def pick(self, exclude, n=3):
        self.picks.append(list(exclude))
        left = [f for f in self.pool if f not in exclude][:n]
        if len(left) < 3:
            raise cc.ClipError(f"countdown: only {len(left)} rendered vertical clip(s) to rank (need 3)")
        return [{"file": f, "name": f} for f in reversed(left)]

    def render_with(self, bad, where=None, status=None):
        """A render that fails the flash limit while any file in bad is in the reel; where: a fixed window second."""
        calls = []

        def render(items):
            calls.append([i["file"] for i in items])
            if status:
                return {"status": status, "reason": "on", "file": None, "parts": None, "total": None, "flash": None}
            parts, _, total = cd.timeline(items, [5.0] * len(items), [True] * len(items), cfg())
            hit = [i for i, it in enumerate(items) if it["file"] in bad]
            if not hit:
                return {"status": "done", "reason": None, "file": cd.FILE, "parts": parts, "total": total,
                        "flash": {"pass": True, "peakFlashesPerSecond": 2}}
            t = where if where is not None else next(p for p in parts if p["kind"] == "clip"
                                                     and p["item"] == hit[0])["start"] + 1.0
            return {"status": "failed", "reason": "flash limit: 4 flashes/s (limit 3): not kept", "file": None,
                    "parts": parts, "total": total, "flash": {"pass": False, "peakFlashesPerSecond": 4,
                                                              "worstWindowStartSec": t}}
        return render, calls

    def test_part_at_prefers_clip_in_a_join(self):
        items = [{"file": "a"}, {"file": "b"}]
        parts, xd, _ = cd.timeline(items, [5.0, 5.0], [True, True], cfg())
        self.assertEqual(cd.part_at(parts, 0.1)["kind"], "card")
        join = parts[2]["start"] + xd / 2  # clip 0's tail overlaps card 1's head
        self.assertEqual((cd.part_at(parts, join)["kind"], cd.part_at(parts, join)["item"]), ("clip", 0))
        self.assertIsNone(cd.part_at(parts, 999))

    def test_drop_and_retry_succeeds(self):
        items = self.pick([])
        render, calls = self.render_with({"p1.mp4"})
        r = cd.make_auto(items, "w", cfg(), render, pick=self.pick)
        self.assertEqual(r["status"], "done")
        self.assertEqual(r["dropped"], [{"source": "p1.mp4", "reason": "flash"}])
        self.assertEqual(len(calls), 2)
        self.assertNotIn("p1.mp4", calls[1])
        self.assertEqual([i["file"] for i in r["items"]], ["p3.mp4", "p2.mp4", "p0.mp4"])

    def test_window_in_card_fails(self):
        render, calls = self.render_with({"p0.mp4"}, where=0.1)
        r = cd.make_auto(self.pick([]), "w", cfg(), render, pick=self.pick)
        self.assertEqual(r["status"], "failed")
        self.assertIn("rank card", r["reason"])
        self.assertEqual((len(calls), r["dropped"]), (1, []))

    def test_user_list_never_retries(self):
        render, calls = self.render_with({"p1.mp4"})
        r = cd.make_auto(self.pick([]), "w", cfg(), render, pick=None)
        self.assertEqual(r["status"], "failed")
        self.assertTrue(r["reason"].startswith("flash limit"))
        self.assertEqual(len(calls), 1)

    def test_retries_exhausted_fails(self):
        render, calls = self.render_with(set(self.pool))  # every clip flashes
        r = cd.make_auto(self.pick([]), "w", cfg(flash__retries=2), render, pick=self.pick)
        self.assertEqual(r["status"], "failed")
        self.assertIn("no retries left", r["reason"])
        self.assertEqual((len(calls), len(r["dropped"])), (3, 2))

    def test_too_few_left_fails(self):
        self.pool = self.pool[:4]
        render, calls = self.render_with(set(self.pool))
        r = cd.make_auto(self.pick([]), "w", cfg(flash__retries=5), render, pick=self.pick)
        self.assertEqual(r["status"], "failed")
        self.assertIn("only 2", r["reason"])
        self.assertEqual((len(calls), len(r["dropped"])), (2, 2))

    def test_on_air_during_retry_stops(self):
        bad_render, _ = self.render_with({"p1.mp4"})
        stop_render, _ = self.render_with(set(), status=cd.STOPPED_ON_AIR)
        seq = iter([bad_render, stop_render, bad_render])
        r = cd.make_auto(self.pick([]), "w", cfg(), lambda its: next(seq)(its), pick=self.pick)
        self.assertEqual(r["status"], cd.STOPPED_ON_AIR)
        self.assertEqual(r["dropped"], [{"source": "p1.mp4", "reason": "flash"}])

    def test_retries_checked(self):
        for bad in (-1, 11, 1.5, True, "3"):
            with self.subTest(bad=bad), self.assertRaises(cc.ClipError):
                cd.check(cfg(flash__retries=bad))


@unittest.skipUnless(HAVE_FFMPEG and HAVE_PIL, "ffmpeg or Pillow missing")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rr1-render-")
        cls.items = []
        # the third clip's sound ends 2 s before its picture (Codex RR1: it must not shift the later joins)
        for i, (colour, sec, audio) in enumerate((("0x2050A0", 3, 3), ("0xA05020", 4, 0), ("0x20A050", 3, 1))):
            p = os.path.join(cls.tmp, f"c{i}.mp4")
            argv = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=108x192:r=30:d={sec}"]
            if audio:
                argv += ["-f", "lavfi", "-i", f"sine=f={330 + 110 * i}:d={audio}", "-c:a", "aac"]
            argv += ["-c:v", "libopenh264", p]
            r = cc.run_tool(argv, timeout=300)
            assert r.returncode == 0, r.stderr
            cls.items.append({"file": p, "name": f"Clip {i}"})
        cls.cfg = cfg(frame={"width": 108, "height": 192}, minItems=3)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_render(self):
        wd = os.path.join(self.tmp, "w")
        seen = []
        r = cd.make(self.items, wd, "ffmpeg", "ffprobe", ["-c:v", "libopenh264", "-b:v", "800k"], ["-c:a", "aac"],
                    self.cfg, live=lambda: False, lock_dir=self.tmp,
                    measure=lambda f, stop: seen.append(f) or {"pass": True, "peakFlashesPerSecond": 0, "limit": 3})
        self.assertEqual(r["status"], "done", r["reason"])
        out = os.path.join(wd, cd.FILE)
        info = cc.media_info("ffprobe", out)
        self.assertAlmostEqual(info["duration"], r["total"], delta=0.15)
        self.assertTrue(info["has_audio"])
        r2 = cc.run_tool(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration",
                          "-of", "csv=p=0", out], timeout=60)
        self.assertAlmostEqual(float(r2.stdout.strip()), r["total"], delta=0.15)  # the sound is as long as the picture
        self.assertEqual((info["width"], info["height"]), (108, 192))
        self.assertEqual(seen, [os.path.join(wd, cd.FILE + ".part")])
        self.assertEqual(sorted(os.listdir(wd)), [cd.FILE])  # the ASS and fonts are gone

    def test_flash_over_limit_not_kept(self):
        wd = os.path.join(self.tmp, "w2")
        r = cd.make(self.items, wd, "ffmpeg", "ffprobe", ["-c:v", "libopenh264"], ["-c:a", "aac"], self.cfg,
                    live=lambda: False, lock_dir=self.tmp,
                    measure=lambda f, stop: {"pass": False, "peakFlashesPerSecond": 5, "limit": 3})
        self.assertEqual(r["status"], "failed")
        self.assertIn("flash limit", r["reason"])
        self.assertEqual(os.listdir(wd), [])

    def test_stream_starts_during_render(self):
        wd = os.path.join(self.tmp, "w3")
        calls = []

        def live():
            calls.append(1)
            return len(calls) > 2  # off air for the first checks, then a stream starts

        r = cd.make(self.items, wd, "ffmpeg", "ffprobe", ["-c:v", "libopenh264"], ["-c:a", "aac"], self.cfg,
                    live=live, lock_dir=self.tmp, poll_sec=0.05)
        self.assertEqual(r["status"], cd.STOPPED_ON_AIR)
        self.assertEqual(os.listdir(wd), [])


if __name__ == "__main__":
    unittest.main()
