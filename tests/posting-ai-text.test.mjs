// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T2: AI post text end to end with the fake llama-server (tests/helpers/fake-llama-server.mjs): one model start per
// batch, the checked answer lands in post.json (textSource ai), every failure keeps the template text and records why.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createModelRunner, loadConfig } from '../services/local-model/runner.mjs';
import { buildPrompt, loadAiTextConfig, loadVocab, transcriptFor, withAiText } from '../services/posting/ai-text.mjs';
import { aiPost, loadLimits, loadTemplates, packageUploads } from '../services/posting/index.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-llama-server.mjs');
const CFG = loadConfig();
const cfg = loadAiTextConfig();
const PROFILE = { handles: { youtube: '@example-channel' }, links: { discord: 'https://example.org/join' } };
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-t2-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const items = [{ id: CFG.serverItem, dest: 'models/llama-server' }, { id: CFG.modelItem, dest: 'models/qwen3-vl-4b' }];
function modelsDir() {
  const d = mk();
  mkdirSync(path.join(d, 'llama-server')); mkdirSync(path.join(d, 'qwen3-vl-4b'));
  for (const f of [['llama-server', CFG.serverExe], ['qwen3-vl-4b', CFG.model], ['qwen3-vl-4b', CFG.mmproj]]) writeFileSync(path.join(d, ...f), 'x');
  return d;
}
function runner(reply, over = {}) {
  const spawned = [];
  const r = createModelRunner({
    modelsDir: modelsDir(), items, isOn: () => true, status: async () => ({ live: false, recording: false }), gpuBusy: () => false, freeVram: () => 6000,
    config: { startTimeoutMs: 8000, watchMs: 50, idleMs: 150 },
    spawnServer: (exe, args) => { spawned.push(args); return spawn(process.execPath, [FAKE, ...args], { windowsHide: true, env: { ...process.env, FAKE_LLAMA_REPLY: typeof reply === 'string' ? reply : JSON.stringify(reply) }, stdio: ['ignore', 'pipe', 'pipe'] }); },
    ...over,
  });
  return { r, spawned };
}

const answer = (o = {}) => ({
  title: 'Clutch finish nobody saw coming', description: 'Everything on the line.\nThe last push settles it.', tags: ['cod mobile', 'clutch', 'highlights', 'shooter', 'mobile gaming'],
  thumbHook: 'NO WAY', thumbTime: 3, factsSeen: { kills: null, result: null, mode: null, medal: null }, ...o,
});

function setup(rows) {
  const dataDir = mk(); const clips = mk();
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true }); mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  const files = rows.map((r, i) => {
    const file = path.join(clips, r.name);
    writeFileSync(file, Buffer.from(`${r.name}-${i}`.repeat(8)));
    return { file, label: 'x', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-24T09:00:00.000Z', kind: r.kind ?? 'short', seconds: r.seconds ?? 12, ...(r.facts ? { facts: r.facts } : {}) };
  });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files }));
  return { dataDir, ledgerFile: path.join(dataDir, 'posting', 'ledger.json') };
}
const ROWS = [{ name: 'codm_short_20261124-185841_triple-kill_01_v.mp4' }, { name: 'codm_short_20261124-190841_triple-kill_02_v.mp4' }];
const pack = (e, ai, why) => packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: process.execPath, ...(ai ? { aiText: ai } : { aiWhy: why }) });
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
const postFiles = (e) => walk(path.join(e.dataDir, 'posting', 'packages')).filter((f) => f.endsWith('post.json'));
const grab = async () => [Buffer.from([0xff, 0xd8, 0xff, 0xd9])];
const ocr = async () => new Set();
const run = (e, deps) => withAiText({ cfg, profileTerms: [], vocab: new Set(['clutch']), grab, ocr, tmpRoot: mk(), ...deps }, (ai, why, stats) => pack(e, ai, why).then((r) => ({ r, stats })));

describe('AI text lands in the draft', () => {
  test('two drafts, one model start; title and description from the model, template lines kept after; textSource ai', async () => {
    const e = setup(ROWS);
    const { r: rn, spawned } = runner(answer());
    const { r, stats } = await run(e, { runner: rn, isOn: () => true });
    assert.equal(r.packaged.length, 2);
    assert.equal(spawned.length, 1, 'one model start for the whole batch');
    assert.equal(rn.running(), false, 'stopped after the batch');
    assert.equal(stats.used, 2);
    assert.equal(postFiles(e).length, 2);
    for (const f of postFiles(e)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      assert.equal(j.textSource, 'ai');
      assert.equal(j.title, 'Clutch finish nobody saw coming');
      assert.match(j.description, /^Everything on the line\.\nThe last push settles it.\n\n/);
      assert.match(j.description, /Live on @example-channel/, 'the template description (links) is kept after the AI lines');
      assert.ok(j.tags.includes('clutch') && j.tags.includes('gaming'), 'AI tags first, template tags kept');
      assert.deepEqual(j.ai.thumbHook, 'NO WAY');
      assert.equal(j.ai.thumbTime, 3);
      assert.equal(j.limits.ok, true);
      assert.deepEqual(j.unresolved, []);
    }
  });

  test('a clip with detector facts: a matching kill count passes and records factsSource detector', async () => {
    const e = setup([{ name: ROWS[0].name, facts: { killsText: '3 KILLS', result: 'VICTORY', mode: 'MP' } }]);
    const { r: rn } = runner(answer({ title: '3 kills to take the victory' }));
    await run(e, { runner: rn, isOn: () => true });
    const j = readPost(e);
    assert.equal(j.textSource, 'ai'); assert.equal(j.factsSource, 'detector'); assert.equal(j.title, '3 kills to take the victory');
  });

  test('no detector facts, the model saw 4 kills: a kill claim is rejected (fact-unverified), template text; the seen facts do not verify', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer({ title: '4 kills in one push', factsSeen: { kills: 4, result: null, mode: null, medal: null } }));
    await run(e, { runner: rn, isOn: () => true });
    const j = readPost(e);
    assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'fact-unverified');
  });
});

function readPost(e) {
  return JSON.parse(readFileSync(postFiles(e)[0], 'utf8'));
}

describe('every failure keeps the template text and records why', () => {
  const template = async () => { const e = setup([ROWS[0]]); await pack(e, null, null); return readPost(e); };
  const reason = async (rep, deps = {}) => {
    const e = setup([ROWS[0]]);
    const { r: rn, spawned } = runner(rep, deps.runner ?? {});
    const { stats } = await run(e, { runner: rn, isOn: () => true, ...(deps.top ?? {}) });
    return { j: readPost(e), spawned, stats };
  };

  test('checker reject (kill count not in the detector facts): template title, aiReject fact-kills, nothing of the model in the text', async () => {
    const e = setup([{ name: ROWS[0].name, facts: { killsText: '3 KILLS' } }]);
    const { r: rn } = runner(answer({ title: '9 kills for the win' }));
    const { stats } = await run(e, { runner: rn, isOn: () => true });
    const j = readPost(e);
    assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'fact-kills');
    assert.doesNotMatch(JSON.stringify(j), /9 kills|NO WAY/);
    assert.equal(stats.used, 0); assert.equal(stats.rejects['fact-kills'], 1);
  });

  test('screen name: a word that OCR reads on screen and is not in the vocab is rejected (screen-name)', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer({ title: 'Zorblax clutch finish' }));
    await run(e, { runner: rn, isOn: () => true, ocr: async () => new Set(['zorblax']) });
    const j = readPost(e);
    assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'screen-name');
    assert.doesNotMatch(JSON.stringify(j), /Zorblax/i);
  });

  test('screen word that is in the vocab is allowed', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer());
    await run(e, { runner: rn, isOn: () => true, ocr: async () => new Set(['clutch']) });
    assert.equal(readPost(e).textSource, 'ai');
  });

  test('OCR cannot run (seam throws): fail closed, template text, aiReject ocr-unavailable', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer());
    const { stats } = await run(e, { runner: rn, isOn: () => true, ocr: async () => { throw new Error('no python'); } });
    const j = readPost(e);
    assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'ocr-unavailable'); assert.equal(stats.used, 0);
  });

  test('win claim with no detector result: fact-unverified', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer({ title: 'We won it', factsSeen: { kills: null, result: 'victory', mode: null, medal: null } }));
    await run(e, { runner: rn, isOn: () => true });
    assert.equal(readPost(e).aiReject, 'fact-unverified');
  });

  test('privacy reject: a profile term in the text', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer({ title: 'ExampleBrand clutch' }));
    await run(e, { runner: rn, isOn: () => true, profileTerms: ['ExampleBrand'] });
    const j = readPost(e);
    assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'privacy');
  });

  test('limits: the composed description over the platform limit is rejected after composing (code limits)', async () => {
    const e = setup([ROWS[0]]);
    const small = loadLimits(); small.targets['youtube-shorts'].fields.description.max = 150;
    const { r: rn } = runner(answer());
    const ai = await withAiText({ cfg, profileTerms: [], vocab: new Set(), grab, ocr, tmpRoot: mk(), runner: rn, isOn: () => true }, (g) => packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: process.execPath, limits: small, aiText: g }));
    assert.equal(ai.packaged.length, 1);
    const j = readPost(e);
    assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'limits');
  });

  test('bad JSON from the model, a wrong shape', async () => {
    assert.equal((await reason('not json at all')).j.aiReject, 'bad-json');
    assert.equal((await reason({ title: 'only a title' })).j.aiReject, 'schema');
  });

  test('flag off: no model start, textSource template, aiReject flag-off', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn, spawned } = runner(answer());
    await run(e, { runner: rn, isOn: () => false });
    const j = readPost(e);
    assert.equal(spawned.length, 0); assert.equal(j.textSource, 'template'); assert.equal(j.aiReject, 'flag-off');
  });

  test('on air: the runner refuses, no model start, aiReject on-air', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn, spawned } = runner(answer(), { status: async () => ({ live: true, recording: false }) });
    await run(e, { runner: rn, isOn: () => true });
    const j = readPost(e);
    assert.equal(spawned.length, 0); assert.equal(j.aiReject, 'on-air');
  });

  test('local AI model switched off or files missing: aiReject off / missing', async () => {
    assert.equal((await reason(answer(), { runner: { isOn: () => false } })).j.aiReject, 'off');
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer(), { modelsDir: mk() });
    await run(e, { runner: rn, isOn: () => true });
    assert.equal(readPost(e).aiReject, 'missing');
  });

  test('no frame could be taken: aiReject no-frames; the template text equals the no-AI run', async () => {
    const e = setup([ROWS[0]]);
    const { r: rn } = runner(answer());
    await run(e, { runner: rn, isOn: () => true, grab: async () => [] });
    const j = readPost(e);
    const t = await template();
    assert.equal(j.aiReject, 'no-frames'); assert.equal(j.title, t.title); assert.equal(j.description, t.description);
  });

  test('a draft without AI input at all records nothing extra (today\'s post.json)', async () => {
    const t = await template();
    assert.equal(t.textSource, undefined); assert.equal(t.aiReject, undefined);
  });
});

describe('aiPost keeps the template lines and the music credit', () => {
  const limits = loadLimits();
  const templates = loadTemplates();
  const tpl = templates.targets['youtube-shorts'];
  const ctx = { profile: PROFILE, n: 1, date: '2026-11-24' };
  const base = { title: 'T', description: 'D', tags: ['gaming', 'highlights', 'stream'], hashtags: ['#Shorts', '#gaming'], target: 'youtube-shorts' };
  const ai = { title: 'Big play', description: 'line one\nline two', tags: ['clutch', 'Gaming', 'shooter', 'mobile', 'fps'], thumbHook: 'NO WAY', thumbTime: 1, factsSeen: {} };
  const go = (music, over = {}) => aiPost({ ai, tpl, ctx, post: base, music, limits, target: 'youtube-shorts', titleMax: 100, kind: 'short', seed: 's', prefs: undefined, ...over });

  test('credit text stays at the end, template description stays after the AI lines, tags deduplicated (case) with AI first', () => {
    const music = { use: 'credit', text: 'Music: Artist - Title\nhttps://www.youtube.com/watch?v=aaaaaaaaaaa' };
    const r = go(music);
    assert.ok(r.post, JSON.stringify(r));
    assert.match(r.post.description, /^line one\nline two\n\n.*Live on @example-channel/s);
    assert.ok(r.post.description.endsWith(music.text));
    assert.deepEqual(r.post.tags.slice(0, 5), ['clutch', 'Gaming', 'shooter', 'mobile', 'fps']);
    assert.equal(r.post.tags.filter((t) => t.toLowerCase() === 'gaming').length, 1);
    assert.deepEqual(r.post.hashtags.slice(0, 2), ['#Shorts', '#gaming']);
  });

  test('credit that would push the description over the limit: rejected, not truncated', () => {
    const music = { use: 'credit', text: 'Music: A\n'.repeat(900) };
    assert.equal(go(music).reject, 'limits');
  });

  test('a placeholder the profile cannot fill is rejected (unresolved)', () => {
    const r = go({ use: 'post' }, { ai: { ...ai, description: 'see {links.nothing}\nline two' } });
    assert.equal(r.reject, 'unresolved');
  });
});

describe('inputs: transcript beside the clip and the prompt', () => {
  test('transcriptFor reads <clip>.srt, then transcript.json; empty when none; the prompt carries facts and speech, never chat', () => {
    const d = mk();
    const clip = path.join(d, 'clip.mp4');
    writeFileSync(clip, 'x');
    assert.equal(transcriptFor(clip), '');
    writeFileSync(path.join(d, 'clip.srt'), '1\n00:00:01,000 --> 00:00:02,500\nnice shot\n\n2\n00:00:03,000 --> 00:00:04,000\nlet us go\n');
    assert.equal(transcriptFor(clip), 'nice shot let us go');
    writeFileSync(path.join(d, 'clip.transcript.json'), JSON.stringify({ segments: [{ text: 'first' }, { text: 'second' }] }));
    assert.equal(transcriptFor(clip), 'first second');
    assert.equal(transcriptFor(clip, 5), 'first');
    const p = buildPrompt(cfg, { kind: 'short', seconds: 12.4, facts: { killsText: '3 KILLS', result: 'VICTORY' }, transcript: 'first second' });
    assert.match(p, /kills: 3 KILLS/); assert.match(p, /result: VICTORY/); assert.match(p, /<speech>\nfirst second\n<\/speech>/); assert.match(p, /12 seconds/);
    assert.doesNotMatch(p, /\{\w+\}/, 'no placeholder is left unfilled');
    assert.doesNotMatch(p, /chat message:/);
  });
});

describe('vocab', () => {
  test('loadVocab: lowercase words of 3+ letters, no duplicates in the file, and game-pack labels are added', () => {
    const j = JSON.parse(readFileSync(new URL('../data/posting/ai-text-vocab.json', import.meta.url), 'utf8'));
    assert.equal(new Set(j.words).size, j.words.length, 'no duplicate words');
    assert.ok(j.words.every((w) => /^[a-z]{3,}$/.test(w)));
    const d = mk();
    mkdirSync(path.join(d, 'g1'));
    writeFileSync(path.join(d, 'g1', 'events.json'), JSON.stringify({ events: [{ id: 'wombat_zone', label: 'Wombat Rush' }] }));
    const v = loadVocab({ file: path.join(d, 'none.json'), gamesDir: d });
    assert.ok(v.has('wombat') && v.has('rush') && v.has('zone'));
    assert.ok(loadVocab().has('clutch'));
  });
});

describe('D443 T3: the cover with the hook', () => {
  const calls = [];
  const maker = (ok = true) => async (a) => { calls.push(a); if (ok) writeFileSync(a.out, 'jpg'); return ok; };
  const readCover = (e) => { const f = postFiles(e)[0]; return { j: JSON.parse(readFileSync(f, 'utf8')), dir: path.dirname(f) }; };
  const go = async (e, o = {}, reply = answer({ thumbHook: 'NO WAY', thumbTime: 3 })) => {
    calls.length = 0;
    const { r: rn } = runner(reply);
    const { coverMaker, ...deps } = o;
    return withAiText({ cfg, profileTerms: [], vocab: new Set(['clutch']), grab, ocr, tmpRoot: mk(), runner: rn, isOn: () => true, ...deps },
      (ai, why) => packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: process.execPath, ...(ai ? { aiText: ai } : { aiWhy: why }), ...(coverMaker ? { coverMaker } : {}) }));
  };

  test('checked hook and thumbTime go to the cover maker; cover.atSec is thumbTime; recorded as hook', async () => {
    const e = setup([ROWS[0]]);
    await go(e, { coverMaker: maker(true) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].hook, 'NO WAY'); assert.equal(calls[0].atSec, 3);
    const { j, dir } = readCover(e);
    assert.deepEqual(j.cover, { file: 'cover.jpg', atSec: 3 });
    assert.equal(j.ai.cover, 'hook');
    assert.equal(path.dirname(calls[0].out), dir);
  });

  test('the maker fails: the plain frame path runs, recorded as plain', async () => {
    const e = setup([ROWS[0]]);
    await go(e, { coverMaker: maker(false) });
    const { j } = readCover(e);
    assert.equal(j.ai.cover, 'plain');
    assert.equal(j.cover, null, 'the ffmpeg stand-in makes no frame, so the plain path ran and found none');
  });

  test('a reel that opens on its own start frame keeps frame 0; the maker is not called', async () => {
    const e = setup([ROWS[0]]);
    const u = path.join(e.dataDir, 'clips', 'uploads.json');
    const f = JSON.parse(readFileSync(u, 'utf8')); f.files[0].thumbnail = true; writeFileSync(u, JSON.stringify(f));
    await go(e, { coverMaker: maker(true) });
    assert.equal(calls.length, 0);
    assert.equal(readCover(e).j.ai.cover, undefined);
  });

  test('template fallback (rejected answer, flag off) or thumbTime past the end: the maker is never called', async () => {
    const e = setup([ROWS[0]]);
    await go(e, { coverMaker: maker(true) }, answer({ title: 'x'.repeat(400) }));
    assert.equal(calls.length, 0);
    assert.equal(readCover(e).j.textSource, 'template');
    const e2 = setup([ROWS[1]]);
    await go(e2, { coverMaker: maker(true), isOn: () => false });
    assert.equal(calls.length, 0);
    const e3 = setup([ROWS[0]]);
    await go(e3, { coverMaker: maker(true) }, answer({ thumbTime: 99 }));
    assert.equal(calls.length, 0);
  });
});
