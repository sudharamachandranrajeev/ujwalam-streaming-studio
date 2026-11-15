// SPDX-License-Identifier: GPL-3.0-or-later
// Go live chooser (D389, track A): services/studio-ui/golive-routes.mjs (options, prepare, suggest), the shared quality
// path (youtube-quality.mjs), the choice file modes (youtube-events.json) and the Go live hook's four modes in server.mjs.
// A fake fetch stands in for Google and YouTube, an in-memory credential store for Windows Credential Manager, a fake
// host for libobs and a fake fetch for the local model: nothing reaches a real platform, a real model or a real stream.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLIENT_ID_TARGET, CLIENT_SECRET_TARGET } from '../services/posting/oauth.mjs';
import { ERROR_TEXT, TARGETS, createMemoryStores } from '../services/platform-connect/index.mjs';
import { LIVE_FILE, readLive } from '../services/platform-connect/youtube-control.mjs';
import { CHOICES_FILE, createYoutubeEvents, readChoices, readMode, writeChoices } from '../services/platform-connect/youtube-events.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { AI_WRITER_FILE, createGoLiveRoutes, smartFill } from '../services/studio-ui/golive-routes.mjs';
import { createSettingsRoutes } from '../services/studio-ui/settings-routes.mjs';
import { writeLiveStart } from '../services/studio-ui/stream-apply.mjs';
import { SETUP_FILE, seedSetup, writeSetup } from '../services/studio-ui/stream-setup.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createYoutubeQuality } from '../services/studio-ui/youtube-quality.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const API = 'https://www.googleapis.com/youtube/v3';
const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3';
const KEY_H = 'zq7h-gl01-mock-hkey-0001';
const KEY_V = 'zq7h-gl02-mock-vkey-0002';
const KEY_H2 = 'zq7h-gl03-mock-h2k-0003';
const KEY_OTHER = 'zq7h-gl04-mock-okey-0004';
const ACCESS = 'ya29.mockGoLiveAccessZZ9';
const REFRESH = '1//0mockGoLiveRefreshZZ9';
const CHAT_TEXT = 'zq-chat-secret-line-9912';
const SECRETS = [KEY_H, KEY_V, KEY_H2, KEY_OTHER, ACCESS, REFRESH];
const TITLES = /My planned stream|Planned vertical|Ranked grind|Old vertical|Somebody else|Mine live|Fresh title/;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-glr-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ---- the fake YouTube ----
const bc = (id, life, over = {}) => ({
  id, snippet: { title: `T ${id}`, description: `Desc ${id}`, scheduledStartTime: '2026-11-15T18:00:00Z', ...(over.snippet ?? {}) },
  status: { privacyStatus: 'unlisted', lifeCycleStatus: life, selfDeclaredMadeForKids: false, ...(over.status ?? {}) },
  contentDetails: { enableDvr: true, enableAutoStart: true, enableAutoStop: true, latencyPreference: 'low', monitorStream: { enableMonitorStream: false }, ...(over.contentDetails ?? {}) },
});
const BROADCASTS = () => [
  bc('upc00001', 'ready', { snippet: { title: 'My planned stream' }, contentDetails: { enableAutoStart: false, enableAutoStop: false, enableEmbed: true, recordFromStart: true } }),
  bc('upc00002', 'created', { snippet: { title: 'Planned vertical', scheduledStartTime: '2026-11-16T18:00:00Z' } }),
  bc('liveOth01', 'live', { snippet: { title: 'Somebody else' }, contentDetails: { boundStreamId: 'streamOther' } }),
  bc('liveMin01', 'live', { snippet: { title: 'Mine live' }, contentDetails: { boundStreamId: 'streamH1' } }),
  bc('past0001', 'complete', { snippet: { title: 'Old vertical', actualStartTime: '2026-11-10T18:00:00Z' }, contentDetails: { boundStreamId: 'streamV1' } }),
  bc('past0002', 'complete', { snippet: { title: 'Ranked grind #41', description: 'Last stream description', actualStartTime: '2026-11-12T18:00:00Z', thumbnails: { high: { url: 'https://i.ytimg.com/vi/past0002/hq.jpg' } } }, contentDetails: { boundStreamId: 'streamH1' } }),
  bc('past0003', 'complete', { snippet: { title: 'Newest anywhere', actualStartTime: '2026-11-13T18:00:00Z' }, contentDetails: { boundStreamId: 'streamGone' } }),
];
const ACTIVE = new Set(['live', 'liveStarting', 'testing', 'testStarting']);
function fakeYoutube(over = {}) {
  const st = {
    calls: [], puts: [], binds: [], inserts: [], made: [], deleted: [], thumbs: 0, nextId: 1,
    broadcasts: BROADCASTS(),
    streams: [{ id: 'streamH1', cdn: { ingestionInfo: { streamName: KEY_H } } }, { id: 'streamV1', cdn: { ingestionInfo: { streamName: KEY_V } } }, { id: 'streamH1440', cdn: { ingestionInfo: { streamName: KEY_H2 } } }],
    failCode: {}, ...over,
  };
  const reply = (status, data) => new Response(status === 204 ? null : JSON.stringify(data ?? {}), { status, headers: { 'content-type': 'application/json' } });
  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    let json = null;
    if (typeof init.body === 'string' && String(init.headers?.['Content-Type'] ?? '').includes('json')) json = JSON.parse(init.body);
    st.calls.push({ method, url, json });
    const u = new URL(url);
    if (u.href.startsWith('https://oauth2.googleapis.com/token')) return reply(200, { access_token: ACCESS, expires_in: 3600, scope: 'https://www.googleapis.com/auth/youtube' });
    if (u.hostname === 'i.ytimg.com') return new Response(Buffer.alloc(500, 1), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (url.startsWith(`${UPLOAD}/thumbnails/set`)) { st.thumbs += 1; return reply(200, {}); }
    const p = url.slice(API.length);
    const f = st.failCode[`${method} ${p.split('?')[0]}`];
    if (f) return reply(f[0], { error: { errors: [{ reason: f[1] }] } });
    if (method === 'GET' && p.startsWith('/liveBroadcasts?')) {
      const s = u.searchParams.get('broadcastStatus');
      if (s) {
        const life = (b) => b.status.lifeCycleStatus;
        const list = s === 'all' ? st.broadcasts : s === 'completed' ? st.broadcasts.filter((b) => life(b) === 'complete') : s === 'active' ? st.broadcasts.filter((b) => ACTIVE.has(life(b))) : st.broadcasts.filter((b) => ['created', 'ready'].includes(life(b)));
        return reply(200, { items: list });
      }
      const ids = (u.searchParams.get('id') ?? '').split(',');
      return reply(200, { items: st.broadcasts.filter((b) => ids.includes(b.id)) });
    }
    if (method === 'GET' && p.startsWith('/liveStreams?')) return reply(200, { items: st.streams });
    if (method === 'GET' && p.startsWith('/videos?')) return reply(200, { items: [{ id: u.searchParams.get('id'), snippet: { title: 'x', description: 'v', categoryId: '20', tags: ['codm', 'ranked'] }, status: { madeForKids: false } }] });
    if (method === 'PUT') { st.puts.push({ path: p.split('?')[0], query: p.split('?')[1], json }); return reply(200, {}); }
    if (method === 'POST' && p.startsWith('/liveBroadcasts/bind?')) { st.binds.push([u.searchParams.get('id'), u.searchParams.get('streamId')]); return reply(200, {}); }
    if (method === 'POST' && p.startsWith('/liveBroadcasts?')) {
      const id = `newbroad${st.nextId++}`; st.made.push(id); st.inserts.push(json);
      st.broadcasts.push(bc(id, 'ready', { snippet: { title: json.snippet.title } }));
      return reply(200, { id });
    }
    if (method === 'DELETE' && p.startsWith('/liveBroadcasts?')) { st.deleted.push(u.searchParams.get('id')); return reply(204); }
    return reply(404, {});
  }
  return { fetch, st };
}
const listCalls = (yt) => yt.st.calls.filter((c) => c.method === 'GET' && /broadcastStatus=/.test(c.url)).length;
const noSecret = (text, where) => { for (const s of SECRETS) assert.ok(!String(text).includes(s), `a secret in ${where}`); };

// ---- unit harness: golive routes with the real settings routes (stream-settings on) and a fake host ----
function fakeHost() {
  const h = {
    states: { 'youtube-h': 'idle', 'youtube-v': 'idle', twitch: 'idle', kick: 'idle', record: 'idle' }, calls: [], configures: [],
    async call(m, p) {
      h.calls.push(m);
      if (m === 'outputs.status') return { sinks: Object.entries(h.states).map(([id, state]) => ({ id, kind: id.startsWith('record') ? 'record' : 'stream', state })) };
      if (m === 'outputs.configure') { h.configures.push(p); return { configured: true }; }
      throw Object.assign(new Error('method-not-found'), { code: 'NO_METHOD' });
    },
  };
  return h;
}
const ALL_KEYS = () => new Map([['youtube-h', true], ['youtube-v', true], ['youtube-h-1440p', true], ['youtube-v-1440p', true], ['youtube-h-2160p', true], ['youtube-v-2160p', true]]);
const readSetupFile = (d) => { const { $comment, ...s } = JSON.parse(readFileSync(path.join(d, SETUP_FILE), 'utf8')); return s; };
const PLAN_ROWS = [{ id: 'youtube-h', label: 'YouTube H', canvas: 'H', quality: '1080p', keyRef: 'Ujwalam/stream/youtube-h' }, { id: 'youtube-v', label: 'YouTube V', canvas: 'V', quality: '1080p', keyRef: 'Ujwalam/stream/youtube-v' }];

function unit({ flagOn = true, keys = ALL_KEYS(), yt = fakeYoutube(), signedIn = true, aiFetch, aiTimeoutMs, game = 'Test Game' } = {}) {
  const dataDir = mk();
  const host = fakeHost();
  writeLiveStart(dataDir, { live: true, planFile: path.join(dataDir, 'outputs', 'stream-setup-plan.json'), paramsFile: path.join(dataDir, 'host', 'outputs-params.json'), instagram: false, select: null, readSchemes: false });
  assert.ok(writeSetup(dataDir, seedSetup(), { upscale: true }).ok);
  const jsonFn = (res, status, body) => { res.status = status; res.body = body; };
  const settings = createSettingsRoutes({ dataDir, host, flags: { isOn: (id) => flagOn && id === 'stream-settings' }, json: jsonFn, startGuard: { starting: () => false } });
  const quality = createYoutubeQuality({ dataDir, settings, readSetup: (d) => ({ exists: true, setup: readSetupFile(d) }), keyPresence: async () => keys });
  const store = { 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_V, 'Ujwalam/stream/youtube-h-1440p': KEY_H2 };
  const events = createYoutubeEvents({ fetchImpl: yt.fetch, accessToken: async () => ACCESS, readKey: async (ref) => store[ref] ?? null });
  const logs = [];
  const ai = { calls: [] };
  const routes = createGoLiveRoutes({
    dataDir, json: jsonFn, log: (l) => logs.push(String(l)), quality, ytOutputs: () => PLAN_ROWS, signedIn: async () => signedIn, events: () => events,
    outputsStatus: () => host.call('outputs.status', {}), gameName: () => game, aiTimeoutMs,
    aiFetch: async (url, init) => { ai.calls.push({ url, init, body: JSON.parse(init.body) }); return (aiFetch ?? (async () => { throw new Error('no model'); }))(url, init); },
  });
  const call = async (method, route, body, query = '') => { const res = {}; const handled = await routes.handle(method, route, body, res, new URL(`http://x${route}${query}`)); return { handled, status: res.status, body: res.body }; };
  return { dataDir, host, yt, call, logs, ai, settings, setupNow: () => readSetupFile(dataDir) };
}
const OPT = '/ui/api/youtube/golive/options';
const PREP = '/ui/api/youtube/golive/prepare';
const SUG = '/ui/api/youtube/golive/suggest';
const modelReply = (content) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('options', () => {
  test('shape: outputs with sizes, key presence and default bitrates; existing (boundToOther), past newest first, last per output, choice, setupInUse', async () => {
    const c = unit({ keys: new Map([['youtube-h', true], ['youtube-v', true], ['youtube-h-1440p', true]]) });
    const r = await c.call('GET', OPT, null);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.deepEqual(Object.keys(b).sort(), ['autoEvent', 'choice', 'existing', 'last', 'outputs', 'past', 'setupInUse', 'signedIn']);
    assert.equal(b.signedIn, true);
    assert.equal(b.setupInUse, true);
    assert.equal(b.choice, null);
    assert.deepEqual(b.outputs.map((o) => [o.id, o.label, o.orientation, o.on, o.size]), [['youtube-h', 'YouTube landscape', 'landscape', true, b.outputs[0].size], ['youtube-v', 'YouTube portrait', 'portrait', true, b.outputs[1].size]]);
    const h = b.outputs[0];
    assert.deepEqual(h.sizes.map((s) => [s.size, s.key]), [['1080p', true], ['1440p', true], ['2160p', false]]);
    for (const s of h.sizes) assert.ok(Number.isInteger(s.bitrateKbps) && s.bitrateKbps > 0);
    assert.ok(h.sizes[2].bitrateKbps > h.sizes[0].bitrateKbps, 'defaults come from data/platforms per size');
    assert.deepEqual(b.existing.map((e) => [e.id, e.lifeCycle, e.boundToOther]).sort(), [['liveMin01', 'live', false], ['liveOth01', 'live', true], ['upc00001', 'ready', false], ['upc00002', 'created', false]]);
    assert.deepEqual(Object.keys(b.existing[0]).sort(), ['boundToOther', 'id', 'lifeCycle', 'title', 'when']);
    assert.deepEqual(b.past.map((p) => p.id), ['past0003', 'past0002', 'past0001']);
    assert.deepEqual(Object.keys(b.past[0]).sort(), ['id', 'title', 'when']);
    assert.equal(b.last['youtube-h'].id, 'past0002', 'H: the newest finished stream on its own key');
    assert.equal(b.last['youtube-v'].id, 'past0001', 'V: the newest finished stream on its own key');
    for (const t of [JSON.stringify(b), ...c.logs]) noSecret(t, 'options');
  });
  test('cached 60 s unless ?refresh=1; bad query refused; signed out: no YouTube call', async () => {
    const c = unit();
    await c.call('GET', OPT, null);
    const n = listCalls(c.yt);
    assert.equal(n, 3, 'upcoming, active, completed');
    await c.call('GET', OPT, null);
    assert.equal(listCalls(c.yt), n, 'cached');
    await c.call('GET', OPT, null, '?refresh=1');
    assert.equal(listCalls(c.yt), 2 * n);
    for (const q of ['?refresh=2', '?x=1', '?refresh=1&refresh=1']) assert.equal((await c.call('GET', OPT, null, q)).status, 400, q);
    assert.equal((await c.call('POST', OPT, {})).status, 405);
    const d = unit({ signedIn: false });
    const r = (await d.call('GET', OPT, null)).body;
    assert.equal(r.signedIn, false);
    assert.deepEqual([r.existing, r.past, r.last], [[], [], { 'youtube-h': null, 'youtube-v': null }]);
    assert.deepEqual(d.yt.st.calls, []);
  });
  test('a file written before D389 (no mode) reads as copy', async () => {
    const c = unit();
    writeFileSync(path.join(c.dataDir, CHOICES_FILE), JSON.stringify({ version: 1, autoEvent: true, outputs: { 'youtube-h': { templateId: 'past0002', templateTitle: 'x', title: null } } }));
    assert.equal(readMode(c.dataDir), 'copy');
    assert.equal((await c.call('GET', OPT, null)).body.choice.mode, 'copy');
  });
  test('quota comes back as a code with a plain message', async () => {
    const c = unit({ yt: fakeYoutube({ failCode: { 'GET /liveBroadcasts': [403, 'quotaExceeded'] } }) });
    const r = await c.call('GET', OPT, null);
    assert.deepEqual([r.status, r.body.error, r.body.message], [429, 'youtube-quota', ERROR_TEXT['youtube-quota']]);
  });
});

describe('prepare', () => {
  const choiceRaw = (c) => (existsSync(path.join(c.dataDir, CHOICES_FILE)) ? readFileSync(path.join(c.dataDir, CHOICES_FILE), 'utf8') : null);
  test('validation: nothing is written and YouTube is not called on a refusal', async () => {
    const c = unit();
    const d = mk(); writeFileSync(path.join(d, 'no.png'), 'text');
    const bad = [
      [null, 400], [{}, 400], [{ mode: 'copy' }, 400], [{ mode: 'copy', outputs: {} }, 400], [{ mode: 'copy', outputs: { 'youtube-h': { templateId: 'past0002' } }, x: 1 }, 400],
      [{ mode: 'stream', outputs: { 'youtube-h': {} } }, 400], [{ mode: 'copy', outputs: { twitch: { templateId: 'past0002' } } }, 404],
      [{ mode: 'copy', outputs: { 'youtube-h': { templateId: 'past0002', size: '720p' } } }, 400], [{ mode: 'copy', outputs: { 'youtube-h': { templateId: 'bad id!' } } }, 400],
      [{ mode: 'copy', outputs: { 'youtube-h': { templateId: 'past0002', key: 'x' } } }, 400], [{ mode: 'copy', outputs: { 'youtube-h': {} } }, 400],
      [{ mode: 'existing', outputs: { 'youtube-h': { templateId: 'past0002' } } }, 400], [{ mode: 'new', outputs: { 'youtube-h': {} } }, 400],
      [{ mode: 'new', outputs: { 'youtube-h': { fields: { title: '<b>x' } } } }, 400], [{ mode: 'new', outputs: { 'youtube-h': { fields: { title: 'ok', extra: 1 } } } }, 400],
      [{ mode: 'new', outputs: { 'youtube-h': { fields: { title: 'ok', privacy: 'secret' } } } }, 400],
      [{ mode: 'new', outputs: { 'youtube-h': { fields: { title: 'ok', thumbnail: '\\\\server\\share\\a.png' } } } }, 400],
      [{ mode: 'new', outputs: { 'youtube-h': { fields: { title: 'ok', thumbnail: path.join(d, 'no.png') } } } }, 400],
    ];
    for (const [b, status] of bad) assert.equal((await c.call('POST', PREP, b)).status, status, JSON.stringify(b));
    assert.equal((await c.call('POST', PREP, { mode: 'new', outputs: { 'youtube-h': { fields: { title: 'ok', thumbnail: path.join(d, 'no.png') } } } })).body.error, 'youtube-bad-thumbnail');
    const same = await c.call('POST', PREP, { mode: 'existing', outputs: { 'youtube-h': { broadcastId: 'upc00001' }, 'youtube-v': { broadcastId: 'upc00001' } } });
    assert.deepEqual([same.status, same.body.error], [400, 'same-event']);
    assert.match(same.body.message, /one output only/);
    assert.equal(choiceRaw(c), null);
    assert.equal(c.host.configures.length, 0);
    assert.deepEqual(c.yt.st.calls, []);
    assert.equal((await c.call('GET', PREP, null)).status, 405);
  });
  test('quality: only the changed YouTube output moves (bitrate = platform default); the choice and mode are written; nothing on YouTube', async () => {
    const c = unit();
    const s = c.setupNow();
    s.outputs.find((o) => o.id === 'youtube-h').video = { output: '1080p', bitrateKbps: 12000 }; // own rung: no sharer
    s.video.bitrateKbps = 6000; delete s.outputs.find((o) => o.id === 'kick').video; // Kick follows the main rung (as in the D388 presets test)
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const before = c.setupNow();
    const opt = (await c.call('GET', OPT, null)).body;
    const def1440 = opt.outputs[0].sizes.find((x) => x.size === '1440p').bitrateKbps;
    const callsBefore = c.yt.st.calls.length;
    const r = await c.call('POST', PREP, { mode: 'copy', outputs: { 'youtube-h': { size: '1440p', templateId: 'past0002' }, 'youtube-v': { size: opt.outputs[1].size, templateId: 'past0001' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, appliesAt: 'now', missingKeys: [], ready: true });
    const after = c.setupNow();
    assert.deepEqual(after.outputs.find((o) => o.id === 'youtube-h').video, { output: '1440p', bitrateKbps: def1440 });
    for (const id of ['twitch', 'kick', 'youtube-v']) assert.equal(JSON.stringify(after.outputs.find((o) => o.id === id)), JSON.stringify(before.outputs.find((o) => o.id === id)), `${id} unchanged`);
    assert.deepEqual(after.video, before.video, 'the main and portrait rungs are untouched');
    assert.equal(c.host.configures.length, 1, 'the D387 apply ran once');
    assert.equal(c.yt.st.calls.length, callsBefore, 'nothing on YouTube');
    assert.equal(readMode(c.dataDir), 'copy');
    const ch = readChoices(c.dataDir);
    assert.deepEqual(ch['youtube-h'], { templateId: 'past0002', templateTitle: 'Ranked grind #41', title: null, size: '1440p' });
    // the same sizes again: nothing to apply
    const r2 = await c.call('POST', PREP, { mode: 'existing', outputs: { 'youtube-h': { size: '1440p', broadcastId: 'upc00001' } } });
    assert.deepEqual([r2.body.appliesAt, c.host.configures.length], ['unchanged', 1]);
    const ch2 = readChoices(c.dataDir)['youtube-h'];
    assert.deepEqual([ch2.broadcastId, ch2.broadcastTitle, ch2.templateId], ['upc00001', 'My planned stream', 'past0002'], 'the other mode\'s pick stays as pre-selection');
    assert.equal(readMode(c.dataDir), 'existing');
    assert.ok(c.logs.some((l) => /golive: prepared \(existing, 1 output\(s\), unchanged, 0 key\(s\) missing\)/.test(l)));
    for (const l of c.logs) assert.ok(!TITLES.test(l), 'no title in a log');
  });
  test('shared rung: 409 in plain words, nothing written, no host call', async () => {
    const c = unit();
    const s = c.setupNow();
    const tw = s.outputs.find((o) => o.id === 'twitch'); tw.name = 'Twitch'; delete tw.video; s.video.bitrateKbps = 6000;
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const raw = readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8');
    const r = await c.call('POST', PREP, { mode: 'copy', outputs: { 'youtube-h': { size: '2160p', templateId: 'past0002' } } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'shared-rung');
    assert.equal(r.body.message, 'Twitch streams from the same encoder as YouTube, so changing the YouTube quality would change Twitch too. Give Twitch its own size in Settings > Stream (Edit output), or keep the current quality.');
    assert.equal(readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8'), raw);
    assert.equal(choiceRaw(c), null);
    assert.equal(c.host.configures.length, 0);
  });
  test('a size whose key is not stored is listed in missingKeys and ready is false (presence only)', async () => {
    const c = unit({ keys: new Map([['youtube-h', true], ['youtube-v', true]]) });
    const s = c.setupNow(); s.outputs.find((o) => o.id === 'youtube-h').video = { output: '1080p', bitrateKbps: 12000 };
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const r = await c.call('POST', PREP, { mode: 'last', outputs: { 'youtube-h': { size: '2160p' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.missingKeys, r.body.ready], [['youtube-h 2160p'], false]);
    assert.equal(readMode(c.dataDir), 'last');
  });
  test('Settings > Stream off: the quality is not applied (plain detail), the setup is untouched, the choice is written', async () => {
    const c = unit({ flagOn: false });
    const raw = readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8');
    const r = await c.call('POST', PREP, { mode: 'copy', outputs: { 'youtube-h': { size: '2160p', templateId: 'past0002' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.appliesAt, 'not-used');
    assert.equal(r.body.detail, 'The quality was not changed, because Settings > Stream is off: Go live streams at the current size. Turn on Settings > Stream to pick the quality here.');
    assert.equal(readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8'), raw);
    assert.equal(c.host.calls.length, 0);
    assert.equal(readChoices(c.dataDir)['youtube-h'].size, '2160p');
  });
  test('mode new: the fields (with a checked thumbnail) are stored sanitized', async () => {
    const c = unit();
    const d = mk(); const pic = path.join(d, 'thumb.png'); writeFileSync(pic, PNG);
    const r = await c.call('POST', PREP, { mode: 'new', outputs: { 'youtube-h': { fields: { title: '  Fresh title  ', description: 'D', privacy: 'public', categoryId: '20', tags: ['a', 'b'], thumbnail: pic } } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(readChoices(c.dataDir)['youtube-h'].fields, { title: 'Fresh title', description: 'D', privacy: 'public', categoryId: '20', tags: ['a', 'b'], thumbnail: pic });
  });
});

describe('suggest ("Help me write it")', () => {
  test('a non-local model address is refused before any request', async () => {
    for (const url of ['http://example.com/v1/chat/completions', 'http://127.0.0.1.example.com/v1', 'http://10.0.0.5:1234/v1', 'ftp://127.0.0.1/x', 'http://user:pw@127.0.0.1:1234/v1', 'not a url']) {
      const c = unit();
      writeFileSync(path.join(c.dataDir, AI_WRITER_FILE), JSON.stringify({ url }));
      const r = await c.call('POST', SUG, {});
      assert.deepEqual([r.status, r.body.error], [409, 'ai-not-local'], url);
      assert.equal(c.ai.calls.length, 0, url);
    }
    for (const url of ['http://localhost:1234/v1/chat/completions', 'http://[::1]:1234/v1/chat/completions']) {
      const c = unit({ aiFetch: modelReply('{"title":"OK"}') });
      writeFileSync(path.join(c.dataDir, AI_WRITER_FILE), JSON.stringify({ url, model: 'qwen2.5-7b' }));
      const r = await c.call('POST', SUG, {});
      assert.equal(r.body.source, 'local-model', url);
      assert.equal(c.ai.calls[0].url, new URL(url).href);
      assert.equal(c.ai.calls[0].body.model, 'qwen2.5-7b');
    }
  });
  test('refused while a stream or a recording runs, and when the state cannot be read', async () => {
    const c = unit();
    c.host.states.twitch = 'live';
    let r = await c.call('POST', SUG, {});
    assert.deepEqual([r.status, r.body.error], [409, 'output-busy']);
    assert.match(r.body.message, /while a stream or recording runs/);
    c.host.states.twitch = 'idle'; c.host.states.record = 'live';
    r = await c.call('POST', SUG, {});
    assert.equal(r.body.error, 'output-busy');
    c.host.states.record = 'idle';
    c.host.call = async () => { throw new Error('down'); };
    r = await c.call('POST', SUG, {});
    assert.equal(r.body.error, 'state-unknown');
    assert.equal(c.ai.calls.length, 0);
  });
  test('the model answer is cleaned (plain, lengths, no < >, tags <= 15); the request carries only game, titles, date, hint and ttl', async () => {
    const tags = Array.from({ length: 25 }, (_, i) => `tag${i}`).concat(['tag1', '<x>']);
    const content = `Sure!\n\`\`\`json\n${JSON.stringify({ title: `<b>Ranked</b> push\u0007 tonight ${'x'.repeat(120)}`, description: 'Line one\nLine <two>', tags })}\n\`\`\``;
    const c = unit({ aiFetch: modelReply(content) });
    writeFileSync(path.join(c.dataDir, 'chat-cache.txt'), CHAT_TEXT); // never read
    const r = await c.call('POST', SUG, { output: 'youtube-h', hint: 'trying the new sniper' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'local-model');
    assert.ok(r.body.title.length <= 100 && !/[<>\x00-\x1f]/.test(r.body.title) && r.body.title.startsWith('bRanked/b push tonight'));
    assert.equal(r.body.description, 'Line one\nLine two');
    assert.ok(r.body.tags.length <= 15 && r.body.tags.every((t) => !/[<>]/.test(t)) && new Set(r.body.tags).size === r.body.tags.length);
    const req = c.ai.calls[0];
    assert.equal(req.url, 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(req.init.redirect, 'error');
    assert.ok(req.init.signal, 'a timeout signal');
    assert.equal(req.body.ttl, 300);
    assert.equal(req.body.model, undefined, 'no model name unless configured');
    assert.deepEqual(Object.keys(req.body).sort(), ['max_tokens', 'messages', 'stream', 'temperature', 'ttl']);
    const user = req.body.messages.find((m) => m.role === 'user').content;
    assert.match(user, /Game: Test Game/);
    assert.match(user, /- Newest anywhere\n- Ranked grind #41\n- Old vertical/);
    assert.match(user, /Date: \d{4}-\d{2}-\d{2}/);
    assert.match(user, /trying the new sniper/);
    assert.ok(!init(req).includes(CHAT_TEXT), 'no chat text in the request');
    for (const l of c.logs) assert.ok(!/sniper|Ranked/.test(l), 'no hint or title in a log');
  });
  test('model down, timeout or a bad answer: smart-fill from the last stream (next number), source says so', async () => {
    const down = unit();
    const r = await down.call('POST', SUG, { output: 'youtube-h' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.source, 'smart-fill');
    // options not read first: the newest finished stream overall is the last one
    assert.equal(r.body.title, 'Newest anywhere');
    const opt = unit();
    await opt.call('GET', OPT, null);
    const r2 = await opt.call('POST', SUG, { output: 'youtube-h' });
    assert.deepEqual(r2.body, { title: 'Ranked grind #42', description: 'Last stream description', tags: ['codm', 'ranked'], source: 'smart-fill' });
    const slow = unit({ aiTimeoutMs: 50, aiFetch: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
    const t0 = Date.now();
    assert.equal((await slow.call('POST', SUG, {})).body.source, 'smart-fill');
    assert.ok(Date.now() - t0 < 5000);
    assert.equal((await unit({ aiFetch: modelReply('I cannot help with that.') }).call('POST', SUG, {})).body.source, 'smart-fill');
    assert.equal((await unit({ aiFetch: modelReply('{"title":"<<>>"}') }).call('POST', SUG, {})).body.source, 'smart-fill');
    const out = unit({ signedIn: false });
    assert.equal((await out.call('POST', SUG, {})).body.source, 'smart-fill');
    assert.deepEqual(out.yt.st.calls, [], 'signed out: no YouTube call');
  });
  test('smart fill keeps the pattern: date and stream number; no last stream = game and date', () => {
    assert.equal(smartFill({ last: { title: 'Day 7 grind 2026-11-01' }, game: null, date: '2026-11-15' }).title, 'Day 8 grind 2026-11-15');
    assert.equal(smartFill({ last: null, game: 'Test Game', date: '2026-11-15' }).title, 'Test Game live 2026-11-15');
  });
  test('bad bodies', async () => {
    const c = unit();
    for (const b of [null, [], { x: 1 }, { hint: 5 }, { hint: 'x'.repeat(201) }, { hint: 'a<b' }, { hint: 'a\nb' }, { output: 'Bad Out' }]) assert.equal((await c.call('POST', SUG, b)).status, 400, JSON.stringify(b));
    assert.equal(c.ai.calls.length, 0);
  });
});
const init = (req) => req.init.body;

describe('no data folder', () => {
  test('the routes answer youtube-events-off and build no path', async () => {
    const quality = createYoutubeQuality({ dataDir: undefined, settings: {}, readSetup: () => { throw new Error('no'); }, keyPresence: async () => new Map() });
    const r = createGoLiveRoutes({ dataDir: undefined, json: (res, s, b) => { res.status = s; res.body = b; }, quality, ytOutputs: () => [], signedIn: async () => false, events: () => null, outputsStatus: async () => ({ sinks: [] }) });
    const res = {};
    assert.equal(await r.handle('GET', OPT, null, res, new URL(`http://x${OPT}`)), true);
    assert.deepEqual([res.status, res.body.error], [404, 'youtube-events-off']);
    assert.equal(await r.handle('GET', '/ui/api/youtube/account', null, {}, null), false);
  });
});

// ---- the server: the Go live hook per mode ----
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
      res.on('data', (ch) => chunks.push(ch));
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

async function boot({ yt = fakeYoutube(), keys = { 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_V }, hostWrap, hostAfter, extra = {} } = {}) {
  const dataDir = mk();
  const mem = createMemoryStores({ [CLIENT_ID_TARGET]: 'mock-google-client.apps.example', [CLIENT_SECRET_TARGET]: 'mock-secret-zz9', [TARGETS.youtubeRefresh]: REFRESH, ...keys });
  const fake = createFakeHost({ outputsReady: true });
  const hostCalls = [];
  const host = { describe: () => fake.describe(), call: async (m, p) => { hostCalls.push(m); if (hostWrap) await hostWrap(m); const r = await fake.call(m, p); if (hostAfter) await hostAfter(m); return r; } };
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const logs = [];
  const srv = createStudioServer({
    uiRoot: UI, core, host, launchKey: LAUNCH, dataDir, limits: { statusPollMs: 30 }, log: (m) => logs.push(String(m)),
    connect: { storeFor: mem.storeFor, fetchImpl: yt.fetch, sleep: async () => {}, browserOpen: async () => {} },
    golive: { aiFetch: async () => { throw new Error('no model in tests'); } }, ...extra,
  });
  servers.push(srv);
  const { port } = await srv.listen();
  return { srv, port, a: await login(port), dataDir, yt, logs, hostCalls, fake };
}
const goLive = (c) => post(c, '/ui/api/host', { method: 'stream.start', params: {} });
const prepare = async (c, body) => { const r = await post(c, PREP, body); assert.equal(r.status, 200, r.text); return r.json(); };
const waitFor = async (fn) => { for (let i = 0; i < 60 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };
function leakCheck(c) {
  for (const r of responses) noSecret(r, 'an HTTP response');
  for (const l of c.logs) { noSecret(l, 'a log line'); assert.ok(!TITLES.test(l), `a title in a log line: ${l}`); }
  for (const f of allFiles(c.dataDir)) noSecret(readFileSync(f, 'utf8'), f);
}
const EXISTING = { mode: 'existing', outputs: { 'youtube-h': { broadcastId: 'upc00001' }, 'youtube-v': { broadcastId: 'upc00002' } } };

describe('Go live hook: existing', () => {
  test('binds the chosen events, turns auto-start on (contentDetails whole), creates nothing; youtube-live.json records them', async () => {
    const c = await boot();
    const opt = (await get(c, OPT)).json();
    assert.equal(opt.setupInUse, false);
    assert.deepEqual(opt.outputs.map((o) => o.id), ['youtube-h', 'youtube-v']);
    const p = await prepare(c, EXISTING);
    assert.equal(p.ok, true);
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'allow', JSON.stringify(r));
    assert.deepEqual(r.youtubeEvents.map((e) => [e.output, e.title]).sort(), [['youtube-h', 'My planned stream'], ['youtube-v', 'Planned vertical']]);
    assert.deepEqual(c.yt.st.made, [], 'no insert');
    assert.deepEqual(c.yt.st.binds.sort(), [['upc00001', 'streamH1'], ['upc00002', 'streamV1']]);
    const put = c.yt.st.puts.filter((x) => x.path === '/liveBroadcasts');
    assert.equal(put.length, 1, 'only the event with auto-start off is updated');
    assert.equal(put[0].query, 'part=contentDetails');
    assert.deepEqual(put[0].json, { id: 'upc00001', contentDetails: { enableDvr: true, enableAutoStart: true, enableAutoStop: true, latencyPreference: 'low', monitorStream: { enableMonitorStream: false }, enableEmbed: true, recordFromStart: true } });
    assert.ok(c.hostCalls.includes('stream.start'));
    const live = readLive(c.dataDir);
    assert.deepEqual([live['youtube-h'].broadcastId, live['youtube-v'].broadcastId], ['upc00001', 'upc00002']);
    assert.ok((await get(c, '/ui/api/tasks')).json().tasks.some((t) => t.title === 'Linking your YouTube events' && t.state === 'done'));
    leakCheck(c);
  });
  test('Stop meanwhile: the start is refused and the user\'s events are never deleted', async () => {
    const c = await boot({ extra: { startPauseMs: 400 } });
    await prepare(c, EXISTING);
    const pending = goLive(c);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await post(c, '/ui/api/streams/end-all', {})).json().verdict, 'allow');
    const r = (await pending).json();
    assert.deepEqual([r.verdict, r.reason], ['refuse', 'stopped-meanwhile'], JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(c.yt.st.deleted, []);
    assert.ok(c.logs.some((l) => /0 event\(s\) deleted again, 0 kept \(output not shown idle\), 2 not ours kept/.test(l)), c.logs.join('\n'));
  });
  test('the host fails: the user\'s events are never deleted (a copy-mode event would be)', async () => {
    const boom = async (m) => { if (m === 'stream.start') throw Object.assign(new Error('boom'), { code: 'host-down' }); };
    const c = await boot({ hostWrap: boom });
    await prepare(c, EXISTING);
    assert.equal((await goLive(c)).status, 502);
    await new Promise((res) => setTimeout(res, 150));
    assert.deepEqual(c.yt.st.deleted, []);
    assert.equal(existsSync(path.join(c.dataDir, LIVE_FILE)), false);
    const d = await boot({ hostWrap: boom });
    await prepare(d, { mode: 'copy', outputs: { 'youtube-h': { templateId: 'past0002' }, 'youtube-v': { templateId: 'past0001' } } });
    assert.equal((await goLive(d)).status, 502);
    await waitFor(() => d.yt.st.deleted.length === 2);
    assert.deepEqual(d.yt.st.deleted.sort(), [...d.yt.st.made].sort(), 'Ujwalam\'s own events go again');
  });
  test('one output fails: the other output\'s existing event is not deleted; the refusal names the output', async () => {
    const c = await boot({ keys: { 'Ujwalam/stream/youtube-h': KEY_H, 'Ujwalam/stream/youtube-v': KEY_OTHER } });
    await prepare(c, EXISTING);
    const r = (await goLive(c)).json();
    assert.deepEqual([r.verdict, r.reason], ['refuse', 'youtube-event-failed']);
    assert.match(r.detail, /^YouTube V: the YouTube event could not be used\. The stream key this output uses is not one/);
    assert.deepEqual(c.yt.st.deleted, []);
    assert.ok(!c.hostCalls.includes('stream.start'));
  });
  test('an event live on another stream is refused in plain words (no bind); a finished or gone event too', async () => {
    const c = await boot();
    await prepare(c, { mode: 'existing', outputs: { 'youtube-h': { broadcastId: 'liveOth01' }, 'youtube-v': { broadcastId: 'upc00002' } } });
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'refuse');
    assert.equal(r.detail.split('. ')[0], 'YouTube H: the YouTube event could not be used');
    assert.ok(r.detail.includes(ERROR_TEXT['youtube-event-bound-other']), r.detail);
    assert.ok(!c.yt.st.binds.some(([id]) => id === 'liveOth01'));
    assert.deepEqual(c.yt.st.deleted, []);
    assert.ok(!c.hostCalls.includes('stream.start'));
    const d = await boot();
    await prepare(d, { mode: 'existing', outputs: { 'youtube-h': { broadcastId: 'past0002' }, 'youtube-v': { broadcastId: 'gone0001' } } });
    const r2 = (await goLive(d)).json();
    assert.ok(r2.detail.includes(ERROR_TEXT['youtube-event-ended']) && r2.detail.includes(ERROR_TEXT['youtube-event-gone']), r2.detail);
    assert.deepEqual([d.yt.st.binds, d.yt.st.puts, d.yt.st.deleted], [[], [], []]);
  });
  test('an event already live on this output\'s own stream is used as it is (no update, no re-bind)', async () => {
    const c = await boot();
    await prepare(c, { mode: 'existing', outputs: { 'youtube-h': { broadcastId: 'liveMin01' }, 'youtube-v': { broadcastId: 'upc00002' } } });
    assert.equal((await goLive(c)).json().verdict, 'allow');
    assert.deepEqual(c.yt.st.binds, [['upc00002', 'streamV1']]);
    assert.deepEqual(c.yt.st.puts, []);
  });
  test('the same event for H and V is refused at Go live too (a hand-edited choice)', async () => {
    const c = await boot();
    writeChoices(c.dataDir, { 'youtube-h': { broadcastId: 'upc00001' }, 'youtube-v': { broadcastId: 'upc00001' } }, { mode: 'existing' });
    const r = (await goLive(c)).json();
    assert.deepEqual([r.verdict, r.reason], ['refuse', 'youtube-event-same']);
    assert.match(r.detail, /pick a different event for each output/);
    assert.deepEqual(c.yt.st.calls.filter((x) => !x.url.startsWith('https://oauth2.')), []);
  });
  test('no event chosen for the mode: refused before any YouTube call, pointing to the Go live window', async () => {
    const c = await boot();
    writeChoices(c.dataDir, { 'youtube-h': { templateId: 'past0002' } }, { mode: 'existing' });
    const r = (await goLive(c)).json();
    assert.deepEqual([r.verdict, r.reason], ['refuse', 'youtube-event-missing']);
    assert.equal(r.detail, "No YouTube event is chosen for YouTube H and YouTube V. Press Go live and choose one in the Go live window (or turn off 'New YouTube event at every Go live' in the YouTube window), then go live.");
    assert.deepEqual(c.yt.st.calls.filter((x) => !x.url.startsWith('https://oauth2.')), []);
  });
});

describe('Go live hook: copy, last, new', () => {
  test('copy: a new event copied from the picked past stream (the D386 path), deleted on nothing', async () => {
    const c = await boot();
    await prepare(c, { mode: 'copy', outputs: { 'youtube-h': { templateId: 'past0002' }, 'youtube-v': { templateId: 'past0001' } } });
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'allow', JSON.stringify(r));
    assert.deepEqual(c.yt.st.inserts.map((i) => i.snippet.title).sort(), ['Old vertical', 'Ranked grind #41']);
    assert.equal(c.yt.st.made.length, 2);
    assert.deepEqual(c.yt.st.deleted, []);
    leakCheck(c);
  });
  test('last: the template is resolved at Go live: the newest finished stream of that output\'s key, else the newest overall', async () => {
    const c = await boot();
    await prepare(c, { mode: 'last', outputs: { 'youtube-h': {}, 'youtube-v': {} } });
    // a newer finished stream on the H key appears after prepare: Go live picks it
    c.yt.st.broadcasts.push(bc('past0009', 'complete', { snippet: { title: 'Ranked grind #42', actualStartTime: '2026-11-14T18:00:00Z' }, contentDetails: { boundStreamId: 'streamH1' } }));
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'allow', JSON.stringify(r));
    const titles = c.yt.st.inserts.map((i) => i.snippet.title).sort();
    assert.deepEqual(titles, ['Old vertical', 'Ranked grind #42']);
    const d = await boot({ yt: fakeYoutube({ broadcasts: BROADCASTS().filter((b) => b.id !== 'past0001') }) });
    await prepare(d, { mode: 'last', outputs: { 'youtube-v': {} } });
    writeChoices(d.dataDir, { 'youtube-h': { size: '1080p' }, 'youtube-v': { size: '1080p' } });
    assert.equal((await goLive(d)).json().verdict, 'allow');
    assert.ok(d.yt.st.inserts.some((i) => i.snippet.title === 'Newest anywhere'), 'V has no finished stream of its own: the newest overall');
    const e = await boot({ yt: fakeYoutube({ broadcasts: BROADCASTS().filter((b) => b.status.lifeCycleStatus !== 'complete') }) });
    await prepare(e, { mode: 'last', outputs: { 'youtube-h': {}, 'youtube-v': {} } });
    const r3 = (await goLive(e)).json();
    assert.equal(r3.verdict, 'refuse');
    assert.ok(r3.detail.includes(ERROR_TEXT['youtube-no-past-stream']));
  });
  test('new: inserted from the fields (latency normal, DVR on, not for kids, auto start/stop), category and tags, the thumbnail through the D388 path', async () => {
    const c = await boot();
    const d = mk(); const pic = path.join(d, 'thumb.png'); writeFileSync(pic, PNG);
    await prepare(c, { mode: 'new', outputs: {
      'youtube-h': { fields: { title: 'Fresh title', description: 'New description', privacy: 'public', categoryId: '20', tags: ['one', 'two'], thumbnail: pic } },
      'youtube-v': { fields: { title: 'Fresh title V' } },
    } });
    const r = (await goLive(c)).json();
    assert.equal(r.verdict, 'allow', JSON.stringify(r));
    const h = c.yt.st.inserts.find((i) => i.snippet.title === 'Fresh title');
    assert.equal(h.snippet.description, 'New description');
    assert.deepEqual(h.status, { privacyStatus: 'public', selfDeclaredMadeForKids: false });
    assert.deepEqual(h.contentDetails, { enableAutoStart: true, enableAutoStop: true, enableDvr: true, latencyPreference: 'normal', monitorStream: { enableMonitorStream: false } });
    assert.equal(c.yt.st.inserts.find((i) => i.snippet.title === 'Fresh title V').status.privacyStatus, 'private', 'privacy defaults to private');
    const vput = c.yt.st.puts.find((x) => x.path === '/videos');
    assert.deepEqual(vput.json.snippet, { title: 'Fresh title', categoryId: '20', description: 'New description', tags: ['one', 'two'] });
    assert.equal(c.yt.st.puts.filter((x) => x.path === '/videos').length, 1, 'V has no category or tags: no videos.update');
    assert.equal(c.yt.st.thumbs, 1);
    assert.equal(c.yt.st.binds.length, 2);
    assert.deepEqual(c.yt.st.deleted, []);
    const live = readLive(c.dataDir);
    assert.deepEqual(Object.keys(live).sort(), ['youtube-h', 'youtube-v']);
    leakCheck(c);
  });
  test('the D388 template routes keep the chooser\'s picks and set the mode to copy', async () => {
    const c = await boot();
    await prepare(c, { mode: 'existing', outputs: { 'youtube-h': { broadcastId: 'upc00001' } } });
    await post(c, '/ui/api/youtube/templates', { refresh: true });
    assert.equal((await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: 'past0002' })).status, 200);
    assert.equal(readMode(c.dataDir), 'copy');
    assert.equal(readChoices(c.dataDir)['youtube-h'].broadcastId, 'upc00001');
    await post(c, '/ui/api/youtube/event/set', { output: 'youtube-h', templateId: null });
    assert.deepEqual(readChoices(c.dataDir)['youtube-h'], { broadcastId: 'upc00001', broadcastTitle: '' });
  });
});
