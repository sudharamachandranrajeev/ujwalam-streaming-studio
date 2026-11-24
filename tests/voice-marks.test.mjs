// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T6 live voice marks (services/event-core/voice-marks.mjs): phrase matching across Malayalam script, Manglish and
// English (shared samples with the Python side), flag gating, marks only through addMarker, gaps, failure isolation.
// Invented lines only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilePhrases, createVoiceMarks, loadVoiceConfig, matchPhrases, FLAG } from '../services/event-core/voice-marks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'voice-phrases.json'), 'utf8')).samples;
const CFG = loadVoiceConfig();

function fakeHost({ fail = false, hang = false, throwSync = false } = {}) {
  const calls = [];
  // Only addMarker exists: any other host method (stream, outputs, scenes) would be a TypeError here.
  return { calls, addMarker(source, note) { calls.push([source, note]); if (throwSync) throw new Error('x'); if (hang) return new Promise(() => {}); return fail ? Promise.reject(new Error('down')) : Promise.resolve({ ok: true }); } };
}
const flagsOn = (on = true) => ({ isOn: (id) => id === FLAG && on });
const tick = () => new Promise((r) => setImmediate(r));

test('config: phrases from data, live values unverified', () => {
  assert.deepEqual(CFG.items.map((i) => i.id), ['adipoli', 'polich', 'scene', 'super']);
  assert.equal(CFG.status, 'unverified');
  const j = JSON.parse(readFileSync(path.join(HERE, '..', 'data', 'clip', 'excitement.json'), 'utf8'));
  for (const k of ['weights', 'rank', 'live']) assert.equal(j[k].status, 'unverified', k);
  assert.equal(j.approvedBy, null);
});

test('matching: Malayalam script, Manglish and English samples (same samples as the Python side)', () => {
  const c = compilePhrases(CFG.items);
  for (const s of SAMPLES) assert.deepEqual(matchPhrases(s.text, c), s.want, JSON.stringify(s.text));
  assert.deepEqual(matchPhrases(null, c), []);
  // NFD input (decomposed) still matches after NFC
  assert.deepEqual(matchPhrases('സൂപ്പർ'.normalize('NFD'), c), ['super']);
});

test('heard: a phrase writes exactly one marker (source audio, phrase id only, no text)', async () => {
  const host = fakeHost();
  const vm = createVoiceMarks({ flags: flagsOn(), host, config: CFG });
  assert.deepEqual(vm.heard('ayyo പൊളിച്ചു secret words here', 1000), ['polich']);
  await tick();
  assert.deepEqual(host.calls, [['audio', 'voice: marker phrase polich']]);
  assert.equal(vm.stats().written, 1);
});

test('gaps: same phrase once per minGapSec, any phrase once per anyGapSec', async () => {
  const host = fakeHost();
  const vm = createVoiceMarks({ flags: flagsOn(), host, config: CFG });
  assert.deepEqual(vm.heard('super', 0), ['super']);
  assert.deepEqual(vm.heard('adipoli', 1000), []); // inside anyGapSec (5 s)
  assert.deepEqual(vm.heard('super', 10_000), []); // inside minGapSec (30 s)
  assert.deepEqual(vm.heard('adipoli', 10_000), ['adipoli']);
  await tick();
  assert.deepEqual(vm.heard('super', 31_000), ['super']);
  assert.equal(host.calls.length, 3);
  assert.equal(vm.stats().suppressed, 2);
});

test('flag off (or a throwing flag reader): no host call at all', () => {
  for (const flags of [flagsOn(false), { isOn() { throw new Error('bad'); } }]) {
    const host = fakeHost();
    const vm = createVoiceMarks({ flags, host, config: CFG });
    assert.deepEqual(vm.heard('adipoli super scene', 0), []);
    assert.equal(host.calls.length, 0);
    assert.equal(vm.stats().off, 1);
  }
});

test('host failure, sync throw and hang never throw; in-flight cap holds', async () => {
  for (const opt of [{ fail: true }, { throwSync: true }]) {
    const vm = createVoiceMarks({ flags: flagsOn(), host: fakeHost(opt), config: CFG });
    assert.deepEqual(vm.heard('super', 0), ['super']);
    await tick(); await tick();
    assert.equal(vm.stats().failures, 1);
  }
  const host = fakeHost({ hang: true });
  const vm = createVoiceMarks({ flags: flagsOn(), host, config: CFG });
  for (let i = 0; i < 5; i++) vm.heard('super', i * 60_000);
  assert.equal(host.calls.length, 2);
  assert.equal(vm.stats().dropped, 3);
});

test('long text is cut to maxTextChars before matching; bad input never throws', () => {
  const vm = createVoiceMarks({ flags: flagsOn(), host: fakeHost(), config: CFG });
  assert.deepEqual(vm.heard('x '.repeat(CFG.live.maxTextChars) + 'super', 0), []);
  assert.deepEqual(vm.heard({ not: 'text' }, 0), []);
  assert.deepEqual(vm.heard(undefined), []);
});
