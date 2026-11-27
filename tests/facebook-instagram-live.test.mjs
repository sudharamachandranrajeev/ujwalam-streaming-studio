// SPDX-License-Identifier: GPL-3.0-or-later
// D447: Facebook Live (Page, automatic key) and the Instagram Live paste in the Go live window.
//   - data/platforms/facebook.json (sourced, checked 2026-11-27); the facebook sink on the H canvas reuses the shared
//     Twitch/Kick rung (no new encoder); the chained Instagram + Facebook live plan; the launcher leaves add-ons out one
//     at a time;
//   - stream URL split and the Instagram paste parsing (rtmps only, URL + key in one box or two);
//   - the Facebook live video against a fake Graph server on 127.0.0.1: Pages, Page pick, create (LIVE_NOW) with the
//     address and key put in the sink's credential stores, end at stream stop, left-overs ended at the next start,
//     errors in plain words, a failed address ends the video again;
//   - the Go live ticks (applyExtras) and the card routes (paste stored, refused while live).
// In-memory credential stores only: no test touches Credential Manager or a real platform. Every value is a throwaway
// test string, never a real key, token or URL.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPlatforms, validate } from '../services/outputs/validate.mjs';
import { addFacebook, loadFacebookAddon, writeFacebookPlan } from '../services/outputs/facebook.mjs';
import { keyFreshness } from '../services/outputs/instagram.mjs';
import { parseInstagramPaste, splitStreamUrl } from '../services/outputs/stream-url.mjs';
import { createFacebookLive } from '../services/posting/facebook-live.mjs';
import { applyExtras, createLiveExtras, readExtras, writeExtras } from '../services/studio-ui/live-extras-routes.mjs';
import { planFile } from '../app/host/lib/outputs-plan.mjs';
import { ALPHA_LIVE_PLAN, livePlanFile } from '../services/studio-ui/stream-apply.mjs';
import { planForStart } from '../services/studio-ui/launch.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORMS = loadPlatforms(path.join(REPO, 'data', 'platforms'));
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-fb-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const memStore = (v = null) => { let x = v; return { get: async () => x, set: async (s) => { x = s; }, delete: async () => { const had = x !== null; x = null; return had; }, peek: () => x }; };
const FB_KEY = 'FB-0000000000-0-TestOnlyNotAKey?s_bl=1&s_psm=1&a=TestOnly'; // throwaway
const FB_URL = `rtmps://live-api-s.test.example:443/rtmp/${FB_KEY}`;

describe('data/platforms/facebook.json', () => {
  test('sourced limits checked 2026-11-27; 1080p60, 9000 kbps, keyframe 4 s max, rtmps only', () => {
    const p = PLATFORMS.facebook;
    assert.ok(p);
    assert.deepEqual([p.maxWidth.value, p.maxHeight.value, p.maxFps.value, p.videoBitrateKbps.max.value, p.keyframeIntervalSec.max.value], [1920, 1080, 60, 9000, 4]);
    assert.deepEqual(p.protocols.value, ['rtmps']);
    for (const k of ['maxWidth', 'maxHeight', 'maxFps', 'videoCodecs', 'protocols', 'audioCodecs']) {
      assert.match(p[k].source, /^https:\/\/developers\.facebook\.com\//, k);
      assert.equal(p[k].checked, '2026-11-27', k);
    }
    assert.equal(p.ingest.value.perBroadcast, true);
  });
});

describe('plan: the facebook sink on the H canvas', () => {
  const preset = JSON.parse(readFileSync(path.join(REPO, 'data/outputs/presets/youtube-1080p60.json'), 'utf8'));
  test('reuses the shared Twitch/Kick rung (no new encoder); the 17 Mbps YouTube rung is not used', () => {
    const r = addFacebook(preset, { platforms: PLATFORMS });
    assert.equal(r.reused, true);
    const twitchRung = preset.sinks.find((s) => s.id === 'twitch').encoder;
    assert.equal(r.rung, twitchRung);
    assert.equal(r.config.encoders.length, preset.encoders.length);
    const res = validate(r.config, PLATFORMS);
    assert.deepEqual(res.errors, []);
    assert.ok(res.rungs.find((x) => x.sinks.includes('facebook')).sinks.includes('twitch'));
  });
  test('a plan whose H rungs do not fit gets its own 1080p60 rung from the H canvas', () => {
    const cfg = structuredClone(preset);
    // only the 17 Mbps YouTube H rung left on the H canvas (no Twitch/Kick rung)
    const shared = cfg.sinks.find((s) => s.id === 'twitch').encoder;
    cfg.sinks = cfg.sinks.filter((s) => s.encoder !== shared);
    cfg.encoders = cfg.encoders.filter((e) => e.id !== shared);
    const r = addFacebook(cfg, { platforms: PLATFORMS });
    assert.equal(r.reused, false);
    const rung = r.config.encoders.find((e) => e.id === r.rung);
    assert.deepEqual([rung.canvas, rung.w, rung.h, rung.fps, rung.bitrate, rung.gop_sec], ['H', 1920, 1080, 60, 6000, 2]);
    assert.deepEqual(validate(r.config, PLATFORMS).errors, []);
  });
  test('the live plan: Instagram then Facebook, target names only, no URL; planned rungs stay four', () => {
    const d = mk();
    const f = livePlanFile({ dataDir: d, streamSettingsOn: false, instagramOn: true, facebookOn: true });
    assert.equal(f, path.join(d, 'outputs', loadFacebookAddon().planName));
    const text = readFileSync(f, 'utf8');
    assert.ok(!/rtmps?:\/\//.test(text));
    const p = planFile(f, { allowLive: true });
    const fb = p.params.sinks.find((s) => s.id === 'facebook');
    const ig = p.params.sinks.find((s) => s.id === 'instagram');
    assert.deepEqual(fb.target, { transport: 'rtmps', urlRef: 'Ujwalam/stream/facebook-server', keyRef: 'Ujwalam/stream/facebook' });
    assert.deepEqual(ig.target, { transport: 'rtmps', urlRef: 'Ujwalam/stream/instagram-server', keyRef: 'Ujwalam/stream/instagram' }, 'instagram no longer needs a stored server before the start');
    assert.equal(fb.rung, p.params.sinks.find((s) => s.id === 'twitch').rung);
    assert.equal(p.params.rungs.length, 4, 'yt-h, reencode-tk, vert, ig-v');
    assert.equal(writeFacebookPlan(mk(), ALPHA_LIVE_PLAN).reused, true);
  });
  test('launcher: an add-on that does not fit is left out, the rest still goes live', async () => {
    const seen = []; const logs = [];
    const r = await planForStart({ live: true, instagramOn: true, facebookOn: true, log: (l) => logs.push(l), recordPlan: null,
      planOnce: async (o) => { seen.push(o); if (o.facebookOn) throw new Error('no'); return { file: 'x', planned: null }; } });
    assert.equal(r.file, 'x');
    assert.deepEqual(seen.map((o) => [o.instagramOn, o.facebookOn]), [[true, true], [false, true], [false, false]]);
    assert.ok(logs.some((l) => /Instagram Live and Facebook Live left out/.test(l)));
  });
  test('flags facebook-live and instagram-live: on (requested features, D447)', () => {
    const defs = loadDefinitions();
    for (const id of ['facebook-live', 'instagram-live']) { const f = defs.find((x) => x.id === id); assert.equal(f.default, true, id); assert.equal(f.onBy, 'D447'); }
  });
});

describe('stream URL split and the Instagram paste', () => {
  test('splitStreamUrl keeps the "?" part with the key, the server has no key', () => {
    const r = splitStreamUrl(FB_URL);
    assert.equal(r.server, 'rtmps://live-api-s.test.example:443/rtmp/');
    assert.equal(r.key, FB_KEY);
    assert.throws(() => splitStreamUrl('rtmp://a.test.example/rtmp/abcdefgh12'), /rtmps/);
    assert.throws(() => splitStreamUrl('rtmps://a.test.example/rtmp/'), /no stream key/);
    assert.throws(() => splitStreamUrl('https://a.test.example/x/abcdefgh12'), /stream address/);
  });
  test('Instagram: URL + key in one box (either order), one URL with the key on it, or two boxes', () => {
    const want = { server: 'rtmps://edge.test.example:443/rtmp/', key: '17999999999999999?s_test=1&a=TestOnly' };
    assert.deepEqual(parseInstagramPaste(`${want.server}\n${want.key}`), want);
    assert.deepEqual(parseInstagramPaste(`  ${want.key}   ${want.server} `), want);
    assert.deepEqual(parseInstagramPaste(`${want.server}${want.key}`), want);
    assert.deepEqual(parseInstagramPaste({ server: 'rtmps://edge.test.example:443/rtmp', key: want.key }), want, 'a missing end "/" is added');
    assert.deepEqual(parseInstagramPaste({ server: `${want.server}${want.key}` }), want);
  });
  test('Instagram: refusals in plain words, never quoting the paste', () => {
    for (const [input, code] of [['', 'empty'], ['rtmp://edge.test.example/rtmp/ key-12345678', 'not-rtmps'], ['just-a-key-123456', 'unclear'],
      ['rtmps://a.test.example/rtmp/ rtmps://b.test.example/rtmp/ k', 'unclear'], ['rtmps://edge.test.example/rtmp/ short', 'bad-key'], ['rtmps://user@x.test.example/ abcdefgh123', 'bad-server']]) {
      assert.throws(() => parseInstagramPaste(input), (e) => e.code === code && !e.message.includes('abcdefgh123') && !e.message.includes('key-12345678'), `${code}: ${input}`);
    }
  });
});

// ---- fake Graph server ----
function fakeGraph() {
  const calls = []; const ended = new Set();
  let failCreate = null; let streamUrl = FB_URL;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const q = req.method === 'GET' ? Object.fromEntries(u.searchParams) : Object.fromEntries(new URLSearchParams(body));
      calls.push({ method: req.method, path: u.pathname, q });
      const send = (code, j) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (u.pathname === '/v24.0/me/accounts') {
        if (q.access_token !== 'user-token-test') return send(400, { error: { code: 190 } });
        return send(200, { data: [{ id: '111', name: 'Test Page', tasks: ['CREATE_CONTENT', 'MODERATE'], access_token: 'page-token-test' }, { id: '222', name: 'Other', tasks: ['ANALYZE'], access_token: 'page-token-2' }] });
      }
      if (req.method === 'POST' && u.pathname === '/v24.0/111/live_videos') {
        if (q.access_token !== 'page-token-test') return send(400, { error: { code: 190 } });
        if (failCreate) return send(400, { error: { code: failCreate } });
        const id = String(900 + calls.filter((c) => c.path.endsWith('/live_videos')).length);
        return send(200, { id, stream_url: streamUrl?.replace('rtmps', 'rtmp'), secure_stream_url: streamUrl });
      }
      const m = /^\/v24\.0\/(\d+)$/.exec(u.pathname);
      if (m && req.method === 'POST' && q.end_live_video === 'true') { if (m[1] === '404404') return send(404, { error: { code: 100 } }); ended.add(m[1]); return send(200, { id: m[1] }); }
      if (m && req.method === 'GET') return send(200, { id: m[1], status: ended.has(m[1]) ? 'VOD' : 'LIVE' });
      send(404, { error: { code: 100 } });
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    endpoints: { graph: `http://127.0.0.1:${srv.address().port}` }, calls, ended, close: () => srv.close(),
    setFailCreate: (c) => { failCreate = c; }, setStreamUrl: (s) => { streamUrl = s; },
  })));
}
const userToken = (extra = {}) => memStore(JSON.stringify({ token: 'user-token-test', igUserId: '1', expiresAt: Date.now() + 86400000, scopes: ['pages_manage_posts', 'pages_read_engagement', 'pages_show_list'], ...extra }));

describe('Facebook live video (fake Graph server)', () => {
  test('Pages, Page pick, create LIVE_NOW, address and key to the sink stores, end at stop', async () => {
    const g = await fakeGraph();
    try {
      const d = mk();
      const stores = { userTokenStore: userToken(), pageStore: memStore(), serverStore: memStore(), keyStore: memStore() };
      const fb = createFacebookLive({ dataDir: d, ...stores, endpoints: g.endpoints, cfg: { graphVersion: 'v24.0' } });
      assert.deepEqual(await fb.listPages(), [{ id: '111', name: 'Test Page', canLive: true }, { id: '222', name: 'Other', canLive: false }]);
      assert.deepEqual(await fb.choosePage('111'), { pageId: '111', name: 'Test Page' });
      assert.equal(JSON.parse(stores.pageStore.peek()).token, 'page-token-test');
      const st = await fb.status();
      assert.deepEqual([st.connected, st.scopesOk, st.page.name], [true, true, 'Test Page']);
      assert.ok(!JSON.stringify(st).includes('token-test'), 'status never carries a token');
      const made = await fb.startLive({ title: 'T'.repeat(300), description: 'Desc' });
      assert.deepEqual(Object.keys(made), ['id']);
      const create = g.calls.find((c) => c.path === '/v24.0/111/live_videos');
      assert.deepEqual([create.q.status, create.q.title.length, create.q.description], ['LIVE_NOW', 254, 'Desc']);
      assert.equal(stores.serverStore.peek(), 'rtmps://live-api-s.test.example:443/rtmp/');
      assert.equal(stores.keyStore.peek(), FB_KEY);
      const stateText = readFileSync(path.join(d, 'outputs', 'facebook-live-state.json'), 'utf8');
      assert.ok(!stateText.includes('rtmp') && !stateText.includes('TestOnly') && !stateText.includes('token'), 'state file: ids only');
      assert.equal(await fb.liveStatus(), 'LIVE');
      const r = await fb.stopLive();
      assert.deepEqual(r, { ended: 1, failed: 0 });
      assert.ok(g.ended.has(made.id));
      assert.equal(stores.serverStore.peek(), null); assert.equal(stores.keyStore.peek(), null);
      assert.equal(fb.readState().live.length, 0);
    } finally { g.close(); }
  });
  test('a crash leaves a live video: the next start ends it first; a gone one counts as ended', async () => {
    const g = await fakeGraph();
    try {
      const d = mk();
      const stores = { userTokenStore: userToken(), pageStore: memStore(JSON.stringify({ pageId: '111', name: 'Test Page', token: 'page-token-test' })), serverStore: memStore(), keyStore: memStore() };
      const mkFb = () => createFacebookLive({ dataDir: d, ...stores, endpoints: g.endpoints, cfg: { graphVersion: 'v24.0' } });
      const first = await mkFb().startLive({});
      // "crash": a new instance (new studio start) with the state file left
      const fb2 = mkFb();
      assert.equal(fb2.readState().live.length, 1);
      const second = await fb2.startLive({});
      assert.ok(g.ended.has(first.id), 'the left-over was ended before the new one was made');
      assert.deepEqual(fb2.readState().live.map((x) => x.id), [second.id]);
      // a left-over Facebook already removed
      const st = path.join(d, 'outputs', 'facebook-live-state.json');
      const j = JSON.parse(readFileSync(st, 'utf8')); j.live.push({ id: '404404' });
      (await import('node:fs')).writeFileSync(st, JSON.stringify(j));
      assert.deepEqual(await fb2.endLeftovers(), { ended: 2, failed: 0 });
    } finally { g.close(); }
  });
  test('errors: not connected, no Page, permission refused; an answer without an address ends the video again', async () => {
    const g = await fakeGraph();
    try {
      const d = mk();
      const none = createFacebookLive({ dataDir: d, userTokenStore: memStore(), pageStore: memStore(), serverStore: memStore(), keyStore: memStore(), endpoints: g.endpoints, cfg: { graphVersion: 'v24.0' } });
      await assert.rejects(none.listPages(), { code: 'not-connected' });
      await assert.rejects(none.startLive({}), { code: 'no-page' });
      const stores = { userTokenStore: userToken(), pageStore: memStore(JSON.stringify({ pageId: '111', name: 'P', token: 'page-token-test' })), serverStore: memStore(), keyStore: memStore() };
      const fb = createFacebookLive({ dataDir: d, ...stores, endpoints: g.endpoints, cfg: { graphVersion: 'v24.0' } });
      g.setFailCreate(200);
      await assert.rejects(fb.startLive({}), (e) => e.code === 'not-permitted' && /100 followers/.test(e.message));
      g.setFailCreate(null); g.setStreamUrl('rtmp://plain.test.example/rtmp/abcdefgh1234');
      await assert.rejects(fb.startLive({}), { code: 'no-stream-url' });
      assert.equal(stores.keyStore.peek(), null);
      assert.equal(fb.readState().live.length, 0, 'the video made was ended again');
      assert.equal(g.ended.size, 1);
      const scopes = createFacebookLive({ dataDir: d, ...stores, userTokenStore: userToken({ scopes: ['pages_show_list'] }), endpoints: g.endpoints, cfg: { graphVersion: 'v24.0' } });
      assert.deepEqual((await scopes.status()).missing, ['pages_manage_posts', 'pages_read_engagement']);
    } finally { g.close(); }
  });
});

describe('Go live ticks and cards', () => {
  test('applyExtras: ticks add or take out facebook / instagram; "all" stays all when nothing changes', () => {
    const planned = ['youtube-h', 'twitch', 'facebook', 'instagram'];
    assert.deepEqual(applyExtras(null, planned, { facebook: true, instagram: true }), { sinks: null, facebook: true, instagram: true });
    assert.deepEqual(applyExtras(null, planned, { facebook: false, instagram: false }).sinks, ['youtube-h', 'twitch']);
    assert.deepEqual(applyExtras(['youtube-h'], planned, { facebook: true, instagram: false }).sinks, ['youtube-h', 'facebook']);
    assert.deepEqual(applyExtras(['youtube-h', 'instagram'], planned, { facebook: false, instagram: false }).sinks, ['youtube-h']);
    assert.deepEqual(applyExtras(['youtube-h'], ['youtube-h'], { facebook: true, instagram: true }), { sinks: ['youtube-h'], facebook: false, instagram: false }, 'not in the plan: not added');
    assert.deepEqual(applyExtras(null, null, { facebook: true }).sinks, null);
  });

  const res = () => { const r = { status: null, body: null }; return [r, (x, code, body) => { r.status = code; r.body = body; }]; };
  test('Instagram paste: stored for this stream (memory stores), ticks Instagram, never echoed; refused while live', async () => {
    const d = mk();
    const server = memStore(); const key = memStore(); let liveState = 'idle'; const opened = [];
    const ex = createLiveExtras({ dataDir: d, facebookOn: () => false, instagramOn: () => true, igServerStore: server, igKeyStore: key, browserOpen: async (u) => { opened.push(u); }, outputLive: async () => liveState });
    let [r, json] = res();
    assert.equal(await ex.handle('POST', '/ui/api/golive/instagram/open', {}, null, json), true);
    assert.deepEqual(opened, ['https://www.instagram.com/']);
    [r, json] = res();
    const paste = 'rtmps://edge.test.example:443/rtmp/ 17999999999999999?s_test=1';
    await ex.handle('POST', '/ui/api/golive/instagram/paste', { text: paste }, null, json);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes('17999999999999999') && !JSON.stringify(r.body).includes('edge.test'), 'nothing pasted is echoed');
    assert.deepEqual([server.peek(), key.peek()], ['rtmps://edge.test.example:443/rtmp/', '17999999999999999?s_test=1']);
    assert.equal(readExtras(d).instagram, true);
    assert.equal(keyFreshness(d).state, 'fresh');
    assert.equal(r.body.instagram.pasted, true);
    [r, json] = res();
    await ex.handle('POST', '/ui/api/golive/instagram/paste', { text: 'rtmp://edge.test.example/rtmp/ 17999999999999999' }, null, json);
    assert.deepEqual([r.status, r.body.error], [400, 'not-rtmps']);
    liveState = 'live';
    [r, json] = res();
    await ex.handle('POST', '/ui/api/golive/instagram/paste', { text: paste }, null, json);
    assert.deepEqual([r.status, r.body.error], [409, 'output-live']);
    liveState = 'idle';
    await ex.streamEnded();
    assert.deepEqual([server.peek(), key.peek()], [null, null], 'one-time key deleted at stream end');
  });

  test('beforeStart: Instagram ticked without a paste refuses; Facebook ticked makes the video, a failed start ends it', async () => {
    const g = await fakeGraph();
    try {
      const d = mk();
      const stores = { userTokenStore: userToken(), pageStore: memStore(JSON.stringify({ pageId: '111', name: 'P', token: 'page-token-test' })), serverStore: memStore(), keyStore: memStore() };
      const fb = createFacebookLive({ dataDir: d, ...stores, endpoints: g.endpoints, cfg: { graphVersion: 'v24.0' } });
      const ex = createLiveExtras({ dataDir: d, facebookOn: () => true, instagramOn: () => true, facebook: fb, igServerStore: memStore(), igKeyStore: memStore(), templateText: () => ({ title: 'Ranked grind', description: 'd' }) });
      const planned = ['youtube-h', 'facebook', 'instagram'];
      writeExtras(d, { facebook: false, instagram: true });
      const refused = await ex.beforeStart({ sinks: null, planned });
      assert.deepEqual([refused.ok, refused.reason], [false, 'instagram-key-missing']);
      writeExtras(d, { facebook: true, instagram: false });
      const okStart = await ex.beforeStart({ sinks: null, planned });
      assert.deepEqual(okStart, { ok: true, sinks: ['youtube-h', 'facebook'] });
      assert.equal(g.calls.find((c) => c.path.endsWith('/live_videos')).q.title, 'Ranked grind');
      assert.ok(stores.keyStore.peek());
      await ex.startFailed();
      assert.equal(stores.keyStore.peek(), null);
      assert.equal(g.ended.size, 1);
      g.setFailCreate(200);
      const fbRefused = await ex.beforeStart({ sinks: null, planned });
      assert.deepEqual([fbRefused.ok, fbRefused.reason], [false, 'facebook-live-failed']);
      assert.match(fbRefused.detail, /Untick Facebook/);
    } finally { g.close(); }
  });
});
