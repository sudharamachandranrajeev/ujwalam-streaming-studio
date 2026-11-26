// SPDX-License-Identifier: GPL-3.0-or-later
// Realism look library (D445, plan 2026-11-25-realism-looks RL1): data/looks/<id>.json against its schema and the
// project validator, every generated LUT byte for byte against tools/make-look-luts.mjs, the swatches, and each grade's
// planned colour shift. No host, no GPU (the host render check is app/host/tests/host-realism-fx.test.mjs).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { createProject, validateProject } from '../services/project/index.mjs';
import { DEFAULT_LOOK, loadLooks, lookSummary } from '../services/project/looks.mjs';
import { REALISM_EFFECTS } from '../services/project/structure.mjs';
import { LUTS_DIR, SIZE, cubeText, gradeOf, hueOf, lookGrade, lutOf, readLooks, swatchOf, toneOf } from '../tools/make-look-luts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...p) => JSON.parse(readFileSync(path.join(REPO, ...p), 'utf8'));
const LOOKS = readLooks();
const byId = Object.fromEntries(LOOKS.map(({ look }) => [look.id, look]));
const WANT = ['cinematic', 'cold-high-key', 'dark-cinematic', 'filmic', 'gritty-war', 'hdr-vivid', 'night-neon'];
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const chroma = (c) => Math.max(...c) - Math.min(...c);

test('library: the seven planned looks, each valid against data/schemas/look.schema.json; id = file name', () => {
  assert.deepEqual(LOOKS.map(({ look }) => look.id), WANT);
  const check = new Ajv2020({ allErrors: true, strict: true }).compile(readJson('data', 'schemas', 'look.schema.json'));
  for (const { file, look } of LOOKS) {
    assert.equal(check(look), true, `${look.id}: ${JSON.stringify(check.errors)}`);
    assert.equal(path.basename(file), `${look.id}.json`);
    assert.equal(look.status, 'unverified', `${look.id}: proposed values stay UNVERIFIED until the user has seen them`);
  }
  const names = LOOKS.map(({ look }) => look.name);
  assert.equal(new Set(names).size, names.length, 'names are unique (they name the scene copies)');
});

test('library: every look is project layer effects the validator takes, the LUT first on a shipped file, room for one own effect', () => {
  for (const { look } of LOOKS) {
    const doc = createProject({ name: 'T', fps: 30 });
    doc.scenes[0].layers.push({ id: 'g', type: 'color', name: 'G', source: { color: '#101010' },
      placements: { h: { visible: true, x: 0, y: 0, width: 1920, height: 1080 } }, effects: structuredClone(look.effects) });
    assert.deepEqual(validateProject(doc).errors, [], look.id);
    const lut = look.effects[0];
    assert.equal(lut, lutOf(look));
    assert.equal(lut.file.base, 'luts');
    assert.ok(readdirSync(LUTS_DIR).includes(lut.file.rel), `${look.id}: ${lut.file.rel} is shipped`);
    assert.ok(look.effects.length <= 5, `${look.id}: at most 5, so a layer with its own effect stays inside the 6-effect limit`);
    assert.ok(look.backdrop.includes('lut') && look.backdrop.every((t) => look.effects.some((e) => e.type === t)), `${look.id}: backdrop types`);
    if (look.id !== 'filmic') assert.equal(lut.file.rel, `look-${look.id}.cube`);
  }
  assert.deepEqual(byId.filmic.effects, JSON.parse(JSON.stringify(REALISM_EFFECTS)), 'Filmic is the D381 realism grade');
  assert.equal(byId.filmic.generator, 'tools/make-realism-lut.mjs');
});

test('LUTs: every committed look-<id>.cube is exactly what tools/make-look-luts.mjs writes (LF, 33^3)', () => {
  const graded = LOOKS.filter(({ look }) => look.grade);
  assert.equal(graded.length, 6);
  for (const { look } of graded) {
    const disk = readFileSync(path.join(LUTS_DIR, lutOf(look).file.rel));
    const want = Buffer.from(cubeText(gradeOf(look.grade)), 'utf8');
    assert.ok(disk.equals(want), `${look.id}: same bytes; run node tools/make-look-luts.mjs and commit the result`);
    assert.ok(!disk.includes(0x0d), 'LF only');
    const lines = want.toString('utf8').split('\n');
    assert.deepEqual(lines.slice(0, 3), [`LUT_3D_SIZE ${SIZE}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0']);
    assert.equal(lines.length - 4, 33 ** 3);
  }
  // no stray look LUT without a look
  const named = new Set(LOOKS.map(({ look }) => lutOf(look).file.rel));
  for (const f of readdirSync(LUTS_DIR).filter((x) => x.startsWith('look-'))) assert.ok(named.has(f), `${f} belongs to a look`);
});

test('swatches: each look file carries the generator\'s swatch (shadow, skin, foliage, sky, red); the menu summary passes it on', () => {
  for (const { look } of LOOKS) assert.deepEqual(look.swatch, swatchOf(look), look.id);
  const menu = loadLooks();
  assert.equal(menu[0].id, DEFAULT_LOOK, 'Filmic first');
  assert.deepEqual(menu.map((l) => l.id).sort(), WANT);
  assert.deepEqual(lookSummary(byId['night-neon']), { id: 'night-neon', name: 'Night neon', summary: byId['night-neon'].summary, swatch: byId['night-neon'].swatch });
});

test('loadLooks: a broken or mislabelled file is skipped, the others stay', async () => {
  const { mkdtempSync, writeFileSync, copyFileSync } = await import('node:fs');
  const os = await import('node:os');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-looks-'));
  copyFileSync(path.join(REPO, 'data', 'looks', 'cinematic.json'), path.join(dir, 'cinematic.json'));
  writeFileSync(path.join(dir, 'broken.json'), '{');
  writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ ...byId.cinematic, id: 'renamed' }));
  writeFileSync(path.join(dir, 'nolut.json'), JSON.stringify({ ...byId.cinematic, id: 'nolut', effects: [{ type: 'sharpen', amount: 0.2 }] }));
  assert.deepEqual(loadLooks(dir).map((l) => l.id), ['cinematic']);
  assert.deepEqual(loadLooks(path.join(dir, 'missing')), []);
});

test('grades: each look shifts colour the way its plan says (UNVERIFIED on real footage)', () => {
  const g = Object.fromEntries(LOOKS.map(({ look }) => [look.id, lookGrade(look)]));
  for (const id of WANT) { // greys stay greyish, nothing inverts, black and white stay in range
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      const o = g[id](v, v, v);
      assert.ok(o.every((x) => x >= 0 && x <= 1), `${id} ${v}`);
      assert.ok(chroma(o) < 0.12, `${id}: grey ${v} stays near grey (${o.map((x) => x.toFixed(3))})`);
    }
    let prev = -1;
    for (let i = 0; i <= 100; i++) { const y = luma(g[id](i / 100, i / 100, i / 100)); assert.ok(y >= prev - 1e-9, `${id}: brightness never goes down (${i})`); prev = y; }
  }
  // Dark cinematic (reference A): crushed blacks, teal-blue shadows, warm highlights
  const dkS = g['dark-cinematic'](0.12, 0.12, 0.12), dkH = g['dark-cinematic'](0.85, 0.85, 0.85);
  assert.ok(luma(dkS) < 0.08, `deep shadows ${dkS}`);
  assert.ok(dkS[2] > dkS[0] + 0.03, `shadows lean blue ${dkS}`);
  assert.ok(dkH[0] > dkH[2] + 0.05, `highlights lean orange ${dkH}`);
  // Cold high-key (reference C): bright, blue cast, low saturation, reds kept strong
  const ck = g['cold-high-key'];
  assert.ok(luma(ck(0.5, 0.5, 0.5)) > 0.58, 'mid grey lifted');
  assert.ok(ck(0.6, 0.6, 0.6)[2] > ck(0.6, 0.6, 0.6)[0] + 0.02, 'blue cast');
  assert.ok(chroma(ck(0.33, 0.47, 0.22)) < 0.6 * chroma([0.33, 0.47, 0.22]), 'foliage washed out');
  assert.ok(chroma(ck(0.8, 0.12, 0.1)) > 0.9 * chroma([0.8, 0.12, 0.1]), 'red kept strong');
  // Gritty war: low colour, muted dark greens
  const gw = g['gritty-war'];
  assert.ok(chroma(gw(0.45, 0.62, 0.85)) < 0.75 * chroma([0.45, 0.62, 0.85]), 'sky desaturated');
  const leaf = gw(0.33, 0.47, 0.22);
  assert.ok(chroma(leaf) < 0.7 * chroma([0.33, 0.47, 0.22]) && luma(leaf) < luma([0.33, 0.47, 0.22]), `greens muted and darker ${leaf}`);
  // HDR vivid: muted colours livelier, saturated ones kept
  const hv = g['hdr-vivid'];
  assert.ok(chroma(hv(0.5, 0.55, 0.6)) > 1.2 * chroma([0.5, 0.55, 0.6]), 'muted colour gains');
  // Night neon: deep blacks with a blue-magenta lean
  const nn = g['night-neon'](0.15, 0.15, 0.15);
  assert.ok(luma(nn) < 0.1 && nn[2] > nn[1] + 0.03, `night shadows ${nn}`);
  // Cinematic: teal shadows, warm highlights, soft (not crushed) blacks
  const cs = g.cinematic(0.15, 0.15, 0.15), ch = g.cinematic(0.85, 0.85, 0.85);
  assert.ok(cs[2] > cs[0] && ch[0] > ch[2], `split tone ${cs} / ${ch}`);
  assert.ok(luma(g.cinematic(0, 0, 0)) >= 0.01, 'black lifted a little (teal, so red stays near 0)');
});

test('generator helpers: hue, tone curve ends, shoulder lands on white', () => {
  assert.equal(hueOf(1, 0, 0), 0);
  assert.equal(hueOf(0, 1, 0), 120);
  assert.equal(hueOf(0, 0, 1), 240);
  assert.equal(hueOf(0.5, 0.5, 0.5), 0);
  const t = toneOf({ knee: 0.8, white: 0.95, crush: 0.05, lift: 0.02 });
  assert.ok(Math.abs(t(1) - 0.95) < 1e-12);
  assert.equal(t(0), 0.02);
  assert.equal(t(0.05), 0.02, 'crushed to the lifted black');
  assert.deepEqual(gradeOf({})(0.3, 0.6, 0.9), [0.3, 0.6, 0.9], 'an empty grade changes nothing');
});
