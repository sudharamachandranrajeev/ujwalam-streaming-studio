// SPDX-License-Identifier: GPL-3.0-or-later
// RS3 (D412) clips.reelStyles in settings.json: the style per reel type and the styles that join the clip look's mix.
// Checked like the other clip settings (services/studio-ui/user-settings.mjs); read by services/clip/reel_style.py pick().
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readSettings, reelStylesProblems, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

test('good values pass, bad ones say why', () => {
  assert.deepEqual(reelStylesProblems({ byType: { reel: 'fast-warm', impact: null }, pool: ['fast-warm', 'calm'] }), []);
  assert.deepEqual(reelStylesProblems({}), []);
  const bad = [
    [null, /must be an object/],
    [{ byType: { story: 'x' } }, /unknown reel type story/],
    [{ byType: { reel: 'Bad Id' } }, /style id/],
    [{ byType: { reel: 3 } }, /style id/],
    [{ pool: ['a', 'a'] }, /different style ids/],
    [{ pool: 'a' }, /different style ids/],
    [{ pool: Array.from({ length: 17 }, (_, i) => `s${i}`) }, /up to 16/],
    [{ inPool: true }, /unknown clips.reelStyles setting inPool/],
  ];
  for (const [v, re] of bad) assert.match(reelStylesProblems(v).join('; '), re, JSON.stringify(v));
  assert.match(settingsProblems({ clips: { reelStyles: { byType: { reel: '../x' } } } }).join(), /style id/);
});

test('saved type by type; pool replaced whole; a broken value reads as none', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-rs3-'));
  try {
    writeSettings(dir, { clips: { reelStyles: { byType: { reel: 'fast-warm' }, pool: ['fast-warm'] } } });
    writeSettings(dir, { clips: { reelStyles: { byType: { montage: 'calm' } } } });
    assert.deepEqual(readSettings(dir).clips.reelStyles, { byType: { reel: 'fast-warm', montage: 'calm' }, pool: ['fast-warm'] });
    writeSettings(dir, { clips: { reelStyles: { byType: { reel: null }, pool: [] } } });
    assert.deepEqual(readSettings(dir).clips.reelStyles, { byType: { reel: null, montage: 'calm' }, pool: [] });
    writeSettings(dir, { clips: { recording: 'ask' } });
    assert.ok(readSettings(dir).clips.reelStyles, 'another change keeps it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
