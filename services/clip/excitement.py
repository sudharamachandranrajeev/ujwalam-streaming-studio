# SPDX-License-Identifier: GPL-3.0-or-later
"""D443 T6 voice and excitement: an excitement score per second of a recording, used post-stream to rank clip
candidates (clip_rank events 'voice.excitement' and 'voice.phrase') and reel cuts (moment_score).

Parts (all per second, each 0..1; rules, weights and windows in data/clip/excitement.json, status unverified):
  loudRise   the speaker's loudness (RMS dBFS) over their own rolling baseline (median/MAD of earlier voiced seconds)
  pitchRise  the pitch (autocorrelation over voiced 50 ms frames) over the same kind of rolling baseline
  phrase     a marker phrase in the transcript (adipoli, polich, scene, super; Malayalam script, Manglish, English)
  event      laughter / shout / cheer from the YAMNet audio-event model (ONNX, CPU only; download item audio-events)
  chat       chat rate over a window against the session median (the engage chat counts clip_signals.read_chat makes)
score = sum(weight * part) / sum(weights of the parts that were available). A part that is missing (no model, no
transcript, no chat) is left out, never guessed. Any failure in a part: that part is off, the clip run goes on.

Off air only: this runs inside the post-stream clipper. Nothing here talks to the host or the stream.
Flag 'voice-excitement' (data/flags.json): off -> no excitement events at all.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import statistics
import time
import unicodedata

FLAG = "voice-excitement"
_HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(_HERE))
CONFIG_FILE = os.path.join(REPO, "data", "clip", "excitement.json")
DOWNLOAD_FILE = os.path.join(REPO, "data", "downloads", "audio-events.json")
DOWNLOAD_ID = "audio-events"
PARTS = ("loudRise", "pitchRise", "phrase", "event", "chat")


def load_config(path=None):
    with open(path or CONFIG_FILE, encoding="utf-8") as f:
        cfg = json.load(f)
    w = cfg["weights"]
    for k in PARTS:
        if not isinstance(w.get(k), (int, float)) or w[k] < 0:
            raise ValueError(f"excitement config: bad weights.{k}")
    return cfg


# ---------------------------------------------------------------- phrases

_LATIN_WORD = re.compile(r"[a-z0-9]+")


def _fold(s):
    """Lower case, NFC, runs of one repeated letter folded to one (adipoliii -> adipoli, suuper -> super)."""
    return re.sub(r"(.)\1+", r"\1", unicodedata.normalize("NFC", s).casefold())


def compile_phrases(cfg):
    """-> [(id, [latin token tuples], [malayalam strings])] from cfg['phrases']['items']."""
    out = []
    for it in cfg["phrases"]["items"]:
        lat = [tuple(_LATIN_WORD.findall(_fold(v))) for v in it.get("latin", [])]
        mal = [unicodedata.normalize("NFC", v) for v in it.get("malayalam", [])]
        out.append((it["id"], [t for t in lat if t], [m for m in mal if m]))
    return out


def match_phrases(text, compiled):
    """Phrase ids found in text (each id once, in the order of the config). Latin: whole adjacent words; Malayalam:
    part of a word (endings join the word). Text is only tested, never kept."""
    if not isinstance(text, str) or not text:
        return []
    norm = unicodedata.normalize("NFC", text)
    words = _LATIN_WORD.findall(_fold(norm))
    found = []
    for pid, lat, mal in compiled:
        hit = any(m in norm for m in mal)
        if not hit:
            for toks in lat:
                n = len(toks)
                if any(tuple(words[i:i + n]) == toks for i in range(len(words) - n + 1)):
                    hit = True
                    break
        if hit:
            found.append(pid)
    return found


def phrase_seconds(segments, duration, compiled):
    """Transcript segments [{start, end, text, words?: [{start, end, word}]}] -> ({second: [ids]}, count). Word times
    are used when the words alone carry the phrase; else the segment's start second."""
    n = max(0, int(duration + 0.999))
    hits = {}
    count = 0
    for seg in segments or []:
        ids = match_phrases(seg.get("text", ""), compiled)
        if not ids:
            continue
        t = float(seg.get("start", 0.0))
        for w in seg.get("words") or []:
            if match_phrases(w.get("word", ""), compiled):
                t = float(w.get("start", t))
                break
        s = int(t)
        if 0 <= s < n:
            hits.setdefault(s, [])
            for i in ids:
                if i not in hits[s]:
                    hits[s].append(i)
                    count += 1
    return hits, count


# ---------------------------------------------------------------- baseline rise

def rolling_rise(values, floor, baseline_sec, min_voiced, min_spread, z_full):
    """Causal rise over the speaker's own baseline. values: per-second numbers (None = unvoiced). For each voiced second
    the z against the median/MAD (x1.4826, at least min_spread) of the last baseline_sec earlier voiced seconds;
    part = clamp(z / z_full, 0, 1). Fewer than min_voiced earlier voiced seconds -> 0 (still learning)."""
    out = [0.0] * len(values)
    hist = []
    for i, x in enumerate(values):
        if x is None or not (x > floor):
            continue
        if len(hist) >= min_voiced:
            med = statistics.median(hist)
            spread = max(min_spread, statistics.median([abs(h - med) for h in hist]) * 1.4826)
            out[i] = min(1.0, max(0.0, (x - med) / spread / z_full))
        hist.append(x)
        if len(hist) > baseline_sec:
            hist.pop(0)
    return out


# ---------------------------------------------------------------- audio features

def frame_features(samples, sr, pitch_min, pitch_max, floor_db):
    """One second of mono float samples -> (rms dBFS or None, pitch Hz or None). Pitch: the median over voiced 50 ms
    frames of the autocorrelation peak inside [pitch_min, pitch_max]; a frame is voiced when its peak is >= 0.3 of
    its energy and its level is above floor_db."""
    import numpy as np  # noqa: PLC0415
    x = np.asarray(samples, dtype=np.float32)
    if x.size == 0:
        return None, None
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2)))
    db = 20.0 * np.log10(rms) if rms > 1e-9 else -120.0
    if db <= floor_db:
        return None, None
    flen = int(sr * 0.05)
    nf = x.size // flen
    if nf == 0:
        return db, None
    fr = x[: nf * flen].reshape(nf, flen).astype(np.float64)
    fr = fr - fr.mean(axis=1, keepdims=True)
    lo, hi = max(1, int(sr / pitch_max)), min(flen - 1, int(sr / pitch_min))
    nfft = 1 << (2 * flen - 1).bit_length()
    spec = np.fft.rfft(fr, nfft, axis=1)
    ac = np.fft.irfft(spec * np.conj(spec), nfft, axis=1)[:, :flen]
    e = ac[:, 0]
    fdb = 10.0 * np.log10(np.maximum(e / flen, 1e-12))
    seg = ac[:, lo:hi + 1]
    lag = seg.argmax(axis=1) + lo
    peak = seg.max(axis=1)
    ok = (e > 0) & (peak >= 0.3 * e) & (fdb > floor_db)
    if not ok.any():
        return db, None
    return db, float(np.median(sr / lag[ok]))


def voice_parts(read_second, n_sec, vcfg):
    """read_second(i) -> samples of second i (or None). -> (loudRise[], pitchRise[], stats)."""
    sr = int(vcfg["sampleRate"])
    loud, pitch = [], []
    for i in range(n_sec):
        s = read_second(i)
        db, hz = (None, None) if s is None else frame_features(s, sr, vcfg["pitchMinHz"], vcfg["pitchMaxHz"], vcfg["floorDb"])
        loud.append(db)
        pitch.append(hz)
    base, mv, z = int(vcfg["baselineSec"]), int(vcfg["minVoicedSec"]), float(vcfg["zFull"])
    lr = rolling_rise(loud, float(vcfg["floorDb"]), base, mv, float(vcfg["minSpreadDb"]), z)
    pr = rolling_rise(pitch, 0.0, base, mv, float(vcfg["minSpreadHz"]), z)
    return lr, pr, {"voicedSec": sum(1 for x in loud if x is not None), "pitchedSec": sum(1 for x in pitch if x is not None)}


# ---------------------------------------------------------------- audio-event model

def pinned_file(models_dir, cfg, download_file=DOWNLOAD_FILE):
    """(path, sha256) of the model when the download manager put it in place, else (None, reason)."""
    try:
        with open(download_file, encoding="utf-8") as f:
            item = next(i for i in json.load(f)["items"] if i["id"] == DOWNLOAD_ID)
        want = next(x for x in item["files"] if x["name"] == cfg["events"]["file"])
    except (OSError, ValueError, KeyError, StopIteration):
        return None, "download item missing"
    if not models_dir:
        return None, "no data folder"
    p = os.path.join(models_dir, *cfg["events"]["dest"].split("/")[1:], cfg["events"]["file"]) \
        if cfg["events"]["dest"].startswith("models/") else None
    if not p or not os.path.isfile(p):
        return None, "model not downloaded"
    if os.path.getsize(p) != want["bytes"]:
        return None, "model size differs"
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    if h.hexdigest() != want["sha256"]:
        return None, "model checksum differs"
    return p, want["sha256"]


class AudioEvents:
    """YAMNet through onnxruntime on the CPU (CPUExecutionProvider only, threads from config). load() -> bool; a
    missing onnxruntime, a missing or changed model file or a load error leaves it unavailable with a reason."""

    def __init__(self, cfg, model_path, session_factory=None):
        self.cfg = cfg
        self.path = model_path
        self.reason = None
        self._sess = None
        self._factory = session_factory

    def load(self):
        if not self.path:
            self.reason = self.reason or "model not downloaded"
            return False
        try:
            if self._factory:
                self._sess = self._factory(self.path)
            else:
                import onnxruntime as ort  # noqa: PLC0415
                so = ort.SessionOptions()
                so.intra_op_num_threads = int(self.cfg["events"].get("threads", 2))
                so.inter_op_num_threads = 1
                self._sess = ort.InferenceSession(self.path, so, providers=["CPUExecutionProvider"])
            return True
        except Exception as e:  # noqa: BLE001 - any failure = part off
            self.reason = f"model load failed: {type(e).__name__}"
            self._sess = None
            return False

    def second_probs(self, wave, sr):
        """Mono float32 wave at 16 kHz -> {kind: [prob per second]} (max over the YAMNet frames whose centre falls in
        the second, max over the kind's classes)."""
        import numpy as np  # noqa: PLC0415
        x = np.asarray(wave, dtype=np.float32)
        n_sec = int(x.size // sr)
        out = {k: [0.0] * n_sec for k in self.cfg["events"]["classes"]}
        if n_sec == 0 or self._sess is None:
            return out
        inp = self._sess.get_inputs()[0].name
        scores = np.asarray(self._sess.run(None, {inp: x})[0])
        hop = 0.48  # YAMNet: 0.96 s windows every 0.48 s
        for fi in range(scores.shape[0]):
            s = int(fi * hop + 0.48)
            if s >= n_sec:
                break
            for k, idx in self.cfg["events"]["classes"].items():
                v = float(scores[fi, idx].max())
                if v > out[k][s]:
                    out[k][s] = v
        return out


def event_part(probs, n_sec, full):
    """{kind: [p]} -> per-second part: max over kinds, p / full clamped to 1."""
    out = [0.0] * n_sec
    for arr in probs.values():
        for i, p in enumerate(arr[:n_sec]):
            v = min(1.0, max(0.0, p / full))
            if v > out[i]:
                out[i] = v
    return out


# ---------------------------------------------------------------- chat

def chat_part(counts, ccfg):
    """Per-second chat counts -> part: rolling count over windowSec / max(minMessages, ratio * median), clamped."""
    if not counts:
        return None
    win = max(1, int(ccfg["windowSec"]))
    roll, s = [], 0
    for i, c in enumerate(counts):
        s += c
        if i >= win:
            s -= counts[i - win]
        roll.append(s)
    if not any(roll):
        return [0.0] * len(counts)
    need = max(float(ccfg["minMessages"]), statistics.median(roll) * float(ccfg["ratio"]))
    return [min(1.0, r / need) for r in roll]


# ---------------------------------------------------------------- combine

def combine(parts, weights, n_sec):
    """parts: {name: [0..1 per second] or None}. -> score per second, over the weights of the available parts."""
    avail = {k: v for k, v in parts.items() if v is not None and weights.get(k, 0) > 0}
    total = sum(weights[k] for k in avail)
    if total <= 0:
        return [0.0] * n_sec
    out = []
    for i in range(n_sec):
        out.append(round(sum(weights[k] * (v[i] if i < len(v) else 0.0) for k, v in avail.items()) / total, 4))
    return out


def excitement_events(score, phrase_hits, rcfg):
    """Score per second + phrase seconds -> clip_rank events. 'voice.excitement' at local maxima >= threshold (one per
    minGapSec, strongest first); 'voice.phrase' at each phrase second (one per minGapSec)."""
    gap = int(rcfg["minGapSec"])
    thr = float(rcfg["threshold"])

    def nms(peaks):
        kept = []
        for i, v in sorted(peaks, key=lambda p: (-p[1], p[0])):
            if all(abs(i - j) >= gap for j, _ in kept):
                kept.append((i, v))
        return sorted(kept)
    ev = []
    for i, v in nms([(i, v) for i, v in enumerate(score) if v >= thr]):
        ev.append({"t": i + 0.5, "kind": "voice.excitement", "w": float(rcfg["excitementWeight"]), "strength": float(v),
                   "detail": {"score": round(v, 3)}, "win": "audio"})
    for i, _ in nms([(s, 1.0) for s in sorted(phrase_hits)]):
        ev.append({"t": i + 0.5, "kind": "voice.phrase", "w": float(rcfg["phraseWeight"]), "strength": 1.0,
                   "detail": {"phrases": list(phrase_hits[i])}, "win": "audio"})
    return ev


def moment_score(score, start, end):
    """Highest excitement score in [start, end) seconds (reel cuts order their pieces by it); 0 when unknown."""
    if not score:
        return 0.0
    a, b = max(0, int(start)), min(len(score), int(end + 0.999))
    return max(score[a:b], default=0.0)


def attach_scores(cands, score):
    """Adds 'excitement' (moment_score) to every candidate; never changes the order or the score."""
    for c in cands:
        c["excitement"] = round(moment_score(score, c["start"], c["end"]), 3)
    return cands


# ---------------------------------------------------------------- recording

def decode_wave(ffmpeg, recording, wd, vcfg, run_tool, duration):
    """ffmpeg -> <wd>/excitement.s16 (mono s16le at sampleRate, the configured audio track). -> path or None."""
    out = os.path.join(wd, "excitement.s16")
    argv = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", recording,
            "-map", f"0:a:{int(vcfg.get('track', 0))}", "-ac", "1", "-ar", str(int(vcfg["sampleRate"])),
            "-f", "s16le", out]
    r = run_tool(argv, timeout=max(600, int(duration) * 2))
    return out if r.returncode == 0 and os.path.isfile(out) else None


def analyse(recording, duration, *, ffmpeg, run_tool, wd, models_dir, chat_counts=None, transcript=None, cfg=None,
            events_factory=None, log=None):
    """The whole post-stream pass. -> (score[], phrase_hits{}, stats). Never raises: a part that fails is off."""
    import numpy as np  # noqa: PLC0415
    cfg = cfg or load_config()
    vcfg = cfg["voice"]
    sr = int(vcfg["sampleRate"])
    n_sec = max(0, int(duration))
    stats = {"status": cfg.get("status"), "parts": {}}
    parts = {k: None for k in PARTS}
    wave = None
    raw = None
    try:
        raw = decode_wave(ffmpeg, recording, wd, vcfg, run_tool, duration)
        if raw:
            wave = np.memmap(raw, dtype="<i2", mode="r")
    except Exception as e:  # noqa: BLE001
        stats["parts"]["audio"] = f"decode failed: {type(e).__name__}"
    try:
        if wave is not None:
            n_sec = min(n_sec, int(wave.size // sr)) if wave.size else n_sec
            t0 = time.perf_counter()

            def read_second(i):
                seg = wave[i * sr:(i + 1) * sr]
                return None if seg.size == 0 else seg.astype(np.float32) / 32768.0
            lr, pr, vs = voice_parts(read_second, n_sec, vcfg)
            parts["loudRise"], parts["pitchRise"] = lr, pr
            stats["parts"]["voice"] = {**vs, "sec": round(time.perf_counter() - t0, 2)}
            ae = AudioEvents(cfg, None, events_factory)
            path, why = pinned_file(models_dir, cfg)
            ae.path = path
            if path is None:
                ae.reason = why
            if ae.load():
                t0 = time.perf_counter()
                probs = {k: [] for k in cfg["events"]["classes"]}
                chunk = 60  # seconds per model call: bounded memory
                for a in range(0, n_sec, chunk):
                    b = min(n_sec, a + chunk)
                    p = ae.second_probs(wave[a * sr:b * sr].astype(np.float32) / 32768.0, sr)
                    for k in probs:
                        probs[k].extend((p[k] + [0.0] * (b - a))[: b - a])
                parts["event"] = event_part(probs, n_sec, float(cfg["events"]["full"]))
                stats["parts"]["event"] = {"model": cfg["events"]["file"], "sec": round(time.perf_counter() - t0, 2),
                                           "secondsOver": sum(1 for v in parts["event"] if v >= 1.0)}
            else:
                stats["parts"]["event"] = ae.reason
    except Exception as e:  # noqa: BLE001
        stats["parts"]["voiceError"] = type(e).__name__
    finally:
        wave = None
        if raw:
            try:
                os.remove(raw)
            except OSError:
                pass
    hits = {}
    try:
        if transcript:
            hits, cnt = phrase_seconds(transcript, n_sec, compile_phrases(cfg))
            parts["phrase"] = [1.0 if s in hits else 0.0 for s in range(n_sec)]
            stats["parts"]["phrase"] = {"hits": cnt}
    except Exception as e:  # noqa: BLE001
        stats["parts"]["phrase"] = f"failed: {type(e).__name__}"
    try:
        cp = chat_part(chat_counts, cfg["chat"]) if chat_counts else None
        if cp is not None:
            parts["chat"] = cp[:n_sec] + [0.0] * max(0, n_sec - len(cp))
    except Exception as e:  # noqa: BLE001
        stats["parts"]["chat"] = f"failed: {type(e).__name__}"
    stats["used"] = [k for k in PARTS if parts[k] is not None]
    score = combine(parts, cfg["weights"], n_sec)
    if log:
        log(f"excitement: parts {','.join(stats['used']) or 'none'}")
    return score, hits, stats


def load_transcript(path):
    """A transcript JSON ({segments: [...]} or [...]) -> segments, or None."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            j = json.load(f)
    except (OSError, ValueError):
        return None
    segs = j.get("segments") if isinstance(j, dict) else j
    return segs if isinstance(segs, list) else None
