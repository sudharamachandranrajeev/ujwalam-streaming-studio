# SPDX-License-Identifier: GPL-3.0-or-later
"""FX6 local AI music (services/clip/music_gen.py, D429): the worker contract with a fake runtime (a stub script that
writes a click-track WAV at the asked tempo), the guards (live, unknown live state, a busy heavy job, low or unknown
GPU memory, no runtime), reuse of a stored track, the record shape, and that posting treats it as made here. The real
ACE-Step run is skipped unless env UJWALAM_ACESTEP_RUNTIME names the runtime folder (off air, GPU)."""

import json
import os
import shutil
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "services", "clip"))

try:
    import av  # noqa: F401
    import numpy  # noqa: F401
    HAVE_NP = True
except ImportError:
    HAVE_NP = False

import clip_common as cc  # noqa: E402
import clip_look as cl  # noqa: E402
import clip_publish as cpub  # noqa: E402
import countdown as cd  # noqa: E402
import music_gen as mg  # noqa: E402

STUB_OK = textwrap.dedent("""
    import json, sys, wave
    import numpy as np
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    sr, sec, beat = 48000, float(job["seconds"]), 60.0 / float(job["bpm"])
    n = int(sec * sr); x = np.zeros(n); t = np.arange(int(0.15 * sr)) / sr
    click = np.sin(2 * np.pi * (60 + 90 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.06)
    k = 0
    while k * beat < sec:
        i = int(k * beat * sr); ln = min(n - i, len(click)); x[i:i + ln] += click[:ln]; k += 1
    x += 0.05 * np.sin(2 * np.pi * 3000 * np.arange(n) / sr)
    pcm = np.clip(np.rint(np.repeat((x / np.max(np.abs(x)) * 0.8)[:, None], 2, axis=1) * 32767), -32768, 32767).astype("<i2")
    with wave.open(job["out"], "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    json.dump({"ok": True, "error": None, "seconds": 0.1, "loadSeconds": 0.0, "torchPeakMB": 0, "out": job["out"]},
              open(job["result"], "w", encoding="utf-8"))
""")
STUB_FAIL = textwrap.dedent("""
    import json, sys
    job = json.load(open(sys.argv[1], encoding="utf-8"))
    open(job["out"], "wb").write(b"half")
    json.dump({"ok": False, "error": "CUDA out of memory"}, open(job["result"], "w", encoding="utf-8"))
    sys.exit(1)
""")
TARGET = {"energy": 0.9, "moods": ["phonk", "edm", "trap"]}


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="fx6-")
        self.lock = os.path.join(self.d, "lock")
        os.makedirs(self.lock)
        self.cfg = mg.load_config()
        self.mlcfg = __import__("music_library").load_config()
        self.ok = self._stub("ok.py", STUB_OK)
        self.fail = self._stub("fail.py", STUB_FAIL)
        self.ran = []

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def _stub(self, name, src):
        p = os.path.join(self.d, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(src)
        return p

    def make(self, **kw):
        args = dict(cfg=self.cfg, live=lambda: False, vram=lambda: 6000, lock_dir=self.lock, python=sys.executable,
                    worker=self.ok, env={}, profile=os.path.join(self.d, "no-profile.json"))
        args.update(kw)
        return mg.make(os.path.join(self.d, "data"), TARGET, 20.0, self.mlcfg, **args)


class RequestTests(unittest.TestCase):
    def test_request_is_seeded_by_the_target(self):
        cfg = mg.load_config()
        a, b = mg.request_for(TARGET, 20.0, cfg), mg.request_for(dict(TARGET), 20.0, cfg)
        self.assertEqual(a, b)
        self.assertEqual((a["mood"], a["bpm"], a["seconds"]), ("phonk", 140, 30))
        self.assertIn("instrumental", a["caption"])
        self.assertTrue(a["id"].startswith("gen-"))
        self.assertEqual(mg.request_for(TARGET, 95.0, cfg)["seconds"], 60, "capped at seconds.max")
        calm = mg.request_for({"energy": 0.3, "moods": ["lo-fi", "chill"]}, 41.0, cfg)
        self.assertEqual((calm["mood"], calm["bpm"], calm["seconds"]), ("lo-fi", 85, 50))
        self.assertNotEqual(calm["id"], a["id"])

    def test_tempo_fix_half_and_double_time(self):
        self.assertEqual(mg.tempo_fix(70.31, 140), 140.62, "the real run: half time measured")
        self.assertEqual(mg.tempo_fix(255.0, 128), 127.5)
        self.assertEqual(mg.tempo_fix(85.18, 85), 85.18)
        self.assertEqual(mg.tempo_fix(100.0, 140), 100.0, "no fit: measured kept")

    def test_runtime_from_env_or_profile_never_a_placeholder(self):
        d = tempfile.mkdtemp(prefix="fx6-rt-")
        try:
            cfg = mg.load_config()
            prof = os.path.join(d, "profile.json")
            self.assertIsNone(mg.runtime_dir({}, prof))
            with open(prof, "w", encoding="utf-8") as f:
                json.dump({"paths": {"acestep_runtime": "<ace-step-1.5-folder-or-remove-for-no-ai-music>"}}, f)
            self.assertIsNone(mg.runtime_dir({}, prof))
            self.assertEqual(mg.runtime_dir({mg.ENV_RUNTIME: d}, prof), os.path.abspath(d))
            self.assertIsNone(mg.runtime_python(cfg, {mg.ENV_RUNTIME: d}, prof), "no Python in the folder")
            py = os.path.join(d, *cfg["python"].split("/"))
            os.makedirs(os.path.dirname(py))
            open(py, "wb").close()
            with open(prof, "w", encoding="utf-8") as f:
                json.dump({"paths": {"acestep_runtime": d}}, f)
            self.assertEqual(mg.runtime_python(cfg, {}, prof), py)
        finally:
            shutil.rmtree(d, ignore_errors=True)


@unittest.skipUnless(HAVE_NP, "needs numpy + PyAV (the project venv)")
class GuardTests(Base):
    def test_no_runtime(self):
        t, why = self.make(python=None)
        self.assertIsNone(t)
        self.assertIn("no AI music runtime", why)

    def test_live_and_unknown_and_broken_live_check(self):
        def boom():
            raise RuntimeError("x")
        for live in (lambda: True, lambda: None, boom):
            t, why = self.make(live=live)
            self.assertIsNone(t)
            self.assertIn("live", why)
        self.assertFalse(os.path.isdir(os.path.join(self.d, "data", "music", "generated")), "nothing written")

    def test_low_or_unknown_gpu_memory(self):
        for v in (lambda: 4000, lambda: None):
            t, why = self.make(vram=v)
            self.assertIsNone(t)
            self.assertIn("free GPU memory", why)

    def test_busy_heavy_job(self):
        with cc.HeavyJobLock(self.lock, job="detector-pass"):
            t, why = self.make()
        self.assertIsNone(t)
        self.assertIn("another heavy clip job", why)

    def test_worker_failure_leaves_nothing(self):
        t, why = self.make(worker=self.fail)
        self.assertIsNone(t)
        self.assertIn("CUDA out of memory", why)
        g = os.path.join(self.d, "data", "music", "generated")
        self.assertEqual([n for n in os.listdir(g)], [], "no part file, job or result left")


@unittest.skipUnless(HAVE_NP, "needs numpy + PyAV (the project venv)")
class MakeTests(Base):
    def test_made_stored_and_reused(self):
        t, why = self.make()
        self.assertEqual(why, "made")
        self.assertTrue(os.path.isfile(t["file"]))
        self.assertAlmostEqual(t["bpm"], 140, delta=3)
        self.assertEqual(t["mood"], "phonk", "the asked mood, not the guess")
        g = t["generated"]
        self.assertEqual((g["generator"], g["licence"]), ("ace-step-1.5", "made on this PC with ACE-Step 1.5, MIT"))
        for k in ("caption", "seed", "bpm", "modelRevision"):
            self.assertIn(k, g)
        again, why2 = self.make(worker=self.fail, python=None, live=lambda: True)  # reuse needs no runtime and no guard
        self.assertEqual(why2, "stored")
        self.assertEqual(again["id"], t["id"])
        self.assertEqual([x["id"] for x in mg.stored(os.path.join(self.d, "data"), self.cfg)], [t["id"]])

    def test_record_posts_as_made_here(self):
        t, _ = self.make()
        rec = mg.record(t)
        self.assertEqual((rec["source"], rec["generator"], rec["track"]), ("made-here", "ace-step-1.5", t["id"]))
        self.assertNotIn("credit", rec)
        full = dict({"mode": "full-bed", "segments": [], "levelDb": -16}, **rec)
        prov = cpub.music_provenance({"music": full}, records=True)
        self.assertEqual(prov, {"source": "generated"})
        self.assertEqual(cd.combined_music([{"music": prov, "musicRaw": full}]), {"source": "made-here"})

    def test_recaption_renders_the_stored_track_again(self):
        import clipper  # noqa: PLC0415
        import music_library as mlib  # noqa: PLC0415
        data = os.path.join(self.d, "data")
        t, _ = self.make()
        ps = [{"start": 0.0, "end": 6.0}, {"start": 9.0, "end": 15.0}]
        rec = dict({k: v for k, v in mlib.plan(t, "full-bed", ps, 0.22, 3.0, None, -16, self.mlcfg).items() if k != "beats"},
                   **mg.record(t))
        wd = os.path.join(self.d, "wd")
        os.makedirs(wd)
        mus, new = clipper._recaption_music(data, wd, {"music": rec}, ps, 0.22, "r1")
        self.assertTrue(os.path.isfile(os.path.join(wd, mus["file"])))
        self.assertIsNone(new, "the same record")
        os.remove(t["file"])
        _, new = clipper._recaption_music(data, wd, {"music": rec}, ps, 0.22, "r1")
        self.assertEqual((new["source"], new["fallback"]), ("made-here", "the generated track is gone"))
        self.assertNotIn("generator", new)

    def test_clipper_plan_uses_the_made_track_when_nothing_fits(self):
        import clipper  # noqa: PLC0415
        real = mg.make
        calls = []

        def fake(data_dir, target, need, mlcfg, **kw):
            calls.append(target)
            return real(data_dir, target, need, mlcfg, cfg=self.cfg, live=lambda: False, vram=lambda: 6000,
                        lock_dir=self.lock, python=sys.executable, worker=self.ok, env={},
                        profile=os.path.join(self.d, "no-profile.json"))
        lcfg = cl.load_config()
        look_now = cl.effective(None, lcfg)
        ex = {"look": {"cfg": lcfg, "look": look_now, "tracks": [], "mlcfg": self.mlcfg, "dataDir": os.path.join(self.d, "data"),
                       "history": {}, "ai": True}}
        pieces = [{"start": 10.0, "end": 22.0, "kills": 3}]
        mg.make = fake
        try:
            _, plan = clipper._look_music_plan(ex, {"music": "full-bed", "name": None}, pieces, 0.0, None,
                                               {"kills": 3, "pieces": pieces}, "montage", None, "r1", "v.mp4")
        finally:
            mg.make = real
        self.assertEqual(len(calls), 1)
        self.assertEqual((plan["record"]["source"], plan["record"]["generator"]), ("made-here", "ace-step-1.5"))
        ex["look"]["ai"] = False
        _, none = clipper._look_music_plan(ex, {"music": "full-bed", "name": None}, pieces, 0.0, None,
                                           {"kills": 3, "pieces": pieces}, "montage", None, "r1", "v.mp4")
        self.assertIsNone(none, "AI off and no track: the made-here bed (caller's fallback)")


class LookTests(unittest.TestCase):
    def test_ai_ticked_by_default_and_added_once(self):
        cfg = cl.load_config()
        self.assertIn("ai", cfg["defaults"]["music"]["sources"])
        self.assertEqual(cl.migrate_ai({"music": {"sources": ["folder"]}}, cfg)["music"],
                         {"sources": ["folder", "ai"], "aiOffered": True})
        kept = {"music": {"sources": ["folder"], "aiOffered": True}}
        self.assertEqual(cl.migrate_ai(kept, cfg), kept, "a later untick stays off")
        self.assertEqual(cl.look_problems({"music": {"aiOffered": "y"}}, cfg), ["clips.look.music.aiOffered must be true or false"])


@unittest.skipUnless(os.environ.get(mg.ENV_RUNTIME), "real ACE-Step run: set UJWALAM_ACESTEP_RUNTIME (off air, GPU)")
class RealRuntimeTests(unittest.TestCase):
    def test_one_real_track(self):
        import time  # noqa: PLC0415
        import music_library as mlib  # noqa: PLC0415
        d = tempfile.mkdtemp(prefix="fx6-real-")
        try:
            t0 = time.time()
            t, why = mg.make(d, TARGET, 20.0, mlib.load_config(), lock_dir=d)
            print(json.dumps({"why": why, "wall": round(time.time() - t0, 1), "free": mg.free_vram_mb(),
                              "generated": (t or {}).get("generated"), "bpm": (t or {}).get("bpm"),
                              "duration": (t or {}).get("duration")}), file=sys.stderr)
            self.assertEqual(why, "made")
            self.assertAlmostEqual(t["bpm"], 140, delta=3)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
