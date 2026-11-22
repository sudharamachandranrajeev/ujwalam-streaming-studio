# SPDX-License-Identifier: GPL-3.0-or-later
"""LV1a (D421): teaching overlays on the long highlights video (plan docs/plan/2026-11-21-beatdrop-montages.md, LV1).
Flag: long-video-teaching (on by default, user-requested). Data: data/clip/long-video.json "teaching".

  captions   what was said, word by word: the line on screen, the word being spoken in the accent colour. The speech to
             text and its look are the reel captions' (reel_captions.py, data/clip/reel-captions.json and its preset),
             with the sizes for the 16:9 frame from teaching.captions. Each render batch is transcribed once (its
             pieces back to back) and moved onto the batch's own timeline, cross fades included (reel_captions.retime).
             No speech model, or the studio found it damaged: no captions, the chapter cards still show.
  chapters   a numbered card at the start of each moment: "1" and what it is in plain words ("3 kills", "streak ·
             5 kills", "won match"). It slides in under 600 ms and fades out under 400 ms (the overlay rule), and stays
             inside the moment (never over the next cross fade).

Both go into one ASS file per batch, burned by clip_montage.render_argv(captions=) with the caption font only.
Callout cards and movement paths are later LV1 parts (not here)."""

from __future__ import annotations

import os

import clip_captions as caps
import clip_montage as mont
import reel_captions as rcap
from clip_common import ClipError, flag_on

FLAG = "long-video-teaching"
ENTRANCE_MAX_MS, EXIT_MAX_MS = 600, 400


def on(data_dir, tcfg=None):
    return flag_on(data_dir, (tcfg or {}).get("flag") or FLAG)


def check(tcfg):
    """The teaching block of long-video.json; ClipError when an animation breaks the overlay timing rule."""
    ch = tcfg["chapters"]
    if int(ch["entranceMs"]) >= ENTRANCE_MAX_MS or int(ch["exitMs"]) >= EXIT_MAX_MS:
        raise ClipError("long video chapters must enter under 600 ms and leave under 400 ms")
    if float(ch["sec"]) * 1000.0 <= int(ch["entranceMs"]) + int(ch["exitMs"]):
        raise ClipError("long video chapters: sec must be longer than the entrance and exit together")
    return tcfg


def label(seg):
    """Plain words for one moment of the long video."""
    kinds = set(seg.get("kinds") or [])
    k = int(seg.get("kills") or 0)
    parts = []
    if "streak" in kinds:
        parts.append("streak")
    if k:
        parts.append(f"{k} kill{'' if k == 1 else 's'}")
    if "win" in kinds:
        parts.append("won match")
    return " · ".join(parts) or "highlight"


def piece_starts(chunk, xd):
    """Where each piece starts on the batch's output timeline (each join overlaps by xd)."""
    out, acc = [], 0.0
    for i, g in enumerate(chunk):
        out.append(acc - i * xd)
        acc += float(g["end"]) - float(g["start"])
    return out


def _colour(hex_rgb, alpha=0):
    return rcap._ass_colour(hex_rgb, alpha)


def chapter_events(chunk, first_no, xd, frame, tcfg, style, accent):
    """-> (style lines, event lines) for the chapter cards of one batch, numbered from first_no."""
    ch, safe = tcfg["chapters"], tcfg["safe"]
    w = int(frame["width"])
    x, y = int(safe["left"]), int(safe["top"])
    slide = int(ch["slidePx"])
    fin, fout = int(ch["entranceMs"]), int(ch["exitMs"])
    styles = [f"Style: Chapter,{style['fontFamily']},{int(ch['labelPx'])},{_colour(style['textColour'])},"
              f"{_colour(style['textColour'])},{_colour(accent)},{_colour(accent, 0x20)},-1,0,0,0,100,100,0,0,3,"
              f"{int(ch['boxPadPx'])},0,7,{x},{max(0, w - x)},{y},1"]
    ev = []
    for i, (g, p0) in enumerate(zip(chunk, piece_starts(chunk, xd))):
        # the card shows only where this moment is alone on screen: after the cross fade in, before the one out (Codex)
        t0 = p0 + (xd if i else 0.0)
        end = p0 + float(g["end"]) - float(g["start"]) - (xd if i + 1 < len(chunk) else 0.0)
        t1 = min(t0 + float(ch["sec"]), end)
        if t1 - t0 < (fin + fout) / 1000.0:
            continue  # a moment too short for the card: none rather than a cut-off one
        num = f"{{\\fs{int(ch['numberPx'])}}}{first_no + i}{{\\fs{int(ch['labelPx'])}}}"
        text = f"{{\\move({x - slide},{y},{x},{y},0,{fin})\\fad({fin},{fout})}}{num}  {caps.ass_escape(label(g))}"
        ev.append(f"Dialogue: 1,{caps._ts(t0)},{caps._ts(t1)},Chapter,,0,0,0,,{text}")
    return styles, ev


def caption_style(ccfg, tcfg):
    """The reel captions preset with the 16:9 sizes of teaching.captions laid over it."""
    st = dict(rcap.load_style(ccfg))
    for k in ("sizePx", "maxCharsPerLine", "maxWordsPerCard", "maxLines", "liftPx"):
        if k in tcfg["captions"]:
            st[k] = tcfg["captions"][k]
    return st


def batch_overlay(ffmpeg, src, chunk, first_no, tr, frame, workdir, ctx, transcribe=None):
    """The ASS of one batch: its captions (when ctx has a speech model) and its chapter cards. ctx: {tcfg, style,
    accent, ccfg or None, opts}. -> (ass name or None, fonts dir or None, info). A caption failure never stops the
    video: the chapter cards are burned without it."""
    pieces = [{"start": float(g["start"]), "end": float(g["end"])} for g in chunk]
    xd = mont.crossfade_sec(pieces, tr)
    in_sec = sum(p["end"] - p["start"] for p in pieces)  # the transcript's timeline: the pieces back to back
    out_sec = in_sec - xd * (len(pieces) - 1)
    doc, info = None, {"backend": "none", "status": "off"}
    if ctx.get("ccfg"):
        try:
            doc, info = rcap.make_transcript(ffmpeg, src, pieces, ctx["ccfg"], ctx["style"], ctx["opts"], workdir,
                                             in_sec, transcribe=transcribe, words=True)
            if doc:
                doc = rcap.retime(doc, pieces, pieces, xd)
        except Exception as e:  # noqa: BLE001 - any caption failure (a model load error too) leaves the cards only
            doc, info = None, {"backend": ctx["ccfg"].get("backend"), "status": "failed", "reason": str(e)[-200:]}
    try:
        extra = chapter_events(chunk, first_no, xd, frame, ctx["tcfg"], ctx["style"], ctx["accent"])
        safe = dict(ctx["tcfg"]["safe"])
        try:
            ass, fd, n = rcap.write_ass(doc or {"segments": []}, frame, safe, ctx["style"], workdir, out_sec,
                                        highlight=ctx["accent"], extra=extra)
        except Exception as e:  # noqa: BLE001 - the captions could not be written (Codex): the cards alone
            if not doc:
                raise
            info = {"backend": info.get("backend"), "status": "failed", "reason": f"captions not written: {e}"[-200:]}
            ass, fd, n = rcap.write_ass({"segments": []}, frame, safe, ctx["style"], workdir, out_sec, extra=extra)
        return ass, fd, dict(info, cards=n, chapters=len(extra[1]))
    except Exception as e:  # noqa: BLE001 - no overlay at all for this batch; the video is still made
        return None, None, dict(info, status="failed", cards=0, chapters=0, reason=f"overlay not written: {e}"[-200:])


def merge_info(infos):
    """One summary for long.json and render.json from the batches' infos."""
    if not infos:
        return {"captions": {"backend": "none", "status": "off"}, "chapters": 0}
    st = [i.get("status") for i in infos]
    status = "ok" if all(s == "ok" for s in st) else "off" if all(s == "off" for s in st) else \
        "failed" if all(s in ("failed", "unavailable") for s in st) else "partial"
    reasons = sorted({i["reason"] for i in infos if i.get("reason")})
    cap = {"backend": infos[0].get("backend"), "status": status, "cards": sum(int(i.get("cards") or 0) for i in infos)}
    if reasons:
        cap["reason"] = "; ".join(reasons)[:200]
    return {"captions": cap, "chapters": sum(int(i.get("chapters") or 0) for i in infos)}


def context(data_dir, lcfg, whisper_bin=None, whisper_model=None):
    """What batch_overlay needs, or None with the flag off. Captions need the reel captions' speech model; without it
    (or with UJWALAM_REEL_CAPTIONS=off from the studio's model check) only the chapter cards are drawn."""
    import reel_title as rti  # noqa: PLC0415
    tcfg = check(lcfg["teaching"])
    if not on(data_dir, tcfg):
        return None
    ccfg = rcap.load_config()
    style = caption_style(ccfg, tcfg)
    accent = rti.load_config()["themeAccent"]
    model = rcap.model_path(data_dir, ccfg, whisper_model)
    use = bool(tcfg["captions"].get("on")) and os.environ.get("UJWALAM_REEL_CAPTIONS") != "off" and (
        ccfg["backend"] == "faster-whisper" and model or ccfg["backend"] == "whisper-cli" and whisper_bin and model)
    return {"tcfg": tcfg, "style": style, "accent": accent, "ccfg": ccfg if use else None,
            "opts": {"whisper_bin": whisper_bin, "whisper_model": model}}
