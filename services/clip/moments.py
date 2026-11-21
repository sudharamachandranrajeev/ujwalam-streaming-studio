# SPDX-License-Identifier: GPL-3.0-or-later
"""BD1 moment finder (plan docs/plan/2026-11-21-beatdrop-montages.md section 5 BD1, D413, D414). From one recording it
finds and times to the frame the moments a beat-locked montage cuts on:

- gunshot: a sharp transient in the game sound (spectral flux in the gunshot.bandHz band) confirmed by a muzzle flash
  (a brightness rise in gunshot.weaponZone) within gunshot.confirmFrames frames; the time is the flash frame;
- hit / kill: hit markers (white pixels in hitmarker.zone) and the existing CODM detector hits (detector_pass hits
  jsonl, read with clip_signals.read_hits; kills.detectors); the kill time is the first hit-marker frame within
  kills.lookbackSec before the detector hit, else the detector hit itself; killcam = kills.killcam detectors;
- scope-in / scope-out: a dark ring (scope.ringInner..ringOuter of the frame height around the centre) with a bright
  centre (scope.centreRadius);
- flick: a burst of sideways camera motion (phase correlation at low resolution);
- jump / slide: vertical camera motion (both directions within vertical.windowSec = jump, one direction = slide);
- third-person: while the camera moves, the lower middle (thirdPerson.bodyZone) stays still relative to the camera
  (the player's own character body).

Each moment: {kind, t, frame, strength (0..1), source, status: "unverified"}. Every game number (zones, thresholds,
colours) is data in data/games/<game>/moments.json (schema data/schemas/moments.schema.json), never in this file.
Off air only, guarded decode (style_analyse.Guard: on-air check, frame, wall-clock and memory caps), BelowNormal, one
job at a time (clip_common.HeavyJobLock, shared with every heavy clip job), CPU only. Detector weights are not used (AGENTS.md: weights are
approved by the user); strength is a plain measure of how clear the signal was. Accuracy on real footage UNVERIFIED.

  load_config(game="codm", path=None)
  find_moments(recording, cfg=None, hits_path=None, live=on_air) -> {"version", "fps", "frames", "moments", ...}
  CLI: moments.py --recording R [--hits H] [--game codm] [--out moments.json]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from clip_common import REPO_ROOT as REPO, ClipError, HeavyJobLock, eprint, load_json, lower_own_priority, on_air, write_json_atomic  # noqa: E402
import style_analyse as sa  # noqa: E402

KINDS = ("gunshot", "hit", "kill", "killcam", "scope-in", "scope-out", "flick", "jump", "slide", "third-person")


def _np():
    import numpy as np  # noqa: PLC0415
    return np


def config_path(game="codm"):
    return os.path.join(REPO, "data", "games", game, "moments.json")


def load_config(game="codm", path=None):
    cfg = load_json(path or config_path(game))
    if cfg.get("status") not in ("unverified", "verified"):
        raise ClipError("moments.json: status must be unverified or verified")
    return cfg


def make_guard(cfg, seconds, live):
    g = cfg["guard"]
    gcfg = {"guard": {"checkEveryFrames": g["checkEveryFrames"], "maxMemMb": g["maxMemMb"],
                      "maxWallSecPerExample": max(60.0, float(g["maxWallSecPerMin"]) * seconds / 60.0)}}
    return sa.Guard(gcfg, live, max_frames=int(g["maxFramesPerSec"] * max(1.0, seconds)) + 60)


def _rect(b, w, h):
    return (int(round(b["y0"] * h)), int(round(b["y1"] * h)), int(round(b["x0"] * w)), int(round(b["x1"] * w)))


def _sub(img, r):
    return img[r[0]:max(r[0] + 1, r[1]), r[2]:max(r[2] + 1, r[3])]


# ---------------------------------------------------------------- picture pass

def frame_pass(path, cfg, guard=None):
    """Per decoded frame, small numbers only: time, weapon-area brightness, hit-marker white share, scope ring and
    centre brightness, camera shift (dx, dy as a share of the width / height), lower-middle and whole-frame change."""
    import cv2  # noqa: PLC0415
    np = _np()
    a = cfg["analysis"]
    W, H, fw, fh = int(a["width"]), int(a["height"]), int(a["flowWidth"]), int(a["flowHeight"])
    wz = _rect(cfg["gunshot"]["weaponZone"], W, H)
    hz = _rect(cfg["hitmarker"]["zone"], W, H)
    bz = _rect(cfg["thirdPerson"]["bodyZone"], W, H)
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.hypot(xx - (W - 1) / 2.0, yy - (H - 1) / 2.0) / H
    sc = cfg["scope"]
    centre = r <= float(sc["centreRadius"])
    ring = (r >= float(sc["ringInner"])) & (r <= float(sc["ringOuter"]))
    white = float(cfg["hitmarker"]["whiteLevel"])
    win = cv2.createHanningWindow((fw, fh), cv2.CV_32F)
    out = {k: [] for k in ("t", "weapon", "hitmark", "ring", "centre", "dx", "dy", "zoneDiff", "fullDiff")}
    prev_s = prev_g = None
    c = sa.safe_open(path)
    try:
        st = next((s for s in c.streams if s.type == "video"), None)
        if st is None:
            raise ClipError(f"{os.path.basename(path)}: no picture")
        st.thread_type = "AUTO"
        st.codec_context.thread_count = 2
        fps = float(st.average_rate or 30)
        n = 0
        for fr in c.decode(st):
            if guard:
                guard.tick()
            g = fr.to_ndarray(format="gray", width=W, height=H).astype(np.float32)
            t = float(fr.time) if fr.time is not None else n / fps
            n += 1
            s = cv2.resize(g, (fw, fh), interpolation=cv2.INTER_AREA)
            hm = _sub(g, hz)
            out["t"].append(t)
            out["weapon"].append(float(_sub(g, wz).mean()))
            out["hitmark"].append(float((hm >= white).mean()))
            out["ring"].append(float(g[ring].mean()) if ring.any() else 255.0)
            out["centre"].append(float(g[centre].mean()))
            if prev_s is None:
                dx = dy = 0.0
                zd = fd = 0.0
            else:
                (sx, sy), _resp = cv2.phaseCorrelate(prev_s, s, win)
                dx, dy = sx / fw, sy / fh
                diff = np.abs(g - prev_g)
                zd, fd = float(_sub(diff, bz).mean()), float(diff.mean())
            out["dx"].append(dx)
            out["dy"].append(dy)
            out["zoneDiff"].append(zd)
            out["fullDiff"].append(fd)
            prev_s, prev_g = s, g
    finally:
        c.close()
    if not out["t"]:
        raise ClipError(f"{os.path.basename(path)}: no frames decoded")
    out["fps"] = fps
    return out


# ---------------------------------------------------------------- sound pass

def audio_transients(path, cfg, guard=None, seconds=None):
    """Band-limited spectral flux, streamed (bounded memory for long recordings) -> [(t, flux)] peaks above
    median + thresholdMad * MAD, at least minGapSec apart. [] when the recording has no sound."""
    import av  # noqa: PLC0415
    np = _np()
    gc = cfg["gunshot"]
    sr, nfft, hop = int(gc["sampleRate"]), int(gc["fft"]), int(gc["hop"])
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    band = (freqs >= float(gc["bandHz"][0])) & (freqs <= float(gc["bandHz"][1]))
    win = np.hanning(nfft).astype(np.float32)
    flux, buf, prev, pos = [], np.zeros(0, np.float32), None, 0
    if guard and seconds:
        guard.limit(int(400 * max(1.0, seconds)) + 100)  # sound frames: the reel style analyser's cap per second
    c = sa.safe_open(path)
    try:
        st = next((s for s in c.streams if s.type == "audio"), None)
        if st is None:
            return []
        rs = av.AudioResampler(format="flt", layout="mono", rate=sr)

        def feed(arr):
            nonlocal buf, prev, pos
            buf = np.concatenate([buf, arr])
            k = (len(buf) - nfft) // hop + 1
            if k <= 0:
                return
            idx = np.arange(nfft)[None, :] + hop * np.arange(k)[:, None]
            lm = np.log1p(100.0 * np.abs(np.fft.rfft(buf[idx] * win[None, :], axis=1))[:, band])
            allm = lm if prev is None else np.vstack([prev, lm])
            d = np.maximum(0.0, np.diff(allm, axis=0)).sum(axis=1)
            flux.extend(([0.0] if prev is None else []) + d.tolist())
            prev = lm[-1:]
            buf = buf[k * hop:]
            pos += k

        for fr in c.decode(st):
            if guard:
                guard.tick()
            for o in rs.resample(fr):
                feed(o.to_ndarray().reshape(-1).astype(np.float32, copy=False))
        for o in rs.resample(None):
            feed(o.to_ndarray().reshape(-1).astype(np.float32, copy=False))
    finally:
        c.close()
    if len(flux) < 3:
        return []
    f = np.asarray(flux)
    med = float(np.median(f))
    mad = float(np.median(np.abs(f - med))) or 1e-6
    thr = med + float(gc["thresholdMad"]) * mad
    gap = max(1, int(round(float(gc["minGapSec"]) * sr / hop)))
    peaks = []
    for i in range(1, len(f) - 1):
        if f[i] > thr and f[i] >= f[i - 1] and f[i] >= f[i + 1]:
            if peaks and i - peaks[-1][0] < gap:
                if f[i] > peaks[-1][1]:
                    peaks[-1] = (i, float(f[i]))
                continue
            peaks.append((i, float(f[i])))
    # frame i holds samples [(i)*hop, i*hop + nfft); a click shows most when it reaches the first half of the window
    return [((i * hop + nfft * 0.5) / sr, v / thr) for i, v in peaks]


# ---------------------------------------------------------------- moments from the numbers

def _m(kind, fp, i, strength, source):
    return {"kind": kind, "t": round(float(fp["t"][i]), 4), "frame": int(i), "strength": round(max(0.0, min(1.0, float(strength))), 3),
            "source": source, "status": "unverified"}


def _frame_at(fp, t):
    ts = fp["t"]
    lo, hi = 0, len(ts) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if ts[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0 and abs(ts[lo - 1] - t) <= abs(ts[lo] - t):
        lo -= 1
    return lo


def flash_rise(fp, cfg):
    np = _np()
    w = np.asarray(fp["weapon"])
    b = int(cfg["gunshot"]["flashBaseFrames"])
    rise = np.zeros(len(w))
    for i in range(1, len(w)):
        rise[i] = w[i] - float(np.median(w[max(0, i - b):i]))
    return rise


def gunshots(fp, trans, cfg):
    gc = cfg["gunshot"]
    rise = flash_rise(fp, cfg)
    k, need = int(gc["confirmFrames"]), float(gc["flashRise"])
    out, used, unconfirmed = [], set(), 0
    for t, v in trans:
        f0 = _frame_at(fp, t)
        cand = [j for j in range(max(0, f0 - k), min(len(rise), f0 + k + 1)) if rise[j] >= need and j not in used]
        if not cand:
            unconfirmed += 1
            continue
        j = min(cand, key=lambda x: (abs(x - f0), x))
        # the flash's first frame: step back while the frame before also rose
        while j - 1 >= 0 and j - 1 not in used and rise[j - 1] >= need and j - 1 >= f0 - k:
            j -= 1
        used.update(range(j, j + 3))
        out.append(_m("gunshot", fp, j, 0.5 * min(1.0, v / 3.0) + 0.5 * min(1.0, rise[j] / (3 * need)), "sound+flash"))
    return out, unconfirmed


def _runs(flags, min_len=1):
    runs, s = [], None
    for i, f in enumerate(list(flags) + [False]):
        if f and s is None:
            s = i
        elif not f and s is not None:
            if i - s >= min_len:
                runs.append((s, i))
            s = None
    return runs


def hits_and_kills(fp, cfg, hits=()):
    hc, kc = cfg["hitmarker"], cfg["kills"]
    hm = [float(hc["minWhiteShare"]) <= v <= float(hc["maxWhiteShare"]) for v in fp["hitmark"]]
    out = []
    marker_starts = [s for s, _e in _runs(hm)]
    for s in marker_starts:
        out.append(_m("hit", fp, s, min(1.0, fp["hitmark"][s] / max(1e-6, 4 * float(hc["minWhiteShare"]))), "hit-marker"))
    kill_hits = sorted((h for h in hits if h.get("detector") in kc["detectors"] and h.get("role") != "negative"), key=lambda h: h["t"])
    clusters = []
    for h in kill_hits:
        if clusters and h["t"] - clusters[-1][-1]["t"] <= float(kc["clusterSec"]):
            clusters[-1].append(h)
        else:
            clusters.append([h])
    look = float(kc["lookbackSec"])
    for cl in clusters:
        t0 = cl[0]["t"]
        f0 = _frame_at(fp, t0)
        prior = [s for s in marker_starts if fp["t"][s] >= t0 - look - 1e-6 and s <= f0]
        dets = sorted({h["detector"] for h in cl})
        if prior:
            out.append(_m("kill", fp, prior[0], min(1.0, 0.5 + 0.1 * len(dets)), "hit-marker+" + "+".join(dets)))
        else:
            out.append(_m("kill", fp, f0, min(1.0, 0.3 + 0.1 * len(dets)), "+".join(dets)))
    seen = None
    for h in sorted((h for h in hits if h.get("detector") in kc["killcam"]), key=lambda h: h["t"]):
        if seen is not None and h["t"] - seen <= float(kc["clusterSec"]):
            continue
        seen = h["t"]
        out.append(_m("killcam", fp, _frame_at(fp, h["t"]), 0.5, h["detector"]))
    return out


def scopes(fp, cfg):
    sc = cfg["scope"]
    on = [rg <= float(sc["ringMaxLuma"]) and ce - rg >= float(sc["minContrast"]) for rg, ce in zip(fp["ring"], fp["centre"])]
    out = []
    for s, e in _runs(on, int(sc["minFrames"])):
        st = min(1.0, (fp["centre"][s] - fp["ring"][s]) / 255.0 * 2)
        out.append(_m("scope-in", fp, s, st, "scope-ring"))
        if e < len(on):
            out.append(_m("scope-out", fp, e, st, "scope-ring"))
    return out


def flicks(fp, cfg):
    fc = cfg["flick"]
    fps = fp["fps"]
    big = [abs(v) >= float(fc["minShiftShare"]) for v in fp["dx"]]
    out, last = [], -1e9
    win = max(1, int(round(float(fc["windowSec"]) * fps)))
    for s, e in _runs(big, int(fc["minFrames"])):
        total = abs(sum(fp["dx"][s:min(e, s + win)]))
        if total < float(fc["minTotalShare"]) or fp["t"][s] - last < float(fc["minGapSec"]):
            continue
        last = fp["t"][s]
        out.append(_m("flick", fp, s, total / (2 * float(fc["minTotalShare"])), "camera-motion"))
    return out


def verticals(fp, cfg):
    vc = cfg["vertical"]
    fps = fp["fps"]
    thr = float(vc["minShiftShare"])
    big = [abs(v) >= thr for v in fp["dy"]]
    win = max(1, int(round(float(vc["windowSec"]) * fps)))
    out, last = [], -1e9
    for s, e in _runs(big, int(vc["minFrames"])):
        if fp["t"][s] - last < float(vc["minGapSec"]):
            continue
        seg = fp["dy"][s:min(len(fp["dy"]), s + win)]
        sign0 = 1 if fp["dy"][s] > 0 else -1
        back = any(v * sign0 <= -thr for v in seg)
        last = fp["t"][s]
        out.append(_m("jump" if back else "slide", fp, s, min(1.0, max(abs(v) for v in seg) / (3 * thr)), "camera-motion"))
    return out


def third_person(fp, cfg):
    tc = cfg["thirdPerson"]
    on = [abs(dx) >= float(tc["minMotionShare"]) and fd > 1e-3 and zd / fd <= float(tc["maxZoneDiffRatio"])
          for dx, zd, fd in zip(fp["dx"], fp["zoneDiff"], fp["fullDiff"])]
    out = []
    for s, e in _runs(on, int(tc["minFrames"])):
        ratio = sum(fp["zoneDiff"][s:e]) / max(1e-6, sum(fp["fullDiff"][s:e]))
        m = _m("third-person", fp, s, 1.0 - ratio / float(tc["maxZoneDiffRatio"]), "body-still")
        m["tEnd"] = round(float(fp["t"][e - 1]), 4)
        out.append(m)
    return out


# ---------------------------------------------------------------- the job

def find_moments(recording, cfg=None, hits_path=None, live=on_air, guard=None):
    import reel_style as rs  # noqa: PLC0415 - the local-file rule (no links, local fixed drive)
    cfg = cfg or load_config()
    if live is not None and live() is not False:
        raise ClipError("the studio is live or recording (or that cannot be told): moments are found off air only")
    bad = rs.local_file_problem(recording)
    if bad:
        raise ClipError(bad)
    seconds = probe_seconds(recording)
    if seconds > float(cfg["guard"]["maxSec"]):
        raise ClipError(f"{os.path.basename(recording)}: longer than {cfg['guard']['maxSec']:g} s")
    guard = guard or make_guard(cfg, seconds, live)
    t0 = time.perf_counter()
    fp = frame_pass(recording, cfg, guard)
    trans = audio_transients(recording, cfg, guard, seconds)
    hits = []
    if hits_path:
        import clip_signals  # noqa: PLC0415
        hits, _info = clip_signals.read_hits(hits_path, seconds + 1.0)
    shots, unconfirmed = gunshots(fp, trans, cfg)
    ms = shots + hits_and_kills(fp, cfg, hits) + scopes(fp, cfg) + flicks(fp, cfg) + verticals(fp, cfg) + third_person(fp, cfg)
    ms.sort(key=lambda m: (m["frame"], KINDS.index(m["kind"])))
    counts = {k: sum(1 for m in ms if m["kind"] == k) for k in KINDS}
    return {"version": 1, "game": cfg["game"], "configVersion": cfg["version"], "status": "unverified",
            "fps": round(fp["fps"], 4), "frames": len(fp["t"]), "seconds": round(seconds, 3), "moments": ms, "counts": counts,
            "soundTransients": len(trans), "unconfirmedTransients": unconfirmed, "analyseSec": round(time.perf_counter() - t0, 2)}


def probe_seconds(path):
    import av  # noqa: PLC0415
    try:
        with sa.safe_open(path) as c:
            st = next((x for x in c.streams if x.type == "video"), None)
            if st is None:
                raise ClipError(f"{os.path.basename(path)}: no picture")
            sec = c.duration / 1e6 if c.duration else (float(st.duration * st.time_base) if st.duration else None)
    except av.error.FFmpegError as e:
        raise ClipError(f"{os.path.basename(path)}: not a video this PC can read") from e
    if sec is None or not math.isfinite(sec):
        raise ClipError(f"{os.path.basename(path)}: its length cannot be read")
    return sec


def main(argv=None):
    ap = argparse.ArgumentParser(description="BD1 moment finder (off air only)")
    ap.add_argument("--recording", required=True)
    ap.add_argument("--hits", help="detector hits jsonl from detector_pass.py")
    ap.add_argument("--game", default="codm")
    ap.add_argument("--out", help="write the moments here (JSON); else print")
    a = ap.parse_args(argv)
    lower_own_priority()
    try:
        cfg = load_config(a.game)
        with HeavyJobLock(job="moments"):  # Codex review: one heavy clip job at a time, whatever the output folder
            r = find_moments(a.recording, cfg, a.hits)
        if a.out:
            write_json_atomic(a.out, r)
            print(json.dumps({"ok": True, "counts": r["counts"], "out": a.out}))
        else:
            print(json.dumps(r))
        return 0
    except ClipError as e:
        eprint(f"moments: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
