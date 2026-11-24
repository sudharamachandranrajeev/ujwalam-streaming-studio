# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T3: a cover picture with a 2-4 word hook, made by the RP6 renderer (reel_thumbnail.png_argv).

Called by services/posting/ai-cover.mjs after the AI post text passed its checks. One ffmpeg run: the frame at the
chosen second of a finished video, the RP6 picture treatment, the hook as the big text (one or two centred lines in
the "main" line style of data/clip/thumbnail.json), written as a JPEG. Nothing is read from chat. The hook is cleaned
the same way the reel title is (upper case, letters, digits and a little punctuation only) and goes to ffmpeg only
through a text file, never into a filter string.

  python -I reel_cover.py <ffmpeg> <video> <second> <out.jpg> <workdir> <hook words...>
Exit 0 and one JSON line {"file", "at", "lines"} on success; exit 1 and {"error"} otherwise (the caller keeps the
plain frame).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I does not add the script folder

import reel_thumbnail as rt  # noqa: E402
from clip_common import run_tool  # noqa: E402

MAX_LINES = 2


def split_hook(hook, cfg):
    """The hook as at most MAX_LINES cleaned lines, each within the main line's maxChars; [] when it does not fit."""
    cap = int(next(x for x in cfg["lines"] if x["id"] == "main")["maxChars"])
    words = rt._clean(hook, 200).split()
    lines, cur = [], ""
    for w in words:
        if len(w) > cap:
            return []
        if cur and len(cur) + 1 + len(w) > cap:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines if 0 < len(lines) <= MAX_LINES else []


def frame_size(ffmpeg, video):
    r = run_tool([ffmpeg, "-hide_banner", "-nostdin", "-i", video], timeout=60)
    m = re.search(r"Video:.*?,\s*(\d{2,5})x(\d{2,5})", r.stderr or "")
    return (int(m.group(1)), int(m.group(2))) if m else None


def make(ffmpeg, video, t, hook, out, wd, cfg=None):
    cfg = cfg or rt.load_config()
    lines = split_hook(hook, cfg)
    if not lines:
        return {"error": "hook does not fit"}
    size = frame_size(ffmpeg, video)
    if not size:
        return {"error": "no video size"}
    w, h = size
    frame = {"width": w, "height": h}
    safe = {"left": round(0.04 * w), "right": round(0.04 * w), "top": 0}
    os.makedirs(os.path.join(wd, rt.FONT_SUBDIR), exist_ok=True)
    shutil.copyfile(os.path.join(rt.FONTS_DIR, cfg["fontFile"]), os.path.join(wd, rt.FONT_SUBDIR, cfg["fontFile"]))
    names = []
    try:
        for i, text in enumerate(lines):
            n = f"cover-{i}.txt"
            with open(os.path.join(wd, n), "w", encoding="utf-8", newline="") as f:
                f.write(text)
            names.append(n)
        part = "cover.part.jpg"
        argv = rt.png_argv(ffmpeg, video, t, frame, [("main", s) for s in lines], cfg, safe, part, names)
        argv[-3:-3] = ["-q:v", "2"]  # before "-update 1 <out>"
        r = run_tool(argv, cwd=wd, timeout=120)
        src = os.path.join(wd, part)
        if r.returncode != 0 or not os.path.isfile(src):
            return {"error": (r.stderr or "no picture").strip()[-300:]}
        os.replace(src, out)
    finally:
        for n in names + ["cover.part.jpg"]:
            try:
                os.remove(os.path.join(wd, n))
            except OSError:
                pass
    return {"file": os.path.basename(out), "at": float(t), "lines": lines}


def main(argv):
    if len(argv) < 7:
        print(json.dumps({"error": "usage"}))
        return 1
    try:
        rec = make(argv[0], argv[1], float(argv[2]), " ".join(argv[5:]), os.path.abspath(argv[3]), argv[4])
    except Exception as e:  # noqa: BLE001 - any failure keeps the plain frame
        rec = {"error": f"{type(e).__name__}: {e}"[-300:]}
    print(json.dumps(rec))
    return 0 if "file" in rec else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
