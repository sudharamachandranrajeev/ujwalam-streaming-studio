# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 output layout (user 2026-11-08): finished videos to the clips folder under the clip_names.py convention, every
other file in the app data folder; the live clipper's replay saves removed once edited; `tidy` for older folders.

publish(work, to, data_dir, ...) -> [row]   each validated (PASS) video of a run folder in app data is linked (a hard
    link, so no second copy on disk; a copy when the folders are on different drives) into
    <to>/<YYYY-MM-DD>/<convention name>.mp4. The run folder keeps its own file (posting packages from it). Rows go to
    <work>/published.json and the upload list <data>/clips/uploads.json ({file, kind, label, run, posted: [], choices?};
    choices = the edit choices of a reel, RP5 / D373).
drop_used_saves(paths) -> deleted   the live clipper's replay saves (host names replay-<H|V>-<stamp>[-n].mkv inside a
    'replay' folder) after live-review made clips from them. Anything else is never touched.
tidy_plan(recordings, clips, data_dir) -> [action]   read-only; `apply_plan` acts on it (clipper.py tidy --apply).
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import shutil
import time
from datetime import datetime

import clip_names as names
import learning_mix as lmix
import reel_thumbnail as rt
import hashlib

from clip_common import ClipError, ensure_provenance_since, load_json, write_json_atomic

PUBLISHED = "published.json"
UPLOADS = os.path.join("clips", "uploads.json")
RUNS = os.path.join("clips", "runs")
ANALYSIS = ("candidates.json", "detector-hits.jsonl", "detector-pass.json", "match-stats.json", "matches.json",
            "render.json", "report.json", PUBLISHED)
REPLAY_RE = re.compile(r"^replay-[HV]-\d{8}-\d{6}(-\d+)?\.mkv$", re.IGNORECASE)
RECORDING_RE = re.compile(r"^[A-Za-z0-9._-]+-[hv]-\d{8}-\d{6}\.(mkv|mp4|mov)$", re.IGNORECASE)
STAMP_RE = re.compile(r"(\d{8}-\d{6})")


def _stamp_time(text):
    m = STAMP_RE.search(text or "")
    return datetime.strptime(m.group(1), "%Y%m%d-%H%M%S") if m else None


def kind_of(clip_id, doc_tool=None):
    if (doc_tool or "") == "clipper.long":
        return "long-highlights"  # D406: the session's long highlights video (H)
    if str(clip_id).startswith("W"):
        return "won-reel"
    if str(clip_id).startswith("I") and (doc_tool or "").startswith("clipper.montage"):
        return "impact-play"  # D326
    if str(clip_id).startswith("M") and (doc_tool or "").startswith("clipper.montage"):
        return "montage"
    if (doc_tool or "") == "clipper.countdown":
        return "countdown"  # RR1 (D424): the Top 5 countdown reel (never auto-posted; not a ranked item itself)
    if str(clip_id).startswith("B") and (doc_tool or "") == "clipper.beatdrop":
        return "montage"  # BD7c: a BeatDrop montage posts under the montage rules (names, auto-post, music gate)
    return "short"


def clip_time(clip, rec_start_local, kind):
    """Local wall time of the clip's first moment (naive datetime), or None."""
    if clip.get("wallStart") is not None:
        return names.local_time(float(clip["wallStart"]))
    if rec_start_local is None:
        return None
    from datetime import timedelta
    if kind in ("montage", "won-reel", "impact-play", "long-highlights") and clip.get("pieces"):
        off = min(float(p["start"]) for p in clip["pieces"])
    else:
        off = float(clip.get("start") or 0.0)
    return rec_start_local + timedelta(seconds=off)


def _kills(clip):
    if isinstance(clip.get("countdown"), list):  # RR1 (D424): the countdown's label counts its entries (top-N)
        return len(clip["countdown"])
    if clip.get("pieces") is None and isinstance(clip.get("beatdrop"), dict):  # BD7c: the BeatDrop plan's own count
        return int((clip["beatdrop"].get("stats") or {}).get("kills") or 0)
    return sum(int(p.get("kills") or 0) for p in clip.get("pieces") or [])


def name_rows(rdoc, game, layouts_by_id, det_weights=None, rec_start_local=None):
    """[(clip, file row, kind, when, label, canvas)] for every rendered file of a render.json (no file access)."""
    tool = rdoc.get("tool") or ""
    if rec_start_local is None:
        rec_start_local = _stamp_time(rdoc.get("recording"))
    out = []
    for c in rdoc.get("clips") or []:
        kind = kind_of(c.get("id"), tool)
        when = clip_time(c, rec_start_local, kind) or _stamp_time(c.get("source")) or datetime.now()
        label = names.label_for(kind, c.get("labels"), _kills(c), det_weights, part=c.get("part"), parts=c.get("parts"))
        for f in c.get("files") or []:
            lay = layouts_by_id.get(f.get("layout")) or ({"input": "v"} if str(f.get("layout", "")).endswith("-v") else
                                                          {"id": f.get("layout")})
            if kind == "long-highlights" or f.get("layout") == "beatdrop-h":
                lay = {"canvas": "h"}  # D406: cut of the H recording; BD7c: the BeatDrop H render
            out.append((c, f, kind, when, label, names.canvas_suffix(lay)))
    return out


MUSIC_SIDECAR = ".music.json"


def music_provenance(c, records=False):
    """Codex BD review (D414): where a rendered clip's music came from, from its own render.json entry ("music", the
    record clipper.py _music writes). -> {"source": "none"} (no music), {"source": "generated"} (made here: RP3 beds,
    D411 made-here fallback), {"source": "user-folder", "track"} (the D411 music folder: render only, never posted),
    {"source": "ncs", "trackId", "credit"} (the NCS library: posted with its credit), {"source": "pack", "trackId",
    "credit"} (FX5 free music pack: posted with its credit), {"source": "unknown"} (a record
    of an unknown shape, or a render that keeps records but wrote none for this clip: held), or None (an older render
    without records: posting's legacy rule decides)."""
    if not isinstance(c, dict) or "music" not in c:
        # a render that keeps music records (render.json musicRecords) but wrote none for this clip: unknown, held
        # (fail closed); an older render without records: no record, posting's legacy rule decides
        return {"source": "unknown"} if records else None
    m = c["music"]
    if m is None:
        return {"source": "none"}
    if not isinstance(m, dict):
        return {"source": "unknown"}
    src = m.get("source")
    if src == "ncs":
        return {"source": "ncs", "trackId": m.get("trackId"), "credit": m.get("credit")}
    if src == "ncs-filename":  # D417: the NCS file-name credit (parsed fields kept in the record)
        return {"source": "ncs-filename", "trackId": m.get("trackId"), "credit": m.get("credit"), "ncs": m.get("ncs")}
    if src == "folder":
        return {"source": "user-folder", "track": m.get("track")}
    if src == "pack":  # FX5 (D427): the free music pack, posted with its credit (CC0: credited anyway)
        return {"source": "pack", "trackId": m.get("trackId"), "credit": m.get("credit")}
    if src == "made-here" or (src is None and "track" not in m and "seed" in m):
        return {"source": "generated"}
    return {"source": "unknown"}


def write_music_sidecar(video, prov):
    """<video>.music.json next to the published video: the clips-folder scan (services/posting/clips-source.mjs) reads
    it for a video that has no uploads.json row. Unknown provenance writes nothing (posting refuses a montage then)."""
    if prov is None:
        return
    try:
        write_json_atomic(video + MUSIC_SIDECAR, {"version": 1, "music": prov, "video": video_binding(video)})
    except (OSError, ClipError):
        pass  # no sidecar = unknown = a montage is not posted (fail closed)


BIND_BYTES = 1 << 20


def video_binding(video):
    """Codex verify (D414): ties a sidecar to its video: size + SHA-256 of the first and last MiB. clips-source.mjs
    musicSidecar checks it; another video (or a changed one) makes the record unknown."""
    with open(video, "rb") as fh:
        size = os.fstat(fh.fileno()).st_size
        head = hashlib.sha256(fh.read(BIND_BYTES)).hexdigest()
        fh.seek(max(0, size - BIND_BYTES))
        tail = hashlib.sha256(fh.read(BIND_BYTES)).hexdigest()
    return {"size": size, "head": head, "tail": tail}


def _link_or_copy(src, dst):
    try:
        os.link(src, dst)
        return "link"
    except OSError:
        shutil.copy2(src, dst)
        return "copy"


def _passed(report):
    """{(id, file): ok} from report.json; None when there is no report."""
    if not report:
        return None
    return {(r.get("id"), r.get("file")): bool(r.get("ok")) for r in report.get("results") or []}


def publish(work, to, data_dir, game, layouts_by_id, det_weights=None, run_name=None, rec_start_local=None):
    """Links each PASS video of the run folder `work` into the clips folder `to`. Returns the rows written."""
    ensure_provenance_since(data_dir)  # D414: before any video lands in the clips folder
    rdoc = load_json(os.path.join(work, "render.json"))
    rep_path = os.path.join(work, "report.json")
    passed = _passed(load_json(rep_path) if os.path.isfile(rep_path) else None)
    if passed is None:
        raise ClipError("publish needs report.json (validate first)")
    prev_path = os.path.join(work, PUBLISHED)
    try:
        prev_all = [r for r in (load_json(prev_path).get("files") or []) if isinstance(r, dict)] \
            if os.path.isfile(prev_path) else []
    except ClipError:
        prev_all = []
    prev = [r for r in prev_all if os.path.isfile(r.get("file", ""))]
    tool = rdoc.get("tool") or ""
    done = {}
    # BeatDrop: a take whose file is gone (posted, then removed) still counts as published, so its render never
    # publishes again; other tools publish an id and layout again when its file is gone (as before BD7c)
    for r in prev_all if tool == "clipper.beatdrop" else prev:
        done.setdefault((r.get("id"), r.get("layout")), []).append(r)
    rows, counters = [], {}
    # Codex BD7c: a name a listed video had (since removed) is never given to a new one; uploads.json would match the new
    # video to the old row and its posted record
    listed = {os.path.normcase(os.path.abspath(r["file"])) for r in prev_all if isinstance(r.get("file"), str)}
    listed |= _listed_uploads(data_dir)
    for c, f, kind, when, label, canvas in name_rows(rdoc, game, layouts_by_id, det_weights, rec_start_local):
        if not passed.get((c["id"], f["file"])):
            continue
        src = os.path.join(work, "clips", c["id"], f["file"])
        if not os.path.isfile(src):
            continue
        olds = done.get((c["id"], f["layout"])) or []
        if olds:
            # BD7c: a BeatDrop retake is a new render (new file name) under the same id and layout. It is published as a
            # new video (published bytes are never replaced, so nothing races an upload) and the earlier ones are marked
            # superseded in uploads.json. Any other tool: the id and layout are published once.
            if tool != "clipper.beatdrop" or any(_same_render(o, src, f["file"]) for o in olds):
                continue
        day = os.path.join(to, names.day_folder(when))
        os.makedirs(day, exist_ok=True)
        start_nn = counters.get((kind, canvas), 0) + 1
        name, nn = names.free_name(lambda n: os.path.exists(os.path.join(day, n))
                                   or os.path.normcase(os.path.abspath(os.path.join(day, n))) in listed,
                                   lambda n: names.clip_name(game, kind, when, label, n, canvas), start_nn)
        counters[(kind, canvas)] = nn
        how = _link_or_copy(src, os.path.join(day, name))
        prov = music_provenance(c, bool(rdoc.get("musicRecords")))
        write_music_sidecar(os.path.join(day, name), prov)
        try:
            vbind = video_binding(os.path.join(day, name))  # Codex verify: the row describes these bytes only
        except OSError:
            vbind = None
        rows.append({"id": c["id"], "layout": f["layout"], "file": os.path.join(day, name), "source": f["file"],
                     "how": how, "kind": kind,
                     "label": label, "seconds": round(float(c["end"]) - float(c["start"]), 3),
                     **({"thumbnail": True} if f.get("thumbnail") else {}),  # RP6: frame 0 is the cover
                     **({"music": prov} if prov is not None else {}),  # D414: where its music came from (posting gate)
                     **({"video": vbind} if vbind else {}),
                     # PT1 (D408): the clip's facts (medal, kills, result, mode; only the known ones) for its post text
                     **({"facts": rt.facts(c)} if rt.facts(c) else {}),
                     # RP5 (D373): the edit choices a reel was made with, so its results can be linked to them
                     **({"choices": lmix.choices_record(c, (c.get("learning") or {}).get("mixAt"))}
                        if tool.startswith("clipper.montage") else {})})
    run = run_name or os.path.basename(os.path.normpath(work))
    # Codex BD7c: rows of gone files are kept (a later retake still supersedes them); `prev` (existing files) decides what is published again
    write_json_atomic(prev_path, {"tool": "clipper.publish", "to": to, "files": prev_all + rows})
    if data_dir:
        entries = [_upload_entry(r, run, rdoc, game) for r in rows]
        sup = {}
        if tool == "clipper.beatdrop":
            # Codex BD7c: every publish of a BeatDrop folder brings uploads.json in line with published.json (the newest
            # take of each id and layout listed, every earlier take superseded by it), so a publish that stopped between
            # the two writes is repaired by the next one
            # The last take is the current one even when its file is gone (posting removes a file once it is uploaded):
            # an earlier take never becomes current again. Earlier takes whose files are gone are superseded too.
            groups = {}
            for r in prev_all + rows:
                groups.setdefault((r.get("id"), r.get("layout")), []).append(r)
            for takes in groups.values():
                newest = takes[-1]
                # every take still on disk is listed (add_uploads keeps a row already listed), so an earlier take whose
                # first uploads write failed is still marked superseded
                entries += [_upload_entry(t, run, rdoc, game) for t in takes
                            if all(k in t for k in ("file", "kind", "label", "seconds")) and os.path.isfile(t["file"])]
                sup.update({o["file"]: newest.get("file") for o in takes if o.get("file") and newest.get("file")})
        if entries or sup:
            add_uploads(data_dir, entries, sup)
    return rows


def _listed_uploads(data_dir):
    """The (normalised) paths uploads.json lists; empty when it is missing or unreadable (add_uploads then refuses)."""
    try:
        doc = load_json(os.path.join(data_dir, UPLOADS)) if data_dir else {}
    except (ClipError, OSError):
        return set()
    files = doc.get("files") if isinstance(doc, dict) else None
    return {os.path.normcase(os.path.abspath(x["file"])) for x in files or []
            if isinstance(x, dict) and isinstance(x.get("file"), str)}


def _upload_entry(r, run, rdoc, game):
    return {**{k: r[k] for k in ("file", "kind", "label", "seconds")}, "run": run,
            "recording": rdoc.get("recording"), "posted": [], "game": game,
            **({"facts": r["facts"]} if r.get("facts") else {}),
            **({"thumbnail": True} if r.get("thumbnail") else {}),
            **({"music": r["music"]} if r.get("music") else {}),
            **({"video": r["video"]} if r.get("video") else {}),
            **({"choices": r["choices"]} if r.get("choices") else {})}


def _same_render(old, src, name):
    """True when the published row `old` holds this render: its source name matches, or (a row written before BD7c,
    without a source) its published file has the same size and first and last MiB as `src`."""
    if old.get("source") is not None:
        return old["source"] == name
    try:
        return video_binding(old["file"]) == video_binding(src)
    except FileNotFoundError:
        return False  # gone: cannot be compared; a retake must not be blocked by it (BeatDrop never published before BD7c)
    except OSError:
        return True  # unreadable: never published twice


UPLOADS_LOCK_STALE_SEC = 30.0  # services/posting/auto-chain.mjs withUploadsLock uses the same lock file and limit


@contextlib.contextmanager
def uploads_lock(data_dir, wait_sec=10.0):
    """Codex BD7c: one writer of uploads.json at a time across processes (this publish step and posting's markPosted):
    <uploads.json>.lock created exclusively with this writer's token, held only around one read-change-write (well under
    a second), taken over when older than UPLOADS_LOCK_STALE_SEC (a writer that died; _take_stale). Released only while
    it still holds this writer's token. Busy past wait_sec (or a lock that keeps failing): ClipError, nothing written."""
    lock = os.path.join(data_dir, UPLOADS) + ".lock"
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    token = f"{os.getpid()}-{os.urandom(8).hex()}"
    end = time.monotonic() + wait_sec
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            try:
                os.write(fd, token.encode())
            finally:
                os.close(fd)
            break
        except OSError:  # held, or being removed (Windows: access denied while a delete is pending)
            if _take_stale(lock):
                continue
            if time.monotonic() > end:
                raise ClipError("the finished-video list (uploads.json) is busy; publish again later") from None
            time.sleep(0.05)
    try:
        yield
    finally:
        try:
            with open(lock, encoding="utf-8") as fh:
                mine = fh.read() == token
            if mine:
                os.remove(lock)
        except OSError:
            pass


def _take_stale(lock):
    """Removes a lock older than the limit. Only the holder of <lock>.takeover (created exclusively) checks and removes,
    so no writer can remove a lock another writer has just taken. A takeover file older than the limit (its process died
    in those few milliseconds) is removed. -> True only when this call removed the lock: try to take it again at once."""
    guard = lock + ".takeover"
    try:
        os.close(os.open(guard, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except OSError:
        try:
            if time.time() - os.path.getmtime(guard) > UPLOADS_LOCK_STALE_SEC:
                os.remove(guard)
        except OSError:
            pass
        return False
    try:
        if time.time() - os.path.getmtime(lock) <= UPLOADS_LOCK_STALE_SEC:
            return False
        os.remove(lock)
        return True
    except OSError:  # gone (the caller waits and tries again) or cannot be removed
        return False
    finally:
        try:
            os.remove(guard)
        except OSError:
            pass

def add_uploads(data_dir, rows, superseded=None):
    p = os.path.join(data_dir, UPLOADS)
    with uploads_lock(data_dir):
        try:
            doc = load_json(p) if os.path.isfile(p) else {"files": []}
        except ClipError:
            # Codex BD7c: an unreadable list is never replaced by a new one (its posted records would be lost and every
            # clip posted again); the clips-folder scan still finds the published videos with their music sidecars
            raise ClipError("the finished-video list (uploads.json) cannot be read; it was not changed") from None
        if not isinstance(doc, dict) or not isinstance(doc.get("files"), list) \
                or not all(isinstance(x, dict) for x in doc["files"]):
            raise ClipError("the finished-video list (uploads.json) has an unknown shape; it was not changed")
        files = list(doc["files"])
        have = {x.get("file") for x in files}
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        files += [{**r, "addedAt": now} for r in rows if r["file"] not in have and not have.add(r["file"])]
        sup = superseded or {}
        for x in files:  # BD7c: earlier BeatDrop takes; posting never packages or sends a superseded video
            new = sup.get(x.get("file"))
            if new is None:
                continue
            if new == x.get("file"):
                x.pop("supersededBy", None)  # the newest take (again, after a newer one was removed)
            else:
                x["supersededBy"] = new
        os.makedirs(os.path.dirname(p), exist_ok=True)
        write_json_atomic(p, {**doc, "$comment": "Finished clips in the clips folder and where each was posted (posted: "
                                                 "[{target, at, id}]). Written by clipper.py publish; read by the studio.",
                              "version": doc.get("version", 1), "files": files})

def is_replay_save(path):
    return bool(REPLAY_RE.match(os.path.basename(path))) and os.path.basename(os.path.dirname(path)).lower() == "replay"


def drop_used_saves(paths):
    """Deletes the given live-clipper replay saves (host-named, in a replay folder). Returns the deleted paths."""
    gone = []
    for p in sorted(set(paths)):
        if is_replay_save(p) and os.path.isfile(p):
            try:
                os.remove(p)
                gone.append(p)
            except OSError:
                pass
    return gone


# ---------------------------------------------------------------- tidy (older folders)

def _saves_rows(data_dir):
    rows = []
    root = os.path.join(data_dir, "live-clips") if data_dir else None
    if not root or not os.path.isdir(root):
        return rows
    for d in sorted(os.listdir(root)):
        p = os.path.join(root, d, "saves.jsonl")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                for line in f:
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        pass
    return rows


def _norm(p):
    return os.path.normcase(os.path.normpath(p))


def _run_dirs(root):
    """Run folders (with render.json or any analysis file) under a clips folder, the montage sub-runs included."""
    out = []
    for e in sorted(os.listdir(root)):
        d = os.path.join(root, e)
        if not os.path.isdir(d) or re.match(r"^\d{4}-\d{2}-\d{2}$", e):
            continue
        out.append(d)
    return out


def tidy_plan(recordings, clips, data_dir, game="game", layouts_by_id=None, det_weights=None):
    """Read-only plan: [{action, src, dst?, why}], action in move | rename | delete | keep | leave."""
    plan, used = [], set()
    saves = _saves_rows(data_dir)
    save_v = {}  # V basename -> (wall start, [H, V paths])
    for r in saves:
        fs = [f.get("path") for f in r.get("files") or [] if f.get("path")]
        v = next((f.get("path") for f in r.get("files") or [] if str(f.get("canvas", "")).upper() == "V"), None)
        try:
            at = datetime.fromisoformat(str(r.get("at")).replace("Z", "+00:00")).timestamp()
        except ValueError:
            at = None
        if v:
            save_v[os.path.basename(v).lower()] = ((at - float(r.get("startBack") or 0)) if at else None, fs)
    runs_root = os.path.join(data_dir, RUNS) if data_dir else None
    if clips and os.path.isdir(clips):
        for d in _run_dirs(clips):
            run = os.path.basename(d)
            subs = [d] + [os.path.join(d, s) for s in ("montage", "beatdrop") if os.path.isdir(os.path.join(d, s))]
            g = game
            dp = os.path.join(d, "detector-pass.json")
            if os.path.isfile(dp):
                try:
                    g = load_json(dp).get("game") or game
                except ClipError:
                    pass
            videos = set()
            counters = {}
            for sd in subs:
                rp = os.path.join(sd, "render.json")
                if not os.path.isfile(rp):
                    continue
                rdoc = load_json(rp)
                rep = os.path.join(sd, "report.json")
                passed = _passed(load_json(rep) if os.path.isfile(rep) else None)
                for c in rdoc.get("clips") or []:
                    if c.get("source") and c.get("wallStart") is None:
                        hit = save_v.get(str(c["source"]).lower())
                        if hit and hit[0] is not None:
                            c["wallStart"] = hit[0] + float(c.get("start") or 0.0)
                            used.update(_norm(x) for x in hit[1])
                for c, f, kind, when, label, canvas in name_rows(rdoc, g, layouts_by_id or {}, det_weights,
                                                                 _stamp_time(run)):
                    src = os.path.join(sd, "clips", c["id"], f["file"])
                    if not os.path.isfile(src):
                        continue
                    videos.add(_norm(src))
                    day = os.path.join(clips, names.day_folder(when))
                    nn = counters.get((kind, canvas), 0) + 1
                    taken = {_norm(a.get("dst", "")) for a in plan}
                    name, nn = names.free_name(lambda n: os.path.exists(os.path.join(day, n)) or
                                               _norm(os.path.join(day, n)) in taken,
                                               lambda n: names.clip_name(g, kind, when, label, n, canvas), nn)
                    counters[(kind, canvas)] = nn
                    ok = None if passed is None else passed.get((c["id"], f["file"]))
                    why = "finished clip, renamed by the convention" + (
                        "" if ok else " (not validated)" if ok is None else " (validation FAILED: check before posting)")
                    plan.append({"action": "rename", "src": src, "dst": os.path.join(day, name), "why": why})
            for base, _dirs, files in os.walk(d):
                for fn in files:
                    p = os.path.join(base, fn)
                    if _norm(p) in videos:
                        continue
                    rel = os.path.relpath(p, d)
                    dst = os.path.join(runs_root, run, rel) if runs_root else None
                    plan.append({"action": "move", "src": p, "dst": dst,
                                 "why": "analysis or working file: to the app data folder"})
        for e in sorted(os.listdir(clips)):
            p = os.path.join(clips, e)
            if os.path.isfile(p):
                plan.append({"action": "leave", "src": p, "why": "unknown file in the clips folder: left alone"})
    if recordings and os.path.isdir(recordings):
        for e in sorted(os.listdir(recordings)):
            p = os.path.join(recordings, e)
            if os.path.isfile(p):
                plan.append({"action": "keep" if RECORDING_RE.match(e) else "leave", "src": p,
                             "why": "full recording (<profile>-<h|v>-<YYYYMMDD-HHMMSS>)" if RECORDING_RE.match(e)
                             else "not a recording name: left alone"})
        rd = os.path.join(recordings, "replay")
        listed = {_norm(x) for r in saves for x in [f.get("path") for f in r.get("files") or []] if x}
        if os.path.isdir(rd):
            for e in sorted(os.listdir(rd)):
                p = os.path.join(rd, e)
                if not os.path.isfile(p):
                    continue
                n = _norm(p)
                if n in used and is_replay_save(p):
                    plan.append({"action": "delete", "src": p, "why": "live clipper save, already edited into clips"})
                elif n in listed:
                    plan.append({"action": "keep", "src": p,
                                 "why": "live clipper save not yet edited into clips (the full recording also has it)"})
                else:
                    plan.append({"action": "keep", "src": p, "why": "replay saved by hand (host name): kept"})
    return plan


def apply_plan(plan, clips=None):
    """Acts on a tidy plan: renames and moves never overwrite (an existing target is skipped); deletes only live
    clipper replay saves. Then removes run folders left empty under `clips`. Returns {done, skipped}."""
    done, skipped = [], []
    for a in plan:
        act, src, dst = a["action"], a["src"], a.get("dst")
        try:
            if act in ("rename", "move"):
                if not dst or os.path.exists(dst) or not os.path.isfile(src):
                    skipped.append({**a, "reason": "target exists or source gone"})
                    continue
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(src, dst)
            elif act == "delete":
                if not is_replay_save(src):
                    skipped.append({**a, "reason": "not a replay save"})
                    continue
                os.remove(src)
            else:
                continue
            done.append(a)
        except OSError as e:
            skipped.append({**a, "reason": str(e)[:200]})
    if clips and os.path.isdir(clips):
        for d in _run_dirs(clips):
            for base, _dirs, _files in sorted(os.walk(d), key=lambda x: -len(x[0])):
                try:
                    os.rmdir(base)  # only empty folders
                except OSError:
                    pass
    return {"done": done, "skipped": skipped}
