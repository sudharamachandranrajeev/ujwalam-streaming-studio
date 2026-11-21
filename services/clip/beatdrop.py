# SPDX-License-Identifier: GPL-3.0-or-later
"""BD3 beat-locked edit planner (D415, plan docs/plan/2026-11-21-beatdrop-montages.md sections 1.3 and 5).

Takes a recording's BD1 moments (moments.py), a BD2 song map (song_map.py) and an optional reel style (RS1/RS2, its
mapped "cuts": shotSec, ratePerMin, beatShare) and builds a montage plan (data; schema
data/schemas/beatdrop-plan.schema.json):

- cold open: calm pieces (third person, scope, any stretch with no kill or gunshot), cut on downbeats only, slowed;
- a title slot over the intro's last bars (empty placeholder for BD5);
- the strongest kill exactly on the first drop; then kills and gunshots on beats, flicks/slides/jumps on off-beats
  (share from the style's beat share);
- breakdowns: calm slow-motion pieces cut on downbeats, letterbox;
- outro: a hero slot and a credits slot (placeholders for BD5) over calm slow pieces.

Retiming: every piece is a whole number of output frames (60 fps) between beat-grid frames, so joins never drift; an
anchored piece's source window is placed so its kill/gunshot frame lands on its target beat's frame, at speed 1 or
slowed (never outside 0.5x-2x; when it does not fit, the next moment is tried). A ragdoll slow motion (speed-ramp) only
starts at the kill frame, so the kill stays on its beat.

Sound: the game is ducked under the music (per piece gain) with short cut-outs kept at full level around each gunshot
and kill; the song is the bed from the plan's songStart; one audio encode with the D411 limiter
(clip_montage.render_argv, extended, not forked). Effects (BD4) are listed in the plan and drawn by beatdrop_fx.

Music: the NCS library (montage_music.pick, seeded, no repeat of the last N) when Settings > Clips > Montage music is on
with a folder; else the made-here bed (reel_music). The render always writes the music record.
Real footage UNVERIFIED (synthetic fixtures only: tests/py/test_beatdrop.py).
"""

from __future__ import annotations

import bisect
import os
import re
import statistics

import beatdrop_fx as bfx
from clip_common import CLIP_DATA, ClipError, load_json, on_air

_HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(CLIP_DATA, "beatdrop.json")
GAMES = os.path.normpath(os.path.join(_HERE, "..", "..", "data", "games"))
PLAN = "beatdrop-plan.json"
GRAPH = "beatdrop-graph.txt"


def load_config(path=None):
    return load_json(path or CONFIG_FILE)


def load_game(game="codm", path=None):
    return load_json(path or os.path.join(GAMES, game, "beatdrop.json"))


def targets(style, cfg):
    """Target pace: the reel style's measured numbers when a style is chosen, else the defaults in the data file."""
    t = {k: cfg["targets"][k] for k in ("shotSec", "cutsPerMin", "beatShare")}
    c = (style or {}).get("cuts") or {}
    used = False
    if c.get("shotSec"):
        t["shotSec"], used = float(c["shotSec"]), True
    if c.get("ratePerMin"):
        t["cutsPerMin"], used = float(c["ratePerMin"]), True
    if c.get("beatShare") is not None:
        t["beatShare"], used = float(c["beatShare"]), True
    t["source"] = f"style:{(style or {}).get('id') or 'chosen'}" if used else "defaults"
    return t


class _Planner:
    def __init__(self, moments_doc, smap, cfg, game, style, max_sec, rec_seconds, luma=None):
        self.cfg, self.game = cfg, game
        self.luma = luma  # source seconds -> relative luminance 0..1 (LumaProbe), or None (no cut check)
        self.log = []
        self.fps = int(cfg["fps"])
        self.rfps = float(moments_doc["fps"])
        self.rec_len = float(rec_seconds or moments_doc["seconds"])
        ms = moments_doc["moments"]
        st = self.st = lambda m: m["frame"] / self.rfps  # noqa: E731 - the moment's source time from its frame
        self.kills = sorted((m for m in ms if m["kind"] == "kill"), key=lambda m: (-m["strength"], m["frame"]))
        margin = float(game["noKillMarginSec"])
        self.killish = sorted(st(m) for m in ms if m["kind"] in ("kill", "gunshot", "hit", "killcam"))
        self.sounds = sorted(st(m) for m in ms if m["kind"] in ("kill", "gunshot"))
        self.kill_ts = sorted(st(m) for m in ms if m["kind"] == "kill")
        self.shot_ts = sorted(st(m) for m in ms if m["kind"] == "gunshot")
        self.scopes = sorted(st(m) for m in ms if m["kind"] == "scope-in")
        shots = sorted((m for m in ms if m["kind"] == "gunshot" and all(abs(st(m) - st(k)) > margin for k in self.kills)),
                       key=lambda m: (-m["strength"], m["frame"]))
        self.on_queue = (self.kills if "kill" in game["onBeatKinds"] else []) + \
            (shots if "gunshot" in game["onBeatKinds"] else [])
        self.offs = sorted((m for m in ms if m["kind"] in game["offBeatKinds"]), key=lambda m: (-m["strength"], m["frame"]))
        self.calms = sorted(st(m) for m in ms if m["kind"] in game["calmKinds"])
        self.margin = margin
        self.tg = targets(style, cfg)
        self.smap = smap
        self.max_sec = float(max_sec or cfg["maxSec"])
        self.used = []  # source spans already in the montage
        self.taken = set()
        self.pieces, self.effects = [], []
        self.song0 = 0.0

    # ---------------------------------------------------------------- helpers
    def F(self, song_t):  # song seconds -> output frame
        return int(round((song_t - self.song0) * self.fps))

    def _free(self, a, b):
        return all(b <= u0 or a >= u1 for u0, u1 in self.used)

    def _no_kill(self, a, b):
        i = bisect.bisect_left(self.killish, a - self.margin)
        return i >= len(self.killish) or self.killish[i] > b + self.margin

    def _keep(self, s0, s1, speed):
        a = self.cfg["audio"]
        out = []
        for t in self.sounds:
            if s0 <= t <= s1:
                lo = (t - s0) / speed
                out.append([round(max(0.0, lo - a["keepPreSec"]), 4), round(lo + a["keepPostSec"], 4)])
        return out

    def _add(self, part, f0, f1, s0, speed, anchor=None, gain=None, keep=None, ramp=None):
        n = f1 - f0
        s1 = s0 + n / self.fps * speed
        self.used.append((s0, s1))
        p = {"part": part, "src": {"start": round(s0, 4), "end": round(s1, 4)}, "speed": round(speed, 4),
             "outStart": f0, "outFrames": n, "anchor": anchor,
             "game": {"gain": float(gain if gain is not None else self.cfg["audio"]["gameGain"]),
                      "keep": keep if keep is not None else self._keep(s0, s1, speed)}}
        if ramp:
            p["ramp"] = ramp
        self.pieces.append(p)
        return p

    def calm(self, part, f0, f1, speed):
        """A calm piece (no kill or gunshot inside): near a calm moment first, else any free stretch."""
        if f1 <= f0:
            return None
        sp_min = float(self.cfg["speed"]["min"])
        starts = [max(0.0, c - 0.2) for c in self.calms] + [k * 0.5 for k in range(int(self.rec_len / 0.5) + 1)]
        for reuse in (False, True):
            s = speed
            while s >= sp_min - 1e-9:
                ln = (f1 - f0) / self.fps * s
                for a in starts:
                    b = a + ln
                    if b <= self.rec_len - 1.0 / self.rfps and self._no_kill(a, b) and (reuse or self._free(a, b)):
                        return self._add(part, f0, f1, a, s, gain=self.cfg["audio"]["calmGain"], keep=[])
                s = round(s - 0.125, 4)
        raise ClipError("beatdrop: the recording has no calm stretch (no kill or gunshot) long enough for the cold open")

    def fit(self, m, f0, fa, f1):
        """The source start and speed that put moment m's frame on output frame fa, inside [f0, f1), or None."""
        if id(m) in self.taken:
            return None
        sa = self.st(m)
        pre, post = (fa - f0) / self.fps, (f1 - fa) / self.fps
        if any(u0 <= sa <= u1 for u0, u1 in self.used):
            return None
        lo = max([0.0] + [u1 for u0, u1 in self.used if u1 <= sa])
        hi = min([self.rec_len - 1.0 / self.rfps] + [u0 for u0, u1 in self.used if u0 >= sa])
        # no other kill (either side) and no gunshot of another moment (before the anchor, beyond the margin that ties
        # a gunshot to this kill) inside the piece: it would land off the beat (D415 review). Too short at 0.5x: the
        # next moment is tried.
        eps = 1.5 / self.rfps
        lo = max([lo] + [t + eps for t in self.kill_ts if t < sa - 1e-6]
                 + [t + eps for t in self.shot_ts if t < sa - self.margin])
        hi = min([hi] + [t - eps for t in self.kill_ts if t > sa + 1e-6])
        s = 1.0
        if pre > 0:
            s = min(s, (sa - lo) / pre)
        if post > 0:
            s = min(s, (hi - sa) / post)
        sp = self.cfg["speed"]
        if s < float(sp["min"]) or s > float(sp["max"]):
            return None
        return sa - pre * s, s

    def anchored(self, part, queue, f0, fa, f1, beat):
        for m in queue:
            r = self.fit(m, f0, fa, f1)
            if r:
                s0, s = r
                self.taken.add(id(m))
                return self._add(part, f0, f1, s0, s, anchor={
                    "kind": m["kind"], "frame": m["frame"], "srcT": round(self.st(m), 4), "outFrame": fa,
                    "outT": round(fa / self.fps, 4), "onBeat": beat, "strength": m["strength"]})
        return None

    def fx(self, fn, at, **extra):
        e = {"fn": fn, "at": round(at, 4), "params": bfx.params_for(fn, preset_id=self.cfg["effects"][fn])}
        e.update(extra)
        self.effects.append(e)
        return e

    # ---------------------------------------------------------------- the plan
    def build(self):
        cfg, sm = self.cfg, self.smap
        beats, downs = list(sm["beats"]), list(sm["downbeats"])
        period = float(sm["period"])
        bar = period * int(sm["beatsPerBar"])
        co = cfg["coldOpen"]
        if not self.on_queue:
            raise ClipError("beatdrop: no kill or gunshot moments in this recording")
        # the song's first drop wins (D415 review): coldOpen.minSec is a soft target, an earlier drop shortens the cold
        # open (logged); only a drop too early for any intro (< coldOpen.minBars bars) is missed, recorded with the reason,
        # and the kill goes on the next drop. The later drop is never called the first drop (song.firstDrop null).
        min_intro = int(co["minBars"]) * bar
        drops = sorted(float(d) for d in sm.get("drops") or [])
        self.missed = None
        drop = None
        for d in drops:
            if d >= min_intro - 1e-6:
                drop = d
                break
            if self.missed is None:
                self.missed = {"at": round(d, 4), "reason": f"the song's first drop at {d:.2f} s is earlier than the "
                               f"shortest intro ({int(co['minBars'])} bars, {min_intro:.2f} s): the kill is on the next drop"}
                self.log.append("firstDropMissed: " + self.missed["reason"])
        if drop is None:
            drop = next((d for d in downs if d >= float(co["minSec"])), None)
            if drop is None:
                raise ClipError("beatdrop: the song has no drop or downbeat after the cold open's minimum length")
        elif drop < float(co["minSec"]):
            self.log.append(f"cold open shortened to {drop:.2f} s (target {float(co['minSec']):g} s): the song's first "
                            f"drop comes earlier")
        self.first_drop = drop if drops and self.missed is None else None
        drop = min(beats, key=lambda b: abs(b - drop))  # the drop on the grid
        if drop > float(co["maxSec"]):  # a long intro: the song starts later, on a downbeat
            self.song0 = min(d for d in downs if drop - d <= float(co["maxSec"]))
        bi = beats.index(drop)
        lead = int(co["leadBeats"])
        cut_drop = beats[bi - lead] if bi - lead >= 0 else self.song0
        oc = cfg["outro"]
        outro_bars = int(oc["heroBars"]) + int(oc["creditsBars"])
        song_end_cap = min(float(sm["duration"]), self.song0 + self.max_sec)
        ends = [d for d in downs if d <= song_end_cap and d - outro_bars * bar > drop + bar]
        if not ends:
            raise ClipError("beatdrop: the song is too short for a drop, a body and an outro")
        song_end = ends[-1]
        outro0 = song_end - outro_bars * bar
        outro0 = min(downs, key=lambda d: abs(d - outro0))

        # cold open: downbeat cuts merged to about coldOpen.shotSec, then the lead-in cut before the drop
        cuts = [self.song0] + [d for d in downs if self.song0 < d < cut_drop - period / 2]
        merged = [cuts[0]]
        for c in cuts[1:]:
            if c - merged[-1] >= float(co["shotSec"]) - 1e-6:
                merged.append(c)
        if cut_drop - merged[-1] < period * 0.99 and len(merged) > 1:
            merged.pop()
        merged.append(cut_drop)
        for a, b in zip(merged, merged[1:]):
            self.calm("cold-open", self.F(a), self.F(b), float(co["speed"]))
        title_bars = int(cfg["title"]["bars"])
        slots = {"title": {"start": round(max(0.0, drop - title_bars * bar - self.song0), 4),
                           "end": round(drop - self.song0, 4), "content": None}}
        self.fx("letterbox", 0.0, end=round(self.F(cut_drop) / self.fps, 4))

        # the drop: the strongest kill exactly on it
        n = max(1, int(round(float(self.tg["shotSec"]) / period)))
        oi = beats.index(outro0) if outro0 in beats else bisect.bisect_left(beats, outro0)
        first_end = min(bi + max(n - lead, 1), oi)
        p = self.anchored("drop", self.kills or self.on_queue, self.F(cut_drop), self.F(drop), self.F(beats[first_end]), True)
        if p is None:
            raise ClipError("beatdrop: no kill fits on the first drop")
        self._on_anchor(p, first=True)
        j = first_end
        n_on, n_off, kills_on = 1, 0, 1
        offs_share = 1.0 - float(self.tg["beatShare"])
        secs = sm.get("sections") or []
        while j < oi:
            t = beats[j]
            sec = next((s for s in secs if s["start"] - 1e-6 <= t < s["end"] - 1e-6), None)
            if sec and sec["kind"] == "breakdown":
                nd = next((d for d in downs if d > t + period / 2), None)
                stop = min(nd if nd is not None else beats[oi], sec["end"], beats[oi])
                stop = min(beats, key=lambda b: abs(b - stop))
                if stop <= t:
                    stop = beats[min(j + 1, oi)]
                self.calm("breakdown", self.F(t), self.F(stop), float(cfg["breakdown"]["speed"]))
                self.fx("letterbox", round(self.F(t) / self.fps, 4), end=round(self.F(stop) / self.fps, 4))
                j = beats.index(stop)
                continue
            if self.offs and (n_off + 1) / (n_on + n_off + 1) <= offs_share + 1e-9 and j + 1 <= oi:
                f0, f1 = self.F(t), self.F(beats[j + 1])
                fa = self.F(t + period / 2)
                p = self.anchored("body", self.offs, f0, fa, f1, False)
                if p:
                    if f0 > 0:
                        self.fx("whip-pan", f0 / self.fps)
                    n_off += 1
                    j += 1
                    continue
            k = min(n, oi - j)
            ai = j + (1 if k >= 2 else 0)
            p = self.anchored("body", self.on_queue, self.F(t), self.F(beats[ai]), self.F(beats[j + k]), True)
            if p is None:  # out of moments: the outro starts at the next downbeat (calm until then)
                nd = next((d for d in downs if d >= t - 1e-6), outro0)
                if nd > t:
                    self.calm("body", self.F(t), self.F(nd), 1.0)
                song_end = min(float(sm["duration"]), nd + outro_bars * bar)
                song_end = max((d for d in downs if d <= song_end + 1e-6), default=song_end)
                outro0 = nd
                break
            if p["anchor"]["kind"] == "kill":
                kills_on += 1
            self._on_anchor(p, kill_no=kills_on)
            n_on += 1
            j += k
        # outro: hero slot and credits slot over calm slow pieces
        hero_end = outro0 + int(oc["heroBars"]) * bar
        hero_end = min(downs + [song_end], key=lambda d: abs(d - hero_end))
        self.calm("outro", self.F(outro0), self.F(hero_end), float(oc["heroSpeed"]))
        if song_end > hero_end:
            self.calm("outro", self.F(hero_end), self.F(song_end), float(oc["heroSpeed"]))
        slots["hero"] = {"start": round(self.F(outro0) / self.fps, 4), "end": round(self.F(hero_end) / self.fps, 4), "content": None}
        slots["credits"] = {"start": round(self.F(hero_end) / self.fps, 4), "end": round(self.F(song_end) / self.fps, 4),
                            "content": None}
        self.fx("letterbox", round(self.F(outro0) / self.fps, 4), end=round(self.F(song_end) / self.fps, 4))
        self.fx("bloom-grade", 0.0)
        fl = cfg["flash"]
        cuts = self.cut_jumps()
        self.effects = bfx.space_flashes(self.effects, int(fl["maxPerSec"]), float(fl["minGapSec"]), cuts=cuts,
                                         soften_frames=int(fl["softenFrames"]))
        n_soft = sum(1 for c in cuts if c["softened"])
        if n_soft:
            self.log.append(f"{n_soft} hard cut(s) with a big brightness jump over the flash budget: softened with a "
                            f"{int(fl['softenFrames'])}-frame dissolve")
        total_f = self.F(song_end)
        reel_beats = [round((b - self.song0), 4) for b in beats if self.song0 <= b <= song_end]
        out = {"version": 1, "kind": "beatdrop", "status": "unverified", "fps": self.fps,
               "songStart": round(self.song0, 4), "total": round(total_f / self.fps, 4), "frames": total_f,
               "song": {"bpm": sm["bpm"], "period": period,
                        "firstDrop": round(drop - self.song0, 4) if self.first_drop is not None else None,
                        "dropAt": round(drop - self.song0, 4), "beats": reel_beats},
               "targets": self.tg, "slots": slots, "pieces": self.pieces, "effects": self.effects,
               "cuts": cuts, "log": self.log, "stats": stats(self.pieces, self.fps)}
        if self.missed:
            out["firstDropMissed"] = self.missed
        return out

    def cut_jumps(self):
        """Hard cuts whose relative luminance jumps by flash.cutDelta or more (darker side below flash.darkerBelow): the
        mean luminance at the outgoing piece's last frame and the incoming piece's first frame (self.luma, a cached low
        resolution probe of the recording, cached). -> [{"at" (reel s), "from", "to"}]; [] without a luma track."""
        if self.luma is None:
            return []
        fl = self.cfg["flash"]
        out = []
        for a, b in zip(self.pieces, self.pieces[1:]):
            la = float(self.luma(max(0.0, a["src"]["end"] - 1.0 / self.rfps)))
            lb = float(self.luma(b["src"]["start"]))
            if abs(la - lb) >= float(fl["cutDelta"]) and min(la, lb) < float(fl["darkerBelow"]):
                out.append({"at": round(b["outStart"] / self.fps, 4), "from": round(la, 4), "to": round(lb, 4)})
        return out

    def _on_anchor(self, p, first=False, kill_no=0):
        """Effects on an on-beat anchor: shake, an impact flash (re-spaced later), RGB split on the drop and every Nth
        kill, a scope push at the piece's end when the shot was scoped, a ragdoll slow motion on every Nth kill."""
        a = p["anchor"]
        t = a["outT"]
        self.fx("shot-shake", t)
        self.fx("impact-flash", t)
        if first or (a["kind"] == "kill" and kill_no % int(self.cfg["rgbSplitEvery"]) == 0):
            self.fx("rgb-split", t)
        s0 = p["src"]["start"]
        end_t = (p["outStart"] + p["outFrames"]) / self.fps
        if any(s0 <= sc <= a["srcT"] for sc in self.scopes):
            self.fx("scope-zoom-transition", end_t)
        if a["kind"] == "kill" and p["speed"] == 1.0 and (first or kill_no % int(self.cfg["ragdollEvery"]) == 0):
            e = bfx.params_for("ragdoll-slowmo", preset_id=self.cfg["effects"]["ragdoll-slowmo"])
            at = (a["outFrame"] - p["outStart"]) / self.fps
            g = float(e["catchUp"])
            end = at + e["sec"] + e["sec"] * (1.0 / e["factor"] - 1.0) * g / (g - 1.0)
            if end < p["outFrames"] / self.fps - 1.0 / self.fps:
                p["ramp"] = {"at": round(at, 4), "sec": e["sec"], "factor": e["factor"], "catchUp": g,
                             "catchUpEnd": round(end, 4), "audio": "sync"}
                self.fx("ragdoll-slowmo", t)


def stats(pieces, fps):
    """Planned pace: median shot, cuts per minute, share of anchors on a beat."""
    lens = [p["outFrames"] / fps for p in pieces]
    total = sum(lens)
    anchors = [p["anchor"] for p in pieces if p.get("anchor")]
    return {"pieces": len(pieces), "medianShotSec": round(statistics.median(lens), 3) if lens else None,
            "cutsPerMin": round((len(pieces) - 1) / total * 60.0, 1) if total else None,
            "onBeatShare": round(sum(1 for a in anchors if a["onBeat"]) / len(anchors), 3) if anchors else None,
            "kills": sum(1 for a in anchors if a["kind"] == "kill")}


def plan(moments_doc, smap, cfg=None, game=None, style=None, max_sec=None, rec_seconds=None, luma=None):
    """moments (moments.find_moments output) + song map (song_map.song_map output) [+ mapped reel style] -> plan.
    luma: source seconds -> relative luminance 0..1 (a LumaProbe), for the hard-cut flash check."""
    cfg = cfg or load_config()
    game = game or load_game(moments_doc.get("game") or "codm")
    return _Planner(moments_doc, smap, cfg, game, style, max_sec, rec_seconds, luma).build()


LUMA_CACHE = "beatdrop-luma.json"
PROBE_FILE = "beatdrop-probe.rgb"


class OnAir(ClipError):
    """A stream or recording started (or that cannot be told) during a BeatDrop step: the whole job stops."""
_LIN = [(c / 255 / 12.92) if c / 255 <= 0.04045 else ((c / 255 + 0.055) / 1.055) ** 2.4 for c in range(256)]


class LumaProbe:
    """Mean relative luminance (WCAG, linear light; the fx test's definition, flash-detect.mjs) of the recording at a
    source time: one small seek and decode (16x9 rgb24, one frame) per cut edge, rounded to 1/lumaFps s and cached in
    <cache_dir>/beatdrop-luma.json keyed by the file's size and mtime. Call save() after planning."""

    W, H = 16, 9

    def __init__(self, ffmpeg, recording, cache_dir, fps=10, stop=None):
        import json  # noqa: PLC0415
        self.ffmpeg, self.recording, self.fps, self.stop = ffmpeg, recording, float(fps), stop
        self.dir = cache_dir
        st = os.stat(recording)
        self.key = {"size": st.st_size, "mtime": int(st.st_mtime), "fps": fps}
        self.cache = os.path.join(cache_dir, LUMA_CACHE)
        self.values, self.probes = {}, 0
        try:
            with open(self.cache, encoding="utf-8") as f:
                doc = json.load(f)
            if doc.get("key") == self.key:
                self.values = dict(doc["values"])
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def __call__(self, t):
        from clip_common import STOPPED_RC, run_tool  # noqa: PLC0415
        q = str(int(round(max(0.0, t) * self.fps)))
        if q in self.values:
            return self.values[q]
        n = self.W * self.H * 3
        out = os.path.join(self.dir, PROBE_FILE)
        # through run_tool with the job's stop= (D415 review): a stream starting during a probe ends the job
        r = run_tool([self.ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", f"{int(q) / self.fps:.3f}", "-i",
                      self.recording, "-an", "-sn", "-frames:v", "1", "-vf", f"scale={self.W}:{self.H}:flags=area",
                      "-f", "rawvideo", "-pix_fmt", "rgb24", out], timeout=120, stop=self.stop, poll_sec=0.5)
        try:
            with open(out, "rb") as f:
                fr = f.read()[:n]
        except OSError:
            fr = b""
        finally:
            try:
                os.remove(out)
            except OSError:
                pass
        if r.returncode == STOPPED_RC:
            raise OnAir("a stream or recording started during the brightness probe")
        if r.returncode != 0 or len(fr) < n:
            raise ClipError("beatdrop: the brightness probe of the recording failed: " + (r.stderr or "")[-200:])
        self.probes += 1
        v = round(sum(0.2126 * _LIN[fr[j]] + 0.7152 * _LIN[fr[j + 1]] + 0.0722 * _LIN[fr[j + 2]]
                      for j in range(0, n, 3)) / (self.W * self.H), 4)
        self.values[q] = v
        return v

    def save(self):
        import json  # noqa: PLC0415
        os.makedirs(os.path.dirname(self.cache), exist_ok=True)
        with open(self.cache, "w", encoding="utf-8") as f:
            json.dump({"key": self.key, "values": self.values}, f)


def measure_flash(path, sample, fps=60, node=None, stop=None):
    """The rendered file's flash rate with the fx test analyser (tools/fx-test.mjs analyseVideo, flash-detect.mjs).
    -> the analyser's result ({"pass", "peakFlashesPerSecond", "limit", ...}). Raises ClipError when it cannot run:
    an unmeasured montage is never published."""
    import json  # noqa: PLC0415
    import shutil  # noqa: PLC0415
    from clip_common import STOPPED_RC, run_tool  # noqa: PLC0415
    node = node or shutil.which("node")
    if not node:
        raise ClipError("the flash check needs node (tools/fx-test.mjs): not found")
    url = "file:///" + os.path.join(_HERE, "..", "..", "tools", "fx-test.mjs").replace("\\", "/")
    js = (f"import({json.dumps(url)}).then(async m => {{ const r = await m.analyseVideo({json.dumps(path)}, "
          f"{{ sample: {{ width: {int(sample['width'])}, height: {int(sample['height'])} }}, fps: {int(fps)} }}); "
          "console.log(JSON.stringify(r)); }).catch(e => { console.error(String(e)); process.exit(2); });")
    r = run_tool([node, "--input-type=module", "-e", js], timeout=1800, stop=stop)
    if r.returncode == STOPPED_RC:
        raise OnAir("a stream or recording started during the flash check")
    if r.returncode != 0:
        raise ClipError("the flash check failed: " + (r.stderr or "")[-200:])
    return json.loads(r.stdout.strip().splitlines()[-1])


def render_pieces(pl):
    """The plan's pieces in the form clip_montage.render_argv takes (source span with a 2-frame margin; the exact
    length is outFrames)."""
    out = []
    for p in pl["pieces"]:
        r = {"start": p["src"]["start"], "end": round(p["src"]["end"] + 2.0 / pl["fps"] * p["speed"], 4),
             "speed": p["speed"], "outFrames": p["outFrames"], "game": p["game"]}
        if p.get("ramp"):
            r["ramp"] = p["ramp"]
        out.append(r)
    return out


def render_argv(pl, ffmpeg, src, frame, encoder_args, audio_args, music_wav, out_name, lut=None, audio_tracks=1,
                threads=4, fx=True):
    """The one ffmpeg run of a plan: clip_montage.render_argv with beat-locked pieces, the bed (no sidechain: the game
    is ducked per piece), the BD4 effects graph and the style's LUT (bloom-grade, lut3d once). One audio encode."""
    import clip_montage as mont  # noqa: PLC0415
    graph = bfx.graph(pl["effects"], frame, pl["fps"]) if fx else None
    bloom = next((e for e in pl["effects"] if e["fn"] == "bloom-grade"), None)
    use_lut = lut if (bloom is None or bloom["params"].get("lut") == "style") else None
    music = {"file": music_wav, "duck": None} if music_wav else None
    return mont.render_argv(ffmpeg, src, render_pieces(pl), frame, encoder_args, audio_args, 8, out_name,
                            threads=threads, audio_tracks=audio_tracks, max_sec=pl["total"], music=music, fx=graph,
                            lut=use_lut)


def graph_from_file(argv, wd):
    """A montage of many beat-locked pieces has a filter graph longer than a Windows command line (32 767 chars): the
    graph goes to wd/GRAPH and ffmpeg reads it with `-/filter_complex <file>` (ffmpeg 7+). Same graph, same run."""
    i = argv.index("-filter_complex")
    with open(os.path.join(wd, GRAPH), "w", encoding="utf-8", newline="\n") as f:
        f.write(argv[i + 1])
    return argv[:i] + ["-/filter_complex", GRAPH] + argv[i + 2:]


def music_bed(wd, pl, track_path, root, cfg=None):
    """The song from the plan's songStart, as long as the montage, as wd/music.wav (music_library.prepare; level from
    the data file, a short fade at the end). -> the bare WAV name."""
    import music_library as mlib  # noqa: PLC0415
    cfg = cfg or load_config()
    total = float(pl["total"])
    rec = {"segments": [{"at": 0.0, "from": float(pl["songStart"]), "len": total, "fadeIn": 0.0,
                         "fadeOut": min(1.5, total / 4)}],
           "total": total, "levelDb": float(cfg["audio"]["musicLevelDb"])}
    return mlib.prepare(wd, rec, {"file": track_path, "root": root}, mlib.load_config(), None)["file"]


def pick_music(data_dir, settings, seed_parts, live=on_air):
    """The montage's song: the NCS library pick (montage_music.pick, seeded, no repeat of the last N) when Montage
    music is on with a folder -> ({"path", "root"}, record); else (None, None) = the made-here bed."""
    import montage_music as mm  # noqa: PLC0415
    t = mm.pick(data_dir, (settings or {}).get("folder") or "", settings, seed_parts, live=live) if settings else None
    if not t:
        return None, None
    return {"path": t["path"], "root": (settings or {})["folder"]}, mm.music_record(t)


def made_here_song(wd, seconds, seed_parts):
    """The made-here bed (reel_music, the D411 fallback) over the whole montage, as wd/music.wav -> (path, record)."""
    import reel_music as rmu  # noqa: PLC0415
    mcfg = rmu.load_config()
    rec = rmu.plan([{"start": 0.0, "end": float(seconds)}], 0.0, None, mcfg, rmu.seed_for(*seed_parts))
    if rec is None:
        raise ClipError("beatdrop: the made-here bed could not be planned")
    rec = dict(rec, intro=[0.0, rec["total"]], outro=None)
    rmu.prepare(wd, rec, mcfg)
    return os.path.join(wd, rmu.WAV), dict(rec, source="made-here")


def settings_of(data_dir):
    """Settings > Clips > Montage music (clips.montageMusic in <data>/settings.json), or None."""
    try:
        s = load_json(os.path.join(data_dir, "settings.json"))
    except (ClipError, OSError, ValueError):
        return None
    v = ((s or {}).get("clips") or {}).get("montageMusic")
    return v if isinstance(v, dict) else None


STOPPED_ON_AIR = "stopped: on air"


def make(recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame=None, style=None,
         seed_parts=(), live=on_air, audio_tracks=1, max_sec=None, lock_dir=None, cfg=None, measure=None, poll_sec=2.0,
         render_json=None, write_render=None):
    """One BeatDrop montage, off air only, one heavy job at a time: the song (NCS library pick or the made-here bed),
    its song map, the plan (wd/beatdrop-plan.json; cut edges probed for brightness), the bed, the style's LUT and the
    one ffmpeg run (wd/beatdrop-<id>.mp4.part), then the flash check of the rendered file; only a file that passes
    becomes wd/beatdrop-<id>.mp4.

    On air (live() not False: a stream or recording, or unknown) before or during the render: the ffmpeg run is killed
    (run_tool stop=), the part file removed, status "stopped: on air" (the job runs again later). Flash rate above the
    limit, or not measurable: status "failed" with the reason; the file is not kept.
    measure(path, stop) -> the fx test analyser's result (default measure_flash). Every child (song map, each
    brightness probe, the render, the flash check) runs under the same stop and live() is asked between steps: any
    stop ends the whole job "stopped: on air", nothing published.
    The video gets a new name per render (beatdrop-<12 hex>.mp4). Inside the heavy-job lock: orphans from a crash
    (this code's names, in wd, not referenced by render_json) are swept first; when the job ends done or failed,
    write_render(res) writes render.json (atomically, pointing at the new video with its music record) and only then
    the older videos are swept. A file render.json references is never deleted. On air, only this run's own part file
    and probe file are removed.
    -> {"status" ("done" | "failed" | "stopped: on air"), "reason", "plan", "music" (the record for render.json),
        "returncode", "stderr", "file", "argv", "flash"}."""
    from clip_common import HeavyJobLock  # noqa: PLC0415
    cfg = cfg or load_config()
    res = {"status": STOPPED_ON_AIR, "reason": "a stream or recording is on (or that cannot be told)", "plan": None,
           "music": None, "returncode": None, "stderr": "", "file": None, "argv": None, "flash": None}

    def on():  # unknown counts as on air
        return live is None or live() is not False

    if on():
        return res
    frame = frame or cfg["frame"]
    os.makedirs(wd, exist_ok=True)
    try:
        with HeavyJobLock(lock_dir, job="beatdrop"):
            sweep_videos(wd, referenced(render_json))
            try:
                _make_locked(res, on, recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame,
                             style, seed_parts, live, audio_tracks, max_sec, cfg, measure, poll_sec)
            except Exception as e:  # noqa: BLE001 - only the on-air stops are handled, the rest re-raised
                from style_analyse import GuardStop  # noqa: PLC0415 - the song map's own live guard
                if not isinstance(e, (OnAir, GuardStop)):
                    raise
                for f in (res.get("part"), os.path.join(wd, PROBE_FILE)):
                    if f:
                        _drop(f)
                res.update(status=STOPPED_ON_AIR, reason="a stream or recording started (or that cannot be told)",
                           file=None)
            res.pop("part", None)
            if res["status"] != STOPPED_ON_AIR and write_render is not None:
                write_render(res)
                refs = referenced(render_json)
                sweep_videos(wd, None if refs is None else refs | ({res["file"]} if res["file"] else set()))
            return res
    finally:
        res.pop("part", None)


def _make_locked(res, on, recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame, style,
                 seed_parts, live, audio_tracks, max_sec, cfg, measure, poll_sec):
    import hashlib  # noqa: PLC0415
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415
    import song_map as smod  # noqa: PLC0415
    from clip_common import STOPPED_RC, run_tool, write_json_atomic  # noqa: PLC0415
    fl = cfg["flash"]

    def check():
        if on():
            raise OnAir("on air")
    song, record = pick_music(data_dir, settings_of(data_dir), seed_parts, live=live)
    res["music"] = record
    if song is None:
        path, record = made_here_song(wd, float(max_sec or cfg["maxSec"]) + 8.0, seed_parts)
        song = {"path": path, "root": wd}
        res["music"] = record
    check()
    smap = smod.song_map(song["path"], song["root"], live=live)
    check()
    probe = LumaProbe(ffmpeg, recording, wd, int(fl["lumaFps"]), stop=on)
    pl = plan(moments_doc, smap, cfg, style=style, max_sec=max_sec, luma=probe)
    probe.save()
    check()
    res["plan"] = pl
    # a new name per render (plan, music record and the time): render.json points at it once it is written
    pid = hashlib.sha1(json.dumps([pl, res["music"], time.time_ns()], sort_keys=True, default=str)
                       .encode("utf-8")).hexdigest()[:12]
    name = f"beatdrop-{pid}.mp4"
    part = os.path.join(wd, name + ".part")
    res["part"] = part
    write_json_atomic(os.path.join(wd, PLAN), pl)
    wav = music_bed(wd, pl, song["path"], song["root"], cfg)
    lut = None
    if style and style.get("colour"):
        import reel_style as rstyle  # noqa: PLC0415
        ref = rstyle.clip_colour(recording, render_pieces(pl))
        rstyle.write_lut(os.path.join(wd, rstyle.LUT_FILE), style["colour"], style["colour"]["strength"], ref)
        lut = rstyle.LUT_FILE
    r = None
    if not on():
        argv = render_argv(pl, ffmpeg, recording, frame, encoder_args, audio_args, wav, name + ".part",
                           lut=lut, audio_tracks=audio_tracks)
        argv = graph_from_file(argv, wd)
        res["argv"] = argv
        r = run_tool(argv, cwd=wd, watch=name + ".part", stall_sec=300, stop=on, poll_sec=poll_sec)
        res["returncode"], res["stderr"] = r.returncode, (r.stderr or "")[-400:]
    for f in (wav, lut, GRAPH):
        if f:
            try:
                os.remove(os.path.join(wd, f))
            except OSError:
                pass
    if r is None or r.returncode == STOPPED_RC:
        raise OnAir("on air during the render")
    if r.returncode != 0 or not os.path.isfile(part):
        _drop(part)
        res.update(status="failed", reason=f"ffmpeg exited {r.returncode}")
        return res
    try:
        check()
        m = (measure or (lambda f, stop: measure_flash(f, fl["sample"], pl["fps"], stop=stop)))(part, on)
        check()
    except OnAir:
        raise
    except ClipError as e:
        m = None
        reason = f"flash not measured ({e}): not published"
    else:
        res["flash"] = {"peakFlashesPerSecond": m.get("peakFlashesPerSecond"), "limit": m.get("limit"),
                        "pass": bool(m.get("pass"))}
        reason = None
        if not m.get("pass") or float(m.get("peakFlashesPerSecond") or 0) > float(fl["maxPerSec"]):
            reason = (f"flash limit: the rendered montage measures {m.get('peakFlashesPerSecond')} flashes/s "
                      f"(limit {float(fl['maxPerSec']):g}): not published")
    if reason:
        _drop(part)
        res.update(status="failed", reason=reason)
        return res
    os.replace(part, os.path.join(wd, name))
    res.update(status="done", reason=None, file=name)
    return res


VIDEO_NAME = re.compile(r"^beatdrop-[0-9a-f]{10,12}\.mp4(\.part)?$")  # 10 hex: the names of c370e5c


def referenced(render_json):
    """The video names a BeatDrop render.json points at: an empty set when there is none yet; None when it exists but
    cannot be read or is not a render document (fail closed: sweep_videos then removes nothing, D415 review)."""
    if not render_json or not os.path.exists(render_json):
        return set()
    try:
        doc = load_json(render_json)
        clips = doc["clips"]
        return {f["file"] for c in clips for f in c.get("files") or [] if f.get("file")}
    except (ClipError, OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        import sys  # noqa: PLC0415
        print(f"beatdrop: {os.path.basename(render_json)} is unreadable ({type(e).__name__}): no video is swept",
              file=sys.stderr)
        return None


def sweep_videos(wd, keep):
    """Removes this code's own videos and part files (exactly beatdrop-<10-12 hex>.mp4 / .mp4.part) in wd that are not in
    `keep` (the names render.json points at). Called only inside make()'s heavy-job lock: before a run (orphans from a
    crash) and after render.json is written (the previous video). Other files are never touched. keep None (an
    unreadable render.json): nothing is removed."""
    if keep is None:
        return []
    try:
        names = os.listdir(wd)
    except OSError:
        return []
    gone = []
    for f in names:
        if VIDEO_NAME.match(f) and f not in keep and f.split(".part")[0] not in keep:
            _drop(os.path.join(wd, f))
            gone.append(f)
    return gone


def _drop(path):
    try:
        os.remove(path)
    except OSError:
        pass
