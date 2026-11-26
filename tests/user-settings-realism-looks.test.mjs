// SPDX-License-Identifier: GPL-3.0-or-later
// RL4 (D445) clips.realismLooks in settings.json: the realism look per reel type (off, one look, random from ticks),
// same rules as services/clip/clip_realism.py problems(); and what GET /ui/api/settings offers (the looks, the types).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readSettings, realismLooksProblems, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';
import { realismLookInfo } from '../services/studio-ui/server.mjs';

test('realismLooksProblems: good values pass, bad ones say why (RL4)', () => {
  assert.deepEqual(realismLooksProblems({ byType: { reel: { mode: 'one', look: 'cinematic', ticks: [] },
    impact: { mode: 'random', look: null, ticks: ['filmic', 'night-neon'] }, montage: { mode: 'off' } } }), []);
  assert.deepEqual(realismLooksProblems({}), []);
  const bad = [
    [{ byType: { long: { mode: 'off' } } }, /unknown reel type long/],
    [{ byType: { reel: { mode: 'sometimes' } } }, /mode must be one of off, one, random/],
    [{ byType: { reel: { mode: 'one' } } }, /one look needs the look/],
    [{ byType: { reel: { mode: 'one', look: '../x' } } }, /look id/],
    [{ byType: { reel: { mode: 'random', ticks: ['aa', 'aa'] } } }, /different look ids/],
    [{ byType: { reel: { mode: 'off', extra: 1 } } }, /unknown clips.realismLooks.byType.reel setting extra/],
    [{ pool: [] }, /unknown clips.realismLooks setting pool/],
    [[], /must be an object/],
  ];
  for (const [v, re] of bad) assert.match(realismLooksProblems(v).join('; '), re, JSON.stringify(v));
  assert.match(settingsProblems({ clips: { realismLooks: { byType: { reel: { mode: 'x' } } } } }).join(), /mode must be/);
});

test('writeSettings: realism looks merge type by type; readSettings drops a bad stored value (RL4)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-rl4-set-'));
  try {
    assert.equal(readSettings(dir).clips.realismLooks, undefined, 'nothing saved: no value (all off)');
    writeSettings(dir, { clips: { realismLooks: { byType: { reel: { mode: 'one', look: 'cinematic', ticks: [] } } } } });
    writeSettings(dir, { clips: { realismLooks: { byType: { montage: { mode: 'random', look: null, ticks: ['gritty-war'] } } } } });
    const s = readSettings(dir).clips.realismLooks;
    assert.deepEqual(s, { byType: { reel: { mode: 'one', look: 'cinematic', ticks: [] }, montage: { mode: 'random', look: null, ticks: ['gritty-war'] } } });
    const raw = JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(raw.clips.realismLooks, s);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('realismLookInfo: every look of data/looks with its summary and swatch, Filmic first; the three reel types (RL4)', () => {
  const i = realismLookInfo();
  assert.deepEqual(i.types, ['reel', 'impact', 'montage']);
  assert.equal(i.looks[0].id, 'filmic');
  assert.equal(i.looks.length, 7);
  for (const l of i.looks) { assert.ok(l.name && l.summary); assert.equal(l.swatch.length, 5); }
});
