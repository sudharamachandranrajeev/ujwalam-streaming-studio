# SPDX-License-Identifier: GPL-3.0-or-later
"""FX4 music library (services/clip/music_library.py, D411): analysis of synthetic tracks (tempo, drop, mood guess),
matching by the reel's energy and mood (seeded, no repeat of the last tracks), the three modes, the bed level measured
again by ffmpeg's EBU R128 scanner (-16 LUFS default), the library refresh (new files only, broken and short files
kept out, nothing while live), the clipper wiring, and one render with the bed and the game sound (one audio stream:
audio encoded once). Synthetic tones only, a few seconds each; needs numpy + PyAV (the project venv)."""

import os
import re
import shutil
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:
    import av  # noqa: F401
    import numpy as np
except ImportError:
    np = None

import clip_common as cc  # noqa: E402

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
SR = 48000


def write_wav(path, x):
    pcm = np.clip(np.rint(np.repeat(x[:, None], 2, axis=1) * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def hype_track(sec=24.0, bpm=128.0, drop=12.0):
    """Kick + bright noise hats on every beat; quiet before `drop`, loud after it."""
    n = int(sec * SR)
    t = np.arange(n) / SR
    x = np.zeros(n)
    beat = 60.0 / bpm
    rng = np.random.default_rng(1)
    k = 0
    while k * beat < sec:
        i = int(k * beat * SR)
        ln = min(n - i, int(0.2 * SR))
        tt = np.arange(ln) / SR
        x[i:i + ln] += np.sin(2 * np.pi * (50 + 80 * np.exp(-tt / 0.03)) * tt) * np.exp(-tt / 0.08)
        h = min(n - i, int(0.03 * SR))
        x[i:i + h] += 0.5 * rng.uniform(-1, 1, h) * np.exp(-np.arange(h) / (0.005 * SR))
        k += 1
    x += 0.15 * np.sin(2 * np.pi * 3520 * t)  # brightness
    x *= np.where(t < drop, 0.15, 0.9)
    return x / np.max(np.abs(x)) * 0.9


def calm_track(sec=24.0):
    """A soft, slow pad: two sines with a gentle 80 BPM swell."""
    t = np.arange(int(sec * SR)) / SR
    swell = 0.6 + 0.4 * np.sin(np.pi * (80.0 / 60.0) * t) ** 2
    return 0.3 * swell * (np.sin(2 * np.pi * 220 * t) + 0.5 * np.sin(2 * np.pi * 330 * t))


def ebur128_i(path):
    r = cc.run_tool(["ffmpeg", "-nostats", "-hide_banner", "-nostdin", "-i", path, "-af", "ebur128", "-f", "null", "-"],
                    timeout=120)
    vals = re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)
    return float(vals[-1])


@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class LibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import music_library as ml  # noqa: PLC0415
        cls.ml = ml
        cls.cfg = ml.load_config()
        cls.tmp = tempfile.mkdtemp(prefix="fx4-")
        cls.folder = os.path.join(cls.tmp, "music")
        os.makedirs(os.path.join(cls.folder, "sub"))
        write_wav(os.path.join(cls.folder, "hype.wav"), hype_track())
        write_wav(os.path.join(cls.folder, "sub", "calm.wav"), calm_track())
        write_wav(os.path.join(cls.folder, "short.wav"), calm_track(3.0))
        with open(os.path.join(cls.folder, "broken.mp3"), "wb") as f:
            f.write(b"not audio at all" * 50)
        with open(os.path.join(cls.folder, "notes.txt"), "w", encoding="utf-8") as f:
            f.write("x")
        cls.data = os.path.join(cls.tmp, "data")
        cls.lib = ml.refresh(cls.data, cls.folder, cls.cfg, live=lambda: False)
        cls.by = {t["name"]: dict(t, root=cls.folder) for t in cls.lib["tracks"]}  # root as usable() gives it

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_refresh(self):
        self.assertEqual(sorted(self.by), ["broken", "calm", "hype", "short"], "txt files are not tracks")
        self.assertIn("error", self.by["broken"])
        self.assertIn("error", self.by["short"])
        self.assertEqual(sorted(t["name"] for t in self.ml.usable(self.lib)), ["calm", "hype"])
        self.assertTrue(os.path.isfile(os.path.join(self.data, "music", "library.json")))

    def test_refresh_keeps_analysed_tracks_and_user_moods(self):
        lib = self.ml.load_library(self.data, self.cfg)
        for t in lib["tracks"]:
            if t["name"] == "calm":
                t["moodUser"] = "cinematic"
        cc.write_json_atomic(os.path.join(self.data, "music", "library.json"), lib)
        calls = []
        real = self.ml.analyse
        self.ml.analyse = lambda p, *a: calls.append(p) or real(p, *a)
        try:
            again = self.ml.refresh(self.data, self.folder, self.cfg, live=lambda: False)
        finally:
            self.ml.analyse = real
        self.assertEqual(calls, [], "no file is analysed twice")
        self.assertEqual(next(t for t in again["tracks"] if t["name"] == "calm")["moodUser"], "cinematic")

    def test_nothing_while_live(self):
        d = os.path.join(self.tmp, "live-data")
        lib = self.ml.refresh(d, self.folder, self.cfg, live=lambda: True)
        self.assertEqual(lib["tracks"], [])
        def unknown():
            raise OSError("cannot tell")
        self.assertEqual(self.ml.refresh(d, self.folder, self.cfg, live=unknown)["tracks"], [], "unknown counts as live")
        self.assertFalse(os.path.exists(os.path.join(d, "music", "library.json")))

    def test_tempo_drop_and_mood_on_synthetic_tones(self):
        h, c = self.by["hype"], self.by["calm"]
        self.assertAlmostEqual(h["bpm"], 128.0, delta=2.0)
        self.assertAlmostEqual(h["drop"], 12.0, delta=60.0 / 128 * 2)
        self.assertIn(h["mood"], ("edm", "phonk"))
        self.assertIn(c["mood"], ("lo-fi", "chill"))
        self.assertGreater(h["energyLevel"], c["energyLevel"])
        self.assertAlmostEqual(h["duration"], 24.0, delta=0.05)

    def test_match_by_energy_and_mood(self):
        tracks = self.ml.usable(self.lib)
        for t in tracks:
            t.pop("moodUser", None)
        hype = self.ml.target_for({"kills": 6, "streaks": 2, "medals": [{"t": 1, "w": 1}], "labels": ["x"]}, "montage", self.cfg)
        calm = self.ml.target_for({"kills": 0, "pieces": [{"kills": 0}]}, "impact-play", self.cfg)
        self.assertEqual(self.ml.match(tracks, hype, 20, ["M1"], (), self.cfg)[0]["name"], "hype")
        self.assertEqual(self.ml.match(tracks, calm, 20, ["M1"], (), self.cfg)[0]["name"], "calm")
        a = self.ml.match(tracks, hype, 20, ["M7", "r"], (), self.cfg)
        self.assertEqual(a, self.ml.match(tracks, hype, 20, ["M7", "r"], (), self.cfg), "seeded")

    def test_no_repeat_of_the_last_tracks(self):
        tracks = [dict(t, id=f"{t['id']}-{k}") for t in self.ml.usable(self.lib) for k in range(3)]
        target = {"energy": 0.6, "moods": ["edm", "lo-fi", "chill"]}
        recent = []
        for i in range(25):
            t, _ = self.ml.match(tracks, target, 10, [f"M{i}"], recent, self.cfg, n_avoid=3)
            self.assertNotIn(t["id"], recent[-3:], i)
            recent.append(t["id"])

    def test_no_fit_gives_none(self):
        strict = dict(self.cfg, score=dict(self.cfg["score"], threshold=2.0))
        t, best = self.ml.match(self.ml.usable(self.lib), {"energy": 0.5, "moods": ["edm"]}, 10, ["x"], (), strict)
        self.assertIsNone(t)
        self.assertGreater(best, 0)

    def test_modes(self):
        h = self.by["hype"]
        ps = [{"start": 0.0, "end": 6.0, "kills": 1}, {"start": 10.0, "end": 16.0, "kills": 2}]
        io = self.ml.plan(h, "intro-outro", ps, 0.0, 8.0, 2.4, -16, self.cfg)
        self.assertEqual(len(io["segments"]), 2)
        self.assertEqual(io["segments"][1]["at"] + io["segments"][1]["len"], 12.0)
        dr = self.ml.plan(h, "drop", ps, 0.0, 8.0, None, -16, self.cfg)
        s = dr["segments"][0]
        self.assertAlmostEqual(s["at"] + (h["drop"] - s["from"]), 8.0, places=2, msg="the drop lands on the strongest kill")
        fb = self.ml.plan(h, "full-bed", ps, 0.0, 8.0, None, -16, self.cfg)
        self.assertEqual(fb["segments"][0]["at"], 0.0)
        self.assertTrue(all(0 <= b <= 12.0 for b in fb["beats"]))
        reel = {"medals": [{"t": 13.0, "w": 2.0}, {"t": 2.0, "w": 1.0}], "peaks": [1.0]}
        self.assertEqual(self.ml.strongest_reel_time(reel, ps, 0.0), 9.0)

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg missing")
    def test_bed_level_measured_by_ffmpeg(self):
        ps = [{"start": 0.0, "end": 10.0, "kills": 1}]
        for name, mode, level in (("hype", "full-bed", -16), ("calm", "drop", -16), ("hype", "intro-outro", -16),
                                  ("calm", "full-bed", -22)):
            rec = self.ml.plan(self.by[name], mode, ps, 0.0, 5.0, None, level, self.cfg)
            p = os.path.join(self.tmp, f"bed-{name}-{mode}.wav")
            self.ml.write_wav(p, self.ml.render(rec, self.by[name], self.cfg))
            i = ebur128_i(p)
            print(f"fx4 bed {name} {mode}: {i:.1f} LUFS (target {level})")
            self.assertAlmostEqual(i, level, delta=1.0, msg=(name, mode))
            with wave.open(p) as w:
                self.assertAlmostEqual(w.getnframes() / w.getframerate(), 10.0, delta=0.01)

    @unittest.skipUnless(HAVE_FFMPEG, "ffmpeg missing")
    def test_render_with_bed_and_effects_has_one_audio_stream(self):
        import clip_montage as mont  # noqa: PLC0415
        import reel_transition as rt  # noqa: PLC0415
        import reel_sfx as sfx  # noqa: PLC0415
        src = os.path.join(self.tmp, "game.mp4")
        r = cc.run_tool(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "color=c=0x404040:s=180x320:r=30:d=12",
                         "-f", "lavfi", "-i", "sine=f=500:d=12", "-c:v", "libopenh264", "-c:a", "aac", "-shortest", src], timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        ps = [{"start": 0.0, "end": 4.0, "kills": 1}, {"start": 6.0, "end": 10.0, "kills": 1}]
        tr = rt.plan_set(ps, "cinematic", 1)
        xd = mont.crossfade_sec(ps, tr)
        rec = self.ml.plan(self.by["hype"], "full-bed", ps, xd, 3.0, None, -16, self.cfg)
        wd = self.tmp
        music = self.ml.prepare(wd, rec, self.by["hype"], self.cfg, {"threshold": 0.05, "ratio": 6, "attackMs": 20, "releaseMs": 400})
        music["sfx"] = sfx.prepare(wd, tr, ps, xd, 1)
        argv = mont.render_argv("ffmpeg", src, ps, {"width": 180, "height": 320}, ["-c:v", "libopenh264"],
                                ["-c:a", "aac", "-b:a", "128k"], 80, "out.mp4", transition=tr, music=music)
        r = cc.run_tool(argv, cwd=wd, timeout=600)
        self.assertEqual(r.returncode, 0, r.stderr)
        info = cc.probe("ffprobe", os.path.join(wd, "out.mp4"))
        kinds = [s["codec_type"] for s in info["streams"]]
        self.assertEqual((kinds.count("video"), kinds.count("audio")), (1, 1), kinds)
        self.assertEqual(argv.count("-c:a"), 1, "one audio encoder in the one run")


@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class SafetyTests(unittest.TestCase):
    """Codex review of D411: links, short tracks, memory and the cache key."""

    def setUp(self):
        import music_library as ml  # noqa: PLC0415
        self.ml, self.cfg = ml, ml.load_config()
        self.tmp = tempfile.mkdtemp(prefix="fx4s-")
        self.folder = os.path.join(self.tmp, "music")
        os.makedirs(self.folder)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_links_and_junctions_are_not_followed(self):
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside)
        write_wav(os.path.join(outside, "secret.wav"), calm_track(12.0))
        write_wav(os.path.join(self.folder, "own.wav"), calm_track(12.0))
        made = []
        try:
            import _winapi  # noqa: PLC0415 - a junction needs no admin rights
            _winapi.CreateJunction(outside, os.path.join(self.folder, "jn"))
            made.append("junction")
        except (ImportError, OSError):
            pass
        try:
            os.symlink(os.path.join(outside, "secret.wav"), os.path.join(self.folder, "link.wav"))
            made.append("symlink")
        except (OSError, NotImplementedError):
            pass
        if not made:
            self.skipTest("this account can make neither a junction nor a symlink")
        files = self.ml.list_files(self.folder, self.cfg)
        self.assertEqual([os.path.basename(f) for f in files], ["own.wav"], made)
        lib = self.ml.refresh(os.path.join(self.tmp, "data"), self.folder, self.cfg, live=lambda: False)
        self.assertEqual([t["name"] for t in lib["tracks"]], ["own"])
        if "junction" in made:
            via = os.path.join(self.folder, "jn", "secret.wav")
            self.assertFalse(self.ml.inside(via, self.folder))
            with self.assertRaises(cc.ClipError):
                self.ml.analyse(via, self.cfg, self.folder)
        # a library row pointing outside (edited file, or the folder swapped) is never opened
        row = dict(lib["tracks"][0], file=os.path.join(outside, "secret.wav"))
        self.assertEqual(self.ml.usable(dict(lib, tracks=[row])), [])
        rec = self.ml.plan(row, "full-bed", [{"start": 0.0, "end": 4.0}], 0.0, 1.0, None, -16, self.cfg)
        with self.assertRaises(cc.ClipError):
            self.ml.render(rec, dict(row, root=self.folder), self.cfg)

    def test_short_track_loops_without_silence(self):
        p = os.path.join(self.folder, "short.wav")
        write_wav(p, calm_track(12.0))
        lib = self.ml.refresh(os.path.join(self.tmp, "data"), self.folder, self.cfg, live=lambda: False)
        tr = self.ml.usable(lib)[0]
        ps = [{"start": 0.0, "end": 20.0}, {"start": 30.0, "end": 50.0}]  # 40 s reel, 12 s track
        for mode in ("full-bed", "drop"):
            rec = self.ml.plan(tr, mode, ps, 0.0, 30.0, None, -16, self.cfg)
            self.assertIn("loop", rec, mode)
            x = self.ml.render(rec, tr, self.cfg)
            self.assertEqual(len(x), 40 * SR)
            s0 = int(rec["segments"][0]["at"] * SR) + SR
            win = x[s0: len(x) - SR, 0][: (len(x) - SR - s0) // (SR // 4) * (SR // 4)].reshape(-1, SR // 4)
            rms = np.sqrt((win ** 2).mean(axis=1))
            self.assertGreater(rms.min(), 0.25 * np.median(rms), f"{mode}: no gap or dip at a loop seam")
        # Codex verify: a drop late in the short track starts past the loop end; the bed is still full length, no gap
        late = dict(tr, drop=11.9)
        rec = self.ml.plan(late, "drop", ps, 0.0, 0.1, None, -16, self.cfg)
        self.assertGreater(rec["segments"][0]["from"], rec["loop"]["b"], "the case under test")
        x = self.ml.render(rec, late, self.cfg)
        self.assertEqual(len(x), 40 * SR)
        win = x[SR: 39 * SR, 0].reshape(-1, SR // 4)
        rms = np.sqrt((win ** 2).mean(axis=1))
        self.assertGreater(rms.min(), 0.25 * np.median(rms), "late drop: no gap anywhere")
        long_t = dict(tr, id="long", duration=120.0)
        got, _ = self.ml.match([tr, long_t], {"energy": tr["energyLevel"], "moods": [tr["mood"]]}, 40, ["x"], (), self.cfg,
                               prefer_long=True)
        self.assertEqual(got["id"], "long", "a track as long as the reel wins")

    def test_analysis_of_a_240_s_track_stays_in_bounded_memory(self):
        import tracemalloc  # noqa: PLC0415
        p = os.path.join(self.folder, "long.wav")
        write_wav(p, hype_track(240.0, 120.0, 60.0))
        tracemalloc.start()
        try:
            facts = self.ml.analyse(p, dict(self.cfg, maxAnalyseSec=600), self.folder)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        print(f"fx4 analyse 240 s: peak {peak / 1e6:.0f} MB, {facts['bpm']} BPM")
        self.assertAlmostEqual(facts["bpm"], 120.0, delta=2.0)
        self.assertLess(peak, 150e6, "the 240 s mono decode is 46 MB; the analysis adds bounded batches only")

    def test_cache_key_sees_a_same_second_change(self):
        p = os.path.join(self.folder, "a.wav")
        write_wav(p, calm_track(6.0))
        st = os.stat(p)
        a = self.ml._track_id(p, st)
        with open(p, "r+b") as f:  # same size, same time to the second: only the content changes
            f.seek(st.st_size - 100)
            f.write(b"\x01" * 100)
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
        self.assertNotEqual(self.ml._track_id(p, os.stat(p)), a)
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1000))



@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class WiringTests(unittest.TestCase):
    def test_clipper_music_plan_and_fallback(self):
        import clipper  # noqa: PLC0415
        import clip_look as cl  # noqa: PLC0415
        import music_library as ml  # noqa: PLC0415
        lcfg, mcfg = cl.load_config(), ml.load_config()
        track = {"id": "t1", "name": "x", "file": "x.wav", "duration": 60.0, "bpm": 120.0, "beatOffset": 0.0, "drop": 20.0,
                 "energyLevel": 0.8, "mood": "edm"}
        look_now = cl.merge(lcfg, {})
        ex = {"look": {"cfg": lcfg, "look": look_now, "tracks": [track], "mlcfg": mcfg, "history": {}},
              "music": None}
        ps = [{"start": 0.0, "end": 5.0, "kills": 1}, {"start": 9.0, "end": 14.0, "kills": 1}]
        reel = {"kills": 4, "streaks": 1, "pieces": ps}
        tr = {"kind": "punchy", "xfade": "fade", "ms": 220, "joins": ["fade"]}
        pk = {"music": "full-bed", "transitions": "punchy", "name": None}
        ps2, mp = clipper._look_music_plan(ex, pk, ps, 0.22, tr, reel, "montage", None, "M1", "r.mp4")
        self.assertEqual(mp["record"]["source"], "folder")
        self.assertEqual(mp["track"]["id"], "t1")
        self.assertLessEqual(max(mp["record"]["beatShifts"] or [0]), 0.25)
        self.assertEqual(ps2[1], ps[1], "only the tail before a join can move")
        _, none = clipper._look_music_plan(ex, dict(pk, music=None), ps, 0.22, tr, reel, "montage", None, "M1")
        self.assertIsNone(none)
        self.assertEqual(clipper._music("wd", ps, 0.0, None, ex, "M1", pk=dict(pk, music=None)), (None, None))
        _, kept = clipper._look_music_plan(ex, pk, ps, 0.22, tr, reel, "montage", None, "M1", "r.mp4")
        self.assertEqual(kept["record"]["beatShifts"], mp["record"]["beatShifts"],
                         "captions are made on the final timeline, so beat sync stays on (Codex review)")


if __name__ == "__main__":
    unittest.main()
