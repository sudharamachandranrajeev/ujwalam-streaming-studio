# SPDX-License-Identifier: GPL-3.0-or-later
"""BD4 BeatDrop effects (D415, plan docs/plan/2026-11-21-beatdrop-montages.md section 5): the core functions
scope-zoom-transition, whip-pan, impact-flash, rgb-split, shot-shake, letterbox, ragdoll-slowmo and bloom-grade, as one
ffmpeg filter graph fragment run once on the joined montage picture (clip_montage.render_argv(fx=)).

An effect is data: {"fn": core function id, "at": reel seconds, "params": {...}} (letterbox also "end"); the params
come from the function's registry manifest defaults (registry/functions/<id>.json), a preset's params, then the plan's
own values, each clamped to the manifest's safeRanges. ragdoll-slowmo is a speed-ramp on the piece (the planner) plus
the zoom pulse here.

Flash safety (AGENTS.md): impact flashes are re-spaced on the final (beat-synced) timeline by space_flashes(): at most
maxFlashesPerSec in any 1 s window and at least minGapSec apart; a flash that does not fit becomes a colour pulse
(a low-alpha tint, below the flash threshold). The rendered result is measured from frame luminance by the same
analyser as `fx test` (services/overlay-server/flash-detect.mjs) in tests/py/test_beatdrop.py.
"""

from __future__ import annotations

import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
REGISTRY = os.path.normpath(os.path.join(_HERE, "..", "..", "registry"))
FUNCTIONS = ("scope-zoom-transition", "whip-pan", "impact-flash", "rgb-split", "shot-shake", "letterbox",
             "ragdoll-slowmo", "bloom-grade")


def manifest(fn, registry=REGISTRY):
    with open(os.path.join(registry, "functions", f"{fn}.json"), encoding="utf-8") as f:
        return json.load(f)


def preset(pid, registry=REGISTRY):
    with open(os.path.join(registry, "presets", f"{pid}.json"), encoding="utf-8") as f:
        return json.load(f)


def params_for(fn, over=None, preset_id=None, registry=REGISTRY):
    """Manifest defaults, then a preset's params, then over; numbers clamped to the manifest's safeRanges."""
    m = manifest(fn, registry)
    p = dict(m["params"]["defaults"])
    if preset_id:
        pr = preset(preset_id, registry)
        if pr["function"] != fn:
            raise ValueError(f"preset {preset_id} is not a {fn} preset")
        p.update(pr["params"])
    p.update(over or {})
    for k, (lo, hi) in (m["params"].get("safeRanges") or {}).items():
        if isinstance(p.get(k), (int, float)) and not isinstance(p.get(k), bool):
            p[k] = min(max(p[k], lo), hi)
    return p


def space_flashes(effects, max_per_sec=3, min_gap=0.34):
    """Impact flashes on the final timeline: kept as flashes while at least min_gap after the last flash and fewer than
    max_per_sec in the 1 s before; the rest become colour pulses (mode "pulse"). -> new list (others unchanged)."""
    out, kept = [], []
    for e in sorted(effects, key=lambda e: e["at"]):
        if e["fn"] != "impact-flash":
            out.append(e)
            continue
        t = e["at"]
        ok = (not kept or t - kept[-1] >= min_gap) and sum(1 for k in kept if t - k < 1.0) < max_per_sec
        if ok:
            kept.append(t)
        out.append(dict(e, mode="flash" if ok else "pulse"))
    return out


def _between(a, b):
    return f"between(t,{a:.4f},{b:.4f})"


def _ease_window(a, ti, b, to):
    """0..1: up over [a, a+ti], 1 until b-to, down to 0 at b (linear; t-based)."""
    return (f"(between(t,{a:.4f},{b:.4f})*min(1,min((t-{a:.4f})/{ti:.4f},({b:.4f}-t)/{to:.4f})))")


def graph(effects, frame, fps=60):
    """effects -> (filter graph fragment reading [fxin] and writing [fxout]) or None when there is nothing to draw.
    Order: zoom (scope push, ragdoll pulse), offsets (whip, shake), directional blur, RGB split, bloom, letterbox,
    flashes and colour pulses last (so a flash is never blurred or split)."""
    ow, oh = int(frame["width"]), int(frame["height"])
    by = {}
    for e in effects:
        by.setdefault(e["fn"], []).append(e)
    chain = []
    # zoom: scope push into the lens before the join, the next piece starts inside it; ragdoll pulses on kills
    zterms = []
    for e in by.get("scope-zoom-transition", []):
        p, j = e["params"], e["at"]
        ti, to, s = p["inFrames"] / fps, p["outFrames"] / fps, p["scale"] - 1.0
        zterms.append(f"{s:.4f}*(between(it,{j - ti:.4f},{j:.4f})*(it-{j - ti:.4f})/{ti:.4f}"
                      f"+gt(it,{j:.4f})*lte(it,{j + to:.4f})*(1-(it-{j:.4f})/{to:.4f}))")
    for e in by.get("ragdoll-slowmo", []):
        p, t = e["params"], e["at"]
        ti, to, s = p["zoomInMs"] / 1000.0, p["zoomOutMs"] / 1000.0, p["zoom"] - 1.0
        zterms.append(f"{s:.4f}*(between(it,{t:.4f},{t + ti:.4f})*sin(PI/2*(it-{t:.4f})/{ti:.4f})"
                      f"+gt(it,{t + ti:.4f})*lte(it,{t + ti + to:.4f})*cos(PI/2*(it-{t + ti:.4f})/{to:.4f}))")
    if zterms:
        chain.append(f"zoompan=z='min(3,1+{'+'.join(zterms)})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                     f":s={ow}x{oh}:fps={fps}")
    # offsets: the picture slides inside a padded frame (outside the windows it is exactly where it was)
    xt, yt, blur = [], [], []
    for e in by.get("whip-pan", []):
        p, j = e["params"], e["at"]
        h = p["frames"] / fps / 2.0
        a, b = j - h, j + h
        xt.append(f"{_between(a, b)}*{p['direction'] * p['offset'] * ow:.2f}*sin(PI*(t-{a:.4f})/{b - a:.4f})")
        blur.append((a, b))
    for e in by.get("shot-shake", []):
        p, a = e["params"], e["at"]
        d = p["frames"] / fps
        amp = p["amplitude"] * oh
        xt.append(f"{_between(a, a + d)}*{amp:.2f}*sin(2*PI*{p['hz']:.2f}*(t-{a:.4f}))*(1-(t-{a:.4f})/{d:.4f})")
        yt.append(f"{_between(a, a + d)}*{amp * 0.6:.2f}*cos(2*PI*{p['hz']:.2f}*(t-{a:.4f}))*(1-(t-{a:.4f})/{d:.4f})")
    if xt or yt:
        mx = max(8, int(0.15 * ow)) // 2 * 2
        my = max(8, int(0.05 * oh)) // 2 * 2
        cx = f"{mx}+clip({'+'.join(xt) or 0},-{mx},{mx})"
        cy = f"{my}+clip({'+'.join(yt) or 0},-{my},{my})"
        chain.append(f"pad=iw+{2 * mx}:ih+{2 * my}:{mx}:{my}:color=black,crop={ow}:{oh}:x='{cx}':y='{cy}'")
    if blur:
        r = int(max(e["params"]["blur"] for e in by["whip-pan"]))
        chain.append(f"dblur=angle=0:radius={r}:enable='{'+'.join(_between(a, b) for a, b in blur)}'")
    if by.get("rgb-split"):
        en = "+".join(_between(e["at"], e["at"] + e["params"]["frames"] / fps) for e in by["rgb-split"])
        px = int(max(e["params"]["shift"] for e in by["rgb-split"]) * ow)
        chain.append(f"format=gbrp,rgbashift=rh=-{px}:bh={px}:enable='{en}',format=yuv420p")
    pre = ",".join(chain) if chain else "null"
    bloom = by.get("bloom-grade")
    lines = []
    if bloom:
        p = bloom[0]["params"]
        lines.append(f"[fxin]{pre},split[bdA][bdB]")
        lines.append(f"[bdB]gblur=sigma={p['sigma']:.2f}[bdG]")
        lines.append(f"[bdA][bdG]blend=all_mode=screen:all_opacity={p['glow']:.3f},hue=s={p['saturation']:.3f}[bdP]")
        cur = "[bdP]"
    else:
        lines.append(f"[fxin]{pre}[bdP]")
        cur = "[bdP]"
    post = []
    for e in by.get("letterbox", []):
        p = e["params"]
        a, b = e["at"], e["end"]
        k = _ease_window(a, p["inMs"] / 1000.0, b, p["outMs"] / 1000.0)
        h = f"ih*{p['bar']:.4f}*{k}"
        post.append(f"drawbox=x=0:y=0:w=iw:h='{h}':color=black:t=fill:enable='{_between(a, b)}'")
        post.append(f"drawbox=x=0:y='ih-{h}':w=iw:h='{h}':color=black:t=fill:enable='{_between(a, b)}'")
    for e in by.get("impact-flash", []):
        p, a = e["params"], e["at"]
        if e.get("mode", "flash") == "flash":
            b = a + p["frames"] / fps - 0.001
            post.append(f"drawbox=x=0:y=0:w=iw:h=ih:color={p['colour']}@{p['alpha']:.3f}:t=fill:enable='{_between(a, b)}'")
        else:
            b = a + p["pulseMs"] / 1000.0
            post.append(f"drawbox=x=0:y=0:w=iw:h=ih:color={p['pulseColour']}@{p['pulseAlpha']:.3f}:t=fill"
                        f":enable='{_between(a, b)}'")
    if not chain and not bloom and not post:
        return None
    lines.append(f"{cur}{','.join(post) if post else 'null'}[fxout]")
    return ";".join(lines)
