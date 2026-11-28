# Molten Stone theme: evidence (2026-11-27, D449)

Plan: `docs/plan/2026-11-27-molten-stone-theme.md`. Branch `feat/molten-stone`. Status: built and tested headless.
Not yet seen by the user on a real screen.

## Tests (headless, `UJWALAM_HEADLESS=1`, 2026-11-28, studio closed, `node tools/live-check.mjs` = off air)

| Test file | Result |
|---|---|
| tests/molten-stone-theme.test.mjs (files + 3 probes) | 10/10 pass |
| tests/studio-qml-themes.test.mjs | 19/19 pass |
| tests/rareui-slice0 / 1 / 2 | 12/12, 19/19, 17/17 pass |
| tests/qml-popup-sizes.test.mjs | 1/1 pass |
| tests/studio-theme-members.test.mjs | 1/1 pass |
| tests/studio-qml-settings.test.mjs | 27/27 pass |
| tests/package-alpha.test.mjs | 21/21 pass |
| studio-themes, web-theme, contrast (file tests) | 41/41 pass |

Generator: `node tools/theme-textures/molten-stone.mjs --check` gives "42 files, 384.3 KiB, 0 differ".

The probes show these results:
- Full fx, off air: `fx` is `full` and the ambient loop items exist.
- On air: `fx` is `plain` and there are 0 ambient items.
- High performance: `fx` is `plain` and there are 0 ambient items.

## Idle cost (headless studio, 40 s, the task panel open; scratch script `molten-idle.mjs`)

| Theme | State | fx | Ambient loop items | CPU (one core) | CPU (all 20 threads) | GPU 3D |
|---|---|---|---|---|---|---|
| violet-night | off air | full | 0 | 1.10 % | 0.07 % | 0 % |
| molten-stone | off air | full | 5 | 4.84 % | 0.30 % | 0 % |
| molten-stone | on air | plain | 0 | 0.87 % | 0.05 % | 0 % |
| molten-stone | High performance | plain | 0 | 0.46 % | 0.03 % | 0 % |

What the numbers show:
- Off air, the smoke and drip loops cost about 3.7 % of one core more than violet-night.
- On air and in High performance mode, Molten Stone costs no more than violet-night, and no loop item exists.
- Plain mode on air is confirmed.

Limit: these runs are headless and never on screen, so the GPU counters read 0. The GPU cost on a visible window is UNVERIFIED.

## Specimen screenshots

The shots are in `out/2026-11-27-molten-stone/` (16 PNGs, about 4 MB, so not committed). The scratch script `molten-shots.mjs` makes them again. Each is 1600x900 at 100 % and 2400x1350 at 150 % (QT_SCALE_FACTOR 1.5).

Limit: the probe grabs only the main window. Dialogs (Settings, Go live, Posts, Import, Review) open in their own windows, so the shots do not show them. Those shots show the main window behind the dialog. Specimens of the dialog-only elements are still to be taken.

From the 150 % shot I found and fixed one artefact. The stone card rim crossed the labels on the low stats cards (44-58 px), so the stats cards are flat in every theme.

## Reference element: where it appears

| Reference element | Control | Where in the studio |
|---|---|---|
| Base / raised / inset surfaces, wire rims | UTexture (card, plate, toast, field) | UCard (every settings card), task panel, schedule rows, text fields |
| Primary button normal / pressed-loading / disabled | UButton textures + `busy` swirl | Every primary button; Go live button shows busy |
| Checkbox | UCheckbox | "Do this every time..." (ClipsAsk); "Skip the items..." (Import) |
| Radio | URadio | Settings > Appearance > Animations (Follow Windows / Always on / Off) |
| Switch with smoke | USwitch | Every switch; smoke over the knob when on, off air, full fx |
| Text field (rim, error plate) | UField `error` | Every text field; mixer dB fields |
| Slider (cracked track, molten fill) | USlider | Mixer faders, every slider |
| Breadcrumbs | UBreadcrumbs | Settings page header (Studio > Settings > page) |
| Pagination | UPagination | Posts window, 20 posts a page |
| 5-step process | USteps | Go live dialog footer (Details, Check, Live) |
| Card with chart | (flat) | Stats panel: the texture was removed, see above |
| List row with NEW badge | UBadge | Posts window rows that still wait for approval |
| Avatar (spiral, no face) | UAvatar | Settings > Connections, each account row; lit when connected |
| Tooltip with drop | UTipDrop | The shared tooltip (Main.qml) |
| Compact table header | UTableHeader | Schedule list |
| Modal confirmation slab with smoke | ConfirmDialog | Held actions ("Go live anyway", rule requests) |
| Toast stack (success / warning / error tones) | TaskCenter toasts | Task notices |
| Linear progress with drip | UProgress (linear) | Task rows |
| Processing bar with gear | UProgress (processing) | Clip tasks |
| Spinner swirl | UBusySwirl | Task panel title; busy buttons |
| Skeleton rows | USkeleton | Schedule list until it loads |
| Empty state (astronaut, closed visor) | UEmptyState | Task panel ("Nothing is running"), schedule |
| Tabs | not built | No new tab bar. The existing settings page list is kept. |
| Elevation 1-4, radius scale, icon style, spacing 6/10 | theme tokens | `data/themes/molten-stone.json` (existing token system) |

## Rules checked

- **No new confirm dialogs (D332):** none added.
- **No faces or names:** the avatar is a spiral and the astronaut's visor is closed. Both are asserted in tests from the generator source.
- **Effects and loops:** no MultiEffect or ShaderEffect. The only loops are the ambient smoke and drip, the busy swirl and the old unknown-amount progress sweep. All are asserted in tests.
- **Plain mode:** no textures, no ambient (the probes show this).
- **Contrast:** text against the painted faces is at least 4.5:1, including the top light. The disabled label is at least 3:1.
- **Pictures:** made by a deterministic Node script, 384 KiB in total. Nothing is downloaded.
