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

import json
import os
import re
import shutil
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
    {"source": "ncs", "trackId", "credit"} (the NCS library: posted with its credit), {"source": "unknown"} (a record
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
        prev = [r for r in (load_json(prev_path).get("files") or []) if os.path.isfile(r.get("file", ""))]             if os.path.isfile(prev_path) else []
    except ClipError:
        prev = []
    done = {(r.get("id"), r.get("layout")): r for r in prev}
    rows, counters = [], {}
    tool = rdoc.get("tool") or ""
    for c, f, kind, when, label, canvas in name_rows(rdoc, game, layouts_by_id, det_weights, rec_start_local):
        if not passed.get((c["id"], f["file"])):
            continue
        src = os.path.join(work, "clips", c["id"], f["file"])
        if not os.path.isfile(src):
            continue
        old = done.get((c["id"], f["layout"]))
        if old is not None:
            # BD7c: a BeatDrop retake is a new render (new file name) under the same id and layout. Not yet posted: it
            # replaces the published copy in place (as recaption does). Already posted: it is published as a new video.
            # Codex BD7c verify: a row without a source (written before BD7c) is the same render; replaced only when its
            # uploads row is found, not posted and not being uploaded right now; anything unknown gets a new file.
            if tool != "clipper.beatdrop" or old.get("source") in (None, f["file"]):
                continue
            up = upload_row(data_dir, old["file"])
            if up is not None and not up.get("posted") and not _uploading(data_dir, old["file"]):
                _replace_published(old, src, c, label, rdoc, data_dir)
                continue
        day = os.path.join(to, names.day_folder(when))
        os.makedirs(day, exist_ok=True)
        start_nn = counters.get((kind, canvas), 0) + 1
        name, nn = names.free_name(lambda n: os.path.exists(os.path.join(day, n)),
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
    write_json_atomic(prev_path, {"tool": "clipper.publish", "to": to, "files": prev + rows})  # prev rows updated in place
    if data_dir and rows:
        add_uploads(data_dir, [{**{k: r[k] for k in ("file", "kind", "label", "seconds")}, "run": run,
                                "recording": rdoc.get("recording"), "posted": [], "game": game,
                                **({"facts": r["facts"]} if r.get("facts") else {}),
                                **({"thumbnail": True} if r.get("thumbnail") else {}),
                                **({"music": r["music"]} if r.get("music") else {}),
                                **({"video": r["video"]} if r.get("video") else {}),
                                **({"choices": r["choices"]} if r.get("choices") else {})} for r in rows])
    return rows


def upload_row(data_dir, file):
    """The uploads.json row of a published file, or None (no data folder, no list, or not in it)."""
    p = os.path.join(data_dir, UPLOADS) if data_dir else None
    try:
        doc = load_json(p) if p and os.path.isfile(p) else {}
    except ClipError:
        return None
    return next((x for x in doc.get("files") or [] if isinstance(x, dict) and x.get("file") == file), None)


UPLOAD_QUEUE = os.path.join("posting", "upload-queue.json")  # services/posting/auto-chain.mjs QUEUE_NAME
POST_LEDGER = os.path.join("posting", "ledger.json")  # services/posting/index.mjs LEDGER_NAME


def _uploading(data_dir, file):
    """True when posting may have sent this file's bytes: an upload-queue item of them uploading, done or holding a
    resumable session, or a ledger entry of them marked uploaded (uploads.json can lag behind both after a crash).
    Anything that cannot be told (unreadable file, a queue or ledger of the wrong shape) counts as sent: never replaced."""
    try:
        h = hashlib.sha256()
        with open(file, "rb") as fh:
            for block in iter(lambda: fh.read(1 << 20), b""):
                h.update(block)
    except OSError:
        return True
    sha = h.hexdigest()
    for rel, field in ((UPLOAD_QUEUE, "items"), (POST_LEDGER, "entries")):
        p = os.path.join(data_dir, rel)
        if not os.path.isfile(p):
            continue
        try:
            doc = load_json(p)
        except ClipError:
            return True
        rows = doc.get(field) if isinstance(doc, dict) else None
        if not isinstance(rows, dict):
            return True
        for it in rows.values():
            if not isinstance(it, dict):
                return True
            if field == "items" and str(it.get("id", "")).startswith(sha[:16] + ".") \
                    and (it.get("state") in ("uploading", "done") or it.get("session")):  # postId: <sha 16>.<target>
                return True
            if field == "entries" and it.get("sha256") == sha and it.get("status") == "uploaded":
                return True
    return False


def _replace_published(old, src, c, label, rdoc, data_dir):
    """BD7c: the published copy `old` (a published.json row, updated in place) gets the bytes of `src`, a new music
    sidecar and video binding; its uploads.json row (when there is one) gets the new record, length, label and facts."""
    tmp = old["file"] + ".part"
    try:
        os.remove(tmp)
    except OSError:
        pass
    _link_or_copy(src, tmp)
    os.replace(tmp, old["file"])
    prov = music_provenance(c, bool(rdoc.get("musicRecords")))
    try:
        os.remove(old["file"] + MUSIC_SIDECAR)  # never a sidecar of the earlier render next to the new bytes
    except OSError:
        pass
    write_music_sidecar(old["file"], prov)
    try:
        vbind = video_binding(old["file"])
    except OSError:
        vbind = None
    fields = {"label": label, "seconds": round(float(c["end"]) - float(c["start"]), 3), "music": prov, "video": vbind,
              "facts": rt.facts(c) or None}
    old.update(source=os.path.basename(src), **{k: v for k, v in fields.items() if v is not None})
    for k in [k for k, v in fields.items() if v is None]:
        old.pop(k, None)
    p = os.path.join(data_dir, UPLOADS) if data_dir else None
    if not p or not os.path.isfile(p):
        return
    try:
        doc = load_json(p)
    except ClipError:
        return
    for x in doc.get("files") or []:
        if isinstance(x, dict) and x.get("file") == old["file"]:
            x.update({k: v for k, v in fields.items() if v is not None})
            for k in [k for k, v in fields.items() if v is None]:
                x.pop(k, None)  # a missing record is unknown to posting (held): never the earlier render's record
    write_json_atomic(p, doc)


def add_uploads(data_dir, rows):
    p = os.path.join(data_dir, UPLOADS)
    try:
        doc = load_json(p) if os.path.isfile(p) else {}
    except ClipError:
        doc = {}
    files = [x for x in doc.get("files") or [] if isinstance(x, dict)]
    have = {x.get("file") for x in files}
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    files += [{**r, "addedAt": now} for r in rows if r["file"] not in have]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    write_json_atomic(p, {"$comment": "Finished clips in the clips folder and where each was posted (posted: "
                                      "[{target, at, id}]). Written by clipper.py publish; read by the studio.",
                          "version": 1, "files": files})


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
