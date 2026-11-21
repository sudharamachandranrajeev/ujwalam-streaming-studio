# SPDX-License-Identifier: GPL-3.0-or-later
"""RS1 reel style analyser (plan docs/plan/2026-11-21-reel-styles-library.md, D412). Measures example videos the user
added to a reel style and merges them into numbers the style mapping (reel_style.py) can use. Off air only, one job at a
time, BelowNormal priority. The examples are read, never copied; the output is numbers only (no frames, no OCR text).

Per example (analyse_video):
- cuts and pacing: shot boundaries from the HSV-histogram distance of small frames (lag 1 for hard cuts, lag L for
  gradual ones), shot lengths, cut rate, share of cuts on a beat of the example's own music (music_library);
- transitions: each cut classed hard / fade / flash (luminance spike or dip) / whip (large sideways global shift);
- zooms and shake: global scale and offset between frames (corner tracking + partial affine fit at low resolution);
  zoom pulses (size, length, how often), shake amplitude (offset left after a 0.5 s smoothing);
- speed ramps: a sustained step in global motion speed inside a shot (UNVERIFIED on real footage);
- text: RapidOCR on frames sampled every text.stepSec: position band, size against frame height, how long each stays,
  entrance after the cut before it (text itself is never stored);
- colour: Lab mean and spread (stats only; the LUT is fitted at render time against the user's own clip);
- music: music_library.analyse on the example's sound (tempo, energy, mood).
Anything that cannot be measured (no sound, too short, no tracking) is left out with a reason in "omitted".

  load_config(path=None)
  analyse_video(path, cfg=None, progress=None) -> per-example numbers
  merge(examples, cfg=None)                    -> {"cuts", "transitions", ...,"spread", "omitted"}
  run_style(data_dir, style_id, cfg=None)      -> the updated style.json (CLI: --data-dir --style)
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
import os
import sys
import time
import warnings

import sys as _sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in _sys.path:  # run as a script with -I (the studio): the clip modules sit next to this file
    _sys.path.insert(0, _HERE)

from clip_common import CLIP_DATA, ClipError, eprint, load_json, lower_own_priority, on_air, write_json_atomic

CONFIG_FILE = os.path.join(CLIP_DATA, "reel-styles.json")
CLASSES = ("hard", "fade", "flash", "whip")


def load_config(path=None):
    return load_json(path or CONFIG_FILE)


def _np():
    import numpy as np  # noqa: PLC0415
    return np


def _median(xs):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else 0.5 * (xs[n // 2 - 1] + xs[n // 2])


def _q(xs, q):
    xs = sorted(xs)
    if not xs:
        return None
    return xs[min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))]


def _r(v, n=3):
    return None if v is None else round(float(v), n)


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


# ---------------------------------------------------------------- frame pass

def _frames(path, max_fps):
    """Decoded frames as BGR (motion size) with their time; frames above max_fps are skipped."""
    import av  # noqa: PLC0415
    c = av.open(path)
    try:
        st = next((s for s in c.streams if s.type == "video"), None)
        if st is None:
            raise ClipError(f"{os.path.basename(path)}: no picture")
        st.thread_type = "AUTO"
        st.codec_context.thread_count = 2
        rate = float(st.average_rate or 30)
        step = 1.0 / min(rate, float(max_fps))
        nxt = -1e9
        for fr in c.decode(st):
            t = float(fr.time) if fr.time is not None else (nxt + step)
            if t < nxt - 0.5 * step:  # container times can be rounded to the ms: half a frame of slack
                continue
            nxt = nxt + step if abs(t - nxt) < 0.5 * step else t + step
            yield t, fr, min(rate, float(max_fps))
    finally:
        c.close()


def _ocr_engine():
    from rapidocr import RapidOCR  # noqa: PLC0415 - shipped in the bundle (models inside the package; no download)
    return RapidOCR(params={"Global.log_level": "error", "Global.use_cls": False,
                            "Det.limit_type": "max", "Det.limit_side_len": 960})


def _ocr_boxes(eng, img, min_score):
    """Normalised text boxes (x0, y0, x1, y1 in 0..1); the text itself is dropped."""
    h, w = img.shape[:2]
    r = eng(img)
    out = []
    if r.boxes is not None and r.scores is not None:
        for poly, sc in zip(r.boxes, r.scores):
            if float(sc) < min_score:
                continue
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            out.append((min(xs) / w, min(ys) / h, max(xs) / w, max(ys) / h))
    return out


def _grid_features(gray, n=4, per=10):
    """Corners picked per cell of an n x n grid (each cell with its own quality line), so the strong corners of an
    overlay (text, HUD) never take all the points from the picture behind it."""
    import cv2  # noqa: PLC0415
    np = _np()
    h, w = gray.shape[:2]
    out = []
    for gy in range(n):
        for gx in range(n):
            y0, y1, x0, x1 = gy * h // n, (gy + 1) * h // n, gx * w // n, (gx + 1) * w // n
            p = cv2.goodFeaturesToTrack(gray[y0:y1, x0:x1], per, 0.01, 4)
            if p is not None:
                out.append(p + np.array([[x0, y0]], np.float32))
    return np.concatenate(out).astype(np.float32) if out else None


def frame_pass(path, cfg, progress=None, ocr=True):
    """One decode of the example -> per-frame arrays and the text samples."""
    import cv2  # noqa: PLC0415
    np = _np()
    a = cfg["analyse"]
    cv2.setNumThreads(2)
    tw, mw = int(a["thumbWidth"]), int(a["motionWidth"])
    L = int(a["cut"]["gradualLagFrames"])
    tx_cfg = a["text"]
    eng = None
    if ocr:
        try:
            eng = _ocr_engine()
        except Exception as e:  # noqa: BLE001 - OCR missing: text is left out with the reason
            eng = e
    rec = collections.defaultdict(list)
    hists = collections.deque(maxlen=L + 1)
    prev_gray = None
    text, next_text, fps = [], 0.0, None
    for t, fr, fps in _frames(path, a["maxFps"]):
        if fr.width < 16 or fr.height < 16:
            raise ClipError("picture too small")
        mh = max(8, int(round(mw * fr.height / fr.width / 2)) * 2)
        th = max(4, int(round(tw * fr.height / fr.width / 2)) * 2)
        img = fr.to_ndarray(width=mw, height=mh, format="bgr24")
        small = cv2.resize(img, (tw, th), interpolation=cv2.INTER_AREA)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 4], [0, 180, 0, 256])
        hist = cv2.normalize(hist, None, 1.0, 0, cv2.NORM_L1)
        d1 = cv2.compareHist(hists[-1], hist, cv2.HISTCMP_BHATTACHARYYA) if hists else 0.0
        dL = cv2.compareHist(hists[0], hist, cv2.HISTCMP_BHATTACHARYYA) if len(hists) == L + 1 else 0.0
        hists.append(hist)
        lab = cv2.cvtColor(small.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab).reshape(-1, 3)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        s, dx, dy, ok = 1.0, 0.0, 0.0, False
        if prev_gray is not None:
            pts = _grid_features(prev_gray)
            if pts is not None and len(pts) >= 8:
                nxt, stt, _err = cv2.calcOpticalFlowPyrLK(prev_gray, gray, pts, None, winSize=(15, 15), maxLevel=3)
                good = stt.reshape(-1) == 1
                # overlays (captions, HUD, a name tag) stay still while the picture moves: when a fair share of the
                # points moves, the still ones are left out of the fit, so an overlay never reads as a still picture
                moving = good & (np.linalg.norm((nxt - pts).reshape(-1, 2), axis=1) > 0.3)
                if moving.sum() >= max(8, 0.25 * good.sum()):
                    good = moving
                if good.sum() >= 8:
                    M, inl = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC,
                                                         ransacReprojThreshold=1.5)
                    if M is not None and inl is not None and inl.mean() >= 0.5:
                        s = float(math.hypot(M[0, 0], M[1, 0]))
                        # the offset of the frame centre (not of the corner), as a share of the width
                        cx, cy = mw / 2.0, mh / 2.0
                        dx = float(M[0, 0] * cx + M[0, 1] * cy + M[0, 2] - cx) / mw
                        dy = float(M[1, 0] * cx + M[1, 1] * cy + M[1, 2] - cy) / mw
                        ok = True
        prev_gray = gray
        for k, v in (("t", t), ("d1", d1), ("dL", dL), ("luma", float(gray.mean())), ("L", float(lab[:, 0].mean())),
                     ("a", float(lab[:, 1].mean())), ("b", float(lab[:, 2].mean())), ("Ls", float(lab[:, 0].std())),
                     ("s", s), ("dx", dx), ("dy", dy), ("ok", ok)):
            rec[k].append(v)
        if ocr and not isinstance(eng, Exception) and t >= next_text and len(text) < int(tx_cfg["maxSamples"]):
            ls = int(tx_cfg["longSide"])
            k = ls / max(fr.width, fr.height)
            timg = fr.to_ndarray(width=max(16, int(fr.width * k) // 2 * 2), height=max(16, int(fr.height * k) // 2 * 2),
                                 format="bgr24")
            text.append((t, _ocr_boxes(eng, timg, float(tx_cfg["minScore"]))))
            next_text = t + float(tx_cfg["stepSec"])
        if progress and len(rec["t"]) % 300 == 0:
            progress(t)
    if not rec["t"]:
        raise ClipError(f"{os.path.basename(path)}: no frames decoded")
    out = {k: np.asarray(v) for k, v in rec.items()}
    out["fps"] = fps
    out["text"] = text
    out["ocrError"] = str(eng)[-160:] if isinstance(eng, Exception) else None
    return out


# ---------------------------------------------------------------- cuts and transitions

def _groups(idx, gap):
    out = []
    for i in idx:
        if out and i - out[-1][1] <= gap:
            out[-1][1] = i
        else:
            out.append([i, i])
    return out


def _excursion(luma, i0, i1, w):
    """Largest luminance jump inside [i0, i1] against the mean of the frames just outside it."""
    np = _np()
    n = len(luma)
    pre = luma[max(0, i0 - w):max(0, i0 - 1)] if i0 - 1 > 0 else luma[:1]
    post = luma[min(n - 1, i1 + 2):min(n, i1 + 2 + w)] if i1 + 2 < n else luma[-1:]
    ref = float(np.concatenate([pre, post]).mean()) if len(pre) + len(post) else float(luma[i0])
    lo, hi = max(0, i0 - 1), min(n, i1 + 2)
    seg = luma[lo:hi]
    return float(np.max(np.abs(seg - ref))) if len(seg) else 0.0


def cut_events(fp, cfg):
    """[{i0, i1, t, kind}] in time order."""
    np = _np()
    a = cfg["analyse"]
    c = a["cut"]
    d1, dL, luma = fp["d1"], fp["dL"], fp["luma"]
    L, gap = int(c["gradualLagFrames"]), int(c["groupFrames"])
    hard = _groups([int(i) for i in np.nonzero(d1 > float(c["histHard"]))[0]], gap)
    taken = np.zeros(len(d1), bool)
    for i0, i1 in hard:
        taken[max(0, i0 - L):min(len(d1), i1 + L + 1)] = True
    grad_idx = [int(i) for i in np.nonzero((dL > float(c["histGradual"])) & ~taken)[0]]
    grad = []
    for i0, i1 in _groups(grad_idx, 1):
        # a lag-L window: the change spans [i0 - L, i1]; at least 2 frames above the line
        if i1 - i0 + 1 >= 2:
            grad.append([max(0, i0 - L), i1])
    evs = []
    for i0, i1 in hard:
        evs.append({"i0": i0, "i1": i1, "gradual": False})
    for i0, i1 in grad:
        evs.append({"i0": i0, "i1": i1, "gradual": True})
    evs.sort(key=lambda e: e["i0"])
    merged = []
    for e in evs:
        if merged and e["i0"] - merged[-1]["i1"] <= gap:
            merged[-1]["i1"] = max(merged[-1]["i1"], e["i1"])
            merged[-1]["gradual"] = merged[-1]["gradual"] or e["gradual"]
        else:
            merged.append(dict(e))
    t = fp["t"]
    out = []
    shift = float(a["whip"]["shiftPerFrame"])
    for e in merged:
        i0, i1 = e["i0"], e["i1"]
        exc = _excursion(luma, i0, i1, int(a["flash"]["window"]))
        lo, hi = max(1, i0 - 1), min(len(t), i1 + 2)
        okm = fp["ok"][lo:hi]
        dx = np.abs(fp["dx"][lo:hi])[okm] if okm.any() else np.zeros(0)
        if exc > float(a["flash"]["lumaJump"]):
            kind = "flash"
        elif len(dx) and float(np.max(dx)) > shift:
            kind = "whip"
        elif e["gradual"] or i1 - i0 >= 2:
            kind = "fade"
        else:
            kind = "hard"
        mid = (i0 + i1 + 1) // 2 if kind != "hard" else i1
        out.append({"i0": i0, "i1": i1, "t": float(t[min(len(t) - 1, mid)]), "kind": kind})
    # shots shorter than minShotSec are not shots: the closer event is dropped
    keep = []
    for e in out:
        if keep and e["t"] - keep[-1]["t"] < float(c["minShotSec"]):
            continue
        keep.append(e)
    return keep


# ---------------------------------------------------------------- zooms, shake, speed

def _smooth(x, n):
    np = _np()
    if n <= 1 or len(x) < 2:
        return x.astype(float)
    k = np.ones(n) / n
    pad = np.pad(x.astype(float), (n // 2, n - 1 - n // 2), mode="edge")
    return np.convolve(pad, k, mode="valid")


def _run_median(x, n):
    np = _np()
    if len(x) < 3:
        return np.full(len(x), float(np.median(x)) if len(x) else 0.0)
    n = min(n | 1, (len(x) // 2) * 2 + 1 if len(x) % 2 else len(x) - 1)
    pad = np.pad(x.astype(float), (n // 2, n // 2), mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(pad, n), axis=1)


def _shots(fp, events):
    """Frame spans between transitions (the transition frames themselves left out)."""
    n = len(fp["t"])
    starts = [0] + [e["i1"] + 1 for e in events]
    ends = [e["i0"] for e in events] + [n]
    return [(s, e) for s, e in zip(starts, ends) if e - s >= 3]


def zooms(fp, events, cfg):
    np = _np()
    a = cfg["analyse"]["zoom"]
    fps = float(fp["fps"])
    pulses, shake = [], []
    for s, e in _shots(fp, events):
        ls = np.where(fp["ok"][s:e], np.log(np.maximum(1e-3, fp["s"][s:e])), 0.0)
        ls[0] = 0.0
        z = np.cumsum(ls)
        # a pulse: z rises above the line and comes back within maxPulseSec
        thr = math.log(1.0 + float(a["minPulse"]))
        zz = z - _run_median(z, max(5, int(1.5 * fps)))  # a slow push-in is not a pulse
        i = 0
        while i < len(zz):
            if zz[i] >= thr:
                j = i
                while j < len(zz) and zz[j] >= thr * 0.3:
                    j += 1
                k0 = i
                while k0 > 0 and zz[k0 - 1] >= thr * 0.3:
                    k0 -= 1
                pk = k0 + int(np.argmax(zz[k0:j]))
                dur = (j - k0) / fps
                if dur <= float(a["maxPulseSec"]) and j < len(zz):
                    pulses.append({"t": _r(fp["t"][s + pk]), "scale": _r(math.exp(float(zz[pk])), 4),
                                   "sec": _r(dur), "inSec": _r((pk - k0) / fps), "outSec": _r((j - pk) / fps)})
                i = j + 1
            else:
                i += 1
        cx = np.cumsum(np.where(fp["ok"][s:e], fp["dx"][s:e], 0.0))
        cy = np.cumsum(np.where(fp["ok"][s:e], fp["dy"][s:e], 0.0))
        w = max(3, int(0.5 * fps))
        if len(cx) > w:
            res = np.hypot(cx - _smooth(cx, w), cy - _smooth(cy, w))
            shake.append(float(np.sqrt(np.mean(res ** 2))) * 100.0)
    dur = float(fp["t"][-1] - fp["t"][0]) + 1.0 / fps
    return {"pulses": pulses, "ratePerMin": _r(len(pulses) * 60.0 / dur, 2),
            "scale": _r(_median([p["scale"] for p in pulses]), 4), "sec": _r(_median([p["sec"] for p in pulses])),
            "inSec": _r(_median([p["inSec"] for p in pulses])), "outSec": _r(_median([p["outSec"] for p in pulses])),
            "shakePct": _r(_median(shake), 3)}


def ramps(fp, events, cfg, pulses=()):
    """Sustained steps in global motion speed inside a shot (frames inside a zoom pulse are left out: a zoom is not a
    speed change). UNVERIFIED on real footage (D412)."""
    np = _np()
    a = cfg["analyse"]["ramp"]
    fps = float(fp["fps"])
    w = max(2, int(float(a["windowSec"]) * fps))
    floor = float(a["minSpeed"])
    found = []
    t_all = fp["t"]
    busy = np.zeros(len(t_all), bool)
    for p in pulses:
        busy |= (t_all >= p["t"] - p["inSec"] - 2.0 / fps) & (t_all <= p["t"] + p["outSec"] + 2.0 / fps)
    for s, e in _shots(fp, events):
        sp = np.where(fp["ok"][s:e] & ~busy[s:e], np.hypot(fp["dx"][s:e], fp["dy"][s:e]), np.nan)
        if np.isnan(sp).all() or len(sp) < 2 * w + 1:
            continue
        best = []
        for k in range(w, len(sp) - w):
            # motion per unit of time (mean, not median): a slowed or 30-in-60 picture repeats frames, and a repeated
            # frame counts as no motion for its time
            with warnings.catch_warnings():  # a window inside a zoom pulse is all NaN: skipped below
                warnings.simplefilter("ignore", RuntimeWarning)
                b = np.nanmean(sp[k - w:k])
                f = np.nanmean(sp[k:k + w])
            if np.isnan(b) or np.isnan(f) or max(b, f) < floor or min(b, f) < floor / 4:
                continue
            ratio = max(b, f) / min(b, f)
            if ratio >= float(a["ratio"]):
                best.append((k, ratio, min(b, f) / max(b, f)))
        for grp in _groups([x[0] for x in best], int(fps * 0.3)):
            cand = [x for x in best if grp[0] <= x[0] <= grp[1]]
            k, _ratio, factor = max(cand, key=lambda x: x[1])
            found.append({"t": _r(fp["t"][s + k]), "factor": _r(factor)})
    dur = float(fp["t"][-1] - fp["t"][0]) + 1.0 / fps
    cuts = [e["t"] for e in events]
    near = [min((abs(r["t"] - c) for c in cuts), default=None) for r in found]
    return {"ramps": found, "ratePerMin": _r(len(found) * 60.0 / dur, 2),
            "factor": _r(_median([r["factor"] for r in found])), "fromCutSec": _r(_median(near))}


# ---------------------------------------------------------------- text

def _iou(p, q):
    ix = max(0.0, min(p[2], q[2]) - max(p[0], q[0]))
    iy = max(0.0, min(p[3], q[3]) - max(p[1], q[1]))
    i = ix * iy
    u = (p[2] - p[0]) * (p[3] - p[1]) + (q[2] - q[0]) * (q[3] - q[1]) - i
    return i / u if u > 0 else 0.0


def text_tracks(samples, step):
    """Boxes followed across samples -> tracks {start, end, box(median)}."""
    open_, done = [], []
    for t, boxes in samples:
        nxt = []
        used = set()
        for tr in open_:
            j = max(range(len(boxes)), key=lambda k: _iou(tr["last"], boxes[k]), default=None)
            if j is not None and j not in used and _iou(tr["last"], boxes[j]) > 0.3:
                used.add(j)
                tr["last"] = boxes[j]
                tr["boxes"].append(boxes[j])
                tr["end"] = t
                nxt.append(tr)
            else:
                done.append(tr)
        for k, b in enumerate(boxes):
            if k not in used:
                nxt.append({"start": t, "end": t, "last": b, "boxes": [b]})
        open_ = nxt
    done += open_
    out = []
    for tr in done:
        bx = [_median([b[i] for b in tr["boxes"]]) for i in range(4)]
        out.append({"start": tr["start"], "end": tr["end"] + step, "box": bx})
    return sorted(out, key=lambda x: x["start"])


def text_stats(fp, events, cfg):
    a = cfg["analyse"]["text"]
    step = float(a["stepSec"])
    tracks = text_tracks(fp["text"], step)
    # boxes on one line close together are one text (words of one name)
    lines = []
    for tr in tracks:
        m = next((x for x in lines if abs(x["start"] - tr["start"]) <= step and abs(x["end"] - tr["end"]) <= step
                  and abs((x["box"][1] + x["box"][3]) - (tr["box"][1] + tr["box"][3])) / 2 < 0.03), None)
        if m:
            m["box"] = [min(m["box"][0], tr["box"][0]), min(m["box"][1], tr["box"][1]),
                        max(m["box"][2], tr["box"][2]), max(m["box"][3], tr["box"][3])]
        else:
            lines.append(dict(tr))
    cuts = [0.0] + [e["t"] for e in events]
    dur = float(fp["t"][-1] - fp["t"][0]) + 1.0 / float(fp["fps"])
    rows = []
    for x in lines:
        x0, y0, x1, y1 = x["box"]
        cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
        prev = max(c for c in cuts if c <= x["start"] + 1e-6) if any(c <= x["start"] + 1e-6 for c in cuts) else 0.0
        rows.append({"start": _r(x["start"]), "sec": _r(x["end"] - x["start"]), "cy": _r(cy), "cx": _r(cx),
                     "sizePct": _r((y1 - y0) * 100.0, 2), "widthPct": _r((x1 - x0) * 100.0, 2),
                     "band": "top" if cy < 1 / 3 else ("middle" if cy < 2 / 3 else "bottom"),
                     # a corner tag stays on one side of the frame (never crosses the middle) and is not in the middle band
                     "corner": bool((x1 < 0.45 or x0 > 0.55) and not (1 / 3 <= cy < 2 / 3)),
                     "afterCutSec": _r(x["start"] - prev)})
    bands = collections.Counter(r["band"] for r in rows)
    return {"texts": rows, "perMin": _r(len(rows) * 60.0 / dur, 2), "sec": _r(_median([r["sec"] for r in rows])),
            "sizePct": _r(_median([r["sizePct"] for r in rows]), 2),
            "band": bands.most_common(1)[0][0] if rows else None,
            "cornerShare": _r(sum(r["corner"] for r in rows) / len(rows)) if rows else None,
            "afterCutSec": _r(_median([r["afterCutSec"] for r in rows])), "stepSec": step}


# ---------------------------------------------------------------- beats

def beat_phase(path, bpm, ml, mcfg):
    """Where the beats fall (s, 0..period) for a known tempo: the onset-strength-weighted circular mean of the onset
    times folded on the exact (fractional) beat period. music_library's own offset folds on a whole number of envelope
    frames, which drifts over a long example; the tempo itself is taken from music_library."""
    np = _np()
    mono = ml.decode(path, ml.SR, 1, max_sec=float(mcfg["maxAnalyseSec"]))[:, 0]
    env, rate, _c = ml._onsets(mono, ml.SR)  # noqa: SLF001 - same package; hop 1024, window 2048
    period = 60.0 / float(bpm)
    t = (np.arange(len(env)) * 1024 + 1024) / float(ml.SR)  # an onset peaks when it reaches the window centre
    w = np.maximum(0.0, env - np.percentile(env, 75)) ** 2
    if w.sum() <= 0:
        return 0.0
    ang = 2 * np.pi * (t % period) / period
    ph = math.atan2(float((w * np.sin(ang)).sum()), float((w * np.cos(ang)).sum()))
    return round((ph % (2 * np.pi)) / (2 * np.pi) * period, 3)


# ---------------------------------------------------------------- one example

def analyse_video(path, cfg=None, progress=None, ocr=True):
    cfg = cfg or load_config()
    t0 = time.perf_counter()
    fp = frame_pass(path, cfg, progress, ocr=ocr)
    np = _np()
    fps = float(fp["fps"])
    dur = float(fp["t"][-1] - fp["t"][0]) + 1.0 / fps
    omitted = []
    if dur < float(cfg["minExampleSec"]):
        raise ClipError(f"{os.path.basename(path)}: shorter than {cfg['minExampleSec']} s")
    events = cut_events(fp, cfg)
    cut_t = [e["t"] for e in events]
    bounds = [0.0] + cut_t + [dur]
    shots = [b - a for a, b in zip(bounds, bounds[1:]) if b - a > 0]
    mix = collections.Counter(e["kind"] for e in events)
    cuts = {"times": [_r(x) for x in cut_t], "count": len(cut_t), "ratePerMin": _r(len(cut_t) * 60.0 / dur, 2),
            "shotSec": _r(_median(shots)), "shotP25": _r(_q(shots, 0.25)), "shotP75": _r(_q(shots, 0.75))}
    transitions = {"events": [{"t": _r(e["t"]), "kind": e["kind"]} for e in events],
                   "mix": {k: _r(mix[k] / len(events)) if events else 0.0 for k in CLASSES}}
    music = None
    try:
        import music_library as ml  # noqa: PLC0415
        mcfg = ml.load_config()
        if dur < float(cfg["analyse"]["minAudioSec"]):
            raise ClipError("too short for a tempo")
        m = ml.analyse(path, mcfg)
        music = {"bpm": m["bpm"], "beatOffset": beat_phase(path, m["bpm"], ml, mcfg), "energyLevel": m["energyLevel"], "mood": m["mood"],
                 "loudnessLufs": m["loudnessLufs"]}
    except (ClipError, OSError, ValueError, ImportError) as e:
        omitted.append({"part": "music", "reason": f"no usable sound ({str(e)[-100:]})"})
    if music and cut_t:
        period = 60.0 / float(music["bpm"])
        tol = float(cfg["analyse"]["beatToleranceSec"])
        on = sum(1 for c in cut_t if abs(((c - music["beatOffset"]) + period / 2) % period - period / 2) <= tol)
        cuts["beatShare"] = _r(on / len(cut_t))
    elif not cut_t:
        omitted.append({"part": "beatShare", "reason": "no cuts"})
    else:
        omitted.append({"part": "beatShare", "reason": "no beat (no usable sound)"})
    okshare = float(np.mean(fp["ok"][1:])) if len(fp["ok"]) > 1 else 0.0
    if okshare >= 0.3:
        zm = zooms(fp, events, cfg)
        rp = ramps(fp, events, cfg, zm["pulses"])
    else:
        zm = rp = None
        omitted.append({"part": "zooms", "reason": f"motion tracked on only {okshare:.0%} of frames"})
        omitted.append({"part": "ramps", "reason": f"motion tracked on only {okshare:.0%} of frames"})
    if fp["ocrError"] or not ocr:
        tx = None
        omitted.append({"part": "text", "reason": "text reader not available" if ocr else "text reading off"})
    else:
        tx = text_stats(fp, events, cfg)
    colour = {"L": _r(np.median(fp["L"]), 2), "a": _r(np.median(fp["a"]), 2), "b": _r(np.median(fp["b"]), 2),
              "contrast": _r(np.median(fp["Ls"]), 2), "chroma": _r(np.median(np.hypot(fp["a"], fp["b"])), 2)}
    return {"seconds": _r(dur), "fps": _r(fps, 2), "frames": int(len(fp["t"])), "cuts": cuts,
            "transitions": transitions, "zooms": zm, "ramps": rp, "text": tx, "colour": colour, "music": music,
            "omitted": omitted, "analyseSec": _r(time.perf_counter() - t0, 2), "trackedShare": _r(okshare)}


# ---------------------------------------------------------------- merge per style

def merge(examples, cfg=None):
    """Median over examples (with min/max spread) of every number the mapping uses. A part measured in no example is
    left out with the reasons."""
    cfg = cfg or load_config()
    paths = {"cuts": ("ratePerMin", "shotSec", "shotP25", "shotP75", "beatShare"),
             "zooms": ("ratePerMin", "scale", "sec", "inSec", "outSec", "shakePct"),
             "ramps": ("ratePerMin", "factor", "fromCutSec"),
             "text": ("perMin", "sec", "sizePct", "cornerShare", "afterCutSec"),
             "colour": ("L", "a", "b", "contrast", "chroma"),
             "music": ("bpm", "energyLevel")}
    out, spread, omitted = {}, {}, []
    for part, keys in paths.items():
        have = [e[part] for e in examples if e.get(part)]
        if not have:
            reasons = sorted({o["reason"] for e in examples for o in e.get("omitted", []) if o["part"] == part})
            omitted.append({"part": part, "reason": "; ".join(reasons) or "not measured"})
            continue
        out[part], spread[part] = {}, {}
        for k in keys:
            vals = [h[k] for h in have if h.get(k) is not None]
            if vals:
                out[part][k] = _r(_median(vals), 4)
                spread[part][k] = [_r(min(vals), 4), _r(max(vals), 4)]
    if out.get("text"):
        bands = collections.Counter(e["text"]["band"] for e in examples if e.get("text") and e["text"].get("band"))
        out["text"]["band"] = bands.most_common(1)[0][0] if bands else None
    if out.get("music"):
        moods = collections.Counter(e["music"]["mood"] for e in examples if e.get("music"))
        out["music"]["mood"] = moods.most_common(1)[0][0]
    n_ev = sum(len(e["transitions"]["events"]) for e in examples)
    if n_ev:
        cnt = collections.Counter(ev["kind"] for e in examples for ev in e["transitions"]["events"])
        out["transitions"] = {"mix": {k: _r(cnt[k] / n_ev) for k in CLASSES}, "count": n_ev}
    else:
        omitted.append({"part": "transitions", "reason": "no cuts found"})
    out["spread"] = spread
    out["omitted"] = omitted
    return out


# ---------------------------------------------------------------- the style job (off air, one at a time)

def style_dir(data_dir, style_id, cfg=None):
    cfg = cfg or load_config()
    if not isinstance(style_id, str) or not style_id or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in style_id):
        raise ClipError("style id must be lower-case letters, digits and dashes")
    return os.path.join(data_dir, *cfg["stylesDir"].split("/"), style_id)


class _Lock:
    def __init__(self, path):
        self.path = path

    def __enter__(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        try:
            if time.time() - os.path.getmtime(self.path) > 3600:
                os.remove(self.path)  # left by a job that died an hour ago
        except OSError:
            pass
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise ClipError("another style analysis is running; try again when it finishes") from None
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return self

    def __exit__(self, *exc):
        try:
            os.remove(self.path)
        except OSError:
            pass


def run_style(data_dir, style_id, cfg=None, live=on_air, progress=None, ocr=True):
    import reel_style as rs  # noqa: PLC0415 - the record rules live there
    cfg = cfg or load_config()
    if live() is not False:
        raise ClipError("the studio is live or recording (or that cannot be told): styles are analysed off air only")
    d = style_dir(data_dir, style_id, cfg)
    doc = load_json(os.path.join(d, "style.json"))
    probs = rs.style_problems(doc, cfg, analysed=False)
    if probs:
        raise ClipError("style.json: " + "; ".join(probs))
    lock = os.path.join(data_dir, *cfg["stylesDir"].split("/"), ".analyse.lock")
    with _Lock(lock):
        per, exs = [], []
        for i, ex in enumerate(doc["examples"]):
            p = ex["path"]
            if not os.path.isfile(p):
                raise ClipError(f"example {i + 1} is missing: {os.path.basename(p)}")
            if progress:
                progress(f"example {i + 1}/{len(doc['examples'])}")
            r = analyse_video(p, cfg, ocr=ocr)
            if r["seconds"] > float(cfg["maxExampleSec"]):
                raise ClipError(f"example {i + 1} is longer than {cfg['maxExampleSec']} s")
            per.append(r)
            exs.append({"path": p, "sha256": sha256_file(p), "seconds": r["seconds"]})
        merged = merge(per, cfg)
        doc = dict(doc, examples=exs, measured=merged, analysedAt=time.strftime("%Y-%m-%dT%H:%M:%S"),
                   perExample=[{k: r[k] for k in ("seconds", "fps", "analyseSec", "trackedShare")} for r in per])
        doc.update(rs.from_measured(merged, cfg))
        probs = rs.style_problems(doc, cfg)
        if probs:
            raise ClipError("style.json after analysis: " + "; ".join(probs))
        write_json_atomic(os.path.join(d, "style.json"), doc)
    return doc


def peak_memory_mb():
    """This process's peak working set (Windows) or max RSS (elsewhere), in MB; None when it cannot be read."""
    try:
        if os.name == "nt":
            import ctypes  # noqa: PLC0415
            from ctypes import wintypes  # noqa: PLC0415

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
            c = PMC()
            c.cb = ctypes.sizeof(PMC)
            k = ctypes.windll.kernel32
            k.GetCurrentProcess.restype = wintypes.HANDLE
            ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            if ctypes.windll.psapi.GetProcessMemoryInfo(k.GetCurrentProcess(), ctypes.byref(c), c.cb):
                return round(c.PeakWorkingSetSize / 1048576.0, 1)
            return None
        import resource  # noqa: PLC0415
        return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 1)
    except (OSError, AttributeError, ValueError):
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(description="Reel style analyser (RS1, off air only)")
    ap.add_argument("--data-dir")
    ap.add_argument("--style")
    ap.add_argument("--video", help="analyse one video and print the numbers (tests, bound check)")
    ap.add_argument("--no-ocr", action="store_true")
    a = ap.parse_args(argv)
    lower_own_priority()
    try:
        if a.video:
            t0 = time.perf_counter()
            r = analyse_video(a.video, ocr=not a.no_ocr)
            print(json.dumps({"result": r, "wallSec": round(time.perf_counter() - t0, 2),
                              "peakMb": peak_memory_mb()}))
            return 0
        if not (a.data_dir and a.style):
            ap.error("--data-dir and --style (or --video)")
        doc = run_style(a.data_dir, a.style, progress=lambda s: print(f"progress {s}", flush=True), ocr=not a.no_ocr)
        print(json.dumps({"ok": True, "style": a.style, "summary": doc.get("summary")}))
        return 0
    except ClipError as e:
        eprint(f"style analysis: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
