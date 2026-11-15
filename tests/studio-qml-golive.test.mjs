// SPDX-License-Identifier: GPL-3.0-or-later
// The Go live chooser in the QML studio (D389, track B). Checks: Go live opens the chooser only with a YouTube output
// switched on and YouTube signed in (no YouTube output, not signed in, or an options read that fails: straight to
// stream.start as before); the last choice is pre-selected; each of the four modes posts its own body to
// golive/prepare and only then hands over to stream.start; a size without a stored key is greyed with "Add the key"
// (which opens Settings > Connections on that output); Cancel sends nothing; "Help me write it" fills the boxes and says
// where the words came from; a refused prepare says why and starts nothing; with Settings > Stream off no size is sent.
// The server routes are built in parallel (track A), so a loopback stand-in sits in front of the real UI server and
// answers ui/api/youtube/golive/* and the host's stream.start by the contract (docs/plan/2026-11-15-go-live-chooser.md);
// it records every request. Nothing ever goes live. Headless probe (UJWALAM_HEADLESS=1, offscreen). Skipped when the
// shell is not built.
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

const sizes = (h2160 = true) => [
  { size: '1080p', key: true, bitrateKbps: 12000 }, { size: '1440p', key: true, bitrateKbps: 24000 }, { size: '2160p', key: h2160, bitrateKbps: 40000 },
];
const baseOptions = () => ({
  signedIn: true,
  outputs: [
    { id: 'youtube-h', label: 'YouTube H', orientation: 'landscape', on: true, sizes: sizes(false), size: '1440p' },
    { id: 'youtube-v', label: 'YouTube V', orientation: 'portrait', on: true, sizes: sizes(true), size: '1080p' },
  ],
  existing: [
    { id: 'ev-1', title: 'Ranked grind tonight', lifeCycle: 'upcoming', when: '2026-11-16T18:00:00Z', boundToOther: false },
    { id: 'ev-2', title: 'Weekend special', lifeCycle: 'upcoming', when: '2026-11-17T18:00:00Z', boundToOther: false },
    { id: 'ev-live', title: 'Already on air', lifeCycle: 'live', when: '2026-11-15T18:00:00Z', boundToOther: true },
  ],
  past: [
    { id: 'pb-1', title: 'Friday night stream', when: '2026-11-13T18:00:00Z' },
    { id: 'pb-2', title: 'Older stream', when: '2026-11-01T18:00:00Z' },
  ],
  last: { 'youtube-h': { id: 'pb-1', title: 'Friday night stream', when: '2026-11-13T18:00:00Z' }, 'youtube-v': null },
  choice: null,
  setupInUse: true,
});

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

describe('QML studio Go live chooser (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // opts: options (the golive/options answer, null = the route is not there), prepare ([status, body]), suggest ([status, body]), flags, actions
  async function probe({ options = baseOptions(), prepare = [200, { ok: true, appliesAt: 'next-go-live', missingKeys: [], ready: true }], suggest = null, flags: on = [], actions = [], ms = Math.max(9000, 4000 + actions.length * 700) } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-gl-')); dirs.push(dataDir);
    const flags = createFlags({ dataDir });
    for (const id of on) flags.set(id, true);
    const file = path.join(dataDir, 'p.project.json');
    saveProject(file, createProject({ name: 'T', fps: 30 }));
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => (m === 'outputs.status' ? { configured: true, sinks: [] } : fake.call(m, p)) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const mem = createMemoryStores({});
    const key = 'g'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), projectSync: createProjectSync({ file }),
      limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), connect: { storeFor: mem.storeFor }, log: () => {} });
    const { port: upstream } = await srv.listen();

    const seen = [];   // { method, url, body }: the golive routes and the host's stream.start
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
        if (url.startsWith('/ui/api/youtube/golive/')) {
          seen.push({ method: req.method, url, body });
          if (url.endsWith('/options')) return options ? json(200, options) : json(404, { error: 'not-found' });
          if (url.endsWith('/prepare')) return json(...prepare);
          if (url.endsWith('/suggest')) return suggest ? json(...suggest) : json(404, { error: 'not-found' });
        }
        if (url === '/ui/api/outputs/panel') return json(200, { live: false, outputs: [
          { id: 'youtube-h', name: 'YouTube', platform: 'youtube', canvas: 'H', enabled: true }, { id: 'twitch', name: 'Twitch', platform: 'twitch', canvas: 'H', enabled: true },
          { id: 'kick', name: 'Kick', platform: 'kick', canvas: 'H', enabled: true }, { id: 'kick-2', name: 'Kick backup', platform: 'kick', canvas: 'H', enabled: false }] });
        if (url === '/ui/api/youtube/categories') return json(200, { categories: [{ id: '20', title: 'Gaming' }, { id: '22', title: 'People & Blogs' }] });
        if (url === '/ui/api/host' && body.method === 'stream.start') { seen.push({ method: 'POST', url, body }); return json(200, { verdict: 'allow' }); }
        const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${upstream}`;
        const up = http.request({ host: '127.0.0.1', port: upstream, path: req.url, method: req.method, headers }, (ur) => {
          res.writeHead(ur.statusCode, ur.headers);
          ur.pipe(res);
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
      return { p, s: p.state, g: p.state.goLive, seen };
    } finally { await new Promise((r) => proxy.close(r)); await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const W = ['gl-wait', 'gl-wait', 'gl-wait']; // unknown action: only gives the answers time
  const reqs = (r, re) => r.seen.filter((x) => re.test(x.url));
  const starts = (r) => reqs(r, /\/ui\/api\/host$/);
  const enc = encodeURIComponent;
  const withOutputs = (patch) => { const o = baseOptions(); Object.assign(o, patch); return o; };

  test('a YouTube output on and signed in: the chooser opens first, nothing is started or prepared yet', async () => {
    const r = await probe({ actions: ['yt-golive', ...W] });
    assert.equal(r.g.open, true);
    assert.equal(reqs(r, /golive\/options$/).length, 1);
    assert.equal(starts(r).length, 0, 'stream.start waits for the chooser');
    assert.equal(reqs(r, /prepare$/).length, 0);
    for (const m of ['existing', 'copy', 'last', 'new']) assert.ok(node(r.p, `glMode:${m}`), m);
    assert.equal(r.g.mode, 'last', 'no saved choice and past streams exist: like the last one');
    assert.deepEqual(r.g.active, ['youtube-h', 'youtube-v']);
    assert.deepEqual(r.g.outputs.map((o) => [o.id, o.size]), [['youtube-h', '1440p'], ['youtube-v', '1080p']]);
    assert.equal(r.g.summary, "Goes live on YouTube landscape in 1440p and YouTube portrait in 1080p as a new event like 'Friday night stream', and on Twitch and Kick as usual.");
    assert.deepEqual(r.g.others, ['Twitch', 'Kick']);
    assert.equal(r.g.goEnabled, true);
    assert.equal(r.g.problem, '');
  });

  test('no chooser without a YouTube output on, when not signed in, or when the options cannot be read: straight to stream.start', async () => {
    const off = withOutputs({ outputs: baseOptions().outputs.map((o) => ({ ...o, on: false })) });
    const a = await probe({ options: off, actions: ['yt-golive', ...W] });
    assert.equal(a.g.open, false, 'no YouTube output on');
    assert.equal(starts(a).length, 1);
    assert.equal(starts(a)[0].body.method, 'stream.start');
    const b = await probe({ options: withOutputs({ signedIn: false }), actions: ['yt-golive', ...W] });
    assert.equal(b.g.open, false, 'not signed in');
    assert.equal(starts(b).length, 1);
    const c = await probe({ options: null, actions: ['yt-golive', ...W] });
    assert.equal(c.g.open, false, 'the route is not there');
    assert.equal(starts(c).length, 1);
    assert.equal(reqs(c, /prepare$/).length, 0);
  });

  test('the last choice is pre-selected: its mode, its sizes, its event', async () => {
    const choice = { mode: 'existing', outputs: { 'youtube-h': { size: '1080p', broadcastId: 'ev-2' }, 'youtube-v': { size: '1440p', broadcastId: 'ev-1' } } };
    const r = await probe({ options: withOutputs({ choice }), actions: ['yt-golive', ...W] });
    assert.equal(r.g.mode, 'existing');
    assert.deepEqual(r.g.outputs.map((o) => [o.id, o.size]), [['youtube-h', '1080p'], ['youtube-v', '1440p']]);
    assert.equal(r.g.picks['youtube-h'].broadcastId, 'ev-2');
    assert.equal(r.g.picks['youtube-v'].broadcastId, 'ev-1');
    assert.equal(r.g.summary.startsWith("Goes live on YouTube landscape in 1080p and YouTube portrait in 1440p into 'Weekend special' and 'Ranked grind tonight'"), true, r.g.summary);
    const old = await probe({ options: withOutputs({ choice: { outputs: { 'youtube-h': { size: '1080p', templateId: 'pb-2' } } } }), actions: ['yt-golive', ...W] });
    assert.equal(old.g.mode, 'copy', 'a choice saved without a mode reads as copy');
    assert.equal(old.g.picks['youtube-h'].templateId, 'pb-2');
  });

  test('Go live in each mode posts that mode\'s body to prepare, then stream.start (in that order)', async () => {
    const last = await probe({ actions: ['yt-golive', ...W, 'click:glGo', ...W, ...W] });
    assert.deepEqual(reqs(last, /prepare$/).map((x) => x.body), [{ mode: 'last', outputs: { 'youtube-h': { size: '1440p' }, 'youtube-v': { size: '1080p' } } }]);
    assert.equal(starts(last).length, 1);
    assert.ok(last.seen.findIndex((x) => /prepare$/.test(x.url)) < last.seen.findIndex((x) => /host$/.test(x.url)), 'prepare first');
    assert.equal(last.g.open, false, 'the chooser closed');

    const ex = await probe({ actions: ['yt-golive', ...W, 'click:glMode:existing', 'gl-event:youtube-h:ev-1', 'gl-event:youtube-v:ev-2', 'gl-size:youtube-h:1080p', 'click:glGo', ...W, ...W] });
    assert.deepEqual(reqs(ex, /prepare$/).map((x) => x.body), [{ mode: 'existing', outputs: { 'youtube-h': { size: '1080p', broadcastId: 'ev-1' }, 'youtube-v': { size: '1080p', broadcastId: 'ev-2' } } }]);
    assert.equal(starts(ex).length, 1);

    const cp = await probe({ actions: ['yt-golive', ...W, 'click:glMode:copy', 'gl-past:youtube-v:pb-2', 'gl-size:youtube-v:1440p', 'click:glGo', ...W, ...W] });
    assert.deepEqual(reqs(cp, /prepare$/).map((x) => x.body), [{ mode: 'copy', outputs: { 'youtube-h': { size: '1440p', templateId: 'pb-1' }, 'youtube-v': { size: '1440p', templateId: 'pb-2' } } }]);

    const nw = await probe({ actions: ['yt-golive', ...W, 'click:glMode:new', 'gl-title:' + enc('Tonight at 9'), 'gl-desc:' + enc('About it'), 'gl-privacy:unlisted', 'gl-tags:' + enc('a, b'),
      'gl-category:20', 'gl-thumb:' + enc('C:/pics/t.png'), 'click:glGo', ...W, ...W] });
    const f = { title: 'Tonight at 9', description: 'About it', privacy: 'unlisted', tags: ['a', 'b'], categoryId: '20', thumbnailPath: 'C:/pics/t.png' };
    assert.deepEqual(reqs(nw, /prepare$/).map((x) => x.body), [{ mode: 'new', outputs: { 'youtube-h': { size: '1440p', fields: f }, 'youtube-v': { size: '1080p', fields: f } } }]);
    assert.equal(starts(nw).length, 1);
  });

  test('a size without a stored key is greyed with "Add the key", which opens Settings > Connections on that output', async () => {
    const r = await probe({ flags: ['platform-connect'], actions: ['yt-golive', ...W, 'gl-size:youtube-h:2160p', 'click:glAddKey:youtube-h:2160p', ...W, ...W] });
    assert.equal(done(r.p)['gl-size:youtube-h:2160p'], false, 'a size with no key cannot be picked');
    assert.equal(r.g.outputs[0].size, '1440p');
    assert.equal(done(r.p)['click:glAddKey:youtube-h:2160p'], true);
    assert.equal(r.g.open, false, 'the chooser closed; nothing was sent');
    assert.equal(r.s.settings.open, true);
    assert.equal(r.s.settings.page, 'Connections');
    assert.equal(r.s.settings.connectionsPage.only, 'youtube-h');
    assert.equal(reqs(r, /prepare$/).length + starts(r).length, 0);
    const grey = await probe({ actions: ['yt-golive', ...W] });
    assert.equal(node(grey.p, 'glSize:youtube-h:2160p').enabled, false, 'greyed');
    assert.equal(node(grey.p, 'glAddKey:youtube-h:2160p').visible, true);
    assert.equal(node(grey.p, 'glSize:youtube-h:1080p').enabled, true);
    assert.equal(node(grey.p, 'glAddKey:youtube-h:1080p').visible, false, 'a size with a key has no Add the key');
    assert.equal(node(grey.p, 'glSize:youtube-v:2160p').enabled, true);
    assert.equal(node(grey.p, 'glSize:youtube-h:1440p').text, '1440p');
    assert.equal(node(grey.p, 'glSize:youtube-h:2160p').text, '4K');
  });

  test('Cancel sends nothing; the chooser closes and Go live can be pressed again', async () => {
    const r = await probe({ actions: ['yt-golive', ...W, 'click:glCancel', ...W] });
    assert.equal(r.g.open, false);
    assert.equal(reqs(r, /prepare$/).length, 0);
    assert.equal(starts(r).length, 0);
    const again = await probe({ actions: ['yt-golive', ...W, 'gl-cancel', ...W, 'yt-golive', ...W] });
    assert.equal(again.g.open, true);
    assert.equal(reqs(again, /golive\/options$/).length, 2);
  });

  test('"Help me write it" fills the title, description and tags and says whether the model or smart fill wrote them', async () => {
    const model = await probe({ suggest: [200, { title: 'Ranked push, night 3', description: 'Grinding ranked.', tags: ['ranked', 'grind'], source: 'local-model' }],
      actions: ['yt-golive', ...W, 'click:glMode:new', 'gl-hint:' + enc('ranked push'), 'click:glHelp', ...W, ...W] });
    assert.deepEqual(reqs(model, /suggest$/).map((x) => x.body), [{ output: 'youtube-h', hint: 'ranked push' }]);
    assert.deepEqual([model.g.fields.title, model.g.fields.description, model.g.fields.tags], ['Ranked push, night 3', 'Grinding ranked.', 'ranked, grind']);
    assert.equal(model.g.helpSource, 'local-model');
    assert.match(node(model.p, 'glHelpSource').text, /^Written by the model on this PC/);
    const smart = await probe({ suggest: [200, { title: 'Friday night stream 2', description: 'Same as last time.', tags: ['a'], source: 'smart-fill' }],
      actions: ['yt-golive', ...W, 'click:glMode:new', 'click:glHelp', ...W, ...W] });
    assert.equal(smart.g.helpSource, 'smart-fill');
    assert.match(node(smart.p, 'glHelpSource').text, /^Filled in from your earlier streams/);
    assert.equal(smart.g.fields.title, 'Friday night stream 2');
    assert.equal(reqs(smart, /suggest$/)[0].body.hint, undefined, 'no hint typed, none sent');
    const refused = await probe({ suggest: [409, { error: 'live', message: 'Not while you are live.' }], actions: ['yt-golive', ...W, 'click:glMode:new', 'click:glHelp', ...W, ...W] });
    assert.equal(refused.g.helpNote, 'Not while you are live.');
    assert.equal(refused.g.helpSource, '');
    assert.equal(refused.g.fields.title, '');
  });

  test('what stops Go live is said in plain words and the button is off: same event twice, a busy event, an empty title', async () => {
    const same = await probe({ actions: ['yt-golive', ...W, 'click:glMode:existing', 'gl-event:youtube-h:ev-1', 'gl-event:youtube-v:ev-1'] });
    assert.equal(same.g.goEnabled, false);
    assert.equal(same.g.problem, 'Landscape and portrait cannot use the same event. Pick a different event for YouTube portrait.');
    assert.equal(node(same.p, 'glProblem').text, same.g.problem);
    const busy = await probe({ actions: ['yt-golive', ...W, 'click:glMode:existing', 'gl-event:youtube-h:ev-live', 'gl-event:youtube-v:ev-2'] });
    assert.match(busy.g.problem, /^'Already on air' is already on air with another stream, so it cannot be used/);
    const none = await probe({ actions: ['yt-golive', ...W, 'click:glMode:existing'] });
    assert.equal(none.g.problem, 'Pick an event for YouTube landscape.');
    const title = await probe({ actions: ['yt-golive', ...W, 'click:glMode:new', 'gl-title:' + enc('a<b')] });
    assert.equal(title.g.problem, 'The title, description and tags cannot contain < or >.');
    assert.equal(node(title.p, 'glGo').enabled, false);
    const empty = await probe({ actions: ['yt-golive', ...W, 'click:glMode:new'] });
    assert.equal(empty.g.problem, 'Type a title (1 to 100 characters).');
    assert.equal(starts(empty).length + reqs(empty, /prepare$/).length, 0);
  });

  test('a refused prepare shows its reason in plain words and starts nothing; a not-ready answer too', async () => {
    const r = await probe({ prepare: [409, { error: 'event-in-use', message: 'That event is already on air with another stream.' }], actions: ['yt-golive', ...W, 'click:glGo', ...W, ...W] });
    assert.equal(r.g.open, true, 'the chooser stays open');
    assert.equal(r.g.error, 'That event is already on air with another stream.');
    assert.equal(node(r.p, 'glProblem').text, 'That event is already on air with another stream.');
    assert.equal(starts(r).length, 0);
    const nr = await probe({ prepare: [200, { ok: true, ready: false, missingKeys: [], detail: 'YouTube is not ready for this size yet.' }], actions: ['yt-golive', ...W, 'click:glGo', ...W, ...W] });
    assert.equal(nr.g.error, 'YouTube is not ready for this size yet.');
    assert.equal(starts(nr).length, 0);
    const mk = await probe({ prepare: [200, { ok: true, ready: false, missingKeys: ['youtube-h 2160p'] }], actions: ['yt-golive', ...W, 'click:glGo', ...W, ...W] });
    assert.match(mk.g.error, /^A stream key is missing for a size you picked/);
    assert.equal(starts(mk).length, 0);
  });

  test('with Settings > Stream off the sizes are not offered and none is sent', async () => {
    const r = await probe({ options: withOutputs({ setupInUse: false }), actions: ['yt-golive', ...W, 'click:glGo', ...W, ...W] });
    // the dialog is closed after Go live: look at it open, before the click
    const open = await probe({ options: withOutputs({ setupInUse: false }), actions: ['yt-golive', ...W] });
    assert.equal(node(open.p, 'glQualityOff').visible, true);
    assert.equal(node(open.p, 'glSize:youtube-h:1080p'), undefined, 'no size buttons');
    assert.deepEqual(reqs(r, /prepare$/).map((x) => x.body), [{ mode: 'last', outputs: { 'youtube-h': {}, 'youtube-v': {} } }]);
    assert.equal(starts(r).length, 1);
    assert.doesNotMatch(r.g.summary, / in (1080p|1440p|4K)/);
  });

  test('only the outputs switched on are in the chooser: one YouTube output on', async () => {
    const o = baseOptions();
    o.outputs[1].on = false;
    const r = await probe({ options: o, actions: ['yt-golive', ...W, 'click:glGo', ...W, ...W] });
    assert.deepEqual(r.g.active, ['youtube-h']);
    assert.deepEqual(reqs(r, /prepare$/).map((x) => x.body), [{ mode: 'last', outputs: { 'youtube-h': { size: '1440p' } } }]);
  });
});
