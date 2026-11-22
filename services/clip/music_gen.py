# SPDX-License-Identifier: GPL-3.0-or-later
"""FX6 local AI music (plan docs/plan/2026-11-21-clip-music-name-transitions.md 3.4, spike
docs/evidence/2026-11-22-fx6-ace-step-spike.md): when the clip look's "ai" source is ticked and no folder or pack
track fits a reel, one instrumental is made for the reel's target with ACE-Step 1.5 on this PC.

The runtime (its own Python 3.12, torch, weights) lives outside the repo; its folder is local data, never code:
env UJWALAM_ACESTEP_RUNTIME, else data/profile.local.json paths.acestep_runtime. No folder, or no Python in it: the
source is simply unavailable. The work runs in a child process (services/clip/ace_worker.py with the runtime's
Python, no window, below-normal priority, in a kill-on-close job), so the model is unloaded when it ends.

Guards, each a clean "not made" (the caller then uses the made-here bed): never while live or when the live state is
unknown, also stopped if a stream starts while it runs; one heavy clip job at a time (clip_common.HeavyJobLock);
free GPU memory checked first (data/clip/music-gen.json minFreeMB). A stored track for the same target is used again
before anything is made. Tracks: <data>/music/generated/<id>.wav + <id>.json (prompt, seed, tempo, model revision,
licence note). The render record says source "made-here" with generator "ace-step-1.5", so posting treats it exactly
like the made-here bed (no credit line).

  runtime_dir(env=None, profile=PROFILE_FILE)      -> folder or None
  runtime_python(cfg, env=None, profile=...)       -> the runtime's python.exe or None (= unavailable)
  request_for(target, need_sec, cfg)               -> {"id", "mood", "bpm", "energy", "seconds", "caption", "seed"}
  stored(data_dir, cfg)                            -> [usable stored tracks]
  make(data_dir, target, need_sec, mlcfg, ...)     -> (track or None, why)
  record(track)                                    -> the render record fields (source made-here + generator)
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess

from clip_common import (CLIP_DATA, NO_JOB_RC, NO_WINDOW, PROFILE_FILE, STOPPED_RC, ClipError, HeavyJobLock, eprint,
                         load_json, on_air, run_tool, write_json_atomic)

CONFIG_FILE = os.path.join(CLIP_DATA, "music-gen.json")
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ace_worker.py")
ENV_RUNTIME = "UJWALAM_ACESTEP_RUNTIME"
SOURCE = "ai"  # the clip look's source id (data/clip/look.json sources)


def load_config(path=None):
    cfg = load_json(path or CONFIG_FILE)
    if not cfg.get("moods") or int(cfg["seconds"]["min"]) > int(cfg["seconds"]["max"]):
        raise ClipError("music-gen.json: moods are missing or the seconds range is empty")
    return cfg


def runtime_dir(env=None, profile=PROFILE_FILE):
    """The ACE-Step runtime folder from env UJWALAM_ACESTEP_RUNTIME, else the local profile's paths.acestep_runtime;
    None when neither names an existing folder (a <placeholder> counts as not set)."""
    v = (env if env is not None else os.environ).get(ENV_RUNTIME)
    if not v:
        try:
            v = load_json(profile).get("paths", {}).get("acestep_runtime")
        except (OSError, ClipError, AttributeError, ValueError):
            v = None
    if not isinstance(v, str) or not v or (v.startswith("<") and v.endswith(">")):
        return None
    return os.path.abspath(v) if os.path.isdir(v) else None


def runtime_python(cfg=None, env=None, profile=PROFILE_FILE):
    rt = runtime_dir(env, profile)
    if not rt:
        return None
    cfg = cfg or load_config()
    p = os.path.join(rt, *cfg["python"].split("/"))
    return p if os.path.isfile(p) else None


def folder(data_dir, cfg):
    return os.path.join(data_dir, *cfg["folder"].split("/"))


def request_for(target, need_sec, cfg=None):
    """What to make for a reel target ({"energy", "moods"} from music_library.target_for): the first mood of the
    target that has a recipe, its tempo, energy words, the length (the reel, within seconds.min..max; a full bed loops
    whole bars past it), a seed and an id from all of these (the same target = the same id = the stored track)."""
    cfg = cfg or load_config()
    mood = next((m for m in target.get("moods") or [] if m in cfg["moods"]), next(iter(cfg["moods"])))
    energy = float(target.get("energy", 0.5))
    words = next((e["words"] for e in cfg["energy"] if energy < float(e["below"])), cfg["energy"][-1]["words"])
    sec = int(max(int(cfg["seconds"]["min"]), min(int(cfg["seconds"]["max"]), -(-float(need_sec) // 10) * 10)))
    recipe = cfg["moods"][mood]
    caption = cfg["caption"].format(style=recipe["style"], energy=words)
    key = "|".join([cfg["generator"], cfg["modelRevision"], cfg["config"], mood, str(recipe["bpm"]), caption, str(sec)])
    h = hashlib.sha256(key.encode("utf-8")).digest()
    return {"id": "gen-" + h[:8].hex(), "mood": mood, "bpm": int(recipe["bpm"]), "energy": round(energy, 3),
            "energyWords": words, "seconds": sec, "caption": caption, "seed": int.from_bytes(h[8:12], "big") & 0x7FFFFFFF}


def _track(path_json, root):
    t = load_json(path_json)
    wav = os.path.join(root, t["id"] + ".wav")
    if not (isinstance(t, dict) and t.get("bpm") and os.path.isfile(wav)):
        return None
    return dict(t, file=wav, root=root)


def stored(data_dir, cfg=None):
    """The stored generated tracks (each with file and root), oldest first by name."""
    cfg = cfg or load_config()
    root = folder(data_dir, cfg)
    out = []
    try:
        names = sorted(n for n in os.listdir(root) if n.startswith("gen-") and n.endswith(".json"))
    except OSError:
        return []
    for n in names:
        try:
            t = _track(os.path.join(root, n), root)
        except (OSError, ClipError, KeyError, ValueError, TypeError):
            t = None
        if t:
            out.append(t)
    return out


def free_vram_mb():
    """Free memory of the first NVIDIA GPU in MiB (nvidia-smi, no window), or None when it cannot be read."""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL, **NO_WINDOW)
        return int(r.stdout.strip().splitlines()[0]) if r.returncode == 0 else None
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _off_air(live):
    try:
        return live() is False
    except Exception:  # noqa: BLE001 - cannot tell: treat as live
        return False


def tempo_fix(measured, asked, tol=0.03):
    """The beat grid of a generated track: the measured tempo, doubled or halved when that lands within tol of the asked
    tempo (FX6 real run: a 140 BPM phonk track measured 70.31, half time; the beat offset stays on the grid either
    way). Else the measured tempo as it is."""
    for f in (1.0, 2.0, 0.5):
        if abs(float(measured) * f - float(asked)) <= tol * float(asked):
            return round(float(measured) * f, 2)
    return float(measured)


def record(track):
    """Render record fields of a generated track: made here (posting: no credit line), plus what made it."""
    g = track.get("generated") or {}
    return {"source": "made-here", "generator": g.get("generator"), "track": track["id"],
            "generated": {k: g.get(k) for k in ("caption", "seed", "bpm", "mood", "modelRevision", "licence")}}


def make(data_dir, target, need_sec, mlcfg, cfg=None, live=on_air, vram=free_vram_mb, lock_dir=None, python=None,
         worker=WORKER, env=None, profile=PROFILE_FILE):
    """The generated track for this target -> (track or None, why). A stored track with the same id is used again
    first; else one is made if every guard passes. Never raises: any failure is (None, why)."""
    try:
        cfg = cfg or load_config()
        req = request_for(target, need_sec, cfg)
    except (OSError, ClipError, KeyError, ValueError, TypeError) as e:
        return None, f"music-gen.json not read ({str(e)[-100:]})"
    root = folder(data_dir, cfg)
    try:
        t = _track(os.path.join(root, req["id"] + ".json"), root)
        if t:
            return t, "stored"
    except (OSError, ClipError, KeyError, ValueError, TypeError):
        pass
    py = python or runtime_python(cfg, env, profile)
    if not py:
        return None, "no AI music runtime is set up on this PC"
    if not _off_air(live):
        return None, "live, or the live state is unknown"
    free = vram()
    if free is None or free < int(cfg["minFreeMB"]):
        return None, f"not enough free GPU memory ({free} MB free, {cfg['minFreeMB']} MB needed)"
    rt = runtime_dir(env, profile) or os.path.dirname(py)
    try:
        os.makedirs(root, exist_ok=True)
        with HeavyJobLock(lock_dir, job="music-gen"):
            return _run(data_dir, root, req, cfg, mlcfg, py, worker, rt, live)
    except ClipError as e:
        return None, str(e)[-160:]
    except OSError as e:
        return None, f"not made ({str(e)[-120:]})"


def _run(data_dir, root, req, cfg, mlcfg, py, worker, rt, live):
    import music_library as mlib  # noqa: PLC0415 - numpy only when a track is really made
    wav = os.path.join(root, req["id"] + ".wav")
    part, job, res = wav + ".part.wav", os.path.join(root, req["id"] + ".job.json"), os.path.join(root, req["id"] + ".result.json")
    for p in (part, res):
        if os.path.exists(p):
            os.remove(p)
    write_json_atomic(job, {"caption": req["caption"], "bpm": req["bpm"], "seconds": req["seconds"], "seed": req["seed"],
                            "out": part, "result": res, "config": cfg["config"], "quantization": cfg["quantization"],
                            "offloadToCpu": bool(cfg["offloadToCpu"])})
    try:
        r = run_tool([py, "-I", worker, job], cwd=rt, timeout=float(cfg["timeoutSec"]),
                     stop=lambda: not _off_air(live))
    except subprocess.TimeoutExpired:
        return None, f"took longer than {cfg['timeoutSec']} s"
    finally:
        try:
            os.remove(job)
        except OSError:
            pass
    if r.returncode == STOPPED_RC:
        return None, "stopped: on air"
    if r.returncode == NO_JOB_RC:
        return None, "not started (Windows refused the child job)"
    try:
        out = load_json(res)
    except (OSError, ClipError, ValueError):
        out = {}
    finally:
        try:
            os.remove(res)
        except OSError:
            pass
    if r.returncode != 0 or not out.get("ok") or not os.path.isfile(part):
        why = out.get("error") or (r.stderr or "").strip()[-200:] or f"exit {r.returncode}"
        if os.path.exists(part):
            os.remove(part)
        return None, f"not made ({why})"
    os.replace(part, wav)
    try:
        facts = mlib.analyse(wav, mlcfg, root)
    except Exception as e:  # noqa: BLE001 - an unreadable result is not used
        os.remove(wav)
        return None, f"made but not readable ({type(e).__name__}: {str(e)[-100:]})"
    facts = dict(facts, bpmMeasured=facts["bpm"], bpm=tempo_fix(facts["bpm"], req["bpm"]))
    meta = {"generator": cfg["generator"], "codeRevision": cfg["codeRevision"], "modelRevision": cfg["modelRevision"],
            "config": cfg["config"], "caption": req["caption"], "seed": req["seed"], "bpm": req["bpm"], "mood": req["mood"],
            "energy": req["energy"], "seconds": req["seconds"], "licence": cfg["licence"],
            "madeSec": out.get("seconds"), "loadSec": out.get("loadSeconds"), "torchPeakMB": out.get("torchPeakMB")}
    # the mood is the one asked for, not re-guessed (spike: a phonk track read as edm)
    t = dict(facts, id=req["id"], name=f"made on this PC ({req['mood']}, {req['bpm']} BPM)", licence=cfg["licence"],
             mood=req["mood"], moodGuess=facts.get("mood"), generated=meta)
    write_json_atomic(os.path.join(root, req["id"] + ".json"), t)
    eprint(f"music: made {req['id']} ({req['mood']}, {req['bpm']} BPM, {req['seconds']} s) in {out.get('seconds')} s")
    return dict(t, file=wav, root=root), "made"
