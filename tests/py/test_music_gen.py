# SPDX-License-Identifier: GPL-3.0-or-later
"""FX6 local AI music (services/clip/music_gen.py + ace_worker.py, D429): the worker contract (stub workers, and the
real ace_worker.py with fake torch + acestep packages in a fake runtime folder), the guards (live, unknown live
state, live flipping right before the start, a busy heavy job, low or unknown GPU memory, no runtime), cleanup after
failure, timeout and a killed worker, reuse of a stored track (also without the runtime, through the clipper plan),
stored JSON that cannot change the posting source, the record shape, posting as made here, and the aiRuntime setting.
The real ACE-Step run is skipped unless env UJWALAM_ACESTEP_RUNTIME names the runtime folder (off air, GPU)."""

import json
import os
import shutil
import subprocess
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

CLICKS = textwrap.dedent("""
    import wave
    import numpy as np
    def clicks(path, sec, bpm):
        sr, beat = 48000, 60.0 / float(bpm)
        n = int(sec * sr); x = np.zeros(n); t = np.arange(int(0.15 * sr)) / sr
        click = np.sin(2 * np.pi * (60 + 90 * np.exp(-t / 0.03)) * t) * np.exp(-t / 0.06)
        k = 0
        while k * beat < sec:
            i = int(k * beat * sr); ln = min(n - i, len(click)); x[i:i + ln] += click[:ln]; k += 1
        x += 0.05 * np.sin(2 * np.pi * 3000 * np.arange(n) / sr)
        pcm = np.clip(np.rint(np.repeat((x / np.max(np.abs(x)) * 0.8)[:, None], 2, axis=1) * 32767), -32768, 32767).astype("<i2")
        with wave.open(path, "wb") as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
""")
STUB_HEAD = "import json, os, sys, time\njob = json.load(open(sys.argv[1], encoding='utf-8'))\n" \
            "here = os.path.dirname(os.path.abspath(sys.argv[1]))\nP = lambda k: os.path.join(here, job[k])\n"
STUB_OK = CLICKS + STUB_HEAD + textwrap.dedent("""
    open(os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "..", "..", "..", "ran.txt"), "a").write("x")
    clicks(P("out"), float(job["seconds"]), job["bpm"])
    json.dump({"ok": True, "error": None, "seconds": 0.1, "loadSeconds": 0.0, "torchPeakMB": 0}, open(P("result"), "w"))
""")
STUB_FAIL = STUB_HEAD + textwrap.dedent("""
    os.makedirs(P("work"), exist_ok=True)
    open(P("out"), "wb").write(b"half")
    json.dump({"ok": False, "error": "CUDA out of memory"}, open(P("result"), "w"))
    sys.exit(1)
""")
STUB_HANG = STUB_HEAD + textwrap.dedent("""
    os.makedirs(P("work"), exist_ok=True)
    open(os.path.join(P("work"), "x.wav"), "wb").write(b"partial")
    open(P("out"), "wb").write(b"half")
    time.sleep(60)
""")
FAKE_TORCH = textwrap.dedent("""
    class _Cuda:
        def reset_peak_memory_stats(self): pass
        def max_memory_allocated(self): return 0
    cuda = _Cuda()
""")
FAKE_HANDLER = "class AceStepHandler:\n    def initialize_service(self, **kw):\n        self.kw = kw\n        return 'ok'\n"
FAKE_INFERENCE = CLICKS + textwrap.dedent("""
    import os
    class GenerationParams:
        def __init__(self, **kw): self.__dict__.update(kw)
    class GenerationConfig:
        def __init__(self, **kw): self.__dict__.update(kw)
    class _Res:
        def __init__(self, path): self.success, self.error, self.audios = True, None, [{"path": path}]
    def generate_music(dit, lm, params, config, save_dir):
        assert lm is None and params.instrumental and not params.thinking and config.seeds == [params.seed]
        os.makedirs(save_dir, exist_ok=True)
        p = os.path.join(save_dir, "a.wav")
        clicks(p, params.duration, params.bpm)
        return _Res(p)
""")
TARGET = {"energy": 0.9, "moods": ["phonk", "edm", "trap"]}


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="fx6-")
        self.data = os.path.join(self.d, "data")
        self.lock = os.path.join(self.d, "lock")
        os.makedirs(self.lock)
        self.cfg = mg.load_config()
        self.mlcfg = __import__("music_library").load_config()
        self.ok = write(os.path.join(self.d, "w", "ok.py"), STUB_OK)
        self.failw = write(os.path.join(self.d, "w", "fail.py"), STUB_FAIL)
        self.hang = write(os.path.join(self.d, "w", "hang.py"), STUB_HANG)
        self.gen = os.path.join(self.data, "music", "generated")

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def ran(self):
        return os.path.isfile(os.path.join(self.d, "ran.txt"))

    def make(self, **kw):
        args = dict(cfg=self.cfg, live=lambda: False, vram=lambda: 6000, lock_dir=self.lock, python=sys.executable,
                    worker=self.ok, env={}, runtime=self.d)
        args.update(kw)
        return mg.make(self.data, TARGET, 20.0, self.mlcfg, **args)

    def left(self):
        return sorted(os.listdir(self.gen)) if os.path.isdir(self.gen) else []


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

    def test_runtime_from_env_or_the_setting(self):
        d = tempfile.mkdtemp(prefix="fx6-rt-")
        try:
            cfg = mg.load_config()
            self.assertIsNone(mg.runtime_dir({}, d), "no settings")
            write(os.path.join(d, "settings.json"), json.dumps({"clips": {"look": {"music": {"aiRuntime": "relative\\x"}}}}))
            self.assertIsNone(mg.runtime_dir({}, d), "not absolute: ignored")
            self.assertEqual(mg.runtime_dir({mg.ENV_RUNTIME: d}, None), os.path.abspath(d))
            self.assertIsNone(mg.runtime_python(cfg, {mg.ENV_RUNTIME: d}), "no Python in the folder")
            py = os.path.join(d, *cfg["python"].split("/"))
            write(py, "")
            write(os.path.join(d, "settings.json"), json.dumps({"clips": {"look": {"music": {"aiRuntime": os.path.abspath(d)}}}}))
            self.assertEqual(mg.runtime_python(cfg, {}, d), py, "from the setting")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_ai_runtime_setting_rules(self):
        cfg = cl.load_config()
        for ok in ("", "C:\\AI\\ace", "D:/x", "\\\\server\\share\\ace"):
            self.assertEqual(cl.look_problems({"music": {"aiRuntime": ok}}, cfg), [], ok)
        msg = ["clips.look.music.aiRuntime must be empty or a full folder path up to 260 characters"]
        self.assertEqual(cl.look_problems({"music": {"aiRuntime": "C:\\" + "\U0001F3B5" * 128 + "a"}}, cfg), [], "260 UTF-16 units")
        for bad in ("ace", "C:", 5, "C:\\" + "a" * 260, "C:\\a\nb", "C:\\" + "\U0001F3B5" * 129):
            self.assertEqual(cl.look_problems({"music": {"aiRuntime": bad}}, cfg), msg, repr(bad))


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
        self.assertFalse(self.ran())

    def test_live_flips_before_the_start(self):
        calls = []

        def live():  # off air for the first check, on air from the one inside the lock
            calls.append(1)
            return len(calls) > 1
        t, why = self.make(live=live)
        self.assertIsNone(t)
        self.assertIn("live", why)
        self.assertFalse(self.ran(), "no child started")
        self.assertEqual(self.left(), [], "the job file is removed")

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
        t, why = self.make(worker=self.failw)
        self.assertIsNone(t)
        self.assertIn("CUDA out of memory", why)
        self.assertEqual(self.left(), [], "no part file, job, result or work folder left")

    def test_metadata_write_failure_leaves_no_final_files(self):
        real = mg.write_json_atomic

        def failing(path, doc):
            if path.endswith(".json.part"):
                raise OSError("disk full")
            return real(path, doc)
        rid = mg.request_for(TARGET, 20.0, self.cfg)["id"]
        os.makedirs(self.gen, exist_ok=True)
        write(os.path.join(self.gen, rid + ".json"), "{\"id\": \"stale\"}")  # an old invalid JSON beside
        mg.write_json_atomic = failing
        try:
            t, why = self.make()
        finally:
            mg.write_json_atomic = real
        self.assertIsNone(t)
        self.assertIn("not stored", why)
        self.assertEqual(self.left(), [], "no final WAV, no stale JSON, no part files")

    def test_timeout_kills_and_cleans(self):
        t, why = self.make(worker=self.hang, cfg=dict(self.cfg, timeoutSec=3))
        self.assertIsNone(t)
        self.assertIn("longer than 3", why)
        self.assertEqual(self.left(), [], "a killed worker leaves nothing")


@unittest.skipUnless(HAVE_NP, "needs numpy + PyAV (the project venv)")
class WorkerContractTests(Base):
    """The real ace_worker.py in a fake runtime folder: fake torch + acestep packages, found from the working folder."""

    def setUp(self):
        super().setUp()
        self.rt = os.path.join(self.d, "rt")
        write(os.path.join(self.rt, "torch", "__init__.py"), FAKE_TORCH)
        write(os.path.join(self.rt, "acestep", "__init__.py"), "")
        write(os.path.join(self.rt, "acestep", "handler.py"), FAKE_HANDLER)
        write(os.path.join(self.rt, "acestep", "inference.py"), FAKE_INFERENCE)

    def test_real_worker_makes_a_track(self):
        t, why = self.make(worker=mg.WORKER, runtime=self.rt)
        self.assertEqual(why, "made")
        self.assertAlmostEqual(t["bpm"], 140, delta=3)
        self.assertEqual(sorted(self.left()), sorted([t["id"] + ".json", t["id"] + ".wav"]), "work folder removed")

    def _job(self, **over):
        folder = os.path.join(self.d, "jobs")
        os.makedirs(folder, exist_ok=True)
        job = {"caption": "x, instrumental", "bpm": 140, "seconds": 30, "seed": 1, "out": "a.part.wav",
               "result": "a.result.json", "work": "a.work", "config": "acestep-v15-turbo",
               "quantization": "int8_weight_only", "offloadToCpu": True}
        job.update(over)
        p = os.path.join(folder, "a.job.json")
        res = os.path.join(folder, "a.result.json")
        if os.path.exists(res):
            os.remove(res)
        write(p, json.dumps(job))
        r = subprocess.run([sys.executable, "-I", mg.WORKER, p], cwd=os.path.join(self.d, "w"), capture_output=True,
                           text=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        out = None
        if os.path.isfile(res):
            with open(res, encoding="utf-8") as f:
                out = json.load(f)
        return r.returncode, out, folder

    def test_paths_must_be_plain_names_in_the_job_folder(self):
        for k, v in (("out", "../evil.wav"), ("out", "C:\\x\\evil.wav"), ("out", "a.json"), ("work", ".."),
                     ("work", "a.part.wav")):
            rc, out, folder = self._job(**{k: v})
            self.assertEqual(rc, 2, f"{k}={v}")
            self.assertFalse(out["ok"])
            self.assertFalse(os.path.exists(os.path.join(self.d, "evil.wav")))
        for k, v in (("out", "CON.wav"), ("out", "nul.wav"), ("out", "Com1.wav"), ("out", "lpt9.part.wav"),
                     ("work", "AUX"), ("work", "prn"), ("work", "work."), ("result", "Nul.json")):
            rc, out, _ = self._job(**{k: v})
            self.assertEqual(rc, 2, f"reserved or trailing dot: {k}={v}")
            if k != "result":
                self.assertIn(k, out["error"])
        rc, out, _ = self._job(result="../escape.json")
        self.assertEqual((rc, out), (2, None), "a bad result name: nothing written anywhere")
        self.assertFalse(os.path.exists(os.path.join(self.d, "escape.json")))

    def test_fields_checked_before_torch(self):
        # cwd has no torch: a field error must be reported without importing it
        for k, v in (("bpm", 999), ("bpm", "140"), ("seconds", -1), ("seed", -5), ("seed", True), ("caption", ""),
                     ("config", "other"), ("quantization", None), ("offloadToCpu", "yes")):
            rc, out, _ = self._job(**{k: v})
            self.assertEqual(rc, 2, f"{k}={v}")
            self.assertIn(k, out["error"])
        rc, out, _ = self._job()
        self.assertEqual(rc, 1, "valid job, no torch in this folder: a clean failure")
        self.assertIn("ModuleNotFoundError", out["error"])


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
        again, why2 = self.make(worker=self.failw, python=None, live=lambda: True)  # reuse needs no runtime and no guard
        self.assertEqual(why2, "stored")
        self.assertEqual(again["id"], t["id"])
        self.assertEqual([x["id"] for x in mg.stored(self.data, self.cfg)], [t["id"]])

    def test_tampered_stored_json_never_changes_the_source(self):
        t, _ = self.make()
        p = os.path.join(self.gen, t["id"] + ".json")
        with open(p, encoding="utf-8") as f:
            doc = json.load(f)
        bad = dict(doc, pack={"file": "pack-01-a.wav", "sha256": "0" * 64, "artist": "A", "title": "T", "licence": "CC0",
                              "fma": "https://x"}, credit={"artist": "A"}, source="pack")
        write(p, json.dumps(bad))
        s = mg.stored_track(self.data, t["id"], self.cfg)
        for k in ("pack", "credit", "source"):
            self.assertNotIn(k, s)
        self.assertEqual(mg.record(s)["source"], "made-here")
        self.assertEqual(self._plan_source(), "made-here")
        write(p, json.dumps({k: v for k, v in doc.items() if k != "generated"}))
        self.assertIsNone(mg.stored_track(self.data, t["id"], self.cfg), "no generated block: refused")
        t2, why = self.make(python=None)
        self.assertIsNone(t2, "refused, never reused as a folder track")
        write(p, json.dumps(dict(doc, bpm="fast")))
        self.assertIsNone(mg.stored_track(self.data, t["id"], self.cfg), "a wrong type: refused")

    def _plan_source(self, ai=True):
        import clipper  # noqa: PLC0415
        lcfg = cl.load_config()
        ex = {"look": {"cfg": lcfg, "look": cl.effective(None, lcfg), "tracks": [], "mlcfg": self.mlcfg,
                       "dataDir": self.data, "history": {}, "ai": ai}}
        ps = [{"start": 10.0, "end": 22.0, "kills": 3}]
        _, plan = clipper._look_music_plan(ex, {"music": "full-bed", "name": None}, ps, 0.0, None,
                                           {"kills": 3, "streaks": 1, "pieces": ps}, "live-clip", None, "r1", "v.mp4")
        return plan and plan["record"]["source"]

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
        t, _ = self.make()
        ps = [{"start": 0.0, "end": 6.0}, {"start": 9.0, "end": 15.0}]
        rec = dict({k: v for k, v in mlib.plan(t, "full-bed", ps, 0.22, 3.0, None, -16, self.mlcfg).items() if k != "beats"},
                   **mg.record(t))
        wd = os.path.join(self.d, "wd")
        os.makedirs(wd)
        mus, new = clipper._recaption_music(self.data, wd, {"music": dict(rec, credit={"x": 1})}, ps, 0.22, "r1")
        self.assertTrue(os.path.isfile(os.path.join(wd, mus["file"])))
        self.assertEqual((new["source"], new["generator"]), ("made-here", "ace-step-1.5"))
        os.remove(t["file"])
        _, new = clipper._recaption_music(self.data, wd, {"music": rec}, ps, 0.22, "r1")
        self.assertEqual((new["source"], new["fallback"]), ("made-here", "the generated track is gone"))
        self.assertNotIn("generator", new)

    def test_clipper_reuses_a_stored_track_without_the_runtime(self):
        import clipper  # noqa: PLC0415
        lcfg = cl.load_config()
        target = __import__("music_library").target_for({"kills": 3, "streaks": 1, "pieces": []}, "live-clip", self.mlcfg)
        t, why = mg.make(self.data, target, 12.0, self.mlcfg, cfg=self.cfg, live=lambda: False, vram=lambda: 6000,
                         lock_dir=self.lock, python=sys.executable, worker=self.ok, env={}, runtime=self.d)
        self.assertEqual(why, "made")
        os.remove(os.path.join(self.d, "ran.txt"))
        old = os.environ.pop(mg.ENV_RUNTIME, None)
        try:
            self.assertIsNone(mg.runtime_python(self.cfg, None, self.data), "no runtime set up")
            self.assertEqual(self._plan_source(), "made-here", "reused through the clipper plan")
            self.assertFalse(self.ran(), "nothing new was made")
            self.assertIsNone(self._plan_source(ai=False), "AI unticked: the made-here bed")
        finally:
            if old is not None:
                os.environ[mg.ENV_RUNTIME] = old
        del clipper, lcfg


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
                              "bpmMeasured": (t or {}).get("bpmMeasured"), "duration": (t or {}).get("duration")}),
                  file=sys.stderr)
            self.assertEqual(why, "made")
            self.assertAlmostEqual(t["bpm"], 140, delta=3)
        finally:
            shutil.rmtree(d, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
