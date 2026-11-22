# SPDX-License-Identifier: GPL-3.0-or-later
"""FX6 (plan docs/plan/2026-11-21-clip-music-name-transitions.md 3.4): one instrumental from ACE-Step 1.5, run by
services/clip/music_gen.py with the runtime's own Python (its folder is the working folder, where its checkpoints
live). Never imported by Ujwalam itself: it needs the runtime's torch and acestep packages.

  <runtime python> -I ace_worker.py <job.json>

job.json: {"caption", "bpm", "seconds", "seed", "out" (the WAV to write), "result" (the JSON to write), "config",
"quantization", "offloadToCpu"}. The settings are the ones the FX6 spike proved on a 6 GB card
(docs/evidence/2026-11-22-fx6-ace-step-spike.md): the DiT only (no language model), INT8 weights, offload to the CPU,
no thinking, no CoT metas, instrumental. Offline: Hugging Face is told to stay offline and send no telemetry before
anything is imported. The result JSON is {"ok", "error", "seconds", "torchPeakMB", "out"}. The model is unloaded when
this process ends.
"""

import json
import os
import shutil
import sys
import time

os.environ["HF_HUB_OFFLINE"] = "1"  # set before any import that reads them
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"


def main(job_path):
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    res = {"ok": False, "error": None, "out": job["out"]}
    t0 = time.time()
    try:
        import torch  # noqa: PLC0415 - the runtime's own torch
        from acestep.handler import AceStepHandler  # noqa: PLC0415
        from acestep.inference import GenerationConfig, GenerationParams, generate_music  # noqa: PLC0415

        dit = AceStepHandler()
        dit.initialize_service(project_root=os.getcwd(), config_path=job.get("config", "acestep-v15-turbo"),
                               device="cuda", offload_to_cpu=bool(job.get("offloadToCpu", True)),
                               quantization=job.get("quantization", "int8_weight_only"))
        res["loadSeconds"] = round(time.time() - t0, 1)
        torch.cuda.reset_peak_memory_stats()
        t1 = time.time()
        save = os.path.join(os.path.dirname(os.path.abspath(job["out"])), "work-" + str(os.getpid()))
        seed = int(job["seed"])
        out = generate_music(dit, None,
                             GenerationParams(caption=job["caption"], bpm=int(job["bpm"]), duration=float(job["seconds"]),
                                              instrumental=True, lyrics="[Instrumental]", thinking=False,
                                              use_cot_metas=False, seed=seed),
                             GenerationConfig(batch_size=1, audio_format="wav", use_random_seed=False, seeds=[seed]),
                             save_dir=save)
        res["seconds"] = round(time.time() - t1, 1)
        res["torchPeakMB"] = round(torch.cuda.max_memory_allocated() / 2**20)
        files = [a.get("path") for a in (out.audios or []) if isinstance(a, dict) and a.get("path")]
        if not out.success or not files or not os.path.isfile(files[0]):
            res["error"] = str(out.error or "no audio written")[:300]
        else:
            shutil.move(files[0], job["out"])
            res["ok"] = True
        shutil.rmtree(save, ignore_errors=True)
    except Exception as e:  # noqa: BLE001 - any failure is reported in the result, the caller falls back
        res["error"] = f"{type(e).__name__}: {str(e)[-300:]}"
    with open(job["result"], "w", encoding="utf-8") as f:
        json.dump(res, f)
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
