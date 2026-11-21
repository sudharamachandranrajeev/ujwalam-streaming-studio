// SPDX-License-Identifier: GPL-3.0-or-later
// PT3 (D408): "Run auto-post now" (refused while live or starting), and the per-clip actions "Schedule next free slot" and
// "Upload now" (D409: queued at the next free time; "Post now (public)" was removed). Temp data dirs, fake host, fake auth and fake fetch only: nothing reaches Google.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QUEUE_NAME, RUN_NOW_NAME, createPostChain, createUploadQueue, requestRunNow } from '../services/posting/auto-chain.mjs';
import { READONLY_SCOPE } from '../services/posting/oauth.mjs';
import { scheduleNextFree } from '../services/posting/auto-settings.mjs';
import { postId } from '../services/posting/index.mjs';
import { uploadMetadata, uploadPost, uploadVideo } from '../services/posting/youtube.mjs';
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
  // The fake channel (D409 fresh read before Post now): `channel.scheduled` = future publish times; `channel.error` =
  // HTTP status of channels.list; `channel.pages` = how many pages of 50 uploads the list has (more than maxPages =
  // incomplete).
  const channel = { scheduled: [], error: null, pages: 1, initFail: false };
  const fetchImpl = async (url, o) => {
    calls.push({ url: String(url), body: typeof o?.body === 'string' ? o.body : null });
    const u = new URL(String(url));
    if (u.pathname.endsWith('/youtube/v3/channels')) return channel.error ? jsonRes(channel.error, { error: { code: channel.error } }) : jsonRes(200, { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUx' } } }] });
    if (u.pathname.endsWith('/youtube/v3/playlistItems')) {
      const p = Number(u.searchParams.get('pageToken') ?? 0);
      const ids = p === 0 ? channel.scheduled.map((_, k) => `sch${k}`) : [`old${p}`];
      return jsonRes(200, { items: ids.map((v) => ({ snippet: { publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { videoId: v, ...(v.startsWith('sch') ? {} : { videoPublishedAt: '2026-01-01T00:00:00Z' }) } })), ...(p + 1 < channel.pages ? { nextPageToken: String(p + 1) } : {}) });
    }
    if (u.pathname.endsWith('/youtube/v3/videos') && (o?.method ?? 'GET') === 'GET') {
      const ids = u.searchParams.get('id').split(',');
      return jsonRes(200, { items: ids.map((v) => (v.startsWith('sch') ? { id: v, status: { privacyStatus: 'private', publishAt: new Date(channel.scheduled[Number(v.slice(3))]).toISOString() } } : { id: v, status: { privacyStatus: 'public' } })) });
    }
    if (String(url).includes('uploadType=resumable')) return channel.initFail ? jsonRes(500, { error: { code: 500 } }) : jsonRes(200, {}, { location: 'https://upload.example/s1' });
    if (url === 'https://upload.example/s1') return jsonRes(200, { id: 'VIDPUB', status: { uploadStatus: 'uploaded' } });
    throw new Error(`unexpected ${url}`);
  };
  const auth = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-token', grantedScopes: async () => [READONLY_SCOPE] };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), now: () => T0,
    youtube: { auth, fetchImpl, outputsStatus: async () => ({ sinks }), lockOpts: { waitMs: 100 } } });
  const { port } = await srv.listen();
  const cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  return { srv, dataDir, id, calls, channel, post, queue: createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => T0) };
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

describe('D409 Upload now: queued at the next free time; no video is ever sent without a publish time', () => {
  const sentInit = (c) => c.calls.some((x) => x.url.includes('uploadType=resumable'));

  test('the Upload click queues the approved clip at the next free time and asks for a pass; nothing is sent from the route', async () => {
    const c = await boot();
    assert.equal((await c.post('/ui/api/posts/youtube/upload', { id: c.id })).json().error, 'not-approved');
    assert.equal((await c.post('/ui/api/posts/status', { id: c.id, status: 'approved' })).status, 200);
    c.queue.add('other'); c.queue.patch('other', { publishAt: new Date(T0 + 2 * HOUR).toISOString() });
    const r = await c.post('/ui/api/posts/youtube/upload', { id: c.id });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json().queued, true); assert.equal(r.json().privacy, 'private');
    const at = Date.parse(r.json().publishAt);
    assert.ok(at > T0 && Math.abs(at - (T0 + 2 * HOUR)) >= HOUR, r.json().publishAt);
    assert.equal(c.queue.get(c.id).state, 'queued'); assert.equal(c.queue.get(c.id).publishAt, r.json().publishAt);
    assert.equal(existsSync(path.join(c.dataDir, 'posting', RUN_NOW_NAME)), true, 'a pass is asked for at once');
    assert.equal(c.calls.length, 0, 'nothing reached YouTube from the route');
    closeAll(c);
  });

  test('the Upload click is refused while live or starting and with auto-post off (nothing queued, nothing sent)', async () => {
    for (const state of ['live', 'starting']) {
      const c = await boot({ sinks: [{ kind: 'stream', id: 'yt', state }] });
      await c.post('/ui/api/posts/status', { id: c.id, status: 'approved' });
      const r = await c.post('/ui/api/posts/youtube/upload', { id: c.id });
      assert.equal(r.status, 409, state); assert.equal(r.json().error, 'stream-active');
      assert.equal(c.queue.get(c.id), null); assert.equal(c.calls.length, 0);
      closeAll(c);
    }
    const off = await boot({ flags: { posting: true } });
    await off.post('/ui/api/posts/status', { id: off.id, status: 'approved' });
    assert.equal((await off.post('/ui/api/posts/youtube/upload', { id: off.id })).json().error, 'auto-post-off');
    assert.equal(off.queue.get(off.id), null);
    closeAll(off);
  });

  test('"Post now (public)" is gone: the route answers no upload, the window has no button, no public state is left', async () => {
    const c = await boot();
    await c.post('/ui/api/posts/status', { id: c.id, status: 'approved' });
    const r = await c.post('/ui/api/posts/youtube/public-now', { id: c.id });
    assert.notEqual(r.status, 200); assert.equal(sentInit(c), false); assert.equal(c.queue.get(c.id), null);
    closeAll(c);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const qml = readFileSync(path.join(root, 'app', 'studio', 'qml', 'PostsWindow.qml'), 'utf8');
    assert.ok(!/postsPublicNow|public-now|canPublicNow/.test(qml));
    for (const f of ['auto-chain.mjs', 'auto-settings.mjs', 'youtube.mjs']) {
      const src = readFileSync(path.join(root, 'services', 'posting', f), 'utf8');
      assert.ok(!/reservePublicNow|finishPublicNow|public-uploading|public-done|publicNow/.test(src), f);
    }
    assert.ok(!/public-now|reservePublicNow/.test(readFileSync(path.join(root, 'services', 'studio-ui', 'server.mjs'), 'utf8')));
  });

  test('uploadPost and uploadVideo refuse a missing publish time for every caller, before any request', async () => {
    let fetched = 0;
    const fetchImpl = async () => { fetched++; throw new Error('must not be called'); };
    const store = { dir: () => { throw new Error('must not be read'); }, media: () => null };
    const auth = { accessToken: async () => { throw new Error('must not ask for a token'); } };
    for (const publishAt of [undefined, null, '']) {
      await assert.rejects(uploadPost({ id: 'x', store, auth, fetchImpl, outputsStatus: async () => ({ sinks: [] }), publishAt }), { code: 'publish-at-required' });
      await assert.rejects(uploadVideo({ post: { status: 'approved' }, sha256: 's', videoPath: 'none', accessToken: 't', ledger: {}, fetchImpl, outputsStatus: async () => ({ sinks: [] }), publishAt }), { code: 'publish-at-required' });
    }
    assert.equal(fetched, 0);
    // The metadata is always private (no public option any more; post.json never decides).
    assert.equal(uploadMetadata({ title: 't' }).status.privacyStatus, 'private');
    assert.equal(uploadMetadata({ title: 't', privacy: 'public' }, { publicNow: true }).status.privacyStatus, 'private');
    // Every caller: in services/, uploadPost is called only by the auto-post chain's gated send (sendGated).
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'services');
    const callers = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.mjs') && /\buploadPost\(/.test(readFileSync(p, 'utf8'))) callers.push(path.relative(root, p).replaceAll('\\', '/')); } };
    walk(root);
    assert.deepEqual(callers.sort(), ['posting/auto-chain.mjs', 'posting/youtube.mjs']);
    const chain = readFileSync(path.join(root, 'posting', 'auto-chain.mjs'), 'utf8');
    assert.match(chain, /sendGated\(\{[^]*?send: \(\) => uploadPost\(\{[^}]*publishAt,/);
  });
});
