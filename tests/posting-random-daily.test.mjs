// SPDX-License-Identifier: GPL-3.0-or-later
// D403 random-daily placement: a 198-clip backlog spread over local days, 3-6 a day at random times inside 09:00-23:00,
// at least 90 minutes apart (also from channel posts), seeded and stable, with a DST day. Pure slot math; no network.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_SCHEDULE, checkUserSchedule, dayCandidates, dayCount, dayWindow, loadScheduleConfig, localDayKey, planQueueSlots, userScheduleFile, zonedParts, zonedToUtc,
} from '../services/posting/schedule.mjs';
import { ensureScheduleSeed } from '../services/posting/schedule-seed.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-rd-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });

const TZ = 'Europe/London'; // a zone with DST (29 Mar and 25 Oct 2026); fixed so the test does not depend on this PC
const base = (over = {}) => ({ ...loadScheduleConfig(DEFAULT_SCHEDULE), timeZone: TZ, seed: 20261119, ...over });
const NOW = Date.parse('2026-11-20T08:00:00Z');
const queued = (n) => Array.from({ length: n }, (_, k) => ({ id: `c${k}`, state: 'queued', publishAt: null, session: null }));
const MIN = 60 * 1000;

function checkPlan(plan, cfg, { nowMs, channel = [] } = {}) {
  const times = plan.map((p) => p.at);
  assert.ok(times.every((t) => t !== null), 'every clip gets a slot inside 60 days');
  const sorted = [...times].sort((a, b) => a - b);
  for (let k = 1; k < sorted.length; k++) assert.ok(sorted[k] - sorted[k - 1] >= cfg.minGapMinutes * MIN, `gap ${k}`);
  for (const t of times) for (const c of channel) assert.ok(Math.abs(t - c) >= cfg.minGapMinutes * MIN, 'gap from channel posts');
  const perDay = new Map();
  for (const t of times) {
    const key = localDayKey(t, cfg.timeZone);
    const w = dayWindow(key, cfg);
    assert.ok(t >= w.start && t <= w.end, `inside the window on ${key}`);
    const p = zonedParts(t, cfg.timeZone);
    assert.ok(p.h * 60 + p.min >= 9 * 60 && p.h * 60 + p.min <= 23 * 60, `local wall time ${p.h}:${p.min}`);
    assert.equal(new Date(t).getUTCSeconds(), 0); assert.equal(t % MIN, 0);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  // In time order the queue order is kept (the first clip in the queue gets the earliest slot).
  assert.deepEqual(times, sorted);
  assert.ok(times[0] >= nowMs + cfg.minLeadHours * 3600e3, 'lead time');
  return perDay;
}

describe('random-daily placement (D403)', () => {
  test('shipped defaults: random-daily, 3-6 a day, 09:00-23:00, 90 min; gap and grid follow it', () => {
    const cfg = loadScheduleConfig(DEFAULT_SCHEDULE);
    assert.equal(cfg.placement, 'random-daily');
    assert.deepEqual([cfg.postsPerDayMin, cfg.postsPerDayMax, cfg.windowStart, cfg.windowEnd, cfg.minGapMinutes], [3, 6, '09:00', '23:00', 90]);
    assert.equal(cfg.intervalHours, 1.5); assert.equal(cfg.alignMinutes, 1);
  });

  test('198 clips: 3-6 per local day (every full day), inside the window, >= 90 min apart, stable with the same seed', () => {
    const cfg = base();
    const plan = planQueueSlots({ items: queued(198), nowMs: NOW, cfg });
    const perDay = checkPlan(plan, cfg, { nowMs: NOW });
    const days = [...perDay.keys()].sort();
    // The first day may be partly past the floor and the last day takes only what is left.
    for (const k of days.slice(1, -1)) { const n = perDay.get(k); assert.ok(n >= 3 && n <= 6, `${k}: ${n}`); assert.equal(n, dayCount(k, cfg)); }
    assert.ok(days.length >= 33 && days.length <= 67, `${days.length} days`);
    const again = planQueueSlots({ items: queued(198), nowMs: NOW, cfg });
    assert.deepEqual(again, plan, 'same seed, same plan');
    const other = planQueueSlots({ items: queued(198), nowMs: NOW, cfg: base({ seed: 7 }) });
    assert.notDeepEqual(other.map((p) => p.at), plan.map((p) => p.at), 'another seed, another plan');
  });

  test('a second pass keeps every given slot and gives new clips the next free picks', () => {
    const cfg = base();
    const first = planQueueSlots({ items: queued(40), nowMs: NOW, cfg });
    const items = queued(60).map((i, k) => (k < 40 ? { ...i, publishAt: new Date(first[k].at).toISOString() } : i));
    const later = NOW + 5 * MIN; // the first slot is still more than the lead time ahead
    const second = planQueueSlots({ items, nowMs: later, cfg });
    assert.deepEqual(second.map((p) => p.id), items.slice(40).map((i) => i.id), 'only the 20 new clips move');
    const all = [...first.map((p) => p.at), ...second.map((p) => p.at)].sort((a, b) => a - b);
    for (let k = 1; k < all.length; k++) assert.ok(all[k] - all[k - 1] >= 90 * MIN);
    // The same 60 clips planned in one pass give the same times (the day plan does not depend on the pass).
    const once = planQueueSlots({ items: queued(60), nowMs: NOW, cfg }).map((p) => p.at);
    assert.deepEqual(all, once);
  });

  test('channel posts: gap kept, and a day already holding posts gets fewer new ones', () => {
    const cfg = base();
    const key = localDayKey(NOW + 2 * 86400e3, TZ);
    const w = dayWindow(key, cfg);
    const channel = [w.start + 4 * 3600e3, w.start + 9 * 3600e3];
    const plan = planQueueSlots({ items: queued(60), channelTimes: channel, nowMs: NOW, cfg });
    const perDay = checkPlan(plan, cfg, { nowMs: NOW, channel });
    assert.equal(perDay.get(key), Math.max(0, dayCount(key, cfg) - 2));
  });

  test('a held slot outside the window, or over the day count, moves; one inside stays', () => {
    const cfg = base();
    const key = localDayKey(NOW + 2 * 86400e3, TZ);
    const w = dayWindow(key, cfg);
    const night = { id: 'n', state: 'queued', session: null, publishAt: new Date(w.start - 3 * 3600e3).toISOString() };
    const ok = { id: 'k', state: 'queued', session: null, publishAt: new Date(w.start + 60 * MIN).toISOString() };
    const hourly = Array.from({ length: 12 }, (_, k) => ({ id: `h${k}`, state: 'queued', session: null, publishAt: new Date(w.start + (3 + k) * 3600e3 / 2 * 2).toISOString() }));
    const plan = planQueueSlots({ items: [night, ok, ...hourly], nowMs: NOW, cfg });
    const moved = new Set(plan.map((p) => p.id));
    assert.ok(moved.has('n')); assert.ok(!moved.has('k'));
    // The day keeps its count at most: k plus the hourly ones that are >= 90 min apart, cut at the count.
    const kept = [ok, ...hourly].filter((i) => !moved.has(i.id));
    assert.ok(kept.length <= dayCount(key, cfg));
    const allTimes = [...kept.map((i) => Date.parse(i.publishAt)), ...plan.map((p) => p.at)].sort((a, b) => a - b);
    for (let k = 1; k < allTimes.length; k++) assert.ok(allTimes[k] - allTimes[k - 1] >= 90 * MIN);
  });

  test('DST: windows follow the wall clock on the change days (London 29 Mar and 25 Oct 2026)', () => {
    const cfg = base();
    for (const key of ['2026-03-29', '2026-10-25']) {
      const w = dayWindow(key, cfg);
      assert.deepEqual([zonedParts(w.start, TZ).h, zonedParts(w.start, TZ).min], [9, 0], key);
      assert.deepEqual([zonedParts(w.end, TZ).h, zonedParts(w.end, TZ).min], [23, 0], key);
      for (const c of dayCandidates(key, cfg)) assert.ok(c >= w.start && c <= w.end);
    }
    // 01:30 on 29 Mar does not exist in London: it moves forward to 02:30 BST (01:30 UTC).
    assert.equal(new Date(zonedToUtc(2026, 3, 29, 1, 30, TZ)).toISOString(), '2026-03-29T01:30:00.000Z');
    // A plan across the October change keeps every rule.
    const now = Date.parse('2026-10-20T08:00:00Z');
    const plan = planQueueSlots({ items: queued(40), nowMs: now, cfg });
    const perDay = checkPlan(plan, cfg, { nowMs: now });
    const n = perDay.get('2026-10-25'); assert.ok(n >= 3 && n <= 6, `DST day ${n}`);
  });

  test('a day that cannot fit its count takes what fits; a narrow window still keeps the gap', () => {
    const cfg = base({ windowStart: '20:00', windowEnd: '22:00', postsPerDayMin: 5, postsPerDayMax: 5 });
    const plan = planQueueSlots({ items: queued(6), nowMs: NOW, cfg });
    const perDay = checkPlan(plan, cfg, { nowMs: NOW });
    for (const n of perDay.values()) assert.ok(n <= 2);
  });

  test('user settings: checked, and saved values replace the shipped ones; the seed is made once', () => {
    assert.ok(checkUserSchedule({ windowStart: '9am' }).problems.length);
    assert.ok(checkUserSchedule({ windowStart: '23:00', windowEnd: '09:00' }).problems.length);
    assert.ok(checkUserSchedule({ postsPerDayMin: 6, postsPerDayMax: 3 }).problems.length);
    assert.ok(checkUserSchedule({ minGapMinutes: 5 }).problems.length);
    const dir = mk();
    mkdirSync(path.join(dir, 'posting'), { recursive: true });
    writeFileSync(userScheduleFile(dir), JSON.stringify({ intervalHours: 2, postsPerDayMax: 4, windowEnd: '22:30' }));
    const s1 = ensureScheduleSeed(dir, { make: () => 42 });
    assert.equal(s1, 42);
    assert.equal(ensureScheduleSeed(dir, { make: () => 99 }), 42, 'kept');
    const saved = JSON.parse(readFileSync(userScheduleFile(dir), 'utf8'));
    assert.equal(saved.intervalHours, 2); assert.equal(saved.seed, 42);
    const cfg = loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: userScheduleFile(dir) });
    assert.deepEqual([cfg.postsPerDayMax, cfg.windowEnd, cfg.seed, cfg.placement], [4, '22:30', 42, 'random-daily']);
    // An existing file without a placement gets random-daily; one with fill-gaps keeps it.
    writeFileSync(userScheduleFile(dir), JSON.stringify({ placement: 'fill-gaps', intervalHours: 2 }));
    const fg = loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: userScheduleFile(dir) });
    assert.equal(fg.placement, 'fill-gaps'); assert.equal(fg.intervalHours, 2); assert.equal(fg.alignMinutes, 60);
  });
});
