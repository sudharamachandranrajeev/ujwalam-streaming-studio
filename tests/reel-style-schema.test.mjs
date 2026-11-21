// SPDX-License-Identifier: GPL-3.0-or-later
// RS2 reel style record (D412): data/clip/reel-style.schema.json validates the committed example record (the Python
// test tests/py/test_reel_style.py checks that the same file follows services/clip/reel_style.py) and refuses records
// that break the limits (zoom entrance >= 600 ms, exit >= 400 ms, unknown keys such as stored frames or text).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(new URL('../data/clip/reel-style.schema.json', import.meta.url), 'utf8'));
const example = JSON.parse(readFileSync(new URL('./fixtures/reel-style-example.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const clone = (o) => JSON.parse(JSON.stringify(o));

test('the example record is valid', () => {
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
});

test('limits and unknown keys are refused', () => {
  const bad = [
    (d) => { d.zooms.inMs = 600; },
    (d) => { d.zooms.outMs = 400; },
    (d) => { d.examples[0].frames = []; },
    (d) => { d.ocrText = 'x'; },
    (d) => { d.examples[0].sha256 = 'abc'; },
    (d) => { d.colour.strength = 1.5; },
    (d) => { d.tune = { speed: 2 }; },
    (d) => { d.version = 2; },
    (d) => { delete d.measured; },
  ];
  for (const f of bad) {
    const d = clone(example);
    f(d);
    assert.equal(validate(d), false, f.toString());
  }
});

test('a part that could not be measured is null', () => {
  const d = clone(example);
  for (const p of ['zooms', 'ramps', 'text', 'music']) d[p] = null;
  assert.equal(validate(d), true, JSON.stringify(validate.errors));
});
