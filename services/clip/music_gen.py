# SPDX-License-Identifier: GPL-3.0-or-later
"""FX6 local AI music (plan docs/plan/2026-11-21-clip-music-name-transitions.md 3.4, spike
docs/evidence/2026-11-22-fx6-ace-step-spike.md, D429): when the clip look's "ai" source is ticked and no folder or pack
track fits a reel, one instrumental is made for the reel's target with ACE-Step 1.5 on this PC.

The runtime (its own Python 3.12, torch, weights) lives outside the repo; its folder is local data, never code: env
UJWALAM_ACESTEP_RUNTIME, else the user setting clips.look.music.aiRuntime (Settings > Clips, "Choose folder..."). No
folder, or no Python in it: nothing new is made (stored tracks are still reused). The work runs in a child process
(services/clip/ace_worker.py with the runtime's Python, no window, below-normal priority, in a kill-on-close job), so
the model is unloaded when it ends.

Guards, each a clean "not made" (the caller then uses the made-here bed): never while live or when the live state is
unknown (checked first, again inside the heavy-job lock right before the child starts, and while it runs); one heavy
clip job at a time (clip_common.HeavyJobLock); free GPU memory checked first (data/clip/music-gen.json minFreeMB).
Every failure removes the partial WAV, the job, the result and the worker's work folder.

Stored tracks: <data>/music/generated/<id>.wav + <id>.json. A stored JSON is read field by field (the analysis facts
and the generation facts, each type-checked); every other key is ignored, so a stored file can never make a track
post as anything but made here. record() builds the render record in code: source "made-here" + generator.

  runtime_dir(env=None, data_dir=None)            -> folder or None
  runtime_python(cfg, env=None, data_dir=None)    -> the runtime's python.exe or None
  request_for(target, need_sec, cfg)              -> {"id", "mood", "bpm", "energy", "seconds", "caption", "seed"}
  stored(data_dir, cfg) / stored_track(data_dir, id, cfg) -> checked stored tracks
  make(data_dir, target, need_sec, mlcfg, ...)    -> (track or None, why)
  record(track)                                   -> the render record fields (source made-here + generator)
"""

from __future__ import annotations

import glob
import hashlib
import math
import os
import re
import shutil
import subprocess

from clip_common import (CLIP_DATA, NO_JOB_RC, NO_WINDOW, SETTINGS_FILE, STOPPED_RC, ClipError, HeavyJobLock, eprint,
                         load_json, on_air, run_tool, write_json_atomic)

CONFIG_FILE = os.path.join(CLIP_DATA, "music-gen.json")
WORKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ace_worker.py")
ENV_RUNTIME = "UJWALAM_ACESTEP_RUNTIME"
SOURCE = "ai"  # the clip look's source id (data/clip/look.json sources)
GENERATOR = "ace-step-1.5"
_ID = re.compile(r"^gen-[0-9a-f]{16}$")
_REV = re.compile(r"^[0-9a-f]{40}$")


def load_config(path=None):
    cfg = load_json(path or CONFIG_FILE)
    if not cfg.get("moods") or int(cfg["seconds"]["min"]) > int(cfg["seconds"]["max"]):
        raise ClipError("music-gen.json: moods are missing or the seconds range is empty")
    return cfg


def _setting(data_dir):
    if not data_dir:
        return None
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
        v = j["clips"]["look"]["music"]["aiRuntime"]
    except (OSError, ClipError, KeyError, TypeError, ValueError):
        return None
    import clip_look  # noqa: PLC0415
    return v if clip_look.ai_runtime_ok(v) else None


def runtime_dir(env=None, data_dir=None):
    """The ACE-Step runtime folder: env UJWALAM_ACESTEP_RUNTIME, else clips.look.music.aiRuntime in
    <data>/settings.json; None when neither names an existing folder."""
    v = (env if env is not None else os.environ).get(ENV_RUNTIME) or _setting(data_dir)
    if not isinstance(v, str) or not v:
        return None
    return os.path.abspath(v) if os.path.isdir(v) else None


def runtime_python(cfg=None, env=None, data_dir=None):
    rt = runtime_dir(env, data_dir)
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


# ---------------------------------------------------------------- stored tracks: read field by field

def _num(v, lo, hi):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and lo <= v <= hi


def _str(v, n=400):
    return isinstance(v, str) and 0 < len(v) <= n and not re.search(r"[\x00-\x1f]", v)


def checked_track(doc, tid, cfg):
    """The usable fields of a stored track JSON, type-checked; None when any needed field is wrong. Only these fields
    come through: analysis facts for the bed and the generation facts for the record. Anything else (a "pack" object,
    a credit, a source) is dropped."""
    if not isinstance(doc, dict) or doc.get("id") != tid or not _ID.match(tid):
        return None
    g = doc.get("generated")
    en = doc.get("energy")
    ok = (_num(doc.get("duration"), 1, 3600) and _num(doc.get("bpm"), 30, 300) and _num(doc.get("beatOffset"), 0, 60)
          and _num(doc.get("drop"), 0, 3600) and _num(doc.get("energyLevel"), 0, 1)
          and (doc.get("loudnessLufs") is None or _num(doc.get("loudnessLufs"), -120, 20))
          and isinstance(en, list) and len(en) <= 20000 and all(_num(x, -200, 200) for x in en)
          and isinstance(g, dict) and g.get("generator") == cfg["generator"] and _str(g.get("caption"))
          and isinstance(g.get("seed"), int) and not isinstance(g.get("seed"), bool) and 0 <= g["seed"] < 2**31
          and _num(g.get("bpm"), 30, 300) and g.get("mood") in cfg["moods"]
          and isinstance(g.get("modelRevision"), str) and _REV.match(g["modelRevision"])
          and isinstance(g.get("codeRevision"), str) and _REV.match(g["codeRevision"]))
    if not ok:
        return None
    t = {k: doc[k] for k in ("duration", "bpm", "beatOffset", "drop", "energyLevel", "energy")}
    t.update(loudnessLufs=doc.get("loudnessLufs"), id=tid, mood=g["mood"], licence=cfg["licence"],
             name=f"made on this PC ({g['mood']}, {int(g['bpm'])} BPM)")
    t["generated"] = {"generator": cfg["generator"], "caption": g["caption"], "seed": g["seed"], "bpm": g["bpm"],
                      "mood": g["mood"], "modelRevision": g["modelRevision"], "codeRevision": g["codeRevision"],
                      "licence": cfg["licence"]}
    return t


def stored_track(data_dir, tid, cfg=None):
    cfg = cfg or load_config()
    if not isinstance(tid, str) or not _ID.match(tid):
        return None
    root = folder(data_dir, cfg)
    wav = os.path.join(root, tid + ".wav")
    try:
        t = checked_track(load_json(os.path.join(root, tid + ".json")), tid, cfg)
    except (OSError, ClipError, ValueError, TypeError):
        return None
    if t is None or not os.path.isfile(wav) or os.path.islink(wav):
        return None
    return dict(t, file=wav, root=root)


def stored(data_dir, cfg=None):
    """The checked stored generated tracks (each with file and root), by name."""
    cfg = cfg or load_config()
    try:
        names = sorted(n[:-5] for n in os.listdir(folder(data_dir, cfg)) if n.endswith(".json"))
    except OSError:
        return []
    return [t for t in (stored_track(data_dir, n, cfg) for n in names) if t]


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
    """Render record fields of a generated track, built here and nowhere else: made here (posting: no credit line),
    plus what made it. Nothing else from the track dict is copied."""
    g = track.get("generated") or {}
    return {"source": "made-here", "generator": GENERATOR, "track": track["id"],
            "generated": {k: g.get(k) for k in ("caption", "seed", "bpm", "mood", "modelRevision", "licence")}}


# ---------------------------------------------------------------- making one

def make(data_dir, target, need_sec, mlcfg, cfg=None, live=on_air, vram=free_vram_mb, lock_dir=None, python=None,
         worker=WORKER, env=None, runtime=None):
    """The generated track for this target -> (track or None, why). A stored track with the same id is used again
    first (no runtime needed); else one is made if every guard passes. Never raises: any failure is (None, why)."""
    try:
        cfg = cfg or load_config()
        req = request_for(target, need_sec, cfg)
    except (OSError, ClipError, KeyError, ValueError, TypeError) as e:
        return None, f"music-gen.json not read ({str(e)[-100:]})"
    t = stored_track(data_dir, req["id"], cfg)
    if t:
        return t, "stored"
    py = python or runtime_python(cfg, env, data_dir)
    if not py:
        return None, "no AI music runtime is set up on this PC"
    if not _off_air(live):
        return None, "live, or the live state is unknown"
    free = vram()
    if free is None or free < int(cfg["minFreeMB"]):
        return None, f"not enough free GPU memory ({free} MB free, {cfg['minFreeMB']} MB needed)"
    rt = runtime or runtime_dir(env, data_dir) or os.path.dirname(py)
    root = folder(data_dir, cfg)
    try:
        os.makedirs(root, exist_ok=True)
        with HeavyJobLock(lock_dir, job="music-gen"):
            return _run(root, req, cfg, mlcfg, py, worker, rt, live)
    except ClipError as e:
        return None, str(e)[-160:]
    except OSError as e:
        return None, f"not made ({str(e)[-120:]})"


def _clean(root, rid):
    """Removes everything one make of rid leaves while it runs: part WAV, job, result, the worker's work folders."""
    for p in (os.path.join(root, rid + n) for n in (".part.wav", ".job.json", ".result.json", ".json.part")):
        try:
            os.remove(p)
        except OSError:
            pass
    for w in glob.glob(os.path.join(glob.escape(root), rid + ".work*")):
        shutil.rmtree(w, ignore_errors=True)


def _run(root, req, cfg, mlcfg, py, worker, rt, live):
    import music_library as mlib  # noqa: PLC0415 - numpy only when a track is really made
    rid = req["id"]
    wav, part = os.path.join(root, rid + ".wav"), os.path.join(root, rid + ".part.wav")
    job, res = os.path.join(root, rid + ".job.json"), os.path.join(root, rid + ".result.json")
    _clean(root, rid)
    for p in (wav, os.path.join(root, rid + ".json")):  # only here when no valid stored track: a stale pair goes
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        write_json_atomic(job, {"caption": req["caption"], "bpm": req["bpm"], "seconds": req["seconds"], "seed": req["seed"],
                                "out": os.path.basename(part), "result": os.path.basename(res), "work": rid + ".work",
                                "config": cfg["config"], "quantization": cfg["quantization"],
                                "offloadToCpu": bool(cfg["offloadToCpu"])})
        if not _off_air(live):  # Codex review: again right before the child starts, inside the lock
            return None, "live, or the live state is unknown"
        try:
            r = run_tool([py, "-I", worker, job], cwd=rt, timeout=float(cfg["timeoutSec"]), stop=lambda: not _off_air(live))
        except subprocess.TimeoutExpired:
            return None, f"took longer than {cfg['timeoutSec']} s"
        if r.returncode == STOPPED_RC:
            return None, "stopped: on air"
        if r.returncode == NO_JOB_RC:
            return None, "not started (Windows refused the child job)"
        try:
            out = load_json(res)
        except (OSError, ClipError, ValueError):
            out = {}
        out = out if isinstance(out, dict) else {}
        if r.returncode != 0 or out.get("ok") is not True or not os.path.isfile(part):
            why = out.get("error") if isinstance(out.get("error"), str) else ((r.stderr or "").strip()[-200:] or f"exit {r.returncode}")
            return None, f"not made ({why})"
        try:
            facts = mlib.analyse(part, mlcfg, root)
        except Exception as e:  # noqa: BLE001 - an unreadable result is not used
            return None, f"made but not readable ({type(e).__name__}: {str(e)[-100:]})"
        facts = dict(facts, bpmMeasured=facts["bpm"], bpm=tempo_fix(facts["bpm"], req["bpm"]))
        num = lambda k: out.get(k) if _num(out.get(k), 0, 1e6) else None  # noqa: E731
        meta = {"generator": cfg["generator"], "codeRevision": cfg["codeRevision"], "modelRevision": cfg["modelRevision"],
                "config": cfg["config"], "caption": req["caption"], "seed": req["seed"], "bpm": req["bpm"], "mood": req["mood"],
                "energy": req["energy"], "seconds": req["seconds"], "licence": cfg["licence"],
                "madeSec": num("seconds"), "loadSec": num("loadSeconds"), "torchPeakMB": num("torchPeakMB")}
        # the mood is the one asked for, not re-guessed (spike: a phonk track read as edm)
        doc = dict(facts, id=rid, mood=req["mood"], moodGuess=facts.get("mood"), generated=meta)
        t = checked_track(doc, rid, cfg)
        if t is None:
            return None, "made but its facts are out of range"
        # Codex verify: metadata first (part file), then the WAV, then the JSON last; a WAV without its valid JSON is
        # never reused (stored_track), and any failure here removes both final names
        meta_part, meta = os.path.join(root, rid + ".json.part"), os.path.join(root, rid + ".json")
        try:
            write_json_atomic(meta_part, doc)
            os.replace(part, wav)
            os.replace(meta_part, meta)
        except (OSError, ClipError) as e:
            for p in (wav, meta):
                try:
                    os.remove(p)
                except OSError:
                    pass
            return None, f"made but not stored ({str(e)[-100:]})"
        eprint(f"music: made {rid} ({req['mood']}, {req['bpm']} BPM, {req['seconds']} s) in {doc['generated']['madeSec']} s")
        return dict(t, file=wav, root=root, bpmMeasured=facts["bpmMeasured"]), "made"
    finally:
        _clean(root, rid)  # Codex review: a killed worker cannot clean up; nothing partial is left
