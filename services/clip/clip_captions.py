# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 captions: transcriber seam (local only) and an ASS writer for burn-in.

Backends (--captions):
  none            no transcription; the clip renders without captions and the report says so (default until a
                  local Whisper is installed).
  whisper-cli     a whisper.cpp command line binary (--whisper-bin, --whisper-model). Runs
                  <bin> -m <model> -f <clip.wav> -oj -of <base> -t 4 and reads <base>.json
                  (transcription[].offsets.from/to in ms, text). UNVERIFIED: no binary or model on the laptop yet.
  faster-whisper  the faster_whisper package, if importable in this interpreter (D176: project .venv, model folder
                  passed with --whisper-model). CPU int8, VAD filter on. Checked on a synthetic speech fixture
                  (tests/py/test_caption_seam.py); quality on real stream speech UNVERIFIED.
No network and no paid API: every backend runs on local files.

Segments are [{start, end, text}] in seconds from the clip start. The ASS file uses the 1080x1920 frame and keeps
captions inside the intersection of every target's safe zone (data/clip/targets.json).
"""

from __future__ import annotations

import json
import os
import re
import sys

from clip_common import ClipError, FFMPEG_THREADS, eprint, run_tool

BACKENDS = ("none", "whisper-cli", "faster-whisper")
MAX_CHARS_PER_LINE = 26
MAX_LINES = 2


# ---------------------------------------------------------------- transcription

def extract_wav(ffmpeg, src, start, dur, out_wav):
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", str(FFMPEG_THREADS), "-ss", f"{start:.3f}",
            "-t", f"{dur:.3f}", "-i", src, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
            out_wav]
    r = run_tool(argv, timeout=600)
    if r.returncode != 0:
        raise ClipError(f"audio extract failed: {r.stderr.strip()[-200:]}")


def _token_confidence(seg):
    """Mean probability of a whisper.cpp segment's text tokens (full JSON, -ojf), or None without token data.
    Special tokens ([_BEG_], [_TT_123], ...) are left out."""
    ps = []
    for t in seg.get("tokens") or []:
        if not isinstance(t, dict) or str(t.get("text", "")).startswith("[_"):
            continue
        try:
            ps.append(float(t["p"]))
        except (KeyError, TypeError, ValueError):
            continue
    return round(sum(ps) / len(ps), 4) if ps else None


def _token_words(seg):
    """LV1 (D421): the words of a whisper.cpp segment from its full-JSON tokens (offsets in ms). A token whose text
    starts with a space starts a new word; any other token continues the word before it (sub-word pieces and bytes
    of one letter). Special tokens are left out. -> [{start, end, text}] in seconds, or None without token times."""
    words = []
    for t in seg.get("tokens") or []:
        if not isinstance(t, dict):
            continue
        text = str(t.get("text", ""))
        if not text or text.startswith("[_"):
            continue
        try:
            a, b = float(t["offsets"]["from"]) / 1000.0, float(t["offsets"]["to"]) / 1000.0
        except (KeyError, TypeError, ValueError):
            return None
        if words and not text[:1].isspace():
            words[-1]["text"] += text
            words[-1]["end"] = max(words[-1]["end"], b)
        else:
            words.append({"start": a, "end": max(a, b), "text": text})
    out = [dict(w, text=w["text"].strip()) for w in words if w["text"].strip()]
    return out or None


def parse_whisper_cpp_json(j):
    out = []
    for seg in j.get("transcription", []) if isinstance(j, dict) else []:
        try:
            a = float(seg["offsets"]["from"]) / 1000.0
            b = float(seg["offsets"]["to"]) / 1000.0
            text = str(seg.get("text", "")).strip()
        except (KeyError, TypeError, ValueError):
            continue
        if text and b > a:
            row = {"start": a, "end": b, "text": text}
            conf = _token_confidence(seg)
            if conf is not None:  # ED2 (D353): only with the full JSON (-ojf); short clips ignore it
                row["confidence"] = conf
            words = _token_words(seg)
            if words:  # LV1 (D421): word times, for the word-by-word captions
                row["words"] = words
            out.append(row)
    return out


def segment_confidence(avg_logprob, no_speech_prob):
    """ED2 (D353): one 0..1 confidence for a faster-whisper segment: the mean token probability (exp of the average
    log probability) times the chance that the segment is speech at all."""
    import math  # noqa: PLC0415
    try:
        return round(max(0.0, min(1.0, math.exp(float(avg_logprob)) * (1.0 - float(no_speech_prob)))), 4)
    except (TypeError, ValueError, OverflowError):
        return None


def transcribe(backend, wav, opts):
    """Returns (segments, info). info.status is 'ok', 'off' or 'unavailable' (with a reason)."""
    if backend == "none":
        return [], {"backend": "none", "status": "off"}
    if backend == "whisper-cli":
        binp, model = opts.get("whisper_bin"), opts.get("whisper_model")
        if not binp or not os.path.isfile(binp) or not model or not os.path.isfile(model):
            return [], {"backend": backend, "status": "unavailable", "reason": "whisper-cli binary or model missing"}
        base = os.path.splitext(wav)[0]
        argv = [binp, "-m", model, "-f", wav, "-ojf" if opts.get("full_json") else "-oj", "-of", base, "-t", "4"]
        if opts.get("language"):
            argv += ["-l", opts["language"]]
        r = run_tool(argv, timeout=1800)
        if r.returncode != 0 or not os.path.isfile(base + ".json"):
            return [], {"backend": backend, "status": "unavailable", "reason": f"whisper-cli exit {r.returncode}"}
        with open(base + ".json", encoding="utf-8", errors="replace") as f:
            segs = parse_whisper_cpp_json(json.load(f))
        return segs, {"backend": backend, "status": "ok", "segments": len(segs)}
    if backend == "faster-whisper":
        iso = opts.get("isolate") if isinstance(opts.get("isolate"), dict) else None
        if iso:  # the child imports it; the parent never loads ctranslate2 or CUDA
            import importlib.util  # noqa: PLC0415
            if importlib.util.find_spec("faster_whisper") is None:
                return [], {"backend": backend, "status": "unavailable", "reason": "faster_whisper not installed"}
            WhisperModel = None  # noqa: N806
        else:
            try:
                from faster_whisper import WhisperModel  # noqa: PLC0415 (optional, not installed)
            except ImportError:
                return [], {"backend": backend, "status": "unavailable", "reason": "faster_whisper not installed"}
        model = opts.get("whisper_model")
        if not model:
            return [], {"backend": backend, "status": "unavailable", "reason": "no --whisper-model (local path)"}
        fb = opts.get("fallback") or {}
        can_fall_back = opts.get("device") == "cuda" and bool(fb.get("whisper_model"))
        try:
            if can_fall_back and _GPU_FAILED:
                # 2026-11-27 (alpha.49): a second GPU try in the same run hung inside ctranslate2 and froze the job.
                # Once the GPU model failed in this process, every later clip goes straight to the CPU model.
                raise _StickyGpuFailure(_GPU_FAILED[0])
            out, lang = _attempt(WhisperModel, model, opts, wav, iso)
        except Exception as e:  # noqa: BLE001 - C3: a GPU model that fails (driver, memory) falls back to the CPU one
            if not can_fall_back:
                if isinstance(e, CaptionTimeout):
                    return [], _timed_out(backend, model, opts, e)
                raise
            if not isinstance(e, _StickyGpuFailure):
                _GPU_FAILED[:] = [error_line(e) if isinstance(e, _ChildError) else f"{type(e).__name__}: {error_line(e)}"]
                eprint(f"captions: {os.path.basename(model)} on the GPU failed ({_GPU_FAILED[0]}); "
                       f"using {os.path.basename(fb['whisper_model'])} on the CPU")
            opts = dict(opts, **fb)
            model = fb["whisper_model"]
            try:
                out, lang = _attempt(WhisperModel, model, opts, wav, iso)
            except CaptionTimeout as t:
                return [], _timed_out(backend, model, opts, t)
        return out, {"backend": backend, "status": "ok", "segments": len(out), "language": lang,
                     "model": os.path.basename(model), "device": opts.get("device", "cpu")}
    raise ClipError(f"unknown captions backend {backend}")


# ---------------------------------------------------------------- GPU failure memory and the child process

_GPU_FAILED = []  # [reason] once the GPU caption model failed in this process (sticky for the rest of the run)


class _StickyGpuFailure(RuntimeError):
    """The GPU model already failed earlier in this process: not tried again."""


class _ChildError(RuntimeError):
    """The child failed; its text already names the error type."""


class CaptionTimeout(RuntimeError):
    """The speech to text child ran past its limit and was stopped (a hung native call cannot be interrupted)."""


def reset_gpu_failure():
    """Forget an earlier GPU failure (tests; a new process starts clean anyway)."""
    _GPU_FAILED.clear()


def error_line(e, limit=160):
    """The first line of an error's text, cut to `limit` characters ('' when it has none)."""
    s = str(e).strip().splitlines()
    s = s[0].strip() if s else ""
    return s if len(s) <= limit else s[:limit - 3] + "..."


def _timed_out(backend, model, opts, e):
    eprint(f"captions: the speech to text with {os.path.basename(model)} on the {opts.get('device', 'cpu').upper()} "
           f"did not finish in {e.limit:g} s and was stopped; this clip has no captions, the job goes on")
    return {"backend": backend, "status": "unavailable", "reason": f"speech to text stopped after {e.limit:g} s"}


def wav_seconds(wav):
    """Length of a PCM wav in seconds, or 0.0 when it cannot be read."""
    import wave  # noqa: PLC0415
    try:
        with wave.open(wav, "rb") as w:
            return w.getnframes() / float(w.getframerate() or 1)
    except (OSError, EOFError, wave.Error):
        return 0.0


def child_limit(iso, wav):
    """Seconds the child may run: setupSec (model load) + perAudioSec x the wav's length (data/clip/reel-captions.json
    `isolate`)."""
    return float(iso.get("setupSec", 300)) + float(iso.get("perAudioSec", 4)) * wav_seconds(wav)


def _attempt(WhisperModel, model, opts, wav, iso):  # noqa: N803
    if not iso:
        return _faster_whisper(WhisperModel, model, opts, wav)
    return _faster_whisper_child(model, opts, wav, iso)


def _child_argv(req_path):
    """The child: this interpreter, isolated (-I drops the script folder from sys.path, so it is added back)."""
    here = os.path.dirname(os.path.abspath(__file__))
    code = (f"import sys; sys.path.insert(0, {here!r}); import clip_captions as c; "
            f"sys.exit(c._child_main({req_path!r}))")
    return [sys.executable, "-I", "-c", code]


def _faster_whisper_child(model, opts, wav, iso):
    """One faster-whisper run in a child process (run_tool: no console window, kill-on-close job). A child that runs
    past child_limit() is killed with its whole tree -> CaptionTimeout. A child that fails -> RuntimeError with its
    error text. The result comes back as a JSON file: {segments, language} or {error}."""
    import subprocess  # noqa: PLC0415
    import tempfile  # noqa: PLC0415
    limit = child_limit(iso, wav)
    keep = {k: v for k, v in opts.items() if k not in ("fallback", "isolate")}
    with tempfile.TemporaryDirectory(dir=os.path.dirname(os.path.abspath(wav)) or None) as td:
        req, res = os.path.join(td, "req.json"), os.path.join(td, "res.json")
        with open(req, "w", encoding="utf-8") as f:
            json.dump({"model": model, "opts": keep, "wav": os.path.abspath(wav), "out": res}, f)
        try:
            r = run_tool(_child_argv(req), timeout=limit)
        except subprocess.TimeoutExpired:
            t = CaptionTimeout(f"speech to text did not finish in {limit:g} s")
            t.limit = limit
            raise t from None
        try:
            with open(res, encoding="utf-8") as f:
                doc = json.load(f)
        except (OSError, ValueError):
            last = (r.stderr or "").strip().splitlines()[-1:]
            doc = {"error": f"speech to text child exit {r.returncode}" + (f": {last[0][:160]}" if last else "")}
        if r.returncode != 0 or "error" in doc:
            raise _ChildError(doc.get("error") or f"speech to text child exit {r.returncode}")
        return doc["segments"], doc.get("language")


def _child_main(req_path):
    """Child entry: runs _faster_whisper and writes {segments, language} or {error} to the request's out file."""
    with open(req_path, encoding="utf-8") as f:
        req = json.load(f)
    try:
        from faster_whisper import WhisperModel  # noqa: PLC0415
        segs, lang = _faster_whisper(WhisperModel, req["model"], req["opts"], req["wav"])
        doc, rc = {"segments": segs, "language": lang}, 0
    except Exception as e:  # noqa: BLE001 - reported to the parent as text
        doc, rc = {"error": f"{type(e).__name__}: {error_line(e)}"}, 1
    with open(req["out"], "w", encoding="utf-8") as f:
        json.dump(doc, f)
    return rc


def _faster_whisper(WhisperModel, model, opts, wav):  # noqa: N803 (the class, passed in: an optional import)
    """One faster-whisper run -> (segments, language). The model is freed on return (GPU memory too)."""
    m = WhisperModel(model, device=opts.get("device", "cpu"), compute_type=opts.get("compute_type", "int8"),
                     cpu_threads=4, local_files_only=True)
    try:
        # vad_filter: without it a segment after leading silence is stamped from 0.0, so the caption showed seconds
        # before the speech (caption seam, tests/py/test_caption_seam.py). Silero VAD ships inside faster-whisper and
        # runs on the CPU through onnxruntime; segment times stay on the clip timeline.
        # ED2 (D353): task is always "transcribe" (never translate); multilingual (opts, reel captions) detects the
        # language per segment for the mixed Malayalam and English speech. Text is kept in the script the model wrote.
        kw = {"multilingual": True} if opts.get("multilingual") else {}
        segs, info = m.transcribe(wav, language=opts.get("language"), vad_filter=True, task="transcribe",
                                  word_timestamps=bool(opts.get("words")), **kw)
        out = []
        for s in segs:
            if not s.text.strip():
                continue
            row = {"start": float(s.start), "end": float(s.end), "text": s.text.strip(),
                   "confidence": segment_confidence(s.avg_logprob, s.no_speech_prob)}
            words = [{"start": float(w.start), "end": float(w.end), "text": w.word.strip()}
                     for w in (getattr(s, "words", None) or []) if w.word.strip()]
            if words:  # LV1 (D421)
                row["words"] = words
            out.append(row)
        return out, getattr(info, "language", None)
    finally:
        del m


# ---------------------------------------------------------------- ASS

def safe_area(targets):
    """Intersection of every target's safe zone (largest margin on each side)."""
    m = {"top": 0, "bottom": 0, "left": 0, "right": 0}
    for t in targets.get("targets", []):
        for k in m:
            m[k] = max(m[k], int(t.get("safe", {}).get(k, 0)))
    return m


def wrap(text, width=MAX_CHARS_PER_LINE, max_lines=MAX_LINES):
    """Greedy word wrap; text beyond max_lines becomes further chunks (each chunk is one caption card)."""
    words = re.sub(r"\s+", " ", text).strip().split(" ")
    lines, cur = [], ""
    for w in words:
        if not w:
            continue
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}" if cur else w
    if cur:
        lines.append(cur)
    return [lines[i:i + max_lines] for i in range(0, len(lines), max_lines)] or []


def ass_escape(text):
    # Captions are speech-to-text output: neutralise ASS override blocks and hard breaks.
    return text.replace("\\", "⧵").replace("{", "(").replace("}", ")").replace("\n", " ")


def _ts(sec):
    sec = max(0.0, sec)
    cs = int(round(sec * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def to_ass(segments, frame, safe, font="Arial", size=64, duration=None):
    """ASS script (1080x1920 PlayRes). Bottom-centre style; MarginV = bottom safe margin; L/R margins = safe sides."""
    w, h = int(frame["width"]), int(frame["height"])
    head = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {w}",
        f"PlayResY: {h}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Cap,{font},{size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,5,2,2,"
        f"{safe['left']},{safe['right']},{safe['bottom']},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    ev = []
    for s in segments:
        a, b = float(s["start"]), float(s["end"])
        if duration is not None:
            b = min(b, duration)
        if b <= a:
            continue
        chunks = wrap(ass_escape(s["text"]))
        if not chunks:
            continue
        step = (b - a) / len(chunks)
        for i, ch in enumerate(chunks):
            body = "\\N".join(ch)
            ev.append(f"Dialogue: 0,{_ts(a + i * step)},{_ts(a + (i + 1) * step)},Cap,,0,0,0,,{body}")
    return "\n".join(head + ev) + "\n"
