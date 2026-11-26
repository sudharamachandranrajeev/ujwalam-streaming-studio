// SPDX-License-Identifier: GPL-3.0-or-later
// Instagram winners (2026-11-26): Reel insights reader, snapshot store, score, weekly promoter and the auto-post chain in
// youtubeSource 'instagram-winners' mode. Fakes only: an in-memory fake Graph (fetchImpl), temp data dirs. Never Meta.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { CORE_METRICS, IG_DB_NAME, REEL_METRICS, collectInstagram, igSummary, openIgStore, parseInsights, ranking, readReelInsights, reelScore, weekOf, weeklyWinners } from '../services/analytics/instagram.mjs';
import { main as cliMain } from '../services/analytics/cli.mjs';
import { createPostChain, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { instagramWinnerCandidates, validateRules } from '../services/posting/auto-post.mjs';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { createInstagramQueue } from '../services/posting/instagram-queue.mjs';
import { loadIgConfig } from '../services/posting/instagram.mjs';
import { READONLY_SCOPE } from '../services/posting/oauth.mjs';
import { scheduleManagerView } from '../services/posting/schedule-manager.mjs';

const H = 3_600_000; const D = 24 * H;
const cfg = loadIgConfig();
const endpoints = { graph: 'http://127.0.0.1:9' };
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-igw-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const res = (status, j) => ({ ok: status >= 200 && status < 300, status, json: async () => j });
const answer = (m) => ({ data: Object.entries(m).map(([name, value]) => ({ name, period: 'lifetime', values: [{ value }], title: name, id: `x/insights/${name}/lifetime` })) });
/** Fake Graph: per media id the metrics to answer; `reject` = a metric list error (100) for the full list. */
function fakeGraph({ media = {}, rejectFull = false, deny = false, rate = false } = {}) {
  const calls = [];
  const fetchImpl = async (u) => {
    const url = new URL(u); calls.push(url);
    if (deny) return res(403, { error: { code: 10, message: 'permission' } });
    if (rate) return res(400, { error: { code: 4 } });
    const m = url.pathname.match(/\/(\d+)\/insights$/);
    if (!m || !media[m[1]]) return res(400, { error: { code: 100 } });
    const asked = url.searchParams.get('metric').split(',');
    if (rejectFull && asked.includes('views')) return res(400, { error: { code: 100, message: 'metric not supported' } });
    return res(200, answer(Object.fromEntries(Object.entries(media[m[1]]).filter(([k]) => asked.includes(k)))));
  };
  return { fetchImpl, calls };
}
const auth = (over = {}) => ({ status: async () => ({ connected: true, insightsAllowed: true, ...over }), session: async () => ({ token: 'TOKEN-X', igUserId: '1784000000' }) });

function igQueue(dataDir, jobs) {
  const q = createInstagramQueue(path.join(dataDir, 'posting', 'instagram-queue.json'));
  for (const j of jobs) { q.add(j.id, j.postedAt); q.patch(j.id, { state: 'done', mediaId: j.mediaId, postedAt: j.postedAt }); }
}

describe('insights parsing and reading', () => {
  test('parseInsights: values[0].value and total_value; junk ignored', () => {
    assert.deepEqual(parseInsights({ data: [{ name: 'views', values: [{ value: 120 }] }, { name: 'reach', total_value: { value: 90 } }, { name: 'Bad Name', values: [{ value: 1 }] }, { name: 'likes', values: [{ value: 'x' }] }] }), { views: 120, reach: 90 });
    assert.deepEqual(parseInsights(null), {});
  });

  test('asks the full Reels list; error 100 -> the core list; the token only as access_token', async () => {
    const g = fakeGraph({ media: { 111: { views: 500, reach: 400, likes: 20, saved: 3, shares: 4, comments: 1, total_interactions: 28, ig_reels_avg_watch_time: 6000, ig_reels_video_view_total_time: 3000000 } } });
    const m = await readReelInsights({ fetchImpl: g.fetchImpl, endpoints, cfg, token: 'TOKEN-X', mediaId: '111' });
    assert.equal(m.views, 500); assert.equal(m.ig_reels_avg_watch_time, 6000);
    assert.equal(g.calls[0].pathname, `/${cfg.graphVersion}/111/insights`);
    assert.deepEqual(g.calls[0].searchParams.get('metric').split(','), [...REEL_METRICS]);
    const g2 = fakeGraph({ media: { 111: { views: 5, reach: 4, likes: 1 } }, rejectFull: true });
    const m2 = await readReelInsights({ fetchImpl: g2.fetchImpl, endpoints, cfg, token: 'T', mediaId: '111' });
    assert.deepEqual(m2, { reach: 4, likes: 1 });
    assert.deepEqual(g2.calls[1].searchParams.get('metric').split(','), [...CORE_METRICS]);
  });

  test('a permission refusal (code 10) -> insights-scope-missing; a bad media id never reaches the network', async () => {
    const g = fakeGraph({ deny: true });
    await assert.rejects(readReelInsights({ fetchImpl: g.fetchImpl, endpoints, cfg, token: 'T', mediaId: '111' }), { code: 'insights-scope-missing' });
    await assert.rejects(readReelInsights({ fetchImpl: g.fetchImpl, endpoints, cfg, token: 'T', mediaId: '../me' }), { code: 'bad-media-id' });
    assert.equal(g.calls.length, 1);
  });
});

describe('collectInstagram', () => {
  test('missing scope fails closed before any request; not connected too', async () => {
    const dataDir = mk(); const g = fakeGraph();
    await assert.rejects(collectInstagram({ dataDir, auth: auth({ insightsAllowed: false }), fetchImpl: g.fetchImpl, endpoints, cfg }), { code: 'insights-scope-missing' });
    await assert.rejects(collectInstagram({ dataDir, auth: auth({ connected: false }), fetchImpl: g.fetchImpl, endpoints, cfg }), { code: 'reauth-needed' });
    assert.equal(g.calls.length, 0);
  });

  test('snapshots per posted Reel with age; hourly at most; 48 h / 7 d checkpoints; old Reels not read again', async () => {
    const dataDir = mk(); const t0 = Date.parse('2026-11-20T08:00:00Z');
    igQueue(dataDir, [{ id: 'p1', mediaId: '111', postedAt: new Date(t0).toISOString() }]);
    const g = fakeGraph({ media: { 111: { views: 10, reach: 8 } } });
    const posts = [{ id: 'p1', clipId: 'c1', startSec: 2, endSec: 14, status: 'approved' }];
    let now = t0 + 10 * H;
    const run = (force = false) => collectInstagram({ dataDir, auth: auth(), posts, fetchImpl: g.fetchImpl, endpoints, cfg, now: () => now, force });
    assert.equal((await run()).snapshots, 1);
    now += 30 * 60_000; assert.equal((await run()).skipped, 'recent'); assert.equal(g.calls.length, 1);
    for (const h of [49, 170]) { now = t0 + h * H; await run(); }
    const s = openIgStore(path.join(dataDir, IG_DB_NAME));
    try {
      const [r] = igSummary(s);
      assert.equal(r.lengthSec, 12); assert.equal(r.clipId, 'c1');
      assert.equal(r.at48h.ageHours, 49); assert.equal(r.at7d.ageHours, 170); assert.equal(r.latest.metrics.views, 10);
    } finally { s.close(); }
    now = t0 + 300 * H; const n = g.calls.length;
    assert.equal((await run()).snapshots, 0); assert.equal(g.calls.length, n);
  });

  test('a rate limit stops the run (kept); a deleted Reel is counted failed', async () => {
    const dataDir = mk(); const t0 = Date.parse('2026-11-20T08:00:00Z');
    igQueue(dataDir, [{ id: 'p1', mediaId: '111', postedAt: new Date(t0).toISOString() }, { id: 'p2', mediaId: '222', postedAt: new Date(t0).toISOString() }]);
    const g = fakeGraph({ media: { 222: { views: 1 } } });
    const r = await collectInstagram({ dataDir, auth: auth(), fetchImpl: g.fetchImpl, endpoints, cfg, now: () => t0 + 5 * H });
    assert.equal(r.failed, 1); assert.equal(r.snapshots, 1);
    const r2 = await collectInstagram({ dataDir, auth: auth(), fetchImpl: fakeGraph({ rate: true }).fetchImpl, endpoints, cfg, now: () => t0 + 7 * H });
    assert.equal(r2.stopped, 'rate-limited');
  });
});

describe('reelScore', () => {
  test('watch time weighs most; shares and saves weigh more than likes; reach scales it', () => {
    const base = { views: 1000, reach: 900, likes: 0, comments: 0, saved: 0, shares: 0, ig_reels_avg_watch_time: 6000 };
    assert.equal(reelScore(base, 12), Math.round(Math.log10(1001) * (2 * 0.5) * 1000) / 1000);
    assert.ok(reelScore({ ...base, ig_reels_avg_watch_time: 12000 }, 12) > reelScore({ ...base, likes: 50 }, 12));
    assert.ok(reelScore({ ...base, shares: 10 }, 12) > reelScore({ ...base, likes: 30 }, 12));
    assert.ok(reelScore({ ...base, saved: 10 }, 12) > reelScore({ ...base, likes: 20 }, 12));
    assert.ok(reelScore({ ...base, views: 10000 }, 12) > reelScore(base, 12));
    assert.equal(reelScore({ ...base, ig_reels_avg_watch_time: 60000 }, 12), Math.round(Math.log10(1001) * 4 * 1000) / 1000, 'watch capped at 2');
    assert.equal(reelScore({ views: 0 }, 12), 0);
    assert.equal(reelScore({ ...base, ig_reels_avg_watch_time: undefined }, 12), 0);
    assert.equal(reelScore(null, 12), null);
  });
});

/** A store with reels posted `daysAgo` before `at`, each with a 48 h snapshot. */
function seed(dataDir, at, reels) {
  const s = openIgStore(path.join(dataDir, IG_DB_NAME));
  for (const r of reels) {
    const posted = at - r.daysAgo * D;
    s.upsertReel({ mediaId: r.mediaId, postId: r.postId, postedAt: new Date(posted).toISOString(), lengthSec: 10 });
    if (r.metrics) s.addSnapshot({ mediaId: r.mediaId, fetchedAt: new Date(posted + 49 * H).toISOString(), ageHours: 49, metrics: r.metrics });
  }
  return s;
}
const m = (watchMs, views = 1000) => ({ views, reach: views, likes: 10, ig_reels_avg_watch_time: watchMs });

describe('ranking and weekly winners', () => {
  const MON = weekOf(Date.parse('2026-11-30T12:00:00Z')).startMs;
  test('weekOf: Monday 00:00 local', () => {
    const w = new Date(MON); assert.equal(w.getDay(), 1); assert.equal(w.getHours(), 0);
    assert.equal(weekOf(MON + 6 * D + 23 * H).startMs, MON);
  });

  test('window 9..2 days back, best first, top N; not approved / uploaded / no numbers are left out with a reason', () => {
    const dataDir = mk();
    const s = seed(dataDir, MON, [
      { postId: 'a', mediaId: '1', daysAgo: 3, metrics: m(5000) }, { postId: 'b', mediaId: '2', daysAgo: 8, metrics: m(9000) },
      { postId: 'c', mediaId: '3', daysAgo: 4, metrics: m(7000) }, { postId: 'old', mediaId: '4', daysAgo: 10, metrics: m(9900) },
      { postId: 'new', mediaId: '5', daysAgo: 1, metrics: m(9900) }, { postId: 'up', mediaId: '6', daysAgo: 5, metrics: m(9800) },
      { postId: 'none', mediaId: '7', daysAgo: 5 }, { postId: 'draft', mediaId: '8', daysAgo: 5, metrics: m(9700) },
    ]);
    const posts = ['a', 'b', 'c', 'old', 'new'].map((id) => ({ id, status: 'approved', title: id })).concat([{ id: 'up', status: 'uploaded' }, { id: 'none', status: 'approved' }, { id: 'draft', status: 'draft' }]);
    try {
      const r = ranking(s, { atMs: MON, posts });
      assert.deepEqual(r.map((x) => x.postId), ['up', 'draft', 'b', 'c', 'a', 'none']);
      assert.deepEqual(r.filter((x) => !x.eligible).map((x) => [x.postId, x.why]), [['up', 'on-youtube'], ['draft', 'not-approved'], ['none', 'no-48h-numbers']]);
      const w = weeklyWinners({ dataDir, posts, nowMs: MON + 3 * H, perWeek: 2, store: s });
      assert.equal(w.ran, true); assert.deepEqual(w.winners.map((x) => [x.postId, x.rank]), [['b', 1], ['c', 2]]);
      // same week: the same list, nothing new recorded; a dry run records nothing
      const again = weeklyWinners({ dataDir, posts, nowMs: MON + 2 * D, perWeek: 5, store: s });
      assert.equal(again.ran, false); assert.deepEqual(again.winners.map((x) => x.postId), ['b', 'c']);
      // next week: b and c never again (already promoted), a is out of the window by then
      const next = weeklyWinners({ dataDir, posts, nowMs: MON + 7 * D + H, perWeek: 5, store: s });
      assert.equal(next.ran, true); assert.deepEqual(next.winners.map((x) => x.postId), ['new']);
      assert.equal(s.promotions().length, 3);
    } finally { s.close(); }
  });

  test('dry run records nothing; default N is 21', () => {
    const dataDir = mk();
    const reels = Array.from({ length: 30 }, (_, i) => ({ postId: `p${i}`, mediaId: String(100 + i), daysAgo: 3 + (i % 5), metrics: m(1000 + i * 100) }));
    const s = seed(dataDir, MON, reels);
    const posts = reels.map((r) => ({ id: r.postId, status: 'approved' }));
    try {
      const d = weeklyWinners({ dataDir, posts, nowMs: MON, dryRun: true, store: s });
      assert.equal(d.winners.length, 21); assert.equal(d.winners[0].postId, 'p29');
      assert.equal(s.promotions().length, 0); assert.equal(s.meta('lastWeek'), null);
    } finally { s.close(); }
  });

  test('instagramWinnerCandidates: none without a data dir; this week\'s winners otherwise; rules youtubeWinnersPerWeek', () => {
    assert.deepEqual(instagramWinnerCandidates({}), []);
    const dataDir = mk();
    seed(dataDir, MON, [{ postId: 'a', mediaId: '1', daysAgo: 3, metrics: m(5000) }, { postId: 'b', mediaId: '2', daysAgo: 4, metrics: m(8000) }]).close();
    const store = { list: () => [{ id: 'a', status: 'approved' }, { id: 'b', status: 'approved' }] };
    assert.deepEqual(instagramWinnerCandidates({ dataDir, store, nowMs: MON + H, perWeek: 1 }), ['b']);
    assert.deepEqual(instagramWinnerCandidates({ dataDir, store, nowMs: MON + 2 * H, perWeek: 5 }), ['b']);
    const r = { autoUpload: true, rules: [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 5 }] };
    assert.equal(validateRules({ ...r, youtubeWinnersPerWeek: 14 }).youtubeWinnersPerWeek, 14);
    assert.throws(() => validateRules({ ...r, youtubeWinnersPerWeek: 0 }));
  });
});

describe('chain in instagram-winners mode', () => {
  test('the week\'s winner is queued for YouTube once; a non-winner never is', async () => {
    const NOW = weekOf(Date.parse('2026-11-30T12:00:00Z')).startMs + 10 * H;
    const dataDir = mk(); mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
    writeFileSync(path.join(dataDir, 'posting', 'schedule.json'), JSON.stringify({ placement: 'fill-gaps' }));
    const entries = {}; const ids = [];
    for (const name of ['win', 'lose']) {
      const video = Buffer.from(`video-${name}`.repeat(5)); const sha = createHash('sha256').update(video).digest('hex');
      const dir = path.join(mk(), 'posts', name, 'youtube-shorts'); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'full-crop.mp4'), video);
      const stamp = '2026-11-20T09:00:00.000Z';
      writeFileSync(path.join(dir, 'post.json'), JSON.stringify({ version: 1, title: 'T', description: 'D', tags: ['g'], hashtags: ['#Shorts'], target: 'youtube-shorts', privacy: 'private', status: 'approved',
        source: { run: 'run1', clipId: name, layout: 'full-crop', startSec: 0, endSec: 10, score: 9, sha256: sha }, video: { file: 'full-crop.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp }));
      entries[`${sha}:youtube-shorts`] = { sha256: sha, target: 'youtube-shorts', status: 'approved', dir, clipId: name, createdAt: stamp, updatedAt: stamp };
      ids.push(postId({ sha256: sha, target: 'youtube-shorts' }));
    }
    const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
    writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries }));
    mkdirSync(path.join(dataDir, 'clips'), { recursive: true }); writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: [] }));
    const s = openIgStore(path.join(dataDir, IG_DB_NAME));
    const wk = weekOf(NOW).startMs;
    seed(dataDir, wk, []).close();
    s.upsertReel({ mediaId: '11', postId: ids[0], postedAt: new Date(wk - 4 * D).toISOString(), lengthSec: 10 });
    s.addSnapshot({ mediaId: '11', fetchedAt: new Date(wk - 2 * D).toISOString(), ageHours: 48, metrics: m(9000) });
    s.upsertReel({ mediaId: '12', postId: ids[1], postedAt: new Date(wk - 4 * D).toISOString(), lengthSec: 10 });
    s.addSnapshot({ mediaId: '12', fetchedAt: new Date(wk - 2 * D).toISOString(), ageHours: 48, metrics: { ...m(1000, 50), likes: 0 } });
    s.close();
    const rulesFile = path.join(dataDir, 'rules.json');
    writeFileSync(rulesFile, JSON.stringify({ autoUpload: true, youtubeSource: 'instagram-winners', youtubeWinnersPerWeek: 1, rules: [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 5 }] }));
    const c = createPostChain({ dataDir, flags: { isOn: (id) => id !== 'post-delete-uploaded' }, rulesFile, auth: { status: async () => ({ signedIn: true, hasClient: true }), accessToken: async () => 'tok', grantedScopes: async () => [READONLY_SCOPE] },
      fetchImpl: async () => { throw new Error('no network in this test'); }, now: () => NOW, tickEveryMs: 0, profileFile: path.join(dataDir, 'none.json'), packageImpl: async () => ({ packaged: [], skipped: [] }) });
    await c.afterRun('x', { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }] });
    const q =createUploadQueue(path.join(dataDir, 'posting', 'upload-queue.json'));
    assert.ok(q.get(ids[0]), 'winner queued'); assert.equal(q.get(ids[1]), null, 'loser not queued');
    const st = openIgStore(path.join(dataDir, IG_DB_NAME));
    try { assert.deepEqual(st.promotions().map((p) => p.postId), [ids[0]]); } finally { st.close(); }
    // scheduling manager: IG score on the row, preview list present
    const v = scheduleManagerView(dataDir, { posts: createPostStore({ ledgerFile }).list(), nowMs: NOW });
    const row = v.rows.find((r) => r.id === ids[0]);
    assert.ok(row && row.igScore > 0); assert.ok(Array.isArray(v.nextWeekToYoutube));
    c.stop?.();
  });
});

describe('cli', () => {
  test('instagram winners --dry-run prints the ranking; flag off -> exit 3', async () => {
    const dataDir = mk();
    const lines = []; const errs = [];
    writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { 'instagram-autopost': false } }));
    assert.equal(await cliMain(['instagram', 'winners', '--dry-run', '--data-dir', dataDir], (s) => lines.push(s), (s) => errs.push(s)), 3);
    const dataDir2 = mk();
    writeFileSync(path.join(dataDir2, 'flags.local.json'), JSON.stringify({ flags: { 'instagram-autopost': true } }));
    assert.equal(await cliMain(['instagram', 'winners', '--dry-run', '--data-dir', dataDir2], (s) => lines.push(s), (s) => errs.push(s)), 0, errs.join('\n'));
    assert.match(lines.join('\n'), /dry run/);
  });
});
