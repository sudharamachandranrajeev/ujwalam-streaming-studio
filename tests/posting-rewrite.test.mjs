// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T4: rewrite scheduled posts and undo. Fakes only: a fake YouTube (stateful), the fake llama server, a fake quota
// file in a temp dir. No real Google, no real model, no GPU.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createModelRunner, loadConfig } from '../services/local-model/runner.mjs';
import { loadAiTextConfig } from '../services/posting/ai-text.mjs';
import { composeField, createPostStore, packageUploads } from '../services/posting/index.mjs';
import { CAPTIONS_SCOPE } from '../services/posting/oauth.mjs';
import { createQuotaBudget, loadQuota } from '../services/posting/quota-budget.mjs';
import { REWRITE_FLAG, readRewrites, rewriteLedgerFile, runRewrite, runUndo } from '../services/posting/rewrite.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-llama-server.mjs');
const CFG = loadConfig();
const cfg = loadAiTextConfig();
const PROFILE = { handles: { youtube: '@example-channel' } };
const NOW = Date.parse('2026-11-24T18:00:00Z');
const FUTURE = '2026-11-30T12:00:00Z';
const PAST = '2026-11-20T12:00:00Z';
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-t4-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const items = [{ id: CFG.serverItem, dest: 'models/llama-server' }, { id: CFG.modelItem, dest: 'models/qwen3-vl-4b' }];
function modelsDir() {
  const d = mk();
  mkdirSync(path.join(d, 'llama-server')); mkdirSync(path.join(d, 'qwen3-vl-4b'));
  for (const f of [['llama-server', CFG.serverExe], ['qwen3-vl-4b', CFG.model], ['qwen3-vl-4b', CFG.mmproj]]) writeFileSync(path.join(d, ...f), 'x');
  return d;
}
const answer = (o = {}) => ({ title: 'Clutch finish nobody saw coming', description: 'Everything on the line.\nThe last push settles it.', tags: ['cod mobile', 'clutch', 'highlights', 'shooter', 'mobile gaming'],
  thumbHook: 'NO WAY', thumbTime: 3, factsSeen: { kills: null, result: null, mode: null, medal: null }, ...o });
function aiDeps(reply) {
  const runner = createModelRunner({
    modelsDir: modelsDir(), items, isOn: () => true, status: async () => ({ live: false, recording: false }), gpuBusy: () => false, freeVram: () => 6000,
    config: { startTimeoutMs: 8000, watchMs: 50, idleMs: 150 },
    spawnServer: (exe, args) => spawn(process.execPath, [FAKE, ...args], { windowsHide: true, env: { ...process.env, FAKE_LLAMA_REPLY: JSON.stringify(reply) }, stdio: ['ignore', 'pipe', 'pipe'] }),
  });
  return { cfg, profileTerms: [], vocab: new Set(['clutch']), grab: async () => [Buffer.from([0xff, 0xd8, 0xff, 0xd9])], ocr: async () => new Set(), tmpRoot: mk(), runner, isOn: () => true };
}

/** Packages `n` template drafts, marks them uploaded with a videoId and publishAt. */
async function setup(n, { publishAt = FUTURE } = {}) {
  const dataDir = mk(); const clips = mk();
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true }); mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  const files = Array.from({ length: n }, (_, i) => {
    const file = path.join(clips, `codm_short_20261124-1${i}0841_triple-kill_0${i}_v.mp4`);
    writeFileSync(file, Buffer.from(`clip-${i}`.repeat(8)));
    return { file, label: 'x', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-24T09:00:00.000Z', kind: 'short', seconds: 12 };
  });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files }));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  await packageUploads({ dataDir, ledgerFile, profile: PROFILE, ffmpeg: process.execPath });
  const store = createPostStore({ ledgerFile, dataDir });
  const yt = { videos: {}, calls: [] };
  store.ledger.list().forEach((e, i) => {
    const id = `${e.sha256.slice(0, 16)}.${e.target}`;
    const post = JSON.parse(readFileSync(path.join(store.dir(id), 'post.json'), 'utf8'));
    const videoId = `vid${i}`;
    store.ledger.setStatus(e.sha256, e.target, 'uploaded', '2026-11-24T10:00:00.000Z');
    store.ledger.annotate(e.sha256, e.target, { videoId, publishAt });
    yt.videos[videoId] = { snippet: { publishedAt: '2026-11-24T10:00:00Z', channelId: 'UCx', title: composeField(post, ['title']), description: composeField(post, ['description', 'hashtags']),
      thumbnails: { default: { url: 'u' } }, tags: post.tags, categoryId: '20', defaultLanguage: 'en', liveBroadcastContent: 'upcoming', localized: { title: 't' } }, privacyStatus: 'private', publishAt };
  });
  return { dataDir, store, yt, ids: store.ledger.list().map((e) => `${e.sha256.slice(0, 16)}.${e.target}`) };
}
const fakeFetch = (yt) => async (url, init) => {
  const u = new URL(url);
  yt.calls.push({ method: init.method, part: u.searchParams.get('part'), body: init.body ? JSON.parse(init.body) : null, url });
  const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
  if (init.method === 'GET') {
    const v = yt.videos[u.searchParams.get('id')];
    return reply(200, { items: v ? [{ snippet: v.snippet, status: { privacyStatus: v.privacyStatus, publishAt: v.publishAt } }] : [] });
  }
  const b = JSON.parse(init.body);
  if (yt.failUpdate) return reply(403, { error: { errors: [{ reason: 'forbidden' }] } });
  yt.videos[b.id].snippet = { ...b.snippet, publishedAt: yt.videos[b.id].snippet.publishedAt, channelId: 'UCx' }; // whole snippet replaced
  return reply(200, { id: b.id });
};
const flags = (on = true) => ({ isOn: (id) => (id === REWRITE_FLAG ? on : true) });
const auth = (scopes = [CAPTIONS_SCOPE]) => ({ grantedScopes: async () => scopes, accessToken: async () => 'tok' });
const budgetFor = (dataDir, over = {}) => createQuotaBudget({ dataDir, nowMs: () => NOW, quota: () => ({ quotaUnitsPerDay: 10000, perUploadUnits: 50, readReserveUnits: 100, updateUnits: 50, ...over }) });
const base = (e, extra = {}) => ({ dataDir: e.dataDir, store: e.store, auth: auth(), budget: budgetFor(e.dataDir), flags: flags(), fetchImpl: fakeFetch(e.yt), nowMs: () => NOW, ffmpeg: process.execPath, ...extra });
const ledgerLines = (dataDir) => { try { return readFileSync(rewriteLedgerFile(dataDir), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

describe('quota.json has the update cost', () => {
  test('updateUnits 50 with its source, status unverified', () => {
    const q = loadQuota(mk(), undefined, { nowMs: NOW });
    assert.equal(q.updateUnits, 50);
    const j = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'posting', 'quota.json'), 'utf8'));
    assert.match(j.updateUnitsSource, /determine_quota_cost/); assert.match(j.updateUnitsSource, /UNVERIFIED/);
  });
});

describe('rewrite', () => {
  test('happy path: new AI text, every other snippet field kept, original saved, one ledger line each', async () => {
    const e = await setup(2);
    const before = structuredClone(e.yt.videos);
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    assert.equal(r.rewritten.length, 2, JSON.stringify(r));
    for (const [vid, v] of Object.entries(e.yt.videos)) {
      assert.equal(v.snippet.title, 'Clutch finish nobody saw coming');
      assert.match(v.snippet.description, /^Everything on the line\./);
      assert.ok(v.snippet.description.includes(before[vid].snippet.description), 'the old description (links, credits) is kept after the AI lines');
      assert.equal(v.snippet.categoryId, '20'); assert.equal(v.snippet.defaultLanguage, 'en');
      assert.ok(v.snippet.tags.includes('clutch'));
      assert.equal(v.privacyStatus, 'private'); assert.equal(v.publishAt, FUTURE);
    }
    const puts = e.yt.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2);
    for (const p of puts) { assert.equal(p.part, 'snippet'); assert.deepEqual(Object.keys(p.body.snippet).sort(), ['categoryId', 'defaultLanguage', 'description', 'tags', 'title']); }
    const st = readRewrites(e.dataDir);
    for (const [vid, rec] of Object.entries(st.items)) { assert.equal(rec.state, 'rewritten'); assert.deepEqual(rec.original, before[vid].snippet, 'the whole original snippet is saved'); }
    const lines = ledgerLines(e.dataDir);
    assert.equal(lines.length, 2); assert.ok(lines.every((l) => l.action === 'rewrite' && l.units === 51));
  });

  test('flag off: refused, nothing sent; no sign-in scope: refused', async () => {
    const e = await setup(1);
    assert.deepEqual(await runRewrite({ ...base(e, { flags: flags(false) }), aiDeps: aiDeps(answer()) }), { refused: 'flag-off' });
    assert.deepEqual(await runRewrite({ ...base(e, { auth: auth([]) }), aiDeps: aiDeps(answer()) }), { refused: 'scope-missing' });
    assert.equal(e.yt.calls.length, 0);
  });

  test('template fallback (checker rejects the answer) skips: nothing is overwritten', async () => {
    const e = await setup(1);
    const before = structuredClone(e.yt.videos);
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer({ title: 'Check https://example.org now' })) });
    assert.equal(r.rewritten.length, 0); assert.match(r.skipped[0].why, /^template-fallback/);
    assert.deepEqual(e.yt.videos, before);
    assert.equal(e.yt.calls.filter((c) => c.method === 'PUT').length, 0);
    assert.equal(ledgerLines(e.dataDir).length, 0);
  });

  test('AI text switched off: every video skipped, no PUT', async () => {
    const e = await setup(1);
    const r = await runRewrite({ ...base(e), aiDeps: { ...aiDeps(answer()), isOn: () => false } });
    assert.equal(r.skipped[0].why, 'ai-flag-off'); assert.equal(e.yt.calls.length, 0);
  });

  test('quota stop: the reserve is never touched; the rest is reported as left', async () => {
    const e = await setup(3);
    // room for exactly one video: read 1 + update 50 = 51 of (quota - reserve) = 60
    const b = budgetFor(e.dataDir, { quotaUnitsPerDay: 160 });
    const r = await runRewrite({ ...base(e, { budget: b }), aiDeps: aiDeps(answer()) });
    assert.equal(r.rewritten.length, 1); assert.equal(r.stopped, 'quota-day-used'); assert.equal(r.left, 2);
    assert.equal(e.yt.calls.filter((c) => c.method === 'PUT').length, 1);
    const used = b.state().units.n;
    assert.ok(used <= 160 - 100, `used ${used} stays below quota minus the reserve`);
  });

  test('items not in our ledger, public items and edited-on-YouTube items are untouched', async () => {
    const e = await setup(2);
    e.yt.videos.stranger = { snippet: { title: 'not ours', description: 'x', categoryId: '22', tags: [] }, privacyStatus: 'private', publishAt: FUTURE };
    const strangerBefore = structuredClone(e.yt.videos.stranger);
    e.yt.videos.vid0.privacyStatus = 'public'; e.yt.videos.vid0.publishAt = null; // went public already
    e.yt.videos.vid1.snippet.title = 'My own title'; // edited by hand in YouTube Studio
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    assert.equal(r.rewritten.length, 0);
    assert.deepEqual(r.skipped.map((s) => s.why).sort(), ['changed-on-youtube', 'not-scheduled-now']);
    assert.deepEqual(e.yt.videos.stranger, strangerBefore);
    assert.ok(!e.yt.calls.some((c) => c.url.includes('stranger')), 'a video outside the ledger is never even read');
    assert.equal(e.yt.calls.filter((c) => c.method === 'PUT').length, 0);
  });

  test('a ledger video whose publish time is in the past is not a candidate (no call at all)', async () => {
    const e = await setup(1, { publishAt: PAST });
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    assert.deepEqual(r, { rewritten: [], skipped: [], left: 0, stopped: null });
    assert.equal(e.yt.calls.length, 0);
  });

  test('the clip file is gone: skipped, no call', async () => {
    const e = await setup(1);
    unlinkSync(e.store.media(e.ids[0], 'video').file);
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    assert.equal(r.skipped[0].why, 'video-file-gone'); assert.equal(e.yt.calls.length, 0);
  });

  test('a second run does not rewrite the same video again', async () => {
    const e = await setup(1);
    await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    assert.equal(r.skipped[0].why, 'already-rewritten');
    assert.equal(e.yt.calls.filter((c) => c.method === 'PUT').length, 1);
  });

  test('YouTube refuses the update: nothing recorded, no ledger line', async () => {
    const e = await setup(1);
    e.yt.failUpdate = true;
    const r = await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    assert.equal(r.rewritten.length, 0); assert.equal(r.skipped[0].why, 'update-update-not-permitted');
    assert.deepEqual(readRewrites(e.dataDir).items, {}); assert.equal(ledgerLines(e.dataDir).length, 0);
  });
});

describe('undo', () => {
  test('restores the saved original exactly, one ledger line each, per item and in bulk', async () => {
    const e = await setup(2);
    const before = structuredClone(e.yt.videos);
    await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    const one = await runUndo({ ...base(e), only: [e.ids[0]] });
    assert.equal(one.restored.length, 1);
    const all = await runUndo({ ...base(e), flags: flags(false) }); // undo works with the rewrite switch off
    assert.equal(all.restored.length, 1);
    for (const [vid, v] of Object.entries(e.yt.videos)) {
      for (const k of ['title', 'description', 'tags', 'categoryId', 'defaultLanguage']) assert.deepEqual(v.snippet[k], before[vid].snippet[k], `${vid}.${k}`);
    }
    assert.deepEqual(ledgerLines(e.dataDir).map((l) => l.action), ['rewrite', 'rewrite', 'undo', 'undo']);
    const again = await runUndo({ ...base(e) });
    assert.equal(again.restored.length, 0);
  });

  test('a video edited by hand since the rewrite is left alone unless forced', async () => {
    const e = await setup(1);
    const before = structuredClone(e.yt.videos.vid0.snippet);
    await runRewrite({ ...base(e), aiDeps: aiDeps(answer()) });
    e.yt.videos.vid0.snippet.title = 'Hand edit';
    const r = await runUndo({ ...base(e) });
    assert.equal(r.skipped[0].why, 'changed-on-youtube'); assert.equal(e.yt.videos.vid0.snippet.title, 'Hand edit');
    const f = await runUndo({ ...base(e), force: true });
    assert.equal(f.restored.length, 1); assert.equal(e.yt.videos.vid0.snippet.title, before.title);
  });
});
