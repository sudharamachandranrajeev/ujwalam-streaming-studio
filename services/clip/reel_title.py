# SPDX-License-Identifier: GPL-3.0-or-later
"""FX2 name display of a reel (D411, plan docs/plan/2026-11-21-clip-music-name-transitions.md; replaces the RP4 centre
card over a blurred, darkened copy of the reel, which the user did not pick).

Three styles, drawn as an ASS file burned by libass inside the reel's own render (clip_montage.render_argv(title=)):
lower-third (accent bar slides in, the name types on), corner-tag (small rounded badge, the whole clip), kinetic (big
letters pop in one by one). The game picture is never blurred or darkened: the text carries an outline and a hard
shadow only (no \\blur, no \\be, no blur filter). Data: data/clip/title.json. The style and its tunables come from the
clip look (clip_look.py, Settings > Clips). The text is the streamer brand from data/profile.local.json
(reel_thumbnail.brand), local only; no brand, no name. The bundled font is copied next to the run (no system font).

  plan(pieces, xd, cfg, brand, frame, safe, name=None) -> record (all numbers resolved, with the text) or None
  restyle(rec, cfg, frame, safe)                       -> a full record from a stored one (old RP4 records too)
  to_ass(rec, cfg)                                     -> the ASS text
  prepare(wd, rec, cfg)                                -> the dict render_argv(title=) takes (writes name.ass + font)
  cleanup(wd)
"""

from __future__ import annotations

import os
import re
import shutil

from clip_captions import _ts
from clip_common import CLIP_DATA, ClipError, flag_on, load_json

DEFAULTS_FILE = os.path.join(CLIP_DATA, "title.json")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONTS_DIR = os.path.join(REPO, "data", "fonts")
FLAG = "reel-title"  # retired with the RP4 centre card; still read so an old flags file keeps the name on
LOOK_FLAG = "clip-look"
FONT_SUBDIR = "title-fonts"
ASS_FILE = "name.ass"
STYLES = ("lower-third", "corner-tag", "kinetic")
ENTRANCE_MAX_MS, EXIT_MAX_MS = 600, 400
_BAD = re.compile(r"[\x00-\x1f\x7f]")
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def load_config(path=None):
    cfg = load_json(path or DEFAULTS_FILE)
    if not os.path.isfile(os.path.join(FONTS_DIR, cfg["fontFile"])):
        raise ClipError(f"name display: font {cfg['fontFile']} is not in data/fonts")
    for s in STYLES:
        st = cfg["styles"][s]
        if entrance_ms(s, st, 24) >= ENTRANCE_MAX_MS or int(st["exitMs"]) >= EXIT_MAX_MS:
            raise ClipError(f"name display: {s} must enter under 600 ms and leave under 400 ms")
    return cfg


def on(data_dir):
    return flag_on(data_dir, LOOK_FLAG) or flag_on(data_dir, FLAG)


def entrance_ms(style, st, n):
    """The time from the name's start until it is fully in (ms), for a text of n letters."""
    if style == "lower-third":
        return max(int(st["barInMs"]), int(st["typeStartMs"]) + _step(st["typeMaxMs"], n, 30) * max(0, n - 1) + 1)
    if style == "corner-tag":
        return max(int(st["popMs"]), int(st["fadeInMs"]))
    return _step(st["lettersMaxMs"], n, 45) * max(0, n - 1) + int(st["letterMs"])


def _step(total_ms, n, cap):
    return int(min(cap, int(total_ms) / max(1, n - 1)))


def _clean(s, n):
    s = re.sub(r"\s+", " ", _BAD.sub(" ", str(s))).strip()
    return s[:n].strip()


def timeline(pieces, xd):
    """-> (name start in reel time, reel length): the name starts where the leading teaser pieces end (0 without)."""
    ds = [float(p["end"]) - float(p["start"]) for p in pieces]
    k = 0
    while k < len(ds) and pieces[k].get("teaser"):
        k += 1
    if k >= len(ds):
        k = 0  # a reel made only of teaser pieces: name at the start
    return max(0.0, sum(ds[:k]) - k * xd), sum(ds) - (len(ds) - 1) * xd


def _colour(c, cfg):
    return c if isinstance(c, str) and _HEX.match(c) else cfg["themeAccent"]


def _place(style, position, frame, safe, cfg):
    """-> (x, y, ASS alignment) of the name's anchor inside the safe area."""
    w, h = int(frame["width"]), int(frame["height"])
    left, right = int(safe.get("left", 0)), int(safe.get("right", 0))
    top, bottom = int(safe.get("top", 0)), int(safe.get("bottom", 0))
    pad = round(0.03 * w)
    if position == "auto":
        position = {"lower-third": "bottom-left", "corner-tag": "top-left", "kinetic": "upper-third"}[style]
    lift = round(0.10 * h)  # above the bottom safe edge: clear of buttons and captions
    return {"top-left": (left + pad, top + pad, 7), "top-right": (w - right - pad, top + pad, 9),
            "bottom-left": (left + pad, h - bottom - lift, 1), "bottom-right": (w - right - pad, h - bottom - lift, 3),
            "upper-third": ((left + w - right) // 2, round(0.28 * h), 5),
            "lower-third": ((left + w - right) // 2, h - bottom - lift, 2)}[position]


def plan(pieces, xd, cfg, brand, frame, safe, name=None):
    """The name record, or None (no brand, no style, or the reel is too short). name: the clip look's name part
    {"style", "variant", "position", "colour", "sizePct", "durationSec"}; None = kinetic with the defaults."""
    text = _clean(brand, int(cfg["maxChars"])) if isinstance(brand, str) and not brand.strip().startswith("<") else ""
    name = dict(name or {})
    style = name.get("style") or "kinetic"
    if not text or not pieces or style not in STYLES:
        return None
    start, total = timeline(pieces, xd)
    if total < float(cfg["minReelSec"]):
        return None
    dur = float(name.get("durationSec") or 2.0)
    if style == "corner-tag":
        end = total
    else:
        if start + dur > total - 0.5:  # no room after the teaser: open the reel with it instead
            start = 0.0
        if start + dur > total - 0.5:
            return None
        end = start + dur
    return restyle({"text": text, "start": round(start, 3), "end": round(end, 3), "style": style,
                    "variant": name.get("variant") or "scale-punch", "position": name.get("position") or "auto",
                    "colour": name.get("colour") or "theme", "sizePct": int(name.get("sizePct") or 100)},
                   cfg, frame, safe)


def restyle(rec, cfg, frame, safe):
    """Every number of a record from its text, times, style and tunables (frame and safe area of this render). An RP4
    record (no style) becomes a kinetic name at the same times."""
    style = rec.get("style") if rec.get("style") in STYLES else "kinetic"
    st = cfg["styles"][style]
    text = _clean(rec["text"], int(cfg["maxChars"]))
    w, h = int(frame["width"]), int(frame["height"])
    safe_w = w - int(safe.get("left", 0)) - int(safe.get("right", 0))
    size = round(float(st["sizeOfHeight"]) * h * int(rec.get("sizePct") or 100) / 100.0)
    room = 0.9 * safe_w if style == "kinetic" else 0.75 * safe_w
    size = max(8, min(size, int(room / max(1, len(text)) / float(cfg["glyphWidthOfSize"]))))
    x, y, an = _place(style, rec.get("position") or "auto", frame, safe, cfg)
    return {"text": text, "start": float(rec["start"]), "end": float(rec["end"]), "style": style,
            "variant": rec.get("variant") if rec.get("variant") in ("scale-punch", "slice-in") else "scale-punch",
            "position": rec.get("position") or "auto", "colour": rec.get("colour") or "theme",
            "sizePct": int(rec.get("sizePct") or 100), "size": size, "x": x, "y": y, "align": an,
            "accent": _colour(rec.get("colour"), cfg), "width": w, "height": h,
            "entranceMs": entrance_ms(style, st, len(text)), "exitMs": int(st["exitMs"])}


def _bgr(hex_rgb, alpha=0):
    r, g, b = hex_rgb[1:3], hex_rgb[3:5], hex_rgb[5:7]
    return f"&H{alpha:02X}{b}{g}{r}".upper()


def _esc(ch):
    return {"\\": "⧵", "{": "(", "}": ")"}.get(ch, ch)


def _rounded(wd, ht, r):
    r = max(1, min(r, ht // 2, wd // 2))
    return (f"m {r} 0 l {wd - r} 0 b {wd} 0 {wd} 0 {wd} {r} l {wd} {ht - r} b {wd} {ht} {wd} {ht} {wd - r} {ht} "
            f"l {r} {ht} b 0 {ht} 0 {ht} 0 {ht - r} l 0 {r} b 0 0 0 0 {r} 0")


def to_ass(rec, cfg):
    """The ASS script of one name record. Outline and hard shadow only: no \\blur and no \\be anywhere."""
    style, st = rec["style"], cfg["styles"][rec["style"]]
    size, text = int(rec["size"]), rec["text"]
    n = len(text)
    out_px = max(1, round(size * float(st["outlineOfSize"])))
    sh_px = max(1, round(size * float(st["shadowOfSize"])))
    white = _bgr(cfg["textColour"])
    accent = _bgr(rec["accent"])
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {rec['width']}", f"PlayResY: {rec['height']}", "WrapStyle: 2",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Name,{cfg['fontFamily']},{size},{white},{white},&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,"
        f"{out_px},{sh_px},5,0,0,0,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    a, b = _ts(rec["start"]), _ts(rec["end"])
    dur_ms = int(round((rec["end"] - rec["start"]) * 1000))
    ex = int(st["exitMs"])
    x, y, an = int(rec["x"]), int(rec["y"]), int(rec["align"])
    gw = float(cfg["glyphWidthOfSize"])
    ev = []
    if style == "lower-third":
        pad = round(size * 0.45)
        bw, bh = round(n * size * gw + 2 * pad), round(size * 1.5)
        bx = x if an in (1, 7) else (x - bw if an in (3, 9) else x - bw // 2)
        by = y - bh
        step = _step(st["typeMaxMs"], n, 30)
        ev.append(f"Dialogue: 0,{a},{b},Name,,0,0,0,,{{\\an7\\move({bx - bw - 40},{by},{bx},{by},0,{int(st['barInMs'])})"
                  f"\\fad(0,{ex})\\bord0\\shad0\\1c{accent}\\p1}}m 0 0 l {bw} 0 l {bw} {bh} l 0 {bh}{{\\p0}}")
        letters = "".join(f"{{\\alpha&HFF&\\t({int(st['typeStartMs']) + i * step},{int(st['typeStartMs']) + i * step + 1},"
                          f"\\alpha&H00&)}}{_esc(c)}" for i, c in enumerate(text))
        ev.append(f"Dialogue: 1,{a},{b},Name,,0,0,0,,{{\\an4\\pos({bx + pad},{by + bh // 2})\\fad(0,{ex})}}{letters}")
    elif style == "corner-tag":
        pad = round(size * 0.5)
        bw, bh = round(n * size * gw + 2 * pad), round(size * 1.7)
        bx = x if an in (1, 7) else (x - bw if an in (3, 9) else x - bw // 2)
        by = y if an in (7, 9) else (y - bh if an in (1, 3) else y - bh // 2)
        dim = f"\\t({int(st['dimAfterMs'])},{int(st['dimAfterMs']) + 300},\\alpha&H{int(st['dimToAlpha']):02X}&)" \
            if dur_ms > int(st["dimAfterMs"]) + 300 + ex else ""
        pop = (f"\\fscx80\\fscy80\\t(0,{int(st['popMs']) * 6 // 10},\\fscx112\\fscy112)"
               f"\\t({int(st['popMs']) * 6 // 10},{int(st['popMs'])},\\fscx100\\fscy100)\\fad({int(st['fadeInMs'])},{ex}){dim}")
        ev.append(f"Dialogue: 0,{a},{b},Name,,0,0,0,,{{\\an7\\pos({bx},{by})\\bord0\\shad0\\1c{_bgr(rec['accent'], 0x30)}"
                  f"{pop}\\p1}}{_rounded(bw, bh, bh // 3)}{{\\p0}}")
        ev.append(f"Dialogue: 1,{a},{b},Name,,0,0,0,,{{\\an4\\pos({bx + pad},{by + bh // 2}){pop}}}"
                  + "".join(_esc(c) for c in text))
    else:
        step = _step(st["lettersMaxMs"], n, 45)
        lm = int(st["letterMs"])
        if rec.get("variant") == "slice-in":
            letters = "".join(f"{{\\alpha&HFF&\\fax0.6\\t({i * step},{i * step + lm},\\alpha&H00&\\fax0)}}{_esc(c)}"
                              for i, c in enumerate(text))
        else:
            letters = "".join(f"{{\\alpha&HFF&\\fscx160\\fscy160\\t({i * step},{i * step + lm},\\alpha&H00&\\fscx100\\fscy100)}}"
                              f"{_esc(c)}" for i, c in enumerate(text))
        ev.append(f"Dialogue: 0,{a},{b},Name,,0,0,0,,{{\\an{an}\\pos({x},{y})\\3c{accent}\\fad(0,{ex})}}{letters}")
    return "\n".join(head + ev) + "\n"


def prepare(wd, rec, cfg):
    """Writes wd/name.ass and wd/title-fonts/<font> -> the dict clip_montage.render_argv(title=) takes."""
    fd = os.path.join(wd, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    shutil.copyfile(os.path.join(FONTS_DIR, cfg["fontFile"]), os.path.join(fd, cfg["fontFile"]))
    with open(os.path.join(wd, ASS_FILE), "w", encoding="utf-8", newline="\n") as f:
        f.write(to_ass(rec, cfg))
    return {"ass": ASS_FILE, "fontsdir": FONT_SUBDIR, "style": rec["style"], "start": rec["start"], "end": rec["end"]}


def cleanup(wd):
    shutil.rmtree(os.path.join(wd, FONT_SUBDIR), ignore_errors=True)
    try:
        os.remove(os.path.join(wd, ASS_FILE))
    except OSError:
        pass
