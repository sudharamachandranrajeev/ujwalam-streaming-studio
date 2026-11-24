# SPDX-License-Identifier: GPL-3.0-or-later
"""Long highlights video (D406, user 2026-11-20): one horizontal (16:9) video per recorded session, cut from its H
recording. Data: data/clip/long-video.json. Flag: long-highlights-video (on by default, user-requested).

1. Moments: every kill group of the recording (clip_montage.groups over the detector hits, end screens dropped, never
   across a match start or end screen), as one window from its first piece to its last, plus the result screen of each
   won match (clip_montage._result_piece). Score: kills * perKill, + streakBonus * the medal score for a streak, and
   `win` for a won match.
2. Merge: each window is padded by padSec (inside the recording); windows that touch or overlap are merged into one
   segment, so no second of footage is used twice. A segment's score is the sum of its moments.
3. Length: the video is the segments joined, minus the cross-fade overlap of each join. Longer than maxSec: the
   lowest-scored segment is dropped first (ties: the shorter, then the later one) until it fits. Shorter than minSec
   (before or after): no video; the reason says how many minutes there were, in plain words.
4. Render: the segments in time order, from the H recording, scaled into the H frame; a cross fade between moments
   (reel_transition: the user's choice when its flag is on, else data defaultTransition; a fade, never a flash). The
   segments are rendered in batches of batchPieces with clip_montage.render_argv (one ffmpeg input per piece), then
   joined without re-encoding (concat demuxer, -c copy), so the audio is encoded once.

Status (DIR/long/long.json): {"status": made|skipped|off|failed, "reason", ...}.
"""

from __future__ import annotations

import os
import shutil

import clip_montage as mont
from clip_common import CLIP_DATA, flag_on, load_json

CONFIG_FILE = os.path.join(CLIP_DATA, "long-video.json")
FLAG = "long-highlights-video"
SUBDIR = "long"
STATUS = "long.json"
CLIP_ID = "X1"
LAYOUT = "long-h"
FILE = "long-h.mp4"
TOOL = "clipper.long"


def load_config(path=None):
    return load_json(path or CONFIG_FILE)


def on(data_dir):
    return flag_on(data_dir, FLAG)


def transition(data_dir, cfg, rt):
    """The join between moments: with the reel-transitions flag on, the user's choice (a cut stays a cut); else the
    data default (a short cross fade). -> {"kind", "xfade", "ms"} or None for a cut."""
    if flag_on(data_dir, rt.FLAG):
        return rt.active(data_dir)
    d = cfg.get("defaultTransition") or None
    return dict(d) if d and d.get("xfade") else None


def mode_at(t, matches):
    """The game family (match "mode", e.g. mp or br) of the match that time t falls in, or None (D438)."""
    best = None
    for m in matches or []:
        try:
            if float(m["start"]) <= t and (best is None or float(m["start"]) >= float(best["start"])):
                best = m
        except (KeyError, TypeError, ValueError):
            continue
    v = (best or {}).get("mode")
    return v if isinstance(v, str) and v else None


def moments(hits, ranking, mcfg, duration, matches, cfg):
    """[{start, end, score, kills, kind}] in recording seconds (unpadded): kill groups and won-match result screens."""
    sc = cfg["score"]
    gs, deaths = mont.groups(mont.drop_end_screens(hits, matches), ranking, mcfg, mont._bounds(matches))
    out = []
    for u in mont._units(gs, deaths, ranking, mcfg, float(duration), matches):
        ps = u["pieces"]
        score = float(sc["perKill"]) * u["kills"] + (float(sc["streakBonus"]) * float(u["score"]) if u["streak"] else 0.0)
        out.append({"start": float(ps[0]["start"]), "end": float(ps[-1]["end"]), "score": round(score, 3),
                    "kills": int(u["kills"]), "kind": "streak" if u["streak"] else "kills",
                    "medals": sorted(float(md["t"]) for md in u.get("medals") or []),  # LV1b callouts (D422)
                    # LV1c paths (D423): the moment's last kill (a merged segment keeps one per moment)
                    "lastKills": [max(float(k) for k in u["peaks"])] if u.get("peaks") else [],
                    # D438: the match family, so a callout never frames a HUD region of another family
                    "modes": [x for x in [mode_at(float(ps[0]["start"]), matches)] if x]})
    wins = {str(x).upper() for x in cfg.get("winResults") or []}
    for mt in matches or []:
        if str(mt.get("result") or "").upper() in wins:
            p = mont._result_piece(mt, mcfg, float(duration))
            if p:
                out.append({"start": float(p["start"]), "end": float(p["end"]), "score": float(sc["win"]), "kills": 0,
                            "kind": "win", "medals": [], "lastKills": [], "modes": [x for x in [mt.get("mode")] if isinstance(x, str) and x]})
    return sorted(out, key=lambda m: (m["start"], m["end"]))


def merge(moms, pad, duration):
    """Padded windows merged where they touch or overlap: [{start, end, score, kills, kinds, moments, medals,
    lastKills}] in time order (medals: the medal times inside; lastKills: each merged moment's last kill; recording seconds). Segments never
    overlap, so no footage is used twice."""
    segs = []
    for m in sorted(moms, key=lambda x: x["start"]):
        s, e = max(0.0, m["start"] - pad), min(float(duration), m["end"] + pad)
        if e <= s:
            continue
        if segs and s <= segs[-1]["end"]:
            g = segs[-1]
            g["end"] = max(g["end"], e)
            g["score"] = round(g["score"] + m["score"], 3)
            g["kills"] += m["kills"]
            g["kinds"] = sorted(set(g["kinds"]) | {m["kind"]})
            g["moments"] += 1
            g["medals"] = sorted(set(g["medals"]) | set(m.get("medals") or []))
            g["lastKills"] = sorted(set(g["lastKills"]) | set(m.get("lastKills") or []))
            g["modes"] = sorted(set(g["modes"]) | set(m.get("modes") or []))
        else:
            segs.append({"start": s, "end": e, "score": m["score"], "kills": m["kills"], "kinds": [m["kind"]],
                         "moments": 1, "medals": sorted(set(m.get("medals") or [])),
                         "lastKills": sorted(set(m.get("lastKills") or [])), "modes": sorted(set(m.get("modes") or []))})
    return [dict(g, start=round(g["start"], 3), end=round(g["end"], 3)) for g in segs]


def video_seconds(segs, tr, batch_pieces=None):
    """Length of the joined video. Inside a render batch each join is cross-faded (it shortens the video); the batch
    files are joined end to end with no cross fade (Codex D406 P2), so only the joins inside a batch are taken off.
    batch_pieces None = one batch (all joins cross-faded)."""
    if not segs:
        return 0.0
    n = len(segs) if batch_pieces is None else max(1, int(batch_pieces))
    total = 0.0
    for i in range(0, len(segs), n):
        chunk = segs[i:i + n]
        xd = mont.crossfade_sec(chunk, tr)
        total += sum(g["end"] - g["start"] for g in chunk) - xd * (len(chunk) - 1)
    return total


def fit(segs, max_sec, tr, batch_pieces=None):
    """Drops the lowest-scored segment first (ties: shorter, then later) until the video, as it is rendered (batches of
    batch_pieces), fits max_sec. -> (kept segments in time order, dropped segments)."""
    keep = sorted(segs, key=lambda g: g["start"])
    dropped = []
    while keep and video_seconds(keep, tr, batch_pieces) > float(max_sec):
        worst = min(keep, key=lambda g: (g["score"], g["end"] - g["start"], -g["start"]))
        keep.remove(worst)
        dropped.append(worst)
    return keep, dropped

# Codex D406: the plan stays this far under maxSec, so frame and join rounding never push a correct render over the cap;
# the probed file is checked against maxSec itself (over_cap) and never published over it.
CAP_MARGIN_SEC = 2.0


def recording_identity(rec):
    """Codex D406: binds long.json to the recording file (the studio's fileIdentity without dev, which Python and Node
    report differently on Windows (measured 2026-11-21): size, ino, mtimeNs as strings, plus the resolved path); the recording cleanup takes it as proof only when all of it matches the file now."""
    try:
        st = os.stat(rec) if rec else None
    except OSError:
        st = None
    if st is None:
        return {"recordingPath": None, "recordingId": None}
    return {"recordingPath": os.path.abspath(rec),
            "recordingId": {"size": str(st.st_size), "ino": str(st.st_ino), "mtimeNs": str(st.st_mtime_ns)}}


def over_cap(actual, cfg):
    return float(actual) > float(cfg["maxSec"])


def _minutes(sec):
    m = sec / 60.0
    return f"{m:.0f} minute{'' if round(m) == 1 else 's'}" if m >= 1 else f"{sec:.0f} seconds"


def plan(hits, ranking, mcfg, duration, matches, cfg, tr):
    """-> {"status": "planned", "segments", "seconds", "dropped", "moments"} or {"status": "skipped", "reason"}."""
    moms = moments(hits, ranking, mcfg, duration, matches, cfg)
    if not moms:
        return {"status": "skipped", "reason": "no kills or wins were found in the recording", "moments": 0}
    segs = merge(moms, float(cfg["padSec"]), duration)
    bp = cfg.get("batchPieces")
    total = video_seconds(segs, tr, bp)
    lo, hi = float(cfg["minSec"]), float(cfg["maxSec"])
    if total < lo:
        return {"status": "skipped", "moments": len(moms), "seconds": round(total, 3),
                "reason": f"the session had only about {_minutes(total)} of highlights; a long video needs at least "
                          f"{_minutes(lo)}"}
    keep, dropped = fit(segs, hi - CAP_MARGIN_SEC, tr, bp)
    secs = video_seconds(keep, tr, bp)
    if secs < lo:  # cannot happen with segments shorter than the band, but never ship below the minimum
        return {"status": "skipped", "moments": len(moms), "seconds": round(secs, 3),
                "reason": f"the best moments fit only about {_minutes(secs)}; a long video needs at least {_minutes(lo)}"}
    return {"status": "planned", "segments": keep, "seconds": round(secs, 3), "dropped": len(dropped),
            "moments": len(moms)}


def batches(segs, n):
    n = max(1, int(n))
    return [segs[i:i + n] for i in range(0, len(segs), n)]


def _render_batches(segs, n, tr, music):
    offset = 0.0
    for chunk in batches(segs, n):
        seconds = video_seconds(chunk, tr)
        bed = dict(music, offsetSec=offset, durationSec=seconds) if music else None
        yield chunk, seconds, bed
        offset += seconds


# The batch parts carry their sound as PCM in MOV (MP4 takes PCM only from FFmpeg 6.1; Codex); the join encodes it
# to AAC once. AAC parts joined by stream copy kept each part's 1024-sample encoder delay: a ~21 ms near-silent gap at
# every batch join and the sound drifting later by that much per join (measured 2026-11-23, ffmpeg n8.1.3;
# docs/evidence/2026-11-23-astra-review-fixes.md).
PART_AUDIO = ["-c:a", "pcm_s24le", "-ar", "48000", "-ac", "2"]
PART_CONTAINER = "mov"
# Codex: the concat demuxer starts each part at the previous part's container duration (its longest stream). A
# track that ends a few ms short of the picture leaves a timestamp gap there; hard compensation fills any gap over
# 1 ms with silence so every track stays on the picture's timeline across all joins.
JOIN_AUDIO_SYNC = ["-af", "aresample=async=1:min_hard_comp=0.001:first_pts=0"]


def concat_argv(ffmpeg, list_name, out_name, audio):
    """Joins the batch files: the picture copied (encoded once in its part), each PCM track encoded once with audio."""
    return [ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", list_name, "-map", "0",
            "-c:v", "copy", *JOIN_AUDIO_SYNC, *audio, "-movflags", "+faststart", "-f", "mp4", out_name]


ATTEMPT_PREFIX = "attempt-"


def clear_attempts(wd):
    """Removes the work folders of earlier attempts (a kill at stream start, a crash) so no part file is left behind."""
    try:
        names = os.listdir(wd)
    except OSError:
        return
    for n in names:
        p = os.path.join(wd, n)
        if n.startswith(ATTEMPT_PREFIX) and os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)


def render(ffmpeg, src, segs, frame, encoder, wd, audio_tracks, fade_ms, tr, batch_pieces, render_job, run_tool, encoders,
           audio, overlay=None, overlay_failed=None, gain_db=None, music=None, grade=None, on_part=None, part_ok=None):
    """Renders the segments into wd/long-h.mp4. render_job(mk_argv, encoder, wd, part, what) -> (CompletedProcess,
    encoder) (clipper._render_job: stall watch, CPU retry). The parts and their list live in a per-attempt folder that
    is removed in finally (and by the next start, after a kill). overlay (LV1a/LV1b, D421/D422): overlay(chunk, first
    number, folder) -> {"ass", "fontsdir", "fx"} (each may be None): the ASS burned over that batch, fx a render_argv
    graph fragment ([fxin] -> [fxout], the callout cards); a batch that fails with it is rendered once more without it
    (overlay_failed(batch index, stderr) is told), so an overlay never stops the video. gain_db (D440): the one loudness
    gain of the whole video (batch_parts + clip_loudness), the same in every batch. on_part(n) (D442): told after batch n
    (1-based) is saved with its manifest (never for a batch made without its overlay); the studio may pause there.
    -> (ok, expected seconds, error or None)."""
    clear_attempts(wd)
    # D442 resume: the parts live in a fixed folder (not an attempt folder), each with the key of its inputs, so a run
    # paused or stopped between batches keeps the batches it saved; a part whose key, size or duration is wrong is
    # made again. The folder goes once the video is joined (or the render failed).
    adir = os.path.join(wd, PARTS_DIR)
    os.makedirs(adir, exist_ok=True)
    finished = False
    try:
        parts, expected, first = [], 0.0, 1
        for i, (chunk, seconds, bed) in enumerate(_render_batches(segs, batch_pieces, tr, music)):
            name = f"part-{i:03d}.{PART_CONTAINER}"
            pieces = [{"start": g["start"], "end": g["end"], "kills": g["kills"]} for g in chunk]
            ov = (overlay(chunk, first, adir) if overlay else None) or {}
            first += len(chunk)
            key = part_key(pieces, frame, audio_tracks, fade_ms, tr, gain_db, bed, grade, ov, src=src, encoder=encoder, base=adir)
            if part_done(adir, name, key, part_ok):
                parts.append(name)
                expected += seconds
                if on_part:
                    on_part(i + 1)
                continue

            drop_part(adir, name)  # Codex review: the manifest and the old media go before this batch is made again

            def mk(enc, pieces=pieces, name=name, ov=ov, bed=bed):
                return mont.render_argv(ffmpeg, src, pieces, frame, encoders[enc], PART_AUDIO, fade_ms, name + ".part",
                                        audio_tracks=audio_tracks, transition=tr, captions=ov.get("ass"),
                                        fontsdir=ov.get("fontsdir"), fx=ov.get("fx"), gain_db=gain_db, music=bed, grade=grade,
                                        container=PART_CONTAINER)
            r, encoder = render_job(mk, encoder, adir, name + ".part", f"long video part {i + 1}")
            fallback = ov.get("degraded") is True  # Codex round 2: the overlay's preparation failed in part
            if r.returncode != 0 and (ov.get("ass") or ov.get("fx")):
                fallback = True  # Codex review: a batch made without its overlay is never kept for a resume
                if overlay_failed:
                    overlay_failed(i, r.stderr)
                r, encoder = render_job(lambda enc, mk=mk: mk(enc, ov={}), encoder, adir, name + ".part",
                                        f"long video part {i + 1} without captions")
            if r.returncode != 0:
                finished = True
                return False, 0.0, f"part {i + 1} did not render: {r.stderr.strip()[-200:]}"
            os.replace(os.path.join(adir, name + ".part"), os.path.join(adir, name))
            parts.append(name)
            expected += seconds
            if not fallback:  # D442: only a committed part is a safe point (a fallback part is made again on resume)
                commit_part(adir, name, key)
                if on_part:
                    on_part(i + 1)
        with open(os.path.join(adir, "parts.txt"), "w", encoding="utf-8") as f:
            f.write("".join(f"file '{p}'\n" for p in parts))
        r = run_tool(concat_argv(ffmpeg, "parts.txt", FILE + ".part", audio), cwd=adir, timeout=1800)
        finished = True
        if r.returncode != 0:
            return False, 0.0, f"the parts did not join: {r.stderr.strip()[-200:]}"
        os.replace(os.path.join(adir, FILE + ".part"), os.path.join(wd, FILE))
        return True, round(expected, 3), None
    finally:
        if finished:  # a kill or an error mid-way keeps the saved parts for the next run
            shutil.rmtree(adir, ignore_errors=True)


PARTS_DIR = "long-parts"  # D442: not an attempt folder (clear_attempts keeps it)


MANIFEST_SUFFIX = ".done.json"  # D442: written after the part's media; binds its key to that file's size and mtime
FINGERPRINT_BYTES = 1 << 20


def fingerprint(p, mtime=False):
    """D442: a stable identity of a file's content that does not depend on where it is: size + SHA-256 of its first
    and last MB (a file up to 2 MB: all of it). mtime (Codex round 2, the recording): its mtime in ns too, so an
    in-place edit is seen; the full file is not hashed (hours of video). Residual: an edit inside the middle that keeps
    the size, both end MBs and the mtime is not seen. None when it is not a readable file."""
    import hashlib  # noqa: PLC0415
    try:
        size = os.path.getsize(p)
        mt = os.stat(p).st_mtime_ns if mtime else None
        h = hashlib.sha256()
        with open(p, "rb") as f:
            h.update(f.read(FINGERPRINT_BYTES))
            if size > FINGERPRINT_BYTES:
                f.seek(max(FINGERPRINT_BYTES, size - FINGERPRINT_BYTES))
                h.update(f.read(FINGERPRINT_BYTES))
        return [size, h.hexdigest()] + ([mt] if mtime else [])
    except (OSError, TypeError, ValueError):
        return None


def _stable(v, base=None):
    """Values for a key with every file or folder path replaced by its content (a temp soundtrack path changes per
    run; the song does not). Codex round 2: a relative path is the batch folder's (base), where ffmpeg runs; a
    folder (the fonts) is keyed by each file's name and content."""
    if isinstance(v, dict):
        return {k: _stable(x, base) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_stable(x, base) for x in v]
    if isinstance(v, str) and 0 < len(v) < 1024:
        p = v if os.path.isabs(v) or not base else os.path.join(base, v)
        if os.path.isfile(p):
            return {"file": fingerprint(p)}
        if os.path.isdir(p):
            files = []
            for root, dirs, names in os.walk(p):
                dirs.sort()
                files += [[os.path.relpath(os.path.join(root, n), p).replace(os.sep, "/"), fingerprint(os.path.join(root, n))]
                          for n in sorted(names)]
            return {"dir": files}
    return v


def part_key(pieces, frame, audio_tracks, fade_ms, tr, gain_db, bed, grade, ov, src=None, encoder=None, base=None):
    """D442: the inputs of one batch, hashed: the recording (content fingerprint), the pieces, the effective render
    configuration (frame, tracks, fade, transition, gain, grade, encoder asked for, part formats), the soundtrack by
    content, the overlay by its files' contents (new captions make it again)."""
    import hashlib  # noqa: PLC0415
    import json  # noqa: PLC0415
    blob = json.dumps([fingerprint(src, mtime=True) if src else None, pieces, frame, audio_tracks, fade_ms, tr, gain_db,
                       _stable(bed), grade, _stable(ov.get("ass"), base), _stable(ov.get("fontsdir"), base),
                       _stable(ov.get("fx"), base), encoder, PART_AUDIO, PART_CONTAINER], sort_keys=True, default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def drop_part(adir, name):
    """Removes a batch's manifest first, then its media (a crash in between leaves media no manifest vouches for)."""
    for n in (name + MANIFEST_SUFFIX, name):
        try:
            os.remove(os.path.join(adir, n))
        except FileNotFoundError:
            pass


def commit_part(adir, name, key):
    """Writes the manifest of a saved batch atomically, after its media: { key, size, mtimeNs }."""
    import json  # noqa: PLC0415
    s = os.stat(os.path.join(adir, name))
    m = os.path.join(adir, name + MANIFEST_SUFFIX)
    with open(m + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"key": key, "size": s.st_size, "mtimeNs": s.st_mtime_ns}, f)
    os.replace(m + ".tmp", m)


def part_done(adir, name, key, part_ok=None):
    """D442: a saved batch can be used again: its manifest has this key and the same size and mtime as the media
    there now (not a file written later), the file is not empty and (part_ok) has a duration."""
    import json  # noqa: PLC0415
    p = os.path.join(adir, name)
    try:
        with open(p + MANIFEST_SUFFIX, encoding="utf-8") as f:
            m = json.load(f)
        s = os.stat(p)
    except (OSError, ValueError):
        return False
    if not isinstance(m, dict) or m.get("key") != key or s.st_size <= 0 or m.get("size") != s.st_size \
            or m.get("mtimeNs") != s.st_mtime_ns:
        return False
    return part_ok(p) if part_ok else True

def batch_parts(ffmpeg, src, segs, frame, enc_args, audio, fade_ms, tr, batch_pieces, audio_tracks, music=None):
    """D440: [(argv builder(gain), seconds)] per batch, as render() cuts them (no overlay: the sound is the same), for
    the loudness pre-pass of the whole video."""
    out = []
    for chunk, seconds, bed in _render_batches(segs, batch_pieces, tr, music):
        pieces = [{"start": g["start"], "end": g["end"], "kills": g["kills"]} for g in chunk]

        def b(gain, pieces=pieces, bed=bed):
            return mont.render_argv(ffmpeg, src, pieces, frame, enc_args, audio, fade_ms, "probe.mp4",
                                    audio_tracks=audio_tracks, transition=tr, gain_db=gain, music=bed)
        out.append((b, seconds))
    return out


def duration_ok(actual, expected):
    """Each batch can round a piece by a frame and the copy join by a few audio frames: 2 s or 0.5 %, the larger."""
    return abs(float(actual) - float(expected)) <= max(2.0, 0.005 * float(expected))
