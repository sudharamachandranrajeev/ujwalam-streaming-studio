// SPDX-License-Identifier: GPL-3.0-or-later
// D434 grid-tiers placement (user 2026-11-22: "upload up to 100 each day ... starting today at 12:00, 13:00, 14:00 ... If
// those slots get filled, use the quarter slot next (12:15, 13:15 ...), then ... the half mark"), the 100-a-day quota fit
// with channel read reuse, and the settings checks. Pure slot math plus the settings files in a temp dir; no network.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_SCHEDULE, checkUserSchedule, gridCandidates, gridProblem, loadScheduleConfig, planQueueSlots, slotClash, userScheduleFile, zonedParts,
} from '../services/posting/schedule.mjs';
import { reusableRead } from '../services/posting/auto-chain.mjs';
import { loadQuota, uploadsFit } from '../services/posting/quota-budget.mjs';
import { checkCard } from '../services/posting/auto-settings.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-grid-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const MIN = 60 * 1000; const HOUR = 60 * MIN; const DAY = 24 * HOUR;
const queued = (n, p = 'c') => Array.from({ length: n }, (_, k) => ({ id: `${p}${k}`, state: 'queued', publishAt: null, session: null }));
// The shipped settings with a fixed zone so the test does not depend on this PC (the planner reads cfg.timeZone).
const base = (over = {}) => ({ ...loadScheduleConfig(DEFAULT_SCHEDULE), timeZone: 'Asia/Kolkata', ...over });
const local = (t, tz) => { const p = zonedParts(t, tz); return { h: p.h, min: p.min }; };

describe('grid-tiers placement (D434)', () => {
  test('shipped: grid-tiers, offsets 0/15/30/45, 15-minute gap, 365 days ahead, read reuse 120 minutes', () => {
    const c = loadScheduleConfig(DEFAULT_SCHEDULE);
    assert.deepEqual([c.placement, c.tierOffsets, c.gridGapMinutes, c.maxAheadDays, c.readReuseMinutes, c.alignMinutes, c.intervalHours],
      ['grid-tiers', [0, 15, 30, 45], 15, 365, 120, 1, 0.25]);
  });

  test('tier 0 is filled across the WHOLE window before tier 1 opens; local wall clock (a half-hour zone)', () => {
    const tz = 'Asia/Kolkata'; // UTC+05:30: local 12:00 is not on a UTC whole hour
    const cfg = base({ timeZone: tz, maxAheadDays: 2 });
    const now = Date.parse('2026-11-22T05:00:00Z'); // 10:30 local; floor = 11:45 local
    const plan = planQueueSlots({ items: queued(60), nowMs: now, cfg });
    const at = plan.map((p) => p.at);
    assert.ok(at.every((t) => t !== null));
    assert.deepEqual(local(at[0], tz), { h: 12, min: 0 }, 'first: today 12:00 local');
    assert.deepEqual(local(at[1], tz), { h: 13, min: 0 });
    const tier0 = gridCandidates(now + HOUR + 15 * MIN, now + 2 * DAY, 0, cfg).length;
    assert.equal(tier0, 47, 'hourly :00 slots from 12:00 today to 10:00 two days on');
    for (let k = 0; k < tier0; k++) assert.equal(local(at[k], tz).min, 0, `slot ${k} on :00`);
    for (let k = tier0; k < 60; k++) assert.equal(local(at[k], tz).min, 15, `slot ${k} on :15`);
    assert.deepEqual(local(at[tier0], tz), { h: 12, min: 15 }, 'the first :15 slot is the earliest one in the window');
    for (let k = 1; k < tier0; k++) assert.ok(at[k] > at[k - 1], 'earliest first in a tier');
  });

  test('DST: every candidate is on the local hour at the offset, the spring day has 23, the autumn day 24 (first of the repeated hour)', () => {
    const tz = 'Europe/London';
    const cfg = base({ timeZone: tz });
    const spring = gridCandidates(Date.parse('2026-03-29T00:00:00Z'), Date.parse('2026-03-29T22:59:00Z'), 0, cfg);
    assert.equal(spring.length, 23, '01:00 does not exist on 29 Mar');
    for (const t of spring) assert.equal(local(t, tz).min, 0);
    const autumn = gridCandidates(Date.parse('2026-10-24T23:00:00Z'), Date.parse('2026-10-25T23:59:00Z'), 15, cfg);
    assert.equal(autumn.length, 24, 'the repeated 01:15 is used once');
    for (let k = 1; k < autumn.length; k++) assert.ok(autumn[k] > autumn[k - 1]);
    for (const t of autumn) assert.equal(local(t, tz).min, 15);
    const plan = planQueueSlots({ items: queued(3), nowMs: Date.parse('2026-03-28T22:30:00Z'), cfg });
    assert.deepEqual(plan.map((p) => local(p.at, tz)), [{ h: 0, min: 0 }, { h: 2, min: 0 }, { h: 3, min: 0 }], 'skips the missing 01:00');
  });

  test('the window rolls with the current time (never a fixed date)', () => {
    const cfg = base({ maxAheadDays: 365 });
    const a = Date.parse('2026-11-22T05:00:00Z'); const b = a + 200 * DAY;
    const pa = planQueueSlots({ items: queued(1), nowMs: a, cfg })[0].at;
    const pb = planQueueSlots({ items: queued(1), nowMs: b, cfg })[0].at;
    assert.ok(pa >= a + HOUR + 15 * MIN && pa < a + 3 * HOUR);
    assert.ok(pb >= b + HOUR + 15 * MIN && pb < b + 3 * HOUR, 'later today = a floor from that day');
    // The cap: a full tier list in a 1-day window, then one more clip waits (null).
    const small = base({ maxAheadDays: 1, tierOffsets: [0] , gridGapMinutes: 15 });
    const plan = planQueueSlots({ items: queued(30), nowMs: a, cfg: small });
    const given = plan.filter((p) => p.at !== null);
    assert.ok(given.length >= 22 && given.length <= 24); assert.ok(plan.some((p) => p.at === null), 'beyond the window: waits');
    assert.ok(given.every((p) => p.at <= a + DAY));
  });

  test('gap rule: no slot within gridGapMinutes of any taken time, also off-grid ones; queue times count', () => {
    const tz = 'Asia/Kolkata';
    const cfg = base({ timeZone: tz, maxAheadDays: 1 });
    const now = Date.parse('2026-11-22T05:00:00Z');
    const noon = gridCandidates(now, now + DAY, 0, cfg)[1]; // 12:00 local
    // a channel post at 12:05 (off-grid) blocks 12:00 (5 min); 12:20 (off-grid) is far enough from 13:00
    const ch = [noon + 5 * MIN, noon + HOUR + 50 * MIN]; // 12:05 and 13:50: 13:00 ok (50 min), 14:00 blocked (10 min)
    const held = [{ id: 'h', state: 'done', sentPublishAt: new Date(noon + 3 * HOUR).toISOString() }]; // 15:00 uploaded
    const plan = planQueueSlots({ items: [...held, ...queued(3)], channelTimes: ch, nowMs: now, cfg });
    assert.deepEqual(plan.map((p) => local(p.at, tz)), [{ h: 13, min: 0 }, { h: 16, min: 0 }, { h: 17, min: 0 }]);
    for (const p of plan) for (const t of [...ch, noon + 3 * HOUR]) assert.ok(Math.abs(p.at - t) >= 15 * MIN);
    // slotClash uses the grid gap (15), not the 60-minute floor of the other placements
    const item = { id: 'x', state: 'queued', publishAt: new Date(noon).toISOString() };
    assert.equal(slotClash({ item, items: [item], channelTimes: [noon + 15 * MIN], cfg }), null);
    assert.equal(slotClash({ item, items: [item], channelTimes: [noon + 14 * MIN], cfg }), noon + 14 * MIN);
  });

  test('a held slot stays while free; one a new channel post now clashes with moves', () => {
    const cfg = base({ maxAheadDays: 2 });
    const now = Date.parse('2026-11-22T05:00:00Z');
    const t = gridCandidates(now, now + DAY, 0, cfg)[3];
    const items = [{ id: 'k', state: 'queued', publishAt: new Date(t).toISOString(), session: null }];
    assert.deepEqual(planQueueSlots({ items, nowMs: now, cfg }), []);
    const moved = planQueueSlots({ items, channelTimes: [t + 10 * MIN], nowMs: now, cfg });
    assert.equal(moved[0].reval, true); assert.ok(Math.abs(moved[0].at - (t + 10 * MIN)) >= 15 * MIN);
  });

  test('performance: a 365-day window with 5000 taken times places 300 clips fast (and a 3000-clip backlog too)', () => {
    const cfg = base({ maxAheadDays: 365 });
    const now = Date.parse('2026-11-22T05:00:00Z');
    // 5000 taken times: the first ~120 days of :00 slots fully taken plus random off-grid posts
    const taken = [];
    const c0 = gridCandidates(now, now + 365 * DAY, 0, cfg);
    for (let k = 0; k < 3000; k++) taken.push(c0[k]);
    let s = 7; const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let k = 0; k < 2000; k++) taken.push(now + Math.floor(r() * 365 * DAY / MIN) * MIN);
    let t0 = performance.now();
    const plan = planQueueSlots({ items: queued(300), channelTimes: taken, nowMs: now, cfg });
    const ms300 = performance.now() - t0;
    assert.ok(plan.every((p) => p.at !== null));
    const sorted = [...taken].sort((a, b) => a - b);
    for (const p of plan) {
      let lo = 0; let hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < p.at - 15 * MIN + 1) lo = m + 1; else hi = m; }
      assert.ok(lo >= sorted.length || sorted[lo] >= p.at + 15 * MIN, 'never within the gap of a taken time');
    }
    assert.ok(ms300 < 2000, `300 clips took ${Math.round(ms300)} ms`);
    t0 = performance.now();
    const big = planQueueSlots({ items: queued(3000, 'b'), channelTimes: taken, nowMs: now, cfg });
    const msBig = performance.now() - t0;
    assert.equal(new Set(big.map((p) => p.at)).size, 3000);
    assert.ok(msBig < 5000, `3000 clips took ${Math.round(msBig)} ms`);
  });
});

describe('grid-tiers settings (D434)', () => {
  test('gridProblem: unique whole minutes 0..59; the gap no wider than the smallest distance (round the hour too)', () => {
    assert.equal(gridProblem([0, 15, 30, 45], 15), null);
    assert.equal(gridProblem([0], 60), null, 'one minute: 60 min apart');
    assert.match(gridProblem([0, 15, 30, 45], 16), /wider than the smallest distance/);
    assert.match(gridProblem([0, 50], 15), /wider/, '50 and the next hour 0 are 10 min apart');
    assert.match(gridProblem([0, 0], 1), /twice/);
    assert.match(gridProblem([60], 1), /0 to 59/); assert.match(gridProblem([], 1), /0 to 59/); assert.match(gridProblem([1.5], 1), /0 to 59/);
    assert.match(gridProblem([0], 0), /1 to 60/);
  });
  test('checkUserSchedule and the card: offsets kept in the given order, bad values named; loadScheduleConfig refuses a bad mix', () => {
    assert.deepEqual(checkUserSchedule({ tierOffsets: [30, 0], gridGapMinutes: 30, readReuseMinutes: 0 }), { values: { gridGapMinutes: 30, readReuseMinutes: 0, tierOffsets: [30, 0] }, problems: [] });
    assert.deepEqual(checkUserSchedule({ tierOffsets: [0, 15], gridGapMinutes: 20 }).problems.map((p) => p.key), ['gridGapMinutes']);
    assert.deepEqual(checkUserSchedule({ gridGapMinutes: 0, readReuseMinutes: 1441 }).problems.map((p) => p.key), ['gridGapMinutes', 'readReuseMinutes']);
    assert.deepEqual(checkCard({ autoUpload: true, kinds: ['short'], minScore: 0, maxPerDay: 100, placement: 'grid-tiers', tierOffsets: [0, 30], gridGapMinutes: 30, readReuseMinutes: 60 }).problems, []);
    const d = mk(); const u = userScheduleFile(d); mkdirSync(path.dirname(u), { recursive: true });
    // the user's offsets with the shipped 15-min gap: [0, 10] is 10 min apart, refused at load (fail closed)
    writeFileSync(u, JSON.stringify({ tierOffsets: [0, 10] }));
    assert.throws(() => loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: u }), (e) => e.code === 'schedule-config-bad');
    writeFileSync(u, JSON.stringify({ tierOffsets: [0, 10], gridGapMinutes: 10, readReuseMinutes: 30 }));
    const c = loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: u });
    assert.deepEqual([c.tierOffsets, c.gridGapMinutes, c.readReuseMinutes, c.intervalHours * 60], [[0, 10], 10, 30, 10]);
    // An older user file (before D434) without the new keys still loads, with the shipped values.
    writeFileSync(u, JSON.stringify({ placement: 'random-daily', intervalHours: 2, maxAheadDays: 60, quotaUnitsPerDay: 10000 }));
    const old = loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: u });
    assert.deepEqual([old.placement, old.tierOffsets, old.readReuseMinutes, old.intervalHours], ['random-daily', [0, 15, 30, 45], 120, 1]);
  });
});

describe('100 a day: quota fit and channel read reuse (D434)', () => {
  test('uploadsFit: reads per reuse period, never more than uploads; 0 minutes = one read per upload (D409)', () => {
    const f = (readsPerDayMax, perUpload = 50) => uploadsFit({ quota: 10000, reserve: 100, perUpload, readUnits: 401, readsPerDayMax, cap: 100 });
    assert.equal(f(null), 21, '0 minutes: (10000 - 100) / (50 + 401)');
    assert.equal(f(24), 21, '60 minutes: 24 reads possible, 21 uploads fit first');
    assert.equal(f(12), 100, '120 minutes: 100 x 50 + 12 x 401 = 9812');
    assert.equal(f(12, 1650), 4, 'the old unit sum');
    assert.equal(uploadsFit({ quota: 1000, reserve: 100, perUpload: 50, readUnits: 401, readsPerDayMax: 1, cap: 100 }), 9);
    assert.equal(uploadsFit({ quota: 400, reserve: 100, perUpload: 50, readUnits: 401, readsPerDayMax: 1, cap: 100 }), 0);
  });
  test('loadQuota: the user\'s reuse minutes change the fit (the card does the same sum)', () => {
    const d = mk(); const u = userScheduleFile(d); mkdirSync(path.dirname(u), { recursive: true });
    assert.equal(loadQuota(d).uploadsPerDayFit, 100);
    writeFileSync(u, JSON.stringify({ readReuseMinutes: 0 }));
    const q = loadQuota(d);
    assert.deepEqual([q.uploadsPerDayFit, q.readsPerDayMax, q.readUnitsPerRead, q.maxPerDay], [21, null, 401, 100]);
  });
  test('reusableRead: only a complete read younger than readReuseMinutes; never a truncated, future-dated or broken one', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    const s = (over = {}) => ({ channelLast: '2026-11-23T10:00:00.000Z', channelTimes: ['2026-11-23T10:00:00.000Z'], recentTimes: ['2026-11-22T09:00:00.000Z'], truncated: false, readAt: new Date(now - 30 * MIN).toISOString(), ...over });
    const cfg = { readReuseMinutes: 60 };
    assert.deepEqual(reusableRead(s(), now, cfg), { times: [Date.parse('2026-11-23T10:00:00Z')], recent: [Date.parse('2026-11-22T09:00:00Z')], last: Date.parse('2026-11-23T10:00:00Z') });
    assert.equal(reusableRead(s({ readAt: new Date(now - 60 * MIN).toISOString() }), now, cfg), null, 'as old as the reuse time: read again');
    assert.equal(reusableRead(s({ truncated: true }), now, cfg), null, 'truncated: never');
    assert.equal(reusableRead(s({ truncated: undefined }), now, cfg), null, 'unknown: never');
    assert.equal(reusableRead(s({ readAt: new Date(now + 10 * MIN).toISOString() }), now, cfg), null, 'future: never');
    assert.equal(reusableRead(s({ channelTimes: ['nope'] }), now, cfg), null);
    assert.equal(reusableRead(s(), now, { readReuseMinutes: 0 }), null, '0 = always read');
    assert.equal(reusableRead(null, now, cfg), null);
  });
});
