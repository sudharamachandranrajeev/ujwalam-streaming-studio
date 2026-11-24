// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T5: the local model cleans caption lines. A fake model (no real model, no download): timing preserved, ids must
// match, invented words, script changes, names and long lines are rejected (the original text is kept), flag off and
// model failure leave the transcript as it was. The model runs through withModel (never on air) and once per batch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { checkCue, cleanTranscript, editDistance, loadCleanConfig, scriptsOf } from '../services/local-model/caption-clean.mjs';
import { LocalModelError } from '../services/local-model/runner.mjs';

const cfg = loadCleanConfig();
const doc = () => ({ version: 1, segments: [
  { start: 0, end: 1.5, text: 'adipolli scene mwone', show: true, confidence: 0.9 },
  { start: 1.5, end: 3, text: 'ഇത് super aayi', show: true, confidence: 0.9 },
  { start: 3, end: 4, text: 'mumble mumble', show: false, hidden: 'low' },
  { start: 4, end: 6, text: 'headshot clutch round', show: true, confidence: 0.8 },
] });
const timing = (d) => d.segments.map((s) => [s.start, s.end]);
function runner() { const r = { starts: 0, withModel: async (fn) => { r.starts += 1; return fn({ url: 'http://127.0.0.1:1/' }); } }; return r; }
const ask = (reply) => async ({ prompt, schema }) => (typeof reply === 'function' ? reply({ prompt, schema }) : reply);
const deps = (chat, over = {}) => ({ runner: runner(), isOn: () => true, cfg, chat, ...over });

describe('caption clean-up (D443 T5)', () => {
  test('data files: words, limits and flag exist', () => {
    assert.ok(cfg.excitementWords.includes('adipoli') && cfg.excitementWords.includes('pwolich') && cfg.excitementWords.includes('polich'));
    assert.ok(cfg.limits.maxCueChars > 0 && cfg.limits.maxCueWords > 0);
    const f = JSON.parse(readFileSync(new URL('../data/flags.json', import.meta.url), 'utf8')).flags.find((x) => x.id === 'ai-captions');
    assert.equal(f.default, true); assert.match(f.description, /Local AI model/);
  });

  test('happy path: text cleaned, timing and count identical, hidden line untouched, one model start', async () => {
    const d = deps(ask(({ prompt, schema }) => {
      assert.match(prompt, /adipoli/); assert.equal(schema.properties.cues.items.properties.id.enum.length, 3);
      return { cues: [{ id: 0, text: 'Adipoli scene, mwone!' }, { id: 1, text: 'ഇത് super aayi.' }, { id: 3, text: 'Headshot, clutch round.' }] };
    }));
    const src = doc();
    const r = await cleanTranscript(src, d);
    assert.equal(r.stats.status, 'cleaned');
    assert.deepEqual(timing(r.doc), timing(src));
    assert.equal(r.doc.segments.length, 4);
    assert.equal(r.doc.segments[0].text, 'Adipoli scene, mwone!');
    assert.equal(r.doc.segments[0].rawText, 'adipolli scene mwone');
    assert.equal(r.doc.segments[2].text, 'mumble mumble');
    assert.equal(d.runner.starts, 1);
    assert.equal(src.segments[0].text, 'adipolli scene mwone', 'input not mutated');
  });

  test('id mismatch: the whole chunk keeps the originals', async () => {
    const r = await cleanTranscript(doc(), deps(ask({ cues: [{ id: 0, text: 'x' }, { id: 1, text: 'y' }, { id: 9, text: 'z' }] })));
    assert.equal(r.stats.changed, 0); assert.equal(r.stats.rejects['id-mismatch'], 3);
    assert.equal(r.doc.segments[0].text, 'adipolli scene mwone');
    const dup = await cleanTranscript(doc(), deps(ask({ cues: [{ id: 0, text: 'a' }, { id: 0, text: 'a' }, { id: 3, text: 'b' }] })));
    assert.equal(dup.stats.changed, 0);
  });

  test('hallucinated words and script change: those cues keep the original', async () => {
    const r = await cleanTranscript(doc(), deps(ask({ cues: [
      { id: 0, text: 'Adipoli scene mwone, subscribe to Jonathan now' },
      { id: 1, text: 'This is super good' },
      { id: 3, text: 'Headshot, clutch round.' },
    ] })));
    assert.equal(r.doc.segments[0].text, 'adipolli scene mwone');
    assert.equal(r.doc.segments[1].text, 'ഇത് super aayi');
    assert.equal(r.doc.segments[3].text, 'Headshot, clutch round.');
    assert.equal(r.stats.changed, 1); assert.equal(r.stats.rejected, 2);
    assert.ok(r.stats.rejects.script);
  });

  test('checkCue rules', () => {
    assert.equal(checkCue('adipolli scene', 'Adipoli scene!', cfg).ok, true);
    assert.equal(checkCue('scene', 'Scene', cfg).ok, true);
    assert.equal(checkCue('super', 'Pwolich super', cfg).ok, true, 'listed cheer allowed');
    assert.equal(checkCue('hello there', 'Hello there Karthik', cfg).code, 'new-word');
    assert.equal(checkCue('ഇത് ok', 'ഇത്', cfg).code, 'script');
    assert.equal(checkCue('ഇത് ok', 'ഇത് ok', cfg).ok, true);
    assert.equal(checkCue('a b c d', 'a\nb c d', cfg).code, 'multiline');
    assert.equal(checkCue('one two', 'one two '.repeat(60), cfg).code, 'too-long');
    assert.equal(checkCue('one two three four five six', 'one', cfg).code, 'dropped-words');
    assert.equal(checkCue('one two', 'one two', cfg, { profileTerms: ['two'] }).ok, true, 'a term already in the original is not new');
    assert.equal(checkCue('one', 'one gg', { ...cfg, gameTerms: ['gg'], limits: {} }, { profileTerms: ['gg'] }).code, 'profile-term');
    assert.equal(editDistance('adipoli', 'adipolli'), 1);
    assert.deepEqual([...scriptsOf('ഇത് ok')].sort(), ['Latin', 'Malayalam']);
  });

  test('flag off: nothing runs, nothing changes', async () => {
    const d = deps(ask(() => { throw new Error('no call'); }), { isOn: () => false });
    const r = await cleanTranscript(doc(), d);
    assert.equal(r.stats.status, 'off'); assert.equal(d.runner.starts, 0); assert.equal(r.doc.segments[0].text, 'adipolli scene mwone');
  });

  test('model failure: originals unchanged, whether the runner or the call fails', async () => {
    const on = { starts: 0, withModel: async () => { throw new LocalModelError('on-air', 'on air'); } };
    const a = await cleanTranscript(doc(), deps(ask({}), { runner: on }));
    assert.equal(a.stats.status, 'failed'); assert.equal(a.stats.reason, 'on-air'); assert.equal(a.doc.segments[0].text, 'adipolli scene mwone');
    const b = await cleanTranscript(doc(), deps(async () => { throw new LocalModelError('timeout', 't'); }));
    assert.equal(b.stats.changed, 0); assert.equal(b.doc.segments[1].text, 'ഇത് super aayi');
    const c = await cleanTranscript(doc(), deps(ask('not an object')));
    assert.equal(c.stats.changed, 0);
  });

  test('on air during the batch: everything is dropped, originals kept', async () => {
    const d = deps(async () => { throw new LocalModelError('on-air', 'stopped'); });
    const r = await cleanTranscript(doc(), d);
    assert.equal(r.stats.status, 'failed'); assert.deepEqual(timing(r.doc), timing(doc()));
  });
});
