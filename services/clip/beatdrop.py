# SPDX-License-Identifier: GPL-3.0-or-later
"""BD3 beat-locked edit planner (D415, plan docs/plan/2026-11-21-beatdrop-montages.md sections 1.3 and 5).

Takes a recording's BD1 moments (moments.py), a BD2 song map (song_map.py) and an optional reel style (RS1/RS2, its
mapped "cuts": shotSec, ratePerMin, beatShare) and builds a montage plan (data; schema
data/schemas/beatdrop-plan.schema.json):

- cold open: calm pieces (third person, scope, any stretch with no kill or gunshot), cut on downbeats only, slowed;
- a title slot over the intro's last bars (filled by BD5, beatdrop_titles.fill);
- the strongest kill exactly on the first drop; then kills and gunshots on beats, flicks/slides/jumps on off-beats
  (share from the style's beat share);
- breakdowns: calm slow-motion pieces cut on downbeats, letterbox;
- outro: a hero slot and a credits slot (filled by BD5, beatdrop_titles) over calm slow pieces.

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
from clip_common import CLIP_DATA, ClipError, NotStarted, load_json, on_air  # NotStarted: re-exported (beatdrop.NotStarted)

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
        self.calm_k = sorted((st(m), m["kind"]) for m in ms if m["kind"] in game["calmKinds"])
        self.calms = [t for t, _ in self.calm_k]
        self.rng = None  # BD7 another-take: a seeded random.Random that shuffles the calm starts
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
        starts = [(max(0.0, c - 0.2), k) for c, k in self.calm_k] +             [(k * 0.5, None) for k in range(int(self.rec_len / 0.5) + 1)]
        if self.rng is not None:
            self.rng.shuffle(starts)
        for reuse in (False, True):
            s = speed
            while s >= sp_min - 1e-9:
                ln = (f1 - f0) / self.fps * s
                for a, kind in starts:
                    b = a + ln
                    if b <= self.rec_len - 1.0 / self.rfps and self._no_kill(a, b) and (reuse or self._free(a, b)):
                        p = self._add(part, f0, f1, a, s, gain=self.cfg["audio"]["calmGain"], keep=[])
                        if kind:
                            p["near"] = kind  # BD7: the calm moment this shot starts at (the plain-word summary)
                        return p
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
                        "dropAt": round(drop - self.song0, 4), "beats": reel_beats,
                        "downbeats": [round(d - self.song0, 4) for d in downs if self.song0 <= d <= song_end]},
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


# ---------------------------------------------------------------- BD7 retakes and summary (D418)

RETAKES = ("another-take", "slower-intro", "more-third-person", "swap")
_ANCHOR_FX = ("shot-shake", "impact-flash", "rgb-split", "ragdoll-slowmo")


def _state(pl, moments_doc, cfg, game, luma=None, rec_seconds=None):
    """A planner that knows the saved plan's timeline: no song map needed (a retake never moves a cut or a beat)."""
    P = _Planner(moments_doc, {}, cfg, game, None, pl["total"], rec_seconds, luma)
    P.song0 = float(pl["songStart"])
    P.by_key = {(m["kind"], m["frame"]): m for m in moments_doc["moments"]}
    return P


def _occupy(P, pieces, skip=()):
    """The used source spans and taken moments of every piece except the indexes in skip."""
    P.used = [(p["src"]["start"], p["src"]["end"]) for i, p in enumerate(pieces) if i not in skip]
    P.taken = set()
    for i, p in enumerate(pieces):
        a = p.get("anchor")
        if i not in skip and a and (a["kind"], a["frame"]) in P.by_key:
            P.taken.add(id(P.by_key[(a["kind"], a["frame"])]))


def _queue_of(P, p):
    if p["part"] == "drop":
        return P.kills or P.on_queue
    return P.on_queue if p["anchor"]["onBeat"] else P.offs


def _redo(P, p, queue, speed=None):
    """A new piece on exactly p's frames: anchored from queue (same anchor frame, beat or off-beat) or calm."""
    P.pieces = []
    f0, f1 = p["outStart"], p["outStart"] + p["outFrames"]
    if p.get("anchor") and queue is not None:
        a = p["anchor"]
        return P.anchored(p["part"], queue, f0, a["outFrame"], f1, a["onBeat"])
    return P.calm(p["part"], f0, f1, speed if speed is not None else p["speed"])


def _drop_fx(effects, p, fps):
    """Without p's anchor: the effects on its beat (shake, flash, split, ragdoll) and its scope push go."""
    a = p.get("anchor")
    if not a:
        return effects
    end_t = round((p["outStart"] + p["outFrames"]) / fps, 4)
    return [e for e in effects if not ((e["fn"] in _ANCHOR_FX and abs(e["at"] - a["outT"]) < 1e-6) or
                                       (e["fn"] == "scope-zoom-transition" and abs(e["at"] - end_t) < 1e-6))]


def _refx(P, effects, pieces, i, old, new):
    """Codex BD7a: piece i's moment changed (old -> new, same frames): the old anchor's beat effects and scope push go
    and the new on-beat anchor gets the ones the planner gives it (_on_anchor: shake, flash, RGB split on the drop and
    every Nth kill counted with the pieces as they are now, a scope push when it was scoped, the ragdoll ramp)."""
    effects = _drop_fx(effects, old, P.fps)
    new.pop("ramp", None)
    a = new.get("anchor")
    if not (a and a.get("onBeat")):
        return effects
    # the planner's count (kills_on starts at 1: the drop's kill): 1 + the body on-beat kills up to and including this
    # one. another-take re-chooses in order, so pieces[:i] are already the new ones; a swap leaves the other pieces'
    # effects as they are (it changes only what it names)
    kill_no = 1 + sum(1 for p in pieces[:i] + [new] if p["part"] == "body" and p.get("anchor")
                      and p["anchor"].get("onBeat") and p["anchor"]["kind"] == "kill")
    P.effects = []
    P._on_anchor(new, first=new["part"] == "drop", kill_no=kill_no)
    return effects + P.effects


def retake(pl, op, moments_doc, cfg=None, game=None, piece=None, luma=None, rec_seconds=None):
    """BD7 (D418): a new plan from a saved plan that changes only what op names. Cuts, beats, song start, slots and
    every piece op does not name stay as they are; the retake is appended to plan["retakes"] (with its seed, step or
    pieces) so base plan + retakes reproduce the result. Numbers from cfg["retakes"].
      another-take       every piece but the drop re-chosen with a seeded shuffle (same frames, same beats); the
                         drop keeps the strongest kill that fits (the first-drop rule)
      slower-intro       cold-open pieces slowed by slowerIntro.speedStep, never below speed.min (same frames, same
                         source start: a shorter span inside the old one)
      more-third-person  up to moreThirdPerson.convert body pieces of moreThirdPerson.kinds (never a kill, never the
                         drop) become calm shots, near a calm moment (third person, scope) first
      swap               piece N (1-based) gets the next candidate moment in its queue (anchored) or the next calm
                         stretch; every other piece identical
    Flash spacing runs again on the new timeline (cut edges re-probed when luma is given; else the saved cuts)."""
    import copy  # noqa: PLC0415
    import random  # noqa: PLC0415
    cfg = cfg or load_config()
    game = game or load_game(moments_doc.get("game") or "codm")
    rc = cfg["retakes"]
    if op not in RETAKES:
        raise ClipError(f"beatdrop: unknown retake {op} (use {', '.join(RETAKES)})")
    out = copy.deepcopy(pl)
    pieces, effects = out["pieces"], [e for e in out["effects"] if e["fn"] != "cut-soften"]
    hist = out.setdefault("retakes", [])
    if len(hist) >= int(rc["max"]):
        raise ClipError(f"beatdrop: this plan already has {len(hist)} retakes (limit {int(rc['max'])})")
    P = _state(out, moments_doc, cfg, game, luma, rec_seconds)
    rec = {"op": op}
    changed = []
    if op == "swap":
        if not isinstance(piece, int) or isinstance(piece, bool) or not 1 <= piece <= len(pieces):
            raise ClipError(f"beatdrop: swap needs a piece number 1..{len(pieces)}")
        i = piece - 1
        old = pieces[i]
        _occupy(P, pieces, skip={i})
        if old.get("anchor"):
            cur = P.by_key.get((old["anchor"]["kind"], old["anchor"]["frame"]))
            q = list(_queue_of(P, old))
            k = next((j for j, m in enumerate(q) if m is cur), None)
            q = q[k + 1:] + q[:k] if k is not None else q
            new = _redo(P, old, q)
        else:
            P.used.append((old["src"]["start"], old["src"]["end"]))  # the next calm stretch, not this one
            new = _redo(P, old, None)
        if new is None or new["src"] == old["src"]:
            raise ClipError(f"beatdrop: piece {piece} has no other candidate that fits its frames")
        effects = _refx(P, effects, pieces, i, old, new)
        pieces[i] = new
        rec["piece"] = piece
        changed = [i]
    elif op == "slower-intro":
        step, sp_min = float(rc["slowerIntro"]["speedStep"]), float(cfg["speed"]["min"])
        for i, p in enumerate(pieces):
            if p["part"] != "cold-open":
                continue
            s = round(max(sp_min, p["speed"] - step), 4)
            if s < p["speed"]:
                p["speed"] = s
                p["src"]["end"] = round(p["src"]["start"] + p["outFrames"] / P.fps * s, 4)
                changed.append(i)
        if not changed:
            raise ClipError(f"beatdrop: the cold open is already at the slowest safe speed ({sp_min:g}x)")
        rec["speedStep"] = step
    elif op == "more-third-person":
        mt = rc["moreThirdPerson"]
        cands = [i for i, p in enumerate(pieces) if p["part"] == "body" and p.get("anchor")
                 and p["anchor"]["kind"] in mt["kinds"] and p["anchor"]["kind"] != "kill"]
        cands.sort(key=lambda i: (pieces[i]["anchor"]["onBeat"], pieces[i]["anchor"]["strength"], i))
        for i in cands:
            if len(changed) >= int(mt["convert"]):
                break
            _occupy(P, pieces, skip={i})
            old = pieces[i]
            P.pieces = []
            try:
                new = P.calm("body", old["outStart"], old["outStart"] + old["outFrames"], float(mt["speed"]))
            except ClipError:
                continue
            effects = _drop_fx(effects, old, P.fps)
            pieces[i] = new
            changed.append(i)
        if not changed:
            raise ClipError("beatdrop: no piece can become a calm third-person shot (only kills or the drop are left)")
        changed.sort()
        rec["pieces"] = [i + 1 for i in changed]
    else:  # another-take
        at = rc["anotherTake"]
        seed = 1 + sum(1 for r in hist if r["op"] == "another-take")
        rng = random.Random(f"{at['seedPrefix']}|{seed}")
        win = float(at["window"])

        def shuffled(q):
            keyed = [(r + rng.uniform(0, win), r, m) for r, m in enumerate(q)]
            return [m for _, _, m in sorted(keyed, key=lambda x: (x[0], x[1]))]
        di = next(i for i, p in enumerate(pieces) if p["part"] == "drop")
        _occupy(P, pieces, skip=set(range(len(pieces))) - {di})
        P.rng = rng
        qs = {}
        for i, old in enumerate(pieces):
            if i == di:
                continue
            if old.get("anchor"):
                base = _queue_of(P, old)
                if id(base) not in qs:
                    qs[id(base)] = shuffled(base)
                new = _redo(P, old, qs[id(base)])
                if new is None:
                    raise ClipError(f"beatdrop: another take found no moment for piece {i + 1}")
                P.taken.add(id(P.by_key[(new["anchor"]["kind"], new["anchor"]["frame"])]))
            else:
                new = _redo(P, old, None)
            P.used.append((new["src"]["start"], new["src"]["end"]))
            effects = _refx(P, effects, pieces, i, old, new)
            pieces[i] = new
            changed.append(i)
        rec["seed"] = seed
    P.pieces = pieces
    fl = cfg["flash"]
    cuts = P.cut_jumps() if luma is not None else [{k: c[k] for k in ("at", "from", "to")} for c in out.get("cuts") or []]
    out["effects"] = bfx.space_flashes(effects, int(fl["maxPerSec"]), float(fl["minGapSec"]), cuts=cuts,
                                       soften_frames=int(fl["softenFrames"]))
    out["cuts"] = cuts
    out["stats"] = stats(pieces, P.fps)
    hist.append(rec)
    out["log"] = (out.get("log") or []) + [f"retake {op}: piece(s) {', '.join(str(i + 1) for i in changed)} changed"]
    out["log"] = out["log"][-50:]
    return out


retake_plan = retake  # make()'s `retake` argument shadows the function name there


def _mmss(t):
    t = int(round(float(t)))
    return f"{t // 60}:{t % 60:02d}"


def _n(k, word, plural=None):
    return f"{k} {word if k == 1 else (plural or word + 's')}"


def summary(pl):
    """BD7 (D418): the plan in plain words for the studio card -> a list of short strings."""
    ps = pl["pieces"]
    out = []
    drop = next((p for p in ps if p["part"] == "drop"), None)
    if drop and drop.get("anchor"):
        what = drop["anchor"]["kind"]
        if pl["song"].get("firstDrop") is not None:
            out.append(f"{what} on the first drop at {_mmss(pl['song']['dropAt'])}")
        else:
            out.append(f"{what} on the drop at {_mmss(pl['song']['dropAt'])} (the song's first drop came too early)")
    anchors = [p["anchor"] for p in ps if p.get("anchor")]
    kb = sum(1 for a in anchors if a["kind"] == "kill" and a["onBeat"])
    if kb:
        out.append(_n(kb, "kill") + " on beats")
    ob = sum(1 for a in anchors if not a["onBeat"])
    if ob:
        out.append(_n(ob, "move") + " between beats (flicks, slides, jumps)")
    tp = sum(1 for p in ps if p.get("near") == "third-person")
    if tp:
        out.append(_n(tp, "third-person shot"))
    co = [p for p in ps if p["part"] == "cold-open"]
    if co:
        out.append(f"slow intro: {_n(len(co), 'shot')} at {min(p['speed'] for p in co):g}x")
    sm = sum(1 for p in ps if p.get("ramp"))
    if sm:
        out.append(_n(sm, "slow-motion kill"))
    out.append(f"{_n(len(ps), 'shot')}, {_mmss(pl['total'])} long")
    words = {"another-take": "another take", "slower-intro": "slower intro", "more-third-person": "more third person",
             "swap": "piece swapped"}
    for r in pl.get("retakes") or []:
        extra = f" ({r['piece']})" if r["op"] == "swap" else (f" ({r['seed']})" if r["op"] == "another-take" else "")
        out.append("retake: " + words[r["op"]] + extra)
    return out


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
        _not_started(r)
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


def _not_started(r):
    from clip_common import NO_JOB_RC  # noqa: PLC0415
    if r.returncode == NO_JOB_RC:
        raise NotStarted(r.stderr or "the child could not be started safely")


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
    _not_started(r)
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
                threads=4, fx=True, titles=None, layout=None):
    """The one ffmpeg run of a plan: clip_montage.render_argv with beat-locked pieces, the bed (no sidechain: the game
    is ducked per piece), the BD4 effects graph and the style's LUT (bloom-grade, lut3d once). One audio encode.
    titles: beatdrop_titles.prepare() dict (BD5), burned by libass after the effects (render_argv title=).
    layout (BD7): the V cut's per-piece framing (clip_montage.render_argv layout=); frame is then the V frame."""
    import clip_montage as mont  # noqa: PLC0415
    graph = bfx.graph(pl["effects"], frame, pl["fps"]) if fx else None
    bloom = next((e for e in pl["effects"] if e["fn"] == "bloom-grade"), None)
    use_lut = lut if (bloom is None or bloom["params"].get("lut") == "style") else None
    music = {"file": music_wav, "duck": None} if music_wav else None
    return mont.render_argv(ffmpeg, src, render_pieces(pl), frame, encoder_args, audio_args, 8, out_name,
                            threads=threads, audio_tracks=audio_tracks, max_sec=pl["total"], music=music, fx=graph,
                            lut=use_lut, title=titles, layout=layout)


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
    # bedSec: the length asked for, so a retake makes the very same bed (BD7, Codex)
    return os.path.join(wd, rmu.WAV), dict(rec, source="made-here", bedSec=round(float(seconds), 3))


def settings_of(data_dir):
    """Settings > Clips > Montage music (clips.montageMusic in <data>/settings.json), or None."""
    try:
        s = load_json(os.path.join(data_dir, "settings.json"))
    except (ClipError, OSError, ValueError):
        return None
    v = ((s or {}).get("clips") or {}).get("montageMusic")
    return v if isinstance(v, dict) else None


STOPPED_ON_AIR = "stopped: on air"
NOT_STARTED = "not started"  # a child could not be started safely (no process job): nothing written, runs again later


def make(recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame=None, style=None,
         seed_parts=(), live=on_air, audio_tracks=1, max_sec=None, lock_dir=None, cfg=None, measure=None, poll_sec=2.0,
         render_json=None, write_render=None, profile=None, vertical=None, retake=None):
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
    The video gets a new name per render (beatdrop-<12 hex>.mp4). Inside the heavy-job lock: once the render child
    has started, orphans from a crash are swept (sweep_videos: only what render.json provably supersedes; this run's
    own files kept); when the job ends done or failed, write_render(res) writes render.json (atomically, pointing at
    the new video with its music record) and only then the older videos are swept. On air, only this run's own part
    file and probe file are removed.
    BD5 (D416, cfg titles.on): the plan's title/hero/credits slots are filled (beatdrop_titles; brand and player name
    from `profile`, default data/profile.local.json), the title is tracked onto the shot (same stop) and drawn in the
    same render.
    A child that cannot be started safely (run_tool NO_JOB_RC): status "not started", handled like on air (no
    render.json write, no sweep, the previous record and video kept; the job runs again later).
    BD7 (D418): vertical (vertical_source()) also cuts the V (9:16) file from the same plan in a second ffmpeg run
    (same pieces, timing, bed, LUT, effects; screen-space titles laid out for the V frame; framed with the clip
    layouts), its own new name, its own flash check: above the limit only the V file is dropped (res["v"]["reason"]).
    Both stay .part until both are measured. retake {"op", "piece"?, "plan" (the saved plan), "music" (its record)}:
    the same song again (no new pick, no song map) and retake() on the saved plan instead of a new plan.
    -> {"status" ("done" | "failed" | "stopped: on air" | "not started"), "reason", "plan", "music" (the record for render.json),
        "returncode", "stderr", "file", "argv", "flash", "summary", "v" ({"file", "flash", "reason", "layout"} or None)}."""
    from clip_common import HeavyJobLock  # noqa: PLC0415
    cfg = cfg or load_config()
    res = {"status": STOPPED_ON_AIR, "reason": "a stream or recording is on (or that cannot be told)", "plan": None,
           "music": None, "returncode": None, "stderr": "", "file": None, "argv": None, "flash": None,
           "summary": None, "v": None}

    def on():  # unknown counts as on air
        return live is None or live() is not False

    if on():
        return res
    frame = frame or cfg["frame"]
    os.makedirs(wd, exist_ok=True)
    try:
        with HeavyJobLock(lock_dir, job="beatdrop"):
            try:
                # the orphan sweep runs once the first guarded child (the render) has started: never on a job that
                # could not start a child; this run's own part file is kept
                _make_locked(res, on, recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame,
                             style, seed_parts, live, audio_tracks, max_sec, cfg, measure, poll_sec,
                             started=lambda own: sweep_videos(wd, render_json, keep=own), profile=profile,
                             vertical=vertical, retake=retake)
            except Exception as e:  # noqa: BLE001 - only the on-air stops are handled, the rest re-raised
                from style_analyse import GuardStop  # noqa: PLC0415 - the song map's own live guard
                if not isinstance(e, (OnAir, GuardStop, NotStarted)):
                    raise
                for f in (res.get("part"), res.get("vpart"), os.path.join(wd, PROBE_FILE)):
                    if f:
                        _drop(f)
                if isinstance(e, NotStarted):
                    res.update(status=NOT_STARTED, reason=str(e), file=None, v=None)
                else:
                    res.update(status=STOPPED_ON_AIR, reason="a stream or recording started (or that cannot be told)",
                               file=None, v=None)
            finally:  # BD5: the titles' ASS (it holds the profile names), fonts and tracking file go on every path
                import beatdrop_titles as bt  # noqa: PLC0415
                bt.cleanup(wd)
            res.pop("part", None)
            res.pop("vpart", None)
            if res["status"] not in (STOPPED_ON_AIR, NOT_STARTED) and write_render is not None:
                write_render(res)
                sweep_videos(wd, render_json)
            return res
    finally:
        res.pop("part", None)
        res.pop("vpart", None)


def vertical_source(cfg, layouts, h_path, h_info, v_path=None, v_info=None, frame=None):
    """BD7 (D418): where and how the V file is cut, from cfg["vertical"] and the clip layouts (layouts.json doc): the
    `layout` (the V canvas recording, as V clips are cut) when v_path is given and readable, else the `fallback` on the
    H recording. -> {"src", "layout", "iw", "ih", "frame", "audio_tracks"} or None when vertical.on is false."""
    vc = cfg.get("vertical") or {}
    if not vc.get("on"):
        return None
    by_id = {x["id"]: x for x in layouts["layouts"]}
    use_v = bool(v_path and v_info and by_id.get(vc["layout"], {}).get("input") == "v")
    lid = vc["layout"] if use_v else vc["fallback"]
    if lid not in by_id:
        raise ClipError(f"beatdrop: the V layout {lid} is not in the clip layouts")
    info = v_info if use_v else h_info
    return {"src": v_path if use_v else h_path, "layout": by_id[lid], "iw": int(info["width"]),
            "ih": int(info["height"]), "frame": dict(frame or vc["frame"]),
            "audio_tracks": 1 if info.get("has_audio") else 0}


def retake_song(data_dir, record, wd, max_sec, cfg, seed_parts, live=on_air):
    """BD7: the saved plan's song again: the same NCS track (by id, fixed) or the same seeded made-here bed."""
    if record and record.get("trackId"):
        s = settings_of(data_dir) or {}
        if not s.get("folder"):
            raise ClipError("beatdrop: retake needs the montage music folder (Settings > Clips > Montage music)")
        song, rec = pick_music(data_dir, dict(s, on=True, mode="fixed", fixedTrack=record["trackId"]), seed_parts,
                               live=live)
        if song is None:
            raise ClipError("beatdrop: the saved plan's song is no longer in the montage music folder")
        return song, rec
    sec = (record or {}).get("bedSec")  # the saved length; a record from before bedSec: as a new montage would ask
    path, rec = made_here_song(wd, float(sec) if sec else float(max_sec or cfg["maxSec"]) + 8.0, seed_parts)
    return {"path": path, "root": wd}, rec


def _v_plan(pl):
    """The V copy of the plan for the titles: the same slots, the title in screen space (the pin track is in H
    pixels); credits and hero lay out for the frame they are drawn in (beatdrop_titles)."""
    import copy  # noqa: PLC0415
    v = copy.deepcopy(pl)
    for ln in ((v["slots"].get("title") or {}).get("content") or {}).get("lines") or []:
        ln.pop("segments", None)
    return v


def _make_locked(res, on, recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame, style,
                 seed_parts, live, audio_tracks, max_sec, cfg, measure, poll_sec, started=None, profile=None,
                 vertical=None, retake=None):
    import hashlib  # noqa: PLC0415
    import json  # noqa: PLC0415
    import time  # noqa: PLC0415
    import song_map as smod  # noqa: PLC0415
    from clip_common import STOPPED_RC, run_tool, write_json_atomic  # noqa: PLC0415
    fl = cfg["flash"]

    def check():
        if on():
            raise OnAir("on air")
    if retake:  # BD7: the same song, the saved plan changed only where the retake names
        song, record = retake_song(data_dir, retake.get("music"), wd, max_sec, cfg, seed_parts, live=live)
        res["music"] = record
    else:
        song, record = pick_music(data_dir, settings_of(data_dir), seed_parts, live=live)
        res["music"] = record
        if song is None:
            path, record = made_here_song(wd, float(max_sec or cfg["maxSec"]) + 8.0, seed_parts)
            song = {"path": path, "root": wd}
            res["music"] = record
    check()
    probe = LumaProbe(ffmpeg, recording, wd, int(fl["lumaFps"]), stop=on)
    if retake:
        pl = retake_plan(retake["plan"], retake["op"], moments_doc, cfg, piece=retake.get("piece"), luma=probe)
    else:
        smap = smod.song_map(song["path"], song["root"], live=live)
        check()
        pl = plan(moments_doc, smap, cfg, style=style, max_sec=max_sec, luma=probe)
    probe.save()
    check()
    tcfg = cfg.get("titles") or {}
    titles_on = bool(tcfg.get("on"))
    if titles_on:  # BD5 (D416): slots filled from the music record and the local profile, the title tracked
        import beatdrop_titles as bt  # noqa: PLC0415
        from clip_common import PROFILE_FILE  # noqa: PLC0415
        gid = moments_doc.get("game") or "codm"
        game = load_game(gid)
        # Codex BD7a: a retake keeps the saved plan's filled slots (names, song title, credits and its one hero-bw
        # effect); only the pin is tracked again over the pieces as they are now
        if not (retake and any(e.get("fn") == "hero-bw" for e in pl["effects"])):
            brand, player = bt.profile_names(profile or PROFILE_FILE, gid)
            bt.fill(pl, res["music"], brand, player, cfg, game)
        bt.pin(pl, recording, ffmpeg, wd, frame, cfg, stop=on)
        check()
    res["plan"] = pl
    res["summary"] = summary(pl)
    # a new name per render (plan, music record and the time): render.json points at it once it is written
    pid = hashlib.sha1(json.dumps([pl, res["music"], time.time_ns()], sort_keys=True, default=str)
                       .encode("utf-8")).hexdigest()[:12]
    name = f"beatdrop-{pid}.mp4"
    part = os.path.join(wd, name + ".part")
    res["part"] = part
    vname = vpart = rv = None
    if vertical:  # BD7: the V file's own new name (the same 12-hex shape, so the sweeps know it)
        vname = f"beatdrop-{hashlib.sha1((pid + '|v').encode('utf-8')).hexdigest()[:12]}.mp4"
        vpart = os.path.join(wd, vname + ".part")
        res["vpart"] = vpart
    wav = lut = r = None
    try:  # Codex BD5 review: the music bed, LUT, graph and title files go on any error before or during the render
        wav = music_bed(wd, pl, song["path"], song["root"], cfg)
        if style and style.get("colour"):
            import reel_style as rstyle  # noqa: PLC0415
            ref = rstyle.clip_colour(recording, render_pieces(pl))
            lut = rstyle.LUT_FILE  # named first: a half-written LUT is removed too
            rstyle.write_lut(os.path.join(wd, lut), style["colour"], style["colour"]["strength"], ref)
        titles = bt.prepare(wd, pl, frame, cfg, game) if titles_on else None
        if not on():
            argv = render_argv(pl, ffmpeg, recording, frame, encoder_args, audio_args, wav, name + ".part",
                               lut=lut, audio_tracks=audio_tracks, titles=titles)
            argv = graph_from_file(argv, wd)
            res["argv"] = argv
            r = run_tool(argv, cwd=wd, watch=name + ".part", stall_sec=300, stop=on, poll_sec=poll_sec)
            res["returncode"], res["stderr"] = r.returncode, (r.stderr or "")[-400:]
        if vertical and r is not None and r.returncode == 0 and os.path.isfile(part) and not on():
            # BD7: the V cut of the same plan: same bed, LUT and effects; titles laid out for the V frame
            if titles_on:
                bt.cleanup(wd)
            vt = bt.prepare(wd, _v_plan(pl), vertical["frame"], cfg, game) if titles_on else None
            if not on():
                argv = render_argv(pl, ffmpeg, vertical["src"], vertical["frame"], encoder_args, audio_args, wav,
                                   vname + ".part", lut=lut, audio_tracks=vertical["audio_tracks"], titles=vt,
                                   layout=None if vertical["layout"]["kind"] == "canvas" else vertical)
                argv = graph_from_file(argv, wd)
                res["vargv"] = argv
                rv = run_tool(argv, cwd=wd, watch=vname + ".part", stall_sec=300, stop=on, poll_sec=poll_sec)
    finally:
        for f in (wav, lut, GRAPH):
            if f:
                try:
                    os.remove(os.path.join(wd, f))
                except OSError:
                    pass
        if titles_on:
            bt.cleanup(wd)
    if r is None or r.returncode == STOPPED_RC:
        raise OnAir("on air during the render")
    _not_started(r)
    h_ok = r.returncode == 0 and os.path.isfile(part)
    if vertical and h_ok:  # Codex BD7a: both children checked before the orphan sweep (a V not started sweeps nothing)
        if rv is None or rv.returncode == STOPPED_RC:
            raise OnAir("on air during the V render")
        _not_started(rv)
    if started is not None:
        started({name, name + ".part"} | ({vname, vname + ".part"} if vname else set()))
    if not h_ok:
        _drop(part)
        res.update(status="failed", reason=f"ffmpeg exited {r.returncode}")
        return res
    if vertical:
        res["v"] = {"file": None, "flash": None, "reason": None, "layout": vertical["layout"]["id"]}
        if rv.returncode != 0 or not os.path.isfile(vpart):
            _drop(vpart)
            res["v"]["reason"] = f"V render: ffmpeg exited {rv.returncode}: " + (rv.stderr or "")[-300:]
    try:
        check()
        m = (measure or (lambda f, stop: measure_flash(f, fl["sample"], pl["fps"], stop=stop)))(part, on)
        check()
    except (OnAir, NotStarted):
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
        if vpart:
            _drop(vpart)
            res["v"] = None
        res.update(status="failed", reason=reason)
        return res
    if vertical and res["v"]["reason"] is None:  # BD7: the V file measured on its own; only it is dropped on a fail
        try:
            check()
            mv = (measure or (lambda f, stop: measure_flash(f, fl["sample"], pl["fps"], stop=stop)))(vpart, on)
            check()
        except (OnAir, NotStarted):
            raise
        except ClipError as e:
            res["v"]["reason"] = f"V flash not measured ({e}): not published"
        else:
            res["v"]["flash"] = {"peakFlashesPerSecond": mv.get("peakFlashesPerSecond"), "limit": mv.get("limit"),
                                 "pass": bool(mv.get("pass"))}
            if not mv.get("pass") or float(mv.get("peakFlashesPerSecond") or 0) > float(fl["maxPerSec"]):
                res["v"]["reason"] = (f"flash limit: the V file measures {mv.get('peakFlashesPerSecond')} flashes/s "
                                      f"(limit {float(fl['maxPerSec']):g}): not published")
        if res["v"]["reason"]:
            _drop(vpart)
    # Codex BD7a: the plan is saved only with a finished video, so a stopped or failed (re)take never leaves a plan
    # that no video shows (a later retake starts from what the user got). Written aside first and moved in only once
    # both videos are in place: a failed move removes what this take moved, so the old plan stays with the old videos
    # render.json still names.
    plan_path = os.path.join(wd, PLAN)
    write_json_atomic(plan_path + ".part", pl)
    moves = [(part, os.path.join(wd, name))]
    if vertical and res["v"]["reason"] is None:
        moves.append((vpart, os.path.join(wd, vname)))
    moved = []
    try:
        for src, dst in moves:
            os.replace(src, dst)
            moved.append(dst)
        os.replace(plan_path + ".part", plan_path)
    except OSError:
        for f in moved + [src for src, _ in moves] + [plan_path + ".part"]:
            _drop(f)
        raise
    if len(moves) == 2:
        res["v"]["file"] = vname
    res.update(status="done", reason=None, file=name)
    return res


VIDEO_NAME = re.compile(r"^beatdrop-[0-9a-f]{10,12}\.mp4(\.part)?$")  # 10 hex: the names of c370e5c


def current_videos(render_json, wd):
    """The beatdrop videos render.json names that exist in wd (positive evidence of the current video, D415 review).
    -> a non-empty set; set() when render.json is absent (FileNotFoundError); None when it cannot be read, is not
    valid JSON, or names no existing beatdrop video (then nothing of ours is provably superseded)."""
    import json  # noqa: PLC0415
    import sys  # noqa: PLC0415
    if not render_json:
        return None
    try:
        with open(render_json, encoding="utf-8") as f:
            doc = json.load(f)
    except FileNotFoundError:
        return set()
    except (OSError, ValueError) as e:
        print(f"beatdrop: {os.path.basename(render_json)} is unreadable ({type(e).__name__}): no video is swept",
              file=sys.stderr)
        return None
    names = set()
    clips = doc.get("clips") if isinstance(doc, dict) else None
    for c in clips if isinstance(clips, list) else []:
        files = c.get("files") if isinstance(c, dict) else None
        for fe in files if isinstance(files, list) else []:
            f = fe.get("file") if isinstance(fe, dict) else None
            if isinstance(f, str) and VIDEO_NAME.match(f) and not f.endswith(".part") and \
                    os.path.isfile(os.path.join(wd, f)):
                names.add(f)
    return names or None


def sweep_videos(wd, render_json, keep=()):
    """Removes this code's own videos and part files (exactly beatdrop-<10-12 hex>.mp4 / .mp4.part) in wd only when
    they are provably superseded or orphaned (D415 review): render.json names a different existing beatdrop video as
    the current one, or render.json is absent and the file is a .part. render.json unreadable, not JSON, or naming no
    existing beatdrop video: nothing is removed. `keep` (this run's own names) and the current video are never
    removed; other files are never touched. Called only inside make()'s heavy-job lock. -> the removed names."""
    cur = current_videos(render_json, wd)
    if cur is None:
        return []
    try:
        names = os.listdir(wd)
    except OSError:
        return []
    gone = []
    for f in names:
        if not VIDEO_NAME.match(f) or f in keep or f in cur or f.split(".part")[0] in cur:
            continue
        if not cur and not f.endswith(".part"):
            continue  # no render.json: only part files are provably orphans
        _drop(os.path.join(wd, f))
        gone.append(f)
    return gone


def _drop(path, tries=20, wait=0.1):
    """Removes one of this job's own files. A file a just-ended child had open (or a scanner is reading) can refuse
    the delete for a moment on Windows: retried for up to tries*wait seconds, then left and logged."""
    import sys  # noqa: PLC0415
    import time  # noqa: PLC0415
    for i in range(tries):
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return True
        except OSError as e:
            if i == tries - 1:
                print(f"beatdrop: could not remove {os.path.basename(path)} ({type(e).__name__})", file=sys.stderr)
                return False
            time.sleep(wait)
    return False
