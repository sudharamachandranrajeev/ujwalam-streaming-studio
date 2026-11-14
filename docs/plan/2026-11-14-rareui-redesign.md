2026-11-14 RareUI redesign: native QML port plan

Research only. No code was written. All numbers below come from the RareUI source on GitHub (branch main, read 2026-11-14) and from Sonner 2.0.8 `dist/index.mjs` and `dist/styles.css`. Anything not read from source is marked UNVERIFIED.

## Summary

- The user wants every RareUI component rebuilt in QML and made the studio default look. There are 21 items, plus Sonner (toasts) added on request, so 22.
- RareUI is React 19, Tailwind 4, framer-motion 12. Only one item needs real GPU work (Liquid Metal, WebGL2 shader) and one is a GPU fluid solver (Liquid Wave, three.js, about 37 draw calls a frame).
- Most items are cheap: springs, gradients, shadows. QML covers these with `SpringAnimation`, `Behavior`, `Gradient`, `Rectangle`, `Rotation` and `Translate` transforms.
- Qt modules linked now (`app/studio/CMakeLists.txt` lines 14 and 90): Widgets, Network, Qml, Quick, QuickControls2. The QML files import only `QtQuick`, `QtQuick.Controls.Basic`, `QtQml.Models` and `Ujwalam.Core`. No QML file uses `ShaderEffect`, `MultiEffect`, `QtQuick.Particles` or `QtQuick3D` today.
- No new Qt module is needed. `ShaderEffect` and `MultiEffect` ship inside Qt Quick (6.5+). `.frag` shaders need `qsb`, which ships with Qt (`qt_add_shaders` in CMake). No new install.
- Do not use Qt Quick 3D (new module, new link). Fake the Book 3D with `Rotation` transforms (Qt Quick has `axis` and `origin` on `Rotation`, and perspective can be faked with scale per face). Book 3D is a handful of faces, so this works.
- The studio already has: a `Theme` singleton with `Theme.motion`, `Theme.fast`, effect levels "full / reduced / performance" (`app/studio/src/theme.h`), a High performance switch (`SettingsAppearance.qml`, 2026-11-10), and a v2 theme schema with a `components` block (button style, tabs, card, chip and so on, D336, behind flag `theme-components`). The port should extend this block, not replace it.
- Toasts live in `TaskCenter.qml` (lines 134 to 153 model, 421 to 500 view). The model is capped at 3, which matches Sonner's default of 3 visible. The view is a plain `Column`, so Sonner stacking is an upgrade of that one view.
- Live rule: while live, or when High performance is on, every shader, particle, 3D, continuous and looping animation is off and the plain style is used. Hover and press feedback stays as a short colour change.
- Proposed order: tokens and live gate first, then buttons and tabs, then toasts and tooltips, then text effects, then cards and sections, then the two GPU items last.

## Licence and credit

- RareUI is MIT. Source: https://github.com/Codewithswappy/RareUI. The `LICENSE` file reads: "MIT License. Copyright (c) 2025 Swapnil Kalambe (RareUI)", then the standard MIT grant and warranty text.
- Sonner (2.0.8) is MIT. The copyright holder line was not read: UNVERIFIED. Read `LICENSE` in the Sonner repo before the credit is written.
- We write our own QML. We copy no source files, images or fonts. We copy design values (numbers and colours) and behaviour, which is an idea, not code, but the MIT notice still applies if we port closely.
- Credit plan: add a `THIRD-PARTY-NOTICES` entry (or the existing licence list in `docs/licence-headers.md`) with the RareUI MIT text and the Sonner MIT text. Put one line in each ported QML file header: "Design after RareUI (MIT, Swapnil Kalambe)". Add the same line to the About page.
- Do not bundle RareUI external assets: the grain texture from `grainy-gradients.vercel.app`, the paper texture from `transparenttextures.com`, and Unsplash photos. We draw our own.
- Fonts: RareUI uses Tailwind default `font-sans`, `font-serif` and `font-mono`. We keep Inter, Barlow and Exo 2 (bundled, OFL) and Windows fonts only. Never bundle Corbel or Consolas.

## Common rules for every port

- Tailwind defaults used by RareUI (needed to read the values below): `shadow-xl`, `rounded-lg` 8 px, `rounded-xl` 12 px, `rounded-2xl` 16 px, `rounded-full` pill. Neutral palette: 950 `#0a0a0a`, 900 `#171717`, 800 `#262626`, 500 `#737373`, 200 `#e5e5e5`, 100 `#f5f5f5`. Tailwind shadow strings: UNVERIFIED for exact values, treat as soft black shadows.
- framer-motion spring to QML: `SpringAnimation { spring: s; damping: d }`. framer `stiffness k, damping c, mass m` has no exact `SpringAnimation` equivalent (its `spring` and `damping` are unitless). Plan: tune by eye and mark each such spring TUNE. The exact option is a tiny `QtObject` spring integrator in a `FrameAnimation` (Qt 6.4+) with k, c, m as written. Pick the exact integrator for anything that reads stiffness and damping; it costs one `FrameAnimation` per active spring and stops at rest.
- Every port reads colours from `Theme.c.*` (panel, border, text, muted, accent, accentHi, danger, ok, onAccent). RareUI is black and white. We map black to `text` or `accent`, white to `panel`.
- All durations clamp to the studio rule: entrances under 600 ms, exits under 400 ms (AGENTS.md overlays rule, applied to overlays and toasts; we apply it to every transient effect).
- Cost rating: low = a few property bindings; medium = many items or a continuous animation; high = per-frame shader or many particles.

## Per component

### 1. Animated Tab
- Source: `components/rareui/AnimatedTab/AnimatedTab.tsx`.
- Visual: a pill-shaped bar. Tab buttons sit inside. One filled pill slides behind the active tab. A faint pill shows under the hovered tab.
- Container: `rounded-full`, padding 4 px (6 px from 640 px up), background white at 60 percent (dark: zinc-900 at 60 percent), 1 px border black at 5 percent (dark: white at 10 percent), backdrop blur 24 px, `shadow-2xl`.
- Tab: padding 12 by 8 px (16 by 10 from 640 px, 24 horizontal from 768 px), text 12 px (14 px from 640 px), weight 600.
- Active pill: black fill (dark: white) with `shadow-xl`; dark mode adds glow `0 0 20px rgba(255,255,255,0.3)`. Shared layout spring: stiffness 320, damping 32, mass 0.9.
- Hover pill: black at 5 percent (dark: white at 5 percent). Fades in over 150 ms. The exit fade never plays in source (no `AnimatePresence`).
- Colours: active text white (dark: black); idle text `#52525b`, hover `#18181b` (dark: `#71717a`, hover `#d4d4d8`). Colour transition 200 ms.
- Press: scale 0.95. No keyboard support in source.
- Dependencies: framer-motion (`layoutId`), Tailwind.
- Cost: low.
- QML: `Row` of `UTab` items. Active pill is one `Rectangle` whose `x` and `width` follow the active item through `SpringAnimation` (TUNE to k 320, c 32, m 0.9). Hover pill: `Rectangle` with `Behavior on opacity` 150 ms. Blur: skip, or `MultiEffect` blur only in non-live mode. Add focus ring and arrow keys (source has none).
- Studio use: `SettingsDialog.qml` page tabs, and the panel tabs in Main. Maps to existing schema key `components.tabs` (add value `"slide"`).
- Live fallback: pill jumps (no spring), no blur, no hover fade longer than 80 ms.

### 2. Floating Navigation
- Source: `components/rareui/FloatingNavigation/FloatingNavigation.tsx`.
- Visual: a floating pill dock with five round icon buttons. Fixed 32 px from the bottom, centred. Active icon has a dark gradient disc behind it. A tooltip pops above the hovered icon.
- Dock: `rounded-full`, padding 8, gap 8, background white at 50 percent (dark: neutral-900 at 50 percent), blur 24 px, border neutral-200 (dark: white at 10 percent), shadow `0 8px 32px rgba(0,0,0,0.12)`, hover shadow `0 8px 40px rgba(0,0,0,0.2)`, 300 ms.
- Button: 48 by 48, icon 20 by 20, stroke 2, round caps. Active text white; idle `#737373` hover `#171717` (dark `#a3a3a3`, hover white).
- Active pill: gradient top to bottom `neutral-800` to `neutral-900` (dark: white to neutral-200), glow `0 0 20px rgba(0,0,0,0.3)` (dark `0 0 20px rgba(255,255,255,0.4)`). Spring stiffness 350, damping 30.
- Hover pill: neutral-100 (dark: white at 10 percent), scale 0.8 to 1 with fade, spring stiffness 400, damping 25.
- Tooltip: opacity 0 to 1, y 10 to -50, scale 0.8 to 1, 200 ms ease-out. Box: neutral-900 fill, 1 px neutral-700 border, radius 8, padding 12 by 6, text 12 px weight 600, 8 px rotated-square arrow.
- Icon motions: home scale 1.1 and y -2 (spring 400/10); search rotates through 0, -10, 10, 0 over 500 ms; bell rotates through 0, 15, -15, 10, -10, 0 over 500 ms; profile scale 1.1 (spring 300); settings rotates 90 (spring 200).
- Keys: left and right arrows wrap and move focus. ARIA roles are in the source.
- Dependencies: framer-motion, Tailwind v4.
- Cost: low.
- QML: `Row` in a rounded `Rectangle`; pill as in item 1; icon motions as `SequentialAnimation` on `rotation`. Our icons come from the existing icon set (schema `icons` weight), not lucide.
- Studio use: the top bar mode switches in `Main.qml` (not a bottom dock, to stay clear of the preview). UNVERIFIED which top-bar group fits best until `Main.qml` top bar is read in detail.
- Live fallback: no icon wiggles, no glow, pill jumps.

### 3. Glass Shimmer Button
- Source: `components/rareui/GlassShimmerButton/GlassShimmerButton.tsx`.
- Visual: a dark pill with a white light band sweeping across forever, thin glossy top and bottom lines, a soft glow on hover.
- Geometry: `rounded-full`, padding 32 by 12, text 16 px weight 500, letter spacing 0.025em, 1 px border white at 10 percent, blur 12 px.
- Colour: light mode `#262626`, hover `#0a0a0a`; dark mode `#f5f5f5`, hover white. Text white (dark: black). Shadow `0 0 20px rgba(0,0,0,0.1)`.
- Shimmer: gradient left to right, transparent, white 100 percent at 50 percent, transparent. Layer is 200 percent wide, left -50 percent. Keyframes from `translateX(-150%) skewX(-20deg)` to `translateX(150%) skewX(-20deg)`. 2.5 s, linear, infinite. Source note: the layer is `-z-10`, so it may hide behind the background in a browser. Intended look is a visible sweep, but at what opacity is UNVERIFIED. Plan a 25 percent peak alpha.
- Gloss lines: top 1 px, white at 40 percent centre, element opacity 0.5; bottom 1 px white at 10 percent, opacity 0.3.
- Hover: scale 1.05, glow layer white at 5 percent fades in 300 ms. Press: scale 0.95. A hover shadow value in source is malformed and does nothing.
- Dependencies: styled-jsx keyframes, no framer-motion.
- Cost: medium while shimmering (one animated item per visible button, clipped).
- QML: `Rectangle` with `clip: true`; inside a skewed `Rectangle` with `Gradient`, `Translate` animated by `NumberAnimation` (2500 ms, linear, loops). Skew with `transform: Matrix4x4`. Run the shimmer only while the button is visible and hovered or once every few seconds (change: source loops always). Mark as "primary call to action" only: not on every button.
- Studio use: `UButton` style `glass` (schema `components.button.style` add `"glass"`). Use for Go Live-adjacent primary actions off air only.
- Live fallback: static gradient, no sweep.

### 4. Liquid Button
- Source: `components/rareui/LiquidButton/LiquidButton.tsx`.
- Visual: a solid button with ten round drops that hang under it and fall in a loop on hover. A gooey filter merges drops with the button so they look like melting liquid.
- Button: `rounded-lg` (8 px), padding 32 by 8, text 16 px (20 px from 768 px), bold, letter spacing wide; default colours black, white text (dark: white, black text). Wrapper padding 16 px.
- Gooey filter (SVG): Gaussian blur stdDeviation 10, colour matrix alpha row `0 0 0 18 -7`, composite `atop`.
- Hover: scale 1.02, spring stiffness 300, damping 15.
- Mouse: drop x offset follows the pointer: `x = clientX - centre`, spring (stiffness 300, damping 30), mapped over [-200, 200] to plus or minus `factor` where `factor = duration * 10`.
- Drops (left %, size px mobile/md, delay s, duration s): 10 (12/16, 0.1, 2.1); 20 (16/20, 0, 2.0); 30 (8/12, 0.6, 2.5); 40 (20/24, 0.8, 2.4); 50 (12/16, 0.4, 1.8); 55 (8/12, 1.5, 2.7); 65 (24/28, 1.2, 2.6); 75 (12/16, 0.9, 2.3); 80 (16/20, 0.2, 2.2); 90 (12/16, 0.5, 2.8).
- Drop motion: keyframes y 0, 20, 140; scale 1, 1.1, 0; times 0, 0.3, 1; ease-in; infinite repeat; starts on hover (or prop `isDripping`).
- Dependencies: motion/react, SVG filter.
- Cost: medium to high (SVG blur and 10 loops; filter is the heavy part).
- QML: no SVG filter in Qt. Use a `ShaderEffectSource` that renders the button plus drops to a texture, then a small `ShaderEffect` with a blur and a threshold (`smoothstep` on alpha) to get the goo. Or fake it: no goo, drops are plain circles with a short stretched neck `Rectangle` between button and drop. Plan: slice 1 uses the cheap fake; the shader goo comes in the GPU slice. Needs qsb `.frag` (alpha threshold of a 2-pass blur: use `MultiEffect` blur then a threshold shader).
- Studio use: one "hero" button only (for example the first-run Start button). Not for repeated controls.
- Live fallback: plain solid button, no drops.

### 5. Liquid Tooltip
- Source: `components/rareui/LiquidTooltip/LiquidTooltip.tsx`.
- Visual: a small dark bubble with a rotated-square arrow. It pops up, and as the pointer moves along the target the bubble slides sideways and tilts like it is hanging from a thread.
- Box: neutral-900 fill, text neutral-100, radius 12, padding 12 by 6, text 12 px bold, mono label with tight tracking, `shadow-xl`. Dark theme inverts. Arrow 8 by 8 rotated 45.
- Placement: top, bottom, left, right. Top offset 48 px, side offset 8 px.
- Enter: opacity 0 to 1, scale 0.6 to 1, y 10 to -10 (mirrored per side). Spring stiffness 260, damping 20.
- Tilt: pointer offset from the target centre, input range [-100, 100] maps to rotation [-45, 45] degrees; sliding spring stiffness 100, damping 15, mass 0.1.
- Dependencies: framer-motion, Tailwind.
- Cost: low.
- QML: one shared `ToolTipLiquid` item placed by `UButton`, `UIconButton`, `UToggle` through their existing `tip` property (they set `ToolTip.visible` and `ToolTip.text` now, 500 ms delay). Replace with a `ToolTip.toolTip` custom `contentItem`/`background`. `Rotation` and `Translate` driven by a `HoverHandler` point. Keep the 500 ms delay.
- Studio use: all tooltips. Keep one item, reuse it.
- Live fallback: fade only (150 ms), no tilt, no spring.

### 6. Neumorphism 3D Button
- Source: `components/rareui/Neumorphism3DButton/Neumorphism3DButton.tsx`.
- Visual: a soft embossed pill. On press the face sinks, shadows flip inside, label shrinks slightly.
- Geometry: `rounded-full`, face padding 24 by 16, label 14 px weight 500, tracking tight, a sheen overlay at 25 percent opacity with 0.0125em blur, sized 0.15em larger each side. Em-based shadows (scale with font size).
- Face gradient (light): 135 deg `rgb(240,240,240)` to `rgb(210,210,210)`; dark: `rgb(40,40,40)` to `rgb(20,20,20)`. Button base `neutral-200` (dark `neutral-900`).
- Outer shadows (light, rest): `-0.15em -0.15em 0.15em -0.075em white, 0.0375em 0.0375em 0.0675em 0 rgba(0,0,0,0.15)`. Dark: white at 5 percent and black at 50 percent.
- Wrapper shadows (light, rest): `0 0.05em 0.05em -0.01em rgba(0,0,0,0.2), 0 0.01em 0.01em -0.01em rgba(0,0,0,0.1), 0.15em 0.3em 0.1em -0.01em rgba(0,0,0,0.05)`. Pressed: `0 0 0 0` (flat). Dark values 0.5, 0.3, 0.2.
- Face inset (light, rest): `inset -0.05em -0.05em 0.05em rgba(0,0,0,0.1), inset 0.025em 0.05em 0.1em white`. Pressed: `inset 0.1em 0.15em 0.05em rgba(0,0,0,0.1), inset -0.025em -0.03em 0.05em 0.025em rgba(255,255,255,0.5)`. Dark values use 0.5 and 0.1.
- Sheen overlay: gradient -135 deg black at 20 percent to transparent at 20 percent, multiply blend (dark: white at 10 percent, overlay blend).
- Press: face and label scale 0.975. Timings: outer and wrapper 300 ms, face and label 250 ms, default ease. No touch or keyboard states in source.
- Label: gradient text neutral-800 to neutral-600 (dark: neutral-100 to neutral-300).
- Dependencies: CSS only.
- Cost: low to medium (multi-layer shadows are many `Rectangle` and `MultiEffect` shadow items; paint once, animate only opacity and scale).
- QML: CSS inset and spread shadows do not exist. Build with layers: outer `MultiEffect` shadow (shadowEnabled, blur, offset), face `Rectangle` with `Gradient`, inner highlights as `Rectangle` rings with clipped offset gradient, pressed state cross-fades a second pre-built layer set. Maps to existing schema `button.style: "neumorph"` (already in the enum) and `card: "neumorph"`.
- Studio use: `UButton` and `UIconButton` style `neumorph` (theme choice), `UCard` neumorph, `USwitch`.
- Live fallback: flat fill with a 1 px border, no shadows (matches High performance flat rule).

### 7. Particle Card
- Source: `components/rareui/ParticleCard/ParticleCard.tsx`.
- Visual: a 330 by 450 card with a photo. On hover the photo breaks into 480 tiles that fly outward and fade, revealing a back panel with name, role, tags and a button.
- Grid: 20 columns by 24 rows. Each tile samples its own slice of the photo (`backgroundSize 2000% 2400%`). Tile is 100.5 percent of its cell to hide seams.
- Explosion: centre cell (10, 12). Spread 150 to 450 times (1 to 1.5), translate times 1.5 (up to about 1000 px), rotation plus or minus 180 times 2, scale 0.5 to 1 times 0.8. Delay = distance times 20 ms plus random up to 150 ms (about 460 ms for edge cells).
- Timing: transform 5400 ms with `cubic-bezier(.2,.8,.2,1)`; opacity 5400 ms ease-in, delay plus 500 ms. This is far longer than our 600 ms entrance cap and is not suitable for the live studio.
- Card: radius 8, `shadow-2xl`, hover scale 1.02 in 400 ms ease-out. Back layer gradient from background to muted, content fades up 20 px in 800 ms (delay 200 ms). Tag chips: 12 px weight 600, padding 12 by 4, radius 6. Button: radius 12, padding 12 vertical, 14 px weight 600, `shadow-lg`.
- Mobile: tap toggle (source has a bug where tap flips the mobile flag).
- Dependencies: motion/react; no canvas; 480 DOM tiles.
- Cost: high (480 animated items).
- QML: do not use 480 items. Use `QtQuick.Particles` is not linked and not needed: make one `ShaderEffect` with a grid-based fragment shader (each cell offset by a deterministic hash plus a uniform `progress`), or use a `Repeater` with 120 tiles (10 by 12) and a `SequentialAnimation`. Plan: shader grid, one draw call, `progress` from a `NumberAnimation` of 600 ms (shortened from 5400 ms to obey the rule).
- Studio use: low priority. Candidate: clip review thumbnail "peek" or the About card. Not a settings control.
- Live fallback: instant swap of front and back, no shatter.

### 8. Premium Button
- Source: `components/rareui/PremiumButton/PremiumButton.tsx`.
- Visual: a lime pill with a metallic crown icon. On hover the gradient slides.
- Geometry: radius 30, padding 40 horizontal, 1.2em vertical, gap 0.4 rem, bold black text.
- Fill: `linear-gradient(15deg, #ddff00, #b8d100, #93a300, #6e7500, #ddff00, #b8d100, #93a300, #6e7500)`, size 300 percent, position left; hover size 320 percent, position right.
- Shadows: box `0 30px 10px -20px rgba(221,255,0,0.2)`; text `2px 2px 3px rgba(221,255,0,0.3)`.
- Timing: 300 ms ease-out on background and colour.
- Icon: 23 px wide, viewBox 36 by 24, path `m18 0 8 12 10-8-4 20H4L0 4l10 8 8-12z`, black fill.
- Dependencies: none (CSS).
- Cost: low.
- QML: `Rectangle` with a repeating `Gradient` drawn at 3x width, `x` animated 300 ms (use `clip`). The lime is a brand choice, so take stops from the theme accent: build 4 shades from `Theme.c.accent` (100, 82, 64, 48 percent lightness steps). Crown icon as a small `Shape`/`Canvas` once.
- Studio use: `UButton` style `premium` for upgrade-type or "pro" actions (maybe the Go Live button off air).
- Live fallback: flat accent fill.

### 9. Premium Profile Card
- Source: `components/rareui/PremiumProfileCard/PremiumProfileCard.tsx`.
- Visual: a 320 by 500 paper-like card. The pointer tilts it in 3D. A click flips it to a dark back with a skill list and contact rows. A glowing border spins on hover.
- Radii: faces 24, glow border 27, image area top 20 and bottom 4. Padding front 12, back 24.
- Tilt: rotateY = mouseX divided by 32, rotateX = minus mouseY divided by 32, clamp plus or minus 10 deg (effectively about plus or minus 5 and 7.8 deg). Transition 700 ms. Perspective 1000 px. Flip: add 180 deg to rotateY.
- Front: `#FDFCF8` (dark `#0d0d0d`), grain overlay, sheen (soft-light, white at 30 percent band at 105 deg, fades in 1000 ms), photo grayscale with parallax 0.2 times tilt.
- Glow border: conic gradient, spin 4 s linear infinite, fades in 500 ms on hover.
- Ambient glow: 500 by 500 circle, blur 80 px, black at 5 percent.
- Text: name 40 px serif, role 10 px bold tracking 0.2em, status dot 6 px pulsing. Arrow button 40 px round: hover scale 1.1, 300 ms.
- Back: `#0a0a0a`, grid texture lines 20 px at 8 percent opacity, 2-column skills, contact rows with hover shift 4 px and white at 5 percent.
- Dependencies: lucide icons, external grain SVG and photo (we draw our own).
- Cost: medium (3D tilt plus blurred glow plus a spinning conic border).
- QML: tilt with `Rotation` (axis x and y, origin centre) plus a fake perspective (`Scale` shrink by cos); flip with two faces and `visible` switching at 90 deg; conic spinning border via `ConicalGradient` is in `Qt5Compat.GraphicalEffects` (not linked), so use a `ShaderEffect` or a `Canvas` ring instead. Plan: `ShaderEffect` with a tiny conic frag.
- Studio use: low. Candidate: the "profile" / channel card in Settings, or the About page. Not required for live work.
- Live fallback: no tilt, no spinning border, flip is an instant swap.

### 10. Retro Pixel Button
- Source: `components/rareui/RetroPixelButton/RetroPixelButton.tsx`.
- Visual: a 64 px tall monospaced button. A coloured block sits left with a pixel arrow. On hover the block grows across almost the full width, the arrow turns 180 deg, the label slides left and turns white.
- Geometry: height 64, padding 32, radius 8, 1 px border `#fdba74` (orange-300), font mono weight 500, background token, `shadow-sm` to `shadow-md` on hover. Press scale 0.98.
- Block: top, left, bottom inset 4, radius 4; width 55 px at rest, 97 percent on hover; spring stiffness 400, damping 30. Colour `orange` (prop `pixelColor`).
- Arrow: icon box 64 px wide; 40 px svg, viewBox 16 by 34; five 5 by 5 squares at (7,6) (11,10) (15,14) (11,18) (7,22); rotate 0 to 180, spring stiffness 300, damping 20.
- Label: padding left 64 to 0 and right 0 to 64 over 400 ms; colour to white over 200 ms; spring (stiffness 200, damping 25, mass 1). Blur 2 px pulse and opacity pulse (1, 0.5, 1) over 300 ms.
- Dependencies: framer-motion.
- Cost: low.
- QML: `Rectangle` for the block with `SpringAnimation` on `width`; five small `Rectangle` pixels in an `Item` with `rotation`; label `x` via `Behavior`. Use `Theme.c.accent` instead of orange. Pixel font: monospace from the bundled families.
- Studio use: `UButton` style `pixel` for the retro-wave and neon-arcade themes (existing theme files).
- Live fallback: no blur pulse, block jumps without spring.

### 11. Soft Button
- Source: `components/rareui/SoftButton/SoftButton.tsx`.
- Visual: a transparent pill with soft sculpted shadows. On hover it turns black, grows, glows with the primary colour, and letter spacing widens.
- Geometry: 160 by 50, radius 30, weight 500, letter spacing 1 px (2 px on hover), borders top and bottom 1 px white at 10 percent (dark: black at 20 percent).
- Rest shadows (light): `4px 4px 6px rgba(255,255,255,0.5), -4px -4px 6px rgba(116,125,136,0.5), inset -4px -4px 6px rgba(255,255,255,0.2), inset 4px 4px 6px rgba(0,0,0,0.4)`. Dark: 0.05, 0.5, 0.05, 0.6.
- Hover: scale 1.05, black fill (dark: white), glow `0 0 20px primary at 60 percent`, outer lights 8 px blur at 0.3 (dark 0.08 and 0.6). Inset layers dropped on hover.
- Press: scale 0.98. Timing 600 ms `transition-all`, default ease (longer than our 400 ms target for a button; we use 250 ms).
- Dependencies: CSS, theme tokens.
- Cost: low to medium (shadow layers).
- QML: like item 6, with the same layer technique; share one `ShadowLayers` helper component for 6 and 11 and the Card neumorph look. Maps to schema `button.style: "soft"` (already in enum) and `card: "soft"`.
- Live fallback: flat field fill, 1 px border.

### 12. Toast Tabs
- Source: `components/rareui/ToastTabs/ToastTabs.tsx`. Note: it is not a toast system. It is an avatar tab row plus a speech bubble that swaps with the active tab.
- Visual: a row of 48 px round avatars. The active one is scaled 1.25 inside a glass ring with a progress ring that fills over the autoplay time. A dotted-border speech bubble above shows the text for the active tab.
- Props: autoplay true, autoplayDelay 3000 ms, ring colour `#f97316`. Hovering the root pauses autoplay (progress paused). Click resets progress. Arrow keys move and wrap.
- Bubble: `max-w-xs`, radius 16, 2 px dotted border (light neutral-300, fill neutral-100; dark neutral-600, fill neutral-800), padding 12, text 14 px weight 500. Tail 16 px rotated square. Enter: opacity 0 to 1, y 20 to 0, scale 0.9 to 1, blur 4 to 0; exit y -20; spring stiffness 260, damping 20 (duration 0.4).
- Ring: shared-layout spring stiffness 300, damping 30; `-inset-2` (8 px out), border white at 20 percent, fill neutral-200 at 50 percent, blur 12 px. Progress circle r 28 in a 60 box, stroke 1.5, dash 175.929, round cap, glow `drop-shadow 0 0 2px`.
- Avatar: active scale 1.25 and shadow-xl; inactive scale 0.9, opacity 0.4, grayscale; inactive hover scale 1.1, full opacity. Hover lift 8 px, 300 ms.
- Dependencies: framer-motion (`useAnimationFrame` per frame while autoplay).
- Cost: low to medium (one animation frame loop while autoplay).
- QML: use as a tabs variant, not as a toast. The progress ring is a `Shape` with `ShapePath` (`QtQuick.Shapes`, part of Qt Quick, no new module; UNVERIFIED that it is already linked, it is part of `Qt6::Quick` so it needs no new link) or `Canvas` with arc. Bubble is a rounded `Rectangle`. Studio use: the Look/theme picker (preview each theme with its description in a bubble), the first-run guide steps (`Guide.qml`, with autoplay off) and the Clips review tab strip. See also Notifications below: its toast-like bubble look is reused for the notification message style.
- Live fallback: no autoplay ring animation, no blur, instant switch.

### 13. Liquid Metal
- Source: `components/rareui/LiquidMetal/LiquidMetal.tsx` (also `LiquidMetalLazy`).
- Visual: a logo or text filled with a flowing chrome-like metal: black and white stripes that move, with colour fringing on the edges.
- Tech: WebGL2 full-screen quad, GLSL ES 3.00 fragment shader, simplex noise, three per-channel stripe passes. Not three.js.
- Props: speed 0.3, dispersion 0.005, edge 0.5, patternBlur 0.005, liquify 0.08, patternScale 2, text "RareUI" (default logo is 180 px weight 900 Arial Black, stroke 5, letter spacing -5).
- Colours: `color1 = (0.98, 0.98, 1.0)`, `color2 = (0.1, 0.1, 0.1 + 0.1 * smoothstep(0.7, 1.3, uv.x + uv.y))`.
- Image pipeline (CPU, once): scales to 500 to 1000 px, builds an edge field with 300 Jacobi iterations (about 1.2 billion reads at 1000 by 1000: freezes a browser UI), remaps with `pow(raw, 2)`.
- Timing: `t = 0.001 * mod(u_time, 10000)`; at speed 0.3 the clock wraps every about 33 s with a visible jump (source bug).
- Interaction: none.
- Dependencies: WebGL2, Canvas 2D.
- Cost: high (about 100 or more ALU ops per pixel per frame; plus the CPU bake).
- QML: `ShaderEffect` with a `.frag` compiled by `qsb` (`qt_add_shaders`). Port the stripe math. Do the edge field offline: bake a small distance texture once in C++ or in a QML `Canvas` at load, or use a signed-distance approximation with `ShaderEffectSource` blur (fewer iterations). Wrap the time uniform with a periodic function to avoid the jump. Render only while visible and cap to 30 fps with a `FrameAnimation` throttle.
- Studio use: one place only: splash / About header word mark. Never behind live controls.
- Live fallback: static first frame (a pre-rendered image) or flat text.

### 14. Loading Spinner
- Source: `components/rareui/LoadingSpinner/LoadingSpinner.tsx`.
- Visual: a 24 px ring with a rotating arc and a blurred copy for glow, next to "Loading..." text with a gradient that glides across it.
- Geometry: viewBox 18; track circle r 7.25, centre (9, 9); arc from 3 o'clock about 49 deg clockwise (`M 16.25 9` to `13.724 14.5`); stroke width 2 (about 2.67 px), round caps.
- Colours: track `#e5e5e5` (dark `#262626`); arc black (dark white); blurred copy opacity 0.6, blur 2 px.
- Timing: rotation 360 deg in 1 s, linear, infinite. Label shimmer: gradient `neutral-950 via neutral-500 to neutral-950` (dark `#f1f2f4`, neutral-500), background size 200 percent, position 200 percent to -200 percent over 3 s, linear, infinite. Text 14 px weight 500.
- Dependencies: framer-motion.
- Cost: low (one rotating item).
- QML: `Canvas` once for the ring; `Item` with `RotationAnimation` (1000 ms, linear, infinite) for the arc; glow by a second semi-transparent arc (no blur needed) or `MultiEffect` blur in non-live mode. Text shimmer with a `Gradient`-filled mask: `ShaderEffect` or simply animate a clipped light `Rectangle` over `Text`; or skip shimmer in live mode.
- Studio use: busy state on tasks (`TaskChip.qml`, `TaskCenter.qml`), import, clip render, "Loading..." placeholders.
- Live fallback: the arc rotates slowly (this is a status indicator, not decoration); no blur, no text shimmer.

### 15. Magnetic Scatter Text
- Source: `components/rareui/MagneticScatterText/MagneticScatterText.tsx`.
- Behaviour correction: the source is not magnetic. It tracks no cursor. Hovering the text scatters every letter by fixed offsets.
- Visual: each letter is its own item. On first show, letters fly in from far away (hidden state offset times 5, up to about 500 px, rotation up to 180, opacity 0, scale 0.5). On hover they scatter by plus or minus 50 px and 36 deg and scale 1.1.
- Offsets (deterministic per index): `seed = index * 42`, `x = sin(seed) * 100`, `y = cos(seed) * 100`, `rotate = sin(seed * 2) * 180`.
- Springs: visible: damping 12, stiffness 80, mass 0.8, delay `index * 0.02` s; scatter: damping 15, stiffness 200.
- Type: sans bold, black (dark white).
- Dependencies: framer-motion, DOM spans.
- Cost: low to medium (scales with letter count).
- QML: `Repeater` over characters in a `Flow` or `Row`. Each letter a `Text` with `x`, `y`, `rotation`, `scale` driven by `SpringAnimation`. Keep to under 24 letters. Reuse one exact spring helper. Consider adding true pointer-follow (distance based) since the name promises it: ask the user (see questions).
- Studio use: first-run welcome title, empty-state headings ("No clips yet"). One-shot entrance only, not hover scatter on live screens.
- Live fallback: plain text, no motion.

### 16. Sound Text
- Source: `components/rareui/SoundText/SoundText.tsx`.
- Visual: letters pop up as the pointer passes over them (y -10, scale 1.3, random tilt plus or minus 5 deg, colour `#A855F7`, glow `0 0 8px rgba(168,85,247,0.6)`). Each letter also plays a note.
- Springs: hover in stiffness 500, damping 10; hover out stiffness 300, damping 20; entrance stiffness 200 with delay `index * 0.02` s, fade and rise 20 px.
- Audio (Web Audio): sine oscillator per hover. Frequency = `basePitch * ratios[index % 6] * 2^(floor(index / 6) * 0.5)`; ratios 1, 1.125, 1.25, 1.5, 1.667, 2; basePitch default 300 Hz. Gain: 0 to 0.3 over 20 ms, then exponential to 0.001 at 300 ms; the oscillator stops at 0.4 s.
- Dependencies: framer-motion, Web Audio.
- Cost: low visually; audio needs a sound source.
- QML: letter animation as in item 15. Audio is a real problem for a streaming app: the studio audio path is libobs, and a UI sound can leak into the stream or monitoring bus. Do not play a sound. Instead reuse the idea visually: letters bounce with the mixer level (the user already named this use). Proposed: On Air bar label letters raise by `level * 10 px`, with the colour moving toward `accentHi` as level rises. Source of level: the existing mixer meter value (see `MixerPanel.qml`; exact property UNVERIFIED).
- Studio use: `OnAirBar.qml` status word ("ON AIR") driven by mixer level. Off air, the hover version for the Help page title.
- Live fallback: while live, the level-driven bounce is allowed only if it is cheap (the level already updates at meter rate, so it costs one binding per letter); under High performance it is off and the word is static. No UI sounds, ever.

### 17. Vapor Smoke Text
- Source: `components/rareui/VaporSmokeText/VaporSmokeText.tsx`.
- Visual: letters appear out of smoke: from blur 20 px, scale 1.5, y 20, rotate 5 deg and opacity 0 to sharp, one after another. Serif italic.
- Timing: container delay `0.2 * i` (i = 1, so 0.2 s), stagger 0.08 s per letter. Spring damping 12, stiffness 100, duration 1.5 s on the visible state (in newer framer-motion an explicit duration may override the spring; UNVERIFIED which wins). Estimated settle about 0.7 s. Hide: all letters together.
- Wrapper clips overflow.
- Dependencies: framer-motion.
- Cost: medium (CSS blur on each letter; blur is the expensive part).
- QML: per-letter `Text` with `opacity`, `scale`, `y`, `rotation`; blur through `MultiEffect` (`blurEnabled`, `blurMax`) on a `layer.enabled` item, only during the entrance, then `layer.enabled = false`. Cap the duration to under 600 ms entrance (the stagger delay is fine because each letter's own entrance is under 600 ms).
- Studio use: scene or look change title card, empty-state heading, splash. Never on live controls.
- Live fallback: fade only, no blur.

### 18. Word Magnet
- Source: `components/rareui/WordMagnet/WordMagnet.tsx`.
- Visual: a sentence whose words are pushed away from the pointer, then spring back.
- Interaction: window `mousemove` (throttled 16 ms). Radius 130 px. Force 0.45 (range 0.1 to 1.0). Push = `((radius - distance) / radius) * force * 100`, so up to about 45 px at the centre. Direction: away from the pointer.
- Springs: stiffness 200 (fixed), damping 28 (range 5 to 50). Return: each in-radius update resets a 400 ms timer that sets the offsets to 0.
- Default type: 32 px, weight 600, spacing -0.03em, line height 1.2em, gap 0.5em between words.
- Mobile: can be disabled (`window.innerWidth < 768` or touch).
- Source issues: the X handler reads a stale Y; the maths uses displaced rects so it feeds back.
- Dependencies: framer-motion; DOM measurements each move.
- Cost: low to medium (per word per move).
- QML: `Repeater` of words in a `Flow`; one `HoverHandler` on the parent gives the pointer; each word computes distance from its own centre in a binding (use the rest position, not the displaced one, to avoid the feedback); `SpringAnimation` on `x` and `y` offsets (spring and damping from the source). Return after 400 ms of no in-radius pointer.
- Studio use: marketing-style headings on the Help or Guide start page. Not in working screens.
- Live fallback: static text.

### 19. Book 3D
- Source: `components/rareui/Book3D/Book3D.tsx`.
- Visual: a 230 by 350 book. On hover it tilts toward you (rotateY -35, rotateX 15, z 60). The front cover opens to the left, and clicking pages flips them. A soft shadow sits on the "floor".
- Parts back to front: back cover `#2f2f2f` at z -20 with shadow `20px 20px 50px rgba(0,0,0,0.5)`; six pages (`#fffcf5`, back faces `#f8f5f0`) each rotating around the left edge by -178 deg when flipped, z = pages minus 1 minus index px; front cover opens -180 deg; inner cover `#f5f1e8`.
- Timing: page flip 0.6 s, delay `index * 0.05` s when closing; cover 0.8 s (delay 0.5 s when closing); ease `[0.23, 1, 0.32, 1]` (ease-out quart-like). Flip debounce 300 ms. Un-hover resets pages after 300 ms. Page flip 0.6 s and cover 0.8 s exceed our 400 ms exit rule for overlays; this is a Help page decoration, not an overlay, but cap to 450 ms in the port.
- Texture and gloss: paper texture at 10 percent, spine creases (12 px gradient black at 20 percent to transparent, 2 px binding), ground shadow ellipse 40 px high, blur 24 px, black at 40 percent, hover scale 1.1 and opacity 0.8.
- Cover (default branding): dark gradient neutral-900 to neutral-800, a 32 px dot pattern, two inset frames, four corner ornaments (32 px, 2 px border, white at 30 percent), title 36 px serif bold.
- Dependencies: framer-motion, Tailwind v4, external paper PNG (we skip it).
- Cost: medium (many layers; transform-only animation).
- QML: faked 3D with Rotation, no Quick 3D. Each page is an `Item` with a `Rotation { axis.y: 1; origin.x: 0 }` and a second face shown by `back` rotation past 90 deg (hide the front face when the angle passes 90, show the back face counter-rotated by 180). Perspective: use `Rotation` plus a small `Scale` and `Translate` to fake depth (cos-based foreshortening) because Qt Quick 2D has no perspective camera. Ground shadow: radial `Gradient` ellipse (no blur). Tilt on hover: `Rotation` on the whole book.
- Studio use: `HelpPanel.qml` / `Guide.qml`: a help book whose pages are guide topics (page flip while reading). Page content comes from the existing guide text.
- Live fallback: closed flat book icon; pages swap with a quick cross-fade, no tilt, no shadow.

### 20. Liquid Wave
- Source: `components/rareui/LiquidWave/LiquidWave.tsx` (and `LiquidWaveLazy`).
- Behaviour correction: it is not a sine wave. It is a GPU fluid simulation (stable fluids): the pointer stirs a velocity field, and colour is mixed by velocity magnitude over a transparent background.
- Tech: three.js, WebGLRenderTarget ping-pong, 7 float buffers at half the container size (`resolution` 0.5), BFECC advection, 32 Jacobi pressure iterations, optional viscous diffusion (32 iterations), colour palette from three stops (default all `orange`).
- Defaults: mouseForce 20, cursorSize 100, dt 0.014, iterationsPoisson 32, iterationsViscous 32, viscous 30, BFECC true, isBounce false.
- Auto demo: after 3000 ms idle, a virtual pointer wanders to random points (speed 0.5, intensity 2.2, ramp 0.6 s, takeover 0.25 s). Pauses when off screen or tab hidden.
- Touch: single-finger.
- Cost: high (about 37 draw calls per frame, 69 with viscous).
- QML: no fluid solver in plain QML. Two options. (a) Real: a chain of `ShaderEffect` plus `ShaderEffectSource` with `recursive: true` for ping-pong; about 37 passes is too heavy to run beside a live encode. (b) Cheap look-alike: one `ShaderEffect` with layered sine waves and a few pointer "blobs" in a single pass (about 1 draw call). Choose (b). It is also the only choice that can obey the live gate.
- Studio use: studio window background behind the side panels only, never behind the preview or mixer meters. Controls on top stay opaque.
- Live fallback: off. Plain background colour or the theme's static gradient.

### 21. Image Expand Testimonial
- Source: `components/rareui/ImageExpandTestimonial/ImageExpandTestimonial.tsx` (and a copy at `Sections/imageExpandTestimonial.tsx`).
- Visual: a strip of image cards. The active card is tall (220 by 550 desktop; 200 by 350 mobile) in full colour. The others are small (100 by 100; 60 by 80) and grey. Clicking a small card expands it. Beside the strip: a counter, a vertical "Reviews" label, name, company, quote, star rating, previous and next buttons, and mobile dots.
- Card: radius 6, border white at 50 percent (dark white at 10 percent), `shadow-lg`, active `shadow-2xl`. Inactive opacity 0.6 (hover 1), overlay black at 10 percent. Filter: active `grayscale(0) brightness(1.05)`, inactive `grayscale(1) brightness(0.9)`.
- Expand: spring on width and height, stiffness 180, damping 24, mass 1.2.
- Text change: exit then enter (`mode="wait"`): opacity 0 to 1 and x 20 to 0, 300 ms ease-out, so about 600 ms total.
- Autoplay: 5000 ms; it goes backward in source (naming bug); no pause on hover.
- Layout: strip gap 16; gap to text 48; text column 400 px (450 px from xl). Name 30 px bold, company 14 px uppercase tracking wider, quote 20 px weight 500.
- Buttons: previous (grey) and next (`yellow-400` with `shadow-yellow-400/30`), round, padding 16, hover scale 1.05 and 1.1.
- Dependencies: motion/react, lucide icons, Next image.
- Cost: low to medium (layout animation of 3 to 5 cards).
- QML: `Row` with card items whose `width` and `height` follow `SpringAnimation`; greyscale and brightness: `MultiEffect` (`saturation: -1`, `brightness`) on `layer.enabled` only during transition, or a `ShaderEffect`. Replace yellow with `Theme.c.accent`. Do not copy "reviews"; this becomes a clip strip.
- Studio use: `ReviewWindow.qml` clips review: the active clip is tall with its title, tags and score; others are thumbnails. Autoplay is off; keyboard arrows move.
- Live fallback: instant size change, no filter animation.

## Notifications

### 22. Sonner (toasts), version 2.0.8
- Source: `src/index.tsx` and `styles.css` (read from `dist/index.mjs` and `dist/styles.css`, 2.0.8). MIT.
- Visual: toasts stack in a corner. The newest is in front at full size. Older ones sit behind, shifted and scaled down. Hovering the stack expands it so every toast is readable.
- Constants (from source): default lifetime 4000 ms; visible toasts 3; toast width 356; gap 14; viewport offset 24 px (mobile 16 px); swipe threshold 45 px; swipe velocity limit 0.11 (px per ms); time before unmount 200 ms; default position `bottom-right`; default hotkey Alt + T to focus the toaster.
- Toast box: padding 16, 1 px border, radius 8, shadow `0 4px 12px rgba(0,0,0,0.1)`, font 13 px; title weight 500 and line height 1.5; description weight 400 and line height 1.4; icon 16 px; gap 6; action button height 24, radius 4, padding 8, font 12 px weight 500; close button 20 px round, shown on hover at the corner.
- Stacking (collapsed): each toast behind the front one gets `scale = 1 - 0.05 * toastsBefore` (the CSS computes `scale(calc(-1 * (toastsBefore * 0.05 + 1)))`, the sign makes it shrink in effect; the values are 0.95, 0.90), and `translateY(lift * gap * toastsBefore)` with gap 14. Height is clamped to the front toast height. Children fade to opacity 0 behind the front toast. z-index is `count - index`.
- Expanded (pointer over the stack, or `expand` option): every toast moves to its own offset (the sum of earlier heights plus gaps) at its own full height.
- Transitions: `transform 400ms, opacity 400ms, height 400ms, box-shadow 200ms`. Entry: translate 100 percent off the edge, opacity 0 to 1. Removal of a front toast: translate 100 percent away, opacity 0, 400 ms. Removal of a back toast, collapsed: translateY 40 percent and opacity 0 with `transform 500ms, opacity 200ms`. The CSS timing function is the default `ease`. The unmount waits 200 ms.
- Swipe: direction lock after 1 px of movement. Dismiss when the swipe is at least 45 px or the velocity is above 0.11. Wrong direction movement is damped by `1 / (1.5 + |delta| / 20)`. Swipe-out animation: 200 ms ease-out, slide 100 percent away and fade. During a swipe the transition is off.
- Pause: the timer pauses while the stack is expanded (hover), while the user is interacting, and while the page tab is hidden (`visibilitychange`). The remaining time is kept and restarts later.
- Types: normal, success, info, warning, error, loading, promise (loading then success or error), plus custom JSX, action button, cancel button, close button, description. Rich colours (per type background, border and text; e.g. light success `hsl(143,85%,96%)`, light error `hsl(359,100%,97%)`; dark error bg `hsl(358,76%,10%)`). Loading shows a 16 px, 12-bar spinner with 1.2 s linear opacity cycle, stagger 0.1 s.
- Reduced motion: transitions and animations off.
- Cost: low.
- Fit with the studio overlay rule: entrances under 600 ms and exits under 400 ms. Sonner's 400 ms enter and 400 ms exit: the exit sits exactly at the limit, and the back-toast removal is 500 ms, which breaks it. Port: enter 350 ms, exit 300 ms, back-toast removal 300 ms, swipe-out 200 ms. Use the studio easing (`outCubic` or the theme's `easing`), and take base durations from `Theme.fast` and `Theme.normal` clamped to these limits.

#### QML port for the studio toasts
- Where toasts live now: `TaskCenter.qml`. Model `toasts` (a `ListModel`, lines 134 to 153) with `toast(title, note, failed)`, `closeToast(uid)`, `clickToast(uid)`, and `notice(...)`. The model already drops the oldest when count reaches 3. View: a `Popup` named `taskToasts` (lines 421 to 500), 360 px wide, in a `Column` with spacing 8, each toast a `Rectangle` with a coloured 4 px edge, a title, a note, an `x` close button, a 6000 ms `Timer`, a fade-in on creation (`opacity: 0` then 1), and a `TapHandler` that opens the task list. A probe (lines 160 to 190) reads `toastPos` from items with `isToast`. The port must keep `objectName: "toast:" + index`, `isToast`, `toastTitle`, and the model API so the existing tests and probes keep working.
- Port plan:
  1. Replace `Column` with one `Item` stack. Each delegate's `y` and `scale` are bindings from its depth `d = count - 1 - index` (0 front): collapsed `y = d * 14`, `scale = 1 - 0.05 * d`, `opacity = d < 3 ? 1 : 0`, back toasts' content opacity 0 (as source). Expanded `y = sum of heights of toasts in front + gap`, `scale = 1`.
  2. `HoverHandler` on the whole stack sets `expanded`. A grace of 100 ms avoids flicker between toasts.
  3. `Behavior on y, scale, opacity` using `NumberAnimation` 350 ms `Easing.OutCubic` (clamped by the theme motion tokens); in High performance the `Behavior` is disabled (`enabled: Theme.motion`, the studio's existing pattern).
  4. Timer: 4000 ms default (the studio uses 6000 ms today; keep 6000 ms for task toasts, 4000 ms for short notices). Pause while `expanded`, while a swipe is active, and while the studio window is not visible (`Window.visibility`). Keep remaining time. Failures: no auto close (a changed behaviour, ask the user; see questions).
  5. Swipe: `DragHandler` on x with a 1 px lock, 45 px threshold, 0.11 px per ms velocity (measure with `centroid.velocity` or timestamps), damping function as in source. On release below threshold, spring back 200 ms. On dismiss, animate x to plus or minus width and opacity to 0 over 200 ms, then `closeToast(uid)`. Do not run swipe inside `TapHandler` conflicts: use `acceptedButtons: Qt.LeftButton` and `grabPermissions`.
  6. Types: `type` role added to the model: `info` (default), `success`, `warning`, `error` (replaces `failed: bool`, keep `failed` as `type === "error"` for compat), `loading` (no auto close; spinner arc from item 14), plus optional `action: {label, id}` button (24 px high, radius 4). Promise flow: `notice` returns a uid; a new `update(uid, patch)` converts loading to success or error and restarts the timer (Sonner does this by id).
  7. Colours from `Theme.c`: success `ok`, error `danger`, warning (no token today; add `warn`, see schema), info `accent`. Rich colours = a tinted fill (type colour at 10 percent over `panel`) and the 4 px edge in the type colour.
  8. Keep position top right under the bar; move left of the task panel when it is open (existing logic: `x: center.open ? ... : ...`). Add a position setting later (Sonner supports 6 positions); not needed now.
  9. Max visible: 3 (matches the model cap). Raise the cap to 5 in the model so that the stack can show 3 and hold 2 queued (Sonner keeps all toasts in the store and shows 3).
- Combine with RareUI Toast Tabs: Toast Tabs is not a notification system; it contributes a look. Use its speech-bubble style (dotted 2 px border, radius 16, rotated-square tail, spring pop with a 4 px blur-in) as a style variant `bubble` for a toast, and its glass progress ring as the auto-close countdown ring on the close button (a thin ring that drains over the toast lifetime and pauses on hover, like the Toast Tabs autoplay ring). The stack logic comes from Sonner, the skin from Toast Tabs and the theme.
- Live safety: while live, toasts stay (they are information) but use the plain style: no stack scale animation (toasts are flat with 8 px gap, like today), no blur, no swipe spring, fade only 150 ms. In High performance the same. Failure and warning toasts must never be suppressed by the gate.
- Other notification surfaces that should share the same look (one `UNotice` base component with type colours, edge, close button and motion tokens):
  - `AlertStrip.qml` (49 lines): the warning and error strip; same type colours and edge.
  - `TaskChip.qml` and the `TaskCenter.qml` panel: the chip badge and task rows use the same type colours and the spinner for running tasks.
  - `GuideBubble.qml` (138 lines) and `GuideClose.qml`: the bubble look from Toast Tabs (tail, dotted border option).
  - `ConfirmDialog.qml` (69 lines) and `CloseDialog.qml`: the "confirm notes" text inside dialogs; same edge and type colour. Note: the studio rule says no typed phrases and no "are you sure" friction (D332), so these only restyle, they do not add steps.
  - `CommandPalette.qml`, `ClipsAsk.qml`, `ReportDialog.qml` result lines and the `Settings*` page save and error notes.
- Probe and test impact: tests in `docs/evidence/` read `taskToasts`, `toastPos` and `toastLog` (not read in this pass, UNVERIFIED). Any restack changes `toastPos` x and y; update the probe to report `depth` and `expanded` too.

## Theme schema additions needed

The schema already has `components` (button shape and style, secondary, caps; tabs; input; focus; switch; slider; sectionHeader; card; list; chip; density) read only while flag `theme-components` is on, and `motion` (fastMs, normalMs, slowMs, easing, hoverLift, pressSink). Do not break these. Proposed additions, all optional, all `additionalProperties: false` kept:

- `components.button.style`: add `"glass"` (item 3), `"premium"` (item 8), `"pixel"` (item 10), `"liquid"` (item 4). Existing: solid, soft, metal, bezel, neumorph, raised.
- `components.tabs`: add `"slide"` (item 1), `"avatar"` (item 12), `"dock"` (item 2).
- `components.tooltip`: new enum `"plain"`, `"liquid"` (item 5).
- `components.toast`: new object: `style` enum `"plain"`, `"stack"` (Sonner), `"bubble"` (Toast Tabs); `richColors` boolean; `position` enum (`top-right` default, `top-left`, `bottom-right`, `bottom-left`); `maxVisible` integer 1 to 5; `swipe` boolean.
- `components.card`: add `"tilt"` (item 9) and `"shatter"` (item 7, off by default).
- `components.spinner`: new enum `"ring"`, `"bars"` (Sonner), `"dots"`.
- `components.text`: new object: `entrance` enum `"none"`, `"vapor"`, `"scatter"`; `hover` enum `"none"`, `"magnet"`, `"bounce"`; applies to chosen headings only.
- `components.background`: new enum `"plain"`, `"waves"` (item 20); `background` block already exists, so this may belong there as `background.animated`. UNVERIFIED which fits the current `background` shape; read lines 124 to 140 of the schema before deciding.
- `components.help`: new enum `"plain"`, `"book"` (item 19).
- `components.clips`: new enum `"grid"`, `"expand"` (item 21).
- `colors`: add optional `warn` (a warning hue; the schema has `danger` and `ok` only). Optional `info` defaults to `accent`.
- `shape`: reuse `geometry.radius` (small, medium, large) for card, toast, tooltip; add `geometry.radius.pill` boolean or `button.shape: "pill"` (already exists). Soft and neumorph widths are em-based in RareUI; we take pixel values from `controlHeight` and scale.
- `motion`: add `spring` object `{ stiffness, damping, mass }` for the shared exact spring (default 300, 30, 1) and `enter` and `exit` clamp fields (enterMs max 600, exitMs max 400). Add `loopMs` for continuous effects with value 0 meaning off.
- `type` (typography): add optional `display` family (serif for Vapor and Book titles; the schema has `family` and `fallbacks` only) and `mono` family for the Pixel button and tooltip label. Use the bundled open fonts only.
- `effects`: a master `liveSafe` list stays in code, not in the theme. A theme must not be able to turn effects on while live (see Live safety).
- Compatibility: a pack without the new keys looks as it does now. `theme.schema.json` has `$id` `https://ujwalam.local/schemas/theme.schema.json` and version 2; the new keys are added to v2 as optional, no version bump, or a v3 bump if the user prefers. Existing ten themes need no change.

## Live safety

- One switch, one rule: the effect level (`full`, `reduced`, `performance` in `theme.h`) and a new live state decide what runs. When live or High performance is on, "plain" is the only allowed style for: shaders (`ShaderEffect`, `MultiEffect` blur), particles and shatter, 3D tilt and flip, looping animations (shimmer, sweeps, waves, spinning borders), text effects (vapor, scatter, magnet), and toast stacking animation.
- Allowed while live: colour change on hover and press (under 100 ms), the busy spinner at its normal rate (status, not decoration), toast fade (150 ms), meter-driven text only if cheap and off under High performance.
- Implementation: a single `Theme.fx` property (`full`, `calm`, `plain`) computed from effect level plus `Store` live state. Each component reads `Theme.fx` and loads its effect through a `Loader` (`active: Theme.fx === "full"`), so nothing is created (no GPU cost) in `plain`. Do not rely on `visible: false`, a hidden `ShaderEffect` still renders.
- Never run effects behind the preview: the Liquid Wave and any shader background stop at the panel edge and are off when the preview is on screen.
- Per-frame ceilings in `full` mode: at most one continuous shader on screen; at most 12 animated letters; any `FrameAnimation` stops at rest; cap shader items to 30 fps.
- Test plan (when built): headless (`UJWALAM_HEADLESS=1`) tests check that in `plain` no `ShaderEffect` or `FrameAnimation` item exists (probe counts them), that every entrance is under 600 ms and every exit under 400 ms, and that failure toasts are not suppressed. Evidence goes in `docs/evidence/`. Never run the GPU or full CI beside the installed studio (memory rule: no CI while the app runs).
- Feature flag: all new styles ship behind a flag off by default (`rareui-look`), switchable from the control page. The existing `theme-components` flag stays the gate for the schema blocks. "Made the studio's default look" is therefore a step after the flag has been used on a real stream with no high-severity feedback (AGENTS.md "done" rule).

## Build order (proposed slices)

1. Slice 0: tokens and gate. Add `Theme.fx`, the new schema keys, the shared spring helper (exact integrator) and the `ShadowLayers` helper. Add credit text and the flag. No visual change.
2. Slice 1: buttons. Soft, Neumorphism 3D (both already in the schema enum, so mostly polish), Premium, Retro Pixel, Glass Shimmer as `UButton` styles. Loading Spinner into `TaskChip`. Cost low.
3. Slice 2: tabs and nav. Animated Tab in `SettingsDialog`, Floating Navigation in the top bar, Toast Tabs avatar variant for the theme picker.
4. Slice 3: tooltips and notifications. Liquid Tooltip into `UButton` and `UIconButton`; Sonner-style stack in `TaskCenter` with type colours, swipe, pause on hover; `UNotice` base for `AlertStrip`, `GuideBubble`, `ConfirmDialog`. Keep the probe API.
5. Slice 4: text. Sound Text (level-driven) in `OnAirBar`, Vapor Smoke and Magnetic Scatter for headings, Word Magnet for Help.
6. Slice 5: cards and sections. Premium Profile Card, Image Expand for `ReviewWindow` clips, Particle Card (shader grid) last of this slice.
7. Slice 6: Book 3D for `HelpPanel` and `Guide`.
8. Slice 7 (GPU, own review): `qt_add_shaders` build step, Liquid Button goo, Liquid Metal, Liquid Wave look-alike background. GPU and encoder-adjacent code goes to the strongest model and a second review (CLAUDE.md routing); run only with the studio closed.
9. Slice 8: make `rareui` the default theme set (new theme files; the ten existing themes stay), after live use.
- Each slice ends with a phase-gate style evidence file and a feature-flag test. Models: Sonnet for slices 0 to 6 (UI), Opus for slice 7 (shaders, GPU, perf).

## Open questions for the user

1. Magnetic Scatter Text is not magnetic in the source (it scatters on hover with fixed offsets). Port the source behaviour, or add real pointer-distance magnetism like Word Magnet?
2. Liquid Wave is a full fluid simulation (about 37 GPU passes). Is a cheap one-pass wave look-alike acceptable, or do you want the real simulation (off while live, and only when you are not recording)?
3. Sound Text plays sine notes. A UI sound can leak into the stream or monitor path. Confirm: no UI sounds, only the visual and mixer-level-driven version in the On Air bar?
4. Toast changes: keep 6000 ms for task toasts and 4000 ms for short notices (Sonner default)? Should failure toasts stay until clicked (no auto close)? Add a position setting?
5. Should a toast with a running task show a loading spinner and update in place (Sonner promise style) instead of three separate toasts (started, stuck, done)?
6. Colours: RareUI is black and white with orange and lime accents. Map everything to the theme tokens (so each existing theme still looks like itself), or add a dedicated RareUI theme with its own black, white and orange values as the default?
7. Fonts: RareUI uses default serif, sans and mono (Vapor Smoke, Book 3D and the Profile Card use serif and mono). Which bundled families for serif and mono? A new open-licence serif would be an install; needs your yes.
8. Floating Navigation in the source is a bottom dock. The studio has a top bar. Use it for top-bar mode switches, or as a floating dock somewhere over the layer or scene panel?
9. Book 3D page content: build it from the Guide topics, or keep it only as a decorative cover for Help?
10. Particle Card and Premium Profile Card have no obvious studio screen. Skip them for now, or place them (About page, channel card)?
11. Sonner copyright holder line was not read (UNVERIFIED). OK to fetch the Sonner LICENSE and add it to the notices when the credit is written?
12. "Default look" timing: flip the default only after a real stream test with the flag on, as the project rules say?

## Answers (2026-11-14)

From the user:

- Q6 Colours: a dedicated RareUI theme (black, white, orange and lime) becomes the default. The effects still read theme tokens, so the existing themes get the new components in their own colours.
- Q2 Liquid Wave: the real fluid simulation, not a look-alike. It runs only when the studio is neither live nor recording, and never in High performance mode.
- Q7 Fonts: bundled fonts only; no new font family. Serif and mono pieces use the fonts already shipped.
- Q10 Particle Card, Premium Profile Card and Image Expand Testimonial: skipped for now (18 items are built).

Lead decisions (logged in D384):

- Q1 Magnetic Scatter Text ports the source behaviour (scatter on hover with fixed offsets).
- Q3 No UI sounds. Sound Text is visual only, driven by the mixer level in the On Air bar, so nothing can leak into the stream or monitor path.
- Q4 Task toasts keep 6000 ms, short notices 4000 ms; failure toasts stay until clicked. No position setting yet.
- Q5 A running task shows one toast with a spinner that updates in place (Sonner promise style).
- Q8 Floating Navigation holds the top bar's mode switches.
- Q9 Book 3D pages are built from the Guide topics.
- Q11 The Sonner LICENSE is fetched and added to the notices with the credit.
- Q12 Everything ships behind a flag, off by default. The RareUI theme becomes the default only after a real stream test with the flag on and no high-severity feedback.

## Not read from source (UNVERIFIED list)

- Sonner licence copyright line.
- Exact Tailwind default shadow strings and colour hex values (read as class names; hex listed from Tailwind defaults).
- Whether the framer-motion `duration` overrides spring values in Vapor Smoke Text (version dependent).
- Exact mixer level property for the On Air bar (`MixerPanel.qml` not read in detail).
- Which top-bar group fits Floating Navigation (`Main.qml` top bar not read in detail).
- `QtQuick.Shapes` availability in the build (it is part of `Qt6::Quick`, so no new link; not tested).
- Existing tests and probes that read `toastPos` and `toastLog` (names only seen in `TaskCenter.qml`).
- Lines 124 to 140 of `data/themes/theme.schema.json` (`background` block shape).
- The LiquidWaveLazy, LiquidMetalLazy, `Sections/imageExpandTestimonial.tsx` and the duplicate flat files under `components/rareui/*.tsx` were not diffed against the folder versions. The folder versions (`Name/Name.tsx`) were read.
- The `rareui.in/docs` pages and `content/docs/*.mdx` (props tables, usage) were not read; only the component source.
