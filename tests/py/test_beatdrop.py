# SPDX-License-Identifier: GPL-3.0-or-later
"""BD3 beat-locked planner + BD4 BeatDrop effects (services/clip/beatdrop.py, beatdrop_fx.py, D415).

Synthetic fixtures made here (no real footage, no real music):
- a "gameplay" recording (60 fps, 320x180, FFV1): a textured scene that pans slowly; 20 s with no kill (third-person
  moments for the cold open), then kills every 1.2 s, each shown as a green square at the centre for 4 frames from the
  kill frame (a click in the sound on the kill and 6 frames before it, the gunshot), and flicks between kills;
- a click track (120 bpm, intro 4 bars, drop 8, breakdown 2, drop 8, outro 4) named as an NCS release in a temp
  Montage music folder (Settings > Clips > Montage music on).

Done when (plan section 7, synthetic part): the montage rendered by `clipper.py beatdrop` (CPU, libopenh264) measures
back with >= 80 % of kills within one frame of a beat (green-square onsets vs the click track's known beats), the
first kill on the first drop, no kill in the cold open, the flash limit held (rendered-frame luminance, the fx test
analyser), one audio encode, and the NCS music record in render.json. BD4: each effect alone, at its densest, keeps
the flash limit on rendered frames; timing limits from the manifests. Real footage UNVERIFIED.
Needs numpy + PyAV (the project venv), ffmpeg with libopenh264 and node on PATH."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
CLIP = os.path.join(REPO, "services", "clip")
sys.path.insert(0, CLIP)

try:
    import av  # noqa: F401
    import numpy as np
except ImportError:
    np = None

HAVE_TOOLS = bool(shutil.which("ffmpeg") and shutil.which("ffprobe") and shutil.which("node"))
NOWIN = 0x08000000 if os.name == "nt" else 0
FPS, W, H, SR = 60, 320, 180, 48000
REC_SEC = 82.0
CALM_END = 20.0
KILLS = [int(round((CALM_END + 1.0 + 1.2 * i) * FPS)) for i in range(50)]  # frames
FLICKS = [k + 51 for k in KILLS]  # 0.85 s after each kill
TPP = [int(t * FPS) for t in (1.0, 5.0, 9.0, 13.0, 17.0)]
BPM, PHASE = 120.0, 0.25
GAINS = [0.15] * 4 + [1.0] * 8 + [0.15] * 2 + [1.0] * 8 + [0.12] * 4
BASS = set(range(4, 12)) | set(range(14, 22))
TRUE_BEATS = [PHASE + k * 0.5 for k in range(len(GAINS) * 4)]
TRUE_DROP = PHASE + 4 * 4 * 0.5  # bar 4


def moments_doc():
    ms = []
    for i, k in enumerate(KILLS):
        ms.append({"kind": "gunshot", "t": round((k - 6) / FPS, 4), "frame": k - 6, "strength": 0.6, "source": "synthetic", "status": "unverified"})
        ms.append({"kind": "kill", "t": round(k / FPS, 4), "frame": k, "strength": 1.0 if i == 7 else round(0.5 + 0.01 * (i % 30), 3),
                   "source": "synthetic", "status": "unverified"})
        ms.append({"kind": "flick", "t": round(FLICKS[i] / FPS, 4), "frame": FLICKS[i], "strength": 0.5, "source": "synthetic", "status": "unverified"})
    for f in TPP:
        ms.append({"kind": "third-person", "t": round(f / FPS, 4), "frame": f, "strength": 0.7, "source": "synthetic", "status": "unverified"})
    ms.sort(key=lambda m: m["frame"])
    return {"version": 1, "game": "codm", "configVersion": "synthetic", "status": "unverified", "fps": FPS,
            "frames": int(REC_SEC * FPS), "seconds": REC_SEC, "moments": ms, "counts": {}, "soundTransients": 0,
            "unconfirmedTransients": 0, "analyseSec": 0}


def write_recording(path):
    rng = np.random.default_rng(5)
    small = rng.uniform(0, 1, (24, 200)).astype(np.float32)
    import cv2  # noqa: PLC0415
    big = cv2.GaussianBlur(cv2.resize(small, (W * 8, H), interpolation=cv2.INTER_CUBIC), (0, 0), 6)
    big = (90 + 70 * (big - big.min()) / (big.max() - big.min())).astype(np.uint8)
    kill_on = set()
    for k in KILLS:
        kill_on.update(range(k, k + 4))
    n = int(REC_SEC * FPS)
    with av.open(path, "w") as c:
        vs = c.add_stream("ffv1", rate=FPS)
        vs.width, vs.height, vs.pix_fmt = W, H, "yuv444p"
        as_ = c.add_stream("pcm_s16le", rate=SR)
        as_.layout = "mono"
        for f in range(n):
            x0 = (2 * f) % (W * 7)
            g = big[:, x0:x0 + W]
            img = np.repeat(g[:, :, None], 3, axis=2).copy()
            if f in kill_on:
                img[H // 2 - 14:H // 2 + 14, W // 2 - 14:W // 2 + 14] = (0, 220, 0)  # BGR green
            for p in vs.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                c.mux(p)
        for p in vs.encode():
            c.mux(p)
        x = 0.01 * np.sin(2 * np.pi * 150 * np.arange(int(REC_SEC * SR)) / SR)
        for k in KILLS:
            for f in (k - 6, k):
                i = int(f / FPS * SR)
                ln = int(0.03 * SR)
                x[i:i + ln] += 0.6 * np.sin(2 * np.pi * 900 * np.arange(ln) / SR) * np.exp(-np.arange(ln) / (0.008 * SR))
        pcm = np.clip(np.rint(x * 32767), -32768, 32767).astype(np.int16)
        for i in range(0, len(pcm), 1024):
            fr = av.AudioFrame.from_ndarray(pcm[None, i:i + 1024], format="s16", layout="mono")
            fr.sample_rate = SR
            for p in as_.encode(fr):
                c.mux(p)
        for p in as_.encode():
            c.mux(p)


def write_click_track(path):
    period = 60.0 / BPM
    n = int((PHASE + len(GAINS) * 4 * period + 1.0) * SR)
    x = np.zeros(n)
    rng = np.random.default_rng(7)
    for b, gain in enumerate(GAINS):
        for q in range(4):
            t = PHASE + (4 * b + q) * period
            i = int(round(t * SR))
            ln = min(n - i, int(0.2 * SR))
            tt = np.arange(ln) / SR
            x[i:i + ln] += (1.0 if q == 0 else 0.6) * gain * np.sin(2 * np.pi * (50 + 90 * np.exp(-tt / 0.03)) * tt) * np.exp(-tt / 0.08)
            j = int(round((t + period / 2) * SR))
            h = min(n - j, int(0.02 * SR))
            x[j:j + h] += 0.25 * gain * rng.uniform(-1, 1, h) * np.exp(-np.arange(h) / (0.004 * SR))
            if b in BASS:
                ln2 = min(n - i, int(period * SR))
                x[i:i + ln2] += 0.25 * np.sin(2 * np.pi * 55 * np.arange(ln2) / SR)
    x = x / np.max(np.abs(x)) * 0.9
    pcm = np.clip(np.rint(np.repeat(x[:, None], 2, axis=1) * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def green_onsets(path):
    """Output times (s) where the centre turns green (a kill's first frame), from the rendered frames."""
    onsets, prev = [], False
    with av.open(path) as c:
        st = c.streams.video[0]
        for i, fr in enumerate(c.decode(st)):
            a = fr.to_ndarray(format="rgb24").astype(np.int32)
            h, w = a.shape[:2]
            gx = a[:, :, 1] - (a[:, :, 0] + a[:, :, 2]) / 2  # green excess
            roi = gx[h // 2 - 6:h // 2 + 6, w // 2 - 6:w // 2 + 6]
            ring = np.concatenate([gx[h // 2 - 6:h // 2 + 6, w // 2 - 40:w // 2 - 24].ravel(),
                                   gx[h // 2 - 6:h // 2 + 6, w // 2 + 24:w // 2 + 40].ravel()])
            # relative to the grey around it: a white impact flash over the frame halves the green's chroma (YUV
            # blend; measured about +15 under a 0.5 flash against about 0 for the grey ring), so a kill under a flash is still seen on its first frame
            g = float(np.mean(roi) - np.mean(ring))
            on = g > 8
            if on and not prev:
                onsets.append(i / FPS)
            prev = on
    return onsets


def flash_measure(path, w=192, h=108):
    """The fx test analyser (tools/fx-test.mjs analyseVideo, services/overlay-server/flash-detect.mjs)."""
    url = "file:///" + os.path.join(REPO, "tools", "fx-test.mjs").replace("\\", "/")
    js = (f"import({json.dumps(url)}).then(async m => {{ const r = await m.analyseVideo({json.dumps(path)}, "
          f"{{ sample: {{ width: {w}, height: {h} }}, fps: 60 }}); console.log(JSON.stringify(r)); }})"
          ".catch(e => { console.error(String(e)); process.exit(2); });")
    r = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, timeout=300,
                       creationflags=NOWIN)
    if r.returncode != 0:
        raise AssertionError(r.stderr[-400:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def smap_fixture(layout=(("intro", 4), ("drop", 8), ("breakdown", 2), ("drop", 8), ("outro", 4))):
    """A song map for the planner unit tests (the known grid of the click track; BD2 itself is tested elsewhere)."""
    n_beats = 4 * sum(b for _, b in layout)
    beats = [round(PHASE + k * 0.5, 4) for k in range(n_beats)]
    secs, t = [], PHASE
    for kind, bars in layout:
        secs.append({"kind": kind, "start": round(t, 4), "end": round(t + bars * 2.0, 4), "energyDb": -10.0})
        t += bars * 2.0
    return {"version": 1, "duration": round(t + 1.0, 3), "bpm": BPM, "period": 0.5, "phase": PHASE, "beatsPerBar": 4,
            "fit": {"rmsMs": 0.5, "inliers": 100, "libraryBpm": BPM}, "beats": beats, "downbeats": beats[::4],
            "sections": secs, "drops": [s["start"] for s in secs if s["kind"] == "drop"], "transients": []}


@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class PlannerTests(unittest.TestCase):
    """Planner rules on data only (no render)."""

    @classmethod
    def setUpClass(cls):
        import beatdrop  # noqa: PLC0415
        cls.bd = beatdrop
        cls.pl = beatdrop.plan(moments_doc(), smap_fixture(), max_sec=60)

    def test_plan_follows_its_schema(self):
        import reel_style as rs  # noqa: PLC0415 - the stdlib schema checker of RS2
        with open(os.path.join(REPO, "data", "schemas", "beatdrop-plan.schema.json"), encoding="utf-8") as f:
            sch = json.load(f)
        self.assertEqual(rs.schema_problems(self.pl, sch, "plan"), [])

    def test_structure(self):
        pl = self.pl
        parts = [p["part"] for p in pl["pieces"]]
        self.assertEqual(parts[0], "cold-open")
        self.assertIn("drop", parts)
        self.assertIn("breakdown", parts)
        self.assertEqual(parts[-1], "outro")
        drop = next(p for p in pl["pieces"] if p["part"] == "drop")
        self.assertEqual(drop["anchor"]["frame"], KILLS[7], "the strongest kill is on the first drop")
        self.assertEqual(drop["anchor"]["outFrame"], round((TRUE_DROP - pl["songStart"]) * 60))
        for p in pl["pieces"]:
            if p["part"] in ("cold-open", "breakdown", "outro"):
                self.assertIsNone(p["anchor"])
                s0, s1 = p["src"]["start"], p["src"]["end"]
                self.assertFalse(any(s0 - 0.01 <= k / FPS <= s1 + 0.01 for k in KILLS), f"no kill in a calm piece {p}")
        for s in ("title", "hero", "credits"):
            self.assertIn(s, pl["slots"])
            self.assertIsNone(pl["slots"][s]["content"])
        self.assertAlmostEqual(pl["slots"]["title"]["end"], TRUE_DROP - pl["songStart"], places=3)

    def test_joins_are_frame_exact_and_cover_the_reel(self):
        f = 0
        for p in self.pl["pieces"]:
            self.assertEqual(p["outStart"], f)
            self.assertGreater(p["outFrames"], 0)
            f += p["outFrames"]
        self.assertEqual(f, self.pl["frames"])

    def test_anchors_on_beats_within_a_frame_and_speed_limits(self):
        beats = [b - self.pl["songStart"] for b in TRUE_BEATS]
        on = [p for p in self.pl["pieces"] if p.get("anchor") and p["anchor"]["onBeat"]]
        self.assertGreaterEqual(len(on), 20)
        for p in self.pl["pieces"]:
            self.assertGreaterEqual(p["speed"], 0.5)
            self.assertLessEqual(p["speed"], 2.0)
            a = p.get("anchor")
            if not a:
                continue
            # the anchor's source frame lands on its output frame: src start + (outFrame - outStart)/60 * speed
            land = p["src"]["start"] + (a["outFrame"] - p["outStart"]) / 60 * p["speed"]
            self.assertAlmostEqual(land, a["srcT"], delta=0.5 / 60)
            if a["onBeat"]:
                self.assertLessEqual(min(abs(a["outT"] - b) for b in beats), 1 / 60 + 1e-6)
            else:  # off-beat: half way between beats
                self.assertLessEqual(min(abs(a["outT"] - b - 0.25) for b in beats), 1 / 60 + 1e-6)
        share = self.pl["stats"]["onBeatShare"]
        self.assertGreaterEqual(share, 0.65)

    def test_style_targets_change_the_edit(self):
        style = {"id": "s1", "cuts": {"shotSec": 1.0, "ratePerMin": 60, "beatShare": 1.0}}
        pl = self.bd.plan(moments_doc(), smap_fixture(), style=style, max_sec=60)
        self.assertEqual(pl["targets"]["source"], "style:s1")
        body = [p for p in pl["pieces"] if p["part"] == "body"]
        self.assertTrue(all(p["anchor"]["onBeat"] for p in body if p.get("anchor")), "beat share 1: no off-beat piece")
        self.assertTrue(any(p["outFrames"] == 60 for p in body), "two beats per shot")
        self.assertGreater(pl["stats"]["medianShotSec"], self.pl["stats"]["medianShotSec"])

    def test_no_room_picks_another_moment(self):
        doc = moments_doc()
        # the strongest kill sits at the very start of the recording: no lead-in fits even at 0.5x, so another kill
        # takes the drop
        doc["moments"].append({"kind": "kill", "t": 0.05, "frame": 3, "strength": 1.0, "source": "synthetic", "status": "unverified"})
        doc["moments"].sort(key=lambda m: m["frame"])
        for m in doc["moments"]:
            if m["frame"] == KILLS[7] and m["kind"] == "kill":
                m["strength"] = 0.99
        pl = self.bd.plan(doc, smap_fixture(), max_sec=60)
        drop = next(p for p in pl["pieces"] if p["part"] == "drop")
        self.assertNotEqual(drop["anchor"]["frame"], 3)
        self.assertEqual(drop["anchor"]["frame"], KILLS[7])

    def test_flashes_respaced(self):
        fl = [e for e in self.pl["effects"] if e["fn"] == "impact-flash"]
        times = sorted(e["at"] for e in fl if e["mode"] == "flash")
        for i, t in enumerate(times):
            self.assertLessEqual(sum(1 for u in times if t - 1.0 < u <= t), 3)
            if i:
                self.assertGreaterEqual(t - times[i - 1], 0.34 - 1e-6)
        self.assertTrue(any(e["mode"] == "pulse" for e in fl) or len(fl) == len(times))

    def test_first_drop_before_the_cold_open_minimum_wins(self):
        # review item 3: a drop at 2 bars (4.25 s) is before coldOpen.minSec (6 s): it stays the first drop, the cold
        # open is shortened and logged
        sm = smap_fixture((("intro", 2), ("drop", 8), ("breakdown", 2), ("drop", 8), ("outro", 4)))
        pl = self.bd.plan(moments_doc(), sm, max_sec=60)
        drop = next(p for p in pl["pieces"] if p["part"] == "drop")
        self.assertEqual(drop["anchor"]["outFrame"], round(4.25 * 60))
        self.assertEqual(pl["song"]["firstDrop"], 4.25)
        self.assertEqual(pl["song"]["dropAt"], 4.25)
        self.assertNotIn("firstDropMissed", pl)
        self.assertTrue(any("cold open shortened" in m for m in pl["log"]), pl["log"])
        self.assertTrue(all(p["part"] == "cold-open" for p in pl["pieces"] if p["outStart"] < drop["outStart"]))

    def test_first_drop_too_early_is_recorded_not_relabelled(self):
        # a drop after 1 bar (2.25 s) leaves no room for the shortest intro (coldOpen.minBars 2): firstDropMissed with
        # the reason; the kill goes on the next drop, which is not called the first drop
        sm = smap_fixture((("intro", 1), ("drop", 4), ("breakdown", 2), ("drop", 8), ("outro", 4)))
        pl = self.bd.plan(moments_doc(), sm, max_sec=60)
        self.assertEqual(pl["firstDropMissed"]["at"], 2.25)
        self.assertIn("shortest intro", pl["firstDropMissed"]["reason"])
        self.assertTrue(any(m.startswith("firstDropMissed") for m in pl["log"]))
        self.assertIsNone(pl["song"]["firstDrop"])
        self.assertEqual(pl["song"]["dropAt"], 2.25 + 6 * 2.0)
        import reel_style as rs  # noqa: PLC0415
        with open(os.path.join(REPO, "data", "schemas", "beatdrop-plan.schema.json"), encoding="utf-8") as f:
            self.assertEqual(rs.schema_problems(pl, json.load(f), "plan"), [])

    def test_lead_in_holds_no_other_kill(self):
        # review item 4: two close kills: a weaker kill 0.3 s before the strongest one sits inside the drop piece's
        # lead-in at speed 1; the lead-in is trimmed (slower) or another moment is picked, never an off-beat kill
        doc = moments_doc()
        near = KILLS[7] - 18
        doc["moments"].append({"kind": "kill", "t": round(near / FPS, 4), "frame": near, "strength": 0.4,
                               "source": "synthetic", "status": "unverified"})
        doc["moments"].sort(key=lambda m: m["frame"])
        pl = self.bd.plan(doc, smap_fixture(), max_sec=60)
        for p, d in ((self.pl, moments_doc()), (pl, doc)):
            kill_ts = [m["frame"] / FPS for m in d["moments"] if m["kind"] == "kill"]
            for q in p["pieces"]:
                a = q.get("anchor")
                if not a:
                    continue
                others = [t for t in kill_ts if abs(t - a["srcT"]) > 1e-3 and q["src"]["start"] <= t <= q["src"]["end"]]
                self.assertEqual(others, [], f"another kill inside an anchored piece {q}")
        drop = next(q for q in pl["pieces"] if q["part"] == "drop")
        self.assertEqual(drop["anchor"]["frame"], KILLS[7])
        self.assertGreater(drop["src"]["start"], near / FPS)

    def test_bright_dark_cuts_count_as_flashes(self):
        # review item 1: cuts between dark and bright shots are flashes in the same 3/s budget: impact flashes yield,
        # a cut over the budget gets a luma-matched dissolve
        def luma(t):
            return 0.9 if int(t * 3) % 2 else 0.03
        pl = self.bd.plan(moments_doc(), smap_fixture(), max_sec=60, luma=luma)
        cuts = pl["cuts"]
        self.assertGreater(len(cuts), 10)
        self.assertEqual(self.pl["cuts"], [], "no luma probe, no cut check")
        soft = {e["at"] for e in pl["effects"] if e["fn"] == "cut-soften"}
        self.assertEqual(soft, {c["at"] for c in cuts if c["softened"]})
        pulses = lambda p: sum(1 for e in p["effects"] if e["fn"] == "impact-flash" and e["mode"] == "pulse")  # noqa: E731
        self.assertGreater(pulses(pl), pulses(self.pl), "impact flashes yield to the cuts")
        # replay the budget: every counted event (each cut, each impact flash left as a flash) keeps the rule unless it
        # is a softened cut
        ev = sorted([(c["at"], "cut", c["softened"]) for c in cuts]
                    + [(e["at"], "flash", False) for e in pl["effects"] if e["fn"] == "impact-flash" and e["mode"] == "flash"])
        kept = []
        for t, kind, softened in ev:
            ok = (not kept or t - kept[-1] >= 0.34 - 1e-6) and sum(1 for k in kept if t - k < 1.0) < 3
            self.assertTrue(ok or softened, f"{kind} at {t} breaks the flash budget unsoftened")
            kept.append(t)
        import beatdrop_fx as bfx  # noqa: PLC0415
        g = bfx.graph(pl["effects"], {"width": W, "height": H})
        self.assertTrue("color=black@" in g or "color=white@" in g)
        import reel_style as rs  # noqa: PLC0415
        with open(os.path.join(REPO, "data", "schemas", "beatdrop-plan.schema.json"), encoding="utf-8") as f:
            self.assertEqual(rs.schema_problems(pl, json.load(f), "plan"), [])

    def test_cuts_over_the_budget_are_softened(self):
        # at 120 bpm a piece is at least one beat (2 cuts/s), so the plan above never needs it: cuts every 0.2 s
        # (a fast song) go over 3/s and the ones that do not fit get the dissolve
        import beatdrop_fx as bfx  # noqa: PLC0415
        cuts = [{"at": round(0.2 * i, 4), "from": 0.03 if i % 2 else 0.9, "to": 0.9 if i % 2 else 0.03} for i in range(1, 11)]
        fl = [{"fn": "impact-flash", "at": 0.5, "params": bfx.params_for("impact-flash")}]
        out = bfx.space_flashes(fl, 3, 0.34, cuts=cuts, soften_frames=3)
        # a softened cut still counts (a dissolve is still a brightness change): after the first, every cut 0.2 s on
        # is under min gap
        self.assertEqual([c["softened"] for c in cuts], [False] + [True] * 9)
        self.assertEqual(sum(1 for e in out if e["fn"] == "cut-soften"), sum(1 for c in cuts if c["softened"]))
        self.assertEqual(next(e for e in out if e["fn"] == "impact-flash")["mode"], "pulse")

    def test_soften_matches_the_outgoing_level(self):
        import beatdrop_fx as bfx  # noqa: PLC0415
        p = bfx.soften_params(0.05, 0.9, 3)
        self.assertEqual(p["colour"], "black")
        self.assertAlmostEqual(0.9 ** (1 / 2.2) * (1 - p["alpha"]), 0.05 ** (1 / 2.2), places=3)
        q = bfx.soften_params(0.9, 0.05, 3)
        self.assertEqual(q["colour"], "white")
        sb = 0.05 ** (1 / 2.2)
        self.assertAlmostEqual(sb + q["alpha"] * (1 - sb), 0.9 ** (1 / 2.2), places=3)

    def test_game_sound_cutouts(self):
        p = next(p for p in self.pl["pieces"] if p["part"] == "drop")
        self.assertEqual(p["game"]["gain"], 0.2)
        a = (p["anchor"]["outFrame"] - p["outStart"]) / 60
        self.assertTrue(any(lo <= a <= hi for lo, hi in p["game"]["keep"]), "the kill sound is kept on its beat")

    def test_render_argv_one_audio_encode_and_old_calls_unchanged(self):
        import clip_montage as mont  # noqa: PLC0415
        argv = self.bd.render_argv(self.pl, "ffmpeg", "rec.mkv", {"width": W, "height": H}, ["-c:v", "libopenh264"],
                                   ["-c:a", "aac", "-b:a", "160k"], "music.wav", "out.mp4")
        self.assertEqual(argv.count("-c:a"), 1)
        g = argv[argv.index("-filter_complex") + 1]
        self.assertIn("alimiter", g)
        self.assertNotIn("sidechaincompress", g)
        self.assertEqual(g.count("lut3d"), 0)
        self.assertIn("[fxout]", g.replace("[vout]", "[fxout]"))
        plain = [{"start": 1.0, "end": 3.0}, {"start": 5.0, "end": 6.5}]
        a1 = mont.render_argv("ffmpeg", "s.mp4", plain, {"width": W, "height": H}, ["-c:v", "x"], ["-c:a", "aac"], 80, "o.mp4")
        g1 = a1[a1.index("-filter_complex") + 1]
        for word in ("atempo", "tpad", "volume=", "[fx"):
            self.assertNotIn(word, g1)

    def test_fx_timing_limits_and_flash_manifests(self):
        import beatdrop_fx as bfx  # noqa: PLC0415
        lb = bfx.manifest("letterbox")["params"]
        self.assertLess(lb["safeRanges"]["inMs"][1], 600)
        self.assertLess(lb["safeRanges"]["outMs"][1], 400)
        for fn in bfx.FUNCTIONS:
            m = bfx.manifest(fn)
            self.assertLessEqual(m["flashesPerSec"], 3)
            self.assertEqual(m["format"], "post-render")
        wp = bfx.manifest("whip-pan")["params"]["safeRanges"]["frames"]
        self.assertEqual(wp, [6, 10])
        self.assertEqual(bfx.params_for("impact-flash", {"maxPerSec": 9})["maxPerSec"], 3, "clamped to the limit")


class StopGuardTests(unittest.TestCase):
    """run_tool(stop=): the guard BeatDrop renders run under (review item 2)."""

    def test_stop_kills_the_child(self):
        import time  # noqa: PLC0415
        import clip_common as cc  # noqa: PLC0415
        t0 = time.monotonic()
        state = {"n": 0}

        def stop():
            state["n"] += 1
            return state["n"] >= 3  # the stream starts on the third look
        r = cc.run_tool([sys.executable, "-c", "import time; time.sleep(60)"], stop=stop, poll_sec=0.2)
        self.assertEqual(r.returncode, cc.STOPPED_RC)
        self.assertIn("stopped: on air", r.stderr)
        self.assertLess(time.monotonic() - t0, 20)

    def test_no_stop_runs_to_the_end(self):
        import clip_common as cc  # noqa: PLC0415
        r = cc.run_tool([sys.executable, "-c", "print('ok')"], stop=lambda: False, poll_sec=0.2)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "ok")


@unittest.skipUnless(np is not None, "numpy/PyAV missing (use the project venv)")
class MusicChoiceTests(unittest.TestCase):
    """No Montage music folder: the made-here bed is made, mapped and planned on; its record says made here."""

    def test_made_here_fallback(self):
        import beatdrop  # noqa: PLC0415
        import clip_publish  # noqa: PLC0415
        import song_map  # noqa: PLC0415
        tmp = tempfile.mkdtemp(prefix="ujw-bdmh-")
        try:
            self.assertEqual(beatdrop.pick_music(tmp, None, ("x",)), (None, None))
            self.assertEqual(beatdrop.pick_music(tmp, {"on": True, "folder": ""}, ("x",), live=lambda: False), (None, None))
            path, rec = beatdrop.made_here_song(tmp, 60.0, ("rec.mkv", "beatdrop"))
            self.assertEqual(clip_publish.music_provenance({"music": rec}, records=True)["source"], "generated")
            sm = song_map.song_map(path, tmp, live=lambda: False)
            pl = beatdrop.plan(moments_doc(), sm, max_sec=60)
            drop = next(p for p in pl["pieces"] if p["part"] == "drop")
            self.assertTrue(drop["anchor"]["onBeat"])
            self.assertGreaterEqual(pl["song"]["dropAt"], 2 * 4 * sm["period"] - 1e-6, "at least the shortest intro")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(np is not None and HAVE_TOOLS, "numpy/PyAV, ffmpeg or node missing")
class EffectFlashTests(unittest.TestCase):
    """Each BD4 effect alone at its densest (every 0.25 s for 4 s), rendered and measured from frame luminance."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ujw-bdfx-")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_each_effect_keeps_the_flash_limit(self):
        import beatdrop_fx as bfx  # noqa: PLC0415
        report = {}
        for fn in bfx.FUNCTIONS:
            p = bfx.params_for(fn)
            if fn == "letterbox":
                fx = [{"fn": fn, "at": a, "end": a + 0.9, "params": p} for a in (0.1, 1.1, 2.1, 3.1)]
            elif fn == "bloom-grade":
                fx = [{"fn": fn, "at": 0.0, "params": p}]
            else:
                fx = [{"fn": fn, "at": round(0.25 + 0.25 * i, 3), "params": p} for i in range(15)]
            fx = bfx.space_flashes(fx, int(p.get("maxPerSec", 3)), float(p.get("minGapSec", 0.34)))
            g = bfx.graph(fx, {"width": W, "height": H})
            out = os.path.join(self.tmp, f"{fn}.mp4")
            r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                                f"color=c=0x404040:s={W}x{H}:r=60:d=4.2", "-filter_complex",
                                "[0:v]format=yuv420p[fxin];" + g, "-map", "[fxout]", "-c:v", "libopenh264", "-b:v", "4000k", out],
                               capture_output=True, text=True, timeout=180, creationflags=NOWIN)
            self.assertEqual(r.returncode, 0, r.stderr[-400:])
            m = flash_measure(out)
            report[fn] = m["peakFlashesPerSecond"]
            self.assertTrue(m["pass"], f"{fn}: {m['peakFlashesPerSecond']} flashes/s")
        print("BD4 densest flash rates:", report)
        self.assertGreater(report["impact-flash"], 0, "the impact flash does flash (the measurement sees it)")
        # control: the same flashes every 0.25 s without re-spacing are measured above the limit
        p = bfx.params_for("impact-flash")
        raw = [{"fn": "impact-flash", "at": round(0.25 + 0.25 * i, 3), "params": p, "mode": "flash"} for i in range(15)]
        out = os.path.join(self.tmp, "unspaced.mp4")
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i",
                            f"color=c=0x404040:s={W}x{H}:r=60:d=4.2", "-filter_complex",
                            "[0:v]format=yuv420p[fxin];" + bfx.graph(raw, {"width": W, "height": H}), "-map", "[fxout]",
                            "-c:v", "libopenh264", "-b:v", "4000k", out],
                           capture_output=True, text=True, timeout=180, creationflags=NOWIN)
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        m = flash_measure(out)
        print(f"BD4 control (no re-spacing): {m['peakFlashesPerSecond']} flashes/s")
        self.assertFalse(m["pass"], "unspaced flashes must fail: the measurement is real")


@unittest.skipUnless(np is not None and HAVE_TOOLS, "numpy/PyAV, ffmpeg or node missing")
class RenderedMontageTests(unittest.TestCase):
    """The Done-when render: clipper.py beatdrop on the synthetic recording with the click track in the NCS folder."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="ujw-beatdrop-")
        cls.data = os.path.join(cls.tmp, "data")
        music = os.path.join(cls.tmp, "music")
        os.makedirs(cls.data)
        os.makedirs(music)
        write_click_track(os.path.join(music, "Test Artist - Click Drop [NCS Release].wav"))
        cls.rec = os.path.join(cls.tmp, "rec.mkv")
        write_recording(cls.rec)
        cls.out = os.path.join(cls.tmp, "run")
        os.makedirs(cls.out)
        with open(os.path.join(cls.out, "moments.json"), "w", encoding="utf-8") as f:
            json.dump(moments_doc(), f)
        with open(os.path.join(cls.data, "settings.json"), "w", encoding="utf-8") as f:
            json.dump({"clips": {"montageMusic": {"on": True, "folder": music, "mode": "random", "avoidLast": 3}}}, f)
        with open(os.path.join(cls.data, "flags.local.json"), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "reel-styles": False}}, f)
        env = dict(os.environ, UJWALAM_DATA_ROOT=cls.data, UJWALAM_HEADLESS="1")
        cls.proc = subprocess.run([sys.executable, "-I", os.path.join(CLIP, "clipper.py"), "--data-dir", cls.data, "beatdrop",
                                  "--out", cls.out, "--recording", cls.rec, "--encoder", "libopenh264",
                                  "--width", str(W), "--height", str(H), "--max-sec", "60"],
                                 capture_output=True, text=True, timeout=900, env=env, creationflags=NOWIN)
        cls.wd = os.path.join(cls.out, "beatdrop", "clips", "B1")
        cls.video = os.path.join(cls.wd, "beatdrop.mp4")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr[-1500:])

    def test_kills_on_beats_and_first_on_the_drop(self):
        with open(os.path.join(self.wd, "beatdrop-plan.json"), encoding="utf-8") as f:
            pl = json.load(f)
        on = green_onsets(self.video)
        beats = [b - pl["songStart"] for b in TRUE_BEATS]
        drop = TRUE_DROP - pl["songStart"]
        err = [min(abs(t - b) for b in beats) for t in on]
        within = sum(1 for e in err if e <= 1 / 60 + 1e-3)
        share = within / len(on)
        first = on[0]
        print(f"BD3 measured: {len(on)} kills rendered, {within} within one frame of a beat ({100 * share:.1f} %), "
              f"max error {1000 * max(err):.1f} ms, first kill at {first:.4f} s, drop at {drop:.4f} s "
              f"(error {1000 * abs(first - drop):.1f} ms); planned stats {pl['stats']}")
        self.assertGreaterEqual(len(on), 20)
        self.assertGreaterEqual(share, 0.80)
        self.assertLessEqual(abs(first - drop), 1 / 60 + 1e-3, "the first kill is on the first drop (none in the cold open)")

    def test_flash_limit_on_rendered_frames(self):
        m = flash_measure(self.video)
        print(f"BD3 montage flash: peak {m['peakFlashesPerSecond']} flashes/s over {m['frames']} frames (limit {m['limit']})")
        self.assertTrue(m["pass"])

    def test_one_audio_stream_and_length(self):
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name:format=duration",
                            "-of", "json", self.video], capture_output=True, text=True, creationflags=NOWIN)
        info = json.loads(r.stdout)
        kinds = [s["codec_type"] for s in info["streams"]]
        self.assertEqual(kinds.count("audio"), 1)
        self.assertEqual(kinds.count("video"), 1)
        with open(os.path.join(self.wd, "beatdrop-plan.json"), encoding="utf-8") as f:
            pl = json.load(f)
        self.assertAlmostEqual(float(info["format"]["duration"]), pl["total"], delta=0.1)

    def test_music_record_in_render_json(self):
        with open(os.path.join(self.out, "beatdrop", "render.json"), encoding="utf-8") as f:
            doc = json.load(f)
        self.assertEqual(doc["musicRecords"], 1)
        row = doc["clips"][0]
        self.assertEqual(row["kind"], "beatdrop")
        self.assertEqual(row["music"]["source"], "ncs")
        self.assertRegex(row["music"]["trackId"], r"^[0-9a-f]{16}$")
        self.assertEqual(row["music"]["credit"]["artist"], "Test Artist")
        import clip_publish  # noqa: PLC0415
        self.assertEqual(clip_publish.music_provenance(row, records=True)["source"], "ncs")
        self.assertFalse(os.path.exists(os.path.join(self.wd, "music.wav")), "the bed is cleaned up")

    def test_render_is_measured_and_recorded(self):
        with open(os.path.join(self.out, "beatdrop", "render.json"), encoding="utf-8") as f:
            row = json.load(f)["clips"][0]
        self.assertTrue(row["flash"]["pass"])
        self.assertLessEqual(row["flash"]["peakFlashesPerSecond"], 3)
        with open(os.path.join(self.wd, "beatdrop-luma.json"), encoding="utf-8") as f:
            self.assertGreater(len(json.load(f)["values"]), 10, "cut edges probed and cached")

    def _make(self, wd, **kw):
        import beatdrop  # noqa: PLC0415
        import clip_render as rnd  # noqa: PLC0415
        with open(os.path.join(self.out, "moments.json"), encoding="utf-8") as f:
            mdoc = json.load(f)
        os.makedirs(os.path.join(self.tmp, "lock"), exist_ok=True)
        return beatdrop.make(self.rec, mdoc, wd, self.data, "ffmpeg", rnd.ENCODERS["libopenh264"], rnd.AUDIO,
                             frame={"width": W, "height": H}, seed_parts=("rec.mkv", "beatdrop"), max_sec=60,
                             lock_dir=os.path.join(self.tmp, "lock"), **kw)

    def test_over_the_flash_limit_is_failed_not_published(self):
        wd = os.path.join(self.tmp, "gate")
        res = self._make(wd, live=lambda: False,
                         measure=lambda f: {"pass": False, "peakFlashesPerSecond": 4.5, "limit": 3})
        self.assertEqual(res["status"], "failed")
        self.assertIn("flash limit", res["reason"])
        self.assertIsNone(res["file"])
        self.assertFalse(os.path.exists(os.path.join(wd, "beatdrop.mp4")))
        self.assertFalse(os.path.exists(os.path.join(wd, "beatdrop.mp4.part")))

    def test_live_flip_mid_render_stops_it(self):
        wd = os.path.join(self.tmp, "flip")
        part = os.path.join(wd, "beatdrop.mp4.part")
        seen = {"rendering": False}

        def live():  # off air until the render has written its first bytes, then a stream starts
            if os.path.isfile(part) and os.path.getsize(part) > 0:
                seen["rendering"] = True
                return True
            return False
        res = self._make(wd, live=live, poll_sec=0.2)
        self.assertTrue(seen["rendering"], "the flip happened during the render")
        self.assertEqual(res["status"], "stopped: on air")
        self.assertIsNone(res["file"])
        self.assertFalse(os.path.exists(part))
        self.assertFalse(os.path.exists(os.path.join(wd, "beatdrop.mp4")))
        unknown = self._make(os.path.join(self.tmp, "unknown"), live=lambda: None)
        self.assertEqual(unknown["status"], "stopped: on air", "unknown counts as on air")

    def test_flag_off_makes_nothing(self):
        data = os.path.join(self.tmp, "data-off")
        os.makedirs(data, exist_ok=True)
        with open(os.path.join(data, "flags.local.json"), "w", encoding="utf-8") as f:
            json.dump({"flags": {"clip-pipeline": True, "beatdrop": False}}, f)
        out = os.path.join(self.tmp, "run-off")
        os.makedirs(out, exist_ok=True)
        r = subprocess.run([sys.executable, "-I", os.path.join(CLIP, "clipper.py"), "--data-dir", data, "beatdrop",
                            "--out", out, "--recording", self.rec, "--moments", os.path.join(self.out, "moments.json")],
                           capture_output=True, text=True, timeout=120, creationflags=NOWIN,
                           env=dict(os.environ, UJWALAM_DATA_ROOT=data, UJWALAM_HEADLESS="1"))
        self.assertEqual(r.returncode, 3, r.stderr[-300:])
        self.assertFalse(os.path.exists(os.path.join(out, "beatdrop")))


if __name__ == "__main__":
    unittest.main()
