# SPDX-License-Identifier: GPL-3.0-or-later
"""ED2 burned-in captions (D353, user 2026-11-11): what was said live, from the local speech to text, burned into
montages, match reels, impact-play reels and live clips. Behind the flag reel-captions (off by default).

Data: data/clip/reel-captions.json (backend, model, confidence threshold, preset id); the look is the registry preset
(registry/presets/<preset>.json, function reel-captions): font, size, colours, outline, words per card.

  transcript   the audio of the reel's pieces in play order (teaser included) is joined into one 16 kHz mono file
               and transcribed once, so segment times are already on the reel's own timeline. Stored next to the reel
               as transcript.json: {segments: [{start, end, text, confidence, show, hidden}]}.
  show         a segment is shown when its confidence is at least minConfidence (data) and it is long enough. A
               segment without a confidence is not shown. The user may edit text and show in transcript.json; a
               re-render (clipper.py recaption) uses the edited file as it is (the threshold is not applied again).
  script       the text is kept in the script the model wrote; nothing is transliterated or translated. A shown
               segment the caption font cannot draw is burned in the preset's script font for it (scriptFonts, C4
               2026-11-24: Malayalam in Baloo Chettan 2, which draws Latin too, so a Manglish line stays one font).
               A segment no listed font can draw is not burned (fontMissing) and stays in the transcript, so no empty
               boxes appear.
  font         only the bundled OFL fonts in data/fonts/ (never a Microsoft font). The preset's font file is copied
               into the reel's work folder (fonts/) and passed to libass as fontsdir, so no system font is used.
  safe zone    captions sit inside the intersection of every target's safe zone (data/clip/targets.json): bottom
               aligned at the bottom safe margin, left and right safe margins, at most maxLines lines per card;
               libass wraps any line that would still be wider than the safe width.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import tempfile

import clip_captions as caps
from clip_common import CLIP_DATA, ClipError, flag_on, load_json, on_air, run_tool, write_json_atomic

DEFAULTS_FILE = os.path.join(CLIP_DATA, "reel-captions.json")
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FONTS_DIR = os.path.join(REPO, "data", "fonts")
PRESETS_DIR = os.path.join(REPO, "registry", "presets")
FLAG = "reel-captions"
TRANSCRIPT = "transcript.json"
ASS_NAME = "captions.ass"
SUBS = ("captions.srt", "captions.vtt")  # C1 (user yes 2026-11-24): caption files beside the reel and its transcript
FONT_SUBDIR = "fonts"
SCRIPTS = (("Malayalam", 0x0D00, 0x0D7F), ("Devanagari", 0x0900, 0x097F), ("Tamil", 0x0B80, 0x0BFF),
           ("Latin", 0x0000, 0x024F))


def load_config(path=None):
    return load_json(path or DEFAULTS_FILE)


def load_style(cfg, presets_dir=PRESETS_DIR):
    """The preset's params (registry/presets/<cfg.preset>.json); its function must be reel-captions."""
    p = load_json(os.path.join(presets_dir, cfg["preset"] + ".json"))
    if p.get("function") != "reel-captions":
        raise ClipError(f"reel-captions: preset {cfg['preset']} is not a reel-captions preset")
    st = dict(p["params"])
    for f in [st["fontFile"]] + [x["fontFile"] for x in st.get("scriptFonts") or []]:
        if os.path.basename(f) != f or not os.path.isfile(os.path.join(FONTS_DIR, f)):
            raise ClipError(f"reel-captions: font {f} is not in data/fonts")
    names = {n for n, _, _ in SCRIPTS}
    for x in st.get("scriptFonts") or []:
        if x.get("script") not in names or not str(x.get("fontFamily") or "").strip():
            raise ClipError(f"reel-captions: bad script font {x.get('script')!r}")
    return st


def on(data_dir, cfg=None):
    # The studio checked the speech model before this job and found it missing or damaged (downloads.mjs
    # modelUsable): captions are skipped for this run, the rest of the job goes on.
    if os.environ.get("UJWALAM_REEL_CAPTIONS") == "off":
        return False
    return flag_on(data_dir, (cfg or {}).get("flag") or FLAG)


CLEAN_FLAGS = ("local-ai-model", "ai-captions")  # D443 T5: both must be on for the model to clean the lines
CLEAN_CLI = os.path.join(REPO, "services", "local-model", "caption-clean.mjs")


def clean_flags(data_dir):
    """D443 T5: the flags to pass the clean-up step, or None when the model may not clean (a switch is off)."""
    return list(CLEAN_FLAGS) if data_dir and all(flag_on(data_dir, f) for f in CLEAN_FLAGS) else None


def clean_transcript(doc, workdir, flags, node=None, run=None):
    """D443 T5: the local model cleans the text of the transcript's lines (punctuation, spelling, game words) in
    workdir/transcript.json, off air only (the runner refuses on air). Timing never changes. Any failure returns the
    transcript as it was. -> (doc, stats dict or None)."""
    node = node or shutil.which("node")
    if not flags or not doc or not node or not os.path.isfile(CLEAN_CLI):
        return doc, None
    path = os.path.join(workdir, TRANSCRIPT)
    try:
        r = (run or run_tool)([node, CLEAN_CLI, path, "--flags=" + ",".join(flags)], timeout=1800)
        if r.returncode != 0:
            return doc, {"status": "failed", "reason": "exit " + str(r.returncode)}
        stats = json.loads(r.stdout.strip().splitlines()[-1])
        if stats.get("status") != "cleaned":
            return doc, stats
        new = load_json(path)
        old_t = [(x["start"], x["end"]) for x in doc["segments"]]
        if [(x["start"], x["end"]) for x in new["segments"]] != old_t:  # timing is sacred: never accept a change
            write_json_atomic(path, doc)
            return doc, {"status": "failed", "reason": "timing changed"}
        return new, stats
    except Exception as e:  # noqa: BLE001 - captions stay as the speech model wrote them
        try:
            write_json_atomic(path, doc)
        except Exception:  # noqa: BLE001
            pass
        return doc, {"status": "failed", "reason": str(e)[-120:]}


def model_path(data_dir, cfg, given=None):
    """--whisper-model, else <event-core data>/../models/<model> when it exists, else None."""
    if given:
        return given
    if not data_dir:
        return None
    p = os.path.join(os.path.dirname(os.path.abspath(data_dir)), "models", cfg["model"])
    return p if os.path.isdir(p) else None


def model_opts(data_dir, cfg, given=None, live=None):
    """C3 (user yes 2026-11-24): the speech model and where it runs. cfg.gpuModel (faster-whisper large-v3-turbo) on
    the GPU when its folder is in <models> and the studio is off air; else the CPU model (cfg.model). A GPU run that
    fails falls back to the CPU model (clip_captions.transcribe). live: injected for tests (default on_air())."""
    cpu = {"whisper_model": model_path(data_dir, cfg, given), "device": "cpu", "compute_type": "int8"}
    gpu = cfg.get("gpuModel")
    if given or not gpu or not data_dir:
        return cpu
    p = os.path.join(os.path.dirname(os.path.abspath(data_dir)), "models", gpu["model"])
    if not os.path.isdir(p):
        return cpu
    if (on_air() if live is None else live) is not False:
        return cpu  # never load a GPU model next to a live stream, or when that cannot be told (VRAM, D1)
    return {"whisper_model": p, "device": "cuda", "compute_type": gpu["computeType"],
            "fallback": cpu if cpu["whisper_model"] else None}


# ---------------------------------------------------------------- font coverage (stdlib TrueType cmap reader)

def font_codepoints(path):
    """Set of code points the font maps (cmap format 4 and 12 subtables). Raises ClipError on an unreadable font."""
    with open(path, "rb") as f:
        data = f.read()
    try:
        num = struct.unpack(">H", data[4:6])[0]
        cmap = None
        for i in range(num):
            tag, _, off, _ = struct.unpack(">4sIII", data[12 + 16 * i:28 + 16 * i])
            if tag == b"cmap":
                cmap = off
        if cmap is None:
            raise ClipError(f"{os.path.basename(path)}: no cmap table")
        n = struct.unpack(">H", data[cmap + 2:cmap + 4])[0]
        out = set()
        for i in range(n):
            _, _, sub = struct.unpack(">HHI", data[cmap + 4 + 8 * i:cmap + 12 + 8 * i])
            o = cmap + sub
            fmt = struct.unpack(">H", data[o:o + 2])[0]
            if fmt == 4:
                segx2 = struct.unpack(">H", data[o + 6:o + 8])[0]
                seg = segx2 // 2
                ends = struct.unpack(f">{seg}H", data[o + 14:o + 14 + segx2])
                starts = struct.unpack(f">{seg}H", data[o + 16 + segx2:o + 16 + 2 * segx2])
                deltas = struct.unpack(f">{seg}h", data[o + 16 + 2 * segx2:o + 16 + 3 * segx2])
                ro_at = o + 16 + 3 * segx2
                ros = struct.unpack(f">{seg}H", data[ro_at:ro_at + segx2])
                for k in range(seg):
                    for c in range(starts[k], ends[k] + 1):
                        if c == 0xFFFF:
                            continue
                        if ros[k] == 0:
                            g = (c + deltas[k]) & 0xFFFF
                        else:
                            gi = ro_at + 2 * k + ros[k] + 2 * (c - starts[k])
                            g = struct.unpack(">H", data[gi:gi + 2])[0]
                            g = (g + deltas[k]) & 0xFFFF if g else 0
                        if g:
                            out.add(c)
            elif fmt == 12:
                ng = struct.unpack(">I", data[o + 12:o + 16])[0]
                for k in range(ng):
                    a, b, g0 = struct.unpack(">III", data[o + 16 + 12 * k:o + 28 + 12 * k])
                    out.update(c for c in range(a, b + 1) if g0 + (c - a))
    except struct.error as e:
        raise ClipError(f"{os.path.basename(path)}: bad font file ({e})") from e
    return out


def script_of(cp):
    for name, a, b in SCRIPTS:
        if a <= cp <= b:
            return name
    return "other"


def missing_scripts(text, codepoints):
    """Scripts (names) of the characters in text that the font has no glyph for; [] when every character renders."""
    out = []
    for ch in text:
        cp = ord(ch)
        if ch.isspace() or cp in codepoints:
            continue
        s = script_of(cp)
        if s not in out:
            out.append(s)
    return out


_CPS = {}


def _cps(font_file):
    """Code points of a data/fonts file, read once per process."""
    if font_file not in _CPS:
        _CPS[font_file] = font_codepoints(os.path.join(FONTS_DIR, font_file))
    return _CPS[font_file]


def font_for(text, style):
    """C4 (2026-11-24): (family override or None for the main font, scripts no font can draw). The main font when it
    draws every character; else the first script font for a missing script that draws the whole text."""
    miss = missing_scripts(text, _cps(style["fontFile"]))
    if not miss:
        return None, []
    for x in style.get("scriptFonts") or []:
        if x["script"] in miss and not missing_scripts(text, _cps(x["fontFile"])):
            return x["fontFamily"], []
    return None, miss


def glyph_check(style):
    """missing(text) -> scripts that no font of the style can draw (mark's check)."""
    return lambda text: font_for(text, style)[1]


def covers(font_file, script):
    """True when the font maps every letter of the named script's block that is assigned (spot check: the first 16)."""
    cps = font_codepoints(font_file)
    for name, a, b in SCRIPTS:
        if name == script:
            want = [c for c in range(a, b + 1) if chr(c).isalpha()][:16]
            return bool(want) and all(c in cps for c in want)
    return False


# ---------------------------------------------------------------- transcript

def pieces_wav_argv(ffmpeg, src, pieces, out_wav):
    """One ffmpeg run: the first audio track of each piece in play order, joined, 16 kHz mono PCM."""
    argv = [ffmpeg, "-v", "error", "-nostdin", "-y", "-threads", "4"]
    for p in pieces:
        argv += ["-ss", f"{float(p['start']):.3f}", "-t", f"{float(p['end']) - float(p['start']):.3f}", "-i", src]
    graph = (";".join(f"[{i}:a:0]aresample=16000,asetpts=PTS-STARTPTS[a{i}]" for i in range(len(pieces))) + ";"
             + "".join(f"[a{i}]" for i in range(len(pieces))) + f"concat=n={len(pieces)}:v=0:a=1,aformat=channel_layouts=mono[aout]")
    return argv + ["-filter_complex", graph, "-map", "[aout]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out_wav]


def mark(segments, cfg, codepoints, duration=None):
    """Transcript rows with show/hidden set by the threshold, the minimum length and the font's glyphs. codepoints: the
    font's code points, or missing(text) -> scripts (glyph_check: the main font and the script fonts)."""
    lo, min_len = float(cfg["minConfidence"]), float(cfg.get("minSegmentSec", 0.0))
    out = []
    for s in segments:
        a, b = round(float(s["start"]), 3), round(float(s["end"]), 3)
        if duration is not None:
            b = min(b, round(float(duration), 3))
        if b <= a:
            continue
        conf = s.get("confidence")
        row = {"start": a, "end": b, "text": str(s.get("text", "")).strip(), "confidence": conf}
        hidden = None
        if conf is None:
            hidden = "no confidence from the speech to text"
        elif conf < lo:
            hidden = f"confidence {conf:.2f} below {lo:g}"
        elif b - a < min_len:
            hidden = f"shorter than {min_len:g} s"
        row["show"] = hidden is None
        row["hidden"] = hidden
        ws = [{"start": round(float(x["start"]), 3), "end": round(min(float(x["end"]), b), 3), "text": x["text"]}
              for x in s.get("words") or [] if float(x["start"]) < b]
        if ws:  # LV1 (D421): word times for the word-by-word captions
            row["words"] = ws
        miss = codepoints(row["text"]) if callable(codepoints) else missing_scripts(row["text"], codepoints)
        if miss:
            row["fontMissing"] = miss
        out.append(row)
    return out


def make_transcript(ffmpeg, src, pieces, cfg, style, opts, workdir, duration=None, transcribe=None, words=False,
                    clean=None, cleaner=None):
    """Transcribes the reel's pieces -> (transcript dict or None, info). Writes workdir/transcript.json when there is
    any segment. transcribe: injected for tests (backend, wav, opts) -> (segments, info). words (LV1, D421): ask the
    speech to text for word times too."""
    transcribe = transcribe or caps.transcribe
    with tempfile.TemporaryDirectory(dir=workdir) as td:
        wav = os.path.join(td, "reel.wav")
        r = run_tool(pieces_wav_argv(ffmpeg, src, pieces, wav), timeout=900)
        if r.returncode != 0 or not os.path.isfile(wav):
            return None, {"backend": cfg["backend"], "status": "unavailable", "reason": "audio extract failed"}
        # isolate (2026-11-27): faster-whisper runs in a child with a time limit, so a hung GPU call cannot freeze the job
        segs, info = transcribe(cfg["backend"], wav, dict(opts, isolate=cfg.get("isolate"),
                                                          multilingual=bool(cfg.get("multilingual")),
                                                          full_json=True, language=cfg.get("language"), words=words))
    if info.get("status") != "ok":
        return None, info
    rows = mark(segs, cfg, glyph_check(style), duration)
    doc = {"version": 1, "backend": cfg["backend"],
           "model": info.get("model") or os.path.basename(str(opts.get("whisper_model") or "")),
           "language": info.get("language"), "minConfidence": cfg["minConfidence"], "font": style["fontFamily"],
           "edited": False, "note": "Edit text or show, then run clipper.py recaption to render the reel again.",
           "segments": rows}
    write_json_atomic(os.path.join(workdir, TRANSCRIPT), doc)
    cinfo = None
    if clean:  # D443 T5: the model tidies the lines before burn-in and the .srt/.vtt files are made from them
        doc, cinfo = (cleaner or clean_transcript)(doc, workdir, clean)
        rows = doc["segments"]
    return doc, dict(info, **({"clean": cinfo} if cinfo else {}), shown=sum(1 for x in rows if x["show"] and not x.get("fontMissing")), segments=len(rows))


def retime(doc, src_pieces, out_pieces, xd):
    """Transcript times moved from the joined pieces it was made from (src_pieces, back to back) onto the reel's
    output timeline (out_pieces, each join overlapping by xd): D411, so captions keep the chosen transitions. The two
    lists hold the same pieces in the same order; a piece of out_pieces may end earlier (beat sync trims a tail): a
    caption past that end is cut there, one left with no time is dropped. A transcript already on the output timeline
    (timeline "output") is returned as it is. -> new transcript dict."""
    if doc.get("timeline") == "output":
        return doc
    src = [(float(p["start"]), float(p["end"])) for p in src_pieces]
    out = [(float(p["start"]), float(p["end"])) for p in out_pieces]
    if len(src) != len(out):
        raise ValueError("retime: the reel's pieces changed in number")

    def where(t, start=False):
        # a time exactly on a join: an end belongs to the piece before it, a start to the piece after it (Codex D421:
        # else a word starting at the join is drawn a cross fade late)
        acc = 0.0
        for i, (a, b) in enumerate(src):
            edge = acc + (b - a)
            if (t < edge - 1e-9 if start else t <= edge + 1e-9) or i == len(src) - 1:
                return i, a + max(0.0, t - acc)
            acc += b - a
        return len(src) - 1, src[-1][1]

    starts, acc = [], 0.0
    for i, (a, b) in enumerate(out):
        starts.append(acc - i * xd)
        acc += b - a

    def to_out(i, rt):
        a, b = out[i]
        return starts[i] + min(max(rt, a), b) - a

    def move(x0, x1):
        i, ra = where(float(x0), start=True)
        j, rb = where(float(x1))
        return round(to_out(i, ra), 3), round(to_out(j, rb), 3)  # over a join: it ends in the next piece

    rows = []
    for s in doc.get("segments") or []:
        a, b = move(s["start"], s["end"])
        if b - a > 0.05:
            row = dict(s, start=a, end=b)
            if s.get("words"):  # LV1 (D421): each word moved the same way, kept inside its segment
                ws = []
                for x in s["words"]:
                    wa, wb = move(x["start"], x["end"])
                    wa, wb = max(a, wa), min(b, wb)
                    if wb > wa:
                        ws.append(dict(x, start=wa, end=wb))
                row["words"] = ws
            rows.append(row)
    # a start moved back over a cross fade never overlaps the caption shown before it (Codex); hidden rows (low
    # confidence, a missing glyph) are never drawn, so they cut nothing short
    vis = [r for r in rows if r.get("show") and not r.get("fontMissing")]
    for cur, nxt_row in zip(vis, vis[1:]):
        nxt = nxt_row["start"]
        if cur["end"] > nxt:
            cur["end"] = nxt
            if cur.get("words"):
                cur["words"] = [dict(x, end=min(x["end"], nxt)) for x in cur["words"] if x["start"] < nxt]
    return dict(doc, segments=rows, timeline="output", joinSec=round(float(xd), 3))


# ---------------------------------------------------------------- ASS

def _ass_colour(hex_rgb, alpha=0):
    h = hex_rgb.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return f"&H{alpha:02X}{b:02X}{g:02X}{r:02X}"


def cards(text, max_words, max_chars, max_lines):
    """Text -> caption cards (each a list of lines): at most max_words words per card, lines of at most max_chars
    (a longer single word stays whole; libass wraps it inside the safe margins), at most max_lines lines."""
    words = [w for w in text.split() if w]
    out = []
    for i in range(0, len(words), max(1, int(max_words))):
        lines = caps.wrap(" ".join(words[i:i + int(max_words)]), int(max_chars), int(max_lines))
        out += lines
    return out


def word_cards(words, max_words, max_chars, max_lines):
    """LV1 (D421): words -> cards, each a list of lines, each line a list of word indexes: at most max_words words and
    max_lines lines of at most max_chars per card (a longer single word stays whole on its own line)."""
    cards_, lines, cur, n = [], [], [], 0
    for i, w in enumerate(words):
        width = sum(len(words[k]["text"]) + 1 for k in cur) + len(w["text"])
        if cur and width > int(max_chars):
            lines.append(cur)
            cur = []
        if n >= int(max_words) or len(lines) >= int(max_lines):
            if cur:
                lines.append(cur)
            cards_.append(lines)
            lines, cur, n = [], [], 0
        cur.append(i)
        n += 1
    if cur:
        lines.append(cur)
    if lines:
        cards_.append(lines)
    return cards_


def _words_match(seg):
    """The word times belong to the text as it is (an edited segment keeps its text, not its old word times)."""
    ws = seg.get("words") or []
    return bool(ws) and " ".join(w["text"] for w in ws).split() == str(seg.get("text", "")).split()


def _highlight_events(seg, a, b, style, accent, family=None):
    """One event per word: the whole card, the current word in the accent colour, until the next word starts. family
    (C4): the script font, set at the start and again after each reset."""
    fn = f"\\fn{family}" if family else ""
    ws = [w for w in seg["words"] if float(w["start"]) < b]
    ev = []
    cards = word_cards(ws, style["maxWordsPerCard"], style["maxCharsPerLine"], style["maxLines"])
    for ci, card in enumerate(cards):
        idx = [k for line in card for k in line]
        c_end = min(b, float(ws[idx[-1]]["end"]))
        if ci + 1 < len(cards):  # never two cards at once (a word moved back over a cross fade starts earlier, Codex)
            c_end = min(c_end, float(ws[cards[ci + 1][0][0]]["start"]))
        for pos, k in enumerate(idx):
            t0 = max(a, float(ws[k]["start"]))
            t1 = float(ws[idx[pos + 1]]["start"]) if pos + 1 < len(idx) else c_end
            t1 = min(t1, b)
            if t1 - t0 < 0.02:
                continue
            text = "\\N".join(" ".join(
                (f"{{\\1c{accent}}}{caps.ass_escape(ws[j]['text'])}{{\\r{fn}}}" if j == k else caps.ass_escape(ws[j]["text"]))
                for j in line) for line in card)
            ev.append(f"Dialogue: 0,{caps._ts(t0)},{caps._ts(t1)},Reel,,0,0,0,,{{{fn}}}{text}" if fn else
                      f"Dialogue: 0,{caps._ts(t0)},{caps._ts(t1)},Reel,,0,0,0,,{text}")
    return ev


def to_ass(transcript, frame, safe, style, duration=None, highlight=None):
    """ASS script of the shown segments that the font can draw. -> (text, cards burned). highlight (LV1, D421): a
    #RRGGBB accent: a segment with word times that match its text is shown word by word, the current word in it."""
    w, h = int(frame["width"]), int(frame["height"])
    bold = -1 if style.get("bold") else 0
    head = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {w}", f"PlayResY: {h}", "WrapStyle: 0",
        "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, "
        "Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
        "MarginR, MarginV, Encoding",
        f"Style: Reel,{style['fontFamily']},{int(style['sizePx'])},{_ass_colour(style['textColour'])},"
        f"{_ass_colour(style['textColour'])},{_ass_colour(style['outlineColour'])},{_ass_colour(style['outlineColour'], 0x64)},"
        f"{bold},0,0,0,100,100,0,0,1,{int(style['outlinePx'])},{int(style['shadowPx'])},2,"
        f"{int(safe['left'])},{int(safe['right'])},{int(safe['bottom']) + int(style.get('liftPx', 0))},1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    ev, n = [], 0
    for s in transcript.get("segments") or []:
        if not s.get("show") or s.get("fontMissing"):
            continue
        a, b = float(s["start"]), float(s["end"])
        if duration is not None:
            b = min(b, float(duration))
        family, _ = font_for(str(s.get("text", "")), style)  # C4: a script font for this segment, or None
        if highlight and b > a and _words_match(s):
            hv = _highlight_events(s, a, b, style, _ass_colour(highlight), family)
            if hv:
                ev += hv
                n += 1
                continue
        cs = cards(caps.ass_escape(str(s.get("text", ""))), style["maxWordsPerCard"], style["maxCharsPerLine"],
                   style["maxLines"])
        if b <= a or not cs:
            continue
        weights = [max(1, sum(len(x) for x in c)) for c in cs]
        t = a
        for c, wt in zip(cs, weights):
            d = (b - a) * wt / sum(weights)
            ev.append(f"Dialogue: 0,{caps._ts(t)},{caps._ts(t + d)},Reel,,0,0,0,,"
                      + (f"{{\\fn{family}}}" if family else "") + "\\N".join(c))
            t += d
            n += 1
    return "\n".join(head + ev) + "\n", n


def refresh_hidden(transcript, style):
    """Re-checks every segment's text against the font (after an edit the text may have changed)."""
    for s in transcript.get("segments") or []:
        miss = font_for(str(s.get("text", "")), style)[1]
        if miss:
            s["fontMissing"] = miss
        else:
            s.pop("fontMissing", None)
    return transcript


def _sub_ts(sec, sep):
    ms = int(round(max(0.0, sec) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def subtitle_cues(transcript, duration=None):
    """C1: [(start, end, text)] of the shown segments on the reel's timeline, as burned, but a segment the caption
    font cannot draw is kept (players and YouTube draw every script). Text as written: one line, no markup."""
    out = []
    for s in transcript.get("segments") or []:
        a, b = float(s["start"]), float(s["end"])
        if duration is not None:
            b = min(b, float(duration))
        text = " ".join(str(s.get("text", "")).split())
        if s.get("show") and b > a and text:
            out.append((a, b, text))
    return out


def to_srt(cues):
    return "".join(f"{i}\n{_sub_ts(a, ',')} --> {_sub_ts(b, ',')}\n{t}\n\n" for i, (a, b, t) in enumerate(cues, 1))


def to_vtt(cues):
    # WebVTT: "-->" would end a cue timing line and "<"/"&" start markup; spoken text never needs them as such
    esc = lambda t: t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")  # noqa: E731
    return "WEBVTT\n\n" + "".join(f"{_sub_ts(a, '.')} --> {_sub_ts(b, '.')}\n{esc(t)}\n\n" for a, b, t in cues)


def write_subtitles(transcript, workdir, duration=None):
    """C1: captions.srt and captions.vtt in workdir from the transcript (both removed when nothing is shown, so an
    edit that hides every line leaves no stale file). -> number of cues."""
    return write_cues(subtitle_cues(transcript, duration), workdir)


def write_cues(cues, workdir):
    """C1: [(start, end, text)] -> captions.srt and captions.vtt in workdir (removed when there is no cue)."""
    for name, fmt in zip(SUBS, (to_srt, to_vtt)):
        p = os.path.join(workdir, name)
        if cues:
            tmp = p + ".part"
            with open(tmp, "w", encoding="utf-8", newline="\n") as f:
                f.write(fmt(cues))
            os.replace(tmp, p)
        elif os.path.isfile(p):
            os.remove(p)
    return len(cues)


def write_ass(transcript, frame, safe, style, workdir, duration=None, highlight=None, extra=None):
    """Writes captions.ass and copies the preset's font into workdir/fonts. -> (ass name, fonts dir name, cards) or
    (None, None, 0) when nothing is left to burn. LV1 (D421): highlight as in to_ass; extra = (style lines, event
    lines) added to the same script (the long video's chapter cards), burned even with no caption."""
    write_subtitles(transcript, workdir, duration)  # C1: also when nothing is burned (a Tamil line, say)
    text, n = to_ass(refresh_hidden(transcript, style), frame, safe, style, duration, highlight)
    if extra and extra[1]:
        head, _, events = text.partition("[Events]")
        styles_end = head.rstrip("\n")
        text = styles_end + "\n" + "\n".join(extra[0]) + "\n\n[Events]" + events.rstrip("\n") + "\n" + \
            "\n".join(extra[1]) + "\n"
    elif not n:
        return None, None, 0
    with open(os.path.join(workdir, ASS_NAME), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    fd = os.path.join(workdir, FONT_SUBDIR)
    os.makedirs(fd, exist_ok=True)
    for f in [style["fontFile"]] + [x["fontFile"] for x in style.get("scriptFonts") or []]:
        shutil.copyfile(os.path.join(FONTS_DIR, f), os.path.join(fd, f))
    return ASS_NAME, FONT_SUBDIR, n


def summary(transcript, cards_burned):
    segs = transcript.get("segments") or [] if transcript else []
    return {"segments": len(segs), "shown": sum(1 for s in segs if s.get("show") and not s.get("fontMissing")),
            "lowConfidence": sum(1 for s in segs if not s.get("show")),
            "fontMissing": sorted({x for s in segs for x in s.get("fontMissing") or []}), "cards": cards_burned}
