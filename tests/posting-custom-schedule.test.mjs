// SPDX-License-Identifier: GPL-3.0-or-later
// Custom posting times (user 2026-11-20: "add the ability to setup custom schedule in app as well"): a weekly plan of
// exact local times per weekday (DST-safe), filled in order, a taken or too close time skipped (never moved), days off;
// "What gets posted" editor (keeps unknown rules and keys, validated, session + CSRF + same Origin); never silent when
// auto-post is on but nothing can upload. Temp dirs through the data-root guard; fake auth; no network.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { safeRoot } from './helpers/data-root-guard.mjs';
import { DEFAULT_SCHEDULE, ScheduleError, checkUserSchedule, customDayTimes, loadScheduleConfig, planQueueSlots, userScheduleFile } from '../services/posting/schedule.mjs';
import { NOTICE_TASK, NOTICE_TEXT, userRulesFile } from '../services/posting/auto-post.mjs';
import { cardFromRules, readRulesEditor, saveAutoPostSettings, saveRulesEdit } from '../services/posting/auto-settings.mjs';
import { createPostChain } from '../services/posting/auto-chain.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { spawnSync } from 'node:child_process';
import { qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const dirs = []; const servers = [];
after(async () => { for (const s of servers) await s.close?.(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const mk = () => { const d = safeRoot(mkdtempSync(path.join(os.tmpdir(), 'ujw-custom-'))); dirs.push(d); mkdirSync(path.join(d, 'posting'), { recursive: true }); return d; };
const Z = (s) => Date.parse(s);
const iso = (t) => (t === null ? null : new Date(t).toISOString());

function cfgWith(user, tz = 'Europe/London') {
  const d = mk();
  writeFileSync(userScheduleFile(d), JSON.stringify({ placement: 'custom', ...user }));
  return { ...loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: userScheduleFile(d) }), timeZone: tz };
}
const items = (n) => Array.from({ length: n }, (_, k) => ({ id: `c${k}`, state: 'queued', publishAt: null, session: null }));
const plan = (o) => planQueueSlots(o).map((p) => [p.id, iso(p.at)]);

describe('custom placement (schedule.mjs)', () => {
  test('checks: weekdays only, times like 18:00, no twice, real dates; custom with no time refuses to load', () => {
    assert.deepEqual(checkUserSchedule({ customTimes: { mon: ['18:00', '09:00'] }, skipDates: ['2026-12-25'] }).values, { customTimes: { mon: ['09:00', '18:00'] }, skipDates: ['2026-12-25'] });
    assert.equal(checkUserSchedule({ customTimes: { monday: ['18:00'] } }).problems[0].key, 'customTimes');
    assert.equal(checkUserSchedule({ customTimes: { mon: ['25:00'] } }).problems[0].key, 'customTimes');
    assert.equal(checkUserSchedule({ customTimes: { mon: ['18:00', '18:00'] } }).problems[0].key, 'customTimes');
    assert.equal(checkUserSchedule({ skipDates: ['2026-02-30'] }).problems[0].key, 'skipDates');
    assert.throws(() => cfgWith({ customTimes: { mon: [] } }), ScheduleError);
  });

  test('slots fill the weekday times in order (local time)', () => {
    const cfg = cfgWith({ customTimes: { mon: ['18:00', '09:00'], wed: ['12:30'] } });
    const nowMs = Z('2026-11-15T00:00:00Z'); // a Sunday; London = UTC in November
    assert.deepEqual(plan({ items: items(4), nowMs, cfg }), [
      ['c0', '2026-11-16T09:00:00.000Z'], ['c1', '2026-11-16T18:00:00.000Z'], ['c2', '2026-11-18T12:30:00.000Z'], ['c3', '2026-11-23T09:00:00.000Z']]);
  });

  test('DST-safe: the same wall time on both sides of the spring change', () => {
    const cfg = cfgWith({ customTimes: { sat: ['18:00'], mon: ['18:00'] } });
    const nowMs = Z('2027-03-26T00:00:00Z'); // London moves to BST on Sunday 2027-03-28
    assert.deepEqual(plan({ items: items(2), nowMs, cfg }), [['c0', '2027-03-27T18:00:00.000Z'], ['c1', '2027-03-29T17:00:00.000Z']]);
    assert.deepEqual(customDayTimes('2027-03-29', cfg).map(iso), ['2027-03-29T17:00:00.000Z']);
  });

  test('days off are skipped', () => {
    const cfg = cfgWith({ customTimes: { mon: ['09:00'], wed: ['12:30'] }, skipDates: ['2026-11-16'] });
    assert.deepEqual(plan({ items: items(1), nowMs: Z('2026-11-15T00:00:00Z'), cfg }), [['c0', '2026-11-18T12:30:00.000Z']]);
  });

  test('a time too close to a channel post or already taken is skipped, never moved', () => {
    const cfg = cfgWith({ customTimes: { mon: ['09:00', '18:00'], tue: ['09:00'] }, minGapMinutes: 90 });
    const nowMs = Z('2026-11-15T00:00:00Z');
    // channel post at 09:30: 09:00 is within 90 min -> skipped; 18:00 is next
    assert.deepEqual(plan({ items: items(1), channelTimes: [Z('2026-11-16T09:30:00Z')], nowMs, cfg }), [['c0', '2026-11-16T18:00:00.000Z']]);
    // a held clip on Mon 18:00 keeps it; a held clip at a time that is not a custom time is moved onto one
    const held = [{ id: 'h1', state: 'queued', publishAt: '2026-11-16T18:00:00.000Z', session: null }, { id: 'h2', state: 'queued', publishAt: '2026-11-16T13:07:00.000Z', session: null }];
    const r = planQueueSlots({ items: [...held, ...items(1)], nowMs, cfg });
    assert.equal(r.some((p) => p.id === 'h1'), false, 'kept slot stays');
    assert.deepEqual(r.map((p) => [p.id, iso(p.at), p.reval]), [['h2', '2026-11-16T09:00:00.000Z', true], ['c0', '2026-11-17T09:00:00.000Z', false]]);
  });
});

// The user's own rules file (2026-11-20), as it is on disk: must load and stay unchanged.
const USER_RULES = {
  version: '0.2.0', autoUpload: true, maxUploadsPerDay: 6, note: 'kept',
  rules: [
    { id: 'all-shorts', target: 'youtube-shorts', minScore: 0, kinds: ['short', 'montage', 'won-reel', 'impact-play'], maxPerDay: 6 },
    { id: 'long-reels', target: 'youtube-video', minScore: 0, kinds: ['won-reel', 'montage'], maxPerDay: 1 },
  ],
};

describe('What gets posted (auto-settings.mjs)', () => {
  test("the user's file loads unchanged; an edit changes only what it names and keeps unknown rules and keys", () => {
    const d = mk();
    const doc = { ...USER_RULES, rules: [...USER_RULES.rules, { id: 'extra', target: 'youtube-shorts', minScore: 5, layouts: ['v'], kinds: ['short'], maxPerDay: 2, mine: 1 }] };
    writeFileSync(userRulesFile(d), JSON.stringify(doc, null, 2));
    const before = readFileSync(userRulesFile(d), 'utf8');
    const v = readRulesEditor(d);
    assert.equal(v.own, true); assert.equal(v.error, null); assert.equal(v.notice, null); assert.equal(v.maxUploadsPerDay, 6);
    assert.deepEqual(v.rules.map((r) => [r.id, r.kinds.join(), r.maxPerDay]), [['all-shorts', 'short,montage,won-reel,impact-play', 6], ['long-reels', 'won-reel,montage', 1], ['extra', 'short', 2]]);
    assert.equal(cardFromRules(doc).custom, true);
    assert.equal(readFileSync(userRulesFile(d), 'utf8'), before, 'reading changes nothing');
    // a bad edit writes nothing
    assert.equal(saveRulesEdit(d, { autoUpload: true, maxUploadsPerDay: 6, rules: [{ id: 'all-shorts', kinds: [], maxPerDay: 6 }] }).ok, false);
    assert.equal(saveRulesEdit(d, { autoUpload: true, maxUploadsPerDay: 6, rules: [{ id: 'nope', kinds: ['short'], maxPerDay: 1 }] }).ok, false);
    assert.equal(saveRulesEdit(d, { autoUpload: true, maxUploadsPerDay: 0, rules: [] }).ok, false);
    assert.equal(saveRulesEdit(d, { autoUpload: true, maxUploadsPerDay: 6, rules: [], extra: 1 }).ok, false);
    assert.equal(readFileSync(userRulesFile(d), 'utf8'), before);
    // a good edit
    const r = saveRulesEdit(d, { autoUpload: false, maxUploadsPerDay: 4, rules: [{ id: 'all-shorts', kinds: ['short', 'impact-play'], maxPerDay: 3 }] });
    assert.equal(r.ok, true);
    const now = JSON.parse(readFileSync(userRulesFile(d), 'utf8'));
    assert.equal(now.autoUpload, false); assert.equal(now.maxUploadsPerDay, 4); assert.equal(now.note, 'kept'); assert.equal(now.version, '0.2.0');
    assert.deepEqual(now.rules[0], { ...doc.rules[0], kinds: ['short', 'impact-play'], maxPerDay: 3 });
    assert.deepEqual(now.rules.slice(1), doc.rules.slice(1));
  });

  test('the card saved with keepRules writes the schedule and never touches the rules file', () => {
    const d = mk();
    writeFileSync(userRulesFile(d), JSON.stringify(USER_RULES));
    const before = readFileSync(userRulesFile(d), 'utf8');
    const card = { autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 6, placement: 'custom', customTimes: { fri: ['20:00'] }, skipDates: [] };
    assert.equal(saveAutoPostSettings(d, { card, keepRules: true }).ok, true);
    assert.equal(readFileSync(userRulesFile(d), 'utf8'), before);
    assert.deepEqual(JSON.parse(readFileSync(userScheduleFile(d), 'utf8')).customTimes, { fri: ['20:00'] });
  });

  test('no rules: the editor says so in plain words', () => {
    const d = mk();
    writeFileSync(userRulesFile(d), JSON.stringify({ autoUpload: true, rules: [] }));
    assert.equal(readRulesEditor(d).notice, NOTICE_TEXT['no-rules']);
    assert.equal(NOTICE_TEXT['no-rules'], 'Auto-post is on but no rule says what to post: nothing uploads');
    writeFileSync(userRulesFile(d), '{ nope');
    assert.equal(readRulesEditor(d).notice, NOTICE_TEXT['bad-rules']);
  });

  test('no rules: the upload pass puts it on the task bar, and clears it once rules exist', async () => {
    const d = mk();
    const rulesFile = userRulesFile(d);
    writeFileSync(rulesFile, JSON.stringify({ autoUpload: true, rules: [] }));
    const c = createPostChain({ dataDir: d, flags: { isOn: (id) => id !== 'post-delete-uploaded' }, rulesFile, auth: { status: async () => ({ signedIn: false }) }, now: () => Z('2026-11-20T10:00:00Z'), tickEveryMs: 0,
      profileFile: path.join(d, 'none.json'), packageImpl: async () => ({ packaged: [], skipped: [] }), scanFolder: false });
    assert.equal((await c.tick({ stream: 'stopped', recording: 'stopped', sinks: [] })).skipped, 'no-rules');
    const task = JSON.parse(readFileSync(path.join(d, 'tasks', `${NOTICE_TASK}.json`), 'utf8'));
    assert.equal(task.title, NOTICE_TEXT['no-rules']); assert.equal(task.state, 'waiting');
    writeFileSync(rulesFile, JSON.stringify(USER_RULES));
    await c.tick({ stream: 'stopped', recording: 'stopped', sinks: [] });
    assert.equal(existsSync(path.join(d, 'tasks', `${NOTICE_TASK}.json`)), false);
    c.stopTasks();
  });
});

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = []; res.on('data', (x) => chunks.push(x));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, json: () => JSON.parse(buf.toString('utf8')) }); });
    });
    req.on('error', reject); req.end(body);
  });
}

describe('routes: /ui/api/posts/auto/rules', () => {
  const KEY = 'k'.repeat(48);
  async function boot(flags) {
    const dataDir = mk();
    writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags }));
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), now: () => Z('2026-11-20T10:00:00Z'),
      youtube: { auth: { status: async () => ({ signedIn: false, hasClient: true }) }, outputsStatus: async () => ({ sinks: [] }) } });
    servers.push(srv);
    const { port } = await srv.listen();
    return { dataDir, port };
  }
  async function session(port) {
    const lr = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: `/login?k=${KEY}`, headers: { host: `127.0.0.1:${port}` } }, (r) => { r.resume(); res(r); }));
    const cookie = lr.headers['set-cookie'][0].split(';')[0];
    const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
    const origin = `http://127.0.0.1:${port}`;
    const post = (body, { noCsrf = false, badOrigin = false } = {}) => raw(port, { method: 'POST', url: '/ui/api/posts/auto/rules', body: JSON.stringify(body),
      headers: { cookie, origin: badOrigin ? 'http://evil.invalid' : origin, 'content-type': 'application/json', ...(noCsrf ? {} : { 'x-ujwalam-csrf': csrf }) } });
    return { cookie, post };
  }

  test('read needs the session and says why nothing uploads; save needs CSRF and same Origin and is checked', async () => {
    const t = await boot({ posting: true, 'auto-post': true, 'post-schedule': true });
    assert.notEqual((await raw(t.port, { url: '/ui/api/posts/auto/rules' })).status, 200);
    const s = await session(t.port);
    let j = (await raw(t.port, { url: '/ui/api/posts/auto/rules', headers: { cookie: s.cookie } })).json();
    assert.equal(j.autoPostOn, true);
    assert.ok(j.notices.includes(NOTICE_TEXT['no-rules']), 'shipped template: no rules');
    assert.ok(j.notices.includes(NOTICE_TEXT['not-signed-in']));
    writeFileSync(userRulesFile(t.dataDir), JSON.stringify(USER_RULES));
    const before = readFileSync(userRulesFile(t.dataDir), 'utf8');
    const edit = { autoUpload: true, maxUploadsPerDay: 5, rules: [{ id: 'long-reels', kinds: ['won-reel'], maxPerDay: 1 }] };
    assert.equal((await s.post(edit, { noCsrf: true })).status, 403);
    assert.equal((await s.post(edit, { badOrigin: true })).status, 403);
    const bad = await s.post({ ...edit, rules: [{ id: 'long-reels', kinds: ['nope'], maxPerDay: 1 }] });
    assert.equal(bad.status, 400); assert.equal(bad.json().error, 'invalid');
    assert.equal(readFileSync(userRulesFile(t.dataDir), 'utf8'), before);
    const ok = await s.post(edit);
    assert.equal(ok.status, 200);
    const now = JSON.parse(readFileSync(userRulesFile(t.dataDir), 'utf8'));
    assert.deepEqual(now.rules[1].kinds, ['won-reel']); assert.deepEqual(now.rules[0], USER_RULES.rules[0]); assert.equal(now.maxUploadsPerDay, 5);
    j = (await raw(t.port, { url: '/ui/api/posts/auto/rules', headers: { cookie: s.cookie } })).json();
    assert.equal(j.notices.includes(NOTICE_TEXT['no-rules']), false);
  });

  test('with auto-post off there is no notice', async () => {
    const t = await boot({ posting: true });
    const s = await session(t.port);
    const j = (await raw(t.port, { url: '/ui/api/posts/auto/rules', headers: { cookie: s.cookie } })).json();
    assert.deepEqual(j.notices, []);
  });
});

describe('Settings > Posting & growth QML', () => {
  const QT = qtDir();
  const gen = QT ? path.join(QT, 'bin', 'qmlcachegen.exe') : null;
  test('SettingsPosting.qml compiles (qmlcachegen, bytecode)', { skip: gen && existsSync(gen) ? false : 'Qt not found' }, () => {
    const out = path.join(mk(), 'SettingsPosting.qmlc');
    const qml = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'studio', 'qml', 'SettingsPosting.qml');
    const r = spawnSync(gen, ['--only-bytecode', '-o', out, qml], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(existsSync(out));
  });
});
describe('Codex round 3', () => {
  test('a custom time missing on the spring-forward day is skipped; the repeated autumn time is its first occurrence', () => {
    const cfg = { customTimes: { sun: ['00:30', '01:30', '02:30'] }, skipDates: [], timeZone: 'Europe/London' };
    assert.deepEqual(customDayTimes('2027-03-28', cfg).map(iso), ['2027-03-28T00:30:00.000Z', '2027-03-28T01:30:00.000Z']); // 01:30 does not exist; 02:30 BST
    assert.deepEqual(customDayTimes('2026-10-25', cfg).map(iso), ['2026-10-24T23:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00.000Z']);
  });

  test('an impossible day off is a problem (400), never a thrown RangeError', async () => {
    assert.equal(checkUserSchedule({ skipDates: ['2026-13-45'] }).problems[0].key, 'skipDates');
    const d = mk();
    const card = { autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 6, placement: 'fill-gaps', skipDates: ['2026-13-45'] };
    const r = saveAutoPostSettings(d, { card, keepRules: true });
    assert.equal(r.ok, false); assert.equal(r.problems[0].key, 'skipDates');
  });

  test('a rules file that cannot be read is never replaced by the card; Reset replaces it', () => {
    const d = mk();
    writeFileSync(userRulesFile(d), '{ broken');
    const card = { autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 6, placement: 'fill-gaps' };
    const r = saveAutoPostSettings(d, { card });
    assert.equal(r.ok, false); assert.match(r.problems[0].text, /^Your rules file has a problem: .*; fix it or reset it$/);
    assert.equal(readFileSync(userRulesFile(d), 'utf8'), '{ broken');
    assert.equal(saveAutoPostSettings(d, { card, keepRules: true }).ok, true);
    assert.equal(readFileSync(userRulesFile(d), 'utf8'), '{ broken');
    assert.equal(saveAutoPostSettings(d, { card, resetRules: true }).ok, true);
    assert.equal(JSON.parse(readFileSync(userRulesFile(d), 'utf8')).rules.length, 2);
  });
});