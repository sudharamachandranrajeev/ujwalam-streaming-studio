// SPDX-License-Identifier: GPL-3.0-or-later
// PT4 (D410) growth-led timing, suggestions only: the math on fixture numbers (fewer than 8 posts = no suggestion), the
// exploration limit (at most 1 in 5 slots), nothing applied without the click, Apply checked with the 60-minute floor and
// logged, Undo puts the schedule back exactly (and refuses to overwrite a later change), Dismiss. Plus the routes.
// Fixture numbers and a temp SQLite store only: no network, no YouTube call.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DB_NAME, openStore } from '../services/analytics/index.mjs';
import { analyseTiming, applySuggestion, dismissSuggestion, exploreSlots, loadTimingConfig, readGrowthLog, readRecord, refreshSuggestion, undoSuggestion } from '../services/analytics/timing.mjs';
import { savePrefs, defaultPrefs } from '../services/posting/post-prefs.mjs';
import { HARD_GAP_MINUTES, hhmmMinutes, userScheduleFile } from '../services/posting/schedule.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const cfg = loadTimingConfig();
const tmp = []; const servers = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pt4-')); tmp.push(d); mkdirSync(path.join(d, 'posting'), { recursive: true }); return d; };
after(async () => { for (const s of servers) await s.close?.(); for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const SCHED = { placement: 'random-daily', postsPerDayMin: 3, postsPerDayMax: 6, windowStart: '09:00', windowEnd: '23:00', minGapMinutes: 60 };

/** n posts at `hour` UTC with `views` 24 h views, one a day from 2026-10-01. */
function posts(n, hour, views, kind = 'short', from = 0) {
  return Array.from({ length: n }, (_, i) => ({ videoId: `v${hour}-${from + i}`, kind, publicAt: new Date(Date.UTC(2026, 9, 1 + from + i, hour, 0)).toISOString(),
    at24h: { views, avgViewedPct: 80, subs: 1 }, at7d: { views: views * 2 } }));
}
const FIXTURE = [...posts(12, 19, 134), ...posts(6, 10, 100), ...posts(6, 14, 100, 'montage')];

describe('growth-led timing math (PT4)', () => {
  test('fewer than 8 posts with numbers: no suggestion, and it says why', () => {
    const a = analyseTiming({ videos: posts(7, 19, 500), cfg, schedule: SCHED, tz: 'UTC' });
    assert.equal(a.count, 7); assert.equal(a.enough, false); assert.equal(a.suggestion, null); assert.equal(a.reason, 'few-posts');
    const noNumbers = posts(20, 19, 500).map((v) => ({ ...v, at24h: null }));
    assert.equal(analyseTiming({ videos: noNumbers, cfg, schedule: SCHED, tz: 'UTC' }).reason, 'few-posts', 'posts without a 24 h number do not count');
  });

  test('fixture: move 2 of the daily posts to 18:00-21:00, +34 % on 12 posts, with the numbers behind it', () => {
    const a = analyseTiming({ videos: FIXTURE, cfg, schedule: SCHED, tz: 'UTC' });
    const s = a.suggestion;
    assert.ok(s, a.reason);
    assert.equal(s.text, 'Move 2 of your daily posts to 18:00-21:00: +34 % 24 h views on 12 posts.');
    assert.deepEqual([s.numbers.bandPosts, s.numbers.bandViews24h, s.numbers.otherPosts, s.numbers.otherViews24h, s.numbers.liftPct], [12, 134, 12, 100, 34]);
    assert.equal(s.numbers.bandViews7d, 268);
    assert.equal(s.perDay, 6);
    assert.equal(s.times.length, 6);
    assert.equal(s.times.filter((t) => hhmmMinutes(t) >= 18 * 60 && hhmmMinutes(t) < 21 * 60).length >= 2, true);
    const m = s.times.map(hhmmMinutes);
    for (let i = 1; i < m.length; i += 1) assert.ok(m[i] - m[i - 1] >= HARD_GAP_MINUTES, `gap ${s.times}`);
    assert.ok(m.every((x) => x >= 9 * 60 && x < 23 * 60), 'inside the window');
    assert.equal(s.change.placement, 'custom');
    assert.deepEqual(s.change.customTimes.mon, s.times);
    // per kind and weekday are reported
    assert.ok(a.byKind.short && a.byKind.montage);
    assert.equal(a.byWeekday.reduce((n, d) => n + d.n, 0), 24);
  });

  test('no clear winner (every band about the same): no suggestion', () => {
    const a = analyseTiming({ videos: [...posts(6, 19, 100), ...posts(6, 10, 102)], cfg, schedule: SCHED, tz: 'UTC' });
    assert.equal(a.suggestion, null); assert.equal(a.reason, 'no-clear-winner');
  });

  test('exploration: at most 1 in 5 slots, for every posts-a-day value', () => {
    for (let n = 1; n <= 24; n += 1) assert.ok(exploreSlots(n, cfg.exploreShare) * 5 <= n, `n=${n}`);
    assert.equal(exploreSlots(4, 0.2), 0); assert.equal(exploreSlots(5, 0.2), 1); assert.equal(exploreSlots(24, 0.2), 4);
    for (const max of [1, 3, 5, 6, 10, 14]) {
      const s = analyseTiming({ videos: FIXTURE, cfg, schedule: { ...SCHED, windowStart: '00:00', windowEnd: '24:00', postsPerDayMax: max }, tz: 'UTC' }).suggestion;
      assert.ok(s, `max=${max}`);
      assert.ok(s.explore * 5 <= s.perDay, `explore ${s.explore} of ${s.perDay}`);
      assert.ok(s.exploreTimes.every((t) => hhmmMinutes(t) < 18 * 60 || hhmmMinutes(t) >= 21 * 60), 'explore slots are outside the best band');
    }
    assert.throws(() => loadTimingConfig(writeTmp({ ...cfg, exploreShare: 0.5 })), /at most 0.2/);
  });
});

function writeTmp(j) { const f = path.join(mk(), 'g.json'); writeFileSync(f, JSON.stringify(j)); return f; }

describe('the suggestion record and its clicks (PT4)', () => {
  const fresh = () => analyseTiming({ videos: FIXTURE, cfg, schedule: SCHED, tz: 'UTC' });

  test('showing a suggestion writes only its record: the schedule is not touched without the click', () => {
    const d = mk();
    const rec = refreshSuggestion({ dataDir: d, analysis: fresh(), cfg });
    assert.equal(rec.status, 'open');
    assert.equal(existsSync(userScheduleFile(d)), false);
    assert.deepEqual(readGrowthLog(d), []);
    assert.equal(refreshSuggestion({ dataDir: d, analysis: fresh(), cfg }).createdAt, rec.createdAt, 'the same suggestion is kept');
  });

  test('Apply writes the schedule (custom times, 60-minute floor kept, other settings kept), logs it; Undo removes it again', () => {
    const d = mk();
    const rec = refreshSuggestion({ dataDir: d, analysis: fresh(), cfg });
    assert.equal(applySuggestion(d, 'g-nope').ok, false);
    const r = applySuggestion(d, rec.id);
    assert.equal(r.ok, true);
    const sch = JSON.parse(readFileSync(userScheduleFile(d), 'utf8'));
    assert.equal(sch.placement, 'custom');
    assert.deepEqual(sch.customTimes.fri, rec.times);
    assert.equal(readGrowthLog(d).at(-1).action, 'apply');
    assert.equal(applySuggestion(d, rec.id).code, 'not-open', 'applied once');
    assert.equal(refreshSuggestion({ dataDir: d, analysis: fresh(), cfg }).status, 'applied', 'an applied change stays with its Undo');
    const u = undoSuggestion(d, rec.id);
    assert.equal(u.ok, true);
    assert.equal(existsSync(userScheduleFile(d)), false, 'there was no schedule file before: it is gone again');
    assert.equal(readGrowthLog(d).at(-1).action, 'undo');
    assert.equal(undoSuggestion(d, rec.id).ok, false);
  });

  test('Undo puts an earlier schedule file back byte for byte; it refuses when the schedule changed after Apply', () => {
    const d = mk();
    const before = `${JSON.stringify({ placement: 'random-daily', postsPerDayMax: 6, minGapMinutes: 90, seed: 5 }, null, 2)}\n`;
    writeFileSync(userScheduleFile(d), before);
    const rec = refreshSuggestion({ dataDir: d, analysis: fresh(), cfg });
    applySuggestion(d, rec.id);
    const sch = JSON.parse(readFileSync(userScheduleFile(d), 'utf8'));
    assert.deepEqual([sch.minGapMinutes, sch.seed, sch.placement], [90, 5, 'custom'], 'other settings stay');
    assert.equal(undoSuggestion(d, rec.id).ok, true);
    assert.equal(readFileSync(userScheduleFile(d), 'utf8'), before);
    const d2 = mk();
    const rec2 = refreshSuggestion({ dataDir: d2, analysis: fresh(), cfg });
    applySuggestion(d2, rec2.id);
    writeFileSync(userScheduleFile(d2), JSON.stringify({ placement: 'fill-gaps' }));
    assert.equal(undoSuggestion(d2, rec2.id).code, 'changed-since');
    assert.equal(JSON.parse(readFileSync(userScheduleFile(d2), 'utf8')).placement, 'fill-gaps', 'the later change stays');
  });

  test('Dismiss changes nothing and the same suggestion is not offered again for a while', () => {
    const d = mk();
    const rec = refreshSuggestion({ dataDir: d, analysis: fresh(), cfg });
    assert.equal(dismissSuggestion(d, rec.id).ok, true);
    assert.equal(existsSync(userScheduleFile(d)), false);
    assert.equal(refreshSuggestion({ dataDir: d, analysis: fresh(), cfg }), null);
    assert.equal(readRecord(d).status, 'dismissed');
  });
});

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject); req.end(body);
  });
}

function seedStore(dataDir, videos) {
  const st = openStore(path.join(dataDir, DB_NAME));
  for (const v of videos) {
    st.upsertVideo({ videoId: v.videoId, kind: v.kind, postId: v.videoId, uploadedAt: v.publicAt });
    st.setState(v.videoId, 'public', v.publicAt);
    st.addSnapshot({ videoId: v.videoId, fetchedAt: new Date(Date.parse(v.publicAt) + 25 * 3600_000).toISOString(), ageHours: 25,
      data: { privacy: 'public', views: v.at24h.views }, analytics: { views: v.at24h.views, averageViewPercentage: 80, subscribersGained: 1 } });
  }
  st.close();
}

async function boot(flags, dataDir = mk()) {
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
  writeFileSync(userScheduleFile(dataDir), JSON.stringify({ ...SCHED, timeZone: 'UTC' }));
  const KEY = 'g'.repeat(48);
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), now: () => Date.parse('2026-11-21T10:00:00Z'),
    youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, fetchImpl: async () => { throw new Error('no network'); }, outputsStatus: async () => ({ sinks: [] }) } });
  servers.push(srv);
  const { port } = await srv.listen();
  const cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  const get = (url) => raw(port, { url, headers: { cookie } });
  return { dataDir, post, get };
}

describe('growth suggestion routes (PT4)', () => {
  test('growth flag off, or suggestions switched off: nothing is proposed', async () => {
    const t = await boot({ posting: true });
    const r = (await t.get('/ui/api/posts/growth-suggestion')).json();
    assert.deepEqual([r.enabled, r.why, r.record], [false, 'growth-off', null]);
    const t2 = await boot({ posting: true, growth: true });
    savePrefs(t2.dataDir, { prefs: { ...defaultPrefs(), growthSuggestions: false } });
    assert.equal((await t2.get('/ui/api/posts/growth-suggestion')).json().why, 'suggestions-off');
  });

  test('from the stored numbers: one suggestion; Apply writes the schedule, Undo puts it back; the saved text never leaves', async () => {
    const t = await boot({ posting: true, growth: true });
    seedStore(t.dataDir, FIXTURE);
    const before = readFileSync(userScheduleFile(t.dataDir), 'utf8');
    const g = (await t.get('/ui/api/posts/growth-suggestion')).json();
    assert.equal(g.enabled, true); assert.equal(g.count, 24);
    assert.equal(g.record.text, 'Move 2 of your daily posts to 18:00-21:00: +34 % 24 h views on 12 posts.');
    assert.equal(readFileSync(userScheduleFile(t.dataDir), 'utf8'), before, 'not applied without the click');
    assert.equal((await t.post('/ui/api/posts/growth-suggestion/apply', { id: g.record.id, extra: 1 })).status, 400);
    const a = await t.post('/ui/api/posts/growth-suggestion/apply', { id: g.record.id });
    assert.equal(a.status, 200);
    assert.equal(a.json().record.status, 'applied');
    assert.equal(a.json().record.before, undefined); assert.equal(a.json().record.appliedText, undefined);
    assert.equal(JSON.parse(readFileSync(userScheduleFile(t.dataDir), 'utf8')).placement, 'custom');
    const u = await t.post('/ui/api/posts/growth-suggestion/undo', { id: g.record.id });
    assert.equal(u.status, 200);
    assert.equal(readFileSync(userScheduleFile(t.dataDir), 'utf8'), before);
  });

  test('fewer than 8 posts stored: enabled, no record, reason few-posts', async () => {
    const t = await boot({ posting: true, growth: true });
    seedStore(t.dataDir, posts(5, 19, 300));
    const g = (await t.get('/ui/api/posts/growth-suggestion')).json();
    assert.deepEqual([g.enabled, g.count, g.reason, g.record], [true, 5, 'few-posts', null]);
  });
});
