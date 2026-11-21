// SPDX-License-Identifier: GPL-3.0-or-later
// PT4 (D410) growth-led timing, suggestions only (plan docs/plan/2026-11-21-posting-text-schedule-growth.md PT4). Reads the
// AN1 numbers Ujwalam already stores (services/analytics/index.mjs view(): per video the 24 h and 7 d checkpoints with
// views, averageViewPercentage and subscribersGained). No new API scope and no request to Google here.
//   loadTimingConfig(file?)                         -> cfg (data/posting/growth-timing.json)
//   analyseTiming({ videos, cfg, schedule, tz })    -> { count, enough, byBand, byWeekday, byKind, suggestion, reason }  pure
//   refreshSuggestion({ dataDir, analysis, now })   -> the record shown in the Posts window (or null)
//   applySuggestion / dismissSuggestion / undoSuggestion (dataDir, id, { now }) -> { ok, record } | { ok: false, code, text }
// Nothing changes the schedule except applySuggestion, which only runs on the user's click (the Posts window's Apply).
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { betaDraw, seededRng } from '../learning/mix.mjs';
import { HARD_GAP_MINUTES, WEEKDAYS, checkUserSchedule, hhmmMinutes, userScheduleFile, windowEndMinutes, zonedParts } from '../posting/schedule.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_TIMING = path.join(REPO, 'data', 'posting', 'growth-timing.json');
export const SUGGESTION_NAME = 'growth-suggestion.json';
export const GROWTH_LOG_NAME = 'growth-log.jsonl';
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const two = (n) => String(n).padStart(2, '0');
const hhmm = (m) => `${two(Math.floor(m / 60))}:${two(m % 60)}`;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

export function loadTimingConfig(file = DEFAULT_TIMING) {
  const j = readJson(file);
  const ok = isPlain(j) && Number.isInteger(j.minPosts) && j.minPosts >= 1 && Number.isInteger(j.minPerBand) && j.minPerBand >= 1
    && Number.isFinite(j.minLiftPct) && Number.isInteger(j.maxMove) && j.maxMove >= 1 && Number.isFinite(j.exploreShare) && j.exploreShare >= 0 && j.exploreShare <= 0.2
    && Array.isArray(j.bands) && j.bands.length >= 2 && j.bands.every((b) => Array.isArray(b) && b.length === 2 && Number.isInteger(b[0]) && Number.isInteger(b[1]) && b[0] >= 0 && b[1] <= 24 && b[0] < b[1]);
  if (!ok) throw new Error('growth-timing.json: bad settings (exploreShare must be at most 0.2, the plan\'s 1 in 5)');
  return j;
}

/** The posts with a usable 24 h number, with the local hour and weekday they went public. Pure. */
export function timingRows(videos, tz) {
  const out = [];
  for (const v of Array.isArray(videos) ? videos : []) {
    const t = typeof v?.publicAt === 'string' ? Date.parse(v.publicAt) : NaN;
    const views24h = num(v?.at24h?.views);
    if (!Number.isFinite(t) || views24h === null) continue;
    const p = zonedParts(t, tz);
    const wd = DAY_NAMES[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
    out.push({ videoId: v.videoId, kind: typeof v.kind === 'string' ? v.kind : 'short', hour: p.h, weekday: wd, views24h,
      views7d: num(v?.at7d?.views), avgViewedPct: num(v?.at24h?.avgViewedPct), subs: num(v?.at24h?.subs) });
  }
  return out;
}

const statsOf = (rows) => ({
  n: rows.length,
  views24h: round1(mean(rows.map((r) => r.views24h))),
  views7d: round1(mean(rows.map((r) => r.views7d).filter((x) => x !== null))),
  avgViewedPct: round1(mean(rows.map((r) => r.avgViewedPct).filter((x) => x !== null))),
  subs: round1(mean(rows.map((r) => r.subs).filter((x) => x !== null))),
});
const bandLabel = (b) => `${two(b[0])}:00-${two(b[1])}:00`;
const bandIndex = (hour, bands) => bands.findIndex((b) => hour >= b[0] && hour < b[1]);

function byBand(rows, bands) {
  return bands.map((b, i) => ({ band: b, label: bandLabel(b), ...statsOf(rows.filter((r) => bandIndex(r.hour, bands) === i)) }));
}

/** How many posts each weekday the current schedule makes (custom: that day's own times; else postsPerDayMax every day).
 *  A day with 0 stays 0 (Codex review: the busiest day is never copied onto the others). */
export function dayCounts(schedule) {
  if (schedule?.placement === 'custom' && isPlain(schedule.customTimes)) {
    return Object.fromEntries(WEEKDAYS.map((d) => [d, Math.min(24, Array.isArray(schedule.customTimes[d]) ? schedule.customTimes[d].length : 0)]));
  }
  const n = Math.max(1, Math.min(24, Number.isInteger(schedule?.postsPerDayMax) ? schedule.postsPerDayMax : 1));
  return Object.fromEntries(WEEKDAYS.map((d) => [d, n]));
}
/** The busiest weekday's count (at least 1). */
export const postsPerDay = (schedule) => Math.max(1, ...Object.values(dayCounts(schedule)));

/** The schedule in use, in plain words, for the Apply text. */
export function scheduleWords(schedule) {
  const p = schedule?.placement;
  if (p === 'random-daily') return `random ${schedule.postsPerDayMin ?? 1}-${schedule.postsPerDayMax ?? 1} a day`;
  if (p === 'custom') return 'custom times';
  if (p === 'fill-gaps') return 'posts that fill the gaps';
  if (p === 'after-last') return 'posts after the last scheduled one';
  return 'current schedule';
}

/** At most 1 in 5 slots explore (rounded down). Pure. */
export const exploreSlots = (n, share) => Math.floor(n * Math.min(share, 0.2) + 1e-9);

/** Minutes apart on the clock, across midnight too (23:30 and 00:10 are 40 min apart). */
const clockGap = (a, b) => { const d = Math.abs(a - b) % 1440; return Math.min(d, 1440 - d); };

/** Every post at least `gap` apart: inside each day, across midnight into the next weekday, and around a single day. */
export function weekGapOk(customTimes, gap) {
  for (let i = 0; i < WEEKDAYS.length; i += 1) {
    const a = (customTimes[WEEKDAYS[i]] ?? []).map(hhmmMinutes).sort((x, y) => x - y);
    for (let k = 1; k < a.length; k += 1) if (a[k] - a[k - 1] < gap) return false;
    const next = (customTimes[WEEKDAYS[(i + 1) % 7]] ?? []).map(hhmmMinutes).sort((x, y) => x - y);
    if (a.length && next.length && (1440 - a.at(-1)) + next[0] < gap) return false;
  }
  return true;
}

/**
 * The analysis and at most one proposed change. Pure (seeded). schedule: the schedule settings in use (scheduleConfigFor).
 * source: the user's schedule file text as read (null = none); its fingerprint is kept so a stale proposal is refused.
 * reason when no suggestion: 'few-posts' (fewer than minPosts with a 24 h number), 'no-clear-winner', 'no-room'.
 */
export function analyseTiming({ videos, cfg, schedule, tz, source = null }) {
  const rows = timingRows(videos, tz);
  const bands = cfg.bands;
  const out = { count: rows.length, minPosts: cfg.minPosts, enough: rows.length >= cfg.minPosts, byBand: byBand(rows, bands),
    byWeekday: DAY_NAMES.map((d) => ({ weekday: d, ...statsOf(rows.filter((r) => r.weekday === d)) })),
    byKind: Object.fromEntries([...new Set(rows.map((r) => r.kind))].sort().map((k) => [k, byBand(rows.filter((r) => r.kind === k), bands)])),
    suggestion: null, reason: null };
  if (!out.enough) { out.reason = 'few-posts'; return out; }
  const gap = Math.max(HARD_GAP_MINUTES, Number.isInteger(schedule?.minGapMinutes) ? schedule.minGapMinutes : HARD_GAP_MINUTES);
  const ws = hhmmMinutes(schedule?.windowStart ?? '00:00') ?? 0;
  const we = windowEndMinutes(schedule?.windowEnd ?? '24:00') ?? 1440;
  const inWin = (b) => Math.max(b[0] * 60, ws) < Math.min(b[1] * 60, we);
  const eligible = out.byBand.map((s, i) => ({ ...s, i })).filter((s) => s.n >= cfg.minPerBand && inWin(s.band));
  if (!eligible.length) { out.reason = 'no-clear-winner'; return out; }
  const best = eligible.reduce((a, b) => (b.views24h > a.views24h ? b : a));
  const rest = rows.filter((r) => bandIndex(r.hour, bands) !== best.i);
  const restMean = mean(rest.map((r) => r.views24h));
  if (!restMean || restMean <= 0) { out.reason = 'no-clear-winner'; return out; }
  const lift = Math.round((best.views24h / restMean - 1) * 100);
  if (lift < cfg.minLiftPct) { out.reason = 'no-clear-winner'; return out; }
  const ranked = [...eligible.filter((s) => s.i !== best.i).sort((a, b) => b.views24h - a.views24h), ...out.byBand.map((s, i) => ({ ...s, i })).filter((s) => inWin(s.band) && !eligible.some((e) => e.i === s.i))];
  const med = [...rows.map((r) => r.views24h)].sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 1;

  // One day with n posts: `move` in the best band, the other best-first bands next, `explore` in a band picked by Thompson
  // sampling. null when not every one of the n slots fits (the proposal is then refused, never cut short).
  function planDay(n) {
    const explore = exploreSlots(n, cfg.exploreShare);
    const exploit = n - explore;
    const chosen = [];
    const fits = (m) => m >= ws && m < we && chosen.every((c) => clockGap(c, m) >= gap);
    const place = (b) => { for (let m = Math.max(b[0] * 60, ws); m < Math.min(b[1] * 60, we); m += 30) if (fits(m)) { chosen.push(m); return m; } return null; };
    let move = 0;
    while (move < Math.min(cfg.maxMove, exploit) && place(best.band) !== null) move += 1;
    if (!move) return null;
    let left = exploit - move;
    for (const s of [best, ...ranked]) { while (left > 0 && place(s.band) !== null) left -= 1; if (!left) break; }
    if (left > 0) return null;
    const rng = seededRng((cfg.seed ?? 1) + n);
    const exploreTimes = [];
    for (let k = 0; k < explore; k += 1) {
      // each band's reward share r = views / (views + median) as RP5, Beta(1 + sum r, 1 + sum (1 - r)); outside the best band
      const cands = out.byBand.map((s, i) => ({ s, i })).filter(({ i, s }) => i !== best.i && inWin(s.band));
      const draws = cands.map((c) => {
        const rs = rows.filter((r) => bandIndex(r.hour, bands) === c.i).map((r) => r.views24h / (r.views24h + med));
        return { c, d: betaDraw(1 + rs.reduce((a, b) => a + b, 0), 1 + rs.reduce((a, b) => a + (1 - b), 0), rng) };
      }).sort((a, b) => b.d - a.d);
      let m = null;
      for (const { c } of draws) { m = place(c.s.band); if (m !== null) break; } // the drawn band first, then the next draws
      if (m === null) return null;
      exploreTimes.push(m);
    }
    if (chosen.length !== n || exploreTimes.length * 5 > chosen.length) return null; // the actual times, not the asked count
    return { times: [...chosen].sort((a, b) => a - b).map(hhmm), move, explore: exploreTimes.length, exploreTimes: exploreTimes.map(hhmm) };
  }

  const counts = dayCounts(schedule);
  const plans = new Map();
  for (const n of new Set(Object.values(counts))) {
    if (n === 0) continue;
    const p = planDay(n);
    if (!p) { out.reason = 'no-room'; return out; }
    plans.set(n, p);
  }
  const customTimes = Object.fromEntries(WEEKDAYS.map((d) => [d, counts[d] ? [...plans.get(counts[d]).times] : []]));
  const change = { placement: 'custom', customTimes };
  if (checkUserSchedule(change, { strict: true }).problems.length || !weekGapOk(customTimes, gap)) { out.reason = 'no-room'; return out; }
  const busiest = plans.get(Math.max(...plans.keys()));
  const fingerprint = hashStr(source === null ? '<none>' : String(source));
  out.suggestion = {
    id: `g-${hashStr(JSON.stringify(change) + fingerprint)}`,
    text: `Move ${busiest.move} of your daily posts to ${best.label}: +${lift} % 24 h views on ${best.n} posts.`,
    applyText: `Replaces your ${scheduleWords(schedule)} with fixed times ${busiest.times.join(', ')} (Undo keeps your old schedule).`,
    numbers: { band: best.label, bandPosts: best.n, bandViews24h: best.views24h, otherPosts: rest.length, otherViews24h: round1(restMean), liftPct: lift,
      bandViews7d: best.views7d, bandAvgViewedPct: best.avgViewedPct, bandSubs: best.subs, postsWithNumbers: rows.length },
    move: busiest.move, perDay: busiest.times.length, explore: busiest.explore, exploreTimes: busiest.exploreTimes, times: busiest.times,
    counts, sourceFingerprint: fingerprint, change,
  };
  return out;
}

export const scheduleFingerprint = (text) => hashStr(text === null ? '<none>' : String(text));

function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }

// ---------------------------------------------------------------- the record and its clicks

export const suggestionFile = (dataDir) => path.join(dataDir, 'posting', SUGGESTION_NAME);
const logFile = (dataDir) => path.join(dataDir, 'posting', GROWTH_LOG_NAME);
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
}
const saveRecord = (dataDir, r) => writeAtomic(suggestionFile(dataDir), `${JSON.stringify(r, null, 2)}\n`);
const log = (dataDir, entry) => { mkdirSync(path.dirname(logFile(dataDir)), { recursive: true }); appendFileSync(logFile(dataDir), `${JSON.stringify(entry)}\n`); };
export const readRecord = (dataDir) => { const j = readJson(suggestionFile(dataDir)); return isPlain(j) && typeof j.id === 'string' ? j : null; };
export function readGrowthLog(dataDir) {
  try { return readFileSync(logFile(dataDir), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

const readSchedule = (dataDir) => { const f = userScheduleFile(dataDir); return existsSync(f) ? readFileSync(f, 'utf8') : null; };

/**
 * An Apply cut short (Codex review): the record says `applying` (saved before the schedule was touched, with the whole
 * file as it was). If the schedule holds the applied text, the change went through: it becomes `applied` and Undo is
 * offered. If it still holds the old text, nothing changed: back to `open`. Anything else (changed since) stays
 * `applied-changed`: shown, and Undo refuses rather than overwrite. Returns the record, recovered or as it was.
 */
export function recoverApply(dataDir, { now = Date.now() } = {}) {
  const rec = readRecord(dataDir);
  if (rec?.status !== 'applying') return rec;
  const cur = readSchedule(dataDir);
  const at = new Date(now).toISOString();
  const next = cur === rec.appliedText ? { ...rec, status: 'applied', appliedAt: at, recovered: true }
    : cur === rec.before ? { ...rec, status: 'open', before: undefined, appliedText: undefined }
      : { ...rec, status: 'applied', appliedAt: at, recovered: true };
  saveRecord(dataDir, next);
  log(dataDir, { at, action: 'recover', id: rec.id, to: next.status });
  return next;
}

/** The record to show. An applied change stays (with Undo) until undone; a dismissed one is not offered again for
 *  dismissDays; a new analysis replaces an open record. Writes only the record file (never the schedule). */
export function refreshSuggestion({ dataDir, analysis, cfg, now = Date.now() }) {
  const cur = recoverApply(dataDir, { now });
  if (cur?.status === 'applied') return cur;
  const s = analysis?.suggestion ?? null;
  if (!s) return cur?.status === 'open' ? (saveRecord(dataDir, { ...cur, status: 'stale', staleAt: new Date(now).toISOString() }), null) : null;
  if (cur && cur.id === s.id && (cur.status === 'open')) return cur;
  if (cur && cur.id === s.id && cur.status === 'dismissed' && now - Date.parse(cur.dismissedAt) < (cfg?.dismissDays ?? 7) * 86_400_000) return null;
  const rec = { id: s.id, status: 'open', createdAt: new Date(now).toISOString(), text: s.text, applyText: s.applyText, numbers: s.numbers, move: s.move, perDay: s.perDay,
    explore: s.explore, exploreTimes: s.exploreTimes, times: s.times, counts: s.counts, sourceFingerprint: s.sourceFingerprint, change: s.change };
  saveRecord(dataDir, rec);
  return rec;
}

const refuse = (code, text) => ({ ok: false, code, text });

/**
 * One click: writes the change into the user's schedule settings (checked with the 60-minute floor). Order (Codex review):
 * (1) the record with the whole file as it was and the text to be written is saved as `applying` (fsync, rename);
 * (2) the schedule is replaced; (3) the record becomes `applied` and the change is logged. A stop between them is
 * recovered by recoverApply. Refused when the schedule changed after the proposal was made (fingerprint).
 * opts.stopAfter ('record' | 'schedule'): test seam that ends the click at that point, as a crash would.
 */
export function applySuggestion(dataDir, id, { now = Date.now(), stopAfter = null } = {}) {
  const rec = recoverApply(dataDir, { now });
  if (!rec || rec.id !== id) return refuse('unknown', 'That suggestion is gone; open the Posts window again.');
  if (rec.status !== 'open') return refuse('not-open', 'That suggestion was already applied or dismissed.');
  const before = readSchedule(dataDir);
  if (typeof rec.sourceFingerprint !== 'string' || scheduleFingerprint(before) !== rec.sourceFingerprint) {
    return refuse('schedule-changed', 'Your schedule changed after this suggestion was made, so it was not applied. Open the Posts window again for a fresh suggestion.');
  }
  let cur = {};
  if (before !== null) { try { cur = JSON.parse(before); } catch { return refuse('schedule-unreadable', 'Your schedule settings could not be read, so nothing was changed.'); } }
  const next = { ...(isPlain(cur) ? cur : {}), ...rec.change };
  const c = checkUserSchedule(next, { strict: true });
  if (c.problems.length) return refuse('invalid', `Not applied: ${c.problems.map((p) => p.text).join('; ')}`);
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const pending = { ...rec, status: 'applying', applyingAt: new Date(now).toISOString(), before, appliedText: text };
  saveRecord(dataDir, pending);
  if (stopAfter === 'record') return { ok: false, code: 'stopped', record: pending };
  writeAtomic(userScheduleFile(dataDir), text);
  if (stopAfter === 'schedule') return { ok: false, code: 'stopped', record: pending };
  const done = { ...pending, status: 'applied', appliedAt: new Date(now).toISOString() };
  saveRecord(dataDir, done);
  log(dataDir, { at: done.appliedAt, action: 'apply', id, text: rec.text, numbers: rec.numbers, change: rec.change });
  return { ok: true, record: done };
}

export function dismissSuggestion(dataDir, id, { now = Date.now() } = {}) {
  const rec = recoverApply(dataDir, { now });
  if (!rec || rec.id !== id) return refuse('unknown', 'That suggestion is gone; open the Posts window again.');
  if (rec.status !== 'open') return refuse('not-open', 'That suggestion was already applied or dismissed.');
  const done = { ...rec, status: 'dismissed', dismissedAt: new Date(now).toISOString() };
  saveRecord(dataDir, done);
  log(dataDir, { at: done.dismissedAt, action: 'dismiss', id, text: rec.text });
  return { ok: true, record: done };
}

/** One click: puts the schedule settings back exactly as they were before Apply. Refused when they were changed since
 *  (the user's later change is never overwritten). */
export function undoSuggestion(dataDir, id, { now = Date.now() } = {}) {
  const rec = recoverApply(dataDir, { now });
  if (!rec || rec.id !== id || rec.status !== 'applied') return refuse('nothing-to-undo', 'There is no applied suggestion to undo.');
  const file = userScheduleFile(dataDir);
  if (readSchedule(dataDir) !== rec.appliedText) return refuse('changed-since', 'Your schedule was changed after the suggestion was applied, so Undo would overwrite that; change it in Settings instead.');
  if (rec.before === null) unlinkSync(file); else writeAtomic(file, rec.before);
  const done = { ...rec, status: 'undone', undoneAt: new Date(now).toISOString() };
  saveRecord(dataDir, done);
  log(dataDir, { at: done.undoneAt, action: 'undo', id, text: rec.text });
  return { ok: true, record: done };
}
