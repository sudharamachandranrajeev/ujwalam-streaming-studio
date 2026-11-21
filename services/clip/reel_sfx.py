# SPDX-License-Identifier: GPL-3.0-or-later
"""FX3 sound effects on the joins of a reel (D411): whoosh, impact, riser, boom and a soft whoosh, made on this PC with
numpy (filtered-noise sweeps and pitched sine transients; no samples, no download, no licence limits). One WAV as long
as the reel, each effect placed on its join, the whole track normalised so its peak sits at the set's sfxDb under full
scale (well under the game mix). clip_montage.render_argv(music={"sfx": ...}) mixes it into audio track 1 without a duck.

  synth(joins, total, kinds, peak_db, seed, path, sr=48000)
  prepare(wd, tr, pieces, xd, seed) -> file name or None
  cleanup(wd)
"""

from __future__ import annotations

import os
import wave

WAV = "sfx.wav"
SR = 48000


def _np():
    import numpy as np  # noqa: PLC0415 - lazy: clipper imports this module and must load on a bare interpreter
    return np


def _noise(rng, n):
    return rng.uniform(-1.0, 1.0, n)


def _sweep_lowpass(x, f0, f1, sr):
    """One-pole low-pass whose cut-off glides from f0 to f1 (exponentially) over the signal."""
    np = _np()
    n = len(x)
    fc = f0 * (f1 / f0) ** (np.arange(n) / max(1, n - 1))
    a = 1.0 - np.exp(-2.0 * np.pi * fc / sr)
    y = np.empty(n)
    acc = 0.0
    for i in range(n):  # a few tenths of a second per effect: a plain loop is fast enough
        acc += a[i] * (x[i] - acc)
        y[i] = acc
    return y


def _env(n, peak_at):
    """Rise to 1 at peak_at (0..1 of the length), then fall, both sine-shaped."""
    np = _np()
    t = np.arange(n) / max(1, n - 1)
    up = np.sin(0.5 * np.pi * np.clip(t / max(peak_at, 1e-3), 0, 1)) ** 2
    down = np.cos(0.5 * np.pi * np.clip((t - peak_at) / max(1 - peak_at, 1e-3), 0, 1)) ** 2
    return np.where(t <= peak_at, up, down)


def whoosh(rng, sr=SR, sec=0.45, soft=False):
    n = int(sec * sr)
    x = _noise(rng, n)
    lo = _sweep_lowpass(x, 300.0, 4000.0 if not soft else 2000.0, sr)
    hp = lo - _sweep_lowpass(lo, 120.0, 600.0, sr)  # take the rumble out
    return hp * _env(n, 0.55) * (0.5 if soft else 1.0)


def impact(rng, sr=SR, sec=0.5):
    np = _np()
    n = int(sec * sr)
    t = np.arange(n) / sr
    f = 45.0 + 75.0 * np.exp(-t / 0.04)
    body = np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t / 0.12)
    click = _noise(rng, n) * np.exp(-t / 0.008)
    return body + 0.4 * (click - _sweep_lowpass(click, 800.0, 800.0, sr))


def riser(rng, sr=SR, sec=0.9):
    np = _np()
    n = int(sec * sr)
    x = _sweep_lowpass(_noise(rng, n), 200.0, 6000.0, sr)
    return x * (np.arange(n) / max(1, n - 1)) ** 2


def boom(rng, sr=SR, sec=1.2):
    np = _np()
    n = int(sec * sr)
    t = np.arange(n) / sr
    return (np.sin(2 * np.pi * 50.0 * t) + 0.3 * np.sin(2 * np.pi * 100.0 * t)) * np.minimum(1.0, t / 0.01) * np.exp(-t / 0.45)


# where each effect sits against its join (start a, end b): offset of the effect's start in seconds
def _placement(kind, a, b, sr=SR):
    mid = (a + b) / 2.0
    return {"whoosh": mid - 0.45 * 0.55, "soft-whoosh": mid - 0.3 * 0.55, "impact": b, "riser": mid - 0.9,
            "boom": mid}[kind]


def _make(kind, rng, sr=SR):
    return {"whoosh": lambda: whoosh(rng, sr), "soft-whoosh": lambda: whoosh(rng, sr, 0.3, soft=True),
            "impact": lambda: impact(rng, sr), "riser": lambda: riser(rng, sr), "boom": lambda: boom(rng, sr)}[kind]()


def synth(joins, total, kinds, peak_db, seed, path, sr=SR):
    """Writes a 16-bit stereo WAV `total` seconds long with each kind of effect on every join, peak at peak_db dBFS."""
    np = _np()
    rng = np.random.default_rng(seed)
    n = int(round(total * sr))
    buf = np.zeros(n)
    for a, b in joins:
        for k in kinds:
            s = _make(k, rng, sr)
            i0 = int(round(_placement(k, a, b, sr) * sr))
            j0, j1 = max(0, i0), min(n, i0 + len(s))
            if j1 > j0:
                buf[j0:j1] += s[j0 - i0:j1 - i0]
    peak = float(np.max(np.abs(buf))) if n else 0.0
    if peak > 0:
        buf *= (10.0 ** (peak_db / 20.0)) / peak
    pcm = np.repeat((np.clip(buf, -1, 1) * 32767).astype("<i2")[:, None], 2, axis=1)
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def prepare(wd, tr, pieces, xd, seed):
    """The sound effects of a reel's joins (tr: reel_transition.plan_set) -> the bare WAV name, or None."""
    from reel_transition import join_times  # noqa: PLC0415
    if not tr or not tr.get("sfx") or len(pieces) < 2:
        return None
    total = sum(float(p["end"]) - float(p["start"]) for p in pieces) - (len(pieces) - 1) * xd
    synth(join_times(pieces, xd), total, tr["sfx"], float(tr["sfxDb"]), seed, os.path.join(wd, WAV))
    return WAV


def cleanup(wd):
    for n in (WAV, WAV + ".part"):
        try:
            os.remove(os.path.join(wd, n))
        except OSError:
            pass
