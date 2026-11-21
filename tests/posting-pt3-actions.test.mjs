// SPDX-License-Identifier: GPL-3.0-or-later
// PT3 (D408): "Run auto-post now" (refused while live or starting), and the per-clip actions "Schedule next free slot" and
// "Post now (public)". Temp data dirs, fake host, fake auth and fake fetch only: nothing reaches Google.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QUEUE_NAME, RUN_NOW_NAME, createPostChain, createUploadQueue, requestRunNow } from '../services/posting/auto-chain.mjs';
import { publicNowClash, scheduleNextFree } from '../services/posting/auto-settings.mjs';
import { postId } from '../services/posting/index.mjs';
import { uploadMetadata } from '../services/posting/youtube.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const HOUR = 3600e3;
const T0 = Date.parse('2026-11-21T10:00:00Z');
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pt3-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject); req.end(body);
  });
}

const VIDEO = Buffer.from('0123456789abcdefghij'.repeat(10));
const sha = createHash('sha256').update(VIDEO).digest('hex');
function makePackage(dataDir) {
  const dir = path.join(mk(), 'posts', 'c01', 'youtube-shorts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'full-crop.mp4'), VIDEO);
  const stamp = '2026-11-21T08:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: 'Test title', description: 'Test description', tags: ['gaming'], hashtags: ['#Shorts'], target: 'youtube-shorts',
    privacy: 'private', status: 'draft', source: { run: 'run', clipId: 'c01', layout: 'full-crop', startSec: 10, endSec: 12, sha256: sha },
    video: { file: 'full-crop.mp4', bytes: VIDEO.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${sha}:youtube-shorts`]: { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: 'c01', createdAt: stamp, updatedAt: stamp } } }));
  return postId({ sha256: sha, target: 'youtube-shorts' });
}
const jsonRes = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body, text: async () => JSON.stringify(body) });

async function boot({ sinks = [], flags = { posting: true, 'auto-post': true } } = {}) {
  const dataDir = mk();
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  writeFileSync(path.join(dataDir, 'posting', 'schedule.json'), JSON.stringify({ placement: 'fill-gaps' }));
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
  const id = makePackage(dataDir);
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url: String(url), body: typeof o?.body === 'string' ? o.body : null });
    if (String(url).includes('uploadType=resumable')) return jsonRes(200, {}, { location: 'https://upload.example/s1' });
    if (url === 'https://upload.example/s1') return jsonRes(200, { id: 'VIDPUB', status: { uploadStatus: 'uploaded' } });
    throw new Error(`unexpected ${url}`);
  };
  const auth = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-token' };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), now: () => T0,
    youtube: { auth, fetchImpl, outputsStatus: async () => ({ sinks }) } });
  const { port } = await srv.listen();
  const cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  return { srv, dataDir, id, calls, post, queue: createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => T0) };
}
// the after() above removes folders; servers close here
const closeAll = (...c) => { for (const x of c) x.srv.close(); };

describe('PT3 Run auto-post now', () => {
  test('refused while a stream is live or starting, and with auto-post off; otherwise the request file is written', async () => {
    for (const state of ['live', 'starting']) {
      const c = await boot({ sinks: [{ kind: 'stream', id: 'yt', state }] });
      const r = await c.post('/ui/api/posts/auto/run', {});
      assert.equal(r.status, 409, state); assert.equal(r.json().error, 'stream-live');
      assert.equal(existsSync(path.join(c.dataDir, 'posting', RUN_NOW_NAME)), false);
      closeAll(c);
    }
    const off = await boot({ flags: { posting: true } });
    assert.equal((await off.post('/ui/api/posts/auto/run', {})).json().error, 'auto-post-off');
    const c = await boot();
    assert.equal((await c.post('/ui/api/posts/auto/run', { x: 1 })).status, 400);
    const r = await c.post('/ui/api/posts/auto/run', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(existsSync(path.join(c.dataDir, 'posting', RUN_NOW_NAME)), true);
    closeAll(off, c);
  });

  test('the chain takes the request on its next tick, without waiting for the throttle', async () => {
    const dataDir = mk();
    writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: {} }));
    let t = T0;
    const chain = createPostChain({ dataDir, now: () => t, scanFolder: false, tickEveryMs: 10 * 60e3 });
    assert.notEqual((await chain.tick({ sinks: [] })).skipped, 'throttled'); // the first tick runs (flag off here)
    t += 1000;
    assert.equal((await chain.tick({ sinks: [] })).skipped, 'throttled');
    requestRunNow(dataDir, t);
    const r = await chain.tick({ sinks: [] });
    assert.notEqual(r.skipped, 'throttled');
    assert.equal(existsSync(path.join(dataDir, 'posting', RUN_NOW_NAME)), false, 'taken');
  });
});

describe('PT3 Schedule next free slot', () => {
  test('approves the clip and queues it at the next free time, an hour or more from every other post', async () => {
    const c = await boot();
    c.queue.add('other'); c.queue.patch('other', { publishAt: new Date(T0 + 4 * HOUR).toISOString() });
    const r = await c.post('/ui/api/posts/schedule-next', { id: c.id });
    assert.equal(r.status, 200, r.text);
    const at = Date.parse(r.json().publishAt);
    assert.ok(at > T0 && Math.abs(at - (T0 + 4 * HOUR)) >= HOUR, r.json().publishAt);
    const it = c.queue.get(c.id);
    assert.equal(it.state, 'queued'); assert.equal(it.publishAt, r.json().publishAt);
    assert.equal(c.calls.length, 0, 'nothing is sent');
    // A second click finds it queued and gives it a time again (still free); an uploaded clip is refused.
    assert.equal((await c.post('/ui/api/posts/schedule-next', { id: c.id })).status, 200);
    c.queue.patch(c.id, { state: 'done' });
    assert.equal((await c.post('/ui/api/posts/schedule-next', { id: c.id })).status, 409);
    closeAll(c);
  });

  test('pure helper: no free time is said plainly', () => {
    const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
    writeFileSync(path.join(d, 'posting', 'schedule.json'), JSON.stringify({ placement: 'fill-gaps', maxAheadDays: 1 }));
    const q = createUploadQueue(path.join(d, 'posting', QUEUE_NAME), () => T0);
    for (let k = 0; k < 40; k++) { q.add(`x${k}`); q.patch(`x${k}`, { publishAt: new Date(T0 + k * HOUR).toISOString() }); }
    const r = scheduleNextFree(d, 'new', { nowMs: T0 });
    assert.equal(r.ok, false); assert.equal(r.code, 'no-free-slot');
  });
});

describe('PT3 Post now (public)', () => {
  test('metadata: public only from the click, never with a publish time; private stays the default', () => {
    assert.equal(uploadMetadata({ title: 't' }).status.privacyStatus, 'private');
    assert.equal(uploadMetadata({ title: 't', privacy: 'public' }).status.privacyStatus, 'private', 'post.json never decides');
    assert.equal(uploadMetadata({ title: 't' }, { publicNow: true }).status.privacyStatus, 'public');
    assert.throws(() => uploadMetadata({ title: 't' }, { publicNow: true, publishAt: '2026-11-22T10:00:00Z' }), { code: 'bad-privacy' });
  });

  test('refused for a draft, while live or starting, and within 60 min of another post; else uploads as public (fake fetch)', async () => {
    let c = await boot();
    assert.equal((await c.post('/ui/api/posts/youtube/public-now', { id: c.id })).json().error, 'not-approved');
    assert.equal((await c.post('/ui/api/posts/status', { id: c.id, status: 'approved' })).status, 200);
    c.queue.add('other'); c.queue.patch('other', { publishAt: new Date(T0 + 50 * 60e3).toISOString() });
    let r = await c.post('/ui/api/posts/youtube/public-now', { id: c.id });
    assert.equal(r.status, 409); assert.equal(r.json().error, 'too-close');
    assert.equal(publicNowClash(c.dataDir, c.id, { nowMs: T0 }), T0 + 50 * 60e3);
    c.queue.patch('other', { publishAt: new Date(T0 + 61 * 60e3).toISOString() });
    r = await c.post('/ui/api/posts/youtube/public-now', { id: c.id });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json(), { videoId: 'VIDPUB', uploadStatus: 'uploaded', thumbnailOk: null, privacy: 'public' });
    const init = c.calls.find((x) => x.url.includes('uploadType=resumable'));
    assert.equal(JSON.parse(init.body).status.privacyStatus, 'public');
    assert.equal(JSON.parse(init.body).status.publishAt, undefined);
    closeAll(c);
    for (const state of ['live', 'starting']) {
      c = await boot({ sinks: [{ kind: 'stream', id: 'yt', state }] });
      await c.post('/ui/api/posts/status', { id: c.id, status: 'approved' });
      r = await c.post('/ui/api/posts/youtube/public-now', { id: c.id });
      assert.equal(r.status, 409, state); assert.equal(c.calls.length, 0);
      closeAll(c);
    }
  });
});
