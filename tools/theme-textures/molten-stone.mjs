// SPDX-License-Identifier: GPL-3.0-or-later
// Molten Stone textures (docs/plan/2026-11-27-molten-stone-theme.md): paints every PNG the theme uses, at 1x and 2x,
// from code only (no downloaded art, no AI image service, no packages beyond Node itself). Deterministic: the same
// script writes the same bytes every time (a seeded hash, no Math.random, no dates). Run:
//   node tools/theme-textures/molten-stone.mjs          writes data/theme-textures/molten-stone/*.png
//   node tools/theme-textures/molten-stone.mjs --check  exits 1 when a committed file differs from what it would write
//
// 9-slice rules (BorderImage, tile mode "round" in both directions): every slice image is margin + 16 + margin logical
// pixels. Everything in the 16 px middle span repeats with a period that divides 16 (grain is per-pixel white noise, the
// rope twist has a period of 4, blotches use sines of period 16), so tiling never shows a seam and nothing is stretched.
// Cracks, highlights and shadows live only inside the margins (the corners and edges), so they never distort.
// "outset" is the part of the margin outside the control's box (glow and shadow): the control draws the image that many
// pixels past its edges, inside the room its layout reserves.
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = path.join(REPO, 'data', 'theme-textures', 'molten-stone');
export const MID = 16;

// ---- palette (from the reference description) ----
const C = {
  stoneLo: [0x6e, 0x6e, 0x72], stoneHi: [0x8c, 0x8c, 0x90], dark: [0x3a, 0x3a, 0x3e], darker: [0x26, 0x26, 0x29],
  well: [0x2e, 0x2e, 0x32], pale: [0xa4, 0xa3, 0xa3],
  core: [0xe8, 0xa2, 0x7c], hi: [0xf4, 0xc2, 0xa0], deep: [0xc0, 0x6a, 0x4a],
  danger: [0xe0, 0x58, 0x4a], amber: [0xf0, 0xc0, 0x60], molten: [0xff, 0x9a, 0x5a],
};

// The slices: name -> margin (logical px, all four sides equal), outset, corner radius, painter. The pack's texture block
// must carry the same margins and outsets (tests/molten-stone-theme.test.mjs compares them).
export const SLICES = {
  base: { m: 12, o: 0, r: 8 },
  raised: { m: 20, o: 6, r: 10 },
  inset: { m: 12, o: 0, r: 8 },
  pressed: { m: 16, o: 4, r: 10 },
  buttonNormal: { m: 17, o: 6, r: 10 },
  buttonPressed: { m: 17, o: 6, r: 10 },
  buttonDisabled: { m: 17, o: 6, r: 10 },
  field: { m: 11, o: 2, r: 8 },
  fieldError: { m: 11, o: 2, r: 8 },
  track: { m: 3, o: 0, r: 3 },
  fill: { m: 3, o: 0, r: 3 },
  card: { m: 24, o: 8, r: 12 },
  plate: { m: 13, o: 3, r: 9 },
  modal: { m: 40, o: 10, r: 14 },
  toast: { m: 14, o: 4, r: 10 },
};
// The face greys (darkest, lightest) of the slices that carry text: tests/molten-stone-theme.test.mjs checks the pack's
// text colours against the lightest (plus the top light, at most 8 percent toward white inside the top 5 px margin).
export const FACES = {
  card: [[0x36, 0x36, 0x3a], [0x3e, 0x3e, 0x42]], modal: [[0x3a, 0x3a, 0x3e], [0x42, 0x42, 0x46]],
  plate: [[0x2c, 0x2c, 0x30], [0x3a, 0x3a, 0x3e]], toast: [[0x2c, 0x2c, 0x30], [0x3a, 0x3a, 0x3e]],
  buttonNormal: [[0x26, 0x26, 0x29], [0x3a, 0x3a, 0x3e]], buttonDisabled: [[0x8e, 0x8d, 0x8e], [0xa4, 0xa3, 0xa3]],
};
// Plain pictures (not 9-sliced): name -> logical size.
export const ART = {
  smoke: [48, 72], drip: [12, 28], empty: [240, 140], avatar: [40, 40], spinner: [40, 40], gear: [14, 14],
};

// ---- deterministic noise ----
function hash(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function rng(seed) { let i = 0; return () => hash(i++, seed, 977); }
const TAU = Math.PI * 2;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const blotch = (X, Y, k) => 0.5 + 0.22 * Math.sin(TAU * X / MID + k) * Math.cos(TAU * Y / MID + 1.7 * k) + 0.07 * Math.sin(TAU * (X - 2 * Y) / MID + 2.3 * k);

function sdRound(X, Y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(X - cx) - hx, qy = Math.abs(Y - cy) - hy;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---- canvas: premultiplied float RGBA ----
class Img {
  constructor(w, h, s) { this.w = w; this.h = h; this.s = s; this.W = Math.round(w * s); this.H = Math.round(h * s); this.p = new Float32Array(this.W * this.H * 4); }
  // f(X, Y, i, j) -> [r, g, b, a] (straight 0..255, a 0..1) or null; composited "over"
  paint(f) {
    const { W, H, s, p } = this;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const c = f((i + 0.5) / s, (j + 0.5) / s, i, j);
      if (!c || c[3] <= 0) continue;
      const a = clamp(c[3]), k = (j * W + i) * 4;
      for (let q = 0; q < 3; q++) p[k + q] = (c[q] / 255) * a + p[k + q] * (1 - a);
      p[k + 3] = a + p[k + 3] * (1 - a);
    }
  }
  png() {
    const { W, H, p } = this;
    const raw = Buffer.alloc((W * 4 + 1) * H);
    for (let j = 0; j < H; j++) {
      raw[j * (W * 4 + 1)] = 1; // filter: sub
      let prev = [0, 0, 0, 0];
      for (let i = 0; i < W; i++) {
        const k = (j * W + i) * 4, a = p[k + 3];
        const px = a > 0 ? [p[k] / a, p[k + 1] / a, p[k + 2] / a, a] : [0, 0, 0, 0];
        const b = px.map((v) => Math.round(clamp(v) * 255));
        for (let q = 0; q < 4; q++) raw[j * (W * 4 + 1) + 1 + i * 4 + q] = (b[q] - prev[q]) & 255;
        prev = b;
      }
    }
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b) { let c = -1; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

// ---- shared layers ----
// The organic edge: a small wobble of the outline, periodic in the middle span so tiles meet.
const wobble = (X, Y, amp) => amp * (Math.sin(TAU * X / 8 + 0.9) * 0.5 + Math.sin(TAU * Y / 8 + 2.1) * 0.5);
// Stone face colour at a point: two greys by blotch, per-pixel grain, top light and bottom shade measured from the
// shape's own top and bottom (inside the margins), a soft darkening near the outline.
function stone(X, Y, i, j, d, top, bottom, lo = C.stoneLo, hi = C.stoneHi, seed = 1) {
  let c = mix(lo, hi, blotch(X, Y, seed));
  const g = (hash(i, j, seed) - 0.5) * 18;
  c = c.map((v) => v + g);
  const tl = 1 - smooth(0, 5, Y - top), bs = 1 - smooth(0, 7, bottom - Y);
  c = mix(c, [235, 232, 228], 0.08 * tl);
  c = mix(c, [20, 20, 22], 0.35 * bs);
  c = mix(c, [24, 24, 26], 0.35 * (1 - smooth(-3, 0, d)) * 0); // reserved: no extra darkening (kept for tuning)
  return mix(c, [30, 30, 32], 0.25 * smooth(-2.5, 0, d));
}
// Twisted rose-gold wire along the outline: a band of width w just inside d = 0, stripes across it with period 4.
function rope(X, Y, d, w, col = [C.deep, C.core, C.hi]) {
  if (d > 0.6 || d < -w - 0.6) return null;
  const a = smooth(-w - 0.6, -w + 0.4, d) * (1 - smooth(-0.4, 0.6, d));
  const t = 0.5 + 0.5 * Math.sin(TAU * (X + Y - d * 1.5) / 4);
  const across = 1 - Math.abs((d + w / 2) / (w / 2 + 0.01));
  const c = mix(mix(col[0], col[1], t), col[2], clamp(across) * 0.55 * t);
  return [...c, a];
}
const glow = (d, o, col = C.core, k = 0.55) => (d <= 0 || o <= 0 ? null : [...col, k * Math.exp(-d / (o / 2.6)) * (1 - smooth(o * 0.75, o, d))]);
const shadow = (d, o, k = 0.5) => (d <= 0 || o <= 0 ? null : [8, 8, 10, k * Math.exp(-d / (o / 2.2)) * (1 - smooth(o * 0.75, o, d))]);

// Cracks: random walks starting from the given corner points, rasterised as segments; returns a distance function.
function cracks(seed, starts, steps, len) {
  const r = rng(seed), segs = [];
  for (const [sx, sy, ang] of starts) {
    let x = sx, y = sy, a = ang;
    for (let k = 0; k < steps; k++) {
      a += (r() - 0.5) * 1.3;
      const nx = x + Math.cos(a) * len, ny = y + Math.sin(a) * len;
      segs.push([x, y, nx, ny, 1 - k / steps]);
      if (r() < 0.25) { const b = a + (r() < 0.5 ? 0.9 : -0.9); segs.push([nx, ny, nx + Math.cos(b) * len * 0.7, ny + Math.sin(b) * len * 0.7, 0.5 * (1 - k / steps)]); }
      x = nx; y = ny;
    }
  }
  return (X, Y) => {
    let best = 1e9, wt = 0;
    for (const [x0, y0, x1, y1, w] of segs) {
      const dx = x1 - x0, dy = y1 - y0, t = clamp(((X - x0) * dx + (Y - y0) * dy) / (dx * dx + dy * dy || 1));
      const dd = Math.hypot(X - x0 - t * dx, Y - y0 - t * dy);
      if (dd < best) { best = dd; wt = w; }
    }
    return [best, wt];
  };
}
// A crack drawn over a face: dark core, molten glowing edge.
function crackInk(cd, wt, width = 0.9) {
  const [dd] = [cd];
  const core = 1 - smooth(width * 0.35 * (0.5 + wt), width * (0.5 + wt), dd);
  const edge = Math.exp(-dd / 1.2) * (0.5 + 0.5 * wt);
  if (core > 0.02) return [...mix(C.molten, [20, 14, 12], 0.35), core];
  if (edge > 0.04) return [...C.core, 0.55 * edge];
  return null;
}

// ---- slice painters ----
function slice(name, s) {
  const { m, o, r } = SLICES[name];
  const w = m * 2 + MID, h = w;
  const im = new Img(w, h, s);
  const x0 = o, y0 = o, x1 = w - o, y1 = h - o;
  const D = (X, Y, amp = 0.35) => sdRound(X, Y, x0, y0, x1, y1, r) + wobble(X, Y, amp);
  const inside = (d) => 1 - smooth(-0.6, 0.6, d);
  const seed = [...name].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7) & 0xffff;

  const plainStone = (lo, hi, opts = {}) => im.paint((X, Y, i, j) => {
    const d = D(X, Y, opts.amp ?? 0.35);
    const a = inside(d);
    if (a <= 0) return null;
    return [...stone(X, Y, i, j, d, y0, y1, lo, hi, seed), a];
  });

  switch (name) {
    case 'base':
      plainStone(C.stoneLo, C.stoneHi);
      break;
    case 'raised': {
      im.paint((X, Y) => glow(D(X, Y), o));
      plainStone(C.stoneLo, C.stoneHi);
      im.paint((X, Y) => rope(X, Y, D(X, Y), 2));
      break;
    }
    case 'inset': {
      plainStone(C.stoneLo, C.stoneHi);
      im.paint((X, Y, i, j) => { // the recessed darker centre: dark top inner shadow, light bottom lip
        const d = D(X, Y) + 4;
        if (d > 0.6) return null;
        const a = inside(d);
        let c = stone(X, Y, i, j, d, y0 + 4, y1 - 4, C.dark, C.well, seed + 3);
        c = mix(c, [10, 10, 12], 0.45 * (1 - smooth(0, 6, Y - (y0 + 4))));
        c = mix(c, [150, 150, 154], 0.25 * (1 - smooth(0, 3, (y1 - 4) - Y)));
        return [...c, a];
      });
      break;
    }
    case 'pressed':
    case 'buttonPressed': {
      im.paint((X, Y) => glow(D(X, Y), o, C.core, 0.45));
      plainStone(C.dark, C.stoneLo);
      // The broken centre: a dark recess whose jagged outline glows; the jag has a period of 4 (tiles meet).
      const inner = name === 'pressed' ? 5 : 4;
      im.paint((X, Y, i, j) => {
        const jag = 0.9 * Math.abs(Math.sin(TAU * X / 8 + 0.6)) + 0.6 * Math.abs(Math.sin(TAU * Y / 4 + 1.9)) * Math.abs(Math.sin(TAU * X / 16));
        const d = D(X, Y, 0) + inner + jag - 1;
        if (d > 2.5) return null;
        if (d > 0) return [...C.molten, 0.85 * Math.exp(-d / 0.9)];
        const g = (hash(i, j, seed) - 0.5) * 8;
        const c = mix([16, 13, 13], [52, 30, 24], Math.exp(d / 2.2)).map((v) => v + g);
        return [...c, inside(d)];
      });
      im.paint((X, Y) => rope(X, Y, D(X, Y), 1.2, [C.deep, C.core, C.hi]));
      break;
    }
    case 'buttonNormal': {
      im.paint((X, Y) => glow(D(X, Y), o));
      plainStone(FACES.buttonNormal[0], FACES.buttonNormal[1]);
      im.paint((X, Y) => rope(X, Y, D(X, Y), 2));
      break;
    }
    case 'buttonDisabled':
      plainStone([0x8e, 0x8d, 0x8e], C.pale, { amp: 0.25 });
      break;
    case 'field':
    case 'fieldError': {
      const err = name === 'fieldError';
      if (err) im.paint((X, Y) => glow(D(X, Y), o, C.danger, 0.5));
      im.paint((X, Y, i, j) => {
        const d = D(X, Y, err ? 0.9 : 0.25) + (err ? 0.5 * Math.abs(Math.sin(TAU * (X + Y) / 4)) : 0);
        const a = inside(d);
        if (a <= 0) return null;
        let c = stone(X, Y, i, j, d, y0, y1, [0x24, 0x24, 0x27], [0x30, 0x30, 0x34], seed);
        c = mix(c, [6, 6, 8], 0.5 * (1 - smooth(0, 4, Y - y0))); // sunken: shade under the top lip
        return [...c, a];
      });
      im.paint((X, Y) => rope(X, Y, D(X, Y, err ? 0.9 : 0.25), err ? 1.5 : 1.2, err ? [[0x8a, 0x2a, 0x22], C.danger, [0xff, 0x9a, 0x88]] : [C.deep, C.core, C.hi]));
      break;
    }
    case 'track': {
      im.paint((X, Y, i, j) => {
        const d = D(X, Y, 0);
        const a = inside(d);
        if (a <= 0) return null;
        let c = stone(X, Y, i, j, d, y0, y1, [0x2a, 0x2a, 0x2d], [0x3a, 0x3a, 0x3e], seed);
        c = mix(c, [6, 6, 8], 0.5 * (1 - smooth(0, 2, Y - y0)));
        const crack = Math.abs(Y - (h / 2 + 0.8 * Math.sin(TAU * X / 8))) < 0.35 && hash(Math.floor(X), 3, seed) > 0.4;
        return [...(crack ? [10, 9, 9] : c), a];
      });
      break;
    }
    case 'fill': {
      im.paint((X, Y, i, j) => {
        const d = D(X, Y, 0);
        const a = inside(d);
        if (a <= 0) return null;
        const flow = 0.5 + 0.5 * Math.sin(TAU * (X - Y * 0.6) / 8);
        let c = mix(C.deep, C.core, flow);
        c = mix(c, C.hi, 0.6 * (1 - smooth(0, 2.2, Y - y0)));
        c = mix(c, [0x8a, 0x40, 0x2a], 0.4 * (1 - smooth(0, 2, y1 - Y)));
        return [...c.map((v) => v + (hash(i, j, seed) - 0.5) * 10), a];
      });
      break;
    }
    case 'card': {
      // A second slab peeking out behind (down-right), then the card with a fine rim.
      const D2 = (X, Y) => sdRound(X, Y, x0 + 4, y0 + 5, x1 + 4, y1 + 5, r) + wobble(X + 3, Y, 0.4);
      im.paint((X, Y) => shadow(D2(X, Y), o, 0.45));
      im.paint((X, Y, i, j) => { const d = D2(X, Y); const a = inside(d); return a > 0 ? [...stone(X, Y, i, j, d, y0 + 5, y1 + 5, [0x30, 0x30, 0x34], [0x3a, 0x3a, 0x3e], seed + 9), a] : null; });
      plainStone(FACES.card[0], FACES.card[1]);
      im.paint((X, Y) => rope(X, Y, D(X, Y), 1));
      break;
    }
    case 'plate':
    case 'toast': {
      im.paint((X, Y) => shadow(D(X, Y), o, 0.55));
      plainStone(FACES.plate[0], FACES.plate[1]);
      if (name === 'plate') im.paint((X, Y) => rope(X, Y, D(X, Y), 1.2));
      break;
    }
    case 'modal': {
      im.paint((X, Y) => shadow(D(X, Y, 0.8), o, 0.6));
      plainStone(FACES.modal[0], FACES.modal[1], { amp: 0.8 });
      // Cracks only in the corners and edges (inside the 40 px margins), so the middle tiles stay plain.
      const crk = cracks(seed, [[x0 + 2, y0 + 8, 0.5], [x1 - 6, y0 + 1, 2.2], [x0 + 1, y1 - 12, -0.4], [x1 - 1, y1 - 7, 3.6]], 6, 4.2);
      im.paint((X, Y) => {
        const d = D(X, Y, 0.8);
        if (d > 0) return null;
        const inMargin = X < m - 1 || X > w - m + 1 || Y < m - 1 || Y > h - m + 1;
        if (!inMargin) return null;
        const [cd, wt] = crk(X, Y);
        return crackInk(cd, wt);
      });
      im.paint((X, Y) => rope(X, Y, D(X, Y, 0.8), 1.5));
      break;
    }
    default: throw new Error(name);
  }
  return im;
}

// ---- art painters ----
function art(name, s) {
  const [w, h] = ART[name];
  const im = new Img(w, h, s);
  const seed = [...name].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 11) & 0xffff;
  switch (name) {
    case 'smoke': { // soft yellow-orange to grey puffs rising, fading out at the top
      const r = rng(seed), puffs = [];
      for (let k = 0; k < 9; k++) puffs.push([w / 2 + (r() - 0.5) * 18 + Math.sin(k) * 6, h - 8 - k * 7.2, 5 + k * 1.1 + r() * 2]);
      im.paint((X, Y) => {
        let a = 0;
        for (const [px, py, pr] of puffs) a += Math.exp(-((X - px) ** 2 + (Y - py) ** 2) / (pr * pr));
        a = clamp(a * 0.42) * smooth(0, h * 0.55, Y) * (1 - smooth(h - 6, h, Y) * 0.6);
        const t = clamp(Y / h);
        return [...mix([0xb8, 0xb4, 0xb0], mix(C.amber, C.core, 0.4), t), a * 0.8];
      });
      break;
    }
    case 'drip': { // a molten drop hanging from the top edge
      im.paint((X, Y) => {
        const cy = h - 6, rr = 4.6;
        const neck = 1.2 + 3.4 * smooth(0, cy, Y);
        const d = Y < cy ? Math.abs(X - w / 2) - neck : Math.hypot(X - w / 2, Y - cy) - rr;
        const a = 1 - smooth(-0.6, 0.6, d);
        const g = d > 0 ? 0.5 * Math.exp(-d / 1.6) : 0;
        if (a <= 0 && g <= 0.02) return null;
        if (a <= 0) return [...C.core, g];
        const c = mix(C.deep, C.hi, clamp(0.6 - (X - w / 2) / 6 - (Y - cy) / 14));
        return [...c, a];
      });
      break;
    }
    case 'avatar':
    case 'spinner': { // a stone disc with a rose-gold spiral in relief (no face)
      const cx = w / 2, cy = h / 2, R = w / 2 - 2;
      im.paint((X, Y) => { const d = Math.hypot(X - cx, Y - cy) - R; return name === 'spinner' ? glow(d, 2, C.core, 0.5) : shadow(d - 0.5, 2, 0.5); });
      im.paint((X, Y, i, j) => {
        const rr = Math.hypot(X - cx, Y - cy), d = rr - R;
        const a = 1 - smooth(-0.6, 0.6, d);
        if (a <= 0) return null;
        const th = Math.atan2(Y - cy, X - cx);
        const turns = name === 'spinner' ? 3.2 : 2.4;
        const sp = Math.sin(rr * TAU / (R / turns) - th * (name === 'spinner' ? 1 : 1));
        let c = stone(X, Y, i, j, d, cy - R, cy + R, [0x5e, 0x5e, 0x62], [0x7a, 0x7a, 0x7e], seed);
        const line = smooth(0.55, 0.9, sp) * smooth(R * 0.06, R * 0.2, rr) * (1 - smooth(-2.5, -1.2, d));
        c = mix(c, mix(C.deep, C.hi, 0.5 + 0.5 * Math.sin(th * 2)), line);
        c = mix(c, [18, 18, 20], 0.35 * smooth(-0.9, -0.3, sp) * (1 - smooth(0, 0.4, sp)));
        return [...c, a];
      });
      break;
    }
    case 'gear': {
      const cx = w / 2, cy = h / 2;
      im.paint((X, Y) => {
        const rr = Math.hypot(X - cx, Y - cy), th = Math.atan2(Y - cy, X - cx);
        const outer = 5.2 + 1.3 * smooth(-0.25, 0.25, Math.cos(th * 8));
        const ring = Math.max(rr - outer, 2.1 - rr);
        const a = 1 - smooth(-0.5, 0.5, ring);
        if (a <= 0) return null;
        return [...mix(C.deep, C.hi, clamp(0.5 - (Y - cy) / 10)), a];
      });
      break;
    }
    case 'empty': { // grey moon landscape vignette with a planet and an astronaut (no face: a closed visor)
      const r = rng(seed);
      im.paint((X, Y) => { // sky with a soft vignette
        const v = 1 - 0.55 * clamp(Math.hypot((X - w / 2) / (w * 0.6), (Y - h * 0.3) / (h * 0.9)));
        return [...mix([0x2a, 0x2a, 0x2e], [0x8a, 0x8a, 0x8c], 0.55 * v), 1 - smooth(0.85, 1, Math.hypot((X - w / 2) / (w / 2), (Y - h / 2) / (h / 2))) ];
      });
      const stars = Array.from({ length: 26 }, () => [r() * w, r() * h * 0.6, 0.3 + r() * 0.5]);
      im.paint((X, Y) => { for (const [sx, sy, sr] of stars) { const d = Math.hypot(X - sx, Y - sy); if (d < sr + 0.6) return [235, 232, 228, 0.7 * (1 - smooth(sr - 0.4, sr + 0.6, d))]; } return null; });
      // The planet with a rose-gold rim and a ring.
      const px = w * 0.78, py = h * 0.28, pr = 17;
      im.paint((X, Y, i, j) => {
        const d = Math.hypot(X - px, Y - py) - pr;
        const ringD = Math.abs(Math.hypot((X - px) / 1.0, (Y - py - (X - px) * 0.25) * 3.4) - pr * 1.55) - 1.1;
        const front = Y - py - (X - px) * 0.25 > 0 || d > 0;
        if (ringD < 0.8 && front) return [...mix(C.deep, C.hi, 0.5), (1 - smooth(-0.6, 0.8, ringD)) * 0.9];
        if (d > 0.6) return null;
        let c = stone(X, Y, i, j, d, py - pr, py + pr, [0x6a, 0x6a, 0x6e], [0x96, 0x96, 0x9a], seed);
        c = mix(c, C.core, 0.7 * smooth(-2.2, -0.2, d) * smooth(0, pr, X - px + Y - py + pr * 0.4));
        return [...c, 1 - smooth(-0.6, 0.6, d)];
      });
      // Ground: a wavy horizon with craters.
      const ground = (X) => h * 0.72 + 4 * Math.sin(X / 23) + 2.5 * Math.sin(X / 9 + 1);
      const craters = [[w * 0.18, h * 0.86, 14], [w * 0.62, h * 0.9, 20], [w * 0.88, h * 0.8, 9], [w * 0.42, h * 0.78, 7]];
      im.paint((X, Y, i, j) => {
        const gy = ground(X);
        if (Y < gy - 0.6) return null;
        let c = stone(X, Y, i, j, -3, gy, h + 20, [0x58, 0x58, 0x5c], [0x7a, 0x7a, 0x7e], seed + 1);
        for (const [cx, cy, cr] of craters) {
          const e = Math.hypot((X - cx) / cr, (Y - cy) / (cr * 0.35));
          if (e < 1) c = mix(c, [0x3a, 0x3a, 0x3e], 0.6 * (1 - e) + 0.2);
          else if (e < 1.25) c = mix(c, [0xa8, 0xa8, 0xac], 0.4 * (1 - (e - 1) / 0.25) * (Y < cy ? 1 : 0.3));
        }
        const vig = 1 - smooth(0.85, 1, Math.hypot((X - w / 2) / (w / 2), (Y - h / 2) / (h / 2)));
        return [...c, (1 - smooth(-0.6, 0.6, gy - Y)) * vig];
      });
      // The astronaut: boots, legs, body, backpack, arms, helmet with a rose-gold closed visor.
      const ax = w * 0.36, ay = ground(w * 0.36) - 2;
      const parts = [
        (X, Y) => sdRound(X, Y, ax - 10, ay - 44, ax - 2, ay - 22, 3), // backpack (behind)
        (X, Y) => sdRound(X, Y, ax - 7, ay - 16, ax - 1, ay, 2.5), // legs
        (X, Y) => sdRound(X, Y, ax + 1, ay - 16, ax + 7, ay, 2.5),
        (X, Y) => sdRound(X, Y, ax - 8, ay - 38, ax + 8, ay - 14, 5), // body
        (X, Y) => sdRound(X, Y, ax - 13, ay - 36, ax - 7, ay - 20, 2.8), // arms
        (X, Y) => sdRound(X, Y, ax + 7, ay - 40, ax + 13, ay - 28, 2.8),
        (X, Y) => Math.hypot(X - ax, Y - (ay - 46)) - 9, // helmet
      ];
      im.paint((X, Y) => shadow(Math.hypot((X - ax - 6) / 2.2, (Y - ay - 1) * 1.6) - 6, 6, 0.4));
      for (const [k, sd] of parts.entries()) im.paint((X, Y, i, j) => {
        const d = sd(X, Y);
        if (d > 0.6) return null;
        let c = stone(X, Y, i, j, d, ay - 56, ay, [0xb4, 0xb2, 0xb0], [0xd6, 0xd4, 0xd0], seed + k);
        c = mix(c, [40, 40, 44], 0.4 * smooth(-1.6, 0, d));
        return [...c, 1 - smooth(-0.6, 0.6, d)];
      });
      im.paint((X, Y) => { // the visor: closed, reflective rose gold (no face)
        const d = sdRound(X, Y, ax - 6, ay - 51, ax + 7, ay - 42, 4);
        if (d > 0.6) return null;
        const c = mix(C.deep, C.hi, clamp(0.8 - (Y - (ay - 51)) / 10 + (X - ax) / 30));
        return [...c, 1 - smooth(-0.6, 0.6, d)];
      });
      break;
    }
    default: throw new Error(name);
  }
  return im;
}

export function render() {
  const files = new Map();
  for (const n of Object.keys(SLICES)) for (const s of [1, 2]) files.set(`${n}${s === 2 ? '@2x' : ''}.png`, slice(n, s).png());
  for (const n of Object.keys(ART)) for (const s of [1, 2]) files.set(`${n}${s === 2 ? '@2x' : ''}.png`, art(n, s).png());
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const files = render();
  let total = 0, bad = 0;
  if (!check) mkdirSync(OUT_DIR, { recursive: true });
  for (const [f, b] of files) {
    total += b.length;
    const p = path.join(OUT_DIR, f);
    if (check) { if (!existsSync(p) || !readFileSync(p).equals(b)) { bad++; console.log(`differs: ${f}`); } }
    else writeFileSync(p, b);
  }
  console.log(`${files.size} files, ${(total / 1024).toFixed(1)} KiB${check ? `, ${bad} differ` : ''}`);
  if (bad) process.exit(1);
}
