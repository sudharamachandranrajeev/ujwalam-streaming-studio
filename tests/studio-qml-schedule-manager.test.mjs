// SPDX-License-Identifier: GPL-3.0-or-later
// QML scheduling manager (SM1-SM4, plan 2026-11-25-scheduling-manager.md): ScheduleCenter.qml, ScheduleView.qml and
// ScheduleWindow.qml. Headless probe (UJWALAM_HEADLESS=1, offscreen; the own window is never shown) against a real UI
// server and the fake host, a temp data dir with placeholder clips, no network. Probe actions: sched:open, sched:close,
// sched:window-open, sched:window-dock, sched:window-close, sched:refresh, sched:search:<text>, sched:target:<id>,
// sched:state:<id>, sched:sort:<asc|desc>, sched:move|remove|now|retry:<key>[:<UTC time>], sched:startmove:<key>,
// sched:moveto:<text>, sched:gomove, sched:moveday:<day>:<new day>, sched:removefailed, sched:undo (the buttons' own click
// functions). The studio-ui-schedule-manager test covers the routes; this one covers the window and what a click sends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { IG_QUEUE_NAME, createInstagramQueue } from '../services/posting/instagram-queue.mjs';
import { postId } from '../services/posting/index.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const NOW = Date.now();
// Local noon-ish times on later days, so the day groups do not depend on the time of day the test runs.
const at = (days, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString().replace(/\.\d+Z$/, 'Z'); };
const dayKey = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const MOVE = 'ui/api/posts/auto/queue/move';
const REMOVE = 'ui/api/posts/auto/queue/remove';
const RETRY = 'ui/api/posts/queue/retry';
const IGNOW = 'ui/api/posts/schedule/instagram-now';

function makePost(root, name, kind, target = 'youtube-shorts') {
  const video = Buffer.from(`${name}`.repeat(10));
  const sha = createHash('sha256').update(video).digest('hex');
  const dir = path.join(root, 'posts', name, target);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'v.mp4'), video);
  const stamp = '2026-11-08T09:00:00.000Z';
  writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
    version: 1, title: `${name} title`, description: 'D', tags: ['g'], hashtags: ['#Shorts'], target, privacy: 'private', status: 'approved',
    source: { run: 'run1', clipId: name, kind, layout: 'v', startSec: 0, endSec: 30, score: null, sha256: sha },
    video: { file: 'v.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
  }));
  return { key: `${sha}:${target}`, entry: { sha256: sha, target, status: 'approved', dir, clipId: name, createdAt: stamp, updatedAt: stamp }, id: postId({ sha256: sha, target }) };
}

describe('QML studio: scheduling manager (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // Six posts over two days: A and B waiting (day 2), C uploaded (video), D failed, F failed on Instagram (day 3), E = A's Reel.
  function small(dataDir) {
    const P = {};
    P.a = makePost(dataDir, 'alpha', 'short'); P.b = makePost(dataDir, 'bravo', 'montage'); P.c = makePost(dataDir, 'charlie', 'long-highlights', 'youtube-video');
    P.d = makePost(dataDir, 'delta', 'short'); P.f = makePost(dataDir, 'foxtrot', 'short');
    writeFileSync(path.join(dataDir, 'posting', 'ledger.json'), JSON.stringify({ version: 1, entries: Object.fromEntries(Object.values(P).map((x) => [x.key, x.entry])) }));
    const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => NOW);
    for (const x of [P.a, P.b, P.c, P.d]) q.add(x.id);
    q.patch(P.a.id, { publishAt: at(2, 12) });
    q.patch(P.b.id, { publishAt: at(2, 15) });
    q.patch(P.c.id, { state: 'done', publishAt: at(3, 9), sentPublishAt: at(3, 9) });
    q.patch(P.d.id, { state: 'failed', publishAt: at(3, 11), reason: 'upload-failed' });
    const ig = createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME), () => NOW);
    ig.add(P.a.id, at(2, 13));
    ig.add(P.f.id, at(3, 14)); ig.patch(P.f.id, { state: 'failed', reason: 'limit-reached' });
    return P;
  }
  // 1000 queued posts spread over 10 days (written as the queue file itself: adding one by one would take minutes).
  function big(dataDir) {
    const items = {};
    for (let i = 0; i < 1000; i++) {
      const id = `bulk${String(i).padStart(4, '0')}`;
      items[id] = { id, state: 'queued', attempts: 0, nextAt: null, reason: null, videoId: null, session: null, publishAt: at(1 + Math.floor(i / 100), 6 + Math.floor((i % 100) / 10), (i % 10) * 5), enqueuedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
    }
    writeFileSync(path.join(dataDir, 'posting', QUEUE_NAME), JSON.stringify({ version: 1, items, note: null }));
  }
  async function probe({ actions = [], prepare = small, ms = Math.max(9000, 4000 + actions.length * 800) } = {}) {
    const dataDir = mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'ujw-qmlsm-')); dirs.push(dataDir);
    mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
    const flags = createFlags({ dataDir });
    flags.set('posting', true);
    const P = prepare(dataDir);
    const fake = createFakeHost({ outputsReady: true });
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 's'.repeat(40);
    const youtube = { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, fetchImpl: async () => { throw new Error('no network in tests'); }, outputsStatus: async () => ({ sinks: [] }) };
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, bots: createFakeBots(), limits: { statusPollMs: 50 }, tcpAnswers: async () => false, botConfig: () => ({}), now: () => Date.now(), youtube, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await new Promise((resolve) => {
        const child = spawn(SHELL_EXE, [], {
          windowsHide: true,
          env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1',
            UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 30_000);
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
      });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      const yq = () => createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
      const iq = () => createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME));
      return { p, s: p.state.schedule, state: p.state, P, yq, iq, dataDir };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => [a.action, a.done]);
  const WAIT = ['sched:search:'];
  const K = (P) => ({ a: `yt:${P.a.id}`, b: `yt:${P.b.id}`, c: `yt:${P.c.id}`, d: `yt:${P.d.id}`, ea: `ig:${P.a.id}`, f: `ig:${P.f.id}` });

  test('the schedule is read only while the manager is open; More > Scheduled posts opens the panel', async () => {
    const closed = await probe({ actions: ['more-open'] });
    assert.deepEqual([closed.s.open, closed.s.loaded, closed.s.reads, closed.s.rowsMade], [false, false, 0, 0], 'nothing read, nothing built, until it is opened');
    assert.ok(closed.state.more.items.some((i) => i.id === 'schedule' && i.enabled && i.tip !== ''), 'a labelled menu item with a tip');
    const viaMenu = await probe({ actions: ['more-open', 'more:schedule'] });
    assert.deepEqual([viaMenu.s.open, viaMenu.s.loaded, viaMenu.s.reads], [true, true, 1], 'one read on opening');
    assert.equal(viaMenu.s.shownRows, 6);
  });

  test('the list: days with headers, target, time, clip name and state in plain words', async () => {
    const r = await probe({ actions: ['sched:open'] });
    const s = r.s, k = K(r.P);
    assert.deepEqual(s.groups.map((g) => [g.day, g.count]), [[dayKey(2), 3], [dayKey(3), 3]]);
    assert.deepEqual(s.shownKeys, [k.a, k.ea, k.b, k.c, k.d, k.f], 'by time inside each day');
    const by = Object.fromEntries(s.rows.map((x) => [x.key, x]));
    assert.deepEqual([by[k.a].targetText, by[k.a].hhmm, by[k.a].title, by[k.a].stateText], ['YouTube Shorts', '12:00', 'alpha title', 'Waiting to upload']);
    assert.deepEqual([by[k.ea].targetText, by[k.ea].hhmm, by[k.ea].stateText], ['Instagram Reels', '13:00', 'Waiting to post']);
    assert.deepEqual([by[k.c].targetText, by[k.c].stateText, by[k.c].buttons], ['YouTube video', 'Uploaded, goes public at its time', []]);
    assert.deepEqual([by[k.d].stateText, by[k.d].buttons], ['Failed', ['remove', 'retry']]);
    assert.match(by[k.d].reasonText, /Upload failed \(upload-failed\)/);
    assert.deepEqual(by[k.a].buttons, ['move', 'remove', 'now']);
    assert.deepEqual(by[k.ea].buttons, ['now'], 'an Instagram post has no Move or Remove');
    assert.deepEqual(by[k.f].buttons, ['retry']);
    assert.equal(by[k.a].channel, '', 'the row model carries a channel field (SM5)');
    assert.deepEqual([s.summary, s.counts.failed], ['6 scheduled posts, 2 failed', 2]);
  });

  test('opens its own window from the panel and docks back; the hidden test mode never shows a window', async () => {
    const w = await probe({ actions: ['sched:open', 'sched:window-open'] });
    assert.deepEqual([w.s.windowOpen, w.s.open, w.s.windowMade, w.s.window.visible], [true, false, true, false], 'the panel folds away; never visible while headless');
    assert.equal(w.s.shownRows, 6, 'the same list');
    const d = await probe({ actions: ['sched:window-open', 'sched:window-dock'] });
    assert.deepEqual([d.s.windowOpen, d.s.open], [false, true], 'Dock returns to the panel');
    const x = await probe({ actions: ['sched:window-open', 'sched:window-close'] });
    assert.deepEqual([x.s.windowOpen, x.s.open], [false, true], 'closing the window returns to the panel');
    const again = await probe({ actions: ['sched:window-open', 'sched:window-dock', 'sched:window-open'] });
    assert.deepEqual([again.s.windowOpen, again.s.reads >= 1], [true, true]);
  });

  test('search, filter by place and state, sort by time', async () => {
    const k = (r) => K(r.P);
    const q = await probe({ actions: ['sched:open', ...WAIT, 'sched:search:bravo'] });
    assert.deepEqual(q.s.shownKeys, [k(q).b]);
    assert.deepEqual(q.s.groups.map((g) => g.day), [dayKey(2)], 'a day with no match has no header');
    const reel = await probe({ actions: ['sched:open', ...WAIT, 'sched:target:instagram-reels'] });
    assert.deepEqual(reel.s.shownKeys, [k(reel).ea, k(reel).f]);
    const failed = await probe({ actions: ['sched:open', ...WAIT, 'sched:state:failed'] });
    assert.deepEqual(failed.s.shownKeys, [k(failed).d, k(failed).f]);
    const both = await probe({ actions: ['sched:open', ...WAIT, 'sched:state:failed', 'sched:target:youtube-shorts'] });
    assert.deepEqual(both.s.shownKeys, [k(both).d]);
    const none = await probe({ actions: ['sched:open', ...WAIT, 'sched:search:nothing-like-this'] });
    assert.deepEqual([none.s.shownRows, none.s.groups.length], [0, 0]);
    const late = await probe({ actions: ['sched:open', ...WAIT, 'sched:sort:desc'] });
    assert.deepEqual(late.s.shownKeys, [k(late).f, k(late).d, k(late).c, k(late).b, k(late).ea, k(late).a]);
    assert.deepEqual(late.s.groups.map((g) => g.day), [dayKey(3), dayKey(2)]);
    assert.equal(q.s.reads, 1, 'filtering does not read the schedule again');
  });

  test('each action sends its route once per click and changes only its own post', async () => {
    const mv = await probe({ actions: ['sched:open', ...WAIT, `sched:move:yt:${'x'}:2026-01-01T00:00:00Z`] });
    assert.equal(mv.s.sent[MOVE] ?? 0, 0, 'an unknown post sends nothing');
    const P = await probe({ actions: ['sched:open'] }).then((r) => r.P); // ids are the same for the same names
    const k = K(P);
    const target = at(4, 18);
    const m = await probe({ actions: ['sched:open', ...WAIT, `sched:move:${k.a}:${target}`, ...WAIT, ...WAIT] });
    assert.equal(m.s.sent[MOVE], 1);
    assert.equal(new Date(m.yq().get(P.a.id).publishAt).getTime(), new Date(target).getTime());
    assert.equal(new Date(m.yq().get(P.b.id).publishAt).getTime(), new Date(at(2, 15)).getTime(), 'the other post keeps its time');
    assert.match(m.s.message, /^Moved to /);
    const bad = await probe({ actions: ['sched:open', ...WAIT, `sched:move:${k.a}:${at(2, 15)}`, ...WAIT] }); // taken by bravo
    assert.match(bad.s.message, /^Not moved: /);
    const rm = await probe({ actions: ['sched:open', ...WAIT, `sched:remove:${k.a}`, ...WAIT, ...WAIT] });
    assert.equal(rm.s.sent[REMOVE], 1);
    assert.equal(rm.yq().get(P.a.id).state, 'removed');
    assert.ok(!rm.s.shownKeys.includes(k.a), 'it leaves the list');
    const refused = await probe({ actions: ['sched:open', ...WAIT, `sched:remove:${k.c}`, `sched:move:${k.d}:${at(5, 10)}`, `sched:now:${k.d}`, `sched:retry:${k.a}`] });
    assert.deepEqual(done(refused.p).slice(-4).map((x) => x[1]), [false, false, false, false], 'a button the row does not offer does nothing');
    assert.equal(Object.keys(refused.s.sent).length, 0);
    const retry = await probe({ actions: ['sched:open', ...WAIT, `sched:retry:${k.d}`, ...WAIT, ...WAIT] });
    assert.equal(retry.s.sent[RETRY], 1);
    assert.equal(retry.yq().get(P.d.id).state, 'queued');
    const up = await probe({ actions: ['sched:open', ...WAIT, `sched:now:${k.b}`, ...WAIT] });
    assert.equal(up.s.sent[RETRY], 1);
    assert.match(up.s.message, /^Uploading now/);
    const ig = await probe({ actions: ['sched:open', ...WAIT, `sched:now:${k.ea}`, `sched:retry:${k.f}`, ...WAIT, ...WAIT] });
    assert.equal(ig.s.sent[IGNOW], 2);
    assert.deepEqual([ig.iq().get(P.f.id).state, ig.iq().get(P.f.id).reason], ['waiting', null]);
  });

  test('the Move box: typed time in your time zone; a bad one sends nothing', async () => {
    const P = await probe({ actions: ['sched:open'] }).then((r) => r.P);
    const k = K(P);
    const t = new Date(at(4, 18));
    const pad = (n) => String(n).padStart(2, '0');
    const text = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:00`;
    const ok = await probe({ actions: ['sched:open', ...WAIT, `sched:startmove:${k.a}`, `sched:moveto:${encodeURIComponent(text)}`, 'sched:gomove', ...WAIT, ...WAIT] });
    assert.equal(ok.s.sent[MOVE], 1);
    assert.equal(new Date(ok.yq().get(P.a.id).publishAt).getTime(), t.getTime());
    assert.equal(ok.s.moving.mode, '', 'the box closes after a move');
    const bad = await probe({ actions: ['sched:open', ...WAIT, `sched:startmove:${k.a}`, 'sched:moveto:tomorrow', 'sched:gomove', ...WAIT] });
    assert.equal(bad.s.sent[MOVE] ?? 0, 0);
    assert.match(bad.s.message, /^Not moved: type the new time/);
    assert.equal(bad.s.moving.mode, 'row', 'the box stays open to fix it');
  });

  test('bulk: move a day with Undo; remove all failed', async () => {
    const P = await probe({ actions: ['sched:open'] }).then((r) => r.P);
    const k = K(P);
    const mv = await probe({ actions: ['sched:open', ...WAIT, `sched:moveday:${dayKey(2)}:${dayKey(5)}`, ...WAIT, ...WAIT, ...WAIT] });
    assert.equal(mv.s.sent[MOVE], 2, 'the two YouTube posts of that day, one request each');
    assert.equal(new Date(mv.yq().get(P.a.id).publishAt).getTime(), new Date(at(5, 12)).getTime());
    assert.equal(new Date(mv.yq().get(P.b.id).publishAt).getTime(), new Date(at(5, 15)).getTime());
    assert.equal(mv.s.undoCount, 2);
    assert.match(mv.s.message, /^Moved 2 posts to /);
    const undo = await probe({ actions: ['sched:open', ...WAIT, `sched:moveday:${dayKey(2)}:${dayKey(5)}`, ...WAIT, ...WAIT, ...WAIT, 'sched:undo', ...WAIT, ...WAIT, ...WAIT] });
    assert.equal(undo.s.sent[MOVE], 4);
    assert.equal(new Date(undo.yq().get(P.a.id).publishAt).getTime(), new Date(at(2, 12)).getTime());
    assert.equal(new Date(undo.yq().get(P.b.id).publishAt).getTime(), new Date(at(2, 15)).getTime());
    assert.match(undo.s.message, /^Put 2 posts back/);
    assert.equal(undo.s.undoCount, 0);
    const rf = await probe({ actions: ['sched:open', ...WAIT, 'sched:removefailed', ...WAIT, ...WAIT] });
    assert.equal(rf.s.sent[REMOVE], 1, 'only the YouTube failure can be removed; the failed Reel stays');
    assert.equal(rf.yq().get(P.d.id).state, 'removed');
    assert.ok(rf.s.shownKeys.includes(k.f) && !rf.s.shownKeys.includes(k.d));
    const nothing = await probe({ actions: ['sched:open', ...WAIT, `sched:moveday:${dayKey(2)}:nonsense`] });
    assert.equal(nothing.s.sent[MOVE] ?? 0, 0);
    assert.match(nothing.s.message, /^Not moved: type the new day/);
  });

  test('1000 scheduled posts: the list builds a few rows, reads once, and a refresh builds none again', async () => {
    const r = await probe({ prepare: big, actions: ['sched:open', ...WAIT, ...WAIT, 'sched:refresh', ...WAIT, ...WAIT], ms: 14000 });
    const s = r.s;
    assert.equal(s.total, 1000);
    assert.equal(s.shownRows, 1000);
    assert.equal(s.groups.length, 10);
    assert.equal(s.modelCount, 1010, '1000 posts and 10 day headers');
    assert.ok(s.rowsMade < 60, `only the rows on screen exist (${s.rowsMade} made)`);
    assert.ok(s.applyMs < 250, `a read is applied inside the budget (${s.applyMs} ms)`);
    assert.equal(s.reads, 2, 'the open and the one refresh');
    const rows = await probe({ prepare: big, actions: ['sched:open', ...WAIT, 'sched:search:06:05'], ms: 12000 });
    assert.equal(rows.s.shownRows, 10, 'one post at 06:05 on each of the ten days');
    assert.ok(rows.s.rowsMade < 60);
    const settings = await probe({ prepare: big, actions: ['settings-open', 'settings-page:Posting%20%26%20growth', ...WAIT], ms: 12000 });
    assert.equal(settings.s.reads, 0, 'Settings does not read the list');
    assert.ok(!settings.p.tree.some((n) => /^autopostTime:/.test(n.name)), 'Settings has no per-post row');
    const sp = settings.state.settings.postingPage;
    assert.equal(sp.schedCount, 1000);
    assert.match(sp.schedLine, /^1000 scheduled posts, the next on /);
  });

  test('the Settings button opens the manager in its own window', async () => {
    const r = await probe({ actions: ['settings-open', 'settings-page:Posting%20%26%20growth', ...WAIT, 'ap-open-manager', ...WAIT] });
    assert.deepEqual([r.s.windowOpen, r.s.windowMade, r.s.loaded], [true, true, true]);
    const node = r.p.tree.find((n) => n.name === 'autopostOpenManager');
    assert.ok(node && node.visible, 'a button with a plain label');
    assert.match(r.state.settings.postingPage.schedLine, /^6 scheduled posts, the next on /);
  });
});
