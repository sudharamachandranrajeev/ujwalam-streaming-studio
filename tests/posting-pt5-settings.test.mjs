// SPDX-License-Identifier: GPL-3.0-or-later
// PT5 (D410) Settings > Posting & growth: post text (tone, emoji, own hashtags, footer), per-kind share and growth
// suggestions. Checks, the text rules, the kind order, and the server round trip (session + CSRF, atomic, survives a
// fresh read like an update). Fakes only: temp dirs, fake host, no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyTextPrefs, checkPrefs, defaultPrefs, evenShares, prefsFile, readPrefs, savePrefs, userKindShares } from '../services/posting/post-prefs.mjs';
import { mixOrder } from '../services/posting/auto-post.mjs';
import { limitsFit, loadLimits } from '../services/posting/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const T0 = Date.parse('2026-11-21T10:00:00Z');
const tmp = []; const servers = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pt5-')); tmp.push(d); mkdirSync(path.join(d, 'posting'), { recursive: true }); return d; };
after(async () => { for (const s of servers) await s.close?.(); for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const STYLE = { emoji: { short: ['X1'], montage: ['M1'] } };

describe('post prefs (PT5)', () => {
  test('defaults change nothing: hype, emoji off, no hashtags, no footer, even shares, suggestions on', () => {
    const d = defaultPrefs();
    assert.deepEqual(d.text, { tone: 'hype', emoji: false, hashtags: [], footer: '' });
    assert.equal(d.growthSuggestions, true);
    assert.deepEqual(d.kindShare, evenShares());
    assert.equal(Object.values(d.kindShare).reduce((a, b) => a + b, 0), 100);
    const post = { title: 'Triple kill!', description: 'Lead!\n\nBody', hashtags: ['#Shorts'] };
    assert.deepEqual(applyTextPrefs(post, d.text, { style: STYLE }), post);
    assert.equal(userKindShares(mk()), null, 'no file: order as before');
  });

  test('text rules: clean drops !, hype+emoji adds one within the title limit, footer and own hashtags (no repeats)', () => {
    const post = { title: 'Triple kill!!', description: 'Wow! nice', hashtags: ['#Shorts', '#gaming'] };
    const clean = applyTextPrefs(post, { tone: 'clean', emoji: true, hashtags: ['#GAMING', '#clutch'], footer: 'Live most nights' }, { style: STYLE });
    assert.equal(clean.title, 'Triple kill');
    assert.equal(clean.description, 'Wow. nice\n\nLive most nights');
    assert.deepEqual(clean.hashtags, ['#Shorts', '#gaming', '#clutch']);
    const hype = applyTextPrefs(post, { tone: 'hype', emoji: true, hashtags: [], footer: '' }, { kind: 'short', style: STYLE });
    assert.equal(hype.title, 'Triple kill!! X1');
    const tight = applyTextPrefs(post, { tone: 'hype', emoji: true, hashtags: [], footer: '' }, { kind: 'short', style: STYLE, titleMax: 13 });
    assert.equal(tight.title, 'Triple kill!!', 'no emoji past the title limit');
  });

  test('checks: bad values are refused with plain words; shares must add to 100', () => {
    const good = defaultPrefs();
    assert.deepEqual(checkPrefs(good).problems, []);
    const bad = { ...good, text: { tone: 'loud', emoji: 'yes', hashtags: ['nohash'], footer: '<b>' }, kindShare: { ...good.kindShare, short: 90 }, growthSuggestions: 1 };
    const keys = checkPrefs(bad).problems.map((p) => p.key);
    for (const k of ['tone', 'emoji', 'hashtags', 'footer', 'kindShare', 'growthSuggestions']) assert.ok(keys.includes(k), k);
  });

  test('uneven shares set the auto-post order; even shares give null', () => {
    const d = mk();
    const prefs = { ...defaultPrefs(), kindShare: { short: 60, montage: 40, 'won-reel': 0, 'impact-play': 0, 'long-highlights': 0 } };
    assert.equal(savePrefs(d, { prefs }).ok, true);
    const s = userKindShares(d);
    assert.deepEqual(s, { short: 0.6, montage: 0.4, 'won-reel': 0, 'impact-play': 0, 'long-highlights': 0 });
    const posts = [1, 2, 3, 4, 5].map((i) => ({ id: `s${i}`, kind: 'short', score: 10 - i })).concat([1, 2, 3, 4, 5].map((i) => ({ id: `m${i}`, kind: 'montage', score: 5 - i })));
    const first5 = mixOrder(posts, s).slice(0, 5).map((p) => p.kind);
    assert.equal(first5.filter((k) => k === 'short').length, 3);
    assert.equal(savePrefs(d, { prefs: defaultPrefs() }).ok, true);
    assert.equal(userKindShares(d), null);
  });

  test('a broken file reads as the defaults with error; nothing else is affected', () => {
    const d = mk();
    writeFileSync(prefsFile(d), '{not json');
    const r = readPrefs(d);
    assert.deepEqual(r.prefs, defaultPrefs());
    assert.match(r.error, /not valid JSON/);
    assert.equal(userKindShares(d), null);
  });
});

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject); req.end(body);
  });
}

async function boot({ flags = { posting: true }, dataDir = mk() } = {}) {
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), now: () => T0,
    youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, fetchImpl: async () => { throw new Error('no network'); }, outputsStatus: async () => ({ sinks: [] }) } });
  servers.push(srv);
  const { port } = await srv.listen();
  const cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const origin = `http://127.0.0.1:${port}`;
  const post = (route, body, { noCsrf = false } = {}) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body),
    headers: { cookie, origin, 'content-type': 'application/json', ...(noCsrf ? {} : { 'x-ujwalam-csrf': csrf }) } });
  const get = (url, withCookie = true) => raw(port, { url, headers: withCookie ? { cookie } : {} });
  return { dataDir, post, get, srv };
}

describe('post prefs routes (PT5)', () => {
  test('round trip: read defaults, save, read back; a new server on the same data folder (an update) keeps them', async () => {
    const t = await boot();
    assert.notEqual((await t.get('/ui/api/posts/prefs', false)).status, 200);
    let r = await t.get('/ui/api/posts/prefs');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().prefs, defaultPrefs());
    const prefs = { text: { tone: 'clean', emoji: true, hashtags: ['#mobile', '#clutch'], footer: 'New clips daily' }, kindShare: { short: 40, montage: 30, 'won-reel': 10, 'impact-play': 10, 'long-highlights': 10 }, growthSuggestions: false };
    assert.equal((await t.post('/ui/api/posts/prefs', { prefs }, { noCsrf: true })).status, 403);
    r = await t.post('/ui/api/posts/prefs', { prefs });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().prefs, prefs);
    assert.deepEqual((await t.get('/ui/api/posts/prefs')).json().prefs, prefs);
    const saved = JSON.parse(readFileSync(prefsFile(t.dataDir), 'utf8'));
    assert.equal(saved.text.tone, 'clean');
    await t.srv.close();
    const t2 = await boot({ dataDir: t.dataDir });
    assert.deepEqual((await t2.get('/ui/api/posts/prefs')).json().prefs, prefs);
  });

  test('a bad value is refused and nothing is written; unknown keys are refused', async () => {
    const t = await boot();
    const r = await t.post('/ui/api/posts/prefs', { prefs: { ...defaultPrefs(), kindShare: { ...defaultPrefs().kindShare, short: 99 } } });
    assert.equal(r.status, 400);
    assert.equal(r.json().problems[0].key, 'kindShare');
    assert.throws(() => readFileSync(prefsFile(t.dataDir)));
    assert.equal((await t.post('/ui/api/posts/prefs', { prefs: defaultPrefs(), extra: 1 })).status, 400);
  });

  test('preview is read only and works with no clips; posting flag off: no routes', async () => {
    const t = await boot();
    const r = await t.post('/ui/api/posts/prefs/preview', { text: { tone: 'clean', emoji: false, hashtags: [], footer: 'x' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json().items, []);
    assert.throws(() => readFileSync(prefsFile(t.dataDir)));
    const off = await boot({ flags: {} });
    assert.equal((await off.get('/ui/api/posts/prefs')).status, 404);
  });
});

describe('Codex review of PT5 (D410)', () => {
  test('#Shorts is refused in own hashtags, and never appended even from an old file', () => {
    const p = { ...defaultPrefs(), text: { ...defaultPrefs().text, hashtags: ['#gaming', '#SHORTS'] } };
    assert.equal(checkPrefs(p).problems[0].key, 'hashtags');
    assert.match(checkPrefs(p).problems[0].text, /#Shorts/);
    const r = applyTextPrefs({ title: 'T', description: 'D', hashtags: ['#gaming'] }, { tone: 'hype', emoji: false, hashtags: ['#shorts', '#clutch'], footer: '' }, { style: STYLE });
    assert.deepEqual(r.hashtags, ['#gaming', '#clutch']);
  });

  test('control characters in the footer are refused (the post editor rule), and stripped if they come from an old file', () => {
    for (const bad of ['a\u0007b', 'tab\there', 'x\u007f']) {
      assert.equal(checkPrefs({ ...defaultPrefs(), text: { ...defaultPrefs().text, footer: bad } }).problems[0].key, 'footer', JSON.stringify(bad));
    }
    const r = applyTextPrefs({ title: 'T', description: 'D', hashtags: [] }, { tone: 'hype', emoji: false, hashtags: [], footer: 'a\u0007b' }, { style: STYLE });
    assert.equal(r.description, 'D\n\na b');
  });

  test('the composed text keeps the platform limits (data/posting/limits.json): a footer or hashtag that would pass them is left out', () => {
    const limits = loadLimits();
    const post = { title: 'T', description: 'x'.repeat(4990), tags: [], hashtags: ['#a'], target: 'youtube-video' };
    const r = applyTextPrefs(post, { tone: 'hype', emoji: false, hashtags: ['#clutch'], footer: 'Live most nights, every night' }, { style: STYLE, fits: limitsFit(post, limits) });
    assert.equal(r.description, post.description, 'the footer would pass 5000 bytes: left out');
    assert.deepEqual(r.hashtags, ['#a'], 'the hashtag would pass 5000 bytes too: left out');
    const small = { ...post, description: 'short' };
    const ok = applyTextPrefs(small, { tone: 'hype', emoji: false, hashtags: ['#clutch'], footer: 'Live' }, { style: STYLE, fits: limitsFit(small, limits) });
    assert.equal(ok.description, 'short\n\nLive'); assert.deepEqual(ok.hashtags, ['#a', '#clutch']);
  });
});
