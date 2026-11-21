# SPDX-License-Identifier: GPL-3.0-or-later
"""BD5 BeatDrop intro title, in-scene pin, outro hero and credits (D416, plan docs/plan/2026-11-21-beatdrop-montages.md
sections 1, 3 and 5 BD5). Fills the planner's title/hero/credits slots (beatdrop.py) and draws them inside the one
montage render (clip_montage.render_argv(title=): an ASS file burned by libass after the BD4 effects).

- title-extrude: "<brand> presents" from the title slot's first downbeat, then the song title from the intro's last
  downbeat to the drop, as layered 2D text: stacked offset copies (depth), a lighter top half, a light sweep and a
  soft glow. Slam entrance (pop -> 1 over inMs < 600 ms, opaque from its first frame), fade exit (outMs < 400 ms).
- title-pin: the title tracked onto a flat area of each shot it covers (OpenCV corners + pyramidal Lucas-Kanade with a
  forward-backward check + RANSAC homography, CPU, low resolution, at most maxFrames decoded frames); a piece with too
  few tracked points or too low an inlier share gets the screen-space title and a log line.
- hero-bw: the outro hero piece fades to black and white with a slow push-in (beatdrop_fx.graph "hero-bw"), the player
  name under it.
- credits-roll: the music record's credit exactly as montage_music.credit_text gives it (the D414 posting gate's text),
  then the data lines (titles.creditLines, titles.madeWith).

Every value is data: registry/functions/<fn>.json + the presets named in data/clip/beatdrop.json `titles`; colours and
fonts from data/games/<game>/beatdrop.json `look` (fonts only from data/fonts). The brand and player name come from
data/profile.local.json at run time (never committed); a missing or <placeholder> value leaves its line out (logged).
Each title line is drawn one ASS event per output frame (event edges on the 10 ms grid that libass's millisecond
clock maps one-to-one onto 60 fps frames), so the pin follows the track frame by frame.
Real footage UNVERIFIED (synthetic fixtures: tests/py/test_beatdrop_titles.py, tests/py/test_beatdrop.py).
"""

from __future__ import annotations

import math
import os
import re
import shutil

import beatdrop_fx as bfx
from clip_common import ClipError, load_json
from reel_title import FONTS_DIR, _bgr, _esc

FUNCTIONS = ("title-extrude", "title-pin", "hero-bw", "credits-roll")
ASS_FILE = "beatdrop-titles.ass"
FONT_SUBDIR = "beatdrop-fonts"
TRACK_FILE = "beatdrop-track.gray"
ENTRANCE_MAX_MS, EXIT_MAX_MS = 600, 400
_BAD = re.compile(r"[\x00-\x1f\x7f]")


def params(cfg):
    """{fn: params} from the presets named in cfg["titles"]["presets"] (manifest defaults, preset, safe ranges)."""
    pr = cfg["titles"]["presets"]
    out = {fn: bfx.params_for(fn, preset_id=pr[fn]) for fn in FUNCTIONS}
    for fn in ("title-extrude", "hero-bw", "credits-roll"):
        if int(out[fn]["inMs"]) >= ENTRANCE_MAX_MS or int(out[fn]["outMs"]) >= EXIT_MAX_MS:
            raise ClipError(f"beatdrop titles: {fn} must enter under 600 ms and leave under 400 ms")
    return out


def look_of(game):
    lk = dict(game.get("look") or {})
    for k in ("titleFont", "textFont"):
        f = lk.get(k)
        if not f or os.path.basename(f) != f or not os.path.isfile(os.path.join(FONTS_DIR, f)):
            raise ClipError(f"beatdrop titles: look {k} must be a font file in data/fonts")
    return lk


def _clean(s, n=80):
    s = _BAD.sub("", str(s or "")).strip()
    return s[:n] if s and not s.startswith("<") else None


def profile_names(path, game="codm"):
    """(brand, player) from the local profile; None for a missing value or a <placeholder>."""
    try:
        doc = load_json(path)
    except (OSError, ClipError, ValueError):
        return None, None
    st = (doc or {}).get("streamer") or {}
    g = ((doc or {}).get("games") or {}).get(game) or {}
    return _clean(st.get("brand")), _clean(g.get("ign")) or _clean(st.get("name"))


def entrance_ms(fn, p, n_lines=1):
    """Time until the element is fully in (ms)."""
    if fn == "credits-roll":
        return int(p["inMs"]) + int(p["staggerMs"]) * max(0, n_lines - 1)
    return int(p["inMs"])


# ------------------------------------------------------------------------------------------------ slots
def fill(pl, record, brand, player, cfg, game):
    """Fills pl["slots"] title/hero/credits "content" and adds the hero-bw effect. record: the montage's music record
    (render.json "music"). -> log lines (also appended to pl["log"])."""
    import montage_music as mm  # noqa: PLC0415
    tc = cfg["titles"]
    prm = params(cfg)
    look_of(game)
    fps = int(pl["fps"])
    log = []

    def fr(t):
        return int(round(float(t) * fps))
    sl = pl["slots"]
    downs = pl["song"].get("downbeats") or []
    ts = sl["title"]
    a, b = float(ts["start"]), float(ts["end"])
    ds = [d for d in downs if a - 1e-6 <= d < b - 1e-6]
    credit = (record or {}).get("credit") if isinstance(record, dict) else None
    song = _clean((credit or {}).get("title"), 120)
    lines = []
    if not ds:
        log.append("title: no downbeat inside the title slot: no title")
    else:
        first, last = ds[0], ds[-1]
        if brand and first < last - 1e-6:
            lines.append({"role": "presents", "text": tc["presentsTemplate"].format(brand=brand), "from": fr(first),
                          "to": fr(last)})
        elif not brand:
            log.append("title: no brand in the local profile: no presents line")
        if song:
            lines.append({"role": "title", "text": song, "from": fr(last), "to": fr(b)})
        else:
            log.append("title: the music record has no song title (made-here bed or no credit): no song title line")
    ts["content"] = {"fn": "title-extrude", "preset": tc["presets"]["title-extrude"], "pin": tc["presets"]["title-pin"],
                     "mode": tc["mode"], "lines": lines} if lines else None
    hs = sl["hero"]
    sl["hero"]["content"] = {"fn": "hero-bw", "preset": tc["presets"]["hero-bw"], "name": player,
                             "from": fr(hs["start"]), "to": fr(hs["end"])}
    if not player:
        log.append("hero: no player name in the local profile: hero without a name")
    pl["effects"].append({"fn": "hero-bw", "at": round(float(hs["start"]), 4), "end": round(float(hs["end"]), 4),
                          "params": prm["hero-bw"]})
    cs = sl["credits"]
    music_credit = mm.credit_text(credit) if credit and mm.complete(credit) else None
    clines = music_credit.split("\n") if music_credit else []
    for s in tc.get("creditLines") or []:
        if "{brand}" in s and not brand:
            continue
        clines.append(s.format(brand=brand or ""))
    if tc.get("madeWith"):
        clines.append(tc["madeWith"])
    cs["content"] = {"fn": "credits-roll", "preset": tc["presets"]["credits-roll"], "musicCredit": music_credit,
                     "lines": clines, "from": fr(cs["start"]), "to": fr(cs["end"])}
    if not music_credit:
        log.append("credits: no complete music credit in the music record: credits without a song credit")
    pl.setdefault("log", []).extend(log)
    return log


# ------------------------------------------------------------------------------------------------ tracking
def track_plane(frames, anchor, pp, stop=None):
    """frames: 2-D uint8 arrays (the tracking size), anchor (x, y) in those px. -> (Hs, info): Hs = one 3x3 homography
    per frame from frame 0 (numpy), or None when tracking is not confident (info["reason"] says why).
    stop() (the job's on-air guard) is asked before every frame: true -> beatdrop.OnAir, no more CPU work."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    f0 = frames[0]
    h, w = f0.shape
    bw, bh = float(pp["boxW"]) * w, float(pp["boxH"]) * h
    x0, x1 = int(max(0, anchor[0] - bw / 2)), int(min(w, anchor[0] + bw / 2))
    y0, y1 = int(max(0, anchor[1] - bh / 2)), int(min(h, anchor[1] + bh / 2))
    mask = np.zeros_like(f0)
    mask[y0:y1, x0:x1] = 255
    min_pts = int(pp["minPoints"])
    p0 = cv2.goodFeaturesToTrack(f0, maxCorners=int(pp["maxPoints"]), qualityLevel=0.01, minDistance=3, mask=mask)
    n0 = 0 if p0 is None else len(p0)
    if n0 < min_pts:
        return None, {"reason": f"{n0} trackable points in the box (need {min_pts})", "points": n0}
    ref = p0.reshape(-1, 2).astype(np.float32)
    cur = ref.copy()
    alive = np.ones(len(ref), bool)
    hs, worst, prev = [np.eye(3)], 1.0, f0
    lk = {"winSize": (21, 21), "maxLevel": 3}
    for i, f in enumerate(frames[1:], start=1):
        if stop is not None and stop():
            from beatdrop import OnAir  # noqa: PLC0415
            raise OnAir("a stream or recording started during the title tracking")
        idx = np.flatnonzero(alive)
        pts = cur[idx].reshape(-1, 1, 2)
        nx, st, _ = cv2.calcOpticalFlowPyrLK(prev, f, pts, None, **lk)
        bk, st2, _ = cv2.calcOpticalFlowPyrLK(f, prev, nx, None, **lk)
        fb = np.linalg.norm(bk.reshape(-1, 2) - pts.reshape(-1, 2), axis=1)
        ok = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < float(pp["fbMaxPx"]))
        alive[idx[~ok]] = False
        cur[idx[ok]] = nx.reshape(-1, 2)[ok]
        n = int(alive.sum())
        if n < min_pts:
            return None, {"reason": f"tracking lost at frame {i} ({n} points left, need {min_pts})", "points": n0}
        hm, inl = cv2.findHomography(ref[alive], cur[alive], cv2.RANSAC, float(pp["ransacPx"]))
        if hm is None:
            return None, {"reason": f"no homography at frame {i}", "points": n0}
        k = int(inl.sum())
        ratio = k / n
        worst = min(worst, ratio)
        if k < min_pts or ratio < float(pp["minInlierRatio"]):
            return None, {"reason": f"low confidence at frame {i} (inliers {k}/{n}, need {min_pts} and "
                          f"{float(pp['minInlierRatio']):g})", "points": n0}
        hs.append(hm)
        prev = f
    return hs, {"points": n0, "worstInlierRatio": round(worst, 3), "frames": len(frames)}


def transform_at(hm, x, y):
    """The anchor (x, y) through homography hm -> (x', y', scale, roll degrees clockwise on screen)."""
    def m(px, py):
        v = hm @ [px, py, 1.0]
        return v[0] / v[2], v[1] / v[2]
    cx, cy = m(x, y)
    ax, ay = m(x + 1.0, y)
    bx, by = m(x, y + 1.0)
    j00, j10, j01, j11 = ax - cx, ay - cy, bx - cx, by - cy
    s = math.sqrt(max(abs(j00 * j11 - j01 * j10), 1e-9))
    return cx, cy, s, math.degrees(math.atan2(j10, j00))


def decode_piece(ffmpeg, recording, piece, n_frames, size, wd, stop=None):
    """The piece's first n_frames output frames at the tracking size (grey), exactly as the render makes them (seek,
    scale + pad, speed, 60 fps). -> list of 2-D uint8 arrays."""
    import numpy as np  # noqa: PLC0415
    from beatdrop import OnAir, _not_started  # noqa: PLC0415
    from clip_common import STOPPED_RC, run_tool  # noqa: PLC0415
    tw, th = size
    sp = float(piece.get("speed") or 1.0)
    vf = (f"scale={tw}:{th}:force_original_aspect_ratio=decrease:flags=area,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2,"
          f"setsar=1,setpts=PTS-STARTPTS" + ("" if sp == 1.0 else f",setpts=PTS/{sp:.6f}") + ",fps=60,format=gray")
    src = piece["src"]
    out = os.path.join(wd, TRACK_FILE)
    try:  # the raw file is removed on every path (stop, timeout, error)
        r = run_tool([ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", f"{src['start']:.3f}",
                      "-t", f"{src['end'] - src['start'] + 2.0 / 60 * sp:.3f}", "-i", recording, "-an", "-sn", "-vf", vf,
                      "-frames:v", str(int(n_frames)), "-f", "rawvideo", out], timeout=300, stop=stop, poll_sec=0.5)
        if r.returncode == STOPPED_RC:
            raise OnAir("a stream or recording started during the title tracking")
        _not_started(r)
        if r.returncode != 0:
            raise ClipError("beatdrop titles: decoding a piece for tracking failed: " + (r.stderr or "")[-200:])
        a = np.fromfile(out, dtype=np.uint8)
    finally:
        try:
            os.remove(out)
        except OSError:
            pass
    k = a.size // (tw * th)
    return [a[i * tw * th:(i + 1) * tw * th].reshape(th, tw) for i in range(k)]


def pin(pl, recording, ffmpeg, wd, frame, cfg, stop=None, decode=None):
    """Tracks each title line over the pieces it covers -> line["segments"] = [{"from", "to", "place": "pin" | "screen",
    "xform": [[x, y, scale, roll], ...] (output px, one per frame; pin only)}]. Screen-space fallback per piece with a
    plan log line. decode(piece, n, size) -> frames (default decode_piece; tests inject frames)."""
    c = (pl["slots"]["title"] or {}).get("content")
    if not c:
        return []
    prm = params(cfg)
    pp, pe = prm["title-pin"], prm["title-extrude"]
    ow, oh = int(frame["width"]), int(frame["height"])
    tw = min(int(pp["trackWidth"]), ow) // 2 * 2
    th = max(2, int(round(tw * oh / ow / 2)) * 2)
    k = ow / tw
    budget = int(pp["maxFrames"])
    log = []
    cache = {}
    decode = decode or (lambda p, n, size: decode_piece(ffmpeg, recording, p, n, size, wd, stop=stop))
    fps = int(pl["fps"])
    moving = bfx.moving_windows(pl.get("effects") or [], fps)
    for ln in c["lines"]:
        ax, ay = 0.5 * ow, _line_y(ln, pe, oh)
        segs = []
        for i, p in enumerate(pl["pieces"]):
            f0, f1 = max(ln["from"], p["outStart"]), min(ln["to"], p["outStart"] + p["outFrames"])
            if f1 <= f0:
                continue
            seg = {"from": f0, "to": f1, "place": "screen"}
            segs.append(seg)
            if c.get("mode") != "pin":
                continue
            hit = next((fn for fn, a, b in moving if a < f1 / fps and b > f0 / fps), None)
            if hit:
                log.append(f"title pin: piece {i + 1} has a moving effect ({hit}) under the title: screen-space title")
                continue
            need = f1 - p["outStart"]
            frames = cache.get(i)
            if frames is None or len(frames) < need:
                if need > budget:
                    log.append(f"title pin: frame budget used up ({int(pp['maxFrames'])}): piece {i + 1} screen-space")
                    continue
                budget -= need
                frames = cache[i] = decode(p, need, (tw, th))
            fs = frames[f0 - p["outStart"]:f1 - p["outStart"]]
            if len(fs) < f1 - f0:
                log.append(f"title pin: piece {i + 1} decoded short: screen-space title")
                continue
            hs, info = track_plane(fs, (ax / k, ay / k), pp, stop=stop)
            if hs is None:
                log.append(f"title pin: piece {i + 1} low tracking confidence ({info['reason']}): screen-space title")
                continue
            xf = []
            for hm in hs:
                x, y, s, rot = transform_at(hm, ax / k, ay / k)
                xf.append([round(x * k, 2), round(y * k, 2), round(s, 4), round(rot, 2)])
            seg.update(place="pin", xform=xf, points=info["points"], worstInlierRatio=info["worstInlierRatio"])
        ln["segments"] = segs
    pl.setdefault("log", []).extend(log)
    return log


def _line_y(ln, pe, oh):
    return float(pe["y"]) * oh


# ------------------------------------------------------------------------------------------------ ASS
def _cs(c):
    return f"{c // 360000}:{c // 6000 % 60:02d}:{c // 100 % 60:02d}.{c % 100:02d}"


def frame_span(k, fps=60):
    """ASS start/end (centiseconds) of output frame k: libass is asked at round(1000 k / fps) ms; edges at
    floor(ms / 10) are strictly increasing at 60 fps (16.7 ms > 10 ms), so each frame falls in exactly one event."""
    def e(n):
        return int(round(1000.0 * n / fps)) // 10
    return _cs(e(k)), _cs(e(k + 1))


def _alpha(a):
    return f"&H{max(0, min(255, int(round(255 * (1.0 - a))))):02X}&"


def _ease_out(x):
    x = min(max(x, 0.0), 1.0)
    return 1.0 - (1.0 - x) ** 3


def _env(k, f0, f1, in_ms, out_ms, fps):
    """(entrance progress 0..1, exit opacity 1..0) at frame k of [f0, f1)."""
    t_in = (k - f0) / fps * 1000.0
    t_out = (f1 - k) / fps * 1000.0 - 1000.0 / fps
    return min(1.0, t_in / in_ms) if in_ms > 0 else 1.0, min(1.0, max(0.0, t_out / out_ms)) if out_ms > 0 else 1.0


def _txt(s):
    return "".join(_esc(ch) for ch in s)


def title_events(ln, pe, lk, frame, fps=60):
    """The ASS events of one title line: per frame, glow + depth copies + face + lighter top + light sweep."""
    ow, oh = int(frame["width"]), int(frame["height"])
    base = float(pe["sizeOfHeight"]) * oh * (float(pe["presentsOfSize"]) if ln["role"] == "presents" else 1.0)
    segs = ln.get("segments") or [{"from": ln["from"], "to": ln["to"], "place": "screen"}]
    text = _txt(ln["text"])
    gw = float(lk.get("glyphWidthOfSize", 0.5))
    depth = int(pe["depth"])
    ev = []
    for sg in segs:
        for k in range(sg["from"], sg["to"]):
            if sg["place"] == "pin":
                x, y, s, rot = sg["xform"][k - sg["from"]]
            else:
                x, y, s, rot = 0.5 * ow, _line_y(ln, pe, oh), 1.0, 0.0
            prog, op = _env(k, ln["from"], ln["to"], float(pe["inMs"]), float(pe["outMs"]), fps)
            if op <= 0.0:
                continue
            size = base * s * (float(pe["pop"]) + (1.0 - float(pe["pop"])) * _ease_out(prog))
            a, b = frame_span(k, fps)
            fz = f"\\frz{-rot:.2f}" if abs(rot) > 0.01 else ""
            d = float(pe["depthOfSize"]) * size / depth
            ol = max(0.0, float(pe["outlineOfSize"]) * size)
            half_w, half_h = len(ln["text"]) * size * gw / 2 + ol, size * 0.55
            common = f"\\an5\\fs{size:.1f}{fz}"
            g = float(pe["glowOfSize"]) * size
            if float(pe["glowAlpha"]) > 0:
                ev.append(f"Dialogue: 0,{a},{b},T,,0,0,0,,{{{common}\\pos({x:.1f},{y:.1f})\\bord{g:.1f}\\blur{g * 0.6:.1f}"
                          f"\\shad0\\1a&HFF&\\3c{_bgr(lk['glow'])}\\3a{_alpha(op * float(pe['glowAlpha']))}}}{text}")
            for j in range(depth, 0, -1):
                ev.append(f"Dialogue: 1,{a},{b},T,,0,0,0,,{{{common}\\pos({x + j * d:.1f},{y + j * d:.1f})\\bord0\\shad0"
                          f"\\1c{_bgr(lk['extrude'])}\\1a{_alpha(op)}}}{text}")
            face = f"{common}\\pos({x:.1f},{y:.1f})\\shad0"
            ev.append(f"Dialogue: 2,{a},{b},T,,0,0,0,,{{{face}\\bord{ol:.1f}\\1c{_bgr(lk['face'])}\\3c{_bgr(lk['outline'])}"
                      f"\\1a{_alpha(op)}\\3a{_alpha(op)}}}{text}")
            clip = f"\\clip({x - half_w:.0f},{y - half_h:.0f},{x + half_w:.0f},{y - 0.05 * size:.0f})"
            ev.append(f"Dialogue: 3,{a},{b},T,,0,0,0,,{{{face}\\bord0{clip}\\1c{_bgr(lk['faceTop'])}\\1a{_alpha(op)}}}{text}")
            sw = float(pe["sweepAlpha"])
            if sw > 0:
                period = float(pe["sweepMs"]) / 1000.0 * fps
                u = ((k - ln["from"]) % period) / period
                band = 0.18 * size
                sx = x - half_w - band + u * (2 * half_w + 2 * band)
                ev.append(f"Dialogue: 4,{a},{b},T,,0,0,0,,{{{face}\\bord0\\clip({sx - band:.0f},{y - half_h:.0f},"
                          f"{sx + band:.0f},{y + half_h:.0f})\\1c&HFFFFFF&\\1a{_alpha(op * sw)}}}{text}")
    return ev


def hero_events(c, ph, lk, frame, fps=60):
    if not c or not c.get("name"):
        return []
    ow, oh = int(frame["width"]), int(frame["height"])
    size = float(ph["nameSizeOfHeight"]) * oh
    text = _txt(c["name"])
    ev = []
    for k in range(c["from"], c["to"]):
        prog, op = _env(k, c["from"], c["to"], float(ph["inMs"]), float(ph["outMs"]), fps)
        o = op * _ease_out(prog)
        if o <= 0.0:
            continue
        a, b = frame_span(k, fps)
        ev.append(f"Dialogue: 5,{a},{b},T,,0,0,0,,{{\\an5\\pos({0.5 * ow:.1f},{float(ph['nameY']) * oh:.1f})\\fs{size:.1f}"
                  f"\\bord{max(1.0, size * 0.04):.1f}\\shad0\\1c{_bgr(lk['text'])}\\3c{_bgr(lk['outline'])}"
                  f"\\1a{_alpha(o)}\\3a{_alpha(o)}}}{text}")
    return ev


CREDIT_WIDTH_OF_FRAME, CREDIT_BOTTOM_OF_FRAME = 0.92, 0.96


def _wrap(line, fits):
    """line split at spaces into rows that fits(row) accepts; a word too wide alone (a link) is cut where it still fits."""
    rows, cur = [], ""
    for w in line.split(" "):
        while not fits(w):
            if cur:
                rows.append(cur)
                cur = ""
            k = max(1, max((j for j in range(1, len(w) + 1) if fits(w[:j])), default=1))
            rows.append(w[:k])
            w = w[k:]
        if cur and not fits(f"{cur} {w}"):
            rows.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        rows.append(cur)
    return rows or [""]


def text_width(font_file):
    """-> width(text, px size) in px: the font's own advance widths (Pillow/FreeType, as libass), the font from data/fonts."""
    from PIL import ImageFont  # noqa: PLC0415 - pinned in requirements-bundle.lock.txt
    font = ImageFont.truetype(os.path.join(FONTS_DIR, font_file), 100)
    return lambda s, size: font.getlength(s) * size / 100.0


def credit_layout(lines, pc, lk, frame):
    """Codex BD5 review: every credit character stays inside the frame. -> (rows [(text, source line index)], size):
    lines wrapped to 92 % of the frame width measured with the credit font's own advance widths, and the size lowered
    only when the rows would pass the bottom of the frame."""
    ow, oh = int(frame["width"]), int(frame["height"])
    size = float(pc["sizeOfHeight"]) * oh
    gap, y = float(pc["lineGap"]), float(pc["y"]) * oh
    width = text_width(lk["textFont"])
    while True:
        bord = max(1.0, size * 0.06)
        room = CREDIT_WIDTH_OF_FRAME * ow - 2 * bord
        rows = [(r, i) for i, line in enumerate(lines) for r in _wrap(line, lambda s: width(s, size) <= room)]
        bottom = y + (len(rows) - 1) * gap * size + 0.6 * size
        if bottom <= CREDIT_BOTTOM_OF_FRAME * oh or size <= 4.0:
            return rows, size
        size *= 0.9


def credits_events(c, pc, lk, frame, fps=60):
    if not c or not c.get("lines"):
        return []
    ow, oh = int(frame["width"]), int(frame["height"])
    rows, size = credit_layout(c["lines"], pc, lk, frame)
    n = len(c["lines"])
    in_ms = float(pc["inMs"])
    stagger = min(float(pc["staggerMs"]), (ENTRANCE_MAX_MS - 1 - in_ms) / max(1, n - 1))
    ev = []
    for row, (line, i) in enumerate(rows):
        text = _txt(line)
        y0 = float(pc["y"]) * oh + row * float(pc["lineGap"]) * size
        f_in = c["from"] + int(round(stagger * i / 1000.0 * fps))
        for k in range(f_in, c["to"]):
            prog, op = _env(k, f_in, c["to"], in_ms, float(pc["outMs"]), fps)
            e = _ease_out(prog)
            o = op * e
            if o <= 0.0:
                continue
            a, b = frame_span(k, fps)
            y = y0 + (1.0 - e) * float(pc["rise"]) * oh
            ev.append(f"Dialogue: 6,{a},{b},B,,0,0,0,,{{\\an5\\pos({0.5 * ow:.1f},{y:.1f})\\fs{size:.1f}"
                      f"\\bord{max(1.0, size * 0.06):.1f}\\shad0\\1c{_bgr(lk['text'])}\\3c{_bgr(lk['outline'])}"
                      f"\\1a{_alpha(o)}\\3a{_alpha(o)}}}{text}")
    return ev


def to_ass(pl, frame, cfg, game):
    prm, lk = params(cfg), look_of(game)
    ow, oh = int(frame["width"]), int(frame["height"])
    fps = int(pl["fps"])
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {ow}", f"PlayResY: {oh}", "WrapStyle: 2",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: T,{lk['titleFamily']},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        f"Style: B,{lk['textFamily']},32,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    sl = pl["slots"]
    ev = []
    for ln in ((sl["title"] or {}).get("content") or {}).get("lines") or []:
        ev += title_events(ln, prm["title-extrude"], lk, frame, fps)
    ev += hero_events(sl["hero"].get("content"), prm["hero-bw"], lk, frame, fps)
    ev += credits_events(sl["credits"].get("content"), prm["credits-roll"], lk, frame, fps)
    return "\n".join(head + ev) + "\n", len(ev)


def prepare(wd, pl, frame, cfg, game):
    """Writes wd/beatdrop-titles.ass and copies the look's two fonts into wd/beatdrop-fonts -> the dict
    clip_montage.render_argv(title=) takes, or None when there is nothing to draw."""
    text, n = to_ass(pl, frame, cfg, game)
    if not n:
        return None
    lk = look_of(game)
    fd = os.path.join(wd, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    for f in {lk["titleFont"], lk["textFont"]}:
        shutil.copyfile(os.path.join(FONTS_DIR, f), os.path.join(fd, f))
    with open(os.path.join(wd, ASS_FILE), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return {"ass": ASS_FILE, "fontsdir": FONT_SUBDIR}


def cleanup(wd):
    shutil.rmtree(os.path.join(wd, FONT_SUBDIR), ignore_errors=True)
    for f in (ASS_FILE, TRACK_FILE):
        try:
            os.remove(os.path.join(wd, f))
        except OSError:
            pass
