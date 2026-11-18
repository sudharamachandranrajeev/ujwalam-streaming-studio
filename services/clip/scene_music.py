# SPDX-License-Identifier: GPL-3.0-or-later
"""MU1 scene music beds (plan 2026-11-18-audio-mixer-music.md): seamless looping music for scenes, made on this PC.

Same idea as the RP3 reel bed (reel_music.py, which this module does not touch): a procedural generator in plain
Python plus numpy (already in the project venv; no model, no download, own code, so no licence limits). A mood is data:
data/music/moods/<id>.json (schema data/schemas/music-mood.schema.json) holds tempo, key, chords, instruments, drum
pattern, effects and the loudness target. The code never names a mood.

Each bed is one WAV (PCM 16-bit, 48 kHz, stereo; the same container RP3 writes and libobs ffmpeg_source plays) of a
few minutes. It loops seamlessly because every step works on the loop as a ring: notes that run past the end wrap to
the start, and the reverb and the low-pass are applied in the frequency domain over the whole loop (circular), so the
last sample is followed by the first one like any two neighbouring samples. Same seed = same bytes.

Loudness is integrated LUFS (ITU-R BS.1770-4, K-weighting, 400 ms blocks, -70 LUFS and -10 LU gates), measured here in
numpy (RP3 has no own measurement; its ffmpeg ebur128 use is for clip ranking) and checked against ffmpeg ebur128 in
the evidence file.

Generation is off air only: the CLI runs tools/live-check.mjs first and refuses unless it says off air.

  python services/clip/scene_music.py --out <folder outside the repo> [--mood id ...] [--seed N] [--duration SEC]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import wave

from clip_common import CLIP_DATA, NO_WINDOW, REPO_ROOT, ClipError, child_kwargs, load_json, lower_own_priority
from reel_music import seed_for

GENERATOR_VERSION = "1.0.0"
SR = 48000
DATA_DIR = os.path.dirname(CLIP_DATA)
MOODS_DIR = os.path.join(DATA_DIR, "music", "moods")
SCHEMA_FILE = os.path.join(DATA_DIR, "schemas", "music-mood.schema.json")
LIVE_CHECK = os.path.join(REPO_ROOT, "tools", "live-check.mjs")
INDEX_NAME = "index.json"
TWO_PI = 2.0 * math.pi
EXIT_REFUSED = 3


def _np():
    try:
        import numpy
    except ImportError as e:  # the project venv has it; a bare interpreter may not
        raise ClipError("scene music needs numpy (use the project venv: .venv-gpu)") from e
    return numpy


# ---------------------------------------------------------------- manifests (data, validated against the schema)

def _type_ok(v, t):
    if t == "object":
        return isinstance(v, dict)
    if t == "array":
        return isinstance(v, list)
    if t == "string":
        return isinstance(v, str)
    if t == "boolean":
        return isinstance(v, bool)
    if t == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if t == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return False


def schema_errors(v, s, path="$"):
    """A small JSON-schema checker for the keywords music-mood.schema.json uses (no jsonschema in the venv; the
    project's ajv is a Node dev dependency). Returns a list of 'path: problem' strings."""
    out = []
    if "enum" in s and v not in s["enum"]:
        return [f"{path}: {v!r} is not one of {s['enum']}"]
    t = s.get("type")
    if t and not _type_ok(v, t):
        return [f"{path}: expected {t}"]
    if isinstance(v, str):
        if len(v) < s.get("minLength", 0) or len(v) > s.get("maxLength", 1 << 30):
            out.append(f"{path}: length out of range")
        if "pattern" in s and not re.search(s["pattern"], v):
            out.append(f"{path}: does not match {s['pattern']}")
    if _type_ok(v, "number"):
        if "minimum" in s and v < s["minimum"]:
            out.append(f"{path}: {v} is below {s['minimum']}")
        if "maximum" in s and v > s["maximum"]:
            out.append(f"{path}: {v} is above {s['maximum']}")
    if isinstance(v, list):
        if len(v) < s.get("minItems", 0) or len(v) > s.get("maxItems", 1 << 30):
            out.append(f"{path}: item count out of range")
        if "items" in s:
            for i, x in enumerate(v):
                out += schema_errors(x, s["items"], f"{path}[{i}]")
    if isinstance(v, dict):
        props = s.get("properties", {})
        if len(v) < s.get("minProperties", 0):
            out.append(f"{path}: too few properties")
        for k in s.get("required", []):
            if k not in v:
                out.append(f"{path}: missing {k}")
        for k, x in v.items():
            if "propertyNames" in s and k not in s["propertyNames"].get("enum", [k]):
                out.append(f"{path}.{k}: name not allowed")
            if k in props:
                out += schema_errors(x, props[k], f"{path}.{k}")
            elif isinstance(s.get("additionalProperties"), dict):
                out += schema_errors(x, s["additionalProperties"], f"{path}.{k}")
            elif s.get("additionalProperties") is False:
                out.append(f"{path}: unknown property {k}")
    return out


def validate_manifest(m, schema=None):
    """Raises ClipError listing every problem (schema, then the cross-field rules a schema cannot say)."""
    errs = schema_errors(m, schema if schema is not None else load_json(SCHEMA_FILE))
    if not errs:
        if m["tempo"]["minBpm"] > m["tempo"]["maxBpm"]:
            errs.append("tempo: minBpm is above maxBpm")
        for p in m["progressions"]:
            for c in p["chords"]:
                if c["type"] not in m["chordTypes"]:
                    errs.append(f"progression {p['id']}: chord type {c['type']} is not defined")
        if m["drums"] == "none" and any(k in m["instruments"] for k in ("kick", "snare", "clap", "hat")):
            errs.append("drums is none but a drum instrument is listed")
    if errs:
        raise ClipError(f"mood {m.get('id', '?') if isinstance(m, dict) else '?'}: " + "; ".join(errs))
    return m


def load_moods(directory=None):
    """{id: manifest} from data/music/moods/*.json, each validated; the file name must equal the id."""
    d = directory or MOODS_DIR
    schema = load_json(SCHEMA_FILE)
    out = {}
    for f in sorted(os.listdir(d)):
        if not f.endswith(".json"):
            continue
        m = validate_manifest(load_json(os.path.join(d, f)), schema)
        if f != m["id"] + ".json":
            raise ClipError(f"{f}: the file name must be {m['id']}.json")
        out[m["id"]] = m
    if not out:
        raise ClipError(f"no mood manifests in {d}")
    return out


# ---------------------------------------------------------------- loudness (BS.1770-4, integrated LUFS)

_KW1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
_KW2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def _k_weight_response(n):
    np = _np()
    w = TWO_PI * np.fft.rfftfreq(n, 1.0 / SR) / SR
    z1 = np.exp(-1j * w)
    z2 = np.exp(-2j * w)
    h = np.ones(len(w), dtype=complex)
    for b, a in (_KW1, _KW2):
        h *= (b[0] + b[1] * z1 + b[2] * z2) / (a[0] + a[1] * z1 + a[2] * z2)
    return h


def measure_lufs(x):
    """Integrated loudness (LUFS) of a stereo float array (n, 2) at 48 kHz, scaled so 1.0 is full scale. The signal is
    treated as a ring (it is a loop), so the K-weighting is applied in the frequency domain. -70.0 when silent."""
    np = _np()
    n = x.shape[0]
    y = np.fft.irfft(np.fft.rfft(x, axis=0) * _k_weight_response(n)[:, None], n, axis=0)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    if n < blk:
        raise ClipError("loudness needs at least 0.4 s of audio")
    cs = np.concatenate([np.zeros((1, y.shape[1])), np.cumsum(y * y, axis=0)])
    starts = np.arange(0, n - blk + 1, hop)
    z = ((cs[starts + blk] - cs[starts]) / blk).sum(axis=1)
    lk = -0.691 + 10.0 * np.log10(np.maximum(z, 1e-20))
    keep = z[lk > -70.0]
    if not len(keep):
        return -70.0
    rel = -0.691 + 10.0 * math.log10(float(keep.mean())) - 10.0
    keep = z[lk > max(-70.0, rel)]
    return -70.0 if not len(keep) else float(-0.691 + 10.0 * math.log10(float(keep.mean())))


def seam_stats(pcm):
    """Loop seam of an int16 array (n, 2): the step from the last sample to the first, against the 99.9th percentile of
    all other neighbouring steps. ratio <= 1 means the seam is as smooth as any other place in the bed (no click)."""
    np = _np()
    step = int(np.abs(pcm[0].astype(np.int64) - pcm[-1].astype(np.int64)).max())
    ref = float(np.percentile(np.abs(np.diff(pcm.astype(np.int64), axis=0)), 99.9))
    return {"seamStep": step, "seamRefStep": round(ref, 1), "seamRatio": round(step / max(ref, 1.0), 3)}


# ---------------------------------------------------------------- the synth (everything wraps around the loop)

def _hz(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def _pan(p):
    a = (p + 1.0) * math.pi / 4.0
    return math.cos(a), math.sin(a)


def _put(buf, start, x, pan=0.0):
    """Adds a note into the ring buffer (wraps past the end), with a 2 ms attack and 10 ms release against clicks."""
    np = _np()
    n = len(buf)
    x = np.array(x, dtype=float)
    if len(x) > n:
        x = x[:n]
    a, r = min(len(x), 96), min(len(x), 480)
    x[:a] *= np.linspace(0.0, 1.0, a)
    x[-r:] *= np.linspace(1.0, 0.0, r)
    gl, gr = _pan(pan)
    pos = int(start) % n
    first = min(len(x), n - pos)
    buf[pos:pos + first, 0] += x[:first] * gl
    buf[pos:pos + first, 1] += x[:first] * gr
    if first < len(x):
        rest = len(x) - first
        buf[:rest, 0] += x[first:] * gl
        buf[:rest, 1] += x[first:] * gr


def _t(n):
    return _np().arange(n) / SR


def _v_keys(f, n):
    np = _np()
    t = _t(n)
    return (np.minimum(1.0, t / 0.015) * np.exp(-t / 1.6) * (1.0 + 0.08 * np.sin(TWO_PI * 4.5 * t))
            * (np.sin(TWO_PI * f * t) + 0.25 * np.sin(TWO_PI * 2 * f * t)))


def _v_saw(f, n, harmonics, att, rel, decay=None):
    """Band-limited saw (1/k partials) with a raised-cosine attack and release, or a plucked decay."""
    np = _np()
    t = _t(n)
    x = sum(np.sin(TWO_PI * f * k * t) / k for k in range(1, harmonics + 1) if f * k < SR / 2.2)
    env = np.ones(n)
    a, r = max(1, int(att)), max(1, int(rel))
    env[:a] = 0.5 - 0.5 * np.cos(np.pi * np.arange(min(a, n)) / a)[:n]
    if r < n:
        env[-r:] *= 0.5 + 0.5 * np.cos(np.pi * np.arange(r) / r)
    if decay:
        env = env * np.exp(-t / decay)
    return x * env


def _v_bell(f, n):
    np = _np()
    t = _t(n)
    return sum(a * np.sin(TWO_PI * f * r * t) * np.exp(-t / d)
               for r, a, d in ((1.0, 1.0, 1.1), (2.76, 0.5, 0.6), (5.4, 0.25, 0.35), (8.9, 0.12, 0.2)))


def _noise(npr, n):
    return npr.uniform(-1.0, 1.0, n)


def _drum_kit(npr):
    np = _np()
    kick_t = _t(int(0.28 * SR))
    ph = np.cumsum(TWO_PI * (45.0 + 75.0 * np.exp(-kick_t / 0.03)) / SR)
    kick = np.exp(-kick_t / 0.09) * np.sin(ph)
    st = _t(int(0.18 * SR))
    snare = np.exp(-st / 0.045) * np.diff(_noise(npr, len(st) + 1)) * 0.7 + 0.5 * np.exp(-st / 0.07) * np.sin(TWO_PI * 190 * st)
    ct = _t(int(0.14 * SR))
    clap = np.diff(_noise(npr, len(ct) + 1)) * np.exp(-ct / 0.04)
    for k in (0.010, 0.020):  # three quick bursts
        clap = clap + np.where(ct >= k, np.diff(_noise(npr, len(ct) + 1)) * np.exp(-(ct - k) / 0.03), 0.0) * 0.8
    ht = _t(int(0.05 * SR))
    hat = np.diff(_noise(npr, len(ht) + 1)) * np.exp(-ht / 0.012)
    ot = _t(int(0.16 * SR))
    ohat = np.diff(_noise(npr, len(ot) + 1)) * np.exp(-ot / 0.05)
    return {"kick": kick, "snare": snare, "clap": clap, "hat": hat, "ohat": ohat}


def _plan(m, seed, bars, duration):
    pyr = random.Random(seed)
    tp = m["tempo"]
    bpm = pyr.randint(int(tp["minBpm"]), int(tp["maxBpm"]))
    key = int(pyr.choice(m["keys"]))
    prog = pyr.choice(m["progressions"])
    q = max(1, round(SR * 15.0 / bpm))  # one 16th note in samples; whole numbers keep the bars exact
    bar = 16 * q
    if bars is None:
        bars = max(2, round(float(duration or m["durationSec"]) * SR / bar))
        if bars >= 16:
            bars -= bars % 4
    return pyr, {"bpm": bpm, "key": key, "progression": prog["id"], "chords": prog["chords"], "q": q, "bar": bar,
                 "bars": int(bars)}


def render(m, seed, bars=None, duration=None):
    """-> (float stereo array (n, 2) before loudness, info dict). Deterministic for (manifest, seed, bars/duration)."""
    np = _np()
    pyr, pl = _plan(m, seed, bars, duration)
    npr = np.random.default_rng(seed)
    q, bar, nbars = pl["q"], pl["bar"], pl["bars"]
    n = nbars * bar
    buf = np.zeros((n, 2))
    ins = m["instruments"]
    types = m["chordTypes"]
    phrases = (nbars + 3) // 4
    on = {k: [float(d.get("density", 1.0)) >= 1.0 or pyr.random() < float(d["density"]) for _ in range(phrases)]
          for k, d in ins.items()}
    kit = _drum_kit(npr) if m["drums"] != "none" else {}

    def lv(k):
        return float(ins[k]["level"])

    def act(k, b):
        return k in ins and on[k][b // 4]

    pattern = m["drums"]
    for b in range(nbars):
        t0 = b * bar
        ch = pl["chords"][b % len(pl["chords"])]
        notes = [pl["key"] + int(ch["root"]) + iv for iv in types[ch["type"]]]
        root = pl["key"] + int(ch["root"])
        if act("keys", b):
            if pattern == "none":  # sparse melody over the chord instead of a strummed block
                for slot in sorted(pyr.sample(range(8), 3)):
                    _put(buf, t0 + slot * 2 * q, 0.7 * lv("keys") * _v_keys(_hz(pyr.choice(notes) + 12), int(3.0 * SR)),
                         pan=pyr.uniform(-0.4, 0.4))
            else:
                for k, mid in enumerate(notes):
                    f = _hz(mid) * (1.0 + pyr.uniform(-0.0015, 0.0015))
                    _put(buf, t0 + int(k * 0.012 * SR), lv("keys") / len(notes) * _v_keys(f, bar))
        if act("pad", b):
            lift = 12 if root < 48 else 0
            for k, mid in enumerate(notes[:4]):
                for side, cents in ((-0.7, 6.0), (0.7, -6.0)):
                    f = _hz(mid + lift) * 2.0 ** (cents / 1200.0)
                    _put(buf, t0, lv("pad") / len(notes) * 0.6 * _v_saw(f, int(bar * 1.25), 6, bar * 0.3, bar * 0.25), side)
        if act("drone", b):
            n_d = int(bar * 1.5)
            t = _t(n_d)
            for k, (iv, a) in enumerate(((0, 1.0), (7, 0.55), (12, 0.35))):
                lfo = 0.85 + 0.15 * np.sin(TWO_PI * 0.13 * t + k * 1.7 + b)
                _put(buf, t0, lv("drone") * a * lfo * _v_saw(_hz(root + iv), n_d, 2, bar * 0.4, bar * 0.5), (k - 1) * 0.3)
        if act("bass", b):
            fb = _hz(root - 24)
            slots = (0,) if pattern == "none" else (0, 2)
            ln = int((3.5 if pattern == "none" else 1.5) * 4 * q)
            for bt in slots:
                t = _t(ln)
                _put(buf, t0 + bt * 4 * q, lv("bass") * np.minimum(1.0, t / 0.01) * np.exp(-t / (1.6 if pattern == "none" else 0.9))
                     * (np.sin(TWO_PI * fb * t) + 0.2 * np.sin(TWO_PI * 2 * fb * t)))
        if act("pulseBass", b):
            fb = _hz(root - 12)
            for e, oct_ in enumerate((0, 0, 12, 0, 0, 0, 12, 0)):
                _put(buf, t0 + e * 2 * q, lv("pulseBass") * 0.5 * _v_saw(fb * 2.0 ** (oct_ / 12.0), int(1.8 * q), 4, 0.003 * SR, 0.02 * SR, 0.25))
        if act("arp", b):
            up = [x + 12 * (-(-(60 - x) // 12)) if x < 60 else x for x in notes]  # lift the chord into the arp range
            seq = up + [x + 12 for x in up]
            order = seq + seq[-2:0:-1]
            for s in range(16):
                _put(buf, t0 + s * q, lv("arp") * 0.5 * _v_saw(_hz(order[s % len(order)]), int(0.28 * SR), 6, 0.002 * SR, 0.03 * SR, 0.12),
                     -0.5 if s % 2 else 0.5)
        if act("bell", b):
            for slot in (0, 1):
                if pyr.random() < 0.6:
                    mid = pyr.choice(notes) + 12 * pyr.choice((1, 2))
                    _put(buf, t0 + pyr.randrange(0, 16, 2) * q, lv("bell") * 0.6 * _v_bell(_hz(mid), int(3.0 * SR)), pyr.uniform(-0.8, 0.8))
        if pattern == "four-on-floor":
            for s in (0, 4, 8, 12):
                if "kick" in ins:
                    _put(buf, t0 + s * q, lv("kick") * kit["kick"])
            for s in (4, 12):
                if "clap" in ins:
                    _put(buf, t0 + s * q, lv("clap") * kit["clap"])
                if "snare" in ins:
                    _put(buf, t0 + s * q, lv("snare") * kit["snare"])
            if "hat" in ins:
                for s in (2, 6, 10, 14):
                    _put(buf, t0 + s * q, lv("hat") * 1.6 * kit["ohat"], 0.25)
                for s in range(1, 16, 2):
                    _put(buf, t0 + s * q, lv("hat") * 0.5 * kit["hat"], 0.25)
            if "snare" in ins and b % 8 == 7:
                for i, s in enumerate((12, 13, 14, 15)):
                    _put(buf, t0 + s * q, lv("snare") * (0.5 + 0.2 * i) * kit["snare"])
        elif pattern == "lofi":
            kicks = [0, 8] + ([10] if pyr.random() < 0.4 else [])
            for s in kicks:
                if "kick" in ins:
                    _put(buf, t0 + s * q, lv("kick") * kit["kick"])
            for s in (4, 12):
                if "snare" in ins:
                    _put(buf, t0 + s * q, lv("snare") * kit["snare"])
            if "hat" in ins:
                sw = float(m["swing"])
                for e in range(8):
                    s = t0 + (e // 2) * 4 * q + (int(sw * 4 * q) if e % 2 else 0)
                    _put(buf, s, lv("hat") * (0.6 if e % 2 else 1.0) * kit["hat"], 0.25)
    if "crackle" in ins:
        k = int(n / SR * 9)
        idx = npr.integers(0, n, k)
        ch_ = npr.integers(0, 2, k)
        buf[idx, ch_] += lv("crackle") * npr.choice([-1.0, 1.0], k)
    info = {"bpm": pl["bpm"], "key": pl["key"], "progression": pl["progression"], "bars": nbars}
    return _finish(buf, m, npr), info


def _finish(buf, m, npr):
    """Reverb and low-pass over the whole loop in the frequency domain (circular, so the seam stays seamless)."""
    np = _np()
    n = buf.shape[0]
    X = np.fft.rfft(buf, axis=0)
    rv = m["reverb"]
    if float(rv["seconds"]) > 0 and float(rv["mix"]) > 0:
        L = min(n, int(float(rv["seconds"]) * SR))
        t = np.arange(L) / SR
        wet = np.empty_like(X)
        for c in range(2):
            ir = npr.standard_normal(L) * np.exp(-6.9 * t / float(rv["seconds"])) * (1.0 - np.exp(-t / 0.015))
            ir /= math.sqrt(float((ir * ir).sum())) or 1.0
            wet[:, c] = X[:, c] * np.fft.rfft(ir, n)
        X = X + float(rv["mix"]) * wet
    f = np.fft.rfftfreq(n, 1.0 / SR)
    X *= (1.0 / (1.0 + (f / float(m["lowpassHz"])) ** 2))[:, None]
    return np.fft.irfft(X, n, axis=0)


def normalise(x, target_lufs, peak_ceiling_db):
    """Scales to the integrated-LUFS target; a tanh soft limit keeps the peak under the ceiling (re-measured after)."""
    np = _np()
    ceil = 10.0 ** (peak_ceiling_db / 20.0)
    for _ in range(8):
        err = target_lufs - measure_lufs(x)
        if abs(err) < 0.02:
            break
        x = x * 10.0 ** (err / 20.0)
        if float(np.abs(x).max()) > ceil:
            x = ceil * np.tanh(x / ceil)
    return x


def to_pcm(x):
    np = _np()
    return np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2")


def write_wav(path, pcm):
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def generate(m, seed, path=None, bars=None, duration=None):
    """Makes one bed. Writes the WAV when path is given. -> record (mood, seed, duration, loudness, seam, ...)."""
    np = _np()
    validate_manifest(m)
    x, info = render(m, seed, bars, duration)
    ld = m["loudness"]
    x = normalise(x, float(ld["targetLufs"]), float(ld["peakCeilingDb"]))
    pcm = to_pcm(x)
    rec = {"mood": m["id"], "moodVersion": m["version"], "seed": int(seed), "durationSec": round(len(pcm) / SR, 3),
           "bpm": info["bpm"], "key": info["key"], "progression": info["progression"], "bars": info["bars"],
           "targetLufs": float(ld["targetLufs"]),
           "lufs": round(measure_lufs(pcm.astype(float) / 32768.0), 2),
           "peakDb": round(20.0 * math.log10(max(1, int(np.abs(pcm.astype(np.int64)).max())) / 32768.0), 2)}
    rec.update(seam_stats(pcm))
    if path:
        write_wav(path, pcm)
        with open(path, "rb") as f:
            rec["sha256"] = hashlib.sha256(f.read()).hexdigest()
        rec["bytes"] = os.path.getsize(path)
    return rec


# ---------------------------------------------------------------- the library and the CLI

def node_live_check():
    """('off' | 'live' | 'unknown', message) from tools/live-check.mjs (exit 0 off air, 1 live, 2 unknown)."""
    node = shutil.which("node")
    if not node or not os.path.isfile(LIVE_CHECK):
        return "unknown", "node or tools/live-check.mjs not found"
    try:
        r = subprocess.run([node, LIVE_CHECK], capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL,
                           **child_kwargs(**NO_WINDOW))
    except (OSError, subprocess.TimeoutExpired) as e:
        return "unknown", f"live check failed: {e}"
    msg = (r.stdout or r.stderr or "").strip()
    return {0: "off", 1: "live"}.get(r.returncode, "unknown"), msg


def _inside_repo(path):
    a, b = os.path.normcase(os.path.realpath(path)), os.path.normcase(os.path.realpath(REPO_ROOT))
    return a == b or a.startswith(b + os.sep)


def build_library(out_dir, moods, mood_ids=None, base_seed=1, duration=None, log=print):
    """Writes <mood>.wav for each mood and index.json into out_dir. -> the index dict."""
    ids = list(mood_ids) if mood_ids else sorted(moods)
    for i in ids:
        if i not in moods:
            raise ClipError(f"unknown mood {i} (have: {', '.join(sorted(moods))})")
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for i in ids:
        seed = seed_for("scene-music", base_seed, i)
        rec = generate(moods[i], seed, os.path.join(out_dir, i + ".wav"), duration=duration)
        rec["file"] = i + ".wav"
        files.append(rec)
        log(f"{i}: {rec['durationSec']} s, {rec['lufs']} LUFS (target {rec['targetLufs']}), seam ratio {rec['seamRatio']}")
    index = {"index": 1, "generator": "scene_music", "generatorVersion": GENERATOR_VERSION,
             "format": "wav pcm_s16le 48000 Hz stereo", "baseSeed": int(base_seed), "files": files}
    tmp = os.path.join(out_dir, INDEX_NAME + ".part")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(index, f, indent=2)
        f.write("\n")
    os.replace(tmp, os.path.join(out_dir, INDEX_NAME))
    return index


def main(argv=None, live_check=None, log=print):
    ap = argparse.ArgumentParser(description="Make the scene music library (off air only).")
    ap.add_argument("--out", required=True, help="folder for the beds and index.json (outside the repo)")
    ap.add_argument("--mood", action="append", help="mood id (repeatable); default all")
    ap.add_argument("--seed", type=int, default=1, help="base seed; each mood derives its own")
    ap.add_argument("--duration", type=float, help="seconds per bed (default: the manifest's durationSec)")
    ap.add_argument("--moods-dir", help="manifest folder (default data/music/moods)")
    a = ap.parse_args(argv)
    try:
        if _inside_repo(a.out):
            raise ClipError("refused: the library goes outside the repo (use the app data folder)")
        state, msg = (live_check or node_live_check)()
        if state != "off":
            log(f"refused: {'live' if state == 'live' else 'cannot confirm off air'} ({msg}); generation is off air only")
            return EXIT_REFUSED
        moods = load_moods(a.moods_dir)
        lower_own_priority()
        build_library(a.out, moods, a.mood, a.seed, a.duration, log)
    except ClipError as e:
        log(str(e))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
