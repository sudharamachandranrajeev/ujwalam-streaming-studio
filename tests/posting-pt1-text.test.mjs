// SPDX-License-Identifier: GPL-3.0-or-later
// PT1 (D408): post text from the clip's facts. Lines are data per kind and per game; a missing fact is never guessed; the
// last N lines are not repeated; titles over the limit are left out; older drafts are redrafted once. Temp dirs only.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createPostStore, loadTemplates } from '../services/posting/index.mjs';
import { cleanFacts, createTextHistory, draftText, fillFacts, pickLine, poolsFor } from '../services/posting/post-text.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pt1-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const T = loadTemplates();
const FACT = /\{(medal|killsText|kills|result|mode)\}/;

describe('PT1 lines from facts', () => {
  test('the shipped pools: every kind has title lines; lines name only known facts and never {n} or {date}', () => {
    for (const k of ['short', 'montage', 'won-reel', 'impact-play', 'long-highlights']) {
      const p = poolsFor(T, k, 'codm');
      assert.ok(p.title.length >= 2, k);
      for (const l of [...p.title, ...p.lead]) {
        assert.doesNotMatch(l, /\{(n|date)\}/, l);
        for (const m of l.matchAll(/\{([^{}]+)\}/g)) assert.ok(FACT.test(`{${m[1]}}`) || /^(handles|links)\./.test(m[1]), l);
      }
    }
    assert.ok(poolsFor(T, 'short', 'codm').title.length > poolsFor(T, 'short', null).title.length, 'the game adds lines');
    assert.deepEqual(poolsFor(T, 'short', '../evil'), poolsFor(T, 'short', null), 'a bad game id adds nothing');
  });

  test('facts are cleaned; {kills} comes from killsText; a missing fact drops the line', () => {
    assert.deepEqual(cleanFacts({ killsText: '3 KILLS', medal: 'Triple Kill', extra: 'x', result: '{bad}' }), { killsText: '3 KILLS', medal: 'Triple Kill', kills: '3' });
    assert.equal(fillFacts('{medal} on stream', {}), null);
    assert.equal(fillFacts('{medal} on stream', { medal: 'Ace' }), 'Ace on stream');
    const d = draftText({ templates: T, kind: 'won-reel', game: null, facts: {}, seed: 'x' });
    assert.equal(d.title, null, 'no facts at all: no fact line (the template title is used)');
    const r = draftText({ templates: T, kind: 'won-reel', game: null, facts: { result: 'Victory' }, seed: 'x' });
    assert.ok(r.title && /Victory/.test(r.title.text) && !FACT.test(r.title.text), JSON.stringify(r));
  });

  test('the same clip gets the same line; the last N lines are not used again; a long title is left out', () => {
    const f = { killsText: '4 KILLS', medal: 'Quad Feed', mode: 'MP' };
    const a = draftText({ templates: T, kind: 'short', game: null, facts: f, seed: 'abc' });
    assert.deepEqual(draftText({ templates: T, kind: 'short', game: null, facts: f, seed: 'abc' }), a);
    const lines = ['{medal} one', '{medal} two', '{medal} three'];
    const seen = [];
    for (let k = 0; k < 3; k++) { const p = pickLine(lines, { medal: 'M' }, { seed: `s${k}`, recent: seen }); seen.push(p.line); }
    assert.equal(new Set(seen).size, 3, 'no repeat while a fresh line is left');
    assert.equal(pickLine(lines, { medal: 'M' }, { seed: 'z', recent: seen }).line, seen[0], 'all used: the oldest repeats');
    assert.equal(pickLine(['{medal} is a very long line'], { medal: 'M' }, { seed: 'q', fits: (s) => s.length <= 5 }), null);
    const h = createTextHistory(mk(), 2); h.add('a', 'b'); h.add('c');
    assert.deepEqual(h.recent(), ['b', 'c']);
  });
});

describe('PT1 redraft older drafts once', () => {
  test('a draft without textVersion gets fact text once; an edited draft and approved posts are left alone', async () => {
    const dataDir = mk();
    const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
    mkdirSync(path.dirname(ledgerFile), { recursive: true });
    const entries = {};
    const mkPkg = (key, status, extra = {}) => {
      const dir = path.join(dataDir, 'pk', key); mkdirSync(dir, { recursive: true });
      const sha = key.repeat(64).slice(0, 64);
      writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ version: 1, title: 'Old title', description: 'Old body', tags: [], hashtags: [], target: 'youtube-shorts', privacy: 'private', status,
        source: { run: 'r', clipId: key, kind: 'won-reel', sha256: sha, file: path.join(dataDir, `${key}.mp4`) }, video: { file: 'v.mp4', bytes: 1 }, limits: { ok: true, checks: [] }, unresolved: [], createdAt: 'x', updatedAt: 'x', ...extra }));
      entries[`${sha}:youtube-shorts`] = { sha256: sha, target: 'youtube-shorts', status, dir, clipId: key, createdAt: 'x', updatedAt: 'x' };
      return dir;
    };
    const dA = mkPkg('a', 'draft'); const dB = mkPkg('b', 'draft', { editedByUser: true }); const dC = mkPkg('c', 'approved');
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries }));
    const store = createPostStore({ ledgerFile });
    const used = [];
    const factsFor = () => ({ facts: { result: 'Victory', killsText: '7 KILLS' }, game: 'codm' });
    assert.equal(store.redraftOnce({ templates: T, profile: {}, recent: () => used, used: (...l) => used.push(...l.filter(Boolean)), factsFor }), 1);
    const a = JSON.parse(readFileSync(path.join(dA, 'post.json'), 'utf8'));
    assert.notEqual(a.title, 'Old title'); assert.match(a.description, /Old body$/);
    assert.equal(a.source.textVersion, 2); assert.deepEqual(a.source.facts, { result: 'Victory', killsText: '7 KILLS', kills: '7' }); assert.equal(a.source.game, 'codm');
    assert.equal(JSON.parse(readFileSync(path.join(dB, 'post.json'), 'utf8')).title, 'Old title');
    assert.equal(JSON.parse(readFileSync(path.join(dC, 'post.json'), 'utf8')).title, 'Old title');
    assert.equal(store.redraftOnce({ templates: T, profile: {}, factsFor }), 0, 'only once');
  });
});
