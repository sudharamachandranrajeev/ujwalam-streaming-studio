# SPDX-License-Identifier: GPL-3.0-or-later
"""D440 loudness target (services/clip/clip_loudness.py, clip_montage.render_argv(gain_db=)). Done when: the gain sits
ahead of the existing true-peak limiter on track 1 (with and without music), the audio-only pre-pass drops every
picture chain, the gain maths and limits hold, a failed pre-pass gives no gain (render as before), the target comes
from Settings > Clips (null = off), and a real short render lands within 1 LU of -14 LUFS with true peak <= -1 dBTP
(ffmpeg ebur128). Synthetic sound (pink noise bursts on a quiet bed) only: real game sound is checked in the evidence
file."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

import clip_common as cc  # noqa: E402
import clip_loudness as cl  # noqa: E402
import clip_montage as mont  # noqa: E402

NOWIN = 0x08000000 if os.name == "nt" else 0
FRAME = {"width": 320, "height": 180}
ENC = ["-c:v", "libopenh264", "-b:v", "1M"]
AUD = ["-c:a", "aac", "-b:a", "160k"]
PIECES = [{"start": 0.5, "end": 6.0, "kills": 1}, {"start": 8.0, "end": 14.0, "kills": 1}]
FADE = {"kind": "fade", "xfade": "fade", "ms": 250}


def _graph(argv):
    return argv[argv.index("-filter_complex") + 1]


class Argv(unittest.TestCase):
    def test_no_gain_is_unchanged(self):
        a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4")
        self.assertNotIn("volume=", _graph(a))
        self.assertNotIn("alimiter", _graph(a))

    def test_gain_then_limiter_on_track_one_only(self):
        a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", audio_tracks=2,
                             transition=FADE, gain_db=12.5)
        g = _graph(a)
        self.assertIn("[aloud0]volume=12.50dB,aresample=192000,alimiter=limit=0.631", g)
        self.assertIn("[aout0]", g)
        self.assertNotIn("[aloud1]", g)
        self.assertLess(g.index("volume=12.50dB"), g.index("alimiter"))
        self.assertEqual(sum(1 for x in a if x == "-c:a"), 1, "one audio encode")

    def test_gain_with_music_goes_before_the_existing_limiter(self):
        a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", gain_db=-3,
                             music={"file": "music.wav", "duck": {"threshold": 0.05, "ratio": 8, "attackMs": 20,
                                                                  "releaseMs": 300}})
        g = _graph(a)
        self.assertIn("normalize=0,volume=-3.00dB,aresample=192000,alimiter", g)
        self.assertEqual(g.count("alimiter"), 1)

    def test_thumbnail_keeps_its_delay(self):
        a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", thumbnail="t.png", gain_db=6)
        g = _graph(a)
        self.assertIn("[aloud0]volume=6.00dB", g)
        self.assertIn("[ab0]adelay=delays=800S:all=1[aout0]", g)


class Probe(unittest.TestCase):
    def test_picture_chains_dropped_sound_kept(self):
        for kw in ({}, {"transition": FADE}, {"thumbnail": "t.png", "captions": "c.ass"},
                   {"fx": "[fxin]split=2[x][y];[y]crop=10:10:0:0[z];[x][z]overlay[fxout]"}):
            with self.subTest(kw=list(kw)):
                a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", gain_db=3, max_sec=9,
                                     **kw)
                p = cl.probe_argv(a)
                g = _graph(p)
                for bad in (":v]", "[v", "scale=", "xfade", "subtitles", "overlay", "libopenh264", "o.mp4"):
                    self.assertNotIn(bad, " ".join(p) if bad in ("libopenh264", "o.mp4") else g)
                self.assertIn("ebur128=peak=true", g)
                self.assertEqual(p[-3:], ["-f", "null", "-"])
                self.assertEqual(p[p.index("-t", p.index("-filter_complex")) + 1], "9.000")
                self.assertIn("info", p)

    def test_other_tracks_are_left_out(self):
        for kw in ({"transition": FADE}, {}):
            a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", audio_tracks=3,
                                 gain_db=2, **kw)
            g = _graph(cl.probe_argv(a))
            for k in (1, 2):
                self.assertNotIn(f"_{k}]", g)
                self.assertNotIn(f"aout{k}", g)
            self.assertIn("[aout0]", g)
        self.assertIn("[a0_0][a1_0]concat=n=2:v=0:a=1[aloud0]", g)

    def test_concat_keeps_only_sound(self):
        a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", gain_db=0)
        g = _graph(cl.probe_argv(a))
        self.assertIn("[a0_0][a1_0]concat=n=2:v=0:a=1[aloud0]", g)

    def test_no_sound_no_probe(self):
        a = mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", audio_tracks=0)
        self.assertIsNone(cl.probe_argv(a))
        self.assertIsNone(cl.probe_argv(["ffmpeg", "-i", "x"]))


class Maths(unittest.TestCase):
    CFG = {"minGainDb": -20, "maxGainDb": 30, "passes": 2, "toleranceLu": 1.0, "source": "user 2026-11-22"}

    def test_gain_limits_and_pooling(self):
        self.assertEqual(cl.gain_for(-14, -29, self.CFG), 15.0)
        self.assertEqual(cl.gain_for(-14, -60, self.CFG), 30.0)
        self.assertEqual(cl.gain_for(-14, 10, self.CFG), -20.0)
        self.assertAlmostEqual(cl.pooled([(-20, 10), (-20, 30)]), -20.0)
        self.assertAlmostEqual(cl.pooled([(-20, 1), (-30, 1)]), -22.6, places=1)
        self.assertIsNone(cl.pooled([(-20, 1), (None, 1)]))

    def test_plan_corrects_for_the_limiter_and_failure_means_none(self):
        class R:
            def __init__(self, rc, err):
                self.returncode, self.stderr = rc, err
        seen = []

        def build(g):
            seen.append(g)
            return [(mont.render_argv("ffmpeg", "s.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", gain_db=g), 11.0)]
        vals = iter([-29.0, -15.0])  # the limiter took 1 LU off at +15 dB

        def run(argv, cwd=None, timeout=None):
            return R(0, f"Integrated loudness:\n    I:         {next(vals)} LUFS\n")
        g, rec = cl.plan(build, run, ".", -14.0, self.CFG)
        self.assertEqual(g, 16.07)  # 15 + 1 LU / (14 LU per 15 dB)
        self.assertEqual(seen, [None, 15.0])
        self.assertEqual(rec["status"], "planned")
        g, rec = cl.plan(build, lambda *a, **k: R(1, "boom"), ".", -14.0, self.CFG)
        self.assertIsNone(g)
        self.assertEqual(rec["status"], "failed")
        self.assertEqual(cl.plan(build, run, ".", None, self.CFG), (None, {"target": None, "source": "user 2026-11-22",
                                                                          "status": "off"}))

    def test_target_from_settings(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(cl.target(d), -14.0)
            for v, want in ((-16, -16.0), (None, None), (-3, -14.0)):  # -3 is outside the range: the defaults
                with open(os.path.join(d, cc.SETTINGS_FILE), "w", encoding="utf-8") as f:
                    json.dump({"clips": {"look": {"music": {"loudnessLufs": v}}}}, f)
                self.assertEqual(cl.target(d), want)


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class RealRender(unittest.TestCase):
    def test_short_render_lands_on_target(self):
        """A 15 s source with quiet pink noise and short loud bursts (gunfire-like peaks), about -27 LUFS like the game."""
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "src.mkv")
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                                "testsrc2=size=320x180:rate=30:duration=15", "-f", "lavfi", "-i",
                                "anoisesrc=color=pink:amplitude=0.12:duration=15:sample_rate=48000",
                                "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.6:duration=15:sample_rate=48000:seed=7",
                                "-filter_complex",
                                "[2:a]volume='if(lt(mod(t,1.3),0.08),1,0)':eval=frame[b];[1:a][b]amix=inputs=2:normalize=0,"
                                "aformat=channel_layouts=stereo,asplit=2[a][a2]",
                                "-map", "0:v", "-map", "[a]", "-map", "[a2]", "-c:v", "libopenh264", "-c:a", "aac", src],
                               capture_output=True, text=True, timeout=300, creationflags=NOWIN)
            self.assertEqual(r.returncode, 0, r.stderr[-600:])
            cfg = cl.load_cfg()

            def build(g):
                return [(mont.render_argv("ffmpeg", "src.mkv", PIECES, FRAME, ENC, AUD, 40, "o.mp4", transition=FADE,
                                          gain_db=g, audio_tracks=2), 11.25)]  # two tracks, like the studio's
            g, rec = cl.plan(build, cc.run_tool, d, -14.0, cfg)
            self.assertIsNotNone(g, rec)
            r = cc.run_tool(build(g)[0][0], cwd=d, timeout=300)
            self.assertEqual(r.returncode, 0, r.stderr[-600:])
            res = cl.check("ffmpeg", os.path.join(d, "o.mp4"), -14.0, cfg)
            print(f"\nD440 synthetic: before {rec['measuredBefore']} LUFS, passes {rec['passes']}, gain {g} dB, after {res}")
            self.assertLessEqual(abs(res["lufs"] + 14.0), 1.0, res)
            self.assertLessEqual(res["truePeak"], -1.0, res)
            self.assertTrue(res["ok"])


if __name__ == "__main__":
    unittest.main()
