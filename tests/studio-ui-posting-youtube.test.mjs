// SPDX-License-Identifier: GPL-3.0-or-later
// F7: Posts view YouTube upload (D409: queued at the next free time, sent by the auto-post chain) + status check (flag `posting`). Fake auth and fake fetch only: nothing here touches
// Google, a browser or Credential Manager. Checks the Upload click (no typed phrase, D332), live refusal (fail closed), approved-only,
// no double upload, no token in any response, the status route, and the UI source rules.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { checkUploadStatus } from '../services/posting/youtube.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const TOKEN = 'SECRET-ACCESS-TOKEN-123'; // lint-allow: secret (a fake test token, not a credential)
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-f7-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json() { return JSON.parse(buf.toString('utf8')); } });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const VIDEO = Buffer.from('0123456789abcdefghij'.repeat(10));
const sha = createHash('sha256').update(VIDEO).digest('hex');

function makePackage(dataDir) {
  const dir = path.join(mk(), 'posts', 'c01', 'youtube-shorts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'full-crop.mp4'), VIDEO);
  const stamp = '2026-11-03T18:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: 'Test title', description: 'Test description', tags: ['gaming'], hashtags: ['#Shorts'], target: 'youtube-shorts',
    privacy: 'private', status: 'draft', source: { run: 'run', clipId: 'c01', layout: 'full-crop', startSec: 10, endSec: 12, sha256: sha },
    video: { file: 'full-crop.mp4', bytes: VIDEO.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${sha}:youtube-shorts`]: { sha256: sha, target: 'youtube-shorts', status: 'draft', dir, clipId: 'c01', createdAt: stamp, updatedAt: stamp } } }));
  return { dir, ledgerFile, id: postId({ sha256: sha, target: 'youtube-shorts' }) };
}

const jsonRes = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });

async function boot({ signedIn = true, sinks = [], outputsThrows = false, reauth = false, autoPost = true } = {}) {
  const dataDir = mk();
  const pkg = makePackage(dataDir);
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true, 'auto-post': autoPost } }));
  const calls = [];
  const fetchImpl = async (url, o) => {
    calls.push({ url: String(url), method: o?.method, auth: o?.headers?.Authorization });
    if (String(url).includes('uploadType=resumable')) return jsonRes(200, {}, { location: 'https://upload.example/s1' });
    if (url === 'https://upload.example/s1') return jsonRes(200, { id: 'VID123', status: { uploadStatus: 'uploaded' } });
    if (String(url).includes('/youtube/v3/videos')) return jsonRes(200, { items: [{ status: { uploadStatus: 'processed', privacyStatus: 'private' }, processingDetails: { processingStatus: 'succeeded' } }] });
    throw new Error(`unexpected ${url}`);
  };
  const auth = {
    status: async () => ({ signedIn, hasClient: true }),
    accessToken: async () => { if (reauth) throw Object.assign(new Error('x'), { code: 'oauth-reauth-needed' }); return TOKEN; },
  };
  const outputsStatus = async () => { if (outputsThrows) throw new Error('host down'); return { sinks }; };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, youtube: { auth, fetchImpl, outputsStatus } });
  const { port } = await srv.listen();
  const lr = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = lr.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  const csrf = s.json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  const get = (url) => raw(port, { url, headers: { cookie } });
  const approve = async () => assert.equal((await post('/ui/api/posts/status', { id: pkg.id, status: 'approved' })).status, 200);
  return { srv, port, post, get, approve, calls, dataDir, ...pkg, store: createPostStore({ ledgerFile: pkg.ledgerFile }) };
}
const UP = '/ui/api/posts/youtube/upload';
const queueItem = (c) => { try { return JSON.parse(readFileSync(path.join(c.dataDir, 'posting', 'upload-queue.json'), 'utf8')).items[c.id] ?? null; } catch { return null; } };
const markUploaded = (c) => { c.store.ledger.setStatus(sha, 'youtube-shorts', 'uploaded', '2026-11-03T19:00:00.000Z'); c.store.ledger.annotate(sha, 'youtube-shorts', { videoId: 'VID123' }); };

describe('youtube status route', () => {
  test('signed in / out, no token or secret in the answer', async () => {
    const c = await boot({ signedIn: true });
    try {
      const r = await c.get('/ui/api/posts/youtube/status');
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.json()).sort(), ['hasClient', 'signedIn'], 'no phrase (D332)');
      assert.equal(r.json().signedIn, true);
      assert.ok(!r.text.includes(TOKEN));
    } finally { c.srv.close(); }
    const d = await boot({ signedIn: false });
    try { assert.equal((await d.get('/ui/api/posts/youtube/status')).json().signedIn, false); } finally { d.srv.close(); }
  });
});

describe('youtube upload route', () => {
  test('refused while the post is a draft, with extra fields (an old phrase field too) and for an unknown post; no network call made', async () => {
    const c = await boot();
    try {
      let r = await c.post(UP, { id: c.id });
      assert.equal(r.status, 409); assert.equal(r.json().error, 'not-approved');
      await c.approve();
      r = await c.post(UP, { id: c.id, confirm: 'yes' });
      assert.equal(r.status, 400); assert.equal(r.json().error, 'bad-params', 'the body is { id } only (D332)');
      r = await c.post(UP, { id: c.id, extra: 1 });
      assert.equal(r.status, 400); assert.equal(r.json().error, 'bad-params');
      r = await c.post(UP, { id: 'nope' });
      assert.equal(r.status, 404);
      assert.equal(c.calls.length, 0);
    } finally { c.srv.close(); }
  });

  test('refused while a stream sink is live, and when the live check fails (fail closed)', async () => {
    for (const opts of [{ sinks: [{ kind: 'stream', id: 'yt', state: 'live' }] }, { sinks: [{ kind: 'stream', active: true }] }, { outputsThrows: true }]) {
      const c = await boot(opts);
      try {
        await c.approve();
        const r = await c.post(UP, { id: c.id });
        assert.equal(r.status, 409, JSON.stringify(opts)); assert.equal(r.json().error, 'stream-active');
        assert.equal(c.calls.length, 0);
        assert.equal(c.store.get(c.id).status, 'approved');
        assert.equal(queueItem(c), null, 'nothing queued');
      } finally { c.srv.close(); }
    }
  });

  test('D409 happy path: the click queues the clip at the next free time and asks for a pass; nothing is sent, no token in the answer', async () => {
    const c = await boot();
    try {
      await c.approve();
      const r = await c.post(UP, { id: c.id });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json().queued, true); assert.equal(r.json().privacy, 'private');
      assert.ok(Date.parse(r.json().publishAt) > Date.now(), 'a publish time ahead');
      assert.ok(!r.text.includes(TOKEN));
      assert.equal(c.calls.length, 0, 'nothing reached YouTube from the route');
      const it = queueItem(c);
      assert.equal(it.state, 'queued'); assert.equal(it.publishAt, r.json().publishAt);
      assert.equal(c.store.get(c.id).status, 'approved', 'not uploaded by the route');
      // Uploaded later (by the chain): a second click is refused.
      markUploaded(c);
      const again = await c.post(UP, { id: c.id });
      assert.equal(again.status, 409); assert.equal(again.json().error, 'already-uploaded');
    } finally { c.srv.close(); }
  });

  test('D409: with auto-post off the click is refused (nothing would send it); no sign-in is asked for', async () => {
    const c = await boot({ autoPost: false, reauth: true });
    try {
      await c.approve();
      const r = await c.post(UP, { id: c.id });
      assert.equal(r.status, 409); assert.equal(r.json().error, 'auto-post-off');
      assert.equal(c.calls.length, 0); assert.equal(queueItem(c), null);
    } finally { c.srv.close(); }
  });
});

describe('youtube check route', () => {
  test('not uploaded -> 409; uploaded -> processing status; unknown -> 404', async () => {
    const c = await boot();
    try {
      await c.approve();
      let r = await c.post('/ui/api/posts/youtube/check', { id: c.id });
      assert.equal(r.status, 409); assert.equal(r.json().error, 'not-uploaded');
      markUploaded(c); // D409: the auto-post chain uploads; here the ledger says it did
      r = await c.post('/ui/api/posts/youtube/check', { id: c.id });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json(), { videoId: 'VID123', found: true, uploadStatus: 'processed', processingStatus: 'succeeded', privacyStatus: 'private', failureReason: null, rejectionReason: null });
      assert.ok(!r.text.includes(TOKEN));
      assert.equal((await c.post('/ui/api/posts/youtube/check', { id: 'zzz' })).status, 404);
    } finally { c.srv.close(); }
  });
});

describe('checkUploadStatus (fake fetch)', () => {
  test('found, not found, 403 and 500', async () => {
    const mkf = (res) => async (url, o) => {
      assert.match(String(url), /youtube\/v3\/videos\?part=status,processingDetails&id=ABC/);
      assert.equal(o.headers.Authorization, 'Bearer t');
      return res;
    };
    const ok = await checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(200, { items: [{ status: { uploadStatus: 'rejected', rejectionReason: 'duplicate' } }] })) });
    assert.equal(ok.found, true); assert.equal(ok.rejectionReason, 'duplicate');
    assert.equal((await checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(200, { items: [] })) })).found, false);
    await assert.rejects(checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(403, {})) }), { code: 'status-not-permitted' });
    await assert.rejects(checkUploadStatus({ videoId: 'ABC', accessToken: 't', fetchImpl: mkf(jsonRes(500, {})) }), { code: 'status-check-failed' });
  });
});

describe('D409-4: request deadlines cover the body; chunk deadline by size; progress after a timeout uses no try', () => {
  test('checkUploadStatus: a hung request and a hung body both end at the deadline', async () => {
    const hangReq = () => new Promise(() => {});
    await assert.rejects(checkUploadStatus({ videoId: 'A', accessToken: 't', fetchImpl: hangReq, requestMs: 80 }), { code: 'request-timeout' });
    const hangBody = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: () => new Promise(() => {}) });
    const t = Date.now();
    await assert.rejects(checkUploadStatus({ videoId: 'A', accessToken: 't', fetchImpl: hangBody, requestMs: 80 }), { code: 'request-timeout' });
    assert.ok(Date.now() - t < 3000);
  });

  test('chunkTimeoutMs grows with the chunk size at the floor speed (the slower of floor and measured), plus REQUEST_MS', async () => {
    const { chunkTimeoutMs, REQUEST_MS } = await import('../services/posting/youtube.mjs');
    const floor = (1000 * 1000) / 8; // fallbackKbps 1000
    assert.equal(chunkTimeoutMs(8 * 1024 * 1024, floor), Math.ceil((8 * 1024 * 1024 / floor) * 1000) + REQUEST_MS);
    assert.ok(chunkTimeoutMs(16 * 1024 * 1024, floor) > chunkTimeoutMs(8 * 1024 * 1024, floor));
    assert.ok(chunkTimeoutMs(1024, floor, floor / 10) > chunkTimeoutMs(1024, floor), 'a slower measured speed gives more time');
    assert.equal(chunkTimeoutMs(1024, floor, floor * 10), chunkTimeoutMs(1024, floor), 'a faster measured speed never shortens it below the floor');
  });

  test('a chunk past its deadline with measured progress resumes from Google\'s count (no try used); without progress it waits', async () => {
    const { uploadVideo } = await import('../services/posting/youtube.mjs');
    const d = mk(); const file = path.join(d, 'v.mp4'); writeFileSync(file, VIDEO);
    const post = { status: 'approved', target: 'youtube-shorts', title: 'T', description: 'D', tags: [], hashtags: [], unresolved: [], source: { sha256: sha } };
    const mkFake = (progressOnTimeout) => {
      let received = 0; let hung = 0; const calls = [];
      const fetchImpl = async (u, o) => {
        if (String(u).includes('uploadType=resumable')) { calls.push('init'); return jsonRes(200, {}, { location: 'https://upload.example/session/1' }); }
        const cr = String(o?.headers?.['Content-Range'] ?? '');
        if (cr.startsWith('bytes */')) { calls.push('query'); return received ? jsonRes(308, null, { range: `bytes=0-${received - 1}` }) : jsonRes(308, null); }
        calls.push('chunk');
        const [, a] = /bytes (\d+)-/.exec(cr);
        if (Number(a) === 0 && hung < 3) { hung++; if (progressOnTimeout) received = 100; return new Promise(() => {}); } // part arrived, then the answer hung
        received = VIDEO.length;
        return jsonRes(200, { id: 'VID1', status: { uploadStatus: 'uploaded' } });
      };
      return { fetchImpl, calls };
    };
    const base = { post, sha256: sha, videoPath: file, accessToken: 't', ledger: { get: () => null, put() {}, setStatus() {} }, limits: { targets: { 'youtube-shorts': { fields: {} } } },
      outputsStatus: async () => ({ sinks: [] }), publishAt: '2099-01-01T00:00:00.000Z', chunkSize: VIDEO.length, chunkRequestMs: 80, requestMs: 1000 };
    const ok = mkFake(true);
    const r = await uploadVideo({ ...base, fetchImpl: ok.fetchImpl });
    assert.equal(r.videoId, 'VID1');
    assert.deepEqual(ok.calls, ['init', 'chunk', 'query', 'chunk'], 'resumed from byte 100 after the timeout, no retry wait');
    const none = mkFake(false);
    await assert.rejects(uploadVideo({ ...base, fetchImpl: none.fetchImpl }), { code: 'request-timeout' });
    assert.deepEqual(none.calls, ['init', 'chunk', 'query'], 'no progress: stops for this pass (the item waits, no attempt)');
  });
});

describe('UI source rules', () => {
  test('no innerHTML, no external script, upload button present, no typed confirmation (D332)', () => {
    const js = readFileSync(path.join(UI, 'js', 'app.js'), 'utf8') + readFileSync(path.join(UI, 'js', 'api.js'), 'utf8');
    const html = readFileSync(path.join(UI, 'index.html'), 'utf8');
    assert.ok(!/innerHTML/.test(js));
    assert.ok(!/<script[^>]+src="https?:/.test(html));
    assert.match(html, /id="post-yt-upload"/);
    assert.doesNotMatch(html, /id="post-yt-confirm"/);
  });
});
