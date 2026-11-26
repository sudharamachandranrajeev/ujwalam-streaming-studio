# SPDX-License-Identifier: GPL-3.0-or-later
"""RL4 realism looks for reels (plan docs/plan/2026-11-25-realism-looks.md, D445): the studio's realism looks
(data/looks/<id>.json, LUTs in data/luts) on reels the clip worker renders off air with ffmpeg.

One source of truth: the look JSON. Its amounts are mapped to ffmpeg filters here, and only here (filter_graph).

  Settings > Clips > Clip look > Realism look, per reel type (reel, impact, montage), in <data>/settings.json
  clips.realismLooks = {"byType": {<type>: {"mode": "off" | "one" | "random", "look": id | null, "ticks": [id]}}}
    off     no realism look (the reel is made exactly as before)
    one     always the look `look`
    random  a seeded pick from `ticks`: the same reel (same seed parts) draws the same look on every render
  A type left out is off. A look that is gone from data/looks is skipped (one: off; random: drawn from the rest).
  services/studio-ui/user-settings.mjs checks the same value with the same rules (realismLooksProblems).

  Order with the reel style (RS4): a realism look REPLACES the reel style's colour (its fitted LUT) on that reel; the
  style's pace, joins, zoom pulses and slow motion stay. Never both colours stacked: two grades on top of each other
  push skin and HUD colours twice as far.

  ffmpeg mapping (the host shaders in app/host/data/effects are the reference; ffmpeg has no exact twin of each):
    clean-up  atadenoise, light (a little temporal averaging, thresholds low so motion is not smeared); every look
    lut       lut3d of the look's .cube mixed with the identity by `amount` (as the host's clut amount), tetrahedral
    bloom     split; the copy at half size, bright pass (lutrgb: above threshold, stretched), gblur sigma
              = size % of the shorter side / 2 (host: reach / 2), back to full size; blend screen at 2 x amount
    chromatic rgbashift: red one way, blue the other, amount x 0.5 % of the shorter side in px (host: radial, the
              same size at the corners); left out when that rounds to 0 px
    clarity   unsharp on luma with its largest matrix (size % of the shorter side, odd, 3..13: ffmpeg allows lx+ly <= 25), luma amount = amount
              (host: 1.5 x amount weighted to mid tones, about 1 x on average)
    sharpen   cas (contrast adaptive sharpen) on luma only, strength = amount (on chroma it shifts flat colours)
    vignette  vignette with the angle that darkens the corners as much as the host does (cos^4 falloff)
    grain     noise on luma only, temporal and uniform, strength = amount x 64 (host: +-amount/4 of full range),
              fixed seed from the reel; last, so no other step sharpens or blooms it
  Colour and glow work in RGB (gbrp), detail, vignette and grain in YUV 4:4:4; the chain ends in yuv420p.

  load_looks(dir, user_dir) / look_by_id / problems(v, ids) / effective(data_dir) / pick(data_dir, type, seed_parts)
  RL5: the user's own looks in <data>/looks (ids "user-...", LUT base "userluts") are merged in by pick and lut_path.
  write_lut(path, look, luts_dir, data_dir) / filter_graph(look, w, h, seed, lut_name, src, dst) / plan(look, wd, frame, seed_parts) / cleanup
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re

from clip_common import REPO_ROOT, SETTINGS_FILE, ClipError, load_json

LOOKS_DIR = os.path.join(REPO_ROOT, "data", "looks")
LUTS_DIR = os.path.join(REPO_ROOT, "data", "luts")
REEL_TYPES = ("reel", "impact", "montage")
MODES = ("off", "one", "random")
SETTINGS_KEY = "realismLooks"
LUT_FILE = "realism.cube"
_ID = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
USER_PREFIX = "user-"   # RL5: the user's own looks (services/clip/look_reference.py)
USER_SUBDIR = "looks"
_REL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.cube$")
MAX_TICKS = 32

# the light clean-up ahead of every look (atadenoise thresholds per plane; s = frames averaged)
CLEAN = "atadenoise=0a=0.01:0b=0.02:1a=0.01:1b=0.02:2a=0.01:2b=0.02:s=5"
GRAIN_SCALE = 64.0      # noise strength per grain amount (host grain: +-amount/4 of full range = amount x 64 of 255)
CHROMATIC_PCT = 0.005   # host chromatic: amount 1 = 0.5 % of the shorter side at the corners


# ---------------------------------------------------------------- the look library

def _usable(look, file, base="luts"):
    """Same rule as services/project/looks.mjs usable(): a file that is not a look is skipped. base: "luts" for the
    built-in looks (data/looks), "userluts" for the user's own (RL5, <data>/looks, ids "user-...")."""
    if not isinstance(look, dict) or look.get("version") != 1 or not _ID.match(str(look.get("id") or "")):
        return False
    if f"{look['id']}.json" != file:
        return False
    n = look.get("name")
    if not isinstance(n, str) or not n.strip() or len(n) > 24:
        return False
    fx = look.get("effects")
    if not isinstance(fx, list) or not fx or not isinstance(look.get("backdrop"), list):
        return False
    lut = fx[0]
    return (isinstance(lut, dict) and lut.get("type") == "lut" and isinstance(lut.get("file"), dict)
            and lut["file"].get("base") == base and isinstance(lut["file"].get("rel"), str)
            and (base == "luts") != look["id"].startswith(USER_PREFIX)
            and bool(_REL.match(lut["file"]["rel"])))


def _read_dir(d, base):
    try:
        files = sorted(f for f in os.listdir(d) if f.endswith(".json"))
    except OSError:
        return []
    out = []
    for f in files:
        try:
            with open(os.path.join(d, f), encoding="utf-8") as fh:
                lk = json.load(fh)
        except (OSError, ValueError):
            continue
        if _usable(lk, f, base):
            out.append(lk)
    return out


def user_looks_dir(data_dir):
    """RL5: the user's own looks (JSON + LUT), <data>/looks; None without a data folder."""
    return os.path.join(data_dir, USER_SUBDIR) if data_dir else None


def load_looks(looks_dir=None, user_dir=None):
    """[look] sorted as the studio menu (Filmic first, then the built-in looks by name, then the user's own looks by
    name); broken files skipped. user_dir: <data>/looks (RL5) merged in; an id that is not "user-..." there is skipped."""
    out = sorted(_read_dir(looks_dir or LOOKS_DIR, "luts"), key=lambda x: (x["id"] != "filmic", x["name"].lower()))
    if user_dir:
        out += sorted(_read_dir(user_dir, "userluts"), key=lambda x: x["name"].lower())
    return out


def lut_path(look, data_dir=None, luts_dir=None):
    """The look's .cube on disk: base luts = data/luts (or luts_dir), base userluts = <data>/looks."""
    f = look["effects"][0]["file"]
    if f["base"] == "userluts":
        if not data_dir:
            raise ClipError(f"{look['id']}: your own look needs the data folder")
        return os.path.join(user_looks_dir(data_dir), f["rel"])
    return os.path.join(luts_dir or LUTS_DIR, f["rel"])


def look_by_id(look_id, looks=None):
    looks = load_looks() if looks is None else looks
    return next((x for x in looks if x["id"] == look_id), None)


# ---------------------------------------------------------------- the settings model

def problems(v, ids=None):
    """Problems with a clips.realismLooks value; [] when fine. ids: the look ids that exist (None = only the form).
    A saved look id that is later removed from data/looks is not a problem here (pick skips it)."""
    if not isinstance(v, dict):
        return ["clips.realismLooks must be an object"]
    out = [f"unknown clips.realismLooks setting {k}" for k in v if k != "byType"]
    bt = v.get("byType", {})
    if not isinstance(bt, dict):
        return out + ["clips.realismLooks.byType must be an object"]
    for t, x in bt.items():
        w = f"clips.realismLooks.byType.{t}"
        if t not in REEL_TYPES:
            out.append(f"clips.realismLooks.byType: unknown reel type {t}")
            continue
        if not isinstance(x, dict):
            out.append(f"{w} must be an object")
            continue
        out += [f"unknown {w} setting {k}" for k in x if k not in ("mode", "look", "ticks")]
        if x.get("mode") not in MODES:
            out.append(f"{w}.mode must be one of {', '.join(MODES)}")
        lk = x.get("look")
        if lk is not None and not (isinstance(lk, str) and _ID.match(lk)):
            out.append(f"{w}.look must be empty or a look id")
        tk = x.get("ticks", [])
        if not isinstance(tk, list) or len(tk) > MAX_TICKS or any(not (isinstance(i, str) and _ID.match(i)) for i in tk) \
                or len(set(tk)) != len(tk):
            out.append(f"{w}.ticks must be up to {MAX_TICKS} different look ids")
        if x.get("mode") == "one" and not lk:
            out.append(f"{w}: one look needs the look")
        if ids is not None:
            known = set(ids)
            if lk and lk not in known:
                out.append(f"{w}.look: unknown look {lk}")
            if isinstance(tk, list) and any(isinstance(i, str) and i not in known for i in tk):
                out.append(f"{w}.ticks: unknown look")
    return out


def _off():
    return {"mode": "off", "look": None, "ticks": []}


def effective(data_dir):
    """{type: {"mode", "look", "ticks"}} for every reel type; off where nothing (valid) is saved."""
    out = {t: _off() for t in REEL_TYPES}
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError, ValueError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    v = c.get(SETTINGS_KEY) if isinstance(c, dict) else None
    if v is None or problems(v):
        return out
    for t, x in (v.get("byType") or {}).items():
        out[t] = {"mode": x["mode"], "look": x.get("look"), "ticks": list(x.get("ticks") or [])}
    return out


def seed_of(*parts):
    return int.from_bytes(hashlib.sha256("|".join(str(p) for p in parts).encode("utf-8")).digest()[:4], "big")


def pick(data_dir, reel_type, seed_parts=(), looks=None):
    """This reel's realism look -> (look or None, record or None). random: the project's seeded pick (clip_look
    weighted_pick, equal weights, seeded by the reel and the type; no history, so a re-render draws the same look)."""
    if reel_type not in REEL_TYPES:
        return None, None
    s = effective(data_dir)[reel_type]
    if s["mode"] == "off":
        return None, None
    looks = load_looks(user_dir=user_looks_dir(data_dir)) if looks is None else looks
    by_id = {x["id"]: x for x in looks}
    if s["mode"] == "one":
        lk = by_id.get(s["look"])
        if not lk:
            return None, {"mode": "one", "skipped": f"the look {s['look']} is not installed"}
        return lk, {"mode": "one"}
    pool = [i for i in s["ticks"] if i in by_id]
    if not pool:
        return None, {"mode": "random", "skipped": "no ticked look is installed"}
    import clip_look as clook  # noqa: PLC0415
    chosen = clook.weighted_pick(clook._rng(list(seed_parts), "realism-" + reel_type), pool, [1.0] * len(pool))
    return by_id[chosen], {"mode": "random", "from": pool}


# ---------------------------------------------------------------- the LUT

def read_cube(path):
    """-> (n, [(r, g, b)] red fastest) of a .cube file."""
    n, rows = None, []
    with open(path, encoding="ascii") as fh:
        for line in fh:
            s = line.strip()
            if not s or s.startswith("#") or s.startswith("TITLE") or s.startswith("DOMAIN_"):
                continue
            if s.startswith("LUT_3D_SIZE"):
                n = int(s.split()[1])
                continue
            r, g, b = (float(x) for x in s.split()[:3])
            rows.append((r, g, b))
    if not n or len(rows) != n ** 3:
        raise ClipError(f"{os.path.basename(path)} is not a 3D LUT")
    return n, rows


def lut_effect(look):
    return look["effects"][0]


def write_lut(path, look, luts_dir=None, data_dir=None):
    """The look's LUT mixed with the identity by its amount (the host's clut amount), as a .cube at path."""
    e = lut_effect(look)
    amt = max(0.0, min(1.0, float(e.get("amount", 1.0))))
    n, rows = read_cube(lut_path(look, data_dir, luts_dir))
    k = n - 1
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        fh.write(f"TITLE \"Ujwalam realism look {look['id']}\"\nLUT_3D_SIZE {n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n")
        for i, (r, g, b) in enumerate(rows):
            ir, ig, ib = (i % n) / k, ((i // n) % n) / k, (i // (n * n)) / k
            fh.write(f"{ir + (r - ir) * amt:.6f} {ig + (g - ig) * amt:.6f} {ib + (b - ib) * amt:.6f}\n")
    return amt


# ---------------------------------------------------------------- ffmpeg filters

def _smooth(a, b, x):
    t = max(0.0, min(1.0, (x - a) / max(b - a, 1e-6)))
    return t * t * (3 - 2 * t)


def vignette_angle(e):
    """The ffmpeg vignette angle (corner factor cos(angle)^4) that darkens a corner as the host shader does there:
    1 - amount * smoothstep(size, size + softness, 1). None when the host leaves the corners as they are."""
    f = 1.0 - float(e.get("amount", 0)) * _smooth(float(e.get("size", 0.5)), float(e.get("size", 0.5)) + max(float(e.get("softness", 0.5)), 0.001), 1.0)
    if f >= 0.999:
        return None
    return math.acos(max(0.0, f) ** 0.25)


def _odd(x, lo=3, hi=13):
    v = int(round(x))
    v = v if v % 2 else v + 1
    return max(lo, min(hi, v))


def _even(x):
    return max(2, int(x) // 2 * 2)


def filter_graph(look, w, h, seed, lut_name=LUT_FILE, src="[rin]", dst="[rout]"):
    """The look as one ffmpeg filter graph fragment from src to dst (frame w x h) -> (fragment, [steps applied]).
    The fragment's own labels start with "rl" so it fits into any bigger graph."""
    m = min(w, h)
    rgb, yuv, chains = [f"lut3d=file={lut_name}:interp=tetrahedral"], [], []
    rgb_steps, yuv_steps = [], []
    bloom = grain = None
    for e in look["effects"][1:]:
        t, a = e.get("type"), float(e.get("amount", 0) or 0)
        if a <= 0:
            continue
        if t == "bloom" and bloom is None:
            bloom = e
        elif t == "grain" and grain is None:
            grain = e
        elif t == "chromatic":
            px = int(round(a * CHROMATIC_PCT * m))
            if px >= 1:
                rgb.append(f"rgbashift=rh={-px}:bh={px}:edge=smear")
                rgb_steps.append(f"chromatic {px}px")
        elif t == "clarity":
            k = _odd(float(e.get("size", 2)) / 100.0 * m)
            yuv.append(f"unsharp=lx={k}:ly={k}:la={a:.3f}:cx=3:cy=3:ca=0")
            yuv_steps.append("clarity")
        elif t == "sharpen":
            yuv.append(f"cas=strength={min(1.0, a):.3f}:planes=1")
            yuv_steps.append("sharpen")
        elif t == "vignette":
            ang = vignette_angle(e)
            if ang is not None:
                yuv.append(f"vignette=angle={ang:.4f}:eval=init")
                yuv_steps.append("vignette")
    if grain:
        s = max(1, int(round(float(grain["amount"]) * GRAIN_SCALE)))
        yuv.append(f"noise=c0s={s}:c0f=t+u:all_seed={int(seed) % 2147483647}")
        yuv_steps.append("grain")
    steps = ["clean", "lut"] + (["bloom"] if bloom else []) + rgb_steps + yuv_steps
    head = f"{src}{CLEAN},format=gbrp,{rgb[0]}"
    if bloom:
        a = min(1.0, 2.0 * float(bloom["amount"]))
        th = int(round(255 * max(0.0, min(0.95, float(bloom.get("threshold", 0.8))))))
        hw, hh = _even(w / 2), _even(h / 2)
        sig = max(0.5, float(bloom.get("size", 3)) / 100.0 * m / 2.0 / 2.0)  # reach/2, at half size
        lin = f"'clip((val-{th})*255/{255 - th},0,255)'"
        chains.append(f"{head}[rl0]")
        chains.append("[rl0]split=2[rla][rlb]")
        chains.append(f"[rlb]scale={hw}:{hh}:flags=bilinear,lutrgb=r={lin}:g={lin}:b={lin},gblur=sigma={sig:.2f}:steps=2,"
                      f"scale={w}:{h}:flags=bilinear,format=gbrp[rlg]")
        tail = ",".join(rgb[1:] + ["format=yuv444p"] + yuv + ["format=yuv420p"])
        chains.append(f"[rla][rlg]blend=all_mode=screen:all_opacity={a:.3f},{tail}{dst}")
    else:
        chains.append(",".join([head] + rgb[1:] + ["format=yuv444p"] + yuv + ["format=yuv420p"]) + dst)
    return ";".join(chains), steps


def plan(look, wd, frame, seed_parts=(), luts_dir=None, data_dir=None):
    """Writes the mixed LUT into wd (a bare name, cwd = wd for ffmpeg) -> (fragment from [rin] to [rout], record)."""
    seed = seed_of("realism", *seed_parts)
    amt = write_lut(os.path.join(wd, LUT_FILE), look, luts_dir, data_dir)
    frag, steps = filter_graph(look, int(frame["width"]), int(frame["height"]), seed)
    return frag, {"id": look["id"], "name": look["name"], "lutAmount": amt, "steps": steps, "seed": seed,
                  "replacesStyleColour": True}


def cleanup(wd):
    try:
        os.remove(os.path.join(wd, LUT_FILE))
    except OSError:
        pass

