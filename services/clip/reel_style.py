# SPDX-License-Identifier: GPL-3.0-or-later
"""RS2 reel style record and mapping, RS4 render plan (plan docs/plan/2026-11-21-reel-styles-library.md, D412).

A style lives in <data>/clips/styles/<id>/style.json (schema data/clip/reel-style.schema.json, version 1):
  {version, id, name, examples: [{path, sha256, seconds}], cuts, ramps, zooms, transitions, text, colour{lut, strength},
   music, measured, tune, summary}
The mapped parts are rebuilt from Ujwalam's own effects (never pixel copies): pace and beat cuts, a transition mix
mapped onto the D411 transition sets, the zoom-pulse and speed-ramp core functions (registry/functions), the D411 name
style and position, a 17^3 .cube LUT fitted against the user's own clip (strength capped), and the music energy
target. Every mapped value can be tuned afterwards (tune: shotSec, lutStrength, zoomScale, rampFactor, musicEnergy).

  load_config(path=None)                     -> data/clip/reel-styles.json
  style_problems(doc, cfg, analysed=True)    -> [] when the record is fine
  from_measured(measured, cfg)               -> the mapped parts + summary (plain words)
  effective(doc, cfg)                        -> mapped parts with the user's tuning laid over them
  load_style / list_styles / chosen(data_dir, reel type)
  write_lut(path, colour, strength, ref, cfg) / clip_colour(src, pieces)
  pace(pieces, shot_sec, ...)  transitions_for(...)  zoom_for(...)  ramp_for(...)  plan(...)
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
import random
import re

from clip_common import CLIP_DATA, SETTINGS_FILE, ClipError, flag_on, load_json

CONFIG_FILE = os.path.join(CLIP_DATA, "reel-styles.json")
FLAG = "reel-styles"
PARTS = ("cuts", "ramps", "zooms", "transitions", "text", "colour", "music")
LUT_FILE = "style.cube"
_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def load_config(path=None):
    return load_json(path or CONFIG_FILE)


def on(data_dir):
    return flag_on(data_dir, FLAG)


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _clamp(v, r):
    return max(float(r["min"]), min(float(r["max"]), float(v)))


# ---------------------------------------------------------------- the record

def style_problems(doc, cfg=None, analysed=True):
    """Problems with a style.json; [] when fine. analysed=False: a new style (name and examples only) is fine."""
    cfg = cfg or load_config()
    if not isinstance(doc, dict):
        return ["style must be an object"]
    out = []
    if doc.get("version") != int(cfg["styleVersion"]):
        out.append(f"version must be {cfg['styleVersion']}")
    if "id" in doc and not (isinstance(doc["id"], str) and _ID.match(doc["id"])):
        out.append("id must be lower-case letters, digits and dashes (up to 40)")
    n = doc.get("name")
    if not isinstance(n, str) or not n.strip() or len(n) > int(cfg["nameMaxChars"]) or re.search(r"[\x00-\x1f]", n):
        out.append(f"name must be 1 to {cfg['nameMaxChars']} characters")
    ex = doc.get("examples")
    if not isinstance(ex, list) or not 1 <= len(ex) <= int(cfg["maxExamples"]):
        out.append(f"examples must list 1 to {cfg['maxExamples']} videos")
    else:
        for i, e in enumerate(ex):
            w = f"examples[{i}]"
            if not isinstance(e, dict) or not isinstance(e.get("path"), str) or not e["path"] \
                    or len(e["path"]) > int(cfg["pathMaxChars"]) or re.search(r"[\x00-\x1f]", e["path"]):
                out.append(f"{w}.path must be a file path up to {cfg['pathMaxChars']} characters")
                continue
            if analysed or "sha256" in e:
                if not (isinstance(e.get("sha256"), str) and _HEX64.match(e["sha256"])):
                    out.append(f"{w}.sha256 must be 64 hex digits")
            if analysed or "seconds" in e:
                if not (_num(e.get("seconds")) and 0 < e["seconds"] <= float(cfg["maxExampleSec"])):
                    out.append(f"{w}.seconds must be above 0 and at most {cfg['maxExampleSec']}")
            extra = set(e) - {"path", "sha256", "seconds"}
            if extra:
                out.append(f"{w} has unknown keys {', '.join(sorted(extra))}")
    out += tune_problems(doc.get("tune", {}), cfg)
    if analysed:
        if not isinstance(doc.get("measured"), dict):
            out.append("measured must be an object (run the analysis)")
        for p in PARTS:
            if p not in doc:
                out.append(f"{p} is missing (null when it could not be measured)")
            elif doc[p] is not None and not isinstance(doc[p], dict):
                out.append(f"{p} must be an object or null")
        c = doc.get("colour")
        if isinstance(c, dict):
            if c.get("lut") != LUT_FILE:
                out.append(f"colour.lut must be {LUT_FILE}")
            if not (_num(c.get("strength")) and 0 <= c["strength"] <= 1):
                out.append("colour.strength must be from 0 to 1")
    return out


def tune_problems(t, cfg=None):
    cfg = cfg or load_config()
    if not isinstance(t, dict):
        return ["tune must be an object"]
    out = []
    for k, v in t.items():
        r = cfg["tune"].get(k)
        if r is None:
            out.append(f"unknown tune setting {k}")
        elif v is not None and not (_num(v) and float(r["min"]) <= v <= float(r["max"])):
            out.append(f"tune.{k} must be from {r['min']} to {r['max']}")
    return out


def new_style(style_id, name, paths, cfg=None):
    """A style before analysis: name and example paths only (the videos are never copied)."""
    cfg = cfg or load_config()
    doc = {"version": int(cfg["styleVersion"]), "id": style_id, "name": name,
           "examples": [{"path": p} for p in paths], "tune": {}}
    probs = style_problems(doc, cfg, analysed=False)
    if probs:
        raise ClipError("; ".join(probs))
    return doc


# ---------------------------------------------------------------- mapping

def _nearest_set(mix, cfg):
    """The D411 transition set whose mix of non-hard joins is closest to the measured one."""
    soft = {k: float(mix.get(k, 0.0)) for k in ("fade", "flash", "whip")}
    tot = sum(soft.values())
    if tot <= 0:
        return None
    soft = {k: v / tot for k, v in soft.items()}
    best, bd = None, 1e9
    for sid, m in cfg["map"]["setMix"].items():
        d = sum((soft[k] - float(m.get(k, 0.0))) ** 2 for k in soft)
        if d < bd:
            best, bd = sid, d
    return best


def from_measured(m, cfg=None):
    """Mapped style parts from the merged analysis (style_analyse.merge). A part with no measurement is None."""
    cfg = cfg or load_config()
    mp = cfg["map"]
    out = {p: None for p in PARTS}
    c = m.get("cuts")
    if c and c.get("shotSec"):
        out["cuts"] = {"shotSec": round(_clamp(c["shotSec"], mp["shotSec"]), 2), "ratePerMin": c.get("ratePerMin"),
                       "beatCuts": bool(c.get("beatShare") is not None and c["beatShare"] >= float(mp["beatShareForBeatCuts"])),
                       "beatShare": c.get("beatShare")}
    t = m.get("transitions")
    if t:
        mix = t["mix"]
        hard = float(mix.get("hard", 0.0))
        out["transitions"] = {"mix": dict(mix), "mode": "hard" if hard >= float(mp["hardShareForCuts"]) else "set",
                              "set": _nearest_set(mix, cfg),
                              "weights": {k: round(float(mix.get(k, 0.0)), 3) for k in ("fade", "flash", "whip")}}
    z = m.get("zooms")
    if z and z.get("scale") and (z.get("ratePerMin") or 0) > 0:
        out["zooms"] = {"preset": "zoom-pulse-kill-slam" if z["scale"] >= 1.12 else "zoom-pulse-beat-punch",
                        "scale": round(_clamp(z["scale"], mp["zoomScale"]), 3),
                        "inMs": int(min(550, max(80, 1000 * (z.get("inSec") or 0.15)))),
                        "outMs": int(min(350, max(100, 1000 * (z.get("outSec") or 0.2)))),
                        "ratePerMin": z["ratePerMin"], "on": "beats" if (m.get("cuts") or {}).get("beatShare") else "kills",
                        "shakePct": z.get("shakePct")}
    r = m.get("ramps")
    if r and r.get("factor") and (r.get("ratePerMin") or 0) > 0:
        out["ramps"] = {"preset": "speed-ramp-kill-slowmo", "factor": round(_clamp(r["factor"], mp["rampFactor"]), 2),
                        "sec": 0.6, "ratePerMin": r["ratePerMin"], "unverified": True}
    tx = m.get("text")
    if tx and tx.get("perMin"):
        band, corner = tx.get("band"), float(tx.get("cornerShare") or 0.0)
        style = "corner-tag" if corner >= 0.5 else ("lower-third" if band == "bottom" else "kinetic")
        pos = {"corner-tag": "top-left" if band == "top" else "bottom-left", "lower-third": "lower-third",
               "kinetic": "upper-third"}[style]
        out["text"] = {"nameStyle": style, "position": pos, "captionBand": band, "sizePct": tx.get("sizePct"),
                       "sec": tx.get("sec")}
    col = m.get("colour")
    if col:
        out["colour"] = {"lut": LUT_FILE, "strength": float(mp["lutStrength"]["default"]), "L": col["L"], "a": col["a"],
                         "b": col["b"], "contrast": col["contrast"],
                         "tone": "warm" if col["b"] > mp["warmB"] else ("cool" if col["b"] < -mp["warmB"] else "neutral")}
    mu = m.get("music")
    if mu:
        out["music"] = {"energyLevel": mu.get("energyLevel"), "mood": mu.get("mood"), "bpm": mu.get("bpm")}
    out["summary"] = summary(out)
    return out


def summary(s):
    """The measured style in plain words ("cuts every 1.2 s, 70 % on the beat, warm colour, zoom pulse on kills")."""
    words = []
    c = s.get("cuts")
    if c:
        w = f"cuts every {c['shotSec']:.1f} s"
        if c.get("beatShare") is not None:
            w += f", {round(100 * c['beatShare'])} % on the beat"
        words.append(w)
    t = s.get("transitions")
    if t:
        words.append("mostly hard cuts" if t["mode"] == "hard" else f"joins like {t['set']}")
    col = s.get("colour")
    if col:
        words.append(f"{col['tone']} colour")
    z = s.get("zooms")
    if z:
        words.append(f"zoom pulse on {z['on']}")
    r = s.get("ramps")
    if r:
        words.append(f"slow motion to {round(100 * r['factor'])} % around moments")
    tx = s.get("text")
    if tx:
        words.append(f"name as {tx['nameStyle'].replace('-', ' ')}")
    mu = s.get("music")
    if mu and mu.get("mood"):
        words.append(f"{mu['mood']} music")
    return ", ".join(words) if words else "nothing measured yet"


def effective(doc, cfg=None):
    """The mapped parts with the user's tuning laid over them (a copy)."""
    cfg = cfg or load_config()
    s = {p: copy.deepcopy(doc.get(p)) for p in PARTS}
    t = doc.get("tune") or {}
    if t.get("shotSec") is not None and s["cuts"]:
        s["cuts"]["shotSec"] = float(t["shotSec"])
    if t.get("lutStrength") is not None and s["colour"]:
        s["colour"]["strength"] = float(t["lutStrength"])
    if t.get("zoomScale") is not None and s["zooms"]:
        s["zooms"]["scale"] = float(t["zoomScale"])
        if t["zoomScale"] <= 1.0:
            s["zooms"] = None  # tuned to no zoom
    if t.get("rampFactor") is not None and s["ramps"]:
        s["ramps"]["factor"] = float(t["rampFactor"])
        if t["rampFactor"] >= 1.0:
            s["ramps"] = None  # tuned to no slow motion
    if t.get("musicEnergy") is not None and s["music"]:
        s["music"]["energyLevel"] = float(t["musicEnergy"])
    return s


# ---------------------------------------------------------------- the library on disk

def styles_root(data_dir, cfg=None):
    cfg = cfg or load_config()
    return os.path.join(data_dir, *cfg["stylesDir"].split("/"))


def load_style(data_dir, style_id, cfg=None, analysed=True):
    cfg = cfg or load_config()
    if not (isinstance(style_id, str) and _ID.match(style_id)):
        return None
    try:
        doc = load_json(os.path.join(styles_root(data_dir, cfg), style_id, "style.json"))
    except (OSError, ClipError):
        return None
    return doc if not style_problems(doc, cfg, analysed=analysed) else None


def list_styles(data_dir, cfg=None):
    cfg = cfg or load_config()
    root = styles_root(data_dir, cfg)
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    for n in names:
        d = load_style(data_dir, n, cfg, analysed=False)
        if d:
            out.append(d)
    return out


def chosen(data_dir, reel_type, cfg=None):
    """The analysed style the user picked for this reel type (settings.json clips.reelStyles.byType), or None."""
    cfg = cfg or load_config()
    if not data_dir or reel_type not in cfg["reelTypes"] or not on(data_dir):
        return None
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return None
    rs = ((j.get("clips") or {}).get("reelStyles") or {}) if isinstance(j, dict) else {}
    sid = (rs.get("byType") or {}).get(reel_type) if isinstance(rs, dict) else None
    return load_style(data_dir, sid, cfg) if sid else None


# ---------------------------------------------------------------- colour (LUT)

def _lab_to_bgr(lab):
    import cv2  # noqa: PLC0415
    return cv2.cvtColor(lab.astype("float32"), cv2.COLOR_Lab2BGR)


def lut_transform(colour, strength, ref=None, cfg=None):
    """-> f(lab array) moving the reference clip's Lab statistics toward the style's, capped (D412: skin and HUD stay
    readable): L shift <= shiftL, a/b shift <= shiftAB, contrast factor within [contrastMin, contrastMax]."""
    cfg = cfg or load_config()
    caps = cfg["map"]["lutCaps"]
    ref = ref or {"L": colour["L"], "a": 0.0, "b": 0.0, "contrast": colour["contrast"]}
    k = max(caps["contrastMin"], min(caps["contrastMax"], float(colour["contrast"]) / max(1e-3, float(ref["contrast"]))))
    dl = max(-caps["shiftL"], min(caps["shiftL"], float(colour["L"]) - float(ref["L"])))
    da = max(-caps["shiftAB"], min(caps["shiftAB"], float(colour["a"]) - float(ref["a"])))
    db = max(-caps["shiftAB"], min(caps["shiftAB"], float(colour["b"]) - float(ref["b"])))
    s = max(0.0, min(1.0, float(strength)))

    def f(lab):
        out = lab.copy()
        out[..., 0] = lab[..., 0] + s * ((lab[..., 0] - float(ref["L"])) * (k - 1.0) + dl)
        out[..., 1] = lab[..., 1] + s * da
        out[..., 2] = lab[..., 2] + s * db
        out[..., 0] = out[..., 0].clip(0, 100)
        return out
    f.shift = {"L": round(s * dl, 2), "a": round(s * da, 2), "b": round(s * db, 2), "contrast": round(1 + s * (k - 1), 3)}
    return f


def write_lut(path, colour, strength, ref=None, cfg=None):
    """A 17^3 .cube (red fastest) of lut_transform. -> the applied shift {L, a, b, contrast}."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    cfg = cfg or load_config()
    n = int(cfg["map"]["lutSize"])
    f = lut_transform(colour, strength, ref, cfg)
    g = np.linspace(0, 1, n, dtype=np.float32)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")  # b slowest, r fastest
    bgr = np.stack([b, gg, r], axis=-1).reshape(-1, 1, 3)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2Lab)
    out = _lab_to_bgr(f(lab)).reshape(-1, 3).clip(0, 1)
    with open(path, "w", encoding="ascii", newline="\n") as fh:
        fh.write("TITLE \"Ujwalam reel style\"\n")
        fh.write(f"LUT_3D_SIZE {n}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n")
        for px in out:
            fh.write(f"{px[2]:.6f} {px[1]:.6f} {px[0]:.6f}\n")
    return f.shift


def frame_colour(frames):
    """Lab statistics {L, a, b, contrast} (medians over frames, same measure as style_analyse) of BGR frames."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    L, a, b, s = [], [], [], []
    for img in frames:
        h, w = img.shape[:2]
        small = cv2.resize(img, (96, max(4, int(round(96 * h / w / 2)) * 2)), interpolation=cv2.INTER_AREA)
        lab = cv2.cvtColor(small.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab).reshape(-1, 3)
        L.append(float(lab[:, 0].mean()))
        a.append(float(lab[:, 1].mean()))
        b.append(float(lab[:, 2].mean()))
        s.append(float(lab[:, 0].std()))
    if not L:
        return None
    return {"L": float(np.median(L)), "a": float(np.median(a)), "b": float(np.median(b)), "contrast": float(np.median(s))}


def clip_colour(src, pieces, per_piece=3):
    """The user's own clip statistics (the LUT's neutral reference): a few frames from each piece. None on failure."""
    try:
        import av  # noqa: PLC0415
        imgs = []
        with av.open(src) as c:
            st = next(s for s in c.streams if s.type == "video")
            for p in pieces:
                for j in range(per_piece):
                    t = p["start"] + (j + 0.5) * (p["end"] - p["start"]) / per_piece
                    c.seek(int(t / st.time_base), stream=st, any_frame=False, backward=True)
                    for fr in c.decode(st):
                        if fr.time is not None and fr.time + 1e-3 >= t:
                            imgs.append(fr.to_ndarray(width=192, height=max(4, int(192 * fr.height / fr.width) // 2 * 2),
                                                      format="bgr24"))
                            break
        return frame_colour(imgs)
    except (OSError, ValueError, StopIteration, ImportError):  # the LUT falls back to the neutral reference
        return None


# ---------------------------------------------------------------- the render plan (RS4)

def _rng(*parts):
    return random.Random(int.from_bytes(hashlib.sha256("|".join(str(p) for p in parts).encode()).digest()[:8], "little"))


def pace(pieces, shot_sec, keep=(), gap_sec=0.5, min_sec=None):
    """Splits each piece longer than two shots into shots of shot_sec with a jump of gap_sec between them (footage in
    the gap is left out), so the reel cuts at the style's pace. A shot holding a kept moment (keep: source times) is
    never cut through. -> new pieces (only ever shorter in total: the D350 maximum still holds)."""
    min_sec = min_sec if min_sec is not None else max(0.4, 0.6 * shot_sec)
    out = []
    for p in pieces:
        d = p["end"] - p["start"]
        if d < 2 * shot_sec + gap_sec:
            out.append(dict(p))
            continue
        t = p["start"]
        while t < p["end"] - 1e-6:
            e = min(p["end"], t + shot_sec)
            for k in keep:  # stretch a shot to hold its moment and a little after it
                if t <= k < e + 0.25:
                    e = min(p["end"], max(e, k + 0.5))
            if p["end"] - e < min_sec:
                e = p["end"]
            out.append(dict(p, start=round(t, 3), end=round(e, 3)))
            t = e + gap_sec
            if p["end"] - t < min_sec:
                break
    return out


def transitions_for(style_tr, pieces, seed, rt, ms=None):
    """The style's joins as a reel_transition plan (None = hard cuts): the style's mix of fade / flash / whip as a
    one-off transition set (the D411 flash spacing still applies), or hard cuts when the style is mostly hard cuts."""
    if not style_tr or style_tr["mode"] == "hard" or len(pieces) < 2:
        return None
    d = copy.deepcopy(rt.load_defaults())
    cfg = load_config()
    joins = []
    for cls, w in style_tr["weights"].items():
        kinds = cfg["map"]["classXfade"].get(cls) or []
        for x in kinds:
            if w > 0:
                joins.append({"xfade": x, "weight": w / len(kinds), **({"flash": True} if cls == "flash" else {})})
    if not joins:
        return None
    base = d["setsById"].get(style_tr.get("set") or "clean") or d["setsById"]["clean"]
    sset = dict(base, id="style", joins=joins)
    d["setsById"]["style"] = sset
    tr = rt.plan_set(pieces, "style", seed, d=d, ms=ms)
    if tr:
        tr = rt.respace(pieces, tr, d) if hasattr(rt, "respace") else tr
        tr["setFrom"] = style_tr.get("set")
    return tr


def zoom_for(style_zoom, reel_times, xd_times=()):
    """Pulse times on the reel's moments (kills) or beats, at most 2 per second, never inside a join."""
    if not style_zoom or not reel_times:
        return None
    ti, to = style_zoom["inMs"] / 1000.0, style_zoom["outMs"] / 1000.0
    times = []
    for t in sorted(reel_times):
        if t - ti < 0:
            continue
        if times and t - times[-1] < max(0.5, ti + to + 0.05):
            continue
        if any(a - to <= t <= b + ti for a, b in xd_times):
            continue
        times.append(round(t, 3))
    return {"times": times, "scale": style_zoom["scale"], "inSec": ti, "outSec": to} if times else None


def ramp_for(style_ramp, piece, moment, catch_up=2.0, audio="sync"):
    """A speed ramp around a moment (source time) inside a piece, or None when the piece is too short: slow to factor
    for sec from just before the moment, then catch up at catch_up until the piece is back on its own clock."""
    if not style_ramp:
        return None
    f, sec = float(style_ramp["factor"]), float(style_ramp["sec"])
    if f >= 1.0:
        return None
    at = max(0.05, moment - piece["start"] - 0.15)
    catch = sec * (1.0 / f - 1.0) * catch_up / (catch_up - 1.0)
    end = at + sec + catch
    if end > piece["end"] - piece["start"] - 0.1:
        return None
    return {"at": round(at, 4), "sec": round(sec, 4), "factor": round(f, 4), "catchUp": float(catch_up),
            "catchUpEnd": round(end, 4), "audio": audio}


def reel_moments(pieces, xd, moments):
    """Source-time moments -> reel (output) times, for pieces joined with overlap xd."""
    out, acc = [], 0.0
    for i, p in enumerate(pieces):
        for m in moments:
            if p["start"] <= m < p["end"]:
                out.append(acc + (m - p["start"]))
        acc += (p["end"] - p["start"]) - (xd if i < len(pieces) - 1 else 0.0)
    return out
