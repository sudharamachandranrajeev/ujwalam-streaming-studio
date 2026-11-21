# SPDX-License-Identifier: GPL-3.0-or-later
"""BD2 song map (plan docs/plan/2026-11-21-beatdrop-montages.md section 5 BD2, D414). For one track:

- beat grid: the tempo from music_library (onset envelope + autocorrelation), then a weighted least-squares fit of the
  beat period and phase to the onset times (each onset timed to the sample on its rising edge), so the grid holds over
  the whole track instead of drifting by an envelope frame;
- downbeats: of the beatsPerBar phases, the one whose beats carry the most low-band (kick) energy;
- sections: bar energy split into loud and quiet runs (between the lowPercentile and highPercentile bar levels); loud
  runs are drops, a quiet run at the start is the intro, at the end the outro, between drops a breakdown; the rising
  bars at the end of a quiet run before a drop are the build;
- drops: the first downbeat of each loud run;
- transients: the strongest onsets (a gunshot can land on them), with whether each is on a beat.

Numbers only (schema data/schemas/song-map.schema.json); settings in data/clip/song-map.json. Off air only, guarded
decode (style_analyse.Guard), CPU. Checked on synthetic tracks only; real tracks UNVERIFIED.

  load_config(path=None)
  song_map(path, cfg=None, root=None, live=on_air, guard=None) -> dict
  CLI: song_map.py --track T [--root FOLDER] [--out map.json]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from clip_common import CLIP_DATA, ClipError, eprint, load_json, lower_own_priority, on_air, write_json_atomic  # noqa: E402
import music_library as ml  # noqa: E402

CONFIG_FILE = os.path.join(CLIP_DATA, "song-map.json")
SECTION_KINDS = ("intro", "build", "drop", "breakdown", "outro")


def _np():
    import numpy as np  # noqa: PLC0415
    return np


def load_config(path=None):
    return load_json(path or CONFIG_FILE)


def envelope(mono, sr, fft, hop, low_hz):
    """-> (onset flux per frame, low-band energy per frame); batched, bounded memory."""
    np = _np()
    n = 1 + (len(mono) - fft) // hop
    if n < 8:
        raise ClipError("track too short to map")
    win = np.hanning(fft).astype(np.float32)
    freqs = np.fft.rfftfreq(fft, 1.0 / sr)
    lowb = freqs <= float(low_hz)
    flux, low = np.zeros(n), np.zeros(n)
    prev = None
    for f0 in range(0, n, 256):
        f1 = min(n, f0 + 256)
        idx = np.arange(fft)[None, :] + hop * np.arange(f0, f1)[:, None]
        mag = np.abs(np.fft.rfft(mono[idx] * win[None, :], axis=1))
        low[f0:f1] = (mag[:, lowb] ** 2).sum(axis=1)
        lm = np.log1p(10.0 * mag)
        allm = lm if prev is None else np.vstack([prev, lm])
        d = np.maximum(0.0, np.diff(allm, axis=0)).sum(axis=1)
        flux[f0 + (1 if prev is None else 0):f1] = d
        prev = lm[-1:]
    return flux, low


def _peaks(env):
    np = _np()
    thr = float(np.median(env) + 1.0 * np.std(env))
    i = np.arange(1, len(env) - 1)
    ok = (env[i] > thr) & (env[i] >= env[i - 1]) & (env[i] > env[i + 1])
    return i[ok]


def refine(mono, sr, frame, fft, hop, cfg):
    """The onset's sample time: the first point on the rising edge of the smoothed level that reaches `share` of the
    way from the quiet before it to its peak, searched over the frame's samples."""
    np = _np()
    rc = cfg["onsetRefine"]
    n, h = int(rc["fft"]), int(rc["hop"])
    s0, s1 = max(0, frame * hop - fft), min(len(mono), frame * hop + fft)  # a window back: the flux peaks late
    if s1 - s0 < 2 * n:
        return (frame * hop + fft / 2) / sr
    x = mono[s0:s1]
    k = 1 + (len(x) - n) // h
    idx = np.arange(n)[None, :] + h * np.arange(k)[:, None]
    lm = np.log1p(10.0 * np.abs(np.fft.rfft(x[idx] * np.hanning(n)[None, :], axis=1)))
    d = np.maximum(0.0, np.diff(lm, axis=0)).sum(axis=1)  # d[j]: frame j+1 against frame j
    j = int(np.argmax(d)) + 1
    return (s0 + j * h + n * float(rc["share"])) / sr


def first_of_groups(times, weights, gap):
    """Onsets closer than `gap` are one sound (a bass note ringing under a kick makes several low-band peaks): the
    first time, with the group's strongest weight."""
    out_t, out_w = [], []
    for t, w in sorted(zip(times, weights)):
        if out_t and t - out_t[-1] < gap:
            out_w[-1] = max(out_w[-1], w)
            continue
        out_t.append(t)
        out_w.append(w)
    return out_t, out_w


def fit_grid(times, weights, bpm, offset, cfg):
    """Weighted least squares t = phase + k * period over the onsets near the grid. -> (period, phase, rms_ms, inliers)."""
    np = _np()
    fc = cfg["fit"]
    t, w = np.asarray(times, float), np.asarray(weights, float)
    if len(t):
        keep = w >= np.percentile(w, float(fc["peakPercentile"]))
        t, w = t[keep], w[keep]
    period, phase = 60.0 / float(bpm), float(offset)
    rms, inl = None, 0
    if len(t):  # start from whichever of the phase and the phase half a beat on holds more onsets
        def near(ph):
            r = t - (ph + np.round((t - ph) / period) * period)
            return float(w[np.abs(r) < float(fc["tolerance"]) * period].sum())
        if near(phase + period / 2) > near(phase):
            phase += period / 2
    for _ in range(int(fc["rounds"])):
        k = np.round((t - phase) / period)
        r = t - (phase + k * period)
        ok = np.abs(r) < float(fc["tolerance"]) * period
        if ok.sum() < int(fc["minInliers"]):
            break
        A = np.stack([np.ones(ok.sum()), k[ok]], axis=1) * np.sqrt(w[ok])[:, None]
        sol, *_ = np.linalg.lstsq(A, t[ok] * np.sqrt(w[ok]), rcond=None)
        phase, period = float(sol[0]), float(sol[1])
        k = np.round((t - phase) / period)
        r = t - (phase + k * period)
        ok = np.abs(r) < float(fc["tolerance"]) * period
        rms, inl = float(np.sqrt(np.mean(r[ok] ** 2)) * 1000.0) if ok.any() else None, int(ok.sum())
    return period, phase % period, rms, inl


def sections(bar_db, bar_t, dur, cfg):
    """[(kind, start, end, energyDb)] from the bars' energy."""
    np = _np()
    sc = cfg["sections"]
    if not bar_db:
        return [("intro", 0.0, dur, None)]
    lo, hi = np.percentile(bar_db, float(sc["lowPercentile"])), np.percentile(bar_db, float(sc["highPercentile"]))
    thr = 0.5 * (lo + hi)
    loud = [v > thr for v in bar_db]
    runs = []  # [loud, first bar, last bar + 1]
    for i, v in enumerate(loud):
        if runs and runs[-1][0] == v:
            runs[-1][2] = i + 1
        else:
            runs.append([v, i, i + 1])
    m = int(sc["minBars"])
    changed = True
    while changed and len(runs) > 1:  # a run shorter than minBars joins its neighbour
        changed = False
        for j, r in enumerate(runs):
            if r[2] - r[1] < m:
                if j > 0:
                    runs[j - 1][2] = r[2]
                else:
                    runs[1][1] = r[1]
                runs.pop(j)
                k = 1
                while k < len(runs):  # neighbours now alike: merge
                    if runs[k][0] == runs[k - 1][0]:
                        runs[k - 1][2] = runs[k][2]
                        runs.pop(k)
                    else:
                        k += 1
                changed = True
                break
    out = []
    first_loud = next((j for j, r in enumerate(runs) if r[0]), None)
    last_loud = max((j for j, r in enumerate(runs) if r[0]), default=None)
    for j, (is_loud, b0, b1) in enumerate(runs):
        if is_loud:
            out.append(["drop", b0, b1])
            continue
        kind = "intro" if first_loud is None or j < first_loud else "outro" if j > last_loud else "breakdown"
        nxt_loud = j + 1 < len(runs) and runs[j + 1][0]
        nb = 0
        if nxt_loud:
            k = b1 - 1
            while k > b0 and bar_db[k] - bar_db[k - 1] >= float(sc["buildRiseDbPerBar"]) and nb < int(sc["buildMaxBars"]):
                nb += 1
                k -= 1
            if nb < int(sc["buildMinBars"]):
                nb = 0
        if b1 - nb > b0:
            out.append([kind, b0, b1 - nb])
        if nb:
            out.append(["build", b1 - nb, b1])
    res = []
    for i, (kind, b0, b1) in enumerate(out):
        start = 0.0 if i == 0 else bar_t[b0]
        end = dur if i == len(out) - 1 else bar_t[b1]
        res.append((kind, round(start, 3), round(end, 3), round(float(np.mean(bar_db[b0:b1])), 2)))
    return res


def song_map(path, cfg=None, root=None, live=on_air, guard=None, open_kw=None):
    np = _np()
    cfg = cfg or load_config()
    if live is not None and live() is not False:
        raise ClipError("the studio is live or recording (or that cannot be told): songs are mapped off air only")
    if root is not None:
        ml._open_checked(path, root)  # noqa: SLF001 - same folder rule as the music library
    mcfg = ml.load_config()
    sr = ml.SR
    mono = ml.decode(path, sr, 1, max_sec=float(cfg["maxAnalyseSec"]), open_kw=open_kw, guard=guard)[:, 0]
    dur = len(mono) / sr
    if dur < float(mcfg["minTrackSec"]):
        raise ClipError(f"{os.path.basename(path)}: shorter than {mcfg['minTrackSec']:g} s")
    env0, rate0, _c = ml._onsets(mono, sr)  # noqa: SLF001 - the library's tempo, then our own fit
    bpm0, off0 = ml.tempo(env0, rate0, mcfg)
    fft, hop = int(cfg["fft"]), int(cfg["hop"])
    flux, low = envelope(mono, sr, fft, hop, cfg["lowBandHz"])
    pk = _peaks(flux)
    times = [refine(mono, sr, int(i), fft, hop, cfg) for i in pk]
    strength = [float(flux[i]) for i in pk]
    # the grid is fitted to the low-band (kick) onsets: bright off-beat hits (hats) would pull it half a beat off
    lflux = np.concatenate([[0.0], np.maximum(0.0, np.diff(np.log1p(low / (float(np.median(low)) + 1e-12))))])
    lpk = _peaks(lflux)
    ltimes, lw = first_of_groups([refine(mono, sr, int(i), fft, hop, cfg) for i in lpk], [float(lflux[i]) for i in lpk],
                                 float(cfg["fit"]["groupSec"]))
    period, phase, rms, inl = fit_grid(ltimes, lw, bpm0, off0, cfg)
    if rms is None:  # no clear kick: fit to every onset
        period, phase, rms, inl = fit_grid(times, strength, bpm0, off0, cfg)
    frame_t = (np.arange(len(low)) * hop + fft / 2.0) / sr

    def kick(ph):  # low-band energy right after each beat of a grid with this phase
        s = 0.0
        for b in np.arange(ph, dur, period):
            sel = (frame_t >= b) & (frame_t <= b + 0.08)
            if sel.any():
                s += float(low[sel].max())
        return s

    if kick((phase + period / 2) % period) > kick(phase):  # locked on the off-beats (hats): the beat is the kick
        p2, ph2, r2, i2 = fit_grid(times, strength, 60.0 / period, (phase + period / 2) % period, cfg)
        if abs(((ph2 - phase) % period) - period / 2) < 0.15 * period:
            period, phase, rms, inl = p2, ph2, r2, i2
        else:
            phase = (phase + period / 2) % period
    beats = [round(phase + k * period, 4) for k in range(int((dur - phase) / period) + 1) if phase + k * period <= dur]
    bpb = int(cfg["beatsPerBar"])
    score = [0.0] * bpb
    for k, b in enumerate(beats):
        sel = (frame_t >= b) & (frame_t <= b + 0.08)
        if sel.any():
            score[k % bpb] += float(low[sel].max())
    m = int(np.argmax(score)) if any(score) else 0
    downbeats = beats[m::bpb]
    bar_t = list(downbeats)
    bar_db = []
    for i, t0 in enumerate(bar_t):
        t1 = bar_t[i + 1] if i + 1 < len(bar_t) else min(dur, t0 + bpb * period)
        seg = mono[int(t0 * sr):int(t1 * sr)].astype(np.float64)
        bar_db.append(float(20 * math.log10(math.sqrt(float(np.mean(seg * seg)) + 1e-12))) if len(seg) else -120.0)
    secs = sections(bar_db, bar_t, dur, cfg)
    drops = [s[1] for s in secs if s[0] == "drop"]
    tc = cfg["transients"]
    tr = []
    if strength:
        cut = float(np.percentile(strength, float(tc["percentile"])))
        smax = max(strength)
        tr = sorted(((t, s) for t, s in zip(times, strength) if s >= cut), key=lambda x: -x[1])[:int(tc["max"])]
        tr = [{"t": round(t, 4), "strength": round(s / smax, 3),
               "onBeat": bool(beats) and min(abs(t - b) for b in beats) <= 0.05} for t, s in sorted(tr)]
    return {"version": 1, "duration": round(dur, 3), "bpm": round(60.0 / period, 3), "period": round(period, 5),
            "phase": round(phase, 4), "beatsPerBar": bpb, "fit": {"rmsMs": None if rms is None else round(rms, 2), "inliers": inl,
            "libraryBpm": bpm0}, "beats": beats, "downbeats": downbeats,
            "sections": [{"kind": k, "start": s, "end": e, "energyDb": d} for k, s, e, d in secs],
            "drops": drops, "transients": tr}


def main(argv=None):
    ap = argparse.ArgumentParser(description="BD2 song map (off air only)")
    ap.add_argument("--track", required=True)
    ap.add_argument("--root", help="the music folder the track must be inside (links are not followed)")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    lower_own_priority()
    try:
        r = song_map(a.track, root=a.root)
        if a.out:
            write_json_atomic(a.out, r)
            print(json.dumps({"ok": True, "bpm": r["bpm"], "drops": r["drops"], "out": a.out}))
        else:
            print(json.dumps(r))
        return 0
    except ClipError as e:
        eprint(f"song map: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
