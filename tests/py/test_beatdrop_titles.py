# SPDX-License-Identifier: GPL-3.0-or-later
"""BD5 BeatDrop titles: intro title, in-scene pin, outro hero and credits (services/clip/beatdrop_titles.py, D416).

Synthetic fixtures made here (no real footage, no real music, placeholder names only):
- a moving-plane clip (60 fps, 640x360, 3 s, FFV1 + a quiet tone): a textured flat card on a plain blue background,
  starting centred on the title's anchor, moving right and down and growing 15 % over the clip (known position per
  frame); a noise clip (every frame new noise: nothing to track);
- a hand-made one-piece plan with the title slot on known downbeats, a hero slot and a credits slot, rendered through
  beatdrop.render_argv (clip_montage.render_argv) at 640x360 with libopenh264 (CPU).

Done when (plan section 7 BD5, synthetic part): the tracked anchor stays within title-pin maxErrPx (data) of the
card's true position; the noise clip falls back to screen space with a log line; in the rendered file the presents
line and the song title appear on their downbeat frames (within one frame), the pinned title's rendered centre
follows the card within maxErrPx, the hero window is black and white, the hero name and credits are drawn, the
entrance and exit times measured from the frames are inside 600 / 400 ms, the flash limit holds (fx test analyser)
and there is one audio encode. Real footage UNVERIFIED.
Needs numpy, OpenCV and PyAV (the project venv), ffmpeg with libopenh264 and node on PATH."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unicodedata
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
CLIP = os.path.join(REPO, "services", "clip")
sys.path.insert(0, CLIP)
sys.path.insert(0, HERE)

try:
    import av  # noqa: F401
    import cv2  # noqa: F401
    import numpy as np
except ImportError:
    np = None

HAVE_TOOLS = bool(shutil.which("ffmpeg") and shutil.which("ffprobe") and shutil.which("node"))
NOWIN = 0x08000000 if os.name == "nt" else 0
FPS, W, H, N = 60, 640, 360, 240
SR = 48000
ANCHOR = (W / 2, 0.3 * H)  # title-extrude y default
RECORD = {"source": "ncs", "trackId": "0123456789abcdef",
          "credit": {"artist": "Test Artist", "title": "Click Drop", "line": "Music provided by NoCopyrightSounds", "link": ""}}


def truth(k):
    """The card's centre at frame k (it starts on the anchor) and its scale."""
    return ANCHOR[0] + 0.8 * k, ANCHOR[1] + 0.3 * k, 1.0 + 0.15 * k / (N - 1)


def card_frames(w=W, h=H, noise=False):
    """BGR frames of the moving card (or noise)."""
    rng = np.random.default_rng(11)
    if noise:
        for _ in range(N):
            yield rng.integers(0, 256, (h, w, 3), dtype=np.uint8)
        return
    cw, ch = int(0.47 * w), int(0.42 * h)
    tex = cv2.GaussianBlur(rng.uniform(0, 1, (ch, cw)).astype(np.float32), (0, 0), 1.6)
    tex = (40 + 140 * (tex - tex.min()) / (tex.max() - tex.min())).astype(np.uint8)  # never white: text is
    tex = np.repeat(tex[:, :, None], 3, axis=2)
    sx = w / W
    for k in range(N):
        x, y, s = truth(k)
        m = np.array([[s, 0, x * sx - s * cw / 2], [0, s, y * sx - s * ch / 2]], np.float32)
        bg = np.empty((h, w, 3), np.uint8)
        bg[:] = (150, 60, 30)  # BGR blue
        yield cv2.warpAffine(tex, m, (w, h), dst=bg, borderMode=cv2.BORDER_TRANSPARENT, flags=cv2.INTER_LINEAR)


def write_clip(path, noise=False):
    with av.open(path, "w") as c:
        vs = c.add_stream("ffv1", rate=FPS)
        vs.width, vs.height, vs.pix_fmt = W, H, "yuv444p"
        a = c.add_stream("pcm_s16le", rate=SR)
        a.layout = "mono"
        for img in card_frames(noise=noise):
            for p in vs.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                c.mux(p)
        for p in vs.encode():
            c.mux(p)
        x = (0.05 * np.sin(2 * np.pi * 220 * np.arange(int(N / FPS * SR)) / SR) * 32767).astype(np.int16)
        for i in range(0, len(x), 1024):
            fr = av.AudioFrame.from_ndarray(x[None, i:i + 1024], format="s16", layout="mono")
            fr.sample_rate = SR
            for p in a.encode(fr):
                c.mux(p)
        for p in a.encode():
            c.mux(p)


def mini_plan():
    """One piece (the whole clip at speed 1), title slot over downbeats 0.25 / 1.0 to the drop at 2.0 (the title line is
    1 s: longer than its 400 ms entrance + 300 ms exit, so the settled pin can be measured), hero 2.0-3.1, credits 3.1-4.0."""
    return {"version": 1, "kind": "beatdrop", "status": "unverified", "fps": FPS, "songStart": 0.0, "total": N / FPS,
            "frames": N, "song": {"bpm": 160.0, "period": 0.375, "firstDrop": 2.0, "dropAt": 2.0, "beats": [],
                                  "downbeats": [0.25, 1.0, 2.0, 2.75, 3.5]},
            "targets": {}, "slots": {"title": {"start": 0.25, "end": 2.0, "content": None},
                                     "hero": {"start": 2.0, "end": 3.1, "content": None},
                                     "credits": {"start": 3.1, "end": 4.0, "content": None}},
            "pieces": [{"part": "cold-open", "src": {"start": 0.0, "end": N / FPS}, "speed": 1.0, "outStart": 0,
                        "outFrames": N, "anchor": None, "game": {"gain": 0.5, "keep": []}}],
            "effects": [], "cuts": [], "log": [], "stats": {}}


def orange(a):
    a = a.astype(np.int32)
    return (a[:, :, 0] > 170) & (a[:, :, 0] - a[:, :, 2] > 100)


@unittest.skipIf(np is None, "numpy / OpenCV / PyAV not installed")
class SlotTests(unittest.TestCase):
    """fill() on the planner's real plan (the BD3 fixtures) and on the mini plan: data only."""

    def setUp(self):
        import beatdrop  # noqa: PLC0415
        import beatdrop_titles as bt  # noqa: PLC0415
        self.bd, self.bt = beatdrop, bt
        self.cfg = beatdrop.load_config()
        self.game = beatdrop.load_game("codm")

    def test_title_on_downbeats_and_schema(self):
        import reel_style as rs  # noqa: PLC0415
        import test_beatdrop as tb  # noqa: PLC0415
        pl = self.bd.plan(tb.moments_doc(), tb.smap_fixture(), max_sec=60)
        self.bt.fill(pl, RECORD, "Test Brand", "TestPlayer", self.cfg, self.game)
        c = pl["slots"]["title"]["content"]
        drop = pl["song"]["dropAt"]
        bar = 4 * pl["song"]["period"]
        pres, title = c["lines"]
        self.assertEqual(pres["text"], "Test Brand presents")
        self.assertEqual(title["text"], "Click Drop")
        self.assertEqual(title["from"], round((drop - bar) * FPS), "the song title enters on the intro's last downbeat")
        self.assertEqual(title["to"], round(drop * FPS))
        self.assertEqual(pres["from"], round(pl["slots"]["title"]["start"] * FPS))
        self.assertIn(pl["slots"]["title"]["start"], pl["song"]["downbeats"])
        with open(os.path.join(REPO, "data", "schemas", "beatdrop-plan.schema.json"), encoding="utf-8") as f:
            self.assertEqual(rs.schema_problems(pl, json.load(f), "plan"), [])

    def test_credits_equal_the_music_record_credit(self):
        import montage_music as mm  # noqa: PLC0415
        pl = mini_plan()
        self.bt.fill(pl, RECORD, "Test Brand", "TestPlayer", self.cfg, self.game)
        c = pl["slots"]["credits"]["content"]
        want = mm.credit_text(RECORD["credit"])
        self.assertEqual(c["musicCredit"], want)
        self.assertEqual("\n".join(c["lines"][:len(want.split("\n"))]), want)
        self.assertEqual(c["lines"][-1], self.cfg["titles"]["madeWith"])
        self.assertIn("Clips and edit: Test Brand", c["lines"])
        self.assertEqual(pl["slots"]["hero"]["content"]["name"], "TestPlayer")
        self.assertEqual(sum(1 for e in pl["effects"] if e["fn"] == "hero-bw"), 1)

    def test_long_credit_wraps_inside_the_frame(self):
        # Codex BD5 review: a long credit line (max artist + title, a link) stays inside a 9:16 frame, every character kept
        prm, lk = self.bt.params(self.cfg)["credits-roll"], self.bt.look_of(self.game)
        frame = {"width": 1080, "height": 1920}
        lines = ["Music: " + "Artist Name " * 10 + "- " + "Song Title Words " * 9, "Watch: https://youtu.be/" + "x" * 90,
                 "WMWMWMWM " * 12 + "W" * 60, self.cfg["titles"]["madeWith"]]
        rows, size = self.bt.credit_layout(lines, prm, lk, frame)
        width = self.bt.text_width(lk["textFont"])  # the font's own advance widths (wide W and M included)
        for text, _ in rows:
            self.assertLessEqual(width(text, size) + 2 * max(1.0, size * 0.06), 0.92 * 1080 + 1e-6, text)
        for i, line in enumerate(lines):
            self.assertEqual("".join(t for t, j in rows if j == i).replace(" ", ""), line.replace(" ", ""))
        bottom = float(prm["y"]) * 1920 + (len(rows) - 1) * float(prm["lineGap"]) * size + 0.6 * size
        self.assertLessEqual(bottom, 0.96 * 1920)
        print(f"BD5 credits on 9:16: {len(lines)} lines -> {len(rows)} rows at {size:.1f} px")
        # a long unspaced word with combining marks is never cut between a base letter and its mark
        word = "é" * 200
        for r, _ in self.bt.credit_layout([word], prm, lk, frame)[0]:
            self.assertNotEqual(unicodedata.category(r[0]), "Mn", "a row starts with a lone combining mark")
        # a credit that cannot fit whole even at the smallest size fails (the render fails, nothing is posted cut)
        from clip_common import ClipError  # noqa: PLC0415
        with self.assertRaises(ClipError):
            self.bt.credit_layout(["x"] * 400, prm, lk, frame)  # 400 rows pass the bottom even at 4 px
        # a short credit is not wrapped and keeps the preset size
        rows2, size2 = self.bt.credit_layout(["Song: A - B"], prm, lk, frame)
        self.assertEqual((rows2, size2), ([("Song: A - B", 0)], float(prm["sizeOfHeight"]) * 1920))

    def test_placeholder_profile_and_no_credit(self):
        b, p = self.bt.profile_names(os.path.join(REPO, "data", "profile.example.json"))
        self.assertEqual((b, p), (None, None), "placeholders are never drawn")
        pl = mini_plan()
        log = self.bt.fill(pl, {"source": "made-here"}, b, p, self.cfg, self.game)
        self.assertIsNone(pl["slots"]["title"]["content"])
        self.assertIsNone(pl["slots"]["credits"]["content"]["musicCredit"])
        self.assertEqual(pl["slots"]["credits"]["content"]["lines"], [self.cfg["titles"]["madeWith"]])
        self.assertTrue(any("no brand" in x for x in log) and any("no song title" in x for x in log))

    def test_timing_limits_from_the_manifests(self):
        prm = self.bt.params(self.cfg)
        for fn in ("title-extrude", "hero-bw", "credits-roll"):
            self.assertLess(self.bt.entrance_ms(fn, prm[fn], 1), 600, fn)
            self.assertLess(prm[fn]["outMs"], 400, fn)
            m = self.bd.bfx.manifest(fn)
            self.assertLess(m["params"]["safeRanges"]["inMs"][1], 600)
            self.assertLess(m["params"]["safeRanges"]["outMs"][1], 400)
            self.assertEqual(m["flashesPerSec"], 0)
        self.assertEqual(self.bd.bfx.manifest("title-pin")["flashesPerSec"], 0)

    def test_frame_events_tile_the_libass_clock(self):
        prev = None
        for k in range(600):
            a, b = self.bt.frame_span(k)
            ms = round(1000 * k / 60)

            def cs(s):
                h, m, rest = s.split(":")
                return (int(h) * 3600 + int(m) * 60) * 100 + int(round(float(rest) * 100))
            self.assertTrue(cs(a) * 10 <= ms < cs(b) * 10, k)
            if prev is not None:
                self.assertEqual(prev, cs(a))
            prev = cs(b)


@unittest.skipIf(np is None, "numpy / OpenCV / PyAV not installed")
class TrackTests(unittest.TestCase):
    """track_plane on in-memory frames at the tracking size (no ffmpeg)."""

    def setUp(self):
        import beatdrop  # noqa: PLC0415
        import beatdrop_titles as bt  # noqa: PLC0415
        self.bt, self.cfg = bt, beatdrop.load_config()
        self.pp = bt.params(self.cfg)["title-pin"]
        self.tw = min(int(self.pp["trackWidth"]), W)
        self.th = int(round(self.tw * H / W))

    def _grey(self, noise=False):
        return [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in card_frames(self.tw, self.th, noise=noise)]

    def test_anchor_follows_the_card_within_max_err(self):
        k = W / self.tw
        hs, info = self.bt.track_plane(self._grey(), (ANCHOR[0] / k, ANCHOR[1] / k), self.pp)
        self.assertIsNotNone(hs, info)
        errs = []
        for i, hm in enumerate(hs):
            x, y, s, _ = self.bt.transform_at(hm, ANCHOR[0] / k, ANCHOR[1] / k)
            tx, ty, ts = truth(i)
            errs.append(((x * k - tx) ** 2 + (y * k - ty) ** 2) ** 0.5)
        print(f"BD5 track: {info['points']} points, worst inlier share {info['worstInlierRatio']}, "
              f"max error {max(errs):.2f} px over {len(hs)} frames (limit {self.pp['maxErrPx']} px), final scale {s:.3f} (true {ts:.3f})")
        self.assertLessEqual(max(errs), float(self.pp["maxErrPx"]))
        self.assertAlmostEqual(s, ts, delta=0.02)

    def test_noise_falls_back_with_a_log_line(self):
        pl = mini_plan()
        import beatdrop as bd  # noqa: PLC0415
        self.bt.fill(pl, RECORD, "Test Brand", "TestPlayer", self.cfg, bd.load_game("codm"))
        frames = self._grey(noise=True)
        log = self.bt.pin(pl, None, None, None, {"width": W, "height": H}, self.cfg,
                          decode=lambda p, n, size: frames[:n])
        segs = [s for ln in pl["slots"]["title"]["content"]["lines"] for s in ln["segments"]]
        self.assertTrue(segs and all(s["place"] == "screen" for s in segs))
        self.assertTrue(log and all("low tracking confidence" in x for x in log), log)
        print("BD5 fallback log:", log[0])

    def test_moving_effect_under_the_pin_falls_back(self):
        # Codex BD5 review: the pin is tracked before the effects, so a zoom/slide under the title gets screen space
        import beatdrop as bd  # noqa: PLC0415
        pl = mini_plan()
        self.bt.fill(pl, RECORD, "Test Brand", "TestPlayer", self.cfg, bd.load_game("codm"))
        last = pl["slots"]["title"]["content"]["lines"][-1]
        at = (last["from"] + 5) / FPS
        pl["effects"].append({"fn": "shot-shake", "at": at, "params": bd.bfx.params_for("shot-shake")})
        frames = self._grey()
        log = self.bt.pin(pl, None, None, None, {"width": W, "height": H}, self.cfg,
                          decode=lambda p, n, size: frames[:n])
        self.assertEqual([s["place"] for s in last["segments"]], ["screen"])
        self.assertTrue(any("moving effect (shot-shake)" in x for x in log), log)
        self.assertIn(("shot-shake", at, at + bd.bfx.params_for("shot-shake")["frames"] / FPS),
                      bd.bfx.moving_windows(pl["effects"]))
        # the same plan without the shake keeps the pin (the card is trackable)
        pl2 = mini_plan()
        self.bt.fill(pl2, RECORD, "Test Brand", "TestPlayer", self.cfg, bd.load_game("codm"))
        self.bt.pin(pl2, None, None, None, {"width": W, "height": H}, self.cfg, decode=lambda p, n, size: frames[:n])
        self.assertEqual([s["place"] for s in pl2["slots"]["title"]["content"]["lines"][-1]["segments"]], ["pin"])


@unittest.skipIf(np is None, "numpy / OpenCV / PyAV not installed")
class GuardAndCleanupTests(unittest.TestCase):
    """Codex review of the BD5 tree: on-air guard inside tracking, cleanup on every path, no zoom snap."""

    def setUp(self):
        import beatdrop  # noqa: PLC0415
        import beatdrop_titles as bt  # noqa: PLC0415
        self.bd, self.bt = beatdrop, bt
        self.tmp = tempfile.mkdtemp(prefix="ujw-bd5g-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_tracking_stops_on_air_between_frames(self):
        pp = self.bt.params(self.bd.load_config())["title-pin"]
        frames = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in card_frames(480, 270)]
        calls = []

        def stop():
            calls.append(1)
            return len(calls) >= 3
        with self.assertRaises(self.bd.OnAir):
            self.bt.track_plane(frames, (240, 81), pp, stop=stop)
        self.assertEqual(len(calls), 3, "stopped at the third frame, not after the whole clip")

    def _own_files(self):
        os.makedirs(os.path.join(self.tmp, self.bt.FONT_SUBDIR), exist_ok=True)
        for f in (self.bt.ASS_FILE, self.bt.TRACK_FILE, os.path.join(self.bt.FONT_SUBDIR, "Anton-Regular.ttf")):
            with open(os.path.join(self.tmp, f), "w", encoding="utf-8") as fh:
                fh.write("Test Brand")

    def _gone(self):
        for f in (self.bt.ASS_FILE, self.bt.TRACK_FILE, self.bt.FONT_SUBDIR):
            self.assertFalse(os.path.exists(os.path.join(self.tmp, f)), f)

    def test_any_error_removes_the_title_files(self):
        from unittest import mock  # noqa: PLC0415

        def boom(res, *a, **k):
            self._own_files()
            raise RuntimeError("boom")
        os.makedirs(os.path.join(self.tmp, "lock"), exist_ok=True)  # make() expects the lock folder (as _make does)
        with mock.patch.object(self.bd, "_make_locked", boom):
            with self.assertRaises(RuntimeError):
                self.bd.make("rec.mkv", {}, self.tmp, self.tmp, "ffmpeg", [], [], live=lambda: False,
                             lock_dir=os.path.join(self.tmp, "lock"))
        self._gone()

    def test_decode_failure_removes_the_raw_file(self):
        from unittest import mock  # noqa: PLC0415
        import clip_common  # noqa: PLC0415

        def fake(argv, **k):
            with open(argv[-1], "wb") as fh:
                fh.write(b"\0" * 10)
            raise TimeoutError("decode timed out")
        piece = {"src": {"start": 0.0, "end": 1.0}, "speed": 1.0}
        with mock.patch.object(clip_common, "run_tool", fake):
            with self.assertRaises(TimeoutError):
                self.bt.decode_piece("ffmpeg", "rec.mkv", piece, 10, (32, 18), self.tmp)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, self.bt.TRACK_FILE)))

    def test_hero_push_eases_out_without_a_snap(self):
        import math  # noqa: PLC0415
        import re as _re  # noqa: PLC0415
        p = self.bd.bfx.params_for("hero-bw", preset_id="hero-bw-push")
        g = self.bd.bfx.graph([{"fn": "hero-bw", "at": 2.0, "end": 4.0, "params": p}], {"width": 64, "height": 36})
        z = _re.search(r"zoompan=z='([^']+)'", g).group(1)
        env = {"between": lambda x, a, b: float(a <= x <= b), "gt": lambda a, b: float(a > b),
               "lte": lambda a, b: float(a <= b), "cos": math.cos, "sin": math.sin, "PI": math.pi, "min": min}
        zs = [eval(z, {"__builtins__": {}}, dict(env, it=k / 60)) for k in range(100, 260)]  # noqa: S307 - our own expression
        steps = [abs(b - a) for a, b in zip(zs, zs[1:])]
        print(f"BD5 hero zoom: peak {max(zs):.4f}, largest step per frame {max(steps):.5f}, at the end {zs[-1]:.4f}")
        self.assertAlmostEqual(max(zs), p["push"], delta=0.01)
        self.assertLess(max(steps), 0.01, "no snap back to 1x")
        self.assertAlmostEqual(eval(z, {"__builtins__": {}}, dict(env, it=4.0)), 1.0, places=4)  # noqa: S307


@unittest.skipIf(np is None or not HAVE_TOOLS, "needs numpy/OpenCV/PyAV, ffmpeg, ffprobe and node")
class RenderedTitlesTests(unittest.TestCase):
    """The mini plan rendered (640x360, 3 s, CPU) and measured back from its frames."""

    @classmethod
    def setUpClass(cls):
        import beatdrop as bd  # noqa: PLC0415
        import beatdrop_titles as bt  # noqa: PLC0415
        import clip_render as rnd  # noqa: PLC0415
        cls.tmp = tempfile.mkdtemp(prefix="ujw-bd5-")
        cls.rec = os.path.join(cls.tmp, "card.mkv")
        write_clip(cls.rec)
        cfg, game = bd.load_config(), bd.load_game("codm")
        cls.pl = pl = mini_plan()
        bt.fill(pl, RECORD, "Test Brand", "TestPlayer", cfg, game)
        cls.pin_log = bt.pin(pl, cls.rec, "ffmpeg", cls.tmp, {"width": W, "height": H}, cfg)
        titles = bt.prepare(cls.tmp, pl, {"width": W, "height": H}, cfg, game)
        cls.argv = bd.render_argv(pl, "ffmpeg", cls.rec, {"width": W, "height": H}, rnd.ENCODERS["libopenh264"],
                                  rnd.AUDIO, None, "out.mp4", titles=titles)
        cls.proc = subprocess.run(cls.argv, cwd=cls.tmp, capture_output=True, text=True, timeout=600, creationflags=NOWIN)
        cls.video = os.path.join(cls.tmp, "out.mp4")
        cls.frames = []
        if cls.proc.returncode == 0:
            with av.open(cls.video) as c:
                cls.frames = [f.to_ndarray(format="rgb24") for f in c.decode(c.streams.video[0])]
        cls.prm = bt.params(cfg)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.assertEqual(self.proc.returncode, 0, self.proc.stderr[-1500:])

    def _orange_counts(self):
        return [int(orange(f[: int(0.6 * H)]).sum()) for f in self.frames]

    def test_title_lines_enter_on_their_downbeats(self):
        lines = self.pl["slots"]["title"]["content"]["lines"]
        cnt = self._orange_counts()
        on = [i for i in range(len(cnt)) if cnt[i] > 20 and (i == 0 or cnt[i - 1] <= 20)]
        want = [ln["from"] for ln in lines]
        print(f"BD5 title onsets (frames): rendered {on}, downbeats {want}; pin segments "
              f"{[s['place'] for ln in lines for s in ln['segments']]}; log {self.pin_log}")
        self.assertEqual(len(on), 2, on)
        for got, w in zip(on, want):
            self.assertLessEqual(abs(got - w), 1)

    def test_entrance_and_exit_times(self):
        lines = self.pl["slots"]["title"]["content"]["lines"]
        pe = self.prm["title-extrude"]
        out = []
        for ln in lines:
            widths = []
            for k in range(ln["from"], ln["to"]):
                xs = np.flatnonzero(orange(self.frames[k][: int(0.6 * H)]).any(axis=0))
                widths.append(int(xs[-1] - xs[0]) if xs.size else 0)
            settled = widths[min(len(widths) - 1, int(pe["inMs"] / 1000 * FPS) + 6):]
            ref = float(np.median(settled))
            # entrance: the slam has the text larger than its settled size until it is in
            ent = next(i for i, wd in enumerate(widths) if abs(wd - ref) <= max(3, 0.03 * ref))
            cnt = [int(orange(self.frames[k][: int(0.6 * H)]).sum()) for k in range(ln["from"], ln["to"])]
            full = float(np.median(cnt[len(cnt) // 3: 2 * len(cnt) // 3]))
            # exit: from the last frame at full strength to the first frame without the text
            last_full = max(i for i, c in enumerate(cnt) if c >= 0.9 * full)
            gone = next((i for i in range(last_full, len(cnt)) if cnt[i] <= 20), len(cnt))
            out.append((ln["role"], round(ent / FPS * 1000), round((gone - last_full) / FPS * 1000)))
        print(f"BD5 measured entrance/exit ms (role, entrance, exit): {out}")
        for _, ent, ex in out:
            self.assertLess(ent, 600)
            self.assertLess(ex, 400)

    def test_pinned_title_follows_the_card(self):
        ln = self.pl["slots"]["title"]["content"]["lines"][1]
        seg = ln["segments"][0]
        self.assertEqual(seg["place"], "pin", self.pin_log)
        k0 = ln["from"] + int(self.prm["title-extrude"]["inMs"] / 1000 * FPS) + 2
        k1 = ln["to"] - int(self.prm["title-extrude"]["outMs"] / 1000 * FPS) - 2

        def centre(k):
            ys, xs = np.nonzero(orange(self.frames[k][: int(0.6 * H)]))
            return xs.mean(), ys.mean()
        c0, t0 = centre(k0), truth(k0)
        errs = []
        for k in range(k0, k1):
            c, t = centre(k), truth(k)
            errs.append((((c[0] - c0[0]) - (t[0] - t0[0])) ** 2 + ((c[1] - c0[1]) - (t[1] - t0[1])) ** 2) ** 0.5)
        lim = float(self.prm["title-pin"]["maxErrPx"])
        print(f"BD5 rendered pin: max {max(errs):.2f} px, mean {sum(errs) / len(errs):.2f} px over frames {k0}-{k1 - 1} "
              f"(card moved {truth(k1)[0] - t0[0]:.0f} px, limit {lim} px)")
        self.assertLessEqual(max(errs), lim)

    def test_hero_black_and_white_and_name_and_credits(self):
        hc, cc = self.pl["slots"]["hero"]["content"], self.pl["slots"]["credits"]["content"]
        ph = self.prm["hero-bw"]

        def spread(k):
            f = self.frames[k][: int(0.5 * H)].astype(np.int32)
            return float(np.mean(f.max(axis=2) - f.min(axis=2)))

        def white(k, y0, y1):
            f = self.frames[k][int(y0 * H):int(y1 * H)].astype(np.int32)
            return int(((f.min(axis=2) > 200)).sum())
        before = spread(hc["from"] - 3)
        inside = max(spread(k) for k in range(hc["from"] + int(ph["inMs"] / 1000 * FPS) + 1, hc["to"] - int(ph["outMs"] / 1000 * FPS)))
        name_px = white(hc["from"] + 40, ph["nameY"] - 0.08, ph["nameY"] + 0.08)
        # credits measured settled: after every line's staggered entrance, before the exit fade starts
        cred_px = white(cc["to"] - int(self.prm["credits-roll"]["outMs"] / 1000 * FPS) - 2, 0.25, 0.75)
        print(f"BD5 hero: colour spread {before:.1f} before, max {inside:.1f} inside (after the fade); name {name_px} px; "
              f"credits {cred_px} px; lines {cc['lines']}")
        self.assertGreater(before, 30)
        self.assertLess(inside, 6)
        self.assertGreater(name_px, 30)
        self.assertGreater(cred_px, 100)

    def test_flash_limit_and_one_audio_encode(self):
        import test_beatdrop as tb  # noqa: PLC0415
        m = tb.flash_measure(self.video)
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", self.video],
                           capture_output=True, text=True, creationflags=NOWIN)
        kinds = [s["codec_type"] for s in json.loads(r.stdout)["streams"]]
        print(f"BD5 flash: peak {m['peakFlashesPerSecond']} flashes/s (limit {m['limit']}); audio streams {kinds.count('audio')}, "
              f"-c:a in argv {self.argv.count('-c:a')}")
        self.assertTrue(m["pass"])
        self.assertEqual(kinds.count("audio"), 1)
        self.assertEqual(self.argv.count("-c:a"), 1)


if __name__ == "__main__":
    unittest.main()
