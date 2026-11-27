// SPDX-License-Identifier: GPL-3.0-or-later
// D444 IP1: Instagram Reels publishing against an in-process fake Graph + rupload server (127.0.0.1). Never Meta.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InstagramError, createInstagramAuth, dialogUrl, loadIgConfig, pickAccount, publishReel, reelCaption, safeUrl } from '../services/posting/instagram.mjs';
import { loadLimits } from '../services/posting/index.mjs';

const cfg = { ...loadIgConfig(), pollEveryMs: 100, pollMaxMs: 5000 };
const memStore = (v = null) => { let x = v; return { get: async () => x, set: async (s) => { x = s; }, delete: async () => { x = null; }, peek: () => x }; };

/** Fake Graph: records every request; `script` decides answers. */
async function fakeMeta(script = {}) {
  const log = [];
  let polls = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://127.0.0.1');
      const form = Object.fromEntries(new URLSearchParams(req.headers['content-type'] === 'application/x-www-form-urlencoded' ? body.toString() : ''));
      log.push({ method: req.method, path: u.pathname, q: Object.fromEntries(u.searchParams), form, headers: req.headers, bytes: body.length, body });
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      const p = u.pathname;
      if (script.httpFail) return send(500, { error: { code: 2, message: 'temporary' } });
      if (script.expired) return send(400, { error: { code: 190, message: 'expired' } });
      if (p.endsWith('/oauth/access_token')) return send(200, u.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: `LL-${log.length}`, expires_in: 5184000 } : { access_token: 'SHORT' });
      if (p.endsWith('/me/accounts') && script.pages) return send(200, { data: script.pages });
      if (p.endsWith('/me/businesses')) return send(200, { data: script.businesses ?? [] });
      if (p.endsWith('/me/permissions')) return send(200, { data: (script.granted ?? cfg.scopes).map((s) => ({ permission: s, status: 'granted' })) });
      if (p.endsWith('/me/accounts')) return send(200, { data: [{ name: 'Page A' }, { name: 'Page B', instagram_business_account: { id: '1784000000', username: 'placeholder_account' } }] });
      if (p.endsWith('/content_publishing_limit')) return send(200, { data: [{ quota_usage: script.used ?? 3, config: { quota_total: 100, quota_duration: 86400 } }] });
      if (p.endsWith('/1784000000/media') && req.method === 'POST') return send(200, { id: '9990001', uri: 'https://rupload.facebook.com/ig-api-upload/x/9990001' });
      if (p.startsWith('/ig-api-upload/')) return send(200, { success: true, message: 'Upload successful.' });
      if (p.endsWith('/9990001') && req.method === 'GET') {
        polls++;
        if (script.resumeOnly && polls > 1) return send(200, { status_code: 'FINISHED' });
        if (script.statusFail) return send(script.statusFail, { error: { code: script.statusCode ?? 2 } });
        return send(200, { status_code: script.status ?? (polls < 2 ? 'IN_PROGRESS' : 'FINISHED') });
      }
      if (p.endsWith('/media_publish')) return send(200, { id: '1800000000001' });
      return send(404, { error: { code: 100 } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { log, endpoints: { graph: origin, dialog: origin, rupload: origin }, close: () => new Promise((r) => server.close(r)) };
}

const tokenJson = (over = {}) => JSON.stringify({ token: 'TOKEN-A', expiresAt: Date.now() + 40 * 86400e3, igUserId: '1784000000', username: 'placeholder_account', renewedAt: Date.now(), ...over });
const video = () => { const d = mkdtempSync(path.join(tmpdir(), 'ujw-ig-')); const f = path.join(d, 'clip.mp4'); writeFileSync(f, Buffer.alloc(12345, 7)); return f; };
const authWith = (meta, tok = tokenJson(), extra = {}) => createInstagramAuth({ appIdStore: memStore('1234567890'), appSecretStore: memStore('abcdef0123456789abcdef'), tokenStore: memStore(tok), fetchImpl: fetch, endpoints: meta.endpoints, cfg, browserOpen: async () => {}, ...extra });

describe('instagram publish (fake Graph + rupload)', () => {
  test('container, resumable upload with the exact bytes and headers, poll, publish; the limit is read first', async () => {
    const meta = await fakeMeta();
    try {
      const f = video();
      const steps = [];
      const r = await publishReel({ auth: authWith(meta), videoPath: f, caption: 'Clip #gaming', cfg, endpoints: meta.endpoints, sleep: async () => {}, beforeStep: async (s) => steps.push(s) });
      assert.equal(r.mediaId, '1800000000001'); assert.equal(r.containerId, '9990001'); assert.equal(r.left, 96);
      const paths = meta.log.map((l) => l.path);
      assert.match(paths[0], /\/v\d+\.\d+\/1784000000\/content_publishing_limit$/);
      const c = meta.log.find((l) => l.path.endsWith('/1784000000/media'));
      assert.deepEqual([c.form.media_type, c.form.upload_type, c.form.caption], ['REELS', 'resumable', 'Clip #gaming']);
      const up = meta.log.find((l) => l.path.startsWith('/ig-api-upload/'));
      assert.equal(up.path, `/ig-api-upload/${cfg.graphVersion}/9990001`);
      assert.equal(up.headers.authorization, 'OAuth TOKEN-A'); assert.equal(up.headers.offset, '0'); assert.equal(up.headers.file_size, '12345');
      assert.equal(up.bytes, 12345); assert.ok(up.body.every((b) => b === 7));
      assert.equal(meta.log.filter((l) => l.method === 'GET' && l.path.endsWith('/9990001')).length, 2, 'polled until FINISHED');
      assert.equal(meta.log.at(-1).form.creation_id, '9990001');
      assert.deepEqual(steps, ['container', 'upload', 'publish']);
    } finally { await meta.close(); }
  });

  test('no posts left in the moving 24 h: refused before anything is created', async () => {
    const meta = await fakeMeta({ used: 100 });
    try {
      await assert.rejects(publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints }), { code: 'limit-reached' });
      assert.equal(meta.log.length, 1);
    } finally { await meta.close(); }
  });

  test('expired token (code 190) -> reauth-needed; an expired stored token never reaches the network', async () => {
    const meta = await fakeMeta({ expired: true });
    try {
      await assert.rejects(publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints }), { code: 'reauth-needed' });
      const n = meta.log.length;
      await assert.rejects(publishReel({ auth: authWith(meta, tokenJson({ expiresAt: Date.now() - 1 })), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints }), { code: 'reauth-needed' });
      assert.equal(meta.log.length, n);
    } finally { await meta.close(); }
  });

  for (const [status, code] of [['ERROR', 'container-error'], ['EXPIRED', 'container-expired']]) {
    test(`container ${status} -> ${code}, nothing published`, async () => {
      const meta = await fakeMeta({ status });
      try {
        await assert.rejects(publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints, sleep: async () => {} }), { code });
        assert.ok(!meta.log.some((l) => l.path.endsWith('/media_publish')));
      } finally { await meta.close(); }
    });
  }

  test('still IN_PROGRESS at the ceiling -> processing-timeout; the container id was handed out for a later resume', async () => {
    const meta = await fakeMeta({ status: 'IN_PROGRESS' });
    try {
      let t = 0; let got = null;
      await assert.rejects(publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints, now: () => t, sleep: async () => { t += 3000; }, onContainer: (id) => { got = id; } }), { code: 'processing-timeout' });
      assert.equal(got, '9990001');
    } finally { await meta.close(); }
  });

  test('the guard stops before publish (a stream started): nothing published', async () => {
    const meta = await fakeMeta();
    try {
      await assert.rejects(publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints, sleep: async () => {},
        beforeStep: async (s) => { if (s === 'publish') throw new InstagramError('stream-live', 'live'); } }), { code: 'stream-live' });
      assert.ok(!meta.log.some((l) => l.path.endsWith('/media_publish')));
    } finally { await meta.close(); }
  });

  test('resume: a FINISHED container from before a restart is published without a second upload', async () => {
    const meta = await fakeMeta({ status: 'FINISHED' });
    try {
      const r = await publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints, resumeContainer: '9990001' });
      assert.equal(r.mediaId, '1800000000001');
      assert.ok(!meta.log.some((l) => l.path.startsWith('/ig-api-upload/') || l.path.endsWith('/1784000000/media')));
    } finally { await meta.close(); }
  });

  test('resume: a failed status read of the saved container (5xx) is retryable and makes no new container', async () => {
    const meta = await fakeMeta({ statusFail: 500 });
    try {
      await assert.rejects(publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints, resumeContainer: '9990001' }), { code: 'container-unknown' });
      assert.ok(!meta.log.some((l) => l.path.endsWith('/1784000000/media') || l.path.startsWith('/ig-api-upload/') || l.path.endsWith('/media_publish')));
    } finally { await meta.close(); }
  });
  test('resume: a timed-out status read is retryable too (nothing new)', async () => {
    const e = await publishReel({ auth: { session: async () => ({ token: 't', igUserId: '1784000000' }) }, videoPath: video(), caption: 'x', cfg, endpoints: { graph: 'http://127.0.0.1:9', rupload: 'http://127.0.0.1:9' }, resumeContainer: '9990001',
      fetchImpl: async () => { throw new Error('ECONNRESET'); } }).catch((x) => x);
    assert.equal(e.code, 'container-unknown');
  });
  for (const [label, script] of [['not found (400 code 100)', { statusFail: 400, statusCode: 100 }], ['not found (404)', { statusFail: 404 }], ['EXPIRED', { status: 'EXPIRED' }], ['ERROR', { status: 'ERROR' }]]) {
    test(`resume: ${label} -> a new container is made`, async () => {
      const meta = await fakeMeta({ ...script, resumeOnly: true });
      try {
        const r = await publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints, resumeContainer: '9990001', sleep: async () => {} });
        assert.equal(r.mediaId, '1800000000001');
        assert.equal(meta.log.filter((l) => l.path.endsWith('/1784000000/media')).length, 1);
      } finally { await meta.close(); }
    });
  }

  test('error answers name only the HTTP status and code, never the token', async () => {
    const meta = await fakeMeta({ httpFail: true });
    try {
      const e = await publishReel({ auth: authWith(meta), videoPath: video(), caption: 'x', cfg, endpoints: meta.endpoints }).catch((x) => x);
      assert.equal(e.code, 'graph-error'); assert.equal(e.message, 'Instagram answered HTTP 500 (code 2)'); assert.doesNotMatch(e.message, /TOKEN-A/);
    } finally { await meta.close(); }
  });
});

describe('instagram sign-in', () => {
  test('Connect: state checked, short -> long-lived token, IG account found through the Pages, all saved to the token store only', async () => {
    const meta = await fakeMeta();
    try {
      const tokenStore = memStore();
      let opened = null;
      const auth = authWith(meta, null, { tokenStore, port: 0, browserOpen: async (u) => {
        opened = new URL(u);
        const r = new URL(opened.searchParams.get('redirect_uri'));
        r.searchParams.set('code', 'CODE1'); r.searchParams.set('state', opened.searchParams.get('state'));
        setImmediate(() => fetch(r.href).catch(() => {}));
      } });
      const r = await auth.signIn();
      assert.equal(r.username, 'placeholder_account');
      assert.equal(opened.pathname, `/${cfg.graphVersion}/dialog/oauth`);
      assert.equal(opened.searchParams.get('scope'), cfg.scopes.join(','));
      const saved = JSON.parse(tokenStore.peek());
      assert.equal(saved.igUserId, '1784000000'); assert.match(saved.token, /^LL-/);
      assert.deepEqual(await auth.status(), { hasApp: true, connected: true, username: 'placeholder_account', expiresAt: new Date(saved.expiresAt).toISOString(), insightsAllowed: true });
      assert.ok(saved.scopes.includes('instagram_manage_insights'));
      await auth.signOut();
      assert.equal((await auth.status()).connected, false);
    } finally { await meta.close(); }
  });

  test('the redirect listener answers on ::1 too (a browser that resolves localhost to IPv6)', async () => {
    const meta = await fakeMeta();
    try {
      const auth = authWith(meta, null, { tokenStore: memStore(), port: 0, browserOpen: async (u) => {
        const o = new URL(u); const r = new URL(o.searchParams.get('redirect_uri'));
        const v6 = new URL(`http://[::1]:${r.port}/`); v6.searchParams.set('code', 'C'); v6.searchParams.set('state', o.searchParams.get('state'));
        setImmediate(() => fetch(v6.href).catch(() => {}));
      } });
      assert.equal((await auth.signIn()).username, 'placeholder_account');
    } finally { await meta.close(); }
  });

  const connectVia = (meta, tokenStore) => authWith(meta, null, { tokenStore, port: 0, browserOpen: async (u) => {
    const o = new URL(u); const r = new URL(o.searchParams.get('redirect_uri'));
    assert.equal(o.searchParams.get('auth_type'), 'rerequest', 'a Page or permission left out before is asked again');
    r.searchParams.set('code', 'C'); r.searchParams.set('state', o.searchParams.get('state'));
    setImmediate(() => fetch(r.href).catch(() => {}));
  } });

  test('a Page owned by a business portfolio (missing from me/accounts) is found through me/businesses', async () => {
    const meta = await fakeMeta({ pages: [], businesses: [{ owned_pages: { data: [{}] }, client_pages: { data: [{ instagram_business_account: { id: '1784000009', username: 'placeholder_biz' } }] } }] });
    try {
      const tokenStore = memStore();
      assert.equal((await connectVia(meta, tokenStore).signIn()).username, 'placeholder_biz');
      assert.equal(JSON.parse(tokenStore.peek()).igUserId, '1784000009');
      assert.ok(cfg.scopes.includes('business_management'));
    } finally { await meta.close(); }
  });

  test('a permission left out -> permission-declined naming it (counts and permission names only)', async () => {
    const meta = await fakeMeta({ pages: [], granted: cfg.scopes.filter((s) => s !== 'pages_show_list') });
    try {
      await assert.rejects(connectVia(meta, memStore()).signIn(), (e) => e.code === 'permission-declined' && e.message === 'Facebook shared 0 Page(s); not allowed: pages_show_list');
    } finally { await meta.close(); }
  });

  for (const [pages, code] of [[[], 'no-fb-page'], [[{ name: 'Page A' }], 'no-ig-account']]) {
    test(`Connect with ${pages.length} shared Page(s) and no Instagram account -> ${code}; nothing saved`, async () => {
      const meta = await fakeMeta({ pages });
      try {
        const tokenStore = memStore();
        const auth = authWith(meta, null, { tokenStore, port: 0, browserOpen: async (u) => {
          const o = new URL(u); const r = new URL(o.searchParams.get('redirect_uri'));
          r.searchParams.set('code', 'C'); r.searchParams.set('state', o.searchParams.get('state'));
          setImmediate(() => fetch(r.href).catch(() => {}));
        } });
        await assert.rejects(auth.signIn(), { code });
        assert.equal(tokenStore.peek(), null);
      } finally { await meta.close(); }
    });
  }

  test('a wrong state is refused; no token is asked for', async () => {
    const meta = await fakeMeta();
    try {
      const auth = authWith(meta, null, { port: 0, browserOpen: async (u) => {
        const r = new URL(new URL(u).searchParams.get('redirect_uri'));
        r.searchParams.set('code', 'C'); r.searchParams.set('state', 'forged');
        setImmediate(() => fetch(r.href).catch(() => {}));
      } });
      await assert.rejects(auth.signIn(), { code: 'state-mismatch' });
      assert.equal(meta.log.length, 0);
    } finally { await meta.close(); }
  });

  test('renewal: under renewDaysBefore days left the token is exchanged once a day; a token far from expiry is not', async () => {
    const meta = await fakeMeta();
    try {
      const store = memStore(tokenJson({ expiresAt: Date.now() + 3 * 86400e3, renewedAt: 0 }));
      const auth = authWith(meta, null, { tokenStore: store });
      const s = await auth.session();
      assert.match(s.token, /^LL-/); assert.equal(meta.log.length, 1);
      await auth.session(); assert.equal(meta.log.length, 1, 'renewed already today');
      const fresh = authWith(meta);
      assert.equal((await fresh.session()).token, 'TOKEN-A'); assert.equal(meta.log.length, 1);
    } finally { await meta.close(); }
  });

  test('app id and secret are checked before saving; empty keeps the stored value', async () => {
    const idS = memStore('1234567890'); const secS = memStore('abcdef0123456789abcdef');
    const auth = createInstagramAuth({ appIdStore: idS, appSecretStore: secS, tokenStore: memStore(), cfg });
    await assert.rejects(auth.setApp({ appId: 'abc' }), { code: 'bad-app-id' });
    await assert.rejects(auth.setApp({ appSecret: 'short' }), { code: 'bad-app-secret' });
    await auth.setApp({ appId: '', appSecret: '' });
    assert.equal(idS.peek(), '1234567890');
    await auth.setApp({ appId: '99999999', appSecret: '0123456789abcdef0123' }); // lint-allow: secret (a fake test app secret, not a credential)
    assert.equal(idS.peek(), '99999999');
    assert.equal((await auth.status()).hasApp, true);
  });
});

describe('instagram helpers', () => {
  test('HTTPS only (127.0.0.1 is the tests\' fake server)', () => {
    assert.throws(() => safeUrl('http://graph.facebook.com/x'), { code: 'insecure-url' });
    assert.equal(safeUrl('https://graph.facebook.com/x').hostname, 'graph.facebook.com');
    assert.equal(safeUrl('http://127.0.0.1:1/x').hostname, '127.0.0.1');
  });
  test('the Graph version is pinned in data and used in the dialog URL', () => {
    assert.match(cfg.graphVersion, /^v\d+\.\d+$/);
    assert.match(dialogUrl({ appId: '1', redirectUri: 'http://127.0.0.1:1/', state: 's', cfg }), new RegExp(`^https://www\\.facebook\\.com/${cfg.graphVersion.replace('.', '\\.')}/dialog/oauth\\?`));
  });
  test('pickAccount takes the first Page with an IG account', () => {
    assert.equal(pickAccount({ data: [{}, { instagram_business_account: { id: '42', username: 'u' } }] }).igUserId, '42');
    assert.equal(pickAccount({ data: [{}] }), null);
  });
  test('caption: description + hashtags, checked against instagram-reels limits (30 hashtags)', () => {
    const limits = loadLimits();
    const ok = reelCaption({ target: 'youtube-shorts', description: 'Nice', hashtags: ['#a', '#b'] }, limits);
    assert.equal(ok.ok, true); assert.equal(ok.caption, 'Nice\n\n#a #b');
    const many = reelCaption({ description: 'x', hashtags: Array.from({ length: 31 }, (_, i) => `#t${i}`) }, limits);
    assert.equal(many.ok, false);
  });
});

describe('instagram queue (IP2)', async () => {
  const { createInstagramPoster, queueInstagramNow, readInstagramStates } = await import('../services/posting/instagram-queue.mjs');
  const dir = () => mkdtempSync(path.join(tmpdir(), 'ujw-igq-'));
  test('holdsFile, no job yet: only a Shorts post sync would add, while wanted or unreadable', async () => {
    const d = dir();
    const mk = (isOn, status) => createInstagramPoster({ dataDir: d, flags: { isOn: () => isOn }, auth: { status }, liveBlock: async () => null });
    const shorts = { target: 'youtube-shorts', ytState: 'done' };
    assert.equal(await mk(false, async () => ({ connected: true })).holdsFile('p1', shorts), false);
    assert.equal(await mk(true, async () => ({ connected: false })).holdsFile('p1', shorts), false);
    assert.equal(await mk(true, async () => { throw new Error('cred'); }).holdsFile('p1', shorts), true);
    const p = mk(true, async () => ({ connected: true }));
    assert.equal(await p.holdsFile('p1', shorts), true, 'no job yet: sync would add it');
    assert.equal(await p.holdsFile('p1', { target: 'youtube-video', ytState: 'done' }), false, 'a long video is never held');
    assert.equal(await p.holdsFile('p1', { target: 'youtube-shorts', ytState: 'failed' }), false, 'a YouTube-failed item is never held');
    assert.equal(await p.holdsFile('p1'), false, 'unknown target: not held');
  });
  test('holdsFile with a job: decided by the queue alone; flag off or disconnected still keeps it; Drop releases it', async () => {
    const d = dir();
    const off = createInstagramPoster({ dataDir: d, flags: { isOn: () => false }, auth: { status: async () => ({ connected: false }) }, liveBlock: async () => null });
    queueInstagramNow(d, 'p1'); queueInstagramNow(d, 'p2'); queueInstagramNow(d, 'p3');
    off.queue.patch('p2', { state: 'failed' });
    off.queue.patch('p3', { state: 'done', postedAt: new Date().toISOString() });
    for (const id of ['p1', 'p2']) assert.equal(await off.holdsFile(id, { target: 'youtube-video' }), true, id);
    assert.equal(await off.holdsFile('p3'), false);
    assert.equal(off.dropQueue(), 2);
    for (const id of ['p1', 'p2']) assert.equal(await off.holdsFile(id), false, id);
    assert.equal(readInstagramStates(d).p3.state, 'done', 'posted jobs stay');
    assert.equal(readInstagramStates(d).p1.reason, 'dropped-by-user');
    const on = createInstagramPoster({ dataDir: d, flags: { isOn: () => true }, auth: { status: async () => ({ connected: true }) }, liveBlock: async () => null });
    assert.equal(await on.sync([{ id: 'p1', state: 'done' }], { get: () => ({ target: 'youtube-shorts' }) }), 0, 'a dropped clip is never re-added');
    assert.equal(off.dropQueue(), 0);
  });
  test('sync spaces jobs by the gap; only Shorts; nothing while not connected', async () => {
    const d = dir(); let t = Date.parse('2026-11-24T10:00:00Z');
    const posts = { a: { target: 'youtube-shorts' }, b: { target: 'youtube-video' }, c: { target: 'youtube-shorts' } };
    const store = { get: (id) => posts[id] };
    const items = [{ id: 'a', state: 'done' }, { id: 'b', state: 'queued' }, { id: 'c', state: 'queued' }, { id: 'x', state: 'failed' }];
    const off = createInstagramPoster({ dataDir: d, flags: { isOn: () => true }, auth: { status: async () => ({ connected: false }) }, liveBlock: async () => null, nowMs: () => t });
    assert.equal(await off.sync(items, store), 0);
    const p = createInstagramPoster({ dataDir: d, flags: { isOn: () => true }, auth: { status: async () => ({ connected: true }) }, liveBlock: async () => null, nowMs: () => t, gapMs: () => 15 * 60e3 });
    assert.equal(await p.sync(items, store), 2);
    const q = readInstagramStates(d);
    assert.deepEqual(Object.keys(q).sort(), ['a', 'c']);
    assert.equal(Date.parse(q.c.dueAt) - Date.parse(q.a.dueAt), 15 * 60e3);
  });
});

describe('instagram queue: stuck container and fairness (2026-11-27)', async () => {
  const { createInstagramPoster, IG_REASON_TEXT } = await import('../services/posting/instagram-queue.mjs');
  const T = Date.parse('2026-11-27T12:00:00Z');
  const hoursAgo = (h) => new Date(T - h * 3600e3).toISOString();
  const store = { get: () => ({ status: 'approved', description: 'x', hashtags: [] }), media: () => ({ file: video() }) };
  const auth = { status: async () => ({ connected: true }), session: async () => ({ token: 't', igUserId: '1784000000' }) };
  const qcfg = { ...cfg, pollMaxMs: 50, stuckContainerMs: 2 * 3600e3 };
  const tick = async () => { await new Promise((r) => setTimeout(r, 15)); };
  const mk = (meta, d, over = {}) => createInstagramPoster({ dataDir: d, flags: { isOn: () => true }, auth, liveBlock: async () => null, nowMs: () => T, gapMs: () => 1000,
    endpoints: meta.endpoints, cfg: qcfg, sleep: tick, ...over });
  const seed = (d, items) => {
    mkdirSync(path.join(d, 'posting'), { recursive: true });
    const base = { state: 'waiting', attempts: 0, nextAt: null, reason: null, containerId: null, mediaId: null, postedAt: null, enqueuedAt: hoursAgo(30), updatedAt: hoursAgo(30) };
    writeFileSync(path.join(d, 'posting', 'instagram-queue.json'), JSON.stringify({ version: 1, lastPostedAt: null, items: Object.fromEntries(items.map((i) => [i.id, { ...base, ...i }])) }));
  };

  test('stuck container past the ceiling: id dropped, attempt counted, plain reason', async () => {
    const meta = await fakeMeta({ status: 'IN_PROGRESS' });
    try {
      const d = mkdtempSync(path.join(tmpdir(), 'ujw-igq-'));
      seed(d, [{ id: 'a', dueAt: hoursAgo(24), containerId: '9990001', containerSince: hoursAgo(3) }]);
      const p = mk(meta, d);
      assert.deepEqual(await p.pass(store), { skipped: 'container-stuck' });
      const j = p.queue.get('a');
      assert.equal(j.containerId, null); assert.equal(j.containerSince, null);
      assert.equal(j.attempts, 1); assert.equal(j.state, 'waiting'); assert.equal(j.reason, 'container-stuck');
      assert.ok(Date.parse(j.nextAt) > T);
      assert.match(IG_REASON_TEXT['container-stuck'], /uploading it again/);
    } finally { await meta.close(); }
  });

  test('within the ceiling the id is kept; old queue shape (no containerSince) starts the clock; max attempts fails it', async () => {
    const meta = await fakeMeta({ status: 'IN_PROGRESS' });
    try {
      const d = mkdtempSync(path.join(tmpdir(), 'ujw-igq-'));
      seed(d, [{ id: 'old', dueAt: hoursAgo(24), containerId: '9990001' }]); // old file: no containerSince field
      const p = mk(meta, d);
      assert.equal(p.queue.get('old').containerSince, undefined);
      await p.pass(store);
      const j = p.queue.get('old');
      assert.equal(j.containerId, '9990001', 'not dropped on first sight');
      assert.equal(j.containerSince, new Date(T).toISOString());
      assert.equal(j.attempts, 0);
      seed(d, [{ id: 'last', dueAt: hoursAgo(24), containerId: '9990001', containerSince: hoursAgo(3), attempts: 5 }]);
      const p2 = mk(meta, d);
      await p2.pass(store);
      assert.equal(p2.queue.get('last').state, 'failed');
    } finally { await meta.close(); }
  });

  test('a deferred stuck job does not block a second due job', async () => {
    const meta = await fakeMeta();
    try {
      const d = mkdtempSync(path.join(tmpdir(), 'ujw-igq-'));
      seed(d, [{ id: 'stuck', dueAt: hoursAgo(24), containerId: '9990001', containerSince: hoursAgo(1), nextAt: hoursAgo(0.5), reason: 'processing-timeout' },
        { id: 'fresh', dueAt: hoursAgo(1) }]);
      const p = mk(meta, d);
      assert.deepEqual(await p.pass(store), { posted: 'fresh' });
      assert.equal(p.queue.get('stuck').state, 'waiting');
    } finally { await meta.close(); }
  });
});
