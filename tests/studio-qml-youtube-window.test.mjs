// SPDX-License-Identifier: GPL-3.0-or-later
// The YouTube window in the QML studio (D388, replaces the D386 event picker dialog): five tabs (Presets, Event, Live,
// Chat, Streams) and the sign-in state. There is no feature flag: the On Air bar button shows with no flag and nothing is
// asked of YouTube until the window opens. Checks: not signed in shows one sign-in button; a preset Use posts the id and
// shows appliesAt, missing keys and the "Settings > Stream is off" line; the preset editor posts a valid preset; Event
// overrides post event/set before Go live and details/thumbnail while live; the Live tab polls only while live and shown;
// chat text is plain (a "<b>x</b>" message shows literally) and Send posts; Streams End/Delete post once per click and an
// "output-live" refusal reads plainly; a refused Go live opens the window on the Presets tab.
// The server side is built in parallel, so a loopback stand-in sits in front of the real UI server: it answers
// ui/api/youtube/* by the D388 contract (and records every request), shows the host as live when asked, and answers the
// host's stream.start with a scripted answer; every other request goes to the real server unchanged. Headless probe
// (UJWALAM_HEADLESS=1, offscreen, never on a screen; no browser or file dialog ever opens). Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createMemoryStores } from '../services/platform-connect/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { createProjectSync } from '../services/studio-ui/project-sync.mjs';
import { createProject, saveProject } from '../services/project/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const TEMPLATES = [
  { id: 'tpl-new', title: 'Friday night stream', when: '2026-11-13T18:00:00Z', privacy: 'public', lifeCycle: 'complete' },
  { id: 'tpl-old', title: 'Older stream', when: '2026-11-01T18:00:00Z', privacy: 'unlisted', lifeCycle: 'complete' },
];
const SIZES = ['1080p', '1440p', '2160p'];
const LIMITS = {
  'youtube-h': { '1080p': { min: 3000, max: 17000, default: 12000 }, '1440p': { min: 6000, max: 34000, default: 24000 }, '2160p': { min: 13000, max: 51000, default: 40000 } },
  'youtube-v': { '1080p': { min: 3000, max: 17000, default: 10000 }, '1440p': { min: 6000, max: 34000, default: 20000 }, '2160p': { min: 13000, max: 51000, default: 40000 } },
};
const KEYS = { 'youtube-h': { '1080p': true, '1440p': true, '2160p': false }, 'youtube-v': { '1080p': true, '1440p': true, '2160p': true } };
const basePresets = () => [
  { id: 'p-aaaa1111', name: '4K ranked', outputs: {
    'youtube-h': { enabled: true, size: '2160p', bitrateKbps: 50000, templateId: 'tpl-new', templateTitle: 'Friday night stream', title: null },
    'youtube-v': { enabled: true, size: '1440p', bitrateKbps: 20000, templateId: 'tpl-old', templateTitle: 'Older stream', title: null } } },
  { id: 'p-bbbb2222', name: 'Plain 1080', outputs: {
    'youtube-h': { enabled: true, size: '1080p', bitrateKbps: 12000, templateId: 'tpl-new', templateTitle: 'Friday night stream', title: null },
    'youtube-v': { enabled: false, size: '1080p', bitrateKbps: 10000, templateId: null, templateTitle: '', title: null } } },
];
const baseOutputs = () => [
  { id: 'youtube-h', label: 'YouTube H', canvas: 'H', quality: '2160p', choice: null },
  { id: 'youtube-v', label: 'YouTube V', canvas: 'V', quality: '1080p', choice: null },
];
const liveOutputs = () => [
  { output: 'youtube-h', label: 'YouTube H', broadcastId: 'BC_h-1', title: 'On air H', watchUrl: 'x', lifeCycle: 'live', health: { status: 'good', issues: [] }, viewers: 42, likes: 7, chat: true },
  { output: 'youtube-v', label: 'YouTube V', broadcastId: 'BC_v-1', title: 'On air V', watchUrl: 'x', lifeCycle: 'live', health: { status: 'bad', issues: ['The video is not reaching YouTube.'] }, viewers: null, likes: null, chat: true },
];
const baseBroadcasts = () => [
  { id: 'bc-1', title: 'Friday night stream', when: '2026-11-13T18:00:00Z', privacy: 'public', lifeCycle: 'complete', current: false },
  { id: 'bc-2', title: 'Tomorrow', when: '2026-11-16T18:00:00Z', privacy: 'unlisted', lifeCycle: 'upcoming', current: false },
  { id: 'bc-3', title: 'On air now', when: '2026-11-15T18:00:00Z', privacy: 'public', lifeCycle: 'live', current: true },
];

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 75_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio YouTube window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // opts: signedIn, live (the host reports live), setupInUse, start (the scripted stream.start answer), chat, refuse (route -> [status, body]), actions
  async function probe({ signedIn = true, live = false, setupInUse = true, start = null, chat = [], refuse = {}, actions = [], ms = Math.max(9000, 4000 + actions.length * 700) } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-yt-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => (m === 'outputs.status' ? { configured: true, sinks: [] } : fake.call(m, p)) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const mem = createMemoryStores({});
    const key = 's'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), connect: { storeFor: mem.storeFor, sleep: async () => {} }, log: () => {} });
    const { port: upstream } = await srv.listen();

    const seen = [];                       // every YouTube request: { method, url, query, body }
    let presets = basePresets(), activeId = null, outputs = baseOutputs(), autoEvent = true, broadcasts = baseBroadcasts();
    let chatSent = [];
    const proxy = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const u = new URL(req.url, 'http://x');
        const url = u.pathname;
        let body = {};
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* not JSON */ }
        const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        const eventsBody = () => ({ signedIn, autoEvent, outputs });
        if (url.startsWith('/ui/api/youtube/')) {
          const q = Object.fromEntries(u.searchParams);
          seen.push({ method: req.method, url, query: q, body });
          const route = url.slice('/ui/api/youtube/'.length);
          if (refuse[route]) return json(...refuse[route]);
          const get = req.method === 'GET';
          if (route === 'account' && get) return json(200, { signedIn, canSignIn: true, channelTitle: signedIn ? 'Placeholder channel' : null });
          if (route === 'signin') return json(200, { started: true });
          if (route === 'presets' && get) return json(200, { presets, activeId, sizes: { 'youtube-h': SIZES, 'youtube-v': SIZES }, limits: LIMITS, keys: KEYS, setupInUse });
          if (route === 'preset/use') {
            const p = presets.find((x) => x.id === body.id);
            if (!p) return json(404, { error: 'unknown', message: 'No such preset.' });
            activeId = p.id;
            const missing = ['youtube-h', 'youtube-v'].filter((o) => p.outputs[o].enabled && !KEYS[o][p.outputs[o].size]).map((o) => `${o} ${p.outputs[o].size}`);
            return json(200, setupInUse
              ? { ok: true, activeId, appliesAt: 'next-go-live', missingKeys: missing, events: eventsBody() }
              : { ok: true, activeId, appliesAt: 'not-used', detail: 'Settings > Stream is off, so only the templates were set.', missingKeys: [], events: eventsBody() });
          }
          if (route === 'preset/save') {
            const p = { ...body.preset, id: body.preset.id ?? 'p-cccc3333' };
            presets = body.preset.id ? presets.map((x) => (x.id === p.id ? p : x)) : [...presets, p];
            return json(200, { ok: true, preset: p, presets });
          }
          if (route === 'preset/delete') { presets = presets.filter((x) => x.id !== body.id); return json(200, { ok: true, presets, activeId }); }
          if (route === 'events' && get) return json(200, eventsBody());
          if (route === 'templates') return json(200, { templates: TEMPLATES });
          if (route === 'categories' && get) return json(200, { categories: [{ id: '20', title: 'Gaming' }, { id: '22', title: 'People & Blogs' }] });
          if (route === 'event/auto') { autoEvent = body.on === true; return json(200, { ok: true, autoEvent }); }
          if (route === 'event/set') {
            const t = TEMPLATES.find((x) => x.id === body.templateId);
            outputs = outputs.map((o) => (o.id !== body.output ? o : { ...o, choice: t ? { templateId: t.id, templateTitle: t.title, title: body.title ?? t.title } : null }));
            return json(200, { ok: true, outputs });
          }
          if (route === 'live' && get) return json(200, { at: '2026-11-15T10:00:00Z', outputs: live ? liveOutputs() : [] });
          if (route === 'details') return json(200, { ok: true, warnings: [] });
          if (route === 'thumbnail') return json(200, { ok: true });
          if (route === 'chat' && get) return json(200, { messages: q.after ? [] : chat, cursor: 'cur-1', live });
          if (route === 'chat/send') { chatSent.push(body); return json(200, { ok: true }); }
          if (route === 'broadcasts' && get) return json(200, { items: q.status === 'completed' ? broadcasts.filter((b) => b.lifeCycle === 'complete') : broadcasts, next: q.page ? null : 'page-2' });
          if (route === 'broadcast/end' || route === 'broadcast/delete') {
            if (body.id === 'bc-3') return json(409, { error: 'output-live', message: 'raw server text' });
            if (route === 'broadcast/delete') broadcasts = broadcasts.filter((b) => b.id !== body.id);
            return json(200, { ok: true });
          }
          return json(404, { error: 'not-found' });
        }
        if (url === '/ui/api/host' && start && body.method === 'stream.start') { seen.push({ method: 'POST', url, query: {}, body }); return json(200, start); }
        // everything else: the real server; the status shows the host as live when asked
        const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${upstream}`;
        const up = http.request({ host: '127.0.0.1', port: upstream, path: req.url, method: req.method, headers }, (ur) => {
          const parts = [];
          ur.on('data', (c) => parts.push(c));
          ur.on('end', () => {
            let data = Buffer.concat(parts);
            const h = { ...ur.headers };
            if (live && url === '/ui/api/status' && req.method === 'GET') {
              try {
                const j = JSON.parse(data.toString('utf8'));
                j.host = { ...(j.host || {}), live: true };
                data = Buffer.from(JSON.stringify(j));
                h['content-length'] = String(data.length);
              } catch { /* leave as is */ }
            }
            res.writeHead(ur.statusCode, h);
            res.end(data);
          });
        });
        up.on('error', () => { res.writeHead(502); res.end(); });
        up.end(raw);
      });
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const port = proxy.address().port;
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, y: p.state.youtube, seen, chatSent };
    } finally { await new Promise((r) => proxy.close(r)); await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const W = ['yt-wait', 'yt-wait', 'yt-wait']; // unknown action: only gives the answers time
  const reqs = (r, re) => r.seen.filter((x) => re.test(x.url));
  const line = (x) => `${x.method} ${x.url.replace('/ui/api/youtube/', '')}`;
  const enc = encodeURIComponent;

  test('no flag: the YouTube button shows, nothing is asked of YouTube until the window opens; then the preset cards and key dots show', async () => {
    const idle = await probe({ actions: [] });
    assert.equal(node(idle.p, 'youtubeEventsBtn').visible, true, 'no flag is needed');
    assert.equal(node(idle.p, 'youtubeEventsBtn').text, 'YouTube');
    assert.deepEqual(idle.seen, [], 'no YouTube call at app start');
    assert.equal(idle.s.flags.some((f) => f.id === 'youtube-events' && f.on), false);
    const r = await probe({ actions: ['click:youtubeEventsBtn', ...W] });
    assert.equal(r.y.open, true);
    assert.equal(r.y.tab, 'presets');
    assert.equal(r.y.signedIn, true);
    assert.deepEqual(r.seen.map(line), ['GET account', 'GET presets']);
    assert.deepEqual(r.y.presets.map((x) => x.name), ['4K ranked', 'Plain 1080']);
    assert.equal(r.y.presets[0].h, 'YouTube H: 4K, 50000 kbps, template "Friday night stream"');
    assert.equal(r.y.presets[1].v, 'YouTube V: off');
    for (const id of ['p-aaaa1111', 'p-bbbb2222']) assert.ok(node(r.p, `ytUse:${id}`) && node(r.p, `ytEdit:${id}`) && node(r.p, `ytDelete:${id}`), id);
    for (const t of ['presets', 'event', 'live', 'chat', 'streams']) assert.ok(node(r.p, `ytTab:${t}`), t);
    assert.equal(node(r.p, 'ytSignin').visible, false);
    assert.equal(r.y.setupInUse, true);
    assert.equal(node(r.p, 'ytSetupOff').visible, false);
  });

  test('not signed in: one Sign in with YouTube button on a tab, no other YouTube call; the click posts /signin', async () => {
    const r = await probe({ signedIn: false, actions: ['yt-open', ...W, 'yt-tab:chat', ...W, 'click:ytSigninBtn', ...W] });
    assert.equal(r.y.signedIn, false);
    assert.equal(node(r.p, 'ytSignin').visible, true);
    assert.equal(node(r.p, 'ytSigninBtn').text, 'Sign in with YouTube');
    assert.equal(done(r.p)['click:ytSigninBtn'], true);
    assert.deepEqual(r.seen.map(line).filter((l, i, a) => a.indexOf(l) === i), ['GET account', 'POST signin'], 'only the account is read, then the sign-in starts');
    assert.equal(reqs(r, /signin$/).length, 1);
    assert.equal(r.y.signingIn, true);
  });

  test('preset Use posts the id and shows appliesAt and the missing keys; a preset while Settings > Stream is off says so', async () => {
    const r = await probe({ actions: ['yt-open', ...W, 'click:ytUse:p-aaaa1111', ...W] });
    assert.equal(done(r.p)['click:ytUse:p-aaaa1111'], true);
    const use = reqs(r, /preset\/use$/);
    assert.equal(use.length, 1);
    assert.deepEqual(use[0].body, { id: 'p-aaaa1111' });
    assert.equal(r.y.activeId, 'p-aaaa1111');
    assert.equal(r.y.useText, 'Saved. It applies at the next Go live.');
    assert.deepEqual(r.y.missingKeys, ['youtube-h 2160p']);
    assert.match(r.y.missingText, /No stream key stored for: youtube-h 2160p\. Set it in Settings > Connections\. Go live refuses that output/);
    assert.equal(node(r.p, 'ytMissingKeys').visible, true);
    const off = await probe({ setupInUse: false, actions: ['yt-open', ...W, 'yt-preset-use:p-bbbb2222', ...W] });
    assert.equal(node(off.p, 'ytSetupOff').visible, true);
    assert.equal(node(off.p, 'ytSetupOff').text, 'Sizes and bitrates are used once Settings > Stream is on.');
    assert.equal(off.y.setupInUse, false);
    assert.equal(off.y.useText, 'Settings > Stream is off, so only the templates were set.');
    assert.equal(node(off.p, 'ytMissingKeys').visible, false);
    const on = await probe({ actions: ['yt-open', ...W] });
    assert.equal(node(on.p, 'ytSetupOff').visible, false, 'the line shows only when the setup is not in use');
  });

  test('preset editor: a size change resets the bitrate into its limits, an invalid one says why, Save posts the preset, Delete is one click', async () => {
    const r = await probe({ actions: ['yt-open', ...W, 'click:ytNew', 'yt-preset-name:' + enc('Night 2K'), 'yt-preset-size:youtube-h:1440p', 'yt-preset-tpl:youtube-h:tpl-new', 'yt-preset-on:youtube-v:off', 'yt-preset-bitrate:youtube-h:99999'] });
    assert.equal(r.y.editing, true);
    assert.equal(r.y.draft.outputs['youtube-h'].bitrateKbps, 99999);
    assert.match(r.y.presetWhy, /bitrate must be 6000 to 34000 kbps/);
    assert.equal(node(r.p, 'ytPresetSave').enabled, false);
    assert.equal(reqs(r, /preset\/save$/).length, 0);
    const ok = await probe({ actions: ['yt-open', ...W, 'click:ytNew', 'yt-preset-name:' + enc('Night 2K'), 'yt-preset-size:youtube-h:1440p', 'yt-preset-tpl:youtube-h:tpl-new', 'yt-preset-on:youtube-v:off', 'click:ytPresetSave', ...W, 'click:ytDelete:p-bbbb2222', ...W] });
    assert.equal(ok.y.draft, null, 'the editor closed after Save');
    const save = reqs(ok, /preset\/save$/);
    assert.equal(save.length, 1);
    assert.deepEqual(save[0].body.preset, { name: 'Night 2K', outputs: {
      'youtube-h': { enabled: true, size: '1440p', bitrateKbps: 24000, templateId: 'tpl-new', templateTitle: 'Friday night stream', title: null },
      'youtube-v': { enabled: false, size: '1080p', bitrateKbps: 10000, templateId: null, templateTitle: '', title: null } } });
    const del = reqs(ok, /preset\/delete$/);
    assert.equal(del.length, 1, 'one click, one delete, no confirmation');
    assert.deepEqual(del[0].body, { id: 'p-bbbb2222' });
    assert.deepEqual(ok.y.presets.map((x) => x.id), ['p-aaaa1111', 'p-cccc3333']);
  });

  test('Event tab before Go live: the template, title and overrides post /event/set (no details call); the new-event toggle posts /event/auto', async () => {
    const r = await probe({ actions: ['yt-open:event', ...W, 'yt-pick:youtube-h:tpl-new', 'yt-title:youtube-h:Tonight%20at%209', 'yt-desc:youtube-h:' + enc('A long night'),
      'yt-privacy:youtube-h:unlisted', 'yt-tags:youtube-h:' + enc('ranked, grind'), 'yt-category:youtube-h:20', 'click:ytSaveEvent:youtube-h', ...W, 'click:ytAuto', ...W] });
    assert.equal(r.y.tab, 'event');
    assert.equal(node(r.p, 'ytAuto').text, 'New YouTube event at every Go live');
    const set = reqs(r, /event\/set$/);
    assert.equal(set.length, 1);
    assert.deepEqual(set[0].body, { output: 'youtube-h', templateId: 'tpl-new', title: 'Tonight at 9', description: 'A long night', privacy: 'unlisted', tags: ['ranked', 'grind'], categoryId: '20' });
    assert.equal(reqs(r, /details$/).length + reqs(r, /thumbnail$/).length, 0, 'the running-event routes are for a live event only');
    assert.match(r.y.rows[0].status, /^Saved: "Tonight at 9", made from "Friday night stream"\./);
    assert.match(r.y.rows[1].status, /Not chosen|No event will be made/);
    const auto = reqs(r, /event\/auto$/);
    assert.equal(auto.length, 1);
    assert.deepEqual(auto[0].body, { on: false });
    assert.equal(r.y.autoEvent, false);
    assert.equal(r.y.categories, 2);
    assert.equal(r.y.rows[0].thumbEnabled, false, 'a thumbnail needs a running event');
    // a bad title or a bad tag turns Save off and sends nothing
    const bad = await probe({ actions: ['yt-open:event', ...W, 'yt-pick:youtube-h:tpl-new', 'yt-title:youtube-h:a%3Cb', 'yt-save:youtube-h'] });
    assert.match(bad.y.rows[0].why, /cannot contain < or >/);
    assert.equal(node(bad.p, 'ytSaveEvent:youtube-h').enabled, false);
    assert.equal(reqs(bad, /event\/set$/).length, 0);
  });

  test('Event tab while live: the same boxes edit the running event (details and thumbnail on the current broadcast); no event/set', async () => {
    const r = await probe({ live: true, actions: ['yt-open:event', ...W, ...W, 'yt-title:youtube-h:' + enc('New live title'), 'yt-desc:youtube-h:' + enc('Live words'), 'yt-tags:youtube-h:' + enc('a, b'),
      'click:ytSaveEvent:youtube-h', ...W, 'yt-thumb:youtube-h:' + enc('C:/pics/thumb.png'), 'click:ytThumbSet:youtube-h', ...W] });
    assert.equal(r.s.live, true);
    assert.equal(r.y.rows[0].live, true);
    const det = reqs(r, /details$/);
    assert.equal(det.length, 1);
    assert.deepEqual(det[0].body, { broadcastId: 'BC_h-1', title: 'New live title', description: 'Live words', tags: ['a', 'b'] });
    const th = reqs(r, /thumbnail$/);
    assert.equal(th.length, 1);
    assert.deepEqual(th[0].body, { broadcastId: 'BC_h-1', path: 'C:/pics/thumb.png' });
    assert.equal(reqs(r, /event\/set$/).length, 0);
    assert.equal(node(r.p, 'ytSaveEvent:youtube-h').text, 'Save to the running event');
    assert.match(r.y.rows[0].status, /thumbnail was set|running event was updated/);
    assert.equal(node(r.p, 'youtubeEventsBtn').visible, true, 'the YouTube button stays while live');
  });

  test('Live tab: no poll and no timer while not live; while live it polls, shows health, viewers, likes and a checked watch link', async () => {
    const off = await probe({ actions: ['yt-open:live', ...W, 'yt-live-refresh', 'yt-tick:live'] });
    assert.equal(off.y.liveTimer, false, 'the 30 s timer is off while not live');
    assert.equal(reqs(off, /\/live$/).length, 0, 'no live request while not live');
    assert.equal(node(off.p, 'ytNotLive').visible, true);
    const on = await probe({ live: true, actions: ['yt-open:live', ...W, ...W] });
    assert.equal(on.y.liveTimer, true, 'the timer runs while live and the tab is shown');
    assert.equal(reqs(on, /\/live$/).length, 1, 'one read on entry, the next is 30 s later');
    assert.deepEqual(on.y.live.map((x) => [x.output, x.health, x.viewers, x.likes]), [['youtube-h', 'Good', '42', '7'], ['youtube-v', 'Bad', '-', '-']]);
    assert.equal(on.y.live[0].link, 'https://www.youtube.com/watch?v=BC_h-1');
    const moved = await probe({ live: true, actions: ['yt-open:live', ...W, 'yt-tab:chat', ...W, 'yt-tick:live'] });
    assert.equal(moved.y.liveTimer, false, 'the timer stops when the tab is not shown');
    const w = await probe({ live: true, actions: ['yt-open:live', ...W, 'click:ytWatch:youtube-h', 'yt-tick:live', ...W] });
    assert.equal(w.y.watched, 'https://www.youtube.com/watch?v=BC_h-1', 'the link is checked; in test mode no browser opens');
    assert.equal(reqs(w, /\/live$/).length, 2, 'a tick polls once more');
  });

  test('Chat: a "<b>x</b>" message shows literally (plain text), Send posts the text once, the next read passes the cursor', async () => {
    const chat = [
      { id: 'm1', author: '<i>Viewer</i>', text: '<b>x</b>', at: '2026-11-15T10:00:00Z', kind: 'text' },
      { id: 'm2', author: 'Someone', text: 'big thanks', at: '2026-11-15T10:00:05Z', kind: 'superChat', amount: '$5.00' },
    ];
    const r = await probe({ live: true, chat, actions: ['yt-open:chat', ...W, ...W, 'yt-chat-text:' + enc('hello chat'), 'click:ytChatSend', ...W, 'yt-tick:chat', ...W] });
    assert.equal(r.y.chat.output, 'youtube-h');
    assert.deepEqual(r.y.chat.messages.map((m) => [m.id, m.author, m.text, m.kind]), [['m1', '<i>Viewer</i>', '<b>x</b>', 'text'], ['m2', 'Someone', 'big thanks', 'superChat']]);
    assert.equal(node(r.p, 'ytChatText:m1').text, '<b>x</b>', 'the markup is shown, not rendered');
    assert.equal(r.y.chat.plain, true, 'the chat texts use the plain text format');
    assert.equal(r.y.chatTimer, true);
    assert.deepEqual(r.chatSent, [{ output: 'youtube-h', text: 'hello chat' }]);
    assert.equal(r.y.chat.text, '', 'the box clears after a send');
    const reads = reqs(r, /\/chat$/);
    assert.ok(reads.length >= 2);
    assert.equal(reads[0].query.output, 'youtube-h');
    assert.equal(reads[0].query.after, undefined, 'the first read has no cursor');
    assert.ok(reads.slice(1).every((x) => x.query.after === 'cur-1'), 'later reads pass the cursor');
    assert.equal(r.y.chat.count, 2, 'a message is not added twice');
    // 200 character cap, empty text, and the V output is its own list
    const long = await probe({ live: true, actions: ['yt-open:chat', ...W, 'yt-chat-text:' + enc('x'.repeat(201)), 'yt-chat-send'] });
    assert.match(long.y.chat.sendWhy, /at most 200/);
    assert.equal(long.chatSent.length, 0);
    const v = await probe({ live: true, chat, actions: ['yt-open:chat', ...W, 'click:ytChatOut:youtube-v', ...W] });
    assert.equal(v.y.chat.output, 'youtube-v');
  });

  test('Streams: filter and paging read the list; End and Delete post once per click; an output-live refusal reads in plain words; Use as H template posts /event/set', async () => {
    const r = await probe({ actions: ['yt-open:streams', ...W, 'click:ytFilter:completed', 'click:ytFilter:all', 'click:ytNext', 'click:ytUseH:bc-1', 'click:ytEnd:bc-2',
      'click:ytDeleteStream:bc-1', 'click:ytEnd:bc-3', ...W], ms: 45000 });
    const lists = reqs(r, /broadcasts$/);
    assert.deepEqual(lists.slice(0, 4).map((x) => [x.query.status, x.query.page ?? null]), [['all', null], ['completed', null], ['all', null], ['all', 'page-2']]);
    const end = reqs(r, /broadcast\/end$/);
    assert.deepEqual(end.map((x) => x.body), [{ id: 'bc-2' }, { id: 'bc-3' }], 'one End per click');
    const del = reqs(r, /broadcast\/delete$/);
    assert.deepEqual(del.map((x) => x.body), [{ id: 'bc-1' }], 'one Delete per click, no confirmation');
    assert.match(r.y.streams.note, /on air in an output that is streaming\. End the stream first/);
    assert.doesNotMatch(r.y.streams.note, /raw server text/, 'the refusal is said in plain words');
    const tpl = reqs(r, /event\/set$/);
    assert.equal(tpl.length, 1);
    assert.deepEqual(tpl[0].body, { output: 'youtube-h', templateId: 'bc-1', title: 'Friday night stream' });
    const fin = await probe({ actions: ['yt-open:streams', ...W, 'click:ytEnd:bc-1', ...W] });
    assert.equal(done(fin.p)['click:ytEnd:bc-1'], false, 'a finished event cannot be ended');
    assert.equal(reqs(fin, /broadcast\/end$/).length, 0);
  });

  test('a refused Go live for a missing YouTube event opens the window on the Presets tab (and only that refusal does)', async () => {
    const detail = 'YouTube H has no event chosen. Pick a previous broadcast under YouTube event, then Go live.';
    const r = await probe({ start: { verdict: 'refuse', reason: 'youtube-event-missing', detail }, actions: ['yt-open:streams', ...W, 'yt-close', 'yt-golive', ...W, ...W] });
    assert.equal(r.s.note, detail);
    assert.equal(r.y.open, true, 'the window opened');
    assert.equal(r.y.tab, 'presets');
    assert.ok(reqs(r, /presets$/).length >= 1, 'the presets were read');
    const failed = await probe({ start: { verdict: 'refuse', reason: 'youtube-event-failed', detail: 'YouTube said no: quota used up.' }, actions: ['yt-golive', ...W, ...W] });
    assert.equal(failed.s.note, 'YouTube said no: quota used up.');
    assert.equal(failed.y.open, true);
    assert.equal(failed.y.tab, 'presets');
    const other = await probe({ start: { verdict: 'refuse', reason: 'no-outputs-enabled', detail: 'No output is switched on.' }, actions: ['yt-golive', ...W] });
    assert.equal(other.s.note, 'No output is switched on.');
    assert.equal(other.y.open, false, 'only a YouTube event refusal opens the window');
    const warn = await probe({ start: { verdict: 'allow', youtubeEvents: [{ output: 'youtube-h', title: 'T', warnings: ['Thumbnail not copied.'] }] }, actions: ['yt-golive', ...W] });
    assert.match(warn.s.note, /Thumbnail not copied\./);
  });
});
