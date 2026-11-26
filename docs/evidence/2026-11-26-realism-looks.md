# Realism looks: look library, bloom / clarity / chromatic, looks submenu (D445, RL1-RL3)

Date: 2026-11-26. Plan: `docs/plan/2026-11-25-realism-looks.md`. Result: PASS for RL1-RL3 as built and tested
below. Each look's values on real gameplay, the submenu opening as its own window on a real display, and live GPU cost
next to three NVENC encodes are UNVERIFIED (RL6, needs the user). Live feature: awaiting live test.

## What was built

- RL1, look library as data: `data/looks/<id>.json` (schema `data/schemas/look.schema.json`), seven looks: Filmic (the
  D381 grade, unchanged), Cinematic, Dark cinematic (reference A), Cold high-key (reference C, reds kept strong), Gritty
  war, HDR vivid, Night neon. Each names a grade, its layer effects (LUT first), the types kept on blurred backdrops and
  a five-colour swatch. All `status: "unverified"`. `tools/make-look-luts.mjs` writes `data/luts/look-<id>.cube` (33^3,
  LF; + - * / and `toFixed(6)` only) and the swatches; `--check` compares. No reference frame or file is in the repo.
  `services/project/looks.mjs` loads the library (a broken file is skipped). The looks ship in the package.
- RL2, host shaders: `bloom` (threshold pass at half size, Gaussian, add), `clarity` (local contrast on a blurred
  luma, mid tones only, clamped) and `chromatic` (radial red/blue offset) as layer effects
  (`app/host/data/effects/ujw_local.effect`, `ujw_chromatic.effect`, `app/host/src/effects.cpp`), in the schema,
  validator, host model and studio effect list; registry functions `layer-bloom`, `layer-clarity`, `layer-chromatic`
  with presets `fx-bloom-soft`, `fx-clarity-punch`, `fx-chromatic-subtle`. Film grain is the existing D291 effect.
- RL3, studio: the scene menu's "Make realism scene" is a submenu with one row per look (name, tip = the look's
  summary). Route op `scene.realism` takes `look` (default `filmic`; `unknown-look` refused). The copy is
  "<scene> <look name>", id `<scene id>-<look id>`; the original is never changed; refused while live. Blurred backdrop
  layers get only the look's backdrop types (the LUT). A look made from a look scene (or an old "Realism" scene) takes
  the old look off first, so two never stack. `GET /ui/api/looks` lists the looks. Flag `realism-look` ON by default
  (`onBy: "D445"`).
- Open: changing the look of an existing scene in place is not built; make a new look scene from it instead.

## Commands and output

```
node tools/make-realism-lut.mjs --check ; node tools/make-look-luts.mjs --check
```
```
realism LUT up to date
look LUTs and swatches up to date
```

```
node --test tests/realism-looks.test.mjs tests/realism-look.test.mjs tests/flags.test.mjs tests/project-schema.test.mjs tests/project-structure.test.mjs
```
`pass 189, fail 0` (LUT byte checks for all six generated LUTs, look schema, every look valid project effects,
swatches, each grade's planned colour shift; realismScene per look with the original unchanged; route with `look`,
`unknown-look`, flag default on).

```
node --test app/host/tests/host-realism-fx.test.mjs
```
```
✔ D445 bloom, clarity and chromatic: validated, round-trip through layers.list, and render as their shaders say
realism effects flash check: peak 0 flashes/s over 181 frames
✔ D445 bloom and chromatic add no flash: a full-canvas still with bloom, clarity, chromatic and grain stays at or under 3 flashes/s
realism looks: 7 looks, worst swatch error 2/255 after NVENC
✔ D445 every look of data/looks: its full effect list loads; its LUT grades the swatch colours as the generator says
```

```
node --test --test-name-pattern="scene menu" tests/studio-qml-editing.test.mjs
```
`pass 5, fail 0`: the submenu row, one row per look in library order, a click on Dark cinematic makes
"<scene> Dark cinematic" with `look-dark-cinematic.cube` on the game layer while the original stays, the
no-game-capture refusal in plain words, rows greyed and no write while live.

## GPU cost (RL2)

`UJWALAM_FX_BENCH=1 node --test --test-timeout=600000 app/host/tests/host-fx-bench.test.mjs`, RTX 4050 Laptop,
no output running. Frame ms = the host's average render-thread time per frame (CPU side; the GPU works
asynchronously, so an approximation, not a GPU timer).

Six full-canvas 1920x1080 layers, one effect each:

| effect | +ms vs none (6 layers) | +ms per layer |
|---|---|---|
| blur 20 (reference) | 0.079 | 0.013 |
| bloom size 5 / 20 | 0.125 / 0.131 | 0.021 / 0.022 |
| clarity size 2.5 / 20 | 0.124 / 0.136 | 0.021 / 0.023 |
| chromatic | 0.014 | 0.002 |
| grain (existing) | 0.032 | 0.005 |

Whole looks on the alpha game scene (H game + V copy + H and V full-canvas blurred backdrops), two passes:

| look | +ms per frame (pass 1 / 2) |
|---|---|
| Filmic | 0.051 / 0.032 |
| Cinematic | 0.064 / 0.077 |
| Cold high-key | 0.062 / 0.086 |
| Dark cinematic | 0.101 / 0.085 |
| Gritty war | 0.066 / 0.067 |
| HDR vivid | 0.062 / 0.059 |
| Night neon | 0.092 / 0.070 |

Every effect is well under the 1 ms per canvas target by this measure. NVML GPU load during these runs was 28-40 %
against 20-22 % for the same scene without a look (idle-clock noise is large at this load).

## UNVERIFIED

- How each look looks on real gameplay and the user's choice per look (RL6).
- GPU cost while live next to three NVENC encodes (the bench is render-thread time, not a GPU timer).
- The submenu opening as its own window on a real display (tests run headless, where it draws inside the window).

## Files

Created: `data/looks/*.json` (7), `data/luts/look-*.cube` (6), `data/schemas/look.schema.json`,
`tools/make-look-luts.mjs`, `services/project/looks.mjs`, `tests/realism-looks.test.mjs`,
`app/host/data/effects/ujw_local.effect`, `app/host/data/effects/ujw_chromatic.effect`,
`app/host/tests/host-realism-fx.test.mjs`, `registry/functions/layer-{bloom,clarity,chromatic}.json`,
`registry/presets/fx-{bloom-soft,clarity-punch,chromatic-subtle}.json`, this file.
Changed: `app/host/src/effects.cpp`, `effects.h`, `model.cpp`, `model.h`, `app/host/CMakeLists.txt`,
`app/host/tests/host-fx-bench.test.mjs`, `data/schemas/project.schema.json`, `services/project/validate.mjs`,
`services/project/structure.mjs`, `services/studio-ui/server.mjs`, `app/studio/src/fx_types.cpp`,
`app/studio/qml/{SceneMenu,UMenu,ScenesPanel,Store,EditOps}.qml`, `data/flags.json`,
`docs/plan/2026-10-29-v1-decisions.md` (D445), `tools/package/manifest.mjs`, `tests/package-alpha.test.mjs`,
`tests/project-schema.test.mjs`, `tests/realism-look.test.mjs`, `tests/studio-qml-editing.test.mjs`.
