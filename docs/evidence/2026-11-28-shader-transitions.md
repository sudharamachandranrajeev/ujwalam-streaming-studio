# 2026-11-28 Shader scene transitions

Status: code and unit tests done; host GPU tests PENDING (UNVERIFIED) until the user's studio is closed.

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
| Host recorded tests | `node --test app/host/tests/host-shader-transitions.test.mjs` | PENDING |
| Render cost | `UJWALAM_TR_BENCH=1 node --test app/host/tests/host-shader-transitions.test.mjs` | PENDING |

## Measurements

PENDING: in-between frames, minimum mean luma, flashes per second, and frame time per transition.
