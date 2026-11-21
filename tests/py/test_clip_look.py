# SPDX-License-Identifier: GPL-3.0-or-later
"""FX1 clip look (services/clip/clip_look.py, D411): the settings checks (same cases as
tests/user-settings-clip-look.test.mjs), the pick rules (seeded, weighted, no repeat of the last N, lock, randomise
off, empty ticks = off, the one-clip override), the history file, and the flag (on). Synthetic values only."""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_look as cl  # noqa: E402

CFG = cl.load_config()
LOOK = CFG["defaults"]

# shared with the Node test: (value, expected problems)
CASES = [
    ({}, []),
    ({"randomise": False}, []),
    ({"randomise": "yes"}, ["clips.look.randomise must be true or false"]),
    ({"colour": 1}, ["unknown clips.look setting colour"]),
    ({"music": {"modes": ["drop", "drop"]}}, ["clips.look.music.modes must be a list of intro-outro, drop, full-bed (each once)"]),
    ({"music": {"modes": []}}, []),
    ({"music": {"levelDb": -30}}, ["clips.look.music.levelDb must be from -24 to -10"]),
    ({"music": {"sources": ["folder", "web"]}}, ["clips.look.music.sources must be a list of folder, pack, ai (each once)"]),
    ({"transitions": {"styles": ["retro"]}}, ["clips.look.transitions.styles must be a list of punchy, cinematic, clean (each once)"]),
    ({"transitions": {"lock": "clean", "sfx": False, "beatSync": True}}, []),
    ({"transitions": {"lock": "retro"}}, ["clips.look.transitions.lock must be empty or one of punchy, cinematic, clean"]),
    ({"name": {"colour": "#12345G"}}, ["clips.look.name.colour must be theme or a colour like #FF3B5C"]),
    ({"name": {"position": "middle"}}, ["clips.look.name.position must be one of auto, top-left, top-right, bottom-left, bottom-right, upper-third, lower-third"]),
    ({"name": {"sizePct": 100.5}}, ["clips.look.name.sizePct must be from 60 to 160"]),
    ({"name": {"durationSec": 2.5, "colour": "#FF3B5C", "styles": ["kinetic"]}}, []),
    ({"name": {"blur": True}}, ["unknown clips.look.name setting blur"]),
]


class SettingsTests(unittest.TestCase):
    def test_flag_is_on(self):
        flags = {f["id"]: f for f in cc.load_json(cc.FLAGS_FILE)["flags"]}
        self.assertIs(flags[cl.FLAG]["default"], True)

    def test_cases(self):
        for v, want in CASES:
            self.assertEqual(cl.look_problems(v, CFG), want, json.dumps(v))

    def test_shared_cases_file_matches(self):
        p = os.path.join(os.path.dirname(__file__), "..", "fixtures", "clip-look-cases.json")
        with open(p, encoding="utf-8") as f:
            shared = json.load(f)
        self.assertEqual([[v, w] for v, w in CASES], shared)

    def test_effective_merges_part_by_part(self):
        d = tempfile.mkdtemp(prefix="fx1-")
        try:
            self.assertEqual(cl.effective(d, CFG), LOOK)
            cc.write_json_atomic(os.path.join(d, cc.SETTINGS_FILE), {"clips": {"look": {"name": {"styles": ["kinetic"]}}}})
            e = cl.effective(d, CFG)
            self.assertEqual(e["name"]["styles"], ["kinetic"])
            self.assertEqual(e["name"]["position"], "auto")
            self.assertEqual(e["music"], LOOK["music"])
            cc.write_json_atomic(os.path.join(d, cc.SETTINGS_FILE), {"clips": {"look": {"name": {"sizePct": 999}}}})
            self.assertEqual(cl.effective(d, CFG), LOOK, "a bad value gives the defaults")
        finally:
            shutil.rmtree(d, ignore_errors=True)


class PickTests(unittest.TestCase):
    def test_determinism(self):
        a = cl.pick(LOOK, ["M1", "rec.mp4"], {}, CFG)
        b = cl.pick(LOOK, ["M1", "rec.mp4"], {}, CFG)
        self.assertEqual(a, b)
        seen = {tuple(cl.pick(LOOK, [f"M{i}", "rec.mp4"], {}, CFG)[g] for g in cl.GROUPS) for i in range(40)}
        self.assertGreater(len(seen), 5, "different reels get different looks")

    def test_no_repeat_of_the_last_pick(self):
        h = {}
        for i in range(60):
            p = cl.pick(LOOK, [f"M{i}", "rec.mp4"], h, CFG)
            for g in cl.GROUPS:
                if h.get(g):
                    self.assertNotEqual(p[g], h[g][-1], f"{g} repeated at reel {i}")
            h = cl.remember(None, p, CFG, history=h)

    def test_every_tick_is_used(self):
        h, got = {}, {g: set() for g in cl.GROUPS}
        for i in range(30):
            p = cl.pick(LOOK, [f"R{i}"], h, CFG)
            h = cl.remember(None, p, CFG, history=h)
            for g in cl.GROUPS:
                got[g].add(p[g])
        for g in cl.GROUPS:
            self.assertEqual(got[g], set(LOOK[g][CFG["groups"][g]["ticks"]]), g)

    def test_one_tick_repeats(self):
        look = cl.merge(CFG, {"name": {"styles": ["corner-tag"]}})
        h = {"name": ["corner-tag"]}
        self.assertEqual(cl.pick(look, ["x"], h, CFG)["name"], "corner-tag", "the only tick is used even if it was last")

    def test_lock_never_varies(self):
        look = cl.merge(CFG, {"transitions": {"lock": "cinematic"}})
        self.assertEqual({cl.pick(look, [f"M{i}"], {}, CFG)["transitions"] for i in range(30)}, {"cinematic"})

    def test_randomise_off_uses_the_first_tick(self):
        look = cl.merge(CFG, {"randomise": False, "music": {"modes": ["full-bed", "drop"]}})
        self.assertEqual({cl.pick(look, [f"M{i}"], {}, CFG)["music"] for i in range(20)}, {"full-bed"})

    def test_no_ticks_is_off(self):
        look = cl.merge(CFG, {"music": {"modes": []}, "name": {"styles": []}})
        p = cl.pick(look, ["M1"], {}, CFG)
        self.assertIsNone(p["music"])
        self.assertIsNone(p["name"])
        self.assertIsNotNone(p["transitions"])

    def test_override(self):
        env = {cl.ENV_OVERRIDE: json.dumps({"music": "off", "transitions": "clean", "name": "nope"})}
        ov = cl.override_from_env(CFG, env)
        self.assertEqual(ov, {"music": "off", "transitions": "clean"})
        look = cl.merge(CFG, {"transitions": {"lock": "punchy"}})
        p = cl.pick(look, ["M1"], {}, CFG, ov)
        self.assertEqual((p["music"], p["transitions"]), (None, "clean"))
        self.assertEqual(cl.override_from_env(CFG, {cl.ENV_OVERRIDE: "not json"}), {})

    def test_history_file(self):
        d = tempfile.mkdtemp(prefix="fx1-")
        try:
            cl.remember(d, {"music": "drop", "transitions": "clean", "name": None}, CFG, track="t1")
            h = cl.load_history(d)
            self.assertEqual(h, {"music": ["drop"], "transitions": ["clean"], "track": ["t1"]})
            for i in range(30):
                h = cl.remember(d, {"music": "drop"}, CFG)
            self.assertEqual(len(cl.load_history(d)["music"]), CFG["historyKeep"])
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
