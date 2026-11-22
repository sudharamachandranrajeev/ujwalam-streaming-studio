# SPDX-License-Identifier: GPL-3.0-or-later
"""LV1c (D423): movement paths on the long highlights video (plan docs/plan/2026-11-21-beatdrop-montages.md, LV1).

Before the last kill of a moment, the enemy's red name tag is followed back from the kill (the tag nearest the
crosshair at the kill frame) through the frames before it, and its path is drawn over the picture in the accent
colour, growing in step with the action, then held a moment and faded out. The path is drawn only when the tracking is
confident (enough frames, the tag moved far enough); otherwise none. It goes into the batch's ASS file with the
captions and chapter cards (long_teaching.batch_overlay).

Data: the tag colour and size are game data (data/games/<game>/moments.json "enemyTag", status unverified until
measured on the user's footage); the HUD areas the tag is never taken from are hud-zones.json; the drawing and
tracking settings are data/clip/long-video.json teaching.paths. Flag: long-video-teaching (teaching.paths.on).
Not built: the user's own movement from optical flow, and dragging the path in the review before rendering."""

from __future__ import annotations

import json
import os
import re

import clip_captions as caps
from clip_common import STOPPED_RC, ClipError, run_tool

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
RAW_FILE = "path-track.rgb"


def load_game(game="codm"):
    """(enemyTag spec, HUD boxes) for a game; (None, []) when the game has no enemyTag block."""
    if not re.fullmatch(r"[a-z0-9_-]+", str(game or "")):
        return None, []
    base = os.path.join(REPO, "data", "games", game)
    try:
        with open(os.path.join(base, "moments.json"), encoding="utf-8") as f:
            spec = json.load(f).get("enemyTag")
    except (OSError, ValueError):
        spec = None
    try:
        with open(os.path.join(base, "hud-zones.json"), encoding="utf-8") as f:
            hud = [z["box"] for z in json.load(f).get("zones") or []]
    except (OSError, ValueError, KeyError, TypeError):
        hud = []
    return spec, hud


def tag_points(rgb, spec, keep=None):
    """Centres (x, y) of the red name tags in one RGB frame (numpy HxWx3), in that frame's pixels. keep: a uint8 mask
    (255 = where a tag may be: the visible game area minus the HUD), or None for the whole frame."""
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    h, w = rgb.shape[:2]
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    m = np.zeros((h, w), np.uint8)
    for lo, hi in spec["hueRanges"]:
        m |= cv2.inRange(hsv, (int(lo), int(spec["minSat"]), int(spec["minVal"])), (int(hi), 255, 255))
    if keep is not None:
        m &= keep
    j = int(spec["joinPx"])  # the letters of a name joined into one tag
    if j > 1:
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((max(1, j // 3), j), np.uint8))
    n, _lab, stats, cent = cv2.connectedComponentsWithStats(m, connectivity=8)
    lo_a, hi_a = float(spec["minAreaShare"]) * w * h, float(spec["maxAreaShare"]) * w * h
    out = []
    for i in range(1, n):
        bw, bh, area = int(stats[i, cv2.CC_STAT_WIDTH]), int(stats[i, cv2.CC_STAT_HEIGHT]), int(stats[i, cv2.CC_STAT_AREA])
        if lo_a <= area <= hi_a and bw >= float(spec["minAspect"]) * max(1, bh):
            out.append((float(cent[i][0]), float(cent[i][1])))
    return out


def track(frames, spec, pcfg, keep=None, area=None):
    """Follows one tag back from the last frame (the kill): the tag nearest the game area's centre (the crosshair)
    within pcfg.startRadius (share of the game width), then in each earlier frame the tag nearest the last position
    within pcfg.maxJump (share of the game width per frame). Missing in more than pcfg.lostFrames frames in a row ends
    it. area: the game area (x0, y0, x1, y1) in these frames' pixels; None = the whole frame (Codex: the game may sit
    inside a canvas). -> ([(frame index, x, y)] in time order, info). Empty when there is no tag at the kill."""
    if not frames:
        return [], {"reason": "no frames"}
    h, w = frames[-1].shape[:2]
    ax0, ay0, ax1, ay1 = area or (0.0, 0.0, float(w), float(h))
    cx, cy, w = (ax0 + ax1) / 2.0, (ay0 + ay1) / 2.0, ax1 - ax0
    start = [p for p in tag_points(frames[-1], spec, keep) if _dist(p, (cx, cy)) <= float(pcfg["startRadius"]) * w]
    if not start:
        return [], {"reason": "no tag near the crosshair at the kill"}
    last = min(start, key=lambda p: _dist(p, (cx, cy)))
    pts, miss, jump = [(len(frames) - 1, last[0], last[1])], 0, float(pcfg["maxJump"]) * w
    for i in range(len(frames) - 2, -1, -1):
        near = [p for p in tag_points(frames[i], spec, keep) if _dist(p, last) <= jump * (miss + 1)]
        if not near:
            miss += 1
            if miss > int(pcfg["lostFrames"]):
                break
            continue
        last, miss = min(near, key=lambda p: _dist(p, last)), 0
        pts.append((i, last[0], last[1]))
    pts.reverse()
    return pts, {"points": len(pts), "frames": len(frames)}


def _dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


def confident(pts, size, pcfg):
    """True when the path has pcfg.minPoints points and its ends are pcfg.minTravel (share of the width) apart."""
    if len(pts) < int(pcfg["minPoints"]):
        return False
    return _dist(pts[0][1:], pts[-1][1:]) >= float(pcfg["minTravel"]) * size[0]


def smooth(pts, k):
    """Moving average over k points (odd), the ends kept."""
    if k <= 1 or len(pts) < 3:
        return list(pts)
    r, out = k // 2, []
    for i, (f, _x, _y) in enumerate(pts):
        a, b = max(0, i - r), min(len(pts), i + r + 1)
        out.append((f, sum(p[1] for p in pts[a:b]) / (b - a), sum(p[2] for p in pts[a:b]) / (b - a)))
    return out


def game_area(size, rec_size, layout):
    """The whole game area (x0, y0, x1, y1) in tracking pixels, even where the frame cuts it: its centre is the
    crosshair (Codex verify: not the centre of the visible part). keep_mask limits tags to the visible part."""
    tw, th = size
    rw, rh = float(rec_size[0]), float(rec_size[1])
    gx, gy, gw, gh = (layout or {}).get("game") or (0.0, 0.0, rw, rh)
    return (gx * tw / rw, gy * th / rh, (gx + gw) * tw / rw, (gy + gh) * th / rh)


def keep_mask(size, rec_size, layout, hud):
    """uint8 mask at the tracking size: 255 inside the visible game area, 0 on the HUD boxes (fractions of the game
    area) and outside the game."""
    import numpy as np  # noqa: PLC0415
    tw, th = size
    rw, rh = float(rec_size[0]), float(rec_size[1])
    sx, sy = tw / rw, th / rh
    gx, gy, gw, gh = (layout or {}).get("game") or (0.0, 0.0, rw, rh)
    vx0, vy0, vx1, vy1 = (layout or {}).get("visible") or (gx, gy, gx + gw, gy + gh)
    m = np.zeros((th, tw), np.uint8)
    m[max(0, int(vy0 * sy)):int(vy1 * sy), max(0, int(vx0 * sx)):int(vx1 * sx)] = 255
    for b in hud:
        m[max(0, int((gy + b["y0"] * gh) * sy)):int((gy + b["y1"] * gh) * sy) + 1,
          max(0, int((gx + b["x0"] * gw) * sx)):int((gx + b["x1"] * gw) * sx) + 1] = 0
    return m


def to_frame(pts, size, rec_size, frame):
    """Tracking pixels -> long video frame pixels (the recording fitted into the frame, as render_argv does)."""
    tw, th = size
    rw, rh = float(rec_size[0]), float(rec_size[1])
    fw, fh = float(frame["width"]), float(frame["height"])
    s = min(fw / rw, fh / rh)
    ox, oy = (fw - rw * s) / 2, (fh - rh * s) / 2
    return [(f, ox + x * rw / tw * s, oy + y * rh / th * s) for f, x, y in pts]


def _stroke(xy):
    """An ASS drawing of a polyline as a zero-width polygon (out and back), drawn by its outline."""
    path = xy + xy[-2::-1]
    return "m " + " ".join(f"{round(x)} {round(y)}" if i != 1 else f"l {round(x)} {round(y)}"
                           for i, (x, y) in enumerate(path))


def _dot(x, y, r):
    return f"m {round(x - r)} {round(y)} l {round(x)} {round(y - r)} {round(x + r)} {round(y)} {round(x)} {round(y + r)}"


def path_styles(pcfg, accent):
    a = caps_colour(accent)
    return [f"Style: Path,Arial,20,&HFF000000,&HFF000000,{a},&H00000000,0,0,0,0,100,100,0,0,1,"
            f"{float(pcfg['strokePx']) / 2:g},0,7,0,0,0,1",
            f"Style: PathDot,Arial,20,{a},{a},&H80000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1"]


def caps_colour(hex_rgb):
    import reel_captions as rcap  # noqa: PLC0415
    return rcap._ass_colour(hex_rgb, 0)


def path_events(pts, fps, t_first, t_max, pcfg):
    """Event lines drawing the path on: one event per pcfg.stepFrames frames showing the path so far and a dot at its
    head, then the whole path held pcfg.holdSec and faded out in pcfg.fadeMs (under 400 ms). pts: [(frame index, x,
    y)] in frame pixels; frame index 0 is at t_first (output seconds); nothing is drawn after t_max."""
    if len(pts) < 2:
        return []
    step, ev = max(1, int(pcfg["stepFrames"])), []
    idx = list(range(1, len(pts), step))
    if idx[-1] != len(pts) - 1:
        idx.append(len(pts) - 1)
    for j, k in enumerate(idx):
        a = t_first + pts[k][0] / fps  # Codex: the frame index counts from the decode start
        last = j == len(idx) - 1
        b = (a + float(pcfg["holdSec"])) if last else t_first + pts[idx[j + 1]][0] / fps
        a, b = min(a, t_max), min(b, t_max)
        if b - a < 1.0 / fps:
            continue
        xy = [(x, y) for _f, x, y in pts[:k + 1]]
        fade = f"\\fad(0,{int(pcfg['fadeMs'])})" if last else ""
        ev.append(f"Dialogue: 2,{caps._ts(a)},{caps._ts(b)},Path,,0,0,0,,{{\\pos(0,0){fade}\\p1}}{_stroke(xy)}")
        ev.append(f"Dialogue: 3,{caps._ts(a)},{caps._ts(b)},PathDot,,0,0,0,,{{\\pos(0,0){fade}\\p1}}"
                  f"{_dot(xy[-1][0], xy[-1][1], float(pcfg['dotPx']))}")
    return ev


def decode(ffmpeg, src, start, sec, size, fps, workdir, stop=None):
    """RGB frames (numpy HxWx3) of the recording from start for sec seconds at the tracking size and fps."""
    import numpy as np  # noqa: PLC0415
    tw, th = size
    out = os.path.join(workdir, RAW_FILE)
    try:
        r = run_tool([ffmpeg, "-v", "error", "-nostdin", "-y", "-ss", f"{start:.3f}", "-t", f"{sec:.3f}", "-i", src,
                      "-an", "-sn", "-vf", f"scale={tw}:{th}:flags=area,fps={fps:g},format=rgb24", "-f", "rawvideo",
                      out], timeout=300, stop=stop, poll_sec=0.5)
        if r.returncode == STOPPED_RC:
            raise ClipError("long video paths: stopped (a stream or recording started)")
        if r.returncode != 0:
            raise ClipError("long video paths: decoding failed: " + (r.stderr or "")[-200:])
        a = np.fromfile(out, dtype=np.uint8)
    finally:
        try:
            os.remove(out)
        except OSError:
            pass
    n = tw * th * 3
    return [a[i * n:(i + 1) * n].reshape(th, tw, 3) for i in range(a.size // n)]


def tracking_size(rec_size, width):
    rw, rh = float(rec_size[0]), float(rec_size[1])
    return int(width) // 2 * 2, int(round(width * rh / rw)) // 2 * 2


def path_kills(kills, lo, hi, pcfg):
    """The kills that get a path: each merged moment's last kill (Codex: merged moments keep each of their paths),
    only where the moment is alone on screen (lo..hi; one in the cross fade out is skipped, never moved), in time order, each window up to
    trackSec before its kill and starting after the previous path has gone (kill + holdSec). A kill whose window is
    too short for minPoints frames gets none, so two paths never overlap. -> [(window start, kill)], recording s."""
    out, free = [], lo
    low = float(pcfg["minPoints"]) / float(pcfg["fps"])
    for k in sorted(k for k in kills if lo <= k <= hi):
        a = max(free, k - float(pcfg["trackSec"]))
        if k - a < low:
            continue
        out.append((a, k))
        free = k + float(pcfg["holdSec"])
    return out


def batch_paths(ffmpeg, src, chunk, starts, xd, frame, pctx, workdir, decode_fn=None):
    """(style lines, event lines, paths drawn) for one batch. pctx: {pcfg, spec, hud, layout, rec_size, accent}.
    starts: each piece's start on the batch's output timeline. Paths for the kills path_kills picks, each tracked back
    from its kill frame (the decode ends one frame after the kill, so the last frame is the kill)."""
    pcfg, spec = pctx["pcfg"], pctx["spec"]
    size = tracking_size(pctx["rec_size"], pcfg["trackWidth"])
    keep = keep_mask(size, pctx["rec_size"], pctx.get("layout"), pctx.get("hud") or [])
    area = game_area(size, pctx["rec_size"], pctx.get("layout"))
    fps = float(pcfg["fps"])
    dec = decode_fn or (lambda s, d: decode(ffmpeg, src, s, d, size, fps, workdir))
    ev, n = [], 0
    for i, (g, p0) in enumerate(zip(chunk, starts)):
        g0, g1 = float(g["start"]), float(g["end"])
        lo = g0 + (xd if i else 0.0)  # recording seconds where this moment is alone on screen
        hi = g1 - (xd if i + 1 < len(chunk) else 0.0)
        out_end = p0 + (hi - g0)
        for a, k in path_kills([float(t) for t in g.get("lastKills") or []], lo, hi, pcfg):
            frames = dec(a, k - a + 1.0 / fps)
            pts, _info = track(frames, spec, pcfg, keep, area)
            if not confident(pts, (area[2] - area[0], area[3] - area[1]), pcfg):
                continue
            fp = to_frame(smooth(pts, int(pcfg["smooth"])), size, pctx["rec_size"], frame)
            ev += path_events(fp, fps, p0 + (a - g0), out_end, pcfg)
            n += 1
    return (path_styles(pcfg, pctx["accent"]) if ev else []), ev, n
