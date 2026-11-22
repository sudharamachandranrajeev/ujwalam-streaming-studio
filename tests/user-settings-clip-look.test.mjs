// SPDX-License-Identifier: GPL-3.0-or-later
// clips.look in <dataDir>/settings.json (FX1-FX4, D411): the clip look ticks, randomise, locks and tunables. Same rules
// and messages as services/clip/clip_look.py look_problems(): both run the shared cases in
// tests/fixtures/clip-look-cases.json (tests/py/test_clip_look.py). Also the one-clip choice of "Make clips?".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookDefaults, lookInfo, lookOverrideProblems, musicAiReady, lookProblems, readSettings, settingsProblems, writeSettings } from '../services/studio-ui/user-settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ujw-look-'));
const withDir = (fn) => { const d = tmp(); try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); } };

test('the shared cases give the same problems as the Python check', () => {
  const cases = JSON.parse(readFileSync(path.join(here, 'fixtures', 'clip-look-cases.json'), 'utf8'));
  assert.ok(cases.length >= 10);
  for (const [v, want] of cases) assert.deepEqual(lookProblems(v), want, JSON.stringify(v));
  assert.deepEqual(settingsProblems({ clips: { look: { randomise: 1 } } }), ['clips.look.randomise must be true or false']);
  assert.deepEqual(lookProblems({ name: { durationSec: 5 } }), ['clips.look.name.durationSec must be from 1 to 4']);
});

test('defaults: every style ticked, randomise on, -16 dB, no blur option', () => {
  const d = lookDefaults();
  assert.equal(d.defaults.randomise, true);
  assert.deepEqual(d.defaults.music.modes, ['intro-outro', 'drop', 'full-bed']);
  assert.deepEqual(d.defaults.transitions.styles, ['punchy', 'cinematic', 'clean']);
  assert.deepEqual(d.defaults.name.styles, ['lower-third', 'corner-tag', 'kinetic']);
  assert.equal(d.defaults.music.levelDb, -16);
  assert.equal(JSON.stringify(d.defaults).includes('blur'), false);
});

test('free music pack (D427): ticked by default, offered, and packReady follows the download marker', () => withDir((d) => {
  const def = lookDefaults();
  assert.deepEqual(def.defaults.music.sources, ['folder', 'pack', 'ai']);
  assert.equal(def.sources.find((s) => s.id === 'pack').available, true);
  assert.equal(lookInfo(d).packReady, false);
  const pk = JSON.parse(readFileSync(path.join(here, '..', 'data', 'clip', 'music-library.json'), 'utf8')).pack;
  const dir = path.join(d, ...pk.folder.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, pk.marker), '{"files":{}}');
  assert.equal(lookInfo(d).packReady, true);
}));

test('free music pack (D427): saved sources get the pack once; a later untick stays off', () => withDir((d) => {
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { look: { music: { sources: ['folder'] } } } }));
  assert.deepEqual(readSettings(d).clips.look.music, { sources: ['folder', 'pack', 'ai'], packOffered: true, aiOffered: true });
  assert.deepEqual(lookInfo(d).look.music.sources, ['folder', 'pack', 'ai']);
  writeSettings(d, { clips: { look: { transitions: { sfx: false } } } }); // any save stores the move
  assert.equal(JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8')).clips.look.music.packOffered, true);
  writeSettings(d, { clips: { look: { music: { sources: ['folder'] } } } });
  assert.deepEqual(readSettings(d).clips.look.music.sources, ['folder'], 'unticked by the user: stays off');
  assert.deepEqual(lookProblems({ music: { packOffered: 'yes' } }), ['clips.look.music.packOffered must be true or false']);
}));

test('AI music (D429): ticked by default, aiReady only with the runtime Python, aiOffered checked', () => withDir((d) => {
  assert.equal(lookDefaults().sources.find((s) => s.id === 'ai').available, true);
  const rt = path.join(d, 'rt');
  assert.equal(musicAiReady(undefined, {}), false, 'no setting, no env: unavailable');
  assert.equal(musicAiReady(undefined, { UJWALAM_ACESTEP_RUNTIME: rt }), false, 'folder without Python');
  const py = JSON.parse(readFileSync(path.join(here, '..', 'data', 'clip', 'music-gen.json'), 'utf8')).python;
  mkdirSync(path.join(rt, ...py.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(path.join(rt, ...py.split('/')), '');
  assert.equal(musicAiReady(undefined, { UJWALAM_ACESTEP_RUNTIME: rt }), true);
  assert.equal(musicAiReady('rt', {}), false, 'not absolute');
  writeSettings(d, { clips: { look: { music: { aiRuntime: rt } } } });
  const saved = { ...process.env }; delete process.env.UJWALAM_ACESTEP_RUNTIME;
  try { assert.equal(lookInfo(d).aiReady, true, 'from the setting'); } finally { Object.assign(process.env, saved); }
  assert.deepEqual(settingsProblems({ clips: { look: { music: { aiRuntime: 'relative' } } } }),
    ['clips.look.music.aiRuntime must be empty or a full folder path up to 260 characters']);
  assert.deepEqual(lookProblems({ music: { aiRuntime: 'C:\\x\ny' } }), ['clips.look.music.aiRuntime must be empty or a full folder path up to 260 characters']);
  assert.deepEqual(lookProblems({ music: { aiRuntime: '' } }), []);
  assert.deepEqual(lookProblems({ music: { aiOffered: 1 } }), ['clips.look.music.aiOffered must be true or false']);
}));

test('free music pack (D427): shared cases with the Python side, validated first, then moved', () => {
  const cases = JSON.parse(readFileSync(path.join(here, 'fixtures', 'clip-look-pack-migration.json'), 'utf8'));
  for (const [stored, want] of cases) withDir((d) => {
    if (stored !== null) writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { look: stored } }));
    assert.deepEqual(lookInfo(d).look.music.sources, want, JSON.stringify(stored));
  });
});

test('round trip: saved group by group, read back, a bad stored value reads as the defaults', () => withDir((d) => {
  assert.equal('look' in readSettings(d).clips, false);
  assert.deepEqual(lookInfo(d).look, lookDefaults().defaults);
  writeSettings(d, { clips: { look: { transitions: { styles: ['clean'], sfx: false } } } });
  writeSettings(d, { clips: { look: { randomise: false, name: { lock: 'corner-tag' } } } });
  writeSettings(d, { clips: { look: { transitions: { beatSync: false } } } });
  const stored = JSON.parse(readFileSync(path.join(d, 'settings.json'), 'utf8')).clips.look;
  assert.deepEqual(stored, { randomise: false, transitions: { styles: ['clean'], sfx: false, beatSync: false }, name: { lock: 'corner-tag' } });
  const info = lookInfo(d).look;
  assert.equal(info.randomise, false);
  assert.deepEqual(info.transitions, { styles: ['clean'], sfx: false, beatSync: false, lock: null });
  assert.equal(info.name.lock, 'corner-tag');
  assert.equal(info.name.sizePct, 100, 'untouched parts keep their default');
  writeSettings(d, { clips: { recording: 'after' } });
  assert.deepEqual(readSettings(d).clips.look, stored, 'other settings keep the look');
  writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ clips: { look: { name: { blur: true } } } }));
  assert.equal('look' in readSettings(d).clips, false);
  assert.deepEqual(lookInfo(d).look, lookDefaults().defaults);
}));

test('the one-clip choice: an option id or off per part', () => {
  assert.deepEqual(lookOverrideProblems({ music: 'drop', transitions: 'off', name: 'kinetic' }), []);
  assert.deepEqual(lookOverrideProblems({}), []);
  assert.deepEqual(lookOverrideProblems({ name: 'centre' }), ['look.name must be off or one of lower-third, corner-tag, kinetic']);
  assert.deepEqual(lookOverrideProblems({ colour: 'red' }), ['unknown look part colour']);
  assert.deepEqual(lookOverrideProblems([]), ['look must be an object']);
});
