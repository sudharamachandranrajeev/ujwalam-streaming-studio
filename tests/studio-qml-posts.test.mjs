// SPDX-License-Identifier: GPL-3.0-or-later
// Posts window in the QML studio (flag posting, plan Q4): the QML twin of the widget openPosts. A hand-made package on disk
// (no ffmpeg), a real UI server, the fake host and a test YouTube sign-in state (no network: Upload is never pressed; the
// tests read whether it is enabled). Edit saves post.json and flags an over-long title; Approve is refused over the limit
// and works after a fix; Open folder goes through the server's seam; the auto-upload queue state shows with Retry now;
// the dry run of the auto-post rules writes nothing. Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen).
// Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeBots, createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { postId } from '../services/posting/index.mjs';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';
import { DB_NAME, openStore } from '../services/analytics/index.mjs';
import { userScheduleFile } from '../services/posting/schedule.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

const VIDEO = Buffer.from('0123456789abcdefghij'.repeat(10));
const SHA = createHash('sha256').update(VIDEO).digest('hex');
const ID = postId({ sha256: SHA, target: 'youtube-shorts' });

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio: Posts window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  function makePackage(dataDir) {
    const dir = path.join(tmp('ujw-qmlposts-pkg-'), 'posts', 'c01', 'youtube-shorts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'full-crop.mp4'), VIDEO);
    writeFileSync(path.join(dir, 'cover.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const stamp = '2026-11-03T18:00:00.000Z';
    writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
      version: 1, title: 'Test title', description: 'Test description', tags: ['gaming'], hashtags: ['#Shorts'], target: 'youtube-shorts',
      privacy: 'private', status: 'draft', source: { run: 'run', clipId: 'c01', layout: 'full-crop', startSec: 10, endSec: 12, sha256: SHA },
      video: { file: 'full-crop.mp4', bytes: VIDEO.length }, cover: { file: 'cover.jpg', atSec: 1 },
      limits: { status: 'unverified', ok: true, checks: [{ field: 'title', value: 10, max: 100, ok: true }] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
    }));
    const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
    mkdirSync(path.dirname(ledgerFile), { recursive: true });
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries: { [`${SHA}:youtube-shorts`]: { sha256: SHA, target: 'youtube-shorts', status: 'draft', dir, clipId: 'c01', createdAt: stamp, updatedAt: stamp } } }));
    return dir;
  }
  async function probe({ actions, flagOn = true, signedIn = false, queued = null, igJob = null, growth = null, ms = Math.max(7000, 3000 + actions.length * 700) }) {
    const dataDir = tmp('ujw-qmlposts-');
    const dir = makePackage(dataDir);
    const flags = createFlags({ dataDir });
    if (flagOn) flags.set('posting', true);
    if (growth) { // PT4: the growth flag and stored AN1 numbers (fixture), UTC schedule
      flags.set('growth', true);
      writeFileSync(userScheduleFile(dataDir), JSON.stringify({ placement: 'random-daily', postsPerDayMax: 6, windowStart: '09:00', windowEnd: '23:00', minGapMinutes: 60, timeZone: 'UTC' }));
      const st = openStore(path.join(dataDir, DB_NAME));
      for (const v of growth) {
        st.upsertVideo({ videoId: v.id, kind: 'short', postId: v.id, uploadedAt: v.at });
        st.setState(v.id, 'public', v.at);
        st.addSnapshot({ videoId: v.id, fetchedAt: new Date(Date.parse(v.at) + 25 * 3600_000).toISOString(), ageHours: 25, data: { privacy: 'public', views: v.views }, analytics: { views: v.views, averageViewPercentage: 80, subscribersGained: 1 } });
      }
      st.close();
    }
    if (queued) { const q = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME)); q.add(ID); q.patch(ID, queued); }
    // D444: the clip's Instagram job (instagram-queue.json)
    if (igJob) { const { queueInstagramNow, createInstagramQueue, IG_QUEUE_NAME } = await import('../services/posting/instagram-queue.mjs'); queueInstagramNow(dataDir, ID); createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME)).patch(ID, igJob); }
    const opened = [];
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'p'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost({ outputsReady: true }), launchKey: key, dataDir, flags, bots: createFakeBots(), authority: null,
      feedbackDir: tmp('ujw-qmlposts-fb-'), openFolder: (d) => { opened.push(d); return true; },
      youtube: { auth: { status: async () => ({ signedIn, hasClient: signedIn }) } }, limits: { statusPollMs: 50, loadRetryMs: [1, 1, 1] }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state.posts, opened, dir, dataDir, postJson: () => JSON.parse(readFileSync(path.join(dir, 'post.json'), 'utf8')) };
    } finally { await srv.close(); }
  }
  const done = (p) => p.actions.map((a) => a.done);
  const enc = encodeURIComponent;

  test('the list, the form and the auto-post line; an over-long title is saved and flagged, Approve refused', async () => {
    const r = await probe({ actions: ['posts-open', 'posts-pick:0', `posts-title:${enc('x'.repeat(150))}`, `posts-tags:${enc('a, b ,, c')}`, 'posts-save', 'posts-approve'] });
    assert.deepEqual(done(r.p), [true, true, true, true, true, true]);
    assert.equal(r.s.rows.length, 1);
    assert.match(r.s.rows[0], /^c01 {2}youtube-shorts {3}draft \/ check$/);
    assert.match(r.s.meta, /youtube-shorts {2}full-crop {2}10-12 s {2}privacy private {2}status draft/);
    assert.match(r.s.limits, /title 150\/100 chars OVER/);
    assert.match(r.s.info, /^Not done: /, 'approve over the limit is refused');
    assert.match(r.s.autoInfo, /^Auto-post: off \(review-first\)/);
    const pj = r.postJson();
    assert.equal(pj.title.length, 150);
    assert.deepEqual(pj.tags, ['a', 'b', 'c']);
    assert.equal(pj.status, 'draft');
    assert.equal(r.s.ytShown, true);
    assert.match(r.s.ytInfo, /^Not signed in\./);
    assert.equal(r.s.uploadEnabled, false);
  });

  test('signed in: a fixed title approves; Upload as private is enabled; Open folder uses the seam; the dry run writes nothing', async () => {
    const r = await probe({ signedIn: true, actions: ['posts-open', 'posts-pick:0', `posts-title:${enc('Short title')}`, 'posts-save', 'posts-approve', 'posts-folder', 'posts-preview'] });
    assert.deepEqual(done(r.p), [true, true, true, true, true, true, true]);
    assert.equal(r.postJson().status, 'approved');
    assert.equal(r.s.info, 'Saved.');
    assert.match(r.s.rows[0], /approved$/);
    assert.equal(r.s.ytInfo, 'Approved. Ready to upload as private.');
    assert.equal(r.s.uploadEnabled, true);
    assert.equal(r.s.checkEnabled, false);
    assert.deepEqual(r.opened, [r.dir]);
    assert.match(r.s.previewInfo, /Dry run: \d+ would be queued, \d+ skipped\. Nothing is written or sent\./);
  });

  test('a failed auto-upload: the queue state and Retry now, which queues it again', async () => {
    const r = await probe({ queued: { state: 'failed', reason: 'upload-failed', attempts: 3 }, actions: ['posts-open', 'posts-pick:0', 'posts-retry'] });
    assert.deepEqual(done(r.p), [true, true, true]);
    assert.match(r.s.queueInfo, /^Upload queue: /);
    assert.equal(r.s.info, 'Queued again. It uploads at the next check if no stream is live.');
    assert.equal(createUploadQueue(path.join(r.dataDir, 'posting', QUEUE_NAME)).get(ID).state, 'queued');
    assert.match(r.s.rows[0], /\/ queued$/);
  });

  test('flag off: Posts unavailable; actions need an open window and a picked package', async () => {
    let r = await probe({ flagOn: false, actions: ['posts-save', 'posts-open'] });
    assert.deepEqual(done(r.p), [false, true]);
    assert.match(r.s.info, /^Posts unavailable: /);
    r = await probe({ actions: ['posts-open', 'posts-approve', 'posts-pick:3'] });
    assert.deepEqual(done(r.p), [true, false, false]);
    assert.equal(r.s.formShown, false);
  });
  // ---- PT4 (D410): growth suggestion in the Posts window ----
  const fixture = (n, hour, views, from) => Array.from({ length: n }, (_, i) => ({ id: `v${hour}x${from + i}`, at: new Date(Date.UTC(2026, 9, 1 + from + i, hour)).toISOString(), views }));
  const GROWTH = [...fixture(12, 19, 134, 0), ...fixture(12, 10, 100, 0)];

  test('PT4: the suggestion shows with its numbers; nothing changes until Apply; Apply then Undo put the schedule back', async () => {
    let r = await probe({ growth: GROWTH, actions: ['posts-open'] });
    assert.equal(r.s.growthStatus, 'open');
    assert.equal(r.s.growthText, 'Move 2 of your daily posts to 18:00-21:00: +34 % 24 h views on 12 posts.');
    assert.match(r.s.growthApplyText, /^Replaces your random \d+-\d+ a day with fixed times \d\d:\d\d.* \(Undo keeps your old schedule\)\.$/, 'Apply says what it replaces');
    assert.match(r.s.growthNumbers, /^12 posts at 18:00-21:00 averaged 134 views in 24 h; 12 posts at other times averaged 100\./);
    assert.equal(JSON.parse(readFileSync(userScheduleFile(r.dataDir), 'utf8')).placement, 'random-daily', 'not applied without the click');
    r = await probe({ growth: GROWTH, actions: ['posts-open', 'posts-preview', 'posts-growth-apply', 'posts-preview'] });
    assert.deepEqual(done(r.p), [true, true, true, true]);
    assert.equal(r.s.growthStatus, 'applied');
    assert.match(r.s.growthInfo, /^Applied: /);
    assert.equal(JSON.parse(readFileSync(userScheduleFile(r.dataDir), 'utf8')).placement, 'custom');
  });

  test('PT4: Dismiss changes nothing; growth flag off shows no suggestion', async () => {
    let r = await probe({ growth: GROWTH, actions: ['posts-open', 'posts-preview', 'posts-growth-dismiss', 'posts-preview'] });
    assert.deepEqual(done(r.p), [true, true, true, true]);
    assert.equal(r.s.growthStatus, '');
    assert.match(r.s.growthInfo, /^Dismissed\. Nothing changed\./);
    assert.equal(JSON.parse(readFileSync(userScheduleFile(r.dataDir), 'utf8')).placement, 'random-daily');
    r = await probe({ actions: ['posts-open', 'posts-growth-apply'] });
    assert.deepEqual(done(r.p), [true, false]);
    assert.equal(r.s.growthText, '');
  });
  // D444: the Instagram Reels state per clip, in plain words, on one line that is always there (no layout jump)
  test('Instagram state: not queued, waiting with its time, posted, failed with the plain reason, dropped', async () => {
    let r = await probe({ actions: ['posts-open', 'posts-pick:0'] });
    assert.equal(r.s.igText, 'Not in the Instagram queue.');
    assert.doesNotMatch(r.s.rows[0], /IG /);
    r = await probe({ igJob: { state: 'waiting', dueAt: '2026-11-24T12:00:00.000Z', reason: 'stream-live' }, actions: ['posts-open', 'posts-pick:0'] });
    assert.match(r.s.igText, /^Waiting to post at .+\. Waiting until the stream ends\.$/);
    assert.match(r.s.rows[0], / \/ IG waiting$/);
    r = await probe({ igJob: { state: 'done', postedAt: '2026-11-24T12:00:00.000Z' }, actions: ['posts-open', 'posts-pick:0'] });
    assert.match(r.s.igText, /^Posted to Instagram /); assert.match(r.s.rows[0], /IG posted$/);
    r = await probe({ igJob: { state: 'failed', reason: 'over-limit' }, actions: ['posts-open', 'posts-pick:0'] });
    assert.match(r.s.igText, /^Not posted: it failed\. The caption is over an Instagram limit .+ The clip file is kept\.$/);
    r = await probe({ igJob: { state: 'dropped', reason: 'dropped-by-user' }, actions: ['posts-open', 'posts-pick:0'] });
    assert.equal(r.s.igText, 'Dropped from the Instagram queue; it is not posted there.');
  });
});
