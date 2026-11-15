// SPDX-License-Identifier: GPL-3.0-or-later
// The YouTube event picker in the QML studio (D386, flag youtube-events): before Go live, per YouTube output (H and V
// separately) pick a previous YouTube broadcast as the template and edit the title. Checks: flag on, the rows render and
// the list is read only when the window opens; picking and Save post the right body; a title with "<" turns Save off
// and says why; signed out shows the Settings pointer; flag off shows nothing and asks nothing; a refused Go live shows
// the server's detail (and a missing event opens the picker); start warnings are shown.
// The server side is built in parallel, so a small loopback stand-in sits in front of the real UI server: it answers
// ui/api/youtube/*, adds the flag to the flag list and answers the host's stream.start with a scripted answer; every other
// request goes to the real server unchanged. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen). Skipped
// when the shell is not built.
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
const baseOutputs = () => [
  { id: 'youtube-h', label: 'YouTube H', canvas: 'H', quality: '2160p', choice: null },
  { id: 'youtube-v', label: 'YouTube V', canvas: 'V', quality: '1080p', choice: null },
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
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio YouTube event picker (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  // opts: flag (the flag's value), signedIn, start (the scripted stream.start answer), actions
  async function probe({ flag = true, signedIn = true, start = null, actions = [], ms = Math.max(9000, 4000 + actions.length * 700) } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-yte-')); dirs.push(dataDir);
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

    // the stand-in: calls it saw, the choices it holds
    const seen = [];
    let outputs = baseOutputs();
    const proxy = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const url = req.url.split('?')[0];
        let body = {};
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* not JSON */ }
        const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (url.startsWith('/ui/api/youtube/')) {
          seen.push({ method: req.method, url, body });
          if (!flag) return json(404, { error: 'youtube-events-off' });
          if (url === '/ui/api/youtube/events' && req.method === 'GET') return json(200, { signedIn, outputs });
          if (url === '/ui/api/youtube/templates') return json(200, { templates: TEMPLATES });
          if (url === '/ui/api/youtube/event/set') {
            const t = TEMPLATES.find((x) => x.id === body.templateId);
            outputs = outputs.map((o) => (o.id !== body.output ? o : { ...o, choice: t ? { templateId: t.id, templateTitle: t.title, title: body.title ?? t.title } : null }));
            return json(200, { ok: true, outputs });
          }
          return json(404, { error: 'not-found' });
        }
        if (url === '/ui/api/host' && start && body.method === 'stream.start') { seen.push({ method: 'POST', url, body }); return json(200, start); }
        // everything else: the real server, with the flag added to the list
        const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${upstream}`;
        const up = http.request({ host: '127.0.0.1', port: upstream, path: req.url, method: req.method, headers }, (ur) => {
          const parts = [];
          ur.on('data', (c) => parts.push(c));
          ur.on('end', () => {
            let data = Buffer.concat(parts);
            const h = { ...ur.headers };
            if (url === '/ui/api/flags' && req.method === 'GET') {
              try {
                const j = JSON.parse(data.toString('utf8'));
                j.flags = (j.flags || []).filter((f) => f.id !== 'youtube-events').concat([{ id: 'youtube-events', label: 'YouTube events', summary: 'Pick a template per YouTube output', page: 'Stream', on: flag }]);
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
      return { p, s: p.state, y: p.state.youtubeEvents, seen };
    } finally { await new Promise((r) => proxy.close(r)); await srv.close(); }
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => Object.fromEntries(p.actions.map((a) => [a.action, a.done]));
  const WAIT = ['yte-refresh-wait', 'yte-refresh-wait', 'yte-refresh-wait']; // unknown action: only gives the answers time

  test('flag on: the button shows; nothing is read from YouTube until the window opens; then both rows and the templates show', async () => {
    const idle = await probe({ actions: [] });
    assert.equal(node(idle.p, 'youtubeEventsBtn').visible, true);
    assert.deepEqual(idle.seen, [], 'no YouTube call at app start');
    const r = await probe({ actions: ['yte-open', ...WAIT] });
    assert.equal(done(r.p)['yte-open'], true);
    assert.equal(r.y.open, true);
    assert.equal(r.y.signedIn, true);
    assert.equal(r.y.templates, 2);
    assert.deepEqual(r.y.rows.map((x) => x.label), ['YouTube H · 4K', 'YouTube V · 1080p']);
    assert.match(r.y.rows[0].status, /Not chosen\. Go live will stop until you pick one/);
    assert.equal(r.y.rows[0].saveEnabled, false);
    for (const id of ['youtube-h', 'youtube-v']) {
      assert.ok(node(r.p, `yteTemplate:${id}`) && node(r.p, `yteTitle:${id}`) && node(r.p, `yteSave:${id}`) && node(r.p, `yteStatus:${id}`), id);
    }
    assert.ok(node(r.p, 'yteRefresh'));
    assert.equal(node(r.p, 'yteSignin').visible, false);
    assert.deepEqual(r.seen.map((x) => `${x.method} ${x.url}`), ['GET /ui/api/youtube/events', 'POST /ui/api/youtube/templates']);
    assert.deepEqual(r.seen[1].body, {}, 'the first list may come from the server cache');
  });

  test('pick and Save post the right body and the status shows the saved choice; H and V are separate', async () => {
    const r = await probe({ actions: ['yte-open', ...WAIT, 'yte-pick:youtube-h:tpl-new', 'yte-title:youtube-h:Tonight%20at%209', 'yte-save:youtube-h', ...WAIT] });
    assert.equal(done(r.p)['yte-save:youtube-h'], true, JSON.stringify(r.y));
    const set = r.seen.filter((x) => x.url === '/ui/api/youtube/event/set');
    assert.equal(set.length, 1);
    assert.deepEqual(set[0].body, { output: 'youtube-h', templateId: 'tpl-new', title: 'Tonight at 9' });
    const [h, v] = r.y.rows;
    assert.equal(h.template, 'tpl-new');
    assert.equal(h.title, 'Tonight at 9');
    assert.match(h.status, /^Saved: "Tonight at 9", made from "Friday night stream"\./);
    assert.equal(v.template, null, 'V is its own choice');
    assert.match(v.status, /Not chosen/);
    // picking fills the title with the template's title
    const p = await probe({ actions: ['yte-open', ...WAIT, 'yte-pick:youtube-v:tpl-old'] });
    assert.equal(p.y.rows[1].title, 'Older stream');
    assert.equal(p.y.rows[1].saveEnabled, true);
    assert.equal(node(p.p, 'yteTitle:youtube-v').text, 'Older stream');
  });

  test('a title with < or > (or empty or over 100 characters) turns Save off and says why', async () => {
    const lt = await probe({ actions: ['yte-open', ...WAIT, 'yte-pick:youtube-h:tpl-new', 'yte-title:youtube-h:a%3Cb', 'yte-save:youtube-h'] });
    assert.equal(lt.y.rows[0].saveEnabled, false);
    assert.match(lt.y.rows[0].why, /cannot contain < or >/);
    assert.equal(node(lt.p, 'yteSave:youtube-h').enabled, false);
    assert.match(node(lt.p, 'yteWhy:youtube-h').text, /cannot contain < or >/);
    assert.equal(done(lt.p)['yte-save:youtube-h'], false, 'the save was refused');
    assert.equal(lt.seen.filter((x) => x.url.endsWith('/event/set')).length, 0, 'nothing was sent');
    const empty = await probe({ actions: ['yte-open', ...WAIT, 'yte-pick:youtube-h:tpl-new', 'yte-title:youtube-h:'] });
    assert.match(empty.y.rows[0].why, /Type a title/);
    const long = await probe({ actions: ['yte-open', ...WAIT, 'yte-pick:youtube-h:tpl-new', `yte-title:youtube-h:${'x'.repeat(101)}`] });
    assert.match(long.y.rows[0].why, /longer than 100/);
    const gt = await probe({ actions: ['yte-open', ...WAIT, 'yte-pick:youtube-h:tpl-new', 'yte-title:youtube-h:a%3Eb'] });
    assert.equal(gt.y.rows[0].saveEnabled, false);
  });

  test('Refresh list asks the server to refresh; signed out shows the Settings pointer and reads no templates', async () => {
    const r = await probe({ actions: ['yte-open', ...WAIT, 'yte-refresh', ...WAIT] });
    assert.equal(done(r.p)['yte-refresh'], true);
    const t = r.seen.filter((x) => x.url === '/ui/api/youtube/templates');
    assert.deepEqual(t.map((x) => x.body), [{}, { refresh: true }]);
    const out = await probe({ signedIn: false, actions: ['yte-open', ...WAIT] });
    assert.equal(out.y.signedIn, false);
    assert.equal(node(out.p, 'yteSignin').visible, true);
    assert.match(node(out.p, 'yteSignin').text, /Settings > Connections > Sign in with YouTube/);
    assert.equal(out.seen.filter((x) => x.url === '/ui/api/youtube/templates').length, 0, 'no quota spent while signed out');
  });

  test('flag off: no button, the window does not open, nothing is asked of YouTube', async () => {
    const r = await probe({ flag: false, actions: ['yte-open', ...WAIT] });
    assert.equal(node(r.p, 'youtubeEventsBtn').visible, false);
    assert.equal(done(r.p)['yte-open'], false);
    assert.equal(r.y.open, false);
    assert.deepEqual(r.seen, []);
  });

  test('Go live refused for a missing event: the server\'s detail is shown and the picker opens', async () => {
    const detail = 'YouTube H has no event chosen. Pick a previous broadcast under YouTube event, then Go live.';
    const r = await probe({ start: { verdict: 'refuse', reason: 'youtube-event-missing', detail }, actions: ['yte-golive', ...WAIT, ...WAIT] });
    assert.equal(r.s.note, detail);
    assert.equal(r.y.open, true, 'the picker opened');
    assert.equal(r.s.live, false);
    const failed = await probe({ start: { verdict: 'refuse', reason: 'youtube-event-failed', detail: 'YouTube said no: quota used up.' }, actions: ['yte-golive', ...WAIT] });
    assert.equal(failed.s.note, 'YouTube said no: quota used up.');
    const other = await probe({ start: { verdict: 'refuse', reason: 'no-outputs-enabled', detail: 'No output is switched on.' }, actions: ['yte-golive', ...WAIT] });
    assert.equal(other.s.note, 'No output is switched on.');
    assert.equal(other.y.open, false, 'only a YouTube event refusal opens the picker');
  });

  test('a start that made YouTube events shows their warnings', async () => {
    const r = await probe({ start: { verdict: 'allow', youtubeEvents: [{ output: 'youtube-h', title: 'T', warnings: ['Thumbnail not copied.'] }, { output: 'youtube-v', title: 'T2', warnings: [] }] }, actions: ['yte-golive', ...WAIT] });
    assert.match(r.s.note, /Thumbnail not copied\./);
  });
});
