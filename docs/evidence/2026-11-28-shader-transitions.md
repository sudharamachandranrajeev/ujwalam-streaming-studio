# 2026-11-28 Shader scene transitions

Status: done in tests (headless host, NVENC recordings, 2026-11-28). Not yet used on a real stream.

## What was built

- Host transition type `ujw_shader_transition` (`app/host/src/shader_transition.cpp`) with one shader per style in
  `app/host/data/effects/ujw_tr_*.effect`: blurZoom, lightLeak, motionSwipe, glitch, heartbeat, pop.
- Runs in manual mode under the existing easer (`transition_ease.cpp`), so every style takes an easing curve.
- Audio: equal-power crossfade.
- Fallback: if a style's shader does not compile, the canvas runs a fade of the same length and curve, and
  `transitions.get` reports `fallback: true`. It never crashes and never shows a black frame. A test seam
  (`UJWALAM_TEST_SHADER_FAIL=<style>`, only with `UJWALAM_HEADLESS=1`) forces this path.
- Flash safety: the light leak is one soft glow per switch (at most +0.28 in screen blend). The glitch only moves slices
  and splits colour, so it adds no brightness of its own, and its slices move 4 times per transition.
- Project: the six types are in the schema and validator (`easing` is allowed). A scene can have its own `transition`.
- Every realism look has a subtle default transition (400 to 700 ms). A realism scene gets its look's transition as its
  own (a user look gets the one of the look it was based on).
- Server: switching to a scene with its own transition sets that transition on the host before the switch. The
  transitions form has a Scene row: a scene's own transition, or "Same as the canvas".
- Studio: Transitions box shows the six kinds with plain-word help, an Easing row and a Scene row.

Look defaults: cinematic blurZoom 600, cold-high-key pop 400, dark-cinematic motionSwipe 550 (left), filmic lightLeak 700,
gritty-war heartbeat 650, hdr-vivid blurZoom 450, night-neon glitch 400.

## Evidence

| Check | Command | Result |
|---|---|---|
| Host build | `node app/host/tools/build.mjs` | PASS (all 6 shaders embedded) |
| Unit, schema, server | `node --test tests/shader-transitions.test.mjs` | PASS 16/16 |
| Existing transitions, looks, structure, schema | `node --test tests/studio-ui-transitions*.test.mjs tests/realism-look*.test.mjs tests/project-structure.test.mjs tests/project-schema.test.mjs tests/user-looks.test.mjs ...` | PASS 203/203 |
| Quick CI (commit hook, includes studio QML compile) | git hook | PASS 9/9 |
| Studio QML transitions | `node --test tests/studio-qml-transitions.test.mjs` | PASS 14/14 |
| Host: shader, D239 and D391 transitions + bench | `UJWALAM_TR_BENCH=1 node --test --test-timeout=600000 --test-concurrency=1 app/host/tests/host-shader-transitions.test.mjs app/host/tests/host-transitions.test.mjs app/host/tests/host-transitions-d391.test.mjs` | PASS 25/25, 0 skipped |

## Measurements

Recorded switch, 640x360 at 30 fps, warm test card to cool test card, 600 ms, easing in-out-sine. "In between" = frames
that differ from both scenes (18 frames = 600 ms). Darkest frame = lowest mean luma of the whole recording (black is
about 16). Flashes = pairs of opposite mean-luma changes of at least 22 steps in any 1 s window (limit 3).

| Style | In-between frames | Darkest frame (mean luma) | Flashes/s |
|---|---|---|---|
| blurZoom | 18 | 79.7 | 0 |
| lightLeak | 18 | 79.7 | 0 |
| motionSwipe | 18 | 79.7 | 0 |
| glitch | 18 | 79.7 | 0 |
| heartbeat | 18 | 79.7 | 0 |
| pop | 18 | 79.7 | 0 |
| glitch with a forced shader failure (fade fallback) | 14 | 79.6 | n/a |
| type changed during a running glitch, while recording | n/a | 79.7 | n/a |

The darkest frame is the warm scene itself: no transition goes darker than its scenes.

forceComplete: a running 8 s heartbeat ended at once (), and a second call reported nothing running.

Render cost, 1920x1080 at 60 fps, measured during an 8 s transition. Frame ms = the render thread's average time per
frame (CPU side, from the host status); GPU % = NVML load. Laptop RTX 4050.

| Transition | Frame ms | +ms vs idle | GPU % |
|---|---|---|---|
| none (cut, idle) | 0.195 | 0.000 | 7 |
| blurZoom | 0.205 | 0.010 | 29 |
| lightLeak | 0.201 | 0.006 | 13 |
| motionSwipe | 0.197 | 0.002 | 26 |
| glitch | 0.204 | 0.009 | 13 |
| heartbeat | 0.197 | 0.002 | 23 |
| pop | 0.198 | 0.003 | 12 |
| fade (reference) | 0.197 | 0.002 | 11 |

All fit easily in a 60 fps frame (16.7 ms). The blur styles (blurZoom, motionSwipe, heartbeat) cost the most GPU, about
16 to 22 points above idle, and only while a transition runs (300 to 700 ms).

Limits: flashes were measured on still test cards, not on game footage. The flash and darkness checks use whole-frame
means. A live feature is done only after one real stream with no high-severity feedback.
