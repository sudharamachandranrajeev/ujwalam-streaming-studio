# SPDX-License-Identifier: GPL-3.0-or-later
"""RR1 (D424): the Top 5 countdown reel (plan docs/plan/2026-11-21-beatdrop-montages.md RR1, reference 2).

A vertical reel counting down from the lowest rank to #1. Each entry is a rank card and then the clip:
  card   a still of the clip's first frame, blurred and darkened; a huge "#N" in the rank's colour pops in; the item's
         name letters fly in from scattered places and assemble (under 600 ms); everything fades out under 400 ms.
  clip   the rendered vertical clip itself (its own sound), at most clipMaxSec.
Whip joins (a short directional slide, ffmpeg xfade) between every part; the sound cross-fades with it.

Items: the best rendered vertical clips across the runs (clips/runs/<run>/{., montage, beatdrop}/render.json; score,
then kills; live clips and impact plays), or the user's own list (pick_items / user_items). Sources are the rendered
clip files, never the recordings (those are deleted once clipped). One ffmpeg run renders the reel; the card text is
one ASS file burned by libass with the bundled font (data/fonts, OFL). Data: data/clip/countdown.json. Flag:
countdown-reel. Not built: the loadout screenshot pop-in, the face-cam part and the red notes box (reference 2)."""

from __future__ import annotations

import json
import os
import random
import shutil

import clip_captions as caps
from clip_common import ClipError, NotStarted, flag_on, load_json, on_air

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
CONFIG = os.path.join(REPO, "data", "clip", "countdown.json")
FONTS_DIR = os.path.join(REPO, "data", "fonts")
FLAG = "countdown-reel"
TOOL = "clipper.countdown"
CLIP_ID = "R1"
LAYOUT = "countdown-v"
FILE = "countdown.mp4"
ASS_FILE = "countdown.ass"
FONT_SUBDIR = "countdown-fonts"
ENTRANCE_MAX_MS, EXIT_MAX_MS = 600, 400
KINDS = ("short", "impact-play")  # single plays; montages, match reels and long videos are not ranked items
RUNS = os.path.join("clips", "runs")


def load_config(path=None):
    return check(load_json(path or CONFIG))


def check(cfg):
    """The countdown config; ClipError on a value that breaks the overlay rule or cannot render."""
    nm, nu = cfg["name"], cfg["numeral"]
    if int(nu["popMs"]) >= ENTRANCE_MAX_MS or int(nm["assembleMs"]) >= ENTRANCE_MAX_MS:
        raise ClipError("countdown: the numeral and the name must be in under 600 ms")
    if int(cfg["exitMs"]) >= EXIT_MAX_MS:
        raise ClipError("countdown: the card text must leave in under 400 ms")
    if not 2 <= int(cfg["minItems"]) <= int(cfg["items"]) <= len(cfg["rankColours"]):
        raise ClipError("countdown: need 2 <= minItems <= items <= the number of rank colours")
    r = cfg["flash"].get("retries", 0)
    if isinstance(r, bool) or not isinstance(r, int) or not 0 <= r <= 10:
        raise ClipError("countdown: flash.retries must be a whole number from 0 to 10")
    xd = float(cfg["join"]["ms"]) / 1000.0
    if not 0 < xd < float(cfg["clipMinSec"]) / 2 or float(cfg["clipMinSec"]) > float(cfg["clipMaxSec"]):
        raise ClipError("countdown: the join must be shorter than half the shortest clip; clipMinSec <= clipMaxSec")
    if (float(cfg["cardSec"]) - 2 * xd) * 1000.0 <= max(int(nu["popMs"]), int(nm["assembleMs"])) + int(cfg["exitMs"]):
        raise ClipError("countdown: cardSec is too short for the card's entrance and exit between its joins")
    for c in cfg["rankColours"] + [nm["colour"], nm["outlineColour"], nu["outlineColour"]]:
        _hex(c)
    return cfg


def on(data_dir):
    return flag_on(data_dir, FLAG)


def _hex(c):
    s = str(c)
    if len(s) != 7 or s[0] != "#" or any(ch not in "0123456789abcdefABCDEF" for ch in s[1:]):
        raise ClipError(f"countdown: colour {c!r} is not #RRGGBB")
    return s.upper()


def _bgr(c, alpha=0):
    c = _hex(c)
    return f"&H{alpha:02X}{c[5:7]}{c[3:5]}{c[1:3]}"


def clean_name(text, max_chars):
    """A display name: control characters and ASS override braces dropped, spaces folded, cut at max_chars."""
    s = "".join((" " if ch.isspace() else "") if not ch.isprintable() else ch for ch in str(text or "")
                if ch not in "{}\\")
    s = " ".join(s.split())
    return s[:int(max_chars)].rstrip() or "Play"


# ---------------------------------------------------------------- items

def display_name(label, kills, kind):
    """The card's name in plain words: the clip's strongest medal ("Triple Kill"), else its kills, else the kind."""
    if label:
        return " ".join(w.capitalize() for w in str(label).replace("_", " ").replace("-", " ").split())
    if kills:
        return f"{int(kills)} Kill" + ("s" if int(kills) != 1 else "")
    return "Impact Play" if kind == "impact-play" else "Highlight"


def _clip_rows(data_dir):
    """Every rendered vertical clip file under the runs: [{file, name, score, kills, run, kind}] (files that exist)."""
    import clip_names as names  # noqa: PLC0415
    import clip_publish as pub  # noqa: PLC0415
    root = os.path.join(data_dir, RUNS)
    if not os.path.isdir(root):
        return []
    from clip_common import load_config as clip_config  # noqa: PLC0415
    lays = {x["id"]: x for x in clip_config("layouts")["layouts"]}
    rows = []
    for run in sorted(os.listdir(root)):
        rd = os.path.join(root, run)
        if not os.path.isdir(rd):
            continue
        for sd in (rd, os.path.join(rd, "montage"), os.path.join(rd, "beatdrop")):
            rj = os.path.join(sd, "render.json")
            if not os.path.isfile(rj):
                continue
            try:
                doc = load_json(rj)
            except (ClipError, OSError):
                continue
            if not isinstance(doc, dict) or doc.get("tool") == TOOL:
                continue
            for c, f, kind, _when, _label, canvas in pub.name_rows(doc, "game", lays):
                if kind not in KINDS or not str(canvas).startswith("v") or not f.get("file"):
                    continue
                path = os.path.join(sd, "clips", str(c.get("id")), str(f["file"]))
                if not os.path.isfile(path):
                    continue
                kills = pub._kills(c)
                rows.append({"file": path, "name": display_name(names.best_label(c.get("labels")), kills, kind),
                             "score": float(c.get("score") or 0.0), "kills": kills, "run": run, "kind": kind,
                             "music": pub.music_provenance(c, bool(doc.get("musicRecords"))),
                             "musicRaw": c.get("music")})
    return rows


def pick_items(data_dir, cfg, exclude=()):
    """The best cfg.items vertical clips across the runs, best last (#1): by score, then kills, then newest run; one
    entry per file; files in exclude left out (D428). -> [{file, name}] in countdown order (lowest rank first);
    ClipError when fewer than minItems."""
    seen = {os.path.normcase(os.path.abspath(f)) for f in exclude}
    rows = []
    for r in sorted(_clip_rows(data_dir), key=lambda r: (r["score"], r["kills"], r["run"]), reverse=True):
        key = os.path.normcase(os.path.abspath(r["file"]))
        if key in seen:
            continue
        seen.add(key)
        rows.append(r)
        if len(rows) == int(cfg["items"]):
            break
    if len(rows) < int(cfg["minItems"]):
        raise ClipError(f"countdown: only {len(rows)} rendered vertical clip(s) to rank (need {int(cfg['minItems'])})")
    return [{"file": r["file"], "name": clean_name(r["name"], cfg["name"]["maxChars"]), "music": r["music"],
             "musicRaw": r["musicRaw"]} for r in reversed(rows)]


CREDITED = ("ncs", "ncs-filename", "pack")  # FX5 (D427): a pack track is credited like an NCS one


def combined_music(items):
    """The countdown's own music record (D414), in the raw form clipper writes (clip_publish.music_provenance reads
    it), from its entries' records ("music": the provenance; "musicRaw": the entry's raw record). The reel carries
    every entry's sound, so it is only as postable as its least known entry. All none (or no entries): None. None and
    made-here beds only: a made-here record. One NCS (or, D427, free-pack) record, the same on every entry that has one
    (the rest none or made here): that record, so posting carries its credit. Anything else (a user-folder track, two
    different credited records, an unknown or missing record, a user's own list): unknown, held."""
    provs = [it.get("music", {"source": "unknown"}) for it in items]
    if any(not isinstance(p, dict) for p in provs):  # None: an older render without records (fail closed)
        return {"source": "unknown"}
    srcs = [p.get("source") for p in provs]
    if all(s == "none" for s in srcs):
        return None
    if all(s in ("none", "generated") for s in srcs):
        return {"source": "made-here"}
    raw = [it.get("musicRaw") for it, s in zip(items, srcs) if s in CREDITED]
    if raw and all(isinstance(r, dict) and r.get("source") == "pack" for r in raw):
        # D427: each reel plans the same pack track its own way; what posting needs is the track and its credit
        raw = [{k: r.get(k) for k in ("source", "trackId", "credit")} for r in raw]
    if all(s in ("none", "generated") + CREDITED for s in srcs) and isinstance(raw[0], dict)             and all(r == raw[0] for r in raw):
        return json.loads(json.dumps(raw[0]))
    return {"source": "unknown"}


def user_items(path, cfg):
    """The user's own list: a JSON file [{"file", "name"}] in rank order (#1 first). -> countdown order."""
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    if not isinstance(doc, list):
        raise ClipError("countdown: the item list must be a JSON list of {file, name}")
    out = []
    for it in doc[:int(cfg["items"])]:
        if not isinstance(it, dict) or not os.path.isfile(str(it.get("file") or "")):
            raise ClipError(f"countdown: item {it!r} has no existing file")
        out.append({"file": os.path.abspath(it["file"]), "name": clean_name(it.get("name"), cfg["name"]["maxChars"])})
    if len(out) < int(cfg["minItems"]):
        raise ClipError(f"countdown: the list has {len(out)} item(s) (need {int(cfg['minItems'])})")
    return list(reversed(out))


# ---------------------------------------------------------------- timeline

def timeline(items, durations, has_audio, cfg):
    """The parts in order: [{kind: card|clip, item, rank, sec, start (output s), audio}] and the join length.
    items in countdown order; rank counts down to 1."""
    xd = float(cfg["join"]["ms"]) / 1000.0
    parts, n = [], len(items)
    for i, it in enumerate(items):
        d = min(float(cfg["clipMaxSec"]), float(durations[i]))
        if d < float(cfg["clipMinSec"]):
            raise ClipError(f"countdown: {os.path.basename(it['file'])} is shorter than {cfg['clipMinSec']} s")
        rank = n - i
        parts.append({"kind": "card", "item": i, "rank": rank, "sec": float(cfg["cardSec"]), "audio": False})
        parts.append({"kind": "clip", "item": i, "rank": rank, "sec": round(d, 3), "audio": bool(has_audio[i])})
    t = 0.0
    for p in parts:
        p["start"] = round(t, 3)
        t += p["sec"] - xd
    return parts, xd, round(t + xd, 3)


# ---------------------------------------------------------------- card text (ASS)

def _width_fn(font_file):
    from PIL import ImageFont  # noqa: PLC0415 - pinned in requirements-bundle.lock.txt
    font = ImageFont.truetype(os.path.join(FONTS_DIR, font_file), 100)
    # libass sizes a font so its ascent + descent is the ASS font size (not its em, as Pillow does): seen on the first
    # full-size render, where em-based widths spread the letters of a tall font (Anton) apart
    m = float(sum(font.getmetrics()))
    return lambda s, size: font.getlength(s) * size / m


def card_events(part, name, xd, cfg, width=None, rng=None):
    """Event lines for one rank card: the numeral pop and the name letters assembling, both fading out by the
    card's end, never during its incoming join."""
    fw, fh = int(cfg["frame"]["width"]), int(cfg["frame"]["height"])
    nu, nm = cfg["numeral"], cfg["name"]
    a = part["start"] + (xd if part["start"] > 0 else 0.0)
    b = part["start"] + part["sec"] - xd / 2
    ex = int(cfg["exitMs"])
    colour = cfg["rankColours"][(part["rank"] - 1) % len(cfg["rankColours"])]
    cx = fw // 2
    ev = [f"Dialogue: 1,{caps._ts(a)},{caps._ts(b)},Numeral,,0,0,0,,{{\\an5\\pos({cx},{int(float(nu['y']) * fh)})"
          f"\\1c{_bgr(colour)}\\alpha&HFF&\\fscx140\\fscy140\\t(0,{int(nu['popMs'])},\\alpha&H00&\\fscx100\\fscy100)"
          f"\\fad(0,{ex})}}#{part['rank']}"]
    width = width or _width_fn(nm["fontFile"])
    rng = rng or random.Random(int(cfg.get("seed") or 0) * 1000 + part["rank"])
    size = float(nm["sizeOfHeight"]) * fh
    room = float(nm["widthOfFrame"]) * fw - 2 * int(cfg["safe"]["left"])
    while width(name, size) > room and size > 8:
        size *= 0.92
    x = cx - width(name, size) / 2.0
    y = int(float(nm["y"]) * fh)
    am, sc = int(nm["assembleMs"]), float(nm["scatterPx"])
    for ch in name:
        w = width(ch, size)
        if ch.strip():
            fx, fy = int(x + w / 2), y
            sx, sy = int(fx + rng.uniform(-sc, sc)), int(fy + rng.uniform(-sc, sc))
            rot = int(rng.uniform(-60, 60))
            ev.append(f"Dialogue: 2,{caps._ts(a)},{caps._ts(b)},Name,,0,0,0,,{{\\an5\\fs{int(size)}"
                      f"\\move({sx},{sy},{fx},{fy},0,{am})\\frz{rot}\\t(0,{am},\\frz0)\\alpha&HFF&"
                      f"\\t(0,{am // 2},\\alpha&H00&)\\fad(0,{ex})}}{caps.ass_escape(ch)}")
        x += w
    return ev


def to_ass(parts, items, xd, cfg, width=None):
    fw, fh = int(cfg["frame"]["width"]), int(cfg["frame"]["height"])
    nu, nm = cfg["numeral"], cfg["name"]
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {fw}", f"PlayResY: {fh}", "WrapStyle: 2",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Numeral,{nu['fontFamily']},{int(float(nu['sizeOfHeight']) * fh)},&H00FFFFFF,&H00FFFFFF,"
        f"{_bgr(nu['outlineColour'])},&H80000000,0,0,0,0,100,100,0,0,1,{int(nu['outlinePx'])},0,5,0,0,0,1",
        f"Style: Name,{nm['fontFamily']},{int(float(nm['sizeOfHeight']) * fh)},{_bgr(nm['colour'])},{_bgr(nm['colour'])},"
        f"{_bgr(nm['outlineColour'])},&H80000000,0,0,0,0,100,100,0,0,1,{int(nm['outlinePx'])},0,5,0,0,0,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    width = width or _width_fn(nm["fontFile"])
    ev = []
    for p in parts:
        if p["kind"] == "card":
            ev += card_events(p, items[p["item"]]["name"], xd, cfg, width)
    return "\n".join(head + ev) + "\n"


def prepare(wd, parts, items, xd, cfg):
    """Writes wd/countdown.ass and the fonts folder -> (ass name, fonts dir name)."""
    fd = os.path.join(wd, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    for f in {cfg["numeral"]["fontFile"], cfg["name"]["fontFile"]}:
        shutil.copyfile(os.path.join(FONTS_DIR, f), os.path.join(fd, f))
    with open(os.path.join(wd, ASS_FILE), "w", encoding="utf-8", newline="\n") as f:
        f.write(to_ass(parts, items, xd, cfg))
    return ASS_FILE, FONT_SUBDIR


def cleanup(wd):
    shutil.rmtree(os.path.join(wd, FONT_SUBDIR), ignore_errors=True)
    try:
        os.remove(os.path.join(wd, ASS_FILE))
    except OSError:
        pass


# ---------------------------------------------------------------- render

def join_kinds(n_joins, cfg):
    """One whip direction per join, cycling through join.kinds."""
    ks = list(cfg["join"]["kinds"])
    return [ks[j % len(ks)] for j in range(n_joins)]


def render_argv(ffmpeg, items, parts, xd, cfg, encoder_args, audio_args, out_name, ass=None, fontsdir=None,
                threads=4):
    """One ffmpeg run: each item file is one input (its first frame makes the card still, its first `sec` seconds the
    clip), every part scaled into the frame at 60 fps, joined with xfade (picture) and acrossfade (sound), the card
    text burned last. A part without sound (a card, a silent clip) gets silence of its length."""
    fw, fh = int(cfg["frame"]["width"]), int(cfg["frame"]["height"])
    st = cfg["still"]
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", str(threads), "-filter_threads", "2"]
    for it in items:
        argv += ["-i", it["file"]]
    fmt = "aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
    g = []
    for i in range(len(items)):
        card = next(p for p in parts if p["item"] == i and p["kind"] == "card")
        clip = next(p for p in parts if p["item"] == i and p["kind"] == "clip")
        nc = max(1, round(card["sec"] * 60))
        g.append(f"[{i}:v]scale={fw}:{fh}:force_original_aspect_ratio=decrease:flags=lanczos,"
                 f"pad={fw}:{fh}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p,split=2[vs{i}][vc{i}]")
        g.append(f"[vs{i}]trim=end_frame=1,loop=loop={nc - 1}:size=1:start=0,setpts=N/(60*TB),"
                 f"gblur=sigma={float(st['blur']):g},lutyuv=y=val*{1.0 - float(st['darken']):g},format=yuv420p[p{2 * i}v]")
        # the last frame held when the picture ends before the container's length: the xfade offsets stay exact
        g.append(f"[vc{i}]trim=duration={clip['sec']:.3f},setpts=PTS-STARTPTS,"
                 f"tpad=stop_mode=clone:stop_duration={clip['sec']:.3f},trim=duration={clip['sec']:.3f}[p{2 * i + 1}v]")
        g.append(f"aevalsrc=0|0:c=stereo:s=48000:d={card['sec']:.3f},{fmt}[p{2 * i}a]")
        if clip["audio"]:
            # padded then cut to the picture's length: a clip whose sound ends early never shifts the later joins
            # Codex RR1: the sound keeps its start against the picture's (both start at 0 here): delayed by
            # avOffset when it starts later, its head cut when it starts earlier
            off = float(clip.get("avOffset") or 0.0)
            shift = (f"adelay={int(round(off * 1000))}:all=1," if off > 0.0005 else
                     f"atrim=start={-off:.3f},asetpts=PTS-STARTPTS," if off < -0.0005 else "")
            g.append(f"[{i}:a:0]asetpts=PTS-STARTPTS,{shift}atrim=duration={clip['sec']:.3f},asetpts=PTS-STARTPTS,{fmt},"
                     f"apad=whole_dur={clip['sec']:.3f},atrim=duration={clip['sec']:.3f}[p{2 * i + 1}a]")
        else:
            g.append(f"aevalsrc=0|0:c=stereo:s=48000:d={clip['sec']:.3f},{fmt}[p{2 * i + 1}a]")
    kinds = join_kinds(len(parts) - 1, cfg)
    vlast = "[vj]" if ass else "[vf]"
    for j in range(1, len(parts)):
        vin = "[p0v]" if j == 1 else f"[x{j - 1}v]"
        ain = "[p0a]" if j == 1 else f"[x{j - 1}a]"
        vout = vlast if j == len(parts) - 1 else f"[x{j}v]"
        aout = "[aout]" if j == len(parts) - 1 else f"[x{j}a]"
        g.append(f"{vin}[p{j}v]xfade=transition={kinds[j - 1]}:duration={xd:.3f}:offset={parts[j]['start']:.3f}{vout}")
        g.append(f"{ain}[p{j}a]acrossfade=d={xd:.3f}:c1=tri:c2=tri{aout}")
    if ass:
        g.append(f"[vj]subtitles={ass}" + (f":fontsdir={fontsdir}" if fontsdir else "") + "[vf]")
    # the joins and the burned text may hand back another pixel format (yuv444p seen on real clips, 2026-11-22);
    # every posted file is 4:2:0 (validate)
    g.append("[vf]format=yuv420p[vout]")
    argv += ["-filter_complex", ";".join(g), "-map", "[vout]", "-map", "[aout]"] + list(encoder_args) \
        + list(audio_args) + ["-r", "60", "-movflags", "+faststart", "-f", "mp4", out_name]
    return argv


STOPPED_ON_AIR = "stopped: on air"
NOT_STARTED = "not started"


def make(items, wd, ffmpeg, ffprobe, encoder_args, audio_args, cfg, live=on_air, lock_dir=None, measure=None,
         poll_sec=2.0, threads=4):
    """The countdown reel, off air only, one heavy job at a time: the plan (each item probed), the card text, one ffmpeg
    run into wd/countdown.mp4.part, the flash check (tools/fx-test.mjs, as BeatDrop), then wd/countdown.mp4. A stream
    or recording before or during it (or unknown): the child is stopped, the part file removed, "stopped: on air".
    measure(path, stop) -> the analyser's result (default beatdrop.measure_flash).
    -> {"status" ("done" | "failed" | "stopped: on air" | "not started"), "reason", "file", "parts", "total", "flash"}."""
    from clip_common import NO_JOB_RC, STOPPED_RC, HeavyJobLock, probe, run_tool  # noqa: PLC0415
    import beatdrop as bd  # noqa: PLC0415 - the shared flash check and file removal
    res = {"status": STOPPED_ON_AIR, "reason": "a stream or recording is on (or that cannot be told)", "file": None,
           "parts": None, "total": None, "flash": None}

    def on():  # unknown counts as on air
        return live is None or live() is not False

    if on():
        return res
    os.makedirs(wd, exist_ok=True)
    part = os.path.join(wd, FILE + ".part")
    with HeavyJobLock(lock_dir, job="countdown"):
        try:
            parts, xd, total = plan(items, lambda f: probe(ffprobe, f), cfg)
            res.update(parts=parts, total=total)
            ass, fonts = prepare(wd, parts, items, xd, cfg)
            if on():
                return res
            argv = render_argv(ffmpeg, items, parts, xd, cfg, encoder_args, audio_args, FILE + ".part", ass=ass,
                               fontsdir=fonts, threads=threads)
            r = run_tool(argv, cwd=wd, watch=FILE + ".part", stall_sec=300, stop=on, poll_sec=poll_sec)
        except NotStarted as e:
            bd._drop(part)
            return dict(res, status=NOT_STARTED, reason=str(e))
        finally:
            cleanup(wd)
        if r.returncode == STOPPED_RC:
            bd._drop(part)
            return dict(res, reason="a stream or recording started (or that cannot be told)")
        if r.returncode == NO_JOB_RC:
            bd._drop(part)
            return dict(res, status=NOT_STARTED, reason=r.stderr or "the child could not be started safely")
        if r.returncode != 0 or not os.path.isfile(part):
            bd._drop(part)
            return dict(res, status="failed", reason=f"ffmpeg exited {r.returncode}: " + (r.stderr or "")[-300:])
        fl = cfg["flash"]
        try:
            m = (measure or (lambda f, stop: bd.measure_flash(f, fl["sample"], 60, stop=stop)))(part, on)
        except NotStarted as e:
            bd._drop(part)
            return dict(res, status=NOT_STARTED, reason=str(e))
        except bd.OnAir:
            bd._drop(part)
            return dict(res, reason="a stream or recording started (or that cannot be told)")
        except ClipError as e:
            bd._drop(part)
            return dict(res, status="failed", reason=f"flash not measured ({e}): not kept")
        if on():
            bd._drop(part)
            return dict(res, reason="a stream or recording started (or that cannot be told)")
        res["flash"] = {"peakFlashesPerSecond": m.get("peakFlashesPerSecond"), "limit": m.get("limit"),
                        "pass": bool(m.get("pass")), "worstWindowStartSec": m.get("worstWindowStartSec"),
                        "worstKind": m.get("worstKind")}
        if not m.get("pass") or float(m.get("peakFlashesPerSecond") or 0) > float(fl["maxPerSec"]):
            bd._drop(part)
            return dict(res, status="failed", reason=f"flash limit: {m.get('peakFlashesPerSecond')} flashes/s "
                                                     f"(limit {float(fl['maxPerSec']):g}): not kept")
        os.replace(part, os.path.join(wd, FILE))
        return dict(res, status="done", reason=None, file=FILE)


def part_at(parts, t):
    """The timeline part playing at output second t: a clip part whose [start, start+sec) holds t wins over a card
    (the joins overlap by the join length). -> the part or None."""
    hits = [p for p in parts or [] if float(p["start"]) <= float(t) < float(p["start"]) + float(p["sec"])]
    return next((p for p in hits if p["kind"] == "clip"), hits[0] if hits else None)


def _flash_failed(res):
    return res["status"] == "failed" and str(res.get("reason") or "").startswith("flash limit")


def make_auto(items, wd, cfg, render, pick=None):
    """D428: the reel with flash retries. render(items) -> make()'s result. When items were picked (pick is the
    re-pick, pick(exclude) -> items) and the reel fails the flash limit inside a clip part, that clip's file is left
    out, the items picked again and the reel rendered again, up to cfg.flash.retries more times. The user's own list
    (pick None), a worst window in a card or unknown, too few clips left: it fails as before. Each try is a full
    make() (off air, the heavy-job lock). -> make()'s result plus "items" (the ones rendered) and "dropped"
    ([{source, reason}])."""
    dropped, exclude = [], []
    tries = int(cfg["flash"].get("retries", 0)) if pick else 0
    while True:
        res = dict(render(items), items=items, dropped=list(dropped))
        if not _flash_failed(res) or pick is None:
            return res
        start = (res.get("flash") or {}).get("worstWindowStartSec")
        p = part_at(res.get("parts"), start) if start is not None else None
        if p is None or p["kind"] != "clip":
            where = "a rank card" if p else "an unknown place"
            return dict(res, reason=f"{res['reason']}; the worst window is in {where}, no clip to leave out")
        if tries <= 0:
            return dict(res, reason=f"{res['reason']}; no retries left")
        bad = items[p["item"]]["file"]
        exclude.append(bad)
        dropped.append({"source": os.path.basename(bad), "reason": "flash"})
        try:
            items = pick(exclude)
        except ClipError as e:
            return dict(res, dropped=list(dropped), reason=f"{res['reason']}; {e} after leaving out "
                                                           f"{len(dropped)} clip(s)")
        tries -= 1


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float("inf") else None


def _hms(text):
    """'HH:MM:SS.fraction' (the Matroska DURATION tag) -> seconds, or None."""
    parts = str(text or "").strip().split(":")
    if len(parts) != 3:
        return None
    h, m, s = (_num(x) for x in parts)
    return None if None in (h, m, s) else h * 3600 + m * 60 + s


def stream_facts(probe_doc):
    """From an ffprobe document (format + streams): (picture seconds, has sound, sound start minus picture start).
    The picture's length is its own stream's (Codex RR1: never the container's, which also spans the sound): its
    duration, else its DURATION tag minus its start (Matroska writes the track's end time there, Codex RR1: a picture
    from 2 s to 5 s is tagged 5 s), else the container's end minus the picture's start. Unknown values count as 0."""
    ss = probe_doc.get("streams") or []
    fmt = probe_doc.get("format") or {}
    v = next((s for s in ss if s.get("codec_type") == "video"), None)
    a = next((s for s in ss if s.get("codec_type") == "audio"), None)
    if not v:
        return 0.0, a is not None, 0.0
    vstart = _num(v.get("start_time"))
    dur = _num(v.get("duration"))
    if dur is None:
        end = _hms((v.get("tags") or {}).get("DURATION"))
        dur = max(0.0, end - (vstart or 0.0)) if end is not None else None
    if dur is None:
        end = (_num(fmt.get("start_time")) or 0.0) + (_num(fmt.get("duration")) or 0.0)
        dur = max(0.0, end - (vstart or 0.0))
    astart = _num(a.get("start_time")) if a else None
    off = round(astart - vstart, 3) if astart is not None and vstart is not None else 0.0
    return dur, a is not None, off


def plan(items, probe_doc, cfg):
    """probe_doc(file) -> the ffprobe document. -> (parts, join seconds, total seconds); each clip part carries
    avOffset (its sound's start against its picture's)."""
    facts = [stream_facts(probe_doc(it["file"])) for it in items]
    parts, xd, total = timeline(items, [f[0] for f in facts], [f[1] for f in facts], cfg)
    for p in parts:
        p["avOffset"] = facts[p["item"]][2] if p["kind"] == "clip" else 0.0
    return parts, xd, total
