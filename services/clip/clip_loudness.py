# SPDX-License-Identifier: GPL-3.0-or-later
"""D440 (user 2026-11-22 said yes): every finished reel, montage and long video at one loudness target, -14 LUFS
integrated by default (YouTube's playback level: it turns loud videos down but never quiet ones up; reels measured
about -29 LUFS because the game sound is very quiet).

How: one STATIC gain (not a riding AGC like one-pass loudnorm) on audio track 1 (the studio mix), placed ahead of the
existing true-peak limiter (clip_montage.LIMIT_LINEAR, -4 dBFS, 4x oversampled, so the AAC encode stays under -1
dBTP). The gain comes from an audio-only pre-pass of the very same filter graph (probe_argv: the picture chains are
dropped, so no video is decoded): pass 1 measures the mix as it is, pass 2 (data: passes) measures it again with the
gain through the limiter and corrects for what the limiter took. Still one audio encode in the real render. A failed
pre-pass returns no gain: the video renders as before (never blocked). After the render, check() measures the file
(ffmpeg ebur128) and the result goes into the render record.

Data: data/clip/look.json "loudness" (tolerance, gain limits, passes) and music.loudnessLufs (the target; Settings >
Clips; null = leave the level as it is).

  target(data_dir)                         -> the target LUFS or None (off)
  probe_argv(argv)                         -> an audio-only ffmpeg argv measuring track 1 of a render_argv argv, or None
  plan(build, run, cwd, tgt, cfg)          -> (gain dB or None, record)
  check(ffmpeg, path, tgt, cfg)            -> {"lufs", "truePeak", "ok"}
"""

from __future__ import annotations

import math
import re

from clip_common import ClipError
from clip_validate import audio_stats, parse_loudness_summary

_CHAIN = re.compile(r"^((?:\[[^\]]+\])*)(.*?)((?:\[[^\]]+\])*)$", re.S)
_LABEL = re.compile(r"\[([^\]]+)\]")
TRACK1 = "aout0"
TRUE_PEAK_MAX = -1.0


def load_cfg():
    import clip_look as look  # noqa: PLC0415
    return look.load_config()["loudness"]


def target(data_dir):
    """The user's target (clips.look.music.loudnessLufs, default -14) or None when it is switched off. An unreadable
    look file leaves the level as it is (None): never a guess."""
    import clip_look as look  # noqa: PLC0415
    try:
        v = look.effective(data_dir, look.load_config())["music"].get("loudnessLufs")
    except (OSError, ClipError, KeyError, TypeError, ValueError):
        return None
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _split(chain):
    m = _CHAIN.match(chain)
    return _LABEL.findall(m.group(1)), m.group(2), _LABEL.findall(m.group(3))


def _is_video(label, video):
    return label in video or bool(re.fullmatch(r"\d+:v(?::\d+)?", label))


def probe_argv(argv):
    """An audio-only copy of a clip_montage.render_argv argv that measures track 1 with ebur128 and writes nothing:
    every chain that reads a picture is dropped (its outputs count as pictures too), a concat keeps only its sound
    (v=0), and [aout0] goes through ebur128 to the null muxer. The output cap (-t after the graph) is kept. None when
    the argv has no graph or no track 1."""
    if "-filter_complex" not in argv:
        return None
    i = argv.index("-filter_complex")
    graph = argv[i + 1]
    video, kept = set(), []
    for chain in graph.split(";"):
        ins, body, outs = _split(chain)
        if body.startswith("concat="):
            vin = [x for x in ins if _is_video(x, video)]
            if vin:
                video.update(x for x in outs if x.startswith("v"))
                ains = [x for x in ins if not _is_video(x, video)]
                aouts = [x for x in outs if not x.startswith("v")]
                if not ains or not aouts:
                    continue
                if len(aouts) > 1:  # several tracks: track 1 only (each segment's first sound, a=1)
                    n = len(aouts)
                    ains, aouts = ains[0::n], aouts[:1]
                    body = re.sub(r"(?<=:)a=\d+", "a=1", body)
                body = re.sub(r"(?<=:)v=1(?=:|$)", "v=0", body)  # same n segments, now sound only
                chain = "".join(f"[{x}]" for x in ains) + body + "".join(f"[{x}]" for x in aouts)
            kept.append(chain)
            continue
        if any(_is_video(x, video) for x in ins):
            video.update(outs)
            continue
        kept.append(chain)
    if not any(_split(c)[2] and TRACK1 in _split(c)[2] for c in kept):
        return None
    while True:  # the other tracks: a chain whose outputs nothing reads (and not track 1) is dropped (ffmpeg refuses
        used = {x for c in kept for x in _split(c)[0]}  # an unconnected labelled output)
        dead = [c for c in kept if TRACK1 not in _split(c)[2] and not any(x in used for x in _split(c)[2])]
        if not dead:
            break
        kept = [c for c in kept if c not in dead]
    out = []
    for c in kept:
        ins, body, outs = _split(c)
        if TRACK1 in outs:
            c = "".join(f"[{x}]" for x in ins) + body + "".join(f"[{'lmeas' if x == TRACK1 else x}]" for x in outs)
        out.append(c)
    out.append(f"[lmeas]ebur128=peak=true:framelog=quiet[{TRACK1}]")
    head = list(argv[:i])
    if "-v" in head:
        head[head.index("-v") + 1] = "info"
    head = [x for x in head if x != "-y"] + ["-nostats"]
    cap = []
    rest = argv[i + 2:]
    if "-t" in rest:
        cap = ["-t", rest[rest.index("-t") + 1]]
    return head + ["-filter_complex", ";".join(out), "-map", f"[{TRACK1}]", *cap, "-f", "null", "-"]


def _measure(run, argv, cwd, timeout):
    p = probe_argv(argv)
    if not p:
        return None
    r = run(p, cwd=cwd, timeout=timeout)
    if r.returncode != 0:
        return None
    lufs, _tp = parse_loudness_summary(r.stderr or "")
    return lufs


def pooled(values):
    """Integrated loudness of parts played one after another, from each part's (LUFS, seconds): the mean energy
    (gating ignored; close for parts of similar level). None if any part could not be measured."""
    if not values or any(v is None or s <= 0 for v, s in values):
        return None
    tot = sum(s for _, s in values)
    return 10.0 * math.log10(sum(s * 10.0 ** (v / 10.0) for v, s in values) / tot)


def gain_for(tgt, measured, cfg):
    """The gain that moves measured to tgt, inside the data's limits."""
    return round(max(float(cfg["minGainDb"]), min(float(cfg["maxGainDb"]), float(tgt) - float(measured))), 2)


def plan(build, run, cwd, tgt, cfg, timeout=900):
    """build(gain dB or None) -> [(render argv, seconds)] (one per part; the long video has several batches).
    -> (gain dB or None, record). None = render as before (off, nothing to measure, or the pre-pass failed)."""
    rec = {"target": tgt, "source": cfg.get("source"), "status": "off"}
    if tgt is None:
        return None, rec
    try:
        before = pooled([(_measure(run, a, cwd, timeout), s) for a, s in build(None)])
        if before is None:
            return None, dict(rec, status="failed", reason="the loudness pre-pass could not measure the mix")
        g = gain_for(tgt, before, cfg)
        steps = [{"gainDb": None, "lufs": round(before, 2)}]
        last_g, last_m = 0.0, before
        for _ in range(max(0, int(cfg.get("passes", 2)) - 1)):
            m = pooled([(_measure(run, a, cwd, timeout), s) for a, s in build(g)])
            if m is None:
                break
            steps.append({"gainDb": g, "lufs": round(m, 2)})
            if abs(tgt - m) <= 0.1:
                break
            # the limiter takes a growing share as the gain rises: step by the measured slope (secant), 0.25-1 LU/dB
            slope = (m - last_m) / (g - last_g) if abs(g - last_g) > 0.01 else 1.0
            slope = min(1.0, max(0.25, slope))
            last_g, last_m = g, m
            g = gain_for(tgt, tgt - (g + (tgt - m) / slope), cfg)
        return g, dict(rec, status="planned", measuredBefore=round(before, 2), gainDb=g, passes=steps)
    except Exception as e:  # noqa: BLE001 - a pre-pass problem never blocks the video
        return None, dict(rec, status="failed", reason=f"loudness pre-pass: {type(e).__name__}: {str(e)[-160:]}")


def check(ffmpeg, path, tgt, cfg):
    """Measure-after: the file's track 1 integrated loudness and true peak; ok = within toleranceLu of the target and
    true peak at or under -1 dBTP."""
    s = audio_stats(ffmpeg, path, 1)[0]
    lufs, tp = s.get("lufs"), s.get("peakDb")
    ok = lufs is not None and tp is not None and abs(lufs - float(tgt)) <= float(cfg["toleranceLu"]) \
        and tp <= TRUE_PEAK_MAX
    return {"lufs": lufs, "truePeak": tp, "ok": bool(ok)}
