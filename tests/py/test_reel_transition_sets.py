# SPDX-License-Identifier: GPL-3.0-or-later
"""FX3 transition sets (services/clip/reel_transition.py plan_set/beat_sync, services/clip/reel_sfx.py, D411): the set
data, the seeded join picks (no kind twice in a row, flash joins never closer than minFlashGapSec), beat sync (earlier
only, at most 0.25 s, a piece's kill never cut), the sound effects (length, peak level), the filter graph, and real
renders (libopenh264, 180x320, a few seconds; skip without ffmpeg): the flash rate measured from the rendered frames'
luminance with the fx test definition (services/overlay-server/flash-detect.mjs, WCAG 2.3.1: a transition is a change
of 0.1 relative luminance with the darker state below 0.8; at most 3 flashes = 6 transitions in any 1 s, per window
of a third of the frame and the whole frame), and the audio encoded once (one audio stream with music and effects).
Needs numpy (the project venv); synthetic pictures and tones only."""

import os
import shutil
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:
    import numpy as np
except ImportError:
    np = None

import clip_common as cc  # noqa: E402
import clip_montage as mont  # noqa: E402
import reel_transition as rt  # noqa: E402

D = rt.load_defaults()
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
FRAME = {"width": 180, "height": 320}


def piece(a, b, kills=1):
    return {"start": float(a), "end": float(b), "kills": kills}


def many(n, length=0.8, gap=1.0):
    return [piece(i * (length + gap), i * (length + gap) + length) for i in range(n)]


def flashes_per_second(frames, fps):
    """Worst flashes in any 1 s window: frames (n, h, w, 3) uint8 sRGB. Mirror of flash-detect.mjs (general flashes)."""
    c = frames.astype(np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    lum = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    n, h, w = lum.shape
    series = [lum.mean(axis=(1, 2))]
    rh, rw, sh, sw = h // 3, w // 3, max(1, h // 6), max(1, w // 6)
    for y in range(0, h - rh + 1, sh):
        for x in range(0, w - rw + 1, sw):
            series.append(lum[:, y:y + rh, x:x + rw].mean(axis=(1, 2)))
    worst = 0.0
    for s in series:
        ends = []  # zig-zag: a leg counts once the signal turns back by >= 0.1
        lo = hi = s[0]
        lo_i = hi_i = 0
        direction = 0
        for i in range(1, n):
            v = s[i]
            if direction >= 0 and v > hi:
                hi, hi_i = v, i
            if direction <= 0 and v < lo:
                lo, lo_i = v, i
            if direction >= 0 and hi - v >= 0.1 and hi - lo >= 0.1 and min(hi, lo) < 0.8:
                ends.append(hi_i)
                direction, lo, lo_i = -1, v, i
            elif direction <= 0 and v - lo >= 0.1 and hi - lo >= 0.1 and min(hi, lo) < 0.8:
                ends.append(lo_i)
                direction, hi, hi_i = 1, v, i
        if direction != 0 and abs(hi - lo) >= 0.1 and min(hi, lo) < 0.8:
            ends.append(hi_i if direction > 0 else lo_i)
        win = int(round(fps))
        for i in range(n):
            k = sum(1 for e in ends if i <= e < i + win)
            worst = max(worst, k / 2.0)
    return worst


class DataTests(unittest.TestCase):
    def test_sets(self):
        self.assertEqual(sorted(D["setsById"]), ["cinematic", "clean", "punchy"])
        for s in D["sets"]:
            self.assertLessEqual(float(s["sfxDb"]), -12, "effects stay well under the game mix")
            self.assertTrue(any(not j.get("flash") for j in s["joins"]), "every set has a join that is no flash")
        flashy = {j["xfade"] for s in D["sets"] for j in s["joins"] if j.get("flash")}
        self.assertEqual(flashy, {"fadewhite", "fadeblack"})
        self.assertGreaterEqual(D["minFlashGapSec"], 1.0 / 3)


class PlanTests(unittest.TestCase):
    def test_deterministic_and_varied(self):
        ps = many(12)
        a, b = rt.plan_set(ps, "punchy", 7), rt.plan_set(ps, "punchy", 7)
        self.assertEqual(a, b)
        self.assertEqual(len(a["joins"]), 11)
        self.assertGreater(len(set(a["joins"])), 2)
        self.assertNotEqual(a["joins"], rt.plan_set(ps, "punchy", 8)["joins"])
        self.assertIsNone(rt.plan_set(ps[:1], "punchy", 7))
        self.assertIsNone(rt.plan_set(ps, "retro", 7))

    def test_no_kind_twice_in_a_row(self):
        for seed in range(30):
            j = rt.plan_set(many(15), "cinematic", seed)["joins"]
            self.assertTrue(all(x != y for x, y in zip(j, j[1:])), j)

    def test_flash_joins_are_spaced(self):
        stress = dict(D, setsById=dict(D["setsById"], allflash=dict(D["setsById"]["punchy"], id="allflash",
                                                                     joins=[{"xfade": "fadewhite", "weight": 1, "flash": True}])))
        for seed in range(20):
            for sid, d in (("punchy", D), ("cinematic", D), ("allflash", stress)):
                tr = rt.plan_set(many(20, 0.6, 0.5), sid, seed, d)
                self.assertTrue(rt.flash_rate_ok(many(20, 0.6, 0.5), tr, d), (sid, seed))
        tr = rt.plan_set(many(20, 0.6, 0.5), "allflash", 1, stress)
        self.assertIn("fade", tr["joins"], "too close: a plain fade instead of another flash")

    def test_beat_sync(self):
        ps = [piece(0, 3), piece(10, 13), piece(20, 23)]
        xd = 0.2
        joins = rt.join_times(ps, xd)
        centres = [(a + b) / 2 for a, b in joins]
        beats = [centres[0] - 0.1, centres[1] + 0.05, centres[1] - 0.4]
        out, shifts = rt.beat_sync(ps, xd, beats)
        self.assertEqual(shifts[0], 0.1)
        self.assertEqual(shifts[1], 0.0, "no beat within 0.25 s before the join: unchanged (never later)")
        self.assertEqual(out[0]["end"], 2.9)
        self.assertEqual([p["start"] for p in out], [0.0, 10.0, 20.0], "only tails are trimmed")
        short = [piece(0, 1.05), piece(5, 8)]
        c = sum((a + b) / 2 for a, b in rt.join_times(short, 0.2))
        self.assertEqual(rt.beat_sync(short, 0.2, [c - 0.2])[1], [0.0], "a piece never gets shorter than 1 s")


def allflash():
    return dict(D, setsById=dict(D["setsById"], allflash=dict(D["setsById"]["punchy"], id="allflash",
                                                              joins=[{"xfade": "fadewhite", "weight": 1, "flash": True},
                                                                     {"xfade": "slideleft", "weight": 0.01}])))


def trimmed_for_flashes():
    """A plan whose flash joins are exactly minFlashGapSec apart, then piece tails trimmed by 0.25 s each (what beat
    sync may do after the plan): two flash joins come closer than the gap."""
    d = allflash()
    ps = many(8, 0.73, 1.0)  # joins 0.51 s apart: every other join flashes, 1.02 s apart
    tr = rt.plan_set(ps, "allflash", 3, d)
    trim = [dict(p, end=round(p["end"] - (0.25 if i % 4 == 2 else 0.0), 3)) for i, p in enumerate(ps)]
    return d, ps, tr, trim


class RespaceTests(unittest.TestCase):
    def test_flash_spacing_checked_again_after_trims(self):
        d, ps, tr, trim = trimmed_for_flashes()
        self.assertTrue(rt.flash_rate_ok(ps, tr, d))
        self.assertFalse(rt.flash_rate_ok(trim, tr, d), "the trims bring two flash joins too close")
        tr2 = rt.respace(trim, tr, d)
        self.assertTrue(rt.flash_rate_ok(trim, tr2, d))
        self.assertTrue(tr2.get("respaced"))
        self.assertEqual(len(tr2["joins"]), len(tr["joins"]))
        self.assertIs(rt.respace(ps, tr, d), tr, "a plan that is fine stays as it is")

    def test_clipper_timeline_respaces_after_beat_sync(self):
        import clipper  # noqa: PLC0415
        d, ps, tr, trim = trimmed_for_flashes()
        real = (rt.load_defaults, clipper._look_music_plan)
        rt_ld = rt.load_defaults
        try:
            rt.load_defaults = lambda *a, **k: d
            clipper._look_music_plan = lambda ex, pk, pieces, xd, t, reel, typ, ass, *s: (trim, {"track": {"id": "t"}})
            m, tr_out, xd, _ = clipper._reel_timeline({"look": None}, {"transitions": "allflash", "seed": 3, "music": "full-bed"},
                                                      {"pieces": ps, "seconds": 1}, "montage", None, True, "M1")
        finally:
            rt.load_defaults, clipper._look_music_plan = rt_ld, real[1]
        self.assertEqual(m["pieces"], trim)
        self.assertTrue(rt.flash_rate_ok(trim, tr_out, d))


class ArgvTests(unittest.TestCase):
    def graph(self, **kw):
        a = mont.render_argv("ffmpeg", "s.mp4", many(4), FRAME, [], [], 80, "o.mp4", **kw)
        return a, a[a.index("-filter_complex") + 1]

    def test_per_join_kinds(self):
        tr = rt.plan_set(many(4), "punchy", 3)
        _, g = self.graph(transition=tr)
        for k in tr["joins"]:
            self.assertIn(f"xfade=transition={k}:", g)

    def test_sfx_and_music_mix_in_one_run(self):
        duck = {"threshold": 0.05, "ratio": 8, "attackMs": 20, "releaseMs": 300}
        a, g = self.graph(music={"file": "music.wav", "duck": duck, "sfx": "sfx.wav"})
        self.assertIn("[mgame][mduck][msfx]amix=inputs=3", g)
        self.assertEqual(a.count("-i"), 6)
        _, g = self.graph(music={"sfx": "sfx.wav"})
        self.assertIn("[amus0][msfx]amix=inputs=2", g)
        self.assertNotIn("sidechaincompress", g)
        self.assertEqual(g.count("alimiter="), 1, "one final limiter in the one audio encode")


@unittest.skipUnless(np is not None, "numpy not installed (use the project venv)")
class SfxTests(unittest.TestCase):
    def test_length_and_peak(self):
        import reel_sfx as sfx  # noqa: PLC0415
        d = tempfile.mkdtemp(prefix="fx3-")
        try:
            for sid in ("punchy", "cinematic", "clean"):
                ps = many(4)
                tr = rt.plan_set(ps, sid, 1)
                xd = mont.crossfade_sec(ps, tr)
                f = sfx.prepare(d, tr, ps, xd, 1)
                with wave.open(os.path.join(d, f)) as w:
                    n, sr = w.getnframes(), w.getframerate()
                    x = np.frombuffer(w.readframes(n), "<i2").astype(float) / 32767
                self.assertAlmostEqual(n / sr, sum(p["end"] - p["start"] for p in ps) - 3 * xd, delta=0.01)
                peak_db = 20 * np.log10(np.max(np.abs(x)))
                self.assertAlmostEqual(peak_db, tr["sfxDb"], delta=0.3, msg=sid)
                sfx.cleanup(d)
            self.assertEqual(os.listdir(d), [])
        finally:
            shutil.rmtree(d, ignore_errors=True)


@unittest.skipUnless(HAVE_FFMPEG and np is not None, "ffmpeg or numpy missing")
class RenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="fx3-")
        cls.src = os.path.join(cls.tmp, "src.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x808080:s=180x320:r=30:d=24",
                         "-f", "lavfi", "-i", "sine=f=330:d=24", "-c:v", "libopenh264", "-c:a", "aac", "-shortest", cls.src],
                        timeout=300)
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def render(self, out, ps, tr, music=None):
        argv = mont.render_argv("ffmpeg", self.src, ps, FRAME, ["-c:v", "libopenh264", "-b:v", "1500k"], ["-c:a", "aac"],
                                80, out, transition=tr, music=music)
        r = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)

    def frames(self, out):
        raw = os.path.join(self.tmp, "f.rgb")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", out, "-vf", "scale=60:108", "-pix_fmt", "rgb24",
                         "-f", "rawvideo", raw], cwd=self.tmp, timeout=120)
        self.assertEqual(r.returncode, 0, r.stderr)
        return np.fromfile(raw, np.uint8).reshape(-1, 108, 60, 3)

    def test_flash_rate_measured_per_set(self):
        stress = dict(D, setsById=dict(D["setsById"], allflash=dict(D["setsById"]["punchy"], id="allflash",
                                                                     joins=[{"xfade": "fadewhite", "weight": 1, "flash": True}])))
        ps = many(14, 0.7, 0.9)  # a join about every 0.5 s: far denser than any real reel
        for sid, d in (("punchy", D), ("cinematic", D), ("clean", D), ("allflash", stress)):
            tr = rt.plan_set(ps, sid, 5, d)
            self.render(f"{sid}.mp4", ps, tr)
            f = self.frames(f"{sid}.mp4")
            rate = flashes_per_second(f, 60.0)
            print(f"fx3 flash {sid}: {rate:.1f} flashes/s worst 1 s window, {len(f)} frames, joins {tr['joins']}")
            self.assertLessEqual(rate, 3.0, sid)
        # the measurement itself sees flashes: every join a fade through white, unplanned
        dense = many(20, 0.45, 0.5)  # a join every ~0.23 s
        raw = dict(rt.plan_set(dense, "allflash", 5, stress), joins=["fadewhite"] * 19)
        self.render("raw.mp4", dense, raw)
        self.assertGreater(flashes_per_second(self.frames("raw.mp4"), 60.0), 3.0, "the check catches a reel over the limit")

    def test_rendered_flashes_after_beat_sync_trims(self):
        d, _ps, tr, trim = trimmed_for_flashes()
        tr2 = rt.respace(trim, tr, d)
        self.render("respaced.mp4", trim, tr2)
        rate = flashes_per_second(self.frames("respaced.mp4"), 60.0)
        print(f"fx3 flash after beat-sync trims, respaced: {rate:.1f} flashes/s")
        self.assertLessEqual(rate, 1.5)

    def test_coincident_peaks_stay_under_minus_1_dbtp(self):
        import re  # noqa: PLC0415
        loud = os.path.join(self.tmp, "loud.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x808080:s=180x320:r=30:d=8",
                         "-f", "lavfi", "-i", "aevalsrc=exprs=0.99*sin(2*PI*220*t)|0.99*sin(2*PI*220*t):s=48000:d=8",
                         "-c:v", "libopenh264", "-c:a", "aac", "-b:a", "256k", "-shortest", loud], timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        n = 48000 * 7
        t = np.arange(n) / 48000
        burst = np.floor(t * 4) % 2 == 0  # noise hits every 0.5 s on two tones, clipped at full scale, all in phase
        full = np.clip(0.6 * np.sin(2 * np.pi * 220 * t) + 0.6 * np.sin(2 * np.pi * 331 * t)
                       + burst * np.random.default_rng(1).normal(0, 0.4, n), -0.99, 0.99)
        pcm = (np.repeat(full[:, None], 2, axis=1) * 32767).astype("<i2")
        for name in ("bed.wav", "hit.wav"):
            with wave.open(os.path.join(self.tmp, name), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(48000)
                w.writeframes(pcm.tobytes())
        ps = [piece(0, 3.5), piece(4, 7.5)]
        tr = rt.plan_set(ps, "clean", 1)
        duck = {"threshold": 0.9, "ratio": 1, "attackMs": 20, "releaseMs": 300}  # no ducking: every source at full scale
        argv = mont.render_argv("ffmpeg", loud, ps, FRAME, ["-c:v", "libopenh264", "-b:v", "800k"], ["-c:a", "aac", "-b:a", "256k"],
                                80, "peaks.mp4", transition=tr, music={"file": "bed.wav", "duck": duck, "sfx": "hit.wav"})
        r = cc.run_tool(argv, cwd=self.tmp, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = cc.run_tool(["ffmpeg", "-nostats", "-hide_banner", "-nostdin", "-i", "peaks.mp4", "-af", "ebur128=peak=true",
                         "-f", "null", "-"], cwd=self.tmp, timeout=120)
        tp = float(re.findall(r"Peak:\s+(-?[\d.]+|-inf) dBFS", r.stderr)[-1])
        print(f"fx3 coincident peaks: true peak {tp:.2f} dBTP")
        self.assertLessEqual(tp, -1.0)

    def test_audio_encoded_once(self):
        import reel_sfx as sfx  # noqa: PLC0415
        ps = many(4, 1.5, 1.0)
        tr = rt.plan_set(ps, "punchy", 2)
        xd = mont.crossfade_sec(ps, tr)
        f = sfx.prepare(self.tmp, tr, ps, xd, 2)
        self.render("mixed.mp4", ps, tr, music={"sfx": f})
        info = cc.probe("ffprobe", os.path.join(self.tmp, "mixed.mp4"))
        kinds = [s["codec_type"] for s in info["streams"]]
        self.assertEqual(kinds.count("audio"), 1, kinds)
        self.assertEqual(kinds.count("video"), 1, kinds)


if __name__ == "__main__":
    unittest.main()
