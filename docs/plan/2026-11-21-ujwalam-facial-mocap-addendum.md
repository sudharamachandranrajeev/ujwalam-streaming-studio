# Ujwalam — Plan Addendum: Facial Motion Capture

**Date:** 2026-11-21
**Status:** Accepted by the user 2026-11-21 as the live-avatar part of `docs/plan/2026-11-08-face-ai-design.md`
(extends it; the face tracker, `services/face/` worker and the reference-image avatar there are the base, not
replaced). Queued after the clip work: long highlights video, clip music / name display / transitions, reel styles.
The user's answers to §10 are recorded there; where this addendum and the 8 Nov plan or AGENTS.md disagree, the
answers and AGENTS.md win.
**Feature flag:** `face-mocap`, sub-flag `body-mocap-offline`; user-requested, so both ship ON once each phase's
"done when" passes (AGENTS.md switch rule: a visible switch on the control page, flippable while live).
**Source reference:** Tutorial transcript on *RGB MoCap* by toyxyz (free, local, video → 3D animation)

---

## 1. Read this first — what the source does and does not cover

The reference transcript shows a **body** motion-capture tool. It does **not** do facial capture. What it does show:

| Shown in transcript | Relevance to Ujwalam |
|---|---|
| Runs fully locally, free, no tokens | Matches Ujwalam's no-subscription rule |
| Normal video in → 3D animation out (offline, minutes per clip) | Good for post-stream / clip content, not live |
| Several solvers: ExMR (fastest), FlowHMR (best quality, tracks fingers), GVHMR, MAMMA (multi-camera) | Pattern to copy: pluggable solver choice per job |
| "Find person" + multi-person tracking, rename/colour each person | Pattern to copy for selecting which face to track |
| Static-camera and smooth-motion options; flat-ground foot locks stop sliding | Analogue for face: jitter smoothing, neutral-pose lock |
| Export FBX / BVH / Blender; retarget to a Mixamo Y Bot with mesh | Export path for body; face needs blendshape export instead |
| Gated Hugging Face models and body models need manual download/import via a model manager | Ujwalam needs the same: a model manager, no silent downloads |
| ~3 min for a 21 s clip on an RTX 3090; MAMMA used ~10 GB VRAM and gave poor results | **Not feasible live on the RTX 4050 (6 GB)**; MAMMA ruled out |

**Consequence:** facial capture needs its own face-tracking solver. RGB MoCap is used as the *design pattern* (local, pluggable solvers, model manager, smoothing, export) and, optionally, as an external tool for offline body animation.

---

## 2. Goal

Let Ujwalam drive an on-stream avatar (or avatar overlay) from the webcam face in real time, locally, with no cloud calls — and optionally produce offline full-body animation from recorded footage for clips.

### In scope (v1 of this feature)
- Live webcam face tracking → expression values (blendshapes) + head rotation
- Avatar source in the scene graph that consumes those values
- Calibration (neutral face), smoothing, and a "lost face" fallback
- Chat-triggered expression/effect overrides (ties into existing chat-controlled effects)
- Panic hotkey hides the avatar and stops tracking

### Out of scope (later)
- Live full-body capture
- Multi-camera solving (MAMMA-style)
- Training custom face models on the user's clips

---

## 3. Architecture

```
Webcam (shared device, not exclusive)
   │
   ▼
face-tracker service (local process, separate from libobs host)
   ├─ solver adapter: [Solver A] [Solver B] ...   ← pluggable, like RGB MoCap's model menu
   ├─ smoothing + neutral calibration
   └─ output: blendshape weights + head pose @ target 30–60 Hz
   │
   ▼  local-only channel (127.0.0.1)
event-core
   ├─ chat overrides (e.g. !happy → expression preset for N seconds)
   └─ effects bus
   │
   ▼
Avatar source in scene (render via browser/CEF source or native)
```

Design rules:
- Tracker runs **out of process** so a crash never takes down the stream (host crash supervisor watches it).
- Webcam is opened in a way that the camera scene source keeps working (shared capture or single capture fanned out).
- Output format is a neutral schema (blendshape name → 0–1 weight, head yaw/pitch/roll) so solvers and avatar renderers can be swapped independently.
- Optional bridge to a standard avatar protocol (e.g. VMC over OSC) so external VTuber software can consume or supply the data — **to verify** before committing.

---

## 4. Solver candidates (to verify before choosing)

These are starting points from general knowledge, **not verified for current licence, accuracy or VRAM use**. A spike must confirm each.

| Candidate type | Expected strengths | Check |
|---|---|---|
| Lightweight landmark/blendshape model (e.g. MediaPipe Face Landmarker class) | Runs on CPU or small GPU budget, real-time, ARKit-style blendshapes | Licence, blendshape quality, Windows/Python 3.14 support |
| Heavier 3D face reconstruction model | Better depth/expressions | VRAM within budget alongside NVENC + clipping |
| External app via protocol bridge | No integration work; user may already own one | Local-only, no account/subscription |

Selection criteria: runs locally, free licence compatible with distribution (record in licence checklist), ≤ ~1.5 GB VRAM, ≥ 30 fps on RTX 4050 while streaming, no account or token needed.

---

## 5. Performance budget (RTX 4050 Laptop, 6 GB)

| Consumer | Budget |
|---|---|
| NVENC encodes (YouTube H, V, shared 1080p60 rung) | unchanged — has priority |
| Face tracker | ≤ 1.5 GB VRAM, ≤ 10 % GPU, or CPU path |
| Avatar render | ≤ 5 % GPU |
| AI clipping / Whisper | runs post-stream, never concurrently with live tracking |

If budget is exceeded, the tracker drops to CPU path or lower frame rate automatically; it never causes encoder frame drops.

---

## 6. Optional: offline body mocap (`body-mocap-offline`)

Based directly on the transcript workflow, for clip content (e.g. turning a recorded moment into an animated replay):

1. Recorded clip → user runs RGB MoCap (external, installed by the user — **no auto-install**).
2. Recommended settings from the transcript: ExMR for speed, FlowHMR when quality/fingers matter; static camera + smooth motion on; flat-ground foot locks on.
3. Export FBX → retarget to Mixamo Y Bot (T-pose, FBX binary with skin) → "export character" with mesh included.
4. Ujwalam imports the FBX into a clip template.

Ujwalam only provides: folder watcher for exports, clip template, and a how-to page. No bundling of RGB MoCap or its models.

---

## 7. Privacy and public-repo rules (critical)

- **No face images, video frames, landmarks or calibration data are ever written to the repo.** Calibration lives in gitignored `data/profile.local.json` (or a sibling local file).
- Test fixtures use synthetic/stock-free generated faces or recorded weight streams (numbers only), never the user's face.
- Git hooks must block common image/video extensions under test folders for this feature.
- Tracking frames are processed in memory; nothing saved unless a debug flag is on, and debug output goes to a gitignored folder and is excluded from the diag bundle.
- Models downloaded manually through a model manager (as in the transcript); gated models need the user's own account action.

---

## 8. Controls and safety

- Flag `face-mocap` is one click on the control page or in the studio, also while live; no typed phrase and no
  "are you sure" (D332). Agents still need the user's words in chat before switching it on a running studio.
- Panic hotkey (Ctrl+Alt+P) also stops tracking and hides the avatar.
- New hotkey proposal: toggle avatar visibility (to be confirmed, no clash with existing hotkeys).
- Lost face for > 2 s → avatar eases to neutral idle; tracking status shown on the control page.
- Chat overrides rate-limited and can be disabled per stream.

---

## 9. Phased plan

| Phase | Work | Done when (evidence in `docs/evidence/`) |
|---|---|---|
| F-M0 Spike | Test 2–3 solver candidates offline on a short local test recording (not committed) | Table of fps, VRAM, latency, licence for each |
| F-M1 Tracker service | Out-of-process tracker, neutral schema, smoothing, calibration | 1 h soak with no crash, < 100 ms latency measured |
| F-M2 Avatar source | Scene source consuming schema; simple 2D/3D test avatar | Visible on preview and recording; no encoder drops |
| F-M3 Integration | Chat overrides, effects bus, panic/hotkeys, lost-face fallback | Test card passes on private YouTube broadcast |
| F-M4 Optional body offline | Export watcher + clip template + how-to for RGB MoCap | One clip produced end-to-end |
| F-M5 Hardening | Licence checklist entries, git-hook rules, diag-bundle exclusions | Hooks block a test face image; licence list updated |

Not scheduled against existing v1 deadlines; starts after the clip work (see Status).

---

## 10. Decisions (user's answers, 2026-11-21)

1. Avatar type: **from the user's photo**, the reference-image avatar of the 8 Nov plan (§5 there), driven live by
   the face. Not VRM, not Live2D.
2. Tracker: **Ujwalam tracks natively** (no external VTuber app bridge; the VMC bridge in §3 is dropped). Full
   52-value expressions need MediaPipe's blendshape model converted with `tf2onnx`: an install, ask the user first;
   until then the geometric features of the 8 Nov tracker drive the avatar.
3. Webcam: the same webcam as the camera layer (shared, never exclusive), per §3. UNVERIFIED that the user wants no
   dedicated camera; the default stands until the user says otherwise.
4. Offline body mocap (§6): **included**. RGB MoCap is installed by the user; Ujwalam only watches its export folder,
   adds a clip template and a how-to page.
5. F-M0 spike: **allowed** with a short private webcam recording on the laptop, gitignored, used only to compare
   trackers; never committed, never in a diag bundle.
