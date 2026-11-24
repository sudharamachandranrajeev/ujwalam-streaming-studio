// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end auto posting against a local fake Google/YouTube HTTP server (127.0.0.1 only, no OAuth, no real network).
// Chain: finished clip job -> packageUploads (montage / won-reel) -> auto rules -> resumable upload -> status check -> markPosted.
// The only seams used: fetchImpl (rewrites the googleapis host to the local server) and a fake token provider (auth).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { QUEUE_NAME, createPostChain, createUploadQueue, readQueueSummary, requestRunNow } from '../services/posting/auto-chain.mjs';
import { createPostStore } from '../services/posting/index.mjs';
import { videoBinding } from '../services/posting/clips-source.mjs';
import { checkPostStatus } from '../services/posting/youtube.mjs';
import { tasksDir } from '../services/studio-ui/tasks.mjs';
import { READONLY_SCOPE, SCOPE } from '../services/posting/oauth.mjs';
import { DELETE_FLAG } from '../services/posting/delete-uploaded.mjs';
import { createQuotaBudget, loadQuota } from '../services/posting/quota-budget.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-e2e-post-')); tmp.push(d); return d; };
const servers = [];
after(() => { for (const s of servers) s.close(); for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const FFMPEG = process.execPath; // stands in for ffmpeg: the cover step fails and the package has no cover
const PROFILE = { handles: { youtube: '@example-channel', twitch: 'example-channel' }, links: { discord: 'https://example.invalid/d' } };
const T0 = Date.parse('2026-11-09T10:00:00Z');
const IDLE = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }, { id: 'rec', kind: 'record', state: 'stopped' }] };
const LIVE = { sinks: [{ id: 'yt', kind: 'stream', state: 'live' }] };
const authOk = { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'fake-access', grantedScopes: async () => [SCOPE, READONLY_SCOPE] };
// D375: automatic uploads always go up scheduled. The tests use a 6 h gap on a 1-minute grid (the repo default is 1 h on whole
// hours) so the times below stay easy to read; the delete flag stays off unless a test turns it on.
const TEST_SCHEDULE = { intervalHours: 6, placement: 'fill-gaps', alignMinutes: 1, lookbackDays: 120, minLeadHours: 1, marginMinutes: 15,
  chunkDeadlineSeconds: 120, fallbackKbps: 1000, maxPages: 20, pageSize: 50, maxAheadDays: 730 };
const CHAIN_FLAGS = { isOn: (id) => id !== DELETE_FLAG };

/** Fake Google: resumable insert sessions, chunk PUTs, progress query, videos.list. `opt` switches inject faults. */
async function fakeGoogle() {
  // Channel read (post-schedule): `channel` = other videos already on the channel (newest first, after our uploads);
  // `channelError` = HTTP answer for channels.list ('scope' -> 403 insufficientPermissions, 500 -> server error);
  // `hideOwnUploads` leaves our own uploads out of the channel list (to prove the queue's own slots count by themselves).
  const opt = { initFailures: 0, chunkFailOnce: false, dropFinalAnswer: false, queryAfterComplete: 'resource' /* | 'gone' | 'error' */, stallFinal: null /* | 'hold' | 'finalize' */,
    channel: [], channelError: null, hideOwnUploads: false, initQuota: 0 /* PT2: 403 quotaExceeded answers */, onVideo: null /* PT2: called when a video completes */ };
  const sessions = new Map(); const videos = []; const log = [];
  let chunkFailed = false;
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname === '/upload/youtube/v3/videos') {
        log.push('init');
        if (opt.initFailures > 0) { opt.initFailures--; return send(503, { error: 'busy' }); }
        if (opt.initQuota > 0) { opt.initQuota--; return send(403, { error: { code: 403, errors: [{ domain: 'youtube.quota', reason: 'quotaExceeded' }] } }); }
        const id = `s${sessions.size + 1}`;
        sessions.set(id, { meta: JSON.parse(body.toString('utf8')), total: Number(req.headers['x-upload-content-length']), got: Buffer.alloc(0), video: null });
        return send(200, undefined, { location: `http://127.0.0.1:${srv.address().port}/session/${id}` });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
        const s = sessions.get(url.pathname.split('/')[2]);
        if (!s) return send(404, { error: 'gone' });
        const cr = String(req.headers['content-range']);
        if (cr.startsWith('bytes */')) {
          log.push('query');
          if (s.video) {
            if (opt.queryAfterComplete === 'gone') return send(404, { error: 'gone' });
            if (opt.queryAfterComplete === 'error') return send(503, { error: 'busy' });
            return send(200, s.video);
          }
          return send(308, undefined, s.got.length ? { range: `bytes=0-${s.got.length - 1}` } : {});
        }
        log.push('chunk');
        if (opt.chunkFailOnce && !chunkFailed) { chunkFailed = true; return send(403, { error: 'quota' }); }
        if (opt.stallFinal && s.got.length + body.length >= s.total) {
          // The final chunk never gets an answer: 'hold' = Google never finalizes it; 'finalize' = it did, the answer is lost.
          log.push('stall');
          if (opt.stallFinal === 'finalize') {
            s.got = Buffer.concat([s.got, body]);
            s.video = { id: `vid${videos.length + 1}`, status: { uploadStatus: 'uploaded', privacyStatus: s.meta.status.privacyStatus, ...(s.meta.status.publishAt ? { publishAt: s.meta.status.publishAt } : {}) }, snippet: s.meta.snippet };
            videos.push({ ...s.video, bytes: s.got.length });
          }
          setTimeout(() => req.socket.destroy(), 5000).unref();
          return undefined;
        }
        s.got = Buffer.concat([s.got, body]);
        if (s.got.length >= s.total) {
          s.video = { id: `vid${videos.length + 1}`, status: { uploadStatus: 'uploaded', privacyStatus: s.meta.status.privacyStatus, ...(s.meta.status.publishAt ? { publishAt: s.meta.status.publishAt } : {}) }, snippet: s.meta.snippet };
          videos.push({ ...s.video, bytes: s.got.length });
          if (opt.onVideo) opt.onVideo(s.video);
          if (opt.dropFinalAnswer) return req.socket.destroy(); // upload completed on the server, the answer never arrives
          return send(200, s.video);
        }
        return send(308, undefined, { range: `bytes=0-${s.got.length - 1}` });
      }
      const all = () => [...(opt.hideOwnUploads ? [] : [...videos].reverse()), ...opt.channel];
      if (req.method === 'GET' && url.pathname === '/youtube/v3/videos') {
        log.push('list');
        const ids = String(url.searchParams.get('id') ?? '').split(',');
        const found = ids.map((id) => all().find((x) => x.id === id)).filter(Boolean);
        return send(200, { items: found.map((v) => ({ id: v.id, status: v.status, processingDetails: { processingStatus: 'succeeded' } })) });
      }
      if (req.method === 'GET' && url.pathname === '/youtube/v3/channels') {
        log.push('channels');
        if (url.searchParams.get('mine') !== 'true' || !/contentDetails/.test(url.searchParams.get('part') ?? '')) return send(400, {});
        if (opt.channelError === 'scope') return send(403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } });
        if (opt.channelError) return send(opt.channelError, { error: { code: opt.channelError } });
        return send(200, { items: [{ id: 'UCfake', contentDetails: { relatedPlaylists: { uploads: 'UUfake' } } }] });
      }
      if (req.method === 'GET' && url.pathname === '/youtube/v3/playlistItems') {
        log.push('playlist');
        if (url.searchParams.get('playlistId') !== 'UUfake') return send(404, {});
        const size = Number(url.searchParams.get('maxResults')); const from = Number(url.searchParams.get('pageToken') ?? 0);
        const list = all(); const page = list.slice(from, from + size);
        // A public video carries its public time (v.publicAt, else an old one); a missing one makes the read incomplete.
        return send(200, { items: page.map((v) => ({ snippet: { publishedAt: v.addedAt ?? '2026-11-09T09:00:00.000Z' }, contentDetails: { videoId: v.id, ...(v.status?.privacyStatus === 'public' && v.publicAt !== null ? { videoPublishedAt: v.publicAt ?? '2025-01-01T00:00:00.000Z' } : {}) } })), ...(from + size < list.length ? { nextPageToken: String(from + size) } : {}) });
      }
      return send(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const fetchImpl = (u, o) => fetch(String(u).replace('https://www.googleapis.com', base), o); // refuses to leave 127.0.0.1 by construction
  const count = (k) => log.filter((x) => x === k).length;
  return { opt, videos, log, fetchImpl, count, sessions };
}

const ROWS = [
  { name: 'codm_montage_20261109-100000_kills-5_01_v.mp4', kind: 'montage', seconds: 45, music: { source: 'generated' } },
  { name: 'codm_montage_20261109-100000_kills-9_02_h.mp4', kind: 'montage', seconds: 90, music: { source: 'generated' } },
  { name: 'codm_won-reel_20261109-100000_victory-kills-4_01_v-full-crop.mp4', kind: 'won-reel', seconds: 50, music: { source: 'none' } },
];

// Task bar (D311 proposed): a re-slotted or deadline-stopped upload is waiting, not failed, so its task file is removed.
const failedUploadTasks = (e) => {
  let names = []; try { names = readdirSync(tasksDir(e.dataDir)); } catch { /* no task file written */ }
  return names.filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(path.join(tasksDir(e.dataDir), n), 'utf8')))
    .filter((t) => t.kind === 'upload' && t.state === 'failed');
};

function setup(rows = ROWS) {
  const dataDir = mk(); const clips = mk();
  const out = rows.map((r, i) => {
    const file = path.join(clips, r.name);
    writeFileSync(file, Buffer.from(`${r.name}-${i}`.repeat(8)));
    return { file, label: 'x', seconds: r.seconds, kind: r.kind, ...(r.music ? { music: r.music } : {}), video: videoBinding(file), run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-09T09:00:00.000Z' };
  });
  mkdirSync(path.join(dataDir, 'clips', 'runs', 'run1'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: out }));
  const rulesFile = path.join(dataDir, 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ autoUpload: true, rules: [
    { id: 'm-short', target: 'youtube-shorts', minScore: 0, kinds: ['montage', 'won-reel'], maxPerDay: 5 },
    { id: 'm-long', target: 'youtube-video', minScore: 0, kinds: ['montage', 'won-reel'], maxPerDay: 5 }] }));
  const profileFile = path.join(dataDir, 'profile.json'); writeFileSync(profileFile, JSON.stringify(PROFILE));
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  const runDir = path.join(dataDir, 'clips', 'runs', 'run1');
  const clock = { t: T0 };
  const scheduleFile = path.join(dataDir, 'schedule.json'); writeFileSync(scheduleFile, JSON.stringify(TEST_SCHEDULE));
  const chain = (g, extra = {}) => createPostChain({ dataDir, flags: CHAIN_FLAGS, rulesFile, auth: authOk, fetchImpl: g.fetchImpl, now: () => clock.t,
    tickEveryMs: 0, profileFile, ffmpeg: FFMPEG, chunkSize: 16, scheduleFile, ...extra });
  const uploads = () => JSON.parse(readFileSync(path.join(dataDir, 'clips', 'uploads.json'), 'utf8')).files;
  const queue = () => createUploadQueue(path.join(dataDir, 'posting', 'upload-queue.json'), () => clock.t);
  return { dataDir, runDir, ledgerFile, clock, chain, uploads, queue, store: () => createPostStore({ ledgerFile }) };
}

describe('auto post e2e against a local fake YouTube', () => {
  test('success: montage short + long montage + won reel packaged, approved, uploaded private, status checked, posted filled', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = e.chain(g);
    const r = await c.afterRun(e.runDir, IDLE);
    assert.equal(r.packaged, 3);
    assert.equal(g.videos.length, 3);
    assert.ok(g.videos.every((v) => v.status.privacyStatus === 'private'));
    assert.ok(g.videos.every((v) => v.bytes > 16), 'multi-chunk resumable upload');
    assert.deepEqual(e.queue().items().map((i) => i.state), ['done', 'done', 'done']);
    const posts = e.store().list();
    assert.deepEqual(posts.map((p) => `${p.kind}:${p.target}:${p.status}`).sort(),
      ['montage:youtube-shorts:uploaded', 'montage:youtube-video:uploaded', 'won-reel:youtube-shorts:uploaded']);
    // status check through the same fake
    for (const p of posts) {
      const s = await checkPostStatus({ id: p.id, store: e.store(), auth: authOk, fetchImpl: g.fetchImpl });
      assert.equal(s.found, true); assert.equal(s.uploadStatus, 'uploaded'); assert.equal(s.privacyStatus, 'private'); assert.equal(s.processingStatus, 'succeeded');
    }
    const rows = e.uploads();
    assert.deepEqual(rows.map((x) => x.posted.map((p) => [p.target, p.privacy, p.url.startsWith('https://youtu.be/')])),
      [[['youtube-shorts', 'private', true]], [['youtube-video', 'private', true]], [['youtube-shorts', 'private', true]]]);
    assert.ok(!/fake-access/.test(readFileSync(path.join(e.dataDir, 'posting', 'upload-queue.json'), 'utf8')));
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 3, 'a second pass posts nothing new');
  });

  test('failed upload is retried with backoff and never posts twice', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.initFailures = 2;
    await c.afterRun(e.runDir, IDLE);
    let q = e.queue().items()[0];
    assert.equal(q.state, 'queued'); assert.equal(q.attempts, 1); assert.equal(g.videos.length, 0);
    await c.tick(IDLE);
    assert.equal(g.count('init'), 1, 'not retried before nextAt');
    e.clock.t += 5 * 60 * 1000 + 1000; await c.tick(IDLE);
    q = e.queue().items()[0];
    assert.equal(q.attempts, 2); assert.equal(g.count('init'), 2);
    e.clock.t += 5 * 60 * 1000 + 1000; await c.tick(IDLE);
    assert.equal(g.count('init'), 2, 'second wait is 10 min (doubling)');
    e.clock.t += 5 * 60 * 1000; await c.tick(IDLE);
    q = e.queue().items()[0];
    assert.equal(q.state, 'done'); assert.equal(g.videos.length, 1);
    e.clock.t += 24 * 3600 * 1000; await c.tick(IDLE); await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1, 'no duplicate');
    assert.equal(e.uploads()[0].posted.length, 1);
  });

  test('a rejected chunk resumes the same session from Google\'s byte count (one video)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.chunkFailOnce = true;
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[0].state, 'queued');
    e.clock.t += 6 * 60 * 1000; await c.tick(IDLE);
    assert.equal(g.count('init'), 1, 'same session continued');
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'done');
  });

  test('answer lost but upload completed: recorded as posted from the session answer, no retry loop, no duplicate', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.dropFinalAnswer = true;
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1, 'Google has the video');
    const q = e.queue().items()[0];
    assert.equal(q.state, 'done', `queue: ${JSON.stringify(q)}`);
    assert.equal(q.videoId, 'vid1');
    assert.equal(e.store().list()[0].status, 'uploaded');
    assert.equal(e.uploads()[0].posted[0].videoId, 'vid1');
    assert.equal(g.count('init'), 1);
  });

  test('answer lost and the progress query fails once: keeps the session, does not start a second upload', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    g.opt.dropFinalAnswer = true; g.opt.queryAfterComplete = 'error';
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1);
    assert.equal(e.queue().items()[0].state, 'queued');
    e.clock.t += 6 * 60 * 1000; await c.tick(IDLE); // the query still fails: the session must be kept, not replaced
    assert.equal(g.count('init'), 1, 'transient query failure does not start a second upload');
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'queued');
    g.opt.queryAfterComplete = 'resource';
    e.clock.t += 12 * 60 * 1000; await c.tick(IDLE);
    assert.equal(g.count('init'), 1, 'no new session, so no second video');
    assert.equal(g.videos.length, 1);
    assert.equal(e.queue().items()[0].state, 'done');
    assert.equal(e.uploads()[0].posted.length, 1);
  });

  test('never posts while live: nothing packaged-and-sent, mid-upload stop keeps the session, resumes after the stream', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = e.chain(g);
    await c.afterRun(e.runDir, LIVE);
    assert.equal(g.log.length, 0, 'zero requests while live');
    assert.equal(e.store().list().filter((p) => p.status !== 'draft').length, 0, 'not even approved while live');
    await c.tick({ nope: 1 });
    assert.equal(g.log.length, 0, 'unreadable state fails closed');
    // goes live after the first chunk
    let live = false; let flipped = false;
    const sinks = [{ id: 'yt', kind: 'stream' }];
    Object.defineProperty(sinks[0], 'state', { get: () => (live ? 'live' : 'stopped'), enumerable: true });
    const c2 = e.chain({ fetchImpl: async (u, o) => { const r = await g.fetchImpl(u, o); if (!flipped && g.count('chunk') === 1) { flipped = true; live = true; } return r; } });
    await c2.tick({ sinks });
    assert.equal(g.count('chunk'), 1, 'stopped after one chunk');
    assert.equal(g.videos.length, 0);
    assert.match(readQueueSummary(e.dataDir).message, /stream/i);
    await c2.tick({ sinks }); await c2.tick({ sinks });
    assert.equal(g.count('chunk'), 1, 'still live: still nothing');
    live = false; await c2.tick({ sinks });
    assert.equal(g.count('init'), 1); assert.equal(g.videos.length, 1);
    assert.equal(e.queue().items()[0].state, 'done');
  });
});

// ---------------------------------------------------------------- scheduled posting (flag post-schedule, D310 proposed)
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const FIRST = T0 + HOUR + 15 * MIN; // empty channel: now + minLeadHours (1) + marginMinutes (15) on the 1-minute grid (TEST_SCHEDULE)
const iso = (t) => new Date(t).toISOString();
const SCHED_ON = CHAIN_FLAGS;
const SCHED_OFF = { isOn: (id) => id !== 'post-schedule' && id !== DELETE_FLAG };
const authSched = { ...authOk, grantedScopes: async () => [SCOPE, READONLY_SCOPE] };
const vid = (id, privacyStatus, publishAt) => ({ id, status: { privacyStatus, uploadStatus: 'processed', ...(publishAt ? { publishAt } : {}) } });
/** The clip maker publishes one more finished video into uploads.json (same run). */
/** PT2: a quota file with the D375 unit-sum model (each upload 1600 + 50 units), for the tests written for it. */
function unitSumQuota(e) {
  const f = path.join(e.dataDir, 'quota-unit-sum.json');
  writeFileSync(f, JSON.stringify({ model: 'unit-sum', quotaUnitsPerDay: 10000, insertUnits: 1600, thumbnailUnits: 50, readReserveUnits: 100 }));
  return f;
}

function addRow(e, r) {
  const f = path.join(e.dataDir, 'clips', 'uploads.json');
  const doc = JSON.parse(readFileSync(f, 'utf8'));
  const file = path.join(path.dirname(doc.files[0].file), r.name);
  writeFileSync(file, Buffer.from(`${r.name}-late`.repeat(8)));
  doc.files.push({ file, label: 'x', seconds: r.seconds, kind: r.kind, ...(r.music ? { music: r.music } : {}), video: videoBinding(file), run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-09T10:30:00.000Z' });
  writeFileSync(f, JSON.stringify(doc));
}

describe('scheduled posting (post-schedule) against the local fake YouTube', () => {
  const schedChain = (e, g, extra = {}) => e.chain(g, { flags: SCHED_ON, auth: authSched, ...extra });
  const sent = (g) => g.videos.map((v) => v.status.publishAt ?? null); // publish times Google received, in upload order
  const qfile = (e) => JSON.parse(readFileSync(path.join(e.dataDir, 'posting', 'upload-queue.json'), 'utf8'));
  /** A settings file in the test's data folder: the repo defaults with `over` applied. */
  const schedFile = (e, over) => {
    const p = path.join(e.dataDir, 'schedule.json');
    writeFileSync(p, JSON.stringify({ ...TEST_SCHEDULE, ...over }));
    return p;
  };

  test('empty channel: three clips go up private, first at now + lead + margin, then every 6 h, in queue order', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 3);
    assert.ok(g.videos.every((v) => v.status.privacyStatus === 'private'));
    assert.deepEqual(sent(g), [iso(FIRST), iso(FIRST + 6 * HOUR), iso(FIRST + 12 * HOUR)]);
    assert.deepEqual(e.queue().items().map((i) => i.publishAt), sent(g), 'queue order = slot order');
    assert.deepEqual(e.queue().items().map((i) => i.sentPublishAt), sent(g), 'recorded = what Google got');
    // D409 (Codex review 2026-11-21): the channel is read right before every new upload session (the pass's first read
    // serves the first session).
    assert.equal(g.count('channels'), 3, 'one channel read per upload session');
    assert.deepEqual(e.uploads().flatMap((r) => r.posted.map((p) => p.publishAt)).sort(), [...sent(g)].sort());
    const s = readQueueSummary(e.dataDir, null, T0);
    assert.equal(s.nextPublishAt, iso(FIRST)); assert.equal(s.lastPublishAt, iso(FIRST + 12 * HOUR)); assert.equal(s.attention, 0);
    assert.ok(!/fake-access/.test(readFileSync(path.join(e.dataDir, 'posting', 'upload-queue.json'), 'utf8')));
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('channels'), 3, 'nothing new to schedule: no channel read'); assert.equal(g.videos.length, 3);
  });

  test('existing schedule in YouTube Studio: 6 h after the latest FUTURE one; past, public and unlisted ones are ignored', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = [vid('old1', 'private', iso(T0 - 2 * HOUR)), vid('pub1', 'public', iso(T0 + 30 * HOUR)), vid('s1', 'private', iso(T0 + 10 * HOUR)),
      vid('s2', 'private', iso(T0 + 4 * HOUR)), vid('u1', 'unlisted')];
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(T0 + 16 * HOUR)]);
    const q = qfile(e);
    assert.equal(q.schedule.channelLast, iso(T0 + 10 * HOUR)); assert.equal(q.schedule.count, 2); assert.equal(q.schedule.truncated, false);
  });

  test('another clip later: next slot after our own last slot, even when the channel list does not show it yet', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST)]);
    e.clock.t = T0 + 30 * MIN; addRow(e, ROWS[2]);
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST), iso(FIRST + 6 * HOUR)]);
    assert.equal(g.count('channels'), 2);
  });

  test('a failed item keeps its slot (never given back): the next clip goes after it', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    const q = e.queue(); q.patch(q.items()[0].id, { state: 'failed', reason: 'upload-failed' }); // as if it had failed for good
    addRow(e, ROWS[2]);
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[1].publishAt, iso(FIRST + 6 * HOUR));
  });

  test('retries never re-slot while the time is still far enough ahead: same time (re-checked by a fresh read), one video', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.initFailures = 1;
    await c.afterRun(e.runDir, IDLE);
    const slot = e.queue().items()[0].publishAt;
    assert.equal(slot, iso(FIRST)); assert.equal(g.videos.length, 0);
    e.clock.t += 5 * MIN + 1000; await c.tick(IDLE); // 70 min before the slot: still >= the 1 h lead
    assert.equal(g.videos.length, 1);
    assert.deepEqual(sent(g), [slot]); assert.equal(e.queue().items()[0].publishAt, slot);
    // The retry re-checks its slot against a fresh channel read before it starts (Codex review); the slot is still free.
    assert.equal(g.count('channels'), 2);
  });

  test('Codex review: a queued slot that a new channel post now clashes with is re-slotted before its upload starts', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.initFailures = 1; // the first try gets slot FIRST, then its session start fails (no session, backing off)
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[0].publishAt, iso(FIRST)); assert.equal(g.videos.length, 0);
    g.opt.channel = [vid('new', 'private', iso(FIRST + 30 * MIN))]; // scheduled by hand in YouTube Studio meanwhile
    e.clock.t += 5 * MIN + 1000; await c.tick(IDLE);
    assert.deepEqual(sent(g), [iso(FIRST + 30 * MIN + 6 * HOUR)], 'never within the gap of the new post');
    assert.equal(g.count('channels'), 2);
    // Both tries (start and retry) count in today's budget.
    assert.equal(createQuotaBudget({ dataDir: e.dataDir, nowMs: () => e.clock.t }).state().uploads.n, 2);
  });

  test('Codex review: the gap grew while two clips waited: the earlier keeps its slot, the later gets one by the new gap', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.initFailures = 2;
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(e.queue().items().map((i) => i.publishAt), [iso(FIRST), iso(FIRST + 6 * HOUR)]);
    schedFile(e, { intervalHours: 8 });
    e.clock.t += 5 * MIN + 1000; await c.tick(IDLE);
    assert.deepEqual(sent(g), [iso(FIRST), iso(FIRST + 8 * HOUR)]);
  });

  test('Codex review: the daily budget stops uploads from earlier approvals (cap and quota), no channel read, no attempt used', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const rules = JSON.parse(readFileSync(path.join(e.dataDir, 'rules.json'), 'utf8'));
    writeFileSync(path.join(e.dataDir, 'rules.json'), JSON.stringify({ ...rules, maxUploadsPerDay: 2 }));
    const budget = createQuotaBudget({ dataDir: e.dataDir, nowMs: () => e.clock.t, quota: () => loadQuota(e.dataDir, unitSumQuota(e)) });
    budget.chargeUpload(); budget.chargeUpload(); // two uploads already started today (earlier approvals, retries)
    const c = schedChain(e, g, { quotaFile: unitSumQuota(e) }); // PT2: the D375 unit sum (the fallback model)
    await c.afterRun(e.runDir, IDLE);
    let it = e.queue().items()[0];
    assert.equal(g.videos.length, 0); assert.equal(g.count('init'), 0); assert.equal(g.count('channels'), 0);
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'daily-cap-reached'); assert.equal(it.attempts, 0);
    assert.match(readQueueSummary(e.dataDir).message, /uploads per day are used up/);
    // Next UTC day, but the quota units of the Pacific day (until 08:00 UTC) are nearly used up: still waits.
    e.clock.t = Date.parse('2026-11-10T01:00:00Z');
    budget.chargeRead(10000 - 3300 - 1000);
    await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.reason, 'quota-day-used'); assert.equal(g.videos.length, 0);
    // A new Pacific day: it goes up, scheduled.
    e.clock.t = Date.parse('2026-11-10T09:00:00Z');
    await c.tick(IDLE);
    assert.equal(g.videos.length, 1); assert.ok(g.videos[0].status.publishAt);
  });

  test('Codex re-review: a quota that fits no upload (read reserve kept) never uploads; a broken settings file blocks too', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    mkdirSync(path.join(e.dataDir, 'posting'), { recursive: true });
    const own = path.join(e.dataDir, 'posting', 'schedule.json');
    writeFileSync(own, JSON.stringify({ quotaUnitsPerDay: 1700 })); // 1700 - 100 reserve < 1650 per upload
    const c = schedChain(e, g, { quotaFile: unitSumQuota(e) }); // PT2: the D375 unit sum (the fallback model)
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'quota-day-used');
    writeFileSync(own, '{ broken');
    e.clock.t += 31 * MIN; await c.tick(IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'quota-unreadable');
  });

  test('missing readonly scope fails closed: no request to Google, no slot, no upload, no attempt used, plain message', async () => {
    const { grantedScopes: _unused, ...noScopes } = authOk;
    for (const auth of [{ ...authOk, grantedScopes: async () => [SCOPE] }, { ...authOk, grantedScopes: async () => null }, noScopes]) {
      const g = await fakeGoogle(); const e = setup([ROWS[0]]);
      await schedChain(e, g, { auth }).afterRun(e.runDir, IDLE);
      assert.equal(g.log.length, 0);
      const it = e.queue().items()[0];
      assert.equal(it.state, 'queued'); assert.equal(it.publishAt ?? null, null); assert.equal(it.reason, 'schedule-scope-missing'); assert.equal(it.attempts, 0);
      assert.match(readQueueSummary(e.dataDir).message, /Sign in again to allow reading scheduled posts/);
    }
  });

  test('Google refuses the read (403 scope) or fails (500): nothing uploads, nothing is guessed; goes up once the read works', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.channelError = 'scope';
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'schedule-scope-missing');
    g.opt.channelError = 500; e.clock.t += 31 * MIN; await c.tick(IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'schedule-read-failed'); assert.equal(e.queue().items()[0].attempts, 0);
    g.opt.channelError = null; e.clock.t += 6 * MIN; await c.tick(IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(e.clock.t + HOUR + 15 * MIN)]);
  });

  test('nothing while live: no read, no slot, no upload; after the stream the slot is set and the clip goes up', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    await c.afterRun(e.runDir, LIVE);
    await c.tick(LIVE); await c.tick({ nope: 1 });
    assert.equal(g.log.length, 0);
    e.clock.t += 3 * HOUR; await c.tick(IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(FIRST + 3 * HOUR)]);
  });

  test('a later item in the batch whose slot came too close before its session started gets a new slot (no past time sent)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true;
    // the first upload is slow: when it finishes, 6 h 20 min have passed, so the second slot (T0 + 7 h 15) is 55 min away
    const fetchImpl = async (u, o) => { const r = await g.fetchImpl(u, o); if (g.videos.length === 1 && e.clock.t === T0) e.clock.t = T0 + 6 * HOUR + 20 * MIN; return r; };
    const c = schedChain(e, g, { fetchImpl });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 1, 'no session started with a too-close time');
    const it = e.queue().items()[1];
    // PT2 (D408): the read was 6 h old right before the second session, so the channel was read again and the too-close
    // slot got the next free one at once (before PT2 it was dropped here and given on the next pass).
    assert.equal(it.state, 'queued'); assert.equal(it.publishAt, iso(T0 + 6 * HOUR + 20 * MIN + HOUR + 15 * MIN)); assert.equal(it.attempts, 0);
    assert.deepEqual(failedUploadTasks(e), [], 'a re-slot is not shown as a failed task');
    await c.tick(IDLE);
    assert.equal(g.videos.length, 2);
    const now = T0 + 6 * HOUR + 20 * MIN;
    assert.deepEqual(sent(g), [iso(FIRST), iso(now + HOUR + 15 * MIN)]);
    assert.ok(Date.parse(sent(g)[1]) - now >= HOUR, 'the time sent is at least the lead ahead of when its session started');
  });

  test('time comes too close during the upload: stopped between chunks, unfinished session dropped, new slot, one video', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const fetchImpl = async (u, o) => { const r = await g.fetchImpl(u, o); if (g.count('chunk') === 1 && e.clock.t === T0) e.clock.t = T0 + HOUR + 5 * MIN; return r; };
    const c = schedChain(e, g, { fetchImpl });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('chunk'), 1, 'stopped after the first chunk (10 min left < 15 min margin)'); assert.equal(g.videos.length, 0);
    assert.equal(e.queue().items()[0].reason, 'slot-passed'); assert.deepEqual(failedUploadTasks(e), []);
    await c.tick(IDLE); // drops the unfinished session (progress query), clears the slot
    assert.equal(g.count('query'), 1); assert.equal(e.queue().items()[0].publishAt, null); assert.equal(e.queue().items()[0].session, null);
    await c.tick(IDLE); // new slot, new session
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 2);
    assert.deepEqual(sent(g), [iso(T0 + HOUR + 5 * MIN + HOUR + 15 * MIN)]);
    assert.equal(g.sessions.get('s1').video, null, 'the first session never became a video');
  });

  test('a slot that passed during a long stream gets a new slot, also when an unfinished session was open', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.initFailures = 1;
    await c.afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[0].publishAt, iso(FIRST)); assert.equal(e.queue().items()[0].session, null);
    e.clock.t = T0 + 10 * HOUR; await c.tick(LIVE);
    assert.equal(g.count('channels'), 1);
    await c.tick(IDLE);
    assert.deepEqual(sent(g), [iso(T0 + 11 * HOUR + 15 * MIN)]);
    // unfinished session open: dropped (never finished with a passed time), then a new slot and a new session
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]); const c2 = schedChain(e2, g2);
    g2.opt.chunkFailOnce = true;
    await c2.afterRun(e2.runDir, IDLE);
    assert.ok(e2.queue().items()[0].session); assert.equal(e2.queue().items()[0].sessionPublishAt, iso(FIRST));
    e2.clock.t = T0 + 10 * HOUR; await c2.tick(IDLE);
    assert.equal(g2.videos.length, 0); assert.equal(e2.queue().items()[0].reason, 'slot-passed');
    await c2.tick(IDLE);
    assert.deepEqual(sent(g2), [iso(T0 + 11 * HOUR + 15 * MIN)]); assert.equal(g2.count('init'), 2);
  });

  // Before D375 an automatic upload could start with no publish time (flag post-schedule off). Such a session can still be in
  // a queue file from then: it is made here by clearing the times of an open session.
  const makeLegacy = (e) => { const it = e.queue().items()[0]; e.queue().patch(it.id, { sessionPublishAt: null, publishAt: null }); };

  test('post-schedule off: an automatic upload waits (never goes up without a publish time); on: it goes up scheduled', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    await e.chain(g, { flags: SCHED_OFF }).afterRun(e.runDir, IDLE);
    assert.equal(g.log.length, 0, 'no request to Google at all');
    const it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'schedule-off'); assert.equal(it.attempts, 0); assert.equal(it.publishAt ?? null, null);
    e.clock.t += 31 * MIN; await schedChain(e, g).tick(IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(e.clock.t + HOUR + 15 * MIN)]);
  });

  test('an unscheduled session from before D375 is not finished as if scheduled: new session with the slot', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.chunkFailOnce = true;
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    makeLegacy(e);
    assert.ok(e.queue().items()[0].session); assert.equal(e.queue().items()[0].sessionPublishAt, null);
    e.clock.t += 6 * MIN;
    await schedChain(e, g).tick(IDLE);
    assert.equal(g.count('init'), 2, 'the unscheduled session was dropped');
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(e.clock.t + HOUR + 15 * MIN)]);
    assert.equal(e.uploads()[0].posted[0].publishAt, sent(g)[0]);
  });

  test('a FINISHED unscheduled session is recorded with no publish time (never a schedule that was not sent)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.dropFinalAnswer = true; g.opt.queryAfterComplete = 'error';
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    makeLegacy(e);
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'queued');
    g.opt.queryAfterComplete = 'resource'; e.clock.t += 6 * MIN;
    await schedChain(e, g).tick(IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.sentPublishAt, null); assert.equal(g.count('init'), 1);
    assert.equal('publishAt' in e.uploads()[0].posted[0], false);
    assert.equal(readQueueSummary(e.dataDir, null, e.clock.t).nextPublishAt, null);
  });

  test('a scheduled upload that finished but was only confirmed after its time passed is marked plainly, not silently', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.dropFinalAnswer = true; g.opt.queryAfterComplete = 'error';
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1); assert.deepEqual(sent(g), [iso(FIRST)]);
    g.opt.queryAfterComplete = 'resource'; e.clock.t = T0 + 2 * HOUR;
    await c.tick(IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, 'went-public-early'); assert.equal(it.sentPublishAt, iso(FIRST));
    const s = readQueueSummary(e.dataDir, null, e.clock.t);
    assert.equal(s.attention, 1); assert.match(s.message, /may have gone public early/);
  });

  test('pagination cap hit: nothing is scheduled or uploaded (fail closed), plain message; within the cap page 2 is read', async () => {
    const f = (e, maxPages) => schedFile(e, { maxPages });
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = Array.from({ length: 160 }, (_, i) => vid(`c${i}`, 'public'));
    g.opt.channel[70] = vid('mid', 'private', iso(T0 + 5 * HOUR));
    await schedChain(e, g, { scheduleFile: f(e, 2) }).afterRun(e.runDir, IDLE);
    assert.equal(g.count('channels'), 1); assert.equal(g.count('playlist'), 2); assert.equal(g.count('init'), 0);
    const it = e.queue().items()[0];
    assert.equal(it.reason, 'schedule-read-incomplete'); assert.equal(it.publishAt ?? null, null); assert.equal(it.attempts, 0);
    assert.match(readQueueSummary(e.dataDir).message, /raise maxPages/);
    assert.equal(qfile(e).schedule.truncated, true); assert.equal(qfile(e).schedule.scanned, 100);
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]);
    g2.opt.channel = Array.from({ length: 90 }, (_, i) => vid(`c${i}`, 'public'));
    g2.opt.channel[70] = vid('mid', 'private', iso(T0 + 5 * HOUR)); // page 2
    await schedChain(e2, g2, { scheduleFile: f(e2, 2) }).afterRun(e2.runDir, IDLE);
    assert.equal(g2.count('playlist'), 2); assert.deepEqual(sent(g2), [iso(T0 + 11 * HOUR)]);
  });

  // Chunk deadline (Codex round 2): margin 1 min and a deadline of 59.5 s, so with the clock at slot - 60 s every chunk
  // request has 500 ms (real time) before it is aborted.
  const SLOT = T0 + HOUR + MIN; // floor with marginMinutes 1
  const nearSlot = (e, g, after) => async (u, o) => {
    const r = await g.fetchImpl(u, o);
    if (e.clock.t === T0 && after()) e.clock.t = SLOT - MIN; // the upload got slow: 60 s left before the slot
    return r;
  };

  test('a final chunk that stalls is aborted before the slot; the unfinished session is dropped and the clip gets a new slot', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; g.opt.stallFinal = 'hold';
    const c = schedChain(e, g, { fetchImpl: nearSlot(e, g, () => g.count('chunk') === 1), scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.5 }) });
    const t = performance.now();
    await c.afterRun(e.runDir, IDLE);
    const took = performance.now() - t;
    assert.equal(g.count('stall'), 1, 'the final chunk was sent and got no answer'); assert.equal(g.videos.length, 0);
    assert.ok(took >= 400 && took < 5000, `aborted at the deadline (${Math.round(took)} ms), not left hanging`);
    assert.equal(g.count('query'), 1, 'asked Google once whether it finished anyway');
    const it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'slot-passed'); assert.equal(it.attempts ?? 0, 0);
    assert.deepEqual(failedUploadTasks(e), [], 'a deadline abort is not shown as a failed task');
    g.opt.stallFinal = null;
    await c.tick(IDLE); // the session (60 s from its time) is dropped, the slot cleared
    assert.equal(e.queue().items()[0].publishAt, null); assert.equal(e.queue().items()[0].session, null);
    await c.tick(IDLE); // new slot, new session
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 2);
    assert.deepEqual(sent(g), [iso(SLOT - MIN + HOUR + MIN)]);
    assert.equal(g.sessions.get('s1').video, null, 'the stalled session never became a video');
  });

  test('a final chunk aborted at the deadline that Google had finished anyway is recorded as done with its slot', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; g.opt.stallFinal = 'finalize';
    const c = schedChain(e, g, { fetchImpl: nearSlot(e, g, () => g.count('chunk') === 1), scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.5 }) });
    await c.afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, null); assert.equal(it.sentPublishAt, iso(SLOT));
    assert.equal(g.videos.length, 1); assert.equal(g.count('init'), 1); assert.equal(e.uploads()[0].posted[0].publishAt, iso(SLOT));
  });

  test('a fast final chunk under the same deadline is unaffected', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g, { fetchImpl: nearSlot(e, g, () => g.count('chunk') === 1), scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.5 }) });
    await c.afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, null); assert.deepEqual(sent(g), [iso(SLOT)]);
    assert.equal(g.count('query'), 0); assert.equal(g.count('init'), 1);
  });

  test('a slot 30 days ahead (beyond the setTimeout limit of about 24.8 days) uploads normally with no abort', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = [vid('far', 'private', iso(T0 + 30 * 24 * HOUR - 6 * HOUR))];
    await schedChain(e, g, { scheduleFile: schedFile(e, { placement: 'after-last' }) }).afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(it.reason, null);
    assert.deepEqual(sent(g), [iso(T0 + 30 * 24 * HOUR)]);
    assert.equal(g.count('query'), 0, 'no abort, so no progress query'); assert.equal(g.count('init'), 1);
    assert.ok(g.count('chunk') > 1, 'several chunks, each with the far deadline');
  });

  test('the final chunk does not start when its estimated transfer time does not fit before the deadline', async () => {
    // One chunk (no speed measured yet): fallbackKbps 64 = 8000 B/s, ~370 bytes needs ~46 ms; only 10 ms are left.
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g, { chunkSize: 1 << 20, fetchImpl: nearSlot(e, g, () => g.count('init') === 1),
      scheduleFile: schedFile(e, { marginMinutes: 1, chunkDeadlineSeconds: 59.99, fallbackKbps: 64 }) });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('chunk'), 0, 'no byte sent'); assert.equal(g.videos.length, 0);
    assert.equal(e.queue().items()[0].reason, 'slot-passed');
    // with a fast enough fallback it fits and goes up
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]); g2.opt.hideOwnUploads = true;
    await schedChain(e2, g2, { chunkSize: 1 << 20, fetchImpl: nearSlot(e2, g2, () => g2.count('init') === 1),
      scheduleFile: schedFile(e2, { marginMinutes: 1, chunkDeadlineSeconds: 59.5, fallbackKbps: 1000 }) }).afterRun(e2.runDir, IDLE);
    assert.deepEqual(sent(g2), [iso(SLOT)]);
  });
  // D314 (user 2026-11-09) with D375 gap filling: a retry less than 1 h from its time gets the earliest free time from
  // now + lead + margin, at least 6 h from every other time; the other queued clips keep their times.
  test('D314: a retry 45 min from its time gets the next free time; the other queued clips keep theirs', async () => {
    const g = await fakeGoogle(); const e = setup();
    // Six upload attempts in one day (3 failed starts + 3 uploads) need more than the shipped 10000-unit quota leaves
    // after its read reserve: this test is about slots, so it gets a larger quota.
    const c = schedChain(e, g, { budget: createQuotaBudget({ dataDir: e.dataDir, nowMs: () => e.clock.t, quota: () => ({ quotaUnitsPerDay: 100000, perUploadUnits: 1650, readReserveUnits: 100 }) }) });
    g.opt.initFailures = 3; // every session start fails once: three queued clips with slots, no session, backing off
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 0);
    assert.deepEqual(e.queue().items().map((i) => [i.publishAt, i.session ?? null]), [[iso(FIRST), null], [iso(FIRST + 6 * HOUR), null], [iso(FIRST + 12 * HOUR), null]]);
    e.clock.t = T0 + 30 * MIN; // the first slot (T0 + 1 h 15) is now 45 min away: less than the 1 h lead
    await c.tick(IDLE);
    const now = T0 + 30 * MIN; const R = FIRST + 18 * HOUR; // 11:45 is too close to 17:15, and 23:15 is taken: the next free time
    assert.deepEqual(sent(g), [iso(R), iso(FIRST + 6 * HOUR), iso(FIRST + 12 * HOUR)]);
    assert.deepEqual(e.queue().items().map((i) => i.state), ['done', 'done', 'done']);
    assert.ok(e.queue().items().every((i) => !i.reslot));
    assert.equal(readQueueSummary(e.dataDir, null, now).lastPublishAt, iso(R), 'the control page shows the new time');
  });

  test('D314: uploaded clips keep their times; the retry and a new clip take the next free times, 6 h from every other', async () => {
    const g = await fakeGoogle(); const e = setup(); const c = schedChain(e, g);
    g.opt.initFailures = 1; // the first clip's session start fails; the other two upload at FIRST + 6 h and FIRST + 12 h
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST + 6 * HOUR), iso(FIRST + 12 * HOUR)]);
    e.clock.t = T0 + 30 * MIN; addRow(e, { name: 'codm_montage_20261109-100000_kills-7_03_v.mp4', kind: 'montage', seconds: 45, music: { source: 'generated' } });
    await c.afterRun(e.runDir, IDLE);
    const items = e.queue().items();
    assert.equal(items[1].sentPublishAt, iso(FIRST + 6 * HOUR)); assert.equal(items[2].sentPublishAt, iso(FIRST + 12 * HOUR));
    assert.equal(items[0].sentPublishAt, iso(FIRST + 18 * HOUR), 'the retry: 11:45 is within 6 h of 17:15, so after 23:15');
    assert.equal(items[3].sentPublishAt, iso(FIRST + 24 * HOUR), 'the new clip: the next free time after the retry');
  });

  test('D314: a clip with an open session keeps its time (Google applies the session time); only the retry moves', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.initFailures = 1; g.opt.chunkFailOnce = true; // clip 1: no session; clip 2: session open, first chunk failed
    await c.afterRun(e.runDir, IDLE);
    const before = e.queue().items();
    assert.equal(before[0].session ?? null, null); assert.ok(before[1].session); assert.equal(before[1].sessionPublishAt, iso(FIRST + 6 * HOUR));
    e.clock.t = T0 + 30 * MIN;
    await c.tick(IDLE);
    const R = FIRST + 12 * HOUR; // 11:45 is within 6 h of the open session's 17:15
    assert.deepEqual(e.queue().items().map((i) => i.sentPublishAt), [iso(R), iso(FIRST + 6 * HOUR)]);
    assert.equal(g.videos.length, 2); assert.equal(g.count('init'), 3, 'clip 2 resumed its session, no new one');
  });

  test('D314 gap: a retry whose floor equals a channel post goes the gap (6 h) after it (read from the fake channel)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    g.opt.initFailures = 1;
    await c.afterRun(e.runDir, IDLE);
    g.opt.channel = [vid('p1', 'private', iso(T0 + HOUR + 45 * MIN))]; // exactly the retry floor at now = T0 + 30 min
    e.clock.t = T0 + 30 * MIN; await c.tick(IDLE);
    assert.deepEqual(sent(g), [iso(T0 + 7 * HOUR + 45 * MIN)]);
    assert.deepEqual(qfile(e).schedule.channelTimes, [iso(T0 + HOUR + 45 * MIN)]);
  });

  test('D375 delete flag on: the clip file is deleted only once YouTube says processed; log line and one task bar line', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    const file = e.uploads()[0].file; const folder = path.dirname(file);
    const c = e.chain(g, { flags: { isOn: () => true }, clipsFolder: folder });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1); assert.equal(e.queue().items()[0].state, 'done');
    assert.ok(existsSync(file), 'still processing at YouTube: kept');
    assert.equal(e.queue().items()[0].deleteReason, 'still-processing');
    g.videos[0].status.uploadStatus = 'processed';
    await c.tick(IDLE);
    assert.ok(existsSync(file), 'not asked again before the 15 min wait');
    e.clock.t += 16 * MIN; await c.tick(IDLE);
    assert.equal(existsSync(file), false);
    const it = e.queue().items()[0];
    assert.equal(it.deleteState, 'deleted'); assert.equal(it.lastStatus.uploadStatus, 'processed');
    const log = readFileSync(path.join(e.dataDir, 'posting', 'deleted.jsonl'), 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.deepEqual(log.map((l) => [l.file, l.videoId]), [[path.basename(file), g.videos[0].id]]);
    const tasks = readdirSync(tasksDir(e.dataDir)).filter((n) => n.startsWith('post-deleted-'));
    assert.equal(tasks.length, 1);
    e.clock.t += 16 * MIN; await c.tick(IDLE);
    assert.equal(readdirSync(tasksDir(e.dataDir)).filter((n) => n.startsWith('post-deleted-')).length, 1, 'never checked again');
  });

  test('D375 delete flag on, but the upload failed or the file changed: the file is kept for good', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    const file = e.uploads()[0].file;
    const c = e.chain(g, { flags: { isOn: () => true }, clipsFolder: path.dirname(file) });
    await c.afterRun(e.runDir, IDLE);
    writeFileSync(file, 'edited after the upload');
    g.videos[0].status.uploadStatus = 'processed'; e.clock.t += 16 * MIN; await c.tick(IDLE);
    assert.ok(existsSync(file)); assert.equal(e.queue().items()[0].deleteState, 'kept'); assert.equal(e.queue().items()[0].deleteReason, 'sha-mismatch');
    const g2 = await fakeGoogle(); const e2 = setup([ROWS[0]]);
    const file2 = e2.uploads()[0].file;
    const c2 = e2.chain(g2, { flags: { isOn: () => true }, clipsFolder: path.dirname(file2) });
    await c2.afterRun(e2.runDir, IDLE);
    g2.videos[0].status.uploadStatus = 'failed'; e2.clock.t += 16 * MIN; await c2.tick(IDLE);
    assert.ok(existsSync(file2)); assert.equal(e2.queue().items()[0].deleteReason, 'upload-failed');
  });

  test('D314 cap: a slot more than maxAheadDays ahead is not given; the clip waits (plain reason, no attempt) and goes up later', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = [vid('s1', 'private', iso(T0 + 20 * HOUR))]; // next slot T0 + 26 h, past a 1-day cap
    const c = schedChain(e, g, { scheduleFile: schedFile(e, { maxAheadDays: 1, placement: 'after-last' }) });
    await c.afterRun(e.runDir, IDLE);
    let it = e.queue().items()[0];
    assert.equal(g.count('init'), 0); assert.equal(it.state, 'queued'); assert.equal(it.publishAt, null);
    assert.equal(it.reason, 'schedule-beyond-cap'); assert.equal(it.attempts, 0);
    assert.match(readQueueSummary(e.dataDir, null, T0).message, /further ahead than the schedule allows \(days ahead/);
    const reads = g.count('channels');
    e.clock.t = T0 + HOUR; await c.tick(IDLE);
    assert.equal(g.count('channels'), reads, 'a capped clip does not re-read the channel before its wait ends');
    e.clock.t = T0 + 6 * HOUR + MIN; await c.tick(IDLE); // the cap is now T0 + 30 h: the slot fits
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.deepEqual(sent(g), [iso(T0 + 26 * HOUR)]);
  });

  // ---- PT2 (D408): the one hard rule, re-checked right before each upload session; the quota fallback ----
  test('PT2: a post scheduled by hand during the pass clashes with the next slot: re-read before its session, new slot, never within the gap', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    let hand = null;
    g.opt.onVideo = () => {
      if (hand !== null) return;
      // Codex review 2026-11-21 (D409): no clock advance at all; the channel is read again before EVERY new session,
      // however fresh the last read. Someone scheduled a post by hand 20 minutes after the second clip's slot.
      hand = FIRST + 6 * HOUR + 20 * MIN;
      g.opt.channel = [vid('hand', 'private', iso(hand))];
    };
    await c.afterRun(e.runDir, IDLE);
    assert.deepEqual(sent(g), [iso(FIRST)], 'the second clip did not go up on its old slot');
    assert.equal(g.count('channels'), 2, 'the channel was read again right before the second session');
    const second = e.queue().items()[1];
    assert.equal(second.state, 'queued');
    assert.ok(Math.abs(Date.parse(second.publishAt) - hand) >= 6 * HOUR, 'new slot keeps the gap from the hand-scheduled post');
    assert.ok(Math.abs(Date.parse(second.publishAt) - FIRST) >= 6 * HOUR, 'and from the clip that went up');
    await c.tick(IDLE);
    assert.equal(g.videos.length, 2);
    for (const t of sent(g)) assert.ok(Math.abs(Date.parse(t) - hand) >= 6 * HOUR);
  });

  test('PT2: YouTube answers quotaExceeded: the clip waits (no attempt), the quota falls back to the unit sum with a plain notice, the bucket returns later', async () => {
    const { loadQuota } = await import('../services/posting/quota-budget.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); const c = schedChain(e, g);
    assert.equal(loadQuota(e.dataDir, undefined, { nowMs: T0 }).model, 'upload-bucket');
    g.opt.initQuota = 1;
    await c.afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(g.videos.length, 0); assert.equal(it.state, 'queued'); assert.equal(it.reason, 'quota-exceeded'); assert.equal(it.attempts, 0);
    assert.ok(Date.parse(it.nextAt) > T0, 'waits');
    const q = loadQuota(e.dataDir, undefined, { nowMs: T0 });
    assert.equal(q.model, 'unit-sum'); assert.equal(q.uploadsPerDayFit, 4); // (10000 - 100) / (1650 + 401), D430 assert.match(q.modelText, /used up/);
    const notice = JSON.parse(readFileSync(path.join(tasksDir(e.dataDir), 'auto-post-notice.json'), 'utf8'));
    assert.match(notice.title, /upload quota is used up/);
    assert.match(readQueueSummary(e.dataDir, null, T0).message, /quota is used up for today/);
    // Codex review 2026-11-21: the wait ends at the next Pacific midnight (T0 = 02:00 PST -> 08:00Z the next day), not 6 h on.
    const midnight = Date.parse('2026-11-10T08:00:00Z');
    assert.equal(it.nextAt, iso(midnight));
    // Passes before then send nothing and use no attempt, even when Run auto-post now is asked for.
    const inits = g.count('init');
    e.clock.t = T0 + 7 * HOUR; await c.tick(IDLE);
    e.clock.t += MIN; requestRunNow(e.dataDir, e.clock.t); await c.tick(IDLE);
    assert.equal(g.count('init'), inits, 'no upload try before midnight Pacific');
    assert.equal(e.queue().items()[0].attempts, 0);
    // After midnight Pacific it goes up (counted the old way that day).
    e.clock.t = midnight + MIN; await c.tick(IDLE);
    assert.equal(e.queue().items()[0].state, 'done');
    // Two Pacific days later the bucket model is back.
    assert.equal(loadQuota(e.dataDir, undefined, { nowMs: T0 + 3 * 24 * HOUR }).model, 'upload-bucket');
  });

  test('D409: a failed channel read right before the second session keeps the second clip waiting (fail closed)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.onVideo = () => { g.opt.channelError = 500; };
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 1, 'only the first went up');
    const second = e.queue().items()[1];
    assert.equal(second.state, 'queued'); assert.equal(second.reason, 'schedule-read-failed'); assert.equal(second.attempts, 0);
    assert.equal(g.count('channels'), 2, 'read again right before the second session');
  });

  // ---- D434 read reuse (user 2026-11-22: up to 100 uploads a day) ----
  test('D434: one complete read serves the next session while it is younger than readReuseMinutes; older = read again', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0], ROWS[2]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g, { scheduleFile: schedFile(e, { readReuseMinutes: 120 }) });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.videos.length, 2, 'both went up');
    assert.equal(g.count('channels'), 1, 'one read served both sessions');
    const [a, b] = e.queue().items();
    assert.ok(Math.abs(Date.parse(a.sentPublishAt) - Date.parse(b.sentPublishAt)) >= 6 * HOUR, 'the slot given out since the read stayed taken');
    // A saved read older than the reuse time is never used: the next session reads again.
    const e2 = setup([ROWS[0]]); const g2 = await fakeGoogle(); g2.opt.hideOwnUploads = true;
    const qf = path.join(e2.dataDir, 'posting', QUEUE_NAME);
    mkdirSync(path.dirname(qf), { recursive: true });
    writeFileSync(qf, JSON.stringify({ version: 1, items: {}, note: null, schedule: { channelLast: null, channelTimes: [], recentTimes: [], truncated: false, readAt: iso(e2.clock.t - 121 * MIN) } }));
    await schedChain(e2, g2, { scheduleFile: schedFile(e2, { readReuseMinutes: 120 }) }).afterRun(e2.runDir, IDLE);
    assert.equal(g2.count('channels'), 1, 'read again'); assert.equal(g2.videos.length, 1);
  });

  test('D434: an incomplete (page cap) read is never reused: nothing uploads, and the next pass reads again', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = Array.from({ length: 120 }, (_, k) => vid(`p${k}`, 'public', null));
    const c = schedChain(e, g, { scheduleFile: schedFile(e, { maxPages: 2, pageSize: 50, readReuseMinutes: 120 }) });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'schedule-read-incomplete');
    const before = g.count('channels');
    e.clock.t += 31 * MIN; await c.tick(IDLE);
    assert.equal(g.count('init'), 0, 'still nothing uploads');
    assert.ok(g.count('channels') > before, 'the truncated read was not reused: read again');
  });

  test('D409: an incomplete (page cap) read right before a session: nothing uploads', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]);
    g.opt.channel = Array.from({ length: 120 }, (_, k) => vid(`p${k}`, 'public', null));
    const c = schedChain(e, g, { scheduleFile: schedFile(e, { maxPages: 2, pageSize: 50 }) });
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0);
    assert.equal(e.queue().items()[0].reason, 'schedule-read-incomplete');
  });

  // ---- D409 second Codex review (2026-11-21) ----
  test('D409: a saved session that expired: a fresh read and the 60-min check come right before the new session; a clash there stops it', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const hand = FIRST + 20 * MIN;
    // The channel changes between the check before the pass's resume and the restart of the expired session.
    const fetchImpl = async (u, o) => {
      const r = await g.fetchImpl(u, o);
      if (String(u).includes('/session/') && r.status === 404 && !g.opt.channel.length) g.opt.channel = [vid('hand', 'private', iso(hand))];
      return r;
    };
    const c = schedChain(e, g, { fetchImpl });
    g.opt.chunkFailOnce = true; // the first chunk is refused: the session is kept for a resume
    await c.afterRun(e.runDir, IDLE);
    assert.ok(e.queue().items()[0].session); assert.equal(e.queue().items()[0].publishAt, iso(FIRST));
    g.sessions.clear(); // the session expired on Google's side
    const reads = g.count('channels');
    e.clock.t = T0 + 6 * MIN; await c.tick(IDLE);
    assert.equal(g.count('channels'), reads + 2, 'read for the resume check, then again right before the new session');
    assert.equal(g.count('init'), 1, 'no new session on the clashing time');
    let it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'schedule-clash'); assert.equal(it.publishAt, null);
    e.clock.t += MIN; await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(g.videos.length, 1);
    assert.ok(Math.abs(Date.parse(it.sentPublishAt) - hand) >= 6 * HOUR, 'the new time keeps the gap from the hand-scheduled post');
  });

  test('D409: a live saved session for the same time resumes only after a complete read in this lock hold; a failed read keeps it waiting', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true; const c = schedChain(e, g);
    g.opt.chunkFailOnce = true;
    await c.afterRun(e.runDir, IDLE);
    const reads = g.count('channels');
    g.opt.channelError = 500;
    e.clock.t = T0 + 6 * MIN; await c.tick(IDLE);
    assert.equal(g.count('channels'), reads + 1); assert.equal(g.count('query'), 0, 'the session was not even touched');
    assert.equal(e.queue().items()[0].reason, 'schedule-read-failed'); assert.equal(e.queue().items()[0].state, 'queued');
    g.opt.channelError = null;
    e.clock.t += 6 * MIN; await c.tick(IDLE);
    assert.equal(g.count('channels'), reads + 2, 'read again in the new hold');
    assert.equal(g.count('init'), 1, 'resumed, no second session'); assert.equal(e.queue().items()[0].state, 'done');
  });

  test('D409: a partial channel answer (video details missing) or a read past its deadline: nothing uploads, no attempt used', async () => {
    let g = await fakeGoogle(); let e = setup([ROWS[0]]);
    g.opt.channel = [vid('p1', 'public', null), vid('p2', 'private', iso(T0 + 3 * HOUR))];
    const partial = async (u, o) => {
      const r = await g.fetchImpl(u, o);
      if (!String(u).includes('/youtube/v3/videos?') || (o?.method ?? 'GET') !== 'GET') return r;
      const b = await r.json();
      return new Response(JSON.stringify({ items: b.items.filter((v) => v.id !== 'p2') }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await schedChain(e, g, { fetchImpl: partial }).afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0);
    assert.equal(e.queue().items()[0].reason, 'schedule-read-incomplete'); assert.equal(e.queue().items()[0].attempts, 0);
    assert.equal(e.queue().items()[0].publishAt, null, 'no time given on a partial read');
    g = await fakeGoogle(); e = setup([ROWS[0]]);
    const slow = (u, o) => (String(u).includes('/channels') ? new Promise((resolve, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted')))) : g.fetchImpl(u, o));
    await schedChain(e, g, { fetchImpl: slow, readDeadlineMs: 50 }).afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0);
    assert.equal(e.queue().items()[0].reason, 'schedule-read-incomplete'); assert.equal(e.queue().items()[0].attempts, 0);
  });

  test('D409: sendGated is the one upload gate: over budget nothing is sent; a quota answer is recorded for every pass', async () => {
    const { sendGated } = await import('../services/posting/auto-chain.mjs');
    const { exhaustedUntil } = await import('../services/posting/quota-budget.mjs');
    const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
    let sent = 0;
    const blocked = await sendGated({ dataDir: d, budget: { reserveUpload: () => 'daily-cap-reached' }, send: async () => { sent++; } });
    assert.deepEqual(blocked, { blocked: 'daily-cap-reached' }); assert.equal(sent, 0);
    const quota = Object.assign(new Error('quota'), { code: 'quota-exceeded' });
    await assert.rejects(sendGated({ dataDir: d, budget: { reserveUpload: () => null }, nowMs: () => T0, send: async () => { sent++; throw quota; } }), (e) => e === quota && Number.isFinite(e.exhaustedUntil));
    assert.equal(sent, 1);
    assert.equal(exhaustedUntil(d, T0), Date.parse('2026-11-10T08:00:00Z'), 'the wait until the next Pacific midnight is saved');
    assert.deepEqual(await sendGated({ dataDir: d, budget: { reserveUpload: () => null }, send: async () => 'ok' }), { result: 'ok' });
  });

  test('D409-4: the sender lock: a live other holder is refused (never taken over); only a dead holder\'s lock is replaced', async () => {
    const { LOCK_NAME, withScheduleLock } = await import('../services/posting/auto-chain.mjs');
    const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
    const f = path.join(d, 'posting', LOCK_NAME);
    // A live other process (the parent of this test process) holds it: refused at once, however old; file untouched.
    const other = JSON.stringify({ pid: process.ppid, token: 'other', at: Date.now() - 20 * 60e3 });
    writeFileSync(f, other);
    await assert.rejects(withScheduleLock(d, async () => 'x', { waitMs: 150 }), { code: 'sender-elsewhere' });
    assert.equal(readFileSync(f, 'utf8'), other, 'a live holder\'s lock is never touched');
    // Unreadable content (not provably ours): refused, untouched.
    writeFileSync(f, '{half');
    await assert.rejects(withScheduleLock(d, async () => 'x'), { code: 'sender-elsewhere' });
    assert.equal(readFileSync(f, 'utf8'), '{half');
    // Its process ended: replaced by the process that then holds it.
    writeFileSync(f, JSON.stringify({ pid: 2 ** 30, token: 'dead', at: Date.now() }));
    assert.equal(await withScheduleLock(d, async () => 'won'), 'won');
    assert.ok(!existsSync(f), 'released after the pass');
    // A dead holder's lock whose claim another process already took: refused (no second remover).
    writeFileSync(f, JSON.stringify({ pid: 2 ** 30, token: 'dead2', at: Date.now() }));
    writeFileSync(`${f}.dead2.claim`, '1');
    await assert.rejects(withScheduleLock(d, async () => 'x'), { code: 'sender-elsewhere' });
    assert.ok(existsSync(f));
    rmSync(`${f}.dead2.claim`); rmSync(f);
    // In this process: a second pass waits for the first (in-process mutex), then times out without sending.
    let release; const held = new Promise((r) => { release = r; });
    const holder = withScheduleLock(d, () => held);
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(withScheduleLock(d, async () => 'x', { waitMs: 100 }), { code: 'schedule-busy' });
    const queued = withScheduleLock(d, async () => 'next', { waitMs: 5000 });
    release(); await holder;
    assert.equal(await queued, 'next', 'the waiting pass runs once the first ends');
    // held() turns false once the file is no longer this hold's; the other file is left alone.
    const lost = await withScheduleLock(d, async (hold) => {
      const before = hold.held();
      writeFileSync(f, JSON.stringify({ pid: process.ppid, token: 'thief', at: Date.now() }));
      return [before, hold.held()];
    });
    assert.deepEqual(lost, [true, false]);
    assert.ok(existsSync(f), 'the other holder\'s file is left alone');
    // No leftover claim or tombstone files.
    assert.deepEqual(readdirSync(path.join(d, 'posting')).filter((n) => /\.(claim|tomb|back)$/.test(n)), []);
  });

  test('D409-4: a lock held by another live process: the chain refuses with a plain-words notice (no attempt, nothing sent)', async () => {
    const { LOCK_NAME } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const f = path.join(e.dataDir, 'posting', LOCK_NAME);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ pid: process.ppid, token: 'other-studio', at: Date.now() }));
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0, 'nothing was sent');
    const it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'sender-elsewhere'); assert.equal(it.attempts, 0);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).token, 'other-studio', 'the other sender\'s lock is left alone');
  });

  test('D409: the schedule lock held elsewhere: the chain waits (no attempt, nothing sent)', async () => {
    const { withScheduleLock } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const c = schedChain(e, g, { lockOpts: { waitMs: 100 } });
    let release; const held = new Promise((r) => { release = r; });
    const holder = withScheduleLock(e.dataDir, () => held);
    await new Promise((r) => setTimeout(r, 20));
    await c.afterRun(e.runDir, IDLE);
    release(); await holder;
    assert.equal(g.count('init'), 0);
    assert.equal(e.queue().items()[0].reason, 'schedule-busy'); assert.equal(e.queue().items()[0].attempts, 0);
  });

  // ---- D409 third Codex review (2026-11-21) ----
  test('D409-3: a video that goes public DURING the channel read still counts (the reference time is taken after the read)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    // It went public at T0 + 1 min; the read starts at T0 and its pages come back at T0 + 2 min.
    const pub = T0 + MIN;
    g.opt.channel = [{ ...vid('pub', 'public', null), publicAt: iso(pub) }];
    const fetchImpl = async (u, o) => { if (String(u).includes('/playlistItems')) e.clock.t = T0 + 2 * MIN; return g.fetchImpl(u, o); };
    await schedChain(e, g, { fetchImpl }).afterRun(e.runDir, IDLE);
    const it = e.queue().items()[0];
    assert.equal(it.state, 'done');
    assert.ok(Math.abs(Date.parse(it.sentPublishAt) - pub) >= 6 * HOUR, `the new time keeps the gap from the video that went public mid-read (${it.sentPublishAt})`);
    assert.deepEqual(e.queue().schedule().recentTimes, [iso(pub)]);
  });

  test('D409-3: a public channel video without a valid public time: nothing uploads, no time given (fail closed)', async () => {
    for (const bad of [null, 'not-a-time']) {
      const g = await fakeGoogle(); const e = setup([ROWS[0]]);
      g.opt.channel = [{ ...vid('pub', 'public', null), publicAt: bad }];
      await schedChain(e, g).afterRun(e.runDir, IDLE);
      assert.equal(g.count('init'), 0, String(bad));
      const it = e.queue().items()[0];
      assert.equal(it.reason, 'schedule-read-incomplete'); assert.equal(it.publishAt, null); assert.equal(it.attempts, 0);
    }
  });

  test('D409-3: the lock taken over during the channel read: no session starts (ownership is re-checked after every read)', async () => {
    const { LOCK_NAME } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const f = path.join(e.dataDir, 'posting', LOCK_NAME);
    let stolen = false;
    const fetchImpl = async (u, o) => {
      if (!stolen && String(u).includes('/playlistItems')) { stolen = true; writeFileSync(f, JSON.stringify({ pid: process.pid, token: 'thief', at: Date.now(), beat: Date.now() })); }
      return g.fetchImpl(u, o);
    };
    await schedChain(e, g, { fetchImpl }).afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0, 'nothing was sent');
    const it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'schedule-busy'); assert.equal(it.attempts, 0);
    assert.equal(JSON.parse(readFileSync(f, 'utf8')).token, 'thief', 'the other holder\'s lock is left alone');
  });

  test('D409-3: a hung session start ends at its request deadline: the item waits (no attempt), the lock is free for the next tick', async () => {
    const { LOCK_NAME } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    let hang = true;
    // A fake request that never answers and ignores the abort signal.
    const fetchImpl = (u, o) => (hang && String(u).includes('uploadType=resumable') ? new Promise(() => {}) : g.fetchImpl(u, o));
    const c = schedChain(e, g, { fetchImpl, requestMs: 100 });
    const t = Date.now();
    await c.afterRun(e.runDir, IDLE);
    assert.ok(Date.now() - t < 5000, 'the pass did not hang');
    let it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'request-timeout'); assert.equal(it.attempts, 0);
    assert.ok(!existsSync(path.join(e.dataDir, 'posting', LOCK_NAME)), 'the lock was released');
    hang = false; e.clock.t += 6 * MIN; await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(g.videos.length, 1);
  });

  test('D409-3: a hung progress query and a hung chunk also end at their deadlines (session kept, no attempt)', async () => {
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    let hang = 'chunk';
    const fetchImpl = (u, o) => {
      const cr = String(o?.headers?.['Content-Range'] ?? '');
      if (String(u).includes('/session/') && ((hang === 'chunk' && !cr.startsWith('bytes */')) || (hang === 'query' && cr.startsWith('bytes */')))) return new Promise(() => {});
      return g.fetchImpl(u, o);
    };
    const c = schedChain(e, g, { fetchImpl, requestMs: 100, chunkRequestMs: 100 });
    await c.afterRun(e.runDir, IDLE);
    let it = e.queue().items()[0];
    assert.equal(it.reason, 'request-timeout'); assert.equal(it.attempts, 0); assert.ok(it.session, 'the session is kept');
    hang = 'query'; e.clock.t += 6 * MIN; await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.reason, 'request-timeout'); assert.equal(it.attempts, 0); assert.ok(it.session);
    hang = null; e.clock.t += 6 * MIN; await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(g.count('init'), 1, 'resumed the same session');
  });

  test('D409-3: the whole hold is capped: a hung request does not block the next tick beyond the cap', async () => {
    const { LOCK_NAME } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    let hang = true;
    // The capped section is the lock hold: it starts when the lock file is written (its `at`), not when afterRun is
    // called. Timing the whole afterRun also counted the work before the lock (store, rules, auth, budget), which took
    // seconds under CPU load (4.4 s, 8 of 10 runs failed with 12 busy cores, 2026-11-24) although the hold itself ended at the cap.
    let holdAt = null;
    const lockFile = path.join(e.dataDir, 'posting', LOCK_NAME);
    const fetchImpl = (u, o) => {
      if (!(hang && String(u).includes('uploadType=resumable'))) return g.fetchImpl(u, o);
      holdAt = JSON.parse(readFileSync(lockFile, 'utf8')).at;
      return new Promise(() => {});
    };
    // The request deadline is far away; only the hold cap (300 ms) ends the pass.
    const lockOpts = { maxHoldMs: 300 };
    const c = schedChain(e, g, { fetchImpl, requestMs: 60 * 60e3, lockOpts });
    await c.afterRun(e.runDir, IDLE);
    assert.ok(holdAt !== null, 'the pass reached the hung session start inside the hold');
    const held = Date.now() - holdAt;
    assert.ok(held < 3000, `the hold ended at the cap (${held} ms)`);
    let it = e.queue().items()[0];
    assert.equal(it.state, 'queued'); assert.equal(it.reason, 'request-timeout'); assert.equal(it.attempts, 0);
    assert.ok(!existsSync(path.join(e.dataDir, 'posting', LOCK_NAME)), 'the lock was released at the cap');
    // The next tick is a normal pass (a whole upload): it gets the shipped cap, not the 300 ms one that only had to end
    // the hung pass. A whole upload under 300 ms raced CPU load (4 of 10 runs, 12 busy cores, 2026-11-24).
    delete lockOpts.maxHoldMs;
    hang = false; e.clock.t += 6 * MIN; await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(g.videos.length, 1, 'the next tick posts');
  });

  test('D409-5: a crash-left claim: refused with the stuck notice, one click clears it, the next pass sends; a live claimant is never cleared', async () => {
    const { LOCK_NAME, stuckLock, clearStuckLock } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const f = path.join(e.dataDir, 'posting', LOCK_NAME);
    mkdirSync(path.dirname(f), { recursive: true });
    // The crash: the old lock (dead holder) and the claim of a claimant that died before the exclusive create.
    writeFileSync(f, JSON.stringify({ pid: 2 ** 30, start: 1000, token: 'old-1', at: Date.now() }));
    writeFileSync(`${f}.old-1.claim`, JSON.stringify({ pid: 2 ** 30 - 1, start: 2000 }));
    const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0, 'nothing sent while stuck');
    let it = e.queue().items()[0];
    assert.equal(it.reason, 'sender-elsewhere'); assert.equal(it.attempts, 0);
    const tasks = readdirSync(tasksDir(e.dataDir)).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(path.join(tasksDir(e.dataDir), n), 'utf8')));
    assert.ok(tasks.some((t) => /posting lock was left behind/.test(t.title ?? '') && /Clear stuck posting lock/.test(t.note ?? '')), JSON.stringify(tasks));
    // No automatic removal: a second pass still refuses and both files stay.
    e.clock.t += 6 * MIN; await c.tick(IDLE);
    assert.ok(existsSync(f) && existsSync(`${f}.old-1.claim`)); assert.equal(g.count('init'), 0);
    // A click with a stale id is refused; the right id clears exactly those two files.
    assert.deepEqual(await clearStuckLock(e.dataDir, 'other'), { cleared: false, code: 'changed' });
    const ID1 = 'schedule.lock.old-1.claim:old-1';
    assert.equal(stuckLock(e.dataDir).id, ID1);
    assert.deepEqual(await clearStuckLock(e.dataDir, ID1), { cleared: true });
    assert.ok(!existsSync(f) && !existsSync(`${f}.old-1.claim`));
    e.clock.t += 6 * MIN; await c.tick(IDLE);
    it = e.queue().items()[0];
    assert.equal(it.state, 'done'); assert.equal(g.videos.length, 1, 'the next pass sends (mock)');

    // A live claimant (the pid is alive and started at the recorded time) is never cleared; a reused pid is.
    const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
    const f2 = path.join(d, 'posting', LOCK_NAME);
    writeFileSync(f2, JSON.stringify({ pid: 2 ** 30, start: 1000, token: 'old-2', at: Date.now() }));
    writeFileSync(`${f2}.old-2.claim`, JSON.stringify({ pid: process.ppid, start: 5_000_000 }));
    const same = { procStart: () => 5_000_000 };
    assert.equal(stuckLock(d, same), null, 'live claimant: not stuck');
    assert.deepEqual(await clearStuckLock(d, 'schedule.lock.old-2.claim:old-2', same), { cleared: false, code: 'not-stuck' });
    assert.equal(stuckLock(d, { procStart: () => null }), null, 'unknown start: not stuck');
    assert.ok(existsSync(f2) && existsSync(`${f2}.old-2.claim`));
    assert.equal(stuckLock(d, { procStart: () => 5_000_000 + 60_000 })?.id, 'schedule.lock.old-2.claim:old-2', 'pid reused (another start time): stuck');
    // A live lock holder is never cleared either, even with a dead claimant.
    writeFileSync(f2, JSON.stringify({ pid: process.ppid, start: 7_000_000, token: 'old-2', at: Date.now() }));
    writeFileSync(`${f2}.old-2.claim`, JSON.stringify({ pid: 2 ** 30, start: 1 }));
    assert.equal(stuckLock(d, { procStart: () => 7_000_000 }), null);
    // Sixth review: a claim holding only a number (7b5c7ec format): pid gone = dead (stuck); pid alive = alive (never).
    writeFileSync(f2, JSON.stringify({ pid: 2 ** 30, start: 1, token: 'old-2', at: Date.now() }));
    writeFileSync(`${f2}.old-2.claim`, String(2 ** 30 - 1));
    assert.equal(stuckLock(d, { procStart: () => null })?.id, 'schedule.lock.old-2.claim:old-2', 'numeric claim, pid gone: dead');
    writeFileSync(`${f2}.old-2.claim`, String(process.ppid));
    assert.equal(stuckLock(d, { procStart: () => null }), null, 'numeric claim, pid alive: alive');
  });

  test('D409-7: every crash point of the dead-lock replacement is either sendable or offers Clear (never stuck without an action)', async () => {
    const { LOCK_NAME, stuckLock, clearStuckLock, withScheduleLock, removeStaleLockTemps } = await import('../services/posting/auto-chain.mjs');
    const OLD =JSON.stringify({ pid: 2 ** 30, start: 1, token: 'old', at: 1 });   // the old holder, dead
    const NEW = JSON.stringify({ pid: 2 ** 30 - 2, start: 3, token: 'new', at: 2 }); // the crashed replacer's new lock
    const CLAIM = JSON.stringify({ pid: 2 ** 30 - 2, start: 3 });                    // the crashed replacer's claim
    const states = {
      'before the claim': { lock: OLD, claim: null },
      'after claim create': { lock: OLD, claim: CLAIM },
      'after old-lock remove': { lock: null, claim: CLAIM },
      'after new-lock create (before claim remove)': { lock: NEW, claim: CLAIM },
      'after claim remove': { lock: NEW, claim: null },
      // Eighth review: "created, not written" (older builds' torn writes), aged past TORN_DEAD_MS.
      'first lock created, not written': { lock: '', claim: null, aged: true },
      'first lock partly written': { lock: '{"pid":12', claim: null, aged: true },
      'claim created, not written': { lock: OLD, claim: '', aged: true },
      'new lock created, not written (claim present)': { lock: '', claim: CLAIM, aged: true },
      'leftover temp file, no target': { lock: null, claim: null, tmp: true },
    };
    const old = new Date(Date.now() - 5 * 60e3);
    for (const [name, st] of Object.entries(states)) {
      const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
      const f = path.join(d, 'posting', LOCK_NAME);
      if (st.lock !== null) writeFileSync(f, st.lock);
      if (st.claim !== null) writeFileSync(`${f}.old.claim`, st.claim);
      if (st.aged) for (const p of [f, `${f}.old.claim`]) if (existsSync(p)) utimesSync(p, old, old);
      if (st.tmp) {
        const tmp = `${f}.123.abcd.tmp`; writeFileSync(tmp, 'x');
        utimesSync(tmp, old, old); assert.equal(removeStaleLockTemps(d), 0, 'a 5-min-old temp is kept (it may still be linked)');
        const older = new Date(Date.now() - 15 * 60e3); utimesSync(tmp, older, older);
        assert.equal(removeStaleLockTemps(d), 1, name);
      }
      let sent = false;
      try { await withScheduleLock(d, async () => { sent = true; }); } catch (e) { assert.equal(e.code, 'sender-elsewhere', name); }
      if (!sent) {
        const s = stuckLock(d);
        assert.ok(s, `${name}: refused, so Clear must be offered`);
        assert.deepEqual(await clearStuckLock(d, s.id), { cleared: true }, name);
        await withScheduleLock(d, async () => { sent = true; });
      }
      assert.ok(sent, `${name}: sendable (after Clear when offered)`);
      assert.deepEqual(readdirSync(path.join(d, 'posting')), [], `${name}: nothing left behind`);
    }
  });

  test('D409-8: torn files: an empty claim and a partial lock (older than 60 s) offer Clear; a young empty claim does not yet', async () => {
    const { LOCK_NAME, stuckLock, clearStuckLock, withScheduleLock } = await import('../services/posting/auto-chain.mjs');
    const old = new Date(Date.now() - 5 * 60e3);
    const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
    const f = path.join(d, 'posting', LOCK_NAME);
    // A young empty claim (a writer may still be between create and write): refused, no Clear yet, untouched.
    writeFileSync(`${f}.x.claim`, '');
    await assert.rejects(withScheduleLock(d, async () => 'x'), { code: 'sender-elsewhere' });
    assert.equal(stuckLock(d), null, 'younger than 60 s: alive');
    assert.ok(existsSync(`${f}.x.claim`));
    // Older: Clear offered.
    utimesSync(`${f}.x.claim`, old, old);
    assert.equal(stuckLock(d)?.id, 'schedule.lock.x.claim:no-lock');
    // A partial JSON lock next to it, also old: Clear covers both.
    writeFileSync(f, '{"pid": 4'); utimesSync(f, old, old);
    const s = stuckLock(d);
    assert.equal(s?.id, 'schedule.lock.x.claim:torn');
    assert.deepEqual(await clearStuckLock(d, s.id), { cleared: true });
    assert.equal(await withScheduleLock(d, async () => 'sent'), 'sent');
    // A young partial lock alone: refused, not offered.
    writeFileSync(f, '{"pid": 4');
    await assert.rejects(withScheduleLock(d, async () => 'x'), { code: 'sender-elsewhere' });
    assert.equal(stuckLock(d), null);
  });

  test('D409-7: crash after the new lock, before the old claim was removed: Clear offered, click, next pass sends', async () => {
    const { LOCK_NAME, stuckLock, clearStuckLock } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const f = path.join(e.dataDir, 'posting', LOCK_NAME);
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify({ pid: 2 ** 30 - 2, start: 3, token: 'new-7', at: Date.now() }));
    writeFileSync(`${f}.old-7.claim`, JSON.stringify({ pid: 2 ** 30 - 2, start: 3 }));
    const c = schedChain(e, g);
    await c.afterRun(e.runDir, IDLE);
    assert.equal(g.count('init'), 0); assert.equal(e.queue().items()[0].reason, 'sender-elsewhere');
    const s = stuckLock(e.dataDir);
    assert.equal(s?.id, 'schedule.lock.old-7.claim:new-7');
    // A second claim with a LIVE claimant: never stuck.
    writeFileSync(`${f}.zz.claim`, JSON.stringify({ pid: process.ppid }));
    assert.equal(stuckLock(e.dataDir), null);
    rmSync(`${f}.zz.claim`);
    assert.deepEqual(await clearStuckLock(e.dataDir, s.id), { cleared: true });
    e.clock.t += 6 * MIN; await c.tick(IDLE);
    assert.equal(e.queue().items()[0].state, 'done'); assert.equal(g.videos.length, 1);
  });

  test('D409-6: interleaved clears cannot remove a live lock (acquire refuses while any claim exists; compare-before-delete)', async () => {
    const { LOCK_NAME, stuckLock, clearStuckLock, withScheduleLock } = await import('../services/posting/auto-chain.mjs');
    const g = await fakeGoogle(); const e = setup([ROWS[0]]); g.opt.hideOwnUploads = true;
    const f = path.join(e.dataDir, 'posting', LOCK_NAME);
    mkdirSync(path.dirname(f), { recursive: true });
    const claim = `${f}.old-3.claim`;
    writeFileSync(f, JSON.stringify({ pid: 2 ** 30, start: 1, token: 'old-3', at: Date.now() }));
    writeFileSync(claim, JSON.stringify({ pid: 2 ** 30 - 1, start: 2 }));
    const seenByB = stuckLock(e.dataDir).id; // B's view: the lock and the claim
    // A's clear removes the lock and stops before the claim (simulated: the claim is removed LAST).
    rmSync(f);
    // A sender attempt now must refuse: a claim exists although the lock file is absent.
    await assert.rejects(withScheduleLock(e.dataDir, async () => 'sent'), { code: 'sender-elsewhere' });
    assert.ok(!existsSync(f), 'no lock was created');
    // B's clear, made on its older view, refuses and removes nothing.
    assert.deepEqual(await clearStuckLock(e.dataDir, seenByB), { cleared: false, code: 'changed' });
    assert.ok(existsSync(claim));
    // A live lock (another live process) with B's stale id: refused, untouched.
    const live = JSON.stringify({ pid: process.ppid, start: 9, token: 'live', at: Date.now() });
    writeFileSync(f, live);
    assert.deepEqual(await clearStuckLock(e.dataDir, seenByB, { procStart: () => 9 }), { cleared: false, code: 'not-stuck' });
    assert.equal(readFileSync(f, 'utf8'), live); assert.ok(existsSync(claim));
    rmSync(f);
    // A finishes: the claim is removed last (here by a click on the current view); then the next pass sends.
    const now = stuckLock(e.dataDir).id;
    assert.equal(now, 'schedule.lock.old-3.claim:no-lock');
    assert.deepEqual(await clearStuckLock(e.dataDir, now), { cleared: true });
    assert.ok(!existsSync(claim));
    await schedChain(e, g).afterRun(e.runDir, IDLE);
    assert.equal(e.queue().items()[0].state, 'done'); assert.equal(g.videos.length, 1);
  });

  test('D409-4: two sender processes: the second refuses; three contenders on a dead lock: exactly one sends', async () => {
    const { spawn } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const { LOCK_NAME } = await import('../services/posting/auto-chain.mjs');
    const mod = pathToFileURL(path.resolve('services/posting/auto-chain.mjs')).href;
    const scriptDir = mk();
    const script = path.join(scriptDir, 'contend.mjs');
    writeFileSync(script, [
      `const { withScheduleLock } = await import(${JSON.stringify(mod)});`,
      'const [dataDir, goAt] = process.argv.slice(2);',
      'while (Date.now() < Number(goAt)) { /* start together */ }',
      'try { await withScheduleLock(dataDir, () => new Promise((r) => setTimeout(r, 1500)), { waitMs: 200 }); console.log("won"); }',
      'catch (e) { console.log(e?.code === "sender-elsewhere" ? "refused" : `error ${e?.code}`); }',
    ].join('\n'));
    const run = (d, goAt) => new Promise((resolve) => {
      const p = spawn(process.execPath, [script, d, String(goAt)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { out += b; });
      p.on('close', () => resolve(out.trim()));
    });
    // Two processes: the first holds; the second, started while the first holds, refuses (no wait, no takeover).
    {
      const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
      const first = run(d, Date.now());
      const f = path.join(d, 'posting', LOCK_NAME);
      for (let t = Date.now(); !existsSync(f) && Date.now() - t < 10000;) await new Promise((r) => setTimeout(r, 20));
      assert.equal(await run(d, Date.now()), 'refused');
      assert.equal(await first, 'won');
    }
    for (let round = 0; round < 3; round++) {
      const d = mk(); mkdirSync(path.join(d, 'posting'), { recursive: true });
      // A lock whose process is gone; three contenders start together.
      writeFileSync(path.join(d, 'posting', LOCK_NAME), JSON.stringify({ pid: 2 ** 30, token: 'dead', at: Date.now() }));
      const goAt = Date.now() + 1500;
      const outs = await Promise.all([run(d, goAt), run(d, goAt), run(d, goAt)]);
      assert.deepEqual(outs.slice().sort(), ['refused', 'refused', 'won'], `round ${round}: ${JSON.stringify(outs)}`);
    }
  });

});