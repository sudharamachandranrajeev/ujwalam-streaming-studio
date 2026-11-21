# SPDX-License-Identifier: GPL-3.0-or-later
"""RP1 reel transitions (plan 2026-11-12-reel-polish-music-learning.md): the join between the pieces of a reel.

Data: data/clip/transitions.json (kinds, each an ffmpeg xfade name or none, with the length range). The user's choice
is <data>/settings.json clips.reelTransition {kind, ms} (Settings > Clips); services/studio-ui/user-settings.mjs checks
it the same way as transition_problems() here. Behind the flag reel-transitions (off by default): off, or a bad value,
gives the hard cut of before.

active(data_dir) -> {"kind", "xfade", "ms"} for clip_montage.render_argv(transition=...), or None for a hard cut.
"""

from __future__ import annotations

import hashlib
import os
import random

from clip_common import CLIP_DATA, SETTINGS_FILE, ClipError, flag_on, load_json

DEFAULTS_FILE = os.path.join(CLIP_DATA, "transitions.json")
FLAG = "reel-transitions"


def load_defaults(path=None):
    """-> transitions.json with "byId" {id: kind row}."""
    d = load_json(path or DEFAULTS_FILE)
    d["byId"] = {k["id"]: k for k in d["kinds"]}
    if d["default"] not in d["byId"]:
        raise ClipError("transitions.json: the default kind is not listed")
    d["setsById"] = {s["id"]: s for s in d.get("sets") or []}
    for s in d["setsById"].values():
        r = s["ms"]
        if not (0 < r["min"] <= r["default"] <= r["max"] <= 600) or not s["joins"] or float(s["sfxDb"]) > -6:
            raise ClipError(f"transitions.json: set {s['id']} is out of its limits")
    return d


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def transition_problems(v, d=None):
    """Problems with a clips.reelTransition value {kind, ms}; [] when fine."""
    d = d or load_defaults()
    if not isinstance(v, dict) or sorted(v) != ["kind", "ms"]:
        return ["clips.reelTransition needs kind and ms"]
    k = d["byId"].get(v["kind"]) if isinstance(v["kind"], str) else None
    if not k:
        return [f"clips.reelTransition.kind must be one of {', '.join(d['byId'])}"]
    r = k.get("ms")
    if r and (not _num(v["ms"]) or not r["min"] <= v["ms"] <= r["max"]):
        return [f"clips.reelTransition.ms must be {r['min']}-{r['max']}"]
    return []


def effective(data_dir=None, d=None):
    """{"kind", "ms"}: the user's valid choice, else the default kind at its default length."""
    d = d or load_defaults()
    k = d["byId"][d["default"]]
    out = {"kind": k["id"], "ms": (k.get("ms") or {}).get("default", 0)}
    if data_dir:
        try:
            j = load_json(os.path.join(data_dir, SETTINGS_FILE))
        except (OSError, ClipError):
            return out
        c = j.get("clips") if isinstance(j, dict) else None
        v = c.get("reelTransition") if isinstance(c, dict) else None
        if v is not None and not transition_problems(v, d):
            out = {"kind": v["kind"], "ms": v["ms"]}
    return out


def active(data_dir=None, d=None):
    """The transition to render with, or None (flag off or a hard cut)."""
    d = d or load_defaults()
    if not flag_on(data_dir, FLAG):
        return None
    e = effective(data_dir, d)
    x = d["byId"][e["kind"]].get("xfade")
    return {"kind": e["kind"], "xfade": x, "ms": e["ms"]} if x else None


# ---------------------------------------------------------------- FX3 transition sets (D411)

def join_times(pieces, xd):
    """[(start, end)] of each join in reel time: join i overlaps the end of piece i-1 by xd (0 = a hard cut)."""
    out, acc = [], 0.0
    for i in range(1, len(pieces)):
        acc += float(pieces[i - 1]["end"]) - float(pieces[i - 1]["start"])
        s = acc - i * xd
        out.append((round(s, 3), round(s + xd, 3)))
    return out


def _seeded(*parts):
    return random.Random(int.from_bytes(hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()[:8], "little"))


def plan_set(pieces, set_id, seed, d=None, ms=None):
    """This reel's joins from a transition set -> {"kind", "set", "xfade", "ms", "joins", "flash", "sfx", "sfxDb"} for
    clip_montage.render_argv(transition=), or None (one piece, unknown set). Each join draws a kind (seeded, weighted, never
    the kind of the join before); a flash join closer than minFlashGapSec to the last flash join is drawn again from
    the set's non-flash kinds."""
    d = d or load_defaults()
    s = d["setsById"].get(set_id)
    if not s or len(pieces) < 2:
        return None
    ms = int(ms if ms is not None else s["ms"]["default"])
    tr = {"kind": set_id, "set": set_id, "xfade": s["joins"][0]["xfade"], "ms": ms}
    from clip_montage import crossfade_sec  # noqa: PLC0415 - clip_montage imports nothing from here
    xd = crossfade_sec(pieces, tr)
    rng = _seeded("joins", set_id, seed)
    gap = float(d["minFlashGapSec"])
    joins, flash, last_flash, prev = [], [], None, None
    for (a, _b) in join_times(pieces, xd):
        pool = [j for j in s["joins"] if j["xfade"] != prev] or s["joins"]
        if last_flash is not None and a - last_flash < gap:
            pool = ([j for j in pool if not j.get("flash")] or [j for j in s["joins"] if not j.get("flash")]
                    or [{"xfade": "fade", "weight": 1}])  # a set of flash joins only: a plain fade here
        x = rng.random() * sum(float(j["weight"]) for j in pool)
        acc, pick = 0.0, pool[-1]
        for j in pool:
            acc += float(j["weight"])
            if x < acc:
                pick = j
                break
        joins.append(pick["xfade"])
        flash.append(bool(pick.get("flash")))
        if pick.get("flash"):
            last_flash = a
        prev = pick["xfade"]
    return dict(tr, joins=joins, flash=flash, sfx=list(s["sfx"]), sfxDb=float(s["sfxDb"]))


def flash_rate_ok(pieces, tr, d=None):
    """True when no two flash joins are closer than minFlashGapSec (each flash join is one flash: up and back)."""
    d = d or load_defaults()
    if not tr or not tr.get("flash"):
        return True
    from clip_montage import crossfade_sec  # noqa: PLC0415
    ts = [a for (a, _b), f in zip(join_times(pieces, crossfade_sec(pieces, tr)), tr["flash"]) if f]
    return all(b - a >= float(d["minFlashGapSec"]) - 1e-6 for a, b in zip(ts, ts[1:]))


def beat_sync(pieces, xd, beats, max_shift=None, min_piece=1.0, d=None):
    """FX3 beatSync: each join moved up to max_shift seconds EARLIER onto the nearest beat at or before it, by trimming
    the tail of the piece before the join (a piece ends postSec after its last kill, so its kill is never cut); a piece
    never gets shorter than min_piece. beats: reel times. -> (new pieces, [shift per join])."""
    d = d or load_defaults()
    max_shift = float(d["maxBeatShiftSec"] if max_shift is None else max_shift)
    ps = [dict(p) for p in pieces]
    shifts = []
    bs = sorted(float(b) for b in beats or [])
    for i in range(1, len(ps)):
        (a, b), = join_times(ps[: i + 1], xd)[-1:]
        centre = (a + b) / 2.0
        cand = [t for t in bs if 0.0 <= centre - t <= max_shift]
        sh = round(centre - max(cand), 3) if cand else 0.0
        p = ps[i - 1]
        if sh and (p["end"] - sh) - p["start"] >= max(min_piece, 2 * xd + 0.1) and not p.get("result"):
            p["end"] = round(p["end"] - sh, 3)
        else:
            sh = 0.0
        shifts.append(sh)
    return ps, shifts