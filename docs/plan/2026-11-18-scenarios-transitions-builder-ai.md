# 2026-11-18 Scenario scenes, cyberpunk transitions, scene builder vision model

User request (2026-11-18): "Different scenes for different scenarios, like gameplay, in lobby just chatting, showing
off PC screen/apps for videos. Fancy transitions, default one cyberpunk colourful. Did you complete the AI assisted
scene builder?" Answers given in the session (same day):

- Scenarios: gameplay, lobby / just chatting, screen share, starting soon / BRB / ending. Each makes an H and a V scene.
- Screen share: both capture kinds; one app window is the default, the whole screen stays available.
- Scene builder AI: install a small vision model (local, LM Studio; `qwen/qwen3-vl-4b` picked). Never loaded while
  live or while Meld Studio runs (D1, 6 GB VRAM).
- Build plan A and B in parallel.

Requested features ship on by default with visible toggles (user, 2026-11-15).

## Status of the scene builder at the request

SB1–SB5 built and tested on drawn fixtures (D339, D341, D345, D347; studio window since Q4, 2026-11-14), behind flag
`scene-builder` (off). Slot reading is rules only; the vision model was a typed hook with no model. Never run on a real
reference of the user's.

## Work

| Id | What | Done when | Owner |
|---|---|---|---|
| SC1 | Host layer types `window` (window_capture) and `screen` (monitor_capture); RPC `capture.listTargets` | Schema/validator tests; host loopback: both layers live, listTargets shape, bad specs refused | Opus |
| SC2 | Scenario templates `data/scene-templates/*.json` built through the SB3 builder; role `screen` | Each template builds H+V within tolerance, V safe zone, existing state hash unchanged | Sonnet |
| SC3 | Studio: Add scene > "From a scenario…" cards, window/screen picker, one click | Route test + QML probe test | Sonnet |
| TR2 | Host transition types slide, swipe, luma wipe, fade to colour | Host recording proves each type | Opus |
| TR3 | Cyberpunk stingers generated locally (presets as data; `neon-glitch` default), flash rate ≤ 3/s measured | Flash and coverage tests; packaged app contains them | Sonnet |
| TR4 | Transitions on by default; `neon-glitch` on both canvases (one-time switch for a project still on the imported fade) | Flag/default tests; user choice never overwritten | Sonnet |
| SB6 | Vision model adapter for `readReference` (LM Studio local endpoint, load on demand, unload after, refused while live) | Fake-server test; one real reference read checked by the user | After the download |

Live check: a test stream after the user's "start stream test" (scene switches with each transition, screen share).
