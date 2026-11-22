# SPDX-License-Identifier: GPL-3.0-or-later
"""FX1 clip look (plan docs/plan/2026-11-21-clip-music-name-transitions.md, D411): one seeded pick per reel of the music
mode, the transition set and the name style, from the user's ticks in <data>/settings.json clips.look.

Data: data/clip/look.json (options, ranges, defaults). services/studio-ui/user-settings.mjs checks clips.look with the
same rules as look_problems() here. Flag clip-look (on by default: the user asked for it).

Pick rules (settled "Pools" decision: weighted pick with a seeded RNG and no-repeat-last-N):
- a one-clip override (the "Make clips?" answer, env UJWALAM_CLIP_LOOK) wins: an option id, or "off";
- else a lock always uses its one choice;
- else no ticks = that part is off (None);
- else randomise off = the first tick;
- else a weighted pick among the ticks, seeded by the reel (seed parts) and the group, leaving out the group's last
  historyN picks while another tick is free.

  load_config(path=None)                     -> look.json
  look_problems(v, cfg)                      -> [] when clips.look v is fine
  effective(data_dir, cfg)                   -> the full look (defaults + the user's valid value)
  override_from_env(cfg, env=None)           -> {group: id|"off"} or {}
  pick(look, seed_parts, history, cfg, override=None) -> {"music", "transitions", "name", "variant", "seed"}
  load_history(data_dir) / remember(data_dir, picked, cfg, track=None)
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import random
import re

from clip_common import CLIP_DATA, SETTINGS_FILE, ClipError, flag_on, load_json, write_json_atomic

LOOK_FILE = os.path.join(CLIP_DATA, "look.json")
FLAG = "clip-look"
HISTORY_FILE = os.path.join("clips", "look-history.json")
ENV_OVERRIDE = "UJWALAM_CLIP_LOOK"
GROUPS = ("music", "transitions", "name")
KINETIC_VARIANTS = ("scale-punch", "slice-in")
_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")


def load_config(path=None):
    cfg = load_json(path or LOOK_FILE)
    for g in GROUPS:
        ids = [o["id"] for o in cfg["groups"][g]["options"]]
        if len(set(ids)) != len(ids) or any(float(o["weight"]) <= 0 for o in cfg["groups"][g]["options"]):
            raise ClipError(f"look.json: group {g} has a repeated id or a weight <= 0")
    if look_problems(cfg["defaults"], cfg):
        raise ClipError("look.json: the defaults break their own rules")
    return cfg


def on(data_dir):
    return flag_on(data_dir, FLAG)


def _ids(cfg, g):
    return [o["id"] for o in cfg["groups"][g]["options"]]


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _ticks(v, allowed, where):
    if not isinstance(v, list) or any(not isinstance(x, str) for x in v) or len(set(v)) != len(v) \
            or any(x not in allowed for x in v):
        return [f"{where} must be a list of {', '.join(allowed)} (each once)"]
    return []


def _range(v, r, where, integer=False):
    ok = _num(v) and r["min"] <= v <= r["max"] and (not integer or float(v).is_integer())
    return [] if ok else [f"{where} must be from {r['min']} to {r['max']}"]


def look_problems(v, cfg=None):
    """Problems with a clips.look value (any part may be left out; the rest keeps its default); [] when fine."""
    cfg = cfg or load_config()
    if not isinstance(v, dict):
        return ["clips.look must be an object"]
    out = []
    for k in v:
        if k not in ("randomise",) + GROUPS:
            out.append(f"unknown clips.look setting {k}")
    if "randomise" in v and not isinstance(v["randomise"], bool):
        out.append("clips.look.randomise must be true or false")
    keys = {"music": ("modes", "sources", "folder", "levelDb", "lock", "packOffered"),
            "transitions": ("styles", "sfx", "beatSync", "lock"),
            "name": ("styles", "position", "colour", "sizePct", "durationSec", "logo", "lock")}
    for g in GROUPS:
        if g not in v:
            continue
        gv, w = v[g], f"clips.look.{g}"
        if not isinstance(gv, dict):
            out.append(f"{w} must be an object")
            continue
        out += [f"unknown {w} setting {k}" for k in gv if k not in keys[g]]
        tk = cfg["groups"][g]["ticks"]
        if tk in gv:
            out += _ticks(gv[tk], _ids(cfg, g), f"{w}.{tk}")
        if "lock" in gv and gv["lock"] is not None and gv["lock"] not in _ids(cfg, g):
            out.append(f"{w}.lock must be empty or one of {', '.join(_ids(cfg, g))}")
        for b in ("sfx", "beatSync", "logo"):
            if b in gv and not isinstance(gv[b], bool):
                out.append(f"{w}.{b} must be true or false")
    m = v.get("music") if isinstance(v.get("music"), dict) else {}
    if "sources" in m:
        out += _ticks(m["sources"], [s["id"] for s in cfg["sources"]], "clips.look.music.sources")
    if "folder" in m and (not isinstance(m["folder"], str) or len(m["folder"]) > int(cfg["folderMaxChars"])
                          or re.search(r"[\x00-\x1f]", m["folder"])):
        out.append(f"clips.look.music.folder must be a folder path up to {cfg['folderMaxChars']} characters")
    if "levelDb" in m:
        out += _range(m["levelDb"], cfg["levelDb"], "clips.look.music.levelDb")
    if "packOffered" in m and not isinstance(m["packOffered"], bool):
        out.append("clips.look.music.packOffered must be true or false")
    n = v.get("name") if isinstance(v.get("name"), dict) else {}
    if "position" in n and n["position"] not in cfg["positions"]:
        out.append(f"clips.look.name.position must be one of {', '.join(cfg['positions'])}")
    if "colour" in n and not (n["colour"] == "theme" or (isinstance(n["colour"], str) and _HEX.match(n["colour"]))):
        out.append("clips.look.name.colour must be theme or a colour like #FF3B5C")
    if "sizePct" in n:
        out += _range(n["sizePct"], cfg["sizePct"], "clips.look.name.sizePct", integer=True)
    if "durationSec" in n:
        out += _range(n["durationSec"], cfg["durationSec"], "clips.look.name.durationSec")
    return out


def merge(cfg, v):
    """Defaults with a valid clips.look value laid over them, part by part."""
    out = copy.deepcopy(cfg["defaults"])
    if isinstance(v, dict) and not look_problems(v, cfg):
        if "randomise" in v:
            out["randomise"] = v["randomise"]
        for g in GROUPS:
            out[g].update(copy.deepcopy(v.get(g) or {}))
    return out


def effective(data_dir=None, cfg=None):
    cfg = cfg or load_config()
    v = None
    if data_dir:
        try:
            j = load_json(os.path.join(data_dir, SETTINGS_FILE))
            c = j.get("clips") if isinstance(j, dict) else None
            v = c.get("look") if isinstance(c, dict) else None
        except (OSError, ClipError):
            v = None
    return merge(cfg, migrate_pack(v, cfg))


def migrate_pack(v, cfg):
    """D427 one-time move (same rule as services/studio-ui/user-settings.mjs migrateLookPack): music sources saved
    before the free pack existed (no packOffered) get the pack added; packOffered true keeps the user's choice."""
    m = v.get("music") if isinstance(v, dict) else None
    if not isinstance(m, dict) or m.get("packOffered") is True or not isinstance(m.get("sources"), list):
        return v
    v = copy.deepcopy(v)
    v["music"]["sources"] = [s["id"] for s in cfg["sources"] if s["id"] == "pack" or s["id"] in m["sources"]]
    v["music"]["packOffered"] = True
    return v


def override_from_env(cfg=None, env=None):
    """The one-clip choice from the "Make clips?" answer: {group: option id or "off"}; anything else is left out."""
    cfg = cfg or load_config()
    raw = (env if env is not None else os.environ).get(ENV_OVERRIDE)
    if not raw:
        return {}
    try:
        j = json.loads(raw)
    except ValueError:
        return {}
    if not isinstance(j, dict):
        return {}
    return {g: j[g] for g in GROUPS if j.get(g) == "off" or j.get(g) in _ids(cfg, g)}


def _rng(seed_parts, group):
    h = hashlib.sha256("|".join([*(str(p) for p in seed_parts), group]).encode("utf-8")).digest()
    return random.Random(int.from_bytes(h[:8], "little"))


def weighted_pick(rng, items, weights, avoid=()):
    """Seeded weighted pick; items in `avoid` are left out while another item is free."""
    free = [(i, w) for i, w in zip(items, weights) if i not in avoid] or list(zip(items, weights))
    x = rng.random() * sum(w for _, w in free)
    acc = 0.0
    for i, w in free:
        acc += w
        if x < acc:
            return i
    return free[-1][0]


def _choose(look, cfg, g, seed_parts, history, override):
    o = override.get(g)
    if o == "off":
        return None
    if o:
        return o
    gv = look[g]
    if gv.get("lock"):
        return gv["lock"]
    ticks = gv.get(cfg["groups"][g]["ticks"]) or []
    if not ticks:
        return None
    if not look.get("randomise", True):
        return ticks[0]
    weights = {o["id"]: float(o["weight"]) for o in cfg["groups"][g]["options"]}
    n = int(cfg["historyN"][g])
    recent = (history.get(g) or [])[-n:] if n > 0 else []
    return weighted_pick(_rng(seed_parts, g), ticks, [weights[t] for t in ticks], recent)


def pick(look, seed_parts, history=None, cfg=None, override=None):
    """This reel's look: {"music": mode|None, "transitions": style|None, "name": style|None, "variant", "seed"}."""
    cfg = cfg or load_config()
    history = history or {}
    override = override or {}
    out = {g: _choose(look, cfg, g, seed_parts, history, override) for g in GROUPS}
    out["variant"] = _rng(seed_parts, "variant").choice(KINETIC_VARIANTS)
    out["seed"] = int.from_bytes(hashlib.sha256("|".join(str(p) for p in seed_parts).encode("utf-8")).digest()[:4], "big")
    return out


def load_history(data_dir):
    if not data_dir:
        return {}
    try:
        j = load_json(os.path.join(data_dir, HISTORY_FILE))
    except (OSError, ClipError):
        return {}
    return {k: [x for x in v if isinstance(x, str)] for k, v in j.items() if isinstance(v, list)} if isinstance(j, dict) else {}


def remember(data_dir, picked, cfg=None, track=None, history=None):
    """Adds this reel's picks to the history (kept to historyKeep per group) and saves it. -> the new history."""
    cfg = cfg or load_config()
    h = dict(history if history is not None else load_history(data_dir))
    keep = int(cfg["historyKeep"])
    for g in GROUPS:
        if picked.get(g):
            h[g] = (h.get(g) or [])[-(keep - 1):] + [picked[g]]
    if track:
        h["track"] = (h.get("track") or [])[-(keep - 1):] + [track]
    if data_dir:
        try:
            os.makedirs(os.path.join(data_dir, "clips"), exist_ok=True)
            write_json_atomic(os.path.join(data_dir, HISTORY_FILE), h)
        except (OSError, ClipError):
            pass
    return h
