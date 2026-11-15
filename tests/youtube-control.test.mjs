// SPDX-License-Identifier: GPL-3.0-or-later
// In-app YouTube control (D388 part B): services/platform-connect/youtube-control.mjs, services/studio-ui/youtube-routes.mjs,
// the retired `youtube-events` flag, the autoEvent toggle, choice overrides and youtube-live.json. A fake fetch stands in
// for Google and YouTube, an in-memory credential store for Windows Credential Manager: nothing reaches a real platform.
// Chat text and author names must never reach a log or a file.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../services/posting/oauth.mjs';
import { ERROR_TEXT, TARGETS, createMemoryStores } from '../services/platform-connect/index.mjs';
import { LIVE_FILE, createYoutubeControl, readLive, setLive, writeLive } from '../services/platform-connect/youtube-control.mjs';
import { CHOICES_FILE, createYoutubeEvents, readAutoEvent, readChoices, writeAutoEvent, writeChoices } from '../services/platform-connect/youtube-events.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const KEY_H = 'zq7h-ct01-mock-hkey-0001';
const KEY_V = 'zq7h-ct02-mock-vkey-0002';
const ACCESS = 'ya29.mockControlAccessZZ9';
const REFRESH = '1//0mockControlRefreshZZ9';
const CHAT_TEXT = 'zq-chat-secret-line-7731';
const CHAT_AUTHOR = 'zq-author-name-5520';
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ytc-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// ---- the fake YouTube ----
const baseBroadcast = (id, over = {}) => ({
  id, snippet: { title: `Title ${id}`, description: `Desc ${id}`, scheduledStartTime: '2026-11-14T10:00:00Z', publishedAt: '2026-11-14T09:00:00Z', liveChatId: `chat-${id}`, ...(over.snippet ?? {}) },
  status: { privacyStatus: 'unlisted', lifeCycleStatus: 'live', selfDeclaredMadeForKids: false, ...(over.status ?? {}) },
  contentDetails: { boundStreamId: `stream-${id}`, enableDvr: true, ...(over.contentDetails ?? {}) },
});
const TEMPLATE = { ...baseBroadcast('tplH0001', { status: { lifeCycleStatus: 'complete' } }), snippet: { title: 'Ranked grind tonight', description: 'Template description', actualStartTime: '2026-11-10T18:00:00Z', thumbnails: { maxres: { url: 'https://i.ytimg.com/vi/tplH0001/maxres.jpg' } } } };
const TEMPLATE_V = { ...TEMPLATE, id: 'tplV0001', snippet: { ...TEMPLATE.snippet, title: 'Vertical template', actualStartTime: '2026-11-11T18:00:00Z' } };
const VIDEO = (id) => ({ id, snippet: { title: 'x', description: 'Video description', categoryId: '20', tags: ['codm'], defaultLanguage: 'en' }, statistics: { likeCount: '42' }, liveStreamingDetails: { concurrentViewers: '17' } });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
const chatItem = (i, over = {}) => ({ id: `msg${i}`, snippet: { type: 'textMessageEvent', displayMessage: `${CHAT_TEXT} ${i}`, publishedAt: '2026-11-15T12:00:00Z', ...(over.snippet ?? {}) }, authorDetails: { displayName: CHAT_AUTHOR, ...(over.authorDetails ?? {}) } });

function fakeYoutube(over = {}) {
  const st = {
    calls: [],
    broadcasts: [TEMPLATE, TEMPLATE_V],
    streams: [{ id: 'streamH1', cdn: { ingestionInfo: { streamName: KEY_H } } }, { id: 'streamV1', cdn: { ingestionInfo: { streamName: KEY_V } } }],
    streamStatus: {}, // id -> { healthStatus }
    chat: [], poll: 5000, chatStatus: 200, chatReason: null, chatPosts: [],
    nextId: 1, made: [], deleted: [], transitions: [], puts: [],
    failCode: {}, // 'METHOD path-prefix' -> [status, reason]
    ...over,
  };
  const reply = (status, data) => new Response(status === 204 ? null : JSON.stringify(data ?? {}), { status, headers: { 'content-type': 'application/json' } });
  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    let json = null;
    if (typeof init.body === 'string' && String(init.headers?.['Content-Type'] ?? '').includes('json')) json = JSON.parse(init.body);
    st.calls.push({ method, url, json, auth: init.headers?.Authorization ?? null, body: init.body });
    const u = new URL(url);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: ACCESS, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube' });
    if (u.hostname === 'i.ytimg.com') return new Response(Buffer.alloc(1000, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith(`${UPLOAD}/thumbnails/set`)) { const f = st.failCode['POST thumbnails']; return f ? reply(f[0], { error: { errors: [{ reason: f[1] }] } }) : reply(200, {}); }
    const p = url.slice(API.length);
    const key = `${method} ${p.split('?')[0]}`;
    const f = st.failCode[key];
    if (f) return reply(f[0], { error: { errors: [{ reason: f[1] }] } });
    const byId = (list) => { const ids = (u.searchParams.get('id') ?? '').split(','); return list.filter((b) => ids.includes(b.id)); };
    if (method === 'GET' && p.startsWith('/channels?')) return reply(200, { items: [{ id: 'chan1', snippet: { title: 'My Channel', country: 'IN' } }] });
    if (method === 'GET' && p.startsWith('/videoCategories?')) return reply(200, { items: [{ id: '20', snippet: { title: 'Gaming', assignable: true } }, { id: '1', snippet: { title: 'Film', assignable: true } }, { id: '29', snippet: { title: 'Hidden', assignable: false } }] });
    if (method === 'GET' && p.startsWith('/liveBroadcasts?')) {
      if (u.searchParams.get('broadcastStatus')) {
        const want = u.searchParams.get('broadcastStatus');
        const list = want === 'all' ? st.broadcasts : st.broadcasts.filter((b) => (want === 'completed') === (b.status?.lifeCycleStatus === 'complete'));
        return reply(200, { items: list, nextPageToken: u.searchParams.get('pageToken') ? undefined : 'next-page-1' });
      }
      return reply(200, { items: byId(st.broadcasts) });
    }
    if (method === 'GET' && p.startsWith('/liveStreams?')) {
      if (u.searchParams.get('mine')) return reply(200, { items: st.streams });
      return reply(200, { items: byId(Object.entries(st.streamStatus).map(([id, v]) => ({ id, status: v }))) });
    }
    if (method === 'GET' && p.startsWith('/videos?')) return reply(200, { items: (u.searchParams.get('id') ?? '').split(',').map(VIDEO) });
    if (method === 'PUT' && (p.startsWith('/videos?') || p.startsWith('/liveBroadcasts?'))) { st.puts.push({ path: p.split('?')[0], json }); return reply(200, {}); }
    if (method === 'POST' && p.startsWith('/liveBroadcasts/bind?')) return reply(200, {});
    if (method === 'POST' && p.startsWith('/liveBroadcasts/transition?')) { st.transitions.push(u.searchParams.get('id')); return reply(200, {}); }
    if (method === 'POST' && p.startsWith('/liveBroadcasts?')) {
      const id = `newbroad${st.nextId++}`; st.made.push(id);
      st.broadcasts.push(baseBroadcast(id, { status: { lifeCycleStatus: 'ready' }, snippet: { title: json.snippet.title } }));
      return reply(200, { id });
    }
    if (method === 'DELETE' && p.startsWith('/liveBroadcasts?')) { st.deleted.push(u.searchParams.get('id')); return reply(204); }
    if (method === 'GET' && p.startsWith('/liveChatMessages?')) {
      if (st.chatStatus !== 200) return reply(st.chatStatus, { error: { errors: [{ reason: st.chatReason }] } });
      const from = Number(u.searchParams.get('pageToken') ?? 0);
      return reply(200, { items: st.chat.slice(from), nextPageToken: String(st.chat.length), pollingIntervalMillis: st.poll });
    }
    if (method === 'POST' && p.startsWith('/liveChatMessages?')) { st.chatPosts.push(json); return reply(200, { id: 'sent1' }); }
    return reply(404, {});
  }
  return { fetch, st };
}
const NOW0 = Date.parse('2026-11-15T12:00:00Z');
// A control service with a hand-driven clock and timers: nothing real is scheduled.
function ctl(yt, extra = {}) {
  const clock = { t: NOW0, timers: [] };
  const svc = createYoutubeControl({
    fetchImpl: yt.fetch, accessToken: async () => ACCESS, now: () => clock.t,
    setTimer: (fn, ms) => { const h = { fn, ms, at: clock.t + ms, dead: false }; clock.timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.dead = true; },
    ...extra,
  });
  const live = () => clock.timers.filter((h) => !h.dead);
  const fire = async () => { const h = live()[0]; assert.ok(h, 'a timer is waiting'); h.dead = true; clock.t = Math.max(clock.t, h.at); h.fn(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
  return { svc, clock, live, fire };
}
const apiCalls = (yt, re) => yt.st.calls.filter((c) => re.test(c.url));

describe('account, categories', () => {
  test('channel title cached 1 h; plain shape', async () => {
    const yt = fakeYoutube(); const { svc, clock } = ctl(yt);
    assert.deepEqual(await svc.account(), { channelTitle: 'My Channel', regionCode: 'IN' });
    await svc.account();
    assert.equal(apiCalls(yt, /\/channels\?/).length, 1);
    clock.t += 61 * 60_000;
    await svc.account();
    assert.equal(apiCalls(yt, /\/channels\?/).length, 2);
  });
  test('categories: assignable only, region of the channel, cached 24 h', async () => {
    const yt = fakeYoutube(); const { svc, clock } = ctl(yt);
    assert.deepEqual(await svc.categories(), [{ id: '20', title: 'Gaming' }, { id: '1', title: 'Film' }]);
    assert.ok(apiCalls(yt, /videoCategories/)[0].url.includes('regionCode=IN'));
    await svc.categories();
    assert.equal(apiCalls(yt, /videoCategories/).length, 1);
    clock.t += 25 * 3_600_000;
    await svc.categories();
    assert.equal(apiCalls(yt, /videoCategories/).length, 2);
  });
});

describe('live status', () => {
  const entries = [{ output: 'youtube-h', label: 'YouTube H', broadcastId: 'liveH001', title: 'T' }, { output: 'youtube-v', label: 'YouTube V', broadcastId: 'liveV001', title: 'T2' }];
  test('health, issues, viewers, likes, chat flag; cached 25 s; missing broadcast reported', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast('liveH001')], streamStatus: { 'stream-liveH001': { healthStatus: { status: 'bad', configurationIssues: [{ description: 'Bitrate is too low.', severity: 'error' }, { reason: 'x' }] } } } });
    const { svc, clock } = ctl(yt);
    const r = await svc.liveStatus(entries);
    assert.deepEqual(r.gone, ['liveV001']);
    const h = r.outputs[0];
    assert.deepEqual([h.output, h.broadcastId, h.lifeCycle, h.health, h.viewers, h.likes, h.chat], ['youtube-h', 'liveH001', 'live', { status: 'bad', issues: ['Bitrate is too low.', 'x'] }, 17, 42, true]);
    assert.equal(h.watchUrl, 'https://www.youtube.com/watch?v=liveH001');
    assert.equal(r.outputs[1].lifeCycle, null);
    const n = yt.st.calls.length;
    await svc.liveStatus(entries);
    assert.equal(yt.st.calls.length, n, 'cached');
    clock.t += 26_000;
    await svc.liveStatus(entries);
    assert.ok(yt.st.calls.length > n);
    assert.equal((await svc.liveStatus([])).outputs.length, 0);
  });
});

describe('details and thumbnail', () => {
  test('liveBroadcasts.update keeps scheduledStartTime and the kids flag; tags/category go through videos.update', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast('liveH001')] }); const { svc } = ctl(yt);
    const r = await svc.updateDetails({ broadcastId: 'liveH001', title: 'New title', description: 'New desc', privacy: 'public', tags: ['a', 'b'], categoryId: '1' });
    assert.deepEqual(r, { warnings: [] });
    const b = yt.st.puts.find((x) => x.path === '/liveBroadcasts');
    assert.deepEqual(b.json, { id: 'liveH001', snippet: { title: 'New title', description: 'New desc', scheduledStartTime: '2026-11-14T10:00:00.000Z' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } });
    const v = yt.st.puts.find((x) => x.path === '/videos');
    assert.deepEqual(v.json, { id: 'liveH001', snippet: { title: 'New title', categoryId: '1', description: 'New desc', tags: ['a', 'b'], defaultLanguage: 'en' } });
  });
  test('only a title: no videos.update; only tags: no liveBroadcasts.update and the old category is kept', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast('liveH001')] }); const { svc } = ctl(yt);
    await svc.updateDetails({ broadcastId: 'liveH001', title: 'Only title' });
    assert.deepEqual(yt.st.puts.map((x) => x.path), ['/liveBroadcasts']);
    yt.st.puts.length = 0;
    await svc.updateDetails({ broadcastId: 'liveH001', tags: [] });
    assert.deepEqual(yt.st.puts.map((x) => x.path), ['/videos']);
    assert.equal(yt.st.puts[0].json.snippet.categoryId, '20');
    assert.equal(yt.st.puts[0].json.snippet.tags, undefined, 'empty tags clear them');
  });
  test('videos.update failure is a warning; bad values, no fields, unknown broadcast, quota are errors with codes', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast('liveH001')], failCode: { 'PUT /videos': [400, 'invalidTags'] } }); const { svc } = ctl(yt);
    const r = await svc.updateDetails({ broadcastId: 'liveH001', tags: ['x'] });
    assert.equal(r.warnings.length, 1);
    await assert.rejects(svc.updateDetails({ broadcastId: 'liveH001' }), { code: 'bad-params' });
    await assert.rejects(svc.updateDetails({ broadcastId: 'liveH001', title: 'a <b>' }), { code: 'youtube-bad-title' });
    await assert.rejects(svc.updateDetails({ broadcastId: 'liveH001', privacy: 'secret' }), { code: 'bad-params' });
    await assert.rejects(svc.updateDetails({ broadcastId: 'bad id', title: 'x' }), { code: 'bad-params' });
    await assert.rejects(svc.updateDetails({ broadcastId: 'nothere1', title: 'x' }), { code: 'unknown-broadcast' });
    const q = fakeYoutube({ broadcasts: [baseBroadcast('liveH001')], failCode: { 'PUT /liveBroadcasts': [403, 'quotaExceeded'] } });
    await assert.rejects(ctl(q).svc.updateDetails({ broadcastId: 'liveH001', title: 'x' }), { code: 'youtube-quota' });
  });
  test('thumbnail: png and jpeg by magic bytes are uploaded with their type', async () => {
    const d = mk(); const yt = fakeYoutube(); const { svc } = ctl(yt);
    writeFileSync(path.join(d, 'a.bin'), PNG); writeFileSync(path.join(d, 'b.bin'), JPG);
    assert.deepEqual(await svc.setThumbnail({ broadcastId: 'liveH001', path: path.join(d, 'a.bin') }), { ok: true });
    await svc.setThumbnail({ broadcastId: 'liveH001', path: path.join(d, 'b.bin') });
    const ups = apiCalls(yt, /thumbnails\/set/);
    assert.equal(ups.length, 2);
    assert.equal(ups[0].url, `${UPLOAD}/thumbnails/set?videoId=liveH001&uploadType=media`);
  });
  test('thumbnail: wrong type, over 2 MB, relative path, missing file, folder: refused with youtube-bad-thumbnail, nothing uploaded', async () => {
    const d = mk(); const yt = fakeYoutube(); const { svc } = ctl(yt);
    writeFileSync(path.join(d, 'text.png'), 'this is not a picture at all');
    writeFileSync(path.join(d, 'big.png'), Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    // UNC, device and rooted-without-drive paths are refused before any file access (Codex review of D388).
    for (const p of [path.join(d, 'text.png'), path.join(d, 'big.png'), 'relative.png', path.join(d, 'nope.png'), d, '', null,
      '\\\\server\\share\\pic.png', '//server/share/pic.png', '\\\\?\\C:\\pic.png', '\\pic.png', '/pic.png', 'C:pic.png']) {
      await assert.rejects(svc.setThumbnail({ broadcastId: 'liveH001', path: p }), { code: 'youtube-bad-thumbnail' }, String(p));
    }
    assert.equal(apiCalls(yt, /thumbnails/).length, 0);
    const g = fakeYoutube({ failCode: { 'POST thumbnails': [403, 'forbidden'] } });
    writeFileSync(path.join(d, 'ok.png'), PNG);
    await assert.rejects(ctl(g).svc.setThumbnail({ broadcastId: 'liveH001', path: path.join(d, 'ok.png') }), { code: 'youtube-forbidden' });
  });
});

describe('broadcast list, End, Delete', () => {
  test('filter, paging, 60 s cache unless refresh; bad status / page refused; end and delete call YouTube', async () => {
    const yt = fakeYoutube(); const { svc, clock } = ctl(yt);
    const l = await svc.listBroadcasts({ status: 'all' });
    assert.deepEqual(l.items.map((i) => i.id), ['tplV0001', 'tplH0001']);
    assert.equal(l.next, 'next-page-1');
    assert.deepEqual(Object.keys(l.items[0]).sort(), ['id', 'lifeCycle', 'privacy', 'title', 'when']);
    await svc.listBroadcasts({ status: 'all' });
    assert.equal(apiCalls(yt, /broadcastStatus=all/).length, 1);
    await svc.listBroadcasts({ status: 'all', refresh: true });
    assert.equal(apiCalls(yt, /broadcastStatus=all/).length, 2);
    clock.t += 61_000;
    await svc.listBroadcasts({ status: 'all' });
    assert.equal(apiCalls(yt, /broadcastStatus=all/).length, 3);
    await svc.listBroadcasts({ status: 'completed', page: 'next-page-1' });
    assert.ok(apiCalls(yt, /broadcastStatus=completed/)[0].url.includes('pageToken=next-page-1'));
    await assert.rejects(svc.listBroadcasts({ status: 'bogus' }), { code: 'bad-params' });
    await assert.rejects(svc.listBroadcasts({ page: 'a b' }), { code: 'bad-params' });
    await svc.endBroadcast('tplH0001');
    await svc.deleteBroadcast('tplV0001');
    assert.deepEqual([yt.st.transitions, yt.st.deleted], [['tplH0001'], ['tplV0001']]);
    assert.ok(apiCalls(yt, /transition/)[0].url.includes('broadcastStatus=complete'));
    await assert.rejects(svc.endBroadcast('bad id'), { code: 'bad-params' });
  });
  test('lifeCycleOf: the state from one liveBroadcasts.list; unknown id = null; bad id refused', async () => {
    const yt = fakeYoutube({ broadcasts: [TEMPLATE, baseBroadcast('liveH001')] });
    const { svc } = ctl(yt);
    assert.equal(await svc.lifeCycleOf('tplH0001'), 'complete');
    assert.equal(await svc.lifeCycleOf('liveH001'), 'live');
    assert.equal(await svc.lifeCycleOf('gone0001'), null);
    await assert.rejects(svc.lifeCycleOf('bad id'), { code: 'bad-params' });
    assert.equal(apiCalls(yt, /liveBroadcasts\?part=id,status&id=/).length, 3);
  });
});

describe('live chat reader', () => {
  const B = 'liveH001';
  test('first ask reads once; asks inside the interval do not read again; the timer reads at max(15 s, pollingIntervalMillis)', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: [chatItem(1), chatItem(2)], poll: 5000 });
    const { svc, clock, live, fire } = ctl(yt);
    const r1 = await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(r1.live, true);
    assert.deepEqual(r1.messages.map((m) => m.id), ['msg1', 'msg2']);
    assert.equal(r1.cursor, '2');
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 1);
    clock.t += 3000;
    const r2 = await svc.chatRead({ output: 'youtube-h', broadcastId: B, after: 2 });
    assert.deepEqual(r2.messages, []);
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 1, 'a client ask 3 s later does not read YouTube');
    assert.equal(live().length, 1);
    assert.equal(live()[0].ms, 15_000, 'pollingIntervalMillis 5000 is raised to 15 s');
    yt.st.chat.push(chatItem(3), chatItem(4));
    clock.t += 3000;
    await svc.chatRead({ output: 'youtube-h', broadcastId: B, after: 2 });
    await fire();
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 2);
    assert.ok(apiCalls(yt, /liveChatMessages/)[1].url.includes('pageToken=2'), 'continues from nextPageToken');
    const r3 = await svc.chatRead({ output: 'youtube-h', broadcastId: B, after: 2 });
    assert.deepEqual(r3.messages.map((m) => m.id), ['msg3', 'msg4']);
    svc.close();
    assert.equal(live().length, 0);
  });
  test('a longer pollingIntervalMillis from YouTube wins', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: [chatItem(1)], poll: 40_000 });
    const { svc, live } = ctl(yt);
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(live()[0].ms, 40_000);
    svc.close();
  });
  test('no client for 60 s: the timer reads nothing and does not run again; the next ask starts it again', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: [chatItem(1)] });
    const { svc, clock, live, fire } = ctl(yt);
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    clock.t += 61_000;
    await fire();
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 1, 'idle: no read');
    assert.equal(live().length, 0, 'idle: no timer left');
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 2);
    assert.equal(live().length, 1);
    svc.close();
  });
  test('an event that is not live: live false, no chat read, found again at most every 25 s', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B, { status: { lifeCycleStatus: 'ready' } })], chat: [chatItem(1)] });
    const { svc, clock, live } = ctl(yt);
    const r = await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.deepEqual([r.live, r.messages.length], [false, 0]);
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(apiCalls(yt, /liveBroadcasts\?part=snippet,status&id=/).length, 1);
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 0);
    assert.equal(live().length, 0);
    yt.st.broadcasts[0].status.lifeCycleStatus = 'live';
    clock.t += 26_000;
    assert.equal((await svc.chatRead({ output: 'youtube-h', broadcastId: B })).live, true);
    svc.close();
  });
  test('chat ended (403 liveChatEnded): live false and the timer stops', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: [chatItem(1)] });
    const { svc, live, fire } = ctl(yt);
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    yt.st.chatStatus = 403; yt.st.chatReason = 'liveChatEnded';
    await fire();
    assert.equal(live().length, 0);
    assert.equal((await svc.chatRead({ output: 'youtube-h', broadcastId: B })).live, false);
    svc.close();
  });
  test('an API error waits 60 s and keeps reading; quota keeps the reader alive without a loop', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: [chatItem(1)] });
    const { svc, clock, live, fire } = ctl(yt);
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    yt.st.chatStatus = 500;
    clock.t += 3000;
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    await fire();
    assert.equal(live()[0].ms, 60_000);
    svc.close();
  });
  test('a failing event look-up is not retried at the ask rate: the next try waits 60 s', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: [chatItem(1)], failCode: { 'GET /liveBroadcasts': [500, 'backendError'] } });
    const { svc, clock, live } = ctl(yt);
    const look = () => apiCalls(yt, /liveBroadcasts\?part=snippet,status&id=/).length;
    const r1 = await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(r1.live, false);
    assert.equal(typeof r1.error, 'string');
    assert.equal(look(), 1);
    for (const step of [3000, 10_000, 20_000, 26_000]) { clock.t += step; await svc.chatRead({ output: 'youtube-h', broadcastId: B }); }
    assert.equal(look(), 1, '59 s of asks: no second look-up');
    assert.equal(apiCalls(yt, /liveChatMessages/).length, 0);
    assert.equal(live().length, 0);
    delete yt.st.failCode['GET /liveBroadcasts'];
    clock.t += 2000;
    const r2 = await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(look(), 2);
    assert.deepEqual([r2.live, r2.error, r2.messages.length], [true, undefined, 1]);
    svc.close();
  });
  test('the ring keeps 500 messages; the cursor keeps counting; plain text clean of control characters and direction marks', async () => {
    const many = Array.from({ length: 600 }, (_, i) => chatItem(i + 1));
    many[0] = chatItem(1, { snippet: { displayMessage: 'a\u0007b\u202ec<b>x</b>' }, authorDetails: { displayName: 'N\u200fm' } });
    many[1] = chatItem(2, { snippet: { type: 'superChatEvent', superChatDetails: { amountDisplayString: '$5.00' } } });
    many[2] = chatItem(3, { snippet: { type: 'newSponsorEvent' } });
    many[3] = chatItem(4, { snippet: { type: 'somethingNew' } });
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: many });
    const { svc } = ctl(yt);
    const first = await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal(first.cursor, '600');
    assert.equal(first.messages.length, 500);
    assert.equal(first.messages[0].id, 'msg101', 'the oldest 100 were dropped');
    const all = await svc.chatRead({ output: 'youtube-h', broadcastId: B, after: 0 });
    assert.equal(all.messages.length, 500);
    // the first four are outside the ring now; read them with a fresh reader limited to 4 messages
    const yt2 = fakeYoutube({ broadcasts: [baseBroadcast(B)], chat: many.slice(0, 4) });
    const r = await ctl(yt2).svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.deepEqual(r.messages.map((m) => m.kind), ['text', 'superChat', 'membership', 'other']);
    assert.equal(r.messages[0].text.includes('\u0007'), false);
    assert.ok(!/[\u202e\u200f]/.test(r.messages[0].text + r.messages[0].author));
    assert.equal(r.messages[0].text.includes('<b>x</b>'), true, 'kept as plain text, never interpreted');
    assert.equal(r.messages[1].amount, '$5.00');
    assert.deepEqual(Object.keys(r.messages[0]).sort(), ['at', 'author', 'id', 'kind', 'text']);
    svc.close();
  });
  test('another event on the same output starts a fresh reader', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B), baseBroadcast('liveH002')], chat: [chatItem(1)] });
    const { svc, live } = ctl(yt);
    await svc.chatRead({ output: 'youtube-h', broadcastId: B });
    assert.equal((await svc.chatRead({ output: 'youtube-h', broadcastId: 'liveH002' })).cursor, '1');
    assert.equal(live().length, 1, 'only the newest reader has a timer');
    svc.close();
  });
  test('send: 1..200 plain characters into the live chat; not live and bad text are refused', async () => {
    const yt = fakeYoutube({ broadcasts: [baseBroadcast(B), baseBroadcast('liveH003', { status: { lifeCycleStatus: 'ready' } })] });
    const { svc } = ctl(yt);
    assert.deepEqual(await svc.chatSend({ broadcastId: B, text: '  hello there  ' }), { ok: true });
    assert.deepEqual(yt.st.chatPosts[0], { snippet: { liveChatId: `chat-${B}`, type: 'textMessageEvent', textMessageDetails: { messageText: 'hello there' } } });
    await assert.rejects(svc.chatSend({ broadcastId: 'liveH003', text: 'hi' }), { code: 'youtube-chat-unavailable' });
    for (const t of ['', '   ', 'x'.repeat(201), 'a\nb', 5, null]) await assert.rejects(svc.chatSend({ broadcastId: B, text: t }), { code: 'bad-params' });
    assert.equal(yt.st.chatPosts.length, 1);
    assert.equal((await svc.chatSend({ broadcastId: B, text: 'x'.repeat(200) })).ok, true);
  });
});

describe('choice file: overrides, autoEvent, createEvent', () => {
  test('overrides are sanitized and kept; autoEvent default true and kept across writeChoices', () => {
    const d = mk();
    assert.equal(readAutoEvent(d), true);
    writeChoices(d, { 'youtube-h': { templateId: 'tplH0001', templateTitle: 'T', title: null, description: 'Line 1\nLine 2', privacy: 'public', tags: [' a ', 'b'], categoryId: '20' }, 'youtube-v': { templateId: 'tplV0001', description: '<bad>', privacy: 'secret', tags: ['<x>'], categoryId: 'abc' } });
    assert.deepEqual(readChoices(d)['youtube-h'], { templateId: 'tplH0001', templateTitle: 'T', title: null, description: 'Line 1\nLine 2', privacy: 'public', tags: ['a', 'b'], categoryId: '20' });
    assert.deepEqual(readChoices(d)['youtube-v'], { templateId: 'tplV0001', templateTitle: '', title: null });
    writeAutoEvent(d, false);
    assert.equal(readAutoEvent(d), false);
    writeChoices(d, readChoices(d));
    assert.equal(readAutoEvent(d), false, 'writeChoices keeps the toggle');
    assert.equal(JSON.parse(readFileSync(path.join(d, CHOICES_FILE), 'utf8')).version, 1);
  });
  test('createEvent uses the overrides instead of the template values; a bad one stops before anything is made', async () => {
    const yt = fakeYoutube();
    const ev = createYoutubeEvents({ fetchImpl: yt.fetch, accessToken: async () => ACCESS, readKey: async () => KEY_H, now: () => NOW0 });
    const r = await ev.createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h', description: 'Mine', privacy: 'public', tags: ['t1', 't2'], categoryId: '1' });
    assert.deepEqual(r.warnings, []);
    const ins = yt.st.calls.find((c) => c.method === 'POST' && c.url.startsWith(`${API}/liveBroadcasts?`));
    assert.equal(ins.json.snippet.description, 'Mine');
    assert.equal(ins.json.status.privacyStatus, 'public');
    const put = yt.st.puts.find((x) => x.path === '/videos');
    assert.deepEqual([put.json.snippet.categoryId, put.json.snippet.tags, put.json.snippet.description], ['1', ['t1', 't2'], 'Mine']);
    const yt2 = fakeYoutube();
    const ev2 = createYoutubeEvents({ fetchImpl: yt2.fetch, accessToken: async () => ACCESS, readKey: async () => KEY_H, now: () => NOW0 });
    await assert.rejects(ev2.createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h', privacy: 'secret' }), { code: 'youtube-bad-choice' });
    assert.equal(yt2.st.calls.length, 0);
  });
  test('an empty description and an empty tag list are real choices: kept in the file and used, not the template values', async () => {
    const d = mk();
    writeChoices(d, { 'youtube-h': { templateId: 'tplH0001', templateTitle: 'T', title: null, description: '', tags: [] } });
    assert.deepEqual(readChoices(d)['youtube-h'], { templateId: 'tplH0001', templateTitle: 'T', title: null, description: '', tags: [] });
    const yt = fakeYoutube();
    const ev = createYoutubeEvents({ fetchImpl: yt.fetch, accessToken: async () => ACCESS, readKey: async () => KEY_H, now: () => NOW0 });
    await ev.createEvent({ templateId: 'tplH0001', keyRef: 'Ujwalam/stream/youtube-h', description: '', tags: [] });
    const ins = yt.st.calls.find((c) => c.method === 'POST' && c.url.startsWith(`${API}/liveBroadcasts?`));
    assert.equal(ins.json.snippet.description, '', 'not the template description');
    const put = yt.st.puts.find((x) => x.path === '/videos');
    if (put) assert.ok(!put.json.snippet.tags?.length, 'not the template tags');
  });
  test('every new code has a plain text', () => {
    for (const c of ['youtube-bad-choice', 'youtube-signin-unreadable', 'youtube-not-idle', 'youtube-bad-thumbnail', 'youtube-chat-unavailable', 'unknown-broadcast', 'bad-params']) assert.ok(ERROR_TEXT[c], c);
    assert.ok(!/flag/i.test(ERROR_TEXT['youtube-quota']) && !/flag/i.test(ERROR_TEXT['youtube-events-off']));
  });
});

describe('youtube-live.json', () => {
  test('atomic write; sanitized; setLive merges; unreadable = none', () => {
    const d = mk();
    setLive(d, [{ output: 'youtube-h', broadcastId: 'abc12345', title: 'T\u0007' }], '2026-11-15T12:00:00.000Z');
    setLive(d, [{ output: 'youtube-v', broadcastId: 'def12345', title: 'V' }, { output: 'Bad Out', broadcastId: 'x1', title: 'x' }], '2026-11-15T12:01:00.000Z');
    const j = JSON.parse(readFileSync(path.join(d, LIVE_FILE), 'utf8'));
    assert.equal(j.version, 1);
    assert.deepEqual(Object.keys(j.outputs).sort(), ['youtube-h', 'youtube-v']);
    assert.deepEqual(j.outputs['youtube-h'], { broadcastId: 'abc12345', title: 'T ', madeAt: '2026-11-15T12:00:00.000Z' });
    assert.equal(existsSync(path.join(d, `${LIVE_FILE}.tmp`)), false);
    writeFileSync(path.join(d, LIVE_FILE), 'not json');
    assert.deepEqual(readLive(d), {});
    writeLive(d, { 'youtube-h': { broadcastId: 'bad id' } });
    assert.deepEqual(readLive(d), {});
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
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); responses.push(t); resolve({ status: res.statusCode, text: t, json() { return JSON.parse(t); } }); });
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

async function boot({ signedIn = true, choices = null, yt = fakeYoutube(), hostWrap, planFile, refreshUnreadable = null } = {}) {
  const dataDir = mk();
  if (choices) writeChoices(dataDir, choices);
  const mem0 = createMemoryStores({ [CLIENT_ID_TARGET]: 'mock-google-client.apps.example', [CLIENT_SECRET_TARGET]: 'mock-secret-zz9', ...(signedIn ? { [TARGETS.youtubeRefresh]: REFRESH } : {}), 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_V });
  // refreshUnreadable(): true = the credential store fails to read the YouTube sign-in (a locked or broken store).
  const mem = { ...mem0, storeFor: (t) => { const s = mem0.storeFor(t); return t === TARGETS.youtubeRefresh && refreshUnreadable ? { ...s, get: async () => { if (refreshUnreadable()) throw new Error('store-locked'); return s.get(); } } : s; } };
  const fake = createFakeHost({ outputsReady: true });
  const hostCalls = [];
  const host = { describe: () => fake.describe(), call: async (m, p) => { hostCalls.push(m); if (hostWrap) await hostWrap(m); return fake.call(m, p); } };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const logs = [];
  const opened = [];
  const srv = createStudioServer({
    uiRoot: UI, core, host, launchKey: LAUNCH, dataDir, limits: { statusPollMs: 30 }, log: (m) => logs.push(String(m)), ...(planFile ? { livePlanFile: planFile } : {}),
    connect: { storeFor: mem.storeFor, fetchImpl: yt.fetch, sleep: async () => {}, browserOpen: async (u) => { opened.push(u); } },
  });
  servers.push(srv);
  const { port } = await srv.listen();
  return { srv, port, a: await login(port), dataDir, mem, yt, logs, hostCalls, opened, fake };
}
const BOTH = { 'youtube-h': { templateId: 'tplH0001', templateTitle: 'Ranked grind tonight', title: null }, 'youtube-v': { templateId: 'tplV0001', templateTitle: 'Vertical template', title: 'V title' } };
const goLive = (c) => post(c, '/ui/api/host', { method: 'stream.start', params: {} });

describe('no flag, autoEvent, overrides, youtube-live.json at the go-live hook', () => {
  test('no flag is on and the routes are there; flags.json has no youtube-events', async () => {
    const defs = JSON.parse(readFileSync(path.join(REPO, 'data', 'flags.json'), 'utf8')).flags;
    assert.equal(defs.some((f) => f.id === 'youtube-events'), false);
    const c = await boot();
    assert.equal((await get(c, '/ui/api/youtube/events')).status, 200);
    assert.equal((await get(c, '/ui/api/youtube/account')).status, 200);
    assert.equal((await post(c, '/ui/api/youtube/templates', {})).status, 200);
  });
  test('go live with no YouTube sign-in: no YouTube call at all; with autoEvent off: no event made', async () => {
    const c = await boot({ signedIn: false });
    const s = (await goLive(c)).json();
    assert.equal(s.verdict, 'allow');
    assert.equal(s.youtubeEvents, undefined);
    assert.deepEqual(c.yt.st.calls, []);
    assert.equal(existsSync(path.join(c.dataDir, LIVE_FILE)), false);
    const d = await boot({ choices: BOTH });
    await post(d, '/ui/api/youtube/event/auto', { on: false });
    const s2 = (await goLive(d)).json();
    assert.equal(s2.verdict, 'allow');
    assert.deepEqual(d.yt.st.calls, []);
    assert.equal(existsSync(path.join(d.dataDir, LIVE_FILE)), false);
  });
  test('signed in, autoEvent on, no template: the refusal keeps its reason and has the new text (no flag mentioned)', async () => {
    const c = await boot();
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'refuse');
    assert.equal(r.reason, 'youtube-event-missing');
    assert.equal(r.detail, "No YouTube event template is picked for YouTube H and YouTube V. Pick a YouTube preset or event template in the YouTube window, or turn off 'New YouTube event at every Go live' there.");
    assert.ok(!c.hostCalls.includes('stream.start'));
    assert.equal(existsSync(path.join(c.dataDir, LIVE_FILE)), false, 'no file on a refusal');
  });
  test('the sign-in cannot be read (store error): Go live is refused, not streamed without the event; autoEvent off streams', async () => {
    let broken = true;
    const c = await boot({ choices: BOTH, refreshUnreadable: () => broken });
    const r = (await goLive(c)).json();
    assert.deepEqual([r.verdict, r.reason], ['refuse', 'youtube-signin-unknown']);
    assert.ok(!/flag/i.test(r.detail));
    assert.ok(!c.hostCalls.includes('stream.start'));
    assert.deepEqual(c.yt.st.made, []);
    assert.equal(existsSync(path.join(c.dataDir, LIVE_FILE)), false);
    await post(c, '/ui/api/youtube/event/auto', { on: false });
    assert.equal((await goLive(c)).json().verdict, 'allow', 'with autoEvent off the sign-in is not read at all');
    assert.deepEqual(c.yt.st.made, []);
    broken = false;
  });
  test('event/set overrides are validated, stored, shown, and used by the go-live event', async () => {
    const c = await boot();
    for (const bad of [{ description: 5 }, { description: '<x>' }, { privacy: 'secret' }, { tags: 'a' }, { tags: ['<x>'] }, { tags: Array(31).fill('a') }, { categoryId: 'x1' }, { extra: 1 }]) {
      assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'tplH0001', ...bad })).status, 400, JSON.stringify(bad));
    }
    const ov = { description: 'My description', privacy: 'public', tags: ['one', 'two'], categoryId: '1' };
    const s = (await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'tplH0001', ...ov })).json();
    assert.equal(s.ok, true);
    assert.deepEqual(s.outputs[0].choice, { templateId: 'tplH0001', templateTitle: 'Ranked grind tonight', title: null, ...ov });
    await post(c, '/ui/api/youtube/event/set', { output: 'youtube-v', templateId: 'tplV0001' });
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'allow', JSON.stringify(r));
    const inserts = c.yt.st.calls.filter((x) => x.method === 'POST' && x.url.startsWith(`${API}/liveBroadcasts?`));
    assert.equal(inserts.length, 2);
    const h = inserts.find((x) => x.json.snippet.description === 'My description');
    assert.ok(h, 'the H event has the override description');
    assert.equal(h.json.status.privacyStatus, 'public');
    assert.equal(inserts.filter((x) => x.json.snippet.description === 'Template description').length, 1, 'V keeps the template description');
    const put = c.yt.st.puts.find((x) => x.json.snippet.categoryId === '1');
    assert.deepEqual(put.json.snippet.tags, ['one', 'two']);
    const cleared = (await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'tplH0001' })).json();
    assert.deepEqual(cleared.outputs[0].choice, { templateId: 'tplH0001', templateTitle: 'Ranked grind tonight', title: null });
  });
  test('an accepted start writes youtube-live.json with both events; a failed event writes nothing', async () => {
    const c = await boot({ choices: BOTH });
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'allow');
    const j = JSON.parse(readFileSync(path.join(c.dataDir, LIVE_FILE), 'utf8'));
    assert.equal(j.version, 1);
    assert.deepEqual(Object.keys(j.outputs).sort(), ['youtube-h', 'youtube-v']);
    assert.deepEqual(Object.values(j.outputs).map((e) => e.broadcastId).sort(), [...c.yt.st.made].sort());
    assert.ok(Object.values(j.outputs).every((e) => !Number.isNaN(Date.parse(e.madeAt))));
    const bad = fakeYoutube({ failCode: { 'POST /liveBroadcasts': [500, 'backendError'] } });
    const d = await boot({ choices: BOTH, yt: bad });
    assert.equal((await goLive(d)).json().verdict, 'refuse');
    assert.equal(existsSync(path.join(d.dataDir, LIVE_FILE)), false);
    const e = await boot({ choices: BOTH, hostWrap: async (m) => { if (m === 'stream.start') throw Object.assign(new Error('boom'), { code: 'host-down' }); } });
    assert.equal((await goLive(e)).status, 502);
    assert.equal(existsSync(path.join(e.dataDir, LIVE_FILE)), false, 'a start that failed at the host writes nothing');
  });
});

describe('routes', () => {
  test('account: signed in with the channel title; signed out: canSignIn from the Google client', async () => {
    const c = await boot();
    assert.deepEqual((await get(c, '/ui/api/youtube/account')).json(), { signedIn: true, canSignIn: true, channelTitle: 'My Channel' });
    const d = await boot({ signedIn: false });
    assert.deepEqual((await get(d, '/ui/api/youtube/account')).json(), { signedIn: false, canSignIn: true, channelTitle: null });
    assert.deepEqual(d.yt.st.calls, []);
  });
  test('signin starts the existing platform-connect YouTube sign-in; a second one is refused while it runs', async () => {
    const c = await boot();
    const r = await post(c, '/ui/api/youtube/signin', {});
    assert.equal(r.status, 200, r.text);
    const j = r.json();
    assert.equal(j.started, true);
    assert.match(j.job.id, /^[0-9a-f]{32}$/);
    assert.equal((await post(c, '/ui/api/youtube/signin', {})).json().error, 'sign-in-busy');
    assert.equal((await post(c, '/ui/api/youtube/signin', { x: 1 })).status, 400);
    assert.equal((await get(c, '/ui/api/connect')).status, 404, 'the platform-connect page stays behind its own flag');
  });
  test('every other route needs the sign-in: 401 with a plain message', async () => {
    const c = await boot({ signedIn: false });
    for (const [m, u, b] of [['G', '/ui/api/youtube/categories'], ['G', '/ui/api/youtube/chat?output=youtube-h'], ['G', '/ui/api/youtube/broadcasts'], ['P', '/ui/api/youtube/details', { broadcastId: 'abc12345', title: 'x' }],
      ['P', '/ui/api/youtube/thumbnail', { broadcastId: 'abc12345', path: 'C:\\x.png' }], ['P', '/ui/api/youtube/chat/send', { output: 'youtube-h', text: 'hi' }], ['P', '/ui/api/youtube/broadcast/end', { id: 'abc12345' }], ['P', '/ui/api/youtube/broadcast/delete', { id: 'abc12345' }]]) {
      const r = m === 'G' ? await get(c, u) : await post(c, u, b);
      assert.equal(r.status, 401, u);
      assert.equal(r.json().error, 'youtube-not-signed-in');
      assert.ok(r.json().message.length > 10);
    }
    assert.deepEqual(c.yt.st.calls, []);
  });
  test('categories, broadcasts (current flag, filter, paging), bad params', async () => {
    const c = await boot();
    assert.deepEqual((await get(c, '/ui/api/youtube/categories')).json().categories, [{ id: '20', title: 'Gaming' }, { id: '1', title: 'Film' }]);
    setLive(c.dataDir, [{ output: 'youtube-h', broadcastId: 'tplH0001', title: 'x' }], new Date().toISOString());
    const b = (await get(c, '/ui/api/youtube/broadcasts?status=all')).json();
    assert.deepEqual(b.items.map((i) => [i.id, i.current]), [['tplV0001', false], ['tplH0001', true]]);
    assert.equal(b.next, 'next-page-1');
    assert.equal((await get(c, '/ui/api/youtube/broadcasts?status=completed&page=next-page-1')).status, 200);
    for (const u of ['?status=nope', '?page=a%20b', '?x=1', '?refresh=2', '?status=all&status=all']) assert.equal((await get(c, `/ui/api/youtube/broadcasts${u}`)).status, 400, u);
  });
  test('details and thumbnail routes: happy path and bad params', async () => {
    const c = await boot();
    c.yt.st.broadcasts.push(baseBroadcast('liveH001'));
    const ok = (await post(c, '/ui/api/youtube/details', { broadcastId: 'liveH001', title: 'New', privacy: 'public', tags: ['x'], categoryId: '1', description: 'D' })).json();
    assert.deepEqual(ok, { ok: true, warnings: [] });
    for (const b of [{ broadcastId: 'liveH001' }, { title: 'x' }, { broadcastId: 'bad id', title: 'x' }, { broadcastId: 'liveH001', title: 5 }, { broadcastId: 'liveH001', description: '<x>' }, { broadcastId: 'liveH001', privacy: 'x' },
      { broadcastId: 'liveH001', tags: 'x' }, { broadcastId: 'liveH001', categoryId: 'x' }, { broadcastId: 'liveH001', title: 'x', extra: 1 }]) assert.equal((await post(c, '/ui/api/youtube/details', b)).status, 400, JSON.stringify(b));
    assert.equal((await post(c, '/ui/api/youtube/details', { broadcastId: 'liveH001', title: 'a <b>' })).json().error, 'youtube-bad-title');
    assert.equal((await post(c, '/ui/api/youtube/details', { broadcastId: 'gone0001', title: 'x' })).status, 404);
    const d = mk();
    writeFileSync(path.join(d, 'pic.png'), PNG); writeFileSync(path.join(d, 'no.png'), 'text');
    assert.deepEqual((await post(c, '/ui/api/youtube/thumbnail', { broadcastId: 'liveH001', path: path.join(d, 'pic.png') })).json(), { ok: true });
    assert.equal((await post(c, '/ui/api/youtube/thumbnail', { broadcastId: 'liveH001', path: path.join(d, 'no.png') })).json().error, 'youtube-bad-thumbnail');
    assert.equal((await post(c, '/ui/api/youtube/thumbnail', { broadcastId: 'liveH001', path: path.join(d, 'pic.png'), x: 1 })).status, 400);
    assert.equal((await post(c, '/ui/api/youtube/thumbnail', { broadcastId: 'liveH001' })).status, 400);
    assert.equal((await get(c, '/ui/api/youtube/details')).status, 405, 'a GET on a POST route is not served');
  });
  test('live: statuses of the current events; complete events are dropped from the file; nothing current = no YouTube call', async () => {
    const c = await boot({ choices: BOTH });
    assert.deepEqual((await get(c, '/ui/api/youtube/live')).json().outputs, []);
    assert.deepEqual(c.yt.st.calls, []);
    assert.equal((await goLive(c)).json().verdict, 'allow');
    const mine = readLive(c.dataDir);
    const hId = mine['youtube-h'].broadcastId;
    c.yt.st.broadcasts.find((b) => b.id === hId).status.lifeCycleStatus = 'live';
    c.yt.st.streamStatus[`stream-${hId}`] = { healthStatus: { status: 'good' } };
    const l = (await get(c, '/ui/api/youtube/live?refresh=1')).json();
    assert.equal(l.outputs.length, 2);
    const h = l.outputs.find((o) => o.output === 'youtube-h');
    assert.deepEqual([h.label, h.lifeCycle, h.health.status, h.viewers, h.likes, h.chat], ['YouTube H', 'live', 'good', 17, 42, true]);
    assert.deepEqual(Object.keys(readLive(c.dataDir)).sort(), ['youtube-h', 'youtube-v']);
    c.yt.st.broadcasts.find((b) => b.id === hId).status.lifeCycleStatus = 'complete';
    await get(c, '/ui/api/youtube/live?refresh=1');
    assert.deepEqual(Object.keys(readLive(c.dataDir)), ['youtube-v'], 'the complete event is dropped from the current list');
    assert.equal((await get(c, '/ui/api/youtube/live?refresh=7')).status, 400);
  });
  test('chat: messages and cursor, send, no current event; the chat text and author reach no log and no file', async () => {
    const c = await boot({ choices: BOTH });
    assert.equal((await goLive(c)).json().verdict, 'allow');
    const hId = readLive(c.dataDir)['youtube-h'].broadcastId;
    c.yt.st.broadcasts.find((b) => b.id === hId).status.lifeCycleStatus = 'live';
    c.yt.st.chat = [chatItem(1), chatItem(2)];
    const r = (await get(c, '/ui/api/youtube/chat?output=youtube-h')).json();
    assert.equal(r.live, true);
    assert.deepEqual(r.messages.map((m) => m.text), [`${CHAT_TEXT} 1`, `${CHAT_TEXT} 2`]);
    assert.equal(r.cursor, '2');
    assert.deepEqual((await get(c, `/ui/api/youtube/chat?output=youtube-h&after=${r.cursor}`)).json().messages, []);
    assert.equal((await post(c, '/ui/api/youtube/chat/send', { output: 'youtube-h', text: 'hello' })).json().ok, true);
    assert.equal(c.yt.st.chatPosts[0].snippet.liveChatId, `chat-${hId}`);
    assert.equal((await post(c, '/ui/api/youtube/chat/send', { output: 'youtube-h', text: '' })).status, 400);
    assert.equal((await post(c, '/ui/api/youtube/chat/send', { output: 'youtube-h', text: 'x'.repeat(201) })).status, 400);
    assert.equal((await post(c, '/ui/api/youtube/chat/send', { output: 'youtube-h', text: 'a', extra: 1 })).status, 400);
    assert.equal((await post(c, '/ui/api/youtube/chat/send', { output: 'twitch', text: 'a' })).json().error, 'youtube-chat-unavailable');
    assert.deepEqual((await get(c, '/ui/api/youtube/chat?output=twitch')).json(), { messages: [], cursor: '0', live: false });
    for (const u of ['', '?output=Bad%20Out', '?output=youtube-h&after=x', '?output=youtube-h&x=1']) assert.equal((await get(c, `/ui/api/youtube/chat${u}`)).status, 400, u);
    for (const l of c.logs) assert.ok(!l.includes(CHAT_TEXT) && !l.includes(CHAT_AUTHOR) && !l.includes('hello'), 'chat text, author or sent text in a log line');
    assert.ok(c.logs.some((l) => /youtube: chat message sent/.test(l)), 'counts-only line is logged');
    for (const l of c.logs) assert.ok(!/Ranked grind|V title|Vertical template|My Channel/.test(l), 'no titles in the log');
    for (const f of allFiles(c.dataDir)) { const t = readFileSync(f, 'utf8'); assert.ok(!t.includes(CHAT_TEXT) && !t.includes(CHAT_AUTHOR), `chat text in ${f}`); }
    for (const t of responses) assert.ok(!t.includes(ACCESS) && !t.includes(REFRESH) && !t.includes(KEY_H) && !t.includes(KEY_V), 'a secret in a response');
  });
  test('End and Delete: refused for an event of a streaming output and when the state is unknown; allowed once the output is stopped', async () => {
    const c = await boot({ choices: BOTH });
    assert.equal((await goLive(c)).json().verdict, 'allow');
    const hId = readLive(c.dataDir)['youtube-h'].broadcastId;
    const before = c.yt.st.calls.length;
    for (const verb of ['end', 'delete']) {
      const r = await post(c, `/ui/api/youtube/broadcast/${verb}`, { id: hId });
      assert.equal(r.status, 409);
      assert.equal(r.json().error, 'output-live');
    }
    assert.equal(c.yt.st.calls.length, before, 'no YouTube call on a refusal');
    assert.deepEqual([c.yt.st.transitions, c.yt.st.deleted], [[], []]);
    // an event that is not the current event of an output is not blocked
    assert.equal((await post(c, '/ui/api/youtube/broadcast/delete', { id: 'tplH0001' })).status, 200);
    assert.deepEqual(c.yt.st.deleted, ['tplH0001']);
    assert.equal((await post(c, '/ui/api/youtube/broadcast/end', { id: 'bad id' })).status, 400);
    assert.equal((await post(c, '/ui/api/youtube/broadcast/end', { id: hId, x: 1 })).status, 400);
    // stop the streams: the same events can be ended / deleted, and leave the current list
    await c.fake.call('stream.stop', {});
    assert.equal((await post(c, '/ui/api/youtube/broadcast/end', { id: hId })).status, 200, 'stopped output: allowed');
    assert.deepEqual(c.yt.st.transitions, [hId]);
    assert.equal(readLive(c.dataDir)['youtube-h'], undefined, 'the ended event is not current any more');
    assert.equal((await post(c, '/ui/api/youtube/broadcast/delete', { id: readLive(c.dataDir)['youtube-v'].broadcastId })).status, 200);
  });
  test('End refuses when no fresh status can be read (unknown state)', async () => {
    let broken = false;
    const c = await boot({ choices: BOTH, hostWrap: async (m) => { if (broken && (m === 'outputs.status' || m === 'host.status')) throw Object.assign(new Error('x'), { code: 'host-down' }); } });
    assert.equal((await goLive(c)).json().verdict, 'allow');
    await c.fake.call('stream.stop', {});
    const hId = readLive(c.dataDir)['youtube-h'].broadcastId;
    broken = true;
    const r = await post(c, '/ui/api/youtube/broadcast/end', { id: hId });
    assert.equal(r.status, 409);
    assert.equal(r.json().error, 'output-live');
    assert.deepEqual(c.yt.st.transitions, []);
  });
  test('while a YouTube output streams, an event not in the current list is checked on YouTube: live refused, unknown refused, complete allowed', async () => {
    const yt = fakeYoutube({ broadcasts: [TEMPLATE, TEMPLATE_V, baseBroadcast('other001'), baseBroadcast('ready001', { status: { lifeCycleStatus: 'ready' } })] });
    const c = await boot({ choices: BOTH, yt });
    assert.equal((await goLive(c)).json().verdict, 'allow');
    for (const id of ['other001', 'ready001']) {
      const r = await post(c, '/ui/api/youtube/broadcast/end', { id });
      assert.equal(r.status, 409, id);
      assert.equal(r.json().error, 'output-live', id);
      assert.equal(r.json().message, ERROR_TEXT['youtube-not-idle'], id);
    }
    assert.equal((await post(c, '/ui/api/youtube/broadcast/delete', { id: 'gone0001' })).json().error, 'unknown-broadcast');
    assert.deepEqual([c.yt.st.transitions, c.yt.st.deleted], [[], []]);
    assert.equal((await post(c, '/ui/api/youtube/broadcast/delete', { id: 'tplV0001' })).status, 200, 'a complete event is allowed');
    assert.deepEqual(c.yt.st.deleted, ['tplV0001']);
    // stopped: no YouTube look-up needed, the event is ended directly
    await c.fake.call('stream.stop', {});
    const looks = apiCalls(c.yt, /liveBroadcasts\?part=id,status&id=/).length;
    assert.equal((await post(c, '/ui/api/youtube/broadcast/end', { id: 'other001' })).status, 200);
    assert.equal(apiCalls(c.yt, /liveBroadcasts\?part=id,status&id=/).length, looks);
  });
  test('stale clean-up drops an old event of an idle output but keeps a newer one written meanwhile by a Go live', async () => {
    let race = null;
    const yt = fakeYoutube({ broadcasts: [baseBroadcast('old00001', { status: { lifeCycleStatus: 'ready' } }), baseBroadcast('old00002', { status: { lifeCycleStatus: 'ready' } })] });
    const c = await boot({ yt, hostWrap: async (m) => { if (race && m === 'outputs.status') { const f = race; race = null; f(); } } });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    setLive(c.dataDir, [{ output: 'youtube-h', broadcastId: 'old00001', title: 'h' }, { output: 'youtube-v', broadcastId: 'old00002', title: 'v' }], old);
    race = () => setLive(c.dataDir, [{ output: 'youtube-h', broadcastId: 'newer001', title: 'n' }], new Date().toISOString());
    assert.equal((await get(c, '/ui/api/youtube/live?refresh=1')).status, 200);
    const now = readLive(c.dataDir);
    assert.equal(now['youtube-h']?.broadcastId, 'newer001', 'the newer event is kept');
    assert.equal(now['youtube-v'], undefined, 'the old event of the idle output is dropped');
  });
  test('quota and API failures come back as codes, never bodies', async () => {
    const c = await boot({ yt: fakeYoutube({ failCode: { 'GET /videoCategories': [403, 'quotaExceeded'], 'GET /channels': [500, 'backendError'] } }) });
    const r = await get(c, '/ui/api/youtube/categories');
    assert.equal(r.status, 429);
    assert.equal(r.json().error, 'youtube-quota');
    assert.ok(!/quotaExceeded/.test(r.text));
  });
  test('closing the server stops the chat reader (no stray timer keeps the process)', async () => {
    const c = await boot({ choices: BOTH });
    assert.equal((await goLive(c)).json().verdict, 'allow');
    c.yt.st.broadcasts.find((b) => b.id === readLive(c.dataDir)['youtube-h'].broadcastId).status.lifeCycleStatus = 'live';
    c.yt.st.chat = [chatItem(1)];
    assert.equal((await get(c, '/ui/api/youtube/chat?output=youtube-h')).json().live, true);
    await c.srv.close();
    servers.splice(servers.indexOf(c.srv), 1);
  });
});
