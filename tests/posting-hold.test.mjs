// SPDX-License-Identifier: GPL-3.0-or-later
// Hold (2026-11-26): take private, future-scheduled videos off their YouTube schedule; youtubeSource instagram-winners
// stops direct YouTube scheduling. Fakes only: a stateful fake YouTube, a temp data dir. No real Google.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { createPostChain, createUploadQueue, reasonText, shownPublishAt } from '../services/posting/auto-chain.mjs';
import { AutoPostError, instagramWinnerCandidates, planAuto, validateRules } from '../services/posting/auto-post.mjs';
import { runHold } from '../services/posting/hold.mjs';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { CAPTIONS_SCOPE, READONLY_SCOPE } from '../services/posting/oauth.mjs';
import { createQuotaBudget } from '../services/posting/quota-budget.mjs';
import { scheduledCandidates } from '../services/posting/rewrite.mjs';
import { itemTimes } from '../services/posting/schedule.mjs';
import { scheduleManagerView } from '../services/posting/schedule-manager.mjs';

const NOW = Date.parse('2026-11-26T10:00:00Z');
const FUTURE = '2026-11-30T12:00:00Z';
const PAST = '2026-11-20T12:00:00Z';
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-hold-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

/** Ledger with one uploaded entry per spec { publishAt, privacy, account? }; the fake YouTube holds the same videos. */
function setup(specs) {
  const dataDir = mk(); mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  const entries = {}; const yt = { videos: {}, calls: [] }; const ids = [];
  specs.forEach((s, i) => {
    const sha = createHash('sha256').update(`v${i}`).digest('hex');
    const e = { sha256: sha, target: 'youtube-shorts', status: 'uploaded', dir: null, clipId: `c${i}`, createdAt: 'x', updatedAt: 'x', videoId: `vid${i}`, publishAt: s.publishAt, ...(s.account ? { account: s.account } : {}) };
    entries[`${sha}:youtube-shorts`] = e;
    ids.push(postId({ sha256: sha, target: 'youtube-shorts' }));
    yt.videos[`vid${i}`] = { privacyStatus: s.privacy ?? 'private', publishAt: s.remotePublishAt === undefined ? s.publishAt : s.remotePublishAt, embeddable: true, license: 'youtube', selfDeclaredMadeForKids: false };
  });
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries }));
  const q = createUploadQueue(path.join(dataDir, 'posting', 'upload-queue.json'));
  for (const [i, id] of ids.entries()) { q.add(id); q.patch(id, { state: 'done', videoId: `vid${i}`, sentPublishAt: specs[i].publishAt, account: 'main' }); }
  return { dataDir, yt, ids, store: createPostStore({ ledgerFile, dataDir }), queue: q };
}
const fakeFetch = (yt) => async (url, init) => {
  const u = new URL(url);
  yt.calls.push({ method: init.method, part: u.searchParams.get('part'), body: init.body ? JSON.parse(init.body) : null });
  const reply = (status, json) => ({ ok: status < 300, status, json: async () => json });
  if (init.method === 'GET') {
    const v = yt.videos[u.searchParams.get('id')];
    const { privacyStatus, publishAt, ...rest } = v ?? {};
    return reply(200, { items: v ? [{ snippet: { title: 't', categoryId: '20' }, status: { privacyStatus, ...(publishAt ? { publishAt } : {}), ...rest } }] : [] });
  }
  if (yt.quotaOnUpdate) return reply(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
  const b = JSON.parse(init.body);
  yt.videos[b.id] = { ...b.status }; // the whole status part is replaced: publishAt left out = no schedule
  return reply(200, { id: b.id });
};
const auth = { grantedScopes: async () => [CAPTIONS_SCOPE], accessToken: async () => 'tok' };
const budgetFor = (dataDir, over = {}) => createQuotaBudget({ dataDir, nowMs: () => NOW, quota: () => ({ quotaUnitsPerDay: 10000, perUploadUnits: 50, readReserveUnits: 100, updateUnits: 50, ...over }) });
const base = (e, extra = {}) => ({ dataDir: e.dataDir, store: e.store, auth, budget: budgetFor(e.dataDir), fetchImpl: fakeFetch(e.yt), nowMs: () => NOW, ...extra });
const heldAt = (e, i) => e.store.ledger.list().find((x) => x.videoId === `vid${i}`).heldAt;

describe('youtube hold', () => {
  test('clears publishAt only on private future-scheduled videos; keeps them private and the other status fields', async () => {
    const e = setup([{ publishAt: FUTURE }, { publishAt: FUTURE, privacy: 'public' }, { publishAt: PAST }, { publishAt: FUTURE }]);
    const r = await runHold(base(e));
    assert.deepEqual(r.held.sort(), [e.ids[0], e.ids[3]].sort());
    assert.deepEqual(r.skipped, [{ id: e.ids[1], why: 'not-private' }]);
    for (const i of [0, 3]) {
      assert.deepEqual(e.yt.videos[`vid${i}`], { privacyStatus: 'private', embeddable: true, license: 'youtube', selfDeclaredMadeForKids: false });
      assert.ok(heldAt(e, i)); assert.ok(e.queue.get(e.ids[i]).heldAt);
    }
    assert.equal(e.yt.videos.vid1.privacyStatus, 'public'); assert.equal(e.yt.videos.vid2.publishAt, PAST);
    const puts = e.yt.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2);
    for (const p of puts) { assert.equal(p.part, 'status'); assert.ok(!('publishAt' in p.body.status)); assert.ok(!('snippet' in p.body)); }
    assert.ok(!e.yt.calls.some((c) => c.body?.id === 'vid2'), 'a past one is not even read');
  });

  test('dry run: counts only, no call, no write', async () => {
    const e = setup([{ publishAt: FUTURE }, { publishAt: FUTURE }, { publishAt: PAST }]);
    const r = await runHold(base(e, { dryRun: true, auth: { grantedScopes: async () => { throw new Error('no'); }, accessToken: async () => { throw new Error('no'); } }, budget: null }));
    assert.equal(r.candidates, 2); assert.equal(e.yt.calls.length, 0);
    assert.ok(!heldAt(e, 0));
  });

  test('resumable: a second run does nothing; a video already off its schedule is only marked', async () => {
    const e = setup([{ publishAt: FUTURE }, { publishAt: FUTURE, remotePublishAt: null }]);
    const r = await runHold(base(e));
    assert.equal(r.held.length, 2);
    assert.equal(e.yt.calls.filter((c) => c.method === 'PUT').length, 1, 'the one already cleared needs no update');
    const n = e.yt.calls.length;
    const r2 = await runHold(base(e));
    assert.equal(r2.candidates, 0); assert.equal(e.yt.calls.length, n);
  });

  test('stops on the day quota before the reserve; the rest is left for another day', async () => {
    const e = setup([{ publishAt: FUTURE }, { publishAt: FUTURE }, { publishAt: FUTURE }]);
    const r = await runHold(base(e, { budget: budgetFor(e.dataDir, { quotaUnitsPerDay: 160 }) }));
    assert.equal(r.held.length, 1); assert.equal(r.stopped, 'quota-day-used'); assert.equal(r.left, 2);
  });

  test('YouTube quotaExceeded stops the run; nothing is marked', async () => {
    const e = setup([{ publishAt: FUTURE }, { publishAt: FUTURE }]);
    e.yt.quotaOnUpdate = true;
    const r = await runHold(base(e));
    assert.equal(r.stopped, 'quota-exceeded'); assert.equal(r.held.length, 0); assert.ok(!heldAt(e, 0));
  });

  test('an added channel\'s video is skipped; no scope refuses', async () => {
    const e = setup([{ publishAt: FUTURE, account: 'ch-abcdef' }]);
    assert.deepEqual((await runHold(base(e))).skipped, [{ id: e.ids[0], why: 'other-channel' }]);
    assert.deepEqual(await runHold(base(e, { auth: { grantedScopes: async () => [], accessToken: async () => 'tok' } })), { refused: 'scope-missing' });
  });

  test('held: not a rewrite candidate, its time is free, the manager shows it as held without a time', async () => {
    const e = setup([{ publishAt: FUTURE }]);
    await runHold(base(e));
    assert.equal(scheduledCandidates({ store: e.store, nowMs: NOW }).length, 0);
    const it = e.queue.get(e.ids[0]);
    assert.deepEqual(itemTimes(it), []); assert.equal(shownPublishAt(it), null);
    const v = scheduleManagerView(e.dataDir, { nowMs: NOW });
    const row = v.rows.find((x) => x.id === e.ids[0]);
    assert.equal(row.state, 'held'); assert.equal(row.stateText, 'Held for Instagram test'); assert.equal(row.at, null);
    assert.equal(row.reasonText, reasonText('held-instagram-test')); assert.equal(v.counts.held, 1);
  });
});

describe('youtubeSource instagram-winners', () => {
  test('rules: accepted, default unchanged, a bad value fails closed', () => {
    const r = { autoUpload: true, rules: [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 5 }] };
    assert.equal(validateRules(r).youtubeSource, undefined);
    assert.equal(validateRules({ ...r, youtubeSource: 'instagram-winners' }).youtubeSource, 'instagram-winners');
    assert.throws(() => validateRules({ ...r, youtubeSource: 'x' }), AutoPostError);
    assert.deepEqual(instagramWinnerCandidates({}), []);
  });

  test('planAuto approves but plans no YouTube upload', () => {
    const posts = [{ id: 'p1', target: 'youtube-shorts', status: 'draft', score: 9, kind: 'short' }];
    const rules = [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 5, kinds: ['short'] }];
    const plan = (src) => planAuto({ posts, rules, autoUpload: true, log: [], now: new Date(NOW), youtubeSource: src }).map((s) => s.action);
    assert.deepEqual(plan(null), ['approve', 'upload']);
    assert.deepEqual(plan('instagram-winners'), ['approve']);
  });

  test('the chain approves the clip but never queues or uploads it to YouTube', async () => {
    const dataDir = mk(); mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
    writeFileSync(path.join(dataDir, 'posting', 'schedule.json'), JSON.stringify({ placement: 'fill-gaps' }));
    const video = Buffer.from('video-a'.repeat(5)); const sha = createHash('sha256').update(video).digest('hex');
    const dir = path.join(mk(), 'posts', 'a', 'youtube-shorts'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'full-crop.mp4'), video);
    const stamp = '2026-11-26T09:00:00.000Z';
    writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ version: 1, title: 'T', description: 'D', tags: ['g'], hashtags: ['#Shorts'], target: 'youtube-shorts', privacy: 'private', status: 'draft',
      source: { run: 'run1', clipId: 'a', layout: 'full-crop', startSec: 1, endSec: 3, score: 9, sha256: sha }, video: { file: 'full-crop.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp }));
    const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${sha}:youtube-shorts`]: { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: 'a', createdAt: stamp, updatedAt: stamp } } }));
    mkdirSync(path.join(dataDir, 'clips'), { recursive: true }); writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: [] }));
    const rulesFile = path.join(dataDir, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ autoUpload: true, youtubeSource: 'instagram-winners', rules: [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 5 }] }));
    const calls = [];
    const c = createPostChain({ dataDir, flags: { isOn: (id) => id !== 'post-delete-uploaded' }, rulesFile, auth: { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'tok', grantedScopes: async () => [READONLY_SCOPE] },
      fetchImpl: async (u) => { calls.push(String(u)); throw new Error('no network in this test'); }, now: () => NOW, tickEveryMs: 0, profileFile: path.join(dataDir, 'none.json'), packageImpl: async () => ({ packaged: [], skipped: [] }) });
    await c.afterRun('x', { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }] });
    const id = postId({ sha256: sha, target: 'youtube-shorts' });
    assert.equal(createPostStore({ ledgerFile }).get(id).status, 'approved');
    assert.equal(createUploadQueue(path.join(dataDir, 'posting', 'upload-queue.json')).get(id), null);
    assert.equal(calls.length, 0);
    c.stop?.();
  });
});
