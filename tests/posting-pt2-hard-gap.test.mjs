// SPDX-License-Identifier: GPL-3.0-or-later
// PT2 (D408, user 2026-11-21): the one hard rule (no slot within 60 min of any other scheduled time), open limits (24 a
// day, the whole day as the window, gap 60..1440), the upload-bucket quota model with its quotaExceeded fallback.
// Pure slot math and local files in temp folders; no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_SCHEDULE, HARD_GAP_MINUTES, USER_LIMITS, checkUserSchedule, dayWindow, loadScheduleConfig, localDayKey, planQueueSlots, slotClash, userScheduleFile,
} from '../services/posting/schedule.mjs';
import { MAX_PER_DAY, validateRules } from '../services/posting/auto-post.mjs';
import { checkCard } from '../services/posting/auto-settings.mjs';
import { QUOTA_MODEL_NAME, loadQuota, quotaFallback, recordQuotaExceeded } from '../services/posting/quota-budget.mjs';
import { quotaReason } from '../services/posting/youtube.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-pt2-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const MIN = 60 * 1000; const HOUR = 60 * MIN;
const TZ = 'Europe/London';
const NOW = Date.parse('2026-11-21T06:00:00Z');
const queued = (n) => Array.from({ length: n }, (_, k) => ({ id: `c${k}`, state: 'queued', publishAt: null, session: null }));
const cfgWith = (user) => { const d = mk(); const f = userScheduleFile(d); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(user)); return { ...loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: f }), timeZone: TZ }; };
const minDist = (ts, others) => Math.min(...ts.flatMap((t) => others.map((o) => Math.abs(t - o))));

describe('PT2 the one hard rule', () => {
  test('the floor is 60 minutes and it is the shipped default', () => {
    assert.equal(HARD_GAP_MINUTES, 60);
    assert.equal(USER_LIMITS.minGapMinutes.min, 60); assert.equal(USER_LIMITS.minGapMinutes.max, 1440);
    assert.equal(loadScheduleConfig(DEFAULT_SCHEDULE).minGapMinutes, 60);
    // The card's Save refuses a narrower gap; a file saved before PT2 (floor 15) reads as 60, never stops posting.
    assert.ok(checkCard({ autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 3, minGapMinutes: 30 }).problems.some((p) => p.key === 'minGapMinutes'));
    assert.equal(checkUserSchedule({ minGapMinutes: 30 }).values.minGapMinutes, 60);
    assert.equal(cfgWith({ minGapMinutes: 30 }).minGapMinutes, 60);
    // fill-gaps: intervalHours below 1 h is refused in the data file.
    const d = mk(); const f = path.join(d, 's.json');
    const raw = { ...loadScheduleConfig(DEFAULT_SCHEDULE), intervalHours: 0.5 };
    writeFileSync(f, JSON.stringify(raw));
    assert.throws(() => loadScheduleConfig(f), { code: 'schedule-config-bad' });
  });

  test('a channel with hand-scheduled videos: no new slot within 60 min of any of them or of each other (every placement)', () => {
    const day = localDayKey(NOW + 86400e3, TZ);
    const w = dayWindow(day, { windowStart: '00:00', windowEnd: '24:00', timeZone: TZ });
    // Hand-scheduled posts at odd minutes over two days.
    const channel = [w.start + 7 * HOUR + 13 * MIN, w.start + 9 * HOUR + 50 * MIN, w.start + 18 * HOUR, w.start + 30 * HOUR + 5 * MIN];
    for (const user of [
      { placement: 'random-daily', postsPerDayMin: 24, postsPerDayMax: 24, windowStart: '00:00', windowEnd: '24:00', minGapMinutes: 60 },
      { placement: 'fill-gaps', intervalHours: 1 },
      { placement: 'after-last', intervalHours: 1 },
      { placement: 'custom', customTimes: { mon: ['07:30', '08:00', '10:00'], tue: ['07:30', '08:00', '10:00'], wed: ['07:30'], thu: ['07:30'], fri: ['07:30'], sat: ['07:30', '08:10', '09:20', '18:30'], sun: ['07:30', '08:10', '09:20', '18:30'] } },
    ]) {
      const cfg = cfgWith(user);
      const plan = planQueueSlots({ items: queued(60), channelTimes: channel, nowMs: NOW, cfg });
      const ts = plan.map((p) => p.at).filter((t) => t !== null);
      assert.ok(ts.length > 0, user.placement);
      assert.ok(minDist(ts, channel) >= 60 * MIN, `${user.placement}: gap from the channel`);
      const s = [...ts].sort((a, b) => a - b);
      for (let k = 1; k < s.length; k++) assert.ok(s[k] - s[k - 1] >= 60 * MIN, `${user.placement}: gap between new slots`);
    }
  });

  test('24 a day is possible: the whole day as the window, 60 min apart', () => {
    const cfg = cfgWith({ placement: 'random-daily', postsPerDayMin: 24, postsPerDayMax: 24, windowStart: '00:00', windowEnd: '24:00', minGapMinutes: 60 });
    const plan = planQueueSlots({ items: queued(24 * 4), nowMs: NOW, cfg });
    const per = new Map();
    for (const p of plan) { if (p.at === null) continue; const k = localDayKey(p.at, TZ); per.set(k, (per.get(k) ?? 0) + 1); }
    const full = [...per.values()].slice(1, -1); // the first day is partly past the floor
    assert.ok(full.length >= 2); for (const n of full) assert.equal(n, 24);
    assert.equal(checkUserSchedule({ windowStart: '00:00', windowEnd: '24:00' }).problems.length, 0);
    assert.ok(checkUserSchedule({ windowStart: '00:00', windowEnd: '24:30' }).problems.length);
  });

  test('slotClash: the check right before an upload session starts', () => {
    const cfg = cfgWith({ minGapMinutes: 60 });
    const t = Date.parse('2026-11-22T12:00:00Z');
    const item = { id: 'a', state: 'queued', publishAt: new Date(t).toISOString() };
    assert.equal(slotClash({ item, items: [item], channelTimes: [t + 61 * MIN, t - 60 * MIN], cfg }), null);
    assert.equal(slotClash({ item, items: [item], channelTimes: [t + 59 * MIN], cfg }), t + 59 * MIN);
    const other = { id: 'b', state: 'done', sentPublishAt: new Date(t - 30 * MIN).toISOString() };
    assert.equal(slotClash({ item, items: [item, other], channelTimes: [], cfg }), t - 30 * MIN);
  });
});

describe('PT2 posts a day up to 24 everywhere', () => {
  test('rules: 1..24; a value from before PT2 (25..100) reads as 24', () => {
    assert.equal(MAX_PER_DAY, 24);
    const r = validateRules({ maxUploadsPerDay: 60, rules: [{ id: 'a', target: 'youtube-shorts', minScore: 0, maxPerDay: 100 }] });
    assert.equal(r.maxUploadsPerDay, 24); assert.equal(r.rules[0].maxPerDay, 24);
    assert.equal(validateRules({ rules: [{ id: 'a', target: 'youtube-shorts', minScore: 0, maxPerDay: 24 }] }).rules[0].maxPerDay, 24);
    assert.throws(() => validateRules({ rules: [{ id: 'a', target: 'youtube-shorts', minScore: 0, maxPerDay: 101 }] }), { code: 'bad-rules' });
    assert.ok(checkCard({ autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 25 }).problems.some((p) => p.key === 'maxPerDay'));
    assert.equal(checkCard({ autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 24, postsPerDayMax: 24, postsPerDayMin: 1 }).problems.length, 0);
  });
});

describe('PT2 quota: the upload bucket by default, the unit sum after quotaExceeded', () => {
  test('bucket by default: 24 a day fit (gap), covers cost 50 units each; the line says which model', () => {
    const d = mk();
    const q = loadQuota(d, undefined, { nowMs: NOW });
    assert.deepEqual([q.model, q.uploadsPerDayFit, q.uploadsCap, q.perUploadUnits], ['upload-bucket', 24, 100, 50]);
    assert.match(q.modelText, /up to 100 a day/);
    assert.equal(quotaFallback(d, NOW), null);
  });

  test('quotaExceeded: the unit sum for today and the next Pacific day, then the bucket again', () => {
    const d = mk();
    const s = recordQuotaExceeded(d, NOW);
    assert.equal(s.model, 'unit-sum');
    const q = loadQuota(d, undefined, { nowMs: NOW });
    assert.deepEqual([q.model, q.uploadsPerDayFit, q.uploadsCap], ['unit-sum', 6, null]);
    assert.match(q.modelText, /used up/);
    assert.equal(loadQuota(d, undefined, { nowMs: NOW + 24 * HOUR }).model, 'unit-sum', 'the next day still counts the old way');
    assert.equal(loadQuota(d, undefined, { nowMs: NOW + 48 * HOUR }).model, 'upload-bucket', 'then the bucket is tried again');
    // A broken state file is no fallback (the bucket stays; YouTube's next answer decides).
    writeFileSync(path.join(d, 'posting', QUOTA_MODEL_NAME), '{ broken');
    assert.equal(loadQuota(d, undefined, { nowMs: NOW }).model, 'upload-bucket');
  });

  test('youtube.mjs reads the quota reason from the error answer', async () => {
    const res = (body) => ({ text: async () => JSON.stringify(body) });
    assert.equal(await quotaReason(res({ error: { errors: [{ reason: 'quotaExceeded' }] } })), true);
    assert.equal(await quotaReason(res({ error: { errors: [{ reason: 'uploadLimitExceeded' }] } })), true);
    assert.equal(await quotaReason(res({ error: { errors: [{ reason: 'insufficientPermissions' }] } })), false);
    assert.equal(await quotaReason({}), false);
  });
});
