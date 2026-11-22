# SPDX-License-Identifier: GPL-3.0-or-later
"""Line up replay passes with each other and with the original match (BD6 alignment engine, D431).

A replay pass is a capture-card recording of the game's own replay viewer: first or third person, HUD on or clean,
played at 1x or 0.5x, possibly paused by the user. Every pass shows the same match, so its game audio repeats the
same events. This module finds where each pass sits on one shared timeline, so a shot can be cut out of any pass
at a given match time.

Timelines:
  pass time    seconds into the pass recording (what a cut uses).
  replay time  seconds on the reference pass's timeline at 1x (the reference is the first pass given, or the
               full-match recording when one exists). One second of replay time is one second of match.
  match time   replay time + a constant, read from the HUD clock by OCR when a pass shows it
               (regions are game data in data/games/<id>/replay-align.json, never engine code).

Method (audio first, OCR as a second check):
  1. Game audio is decoded with PyAV to mono 16 kHz. A short-time spectrum (1024-sample window, 10 ms hop) is
     pooled into 40 log-spaced bands; the onset envelope is the sum over bands of the positive change in
     log energy, at 100 frames per second. Onsets (shots, steps, hits) survive a change of camera, HUD and
     mixing, where the raw waveform does not.
  2. For a pass played at rate r (0.5 = half speed), its envelope is resampled onto replay time
     (replay = pass * r). Unless a rate is given, 1.0 and 0.5 are both tried and the better one kept.
  3. Normalised cross-correlation (FFT) gives candidate lags; each is re-scored as the Pearson r of the two
     envelopes over their overlap (at least MIN_OVERLAP_SEC). The best r is the confidence; the margin is how
     far it stands above the best lag more than 0.5 s away.
  4. A pair counts as aligned when r >= MIN_CONFIDENCE and margin >= MIN_MARGIN (set from the real fixtures and
     a null pair, D431).
  5. Pauses: every silent (or, with --frozen, frozen-picture) stretch of at least MIN_PAUSE_SEC is tried as a
     pause, and kept only when laying the pass out with the replay standing still there fits the reference
     clearly better (segment_pass). Seeks are not modelled.

Usage (run isolated, project venv):
  python -I services/clip/replay_align.py --ref REF.mkv PASS.mkv [PASS.mkv ...] [--rate auto|1|0.5]
      [--game codm] [--ocr] [--out map.json]
Prints one JSON object: per pass, its segments and the pair confidence. Nothing is written beside the inputs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

try:
    import numpy as np
except ImportError:  # the system python has no numpy; tests skip, the engine needs the project venv
    np = None

SR = 16000
HOP = 160                  # 10 ms: 100 envelope frames per second
FPS = SR / HOP
NFFT = 1024
BANDS = 40
MIN_OVERLAP_SEC = 5.0
MIN_CONFIDENCE = 0.2       # pair Pearson r below this: not aligned (real passes 0.24-0.60)
MIN_MARGIN = 0.05          # best r must beat the best placement more than MARGIN_SEC away by this much
MARGIN_SEC = 0.5
SWITCH_MARGIN = 0.1        # a pause must raise the whole pass's score by this much to be accepted
MIN_PAUSE_SEC = 0.5
RATES = (1.0, 0.5)
VERSION = 1

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))


# ---------------------------------------------------------------- audio

def decode_audio(path: str, sr: int = SR):
    """First audio stream of `path` -> mono float32 at `sr`, sample 0 = start of the file's timeline."""
    import av
    out = []
    with av.open(path) as box:
        stream = next(s for s in box.streams if s.type == "audio")
        res = av.AudioResampler(format="flt", layout="mono", rate=sr)
        start = None
        for frame in box.decode(stream):
            if start is None and frame.time is not None:
                start = max(0.0, float(frame.time))
                if start > 0:
                    out.append(np.zeros(int(round(start * sr)), np.float32))
            for f in res.resample(frame):
                out.append(f.to_ndarray().reshape(-1))
        for f in res.resample(None):
            out.append(f.to_ndarray().reshape(-1))
    return np.concatenate(out).astype(np.float32) if out else np.zeros(0, np.float32)


def _band_matrix(sr: int = SR, nfft: int = NFFT, bands: int = BANDS):
    edges = np.geomspace(80.0, min(7600.0, sr / 2 - 1), bands + 1)
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    m = np.zeros((bands, freqs.size), np.float32)
    for b in range(bands):
        sel = (freqs >= edges[b]) & (freqs < edges[b + 1])
        if not sel.any():  # narrow low bands: take the nearest bin
            sel = np.zeros(freqs.size, bool)
            sel[int(np.argmin(np.abs(freqs - (edges[b] + edges[b + 1]) / 2)))] = True
        m[b, sel] = 1.0
    return m


def frame_energy(x):
    """Per-frame RMS level in dBFS at FPS (for silence detection)."""
    n = len(x) // HOP
    if n == 0:
        return np.zeros(0)
    fr = x[: n * HOP].reshape(n, HOP).astype(np.float64)
    return 10 * np.log10(np.mean(fr * fr, axis=1) + 1e-12)


def onset_envelope(x):
    """Mono samples at SR -> onset envelope at FPS (float64, zero mean, unit variance where not flat)."""
    if len(x) < NFFT:
        return np.zeros(max(0, len(x) // HOP))
    pad = np.concatenate([np.zeros(NFFT // 2, np.float32), x, np.zeros(NFFT // 2, np.float32)])
    n = 1 + (len(pad) - NFFT) // HOP
    idx = np.arange(NFFT)[None, :] + HOP * np.arange(n)[:, None]
    win = np.hanning(NFFT).astype(np.float32)
    spec = np.abs(np.fft.rfft(pad[idx] * win, axis=1)) ** 2
    logb = np.log1p(1e4 * (spec @ _band_matrix().T))
    d = np.diff(logb, axis=0, prepend=logb[:1])
    env = np.maximum(d, 0).sum(axis=1)
    return _norm(env)


def _norm(v):
    v = np.asarray(v, np.float64)
    v = v - v.mean() if v.size else v
    s = v.std() if v.size else 0.0
    return v / s if s > 1e-12 else v


def retime(env, rate: float):
    """Envelope sampled on pass time -> sampled on replay time, for a pass played at `rate` (replay = pass*rate)."""
    if abs(rate - 1.0) < 1e-9:
        return env
    n_out = int(len(env) * rate)
    t_pass = np.arange(n_out) / rate  # pass frame for each replay frame
    # a slowed pass spreads one onset over 1/rate frames; pool with a max so it is not averaged away
    k = max(1, int(round(1 / rate)))
    if k > 1:
        padded = np.concatenate([env, np.full(k - 1, env.min() if env.size else 0)])
        env = np.max(np.stack([padded[i:i + len(env)] for i in range(k)]), axis=0)
    return np.interp(t_pass, np.arange(len(env)), env)


# ---------------------------------------------------------------- correlation

def _pearson(a, b):
    if len(a) < 2:
        return 0.0
    a = a - a.mean()
    b = b - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 1e-12 else 0.0


def _significance(r: float, n: int) -> float:
    """Fisher z times the square root of the frames compared."""
    return float(np.arctanh(np.clip(r, -0.999, 0.999)) * np.sqrt(max(n, 1)))


def _overlap(ref, x, lag):
    """Overlap of ref and x placed so x[0] sits at ref[lag]."""
    r0 = max(0, lag)
    x0 = max(0, -lag)
    n = min(len(ref) - r0, len(x) - x0)
    if n <= 0:
        return None, None
    return ref[r0:r0 + n], x[x0:x0 + n]


def xcorr_offset(ref, x, min_overlap: float = MIN_OVERLAP_SEC, lag_range=None, top: int = 8):
    """Best placement of envelope x on envelope ref (both at FPS, same time scale).

    Returns dict(offset = seconds of ref at x's start, r = Pearson over the overlap, margin = r minus the best r
    more than MARGIN_SEC away, overlap = seconds compared), or None if nothing overlaps enough."""
    n = len(ref) + len(x)
    size = 1 << (n - 1).bit_length()
    cc = np.fft.irfft(np.fft.rfft(ref, size) * np.conj(np.fft.rfft(x, size)), size)
    lags = np.arange(-(len(x) - 1), len(ref))
    vals = np.concatenate([cc[size - (len(x) - 1):], cc[:len(ref)]]) if len(x) > 1 else cc[:len(ref)]
    ov = np.minimum(len(ref), lags + len(x)) - np.maximum(0, lags)
    need = int(min(min_overlap * FPS, min(len(ref), len(x))))
    ok = ov >= max(need, 2)
    if lag_range is not None:
        ok &= (lags >= lag_range[0]) & (lags <= lag_range[1])
    if not ok.any():
        return None
    score = np.where(ok, vals / np.maximum(ov, 1) * np.sqrt(np.maximum(ov, 1)), -np.inf)
    order = np.argsort(score)[::-1]
    cands = []
    for i in order:
        if not np.isfinite(score[i]) or len(cands) >= top:
            break
        if all(abs(lags[i] - c) > MARGIN_SEC * FPS for c in cands):
            cands.append(int(lags[i]))
    scored = []
    for lag in cands:
        a, b = _overlap(ref, x, lag)
        rr = _pearson(a, b)
        scored.append((_significance(rr, len(a)), rr, lag, len(a)))
    scored.sort(reverse=True)  # by significance, so a short chance overlap cannot beat a long true one
    scored = [s[1:] for s in scored]
    r, lag, nov = scored[0]
    other = max([s[0] for s in scored[1:] if abs(s[1] - lag) > MARGIN_SEC * FPS] or [0.0])
    # sub-frame refinement: parabola through the Pearson r at lag-1, lag, lag+1
    fine = 0.0
    rs = []
    for d in (-1, 0, 1):
        a, b = _overlap(ref, x, lag + d)
        rs.append(_pearson(a, b) if a is not None and len(a) >= 2 else r)
    den = rs[0] - 2 * rs[1] + rs[2]
    if den < -1e-12:
        fine = float(np.clip(0.5 * (rs[0] - rs[2]) / den, -0.5, 0.5))
    return {"offset": (lag + fine) / FPS, "r": round(r, 4), "margin": round(r - other, 4),
            "overlap": round(nov / FPS, 2)}


def align_pair(ref_env, pass_env, rate="auto", min_overlap: float = MIN_OVERLAP_SEC):
    """Global alignment of a pass onto the reference. rate: 'auto' (search RATES) or a number.

    Returns dict(rate, offset = replay time at pass time 0, r, margin, overlap) or None."""
    rates = RATES if rate in (None, "auto") else (float(rate),)
    best = None
    for rt in rates:
        res = xcorr_offset(ref_env, retime(pass_env, rt), min_overlap=min_overlap)
        if res is None:
            continue
        res["rate"] = rt
        res["_z"] = _significance(res["r"], int(res["overlap"] * FPS))
        if best is None or res["_z"] > best["_z"]:
            best = res
    if best is not None:
        best.pop("_z")
    return best


# ---------------------------------------------------------------- pass map (piecewise)

def _quiet_runs(level_db, frozen=None, min_sec: float = 0.3, floor_db: float = -50.0):
    """Runs of frames that are silent (below floor_db) or frozen -> [(start_s, end_s)]."""
    q = level_db < floor_db
    if frozen is not None and len(frozen):
        m = min(len(q), len(frozen))
        q = q[:m] | frozen[:m]
    runs, start = [], None
    for i, v in enumerate(list(q) + [False]):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if (i - start) / FPS >= min_sec:
                runs.append((start / FPS, i / FPS))
            start = None
    return runs


def _placed_score(ref_env, pass_env, rate, bounds, ks):
    """Frame-weighted Pearson r of the pass laid on the reference piece by piece: piece j covers pass seconds
    bounds[j] (start, end) and sits at offset ks[j] (replay = k + pass * rate). -> (score, per-piece r)."""
    tot, num, rs = 0, 0.0, []
    for (p0, p1), k in zip(bounds, ks):
        i0, i1 = int(p0 * FPS), int(p1 * FPS)
        if i1 - i0 < 2:
            rs.append(0.0)
            continue
        xp = retime(pass_env[i0:i1], rate)
        a, b = _overlap(ref_env, xp, int(round((k + p0 * rate) * FPS)))
        r = _pearson(a, b) if a is not None and len(a) >= 0.5 * len(xp) else 0.0
        rs.append(r)
        tot += len(xp)
        num += r * len(xp)
    return (num / tot if tot else 0.0), rs


def segment_pass(ref_env, pass_env, rate: float, level_db=None, frozen=None, start_k=0.0,
                 min_pause: float = MIN_PAUSE_SEC):
    """Pause finding -> segments [{pass_t0, pass_t1, replay_t0, rate, r}] and the gaps between them.

    replay time inside a segment = replay_t0 + (pass_t - pass_t0) * rate. Every silent or frozen stretch of at
    least min_pause seconds is a candidate pause: the replay stood still while the pass ran on, so the pass after
    it sits (length * rate) earlier on the reference than before it. The pause is accepted only when laying the
    pass out that way (shifting the part after it, or the part before it when the global offset locked onto the
    later part) raises the whole pass's score by SWITCH_MARGIN. Windowed searches were tried first and rejected:
    real game audio repeats (gunfire, steps), so short windows find chance matches elsewhere (evidence, D431).
    Seeks (the user jumping back or forward) are not modelled."""
    end = len(pass_env) / FPS
    runs = [q for q in (_quiet_runs(level_db, frozen, min_sec=min_pause) if level_db is not None else [])
            if q[0] > 0.5 and q[1] < end - 0.5]
    bounds, prev = [], 0.0
    for q in runs:
        bounds.append((prev, q[0]))
        prev = q[1]
    bounds.append((prev, end))
    ks = [start_k] * len(bounds)
    accepted = [False] * len(runs)
    score, _ = _placed_score(ref_env, pass_env, rate, bounds, ks)
    for i, q in enumerate(runs):
        shift = (q[1] - q[0]) * rate
        best = None
        for opt in ([k - shift if j > i else k for j, k in enumerate(ks)],
                    [k + shift if j <= i else k for j, k in enumerate(ks)]):
            s, _ = _placed_score(ref_env, pass_env, rate, bounds, opt)
            if s >= score + SWITCH_MARGIN and (best is None or s > best[0]):
                best = (s, opt)
        if best:
            score, ks = best
            accepted[i] = True
    # pieces split by a rejected quiet run join up again (the replay kept running through it)
    out, gaps = [], []
    _, rs = _placed_score(ref_env, pass_env, rate, bounds, ks)
    cur = {"pass_t0": bounds[0][0], "pass_t1": bounds[0][1], "k": ks[0], "rs": [rs[0]]}
    for i, q in enumerate(runs):
        nxt = bounds[i + 1]
        if accepted[i]:
            out.append(cur)
            gaps.append({"pass_t0": round(q[0], 3), "pass_t1": round(q[1], 3), "found_by": "quiet"})
            cur = {"pass_t0": nxt[0], "pass_t1": nxt[1], "k": ks[i + 1], "rs": [rs[i + 1]]}
        else:
            cur["pass_t1"] = nxt[1]
            cur["rs"].append(rs[i + 1])
    out.append(cur)
    segs = []
    for g in out:
        segs.append({"pass_t0": round(g["pass_t0"], 3), "pass_t1": round(g["pass_t1"], 3),
                     "replay_t0": round(g["k"] + g["pass_t0"] * rate, 4), "rate": rate,
                     "r": round(float(np.mean(g["rs"])), 4)})
    return segs, gaps

class PassMap:
    """pass time <-> replay time <-> match time for one pass. match = replay * match_slope + match_offset."""

    def __init__(self, segments, match_offset=None, match_slope: float = 1.0):
        self.segments = sorted(segments, key=lambda s: s["pass_t0"])
        self.match_offset = match_offset
        self.match_slope = match_slope

    def pass_to_replay(self, t: float):
        for s in self.segments:
            if s["pass_t0"] <= t <= s["pass_t1"]:
                return s["replay_t0"] + (t - s["pass_t0"]) * s["rate"]
        return None  # inside a pause or outside the pass

    def replay_to_pass(self, t: float):
        """First pass time showing replay time t, or None when the pass never shows it."""
        for s in self.segments:
            p = s["pass_t0"] + (t - s["replay_t0"]) / s["rate"]
            if s["pass_t0"] - 1e-9 <= p <= s["pass_t1"] + 1e-9:
                return p
        return None

    def replay_to_match(self, t: float):
        return None if self.match_offset is None else t * self.match_slope + self.match_offset

    def match_to_replay(self, m: float):
        return None if self.match_offset is None else (m - self.match_offset) / self.match_slope

    def match_to_pass(self, m: float):
        r = self.match_to_replay(m)
        return None if r is None else self.replay_to_pass(r)

    def to_json(self):
        return {"segments": self.segments, "match_offset": self.match_offset, "match_slope": self.match_slope}


# ---------------------------------------------------------------- frames: frozen detection and HUD clock OCR

def frozen_frames(path: str, step: int = 2, thr: float = 0.6):
    """Per envelope frame (FPS): True where the picture stands still (mean abs diff of a 64x36 grey copy < thr)."""
    import av
    marks = []
    prev = None
    with av.open(path) as box:
        vs = box.streams.video[0]
        vs.thread_type = "AUTO"
        vs.codec_context.thread_count = 4
        for i, fr in enumerate(box.decode(vs)):
            if i % step or fr.time is None:
                continue
            g = fr.reformat(width=64, height=36, format="gray").to_ndarray().astype(np.float32)
            if prev is not None:
                marks.append((float(fr.time), float(np.mean(np.abs(g - prev))) < thr))
            prev = g
    if not marks:
        return np.zeros(0, bool)
    n = int(marks[-1][0] * FPS) + 1
    out = np.zeros(n, bool)
    times = np.array([m[0] for m in marks])
    vals = np.array([m[1] for m in marks])
    idx = np.searchsorted(times, np.arange(n) / FPS).clip(0, len(vals) - 1)
    out[:] = vals[idx]
    return out


def load_clock_regions(game: str):
    path = os.path.join(_ROOT, "data", "games", game, "replay-align.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("clocks", [])


def parse_clock(text: str, pattern: str):
    m = re.search(pattern, text.replace(" ", ""))
    if not m:
        return None
    mm, ss = int(m.group("m")), int(m.group("s"))
    return mm * 60 + ss if ss < 60 else None


def read_clocks(path: str, regions, times):
    """OCR each clock region at each pass time -> {region id: [(pass_t, seconds shown)]}."""
    import av
    sys.path.insert(0, _HERE)
    import g1_scan
    out = {r["id"]: [] for r in regions}
    with av.open(path) as box:
        vs = box.streams.video[0]
        for t in times:
            box.seek(int(t / vs.time_base), stream=vs, backward=True)
            frame = None
            for fr in box.decode(vs):
                if fr.time is not None and fr.time >= t - 1e-3:
                    frame = fr
                    break
            if frame is None:
                continue
            img = frame.to_ndarray(format="bgr24")
            h, w = img.shape[:2]
            for r in regions:
                b = r["box"]
                crop = img[int(b["y0"] * h):int(b["y1"] * h), int(b["x0"] * w):int(b["x1"] * w)]
                if crop.size == 0:
                    continue
                boxes, _ = g1_scan.ocr(np.ascontiguousarray(crop))
                text = " ".join(x["text"] for x in sorted(boxes, key=lambda x: x["x0"]))
                v = parse_clock(text, r["pattern"])
                if v is not None:
                    out[r["id"]].append((float(frame.time), v))
    return out


def fit_clock(readings, pmap: PassMap, slope: float):
    """Clock readings (pass_t, shown s) -> offset so that shown = replay * slope + offset (1 s clock resolution:
    the median of shown - slope*replay, plus 0.5 s for a clock that floors). None with fewer than 3 readings."""
    vals = []
    for t, shown in readings:
        rp = pmap.pass_to_replay(t)
        if rp is not None:
            vals.append(shown - slope * rp)
    if len(vals) < 3:
        return None
    med = float(np.median(vals))
    agree = sum(1 for v in vals if abs(v - med) <= 1.5)
    return {"offset": round(med + 0.5 * slope, 3), "readings": len(vals), "agree": agree}


# ---------------------------------------------------------------- top level

def analyse(path: str):
    x = decode_audio(path)
    return {"env": onset_envelope(x), "level": frame_energy(x), "duration": len(x) / SR}


def build_map(ref, item, rate="auto", frozen=None):
    """ref, item: analyse() results. -> (PassMap, global pair result)."""
    glob = align_pair(ref["env"], item["env"], rate=rate)
    if glob is None:
        return None, None
    segs, gaps = segment_pass(ref["env"], item["env"], glob["rate"], level_db=item["level"], frozen=frozen,
                              start_k=glob["offset"])
    glob["gaps"] = gaps
    glob["aligned"] = glob["r"] >= MIN_CONFIDENCE and glob["margin"] >= MIN_MARGIN
    return PassMap(segs), glob


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--ref", required=True)
    ap.add_argument("passes", nargs="+")
    ap.add_argument("--rate", default="auto")
    ap.add_argument("--game", default="codm")
    ap.add_argument("--ocr", action="store_true", help="read the HUD clocks as a second check")
    ap.add_argument("--frozen", action="store_true", help="also find frozen frames to place pause breaks")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    ref = analyse(a.ref)
    regions = load_clock_regions(a.game) if a.ocr else []
    result = {"version": VERSION, "ref": os.path.basename(a.ref), "passes": []}
    for p in [a.ref] + a.passes:
        if p == a.ref:  # the reference defines replay time: identity map; its clocks give the match offset
            item = ref
            pmap = PassMap([{"pass_t0": 0.0, "pass_t1": round(ref["duration"], 3), "replay_t0": 0.0, "rate": 1.0,
                             "r": 1.0}])
            glob = {"reference": True}
        else:
            item = analyse(p)
            frozen = frozen_frames(p) if a.frozen else None
            pmap, glob = build_map(ref, item, rate=a.rate, frozen=frozen)
        entry = {"pass": os.path.basename(p), "duration": round(item["duration"], 2), "pair": glob,
                 "map": pmap.to_json() if pmap else None}
        if pmap and regions:
            ts = list(np.arange(1.0, item["duration"] - 1.0, max(2.0, item["duration"] / 12)))
            reads = read_clocks(p, regions, ts)
            entry["clocks"] = {}
            for r in regions:
                entry["clocks"][r["id"]] = {"raw": reads[r["id"]],
                                            "fit": fit_clock(reads[r["id"]], pmap, r.get("slope", 1.0))}
        result["passes"].append(entry)
    text = json.dumps(result, indent=1)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
