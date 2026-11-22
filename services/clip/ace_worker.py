# SPDX-License-Identifier: GPL-3.0-or-later
"""FX6 (plan docs/plan/2026-11-21-clip-music-name-transitions.md 3.4, D429): one instrumental from ACE-Step 1.5, run by
services/clip/music_gen.py with the runtime's own Python (its folder is the working folder, where its checkpoints and
its acestep package live). Never imported by Ujwalam itself: it needs the runtime's torch and acestep packages.

  <runtime python> -I ace_worker.py <job.json>

job.json: {"caption", "bpm", "seconds", "seed", "out", "result", "work", "config", "quantization", "offloadToCpu"}.
out, result and work are plain names (no folder part, no "..") of files and a folder directly inside the job file's
own folder; the result is only ever written there. Every field is checked before torch is imported; a bad job writes
{"ok": false, "error"} to the result when its name is valid, and exits 2 either way.

The settings are the ones the FX6 spike proved on a 6 GB card (docs/evidence/2026-11-22-fx6-ace-step-spike.md): the
DiT only (no language model), INT8 weights, offload to the CPU, no thinking, no CoT metas, instrumental. Offline:
Hugging Face is told to stay offline and send no telemetry before anything is imported. The result JSON is
{"ok", "error", "seconds", "loadSeconds", "torchPeakMB"}. The model is unloaded when this process ends.
"""

import json
import math
import os
import re
import shutil
import sys
import time

os.environ["HF_HUB_OFFLINE"] = "1"  # set before any import that reads them
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")
CONFIGS = ("acestep-v15-turbo",)
QUANT = ("int8_weight_only",)


def _name(v, ext=None):
    return isinstance(v, str) and bool(_NAME.match(v)) and ".." not in v and (ext is None or v.lower().endswith(ext))


def _int(v, lo, hi):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v <= hi


def check(job):
    """Problems with a job (before torch is imported); [] when fine."""
    if not isinstance(job, dict):
        return ["the job is not an object"]
    out = []
    if not _name(job.get("out"), ".wav"):
        out.append("out must be a plain .wav name")
    if not _name(job.get("result"), ".json"):
        out.append("result must be a plain .json name")
    if not _name(job.get("work")):
        out.append("work must be a plain folder name")
    if len({job.get("out"), job.get("result"), job.get("work")}) != 3:
        out.append("out, result and work must differ")
    c = job.get("caption")
    if not (isinstance(c, str) and 0 < len(c) <= 400 and not re.search(r"[\x00-\x1f]", c)):
        out.append("caption must be text up to 400 characters")
    if not _int(job.get("bpm"), 40, 220):
        out.append("bpm must be a whole number from 40 to 220")
    s = job.get("seconds")
    if not (isinstance(s, (int, float)) and not isinstance(s, bool) and math.isfinite(s) and 10 <= s <= 240):
        out.append("seconds must be from 10 to 240")
    if not _int(job.get("seed"), 0, 2**31 - 1):
        out.append("seed must be a whole number from 0 to 2147483647")
    if job.get("config") not in CONFIGS:
        out.append(f"config must be one of {', '.join(CONFIGS)}")
    if job.get("quantization") not in QUANT:
        out.append(f"quantization must be one of {', '.join(QUANT)}")
    if not isinstance(job.get("offloadToCpu"), bool):
        out.append("offloadToCpu must be true or false")
    return out


def _inside(folder, name):
    p = os.path.join(folder, name)
    return p if os.path.dirname(os.path.abspath(p)) == os.path.abspath(folder) and not os.path.islink(p) else None


def main(job_path):
    folder = os.path.dirname(os.path.abspath(job_path))
    try:
        with open(job_path, encoding="utf-8") as f:
            job = json.load(f)
    except (OSError, ValueError):
        return 2
    res_path = _inside(folder, job["result"]) if isinstance(job, dict) and _name(job.get("result"), ".json") else None
    res = {"ok": False, "error": None}

    def done(code):
        if res_path:
            with open(res_path, "w", encoding="utf-8") as f:
                json.dump(res, f)
        return code

    bad = check(job)
    out_path = _inside(folder, job["out"]) if not bad else None
    work = _inside(folder, job["work"]) if not bad else None
    if bad or not out_path or not work or not res_path:
        res["error"] = "; ".join(bad) or "a path is not a plain file in the job's folder"
        return done(2)
    if os.getcwd() not in sys.path:  # the runtime folder (cwd): its acestep package, as `uv run` from there
        sys.path.insert(0, os.getcwd())
    t0 = time.time()
    try:
        import torch  # noqa: PLC0415 - the runtime's own torch
        from acestep.handler import AceStepHandler  # noqa: PLC0415
        from acestep.inference import GenerationConfig, GenerationParams, generate_music  # noqa: PLC0415

        dit = AceStepHandler()
        dit.initialize_service(project_root=os.getcwd(), config_path=job["config"], device="cuda",
                               offload_to_cpu=job["offloadToCpu"], quantization=job["quantization"])
        res["loadSeconds"] = round(time.time() - t0, 1)
        torch.cuda.reset_peak_memory_stats()
        t1 = time.time()
        seed = job["seed"]
        out = generate_music(dit, None,
                             GenerationParams(caption=job["caption"], bpm=job["bpm"], duration=float(job["seconds"]),
                                              instrumental=True, lyrics="[Instrumental]", thinking=False,
                                              use_cot_metas=False, seed=seed),
                             GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=False, seeds=[seed]),
                             save_dir=work)
        res["seconds"] = round(time.time() - t1, 1)
        res["torchPeakMB"] = round(torch.cuda.max_memory_allocated() / 2**20)
        files = [a.get("path") for a in (out.audios or []) if isinstance(a, dict) and a.get("path")]
        if not out.success or not files or not os.path.isfile(files[0]):
            res["error"] = str(out.error or "no audio written")[:300]
        else:
            shutil.move(files[0], out_path)
            res["ok"] = True
    except Exception as e:  # noqa: BLE001 - any failure is reported in the result, the caller falls back
        res["error"] = f"{type(e).__name__}: {str(e)[-300:]}"
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return done(0 if res["ok"] else 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
