# SPDX-License-Identifier: GPL-3.0-or-later
"""D441: BR end screen (S2) and BR top HUD (H1) in the match gate (services/clip/match_gate.py). OCR results are
hand-written fixtures in game-area fractions at the positions measured on 6 BR matches of the 2026-11-22 recording
(docs/evidence/2026-11-24-br-end-screen.md); names are placeholders (PLAYER_A ...)."""
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.normpath(os.path.join(_HERE, "..", ".."))
_CLIP = os.path.join(_REPO, "services", "clip")
if _CLIP not in sys.path:
    sys.path.insert(0, _CLIP)

import game_pack  # noqa: E402
import match_gate as mg  # noqa: E402

PACK = game_pack.load_pack(os.path.join(_REPO, "data", "games", "codm"))
CFG = mg.stats_config(PACK)
S2 = mg.br_end_detector(PACK)
H1 = mg.br_hud_detector(PACK)
NAMES = ["OWN_NAME"]

# measured boxes (x0, y0, x1, y1), 2026-11-22, identical in all 6 matches
GAME_OVER = (0.325, 0.368, 0.672, 0.519)
MISSION_COMPLETED = (0.194, 0.371, 0.804, 0.518)
RANKING_LABEL = (0.279, 0.562, 0.334, 0.611)
MODE_LABEL = (0.280, 0.637, 0.319, 0.676)
MAP_LABEL = (0.280, 0.683, 0.314, 0.723)
RANK_VALUE = (0.635, 0.541, 0.724, 0.621)
MODE_VALUE = (0.634, 0.634, 0.719, 0.679)
MAP_VALUE = (0.650, 0.685, 0.718, 0.722)
STRIP_RANK = (0.251, 0.026, 0.349, 0.093)
STRIP_MODE = (0.103, 0.889, 0.275, 0.929)
STRIP_KILLS = (0.200, 0.725, 0.260, 0.757)
END_DECOY = (0.056, 0.022, 0.095, 0.050)  # an N/M box on every end frame: not players left
HUD_LEFT = (0.136, 0.022, 0.171, 0.060)
HUD_KILLS = (0.204, 0.027, 0.219, 0.056)
HUD_GULAG = (0.232, 0.027, 0.270, 0.056)


def box(text, g, score=0.99):
    return {"text": text, "score": score, "g": list(g)}


def card(rank="#4/50", heading="GAME OVER", mode="Battle Royale", mp="VERDANSK"):
    out = [box("858/10", END_DECOY), box("Ranking", RANKING_LABEL), box("Mode", MODE_LABEL), box("MAP", MAP_LABEL),
           box("PLAYER_A", (0.40, 0.80, 0.48, 0.83))]
    if heading:
        out.append(box(heading, MISSION_COMPLETED if heading == "MISSION COMPLETED" else GAME_OVER))
    if rank:
        out.append(box(rank, RANK_VALUE))
    if mode:
        out.append(box(mode, MODE_VALUE))
    if mp:
        out.append(box(mp, MAP_VALUE))
    return out


def strip(rank="#2/51", line="Battle Royale- VERDANSK"):
    return [box(rank, STRIP_RANK), box(line, STRIP_MODE), box("KILLS 3", STRIP_KILLS),
            box("PLAYER_B", (0.20, 0.70, 0.27, 0.72))]


def hud(left="96/97", kills="3"):
    out = [box("x1", HUD_GULAG)]
    if left:
        out.append(box(left, HUD_LEFT))
    if kills is not None:
        out.append(box(kills, HUD_KILLS))
    return out


def hit(t, det, label=None, signal=True, mode="br", **kw):
    return dict({"t": t, "tEnd": t, "detector": det, "label": label, "signal": signal, "why": [], "mode": mode}, **kw)


class PackTests(unittest.TestCase):
    def test_detectors_are_unverified_br_context(self):
        for d in (S2, H1):
            self.assertIsNotNone(d)
            self.assertEqual((d["role"], d["modes"], d["status"], d["nameRequired"], d["weight"]),
                             ("context", ["br"], "unverified", False, None))
            self.assertTrue(all(r["status"] == "unverified" and "2026-11-22" in r.get("note", "") for r in d["rois"]))
        self.assertIn("S2", CFG["endScreenDetectors"])
        self.assertEqual(CFG["detectorModes"]["S2"], ["br"])
        self.assertEqual(CFG["detectorModes"]["W1"], ["mp"])

    def test_rois_hold_the_measured_box_centres(self):
        want = {"heading": [GAME_OVER, MISSION_COMPLETED], "ranking": [RANK_VALUE], "mode_value": [MODE_VALUE],
                "map_value": [MAP_VALUE], "strip_rank": [STRIP_RANK], "strip_mode": [STRIP_MODE]}
        for rid, gs in want.items():
            for g in gs:
                self.assertTrue(mg._inside(g, mg._roi(S2, rid)), rid)
        self.assertTrue(mg._inside(HUD_LEFT, mg._roi(H1, "players_left")))
        self.assertTrue(mg._inside(HUD_KILLS, mg._roi(H1, "own_kills")))
        # neighbours stay out: labels, the end-frame N/M box, the gulag box, the map row in the mode ROI
        for g in (RANKING_LABEL, MODE_LABEL, MAP_LABEL, MAP_VALUE):
            self.assertFalse(mg._inside(g, mg._roi(S2, "mode_value")))
        self.assertFalse(mg._inside(END_DECOY, mg._roi(H1, "players_left")))
        self.assertFalse(mg._inside(HUD_GULAG, mg._roi(H1, "own_kills")))
        self.assertFalse(mg._inside(HUD_KILLS, mg._roi(H1, "players_left")))

    def test_names_are_pack_texts(self):
        st = S2["stats"]
        self.assertIn("Battle Royale", st["modeNames"])
        self.assertIn("VERDANSK", st["mapNames"])
        self.assertEqual(st["headings"], ["GAME OVER", "MISSION COMPLETED"])


class ParseEndTests(unittest.TestCase):
    def test_game_over_card(self):
        self.assertEqual(mg.parse_br_end(card(), S2),
                         {"screen": "card", "ownRank": 4, "teams": 50, "gameMode": "battle royale",
                          "map": "VERDANSK", "heading": "GAME OVER"})

    def test_win_card(self):
        r = mg.parse_br_end(card("#1/51", "MISSION COMPLETED"), S2)
        self.assertEqual((r["ownRank"], r["teams"], r["heading"]), (1, 51, "MISSION COMPLETED"))

    def test_card_with_heading_only_or_mode_only(self):
        self.assertEqual(mg.parse_br_end(card(mode=None), S2)["heading"], "GAME OVER")
        self.assertEqual(mg.parse_br_end(card(heading=None), S2)["gameMode"], "battle royale")

    def test_strip(self):
        self.assertEqual(mg.parse_br_end(strip(), S2),
                         {"screen": "strip", "ownRank": 2, "teams": 51, "gameMode": "battle royale",
                          "map": "VERDANSK", "heading": None})
        self.assertEqual(mg.parse_br_end(strip(line="Battle Royale - VERDANSK"), S2)["map"], "VERDANSK")

    def test_never_a_guess(self):
        self.assertIsNone(mg.parse_br_end(card(heading=None, mode=None), S2))  # a lone #N/M is no end screen
        self.assertIsNone(mg.parse_br_end(card(rank="#2"), S2))  # one 2026-11-22 frame read #2 without /M
        self.assertIsNone(mg.parse_br_end(card(rank="#60/51"), S2))  # placement above the team count
        self.assertIsNone(mg.parse_br_end([box("#4/50", STRIP_KILLS), box("GAME OVER", GAME_OVER)], S2))
        self.assertIsNone(mg.parse_br_end(strip(line="PLAYER_A - VERDANSK"), S2))
        self.assertIsNone(mg.parse_br_end([], S2))

    def test_popup_text_in_map_row_is_not_a_map(self):
        # a daily-challenge popup can cover x 0.64-0.81 y 0.67-0.76 a few seconds after the card
        r = mg.parse_br_end(card(mp=None) + [box("PLACEHOLDER CHALLENGE", (0.66, 0.69, 0.80, 0.72))], S2)
        self.assertEqual((r["ownRank"], r["map"]), (4, None))


class ParseHudTests(unittest.TestCase):
    def test_players_left_and_own_kills(self):
        self.assertEqual(mg.parse_br_hud(hud(), H1), {"playersLeft": 96, "ownKills": 3})

    def test_decoys_and_misreads(self):
        self.assertIsNone(mg.parse_br_hud([box("858/10", END_DECOY), box("x1", HUD_GULAG)], H1))
        self.assertEqual(mg.parse_br_hud(hud(kills="x"), H1), {"playersLeft": 96, "ownKills": None})
        self.assertEqual(mg.parse_br_hud(hud(left="97/96", kills="0"), H1), {"playersLeft": None, "ownKills": 0})
        self.assertIsNone(mg.parse_br_hud(hud(left=None, kills="123"), H1))

    def test_hud_kills_need_two_frames(self):
        rd = [{"kind": "br_hud", "t": t, "ownKills": k} for t, k in ((10, 0), (11, 0), (50, 2), (51, 2), (90, 7))]
        self.assertEqual(mg.br_hud_kills(rd, 0, 100), 2)  # 7 read once: a misread
        self.assertEqual(mg.br_hud_kills(rd, 0, 50), 0)  # end is exclusive
        self.assertIsNone(mg.br_hud_kills(rd[-1:], 0, 100))


class FrameStatsTests(unittest.TestCase):
    def test_br_frames(self):
        rows, readings = mg.frame_stats(card(), PACK, NAMES, 0.8, "br")
        self.assertEqual([(r["detector"], r["label"], r["signal"], r["clipReason"]) for r in rows],
                         [("S2", "GAME OVER", True, False)])
        self.assertEqual(readings[0]["kind"], "br_end")
        rows, readings = mg.frame_stats(hud(), PACK, NAMES, 0.8, "br")
        self.assertEqual(rows, [])
        self.assertEqual(readings, [{"kind": "br_hud", "playersLeft": 96, "ownKills": 3}])

    def test_not_in_mp_frames(self):
        rows, readings = mg.frame_stats(card(), PACK, NAMES, 0.8, "mp")
        self.assertFalse([r for r in rows if r["detector"] == "S2"])
        self.assertFalse([r for r in readings if r["kind"] in ("br_end", "br_hud")])

    def test_no_names_in_output(self):
        rows, readings = mg.frame_stats(card() + strip(), PACK, NAMES, 0.8, "br")
        self.assertNotIn("PLAYER_", repr(rows) + repr(readings))


class SegmentTests(unittest.TestCase):
    def match(self, rank=1, teams=51, w1_mode="br"):
        hits = [hit(100, "B1", "BR kill feed"), hit(900, "S2", "GAME OVER"), hit(910, "S2", "GAME OVER"),
                dict(hit(905, "W1", "VICTORY" if rank != 1 else "DEFEAT", mode=w1_mode), banner="match")]
        rd = [{"kind": "br_hud", "t": t, "playersLeft": 40, "ownKills": k} for t, k in ((200, 1), (201, 1), (400, 2),
                                                                                    (401, 2), (402, 5))]
        rd += [{"kind": "br_end", "t": 900, "screen": "card", "ownRank": rank, "teams": teams,
                "gameMode": "battle royale", "map": "VERDANSK",
                "heading": "MISSION COMPLETED" if rank == 1 else "GAME OVER"},
               {"kind": "br_end", "t": 910, "screen": "strip", "ownRank": rank, "teams": teams,
                "gameMode": "battle royale", "map": "VERDANSK", "heading": None}]
        ms = mg.segment(hits, {"readings": rd}, 911.0, CFG)
        self.assertEqual(len(ms), 1)
        return ms[0]

    def test_win(self):
        m = self.match()
        self.assertTrue(m["endSeen"])
        self.assertEqual((m["ownRank"], m["teams"], m["map"], m["placementSource"], m["top3Seen"]),
                         (1, 51, "VERDANSK", "br end screen", True))
        self.assertEqual((m["result"], m["resultConfirmed"], m["resultAt"], m["resultEnd"]), ("VICTORY", True, 900, 910))
        self.assertEqual((m["family"], m["gameMode"], m["mode"], m["modeConfidence"]),
                         ("br", "battle royale", "battle royale", "high"))
        self.assertEqual((m["ownKills"], m["killsSource"]), (2, "hud counter"))

    def test_placement_is_no_result_and_w1_misread_dropped(self):
        m = self.match(rank=4, teams=50)  # a W1 VICTORY misread on the BR screen
        self.assertEqual((m["ownRank"], m["teams"]), (4, 50))
        self.assertEqual((m["result"], m["resultConfirmed"], m["resultAt"]), (None, False, None))

    def test_w1_on_a_br_screen_never_closes_a_match(self):
        hits = [hit(100, "B1", "BR kill feed"), dict(hit(500, "W1", "VICTORY"), banner="match")]
        ms = mg.segment(hits, None, 900.0, CFG)
        self.assertEqual([m["endSeen"] for m in ms], [False])
        hits[1]["mode"] = "mp"
        self.assertTrue(mg.segment(hits, None, 900.0, CFG)[0]["endSeen"])


if __name__ == "__main__":
    unittest.main()
