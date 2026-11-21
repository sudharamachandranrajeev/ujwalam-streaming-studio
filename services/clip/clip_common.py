# SPDX-License-Identifier: GPL-3.0-or-later
"""Shared helpers for the F6 post-stream clip pipeline (docs/plan/2026-11-03-f6-clip-pipeline-plan.md).

Stdlib only. Covers:
  - the feature flag gate (same rules as services/flags/index.mjs: an id missing from data/flags.json is off;
    <dataDir>/flags.local.json overrides the committed default; only booleans count),
  - data-dir resolution (--data-dir, else paths.event_core_data in data/profile.local.json),
  - ffmpeg / ffprobe lookup (explicit path, else PATH; never downloaded),
  - laptop budget: children at below-normal priority on Windows, ffmpeg threads capped,
  - output safety: never inside the clips corpus; inside the repository only when gitignored.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone

# No console window on Windows (D191): every subprocess call passes **NO_WINDOW.
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

PARENT_PIPE_ENV = "UJWALAM_PARENT_PIPE"
_JOB = None  # the kill-on-close job of contain_children(); held (never closed) for the life of this process


def contain_children():
    """Windows (user 2026-11-09, D311 proposed): puts this process in a new job object that kills every member when
    its last handle closes. Children started from now on (ffmpeg) are members too, so however this process ends
    (finished, crashed, or killed by the launcher: a plain kill ends only this process) none of them runs on unseen.
    Returns True when the job is in place; False elsewhere or when Windows refused (the parent pipe still applies)."""
    global _JOB
    if os.name != "nt":
        return False
    if _JOB is not None:
        return True
    import ctypes
    job = kill_on_close_job(ctypes.WinDLL("kernel32").GetCurrentProcess())
    if job is None:
        return False
    _JOB = job
    return True


def _k32():
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    return k32


def kill_on_close_job(process_handle):
    """Windows: a new job object that kills every member when its last handle closes, with the process (a handle)
    in it; children it starts later are members too. Returns the job handle, or None elsewhere or when Windows
    refused. end_job() ends every member at once (the whole tree, also when the first process already exited)."""
    if os.name != "nt" or not process_handle:
        return None
    import ctypes
    from ctypes import wintypes
    from ctypes import wintypes

    class BASIC(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

    class EXTENDED(ctypes.Structure):
        _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k32 = _k32()
    job = k32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = EXTENDED()
    info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)) or \
            not k32.AssignProcessToJobObject(job, wintypes.HANDLE(int(process_handle))):  # 9: extended limits
        k32.CloseHandle(job)
        return None
    return job


def end_job_members(job):
    """End every process of a kill_on_close_job() job now; the job stays open. No-op for None."""
    if job is not None:
        _k32().TerminateJobObject(job, 1)


def end_job(job):
    """End every process of a kill_on_close_job() job and close it. No-op for None."""
    if job is None:
        return
    k32 = _k32()
    k32.TerminateJobObject(job, 1)
    k32.CloseHandle(job)


def end_own_tree(pid=None, run=None):
    """Ends this process and every process it started (ffmpeg, workers). Windows: taskkill /T /F from System32, no
    console window (D191); elsewhere SIGKILL to the process. Never returns when it works."""
    pid = os.getpid() if pid is None else pid
    try:
        if os.name == "nt":
            root = os.environ.get("SystemRoot", "")
            exe = os.path.join(root, "System32", "taskkill.exe") if root else ""
            if exe and os.path.isfile(exe):
                (run or subprocess.run)([exe, "/T", "/F", "/PID", str(pid)], capture_output=True, timeout=15, **NO_WINDOW)
    finally:
        # Always: taskkill missing, timing out or failing must not leave the job running unseen. The kill-on-close
        # job (contain_children) then ends ffmpeg with us.
        os._exit(1)


def _take_stdin_pipe():
    """The watcher's own copy of the parent pipe; fd 0 (and the Windows standard input handle) become NUL.
    Windows: a blocking read on a synchronous pipe blocks every other call on that handle, and subprocess duplicates
    the standard input handle for each child it starts. With the watcher reading stdin, the first ffprobe/ffmpeg
    start hung forever (2026-11-10: live-review stuck 38+ min before its first frame). The copy is not inheritable,
    so children never see the pipe."""
    fd = os.dup(0)
    nul = os.open(os.devnull, os.O_RDONLY)
    try:
        os.dup2(nul, 0)
    finally:
        os.close(nul)
    try:
        sys.stdin = open(os.devnull, encoding="utf-8")
    except OSError:
        pass
    return os.fdopen(fd, "rb", buffering=0)


def end_tree_when_parent_gone(env=None, stdin=None, on_gone=None):
    """Parent pipe (D234; user 2026-11-09, D311 proposed): with UJWALAM_PARENT_PIPE=1 the launcher holds our stdin as
    a pipe. End-of-file means Ujwalam is gone (closed, crashed or hard-killed); the clip job then ends itself and its
    ffmpeg children, so nothing runs on unseen. Returns the watcher thread, or None without the env marker."""
    import threading
    if (env if env is not None else os.environ).get(PARENT_PIPE_ENV) != "1":
        return None
    src = stdin if stdin is not None else _take_stdin_pipe()
    gone = on_gone or end_own_tree

    def read():
        try:
            while src.read(64):
                pass
        except (OSError, ValueError):
            pass
        gone()

    t = threading.Thread(target=read, name="parent-pipe", daemon=True)
    t.start()
    return t

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))
FLAGS_FILE = os.path.join(REPO_ROOT, "data", "flags.json")
CLIP_DATA = os.path.join(REPO_ROOT, "data", "clip")
PROFILE_FILE = os.path.join(REPO_ROOT, "data", "profile.local.json")
FLAG_ID = re.compile(r"^[a-z][a-z0-9-]{0,47}$")
FLAG = "clip-pipeline"
LOCAL_FLAGS = "flags.local.json"

# Laptop budget (user instruction 2026-10-27): about 4 threads, below-normal priority, one heavy job at a time.
FFMPEG_THREADS = 4

EXIT_FLAG_OFF = 3
EXIT_ON_AIR = 4  # a job stopped because a stream or recording started (or that could not be told): run it again later


class ClipError(Exception):
    """A user-facing failure (bad input, missing tool). The CLI prints the message and exits 1."""


# ---------------------------------------------------------------- json

def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise ClipError(f"missing file: {os.path.basename(path)}") from None
    except ValueError:
        raise ClipError(f"not valid JSON: {os.path.basename(path)}") from None


def write_json_atomic(path, obj):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def load_config(name, path=None):
    """Loads data/clip/<name>.json (or an explicit path)."""
    return load_json(path or os.path.join(CLIP_DATA, f"{name}.json"))


# ---------------------------------------------------------------- flags

def flag_definitions(defs_file=FLAGS_FILE):
    j = load_json(defs_file)
    if not isinstance(j, dict) or not isinstance(j.get("flags"), list):
        raise ClipError("flags: bad definitions file")
    out = {}
    for f in j["flags"]:
        if not isinstance(f, dict) or not isinstance(f.get("id"), str) or not FLAG_ID.match(f["id"]):
            raise ClipError("flags: bad id")
        if not isinstance(f.get("default"), bool):
            raise ClipError(f"flags: bad entry {f['id']}")
        out[f["id"]] = f["default"]
    return out


SETTINGS_FILE = "settings.json"
CLIP_MODES = ("ask", "after", "while", "off")
WORKER_FILE = os.path.join("clips", "live-worker.json")
WORKER_FRESH_SEC = 30.0


def clip_settings(data_dir):
    """The user's clip choices from <data>/settings.json (D284): {"recording": mode, "live": mode}; "ask" when unset."""
    out = {"recording": "ask", "live": "ask"}
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    if isinstance(c, dict):
        for k in out:
            if c.get(k) in CLIP_MODES:
                out[k] = c[k]
    return out


MATCH_GATE_DEFAULTS = {"top3": True, "minKills": None}
MIN_KILLS_RANGE = (1, 200)


def match_gate_settings(data_dir):
    """The match gate (D286 proposed) from <data>/settings.json clips.matchGate: {"top3": bool, "minKills": int 1..200
    or None}. Missing or invalid values fall back to the defaults (top3 on, kills rule off), as user-settings.mjs."""
    out = dict(MATCH_GATE_DEFAULTS)
    if not data_dir:
        return out
    try:
        j = load_json(os.path.join(data_dir, SETTINGS_FILE))
    except (OSError, ClipError):
        return out
    c = j.get("clips") if isinstance(j, dict) else None
    g = c.get("matchGate") if isinstance(c, dict) else None
    if not isinstance(g, dict):
        return out
    if isinstance(g.get("top3"), bool):
        out["top3"] = g["top3"]
    k = g.get("minKills")
    if k is None or (isinstance(k, int) and not isinstance(k, bool) and MIN_KILLS_RANGE[0] <= k <= MIN_KILLS_RANGE[1]):
        out["minKills"] = k
    return out


PROGRESS_PREFIX = "ujwalam-progress "
# publish and montage write one line when they start and none while they work (unmeasured: the studio's stall warning
# does not count their silence; services/studio-ui/record-clips.mjs STAGE_TEXT, 2026-11-10).
PROGRESS_STAGES = ("detect", "candidates", "render", "validate", "review", "gate", "publish", "montage", "long")  # long: D406


def progress_line(stage, done, total, note=""):
    """One progress line for the UI (contract shared with the studio): on stderr,
    ujwalam-progress {"stage":"<stage>","done":<int>,"total":<int>,"note":"<short plain text, no names>"}"""
    if stage not in PROGRESS_STAGES:
        raise ValueError(f"unknown progress stage {stage}")
    note = " ".join(str(note or "").split())[:120]
    line = PROGRESS_PREFIX + json.dumps({"stage": stage, "done": int(done), "total": int(total), "note": note},
                                        separators=(",", ":"), ensure_ascii=True)
    print(line, file=sys.stderr, flush=True)
    return line


def clips_allowed(data_dir):
    """The clipper may run when the developer flag is on or the user chose any clip mode other than off (D284)."""
    return flag_on(data_dir, FLAG) or any(v != "off" for v in clip_settings(data_dir).values())


def worker_wanted(data_dir, now=None):
    """True while the launcher asks the live clipper to watch (the user chose "while recording" or "while live" and
    that is happening now): <data>/clips/live-worker.json {"on": true, "atMs": ...}, ignored when older than 30 s."""
    try:
        j = load_json(os.path.join(data_dir, WORKER_FILE))
    except (OSError, ClipError):
        return False
    if not isinstance(j, dict) or j.get("on") is not True or not isinstance(j.get("atMs"), (int, float)):
        return False
    now = time.time() if now is None else now
    return abs(now - j["atMs"] / 1000.0) <= WORKER_FRESH_SEC


def flag_on(data_dir, flag_id=FLAG, defs_file=FLAGS_FILE):
    """True when the flag is on: the local override if it is a boolean, else the committed default."""
    defs = flag_definitions(defs_file)
    if flag_id not in defs:
        return False
    if data_dir:
        try:
            j = load_json(os.path.join(data_dir, LOCAL_FLAGS))
        except (OSError, ClipError):
            j = None
        v = j.get("flags", {}).get(flag_id) if isinstance(j, dict) and isinstance(j.get("flags"), dict) else None
        if isinstance(v, bool):
            return v
    return defs[flag_id]


def resolve_data_dir(arg=None, profile=PROFILE_FILE):
    """--data-dir, else paths.event_core_data from the local profile (the studio and event core share it)."""
    if arg:
        return os.path.abspath(arg)
    try:
        v = load_json(profile).get("paths", {}).get("event_core_data")
    except (OSError, ClipError, AttributeError):
        v = None
    if isinstance(v, str) and v and not (v.startswith("<") and v.endswith(">")):
        return os.path.abspath(os.path.join(REPO_ROOT, v))
    return None


def corpus_dir(profile=PROFILE_FILE):
    try:
        v = load_json(profile).get("paths", {}).get("clips_corpus")
    except (OSError, ClipError, AttributeError):
        return None
    if isinstance(v, str) and v and not (v.startswith("<") and v.endswith(">")):
        return v
    return None


# ---------------------------------------------------------------- safety

def _real(p):
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def is_inside(path, root):
    return bool(root) and (_real(path) + os.sep).startswith(_real(root) + os.sep)


def check_out_dir(path, corpus=None):
    """The output folder must not be inside the clips corpus; inside the repository it must be gitignored
    (clips are media and captions hold speech)."""
    if is_inside(path, corpus) or (corpus and _real(path) == _real(corpus)):
        raise ClipError("refusing to write inside the clips corpus")
    if is_inside(path, REPO_ROOT) or _real(path) == _real(REPO_ROOT):
        probe = os.path.join(path, "probe.mp4.txt")
        r = subprocess.run(["git", "-C", REPO_ROOT, "check-ignore", "-q", probe], capture_output=True, **NO_WINDOW)
        if r.returncode != 0:
            raise ClipError("refusing: the output folder is inside the repository and not gitignored")


# ---------------------------------------------------------------- tools

def find_tool(name, explicit=None):
    """Explicit path, else PATH. Returns an absolute path or raises ClipError. Never downloads."""
    if explicit:
        if os.path.isfile(explicit):
            return os.path.abspath(explicit)
        raise ClipError(f"{name} not found at the given path")
    p = shutil.which(name)
    if not p:
        raise ClipError(f"{name} not found on PATH (pass --{name})")
    return p


def child_kwargs(creationflags=0):
    """subprocess kwargs: below-normal priority on Windows."""
    if os.name == "nt":
        return {"creationflags": subprocess.BELOW_NORMAL_PRIORITY_CLASS | creationflags}
    return {}


def lower_own_priority():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = wintypes.HANDLE
        k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.SetPriorityClass(k.GetCurrentProcess(), subprocess.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        try:
            os.nice(10)
        except OSError:
            pass


STALLED_RC = -2  # run_tool(watch=...): the child wrote nothing for stall_sec and was stopped
STOPPED_RC = -3  # run_tool(stop=...): stop() said stop (a stream or recording started); the child was stopped


def run_tool(argv, cwd=None, timeout=None, watch=None, stall_sec=None, poll_sec=2.0, setup_sec=300.0, stop=None):
    """Runs a child at below-normal priority; returns CompletedProcess (text, utf-8, errors replaced).

    watch + stall_sec (2026-11-12, a render hung for 30 min after a GPU driver reset): the child is stopped when the
    file `watch` (its output; relative to cwd) has not grown for stall_sec seconds; before its first byte the child
    gets max(stall_sec, setup_sec) (a long seek or filter set-up writes nothing yet). The result then has returncode
    STALLED_RC and says so in stderr. timeout still raises subprocess.TimeoutExpired.

    stop (2026-11-21, D415 review): a callable asked every poll_sec while the child runs; when it returns True the
    child is killed and the result has returncode STOPPED_RC ("stopped: on air" in stderr). A caller that treats an
    unknown live state as on air passes e.g. lambda: live() is not False."""
    if (watch is None or not stall_sec) and stop is None:
        return subprocess.run(argv, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout, stdin=subprocess.DEVNULL, **child_kwargs(**NO_WINDOW))
    import tempfile  # noqa: PLC0415
    path = None if watch is None or not stall_sec else (watch if os.path.isabs(watch) or not cwd else os.path.join(cwd, watch))
    with tempfile.TemporaryFile() as fo, tempfile.TemporaryFile() as fe:  # files, not pipes: no pipe can fill and block
        p = subprocess.Popen(argv, cwd=cwd, stdout=fo, stderr=fe, stdin=subprocess.DEVNULL, **child_kwargs(**NO_WINDOW))
        t0 = last = time.monotonic()
        size, stalled, grew, stopped = -1, False, False, False
        try:
            while True:
                try:
                    p.wait(timeout=poll_sec)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if stop is not None and stop() and p.poll() is None:
                    stopped = True
                    p.kill()
                    p.wait()
                    break
                now = time.monotonic()
                if path is not None:
                    try:
                        s = os.path.getsize(path)
                    except OSError:
                        s = -1
                    if s != size:
                        grew = grew or size >= 0 or s > 0
                        size, last = s, now
                if path is not None and now - last >= (stall_sec if grew else max(stall_sec, setup_sec)):
                    if p.poll() is not None:  # it ended between the wait and this check: its own exit code counts
                        break
                    stalled = True
                    p.kill()
                    p.wait()
                    break
                if timeout is not None and now - t0 >= timeout:
                    p.kill()
                    p.wait()
                    raise subprocess.TimeoutExpired(argv, timeout)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait()
        fo.seek(0)
        fe.seek(0)
        out = fo.read().decode("utf-8", errors="replace")
        err = fe.read().decode("utf-8", errors="replace")
    # a stream can start between the last look and the child's exit: one more look after it ended; on air (or unknown,
    # the caller's stop() decides) = stopped, its output discarded (D415 review)
    if not stopped and not stalled and stop is not None and stop():
        stopped, out = True, ""
    if stopped:
        return subprocess.CompletedProcess(argv, STOPPED_RC, "", err + "\nstopped: on air")
    if stalled:
        return subprocess.CompletedProcess(argv, STALLED_RC, out,
                                           err + f"\nstalled: no output for {stall_sec:g} s; stopped")
    return subprocess.CompletedProcess(argv, p.returncode, out, err)


def host_running(name="ujwalam-host.exe"):
    """True when a ujwalam-host process runs (a live stream or soak may own the GPU). Windows only."""
    if os.name != "nt":
        return False
    try:
        r = run_tool(["tasklist", "/FI", f"IMAGENAME eq {name}", "/NH", "/FO", "CSV"], timeout=20)
    except (OSError, subprocess.SubprocessError):
        return True  # unknown: assume busy, stay on the CPU
    return name.lower() in r.stdout.lower()


_SINK_LINE = re.compile(rb"\[host\] sink (\S+) (live|stopped|failed|dropped)\b")
_EXIT_LINE = re.compile(rb"\[host\] exit\b")


def host_logs_dir():
    """The installed app's host log folder (%LOCALAPPDATA%\\Ujwalam\\data\\host\\logs), or None off Windows."""
    base = os.environ.get("LOCALAPPDATA")
    return os.path.join(base, "Ujwalam", "data", "host", "logs") if base else None


HOST_EXE = "ujwalam-host.exe"
LOG_BIND_SEC = 120  # a host's log is named after its start (local time): the name lies within this of the start
_LOG_NAME = re.compile(r"^host-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)\.log$")


def installed_hosts(base=None):
    """Start times (local naive datetime) of the running installed hosts: every ujwalam-host.exe whose image is
    under %LOCALAPPDATA%\\Ujwalam (by path, never by name alone: agents' test hosts run from the repo). [] when none
    runs. None when it cannot be told: the process list fails, or a process named ujwalam-host.exe whose path or
    start time cannot be read (an elevated host, say) - it may be the user's."""
    base = base or os.environ.get("LOCALAPPDATA")
    if os.name != "nt" or not base:
        return None
    import ctypes
    import datetime
    from ctypes import wintypes

    class _Entry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_void_p), ("th32ModuleID", wintypes.DWORD),
                    ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                    ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260)]
    root = os.path.normcase(os.path.join(base, "Ujwalam")) + os.sep
    k = ctypes.WinDLL("kernel32")  # its own instance: argtypes below name this call's _Entry class
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(_Entry)]
    k.OpenProcess.restype = wintypes.HANDLE
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR,
                                             ctypes.POINTER(wintypes.DWORD)]
    k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    snap = k.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS: names without opening the processes
    if not snap or snap == wintypes.HANDLE(-1).value:
        return None
    pids = []
    try:
        e = _Entry()
        e.dwSize = ctypes.sizeof(_Entry)
        ok = k.Process32FirstW(snap, ctypes.byref(e))
        if not ok:
            return None
        while ok:
            if e.szExeFile.lower() == HOST_EXE:
                pids.append(e.th32ProcessID)
            ok = k.Process32NextW(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    out = []
    buf = ctypes.create_unicode_buffer(1024)
    for pid in pids:
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return None
        try:
            n = wintypes.DWORD(len(buf))
            if not k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)) or not buf.value:
                return None
            if not os.path.normcase(buf.value).startswith(root):
                continue  # a dev or test host from a repo checkout
            t = [wintypes.FILETIME() for _ in range(4)]
            if not k.GetProcessTimes(h, *[ctypes.byref(x) for x in t]):
                return None
            ft = (t[0].dwHighDateTime << 32) | t[0].dwLowDateTime
            utc = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(microseconds=ft // 10)
            out.append(utc.astimezone().replace(tzinfo=None))
        finally:
            k.CloseHandle(h)
    return out


def ctypes_error():
    import ctypes
    return ctypes.ArgumentError


def installed_host_running(base=None):
    """True when an installed host runs, False when none does, None when it cannot be told (installed_hosts)."""
    hosts = installed_hosts(base)
    return None if hosts is None else bool(hosts)


def log_for_start(names, start):
    """The host log of the host started at `start` (local naive datetime): the newest log whose name time lies
    within LOG_BIND_SEC around the start. None when no log belongs to it."""
    import datetime
    best = None
    for f in names:
        m = _LOG_NAME.match(f)
        if not m:
            continue
        t = datetime.datetime(*map(int, m.groups()))
        if abs((t - start).total_seconds()) <= LOG_BIND_SEC and (best is None or t > best[0]):
            best = (t, f)
    return best and best[1]


_LOG_CACHE = {}  # path -> [file identity, bytes read, {sink: state}, exited, partial line]; reads only new bytes


def _log_state(path):
    """(sink states, exited) of a host log, read incrementally. The file's identity (volume, file index, creation
    time) is kept with the offset: a replaced, rotated or truncated file is read again from the start."""
    with open(path, "rb") as f:
        s = os.fstat(f.fileno())
        ident = (s.st_dev, s.st_ino, getattr(s, "st_birthtime_ns", None) or s.st_ctime_ns)
        st = _LOG_CACHE.get(path)
        if st is None or st[0] != ident or s.st_size < st[1]:
            st = _LOG_CACHE[path] = [ident, 0, {}, False, b""]
        if s.st_size > st[1]:
            f.seek(st[1])
            data = st[4] + f.read(s.st_size - st[1])
            st[1] = s.st_size
            cut = data.rfind(b"\n") + 1
            done, st[4] = data[:cut], data[cut:]
            for m in _SINK_LINE.finditer(done):
                st[2][m.group(1)] = m.group(2)
            st[3] = st[3] or bool(_EXIT_LINE.search(done))
    return st[2], st[3]


def on_air(logs_dir=None, hosts=None):
    """Is the user's studio live or recording right now? Same rule as tools/live-check.mjs. No installed host
    process: off air. For each running installed host, its own log (named after its start, log_for_start): each
    sink's last live / stopped / failed / dropped line; a live or dropped sink counts however old the log is (a long
    stream can log nothing for minutes) until the host's exit line. True = on air, False = off air, None = unknown
    (callers treat it as on air): the process check failed, or a running host's log is missing or unreadable."""
    try:
        running = (hosts or installed_hosts)()
    except (OSError, ValueError, TypeError, AttributeError, ctypes_error()):
        running = None  # the check itself failed: unknown
    if running is None:
        return None
    if not running:
        return False
    d = host_logs_dir() if logs_dir is None else logs_dir
    try:
        names = os.listdir(d) if d else None
    except OSError:
        return None
    if not names:
        return None
    result = False
    for start in running:
        f = log_for_start(names, start)
        if f is None:
            return None
        try:
            states, exited = _log_state(os.path.join(d, f))
        except OSError:
            return None  # replaced or removed between the listing and the read
        if not exited and any(s in (b"live", b"dropped") for s in states.values()):
            result = True
    return result


def probe(ffprobe, path):
    """ffprobe JSON (format + streams). Raises ClipError on failure."""
    r = run_tool([ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], timeout=120)
    if r.returncode != 0:
        raise ClipError(f"ffprobe failed on {os.path.basename(path)}: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout)


def media_info(ffprobe, path):
    j = probe(ffprobe, path)
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    dur = float(j.get("format", {}).get("duration") or 0.0)
    fps = 0.0
    if v:
        num, _, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1").partition("/")
        try:
            fps = float(num) / float(den or 1) if float(den or 1) else 0.0
        except ValueError:
            fps = 0.0
    return {
        "duration": dur,
        "width": int(v["width"]) if v else 0,
        "height": int(v["height"]) if v else 0,
        "fps": fps,
        "vcodec": v.get("codec_name") if v else None,
        "pix_fmt": v.get("pix_fmt") if v else None,
        "acodec": a.get("codec_name") if a else None,
        "has_audio": a is not None,
        "audio_tracks": sum(1 for s in j.get("streams", []) if s.get("codec_type") == "audio"),
        "size": int(j.get("format", {}).get("size") or 0),
    }


def eprint(*a):
    print(*a, file=sys.stderr)


LOCK_NAME = "ujwalam-clip-heavy.lock"
PROVENANCE_FILE = ("clips", "music-provenance.json")  # services/posting/post-text.mjs PROVENANCE_FILE (keep in step)


def ensure_provenance_since(data_dir):
    """Codex verify (D414): the moment music records started, written once (temp file, flushed, linked into place so
    the first writer wins) and never moved; only a clip older than it can be a legacy clip in posting. Best effort:
    returns the ISO time or None."""
    if not data_dir:
        return None
    path = os.path.join(data_dir, *PROVENANCE_FILE)
    def read():
        try:
            with open(path, encoding="utf-8") as fh:
                v = json.load(fh).get("since")
            return v if isinstance(v, str) else None
        except (OSError, ValueError, AttributeError):
            return None
    have = read()
    if have:
        return have
    tmp = f"{path}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": 1, "since": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"}, fh)
            fh.flush()
            os.fsync(fh.fileno())
        try:
            os.link(tmp, path)
        except FileExistsError:
            pass
    except OSError:
        return None
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass
    return read()


# ---------------------------------------------------------------- one heavy job

def _pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


LOCK_BYTE = 1 << 20  # Windows: the locked byte sits past the owner text, so a busy reader can still read who holds it


class HeavyJobLock:
    """One heavy clip job at a time across processes (user limit 2026-10-27): the detector pass, the BD1 moment
    finder, the BD2 song map and the montage-music scan share this one lock. Codex verify: an OS-held lock on a lock
    file that is never deleted (msvcrt.locking LK_NBLCK on Windows, fcntl.flock LOCK_EX|LOCK_NB elsewhere), held for
    the job's life; the kernel frees it when the process ends, however it ends, so there is no staleness rule. The
    owner text in the file (pid, job, time) is written after locking and is for the busy message only."""

    def __init__(self, folder=None, job="detector-pass"):
        self.job = job
        self.path = os.path.join(folder or tempfile.gettempdir(), LOCK_NAME)
        self.held = False
        self.fh = None

    def _owner(self):
        try:
            with open(self.path, encoding="utf-8") as fh:
                rec = json.loads(fh.read(4096).split("\n", 1)[0] or "{}")
            return rec if isinstance(rec, dict) else {}
        except (OSError, ValueError):
            return {}

    def __enter__(self):
        fh = open(self.path, "a+b")  # created when missing, never truncated before the lock is ours, never deleted
        try:
            if os.name == "nt":
                import msvcrt  # noqa: PLC0415
                fh.seek(LOCK_BYTE)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl  # noqa: PLC0415
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            o = self._owner()
            since = time.strftime("%H:%M:%S", time.localtime(o["at"])) if isinstance(o.get("at"), (int, float)) else "?"
            raise ClipError(f"another heavy clip job is running ({o.get('job', 'unknown job')} since {since}, "
                            f"pid {o.get('pid', '?')}); one at a time") from None
        try:
            fh.seek(0)
            fh.truncate()
            fh.write((json.dumps({"pid": os.getpid(), "job": self.job, "at": time.time()}) + "\n").encode("utf-8"))
            fh.flush()
        except OSError:
            pass  # the owner text is display only
        self.fh, self.held = fh, True
        return self

    def __exit__(self, *exc):
        if self.held:
            try:
                if os.name == "nt":
                    import msvcrt  # noqa: PLC0415
                    self.fh.seek(LOCK_BYTE)
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl  # noqa: PLC0415
                    fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            finally:
                self.fh.close()
                self.fh, self.held = None, False
        return False
