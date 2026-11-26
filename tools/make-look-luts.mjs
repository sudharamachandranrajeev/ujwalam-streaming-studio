// SPDX-License-Identifier: GPL-3.0-or-later
// Realism look LUTs (D445, plan 2026-11-25-realism-looks RL1): writes data/luts/look-<id>.cube for every look in
// data/looks/<id>.json that has a "grade", our own 33 x 33 x 33 colour look-up tables for OBS's clut_filter (layer effect
// "lut", base "luts"). The Filmic look keeps its own generator (tools/make-realism-lut.mjs). Deterministic: only
// + - * / on doubles and toFixed(6), so the same Node writes the same bytes; tests/realism-looks.test.mjs checks every
// committed file and every look's swatch against this script.
//
//   node tools/make-look-luts.mjs          writes the files and prints each look's swatch
//   node tools/make-look-luts.mjs --check  exit 1 when a committed LUT or swatch differs
//
// A grade, in order, on display-referred RGB 0..1 (every key optional; the neutral value leaves the colour alone):
//   gain [r, g, b]          white balance: each channel times this (neutral [1, 1, 1])
//   saturation s            chroma around the luma times s (neutral 1)
//   tame t                  the most saturated colours lose up to t of their chroma (neutral 0)
//   vibrance v              low-chroma colours gain up to v more chroma (neutral 0)
//   hueSat [{hue, width, sat, lum?}]  selective colour: inside a hue band (HSV hue in degrees, full effect at the
//                           centre, none past width) the chroma factor moves towards sat and the colour is times lum
//   crush k                 blacks: everything at or below k goes to 0 (neutral 0)
//   contrast c              share of the way to a smoothstep S-curve (neutral 0)
//   mids m                  mid tones: y (1 + m) / (1 + m y); m > 0 brighter, m < 0 darker, 0 and 1 stay (neutral 0)
//   lift l                  black level lifted to l (neutral 0)
//   knee, white             highlight shoulder: above knee, a Reinhard-style roll-off (slope 1 at the knee) that lands
//                           1.0 on white (neutral: white 1)
//   split {shadows, highlights}  rgb offsets weighted by (1 - luma)^2 and luma^2 of the graded colour
// Format: Adobe .cube 1.0, LUT_3D_SIZE 33, red changes fastest, LF line endings (as realism-filmic.cube).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { grade as filmicGrade } from './make-realism-lut.mjs';

export const SIZE = 33;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOOKS_DIR = path.join(ROOT, 'data', 'looks');
export const LUTS_DIR = path.join(ROOT, 'data', 'luts');
// The swatch: shadow grey, skin, foliage, sky, red, each through the look's LUT at its amount.
export const SWATCH_REFS = Object.freeze([[0.15, 0.15, 0.15], [0.87, 0.65, 0.52], [0.33, 0.47, 0.22], [0.45, 0.62, 0.85], [0.8, 0.12, 0.1]]);

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** HSV hue in degrees 0..360 (0 for greys), with + - * / only. */
export function hueOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d <= 0) return 0;
  let h;
  if (mx === r) h = (g - b) / d;
  else if (mx === g) h = 2 + (b - r) / d;
  else h = 4 + (r - g) / d;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** The tone curve of a grade for one channel. */
export function toneOf(gr) {
  const crush = gr.crush ?? 0, contrast = gr.contrast ?? 0, mids = gr.mids ?? 0, lift = gr.lift ?? 0;
  const knee = gr.knee ?? 1, white = gr.white ?? 1;
  // KNEE + (1 - KNEE) / (1 + (1 - KNEE) / S) = white  =>  S = (1 - KNEE) / ((1 - KNEE) / (white - KNEE) - 1)
  const shoulder = white < 1 && knee < white ? (1 - knee) / ((1 - knee) / (white - knee) - 1) : 0;
  return (x) => {
    let y = crush > 0 ? clamp01((x - crush) / (1 - crush)) : x;
    y = y + contrast * (y * y * (3 - 2 * y) - y);
    if (mids !== 0) y = (y * (1 + mids)) / (1 + mids * y);
    y = lift + y * (1 - lift);
    if (shoulder > 0 && y > knee) y = knee + (y - knee) / (1 + (y - knee) / shoulder);
    return y;
  };
}

/** The grade function (r, g, b) -> [r, g, b] for a look's grade object. */
export function gradeOf(gr) {
  const gain = gr.gain ?? [1, 1, 1], sat = gr.saturation ?? 1, tame = gr.tame ?? 0, vib = gr.vibrance ?? 0;
  const bands = gr.hueSat ?? [], tone = toneOf(gr);
  const sh = gr.split?.shadows ?? [0, 0, 0], hi = gr.split?.highlights ?? [0, 0, 0];
  return (r, g, b) => {
    r = clamp01(r * gain[0]); g = clamp01(g * gain[1]); b = clamp01(b * gain[2]);
    const l0 = luma(r, g, b);
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    let keep = sat * (1 - tame * smooth(0.35, 1, chroma)) * (1 + vib * (1 - smooth(0, 0.6, chroma)));
    let scale = 1;
    if (bands.length && chroma > 0) {
      const hue = hueOf(r, g, b);
      for (const band of bands) {
        let d = hue - band.hue; if (d < 0) d = -d; if (d > 180) d = 360 - d;
        const w = (1 - smooth(0, band.width, d)) * smooth(0, 0.15, chroma); // greys have no hue to pick
        keep = keep + (band.sat - keep) * w;
        if (band.lum !== undefined) scale = scale + (band.lum - 1) * w;
      }
    }
    r = (l0 + (r - l0) * keep) * scale; g = (l0 + (g - l0) * keep) * scale; b = (l0 + (b - l0) * keep) * scale;
    r = tone(clamp01(r)); g = tone(clamp01(g)); b = tone(clamp01(b));
    const l = clamp01(luma(r, g, b));
    const wh = l * l, ws = (1 - l) * (1 - l);
    r += hi[0] * wh + sh[0] * ws;
    g += hi[1] * wh + sh[1] * ws;
    b += hi[2] * wh + sh[2] * ws;
    return [clamp01(r), clamp01(g), clamp01(b)];
  };
}

/** The .cube text for a grade function. */
export function cubeText(fn, size = SIZE) {
  const out = [`LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const n = size - 1;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) out.push(fn(ri / n, gi / n, bi / n).map((v) => v.toFixed(6)).join(' '));
    }
  }
  return out.join('\n') + '\n';
}

/** Every look file, sorted by id: [{ file, look }]. */
export function readLooks(dir = LOOKS_DIR) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: path.join(dir, f), look: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));
}

/** A look's LUT effect (its first effect of type lut). */
export const lutOf = (look) => look.effects.find((e) => e.type === 'lut');

/** The grade function of a look: its own grade, or the Filmic generator's. */
export const lookGrade = (look) => (look.grade ? gradeOf(look.grade) : filmicGrade);

/** The swatch: SWATCH_REFS through the look's grade, mixed by the LUT amount (as clut_filter mixes), as #rrggbb. */
export function swatchOf(look) {
  const fn = lookGrade(look), amount = lutOf(look)?.amount ?? 1;
  const hex = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return SWATCH_REFS.map(([r, g, b]) => {
    const o = fn(r, g, b), src = [r, g, b];
    return '#' + o.map((v, i) => hex(src[i] + (v - src[i]) * amount)).join('');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const { file, look } of readLooks()) {
    const sw = swatchOf(look);
    if (JSON.stringify(sw) !== JSON.stringify(look.swatch)) {
      console.error(`${look.id}: swatch should be ${JSON.stringify(sw)}`);
      bad++;
    }
    if (!look.grade) continue; // Filmic: tools/make-realism-lut.mjs
    const out = path.join(LUTS_DIR, lutOf(look).file.rel);
    const text = cubeText(gradeOf(look.grade));
    if (check) {
      let cur = null;
      try { cur = readFileSync(out, 'utf8'); } catch { cur = null; }
      if (cur !== text) { console.error(`${path.relative(process.cwd(), out)} differs from ${path.basename(file)}`); bad++; }
    } else {
      mkdirSync(LUTS_DIR, { recursive: true });
      writeFileSync(out, text);
      console.log(`wrote ${path.relative(process.cwd(), out)} (${SIZE}^3 entries)`);
    }
  }
  if (bad) process.exit(1);
  if (check) console.log('look LUTs and swatches up to date');
}
