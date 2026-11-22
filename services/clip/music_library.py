# SPDX-License-Identifier: GPL-3.0-or-later
"""FX4 music library (D411, plan docs/plan/2026-11-21-clip-music-name-transitions.md 3.4): tracks from the user's own
music folder, analysed once off air with PyAV + numpy, matched to each reel by energy and mood, and laid under the reel
as one WAV in one of three modes (intro-outro, drop, full-bed) at the user's level (default -16 LUFS integrated, of the
music where it plays). No network: nothing is downloaded here. FX5 (D427): the free music pack the user downloads in
Settings > Downloads (item music-pack, <data>/music/pack) is a second library with its own file; only tracks listed in
the pack's manifest, present in the pack folder and recorded in the download's marker count, and each carries its
credit (artist, title, licence, track page) from the manifest. Local AI music is FX6, later. Data:
data/clip/music-library.json; libraries: <data>/music/library.json and <data>/music/pack-library.json.

  analyse(path, cfg)                         -> track facts (bpm, beat offset, energy curve, drop, loudness, mood, ...)
  refresh(data_dir, folder, cfg, live=None)  -> library (new files analysed, gone files dropped; never while live)
  load_library(data_dir)                     -> library dict
  pack_files(data_dir, cfg)                  -> {path: credit} of the downloaded pack (manifest + marker)
  refresh_pack(data_dir, cfg, live=None)     -> the pack's library (same analysis and limits as the folder)
  usable_pack(lib, data_dir, cfg)            -> the pack tracks that can be used, each with its credit
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
import stat
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


# ---------------------------------------------------------------- the folder: no links, nothing outside it

REPARSE = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def is_link(path):
    """True for a symbolic link, a junction or any other Windows reparse point (never followed: a link could lead
    out of the music folder). An entry that cannot be read counts as a link."""
    try:
        st = os.lstat(path)
    except OSError:
        return True
    return stat.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & REPARSE)


def inside(path, folder):
    """True when path, fully resolved, is a plain file inside the fully resolved folder (checked right before a track
    is opened: Codex review, a link or a swapped file never lets a file outside the folder be read)."""
    if not folder or is_link(path):
        return False
    try:
        root = os.path.realpath(folder)
        real = os.path.realpath(path)
        return os.path.commonpath([os.path.normcase(root), os.path.normcase(real)]) == os.path.normcase(root) \
            and real != root and os.path.isfile(real)
    except (OSError, ValueError):
        return False


def _open_checked(path, folder):
    if not inside(path, folder):
        raise ClipError(f"{os.path.basename(path)}: not a plain file inside the music folder (links are not followed)")
    return path


# ---------------------------------------------------------------- decode and analyse

def decode(path, sr=SR, channels=2, max_sec=None, open_kw=None, guard=None):
    """-> float32 array (n, channels) at sr, from any file PyAV/FFmpeg can read."""
    import av  # noqa: PLC0415
    np = _np()
    chunks = []
    with av.open(path, **(open_kw or {})) as c:  # open_kw: the reel style analyser's safe open (format, options)
        st = next((s for s in c.streams if s.type == "audio"), None)
        if st is None:
            raise ClipError(f"{os.path.basename(path)}: no sound")
        rs = av.AudioResampler(format="flt", layout="stereo" if channels == 2 else "mono", rate=sr)
        got = 0
        for fr in c.decode(st):
            if guard:  # the reel style analyser's guard: every decoded sound frame (caps, time, on air)
                guard.tick()
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
    x = np.concatenate(chunks).astype(np.float32, copy=False)  # PyAV gives float32 already: no extra copy
    del chunks
    return x[: int(max_sec * sr)] if max_sec else x


def _onsets(mono, sr):
    """Spectral-flux onset envelope -> (envelope, frames per second, spectral centroid Hz)."""
    np = _np()
    n_fft, hop = 2048, 1024
    if len(mono) < n_fft * 4:
        raise ClipError("track too short to analyse")
    frames = 1 + (len(mono) - n_fft) // hop
    win = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    flux = np.zeros(frames)
    num = den = 0.0
    prev = None
    batch = 256  # bounded memory (Codex review): 256 frames of 2048 at a time, never the whole track's matrix
    for f0 in range(0, frames, batch):
        f1 = min(frames, f0 + batch)
        idx = np.arange(n_fft)[None, :] + hop * np.arange(f0, f1)[:, None]
        mag = np.abs(np.fft.rfft(mono[idx] * win[None, :], axis=1))
        lm = np.log1p(10.0 * mag)
        if prev is not None:
            lm_all = np.vstack([prev, lm])
            flux[f0:f1] = np.maximum(0.0, np.diff(lm_all, axis=0)).sum(axis=1)
        else:
            flux[f0 + 1:f1] = np.maximum(0.0, np.diff(lm, axis=0)).sum(axis=1)
        prev = lm[-1:]
        num += float((mag * freqs[None, :]).sum())
        den += float(mag.sum())
    return flux, sr / hop, num / max(1e-9, den)


def tempo(env, rate, cfg):
    """BPM and beat offset (s) from an onset envelope: autocorrelation over the BPM range with a soft preference for
    cfg.bpm.prefer (octave errors), then the phase whose beats hold the most onset strength."""
    np = _np()
    e = env - env.mean()
    lo, hi = float(cfg["bpm"]["min"]), float(cfg["bpm"]["max"])
    lags = np.arange(max(1, int(rate * 60.0 / hi)) - 1, int(rate * 60.0 / lo) + 2)  # +-1 for the refinement
    lags = lags[(lags >= 1) & (lags < len(e) - 1)]
    ac = np.zeros(int(lags.max()) + 2 if len(lags) else 1)
    for lg in lags:  # only the lags of the BPM range (Codex review), not the full autocorrelation
        ac[lg] = float(np.dot(e[:-lg], e[lg:]))
    lags = lags[1:-1] if len(lags) > 2 else lags
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
    m = mono[: k * n].reshape(k, n)
    rms = np.sqrt(np.einsum("ij,ij->i", m, m, dtype=np.float64) / n + 1e-12)  # no squared copy of the track
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


def analyse(path, cfg, root=None, open_kw=None, guard=None):
    """Facts of one track. Raises ClipError when it cannot be read, is too short, or (root given) is not a plain file
    inside root."""
    np = _np()
    if root is not None:
        _open_checked(path, root)
    from scene_music import measure_lufs  # noqa: PLC0415 - BS.1770 integrated loudness at 48 kHz
    mono = decode(path, SR, 1, max_sec=float(cfg["maxAnalyseSec"]), open_kw=open_kw, guard=guard)[:, 0]  # mono float32: bounded memory
    dur = len(mono) / SR
    if dur < float(cfg["minTrackSec"]):
        raise ClipError(f"{os.path.basename(path)}: shorter than {cfg['minTrackSec']:g} s")
    env, rate, centroid = _onsets(mono, SR)
    bpm, offset = tempo(env, rate, cfg)
    energy = _energy(mono, SR)
    drop, rise = _drop(energy, 0.5, dur)
    beat = 60.0 / bpm
    drop = round(float(offset + round((drop - offset) / beat) * beat), 3)  # on a beat
    mid = int(len(mono) / 2)
    part = mono[max(0, mid - 10 * SR): mid + 10 * SR].astype(np.float64)  # the middle 20 s: a guide value only
    # one channel, +3.01 dB = the same mono signal on both channels (BS.1770 sums channels); the bed is measured
    # again when it is made
    loud = measure_lufs(part[:, None]) + 10.0 * math.log10(2.0)
    e = sorted(energy)
    dyn = (e[int(0.95 * (len(e) - 1))] - e[int(0.10 * (len(e) - 1))]) if e else 0.0
    level = max(0.0, min(1.0, 0.45 * (bpm - 70.0) / 110.0 + 0.55 * min(1.0, _onset_rate(env, rate) / 6.0)))
    return {"duration": round(dur, 3), "bpm": bpm, "beatOffset": offset, "drop": max(0.0, min(drop, dur)),
            "dropRiseDb": rise, "energy": energy, "loudnessLufs": round(loud, 2), "centroidHz": round(centroid, 1),
            "dynamicsDb": round(float(dyn), 2), "energyLevel": round(float(level), 3),
            "mood": guess_mood(bpm, level, centroid, dyn)}


# ---------------------------------------------------------------- the library file

def _lib_path(data_dir, cfg, rel=None):
    return os.path.join(data_dir, *(rel or cfg["library"]).split("/"))


def load_library(data_dir, cfg=None, rel=None):
    cfg = cfg or load_config()
    try:
        j = load_json(_lib_path(data_dir, cfg, rel))
    except (OSError, ClipError):
        return {"version": 1, "folder": None, "tracks": []}
    return j if isinstance(j, dict) and isinstance(j.get("tracks"), list) else {"version": 1, "folder": None, "tracks": []}


def _track_id(path, st):
    """Path + size + mtime in ns + the first and last 64 KiB (Codex review: a file changed within the same second, or
    copied over with its old time, is analysed again)."""
    h = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}".encode("utf-8"))
    with open(path, "rb") as f:
        h.update(f.read(65536))
        if st.st_size > 65536:
            f.seek(max(65536, st.st_size - 65536))
            h.update(f.read(65536))
    return h.hexdigest()[:16]


def list_files(folder, cfg):
    exts = tuple(cfg["extensions"])
    out = []
    for root, dirs, files in os.walk(folder, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not is_link(os.path.join(root, d)))  # no linked or junction folders
        for f in sorted(files):
            p = os.path.join(root, f)
            if f.lower().endswith(exts) and not is_link(p):
                out.append(p)
                if len(out) >= int(cfg["maxFiles"]):
                    return out
    return out


def _on_air(live):
    try:
        return bool(live()) if live else False
    except Exception:  # noqa: BLE001 - cannot tell: treat as live
        return True


def refresh(data_dir, folder, cfg=None, live=None):
    """Adds new tracks of the folder (at most maxNewPerRun per call), drops gone ones, keeps the user's moods. Nothing
    is analysed while live (live() true or unknown): the library is returned as it is."""
    cfg = cfg or load_config()
    lib = load_library(data_dir, cfg)
    if not folder or not os.path.isdir(folder):
        return lib
    if _on_air(live):
        return lib
    return _scan(data_dir, folder, list_files(folder, cfg), lib, cfg, cfg["library"], cfg["licence"])


def _scan(data_dir, folder, files, lib, cfg, rel, licence, extra=None):
    """The shared refresh of one library file: files (inside folder) analysed when new, gone ones dropped."""
    old = {t["id"]: t for t in lib["tracks"] if lib.get("folder") == folder}
    tracks, new = [], 0
    for p in files:
        try:
            if not inside(p, folder):
                continue
            st = os.stat(p)
            tid = _track_id(p, st)
        except OSError:
            continue
        if tid in old:
            tracks.append(old[tid])
            continue
        if new >= int(cfg["maxNewPerRun"]):
            continue
        new += 1
        row = {"id": tid, "file": p, "name": os.path.splitext(os.path.basename(p))[0], "licence": licence}
        if extra:
            row.update(extra(p))
        try:
            row.update(analyse(p, cfg, folder))
        except (ClipError, OSError, ValueError, MemoryError) as e:
            row["error"] = str(e)[-160:]
        except Exception as e:  # noqa: BLE001 - a broken file never stops the clip run
            row["error"] = f"{type(e).__name__}: {str(e)[-120:]}"
        tracks.append(row)
    lib = {"version": 1, "folder": folder, "tracks": tracks}
    os.makedirs(os.path.dirname(_lib_path(data_dir, cfg, rel)), exist_ok=True)
    write_json_atomic(_lib_path(data_dir, cfg, rel), lib)
    return lib


# ---------------------------------------------------------------- the free music pack (FX5, D427)

def pack_dir(data_dir, cfg):
    return os.path.join(data_dir, *cfg["pack"]["folder"].split("/"))


def pack_manifest(cfg):
    """{file name: credit + bytes} from the pack's download manifest (repo data/downloads): only rows with a plain file
    name of a known sound type and a plain artist, title, licence and https track page."""
    pk = cfg["pack"]
    try:
        doc = load_json(os.path.join(os.path.dirname(CLIP_DATA), *pk["manifest"].split("/")))
    except (OSError, ClipError, ValueError):
        return {}
    item = next((i for i in doc.get("items") or [] if isinstance(i, dict) and i.get("id") == pk["item"]), None)
    out = {}
    for f in (item or {}).get("files") or []:
        if not isinstance(f, dict):
            continue
        name = f.get("name")
        if not (isinstance(name, str) and name == os.path.basename(name) and name.lower().endswith(tuple(cfg["extensions"]))):
            continue
        credit = {"artist": f.get("artist"), "title": f.get("title"), "licence": f.get("licence"), "fma": f.get("fma")}
        sha = f.get("sha256")
        if all(isinstance(v, str) and v.strip() for v in credit.values()) and credit["fma"].startswith("https://") \
                and isinstance(sha, str) and len(sha) == 64 and isinstance(f.get("bytes"), int):
            out[name] = dict(credit, bytes=f["bytes"], sha256=sha.lower())
    return out


def pack_folder_ok(data_dir, cfg):
    """True when the pack folder is a real folder at its expected place: no link or junction on any step from the data
    root down, and its fully resolved path equals the expected one (Codex review: a junction to an outside folder with
    its own marker never counts as the pack)."""
    folder = pack_dir(data_dir, cfg)
    p = os.path.abspath(data_dir)
    for part in cfg["pack"]["folder"].split("/"):
        p = os.path.join(p, part)
        if is_link(p) or not os.path.isdir(p):
            return False
    try:
        return os.path.normcase(os.path.realpath(folder)) == os.path.normcase(os.path.join(os.path.realpath(data_dir),
                                                                                           *cfg["pack"]["folder"].split("/")))
    except (OSError, ValueError):
        return False


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _verified(data_dir, cfg, p, name, want, st):
    """True when the file's SHA-256 equals the manifest's. Hashed once per size + modified time (cache file
    cfg.pack.hashes in the data root), so a run does not hash the pack again."""
    cache_f = os.path.join(data_dir, *cfg["pack"]["hashes"].split("/"))
    try:
        cache = load_json(cache_f)
        cache = cache if isinstance(cache, dict) else {}
    except (OSError, ClipError, ValueError):
        cache = {}
    e = cache.get(name)
    if isinstance(e, dict) and e.get("size") == st.st_size and e.get("mtimeNs") == st.st_mtime_ns and isinstance(e.get("sha256"), str):
        return e["sha256"] == want
    try:
        got = _sha256(p)
    except OSError:
        return False
    cache[name] = {"size": st.st_size, "mtimeNs": st.st_mtime_ns, "sha256": got}
    try:
        os.makedirs(os.path.dirname(cache_f), exist_ok=True)
        write_json_atomic(cache_f, cache)
    except OSError:
        pass
    return got == want


def pack_files(data_dir, cfg=None):
    """{path: credit} of the pack tracks that count: in the manifest, a plain file inside the pack folder, and listed
    in the download's marker with the file's own size (and the manifest's size), and its SHA-256 equals the manifest's.
    The folder itself must be the real pack folder (pack_folder_ok). No marker: none (the download is not
    finished, or was never asked for)."""
    cfg = cfg or load_config()
    folder = pack_dir(data_dir, cfg)
    if not pack_folder_ok(data_dir, cfg):
        return {}
    try:
        marker = load_json(os.path.join(folder, cfg["pack"]["marker"]))
    except (OSError, ClipError, ValueError):
        return {}
    done = marker.get("files") if isinstance(marker, dict) else None
    if not isinstance(done, dict):
        return {}
    out = {}
    for name, credit in pack_manifest(cfg).items():
        p = os.path.join(folder, name)
        e = done.get(name)
        if not isinstance(e, dict) or not inside(p, folder):
            continue
        try:
            st = os.stat(p)
        except OSError:
            continue
        if e.get("size") != st.st_size or credit["bytes"] != st.st_size:
            continue
        if not _verified(data_dir, cfg, p, name, credit["sha256"], st):  # Codex review: the bytes, not only the size
            continue
        out[p] = dict({k: credit[k] for k in ("artist", "title", "licence", "fma")}, file=name)
    return out


def refresh_pack(data_dir, cfg=None, live=None):
    """The pack's library (its own file, cfg.pack.library): the same analysis and limits as the folder, never while
    live. A pack that is not downloaded leaves the library as it is (usable_pack then gives no tracks)."""
    cfg = cfg or load_config()
    rel = cfg["pack"]["library"]
    lib = load_library(data_dir, cfg, rel)
    files = pack_files(data_dir, cfg)
    if not files or _on_air(live):
        return lib
    return _scan(data_dir, pack_dir(data_dir, cfg), sorted(files), lib, cfg, rel, cfg["pack"]["licence"],
                 extra=lambda p: {"pack": files[p]})


def usable_pack(lib, data_dir, cfg=None):
    """The pack tracks that can be used now (usable() and still counted by pack_files), each with its credit from the
    manifest as it is now."""
    cfg = cfg or load_config()
    norm = lambda p: os.path.normcase(os.path.abspath(p))  # noqa: E731
    if not lib.get("folder") or norm(lib["folder"]) != norm(pack_dir(data_dir, cfg)):
        return []
    files = {norm(p): c for p, c in pack_files(data_dir, cfg).items()}
    out = []
    for t in usable(lib):
        c = files.get(norm(t.get("file", "")))
        if c:
            out.append(dict(t, pack=c))
    return out


def usable(lib):
    """The tracks that can be used, each with root = the library's folder (checked again when it is opened)."""
    root = lib.get("folder")
    return [dict(t, root=root) for t in lib.get("tracks") or []
            if not t.get("error") and t.get("bpm") and inside(t.get("file", ""), root)]


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


def match(tracks, target, need_sec, seed_parts, recent=(), cfg=None, n_avoid=3, prefer_long=False):
    """(track, score) for this reel, or (None, best score) when nothing reaches the threshold. Seeded, weighted by
    score^sharpness; the last n_avoid tracks are left out while another fits."""
    cfg = cfg or load_config()
    scored = [(score(t, target, need_sec, cfg), t) for t in tracks]
    ok = [(s, t) for s, t in scored if s >= float(cfg["score"]["threshold"])]
    if not ok:
        return None, round(max((s for s, _ in scored), default=0.0), 3)
    if prefer_long:  # full bed / drop: a track as long as the reel is used while one fits (else it loops, render)
        ok = [(s, t) for s, t in ok if float(t.get("duration", 0)) - float(t.get("beatOffset", 0)) >= need_sec] or ok
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
        segs.append({"at": r0, "from": src, "len": total - r0,  # a short track loops (render), never silence
                     "fadeIn": float(bd["dropLeadFadeSec"]) if r0 > 0 else float(bd["startFadeSec"]), "fadeOut": float(bd["endFadeSec"])})
    elif mode == "full-bed":
        segs.append({"at": 0.0, "from": off, "len": total, "fadeIn": float(bd["startFadeSec"]), "fadeOut": float(bd["endFadeSec"])})
    else:
        raise ClipError(f"music mode {mode} is not known")
    beats = []
    for s in segs:
        k0 = math.ceil((s["from"] - off) / beat - 1e-9)
        t = off + k0 * beat
        while t < s["from"] + s["len"]:
            beats.append(round(s["at"] + (t - s["from"]), 3))
            t += beat
    out = {"mode": mode, "total": round(total, 3), "levelDb": float(level_db), "track": track["id"], "name": track.get("name"),
           "bpm": bpm, "segments": [{k: round(v, 3) for k, v in s.items()} for s in segs], "beats": beats}
    if any(s["from"] + s["len"] > dur - 0.01 for s in segs):  # Codex review: loop whole bars, crossfaded on a beat
        bar = 4.0 * beat
        xf = round(min(0.25, beat / 2.0), 3)
        bars = max(1, int((dur - off - xf) / bar))
        out["loop"] = {"a": round(off, 3), "b": round(off + bars * bar, 3), "xf": xf}
    return out


def render(rec, track, cfg=None):
    """The bed as float stereo (n, 2) at 48 kHz, as long as the reel, at rec.levelDb integrated LUFS (of the music
    where it plays; silence between the segments is gated out), peaks under the ceiling."""
    np = _np()
    from scene_music import normalise  # noqa: PLC0415
    cfg = cfg or load_config()
    _open_checked(track["file"], track.get("root"))  # right before opening: still a plain file inside the folder
    need = max(s["from"] + s["len"] for s in rec["segments"]) + 0.5
    if rec.get("loop"):
        need = min(need, float(rec["loop"]["b"]) + float(rec["loop"]["xf"]) + 0.5)
    x = decode(track["file"], SR, 2, max_sec=need).astype(np.float64)
    n = int(round(rec["total"] * SR))
    out = np.zeros((n, 2))
    for s in rec["segments"]:
        a, f, ln = int(round(s["at"] * SR)), int(round(s["from"] * SR)), int(round(s["len"] * SR))
        seg = take(x, f, ln, rec.get("loop"))
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


def take(x, f, ln, loop=None):
    """ln samples of x from sample f. Past the end of the track (or of the loop): the loop's whole bars again, each
    seam crossfaded over xf so the beat grid runs on (D411: never silence under a full bed). -> new array."""
    np = _np()
    if not loop or f + ln <= len(x):
        return x[f:f + ln].copy()
    la, lb, xf = int(round(loop["a"] * SR)), int(round(loop["b"] * SR)), max(1, int(round(loop["xf"] * SR)))
    lb = min(lb, len(x) - xf)
    if lb - la <= 2 * xf:
        raise ClipError("music: the track is too short to loop")
    if f >= lb:  # Codex verify: a segment that starts past the loop end starts at the same place inside the loop
        f = la + (f - la) % (lb - la)
    fade = np.linspace(0.0, 1.0, xf)[:, None]
    end = lb + xf
    y = x[f:end].copy()
    while len(y) < ln + xf:
        c = x[la:lb + xf]
        y[-xf:] = y[-xf:] * (1.0 - fade) + c[:xf] * fade
        y = np.concatenate([y, c[xf:]])
    return y[:ln]


def write_wav(path, x):
    np = _np()
    pcm = np.clip(np.rint(x * 32767.0), -32768, 32767).astype("<i2")
    tmp = path + ".part"
    try:
        with wave.open(tmp, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        os.replace(tmp, path)
    except BaseException:  # Codex BD5 verify: a failed write (disk full, stop) leaves no music.wav.part behind
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def prepare(wd, rec, track, cfg, duck):
    """Writes wd/music.wav -> the dict clip_montage.render_argv(music=) takes."""
    write_wav(os.path.join(wd, WAV), render(rec, track, cfg))
    return {"file": WAV, "duck": duck}
