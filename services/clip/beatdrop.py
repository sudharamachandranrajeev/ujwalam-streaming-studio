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
import statistics

import beatdrop_fx as bfx
from clip_common import CLIP_DATA, ClipError, load_json, on_air

_HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(CLIP_DATA, "beatdrop.json")
GAMES = os.path.normpath(os.path.join(_HERE, "..", "..", "data", "games"))
PLAN = "beatdrop-plan.json"
OUT = "beatdrop.mp4"
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
    def __init__(self, moments_doc, smap, cfg, game, style, max_sec, rec_seconds):
        self.cfg, self.game = cfg, game
        self.fps = int(cfg["fps"])
        self.rfps = float(moments_doc["fps"])
        self.rec_len = float(rec_seconds or moments_doc["seconds"])
        ms = moments_doc["moments"]
        st = self.st = lambda m: m["frame"] / self.rfps  # noqa: E731 - the moment's source time from its frame
        self.kills = sorted((m for m in ms if m["kind"] == "kill"), key=lambda m: (-m["strength"], m["frame"]))
        margin = float(game["noKillMarginSec"])
        self.killish = sorted(st(m) for m in ms if m["kind"] in ("kill", "gunshot", "hit", "killcam"))
        self.sounds = sorted(st(m) for m in ms if m["kind"] in ("kill", "gunshot"))
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
        drops = [d for d in sm.get("drops") or [] if d >= float(co["minSec"])]
        drop = drops[0] if drops else next((d for d in downs if d >= float(co["minSec"])), None)
        if drop is None:
            raise ClipError("beatdrop: the song has no drop or downbeat after the cold open's minimum length")
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
        self.effects = bfx.space_flashes(self.effects, int(fl["maxPerSec"]), float(fl["minGapSec"]))
        total_f = self.F(song_end)
        reel_beats = [round((b - self.song0), 4) for b in beats if self.song0 <= b <= song_end]
        return {"version": 1, "kind": "beatdrop", "status": "unverified", "fps": self.fps,
                "songStart": round(self.song0, 4), "total": round(total_f / self.fps, 4), "frames": total_f,
                "song": {"bpm": sm["bpm"], "period": period, "firstDrop": round(drop - self.song0, 4),
                         "beats": reel_beats},
                "targets": self.tg, "slots": slots, "pieces": self.pieces, "effects": self.effects,
                "stats": stats(self.pieces, self.fps)}

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


def plan(moments_doc, smap, cfg=None, game=None, style=None, max_sec=None, rec_seconds=None):
    """moments (moments.find_moments output) + song map (song_map.song_map output) [+ mapped reel style] -> plan."""
    cfg = cfg or load_config()
    game = game or load_game(moments_doc.get("game") or "codm")
    return _Planner(moments_doc, smap, cfg, game, style, max_sec, rec_seconds).build()


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


def make(recording, moments_doc, wd, data_dir, ffmpeg, encoder_args, audio_args, frame=None, style=None,
         seed_parts=(), live=on_air, audio_tracks=1, max_sec=None, lock_dir=None, cfg=None):
    """One BeatDrop montage, off air only, one heavy job at a time: the song (NCS library pick or the made-here bed),
    its song map, the plan (wd/beatdrop-plan.json), the bed, the style's LUT and the one ffmpeg run (wd/beatdrop.mp4).
    -> {"plan", "music" (the record for render.json), "returncode", "stderr", "file", "argv"}."""
    import song_map as smod  # noqa: PLC0415
    from clip_common import HeavyJobLock, run_tool, write_json_atomic  # noqa: PLC0415
    cfg = cfg or load_config()
    if live is None or live() is not False:
        raise ClipError("the studio is live or recording (or that cannot be told): BeatDrop montages are made off air only")
    frame = frame or cfg["frame"]
    os.makedirs(wd, exist_ok=True)
    with HeavyJobLock(lock_dir, job="beatdrop"):
        song, record = pick_music(data_dir, settings_of(data_dir), seed_parts, live=live)
        if song is None:
            path, record = made_here_song(wd, float(max_sec or cfg["maxSec"]) + 8.0, seed_parts)
            song = {"path": path, "root": wd}
        smap = smod.song_map(song["path"], song["root"], live=live)
        pl = plan(moments_doc, smap, cfg, style=style, max_sec=max_sec)
        write_json_atomic(os.path.join(wd, PLAN), pl)
        wav = music_bed(wd, pl, song["path"], song["root"], cfg)
        lut = None
        if style and style.get("colour"):
            import reel_style as rstyle  # noqa: PLC0415
            ref = rstyle.clip_colour(recording, render_pieces(pl))
            rstyle.write_lut(os.path.join(wd, rstyle.LUT_FILE), style["colour"], style["colour"]["strength"], ref)
            lut = rstyle.LUT_FILE
        if live() is not False:
            raise ClipError("the studio went live: the BeatDrop montage was stopped before rendering")
        argv = render_argv(pl, ffmpeg, recording, frame, encoder_args, audio_args, wav, OUT + ".part",
                           lut=lut, audio_tracks=audio_tracks)
        argv = graph_from_file(argv, wd)
        r = run_tool(argv, cwd=wd, watch=OUT + ".part", stall_sec=300)
        for f in (wav, lut, GRAPH):
            if f:
                try:
                    os.remove(os.path.join(wd, f))
                except OSError:
                    pass
        if r.returncode == 0 and os.path.isfile(os.path.join(wd, OUT + ".part")):
            os.replace(os.path.join(wd, OUT + ".part"), os.path.join(wd, OUT))
    return {"plan": pl, "music": record, "returncode": r.returncode, "stderr": (r.stderr or "")[-400:],
            "file": OUT if r.returncode == 0 else None, "argv": argv}
