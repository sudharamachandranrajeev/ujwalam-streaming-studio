# SPDX-License-Identifier: GPL-3.0-or-later
"""RL5 New look from a reference (plan docs/plan/2026-11-25-realism-looks.md, D445).

The user picks a screenshot or a short video of a look they like. Its colour is measured with the Reel styles colour
analysis (reel_style.frame_colour: Lab mean and spread, the same measure style_analyse uses) and turned into a 17^3
.cube with the Reel styles LUT writer (reel_style.write_lut, the same caps: L shift <= 12, a/b shift <= 15, contrast
0.8..1.25, so skin and HUD stay readable). A look JSON is written next to it. Nothing from the reference file is copied
or kept: only the measured numbers are saved (no path, no file name, no picture).

  Where: <data>/looks/<id>.json and <id>.cube (the user's data folder, never the repo). Ids start with "user-". The
  look's LUT effect points at file base "userluts" (= <data>/looks; the host and the reel path resolve it there).
  services/project/looks.mjs and clip_realism.load_looks merge these with the built-in looks.

  Colour: the reference's Lab statistics (black bars left out) against a neutral picture (NEUTRAL: a = b = 0, mid
  brightness, a typical spread). A blue cast in the reference becomes the same blue push in the LUT (capped as above);
  brightness and contrast move by TONE_SHARE of their difference only (content, not grade, drives most of them).
  Effects: glow, grain, vignette, clarity and the rest start from the nearest built-in look by colour distance (the
  LUT's shift on a grey ramp, Lab units; contrast weighted CONTRAST_WEIGHT per unit of factor). The studio says so.

  measure_reference(path) -> {L, a, b, contrast}       (raises ClipError for a file that is not a picture or video)
  apply_lut(n, rows, rgb) / lut_shift(n, rows, amount) -> {L, a, b, contrast} shift on the grey ramp
  nearest_builtin(shift, looks) -> (look, distance)
  make_look(data_dir, path, name) -> the saved look (JSON) + {"basedOn": {id, name}, "measured": {...}}
CLI (the studio): look_reference.py make --data-dir D --json '{"path": "...", "name": "..."}'  -> one JSON line.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys as _sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in _sys.path:  # run as a script with -I (the studio): the clip modules sit next to this file
    _sys.path.insert(0, _HERE)

from clip_common import ClipError, eprint, lower_own_priority, write_json_atomic  # noqa: E402

USER_SUBDIR = "looks"
USER_BASE = "userluts"
PREFIX = "user-"
MAX_USER_LOOKS = 40
# The neutral picture the reference is compared with: no colour cast, mid brightness, the L spread of a typical game
# frame. UNVERIFIED value for the spread (20 L units); tune after RL6 if user looks come out too flat or too punchy.
NEUTRAL = {"L": 50.0, "a": 0.0, "b": 0.0, "contrast": 20.0}
CONTRAST_WEIGHT = 40.0          # nearest look: 0.1 of contrast factor counts as 4 Lab units
# Brightness and contrast are taken at this share of the measured difference (the colour cast in full): a reference's
# mean brightness says as much about its content (a night map, a dark room) as about its grade. UNVERIFIED (RL6).
TONE_SHARE = 0.5
BORDER_MAX = 16                 # rows and columns this dark all the way across are bars around the picture, not the look
IMAGE_EXT = {".png": True, ".jpg": True, ".jpeg": True, ".bmp": True, ".webp": True}
MAX_IMAGE_MB = 40
VIDEO_FRAMES = 12
# tools/make-look-luts.mjs SWATCH_REFS (shadow grey, skin, foliage, sky, red); tests/py/test_look_reference.py checks
SWATCH_REFS = ((0.15, 0.15, 0.15), (0.87, 0.65, 0.52), (0.33, 0.47, 0.22), (0.45, 0.62, 0.85), (0.8, 0.12, 0.1))


def user_dir(data_dir):
    return os.path.join(os.path.abspath(data_dir), USER_SUBDIR)


def clean_name(name):
    n = " ".join(str(name or "").split())[:24].strip()
    return n


# ---------------------------------------------------------------- reading the reference

def _image(path):
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    if os.path.getsize(path) > MAX_IMAGE_MB * 1048576:
        raise ClipError(f"{os.path.basename(path)}: larger than {MAX_IMAGE_MB} MB")
    img = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)  # fromfile: any path, also non-ASCII
    if img is None or img.size == 0:
        raise ClipError(f"{os.path.basename(path)}: not a picture this PC can read")
    return [img]


def _video(path):
    """VIDEO_FRAMES frames spread over the video, opened as the Reel styles examples are (style_analyse.safe_open:
    the demuxer named from the extension, file protocol only, no references to other files; length and size limits)."""
    import style_analyse as sa  # noqa: PLC0415
    sec = sa.probe_example(path, sa.load_config())
    imgs = []
    with sa.safe_open(path) as c:
        st = next(s for s in c.streams if s.type == "video")
        for j in range(VIDEO_FRAMES):
            t = (j + 0.5) * sec / VIDEO_FRAMES
            c.seek(int(t / st.time_base), stream=st, any_frame=False, backward=True)
            for fr in c.decode(st):
                if fr.time is None or fr.time + 1e-3 >= t:
                    imgs.append(fr.to_ndarray(width=192, height=max(4, int(192 * fr.height / fr.width) // 2 * 2),
                                              format="bgr24"))
                    break
    if not imgs:
        raise ClipError(f"{os.path.basename(path)}: no picture could be read")
    return imgs


def crop_bars(img):
    """The picture without black bars (letterbox, pillarbox, a vertical reel on a black frame): rows and columns whose
    brightest pixel is at most BORDER_MAX are cut from the edges. All dark: the picture as it is."""
    import numpy as np  # noqa: PLC0415
    m = img.max(axis=2)
    rows = np.where(m.max(axis=1) > BORDER_MAX)[0]
    cols = np.where(m.max(axis=0) > BORDER_MAX)[0]
    if len(rows) < 4 or len(cols) < 4:
        return img
    return img[rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1]


def lut_target(m):
    """The colour the LUT aims for: the cast in full, brightness and contrast at TONE_SHARE of their difference."""
    return {"L": NEUTRAL["L"] + TONE_SHARE * (m["L"] - NEUTRAL["L"]), "a": m["a"], "b": m["b"],
            "contrast": NEUTRAL["contrast"] + TONE_SHARE * (m["contrast"] - NEUTRAL["contrast"])}


def measure_reference(path):
    """-> Lab statistics {L, a, b, contrast} of the reference (reel_style.frame_colour), black bars left out."""
    import reel_style as rs  # noqa: PLC0415
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        raise ClipError("pick a picture or video file that exists")
    ext = os.path.splitext(path)[1].lower()
    frames = _image(path) if IMAGE_EXT.get(ext) else _video(path)
    m = rs.frame_colour([crop_bars(f) for f in frames])
    if not m:
        raise ClipError(f"{os.path.basename(path)}: no picture could be read")
    return m


# ---------------------------------------------------------------- LUT maths

def apply_lut(n, rows, rgb):
    """Trilinear lookup of float RGB (..., 3) in 0..1 through a .cube (rows red fastest) -> same shape."""
    import numpy as np  # noqa: PLC0415
    t = np.asarray(rows, dtype=np.float64).reshape(n, n, n, 3)  # [b, g, r]
    x = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1) * (n - 1)
    i0 = np.minimum(np.floor(x).astype(int), n - 2)
    f = x - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]
    out = 0
    for db in (0, 1):
        for dg in (0, 1):
            for dr in (0, 1):
                w = (fr if dr else 1 - fr) * (fg if dg else 1 - fg) * (fb if db else 1 - fb)
                out = out + w * t[b0 + db, g0 + dg, r0 + dr]
    return out


def _lab(rgb):
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    a = np.asarray(rgb, dtype=np.float32).reshape(-1, 1, 3)[..., ::-1].copy()  # RGB -> BGR for OpenCV
    return cv2.cvtColor(a, cv2.COLOR_BGR2Lab).reshape(-1, 3)


def _ramp():
    import numpy as np  # noqa: PLC0415
    g = np.linspace(0.04, 0.96, 33)
    return np.stack([g, g, g], axis=-1)


def lut_shift(n, rows, amount=1.0):
    """What a LUT (mixed with the identity by amount, as the host's clut amount) does to a neutral grey ramp:
    {L, a, b} mean shift in Lab units and the L spread factor (contrast)."""
    import numpy as np  # noqa: PLC0415
    src = _ramp()
    out = src + (apply_lut(n, rows, src) - src) * max(0.0, min(1.0, float(amount)))
    li, lo = _lab(src), _lab(out)
    return {"L": float(lo[:, 0].mean() - li[:, 0].mean()), "a": float(lo[:, 1].mean() - li[:, 1].mean()),
            "b": float(lo[:, 2].mean() - li[:, 2].mean()), "contrast": float(lo[:, 0].std() / max(1e-6, li[:, 0].std()))}


def distance(s, t):
    return math.sqrt((s["L"] - t["L"]) ** 2 + (s["a"] - t["a"]) ** 2 + (s["b"] - t["b"]) ** 2
                     + (CONTRAST_WEIGHT * (s["contrast"] - t["contrast"])) ** 2)


def nearest_builtin(shift, looks, luts_dir=None):
    """The built-in look whose LUT (at its amount) moves a grey ramp most like `shift` -> (look, distance)."""
    import clip_realism as cr  # noqa: PLC0415
    best = (None, float("inf"))
    for lk in looks:
        e = lk["effects"][0]
        if e["file"].get("base") != "luts":
            continue
        try:
            n, rows = cr.read_cube(os.path.join(luts_dir or cr.LUTS_DIR, e["file"]["rel"]))
        except (OSError, ClipError):
            continue
        d = distance(shift, lut_shift(n, rows, e.get("amount", 1.0)))
        if d < best[1]:
            best = (lk, d)
    return best


def _hex(rgb):
    return "#" + "".join(f"{max(0, min(255, int(round(float(c) * 255)))):02x}" for c in rgb)


def tone_words(m):
    """Plain words for the measured colour (Lab means of the reference)."""
    import reel_style as rs  # noqa: PLC0415
    warm = float(rs.load_config()["map"]["warmB"])
    w = []
    w.append("warm" if m["b"] > warm else ("cool" if m["b"] < -warm else "neutral"))
    if m["a"] > warm:
        w.append("pink-red")
    elif m["a"] < -warm:
        w.append("green")
    w.append("dark" if m["L"] < 35 else ("bright" if m["L"] > 65 else "mid-bright"))
    w.append("punchy" if m["contrast"] > NEUTRAL["contrast"] * 1.15 else ("soft" if m["contrast"] < NEUTRAL["contrast"] * 0.85 else "normal contrast"))
    return ", ".join(w)


# ---------------------------------------------------------------- the user's looks

def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return (s or "look")[:22].strip("-") or "look"


def free_id(data_dir, name, taken=()):
    d = user_dir(data_dir)
    base = PREFIX + _slug(name)
    for k in range(1, 1000):
        i = base if k == 1 else f"{base[:32 - len(str(k)) - 1]}-{k}"
        if i not in taken and not os.path.exists(os.path.join(d, i + ".json")) and not os.path.exists(os.path.join(d, i + ".cube")):
            return i
    raise ClipError("no free name for the look; delete one of your looks")


def make_look(data_dir, path, name=None, looks=None, luts_dir=None):
    """Measure the reference, write <data>/looks/<id>.cube and <id>.json -> the look plus basedOn and measured."""
    import clip_realism as cr  # noqa: PLC0415
    import reel_style as rs  # noqa: PLC0415
    d = user_dir(data_dir)
    os.makedirs(d, exist_ok=True)
    own = [f for f in os.listdir(d) if f.startswith(PREFIX) and f.endswith(".json")]
    if len(own) >= MAX_USER_LOOKS:
        raise ClipError(f"you have {MAX_USER_LOOKS} looks of your own; delete one first")
    m = measure_reference(path)
    builtins = [x for x in (cr.load_looks() if looks is None else looks) if not x["id"].startswith(PREFIX)]
    if not builtins:
        raise ClipError("the built-in looks are missing")
    nm = clean_name(name) or "My look"
    taken = {x["id"] for x in builtins}
    look_id = free_id(data_dir, nm, taken)
    cube = os.path.join(d, look_id + ".cube")
    shift = rs.write_lut(cube, lut_target(m), 1.0, NEUTRAL)  # same writer and caps as the Reel styles colour
    try:
        n, rows = cr.read_cube(cube)
        got = lut_shift(n, rows, 1.0)
        near, dist = nearest_builtin(got, builtins, luts_dir)
        if near is None:
            raise ClipError("the built-in looks could not be read")
        import numpy as np  # noqa: PLC0415
        swatch = [_hex(c) for c in apply_lut(n, rows, np.asarray(SWATCH_REFS))]
        measured = {k: round(float(m[k]), 2) for k in ("L", "a", "b", "contrast")}
        look = {
            "version": 1, "id": look_id, "name": nm,
            "summary": f"Your look from a reference: {tone_words(m)}. Glow, grain and vignette start from {near['name']}."[:200],
            "status": "unverified",
            "measured": {"colour": measured, "shift": {k: round(float(v), 3) for k, v in shift.items()},
                         "basedOn": near["id"]},
            "effects": [{"type": "lut", "file": {"base": USER_BASE, "rel": look_id + ".cube"}, "amount": 1.0}]
                       + json.loads(json.dumps(near["effects"][1:])),
            "backdrop": list(near["backdrop"]),
            "swatch": swatch,
        }
        write_json_atomic(os.path.join(d, look_id + ".json"), look)
    except BaseException:
        try:
            os.remove(cube)
        except OSError:
            pass
        raise
    return {"look": look, "basedOn": {"id": near["id"], "name": near["name"], "distance": round(dist, 2)},
            "measured": measured}


def main(argv=None):
    ap = argparse.ArgumentParser(description="New realism look from a reference picture or video (RL5)")
    ap.add_argument("op", choices=["make"])
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--json", required=True)
    a = ap.parse_args(argv)
    lower_own_priority()
    try:
        b = json.loads(a.json)
        if not isinstance(b, dict) or not isinstance(b.get("path"), str):
            raise ClipError("pick a picture or video file")
        r = make_look(a.data_dir, b["path"], b.get("name"))
    except (ClipError, ValueError, OSError) as e:
        eprint(f"new look: {e}")
        return 1
    print(json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    _sys.exit(main())
