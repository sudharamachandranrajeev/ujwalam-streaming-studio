# SPDX-License-Identifier: GPL-3.0-or-later
"""One versioned theme per long render. Sound comes from the local scene-music generator."""

from __future__ import annotations

import os
import re
import tempfile
import wave
from contextlib import contextmanager

from clip_common import CLIP_DATA, ClipError, flag_on, load_json, on_air
from reel_music import seed_for

FLAG = "long-video-themes"
THEME_MOODS_DIR = os.path.join(CLIP_DATA, "themes", "moods")  # theme-only songs, kept out of the scene-music library


def pick(cfg, recording_name):
    """The theme id for this recording. cfg "theme" is one id or a list (user 2026-11-22: one theme per long video);
    a list is picked from by a seed of the recording's name, so a re-render keeps its theme."""
    ids = cfg["theme"] if isinstance(cfg["theme"], list) else [cfg["theme"]]
    if not ids or not all(isinstance(i, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,47}", i) for i in ids):
        raise ClipError("invalid long video theme id")
    return ids[seed_for("long-video-theme", recording_name) % len(ids)]


def _mood(mood_id):
    """A theme's song settings: its own mood (data/clip/themes/moods) first, else a scene-music mood. Validated."""
    import scene_music as sm  # noqa: PLC0415
    own = os.path.join(THEME_MOODS_DIR, mood_id + ".json")
    m = sm.validate_manifest(load_json(own if os.path.isfile(own) else os.path.join(sm.MOODS_DIR, mood_id + ".json")))
    if m["id"] != mood_id:
        raise ClipError(f"mood file {mood_id}.json holds {m['id']}")
    return m


def active(data_dir, cfg, recording_name=""):
    if not flag_on(data_dir, FLAG):
        return None
    theme_id = pick(cfg, recording_name)
    theme = load_json(os.path.join(CLIP_DATA, "themes", theme_id + ".json"))
    tr, music = theme["transition"], theme["music"]
    if (theme["id"] != theme_id or not all(re.fullmatch(r"#[0-9a-fA-F]{6}", v) for v in theme["palette"].values())
            or tr["xfade"] not in ("fade", "slideleft", "slideright", "smoothleft", "smoothright")
            or not 0 < tr["ms"] < 600 or not 0 <= theme["padSec"] <= 10
            or not all(-1 <= v <= 1 for v in theme["grade"].values())
            or not re.fullmatch(r"[a-z][a-z0-9-]{0,47}", music["mood"])
            or not 1 <= music["bars"] <= 16 or not -40 <= music["targetLufs"] <= -24
            or not 6 <= music["underGameDb"] <= 24):
        raise ClipError("invalid long video theme colour, timing or music settings")
    return theme


@contextmanager
def soundtrack(theme, recording_name, folder, attempt_prefix):
    """Generate one short seamless loop, shared by every probe and render batch, removed even on a failed render."""
    if theme is None:
        yield None, None
        return
    if on_air() is not False:
        raise ClipError("the theme soundtrack needs a confirmed off-air studio")
    import scene_music as sm  # numpy is loaded only while generating a themed video
    cfg = theme["music"]
    mood = _mood(cfg["mood"])
    mood = dict(mood, loudness=dict(mood["loudness"], targetLufs=cfg["targetLufs"]))
    seed = seed_for(theme["id"], theme["version"], recording_name)
    with tempfile.TemporaryDirectory(dir=folder, prefix=attempt_prefix) as work:
        path = os.path.abspath(os.path.join(work, "soundtrack.wav"))
        rec = sm.generate(mood, seed, path=path, bars=cfg["bars"])
        with wave.open(path, "rb") as wav:
            loop_frames = wav.getnframes()
        yield {"file": path, "loopFrames": loop_frames, "duck": cfg["duck"]}, dict(rec, source="made-here")


def balance(music_cfg, record, parts, run, cwd):
    """Keep the loop under even a quiet recording. A failed measurement retains the theme's conservative level."""
    import clip_loudness as loud  # noqa: PLC0415
    from music_library import target_lufs  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    try:
        game = loud.measure_parts([(builder(None), sec) for builder, sec in parts], run, cwd)
    except (OSError, subprocess.TimeoutExpired):
        game = None
    target = target_lufs(music_cfg["targetLufs"], game, music_cfg["underGameDb"])
    gain = min(0.0, target - record["lufs"])
    record.update(gameLufs=game, underGameDb=music_cfg["underGameDb"], mixTargetLufs=target, bedGainDb=round(gain, 2))
    return gain
