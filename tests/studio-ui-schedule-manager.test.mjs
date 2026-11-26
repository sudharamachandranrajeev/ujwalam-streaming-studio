// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduling manager routes (SM1-SM4, plan 2026-11-25-scheduling-manager.md): the flat schedule list (YouTube queue,
// Instagram queue, the channel's own times), the brief answers for the Settings line, and the Instagram "Post now" / Retry
// route (refused while live). Move, Remove and Retry for YouTube reuse the existing routes. Fakes only: temp dirs, no network.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { IG_QUEUE_NAME, createInstagramQueue } from '../services/posting/instagram-queue.mjs';
import { postId } from '../services/posting/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const NOW = Date.parse('2026-11-13T10:00:00Z');
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-sm-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, text: buf.toString('utf8'), headers: res.headers, json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function makePost(name, kind, target = 'youtube-shorts') {
  const video = Buffer.from(`${name}`.repeat(10));
  const sha = createHash('sha256').update(video).digest('hex');
  const dir = path.join(mk(), 'posts', name, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'v.mp4'), video);
  const stamp = '2026-11-08T09:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: `Title ${name}`, description: 'D', tags: ['g'], hashtags: ['#Shorts'], target, privacy: 'private', status: 'approved',
    source: { run: 'run1', clipId: name, kind, layout: 'v', startSec: 0, endSec: 30, score: null, sha256: sha },
    video: { file: 'v.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  return { key: `${sha}:${target}`, entry: { sha256: sha, target, status: 'approved', dir, clipId: name, createdAt: stamp, updatedAt: stamp }, id: postId({ sha256: sha, target }) };
}

async function boot({ sinks = [] } = {}) {
  const dataDir = mk();
  const a = makePost('clip-a', 'short'); const b = makePost('clip-b', 'montage'); const c = makePost('clip-c', 'long-highlights', 'youtube-video');
  const d = makePost('clip-d', 'short'); const e = makePost('clip-e', 'short');
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  writeFileSync(path.join(dataDir, 'posting', 'ledger.json'), JSON.stringify({ version: 1, entries: Object.fromEntries([a, b, c, d, e].map((x) => [x.key, x.entry])) }));
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
  const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => NOW);
  for (const x of [a, b, c, d]) q.add(x.id);
  q.patch(a.id, { publishAt: '2026-11-14T12:00:00.000Z' });
  q.patch(b.id, { publishAt: '2026-11-14T15:00:00.000Z', state: 'failed', reason: 'upload-failed' });
  q.patch(c.id, { publishAt: '2026-11-15T09:00:00.000Z', state: 'done', sentPublishAt: '2026-11-15T09:00:00.000Z' });
  q.patch(d.id, { publishAt: '2026-11-01T09:00:00.000Z', state: 'done', sentPublishAt: '2026-11-01T09:00:00.000Z' }); // already public: not listed
  const ig = createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME), () => NOW);
  ig.add(a.id, '2026-11-14T13:00:00.000Z'); ig.add(e.id, '2026-11-14T14:00:00.000Z'); ig.patch(e.id, { state: 'failed', reason: 'limit-reached' });
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, now: () => NOW,
    youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, outputsStatus: async () => ({ sinks }) } });
  const { port } = await srv.listen();
  const lr = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = lr.headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  const get = (url) => raw(port, { url, headers: { cookie } });
  return { srv, post, get, dataDir, ids: { a: a.id, b: b.id, c: c.id, d: d.id, e: e.id }, ig: () => createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME)) };
}
const IGNOW = '/ui/api/posts/schedule/instagram-now';

describe('scheduling manager list', () => {
  test('one flat list: target, clip name, plain state, what each row can do; public clips are not listed', async () => {
    const t = await boot();
    try {
      const r = (await t.get('/ui/api/posts/schedule/list')).json();
      const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
      assert.deepEqual(Object.keys(by).sort(), [`ig:${t.ids.a}`, `ig:${t.ids.e}`, `yt:${t.ids.a}`, `yt:${t.ids.b}`, `yt:${t.ids.c}`].sort());
      const a = by[`yt:${t.ids.a}`];
      assert.deepEqual([a.target, a.title, a.state, a.stateText, a.movable, a.removable, a.postable, a.retryable, a.channel], ['youtube-shorts', 'Title clip-a', 'waiting', 'Waiting to upload', true, true, true, false, '']);
      const b = by[`yt:${t.ids.b}`];
      assert.deepEqual([b.state, b.retryable, b.removable, b.movable, b.postable], ['failed', true, true, false, false]);
      assert.match(b.reasonText, /Upload failed \(upload-failed\)/);
      const c = by[`yt:${t.ids.c}`];
      assert.deepEqual([c.target, c.state, c.movable, c.removable], ['youtube-video', 'scheduled', false, false]);
      const i = by[`ig:${t.ids.a}`];
      assert.deepEqual([i.target, i.state, i.at, i.postable, i.movable, i.removable], ['instagram-reels', 'waiting', '2026-11-14T13:00:00.000Z', true, false, false]);
      const f = by[`ig:${t.ids.e}`];
      assert.deepEqual([f.state, f.retryable], ['failed', true]);
      assert.match(f.reasonText, /24 hours/);
      assert.deepEqual([r.counts.waiting, r.counts.failed, r.counts.scheduled, r.counts.total], [2, 2, 1, 5]);
      assert.equal(r.nextAt, '2026-11-14T12:00:00.000Z');
    } finally { t.srv.close(); }
  });
  test('brief answers carry counts and the next time, no rows (the Settings line)', async () => {
    const t = await boot();
    try {
      const l = (await t.get('/ui/api/posts/schedule/list?brief=1')).json();
      assert.equal(l.rows, undefined); assert.equal(l.counts.total, 5);
      const s = (await t.get('/ui/api/posts/auto/schedule?brief=1&count=0')).json();
      assert.equal(s.queue, undefined); assert.equal(s.queueCount, 2); assert.equal(s.nextAt, '2026-11-14T12:00:00.000Z');
    } finally { t.srv.close(); }
  });
});

describe('Instagram Post now / Retry', () => {
  test('a waiting job is due now; a failed one is tried again; nothing else changes', async () => {
    const t = await boot();
    try {
      const r = await t.post(IGNOW, { id: t.ids.e });
      assert.equal(r.status, 200, r.text);
      const it = t.ig().get(t.ids.e);
      assert.deepEqual([it.state, it.attempts, it.reason, it.dueAt], ['waiting', 0, null, new Date(NOW).toISOString()]);
      assert.equal(t.ig().get(t.ids.a).dueAt, '2026-11-14T13:00:00.000Z', 'the other job keeps its time');
    } finally { t.srv.close(); }
  });
  test('refused while a stream is live; unknown, bad bodies refused; nothing changes', async () => {
    const t = await boot({ sinks: [{ kind: 'stream', id: 'yt', state: 'live' }] });
    try {
      const r = await t.post(IGNOW, { id: t.ids.e });
      assert.equal(r.status, 409); assert.equal(r.json().error, 'stream-live');
      assert.equal(t.ig().get(t.ids.e).state, 'failed');
      assert.equal((await t.post(IGNOW, { id: 'nope' })).status, 404);
      assert.equal((await t.post(IGNOW, { id: t.ids.e, x: 1 })).status, 400);
      assert.equal((await t.post(IGNOW, {})).status, 400);
    } finally { t.srv.close(); }
  });
});
