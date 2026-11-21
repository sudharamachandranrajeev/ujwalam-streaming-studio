# SPDX-License-Identifier: GPL-3.0-or-later
"""Synthetic example videos for the reel styles tests (RS1-RS4, D412): shots of known colour and motion, cuts of known
kind at known times, zoom pulses, a speed ramp, burned-in text boxes, a colour cast and a tone track on a known beat.
Every value is made here; no real footage. Needs numpy, OpenCV and PyAV (the project venv)."""

import math
import wave

import numpy as np

SR = 48000


def _canvas(w, h, hue, seed):
    """A shot's picture source, twice the frame size: a hue band across x and soft blobs in brightness."""
    import cv2  # noqa: PLC0415
    rng = np.random.default_rng(seed)
    W, H = 2 * w, 2 * h
    noise = rng.uniform(0, 1, (H // 8 + 1, W // 8 + 1)).astype(np.float32)
    blobs = cv2.resize(noise, (W, H), interpolation=cv2.INTER_CUBIC)
    blobs = cv2.GaussianBlur(blobs, (0, 0), 6)
    blobs = (blobs - blobs.min()) / max(1e-6, blobs.max() - blobs.min())
    x = np.linspace(0, 1, W, dtype=np.float32)[None, :].repeat(H, 0)
    hsv = np.zeros((H, W, 3), np.float32)
    hsv[..., 0] = (hue + 20.0 * np.sin(2 * np.pi * x)) % 180.0
    hsv[..., 1] = 150 + 80 * blobs
    hsv[..., 2] = 90 + 150 * blobs
    return cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2BGR)


def _view(canvas, w, h, ox, z):
    """A w x h view into the canvas, offset ox (px, wraps), zoomed by z about the view's centre."""
    import cv2  # noqa: PLC0415
    H, W = canvas.shape[:2]
    span = W - w  # ping-pong inside the canvas: never a jump (a jump would be a cut)
    m = ox % (2 * span)
    cx = w / 2.0 + (m if m <= span else 2 * span - m)
    cy = H / 2.0
    M = np.array([[z, 0, w / 2.0 - z * cx], [0, z, h / 2.0 - z * cy]], np.float32)
    return cv2.warpAffine(canvas, M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)


def _text(img, box, label="GG WP"):
    import cv2  # noqa: PLC0415
    h, w = img.shape[:2]
    x0, y0, x1, y1 = [int(round(v)) for v in (box[0] * w, box[1] * h, box[2] * w, box[3] * h)]
    cv2.rectangle(img, (x0, y0), (x1, y1), (20, 20, 20), -1)
    th = y1 - y0
    scale = cv2.getFontScaleFromHeight(cv2.FONT_HERSHEY_DUPLEX, int(th * 0.6), 2)
    (tw, tth), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_DUPLEX, scale, 2)
    cv2.putText(img, label, (x0 + max(2, (x1 - x0 - tw) // 2), y0 + (th + tth) // 2), cv2.FONT_HERSHEY_DUPLEX, scale,
                (255, 255, 255), 2, cv2.LINE_AA)


def cast(img, b_shift=0.0, a_shift=0.0):
    """A colour cast in Lab (b > 0 warm, a > 0 magenta)."""
    import cv2  # noqa: PLC0415
    lab = cv2.cvtColor(img.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab)
    lab[..., 1] += a_shift
    lab[..., 2] += b_shift
    return np.clip(cv2.cvtColor(lab, cv2.COLOR_Lab2BGR) * 255.0 + 0.5, 0, 255).astype(np.uint8)


def frames(spec):
    """Yields BGR frames of a spec:
    {w, h, fps, shots: [{sec, hue, speed (px/frame), ramp: {at, speed}?, zooms: [{at, scale, inSec, outSec}]}],
     joins: ["hard" | "fade" | "flash" | "whip"] (one per cut), joinFrames, texts: [{start, sec, box}], cast: {a, b}}
    Times inside a shot are seconds from the shot start. Transition frames replace the end of a shot and the start of
    the next (the reel length is the sum of the shots)."""
    w, h, fps = spec["w"], spec["h"], spec["fps"]
    jf = int(spec.get("joinFrames", 8))
    canv = [_canvas(w, h, s["hue"], 11 + i) for i, s in enumerate(spec["shots"])]
    starts = np.cumsum([0.0] + [s["sec"] for s in spec["shots"]])
    nf = int(round(starts[-1] * fps))

    def shot_frame(k, t):
        s = spec["shots"][k]
        tt = max(0.0, t - starts[k])
        sp, ox = s.get("speed", 1.0), 0.0
        r = s.get("ramp")
        if r and tt > r["at"]:
            ox = sp * r["at"] * fps + r["speed"] * (tt - r["at"]) * fps
        else:
            ox = sp * tt * fps
        z = 1.0
        for zp in s.get("zooms", []):
            a, pk = zp["at"] - zp["inSec"], zp["at"]
            if a <= tt <= pk:
                z = max(z, 1 + (zp["scale"] - 1) * math.sin(0.5 * math.pi * (tt - a) / zp["inSec"]))
            elif pk < tt <= pk + zp["outSec"]:
                z = max(z, 1 + (zp["scale"] - 1) * math.cos(0.5 * math.pi * (tt - pk) / zp["outSec"]))
        return _view(canv[k], w, h, ox, z)

    joins = spec.get("joins") or ["hard"] * (len(spec["shots"]) - 1)
    cut_frames = [int(round(starts[k + 1] * fps)) for k in range(len(spec["shots"]) - 1)]
    for i in range(nf):
        t = i / fps
        k = int(np.searchsorted(starts, t, side="right") - 1)
        k = min(k, len(spec["shots"]) - 1)
        img = shot_frame(k, t)
        for c, (cf, kind) in enumerate(zip(cut_frames, joins)):
            if kind == "hard" or not (cf - jf // 2 <= i < cf + jf - jf // 2):
                continue
            p = (i - (cf - jf // 2) + 0.5) / jf
            A, B = shot_frame(c, t), shot_frame(c + 1, t)
            if kind == "fade":
                img = (A * (1 - p) + B * p).astype(np.uint8)
            elif kind == "flash":
                white = np.full_like(A, 255)
                img = ((A * (1 - 2 * p) + white * 2 * p) if p < 0.5 else (white * (2 - 2 * p) + B * (2 * p - 1))).astype(np.uint8)
            elif kind == "whip":
                sh = int(round(p * w))
                img = np.concatenate([A[:, sh:], B[:, :sh]], axis=1) if sh else A
        for tx in spec.get("texts", []):
            if tx["start"] <= t < tx["start"] + tx["sec"]:
                _text(img, tx["box"])
        cs = spec.get("cast")
        if cs:
            img = cast(img, cs.get("b", 0.0), cs.get("a", 0.0))
        yield img


def cut_truth(spec):
    """Expected cut times (s) and kinds."""
    starts = np.cumsum([0.0] + [s["sec"] for s in spec["shots"]])
    joins = spec.get("joins") or ["hard"] * (len(spec["shots"]) - 1)
    return [(float(starts[k + 1]), joins[k]) for k in range(len(joins))]


def beat_audio(sec, bpm=120.0, offset=0.0):
    """A tone track: a kick and a click on every beat, a quiet bass under it (mono float)."""
    n = int(sec * SR)
    x = 0.08 * np.sin(2 * np.pi * 55 * np.arange(n) / SR)
    beat = 60.0 / bpm
    k = 0
    while offset + k * beat < sec:
        i = int((offset + k * beat) * SR)
        ln = min(n - i, int(0.15 * SR))
        tt = np.arange(ln) / SR
        x[i:i + ln] += np.sin(2 * np.pi * (50 + 90 * np.exp(-tt / 0.03)) * tt) * np.exp(-tt / 0.06)
        c = min(n - i, int(0.02 * SR))
        x[i:i + c] += 0.4 * np.random.default_rng(k).uniform(-1, 1, c) * np.exp(-np.arange(c) / (0.004 * SR))
        k += 1
    return x / np.max(np.abs(x)) * 0.8


def write(path, spec, audio=None, codec="ffv1", crf=None):
    """Encodes the spec's frames (and an optional mono float audio at 48 kHz) with PyAV."""
    import av  # noqa: PLC0415
    w, h, fps = spec["w"], spec["h"], spec["fps"]
    with av.open(path, "w") as c:
        vs = c.add_stream(codec, rate=fps)
        vs.width, vs.height = w, h
        vs.pix_fmt = "yuv444p" if codec == "ffv1" else "yuv420p"
        if codec == "libx264":
            vs.options = {"preset": "veryfast", "crf": str(crf or 20), "threads": "2"}
        if audio is not None:
            as_ = c.add_stream("pcm_s16le" if codec == "ffv1" else "aac", rate=SR)
            as_.layout = "mono"
        for img in frames(spec):
            for p in vs.encode(av.VideoFrame.from_ndarray(img, format="bgr24")):
                c.mux(p)
        for p in vs.encode():
            c.mux(p)
        if audio is not None:
            pcm = np.clip(np.rint(audio * 32767), -32768, 32767).astype(np.int16)
            step = 1024
            for i in range(0, len(pcm), step):
                fr = av.AudioFrame.from_ndarray(pcm[None, i:i + step], format="s16", layout="mono")
                fr.sample_rate = SR
                for p in as_.encode(fr):
                    c.mux(p)
            for p in as_.encode():
                c.mux(p)


def write_wav(path, x):
    pcm = np.clip(np.rint(np.repeat(x[:, None], 2, axis=1) * 32767), -32768, 32767).astype("<i2")
    with wave.open(path, "wb") as wv:
        wv.setnchannels(2)
        wv.setsampwidth(2)
        wv.setframerate(SR)
        wv.writeframes(pcm.tobytes())
