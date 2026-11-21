# SPDX-License-Identifier: GPL-3.0-or-later
"""Montage music: the user's NCS library (D413 item 2, D414; settings data/clip/montage-music.json).

- folder_problem(folder): the folder must be a real folder on this PC's own fixed drive, reached with no link (the
  reel-style example rule, reel_style.local_file_problem, for a folder);
- scan(data_dir, folder): every track in the folder gets a credit record (artist, title, the NCS line, link) read from
  its tags, else from an "Artist - Title [NCS Release]" file name; a record the user edited is kept as edited;
- set_credit(data_dir, track_id, credit): the user's edit (checked: plain text, length limits);
- pick(data_dir, folder, settings, seed_parts): random (seeded, none of the last avoidLast) or the fixed track;
- montage_row(track): what a montage's clip row carries for posting: {"library": "ncs", "trackId", "credit"} (the
  description gets the credit; no credit = never sent), or {"library": None} for a track from anywhere else (render
  only, never auto-posted);
- credit_text(credit): the description lines (same template as services/posting/post-text.mjs musicCredit).

CLI (the studio, services/studio-ui/montage-music.mjs): montage_music.py list|credit --data-dir D [--json BODY]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import stat
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from clip_common import CLIP_DATA, ClipError, eprint, load_json, write_json_atomic  # noqa: E402
import music_library as ml  # noqa: E402

CONFIG_FILE = os.path.join(CLIP_DATA, "montage-music.json")
ID = re.compile(r"^[0-9a-f]{16}$")
CONTROL = re.compile(r"[\x00-\x1f\x7f<>{}]")
NAME = re.compile(r"^(?P<artist>.+?)\s+-\s+(?P<title>.+?)\s*(?:\[(?P<tag>[^\]]*)\])?\s*$")


def load_config(path=None):
    return load_json(path or CONFIG_FILE)


def folder_problem(folder, drive_type=None):
    """None when folder is a real folder on a local fixed drive with no link on the way; else why not, in plain words."""
    import reel_style as rs  # noqa: PLC0415 - the same drive rule as the reel-style examples
    drive_type = drive_type or rs._drive_type  # noqa: SLF001
    if not isinstance(folder, str) or not folder.strip() or re.search(r"[\x00-\x1f]", folder):
        return "give the full path of your music folder"
    q = folder.replace("/", "\\") if os.name == "nt" else folder
    if q.startswith("\\\\"):
        return "network and device paths are not allowed; use a folder on this PC's own drive"
    if not os.path.isabs(folder):
        return "give the full path of your music folder"
    try:
        st = os.lstat(folder)
    except OSError:
        return "folder not found"
    if stat.S_ISLNK(st.st_mode) or getattr(st, "st_file_attributes", 0) & ml.REPARSE:
        return "links are not followed; use the folder itself"
    if not stat.S_ISDIR(st.st_mode):
        return "not a folder"
    real = os.path.realpath(folder)
    if os.path.normcase(real).rstrip("\\/") != os.path.normcase(os.path.abspath(folder)).rstrip("\\/"):
        return "the path goes through a link or junction; use the folder itself"
    drive = os.path.splitdrive(real)[0]
    if os.name == "nt" and not (len(drive) == 2 and drive[1] == ":"):
        return "not on a drive letter of this PC"
    if drive_type((drive or "/") + ("\\" if os.name == "nt" else "")) != rs._DRIVE_FIXED:  # noqa: SLF001
        return "not on this PC's own fixed drive (network, removable or virtual drives are not used)"
    return None


def _id(name):
    return hashlib.sha256(name.lower().encode("utf-8")).hexdigest()[:16]  # by file name: survives a copy to a new disk


def _clean(v, n):
    if not isinstance(v, str):
        return ""
    v = re.sub(r"\s+", " ", CONTROL.sub(" ", v)).strip()
    return v[:n]


def credit_problems(c, cfg=None):
    cfg = cfg or load_config()
    mx = cfg["credit"]["maxChars"]
    if not isinstance(c, dict):
        return ["the credit must be an object"]
    out = [f"unknown credit part {k}" for k in c if k not in mx]
    for k in ("artist", "title"):
        if not isinstance(c.get(k), str) or not c[k].strip():
            out.append(f"the {k} is missing")
    for k, n in mx.items():
        v = c.get(k, "")
        if not isinstance(v, str) or len(v) > n or CONTROL.search(v):
            out.append(f"the {k} is plain text of at most {n} characters, without < > {{ }}")
    link = c.get("link", "")
    if isinstance(link, str) and link and not re.match(r"^https://[A-Za-z0-9.-]+(/[^\s]*)?$", link):
        out.append("the link must start with https://")
    return out


def complete(c, cfg=None):
    return isinstance(c, dict) and not credit_problems({k: c.get(k, "") for k in ("artist", "title", "line", "link")}, cfg)


def credit_text(c, cfg=None):
    cfg = cfg or load_config()
    lines = [s.format(**{k: c.get(k, "") for k in ("artist", "title", "line", "link")}) for s in cfg["credit"]["template"]]
    return "\n".join(s for s in lines if s.strip())


def from_name(stem, cfg):
    m = NAME.match(stem)
    if not m:
        return None
    return {"artist": m.group("artist").strip(), "title": m.group("title").strip(),
            "ncsTagged": bool(m.group("tag") and cfg["credit"]["nameTag"].lower() in m.group("tag").lower())}


def read_tags(path):
    import av  # noqa: PLC0415
    try:
        with av.open(path) as c:
            md = {str(k).lower(): str(v) for k, v in (c.metadata or {}).items()}
            for s in c.streams:
                for k, v in (s.metadata or {}).items():
                    md.setdefault(str(k).lower(), str(v))
            return md
    except (av.error.FFmpegError, OSError, UnicodeError):
        return {}


def _save(path, doc):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_json_atomic(path, doc)


def _credits_path(data_dir, cfg):
    return os.path.join(data_dir, *cfg["credits"].split("/"))


def load_credits(data_dir, cfg=None):
    cfg = cfg or load_config()
    try:
        j = load_json(_credits_path(data_dir, cfg))
    except (ClipError, OSError, ValueError):
        return {"version": 1, "tracks": {}}
    if not isinstance(j, dict) or not isinstance(j.get("tracks"), dict):
        return {"version": 1, "tracks": {}}
    return j


def list_files(folder, cfg):
    out = []
    for name in sorted(os.listdir(folder)):
        p = os.path.join(folder, name)
        if os.path.splitext(name)[1].lower() in cfg["extensions"] and ml.inside(p, folder):
            out.append(p)
        if len(out) >= int(cfg["maxFiles"]):
            break
    return out


def scan(data_dir, folder, cfg=None, tags=None):
    """-> the credits document, updated for the folder's tracks (and saved). Edited records are never overwritten."""
    cfg = cfg or load_config()
    tags = tags or read_tags
    bad = folder_problem(folder)
    if bad:
        raise ClipError(f"montage music folder: {bad}")
    doc = load_credits(data_dir, cfg)
    old = doc["tracks"]
    mx = cfg["credit"]["maxChars"]
    new = {}
    for p in list_files(folder, cfg):
        name = os.path.basename(p)
        tid = _id(name)
        if tid in old and old[tid].get("edited"):
            new[tid] = dict(old[tid], file=name)
            continue
        md = tags(p)
        artist, title = _clean(md.get("artist", ""), mx["artist"]), _clean(md.get("title", ""), mx["title"])
        source = "tags"
        fn = from_name(os.path.splitext(name)[0], cfg)
        if not (artist and title) and fn:
            artist, title, source = _clean(fn["artist"], mx["artist"]), _clean(fn["title"], mx["title"]), "file name"
        elif not (artist and title):
            source = "none"
        new[tid] = {"file": name, "artist": artist, "title": title, "line": cfg["credit"]["line"], "link": "",
                    "source": source, "edited": False}
    for tid, r in old.items():  # an edited record of a file that left the folder is kept (the user typed it)
        if tid not in new and r.get("edited"):
            new[tid] = dict(r, missing=True)
    doc = {"version": 1, "folder": os.path.abspath(folder), "tracks": new}
    _save(_credits_path(data_dir, cfg), doc)
    return doc


def set_credit(data_dir, track_id, credit, cfg=None):
    cfg = cfg or load_config()
    if not isinstance(track_id, str) or not ID.match(track_id):
        raise ClipError("unknown track")
    probs = credit_problems(credit, cfg)
    if probs:
        raise ClipError("; ".join(probs))
    doc = load_credits(data_dir, cfg)
    if track_id not in doc["tracks"]:
        raise ClipError("unknown track (look at the folder again)")
    r = doc["tracks"][track_id]
    r.update({k: credit.get(k, "").strip() for k in ("artist", "title", "line", "link")}, source="edited", edited=True)
    _save(_credits_path(data_dir, cfg), doc)
    return r


def view(doc, cfg=None):
    cfg = cfg or load_config()
    rows = []
    for tid, r in sorted(doc["tracks"].items(), key=lambda kv: kv[1].get("file", "")):
        rows.append({"id": tid, "file": r.get("file", ""), "artist": r.get("artist", ""), "title": r.get("title", ""),
                     "line": r.get("line", ""), "link": r.get("link", ""), "source": r.get("source", ""),
                     "edited": bool(r.get("edited")), "missing": bool(r.get("missing")), "complete": complete(r, cfg)})
    return rows


def pick(data_dir, folder, settings, seed_parts, cfg=None):
    """The montage's track: {"id", "path", "credit"} or None (switch off, no folder, no usable track). Random: seeded,
    none of the last avoidLast picks while another is free; fixed: that track only. History is saved."""
    cfg = cfg or load_config()
    s = dict(cfg["defaults"], **(settings or {}))
    if not s.get("on") or not s.get("folder"):
        return None
    doc = scan(data_dir, folder, cfg)
    tracks = {tid: r for tid, r in doc["tracks"].items() if not r.get("missing")}
    if not tracks:
        return None
    hist_path = os.path.join(data_dir, *cfg["history"].split("/"))
    try:
        hist = [x for x in load_json(hist_path).get("recent", []) if isinstance(x, str)]
    except (ClipError, OSError, ValueError, AttributeError):
        hist = []
    if s.get("mode") == "fixed":
        tid = s.get("fixedTrack")
        if tid not in tracks:
            return None
    else:
        n = max(0, min(int(cfg["avoidLast"]["max"]), int(s.get("avoidLast", cfg["avoidLast"]["default"]))))
        avoid = set(hist[-n:]) if n else set()
        ids = sorted(tracks)
        free = [t for t in ids if t not in avoid] or ids
        rng = random.Random(int.from_bytes(hashlib.sha256("|".join(map(str, [*seed_parts, "montage-track"])).encode()).digest()[:8], "little"))
        tid = free[int(rng.random() * len(free))]
    _save(hist_path, {"version": 1, "recent": (hist + [tid])[-50:]})
    r = tracks[tid]
    return {"id": tid, "path": os.path.join(folder, r["file"]),
            "credit": {k: r.get(k, "") for k in ("artist", "title", "line", "link")}}


def montage_row(track, cfg=None):
    """What the montage's clip row carries for posting (services/posting/index.mjs)."""
    cfg = cfg or load_config()
    if not track:
        return {"library": None}
    c = track.get("credit")
    return {"library": cfg["library"], "trackId": track["id"], "credit": c if complete(c, cfg) else None}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Montage music (NCS library)")
    ap.add_argument("op", choices=["list", "credit"])
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--json", default="{}")
    a = ap.parse_args(argv)
    try:
        b = json.loads(a.json)
        if not isinstance(b, dict):
            raise ClipError("bad request")
        cfg = load_config()
        if a.op == "list":
            folder = b.get("folder") or ""
            if not folder:
                print(json.dumps({"tracks": view(load_credits(a.data_dir, cfg), cfg), "folderProblem": None, "folder": ""}))
                return 0
            bad = folder_problem(folder)
            if bad:
                print(json.dumps({"tracks": [], "folderProblem": bad, "folder": folder}))
                return 0
            print(json.dumps({"tracks": view(scan(a.data_dir, folder, cfg), cfg), "folderProblem": None, "folder": folder}))
            return 0
        r = set_credit(a.data_dir, b.get("id"), b.get("credit"), cfg)
        print(json.dumps({"ok": True, "complete": complete(r, cfg)}))
        return 0
    except (ClipError, ValueError) as e:
        eprint(f"montage music: {e}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
