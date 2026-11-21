# SPDX-License-Identifier: GPL-3.0-or-later
"""FX4 music library (D411, plan docs/plan/2026-11-21-clip-music-name-transitions.md 3.4): tracks from the user's own
music folder, analysed once off air with PyAV + numpy, matched to each reel by energy and mood, and laid under the reel
as one WAV in one of three modes (intro-outro, drop, full-bed) at the user's level (default -16 LUFS integrated, of the
music where it plays). No network: nothing is downloaded (the free pack and local AI music are FX5/FX6, later, and need
the user's yes). Data: data/clip/music-library.json; library: <data>/music/library.json.

  analyse(path, cfg)                         -> track facts (bpm, beat offset, energy curve, drop, loudness, mood, ...)
  refresh(data_dir, folder, cfg, live=None)  -> library (new files analysed, gone files dropped; never while live)
  load_library(data_dir)                     -> library dict
  target_for(reel, typ, cfg)                 -> {"energy", "moods"}
  match(tracks, target, need_sec, seed_parts, recent, cfg) -> (track or None, score)
  strongest_reel_time(reel, pieces, xd)      -> reel time of the strongest moment
  plan(track, mode, pieces, xd, strongest, title_end, level_db, cfg) -> bed record (times, beats in reel time)
  render(rec, track, cfg)                    -> float stereo (n, 2) at 48 kHz, normalised
  prepare(wd, rec, track, cfg, duck)         -> the dict clip_montage.render_argv(music=) takes
"""

from __future__ import annotations

import hashlib
import math
import os
import random
import wave

from clip_common import CLIP_DATA, ClipError, load_json, write_json_atomic

CONFIG_FILE = os.path.join(CLIP_DATA, "music-library.json")
WAV = "music.wav"
SR = 48000
MODES = ("intro-outro", "drop", "full-bed")


def _np():
    import numpy as np  # noqa: PLC0415 - the shipped runtime has it; a bare interpreter gets a clear error
    return np


def load_config(path=None):
    cfg = load_json(path or CONFIG_FILE)
    if int(cfg["analysisSampleRate"]) != SR:
        raise ClipError("music library: analysis runs at 48 kHz (the loudness filter is made for it)")
    return cfg


# ---------------------------------------------------------------- decode and analyse

def decode(path, sr=SR, channels=2, max_sec=None):
    """-> float32 array (n, channels) at sr, from any file PyAV/FFmpeg can read."""
    import av  # noqa: PLC0415
    np = _np()
    chunks = []
    with av.open(path) as c:
        st = next((s for s in c.streams if s.type == "audio"), None)
        if st is None:
            raise ClipError(f"{os.path.basename(path)}: no sound")
        rs = av.AudioResampler(format="flt", layout="stereo" if channels == 2 else "mono", rate=sr)
        got = 0
        for fr in c.decode(st):
            for o in rs.resample(fr):
                a = o.to_ndarray().reshape(-1, channels)
                chunks.append(a)
                got += len(a)
            if max_sec and got >= max_sec * sr:
                break
        for o in rs.resample(None):
            chunks.append(o.to_ndarray().reshape(-1, channels))
    if not chunks:
        raise ClipError(f"{os.path.basename(path)}: no sound decoded")
    x = np.concatenate(chunks).astype(np.float32)
    return x[: int(max_sec * sr)] if max_sec else x


def _onsets(mono, sr):
    """Spectral-flux onset envelope -> (envelope, frames per second, spectral centroid Hz)."""
    np = _np()
    n_fft, hop = 2048, 1024
    if len(mono) < n_fft * 4:
        raise ClipError("track too short to analyse")
    frames = 1 + (len(mono) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(frames)[:, None]
    mag = np.abs(np.fft.rfft(mono[idx] * np.hanning(n_fft)[None, :], axis=1))
    lm = np.log1p(10.0 * mag)
    flux = np.maximum(0.0, np.diff(lm, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    centroid = float((mag * freqs[None, :]).sum() / max(1e-9, mag.sum()))
    return flux, sr / hop, centroid


def tempo(env, rate, cfg):
    """BPM and beat offset (s) from an onset envelope: autocorrelation over the BPM range with a soft preference for
    cfg.bpm.prefer (octave errors), then the phase whose beats hold the most onset strength."""
    np = _np()
    e = env - env.mean()
    ac = np.correlate(e, e, mode="full")[len(e) - 1:]
    lo, hi = float(cfg["bpm"]["min"]), float(cfg["bpm"]["max"])
    lags = np.arange(max(1, int(rate * 60.0 / hi)), int(rate * 60.0 / lo) + 1)
    lags = lags[lags < len(ac) - 1]
    if not len(lags):
        raise ClipError("track too short for a tempo")
    bpms = 60.0 * rate / lags
    prior = np.exp(-0.5 * (np.log2(bpms / float(cfg["bpm"]["prefer"])) / 0.9) ** 2)
    score = ac[lags] * prior
    k = int(np.argmax(score))
    lag = float(lags[k])
    if 0 < k < len(lags) - 1:  # parabolic refinement
        a, b, c = score[k - 1], score[k], score[k + 1]
        d = a - 2 * b + c
        if d < 0:
            lag += 0.5 * (a - c) / d
    period = lag
    p = int(round(period))
    phases = [env[ph::p].sum() if p > 0 else 0.0 for ph in range(max(1, p))]
    offset = int(np.argmax(phases)) / rate
    return round(float(60.0 * rate / period), 2), round(float(offset), 3)


def _energy(mono, sr, step=0.5):
    np = _np()
    n = int(step * sr)
    k = len(mono) // n
    if k == 0:
        return []
    rms = np.sqrt((mono[: k * n].reshape(k, n) ** 2).mean(axis=1) + 1e-12)
    return [round(float(20.0 * math.log10(v)), 2) for v in rms]


def _drop(energy, step, dur, window=4.0):
    """Time of the largest sustained rise: mean energy of the next window minus the one before."""
    w = int(window / step)
    best, at = -1e9, dur / 3.0
    for i in range(w, len(energy) - w + 1):
        rise = sum(energy[i:i + w]) / w - sum(energy[i - w:i]) / w
        if rise > best:
            best, at = rise, i * step
    return round(float(at), 3), round(float(best), 2)


def _onset_rate(env, rate):
    """Clear onsets per second, scaled by how percussive the track is (95th percentile of the onset envelope over its
    median: a smooth pad has a flat envelope and counts as almost no onsets)."""
    np = _np()
    thr = env.mean() + 1.5 * env.std()
    peaks = (env[1:-1] > thr) & (env[1:-1] >= env[:-2]) & (env[1:-1] >= env[2:])
    crest = float(np.percentile(env, 95)) / max(1e-9, float(np.median(env)))
    return float(peaks.sum()) / (len(env) / rate) * max(0.0, min(1.0, (crest - 1.5) / 4.0))


def guess_mood(bpm, energy_level, centroid, dyn_db):
    """A first guess from tempo, energy, brightness and dynamics; the user may change it (UNVERIFIED on real tracks)."""
    if bpm < 95 or energy_level < 0.3:
        return "chill" if centroid > 2500 else "lo-fi"
    if bpm < 125:
        return "cinematic" if dyn_db > 12 else "trap"
    return "edm" if centroid > 2200 else "phonk"


def analyse(path, cfg):
    """Facts of one track. Raises ClipError when it cannot be read or is too short."""
    np = _np()
    from scene_music import measure_lufs  # noqa: PLC0415 - BS.1770 integrated loudness at 48 kHz
    x = decode(path, SR, 2, max_sec=float(cfg["maxAnalyseSec"]))
    dur = len(x) / SR
    if dur < float(cfg["minTrackSec"]):
        raise ClipError(f"{os.path.basename(path)}: shorter than {cfg['minTrackSec']:g} s")
    mono = x.mean(axis=1).astype(np.float64)
    env, rate, centroid = _onsets(mono, SR)
    bpm, offset = tempo(env, rate, cfg)
    energy = _energy(mono, SR)
    drop, rise = _drop(energy, 0.5, dur)
    beat = 60.0 / bpm
    drop = round(float(offset + round((drop - offset) / beat) * beat), 3)  # on a beat
    loud = measure_lufs(x.astype(np.float64))
    e = sorted(energy)
    dyn = (e[int(0.95 * (len(e) - 1))] - e[int(0.10 * (len(e) - 1))]) if e else 0.0
    level = max(0.0, min(1.0, 0.45 * (bpm - 70.0) / 110.0 + 0.55 * min(1.0, _onset_rate(env, rate) / 6.0)))
    return {"duration": round(dur, 3), "bpm": bpm, "beatOffset": offset, "drop": max(0.0, min(drop, dur)),
            "dropRiseDb": rise, "energy": energy, "loudnessLufs": round(loud, 2), "centroidHz": round(centroid, 1),
            "dynamicsDb": round(float(dyn), 2), "energyLevel": round(float(level), 3),
            "mood": guess_mood(bpm, level, centroid, dyn)}


# ---------------------------------------------------------------- the library file

def _lib_path(data_dir, cfg):
    return os.path.join(data_dir, *cfg["library"].split("/"))


def load_library(data_dir, cfg=None):
    cfg = cfg or load_config()
    try:
        j = load_json(_lib_path(data_dir, cfg))
    except (OSError, ClipError):
        return {"version": 1, "folder": None, "tracks": []}
    return j if isinstance(j, dict) and isinstance(j.get("tracks"), list) else {"version": 1, "folder": None, "tracks": []}


def _track_id(path, st):
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}".encode("utf-8")).hexdigest()[:16]


def list_files(folder, cfg):
    exts = tuple(cfg["extensions"])
    out = []
    for root, dirs, files in os.walk(folder):
        dirs.sort()
        for f in sorted(files):
            if f.lower().endswith(exts):
                out.append(os.path.join(root, f))
                if len(out) >= int(cfg["maxFiles"]):
                    return out
    return out


def refresh(data_dir, folder, cfg=None, live=None):
    """Adds new tracks of the folder (at most maxNewPerRun per call), drops gone ones, keeps the user's moods. Nothing
    is analysed while live (live() true or unknown): the library is returned as it is."""
    cfg = cfg or load_config()
    lib = load_library(data_dir, cfg)
    if not folder or not os.path.isdir(folder):
        return lib
    try:
        on_air = bool(live()) if live else False
    except Exception:  # noqa: BLE001 - cannot tell: treat as live
        on_air = True
    if on_air:
        return lib
    old = {t["id"]: t for t in lib["tracks"] if lib.get("folder") == folder}
    tracks, new = [], 0
    for p in list_files(folder, cfg):
        try:
            st = os.stat(p)
        except OSError:
            continue
        tid = _track_id(p, st)
        if tid in old:
            tracks.append(old[tid])
            continue
        if new >= int(cfg["maxNewPerRun"]):
            continue
        new += 1
        row = {"id": tid, "file": p, "name": os.path.splitext(os.path.basename(p))[0], "licence": cfg["licence"]}
        try:
            row.update(analyse(p, cfg))
        except (ClipError, OSError, ValueError, MemoryError) as e:
            row["error"] = str(e)[-160:]
        except Exception as e:  # noqa: BLE001 - a broken file never stops the clip run
            row["error"] = f"{type(e).__name__}: {str(e)[-120:]}"
        tracks.append(row)
    lib = {"version": 1, "folder": folder, "tracks": tracks}
    os.makedirs(os.path.dirname(_lib_path(data_dir, cfg)), exist_ok=True)
    write_json_atomic(_lib_path(data_dir, cfg), lib)
    return lib


def usable(lib):
    return [t for t in lib.get("tracks") or [] if not t.get("error") and t.get("bpm") and os.path.isfile(t.get("file", ""))]


# ---------------------------------------------------------------- matching

def target_for(reel, typ, cfg=None):
    """The reel's music target from its own facts: energy from kills, streaks and medals; moods from its kind."""
    cfg = cfg or load_config()
    kills = int(reel.get("kills") or sum(int(p.get("kills") or 0) for p in reel.get("pieces") or []))
    streaks = int(reel.get("streaks") or 0) + (1 if reel.get("labels") and typ in ("montage", "live-clip") else 0)
    medals = len(reel.get("medals") or [])
    energy = max(0.2, min(1.0, 0.35 + 0.08 * kills + 0.12 * streaks + (0.1 if medals else 0.0)))
    t = cfg["targets"]
    moods = t["calm"] if energy < 0.45 else (t["streak"] if streaks and typ in ("montage", "live-clip") else t.get(typ, t["montage"]))
    return {"energy": round(energy, 3), "moods": list(moods)}


def score(track, target, need_sec, cfg=None):
    cfg = cfg or load_config()
    s = cfg["score"]
    mood = track.get("moodUser") or track.get("mood")
    ranks = s["moodRank"]
    m = ranks[target["moods"].index(mood)] if mood in target["moods"][: len(ranks)] else float(s["otherMood"])
    e = 1.0 - abs(float(track.get("energyLevel", 0.5)) - float(target["energy"]))
    ln = min(1.0, float(track.get("duration", 0)) / max(1.0, need_sec))
    return float(s["mood"]) * m + float(s["energy"]) * e + float(s["length"]) * ln


def match(tracks, target, need_sec, seed_parts, recent=(), cfg=None, n_avoid=3):
    """(track, score) for this reel, or (None, best score) when nothing reaches the threshold. Seeded, weighted by
    score^sharpness; the last n_avoid tracks are left out while another fits."""
    cfg = cfg or load_config()
    scored = [(score(t, target, need_sec, cfg), t) for t in tracks]
    ok = [(s, t) for s, t in scored if s >= float(cfg["score"]["threshold"])]
    if not ok:
        return None, round(max((s for s, _ in scored), default=0.0), 3)
    avoid = set(list(recent)[-n_avoid:]) if n_avoid else set()
    free = [(s, t) for s, t in ok if t["id"] not in avoid] or ok
    rng = random.Random(int.from_bytes(hashlib.sha256("|".join(map(str, [*seed_parts, "track"])).encode()).digest()[:8], "little"))
    w = [s ** float(cfg["score"]["sharpness"]) for s, _ in free]
    x = rng.random() * sum(w)
    acc = 0.0
    for (s, t), wi in zip(free, w):
        acc += wi
        if x < acc:
            return t, round(s, 3)
    return free[-1][1], round(free[-1][0], 3)


# ---------------------------------------------------------------- the bed

def reel_time(pieces, xd, t):
    """Recording time t -> reel time (the first non-teaser piece that holds it), or None."""
    acc = 0.0
    for i, p in enumerate(pieces):
        a, b = float(p["start"]), float(p["end"])
        if a <= t <= b and not p.get("teaser"):
            return acc - i * xd + (t - a)
        acc += b - a
    return None


def strongest_reel_time(reel, pieces, xd):
    """Reel time of the strongest moment: the heaviest medal, else the first kill of the piece with the most kills,
    else the middle of the reel."""
    total = sum(float(p["end"]) - float(p["start"]) for p in pieces) - (len(pieces) - 1) * xd
    for m in sorted(reel.get("medals") or [], key=lambda m: -float(m.get("w", 0))):
        r = reel_time(pieces, xd, float(m["t"]))
        if r is not None:
            return round(r, 3)
    for k in sorted(reel.get("peaks") or []):
        r = reel_time(pieces, xd, float(k))
        if r is not None:
            return round(r, 3)
    return round(total / 2.0, 3)


def plan(track, mode, pieces, xd, strongest, title_end, level_db, cfg=None):
    """Where the track plays under the reel -> {mode, total, segments: [{at, from, len, fadeIn, fadeOut}], beats, levelDb,
    track id/name/bpm}. Segment: reel time `at`, track time `from`, length; beats: reel times of the track's beats."""
    cfg = cfg or load_config()
    bd = cfg["bed"]
    total = sum(float(p["end"]) - float(p["start"]) for p in pieces) - (len(pieces) - 1) * xd
    dur, bpm, off = float(track["duration"]), float(track["bpm"]), float(track["beatOffset"])
    beat = 60.0 / bpm
    segs = []
    if mode == "intro-outro":
        intro = max(float(bd["introMinSec"]), float(title_end or 0.0))
        intro = min(intro, total / 2.0)
        n_beats = max(1, int(intro / beat))
        intro = min(intro, n_beats * beat) if n_beats * beat >= float(bd["introMinSec"]) else intro
        segs.append({"at": 0.0, "from": off, "len": intro, "fadeIn": float(bd["startFadeSec"]), "fadeOut": float(bd["introFadeOutSec"])})
        osec = float(bd["outroSec"])
        if total - osec >= intro + 1.0:
            src = min(float(track["drop"]), max(0.0, dur - osec))
            segs.append({"at": total - osec, "from": src, "len": osec, "fadeIn": float(bd["outroFadeInSec"]), "fadeOut": float(bd["endFadeSec"])})
    elif mode == "drop":
        r0 = max(0.0, strongest - float(track["drop"]))
        src = float(track["drop"]) - (strongest - r0)
        segs.append({"at": r0, "from": src, "len": min(total - r0, dur - src),
                     "fadeIn": float(bd["dropLeadFadeSec"]) if r0 > 0 else float(bd["startFadeSec"]), "fadeOut": float(bd["endFadeSec"])})
    elif mode == "full-bed":
        segs.append({"at": 0.0, "from": off, "len": min(total, dur - off), "fadeIn": float(bd["startFadeSec"]), "fadeOut": float(bd["endFadeSec"])})
    else:
        raise ClipError(f"music mode {mode} is not known")
    beats = []
    for s in segs:
        k0 = math.ceil((s["from"] - off) / beat - 1e-9)
        t = off + k0 * beat
        while t < s["from"] + s["len"]:
            beats.append(round(s["at"] + (t - s["from"]), 3))
            t += beat
    return {"mode": mode, "total": round(total, 3), "levelDb": float(level_db), "track": track["id"], "name": track.get("name"),
            "bpm": bpm, "segments": [{k: round(v, 3) for k, v in s.items()} for s in segs], "beats": beats}


def render(rec, track, cfg=None):
    """The bed as float stereo (n, 2) at 48 kHz, as long as the reel, at rec.levelDb integrated LUFS (of the music
    where it plays; silence between the segments is gated out), peaks under the ceiling."""
    np = _np()
    from scene_music import normalise  # noqa: PLC0415
    cfg = cfg or load_config()
    need = max(s["from"] + s["len"] for s in rec["segments"])
    x = decode(track["file"], SR, 2, max_sec=need + 0.5).astype(np.float64)
    n = int(round(rec["total"] * SR))
    out = np.zeros((n, 2))
    for s in rec["segments"]:
        a, f, ln = int(round(s["at"] * SR)), int(round(s["from"] * SR)), int(round(s["len"] * SR))
        seg = x[f:f + ln].copy()
        ln = min(len(seg), n - a)
        if ln <= 0:
            continue
        seg = seg[:ln]
        fi, fo = min(ln, int(s["fadeIn"] * SR)), min(ln, int(s["fadeOut"] * SR))
        if fi > 0:
            seg[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
        if fo > 0:
            seg[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
        out[a:a + ln] += seg
    if float(np.abs(out).max(initial=0.0)) > 0:
        out = normalise(out, float(rec["levelDb"]), float(cfg["bed"]["peakCeilingDb"]))
    return out


def write_wav(path, x):
    np = _np()
    pcm = np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2")
    tmp = path + ".part"
    with wave.open(tmp, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    os.replace(tmp, path)


def prepare(wd, rec, track, cfg, duck):
    """Writes wd/music.wav -> the dict clip_montage.render_argv(music=) takes."""
    write_wav(os.path.join(wd, WAV), render(rec, track, cfg))
    return {"file": WAV, "duck": duck}
