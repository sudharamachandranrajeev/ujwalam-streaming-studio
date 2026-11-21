// SPDX-License-Identifier: GPL-3.0-or-later
// BD1/BD2 data (D414): data/games/codm/moments.json follows data/schemas/moments.schema.json (status unverified, game
// numbers as data, evidence fields), and a song map made by services/clip/song_map.py on a synthetic track
// (tests/fixtures/song-map-example.json) follows data/schemas/song-map.schema.json: numbers and section names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const moments = ajv.compile(read('../data/schemas/moments.schema.json'));
const songMap = ajv.compile(read('../data/schemas/song-map.schema.json'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('the CODM moments file is valid and unverified', () => {
  const m = read('../data/games/codm/moments.json');
  assert.equal(moments(m), true, JSON.stringify(moments.errors));
  assert.equal(m.status, 'unverified');
  assert.match(m.evidence.realFootage, /UNVERIFIED/);
});

test('moments: out-of-range and unknown values are refused', () => {
  const m = read('../data/games/codm/moments.json');
  const bad = [
    (d) => { d.gunshot.weaponZone.x1 = 1.2; },
    (d) => { d.status = 'approved'; },
    (d) => { d.kills.detectors.push('m4'); },
    (d) => { d.scope.ringMaxLuma = 300; },
    (d) => { d.weights = { M4: 1 }; },
    (d) => { delete d.evidence; },
    (d) => { d.gunshot.fft = 1000; },
  ];
  for (const f of bad) { const d = clone(m); f(d); assert.equal(moments(d), false, f.toString()); }
});

test('a made song map is valid; text or frames are refused', () => {
  const s = read('./fixtures/song-map-example.json');
  assert.equal(songMap(s), true, JSON.stringify(songMap.errors));
  const bad = [
    (d) => { d.title = 'a song'; },
    (d) => { d.sections[0].kind = 'chorus'; },
    (d) => { d.sections[0].name = 'x'; },
    (d) => { d.transients[0] = { t: 1, strength: 2, onBeat: true }; },
    (d) => { d.bpm = 0; },
    (d) => { d.version = 2; },
  ];
  for (const f of bad) { const d = clone(s); f(d); assert.equal(songMap(d), false, f.toString()); }
});
