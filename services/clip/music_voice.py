# SPDX-License-Identifier: GPL-3.0-or-later
"""D437: what the music bed needs to know about a reel's own game audio, read once before the render.

  game_audio(ffmpeg, src, pieces, wd)   -> float stereo (n, 2) at 48 kHz: the first audio track of each piece, joined
  game_lufs(x)                          -> integrated loudness of the game mix (BS.1770), or None when silent
  speech_spans(x, pieces, xd, vcfg)     -> [(start, end)] reel seconds where someone speaks (Silero VAD)
  measure(ffmpeg, src, pieces, xd, wd, vcfg) -> {"gameLufs", "spans", "speech"} (never raises: any failure gives Nones)

Speech times come from Silero VAD: the onnx model that ships inside faster-whisper, already in the runtime; it runs on
the CPU and downloads nothing. A failure here never stops a render: the bed then keeps the user's level and the game
duck alone (the rules before D437).
"""

from __future__ import annotations

import os
import tempfile
import wave

from clip_common import run_tool

SR = 48000
VAD_SR = 16000


def _np():
    import numpy as np  # noqa: PLC0415
    return np


def game_audio_argv(ffmpeg, src, pieces, out_wav):
    """One ffmpeg run: the first audio track of each piece in play order, joined, 48 kHz stereo PCM."""
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", "2"]
    for p in pieces:
        argv += ["-ss", f"{float(p['start']):.3f}", "-t", f"{float(p['end']) - float(p['start']):.3f}", "-i", src]
    n = len(pieces)
    graph = (";".join(f"[{i}:a:0]aresample={SR},aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS[a{i}]" for i in range(n))
             + ";" + "".join(f"[a{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1[aout]")
    return argv + ["-filter_complex", graph, "-map", "[aout]", "-ac", "2", "-ar", str(SR), "-c:a", "pcm_s16le", out_wav]


def game_audio(ffmpeg, src, pieces, wd):
    np = _np()
    with tempfile.TemporaryDirectory(dir=wd) as td:
        wav = os.path.join(td, "game.wav")
        r = run_tool(game_audio_argv(ffmpeg, src, pieces, wav), timeout=600)
        if r.returncode != 0 or not os.path.isfile(wav):
            raise OSError("game audio extract failed")
        with wave.open(wav, "rb") as w:
            raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype="<i2").reshape(-1, 2).astype(np.float64) / 32768.0


def game_lufs(x):
    from scene_music import measure_lufs  # noqa: PLC0415
    if len(x) < SR // 2:
        return None
    v = measure_lufs(x)
    return round(float(v), 2) if v is not None and v > -70.0 else None


def map_span(a, b, pieces, xd):
    """A span on the pieces joined back to back (source seconds) -> [(start, end)] reel seconds: cut at each piece's
    edges first (Codex review: a span over a join is never shortened or dropped), each part moved onto the reel
    timeline (joins overlap by xd; a piece's speed, if any, scales its time)."""
    out, acc, at = [], 0.0, 0.0
    for i, p in enumerate(pieces):
        ln = float(p["end"]) - float(p["start"])
        sp = float(p.get("speed") or 1.0)
        s0, s1 = max(a, acc), min(b, acc + ln)
        o0 = at - i * xd
        if s1 > s0:
            out.append((max(0.0, o0 + (s0 - acc) / sp), max(0.0, o0 + (s1 - acc) / sp)))
        acc += ln
        at += ln / sp
    return out


def merge(spans, gap):
    out = []
    for a, b in sorted(spans):
        if out and a - out[-1][1] <= gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def vad_spans(mono16k, vcfg, vad=None):
    """[(start, end)] seconds of speech in 16 kHz mono float audio. vad: injected for tests."""
    if vad is None:
        from faster_whisper.vad import VadOptions, get_speech_timestamps  # noqa: PLC0415 - shipped runtime
        opts = VadOptions(threshold=float(vcfg["threshold"]), min_speech_duration_ms=int(float(vcfg["minSpeechSec"]) * 1000),
                          min_silence_duration_ms=int(float(vcfg["mergeGapSec"]) * 1000), speech_pad_ms=0)
        vad = lambda a: get_speech_timestamps(a, opts)  # noqa: E731
    return [(int(s["start"]) / VAD_SR, int(s["end"]) / VAD_SR) for s in vad(mono16k)]


def speech_spans(x, pieces, xd, vcfg, vad=None):
    np = _np()
    mono = x.mean(axis=1)
    k = SR // VAD_SR  # 3: average then keep every third sample (speech lives under 8 kHz)
    m = len(mono) // k * k
    mono16 = mono[:m].reshape(-1, k).mean(axis=1).astype(np.float32)
    spans = [s for a, b in vad_spans(mono16, vcfg, vad) for s in map_span(a, b, pieces, xd)]
    return [(round(a, 3), round(b, 3)) for a, b in merge([s for s in spans if s[1] > s[0]], float(vcfg["mergeGapSec"]))]


def measure(ffmpeg, src, pieces, xd, wd, vcfg, want_speech=True, vad=None, audio=None):
    """-> {"gameLufs": float or None, "spans": list or None, "speech": "vad" | reason}. Never raises."""
    out = {"gameLufs": None, "spans": None, "speech": "off" if not want_speech else "failed"}
    try:
        x = audio if audio is not None else game_audio(ffmpeg, src, pieces, wd)
    except Exception as e:  # noqa: BLE001 - a failed read leaves the old rules
        out["speech"] = out["why"] = f"game audio not read ({type(e).__name__})"
        return out
    try:
        out["gameLufs"] = game_lufs(x)
    except Exception as e:  # noqa: BLE001
        out["why"] = f"loudness not measured ({type(e).__name__})"
    if want_speech:
        try:
            out["spans"] = speech_spans(x, pieces, xd, vcfg, vad)
            out["speech"] = "vad"
        except Exception as e:  # noqa: BLE001 - no speech times: the game duck alone
            out["speech"] = f"no speech times ({type(e).__name__}: {str(e)[-80:]})"
    return out
