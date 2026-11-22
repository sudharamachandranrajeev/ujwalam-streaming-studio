# SPDX-License-Identifier: GPL-3.0-or-later
"""LV1a (D421): teaching overlays on the long highlights video (plan docs/plan/2026-11-21-beatdrop-montages.md, LV1).
Flag: long-video-teaching (on by default, user-requested). Data: data/clip/long-video.json "teaching".

  captions   what was said, word by word: the line on screen, the word being spoken in the accent colour. The speech to
             text and its look are the reel captions' (reel_captions.py, data/clip/reel-captions.json and its preset),
             with the sizes for the 16:9 frame from teaching.captions. Each render batch is transcribed once (its
             pieces back to back) and moved onto the batch's own timeline, cross fades included (reel_captions.retime).
             No speech model, or the studio found it damaged: no captions, the chapter cards still show.
  chapters   D439 K.O. cards (replace the numbered card of D421): at the start of each moment a big word says what
             happened ("K.O.", "DOUBLE K.O.", "STREAK", "WON"; teaching.koCards.words), with a plain-words line under it
             when it adds something ("streak · 5 kills"). No number. One animation per moment (registry presets
             ko-card-<style>: slam, slash, glitch, zoom-punch, stamp), a seeded pick among the styles ticked in
             Settings > Clips, never one of the last two. Enters under 600 ms, leaves under 400 ms, stays inside the
             moment (never over the next cross fade).

  callouts   LV1b (D422): a little after each medal of a moment, the game pack's kill feed region (teaching.callouts:
             detector + roi, verified regions only) cropped from the picture, enlarged and framed in an accent border
             with a darker halo, for a few seconds; never over a cross fade, never two at once. A render_argv fx
             fragment on the joined picture, under the captions.

Captions and chapters go into one ASS file per batch, burned by clip_montage.render_argv(captions=) with the caption
font only. Movement paths (LV1c, D423): long_paths.py, drawn into the same ASS."""

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
    kc = tcfg["koCards"]
    for st in KO_STYLES:  # D439: every K.O. card preset obeys the overlay rule
        p = ko_params(st)
        if int(p["inMs"]) >= ENTRANCE_MAX_MS or int(p["outMs"]) >= EXIT_MAX_MS:
            raise ClipError(f"K.O. card {st} must enter under 600 ms and leave under 400 ms")
        if float(kc["sec"]) * 1000.0 <= int(p["inMs"]) + int(p["outMs"]):
            raise ClipError("long video K.O. cards: sec must be longer than the entrance and exit together")
    if not kc.get("words") or kc["words"][-1].get("when"):
        raise ClipError("long video K.O. cards: the wording table must end with a rule for any moment (when {})")
    oc = tcfg.get("callouts") or {}
    if oc.get("on") and not (0 < float(oc["minSec"]) <= float(oc["sec"]) and float(oc["scale"]) > 0
                             and float(oc["delaySec"]) >= 0 and 0 <= float(oc["glowShade"]) <= 1):
        raise ClipError("long video callouts: need 0 < minSec <= sec, scale > 0, delaySec >= 0, glowShade 0-1")
    pc = tcfg.get("paths") or {}
    if pc.get("on") and not (0 <= int(pc["fadeMs"]) < EXIT_MAX_MS and float(pc["fps"]) > 0 and float(pc["trackSec"]) > 0
                             and int(pc["trackWidth"]) >= 64 and int(pc["minPoints"]) >= 2):
        raise ClipError("long video paths: need fadeMs under 400, fps and trackSec > 0, trackWidth >= 64, minPoints >= 2")
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


# ---------------------------------------------------------------- D439 K.O. cards (replace the numbered chapter card)

KO_FUNCTION = "ko-card"
KO_STYLES = ("slam", "slash", "glitch", "zoom-punch", "stamp")  # registry presets ko-card-<style>


def ko_params(style_id):
    """The animation of one K.O. style: the ko-card manifest defaults + the preset's params, clamped to safeRanges."""
    import beatdrop_fx as bfx  # noqa: PLC0415 - the shared registry reader
    return bfx.params_for(KO_FUNCTION, preset_id=f"{KO_FUNCTION}-{style_id}")


def ko_word(seg, kcfg):
    """-> (big word, detail line or None) for one moment, from the wording table (the first rule that fits wins)."""
    kinds = set(seg.get("kinds") or [])
    k = int(seg.get("kills") or 0)
    for r in kcfg["words"]:
        w = r.get("when") or {}
        if "win" in w and bool(w["win"]) != ("win" in kinds):
            continue
        if "streak" in w and bool(w["streak"]) != ("streak" in kinds):
            continue
        if "minKills" in w and k < int(w["minKills"]):
            continue
        if "kills" in w and k != int(w["kills"]):
            continue
        return str(r["text"]), (label(seg) if r.get("detail") else None)
    return "HIGHLIGHT", label(seg)


def ko_picks(seed, n, styles, weights=None, avoid_n=2):
    """The style of each of the first n moments of a video: a seeded weighted pick among `styles`, never one of the
    last avoid_n picks while another style is free (settled Pools rule). Same seed -> same list, so a batch can ask for
    its own slice and a re-render draws the same."""
    import clip_look as look  # noqa: PLC0415
    styles = list(styles)
    if not styles or n <= 0:
        return []
    weights = weights or {}
    rng = look._rng([seed], "ko-cards")
    out = []
    for _ in range(n):
        recent = out[-avoid_n:] if avoid_n > 0 else []
        out.append(look.weighted_pick(rng, styles, [float(weights.get(s, 1.0)) for s in styles], recent))
    return out


def _tag_colour(hex_rgb):
    c = _hex(hex_rgb)
    return f"&H{c[4:6]}{c[2:4]}{c[0:2]}&"


def _ko_lines(anim, p, word, detail, cx, cy, dy, d_ms, kcfg, accent):
    """-> [(layer, ms from the card start to its end or None = whole card, style, text)] for one card."""
    fin, fout = int(p["inMs"]), int(p["outMs"])
    ex0 = d_ms - fout
    wpx = int(kcfg["wordPx"])
    txt = caps.ass_escape(word)
    gone = f"\\t({ex0},{d_ms},\\alpha&HFF&)"
    out = []
    if anim == "slam":  # drops in big, overshoots, settles with a small shake, all inside the entrance
        s0, ov, sh = int(p["startScale"]), int(p["overshoot"]), float(p["shakeDeg"])
        a = int(fin * 0.55)
        q = max(1, (fin - a) // 3)
        tags = (f"\\an5\\pos({cx},{cy})\\fscx{s0}\\fscy{s0}\\alpha&HFF&\\t(0,{a},\\fscx{ov}\\fscy{ov}\\alpha&H00&)"
                f"\\t({a},{a + q},\\fscx100\\fscy100\\frz{sh:g})\\t({a + q},{a + 2 * q},\\frz{-sh:g})\\t({a + 2 * q},{fin},\\frz0)"
                f"\\t({ex0},{d_ms},\\alpha&HFF&\\fscx90\\fscy90)")
        out.append((2, None, "KOWord", f"{{{tags}}}{txt}"))
    elif anim == "slash":  # a slanted word wiped on left to right, an accent bar under it
        half = int(len(word) * wpx * 0.34) + int(kcfg["outlinePx"]) + 12
        x0, x1, y0, y1 = cx - half, cx + half, cy - wpx, cy + wpx
        tags = (f"\\an5\\move({cx - 40},{cy},{cx},{cy},0,{fin})\\fax{float(p['skew']):g}\\clip({x0},{y0},{x0 + 1},{y1})"
                f"\\t(0,{fin},\\clip({x0},{y0},{x1},{y1}))\\t({ex0},{d_ms},\\clip({x1 - 1},{y0},{x1},{y1}))")
        out.append((2, None, "KOWord", f"{{{tags}}}{txt}"))
        bh, by = max(6, wpx // 14), cy + int(wpx * 0.52)
        bar = (f"{{\\an5\\pos({cx},{by})\\p1\\bord0\\shad0\\1c{_tag_colour(accent)}\\fscx0\\t(0,{int(fin * 0.6)},\\fscx100)"
               f"{gone}}}m {-half} 0 l {half} {-bh} l {half} 0 l {-half} {bh}{{\\p0}}")
        out.append((1, None, "KOWord", bar))
    elif anim == "glitch":  # an accent copy and a white copy slide in from both sides and snap into the word
        sp = int(p["splitPx"])
        acc = _tag_colour(accent)
        palette = kcfg.get("palette")
        ghost = f"\\1c{_tag_colour(palette['secondary'])}\\3c{_tag_colour(palette['secondary'])}" if palette else ""
        out.append((1, fin, "KOWord", f"{{\\an5\\move({cx - sp},{cy},{cx},{cy},0,{fin})\\1c{acc}\\3c{acc}\\alpha&H60&"
                                      f"\\t({fin // 2},{fin},\\alpha&HFF&)}}{txt}"))
        out.append((1, fin, "KOWord", f"{{\\an5\\move({cx + sp},{cy - sp // 4},{cx},{cy},0,{fin}){ghost}\\alpha&H80&"
                                      f"\\t({fin // 2},{fin},\\alpha&HFF&)}}{txt}"))
        out.append((2, None, "KOWord", f"{{\\an5\\pos({cx},{cy})\\alpha&HFF&\\t({fin // 2},{fin},\\alpha&H00&)"
                                       f"\\t({ex0},{d_ms},\\alpha&HFF&\\fscx115)}}{txt}"))
    elif anim == "zoom":  # punches in from small and blurred, overshoots, leaves by growing away
        s0, ov, bl = int(p["startScale"]), int(p["overshoot"]), float(p["blur"])
        a = int(fin * 0.7)
        tags = (f"\\an5\\pos({cx},{cy})\\fscx{s0}\\fscy{s0}\\blur{bl:g}\\alpha&HFF&"
                f"\\t(0,{a},\\fscx{ov}\\fscy{ov}\\blur0\\alpha&H00&)\\t({a},{fin},\\fscx100\\fscy100)"
                f"\\t({ex0},{d_ms},\\fscx135\\fscy135\\alpha&HFF&)")
        out.append((2, None, "KOWord", f"{{{tags}}}{txt}"))
    elif anim == "stamp":  # a tilted accent box stamped down from big
        s0, ang = int(p["startScale"]), float(p["angle"])
        a = int(fin * 0.7)
        tags = (f"\\an5\\pos({cx},{cy})\\frz{ang:g}\\fscx{s0}\\fscy{s0}\\alpha&HFF&"
                f"\\t(0,{a},\\fscx94\\fscy94\\alpha&H00&)\\t({a},{fin},\\fscx100\\fscy100){gone}")
        out.append((2, None, "KOBox", f"{{{tags}}}{txt}"))
    else:
        raise ClipError(f"K.O. card: unknown animation {anim!r}")
    if detail:  # the plain-words line fades in at the end of the entrance and out with the word
        out.append((2, None, "KODetail", f"{{\\an5\\pos({cx},{cy + dy})\\alpha&HFF&\\t({int(fin * 0.6)},{fin},\\alpha&H00&)"
                                         f"{gone}}}{caps.ass_escape(detail)}"))
    return out


def ko_styles(frame, tcfg, style, accent):
    kc, safe = tcfg["koCards"], tcfg["safe"]
    palette = kc.get("palette") or {}
    tx, sh = _colour(style["textColour"]), _colour(palette.get("shadow", "#000000"), 0x60)
    detail = _colour(palette.get("secondary", style["textColour"]))
    row = (f"0,0,0,100,100,0,0,{{bs}},{{bord}},{{shad}},5,{int(safe['left'])},{int(safe['right'])},0,1")
    return [
        f"Style: KOWord,{style['fontFamily']},{int(kc['wordPx'])},{tx},{tx},{_colour(accent)},{sh},-1,"
        + row.format(bs=1, bord=int(kc["outlinePx"]), shad=int(kc["shadowPx"])),
        f"Style: KOBox,{style['fontFamily']},{int(kc['wordPx'])},{tx},{tx},{_colour(accent)},{_colour(accent)},-1,"
        + row.format(bs=3, bord=int(kc["boxPadPx"]), shad=0),
        f"Style: KODetail,{style['fontFamily']},{int(kc['detailPx'])},{detail},{detail},{_colour(palette.get('shadow', '#000000'), 0x30)},{sh},-1,"
        + row.format(bs=1, bord=3, shad=2),
    ]


def chapter_events(chunk, first_no, xd, frame, tcfg, style, accent, card_styles=KO_STYLES, seed="", weights=None,
                   picked=None):
    """D439: -> (style lines, event lines) for the K.O. cards of one batch (moments first_no.. of the video). No moment
    number; the word says what happened (ko_word). The animation of moment k is ko_picks(seed, ...)[k - 1] among
    card_styles; none ticked -> no cards. picked: a list the chosen style of each drawn card is added to."""
    kc, safe = tcfg["koCards"], tcfg["safe"]
    card_styles = [s for s in card_styles if s in KO_STYLES]
    if not card_styles or not chunk:
        return [], []
    w, h = int(frame["width"]), int(frame["height"])
    wpx, dpx = int(kc["wordPx"]), int(kc["detailPx"])
    dy = (wpx + dpx) // 2 + int(kc["gapPx"])
    cy = max(int(safe["top"]) + wpx // 2 + int(kc["boxPadPx"]),
             min(int(float(kc["at"]["y"]) * h), h - int(safe["bottom"]) - dy - dpx))
    picks = ko_picks(seed, first_no - 1 + len(chunk), card_styles, weights)[first_no - 1:]
    params = {s: ko_params(s) for s in set(picks)}
    ev = []
    for i, (g, p0) in enumerate(zip(chunk, piece_starts(chunk, xd))):
        st = picks[i]
        p = params[st]
        fin, fout = int(p["inMs"]), int(p["outMs"])
        # the card shows only where this moment is alone on screen: after the cross fade in, before the one out (Codex)
        t0 = p0 + (xd if i else 0.0)
        end = p0 + float(g["end"]) - float(g["start"]) - (xd if i + 1 < len(chunk) else 0.0)
        t1 = min(t0 + float(kc["sec"]), end)
        if t1 - t0 < (fin + fout) / 1000.0 + 0.2:
            continue  # a moment too short for the card: none rather than a cut-off one
        word, detail = ko_word(g, kc)
        half = int(len(word) * wpx * 0.34) + int(kc["boxPadPx"])
        cx = max(int(safe["left"]) + half, min(int(float(kc["at"]["x"]) * w), w - int(safe["right"]) - half))
        d_ms = int((t1 - t0) * 100) * 10  # whole centiseconds, as the ASS times: the exit is never cut short
        t0c, t1c = round(t0, 2), round(t0, 2) + d_ms / 1000.0
        for layer, until, sty, text in _ko_lines(p["anim"], p, word, detail, cx, cy, dy, d_ms, kc, accent):
            te = t1c if until is None else min(t1c, t0c + until / 1000.0)
            ev.append(f"Dialogue: {layer},{caps._ts(t0c)},{caps._ts(te)},{sty},,0,0,0,,{text}")
        if picked is not None:
            picked.append(st)
    return ko_styles(frame, tcfg, style, accent), ev

# ---------------------------------------------------------------- LV1b callout cards (D422)

def callout_box(pack, ocfg):
    """The HUD crop of a callout: the game pack's detector region named by teaching.callouts (detector, roi), as
    fractions {x0, y0, x1, y1}; None when the pack, detector or region is missing or the region is not verified (a
    callout frames only a measured region)."""
    for d in (pack or {}).get("detectors") or []:
        if d.get("id") != ocfg["detector"]:
            continue
        for r in d.get("rois") or []:
            if r.get("id") == ocfg["roi"] and r.get("status") == "verified":
                box = {k: float(r[k]) for k in ("x0", "y0", "x1", "y1")}
                return box if 0 <= box["x0"] < box["x1"] <= 1 and 0 <= box["y0"] < box["y1"] <= 1 else None
    return None


def callout_modes(pack, ocfg):
    """D438: the game families (detector `modes`) the callout region belongs to; [] when not stated."""
    for d in (pack or {}).get("detectors") or []:
        if d.get("id") == ocfg["detector"]:
            return [m for m in d.get("modes") or [] if isinstance(m, str)]
    return []


def frame_box(roi, layout, rec_size, frame):
    """A region in game-area fractions (detector ROIs are fractions of the game area) -> fractions of the long video
    frame. layout: the detect summary's {"game": [x, y, w, h], "visible": [x0, y0, x1, y1]} in recording pixels (the
    game may sit inside a canvas with overlays around it); None = the game fills the recording. The recording is
    fitted into the frame (scale + centre pad, as render_argv does). None when the region is not visible."""
    if not roi:
        return None
    rw, rh = float(rec_size[0]), float(rec_size[1])
    if rw <= 0 or rh <= 0:
        return None
    gx, gy, gw, gh = (layout or {}).get("game") or (0.0, 0.0, rw, rh)
    vx0, vy0, vx1, vy1 = (layout or {}).get("visible") or (gx, gy, gx + gw, gy + gh)
    x0, x1 = max(gx + roi["x0"] * gw, vx0, 0.0), min(gx + roi["x1"] * gw, vx1, rw)
    y0, y1 = max(gy + roi["y0"] * gh, vy0, 0.0), min(gy + roi["y1"] * gh, vy1, rh)
    if x1 <= x0 or y1 <= y0:
        return None
    fw, fh = float(frame["width"]), float(frame["height"])
    s = min(fw / rw, fh / rh)
    ox, oy = (fw - rw * s) / 2, (fh - rh * s) / 2
    return {"x0": (ox + x0 * s) / fw, "y0": (oy + y0 * s) / fh, "x1": (ox + x1 * s) / fw, "y1": (oy + y1 * s) / fh}


def callout_windows(chunk, xd, ocfg):
    """[(t0, t1)] on the batch's output timeline: one callout a little after each medal of a moment, only where the
    moment is alone on screen (no cross fade), never two at once (a later one that would overlap is dropped)."""
    out = []
    delay, sec, low = float(ocfg["delaySec"]), float(ocfg["sec"]), float(ocfg["minSec"])
    for i, (g, p0) in enumerate(zip(chunk, piece_starts(chunk, xd))):
        g0, g1 = float(g["start"]), float(g["end"])
        lo = p0 + (xd if i else 0.0)
        hi = p0 + (g1 - g0) - (xd if i + 1 < len(chunk) else 0.0)
        for t in sorted(float(x) for x in g.get("medals") or []):
            if not g0 <= t <= g1:
                continue
            a = max(lo, p0 + (t - g0) + delay)
            b = min(hi, a + sec)
            if b - a >= low and (not out or a >= out[-1][1]):
                out.append((round(a, 3), round(b, 3)))
    return out


def _hex(c):
    c = str(c).lstrip("#")
    if len(c) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in c):
        raise ClipError(f"long video callouts: colour {c!r} is not #RRGGBB")
    return c.upper()


def _dim(c, f):
    return "".join(f"{int(int(c[k:k + 2], 16) * f):02X}" for k in (0, 2, 4))


def callout_fx(windows, box, frame, ocfg, accent):
    """The render_argv fx fragment ([fxin] -> [fxout]) that shows the HUD crop, enlarged, in an accent border over the
    joined picture during each window; None when there is none. The card pops in and out (0 ms: inside the overlay
    timing rule). at: the card's top centre, fractions of the frame, kept inside the safe margins. The crop is taken
    from the joined frame, so the box fractions are right when the recording has the frame's aspect (16:9)."""
    if not windows or not box:
        return None
    w, h = int(frame["width"]), int(frame["height"])
    cx, cy = round(box["x0"] * w) // 2 * 2, round(box["y0"] * h) // 2 * 2
    cw, ch = round((box["x1"] - box["x0"]) * w) // 2 * 2, round((box["y1"] - box["y0"]) * h) // 2 * 2
    cw, ch = min(cw, w - cx) // 2 * 2, min(ch, h - cy) // 2 * 2  # never past the frame edge
    bd, gl = int(ocfg["borderPx"]), int(ocfg["glowPx"])
    safe = ocfg["margin"]
    room_w = w - int(safe["left"]) - int(safe["right"]) - 2 * (bd + gl)
    room_h = h - int(safe["top"]) - int(safe["bottom"]) - 2 * (bd + gl)
    if cw < 2 or ch < 2 or room_w < 2 or room_h < 2:
        return None
    sc = min(float(ocfg["scale"]), room_w / cw, room_h / ch)  # Codex: shrunk to fit inside the safe area
    sw, sh = max(2, int(cw * sc) // 2 * 2), max(2, int(ch * sc) // 2 * 2)
    tw, th = sw + 2 * (bd + gl), sh + 2 * (bd + gl)
    x = max(int(safe["left"]), min(int(float(ocfg["at"]["x"]) * w) - tw // 2, w - int(safe["right"]) - tw))
    y = max(int(safe["top"]), min(int(float(ocfg["at"]["y"]) * h), h - int(safe["bottom"]) - th))
    acc = _hex(accent)
    en = "+".join(f"between(t,{a:.3f},{b:.3f})" for a, b in windows)
    return (f"[fxin]split=2[lvcb][lvcs];[lvcs]crop={cw}:{ch}:{cx}:{cy},scale={sw}:{sh}:flags=lanczos,"
            f"pad={sw + 2 * bd}:{sh + 2 * bd}:{bd}:{bd}:color=0x{acc},"
            f"pad={tw}:{th}:{gl}:{gl}:color=0x{_dim(acc, float(ocfg['glowShade']))}[lvcc];"
            f"[lvcb][lvcc]overlay=x={x}:y={y}:enable='{en}'[fxout]")


def batch_callouts(chunk, tr, frame, ctx):
    """-> (fx fragment or None, number of callouts) for one batch; none without a verified HUD box."""
    ocfg = ctx["tcfg"].get("callouts") or {}
    if not ocfg.get("on") or not ctx.get("box"):
        return None, 0
    pieces = [{"start": float(g["start"]), "end": float(g["end"])} for g in chunk]
    # D438 (user 2026-11-22: a Battle Royale moment showed a cut-out of the wrong screen area): a moment from a match of
    # a family the region was not measured in gets no callout. A moment of unknown family keeps the old behaviour.
    fams = ctx.get("boxModes") or []
    chunk = [dict(g, medals=[]) if fams and any(m not in fams for m in g.get("modes") or []) else g for g in chunk]
    win = callout_windows(chunk, mont.crossfade_sec(pieces, tr), ocfg)
    fx = callout_fx(win, ctx["box"], frame, dict(ocfg, margin=ctx["tcfg"]["safe"]), ctx["accent"])
    return fx, (len(win) if fx else 0)  # Codex verify: no card drawn, none counted


def caption_style(ccfg, tcfg):
    """The reel captions preset with the 16:9 sizes of teaching.captions laid over it."""
    st = dict(rcap.load_style(ccfg))
    for k in ("sizePx", "maxCharsPerLine", "maxWordsPerCard", "maxLines", "liftPx"):
        if k in tcfg["captions"]:
            st[k] = tcfg["captions"][k]
    return st


def batch_overlay(ffmpeg, src, chunk, first_no, tr, frame, workdir, ctx, transcribe=None, decode=None):
    """The ASS of one batch: its captions (when ctx has a speech model), its chapter cards and (LV1c, ctx "paths")
    its movement paths. ctx: {tcfg, style, accent, ccfg or None, opts, paths or None}. -> (ass name or None, fonts dir
    or None, info). A caption or path failure never stops the video: the rest is burned without it. decode: tests."""
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
    npaths = 0
    try:
        picked = []
        extra = chapter_events(chunk, first_no, xd, frame, ctx["tcfg"], ctx["style"], ctx["accent"],
                               card_styles=ctx.get("cards", KO_STYLES), seed=ctx.get("seed") or "",
                               weights=ctx.get("cardWeights"), picked=picked)
        nch = len(picked)
        if ctx.get("paths"):  # LV1c (D423): any tracking failure leaves the rest of the overlay
            import long_paths as lp  # noqa: PLC0415
            try:
                ps, pe, npaths = lp.batch_paths(ffmpeg, src, chunk, piece_starts(chunk, xd), xd, frame, ctx["paths"],
                                                workdir, decode_fn=decode)
                extra = (extra[0] + ps, extra[1] + pe)
            except Exception as e:  # noqa: BLE001
                npaths = 0
                info = dict(info, reason=f"paths not drawn: {e}"[-200:])
        safe = dict(ctx["tcfg"]["safe"])
        try:
            ass, fd, n = rcap.write_ass(doc or {"segments": []}, frame, safe, ctx["style"], workdir, out_sec,
                                        highlight=ctx["accent"], extra=extra)
        except Exception as e:  # noqa: BLE001 - the captions could not be written (Codex): the cards alone
            if not doc:
                raise
            info = {"backend": info.get("backend"), "status": "failed", "reason": f"captions not written: {e}"[-200:]}
            ass, fd, n = rcap.write_ass({"segments": []}, frame, safe, ctx["style"], workdir, out_sec, extra=extra)
        return ass, fd, dict(info, cards=n, chapters=nch, cardStyles=picked, paths=npaths)
    except Exception as e:  # noqa: BLE001 - no overlay at all for this batch; the video is still made
        return None, None, dict(info, status="failed", cards=0, chapters=0, paths=0,
                                reason=f"overlay not written: {e}"[-200:])


def merge_info(infos):
    """One summary for long.json and render.json from the batches' infos."""
    if not infos:
        return {"captions": {"backend": "none", "status": "off"}, "chapters": 0, "callouts": 0, "paths": 0}
    st = [i.get("status") for i in infos]
    status = "ok" if all(s == "ok" for s in st) else "off" if all(s == "off" for s in st) else \
        "failed" if all(s in ("failed", "unavailable") for s in st) else "partial"
    reasons = sorted({i["reason"] for i in infos if i.get("reason")})
    cap = {"backend": infos[0].get("backend"), "status": status, "cards": sum(int(i.get("cards") or 0) for i in infos)}
    if reasons:
        cap["reason"] = "; ".join(reasons)[:200]
    return {"captions": cap, "chapters": sum(int(i.get("chapters") or 0) for i in infos),
            "callouts": sum(int(i.get("callouts") or 0) for i in infos),
            "paths": sum(int(i.get("paths") or 0) for i in infos)}


def context(data_dir, lcfg, whisper_bin=None, whisper_model=None, pack=None, layout=None, rec_size=None, game=None,
            seed=None, theme=None):
    """What batch_overlay needs, or None with the flag off. Captions need the reel captions' speech model; without it
    (or with UJWALAM_REEL_CAPTIONS=off from the studio's model check) only the chapter cards are drawn. pack: the
    run's game pack (the callout's HUD box); none -> no callouts. layout / rec_size: where the game sits in the
    recording (frame_box). game: the run's game id (LV1c: its enemyTag and HUD areas); none -> no paths. seed (D439):
    the K.O. card picks' seed (the recording's name), so a re-render draws the same styles."""
    import reel_title as rti  # noqa: PLC0415
    tcfg = check(lcfg["teaching"])
    if not on(data_dir, tcfg):
        return None
    ccfg = rcap.load_config()
    style = caption_style(ccfg, tcfg)
    accent = rti.load_config()["themeAccent"]
    cards, card_weights = card_choice(data_dir)
    if theme:
        palette = theme["palette"]
        accent = palette["accent"]
        style = dict(style, textColour=palette["text"], outlineColour=palette["shadow"])
        tcfg = dict(tcfg, koCards=dict(tcfg["koCards"], palette=palette))
        # Respect disabled styles, including the user's choice to draw no cards.
        cards = [st for st in cards if st in theme["cardStyles"]] or cards
    model = rcap.model_path(data_dir, ccfg, whisper_model)
    use = bool(tcfg["captions"].get("on")) and os.environ.get("UJWALAM_REEL_CAPTIONS") != "off" and (
        ccfg["backend"] == "faster-whisper" and model or ccfg["backend"] == "whisper-cli" and whisper_bin and model)
    ocfg = tcfg.get("callouts") or {}
    ok_size = bool(rec_size) and all(isinstance(v, (int, float)) and v > 0 for v in rec_size)
    layout = layout if isinstance(layout, dict) else None  # Codex LV1b: the detect summary is outside data
    game = game if isinstance(game, str) else None
    box = paths = None
    box_modes = []
    try:  # Codex: malformed region or layout data leaves the video without callouts, never stops it
        if ocfg.get("on") and ok_size:
            box = frame_box(callout_box(pack, ocfg), layout, rec_size, lcfg["frame"])
            box_modes = callout_modes(pack, ocfg)
    except (AttributeError, KeyError, TypeError, ValueError):
        box = None
    try:
        if ok_size:
            paths = _paths_context(tcfg, game, layout, rec_size, accent)
    except (AttributeError, KeyError, TypeError, ValueError):
        paths = None
    return {"tcfg": tcfg, "style": style, "accent": accent, "ccfg": ccfg if use else None,
            "opts": {"whisper_bin": whisper_bin, "whisper_model": model}, "box": box, "boxModes": box_modes, "paths": paths,
            "cards": cards, "cardWeights": card_weights, "seed": seed or ""}


def card_choice(data_dir):
    """D439: (the ticked K.O. styles in option order, {style: weight}) from Settings > Clips (clips.look.cards, look.json
    groups.cards); a broken look file -> every style at weight 1."""
    import clip_look as look  # noqa: PLC0415
    try:
        cfg = look.load_config()
        eff = look.effective(data_dir, cfg)
        opts = cfg["groups"][look.CARDS]["options"]
        ticked = eff.get(look.CARDS, {}).get("styles") or []
        return [o["id"] for o in opts if o["id"] in ticked and o["id"] in KO_STYLES], \
            {o["id"]: float(o["weight"]) for o in opts}
    except (OSError, ClipError, KeyError, TypeError, ValueError):
        return list(KO_STYLES), {}


def _paths_context(tcfg, game, layout, rec_size, accent):
    """LV1c: what long_paths.batch_paths needs, or None (switched off, no game, no recording size, no enemyTag)."""
    import long_paths as lp  # noqa: PLC0415
    pcfg = tcfg.get("paths") or {}
    if not pcfg.get("on") or not game:
        return None
    spec, hud = lp.load_game(game)
    if not spec:
        return None
    return {"pcfg": pcfg, "spec": spec, "hud": hud, "layout": layout, "rec_size": rec_size, "accent": accent}
