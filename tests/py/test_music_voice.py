# SPDX-License-Identifier: GPL-3.0-or-later
"""D437: the game mix measurement and speech times for the music bed (services/clip/music_voice.py), and the clipper's
use of them (_music_level). Run as a script: python -I tests/py/test_music_voice.py"""

from __future__ import annotations

import importlib.util
import math
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import music_voice as mv  # noqa: E402

HAVE_VAD = importlib.util.find_spec("faster_whisper") is not None
HAVE_NP = importlib.util.find_spec("numpy") is not None  # CI's plain Python has none (use the project venv)


def tone(sec, db, sr=48000):
    import numpy as np
    t = np.arange(int(sec * sr)) / sr
    x = (10 ** (db / 20.0)) * np.sin(2 * math.pi * 997.0 * t)
    return np.stack([x, x], axis=1)


@unittest.skipUnless(HAVE_NP, "numpy missing (use the project venv)")
class VoiceTests(unittest.TestCase):
    VC = {"threshold": 0.5, "minSpeechSec": 0.25, "mergeGapSec": 0.4, "depthDb": 8, "attackSec": 0.2, "releaseSec": 0.3}

    def test_reel_time_over_joins(self):
        ps = [{"start": 0.0, "end": 5.0}, {"start": 10.0, "end": 15.0}, {"start": 20.0, "end": 25.0}]
        self.assertEqual(mv.map_span(1.0, 2.0, ps, 0.5), [(1.0, 2.0)])
        self.assertEqual(mv.map_span(7.0, 8.0, ps, 0.5), [(6.5, 7.5)])
        self.assertEqual(mv.map_span(12.0, 13.0, ps, 0.5), [(11.0, 12.0)])
        # Codex review: a span over a join is cut at the edge, never dropped
        self.assertEqual(mv.map_span(4.9, 5.1, ps, 0.5), [(4.9, 5.0), (4.5, 4.6)])
        # a piece played at half speed takes twice as long on the reel
        slow = [{"start": 0.0, "end": 2.0, "speed": 0.5}, {"start": 5.0, "end": 7.0}]
        self.assertEqual(mv.map_span(2.5, 3.0, slow, 0.0), [(4.5, 5.0)])
        self.assertEqual(mv.map_span(1.0, 1.5, slow, 0.0), [(2.0, 3.0)])

    def test_merge(self):
        self.assertEqual(mv.merge([(3.0, 4.0), (0.0, 1.0), (1.2, 2.0)], 0.4), [(0.0, 2.0), (3.0, 4.0)])

    def test_speech_spans_with_injected_vad(self):
        x = tone(6.0, -20)
        ps = [{"start": 10.0, "end": 13.0}, {"start": 20.0, "end": 23.0}]
        vad = lambda a: [{"start": 16000, "end": 32000}, {"start": 64000, "end": 72000}]  # noqa: E731 - 1-2 s, 4-4.5 s
        self.assertEqual(mv.speech_spans(x, ps, 0.25, self.VC, vad), [(1.0, 2.0), (3.75, 4.25)])

    def test_measure_never_raises(self):
        with tempfile.TemporaryDirectory() as d:
            m = mv.measure(os.path.join(d, "no-ffmpeg.exe"), os.path.join(d, "none.mp4"), [{"start": 0, "end": 1}], 0.0, d, self.VC)
        self.assertIsNone(m["gameLufs"])
        self.assertIsNone(m["spans"])
        self.assertIn("not read", m["speech"])
        broken = mv.measure("ffmpeg", "x", [{"start": 0, "end": 6}], 0.0, ".", self.VC, audio=tone(6.0, -20),
                            vad=lambda a: (_ for _ in ()).throw(RuntimeError("vad broke")))
        self.assertIsNotNone(broken["gameLufs"], "the loudness still counts")
        self.assertIsNone(broken["spans"])
        self.assertIn("no speech times", broken["speech"])

    def test_game_lufs_of_a_tone(self):
        v = mv.game_lufs(tone(4.0, -20))
        self.assertTrue(-22.0 < v < -16.0, v)  # a 997 Hz sine at -20 dBFS per channel, two channels: about -17 LUFS
        self.assertIsNone(mv.game_lufs(tone(4.0, -120)))

    def test_bed_window_follows_speed_and_skips_crossfade(self):
        import numpy as np
        pieces = [{"start": 10, "end": 14, "speed": 2}, {"start": 30, "end": 33}]
        # On the reel: 1.5-2 is the crossfade; 2-3 is the second piece's 0.5-1.5.
        raw = np.concatenate([tone(4.5, -10), tone(1, -40), tone(1.5, -10)])
        window = [{"at": 1.5, "len": 1.5}]
        self.assertEqual(mv.bed_window_lufs(raw, pieces, 0.5, window), mv.game_lufs(tone(1, -40)))
        self.assertIsNone(mv.bed_window_lufs(raw, pieces, 0.5, [{"at": 0, "len": 4.5}]), "full bed")
        self.assertIsNone(mv.bed_window_lufs(raw, pieces, 0.5, [{"at": 1.5, "len": 0.5}]), "only a crossfade")
        self.assertIsNone(mv.bed_window_lufs(raw, [dict(pieces[0], ramp={"audio": "mute"}), pieces[1]], 0.5, window))
        self.assertIsNone(mv.bed_window_lufs(raw * 0, pieces, 0.5, window), "silent program in the window")

    def test_argv_joins_the_pieces_at_48k_stereo(self):
        a = mv.game_audio_argv("ffmpeg", "rec.mp4", [{"start": 1.0, "end": 3.0}, {"start": 5.0, "end": 6.5}], "g.wav")
        self.assertEqual(a.count("-i"), 2)
        self.assertIn("1.500", a)
        g = a[a.index("-filter_complex") + 1]
        self.assertIn("concat=n=2:v=0:a=1", g)
        self.assertIn("aresample=48000", g)

    @unittest.skipUnless(HAVE_VAD, "faster-whisper (Silero VAD) missing")
    def test_real_vad_runs_on_a_tone(self):
        m = mv.measure("ffmpeg", "x", [{"start": 0, "end": 4}], 0.0, ".", self.VC, audio=tone(4.0, -20))
        self.assertEqual(m["speech"], "vad")
        self.assertEqual(m["spans"], [], "a steady tone is not speech")


@unittest.skipUnless(HAVE_NP, "numpy missing (use the project venv)")
class ClipperLevelTests(unittest.TestCase):
    def test_off_bed_action_cannot_raise_partial_music(self):
        import numpy as np
        import clipper
        import music_library as mlib
        segments = [{"at": 0, "len": 1}, {"at": 4, "len": 1}]
        plan = {"segments": segments, "levelDb": -20}
        mplan = {"rec": plan, "record": dict(plan, source="folder", track="song"), "track": {"id": "song"}}
        ex = {"look": {"mlcfg": mlib.load_config(), "look": {"music": {"levelDb": -20, "voiceDuckDb": 0}}},
              "music": {"duck": {}}}
        pieces = [{"start": 10, "end": 15}]

        def render(edges, middle):
            raw = np.concatenate([tone(1, edges), tone(3, middle), tone(1, edges)])
            with patch.object(mv, "game_audio", return_value=raw) as extract, patch.object(mlib, "prepare") as prepare:
                _, rec = clipper._music(".", pieces, 0, None, ex, mplan=mplan, ffmpeg="ffmpeg", src="original")
                extract.assert_called_once()
                self.assertEqual(prepare.call_args.args[1]["targetLufs"], rec["targetLufs"])
            return rec

        quiet = render(-40, -40)
        action = render(-40, -12)
        self.assertGreater(action["level"]["gameLufs"], quiet["level"]["gameLufs"] + 20)
        self.assertAlmostEqual(action["targetLufs"], quiet["targetLufs"], delta=0.1)
        self.assertAlmostEqual(action["targetLufs"], action["level"]["bedWindowGameLufs"] - 8, delta=0.1)
        bright = render(-24, -30)
        self.assertGreater(bright["level"]["bedWindowGameLufs"], bright["level"]["gameLufs"])
        self.assertEqual(bright["targetLufs"], mlib.target_lufs(-20, bright["level"]["gameLufs"], 8))
        with (patch.object(mlib, "load_library"), patch.object(mlib, "usable", return_value=[mplan["track"]]),
              patch.object(mlib, "prepare") as prepare):
            clipper._recaption_music(".", ".", {"music": action}, pieces, 0, "M01")
            self.assertEqual(prepare.call_args.args[1]["targetLufs"], action["targetLufs"])

    def test_music_level_without_ffmpeg_keeps_the_users_level(self):
        import clipper
        import music_library as mlib
        mcfg = mlib.load_config()
        tgt, voice, rec = clipper._music_level(None, None, [], 0.0, ".", {"levelDb": -18}, mcfg)
        self.assertEqual((tgt, voice), (-18.0, None))
        self.assertEqual(rec["speech"], "not measured")

    def test_music_level_measured(self):
        import clipper
        import music_library as mlib
        mcfg = mlib.load_config()
        orig = mv.measure
        try:
            mv.measure = lambda *a, **k: {"gameLufs": -30.0, "spans": [(1.0, 2.0)], "speech": "vad"}
            tgt, voice, rec = clipper._music_level("ffmpeg", "x.mp4", [{"start": 0, "end": 5}], 0.0, ".",
                                                   {"levelDb": -20, "underGameDb": 8, "voiceDuckDb": 6}, mcfg)
            self.assertEqual(tgt, -38.0)
            self.assertEqual(voice["depthDb"], 6.0)
            self.assertEqual(voice["spans"], [(1.0, 2.0)])
            self.assertEqual(rec["speechSec"], 1.0)
            _, off, _ = clipper._music_level("ffmpeg", "x.mp4", [{"start": 0, "end": 5}], 0.0, ".",
                                             {"levelDb": -20, "voiceDuckDb": 0}, mcfg)
            self.assertIsNone(off, "0 dB = no voice duck")
        finally:
            mv.measure = orig


if __name__ == "__main__":
    unittest.main()
