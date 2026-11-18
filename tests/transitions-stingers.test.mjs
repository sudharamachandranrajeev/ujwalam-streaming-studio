// SPDX-License-Identifier: GPL-3.0-or-later
// Cyberpunk stingers (D391): presets are valid, the committed WebM files decode (VP9 with alpha), are opaque at the
// switch point, transparent at both ends, and stay under the flash limit (3 per second) over black, grey and white.
// Needs ffmpeg (FFMPEG env, else PATH); every child runs hidden. Does not start the host.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STINGER_DIR, SIZES, listPresets, loadPreset, validatePreset } from '../tools/make-stingers.mjs';
import { createFlashAnalyser } from '../services/overlay-server/flash-detect.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const have = spawnSync(FFMPEG, ['-version'], { windowsHide: true }).status === 0;
const opt = { skip: have ? false : 'ffmpeg not runnable' };
const presets = listPresets();

function decode(file, w, h, extra = []) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-c:v', 'libvpx-vp9', '-i', file, ...extra, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    { maxBuffer: 1 << 30, windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return { buf: r.stdout, frames: r.stdout.length / (w * h * 4) };
}
const frameAt = (ms, fps) => Math.round((ms * fps) / 1000);

describe('stinger presets', () => {
  test('at least neon-glitch (default), synthwave-sweep and cyan-grid; exactly one default', () => {
    const ids = presets.map((p) => p.id);
    for (const id of ['neon-glitch', 'synthwave-sweep', 'cyan-grid']) assert.ok(ids.includes(id), id);
    assert.deepEqual(presets.filter((p) => p.default).map((p) => p.id), ['neon-glitch']);
    for (const p of presets) validatePreset(p);
  });
  test('a preset that does not cover the point, or starts visible, is refused', () => {
    const p = loadPreset('neon-glitch');
    assert.throws(() => validatePreset({ ...p, pointMs: 100 }), /pointMs|cover/);
    assert.throws(() => validatePreset({ ...p, timing: { ...p.timing, coverMs: 600 } }), /cover/);
    assert.throws(() => validatePreset({ ...p, durationMs: 820 }), /empty frames/);
  });
});

for (const p of presets) {
  for (const c of ['h', 'v']) {
    const { width: w, height: h } = SIZES[c];
    const file = path.join(STINGER_DIR, `${p.id}-${c}.webm`);
    describe(`${p.id}-${c}.webm`, () => {
      test('is committed and small', () => {
        const n = statSync(file).size;
        assert.ok(n > 10_000 && n < 1_500_000, `${n} bytes`);
      });
      test('decodes with alpha: transparent first and last frame, opaque at pointMs +- 1 frame', opt, () => {
        const n = Math.round((p.durationMs * p.fps) / 1000);
        const at = frameAt(p.pointMs, p.fps);
        const probe = (idx) => {
          const { buf } = decode(file, w, h, ['-vf', `select='eq(n,${idx})'`, '-frames:v', '1', '-fps_mode', 'passthrough']);
          let min = 255, max = 0;
          for (let i = 3; i < buf.length; i += 4) { if (buf[i] < min) min = buf[i]; if (buf[i] > max) max = buf[i]; }
          return { min, max };
        };
        const first = probe(0), last = probe(n - 1);
        assert.ok(first.max <= 4, `first frame alpha max ${first.max}`);
        assert.ok(last.max <= 4, `last frame alpha max ${last.max}`);
        for (const idx of [at - 1, at, at + 1]) assert.ok(probe(idx).min >= 250, `frame ${idx} alpha min ${probe(idx).min}`);
      });
      test('frame count and size match the preset', opt, () => {
        const r = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate', '-of', 'json', file], { windowsHide: true });
        if (r.error) return;
        const s = JSON.parse(r.stdout).streams[0];
        assert.equal(s.width, w); assert.equal(s.height, h);
        assert.equal(Number(s.nb_read_frames), Math.round((p.durationMs * p.fps) / 1000));
        assert.equal(s.r_frame_rate, `${p.fps}/1`);
      });
      test('flash rate stays at or under 3 per second over black, grey, white and a black-to-white swap', opt, () => {
        const sw = c === 'h' ? 192 : 108, sh = c === 'h' ? 108 : 192;
        const { buf, frames } = decode(file, sw, sh, ['-vf', `scale=${sw}:${sh}:flags=area`]);
        const fb = sw * sh * 4;
        const worst = [];
        for (const [name, bgFor] of [['black', () => 0], ['grey', () => 128], ['white', () => 255], ['swap', (i) => (i < frameAt(p.pointMs, p.fps) ? 0 : 255)]]) {
          const an = createFlashAnalyser({ width: sw, height: sh, fps: p.fps });
          const rgb = Buffer.alloc(sw * sh * 3);
          for (let i = 0; i < frames; i++) {
            const bg = bgFor(i);
            for (let px = 0, o = i * fb, q = 0; px < sw * sh; px++, o += 4, q += 3) {
              const a = buf[o + 3] / 255;
              rgb[q] = buf[o] * a + bg * (1 - a); rgb[q + 1] = buf[o + 1] * a + bg * (1 - a); rgb[q + 2] = buf[o + 2] * a + bg * (1 - a);
            }
            an.push(rgb);
          }
          const res = an.result();
          worst.push(`${name}: ${res.peakFlashesPerSecond}`);
          assert.ok(res.pass, `${name} over ${res.limit}/s: ${JSON.stringify({ peak: res.peakFlashesPerSecond, trans: res.maxTransitionsInWindow })}`);
        }
        console.log(`# flash ${p.id}-${c}: ${worst.join(', ')}`);
      });
    });
  }
}
