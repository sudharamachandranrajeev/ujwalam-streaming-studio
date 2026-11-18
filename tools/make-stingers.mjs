// SPDX-License-Identifier: GPL-3.0-or-later
// Cyberpunk stinger generator (D391): draws RGBA frames with a small deterministic rasterizer (plain JS, no deps) and
// pipes them to ffmpeg, which writes VP9 WebM with alpha. Nothing is downloaded and no font is used.
//
//   node tools/make-stingers.mjs [--id <preset>] [--canvas h|v] [--out <dir>]     write the .webm files
//   node tools/make-stingers.mjs --list                                          list the presets
//
// Presets are data: data/transitions/stingers/<id>.json (palette, timing, shape, pointMs, tags). Output goes to
// data/transitions/stingers/<id>-h.webm (1920x1080) and <id>-v.webm (1080x1920). Same preset + same ffmpeg = same frames.
//
// Look: the dark base slab sweeps across on a diagonal and covers the canvas (so the scene swap at pointMs is hidden),
// with a group of neon bars glued to its edge (ahead of it on the way in, behind it on the way out), glow on every edge,
// a neon grid and scanlines on the base, and a short RGB-split glitch band while the canvas is covered. Before the
// first sweep and after the last one every pixel is transparent, so the old and new scenes show through.
//
// Frame budget: the colour of a pixel depends on its position along the sweep axis only (a 1-D lookup table per frame);
// grid, bars, scanlines and glitch are the only 2-D parts, and they touch the base slab only.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STINGER_DIR = path.join(REPO, 'data', 'transitions', 'stingers');
export const SIZES = Object.freeze({ h: { width: 1920, height: 1080 }, v: { width: 1080, height: 1920 } });
const FFMPEG = () => process.env.FFMPEG || 'ffmpeg';

// ---- helpers ----
export function hexRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) throw new RangeError(`bad colour ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2); // cubic
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const seedOf = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

export function loadPreset(id, dir = STINGER_DIR) {
  const p = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  validatePreset(p);
  if (p.id !== id) throw new Error(`preset file ${id}.json has id ${p.id}`);
  return p;
}
export function listPresets(dir = STINGER_DIR) {
  return readdirSync(dir).filter((f) => /^[a-z][a-z0-9-]*\.json$/.test(f)).map((f) => loadPreset(f.slice(0, -5), dir));
}

export function validatePreset(p) {
  const bad = (m) => { throw new RangeError(`stinger preset ${p?.id ?? '?'}: ${m}`); };
  if (!p || typeof p !== 'object') bad('not an object');
  if (!/^[a-z][a-z0-9-]*$/.test(p.id ?? '')) bad('id');
  if (p.version !== 1) bad('version must be 1');
  if (typeof p.label !== 'string' || !p.label) bad('label');
  if (p.fps !== 60) bad('fps must be 60');
  if (!Number.isInteger(p.durationMs) || p.durationMs < 500 || p.durationMs > 1200) bad('durationMs 500..1200');
  if (!Number.isInteger(p.pointMs) || p.pointMs <= 0 || p.pointMs >= p.durationMs) bad('pointMs inside the clip');
  const pal = p.palette ?? {};
  for (const k of ['base', 'grid', 'core']) hexRgb(pal[k]);
  if (!Array.isArray(pal.bars) || pal.bars.length < 1 || pal.bars.length > 5) bad('palette.bars 1..5 colours');
  pal.bars.forEach(hexRgb);
  const t = p.timing ?? {};
  for (const k of ['startMs', 'coverMs', 'clearStartMs', 'clearMs']) if (!Number.isFinite(t[k]) || t[k] < 0) bad(`timing.${k}`);
  const n = pal.bars.length;
  const coverEnd = t.startMs + t.coverMs;
  const clearFirst = t.clearStartMs;
  if (!(coverEnd <= p.pointMs - 1000 / p.fps && p.pointMs + 1000 / p.fps <= clearFirst)) bad('full cover must span pointMs +- one frame');
  if (t.clearStartMs + t.clearMs > p.durationMs - 2 * (1000 / p.fps)) bad('the clip must end with at least two empty frames');
  const s = p.shape ?? {};
  for (const k of ['barWidthPx', 'barGapPx', 'glowPx', 'coreWidthPx', 'gridSpacingPx', 'gridWidthPx', 'gridAlpha', 'scanlineAlpha', 'dataBars']) if (!Number.isFinite(s[k]) || s[k] < 0) bad(`shape.${k}`);
  if (!s.angleDeg || typeof s.angleDeg.h !== 'number' || typeof s.angleDeg.v !== 'number') bad('shape.angleDeg {h, v}');
  const g = p.glitch ?? {};
  for (const k of ['startMs', 'durationMs', 'bands', 'maxShiftPx', 'splitPx']) if (!Number.isFinite(g[k]) || g[k] < 0) bad(`glitch.${k}`);
  if (g.bands > 0 && !(g.startMs >= coverEnd - 1000 / p.fps && g.startMs + g.durationMs <= clearFirst + 1000 / p.fps)) bad('glitch must sit inside the covered window');
  if (!p.tags || typeof p.tags !== 'object' || Array.isArray(p.tags)) bad('tags');
}

// ---- rendering ----
// One frame: `frame(i)` -> Uint8Array RGBA (straight alpha). Built per canvas size.
export function createRenderer(preset, width, height) {
  validatePreset(preset);
  const { palette: pal, timing: tm, shape: sh, glitch: gl } = preset;
  const fps = preset.fps;
  const unit = Math.min(width, height) / 1080; // pixel values in the preset are for a 1080 short side
  const px = (v) => v * unit;
  const ang = (width >= height ? sh.angleDeg.h : sh.angleDeg.v) * Math.PI / 180;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const corners = [0, width * dx, height * dy, width * dx + height * dy];
  const sMin = Math.min(...corners), sMax = Math.max(...corners);
  const glow = Math.max(1, px(sh.glowPx));
  const core = Math.max(1, px(sh.coreWidthPx));
  const reach = Math.ceil(glow * 4 + core + 4);
  const barW = px(sh.barWidthPx), barGap = px(sh.barGapPx);
  const nBars = pal.bars.length;
  const lo = sMin - nBars * (barW + barGap) - reach - 8;
  const hi = sMax + nBars * (barW + barGap) + reach + 8;
  const L = Math.ceil(hi - lo) + 2; // LUT length, 1 px per entry
  const base = hexRgb(pal.base), gridC = hexRgb(pal.grid), coreC = hexRgb(pal.core);
  const barC = pal.bars.map(hexRgb);
  const pos = (tau) => lo + (hi - lo) * easeInOut(clamp01(tau));
  const rnd = mulberry32(seedOf(`${preset.id}:${width}x${height}`));

  // data bars: thin horizontal rectangles on the base slab (seeded, fixed for the clip)
  const rects = [];
  for (let i = 0; i < sh.dataBars; i++) {
    const w = Math.round(px(60 + rnd() * 340)), h = Math.max(2, Math.round(px(3 + rnd() * 9)));
    rects.push({ x: Math.round(rnd() * (width - w)), y: Math.round(rnd() * (height - h)), w, h, c: barC[i % nBars], a: 0.25 + rnd() * 0.3 });
  }
  // glitch bands: seeded rows and shifts, re-rolled every 2 frames inside the glitch window
  const glitchAt = (i) => {
    const t = (i * 1000) / fps;
    if (!(gl.bands > 0) || t < gl.startMs || t >= gl.startMs + gl.durationMs) return [];
    const r = mulberry32(seedOf(`${preset.id}:g:${Math.floor(i / 2)}:${width}`));
    const out = [];
    for (let b = 0; b < gl.bands; b++) {
      const h = Math.round(px(10 + r() * 70));
      out.push({ y: Math.floor(r() * (height - h)), h, shift: Math.round((r() * 2 - 1) * px(gl.maxShiftPx)) });
    }
    return out;
  };

  // LUT scratch (r, g, b, a in 0..1 floats, plus a base-slab weight)
  const lr = new Float32Array(L), lg = new Float32Array(L), lb = new Float32Array(L), la = new Float32Array(L), lw = new Float32Array(L);
  const buf = new Uint8Array(width * height * 4);

  // composite colour c (0..255) with alpha a over the LUT entry k (straight alpha "over")
  const over = (k, c, a) => {
    if (a <= 0) return;
    const A = la[k];
    const outA = a + A * (1 - a);
    lr[k] = (c[0] * a + lr[k] * A * (1 - a)) / outA;
    lg[k] = (c[1] * a + lg[k] * A * (1 - a)) / outA;
    lb[k] = (c[2] * a + lb[k] * A * (1 - a)) / outA;
    la[k] = outA;
  };
  const edgeAA = (v) => clamp01(v + 0.5); // 1-px ramp
  // Bars are glued to the base slab by distance, so they travel as one coloured group (one bump of light per pass, which
  // keeps the flash count low): 'in' bars sit ahead of the base's leading edge (bar 0 farthest), 'out' bars sit behind its
  // trailing edge (bar n-1 farthest).
  const bandAt = (lead, trail, j, phase) => (phase === 'in' ? lead + (nBars - j) * (barW + barGap) - barGap : trail - (nBars - 1 - j) * (barW + barGap));

  function buildLut(frameT) {
    la.fill(0); lw.fill(0);
    const colour0 = barC[0];
    for (let k = 0; k < L; k++) { lr[k] = colour0[0]; lg[k] = colour0[1]; lb[k] = colour0[2]; }
    const lead = pos((frameT - tm.startMs) / tm.coverMs); // base leading edge
    const trail = pos((frameT - tm.clearStartMs) / tm.clearMs); // base trailing edge
    const baseOn = !(lead <= lo + 0.5 && trail <= lo + 0.5) && lead > trail;
    // glow of the base edges (under the base), then the base, then bars with their glow, then the edge cores
    const glowEdge = (edge, dir, c, strength) => {
      // dir +1: glow ahead (greater s) of `edge`; -1: behind it
      for (let k = Math.max(0, Math.floor(edge - lo - reach)); k < Math.min(L, Math.ceil(edge - lo + reach)); k++) {
        const d = ((lo + k) - edge) * dir;
        if (d <= 0) continue;
        over(k, c, strength * Math.exp(-d / glow));
      }
    };
    if (baseOn) {
      glowEdge(lead, +1, barC[nBars - 1], 0.85); // ahead of the lead edge
      glowEdge(trail, -1, barC[0], 0.85); // behind the trail edge
      const k0 = Math.max(0, Math.floor(trail - lo) - 1), k1 = Math.min(L, Math.ceil(lead - lo) + 1);
      for (let k = k0; k < k1; k++) {
        const s = lo + k;
        const cov = edgeAA(Math.min(lead - s, s - trail));
        over(k, base, cov);
        lw[k] = cov;
      }
    }
    // bars
    for (const phase of ['in', 'out']) {
      for (let j = 0; j < nBars; j++) {
        const p = bandAt(lead, trail, j, phase);
        if (p <= lo + 0.5 || p - barW >= hi - 0.5) continue;
        const c = barC[j];
        const front = p, back = p - barW;
        glowEdge(front, +1, c, 0.7);
        glowEdge(back, -1, c, 0.7);
        const k0 = Math.max(0, Math.floor(back - lo) - 1), k1 = Math.min(L, Math.ceil(front - lo) + 1);
        for (let k = k0; k < k1; k++) { const s = lo + k; over(k, c, edgeAA(Math.min(front - s, s - back))); lw[k] = 0; }
        // bright core on the leading edge of an 'in' bar and the trailing edge of an 'out' bar
        const e = phase === 'in' ? front : back;
        for (let k = Math.max(0, Math.floor(e - lo - core - 1)); k < Math.min(L, Math.ceil(e - lo + core + 1)); k++) over(k, coreC, 0.9 * clamp01(1 - Math.abs(lo + k - e) / core));
      }
    }
    if (baseOn) {
      for (const e of [lead, trail]) {
        for (let k = Math.max(0, Math.floor(e - lo - core - 1)); k < Math.min(L, Math.ceil(e - lo + core + 1)); k++) over(k, coreC, 0.9 * clamp01(1 - Math.abs(lo + k - e) / core));
      }
    }
    return { lead, trail, baseOn };
  }

  const gridW = Math.max(1, px(sh.gridWidthPx));
  const spacing = Math.max(8, px(sh.gridSpacingPx));
  const scanA = sh.scanlineAlpha;

  function frame(i) {
    const frameT = (i * 1000) / fps;
    const { baseOn } = buildLut(frameT);
    const drift = frameT * 0.05 * unit; // slow grid drift (px)
    const sRow0 = (y) => y * dy - lo;
    for (let y = 0; y < height; y++) {
      const s0 = sRow0(y);
      const scan = (y & 3) === 0 ? 1 - scanA : 1;
      const gy = ((y + drift) % spacing) < gridW;
      let o = y * width * 4;
      for (let x = 0; x < width; x++, o += 4) {
        const k = (s0 + x * dx) | 0;
        const a = la[k];
        if (a <= 0) { buf[o] = lr[k]; buf[o + 1] = lg[k]; buf[o + 2] = lb[k]; buf[o + 3] = 0; continue; }
        let r = lr[k], g = lg[k], b = lb[k];
        const w = lw[k];
        if (baseOn && w > 0.001 && a > 0.99) {
          // grid on the base slab (blended by the base weight, so the AA edge stays clean)
          if (gy || ((x + drift * 0.6) % spacing) < gridW) {
            const m = sh.gridAlpha * w;
            r += (gridC[0] - r) * m; g += (gridC[1] - g) * m; b += (gridC[2] - b) * m;
          }
          r *= scan; g *= scan; b *= scan;
        }
        buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a * 255 + 0.5;
      }
    }
    // data bars on the base slab
    if (baseOn) {
      for (const q of rects) {
        for (let y = q.y; y < q.y + q.h; y++) {
          for (let x = q.x, o = (y * width + q.x) * 4; x < q.x + q.w; x++, o += 4) {
            const k = ((y * dy + x * dx) - lo) | 0;
            const m = q.a * lw[k] * (la[k] > 0.99 ? 1 : 0);
            if (m <= 0) continue;
            buf[o] += (q.c[0] - buf[o]) * m; buf[o + 1] += (q.c[1] - buf[o + 1]) * m; buf[o + 2] += (q.c[2] - buf[o + 2]) * m;
          }
        }
      }
    }
    // glitch: shift whole rows and split the colour channels (wraps inside the row; only rows that are covered matter)
    for (const b of glitchAt(i)) {
      const split = Math.round(px(gl.splitPx));
      for (let y = b.y; y < b.y + b.h; y++) {
        const row = y * width * 4;
        const src = buf.slice(row, row + width * 4);
        for (let x = 0; x < width; x++) {
          const m = (n) => (((x - b.shift + n) % width) + width) % width * 4;
          const c = m(0), cr = m(split), cb = m(-split);
          const o = row + x * 4;
          if (src[c + 3] === 0 && src[cr + 3] === 0 && src[cb + 3] === 0) continue;
          buf[o] = src[cr]; buf[o + 1] = src[c + 1]; buf[o + 2] = src[cb + 2];
          buf[o + 3] = Math.max(src[c + 3], src[cr + 3], src[cb + 3]);
        }
      }
    }
    return buf;
  }
  return { width, height, fps, frames: Math.round((preset.durationMs * fps) / 1000), frame };
}

// ---- encoding ----
export function ffmpegArgs({ width, height, fps, out }) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-nostdin',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    '-an', '-vf', 'format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
    '-b:v', '0', '-crf', '33', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-threads', '4', '-g', '60',
    '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', '-f', 'webm', out];
}

export async function writeStinger(preset, canvas, outFile) {
  const { width, height } = SIZES[canvas];
  const r = createRenderer(preset, width, height);
  const tmp = `${outFile}.tmp`;
  const child = spawn(FFMPEG(), ffmpegArgs({ width, height, fps: r.fps, out: tmp }), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  const err = [];
  child.stderr.on('data', (d) => err.push(d));
  const done = new Promise((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`ffmpeg not runnable: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().trim().split('\n').pop()}`))));
  });
  child.stdin.on('error', () => { /* reported by close */ });
  for (let i = 0; i < r.frames; i++) {
    const f = r.frame(i);
    if (!child.stdin.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength))) await new Promise((res) => child.stdin.once('drain', res));
  }
  child.stdin.end();
  await done;
  renameSync(tmp, outFile);
  return { file: outFile, frames: r.frames, width, height };
}

// ---- CLI ----
async function main(argv) {
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--list')) { for (const p of listPresets()) console.log(`${p.id}\t${p.label}\tpointMs ${p.pointMs}`); return 0; }
  const out = path.resolve(arg('out') ?? STINGER_DIR);
  mkdirSync(out, { recursive: true });
  const presets = arg('id') ? [loadPreset(arg('id'))] : listPresets();
  const canvases = arg('canvas') ? [arg('canvas')] : ['h', 'v'];
  for (const c of canvases) if (!SIZES[c]) throw new RangeError('--canvas h|v');
  for (const p of presets) for (const c of canvases) {
    const t0 = Date.now();
    const r = await writeStinger(p, c, path.join(out, `${p.id}-${c}.webm`));
    console.log(`${p.id}-${c}.webm  ${r.width}x${r.height}  ${r.frames} frames  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  return 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(2); });
}
