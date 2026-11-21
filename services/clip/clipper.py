# SPDX-License-Identifier: GPL-3.0-or-later
"""F6 post-stream clipper (docs/plan/2026-11-03-f6-clip-pipeline-plan.md). Behind the feature flag `clip-pipeline`
(data/flags.json, off by default): every subcommand exits 3 while the flag is off in the data dir.

  detect      --recording FILE --out DIR [--game codm] [--detector-config F] [--profile F] [--layout F | --project F] [--fps F]
              [--threads 1-4]
              -> DIR/detector-hits.jsonl + DIR/detector-pass.json: the game pack's detectors over the H recording
              (OCR venv; sample rate from data/clip/detector-pass.json; one heavy job at a time)
  candidates  --recording FILE [--markers FILE ...] [--chat-db event-core.db] [--hits FILE] [--record-start ISO]
              [--no-audio] --out DIR
              -> DIR/candidates.json (times, scores, reasons, detectorHits; no chat text, no marker notes, no names)
              Without --hits, DIR/detector-hits.jsonl from `detect` on the same recording is used. Detector hits
              weigh 0 until ranking.json detectorWeightsStatus is "approved": listed and attached, never ranked.
  render      --recording FILE --out DIR [--v-recording FILE] [--layouts a,b,c] [--only c01,c02] [--encoder auto|libopenh264|h264_nvenc]
              [--captions none|whisper-cli|faster-whisper] [--whisper-bin F --whisper-model F] [--language xx]
              -> DIR/clips/<id>/<layout>.mp4 (+ captions.ass), DIR/render.json
  gate        --recording FILE --out DIR [--hits F]
              -> DIR/matches.json: the recording split into matches by their end screens, each kept or skipped by
              settings.json clips.matchGate (match_gate.py, D286 proposed); candidates.json keeps the passing
              candidates and moves the others to `gatedOut`. Uses DIR/detector-hits.jsonl and DIR/match-stats.json
              from `detect`; without them every candidate is kept.
  validate    --out DIR [--no-decode]  -> DIR/report.json; exit 4 when any file fails
  run         [--detect] candidates + gate + render + validate with the same options (--detect runs `detect` first)
              [--montage] then `montage` into DIR/montage; [--publish CLIPS] then `publish` (both run folders)
  montage     --recording FILE --out DIR [--v-recording F] [--hits F] [--montage-config F] [--publish CLIPS]
              -> DIR/montage/clips/<id>/montage-v.mp4 + render.json + candidates.json + report.json (validated):
              every own kill, streaks first (clip_montage.py, D298 proposed), plus match reels for the matches that
              pass the pack's match-reels.json rules (D315); why each match did or did not: DIR/montage/match-reels.json
  publish     --out DIR --to CLIPS  -> each PASS video of DIR linked into CLIPS/<YYYY-MM-DD>/<convention>.mp4
              (clip_names.py), DIR/published.json, <data>/clips/uploads.json. --out is the run folder in app data;
              the clips folder gets finished videos only.
  tidy        --recordings DIR --clips DIR [--dry-run | --apply]  -> lists (default) or does the moves that bring
              older folders to the layout: analysis files to <data>/clips/runs/<run>/, finished clips renamed by the
              convention, the live clipper's used replay saves deleted. Never overwrites; --apply is required to act.
  live-review --saves DIR --out DIR [--layouts ...] [--encoder ...] [--matches FILE | --recording FILE [detect options]]
              -> DIR/clips/<id>/<layout>.mp4 + DIR/render.json from the live clipper's replay saves
              (DIR/saves.jsonl, live_worker.py); overlapping saves are merged; then `validate --out DIR`.
              --matches: matches.json of the same session's recording; saves inside skipped matches are dropped.
              --recording (D304 proposed, the studio's "while" clips): the H recording of the same stream; when the
              window has saves and the match gate is on, `detect` runs on it (unless DIR already holds its hits) and
              its matches are written to DIR/matches.json and applied like --matches. When detection cannot run, every
              save is kept and render.json matchGate says why.
              [--publish CLIPS] validate + publish; [--drop-used-saves] then delete the replay saves of the window
              (host-named live clipper intermediates) when every clip rendered.
              [--montage [--v-recording F] [--montage-config F]] (D322 proposed): with --recording, after the short
              clips are published (and the used saves dropped), the same work as `montage` (kill montages + match
              reels) into DIR/montage, validated and published with --publish. It needs detector hits of the
              recording (`detect` runs when DIR has none and it has not already run) and the V recording. A montage
              that cannot be made never undoes the short clips: live-review still exits as it would without
              --montage; the log says "montage: NOT MADE (...)" and render.json `montage` holds the status
              (made | failed | skipped) and the reason.

Progress (stderr, one per line, for the studio): ujwalam-progress {"stage":"<detect|candidates|render|validate|review|
gate|publish|montage>","done":<int>,"total":<int>,"note":"<short plain text, no names>"} (clip_common.progress_line). The detector
pass writes one at least every 2 s; render and live-review one per clip.

Common: [--data-dir DIR] (flags.local.json; default paths.event_core_data from data/profile.local.json)
        [--ffmpeg F] [--ffprobe F] [--ranking F] [--layouts-file F] [--targets F]

Inputs are only read (the recording is an ffmpeg input; the chat db is opened read-only). --out must be outside the
repository or gitignored, and never inside the clips corpus. One render at a time; children run at below-normal
priority with 4 threads. Run isolated: python -I services/clip/clipper.py ...
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import clip_captions as caps  # noqa: E402
import clip_look as look  # noqa: E402
import clip_publish as pub  # noqa: E402
import clip_rank as rank  # noqa: E402
import clip_render as rnd  # noqa: E402
import reel_captions as rcap  # noqa: E402
import reel_hook as rh  # noqa: E402
import reel_length as rl  # noqa: E402
import reel_thumbnail as rth  # noqa: E402
import reel_title as rti  # noqa: E402
import reel_music as rmu  # noqa: E402
import reel_sfx as rsfx  # noqa: E402
import reel_style as rstyle  # noqa: E402
import reel_transition as rt  # noqa: E402
import clip_signals as sig  # noqa: E402
import clip_validate as val  # noqa: E402
import game_pack  # noqa: E402
import learning_capture as lcap  # noqa: E402
import learning_mix as lmix  # noqa: E402
import match_gate as mg  # noqa: E402
import music_library as mlib  # noqa: E402
from clip_common import (  # noqa: E402
    CLIP_DATA, EXIT_FLAG_OFF, FLAG, PROFILE_FILE, ClipError, check_out_dir, clips_allowed, contain_children, corpus_dir, end_tree_when_parent_gone, eprint, find_tool, flag_on, load_config,
    load_json, lower_own_priority, match_gate_settings, media_info, on_air, progress_line, resolve_data_dir, run_tool,
    write_json_atomic,
)

TOOL_VERSION = 1
CANDIDATES = "candidates.json"
RENDER = "render.json"
REPORT = "report.json"
MATCH_REELS = "match-reels.json"  # montage/: why each match got a reel or not (D315)


def _tools(a):
    return find_tool("ffmpeg", a.ffmpeg), find_tool("ffprobe", a.ffprobe)


def _same_recording(a, doc):
    if os.path.basename(a.recording) != doc.get("recording"):
        raise ClipError("--recording does not match the recording named in candidates.json")


# ---------------------------------------------------------------- candidates

def cmd_candidates(a):
    progress_line("candidates", 0, 1, "reading markers, chat, audio and detector hits")
    ffmpeg, ffprobe = _tools(a)
    cfg = load_config("ranking", a.ranking)
    sl = rl.effective_limits(resolve_data_dir(a.data_dir))["short"]  # CL1 (D350): the user's short-clip length
    cfg = dict(cfg, clip=dict(cfg["clip"], minSec=sl["minSec"], maxSec=sl["maxSec"]))
    if not os.path.isfile(a.recording):
        raise ClipError("recording not found")
    info = media_info(ffprobe, a.recording)
    dur = info["duration"]
    if dur <= 0:
        raise ClipError("recording has no duration")
    start = sig.recording_start(a.recording, a.record_start)
    markers, mstats = sig.read_markers(a.markers, start, dur)
    counts, intents, cstats = sig.read_chat(a.chat_db, start, dur, cfg["chat"]["intentPattern"])
    if a.no_audio or not info["has_audio"]:
        lufs, astats = None, {"available": False, "reason": "skipped" if a.no_audio else "no audio stream"}
    else:
        lufs, astats = sig.audio_loudness(ffmpeg, a.recording, dur, float(cfg["audio"]["floorLufs"]))
    hits_path = a.hits or _own_hits(a)
    hits, hstats = sig.read_hits(hits_path, dur)
    approved = cfg.get("detectorWeightsStatus") == "approved"
    w = cfg["weights"]
    gap = int(cfg["peaks"]["minGapSec"])
    events = rank.marker_events(markers, w)
    events += rank.chat_events(counts if a.chat_db else None, intents, {**cfg["chat"], "minGapSec": gap}, w)
    aev, abase = rank.loudness_events(lufs, cfg["audio"], w, gap)
    events += aev
    dev = rank.detector_events(hits, cfg.get("detectorWeights", {}), approved)
    events += dev
    deaths = rank.death_spans(hits, cfg)
    cands = rank.build_candidates(events, dur, cfg, deaths)
    if hstats is not None:
        hstats = {**hstats, "file": os.path.basename(hits_path), "weightsStatus": cfg.get("detectorWeightsStatus"),
                  "rule": "a detector hit counts only when detectorWeightsStatus is 'approved'; until then weight 0, "
                          "listed and attached as a reason, never opens or ranks a candidate",
                  "counted": sum(1 for e in dev if not e["attachOnly"]),
                  "attached": sum(1 for e in dev if e.get("candidate"))}
    doc = {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(),
        "recording": os.path.basename(a.recording),
        "recordStartUtc": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
        "duration": round(dur, 3),
        "source": {k: info[k] for k in ("width", "height", "fps", "vcodec", "has_audio")},
        "ranking": {"version": cfg.get("version"), "status": cfg.get("status"), "approvedBy": cfg.get("approvedBy")},
        "signals": {
            "markers": mstats,
            "chat": cstats if a.chat_db else {"available": False},
            "audio": {**astats, **({"baseline": abase} if abase else {})},
            "detectors": hstats or {"available": False},
            "events": len(events),
        },
        "candidates": cands,
        # every detector hit, shown even when it adds nothing to a score (no OCR text, no names)
        "detectorHits": [{"t": round(h["t"], 2), "detector": h["detector"], "label": h.get("label"),
                          "signal": h.get("signal"), "weight": e["w"], "candidate": e.get("candidate")}
                         for h, e in zip(hits, dev)],
    }
    os.makedirs(a.out, exist_ok=True)
    write_json_atomic(os.path.join(a.out, CANDIDATES), doc)
    print(f"candidates: {len(cands)} from {len(events)} events "
          f"(markers {mstats['matched']}, chat {'on' if a.chat_db else 'off'}, "
          f"audio {'on' if astats.get('available') else 'off'}, detectors {len(hits)}); ranking {cfg.get('status')}")
    progress_line("candidates", 1, 1, f"{len(cands)} candidate(s)")
    return 0


# ---------------------------------------------------------------- gate

def _gate_pack(a):
    """The game pack named by the detect summary in --out (else the default game); None when it cannot be loaded."""
    import detector_pass as dp
    game = getattr(a, "game", None)
    s = os.path.join(a.out, dp.SUMMARY)
    if not game and os.path.isfile(s):
        try:
            game = load_json(s).get("game")
        except ClipError:
            game = None
    try:
        _gid, st, _doc = dp.load_settings(game, getattr(a, "detector_config", None))
        return game_pack.load_pack(dp.pack_path(st))
    except (ClipError, OSError, ValueError, KeyError):
        return None


def _match_stats(a):
    """DIR/match-stats.json from `detect` on the same recording, else None (older runs: the kill feed hits count)."""
    p = os.path.join(a.out, mg.STATS)
    if not os.path.isfile(p):
        return None
    doc = load_json(p)
    return doc if doc.get("recording") == os.path.basename(a.recording) else None


def _reel_matches(a, hits_path, duration):
    """Matches of the recording with their reel decision (D315, match-reels.json rules of the game pack) in
    m["reel"], and the report doc for DIR/montage/match-reels.json (the caller adds `reels`). Rules whose signal was
    not read stay inert; a match qualifies only on a rule that passes."""
    pack = _gate_pack(a) or {}
    stats = _match_stats(a)
    matches = mg.segment(mg.read_hits(hits_path), stats, float(duration), mg.stats_config(pack))
    rules = mg.reel_rules(pack)
    for m in matches:
        m["reel"] = mg.reel_decide(m, rules)
    doc = {"tool": "clipper.montage", "toolVersion": mg.TOOL_VERSION, "createdAt": _now(),
           "recording": os.path.basename(a.recording), "packVersion": pack.get("version"),
           "decision": (pack.get("matchReels") or {}).get("decision"),
           "rules": [{"id": r.get("id"), "label": r.get("label"), "when": r.get("when"), "status": r.get("status")}
                     for r in rules],
           "inputs": {"hits": os.path.basename(hits_path), "matchStats": mg.STATS if stats else None,
                      "killsFallback": None if stats else "kill-feed hit instances (undercount close kills)"},
           "summary": "a match gets a reel when any rule passes; a rule whose signal was not read is inert and "
                      "never gives a reel; a qualifying match with no own kill gives no reel",
           "matches": matches}
    return matches, doc


def cmd_gate(a):
    """Match gate (match_gate.py): splits the recording into matches by their end screens and keeps only the
    candidates of matches that pass clips.matchGate. -> DIR/matches.json; candidates.json keeps the passing
    candidates in `candidates` and moves the others to `gatedOut` (with the reason)."""
    path = os.path.join(a.out, CANDIDATES)
    doc = load_json(path)
    _same_recording(a, doc)
    gate = match_gate_settings(resolve_data_dir(a.data_dir))
    cands = [{k: v for k, v in c.items() if k not in ("match", "gateReason")}
             for c in doc.get("candidates", []) + doc.get("gatedOut", [])]
    cands.sort(key=lambda c: (c.get("rank", 0), c.get("id", "")))
    hits_path = getattr(a, "hits", None) or _own_hits(a)
    hits = mg.read_hits(hits_path)
    pack = _gate_pack(a) or {}
    cfg = mg.stats_config(pack)
    stats = _match_stats(a)
    matches = mg.segment(hits, stats, float(doc.get("duration") or 0.0), cfg)
    progress_line("gate", 0, len(matches), "sorting clips by match")
    kept, dropped = mg.gate_candidates(cands, matches, gate)
    start = sig.parse_iso(doc.get("recordStartUtc"))
    for i, m in enumerate(matches, 1):
        if start:
            m["startUtc"] = _iso_ms(start.timestamp() + m["start"])
            m["endUtc"] = _iso_ms(start.timestamp() + m["end"])
        progress_line("gate", i, len(matches), f"match {i}: {'kept' if m['passed'] else 'skipped'}")
    write_json_atomic(os.path.join(a.out, mg.MATCHES), {
        "tool": "clipper.gate", "toolVersion": mg.TOOL_VERSION, "createdAt": _now(), "recording": doc["recording"],
        "recordStartUtc": doc.get("recordStartUtc"), "duration": doc.get("duration"),
        "gate": gate, "packVersion": pack.get("version"),
        "inputs": {"hits": os.path.basename(hits_path) if hits_path else None,
                   "matchStats": mg.STATS if stats else None,
                   "killsFallback": None if stats else "kill-feed hit instances (undercount close kills)"},
        "rules": "a match passes when the streamer's card is #1-#3 on the top-3 screen (top3 on) or the streamer's "
                 "kills reach minKills (minKills set); a match with no end screen seen, or whose end screens were "
                 "not read, keeps its clips",
        "matches": matches,
    })
    doc["candidates"], doc["gatedOut"] = kept, dropped
    doc["matchGate"] = {"settings": gate, "file": mg.MATCHES, "matches": len(matches), "kept": len(kept),
                        "dropped": len(dropped)}
    write_json_atomic(path, doc)
    print(f"gate: {len(matches)} match(es) ({sum(1 for m in matches if m['endSeen'])} with an end screen), "
          f"{sum(1 for m in matches if m['passed'])} kept; candidates {len(kept)} kept, {len(dropped)} skipped "
          f"(top3 {'on' if gate['top3'] else 'off'}, minKills {gate['minKills']})")
    for m in matches:
        print(f"gate: match {m['index']} {m['start']:.0f}-{m['end']:.0f} s: {'KEPT' if m['passed'] else 'SKIPPED'} "
              f"({m['reason']})")
    return 0


# ---------------------------------------------------------------- detect

def _own_hits(a):
    """DIR/detector-hits.jsonl from an earlier `detect` on the same recording, else None."""
    import detector_pass as dp
    p = os.path.join(a.out, dp.HITS)
    s = os.path.join(a.out, dp.SUMMARY)
    if not (os.path.isfile(p) and os.path.isfile(s)):
        return None
    if load_json(s).get("recording") != os.path.basename(a.recording):
        eprint("candidates: detector hits in --out belong to another recording; not used")
        return None
    return p


def _dml_available():
    try:
        import onnxruntime
        return "DmlExecutionProvider" in onnxruntime.get_available_providers()
    except ImportError:
        return False


def cmd_detect(a):
    """Post-stream detector pass over the H recording -> DIR/detector-hits.jsonl + DIR/detector-pass.json."""
    import detector_pass as dp  # needs the OCR venv (numpy, cv2, rapidocr) only from here on
    _ffmpeg, ffprobe = _tools(a)
    if not os.path.isfile(a.recording):
        raise ClipError("recording not found")
    info = media_info(ffprobe, a.recording)
    gid, st, cdoc = dp.load_settings(a.game, a.detector_config)
    if a.fps:
        st["fps"] = float(a.fps)
    pack = game_pack.load_pack(dp.pack_path(st))
    names, have_profile = dp.load_names(a.profile or PROFILE_FILE, pack["nameMatch"]["profileKey"])
    try:
        layout, lsrc = dp.layout_for(a.recording, a.layout, a.project)
    except ValueError as e:
        raise ClipError(f"--project: {e}")
    print(f"detect: layout {lsrc}, game {layout['game']}, visible {layout['visible']}")
    gpu = _dml_available()
    if gpu:  # OCR on the GPU (D227): only when this Python has onnxruntime-directml (.venv-gpu)
        import g1_scan
        g1_scan.set_ocr_params({"EngineConfig.onnxruntime.use_dml": True})
    total = int(info["duration"] * float(st["fps"])) + 1
    if not os.path.exists(os.path.join(a.out, dp.CHECKPOINT)):  # a resumed pass starts its lines at its own count
        progress_line("detect", 0, total, "reading the game screen")
    with dp.HeavyJobLock():
        summ = dp.run_pass(a.recording, a.out, st, pack, names, layout, threads=a.threads, total_frames=total,
                           progress_line=lambda d, n, note="reading the game screen":
                           progress_line("detect", d, n, note))
    doc = {
        "tool": "clipper.detect", "toolVersion": TOOL_VERSION, "detectorPassVersion": dp.TOOL_VERSION,
        "createdAt": _now(), "recording": os.path.basename(a.recording), "duration": round(info["duration"], 3),
        "game": gid, "packVersion": pack.get("version"),
        "config": {"version": cdoc.get("version"), "status": cdoc.get("status"), "fps": st["fps"],
                   "diffGate": st["diffGate"], "nameMin": st["nameMin"], "mergeGapSec": st["mergeGapSec"]},
        "layout": {"source": lsrc, "status": "unverified" if lsrc == "full-frame" else lsrc,
                   "game": layout["game"], "visible": layout["visible"]},
        "profileNames": len(names) if have_profile else 0,
        "detectorStatus": {d["id"]: d.get("status") for d in pack["detectors"]},
        "threads": a.threads, "ocr": "gpu-directml" if gpu else "cpu", **summ,
    }
    write_json_atomic(os.path.join(a.out, dp.SUMMARY), doc)
    print(f"detect: {summ['hits']} hit(s), {summ['signalHits']} with signal, from {summ['ocrFrames']} OCR frames "
          f"at {st['fps']} fps in {summ['seconds']} s; detectors unverified, weights not approved")
    return 0


# ---------------------------------------------------------------- render

def v_recording(h_path, given=None):
    """The V canvas recording of the same session: --v-recording, else the sibling file whose name has '-v-' where
    the H file has '-h-' (sinks record H and V from one start, e.g. practice-h-<ts>.mkv / practice-v-<ts>.mkv)."""
    if given:
        return given if os.path.isfile(given) else None
    d, base = os.path.split(h_path)
    if "-h-" not in base:
        return None
    cand = os.path.join(d, base.replace("-h-", "-v-", 1))
    return cand if os.path.isfile(cand) else None


def cmd_render(a):
    ffmpeg, ffprobe = _tools(a)
    doc = load_json(os.path.join(a.out, CANDIDATES))
    _same_recording(a, doc)
    info = media_info(ffprobe, a.recording)
    lay_doc = load_config("layouts", a.layouts_file)
    targets = load_config("targets", a.targets)
    frame = lay_doc["output"]
    wanted = ([x for x in (a.layouts or "").split(",") if x] or lay_doc.get("default")
              or [x["id"] for x in lay_doc["layouts"]])
    by_id = {x["id"]: x for x in lay_doc["layouts"]}
    missing = [x for x in wanted if x not in by_id]
    if missing:
        raise ClipError(f"unknown layout(s): {', '.join(missing)}")
    sources = {"h": (a.recording, info)}
    if any(by_id[x].get("input") == "v" for x in wanted):
        vrec = v_recording(a.recording, a.v_recording)
        if not vrec:
            raise ClipError("layout needs the V canvas recording: none next to the H recording; give --v-recording")
        sources["v"] = (vrec, media_info(ffprobe, vrec))
    only = {x for x in (a.only or "").split(",") if x}
    cands = [c for c in doc["candidates"] if not only or c["id"] in only]
    encoder = rnd.pick_encoder(a.encoder)
    safe = caps.safe_area(targets)
    opts = {"whisper_bin": a.whisper_bin, "whisper_model": a.whisper_model, "language": a.language}
    out_rows, failed = [], 0
    t0 = time.monotonic()
    progress_line("render", 0, len(cands), "making clip videos")
    for n, c in enumerate(cands, 1):
        wd = os.path.join(a.out, "clips", c["id"])
        os.makedirs(wd, exist_ok=True)
        dur = float(c["end"]) - float(c["start"])
        cinfo = {"backend": a.captions, "status": "off"}
        capname = None
        if a.captions != "none":
            if not info["has_audio"]:
                cinfo = {"backend": a.captions, "status": "unavailable", "reason": "no audio"}
            else:
                with tempfile.TemporaryDirectory(dir=wd) as td:
                    wav = os.path.join(td, "clip.wav")
                    caps.extract_wav(ffmpeg, a.recording, float(c["start"]), dur, wav)
                    segs, cinfo = caps.transcribe(a.captions, wav, opts)
                if segs:
                    with open(os.path.join(wd, "captions.ass"), "w", encoding="utf-8", newline="\n") as f:
                        f.write(caps.to_ass(segs, frame, safe, duration=dur))
                    capname = "captions.ass"
        files, errors = [], []
        for lid in wanted:
            lay = by_id[lid]
            t1 = time.monotonic()
            try:
                src, sinfo = sources[lay.get("input", "h")]
                name = rnd.render_variant(ffmpeg, src, sinfo, c, lay, frame, encoder, wd, capname)
            except ClipError as e:  # one failed variant never stops the others; validate reports it
                errors.append({"layout": lid, "error": str(e)[-300:]})
                failed += 1
                eprint(f"render {c['id']}/{lid}: FAILED")
                continue
            files.append({"layout": lid, "file": name, "geometry": lay.get("geometry", "unverified"),
                          "seconds": round(time.monotonic() - t1, 2), "sourceAudioTracks": sinfo.get("audio_tracks")})
            print(f"render {c['id']}/{lid}: {files[-1]['seconds']} s")
        out_rows.append({"id": c["id"], "start": c["start"], "end": c["end"], "captions": cinfo, "files": files,
                         "errors": errors})
        progress_line("render", n, len(cands), f"clip {c['id']} {'failed' if errors else 'done'}")
    write_json_atomic(os.path.join(a.out, RENDER), {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": doc["recording"],
        "encoder": encoder, "frame": frame, "layoutsVersion": lay_doc.get("version"),
        "seconds": round(time.monotonic() - t0, 2), "failed": failed, "clips": out_rows,
    })
    print(f"render: {sum(len(r['files']) for r in out_rows)} file(s), {failed} failed, with {encoder}, "
          f"captions {a.captions}")
    return 0  # failures are carried into render.json; validate turns them into a non-zero exit


# ---------------------------------------------------------------- validate

def cmd_validate(a):
    ffmpeg, ffprobe = _tools(a)
    rdoc = load_json(os.path.join(a.out, RENDER))
    targets = load_config("targets", a.targets)
    frame = rdoc["frame"]
    rows, bad = [], 0
    total = sum(len(c["files"]) for c in rdoc["clips"])
    progress_line("validate", 0, total, "checking clip files")
    for c in rdoc["clips"]:
        for f in c["files"]:
            exp = float(f["outSec"]) if f.get("outSec") is not None else float(c["end"]) - float(c["start"])
            p = os.path.join(a.out, "clips", c["id"], f["file"])
            res = val.validate_file(ffmpeg, ffprobe, p, exp, frame, targets, decode=not getattr(a, "no_decode", False),
                                    source_tracks=f.get("sourceAudioTracks"))
            rows.append({"id": c["id"], "layout": f["layout"], "file": f["file"], "geometry": f["geometry"],
                         "captions": c["captions"].get("status"), **res})
            bad += 0 if res["ok"] else 1
            progress_line("validate", sum(1 for r in rows if r.get("file")), total,
                          f"clip {c['id']} {'ok' if res['ok'] else 'failed'}")
            loud = ", ".join(f"track {x['track']} {x['lufs'] if x['lufs'] is not None else '-inf'} LUFS"
                             f"{' (quiet)' if x['quiet'] else ''}" for x in res["audio"]["loudness"] or [])
            print(f"validate {c['id']}/{f['layout']}: {'PASS' if res['ok'] else 'FAIL ' + '; '.join(res['issues'])}; "
                  f"audio {res['audio']['tracks']} track(s){': ' + loud if loud else ''}")
        for e in c.get("errors", []):
            rows.append({"id": c["id"], "layout": e["layout"], "file": None, "ok": False,
                         "issues": ["render failed"], "error": e["error"]})
            bad += 1
            print(f"validate {c['id']}/{e['layout']}: FAIL render failed")
    write_json_atomic(os.path.join(a.out, REPORT), {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": rdoc["recording"],
        "targetsVersion": targets.get("version"),
        "targetsUnverified": [t["id"] for t in targets.get("targets", []) if t.get("unverified")],
        "files": len(rows), "failed": bad,
        "audioRule": "per file: audio track count (fails when fewer than the source) and per-track integrated loudness "
                     "(LUFS) and true peak; loudness is reported, not judged (no game-audio detector); quiet = below "
                     f"{val.QUIET_LUFS} LUFS, listen before posting",
        "results": rows,
    })
    print(f"validate: {len(rows) - bad}/{len(rows)} PASS")
    return 0 if bad == 0 else 4


def merge_saves(rows, durations):
    """Live saves -> clip windows. rows: saves.jsonl rows; durations: {path: seconds} of each save's V file.
    A save's clip is [at - startBack, at - endBack] in wall time. Overlapping clips merge into one cut from the
    later save's file when that file still holds the earlier start; otherwise they stay separate."""
    items = []
    for r in rows:
        at = sig.parse_iso(r.get("at"))
        v = next((f.get("path") for f in r.get("files", []) if str(f.get("canvas", "")).lower() == "v" and f.get("path")), None)
        if not at or not v or v not in durations:
            continue
        t = at.timestamp()
        ab = r.get("anchorBack")
        items.append({"s": t - float(r["startBack"]), "e": t - float(r["endBack"]), "at": t, "file": v,
                      "score": r.get("score", 0), "labels": list(r.get("labels", [])), "reasons": [r.get("reason")],
                      "anchor": t - float(ab) if isinstance(ab, (int, float)) else None, "best": r.get("score", 0)})
    items.sort(key=lambda x: x["s"])
    out = []
    for it in items:
        prev = out[-1] if out else None
        if prev and it["s"] <= prev["e"] and it["at"] - prev["s"] <= durations[it["file"]]:
            if it["anchor"] is not None and (prev["anchor"] is None or it["best"] > prev["best"]):
                prev.update(anchor=it["anchor"], best=it["best"])  # ED1: the stronger save's medal
            prev.update(e=max(prev["e"], it["e"]), at=it["at"], file=it["file"], score=prev["score"] + it["score"],
                        labels=prev["labels"] + it["labels"], reasons=prev["reasons"] + it["reasons"])
        else:
            out.append(dict(it))
    clips = []
    for i, c in enumerate(out, 1):
        dur = durations[c["file"]]
        start, end = max(0.0, dur - (c["at"] - c["s"])), max(0.0, dur - (c["at"] - c["e"]))
        if end - start < 1.0:
            continue
        row = {"id": f"L{i:02d}", "file": c["file"], "start": round(start, 3), "end": round(end, 3),
               "wallStart": round(c["s"], 3), "score": c["score"], "labels": c["labels"], "reasons": c["reasons"]}
        if c.get("anchor") is not None:  # ED1 (D352): the strongest medal in the file's time, inside the clip
            row["anchor"] = round(min(max(dur - (c["at"] - c["anchor"]), start), end), 3)
        clips.append(row)
    return clips


def saves_between(rows, since=None, until=None):
    """The saves of one recording or stream (D284): "at" within [since, until]. Both sides are ISO UTC with
    milliseconds and a Z (live_worker and the launcher), so string order is time order."""
    return [r for r in rows if (not since or str(r.get("at", "")) >= since) and (not until or str(r.get("at", "")) <= until)]


def _live_matches(a):
    """Matches for live-review from the stream's own recording (--recording, D304 proposed): the detector pass (skipped
    when DIR already holds hits of that recording), then the end-screen segmentation and the gate decision of `gate`.
    -> (path of DIR/matches.json, None) or (None, plain reason why the gate is not applied)."""
    gate = match_gate_settings(resolve_data_dir(a.data_dir))
    if not gate.get("top3") and gate.get("minKills") is None:
        return None, "match gate off in Settings: every save kept"
    try:
        if not os.path.isfile(a.recording):
            return None, "the stream's recording was not found: every save kept"
        if not _own_hits(a):
            a.detect_ran = True  # --montage never runs a second (failing) pass after this one
            cmd_detect(a)
        hits_path = _own_hits(a)
        if not hits_path:
            return None, "no detector hits for the stream's recording: every save kept"
        import detector_pass as dp
        duration = float(load_json(os.path.join(a.out, dp.SUMMARY)).get("duration") or 0.0)
        start = sig.recording_start(a.recording, getattr(a, "record_start", None))
    except (ClipError, ImportError, OSError, ValueError) as e:
        return None, f"match detection on the stream's recording failed ({str(e)[:120]}): every save kept"
    pack = _gate_pack(a) or {}
    stats = _match_stats(a)
    matches = mg.segment(mg.read_hits(hits_path), stats, duration, mg.stats_config(pack))
    for m in matches:
        m["passed"], m["reason"] = mg.decide(m, gate)
        m["startUtc"] = _iso_ms(start.timestamp() + m["start"])
        m["endUtc"] = _iso_ms(start.timestamp() + m["end"])
    path = os.path.join(a.out, mg.MATCHES)
    write_json_atomic(path, {
        "tool": "clipper.live-review", "toolVersion": mg.TOOL_VERSION, "createdAt": _now(),
        "recording": os.path.basename(a.recording),
        "recordStartUtc": start.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), "duration": duration,
        "gate": gate, "packVersion": pack.get("version"),
        "inputs": {"hits": os.path.basename(hits_path), "matchStats": mg.STATS if stats else None,
                   "killsFallback": None if stats else "kill-feed hit instances (undercount close kills)"},
        "matches": matches,
    })
    print(f"live-review: {len(matches)} match(es) in the stream's recording "
          f"({sum(1 for m in matches if m['endSeen'])} with an end screen), {sum(1 for m in matches if m['passed'])} kept")
    _queue_unknown_modes(a, matches, mg.stats_config(pack))
    return path, None


def _queue_unknown_modes(a, matches, cfg):
    """LL3 (D340): matches whose game mode the gate could not tell go to the review queue of this stream's session in
    the local learning store (live-<saves folder name>), each with one frame of the recording at its end screen.
    Post-stream only; any failure is logged and changes nothing else."""
    data_dir = resolve_data_dir(a.data_dir)
    if not data_dir or not getattr(a, "saves", None):
        return 0

    def frame_of(m):
        t = m.get("endScreenAt")
        if not isinstance(t, (int, float)):
            return None
        ffmpeg = find_tool("ffmpeg", getattr(a, "ffmpeg", None))
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "f.jpg")
            r = run_tool([ffmpeg, "-v", "error", "-y", "-ss", f"{max(0.0, float(t)):.2f}", "-i", a.recording,
                          "-frames:v", "1", "-q:v", "3", out], timeout=60)
            if r.returncode != 0 or not os.path.isfile(out):
                return None
            with open(out, "rb") as f:
                return f.read()

    n = lcap.queue_unknown_modes(data_dir, f"live-{os.path.basename(os.path.normpath(a.saves))}", matches, cfg,
                                 frame_of=frame_of, log=eprint)
    if n:
        print(f"live-review: {n} match(es) with an unknown game mode queued for review")
    return n


def cmd_live_review(a):
    ffmpeg, ffprobe = _tools(a)
    path = os.path.join(a.saves, "saves.jsonl")
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    eprint("live-review: skipped a bad saves.jsonl line")
    rows = saves_between(rows, a.since, a.until)
    window_files = [fl.get("path") for r in rows for fl in r.get("files", []) if fl.get("path")]
    gate_info = {"applied": False, "reason": "no matches.json (--matches) and no recording (--recording): every save kept"}
    matches_path = a.matches
    if not matches_path and getattr(a, "recording", None):
        if rows:
            matches_path, why = _live_matches(a)
            if why:
                gate_info = {"applied": False, "reason": why}
                print(f"live-review: {why}")
        else:
            gate_info = {"applied": False, "reason": "no saves in the window: nothing to gate"}
    if matches_path:
        mdoc = load_json(matches_path)
        gate = match_gate_settings(resolve_data_dir(a.data_dir))
        progress_line("gate", 0, 1, "sorting saves by match")
        rows, dropped = mg.gate_saves(rows, mdoc.get("matches") or [], gate, sig.parse_iso)
        gate_info = {"applied": True, "settings": gate, "matches": len(mdoc.get("matches") or []),
                     "keptSaves": len(rows), "droppedSaves": dropped}
        progress_line("gate", 1, 1, f"{len(rows)} save(s) kept, {len(dropped)} skipped")
        print(f"live-review: match gate kept {len(rows)} save(s), skipped {len(dropped)}")
    infos = {}
    for r in rows:
        for fl in r.get("files", []):
            p = fl.get("path")
            if str(fl.get("canvas", "")).lower() == "v" and p and p not in infos and os.path.isfile(p):
                infos[p] = media_info(ffprobe, p)
    clips = merge_saves(rows, {p: i["duration"] for p, i in infos.items()})
    retimed = _retime_live_clips(a, clips, matches_path, {p: i["duration"] for p, i in infos.items()})
    if retimed:
        print(f"live-review: {retimed} clip(s) re-cut to the recording's kills (dead time between them cut)")
    lay_doc = load_config("layouts", a.layouts_file)
    frame = lay_doc["output"]
    by_id = {x["id"]: x for x in lay_doc["layouts"]}
    wanted = [x for x in (a.layouts or "").split(",") if x] or lay_doc.get("default") or []
    bad = [x for x in wanted if x not in by_id or by_id[x].get("input") != "v"]
    if bad:
        raise ClipError(f"live-review renders V-canvas layouts only: {', '.join(bad)}")
    encoder = rnd.pick_encoder(a.encoder)
    data_dir = resolve_data_dir(a.data_dir)
    ex = _reel_extras(a, data_dir)  # ED1 hook, ED2 captions (D352, D353), RP1 transition
    import clip_montage as mont  # noqa: PLC0415
    lim_live = rl.effective_limits(data_dir)["live-clip"]
    fade_ms = int(load_config("montage", getattr(a, "montage_config", None))["audioFadeMs"])
    out_rows, failed = [], 0
    progress_line("review", 0, len(clips), "making clip videos from live saves")
    for n, c in enumerate(clips, 1):
        wd = os.path.join(a.out, "clips", c["id"])
        os.makedirs(wd, exist_ok=True)
        files, errors = [], []
        m = _live_hook(c, ex, lim_live)
        sinfo = infos[c["file"]]
        # the canvas layout renders through the pieces path when a teaser opens the clip or captions are on; a save
        # without audio renders picture only there, so a planned teaser is always what is rendered (and recorded)
        pieces_path = (bool(m["hook"].get("teaser")) or (ex["cap_on"] and bool(sinfo.get("has_audio")))
                       or len(m["pieces"]) > 1  # CL2: a re-cut clip with its dead time removed
                       or bool(ex["thumb"])  # RP6: the start frame
                       or bool(ex["title"] and ex["tbrand"])  # RP4: the title card
                       or bool(ex["music"] and sinfo.get("has_audio")))  # RP3: the music beds
        src_pieces = m["pieces"]
        if pieces_path and sinfo.get("has_audio"):
            tdoc, cinfo = _caption_reel(ffmpeg, c["file"], m["pieces"], frame, wd, ex, m["seconds"])
        else:
            tdoc = None
            cinfo = ({"backend": "none", "status": "unavailable", "reason": "no audio"} if ex["cap_on"]
                     else {"backend": "none", "status": "off"})
        hook = m["hook"]
        pk = _look_pick(ex, c["id"], os.path.basename(c["file"]))  # FX1: this clip's look
        if pieces_path:  # D411: transitions, the folder track and beat sync; captions follow that timeline
            m, tr, xd, mplan = _reel_timeline(ex, pk, m, "live-clip", ex["transition"], bool(sinfo.get("has_audio")),
                                              c["id"], os.path.basename(c["file"]))
        else:
            tr, xd, mplan = None, 0.0, None
        ass, fdir, cinfo = _caption_ass(tdoc, cinfo, src_pieces, m["pieces"], xd, frame, wd, ex)
        thumb, trec = _thumbnail(ffmpeg, c["file"], m, "live-clip", frame, wd, ex) if pieces_path else (None, None)
        ttl, tirec = _title(wd, m["pieces"], xd, frame, ex, pk) if pieces_path else (None, None)
        mus, murec = (_music(wd, m["pieces"], xd, tirec, ex, c["id"], os.path.basename(c["file"]), pk=pk, mplan=mplan)
                      if pieces_path and sinfo.get("has_audio") else (None, None))
        mus, sfxrec = (_with_sfx(wd, ex, tr, m["pieces"], xd, pk, mus) if pieces_path and sinfo.get("has_audio")
                       else (mus, None))  # FX3
        for lid in wanted:
            try:
                out_sec = None
                if pieces_path and by_id[lid].get("kind") == "canvas":
                    name = _render_pieces(ffmpeg, c["file"], m["pieces"], frame, encoder, wd, lid, sinfo, fade_ms,
                                          lim_live["maxSec"], ass, fdir, tr, thumb, ttl, mus)
                    out_sec = _pieces_out_sec(m, xd, thumb, lim_live["maxSec"])
                else:
                    name = rnd.render_variant(ffmpeg, c["file"], sinfo, c, by_id[lid], frame, encoder, wd)
                files.append({"layout": lid, "file": name, "geometry": by_id[lid].get("geometry", "unverified"),
                              # validate's expected length: a re-cut clip is its pieces minus the cross-faded joins,
                              # not its first piece's start to its last piece's end
                              **({"outSec": out_sec} if out_sec is not None else {}),
                              "sourceAudioTracks": sinfo.get("audio_tracks"),
                              **({"thumbnail": True} if thumb and pieces_path and by_id[lid].get("kind") == "canvas" else {})})
                if by_id[lid].get("kind") == "canvas" and hook.get("score") is None:
                    hook = _hook_score(ffmpeg, wd, name, m if pieces_path else dict(m, pieces=[
                        {"start": c["start"], "end": c["end"], "kills": 0}]), "live-clip", ex)
                print(f"live-review {c['id']}/{lid}: rendered ({m['seconds'] if pieces_path else c['end'] - c['start']:.1f} s)")
            except ClipError as e:
                errors.append({"layout": lid, "error": str(e)[-300:]})
                failed += 1
                eprint(f"live-review {c['id']}/{lid}: FAILED")
        _drop_fonts(wd)
        rti.cleanup(wd)
        rmu.cleanup(wd)
        rsfx.cleanup(wd)
        out_rows.append({"id": c["id"], "start": c["start"], "end": c["end"], "wallStart": c["wallStart"],
                         "source": os.path.basename(c["file"]), "sourcePath": c["file"],
                         "score": c["score"], "labels": c["labels"], "reasons": c["reasons"],
                         **({"pieces": m["pieces"]} if pieces_path else {}), "retimed": bool(c.get("retimed")),
                         "transition": dict(tr, joinSec=xd) if xd else None, "thumbnail": trec,
                         "title": tirec, "music": murec, "look": pk, "sfx": sfxrec, "captions": cinfo, "hook": hook, "files": files,
                         "errors": errors})
        _look_remember(ex, pk if files else None, track=(mplan or {}).get("track", {}).get("id"))
        progress_line("review", n, len(clips), f"clip {c['id']} {'failed' if errors else 'done'}")
    write_json_atomic(os.path.join(a.out, RENDER), {
        "tool": "clipper", "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": "live-saves",
        "saves": len(rows), "encoder": encoder, "frame": frame, "layoutsVersion": lay_doc.get("version"),
        "failed": failed, "matchGate": gate_info, "clips": out_rows,
    })
    print(f"live-review: {len(rows)} save(s) -> {len(clips)} clip(s), {failed} failed render(s)")
    rc = 0
    if a.publish:
        rc = cmd_validate(a)
        _publish(a, a.out)
    if a.drop_used_saves and failed == 0 and rc == 0:
        gone = pub.drop_used_saves(window_files)
        print(f"live-review: {len(gone)} used replay save file(s) deleted (live clipper intermediates)")
    if getattr(a, "montage", False):
        status = _live_montage(a)
        rpath = os.path.join(a.out, RENDER)
        try:  # the shorts are already published: a status write (disk full, locked file) must not fail the job
            rdoc = load_json(rpath)
            rdoc["montage"] = status
            write_json_atomic(rpath, rdoc)
        except (OSError, ValueError, ClipError) as e:
            eprint(f"montage: status not saved to {RENDER} ({type(e).__name__})")
        if status["status"] != "made":
            print(f"montage: NOT MADE ({status['reason']}); the short clips are kept"
                  f"{' and published' if a.publish else ''}")
    if getattr(a, "long_video", False) and getattr(a, "recording", None):
        _long_video(a)  # D406: last; its outcome never changes the exit code (see DIR/long/long.json)
    return 0  # a montage outcome never changes the exit code (D322 proposed): see render.json `montage`


def _retime_live_clips(a, clips, matches_path, durations):
    """CL2 (triage F2): after the stream, each live clip is re-cut from the recording's detector hits: the kill
    groups in its live window, with their earlier kills and knocks, dead time cut (clip_montage.live_clip_pieces).
    Needs the recording's hits and its start time (matches.json recordStartUtc); without them, or with no group in a
    window, the clip keeps its live window. Sets c["pieces"] (file time) and returns how many clips changed."""
    import clip_montage as mont  # noqa: PLC0415
    try:
        mdoc = load_json(matches_path) if matches_path else {}
        rec0 = sig.parse_iso(mdoc.get("recordStartUtc"))
        hits_path = _own_hits(a) if getattr(a, "recording", None) else None
        if not rec0 or not hits_path:
            return 0
        hits, _ = sig.read_hits(hits_path, float(mdoc.get("duration") or 1e9))
        ranking = load_config("ranking", getattr(a, "ranking", None))
        cfg = load_config("montage", getattr(a, "montage_config", None))
        min_sec = float(load_config("live-clips", None)["minClipSec"])
        # the longest re-cut: the live-clip maximum minus the longest teaser (a re-cut is never split into parts)
        max_sec = (float(rl.effective_limits(resolve_data_dir(getattr(a, "data_dir", None)))["live-clip"]["maxSec"])
                   - float(rh.load_defaults()["teaserSec"]["max"]))
    except (ClipError, OSError, ValueError, KeyError) as e:
        eprint(f"live-review: clips keep their live windows ({type(e).__name__})")
        return 0
    gs, deaths = mont.groups(hits, ranking, cfg)
    clips.sort(key=lambda x: x["wallStart"])
    # recording time = file time + off; span = the part of the recording the clip's save file holds
    plan = []
    for c in clips:
        off = float(c["wallStart"]) - float(c["start"]) - rec0.timestamp()
        plan.append((c, off, (off, float(durations[c["file"]]) + off),
                     mont.groups_in(gs, float(c["start"]) + off, float(c["end"]) + off)))

    def held(g, span):  # seconds of the group's pieces inside a save file
        return sum(max(0.0, min(p["end"], span[1]) - max(p["start"], span[0]))
                   for p in mont._pieces(g["kills"], deaths, ranking, cfg, g["actions"]))

    # a kill group seen by several clips belongs to the one whose save file holds most of it (the earliest on a tie):
    # one clip shows the whole chain, and no two clips show the same kills
    owner = {}
    for c, _, span, sel in plan:
        for g in sel:
            if id(g) not in owner or held(g, span) > held(g, owner[id(g)][1]):
                owner[id(g)] = (c, span)
    n, last_end, gone = 0, None, []
    for c, off, span, sel in plan:
        mine = [g for g in sel if owner[id(g)][0] is c]
        if sel and not mine:  # its kills are shown by another clip: one clip, not the same kills twice
            keep = owner[id(sel[0])][0]
            keep["labels"] = list(dict.fromkeys(keep["labels"] + c["labels"]))
            keep["reasons"] = keep["reasons"] + c["reasons"]
            gone.append(c)
            continue
        lo = span[0] if last_end is None else max(span[0], last_end)
        ps = mont.live_clip_pieces(mine, deaths, ranking, cfg, min_sec, lo=lo, hi=span[1])
        if not ps:
            continue
        if sum(p["end"] - p["start"] for p in ps) > max_sec:  # too long for one clip: it keeps its live window
            eprint(f"live-review: {c['id']} keeps its live window (its kills need more than {max_sec:g} s)")
            continue
        last_end = ps[-1]["end"]
        c["pieces"] = [dict(p, start=round(p["start"] - off, 3), end=round(p["end"] - off, 3)) for p in ps]
        c["start"], c["end"] = c["pieces"][0]["start"], c["pieces"][-1]["end"]
        c["wallStart"] = round(c["start"] + off + rec0.timestamp(), 3)
        if c.get("anchor") is not None:
            c["anchor"] = min(max(float(c["anchor"]), c["start"]), c["end"])
        c["retimed"] = True
        n += 1
    for c in gone:
        clips.remove(c)
        print(f"live-review: clip {c['id']} joined the clip that holds its kills")
    return n


def _live_hook(c, ex, lim):
    """ED1 (D352) for one live clip: {pieces, seconds, peaks, medals, hook}. The clip's strongest medal (anchor) is
    the moment; with a teaser the clip is first cut to the maximum minus the teaser around it (D350). A clip re-cut
    from the recording (CL2) keeps its pieces."""
    anchor = c.get("anchor")
    pieces = [dict(p) for p in c.get("pieces") or [{"start": float(c["start"]), "end": float(c["end"]), "kills": 0}]]
    reel = {"pieces": pieces,
            "seconds": round(sum(p["end"] - p["start"] for p in pieces), 3),
            "peaks": [float(anchor)] if anchor is not None else [],
            "medals": [{"t": float(anchor), "w": 1.0, "label": (c.get("labels") or [None])[0]}] if anchor is not None else []}
    h = ex["hooks"].get("live-clip") or {"on": False, "teaserSec": 0}
    if not h["on"]:
        return dict(reel, hook={"on": False})
    strat = ex["hcfg"]["byType"]["live-clip"]["strategy"]
    (r,) = rl.split_reel(reel, lim["maxSec"] - rh.room_for(strat, h["teaserSec"]), 0)
    r, rec = rh.plan_hook(r, strat, h["teaserSec"], ex["hcfg"], max_sec=lim["maxSec"])
    return dict(r, seconds=round(sum(p["end"] - p["start"] for p in r["pieces"]), 3), hook=rec)


RENDER_STALL_SEC = 120  # a render that writes nothing this long is stopped (2026-11-12: NVENC hung after a GPU reset)
CPU_ENCODER = "libopenh264"


def _render_job(mk_argv, encoder, wd, part, what):
    """Runs one reel render (mk_argv(encoder) -> argv writing `part` in wd) with the stall watch. A GPU render that
    fails, stalls or times out is tried once more on the CPU encoder (the part file is removed first). A timeout never
    raises: it comes back as a failed result, so one reel never stops the others. -> (CompletedProcess, encoder)."""
    def once(enc):
        try:
            return rnd.run_tool(mk_argv(enc), cwd=wd, timeout=1800, watch=part, stall_sec=RENDER_STALL_SEC)
        except subprocess.TimeoutExpired:
            return subprocess.CompletedProcess([], 1, "", "timed out after 1800 s")
    r = once(encoder)
    if r.returncode != 0 and encoder != CPU_ENCODER:
        eprint(f"{what}: the {encoder} render did not finish ({r.stderr.strip()[-120:]}); trying again on the CPU")
        try:
            os.remove(os.path.join(wd, part))
        except OSError:
            pass
        encoder = CPU_ENCODER
        r = once(encoder)
    return r, encoder


def _render_pieces(ffmpeg, src, pieces, frame, encoder, wd, lid, sinfo, fade_ms, max_sec, ass=None, fdir=None,
                   transition=None, thumbnail=None, title=None, music=None):
    """A canvas layout rendered from pieces (teaser + clip) with optional captions, the RP1 transition, the RP6
    start frame and the RP4 title card -> '<layout>.mp4'."""
    import clip_montage as mont  # noqa: PLC0415
    name = f"{lid}.mp4"
    def mk(enc):
        return mont.render_argv(ffmpeg, src, pieces, frame, rnd.ENCODERS[enc], rnd.AUDIO, fade_ms, name + ".part",
                                audio_tracks=max(1, int(sinfo.get("audio_tracks") or 1)) if sinfo.get("has_audio") else 0,
                                max_sec=max_sec, captions=ass, fontsdir=fdir, transition=transition, thumbnail=thumbnail,
                                title=title, music=music)
    r, _ = _render_job(mk, encoder, wd, name + ".part", f"render {lid}")
    if r.returncode != 0:
        try:
            os.remove(os.path.join(wd, name + ".part"))
        except OSError:
            pass
        raise ClipError(f"render {lid} failed: {r.stderr.strip()[-300:]}")
    os.replace(os.path.join(wd, name + ".part"), os.path.join(wd, name))
    return name


def _live_montage(a):
    """live-review --montage (D322 proposed): kill montages and match reels of the stream's H recording, cut from its
    V recording, into DIR/montage (cmd_montage, published with --publish). Runs after the short clips are rendered and
    published, so nothing here can lose them. -> {"status": made|failed|skipped, "reason", "rc"?, "videos"?}."""
    rec = getattr(a, "recording", None)
    if not rec or not os.path.isfile(rec):
        return {"status": "skipped", "reason": "no H recording of the stream (--recording)"}
    if not v_recording(rec, getattr(a, "v_recording", None)):
        return {"status": "skipped", "reason": "no V recording of the stream (--v-recording)"}
    try:
        if not _own_hits(a) and not getattr(a, "detect_ran", False):
            a.detect_ran = True
            cmd_detect(a)  # the montage needs the kills of the whole recording (HeavyJobLock inside)
        if not _own_hits(a):
            return {"status": "failed", "reason": "no detector hits for the stream's recording"}
        rc = cmd_montage(argparse.Namespace(**{**vars(a), "hits": None}))
    except Exception as e:  # noqa: BLE001 - any montage error is reported; the short clips stay as they are
        eprint(f"montage: FAILED: {type(e).__name__}: {str(e)[-200:]}")
        return {"status": "failed", "reason": f"{type(e).__name__}: {str(e)[-200:]}"}
    videos = 0
    try:
        videos = sum(1 for r in load_json(os.path.join(a.out, "montage", REPORT)).get("results", []) if r.get("ok"))
    except ClipError:
        pass
    if rc:
        return {"status": "failed", "rc": rc, "videos": videos,
                "reason": f"a montage file failed its check (exit {rc}); {videos} passing video(s) kept"}
    return {"status": "made", "rc": 0, "videos": videos,
            "reason": f"{videos} montage/reel video(s)" if videos else "no montage or reel in this recording"}


def _long_video(a):
    """D406 long highlights video of the H recording (long_video.py) into DIR/long, published with --publish. Runs
    last, after the shorts and reels, so nothing here can lose them. Writes DIR/long/long.json (the studio reads it:
    a recording is kept until it says made, skipped or off). -> {"status": made|skipped|off|failed, "reason", ...}."""
    import long_video as lv  # noqa: PLC0415
    out = os.path.join(a.out, lv.SUBDIR)
    os.makedirs(out, exist_ok=True)
    lv.clear_attempts(os.path.join(out, "clips", lv.CLIP_ID))  # Codex D406: every path, before any early return
    progress_line("long", 0, 1, "making the long highlights video")
    try:
        status = _long_video_steps(a, lv, out)
    except Exception as e:  # noqa: BLE001 - any error is reported; the shorts and reels stay as they are
        eprint(f"long video: FAILED: {type(e).__name__}: {str(e)[-200:]}")
        status = {"status": "failed", "reason": f"{type(e).__name__}: {str(e)[-200:]}"}
    rec = getattr(a, "recording", None)
    status = dict(status, createdAt=_now(), flag=lv.FLAG, recording=os.path.basename(rec) if rec else None,
                  **lv.recording_identity(rec))
    try:
        write_json_atomic(os.path.join(out, lv.STATUS), status)
    except (OSError, ClipError) as e:
        eprint(f"long video: status not saved ({type(e).__name__}); the recording is kept")
    print(f"long video: {status['status'].upper()} ({status.get('reason')})")
    progress_line("long", 1, 1, f"long video {status['status']}")
    return status


def cmd_long(a):
    """D406: the long highlights video alone, as its own job after the clip job (record-clips runs it off air and with no
    recording running; Codex D406 P1). The outcome is in DIR/long/long.json; the exit code is 0 unless it failed."""
    status = _long_video(a)
    return 0 if status.get("status") in ("made", "skipped", "off") else 1


def _long_video_steps(a, lv, out):
    data_dir = resolve_data_dir(a.data_dir)
    if not lv.on(data_dir):
        return {"status": "off", "reason": f"the long highlights video is switched off (flag {lv.FLAG})"}
    rec = getattr(a, "recording", None)
    if not rec or not os.path.isfile(rec):
        return {"status": "skipped", "reason": "the stream was not recorded"}
    if not _own_hits(a) and not getattr(a, "detect_ran", False):
        a.detect_ran = True
        cmd_detect(a)  # the moments need the kills of the whole recording (HeavyJobLock inside)
    hits_path = _own_hits(a)
    if not hits_path:
        return {"status": "failed", "reason": "no detector hits for the recording"}
    ffmpeg, ffprobe = _tools(a)
    info = media_info(ffprobe, rec)
    if not info.get("has_audio"):
        return {"status": "failed", "reason": "the recording has no sound"}
    hits, _ = sig.read_hits(hits_path, info["duration"])
    ranking = load_config("ranking", a.ranking)
    mcfg = load_config("montage", getattr(a, "montage_config", None))
    cfg = lv.load_config()
    matches, _ = _reel_matches(a, hits_path, info["duration"])
    tr = lv.transition(data_dir, cfg, rt)
    p = lv.plan(hits, ranking, mcfg, info["duration"], matches, cfg, tr)
    if p["status"] != "planned":
        return p
    print(f"long video: {p['moments']} moment(s) -> {len(p['segments'])} segment(s), {p['seconds']:.0f} s, "
          f"{p['dropped']} lowest-scored segment(s) dropped to fit")
    wd = os.path.join(out, "clips", lv.CLIP_ID)
    os.makedirs(wd, exist_ok=True)
    frame = cfg["frame"]
    tracks = max(1, int(info.get("audio_tracks") or 1))
    ok, expected, err = lv.render(ffmpeg, rec, p["segments"], frame, rnd.pick_encoder(a.encoder), wd, tracks,
                                  int(mcfg["audioFadeMs"]), tr, cfg["batchPieces"], _render_job, rnd.run_tool,
                                  rnd.ENCODERS, rnd.AUDIO)
    files, errors = [], []
    if ok:
        files.append({"layout": lv.LAYOUT, "file": lv.FILE, "geometry": "canvas", "sourceAudioTracks": tracks})
    else:
        errors.append({"layout": lv.LAYOUT, "error": err})
    kills = sum(g["kills"] for g in p["segments"])
    write_json_atomic(os.path.join(out, RENDER), {
        "tool": lv.TOOL, "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": os.path.basename(rec),
        "frame": frame, "configVersion": cfg.get("version"), "transition": tr,
        "flash": "no flash effect: cross fade or cut only", "failed": 0 if ok else 1,
        "clips": [{"id": lv.CLIP_ID, "start": 0.0, "end": expected, "score": round(sum(g["score"] for g in p["segments"]), 3),
                   "labels": [], "kills": kills, "pieces": p["segments"], "dropped": p["dropped"],
                   "captions": {"backend": "none", "status": "off"}, "files": files, "errors": errors}]})
    if not ok:
        return {"status": "failed", "reason": err[:200]}
    res = val.validate_file(ffmpeg, ffprobe, os.path.join(wd, lv.FILE), None, frame, {"targets": []},
                            decode=not getattr(a, "no_decode", False), source_tracks=tracks)
    if not lv.duration_ok(res["facts"]["duration"], expected):
        res["ok"] = False
        res["issues"].append(f"duration {res['facts']['duration']:.1f}s (want {expected:.1f}s)")
    if lv.over_cap(res["facts"]["duration"], cfg):  # Codex D406: never published over maxSec, whatever the tolerance
        res["ok"] = False
        res["issues"].append(f"duration {res['facts']['duration']:.1f}s is over the {float(cfg['maxSec']):.0f}s cap")
    if not res["ok"]:
        try:
            os.remove(os.path.join(wd, lv.FILE))
        except OSError:
            pass
    write_json_atomic(os.path.join(out, REPORT), {
        "tool": lv.TOOL, "toolVersion": TOOL_VERSION, "createdAt": _now(), "recording": os.path.basename(rec),
        "files": 1, "failed": 0 if res["ok"] else 1,
        "results": [{"id": lv.CLIP_ID, "layout": lv.LAYOUT, "file": lv.FILE, "geometry": "canvas", "captions": "off", **res}]})
    if not res["ok"]:
        return {"status": "failed", "reason": f"the long video failed its check: {'; '.join(res['issues'])[:160]}"}
    published = 0
    if getattr(a, "publish", None):
        sub = argparse.Namespace(**{**vars(a), "out": out})
        published = len(_publish(sub, out, run_name=os.path.basename(a.out), rec_start=rec))
    return {"status": "made", "reason": f"{p['seconds'] / 60:.1f} minutes from {len(p['segments'])} moment(s)",
            "seconds": expected, "segments": len(p["segments"]), "dropped": p["dropped"], "published": published}


KIND_TYPE = {"M": "montage", "W": "match-reel", "I": "impact-play", "L": "live-clip"}  # clip id prefix -> reel type (CL1)


# ---------------------------------------------------------------- ED1 hook and ED2 captions (D352, D353)

def _reel_extras(a, data_dir):
    """The payoff-first hook settings (flag reel-hook + Settings > Clips) and the burned-in caption settings (flag
    reel-captions) for one run."""
    hcfg = rh.load_defaults()
    ccfg = rcap.load_config()
    cap_on = rcap.on(data_dir, ccfg)
    th_on = rth.on(data_dir)
    ti_on = rti.on(data_dir)
    mu_on = rmu.on(data_dir)
    lcfg = look.load_config() if look.on(data_dir) else None  # FX1 (D411): the clip look, picked per reel
    look_now = look.effective(data_dir, lcfg) if lcfg else None
    tracks, mlcfg = _look_library(data_dir, look_now) if lcfg else ([], None)  # FX4: the user's music folder
    return {"hooks": rh.active(data_dir, hcfg), "hcfg": hcfg, "cap_on": cap_on, "ccfg": ccfg,
            "look": ({"cfg": lcfg, "look": look_now, "override": look.override_from_env(lcfg), "tracks": tracks,
                      "mlcfg": mlcfg, "dataDir": data_dir, "history": look.load_history(data_dir),
                      # each part of the look obeys its own switch (Codex review): music = reel-music, transitions =
                      # reel-transitions, name = the clip-look switch itself (the old reel-title switch is retired)
                      "gates": {"music": mu_on, "transitions": flag_on(data_dir, rt.FLAG), "name": True}} if lcfg else None),
            "transition": rt.active(data_dir),  # RP1: None = hard cut (flag off, or the user chose Cut)
            "reelStyles": data_dir if rstyle.on(data_dir) else None,  # RS4 (D412): styles picked per reel (flag reel-styles)
            "thumb": rth.load_config() if th_on else None,  # RP6: the start frame (flag reel-thumbnail)
            "brand": rth.brand() if th_on else None,
            "title": rti.load_config() if ti_on else None,  # FX2: the name display (flag clip-look, or the retired reel-title)
            "tbrand": rth.brand() if ti_on else None,
            "music": rmu.load_config() if mu_on else None,  # RP3 beds and the FX4 duck + fallback (flag reel-music)
            "style": rcap.load_style(ccfg) if cap_on else None,
            "safe": caps.safe_area(load_config("targets", getattr(a, "targets", None))),
            "opts": {"whisper_bin": getattr(a, "whisper_bin", None),
                     "whisper_model": rcap.model_path(data_dir, ccfg, getattr(a, "whisper_model", None))}}


def _thumbnail(ffmpeg, src, reel, typ, frame, wd, ex, matches=None):
    """RP6 (D366): the start frame of a reel -> (bare PNG name or None, record for render.json or None)."""
    if not ex.get("thumb"):
        return None, None
    mt = next((x for x in matches or [] if reel.get("match") is not None and x.get("index") == reel.get("match")), None)
    facts = dict(reel, **({"resultText": mt.get("result"), "mode": mt.get("mode")} if mt else {}))
    rec = rth.make(ffmpeg, src, facts, typ, frame, ex["safe"], wd, ex["thumb"], ex.get("brand"))
    if rec.get("error"):
        eprint(f"thumbnail: not made ({rec['error'][-120:]}); the reel opens without it")
    return rec.get("file"), rec


STYLE_TYPE = {"match-reel": "reel", "live-clip": "reel", "impact-play": "impact", "montage": "montage"}  # RS4 (D412)


def _style_pick(ex, typ, m, pk, *seed_parts):
    """RS4 (D412): this reel's style (reel_style.pick: the one chosen for the type, or a seeded pick with the pool) with
    the user's tuning, and what it changes before the timeline: the pace (long pieces cut into shots of the style's
    length; a kill is never cut through), the name style and the music energy target. No style: everything as before.
    -> (style parts or None, m, pk)."""
    dd = ex.get("reelStyles")
    st = rstyle.pick(dd, STYLE_TYPE.get(typ), seed_parts) if dd else None
    if not st:
        return None, m, pk
    eff = dict(rstyle.effective(st), id=st["id"], name=st["name"])
    if eff["cuts"]:
        keep = list(m.get("peaks") or [])
        if eff["ramps"] and keep:  # the first kill keeps a shot long enough for its speed ramp (slow part + catch-up)
            f, sec = float(eff["ramps"]["factor"]), float(eff["ramps"]["sec"])
            keep[0] = (keep[0], sec + 2.0 * sec * (1.0 / f - 1.0) + 0.3)
        ps = rstyle.pace(m["pieces"], float(eff["cuts"]["shotSec"]), keep=keep)
        if len(ps) != len(m["pieces"]):
            m = dict(m, pieces=ps, seconds=round(sum(p["end"] - p["start"] for p in ps), 3))
    if eff["music"] and eff["music"].get("energyLevel") is not None:
        m = dict(m, styleMusicEnergy=float(eff["music"]["energyLevel"]))
    if pk and pk.get("name") and eff["text"] and eff["text"].get("nameStyle") and pk["name"] != eff["text"]["nameStyle"]:
        pk = dict(pk, name=eff["text"]["nameStyle"], nameFrom="style")  # only when the name part is on
    return eff, m, pk


def _style_render_plan(sty, m, xd, vrec, wd, captions=False):
    """RS4 (D412): the style's zoom pulses (on the kills, off the joins), one speed ramp on the first kill it fits
    around (not with captions: slow motion would put the words out of step), and the LUT fitted to this reel's own
    footage (written to wd; lut3d once, after the joins). -> (m, zoom or None, lut file name or None, style record)."""
    if not sty:
        return m, None, None, None
    ps, peaks = [dict(p) for p in m["pieces"]], sorted(m.get("peaks") or [])
    rec = {"id": sty["id"], "name": sty["name"], "pace": (sty["cuts"] or {}).get("shotSec"),
           "transitions": (sty["transitions"] or {}).get("mode")}
    zoom = rstyle.zoom_for(sty["zooms"], rstyle.reel_moments(ps, xd, peaks), rstyle.join_windows(ps, xd))
    if zoom:
        rec["zoom"] = {"times": zoom["times"], "scale": zoom["scale"]}
    if sty["ramps"] and not captions:
        for i, p in enumerate(ps):
            k = next((t for t in peaks if p["start"] <= t < p["end"]), None)
            r = rstyle.ramp_for(sty["ramps"], p, k) if k is not None else None
            if r:
                ps[i] = dict(p, ramp=r)
                rec["ramp"] = {"piece": i, "at": r["at"], "factor": r["factor"]}
                break
    lut = None
    if sty["colour"]:
        ref = rstyle.clip_colour(vrec, ps)
        rec["colour"] = rstyle.write_lut(os.path.join(wd, rstyle.LUT_FILE), sty["colour"], sty["colour"]["strength"], ref)
        lut = rstyle.LUT_FILE
    if m.get("styleMusicEnergy") is not None:
        rec["musicEnergy"] = m["styleMusicEnergy"]
    return dict(m, pieces=ps), zoom, lut, rec


def _style_cleanup(wd):
    try:
        os.remove(os.path.join(wd, rstyle.LUT_FILE))
    except OSError:
        pass


def _look_pick(ex, *seed_parts):
    """FX1 (D411): this reel's clip look {music, transitions, name, variant, seed}, or None (flag clip-look off)."""
    lk = ex.get("look")
    if not lk:
        return None
    pk = look.pick(lk["look"], seed_parts, lk["history"], lk["cfg"], lk["override"])
    for g, on in (lk.get("gates") or {}).items():
        if not on and pk.get(g):
            pk = dict(pk, **{g: None}, off=sorted(set(pk.get("off") or []) | {g}))
    return pk


def _resume_row(a, wd, cid, old_rows):
    """--resume (2026-11-12): a run stopped part-way keeps the reels it finished. Codex review (D411): a kept reel keeps
    its stored row (its look, music and transition decisions), so the caller makes no new pick and no history change.
    -> the stored row marked resumed, or None (render it)."""
    done = os.path.join(wd, "montage-v.mp4")
    if not (getattr(a, "resume", False) and os.path.isfile(done) and os.path.getsize(done) > 0):
        return None
    kept = next((x for x in old_rows if x.get("id") == cid and x.get("files")), None)
    if kept is None or kept.get("fileStamp") != _file_stamp(done):
        # Codex verify: only a row written for this very file (its size and mtime in ns) is trusted; an old row next
        # to a newer file, or a row without a stamp, means the reel is rendered again
        return None
    print(f"montage {cid}: kept from the earlier run (--resume)")
    try:  # a stopped render's leftover must never replace the finished reel
        os.remove(os.path.join(wd, "montage-v.mp4.part"))
    except OSError:
        pass
    return dict(kept, resumed=True)


def _file_stamp(path):
    """Size and mtime (ns) of a finished reel file, stored in its row: the row belongs to exactly that file."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return {"size": st.st_size, "mtimeNs": st.st_mtime_ns}


def _look_remember(ex, pk, track=None):
    """Adds a rendered reel's picks to <data>/clips/look-history.json (no repeat of the last picks)."""
    lk = ex.get("look")
    if lk and pk:
        lk["history"] = look.remember(lk["dataDir"], pk, lk["cfg"], track=track, history=lk["history"])


def _look_transition(exr, pk, pieces, legacy):
    """FX3: the joins of this reel from the look's transition set (None = hard cut); without the look, the RP1 choice.
    The RP5 mix may still pick the hard cut for a reel."""
    if pk is None:
        return legacy
    lr = exr.get("learning")
    if (lr and (lr.get("picks") or {}).get("transition") == "cut") or not pk.get("transitions"):
        return None
    return rt.plan_set(pieces, pk["transitions"], pk["seed"])


def _with_sfx(wd, exr, tr, pieces, xd, pk, mus):
    """FX3: the join sound effects of this reel added to the music dict render_argv takes -> (music dict, record)."""
    if not (pk and tr and tr.get("sfx") and exr["look"]["look"]["transitions"].get("sfx", True)):
        return mus, None
    try:
        f = rsfx.prepare(wd, tr, pieces, xd, pk["seed"])
    except (OSError, ValueError) as e:
        eprint(f"sound effects: not made ({str(e)[-120:]}); the reel renders without them")
        rsfx.cleanup(wd)
        return mus, None
    return (dict(mus or {}, sfx=f), {"kinds": tr["sfx"], "peakDb": tr["sfxDb"]}) if f else (mus, None)


def _name_part(ex, pk):
    """The clip look's name settings for reel_title.plan, None for the default, or False when the look has no name."""
    if pk is None:
        return None
    if not pk.get("name"):
        return False
    nv = ex["look"]["look"]["name"]
    return {"style": pk["name"], "variant": pk.get("variant"), "position": nv["position"], "colour": nv["colour"],
            "sizePct": nv["sizePct"], "durationSec": nv["durationSec"]}


def _title(wd, pieces, xd, frame, ex, pk=None):
    """FX2: the name display of a reel -> (dict for render_argv(title=) or None, record for render.json or None). The
    record holds the brand, so like the thumbnail it stays in local app data."""
    if not ex.get("title"):
        return None, None
    name = _name_part(ex, pk)
    if name is False:
        return None, None
    rec = rti.plan(pieces, xd, ex["title"], ex.get("tbrand"), frame, ex["safe"], name)
    if rec is None:
        return None, None
    try:
        return rti.prepare(wd, rec, ex["title"]), rec
    except OSError as e:
        eprint(f"title: not made ({str(e)[-120:]}); the reel renders without it")
        return None, None


def _look_library(data_dir, look_now):
    """FX4: the usable tracks of the user's music folder (new files analysed off air) and the library config, or
    ([], cfg) when the folder is not ticked, not set or cannot be read. Never raises: a library error means the
    made-here bed."""
    mv = look_now["music"]
    try:
        mcfg = mlib.load_config()
    except (OSError, ClipError) as e:
        eprint(f"music library: not used ({str(e)[-120:]})")
        return [], None
    if "folder" not in (mv.get("sources") or []) or not mv.get("folder"):
        return [], mcfg
    try:
        lib = mlib.refresh(data_dir, mv["folder"], mcfg, live=on_air)
        return mlib.usable(lib), mcfg
    except Exception as e:  # noqa: BLE001 - a broken library never stops the clip run
        eprint(f"music library: not read ({type(e).__name__}: {str(e)[-120:]}); the made-here bed is used")
        return [], mcfg


def _look_music_plan(ex, pk, pieces, xd, tr, reel, typ, ass, *seed_parts):
    """FX4: this reel's track from the user's folder (matched to the reel's energy and mood) and where it plays; with
    beatSync, the joins moved onto its beats (full-bed and intro-outro: the bed is anchored at the reel start). ->
    (pieces, plan or None)."""
    lk = ex.get("look")
    if not (lk and pk and pk.get("music") and lk.get("tracks")):
        return pieces, None
    mv, mcfg = lk["look"]["music"], lk["mlcfg"]
    total = sum(float(p["end"]) - float(p["start"]) for p in pieces) - (len(pieces) - 1) * xd
    target = mlib.target_for(reel, typ, mcfg)
    if reel.get("styleMusicEnergy") is not None:  # RS4 (D412): the reel style's music energy target
        target = dict(target, energy=round(float(reel["styleMusicEnergy"]), 3))
    track, sc = mlib.match(lk["tracks"], target, total, seed_parts, lk["history"].get("track") or [], mcfg,
                           n_avoid=int(lk["cfg"]["historyN"]["track"]), prefer_long=pk["music"] != "intro-outro")
    if track is None:
        return pieces, None
    name_end = None
    if pk.get("name") in ("lower-third", "kinetic"):
        name_end = rti.timeline(pieces, xd)[0] + float(lk["look"]["name"]["durationSec"])

    def mk(ps):
        return mlib.plan(track, pk["music"], ps, xd, mlib.strongest_reel_time(reel, ps, xd), name_end, mv["levelDb"], mcfg)
    rec = mk(pieces)
    shifts = []
    if tr and lk["look"]["transitions"].get("beatSync") and pk["music"] != "drop":
        seg0 = rec["segments"][0]
        beats = rec["beats"] if pk["music"] == "full-bed" else [b for b in rec["beats"] if b <= seg0["at"] + seg0["len"]]
        synced, shifts = rt.beat_sync(pieces, xd, beats)
        if any(shifts):
            pieces = synced
            rec = mk(pieces)
    record = {k: v for k, v in rec.items() if k != "beats"}
    return pieces, {"rec": rec, "track": track,
                    "record": dict(record, source="folder", score=sc, target=target, beatShifts=shifts, beats=len(rec["beats"]))}


def _music(wd, pieces, xd, title_rec, ex, *seed_parts, pk=None, mplan=None):
    """RP3/FX4: the music bed of a reel -> (dict for render_argv(music=) or None, record for render.json or None). With
    the clip look: no music when the look has none; a matched track of the user's folder (mplan); else the made-here
    bed as the last fallback."""
    if pk is not None and not pk.get("music"):
        return None, None
    if mplan:
        try:
            return (mlib.prepare(wd, mplan["rec"], mplan["track"], ex["look"]["mlcfg"], ex["music"]["duck"]),
                    mplan["record"])
        except Exception as e:  # noqa: BLE001 - a track that fails to decode falls back to the made-here bed
            eprint(f"music: the track is not used ({type(e).__name__}: {str(e)[-120:]}); the made-here bed is used")
            rmu.cleanup(wd)
    if not ex.get("music"):
        return None, None
    rec = rmu.plan(pieces, xd, title_rec, ex["music"], rmu.seed_for(*seed_parts))
    if rec is None:
        return None, None
    if pk is not None:
        rec = dict(rec, source="made-here", mode="intro-outro")
    try:
        return rmu.prepare(wd, rec, ex["music"]), rec
    except (OSError, ValueError) as e:
        eprint(f"music: not made ({str(e)[-120:]}); the reel renders without it")
        rmu.cleanup(wd)
        return None, None


def _live_clip_spans(a):
    """RP2: [(start, end)] recording spans of this stream's live clips (DIR/render.json of live-review, its clip
    windows or re-cut pieces; recording time from DIR/matches.json recordStartUtc). [] when there are none."""
    try:
        rdoc = load_json(os.path.join(a.out, RENDER))
        rec0 = sig.parse_iso(load_json(os.path.join(a.out, mg.MATCHES)).get("recordStartUtc"))
    except (ClipError, OSError, ValueError):
        return []
    if rdoc.get("recording") != "live-saves" or not rec0:
        return []
    spans = []
    for c in rdoc.get("clips") or []:
        try:  # file time -> recording time: the clip's start is at wallStart
            off = float(c["wallStart"]) - float(c["start"]) - rec0.timestamp()
            ps = [p for p in c.get("pieces") or [{"start": c["start"], "end": c["end"]}] if not p.get("teaser")]
            spans += [(float(p["start"]) + off, float(p["end"]) + off) for p in ps]
        except (KeyError, TypeError, ValueError):
            continue
    return spans


def _hook_jobs(reels, typ, prefix, lim, ex, deaths=None):
    """CL1 split, then the hook of every part from its own pieces. With a teaser the split keeps room for it, so a part
    and its teaser stay within the type's maximum (D350)."""
    h = ex["hooks"].get(typ) or {"on": False, "teaserSec": 0}
    strat = (ex["hcfg"]["byType"].get(typ) or {}).get("strategy")
    room = rh.room_for(strat, h["teaserSec"]) if h["on"] else 0.0
    cap = {"maxSec": lim["maxSec"] - room, "minSec": min(lim["minSec"], lim["maxSec"] - room)}
    out = []
    for cid, r in rl.cap_reels(reels, cap, prefix):
        if r.get("story"):  # RP2: a story montage opens with its own fast cut; moving a piece would break the story
            rec = {"on": False, "used": "story"}
        elif h["on"]:
            r, rec = rh.plan_hook(r, strat, h["teaserSec"], ex["hcfg"], max_sec=lim["maxSec"], deaths=deaths)
        else:
            rec = {"on": False}
        out.append((cid, dict(r, hook=rec)))
    return out


def _caption_reel(ffmpeg, src, pieces, frame, wd, ex, duration):
    """The transcript of a reel's pieces (back to back) -> (transcript or None, captions info). The ASS is written by
    _caption_ass once the reel's final timeline (transitions, beat sync) is known."""
    if not ex["cap_on"]:
        return None, {"backend": "none", "status": "off"}
    try:
        tr, info = rcap.make_transcript(ffmpeg, src, pieces, ex["ccfg"], ex["style"], ex["opts"], wd, duration)
    except ClipError as e:  # a caption failure never stops the reel: it renders without captions
        return None, {"backend": ex["ccfg"]["backend"], "status": "failed", "reason": str(e)[-200:]}
    return tr, info


def _caption_ass(doc, info, src_pieces, pieces, xd, frame, wd, ex):
    """D411: the captions on the reel's output timeline (each cross-faded join overlaps by xd), so captions keep the
    chosen transitions. The moved transcript is saved (timeline "output") for recaption. -> (ass, fonts dir, info)."""
    if not doc:
        return None, None, info
    try:
        doc = rcap.retime(doc, src_pieces, pieces, xd)
    except ValueError as e:
        return None, None, dict(info, status="failed", reason=str(e)[-200:])
    write_json_atomic(os.path.join(wd, rcap.TRANSCRIPT), doc)
    out_sec = sum(float(p["end"]) - float(p["start"]) for p in pieces) - xd * (len(pieces) - 1)
    ass, fd, n = rcap.write_ass(doc, frame, ex["safe"], ex["style"], wd, out_sec)
    return ass, fd, dict(info, **rcap.summary(doc, n), transcript=rcap.TRANSCRIPT, burned=bool(n))


def _reel_timeline(ex, pk, m, typ, legacy_tr, has_audio, *seed_parts, style=None):
    """D411: the reel's joins, its folder track and beat sync, in that order; after beat sync the flash spacing is
    checked again on the final timeline (Codex review). -> (m with the final pieces, tr, xd, music plan)."""
    import clip_montage as mont  # noqa: PLC0415
    if style is not None and style.get("transitions") is not None:  # RS4 (D412): the style's joins (hard = cuts)
        tr = rstyle.transitions_for(style["transitions"], m["pieces"], "|".join(str(x) for x in seed_parts), rt)
    else:
        tr = _look_transition(ex, pk, m["pieces"], legacy_tr)
    xd = mont.crossfade_sec(m["pieces"], tr)
    mplan = None
    if has_audio:
        ps2, mplan = _look_music_plan(ex, pk, m["pieces"], xd, tr, m, typ, None, *seed_parts)
        if ps2 is not m["pieces"]:
            m = dict(m, pieces=ps2, seconds=round(sum(p["end"] - p["start"] for p in ps2), 3))
            tr = rt.respace(m["pieces"], tr)
            xd = mont.crossfade_sec(m["pieces"], tr)
    if tr and not rt.flash_rate_ok(m["pieces"], tr):
        tr = rt.respace(m["pieces"], tr)
    return m, tr, xd, mplan


def _drop_fonts(wd):
    import shutil  # noqa: PLC0415
    shutil.rmtree(os.path.join(wd, rcap.FONT_SUBDIR), ignore_errors=True)


def _hook_score(ffmpeg, wd, fname, m, typ, ex):
    """The hook record of a rendered reel with its hook-quality score (always computed, hook on or off, for AN2)."""
    motion = rh.motion_ydif(ffmpeg, fname, ex["hcfg"]["windowSec"], cwd=wd)
    kills = [] if typ in ("impact-play", "live-clip") else m.get("peaks")
    return dict(m.get("hook") or {"on": False}, score=rh.hook_score(m["pieces"], kills, m.get("medals"), ex["hcfg"], motion))


def _pieces_out_sec(m, xd, thumb, max_sec):
    """Length of a reel rendered from its pieces: the pieces, minus each cross-faded join, plus the start frame, cut at
    the type's maximum (-t)."""
    return round(min(m["seconds"] - xd * (len(m["pieces"]) - 1) + (1 / 60 if thumb else 0.0), float(max_sec)), 3)


def _hook_line(cid, hook):
    """The log line of a reel whose planned hook moved its opening, else None. Only a planned hook (on) carries peakOut:
    a story montage is {"on": False, "used": "story"} (2026-11-14: reading peakOut there failed every reel of the run)."""
    if not hook.get("on") or hook.get("used") in (None, "already", "none") or "peakOut" not in hook:
        return None
    return f"montage {cid}: opens on its strongest moment ({hook['used']}, at {hook['peakOut']:.1f} s)"


def cmd_montage(a):
    """Kill montages (clip_montage.py, data/clip/montage.json) from the detector hits of the H recording, cut from the
    V recording of the same session -> DIR/montage/clips/<id>/montage-v.mp4 + DIR/montage/render.json +
    DIR/montage/candidates.json (then `validate --out DIR/montage`; then the folder packages for posting)."""
    progress_line("montage", 0, 1, "making the kill montage")
    import clip_montage as mont
    ffmpeg, ffprobe = _tools(a)
    hits_path = a.hits or os.path.join(a.out, "detector-hits.jsonl")
    if not os.path.isfile(hits_path):
        raise ClipError("no detector hits: run `detect` on this recording first (or give --hits)")
    info = media_info(ffprobe, a.recording)
    hits, _ = sig.read_hits(hits_path, info["duration"])
    vrec = v_recording(a.recording, a.v_recording)
    if not vrec:
        raise ClipError("montage cuts the V canvas recording: none next to the H recording; give --v-recording")
    vinfo = media_info(ffprobe, vrec)
    if not vinfo["has_audio"]:
        raise ClipError("the V recording has no audio stream")
    ranking = load_config("ranking", a.ranking)
    cfg = load_config("montage", a.montage_config)
    frame = load_config("layouts", a.layouts_file)["output"]
    lim = rl.effective_limits(resolve_data_dir(a.data_dir))  # CL1 (D350): the user's length per reel type
    ex = _reel_extras(a, resolve_data_dir(a.data_dir))  # ED1 hook, ED2 captions (D352, D353)
    cfg = dict(cfg, minSec=lim["montage"]["minSec"], maxSec=lim["montage"]["maxSec"])
    # RP5 (D373): the learned mix, only with the flag self-learning on and a mix in use; None = plan exactly as before
    mix = lmix.load_mix(resolve_data_dir(a.data_dir))
    cfg = lmix.length_target(cfg, lim["montage"], mix, vrec)
    if mix:
        print(f"montage: learned mix in use (changed {mix.get('changedAt')}); montage length band "
              f"{cfg.get('learningBand', 'unchanged')}")
    matches, reel_doc = _reel_matches(a, hits_path, info["duration"])
    story_on = flag_on(resolve_data_dir(a.data_dir), cfg["story"]["flag"])  # RP2 (D361)
    if story_on:
        avoid = _live_clip_spans(a)
        plans = mont.plan_story_montages(hits, ranking, cfg, min(info["duration"], vinfo["duration"]), matches, avoid)
        print(f"montage: story montages ({len(avoid)} live-clip span(s) avoided where possible)")
    else:
        plans = mont.plan_montages(hits, ranking, cfg, min(info["duration"], vinfo["duration"]), matches)
    encoder = rnd.pick_encoder(a.encoder)
    out = os.path.join(a.out, "montage")
    os.makedirs(out, exist_ok=True)
    gs, _ = mont.groups(mont.drop_end_screens(hits, matches), ranking, cfg, mont._bounds(matches))
    sk = sum(len(g["kills"]) for g in gs if g["streak"])
    nk = sum(len(g["kills"]) for g in gs)
    print(f"montage: {nk} own kill(s): {sk} in {sum(1 for g in gs if g['streak'])} streak(s), {nk - sk} single; "
          f"{sum(m['kills'] for m in plans)} used in {len(plans)} montage(s)")
    reels = mont.match_reels(hits, ranking, cfg, matches, min(info["duration"], vinfo["duration"]))  # D315 rules, every own kill (D237)
    for m in matches:
        d = m["reel"]
        verdict = "REEL" if d["qualifies"] and not d.get("noReel") else "no reel"
        extra = f"; {d['noReel']}" if d.get("noReel") else ""
        print(f"montage: match {m['index']} {m['start']:.0f}-{m['end']:.0f} s: {verdict} ({d['reason']}{extra})")
    deaths = rank.death_spans(hits, ranking)  # ED1: a reel never opens on a death
    montage_jobs = _hook_jobs(plans, "montage", "M", lim["montage"], ex, deaths)
    reel_jobs = _hook_jobs(reels, "match-reel", "W", lim["match-reel"], ex, deaths)
    for _, r in reel_jobs:
        r["score"] = float(r["kills"])  # a match reel's score is its kill count
    reel_doc["reelLength"] = {"matchReel": lim["match-reel"], "montage": lim["montage"], "impactPlay": lim["impact-play"]}
    reel_doc["reels"] = [{"id": cid, "match": r["match"], "rules": r["rules"], "kills": int(r["score"]),
                          "pieces": r["pieces"], "pieceRounds": r.get("pieceRounds"), "part": r.get("part"),
                          "parts": r.get("parts"), "trimmed": r.get("trimmed"), "hook": r.get("hook")}
                         for cid, r in reel_jobs]
    # D326: impact-play reels (match-reels.json impactPlay), only while their flag is on (off by default)
    ip_spec = ((_gate_pack(a) or {}).get("matchReels") or {}).get("impactPlay")
    ip_on = bool(ip_spec) and flag_on(resolve_data_dir(a.data_dir), ip_spec.get("flag") or "impact-play-reels")
    try:  # the result banner's span ends one detector sample after its last read frame
        fps = float(load_json(os.path.join(os.path.dirname(hits_path), "detector-pass.json"))["config"]["fps"])
    except (OSError, ClipError, KeyError, TypeError, ValueError):
        fps = 1.0
    impacts = (mont.impact_play_reels(hits, matches, ip_spec, min(info["duration"], vinfo["duration"]),
                                      sample_sec=1.0 / fps if fps > 0 else 1.0,
                                      min_sec=lim["impact-play"]["minSec"]) if ip_on else [])
    impact_jobs = _hook_jobs(impacts, "impact-play", "I", lim["impact-play"], ex, deaths)
    reel_doc["impactPlay"] = {"flag": (ip_spec or {}).get("flag"), "on": ip_on,
                              "reels": [{"id": cid, "match": r["match"], "pieces": r["pieces"], "part": r.get("part"),
                                         "parts": r.get("parts"), "trimmed": r.get("trimmed"), "hook": r.get("hook")}
                                        for cid, r in impact_jobs]}
    write_json_atomic(os.path.join(out, MATCH_REELS), reel_doc)
    print(f"montage: {len(reels)} won-match reel(s) (rules: {MATCH_REELS})")
    if ip_on:
        print(f"montage: {len(impacts)} impact-play reel(s)")
    jobs = montage_jobs + reel_jobs + impact_jobs
    rows, failed = [], 0
    old_rows = []
    if getattr(a, "resume", False):  # D411: the rows of the reels an earlier run finished (kept with their decisions)
        try:
            old_rows = load_json(os.path.join(out, RENDER)).get("clips") or []
        except (OSError, ClipError, ValueError):
            old_rows = []
    def _write_render(clips):  # render.json with the rows given; failed is read when it is called
        write_json_atomic(os.path.join(out, RENDER), {
            "tool": "clipper.montage", "toolVersion": TOOL_VERSION, "createdAt": _now(),
            "recording": os.path.basename(a.recording), "vRecording": os.path.basename(vrec), "encoder": encoder,
            "vRecordingPath": vrec, "audioFadeMs": int(cfg["audioFadeMs"]),  # ED2: clipper.py recaption renders from these
            "reelHook": {"version": ex["hcfg"]["version"], "flag": rh.FLAG, "types": ex["hooks"]},
            "reelCaptions": {"version": ex["ccfg"]["version"], "flag": rcap.FLAG, "on": ex["cap_on"]},
            "reelTransition": {"flag": rt.FLAG, "use": ex["transition"]},
            "reelMusic": {"flag": rmu.FLAG, "on": bool(ex["music"]), "version": (ex["music"] or {}).get("version"),
                          "generator": (ex["music"] or {}).get("generator")},
            "reelTitle": {"flag": rti.FLAG, "on": bool(ex["title"]), "version": (ex["title"] or {}).get("version")},
            "reelThumbnail": {"flag": rth.FLAG, "on": bool(ex["thumb"]),
                              "version": (ex["thumb"] or {}).get("version")},
            "learningMix": {"flag": lmix.FLAG, "on": bool(mix), "changedAt": (mix or {}).get("changedAt"),
                            "lengthBand": cfg.get("learningBand")},
            "frame": frame, "montageVersion": cfg.get("version"), "montageStatus": cfg.get("status"),
            "game": _game(a), "failed": failed, "reelLength": lim, "clips": clips,
            "matchReels": {"file": MATCH_REELS, "matches": len(matches),
                           "qualified": sum(1 for m in matches if m["reel"]["qualifies"]), "reels": len(reels),
                           "impactPlayReels": len(impacts)},
        })

    for cid, m in jobs:
        wd = os.path.join(out, "clips", cid)
        os.makedirs(wd, exist_ok=True)
        typ = KIND_TYPE[cid[:1]]
        done =os.path.join(wd, "montage-v.mp4")
        kept = _resume_row(a, wd, cid, old_rows)
        if kept is not None:
            rows.append(kept)
            continue
        src_pieces = m["pieces"]
        tdoc, cinfo = _caption_reel(ffmpeg, vrec, m["pieces"], frame, wd, ex, m["seconds"])
        exr = lmix.reel_choices(ex, mix, cid, vrec)  # RP5: this reel's transition/title/music (ex as is without a mix)
        pk = _look_pick(exr, cid, os.path.basename(vrec))  # FX1: this reel's look
        sty, m, pk = _style_pick(ex, typ, m, pk, cid, os.path.basename(vrec))  # RS4: this reel's style (or None)
        # D411: the joins (each cross-faded join shortens the reel), the folder track and beat sync; captions follow
        m, tr, xd, mplan = _reel_timeline(exr, pk, m, typ, exr["transition"], bool(vinfo.get("has_audio", True)),
                                          cid, os.path.basename(vrec), style=sty)
        m, zoom, lut, strec = _style_render_plan(sty, m, xd, vrec, wd, captions=tdoc is not None)
        ass, fdir, cinfo = _caption_ass(tdoc, cinfo, src_pieces, m["pieces"], xd, frame, wd, ex)
        thumb, trec = _thumbnail(ffmpeg, vrec, m, typ, frame, wd, ex, matches)  # RP6
        ttl, tirec = _title(wd, m["pieces"], xd, frame, exr, pk)  # FX2
        mus, murec = _music(wd, m["pieces"], xd, tirec, exr, cid, os.path.basename(vrec), pk=pk, mplan=mplan)  # RP3/FX4
        mus, sfxrec = _with_sfx(wd, exr, tr, m["pieces"], xd, pk, mus)  # FX3
        def mk(enc, m=m, ass=ass, fdir=fdir, tr=tr, thumb=thumb, ttl=ttl, mus=mus, typ=typ):
            return mont.render_argv(ffmpeg, vrec, m["pieces"], frame, rnd.ENCODERS[enc], rnd.AUDIO,
                                    int(cfg["audioFadeMs"]), "montage-v.mp4.part",
                                    audio_tracks=max(1, vinfo["audio_tracks"]), max_sec=lim[typ]["maxSec"], captions=ass,
                                    fontsdir=fdir, transition=tr, thumbnail=thumb, title=ttl, music=mus, zoom=zoom, lut=lut)
        if os.path.isfile(done):
            # Codex verify (D411): a finished file with no stored row (the run stopped between the file and its row)
            # is never kept with guessed decisions: it is rendered again with this run's decisions
            if getattr(a, "resume", False):
                print(f"montage {cid}: a reel file without its row: rendered again (--resume)")
            os.remove(done)
        # Codex verify: this reel's old row is dropped from render.json before it renders, so a stop at any point never
        # leaves an old row next to a new file
        _write_render(rows + [x for x in old_rows if x.get("id") != cid and x.get("id") not in {y["id"] for y in rows}])
        r, _ = _render_job(mk, encoder, wd, "montage-v.mp4.part", f"montage {cid}")
        _drop_fonts(wd)
        rti.cleanup(wd)
        rmu.cleanup(wd)
        rsfx.cleanup(wd)
        _style_cleanup(wd)
        files, errors = [], []
        hook = m.get("hook") or {"on": False}
        if r.returncode == 0:
            if os.path.isfile(os.path.join(wd, "montage-v.mp4.part")):
                os.replace(os.path.join(wd, "montage-v.mp4.part"), done)
            hook = _hook_score(ffmpeg, wd, "montage-v.mp4", m, typ, ex)
            line = _hook_line(cid, hook)
            if line:
                print(line)
            files.append({"layout": "montage-v", "file": "montage-v.mp4", "geometry": "canvas",
                          "sourceAudioTracks": vinfo["audio_tracks"], **({"thumbnail": True} if thumb else {})})
            kills = m.get("kills", sum(p["kills"] for p in m["pieces"]))
            if m.get("part"):
                print(f"montage {cid}: part {m['part']} of {m['parts']}")
            for t in m.get("trimmed") or []:
                print(f"montage {cid}: one piece of {t['from'][1] - t['from'][0]:.1f} s trimmed to "
                      f"{t['to'][1] - t['to'][0]:.1f} s around its peak (length setting)")
            print(f"montage {cid}: {m['seconds']:.1f} s, {len(m['pieces'])} piece(s), {kills} kill(s) "
                  f"({m.get('streakKills', '-')} in {m.get('streaks', '-')} streak(s), {m.get('singleKills', '-')} single), "
                  f"score {m['score']:g}")
        else:
            try:
                os.remove(os.path.join(wd, "montage-v.mp4.part"))
            except OSError:
                pass
            errors.append({"layout": "montage-v", "error": r.stderr.strip()[-300:]})
            failed += 1
            eprint(f"montage {cid}: FAILED")
        out_sec = _pieces_out_sec(m, xd, thumb, lim[typ]["maxSec"])
        rows.append({"id": cid, "start": 0.0, "end": out_sec, "score": m["score"], "labels": m["labels"],
                     "transition": dict(tr, joinSec=xd) if xd else None, "thumbnail": trec, "title": tirec, "music": murec,
                     "look": pk, "sfx": sfxrec, "style": strec,
                     "pieces": m["pieces"], "part": m.get("part"), "parts": m.get("parts"),
                     # the overlaps of a cross fade can take a reel planned at its shortest length below it
                     "trimmed": m.get("trimmed"), "belowMin": m.get("belowMin") or (out_sec < lim[typ]["minSec"]) or None, "kills": m.get("kills"), "streakKills": m.get("streakKills"),
                     "singleKills": m.get("singleKills"), "captions": cinfo, "hook": hook,
                     **({"story": m["story"]} if m.get("story") else {}),
                     **({"learning": exr["learning"]} if exr.get("learning") else {}),
                     "files": files, "errors": errors, "fileStamp": _file_stamp(done) if files else None})
        _look_remember(exr, pk if files else None, track=(mplan or {}).get("track", {}).get("id"))
        # Codex verify (D411): each reel's row is saved (temp + rename) as soon as the reel is done, with the stored rows
        # of the reels not reached yet, so a stopped run never leaves a finished reel without its decisions
        _write_render(rows + [x for x in old_rows if x.get("id") not in {y["id"] for y in rows}])
    _write_render(rows)
    # candidates.json in the montage folder makes it a clip run folder for posting (services/posting packageRun):
    # times are on the montage's own timeline (0 .. seconds); anchor = the first kill (cover frame); the source
    # recording times are in `pieces`
    pre = float(cfg["preSec"])
    write_json_atomic(os.path.join(out, CANDIDATES), {
        "tool": "clipper.montage", "toolVersion": TOOL_VERSION, "createdAt": _now(),
        "recording": os.path.basename(a.recording),
        "recordStartUtc": sig.recording_start(a.recording, a.record_start).isoformat().replace("+00:00", "Z"),
        "candidates": [{"id": r["id"], "rank": i, "kind": {"W": "won-match", "I": "impact-play"}.get(r["id"][:1], "montage"),
                        "start": 0.0, "end": r["end"], "anchor": min(pre, r["end"]), "score": r["score"],
                        "labels": r["labels"], "pieces": r["pieces"],
                         "part": r.get("part"), "parts": r.get("parts"), "hook": r.get("hook")}
                       for i, r in enumerate((r for r in rows if r["files"]), 1)],
    })
    print(f"montage: {len(montage_jobs)} montage video(s), {len(reel_jobs)} won-match reel video(s), {failed} failed")
    sub = argparse.Namespace(**{**vars(a), "out": out})
    rc = cmd_validate(sub)
    if getattr(a, "publish", None):
        _publish(sub, out, run_name=os.path.basename(a.out), rec_start=a.recording)
    return rc


# ---------------------------------------------------------------- recaption (ED2, D353)

def _recaption_music(data_dir, wd, row, pieces, xd, rid):
    """The music of a reel rendered again by recaption (same timeline). A folder track: the stored plan rendered again
    from the same file. Gone (or unreadable): the made-here bed, and the record says so. -> (music dict for
    render_argv or None, new record or None = unchanged)."""
    mrec = row["music"]
    cfg_m = rmu.load_config()
    if mrec.get("source") == "folder":
        try:
            mcfg = mlib.load_config()
            lib = mlib.load_library(data_dir, mcfg)
            track = next((t for t in mlib.usable(lib) if t["id"] == mrec.get("track")), None)
            if track is not None:
                return mlib.prepare(wd, mrec, track, mcfg, cfg_m["duck"]), None
            why = "the folder track is gone"
        except Exception as e:  # noqa: BLE001 - a broken track falls back to the made-here bed
            why = f"the folder track could not be read ({type(e).__name__})"
        eprint(f"recaption {rid}: {why}; the made-here bed is used")
        try:
            rec = rmu.plan(pieces, xd, None, cfg_m, rmu.seed_for(rid, "recaption"))
            if rec is None:
                return None, dict(mrec, fallback=why, used="none")
            return rmu.prepare(wd, rec, cfg_m), dict(rec, source="made-here", fallback=why, was=mrec.get("track"))
        except (OSError, ClipError, KeyError, TypeError, ValueError) as e:
            eprint(f"recaption {rid}: the music is not kept ({str(e)[-100:]})")
            return None, dict(mrec, fallback=why, used="none")
    try:  # RP3: the same made-here bed (its seed) on the same timeline
        rec = rmu.plan(pieces, xd, row.get("title") if isinstance(row.get("title"), dict) else None, cfg_m,
                       int(mrec["seed"]))
        return (rmu.prepare(wd, rec, cfg_m) if rec else None), None
    except (OSError, ClipError, KeyError, TypeError, ValueError) as e:
        eprint(f"recaption {rid}: the music is not kept ({str(e)[-100:]})")
        return None, None


def cmd_recaption(a):
    """Renders one reel again with its (edited) transcript: DIR/clips/<id>/transcript.json -> captions.ass -> the
    reel's canvas file, cut from the source recording again (render.json vRecordingPath, or the live clip's
    sourcePath, or --source). The threshold is not applied again: the transcript's show values are used as they are.
    A published copy of the reel (published.json) is replaced too. Needs the reel-captions flag."""
    import clip_montage as mont  # noqa: PLC0415
    data_dir = resolve_data_dir(a.data_dir)
    ccfg = rcap.load_config()
    if not rcap.on(data_dir, ccfg):
        raise ClipError(f"captions are off (the '{rcap.FLAG}' flag)")
    ffmpeg, ffprobe = _tools(a)
    rpath = os.path.join(a.out, RENDER)
    rdoc = load_json(rpath)
    row = next((c for c in rdoc.get("clips") or [] if c.get("id") == a.id), None)
    if row is None:
        raise ClipError(f"no reel {a.id} in {RENDER}")
    wd = os.path.join(a.out, "clips", a.id)
    tpath = os.path.join(wd, rcap.TRANSCRIPT)
    if not os.path.isfile(tpath):
        raise ClipError(f"no {rcap.TRANSCRIPT} for {a.id} (it is made when the reel renders with captions on)")
    tr = load_json(tpath)
    src = a.source or rdoc.get("vRecordingPath") or row.get("sourcePath")
    if not src or not os.path.isfile(src):
        raise ClipError("the source recording of this reel is gone: give --source")
    canvas = next((f for f in row.get("files") or [] if f.get("geometry") == "canvas" or f.get("layout") in
                   ("montage-v", "stream-v")), None)
    if canvas is None:
        raise ClipError(f"reel {a.id} has no canvas file to render again")
    pieces = row.get("pieces") or [{"start": float(row["start"]), "end": float(row["end"]), "kills": 0}]
    # D411: the reel keeps its transitions and its timeline; the captions are laid on it (an older transcript, made on
    # the pieces back to back, is moved onto it first)
    trn = row.get("transition") or None
    xd = float((trn or {}).get("joinSec") or 0.0)
    tr_now = {k: v for k, v in trn.items() if k != "joinSec"} if trn else None
    tr = rcap.retime(tr, pieces, pieces, xd)
    write_json_atomic(tpath, tr)
    seconds = round(sum(float(p["end"]) - float(p["start"]) for p in pieces) - xd * (len(pieces) - 1), 3)
    style = rcap.load_style(ccfg)
    safe = caps.safe_area(load_config("targets", a.targets))
    ass, fdir, n = rcap.write_ass(tr, rdoc["frame"], safe, style, wd, seconds)
    fade = int(rdoc.get("audioFadeMs") or load_config("montage", None)["audioFadeMs"])
    name = canvas["file"]
    # the reel keeps its own length: the cut is the existing file's length (or none), never the current maximum
    # setting, which may have been lowered since the reel was made
    old = os.path.join(wd, name)
    max_sec = (media_info(ffprobe, old).get("duration") or None) if os.path.isfile(old) else None
    # RP6: the reel keeps its start frame when it had one and the PNG is still there
    thumb = (row.get("thumbnail") or {}).get("file")
    thumb = thumb if thumb == rth.PNG and os.path.isfile(os.path.join(wd, thumb)) else None
    sinfo = media_info(ffprobe, src)
    # FX2: the reel keeps its name display at the same times (same timeline); an RP4 record becomes a kinetic name
    ttl = None
    if isinstance(row.get("title"), dict):
        try:
            cfg_t = rti.load_config()
            rec = rti.restyle(dict(row["title"]), cfg_t, rdoc["frame"], safe)
            ttl = rti.prepare(wd, rec, cfg_t)
        except (OSError, ClipError, KeyError, TypeError, ValueError) as e:
            eprint(f"recaption {a.id}: the name is not kept ({str(e)[-100:]})")
    mus = None
    if isinstance(row.get("music"), dict) and sinfo.get("has_audio"):
        mus, mrow = _recaption_music(data_dir, wd, row, pieces, xd, a.id)
        if mrow is not None:
            row["music"] = mrow
    if tr_now and isinstance(row.get("sfx"), dict) and sinfo.get("has_audio"):  # FX3: the join sounds again
        try:
            f = rsfx.prepare(wd, tr_now, pieces, xd, int((row.get("look") or {}).get("seed") or 0))
            if f:
                mus = dict(mus or {}, sfx=f)
        except (OSError, ValueError) as e:
            eprint(f"recaption {a.id}: the join sounds are not kept ({str(e)[-100:]})")
    argv = mont.render_argv(ffmpeg, src, pieces, rdoc["frame"], rnd.ENCODERS[rnd.pick_encoder(a.encoder)], rnd.AUDIO,
                            fade, name + ".part",
                            audio_tracks=max(1, int(sinfo.get("audio_tracks") or 1)) if sinfo.get("has_audio") else 0,
                            max_sec=max_sec, captions=ass, fontsdir=fdir, transition=tr_now, thumbnail=thumb, title=ttl,
                            music=mus)
    r = rnd.run_tool(argv, cwd=wd, timeout=1800)
    _drop_fonts(wd)
    rti.cleanup(wd)
    rmu.cleanup(wd)
    rsfx.cleanup(wd)
    if r.returncode != 0:
        try:
            os.remove(os.path.join(wd, name + ".part"))
        except OSError:
            pass
        raise ClipError(f"recaption {a.id} failed: {r.stderr.strip()[-300:]}")
    os.replace(os.path.join(wd, name + ".part"), os.path.join(wd, name))
    row["captions"] = dict(row.get("captions") or {}, **rcap.summary(tr, n), status="ok", burned=bool(n),
                           transcript=rcap.TRANSCRIPT, recaptionedAt=_now())
    write_json_atomic(rpath, rdoc)
    replaced = 0
    ppath = os.path.join(a.out, pub.PUBLISHED)
    if os.path.isfile(ppath):
        for f in load_json(ppath).get("files") or []:
            if f.get("id") == a.id and f.get("layout") == canvas.get("layout") and os.path.isfile(f.get("file", "")):
                tmp = f["file"] + ".part"
                pub._link_or_copy(os.path.join(wd, name), tmp)
                os.replace(tmp, f["file"])
                replaced += 1
    print(f"recaption {a.id}: {n} caption card(s) burned, {replaced} published copy(ies) replaced")
    return 0


# ---------------------------------------------------------------- publish / tidy

def _game(a):
    """Game id of the detector pass in --out (its parent for a montage folder), else the default game."""
    for d in (a.out, os.path.dirname(a.out)):
        p = os.path.join(d, "detector-pass.json")
        if os.path.isfile(p):
            try:
                g = load_json(p).get("game")
                if g:
                    return g
            except ClipError:
                pass
    try:
        return load_json(os.path.join(CLIP_DATA, "detector-pass.json")).get("defaultGame") or "game"
    except ClipError:
        return "game"


def _publish(a, work, run_name=None, rec_start=None):
    progress_line("publish", 0, 1, "copying the finished clips to your clips folder")
    lay_doc = load_config("layouts", a.layouts_file)
    ranking = load_config("ranking", a.ranking)
    start = None
    if rec_start:
        try:
            start = sig.recording_start(rec_start, getattr(a, "record_start", None)).astimezone().replace(tzinfo=None)
        except ClipError:
            start = None
    rows = pub.publish(work, a.publish, resolve_data_dir(a.data_dir), _game(argparse.Namespace(out=work)),
                       {x["id"]: x for x in lay_doc["layouts"]}, ranking.get("detectorWeights"), run_name, start)
    for r in rows:
        print(f"publish: {os.path.basename(r['file'])} ({r['how']})")
    print(f"publish: {len(rows)} finished video(s) in {a.publish}")
    return rows


def cmd_publish(a):
    a.publish = os.path.abspath(a.to)
    rdoc = load_json(os.path.join(a.out, RENDER))
    rec = rdoc.get("recording") if rdoc.get("recording") != "live-saves" else None
    _publish(a, a.out, rec_start=rec)
    return 0


def cmd_tidy(a):
    lay_doc = load_config("layouts", a.layouts_file)
    ranking = load_config("ranking", a.ranking)
    data_dir = resolve_data_dir(a.data_dir)
    game = _game(argparse.Namespace(out=os.path.join(CLIP_DATA, "-")))
    plan = pub.tidy_plan(a.recordings, a.clips, data_dir, game, {x["id"]: x for x in lay_doc["layouts"]},
                         ranking.get("detectorWeights"))
    for x in plan:
        line = f"{x['action'].upper():7s} {x['src']}"
        if x.get("dst"):
            line += "\n        -> " + x["dst"]
        print(line + "\n        (" + x["why"] + ")")
    counts = {k: sum(1 for x in plan if x["action"] == k) for k in ("rename", "move", "delete", "keep", "leave")}
    tail = "" if a.apply else " (dry run: nothing changed; add --apply to act)"
    print("tidy: " + ", ".join(f"{v} {k}" for k, v in counts.items()) + tail)
    if a.apply:
        r = pub.apply_plan(plan, a.clips)
        print(f"tidy: {len(r['done'])} done, {len(r['skipped'])} skipped")
        for x in r["skipped"]:
            print(f"SKIPPED {x['src']} ({x['reason']})")
    return 0


def cmd_run(a):
    steps = ((cmd_detect,) if a.detect else ()) + (cmd_candidates, cmd_gate, cmd_render, cmd_validate)
    rc = 0
    for step in steps:
        rc = step(a)
        if rc and step is not cmd_validate:
            return rc
    if a.publish:  # the passing short clips, even when another file failed validation
        _publish(a, a.out, rec_start=a.recording)
    if a.montage:  # a montage that cannot be made never undoes the short clips already published
        try:
            rc = rc or cmd_montage(a)
        except ClipError as e:
            eprint(f"montage: not made: {e}")
    if getattr(a, "long_video", False):  # D406: last; its outcome never changes the exit code (see DIR/long/long.json)
        _long_video(a)
    return rc


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _iso_ms(ts):
    """ISO UTC with milliseconds and a Z (the live saves' `at` format, so string order is time order)."""
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


# ---------------------------------------------------------------- cli

def build_parser():
    p = argparse.ArgumentParser(prog="clipper", description="F6 post-stream clipper (flag: clip-pipeline)")
    p.add_argument("--data-dir")
    p.add_argument("--ffmpeg")
    p.add_argument("--ffprobe")
    p.add_argument("--ranking")
    p.add_argument("--layouts-file")
    p.add_argument("--targets")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp, recording=True):
        sp.add_argument("--out", required=True)
        if recording:
            # absolute: ffmpeg renders run in a work folder, where a relative path does not resolve
            sp.add_argument("--recording", required=True, type=os.path.abspath)

    def cand_args(sp):
        sp.add_argument("--markers", action="append", default=[])
        sp.add_argument("--chat-db")
        sp.add_argument("--hits")
        sp.add_argument("--record-start")
        sp.add_argument("--no-audio", action="store_true")

    def render_args(sp):
        sp.add_argument("--layouts")
        sp.add_argument("--only")
        sp.add_argument("--v-recording", type=os.path.abspath,
                        help="V canvas recording for source-v layouts (default: the '-v-' sibling of --recording)")
        sp.add_argument("--encoder", default="auto")
        sp.add_argument("--captions", default="none", choices=caps.BACKENDS)
        sp.add_argument("--whisper-bin")
        sp.add_argument("--whisper-model")
        sp.add_argument("--language")

    def detect_args(sp):
        sp.add_argument("--game")
        sp.add_argument("--detector-config")
        sp.add_argument("--profile")
        sp.add_argument("--layout")
        sp.add_argument("--project", type=os.path.abspath,
                        help="Ujwalam project of a canvas recording: scan only its game layer's area (D235)")
        sp.add_argument("--fps", type=float)
        sp.add_argument("--threads", type=int, default=4, choices=range(1, 5), metavar="1-4")

    s = sub.add_parser("detect"); common(s); detect_args(s); s.set_defaults(fn=cmd_detect)
    s = sub.add_parser("candidates"); common(s); cand_args(s); s.set_defaults(fn=cmd_candidates)
    s = sub.add_parser("gate"); common(s); s.add_argument("--hits"); s.add_argument("--game")
    s.add_argument("--detector-config"); s.set_defaults(fn=cmd_gate)
    s = sub.add_parser("render"); common(s); render_args(s); s.set_defaults(fn=cmd_render)
    s = sub.add_parser("validate"); common(s, recording=False); s.add_argument("--no-decode", action="store_true")
    s.set_defaults(fn=cmd_validate)
    def publish_arg(sp):
        sp.add_argument("--publish", type=os.path.abspath,
                        help="clips folder: finished, validated videos are linked there under the naming convention")

    s = sub.add_parser("run"); common(s); cand_args(s); render_args(s); s.add_argument("--no-decode", action="store_true")
    detect_args(s); s.add_argument("--detect", action="store_true"); publish_arg(s)
    s.add_argument("--montage", action="store_true", help="also make kill montages (needs the V recording)")

    s.add_argument("--montage-config")
    s.add_argument("--long-video", action="store_true", help="also make the long highlights video of --recording (D406)")
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("long", help="the long highlights video of --recording only (D406; its own job in the studio)")
    common(s); cand_args(s); render_args(s); detect_args(s); publish_arg(s)
    s.add_argument("--no-decode", action="store_true"); s.add_argument("--montage-config")
    s.set_defaults(fn=cmd_long)

    s = sub.add_parser("montage"); common(s)
    s.add_argument("--hits"); s.add_argument("--montage-config")
    s.add_argument("--whisper-bin"); s.add_argument("--whisper-model")  # ED2 captions (flag reel-captions)
    s.add_argument("--v-recording", type=os.path.abspath); s.add_argument("--encoder", default="auto")
    s.add_argument("--record-start"); s.add_argument("--no-decode", action="store_true"); publish_arg(s)
    s.add_argument("--resume", action="store_true",
                   help="keep each reel an earlier, stopped run of this folder finished; render only the missing ones")
    s.set_defaults(fn=cmd_montage)
    s = sub.add_parser("recaption", help="render one reel again with its edited transcript (ED2, flag reel-captions)")
    common(s, recording=False)
    s.add_argument("--id", required=True); s.add_argument("--source", type=os.path.abspath)
    s.add_argument("--encoder", default="auto"); s.set_defaults(fn=cmd_recaption)
    s = sub.add_parser("publish"); common(s, recording=False)
    s.add_argument("--to", required=True, help="the clips folder"); s.set_defaults(fn=cmd_publish)
    s = sub.add_parser("tidy")
    s.add_argument("--recordings", type=os.path.abspath); s.add_argument("--clips", type=os.path.abspath)
    g = s.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="list only (the default)")
    g.add_argument("--apply", action="store_true", help="do the listed moves, renames and deletes")
    s.set_defaults(fn=cmd_tidy)
    s = sub.add_parser("live-review"); common(s, recording=False)
    s.add_argument("--saves", required=True, type=os.path.abspath, help="live clipper session folder (saves.jsonl)")
    s.add_argument("--since", help="ISO UTC time: saves at or after it only")
    s.add_argument("--until", help="ISO UTC time: saves at or before it only")
    s.add_argument("--layouts"); s.add_argument("--encoder", default="auto")
    s.add_argument("--matches", type=os.path.abspath,
                   help="matches.json of the same session's recording (`run`): saves in skipped matches are dropped")
    s.add_argument("--recording", type=os.path.abspath,
                   help="H recording of the same stream: its matches (detect + gate) drop saves in skipped matches")
    s.add_argument("--record-start"); detect_args(s)
    s.add_argument("--no-decode", action="store_true"); publish_arg(s)
    s.add_argument("--drop-used-saves", action="store_true",
                   help="delete the window's replay saves (live clipper intermediates) once every clip rendered")
    s.add_argument("--montage", action="store_true",
                   help="then kill montages + match reels of --recording, cut from the V recording (D322 proposed)")
    s.add_argument("--v-recording", type=os.path.abspath,
                   help="V canvas recording for --montage (default: the '-v-' sibling of --recording)")
    s.add_argument("--montage-config")

    s.add_argument("--whisper-bin"); s.add_argument("--whisper-model")  # ED2 captions (flag reel-captions)
    s.add_argument("--long-video", action="store_true", help="also make the long highlights video of --recording (D406)")
    s.set_defaults(fn=cmd_live_review)

    return p


def main(argv=None):
    a = build_parser().parse_args(argv)
    try:
        data_dir = resolve_data_dir(a.data_dir)
        if not clips_allowed(data_dir):
            eprint(f"clipper: clips are off (Settings > Clips, or the '{FLAG}' flag)")
            return EXIT_FLAG_OFF
        if getattr(a, "out", None):
            a.out = os.path.abspath(a.out)
            check_out_dir(a.out, corpus_dir())
        lower_own_priority()
        contain_children()  # ffmpeg and other children end with this process, however it ends (D311 proposed)
        end_tree_when_parent_gone()  # started by Ujwalam: ends with it, ffmpeg children included (D311 proposed)
        return a.fn(a)
    except ClipError as e:
        eprint(f"clipper: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
