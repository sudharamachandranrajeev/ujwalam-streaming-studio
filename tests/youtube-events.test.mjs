// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube live events per go-live (D386; D388: no feature flag, the toggle autoEvent decides): services/platform-connect/youtube-events.mjs and the
// studio-ui routes + go-live hook. A fake fetch stands in for Google and YouTube, an in-memory credential store for
// Windows Credential Manager: nothing reaches a real platform. Leak checks: the stream keys never appear in a result,
// an HTTP response, a log line or a file under the data folder.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../services/posting/oauth.mjs';
import { ERROR_TEXT, TARGETS, createMemoryStores } from '../services/platform-connect/index.mjs';
import { CHOICES_FILE, cleanTitle, createYoutubeEvents, readAutoEvent, readChoices, writeChoices } from '../services/platform-connect/youtube-events.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const KEY_H = 'zq7h-ev01-mock-hkey-0001';
const KEY_V = 'zq7h-ev02-mock-vkey-0002';
const KEY_OTHER = 'zq7h-ev03-mock-okey-0003';
const ACCESS = 'ya29.mockEventsAccessZZ9';
const REFRESH = '1//0mockEventsRefreshZZ9';
const SECRET_VALUES = [KEY_H, KEY_V, KEY_OTHER, ACCESS, REFRESH];
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-yte-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// ---- the fake YouTube ----
const TEMPLATE = {
  id: 'tplH0001', snippet: {
    title: 'Ranked grind tonight', description: 'Template description', actualStartTime: '2026-11-10T18:00:00Z',
    thumbnails: { high: { url: 'https://i.ytimg.com/vi/tplH0001/hqdefault_live.jpg' }, maxres: { url: 'https://i.ytimg.com/vi/tplH0001/maxresdefault_live.jpg' } },
  },
  status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, lifeCycleStatus: 'complete' },
  contentDetails: { enableDvr: true, enableEmbed: false, recordFromStart: true, latencyPreference: 'low', closedCaptionsType: 'closedCaptionsDisabled', enableAutoStart: false, monitorStream: { enableMonitorStream: true }, boundStreamId: 'should-not-copy', projection: '360' },
};
const TEMPLATE_V = { ...TEMPLATE, id: 'tplV0001', snippet: { ...TEMPLATE.snippet, title: 'Vertical template', actualStartTime: '2026-11-11T18:00:00Z' } };
const VIDEO = (id) => ({ id, snippet: { title: 'x', description: 'Video description', categoryId: '20', tags: ['codm', 'ranked'], defaultLanguage: 'en', defaultAudioLanguage: 'en-IN', channelTitle: 'not copied' }, status: { privacyStatus: 'unlisted', madeForKids: false } });

function fakeYoutube(over = {}) {
  const st = {
    calls: [], // { method, url, json, auth }
    broadcasts: [
      { id: 'old00001', snippet: { title: 'Older', publishedAt: '2026-10-01T10:00:00Z' }, status: { privacyStatus: 'private', lifeCycleStatus: 'complete' } },
      TEMPLATE, TEMPLATE_V,
      { id: 'bad id!', snippet: { title: 'Bad id' } },
      { id: 'sched001', snippet: { title: 'Scheduled', scheduledStartTime: '2026-11-12T18:00:00Z' }, status: { privacyStatus: 'public', lifeCycleStatus: 'created' } },
    ],
    streams: [
      { id: 'streamH1', cdn: { ingestionInfo: { streamName: KEY_H } } },
      { id: 'streamV1', cdn: { ingestionInfo: { streamName: KEY_V } } },
    ],
    nextId: 1, made: [], deleted: [],
    insertStatus: 200, bindStatus: 200, updateStatus: 200, thumbStatus: 200, thumbBytes: 1000, listStatus: 200, listReason: null,
    ...over,
  };
  const reply = (status, data) => new Response(status === 204 ? null : JSON.stringify(data ?? {}), { status, headers: { 'content-type': 'application/json' } });
  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    let json = null;
    if (typeof init.body === 'string' && String(init.headers?.['Content-Type'] ?? '').includes('json')) json = JSON.parse(init.body);
    st.calls.push({ method, url, json, auth: init.headers?.Authorization ?? null });
    const u = new URL(url);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: ACCESS, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube' });
    if (u.hostname === 'i.ytimg.com') return new Response(Buffer.alloc(st.thumbBytes, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith(`${UPLOAD}/thumbnails/set`)) return reply(st.thumbStatus, {});
    const p = url.slice(API.length);
    if (method === 'GET' && p.startsWith('/liveBroadcasts?') && u.searchParams.get('broadcastStatus') === 'all') {
      if (st.listStatus !== 200) return reply(st.listStatus, { error: { errors: [{ reason: st.listReason }] } });
      return reply(200, { items: st.broadcasts });
    }
    if (method === 'GET' && p.startsWith('/liveBroadcasts?')) return reply(200, { items: st.broadcasts.filter((b) => b.id === u.searchParams.get('id')) });
    if (method === 'GET' && p.startsWith('/videos?')) return reply(200, { items: [VIDEO(u.searchParams.get('id'))] });
    if (method === 'GET' && p.startsWith('/liveStreams?')) return reply(200, { items: st.streams });
    if (method === 'POST' && p.startsWith('/liveBroadcasts?')) {
      if (st.insertStatus !== 200) return reply(st.insertStatus, { error: { errors: [{ reason: st.insertReason ?? 'backendError' }] } });
      const id = `newbroad${st.nextId++}`; st.made.push(id); return reply(200, { id });
    }
    if (method === 'PUT' && p.startsWith('/videos?')) return reply(st.updateStatus, {});
    if (method === 'POST' && p.startsWith('/liveBroadcasts/bind?')) return reply(typeof st.bindStatus === 'function' ? st.bindStatus(u) : st.bindStatus, {});
    if (method === 'DELETE' && p.startsWith('/liveBroadcasts?')) { st.deleted.push(u.searchParams.get('id')); return reply(204); }
    return reply(404, {});
  }
  return { fetch, st };
}
const evFor = (yt, keys = { 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_V }, extra = {}) => createYoutubeEvents({
  fetchImpl: yt.fetch, accessToken: async () => ACCESS, readKey: async (ref) => keys[ref] ?? null, now: () => Date.parse('2026-11-15T12:00:00Z'), ...extra,
});
const noSecret = (text, where) => { for (const v of SECRET_VALUES) assert.ok(!String(text).includes(v), `a secret leaked into ${where}`); };

describe('listTemplates', () => {
  test('newest first by actual/scheduled/published time, bad ids dropped, plain shape, cached 5 minutes', async () => {
    const yt = fakeYoutube();
    let t = Date.parse('2026-11-15T12:00:00Z');
    const ev = evFor(yt, {}, { now: () => t });
    const list = await ev.listTemplates();
    assert.deepEqual(list.map((x) => x.id), ['sched001', 'tplV0001', 'tplH0001', 'old00001']);
    assert.deepEqual(Object.keys(list[0]).sort(), ['id', 'lifeCycle', 'privacy', 'title', 'when']);
    assert.equal(list[2].when, '2026-11-10T18:00:00.000Z');
    assert.equal(list[2].privacy, 'unlisted');
    const n = yt.st.calls.length;
    await ev.listTemplates();
    assert.equal(yt.st.calls.length, n, 'cached');
    t += 6 * 60_000;
    await ev.listTemplates();
    assert.equal(yt.st.calls.length, n + 1, 'cache ran out');
    await ev.listTemplates({ refresh: true });
    assert.equal(yt.st.calls.length, n + 2, 'refresh');
    assert.ok(yt.st.calls[0].url.includes('broadcastStatus=all&broadcastType=all&maxResults=50'));
  });
  test('at most 25; quota and 401 give codes, never bodies', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `b${String(i).padStart(4, '0')}`, snippet: { title: `T${i}`, publishedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() } }));
    assert.equal((await evFor(fakeYoutube({ broadcasts: many })).listTemplates()).length, 25);
    await assert.rejects(evFor(fakeYoutube({ listStatus: 403, listReason: 'quotaExceeded' })).listTemplates(), { code: 'youtube-quota' });
    let noted = 0;
    await assert.rejects(evFor(fakeYoutube({ listStatus: 401 }), {}, { onUnauthorized: () => { noted += 1; } }).listTemplates(), { code: 'youtube-unauthorized' });
    assert.equal(noted, 1);
    await assert.rejects(evFor(fakeYoutube({ listStatus: 403, listReason: 'liveStreamingNotEnabled' })).listTemplates(), { code: 'youtube-live-not-enabled' });
    await assert.rejects(evFor(fakeYoutube({ listStatus: 403, listReason: 'forbidden' })).listTemplates(), { code: 'youtube-forbidden' });
    await assert.rejects(evFor(fakeYoutube({ listStatus: 500 })).listTemplates(), { code: 'youtube-api-failed' });
  });
});

describe('findStreamId', () => {
  test('matches the stored key against the channel streams; the key is never in the result', async () => {
    const yt = fakeYoutube();
    const id = await evFor(yt).findStreamId('Ujwalam/stream/youtube-v');
    assert.equal(id, 'streamV1');
    noSecret(JSON.stringify(id), 'the result');
  });
  test('a key not on the channel: youtube-key-not-found with a plain message; no key: youtube-key-missing', async () => {
    const yt = fakeYoutube();
    const e = await evFor(yt, { 'Ujwalam/stream/youtube-h': KEY_OTHER }).findStreamId('Ujwalam/stream/youtube-h').catch((x) => x);
    assert.equal(e.code, 'youtube-key-not-found');
    assert.match(e.message, /Settings > Connections/);
    noSecret(`${e.message} ${JSON.stringify(e)}`, 'the error');
    await assert.rejects(evFor(yt, {}).findStreamId('Ujwalam/stream/youtube-h'), { code: 'youtube-key-missing' });
    await assert.rejects(evFor(yt).findStreamId('not/a/ref'), { code: 'youtube-key-missing' });
  });
});

describe('createEvent', () => {
  test('copies the whitelist from the template, auto-start/stop on, monitor stream off, binds to the matched stream', async () => {
    const yt = fakeYoutube();
    const r = await evFor(yt).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' });
    assert.deepEqual(r, { broadcastId: 'newbroad1', title: 'Ranked grind tonight', warnings: [] });
    const ins = yt.st.calls.find((c) => c.method === 'POST' && c.url.startsWith(`${API}/liveBroadcasts?`));
    assert.ok(ins.url.endsWith('part=snippet,status,contentDetails'));
    assert.deepEqual(ins.json, {
      snippet: { title: 'Ranked grind tonight', description: 'Template description', scheduledStartTime: '2026-11-15T12:00:00.000Z' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
      contentDetails: { enableAutoStart: true, enableAutoStop: true, monitorStream: { enableMonitorStream: false }, enableDvr: true, enableEmbed: false, recordFromStart: true, latencyPreference: 'low', closedCaptionsType: 'closedCaptionsDisabled' },
    });
    const upd = yt.st.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(upd.json, { id: 'newbroad1', snippet: { title: 'Ranked grind tonight', categoryId: '20', description: 'Template description', tags: ['codm', 'ranked'], defaultLanguage: 'en', defaultAudioLanguage: 'en-IN' } });
    const th = yt.st.calls.filter((c) => c.url.includes('i.ytimg.com'));
    assert.equal(th.length, 1);
    assert.ok(th[0].url.includes('maxresdefault'), 'the best size first');
    assert.equal(th[0].auth, null, 'no token sent to the image server');
    assert.ok(yt.st.calls.some((c) => c.url === `${UPLOAD}/thumbnails/set?videoId=newbroad1&uploadType=media`));
    const bind = yt.st.calls.find((c) => c.url.includes('/liveBroadcasts/bind'));
    assert.equal(bind.url, `${API}/liveBroadcasts/bind?id=newbroad1&streamId=streamH1&part=id,contentDetails`);
    assert.deepEqual(yt.st.deleted, []);
    noSecret(JSON.stringify(yt.st.calls.map((c) => [c.url, c.json])), 'a request URL or body');
  });
  test('title override is used; "<" or ">" or over 100 characters is refused before anything is made', async () => {
    const yt = fakeYoutube();
    const r = await evFor(yt).createEvent({ templateId: 'tplH0001', title: '  My own title  ', keyRef: 'Ujwalam/stream/youtube-h' });
    assert.equal(r.title, 'My own title');
    assert.equal(yt.st.calls.find((c) => c.method === 'POST' && c.url.startsWith(`${API}/liveBroadcasts?`)).json.snippet.title, 'My own title');
    const yt2 = fakeYoutube();
    await assert.rejects(evFor(yt2).createEvent({ templateId: 'tplH0001', title: 'a <b> title', keyRef: 'Ujwalam/stream/youtube-h' }), { code: 'youtube-bad-title' });
    await assert.rejects(evFor(yt2).createEvent({ templateId: 'tplH0001', title: 'x'.repeat(101), keyRef: 'Ujwalam/stream/youtube-h' }), { code: 'youtube-bad-title' });
    assert.equal(yt2.st.calls.length, 0);
    assert.equal(cleanTitle('ok'), 'ok');
    assert.equal(cleanTitle(''), null);
  });
  test('thumbnail: only https from i.ytimg.com; a failure or a too large file is a warning, never fatal', async () => {
    const off = fakeYoutube({ broadcasts: [{ ...TEMPLATE, snippet: { ...TEMPLATE.snippet, thumbnails: { maxres: { url: 'https://evil.example/x.jpg' } } } }] });
    const r1 = await evFor(off).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' });
    assert.equal(r1.warnings.length, 1);
    assert.ok(!off.st.calls.some((c) => c.url.includes('evil.example')), 'never downloaded');
    const http1 = fakeYoutube({ broadcasts: [{ ...TEMPLATE, snippet: { ...TEMPLATE.snippet, thumbnails: { maxres: { url: 'http://i.ytimg.com/x.jpg' } } } }] });
    assert.equal((await evFor(http1).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' })).warnings.length, 1);
    const big = fakeYoutube({ thumbBytes: 2 * 1024 * 1024 + 1 });
    const r2 = await evFor(big).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' });
    assert.equal(r2.warnings.length, 1);
    assert.ok(!big.st.calls.some((c) => c.url.startsWith(UPLOAD)), 'nothing uploaded');
    const unverified = fakeYoutube({ thumbStatus: 403 });
    const r3 = await evFor(unverified).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' });
    assert.match(r3.warnings[0], /verified channel/);
    assert.equal(r3.broadcastId, 'newbroad1');
    assert.deepEqual(unverified.st.deleted, []);
  });
  test('videos.update failure is a warning; bind failure deletes the new broadcast and throws', async () => {
    const upd = fakeYoutube({ updateStatus: 400 });
    const r = await evFor(upd).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' });
    assert.equal(r.warnings.length, 1);
    const bind = fakeYoutube({ bindStatus: 500 });
    await assert.rejects(evFor(bind).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' }), { code: 'youtube-api-failed' });
    assert.deepEqual(bind.st.deleted, ['newbroad1']);
  });
  test('quota at insert: youtube-quota, nothing to delete; a key not on the channel: nothing is made', async () => {
    const q = fakeYoutube({ insertStatus: 403, insertReason: 'quotaExceeded' });
    await assert.rejects(evFor(q).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' }), { code: 'youtube-quota' });
    assert.deepEqual(q.st.made, []);
    const k = fakeYoutube();
    await assert.rejects(evFor(k, { 'Ujwalam/stream/youtube-h': KEY_OTHER }).createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h' }), { code: 'youtube-key-not-found' });
    assert.deepEqual(k.st.made, []);
    await assert.rejects(evFor(k).createEvent({ templateId: 'gone0001', keyRef: 'Ujwalam/stream/youtube-h' }), { code: 'youtube-template-missing' });
  });
  test('every new code has a plain text', () => {
    for (const c of ['youtube-key-not-found', 'youtube-key-missing', 'youtube-quota', 'youtube-forbidden', 'youtube-template-missing', 'youtube-bad-title', 'youtube-events-off', 'youtube-not-signed-in', 'unknown-template']) assert.ok(ERROR_TEXT[c], c);
  });
});

describe('choice store', () => {
  test('sanitized on write and read; atomic file with version 1', () => {
    const d = mk();
    writeChoices(d, { 'youtube-h': { templateId: 'tplH0001', templateTitle: 'T\u0007', title: 'Mine' }, 'Bad Id': { templateId: 'x' }, 'youtube-v': { templateId: 'bad id' }, kick: { templateId: 'tplH0001', title: '<x>' } });
    const j = JSON.parse(readFileSync(path.join(d, CHOICES_FILE), 'utf8'));
    assert.equal(j.version, 1);
    assert.deepEqual(j.outputs, { 'youtube-h': { templateId: 'tplH0001', templateTitle: 'T ', title: 'Mine' }, kick: { templateId: 'tplH0001', templateTitle: '', title: null } });
    writeFileSync(path.join(d, CHOICES_FILE), 'not json');
    assert.deepEqual(readChoices(d), {});
    assert.deepEqual(readChoices(mk()), {});
  });
});

// ---- studio-ui routes and the go-live hook ----

const LAUNCH = 'k'.repeat(48);
const servers = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
const responses = [];
function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); responses.push(text); resolve({ status: res.statusCode, text, json() { return JSON.parse(text); } }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function login(port) {
  const r = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: `/login?k=${LAUNCH}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res); }).on('error', reject));
  const cookie = r.headers['set-cookie'][0].split(';')[0];
  const s = await raw(port, { url: '/ui/api/session', headers: { cookie } });
  return { cookie, csrf: s.json().csrf };
}
const get = (c, url) => raw(c.port, { url, headers: { cookie: c.a.cookie } });
const post = (c, route, body) => raw(c.port, {
  method: 'POST', url: route, body: JSON.stringify(body),
  headers: { cookie: c.a.cookie, origin: `http://127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': c.a.csrf },
});
function allFiles(dir) { return readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? allFiles(p) : [p]; }); }

async function boot({ signedIn = true, choices = null, yt = fakeYoutube(), keys = { 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_V }, planFile, hostWrap, hostAfter } = {}) {
  const dataDir = mk();
  if (choices) writeChoices(dataDir, choices);
  const mem = createMemoryStores({ [CLIENT_ID_TARGET]: 'mock-google-client.apps.example', [CLIENT_SECRET_TARGET]: 'mock-secret-zz9', ...(signedIn ? { [TARGETS.youtubeRefresh]: REFRESH } : {}), ...keys });
  const fake = createFakeHost({ outputsReady: true });
  const hostCalls = [];
  const host = {
    describe: () => fake.describe(),
    call: async (m, p) => { hostCalls.push(m); if (hostWrap) await hostWrap(m); const r = await fake.call(m, p); if (hostAfter) await hostAfter(m); return r; },
  };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const logs = [];
  const srv = createStudioServer({
    uiRoot: UI, core, host, launchKey: LAUNCH, dataDir, limits: { statusPollMs: 30 }, log: (m) => logs.push(String(m)), ...(planFile ? { livePlanFile: planFile } : {}),
    connect: { storeFor: mem.storeFor, fetchImpl: yt.fetch, sleep: async () => {}, browserOpen: async () => {} },
  });
  servers.push(srv);
  const { port } = await srv.listen();
  return { srv, port, a: await login(port), dataDir, mem, yt, logs, hostCalls };
}
const BOTH = { 'youtube-h': { templateId: 'tplH0001', templateTitle: 'Ranked grind tonight', title: null }, 'youtube-v': { templateId: 'tplV0001', templateTitle: 'Vertical template', title: 'V title' } };
const ytApiCalls = (c) => c.yt.st.calls.filter((x) => !x.url.startsWith('https://oauth2.'));
function leakCheck(c) {
  for (const r of responses) noSecret(r, 'an HTTP response');
  for (const l of c.logs) { noSecret(l, 'a log line'); assert.ok(!/Ranked grind|V title|Vertical template/.test(l), 'no titles in the log'); }
  for (const f of allFiles(c.dataDir)) noSecret(readFileSync(f, 'utf8'), f);
}

describe('studio-ui routes (D386)', () => {
  test('no flag at all: the flag is gone from data/flags.json and the routes work with no flag on', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    assert.equal(defs.find((f) => f.id === 'youtube-events'), undefined);
    const c = await boot();
    assert.equal((await get(c, '/ui/api/youtube/events')).status, 200);
    assert.equal((await post(c, '/ui/api/youtube/templates', {})).status, 200);
    assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'tplH0001' })).status, 200);
  });
  test('not signed in to YouTube: a start streams exactly as before (no YouTube call, no refusal)', async () => {
    const c = await boot({ signedIn: false });
    const s = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(s.verdict, 'allow');
    assert.equal(s.youtubeEvents, undefined);
    assert.ok(c.hostCalls.includes('stream.start'));
    assert.deepEqual(c.yt.st.calls, []);
    assert.equal((await post(c, '/ui/api/youtube/templates', {})).json().error, 'youtube-not-signed-in');
  });
  test('autoEvent off: a start makes no event and calls YouTube not at all; on by default; the choices stay', async () => {
    const c = await boot({ choices: BOTH });
    assert.equal((await get(c, '/ui/api/youtube/events')).json().autoEvent, true);
    assert.equal((await post(c, '/ui/api/youtube/event/auto', { on: false })).json().autoEvent, false);
    assert.equal((await post(c, '/ui/api/youtube/event/auto', { on: 'no' })).status, 400);
    assert.equal((await post(c, '/ui/api/youtube/event/auto', { on: false, x: 1 })).status, 400);
    const v = (await get(c, '/ui/api/youtube/events')).json();
    assert.equal(v.autoEvent, false);
    assert.equal(v.outputs[0].choice.templateId, 'tplH0001', 'the choices are kept');
    const s = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(s.verdict, 'allow');
    assert.equal(s.youtubeEvents, undefined);
    assert.deepEqual(c.yt.st.calls, []);
    assert.equal((await post(c, '/ui/api/youtube/event/auto', { on: true })).json().autoEvent, true);
    assert.equal(readAutoEvent(c.dataDir), true);
  });
  test('GET events lists the YouTube outputs of the plan only; templates; set and clear a choice', async () => {
    const c = await boot();
    const v = (await get(c, '/ui/api/youtube/events')).json();
    assert.equal(v.signedIn, true);
    assert.equal(v.autoEvent, true);
    assert.deepEqual(v.outputs, [
      { id: 'youtube-h', label: 'YouTube H', canvas: 'H', quality: '1080p', choice: null },
      { id: 'youtube-v', label: 'YouTube V', canvas: 'V', quality: '1080p', choice: null },
    ]);
    const t = (await post(c, '/ui/api/youtube/templates', { refresh: true })).json();
    assert.equal(t.templates[0].id, 'sched001');
    assert.equal((await post(c, '/ui/api/youtube/templates', { refresh: 'yes' })).status, 400);
    const s = (await post(c, '/ui/api/youtube/event/set', { output: 'youtube-v', templateId: 'tplV0001', title: 'My V' })).json();
    assert.equal(s.ok, true);
    assert.deepEqual(s.outputs[1].choice, { templateId: 'tplV0001', templateTitle: 'Vertical template', title: 'My V' });
    assert.equal(s.outputs[0].choice, null, 'H keeps its own (none)');
    assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'tplH0001', title: '<b>' })).json().error, 'youtube-bad-title');
    assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'unknown01' })).status, 404);
    assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'twitch', templateId: 'tplH0001' })).json().error, 'unknown-output');
    assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'tplH0001', extra: 1 })).status, 400);
    const cl = (await post(c, '/ui/api/youtube/event/set', { output: 'youtube-v', templateId: null })).json();
    assert.equal(cl.outputs[1].choice, null);
    leakCheck(c);
  });
  test('quality follows the key the plan streams with (D385 per-quality key)', async () => {
    const d = mk();
    const plan = path.join(d, 'plan.json');
    writeFileSync(plan, JSON.stringify({ targets: { 'youtube-h': { transport: 'rtmps', keyRef: 'Ujwalam/stream/youtube-h-1440p' }, 'youtube-v': { transport: 'rtmps', keyRef: 'Ujwalam/stream/youtube-v' }, kick: { transport: 'rtmps', keyRef: 'Ujwalam/stream/kick', serverRef: 'Ujwalam/stream/kick-server' } } }));
    const c = await boot({ planFile: plan });
    const v = (await get(c, '/ui/api/youtube/events')).json();
    assert.deepEqual(v.outputs.map((o) => [o.id, o.quality]), [['youtube-h', '1440p'], ['youtube-v', '1080p']]);
  });
});

describe('go-live hook (D386)', () => {
  test('a YouTube output without a choice: refused before anything is made, the host never asked', async () => {
    const c = await boot({ choices: { 'youtube-h': BOTH['youtube-h'] } });
    const r = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(r.verdict, 'refuse');
    assert.equal(r.reason, 'youtube-event-missing');
    assert.equal(r.detail, "No YouTube event template is picked for YouTube V. Pick a YouTube preset or event template in the YouTube window, or turn off 'New YouTube event at every Go live' there.");
    assert.deepEqual(ytApiCalls(c), []);
    assert.ok(!c.hostCalls.includes('stream.start'));
  });
  test('success: one event per YouTube output, in the answer with titles and warnings; then the stream starts', async () => {
    const c = await boot({ choices: BOTH });
    const r = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(r.verdict, 'allow', JSON.stringify(r));
    assert.deepEqual(r.youtubeEvents.map((e) => [e.output, e.title, e.warnings.length]).sort(), [['youtube-h', 'Ranked grind tonight', 0], ['youtube-v', 'V title', 0]]);
    assert.ok(c.hostCalls.includes('stream.start'));
    const binds = c.yt.st.calls.filter((x) => x.url.includes('/bind')).map((x) => new URL(x.url).searchParams.get('streamId')).sort();
    assert.deepEqual(binds, ['streamH1', 'streamV1']);
    assert.deepEqual(c.yt.st.deleted, []);
    const tasks = (await get(c, '/ui/api/tasks')).json().tasks;
    assert.ok(tasks.some((t) => t.title === 'Creating the YouTube events' && t.state === 'done'), JSON.stringify(tasks));
    leakCheck(c);
  });
  test('one output fails: the events already made are deleted, the start is refused naming the output', async () => {
    const c = await boot({ choices: BOTH, keys: { 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_OTHER } });
    const r = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(r.verdict, 'refuse');
    assert.equal(r.reason, 'youtube-event-failed');
    assert.match(r.detail, /^YouTube V: the YouTube event could not be made\. The stream key this output uses is not one/);
    assert.deepEqual(c.yt.st.made, ['newbroad1']);
    assert.deepEqual(c.yt.st.deleted, ['newbroad1']);
    assert.ok(!c.hostCalls.includes('stream.start'));
    leakCheck(c);
  });
  test('the host call fails after the events were made: they are deleted again', async () => {
    const c = await boot({ choices: BOTH, hostWrap: async (m) => { if (m === 'stream.start') throw Object.assign(new Error('boom'), { code: 'host-down' }); } });
    const r = await post(c, '/ui/api/host', { method: 'stream.start', params: {} });
    assert.equal(r.status, 502);
    for (let i = 0; i < 50 && c.yt.st.deleted.length < 2; i++) await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual([...c.yt.st.deleted].sort(), ['newbroad1', 'newbroad2']);
  });
  test('the host started but its answer was lost: the events of the outputs now live are kept (Codex review)', async () => {
    const c = await boot({ choices: BOTH, hostAfter: async (m) => { if (m === 'stream.start') throw Object.assign(new Error('lost'), { code: 'timeout' }); } });
    const r = await post(c, '/ui/api/host', { method: 'stream.start', params: {} });
    assert.equal(r.status, 502);
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(c.yt.st.deleted, [], 'a live output keeps its event');
    assert.ok(c.logs.some((l) => /0 event\(s\) deleted again, 2 kept/.test(l)), c.logs.join('\n'));
  });
  test('the host call fails and the output state is not clear: the events are kept (Codex re-review)', async () => {
    const c = await boot({ choices: BOTH, hostWrap: async (m) => { if (m === 'stream.start' || m === 'outputs.status') throw Object.assign(new Error('boom'), { code: 'host-down' }); } });
    const r = await post(c, '/ui/api/host', { method: 'stream.start', params: {} });
    assert.equal(r.status, 502);
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(c.yt.st.deleted, [], 'no sink-by-id idle state: nothing deleted');
  });
  test('a Twitch/Kick-only start makes no YouTube call', async () => {
    const d = mk();
    const plan = path.join(d, 'plan.json');
    writeFileSync(plan, JSON.stringify({ targets: { twitch: { transport: 'auto', keyRef: 'Ujwalam/stream/twitch', serverRef: 'Ujwalam/stream/twitch-server' }, kick: { transport: 'rtmps', keyRef: 'Ujwalam/stream/kick', serverRef: 'Ujwalam/stream/kick-server' } } }));
    const c = await boot({ planFile: plan });
    const r = (await post(c, '/ui/api/host', { method: 'stream.start', params: {} })).json();
    assert.equal(r.verdict, 'allow');
    assert.equal(r.youtubeEvents, undefined);
    assert.deepEqual(c.yt.st.calls, []);
  });
});
