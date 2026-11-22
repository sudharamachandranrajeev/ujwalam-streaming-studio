// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduled posting (flag `post-schedule`, off by default; D310, D314, D375). PURE: slot math and settings only. No network,
// no auth, no writes (the channel read is services/posting/schedule-read.mjs; the queue writes are auto-chain.mjs; the
// user's settings file is written by auto-settings.mjs), so the read-only preview can import this file.
//
// Slot rule (D375, user 2026-11-13: "schedule the post with a gap of 6 hours ... work around the existing schedule ...
// don't double post at the same time"; settings in data/posting/schedule.json, never hardcoded):
//   floor  = now + minLeadHours + marginMinutes, rounded UP to alignMinutes (60 = whole hours). A D314 retry that is
//            backing off after an error counts from its nextAt instead of now (it cannot start sooner).
//   taken  = every time a post already has: each scheduled post read from the channel (YouTube Studio's "Scheduled"),
//            each channel video that went public recently, every fixed queue time (uploaded, open upload session, failed
//            slot, queued with a usable slot) and every slot given out earlier in the same pass.
//   slot   = the earliest time >= floor, on the alignMinutes grid, that is at least intervalHours (6 h) away from EVERY
//            taken time. So new posts fill the free gaps around the existing schedule (e.g. 06:00, 12:00 and 18:00 on days
//            that only have a 00:00 post) and no two posts are ever less than intervalHours apart.
//   placement "after-last" (the D310 rule) instead starts the search at the latest taken time + intervalHours.
//   The result is always UTC (RFC 3339 'Z'), so time zones and DST never matter.
// Who gets a new slot in a pass: a queued item with no slot, and a D314 retry (a queued item with no upload session whose
// time is less than minLeadHours away, or whose too-close time was already dropped). Every other time stays as it is.
// Cap: a slot more than maxAheadDays (730 = 2 years) ahead is not given out; the item waits ('schedule-beyond-cap').
// Check before an upload session starts or resumes: publishAt >= now + minLeadHours (leadOk). The margin in the floor
// is what lets a slot given out now pass that check when its upload starts a little later in the same batch.
// Check before every chunk: publishAt >= now + marginMinutes, so an upload never finishes with a past time.
// Bound on every chunk (youtube.mjs): the request is aborted at publishAt - chunkDeadlineSeconds, and the final chunk
// only starts when its estimated transfer (slowest measured chunk speed, else fallbackKbps) fits before that deadline.
// The user's own settings (Settings > Posting & growth > Auto-post) live in <data dir>/posting/schedule.json and replace
// the shipped intervalHours, maxAheadDays and placement (and hold quotaUnitsPerDay, read by quota-budget.mjs).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCHEDULE_FLAG = 'post-schedule';
export const DEFAULT_SCHEDULE = path.join(REPO, 'data', 'posting', 'schedule.json');
export const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class ScheduleError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'ScheduleError'; this.code = code; }
}

export const USER_SCHEDULE_NAME = 'schedule.json';
/** The user's own schedule settings (Settings > Posting & growth > Auto-post): <dataDir>/posting/schedule.json. Only the
 *  keys in USER_KEYS are read from it; each replaces the shipped value. It survives app updates (data dir, not repo). */
export const userScheduleFile = (dataDir) => path.join(dataDir, 'posting', USER_SCHEDULE_NAME);
// 'random-daily' (D403, user 2026-11-19: "spread out randomly"): each local day gets a random number of posts
// (postsPerDayMin..postsPerDayMax) at random times inside windowStart..windowEnd (local time, DST-safe), at least
// minGapMinutes apart from each other and from every taken time. Seeded (seed in the user's schedule.json), so a plan is
// the same on every pass and after a restart. See planRandomDaily below.
// 'custom' (user 2026-11-20: "add the ability to setup custom schedule in app as well"): a weekly plan of exact local times
// per weekday (customTimes { mon: ['18:00', ...], ... }), DST-safe, filled in order; a time too close to a channel post or
// already taken is skipped, never moved; skipDates ['YYYY-MM-DD'] are days off. See planCustom below.
// 'grid-tiers' (D434, user 2026-11-22: "upload up to 100 each day ... starting today at 12:00, 13:00, 14:00 ... If those
// slots get filled, use the quarter slot next (12:15, 13:15 ...), then ... the half mark"): candidate times at every local
// hour (this PC's clock, DST-safe) at minute tierOffsets[0], over the rolling window floor..now + maxAheadDays; a clip takes
// the EARLIEST free one; only when no slot of that tier is free anywhere in the window does the next tier
// (tierOffsets[1], ...) open. Free = no taken time within gridGapMinutes. The 60-minute HARD_GAP floor does not apply in
// this mode (the user reversed D408 for it); the floor is gridGapMinutes (at most the smallest distance between offsets).
export const PLACEMENTS = Object.freeze(['grid-tiers', 'random-daily', 'fill-gaps', 'after-last', 'custom']);
/** Shipped grid-tiers defaults (the user's 2026-11-22 pattern), used when neither file sets them. */
export const GRID_DEFAULTS = Object.freeze({ tierOffsets: Object.freeze([0, 15, 30, 45]), gridGapMinutes: 15 });
/** readReuseMinutes when no file sets it: 0 = a channel read before every upload session (the D409 rule, safest). The
 *  shipped data/posting/schedule.json sets 120 (D434). */
export const READ_REUSE_DEFAULT = 0;
/** Checks a tier list and gap together. -> problem text or null. Offsets: unique whole minutes 0..59 (1 to 60 of them);
 *  the gap may not be wider than the smallest distance between two offsets (counting round the hour). Pure. */
export function gridProblem(offsets, gap) {
  if (!Array.isArray(offsets) || !offsets.length || offsets.length > 60 || offsets.some((o) => !Number.isInteger(o) || o < 0 || o > 59)) return 'slot minutes must be whole minutes from 0 to 59';
  if (new Set(offsets).size !== offsets.length) return 'a slot minute is listed twice';
  if (!Number.isInteger(gap) || gap < 1 || gap > 60) return 'the gap between slots must be a whole number of minutes from 1 to 60';
  const s = [...offsets].sort((a, b) => a - b);
  let d = 60 - (s[s.length - 1] - s[0]);
  for (let k = 1; k < s.length; k++) d = Math.min(d, s[k] - s[k - 1]);
  if (gap > d) return `the gap between slots (${gap} min) is wider than the smallest distance between your slot minutes (${d} min)`;
  return null;
}
export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const CUSTOM_LIMITS = Object.freeze({ timesPerDay: 24, skipDates: 400 });
/** PT2 (D408, user 2026-11-21: "only not allowed rule should be ... 1 hr before or after the already scheduled one"): the
 *  one fixed rule. No slot is ever less than this from any other scheduled time (channel, queue, same pass), in every
 *  placement; a user gap may be wider, never narrower. 24 posts a day is the most this gap allows. */
export const HARD_GAP_MINUTES = 60;
/** What the user may set, and the allowed whole-number ranges (2 days is the widest gap that is still a schedule;
 *  maxAheadDays 730 = the user's 2-year cap, D314; quota from 1,000 units up to a raised Google quota). */
export const USER_LIMITS = Object.freeze({
  intervalHours: { min: HARD_GAP_MINUTES / 60, max: 48 },
  maxAheadDays: { min: 1, max: 730 },
  quotaUnitsPerDay: { min: 1000, max: 10000000 },
  postsPerDayMin: { min: 1, max: 24 },
  postsPerDayMax: { min: 1, max: 24 },
  minGapMinutes: { min: HARD_GAP_MINUTES, max: 1440 },
  seed: { min: 0, max: 2147483647 },
  // D434: grid-tiers gap (1..60 min; also checked against the slot minutes) and how long one complete channel read is
  // reused for upload sessions (0 = read again before every session, the D409 behaviour; at most a day).
  gridGapMinutes: { min: 1, max: 60 },
  readReuseMinutes: { min: 0, max: 1440 },
});
export const USER_KEYS = Object.freeze(['intervalHours', 'maxAheadDays', 'placement', 'quotaUnitsPerDay', 'postsPerDayMin', 'postsPerDayMax', 'windowStart', 'windowEnd', 'minGapMinutes', 'seed', 'customTimes', 'skipDates', 'tierOffsets', 'gridGapMinutes', 'readReuseMinutes']);
/** The keys the random-daily placement reads (shipped defaults in data/posting/schedule.json, replaced by the user's). */
export const RANDOM_KEYS = Object.freeze(['postsPerDayMin', 'postsPerDayMax', 'windowStart', 'windowEnd', 'minGapMinutes', 'seed']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 'HH:MM' -> minutes after midnight, or null. */
export const hhmmMinutes = (s) => { const m = typeof s === 'string' ? HHMM.exec(s) : null; return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** PT2: the window's end may also be '24:00' (the whole day: windowStart 00:00, windowEnd 24:00). */
export const windowEndMinutes = (s) => (s === '24:00' ? 1440 : hhmmMinutes(s));

/** Checks a user settings object (only USER_KEYS; any may be missing). -> { values, problems: [{ key, text }] }. Pure. */
/** 'YYYY-MM-DD' that is a real calendar date (Codex round 3: never throws). */
const realDate = (s) => { const t = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s; };
// opts.strict (the card's Save): a gap below the 60-minute floor is a problem. Without it (reading a file saved before PT2,
// when the floor was 15 min) such a gap is raised to the floor, never used and never a reason to stop posting.
export function checkUserSchedule(j, { strict = false } = {}) {
  const values = {}; const problems = [];
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return { values, problems: [{ key: null, text: 'not a settings object' }] };
  for (const [k, lim] of Object.entries(USER_LIMITS)) {
    if (j[k] === undefined) continue;
    if (!strict && k === 'minGapMinutes' && Number.isInteger(j[k]) && j[k] >= 15 && j[k] < lim.min) { values[k] = lim.min; continue; }
    if (!Number.isInteger(j[k]) || j[k] < lim.min || j[k] > lim.max) problems.push({ key: k, text: `${k} must be a whole number from ${lim.min} to ${lim.max}` });
    else values[k] = j[k];
  }
  if (j.placement !== undefined) { if (PLACEMENTS.includes(j.placement)) values.placement = j.placement; else problems.push({ key: 'placement', text: `placement must be one of ${PLACEMENTS.join(', ')}` }); }
  for (const k of ['windowStart', 'windowEnd']) {
    if (j[k] === undefined) continue;
    const v = k === 'windowEnd' ? windowEndMinutes(j[k]) : hhmmMinutes(j[k]);
    if (v === null) problems.push({ key: k, text: `${k} must be a time like 09:00${k === 'windowEnd' ? ' (24:00 = until midnight)' : ''}` }); else values[k] = j[k];
  }
  if (values.postsPerDayMin !== undefined && values.postsPerDayMax !== undefined && values.postsPerDayMin > values.postsPerDayMax) problems.push({ key: 'postsPerDayMax', text: 'the most posts a day must not be less than the fewest' });
  if (values.windowStart !== undefined && values.windowEnd !== undefined && windowEndMinutes(values.windowEnd) <= hhmmMinutes(values.windowStart)) problems.push({ key: 'windowEnd', text: 'the posting window must end after it starts (same day)' });
  if (j.customTimes !== undefined) {
    const ct = j.customTimes; let bad = null;
    if (!isPlain(ct) || Object.keys(ct).some((k) => !WEEKDAYS.includes(k))) bad = 'custom times must list weekdays (mon to sun)';
    else {
      for (const d of WEEKDAYS) {
        const a = ct[d]; if (a === undefined) continue;
        if (!Array.isArray(a) || a.length > CUSTOM_LIMITS.timesPerDay || a.some((t) => hhmmMinutes(t) === null)) { bad = `${d}: up to ${CUSTOM_LIMITS.timesPerDay} times like 18:00`; break; }
        if (new Set(a).size !== a.length) { bad = `${d}: a time is listed twice`; break; }
      }
    }
    if (bad) problems.push({ key: 'customTimes', text: bad });
    else values.customTimes = Object.fromEntries(WEEKDAYS.filter((d) => ct[d] !== undefined).map((d) => [d, [...ct[d]].sort((x, y) => hhmmMinutes(x) - hhmmMinutes(y))]));
  }
  if (j.skipDates !== undefined) {
    const ok = Array.isArray(j.skipDates) && j.skipDates.length <= CUSTOM_LIMITS.skipDates && j.skipDates.every((s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && realDate(s));
    if (ok) values.skipDates = [...new Set(j.skipDates)].sort(); else problems.push({ key: 'skipDates', text: `days off must be dates like 2026-12-25 (up to ${CUSTOM_LIMITS.skipDates})` });
  }
  if (j.tierOffsets !== undefined) {
    // Order matters (tier 0 first), so it is kept as given. The gap is checked against them below (and again at load,
    // with the shipped gap when the user saved none).
    const p = gridProblem(j.tierOffsets, 1);
    if (p) problems.push({ key: 'tierOffsets', text: p }); else values.tierOffsets = [...j.tierOffsets];
  }
  if (values.tierOffsets && values.gridGapMinutes !== undefined) {
    const p = gridProblem(values.tierOffsets, values.gridGapMinutes);
    if (p) problems.push({ key: 'gridGapMinutes', text: p });
  }
  return { values, problems };
}
const ALIGN_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

/**
 * Reads and checks data/posting/schedule.json. Throws ScheduleError('schedule-config-bad') on any bad value.
 * opts.userFile: the user's <data>/posting/schedule.json; when it exists its intervalHours, maxAheadDays and placement
 * replace the shipped ones (a bad or unreadable user file is refused, never ignored: fail closed). cfg.userKeys lists them.
 */
export function loadScheduleConfig(file = DEFAULT_SCHEDULE, { userFile = null } = {}) {
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new ScheduleError('schedule-config-bad', 'the schedule settings file could not be read'); }
  const num = (k, min, max, src = j) => {
    const v = src?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ScheduleError('schedule-config-bad', `schedule setting ${k} must be a number from ${min} to ${max}`);
    return v;
  };
  const placement = j?.placement ?? 'grid-tiers';
  if (!PLACEMENTS.includes(placement)) throw new ScheduleError('schedule-config-bad', `schedule setting placement must be one of ${PLACEMENTS.join(', ')}`);
  const alignMinutes = num('alignMinutes', 1, 60);
  if (!ALIGN_STEPS.includes(alignMinutes)) throw new ScheduleError('schedule-config-bad', `schedule setting alignMinutes must divide an hour (${ALIGN_STEPS.join(', ')})`);
  const cfg = {
    intervalHours: num('intervalHours', HARD_GAP_MINUTES / 60, 24 * 30),
    minLeadHours: num('minLeadHours', 0.25, 24 * 30),
    marginMinutes: num('marginMinutes', 1, 4 * 60),
    chunkDeadlineSeconds: num('chunkDeadlineSeconds', 1, 3600),
    fallbackKbps: num('fallbackKbps', 64, 1000000),
    maxPages: Math.floor(num('maxPages', 1, 400)), // 400 x 50 = 20000 uploads (2026-11-22: the user's channel has > 2000)
    pageSize: Math.floor(num('pageSize', 1, 50)),
    maxAheadDays: num('maxAheadDays', 1, 3650),
    lookbackDays: num('lookbackDays', 1, 3650),
    alignMinutes,
    placement,
  };
  cfg.userKeys = [];
  if (typeof userFile === 'string' && userFile && existsSync(userFile)) {
    let u;
    try { u = JSON.parse(readFileSync(userFile, 'utf8')); } catch { throw new ScheduleError('schedule-config-bad', 'your schedule settings file (posting/schedule.json in the data folder) could not be read'); }
    const { values, problems } = checkUserSchedule(u);
    if (problems.length) throw new ScheduleError('schedule-config-bad', `your schedule settings: ${problems.map((p) => p.text).join('; ')}`);
    for (const k of ['intervalHours', 'maxAheadDays', 'placement', ...RANDOM_KEYS, 'customTimes', 'skipDates', 'tierOffsets', 'gridGapMinutes', 'readReuseMinutes']) if (values[k] !== undefined) { cfg[k] = values[k]; cfg.userKeys.push(k); }
  }
  // Codex D434: a user file saved before D434 without a placement keeps the old default (random-daily), never the new one.
  if (cfg.userKeys.length && !cfg.userKeys.includes('placement') && j?.placement === 'grid-tiers') cfg.placement = 'random-daily';
  // grid-tiers (D434): the user's values, else the shipped file's, else GRID_DEFAULTS; then checked together.
  cfg.tierOffsets ??= Array.isArray(j?.tierOffsets) ? [...j.tierOffsets] : [...GRID_DEFAULTS.tierOffsets];
  cfg.gridGapMinutes ??= j?.gridGapMinutes ?? GRID_DEFAULTS.gridGapMinutes;
  cfg.readReuseMinutes ??= j?.readReuseMinutes ?? READ_REUSE_DEFAULT;
  const gp = gridProblem(cfg.tierOffsets, cfg.gridGapMinutes);
  if (gp) throw new ScheduleError('schedule-config-bad', `schedule setting ${gp}`);
  const rr = USER_LIMITS.readReuseMinutes;
  if (!Number.isInteger(cfg.readReuseMinutes) || cfg.readReuseMinutes < rr.min || cfg.readReuseMinutes > rr.max) throw new ScheduleError('schedule-config-bad', `schedule setting readReuseMinutes must be a whole number from ${rr.min} to ${rr.max}`);
  // random-daily (D403): shipped defaults (a missing key = the user's 2026-11-19 choice), then the checks across keys.
  const rd = { postsPerDayMin: 3, postsPerDayMax: 6, windowStart: '09:00', windowEnd: '23:00', minGapMinutes: HARD_GAP_MINUTES, seed: 0 };
  for (const k of RANDOM_KEYS) if (cfg[k] === undefined) cfg[k] = j?.[k] ?? rd[k];
  const rc = checkUserSchedule(Object.fromEntries(RANDOM_KEYS.map((k) => [k, cfg[k]])));
  if (rc.problems.length) throw new ScheduleError('schedule-config-bad', `schedule setting ${rc.problems.map((p) => p.text).join('; ')}`);
  cfg.timeZone = typeof j?.timeZone === 'string' && j.timeZone ? j.timeZone : null; // null = this PC's own zone
  cfg.seedSaved = cfg.userKeys.includes('seed');
  cfg.customTimes ??= {}; cfg.skipDates ??= [];
  if (cfg.placement === 'random-daily' || cfg.placement === 'custom') {
    if (cfg.placement === 'custom' && !WEEKDAYS.some((d) => (cfg.customTimes[d] ?? []).length)) throw new ScheduleError('schedule-config-bad', 'custom times: add at least one posting time');
    // Random minutes, not whole hours; and every gap (channel posts, the queue, a moved clip) is minGapMinutes.
    cfg.alignMinutes = 1;
    cfg.intervalHours = cfg.minGapMinutes / 60;
  }
  // A chunk may only start with at least marginMinutes left, and must end chunkDeadlineSeconds before the time:
  // a deadline at or past the margin would stop every final chunk.
  if (cfg.placement === 'grid-tiers') {
    // D434: whole local minutes; every gap (channel posts, the queue, a moved clip) is gridGapMinutes. The user reversed
    // the 60-minute floor for this mode only.
    cfg.alignMinutes = 1;
    cfg.intervalHours = cfg.gridGapMinutes / 60;
  } else if (cfg.intervalHours * 60 < HARD_GAP_MINUTES) {
    // PT2 hard rule: in every other placement the gap in use is never under HARD_GAP_MINUTES.
    cfg.intervalHours = HARD_GAP_MINUTES / 60;
  }
  cfg.recheckMaxAgeMinutes = typeof j?.recheckMaxAgeMinutes === 'number' && j.recheckMaxAgeMinutes >= 1 && j.recheckMaxAgeMinutes <= 240 ? j.recheckMaxAgeMinutes : 10;
  if (cfg.chunkDeadlineSeconds >= cfg.marginMinutes * 60) throw new ScheduleError('schedule-config-bad', 'schedule setting chunkDeadlineSeconds must be less than marginMinutes');
  return cfg;
}

const ms = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
export const toIso = (t) => new Date(t).toISOString(); // always UTC with 'Z'
/** Rounded UP to the alignMinutes grid (UTC; 60 = whole hours). */
export const alignUp = (t, cfg) => { const a = (cfg.alignMinutes ?? 1) * MINUTE_MS; return Math.ceil(t / a) * a; };
/** The earliest a new slot may be: from + minLeadHours + marginMinutes, on the grid. */
export const floorFrom = (fromMs, cfg) => alignUp(fromMs + cfg.minLeadHours * HOUR_MS + cfg.marginMinutes * MINUTE_MS, cfg);

/**
 * Taken times kept sorted (ms), with the free-slot search. Each search step finds the taken times within the gap of the
 * candidate by binary search and jumps to the latest of them + gap: every time skipped is within the gap of that one,
 * so the answer is the first free one. Steps move strictly later and the list is finite, so it always ends.
 * free() remembers, per floor, where the last search ended: times before it were all taken then and taken times only
 * ever get added, so the next search with the same floor starts there. A pass over ~1500 new items (hourly slots for
 * two months) is then O(n log n), not O(n^2) or worse.
 */
export function createSlotter(times, cfg) {
  const gap = cfg.intervalHours * HOUR_MS;
  const list = (times ?? []).filter((t) => Number.isFinite(t)).sort((x, y) => x - y);
  const cursor = new Map();
  const lowerBound = (v) => { let lo = 0; let hi = list.length; while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < v) lo = m + 1; else hi = m; } return lo; };
  /** The latest taken time t with |at - t| < gap, or null. */
  const conflict = (at) => { const k = lowerBound(at + gap) - 1; return k >= 0 && list[k] > at - gap ? list[k] : null; };
  return {
    add(t) { list.splice(lowerBound(t), 0, t); },
    /** The latest taken time within the gap of `at`, or null (free). */
    conflict,
    times: () => list.slice(),
    latest: () => (list.length ? list[list.length - 1] : null),
    free(floor) {
      let at = alignUp(Math.max(floor, cursor.get(floor) ?? floor), cfg);
      for (let t = conflict(at); t !== null; t = conflict(at)) at = alignUp(t + gap, cfg);
      cursor.set(floor, at);
      return at;
    },
  };
}

/** The earliest time >= s (on the grid) that is at least intervalHours from every taken time (ms). Pure. */
export const earliestFree = (s, taken, cfg) => createSlotter(taken, cfg).free(s);

/** Latest future publish time among YouTube video resources (privacy private + publishAt after now). Past ones are ignored. */
export function latestFutureSchedule(videos, nowMs) {
  let last = null; let count = 0;
  for (const v of videos ?? []) {
    if (!isPlain(v) || v.status?.privacyStatus !== 'private') continue;
    const t = ms(v.status?.publishAt);
    if (t === null || t <= nowMs) continue;
    count++;
    if (last === null || t > last) last = t;
  }
  return { last, count };
}

/** Every future publish time (ms, sorted) among YouTube video resources that are private with a publishAt after now. */
export function futureScheduleTimes(videos, nowMs) {
  const out = [];
  for (const v of videos ?? []) {
    if (!isPlain(v) || v.status?.privacyStatus !== 'private') continue;
    const t = ms(v.status?.publishAt);
    if (t !== null && t > nowMs) out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/** True when publishAt is at least needMs ahead of now (unreadable = false). */
export const leadOk = (publishAt, nowMs, needMs) => { const t = ms(publishAt); return t !== null && t - nowMs >= needMs; };
/** A saved slot can no longer start or resume an upload session: less than minLeadHours ahead (or unreadable). */
export const slotTooClose = (publishAt, nowMs, cfg) => !leadOk(publishAt, nowMs, cfg.minLeadHours * HOUR_MS);
export const minLeadMs = (cfg) => cfg.minLeadHours * HOUR_MS;
export const marginMs = (cfg) => cfg.marginMinutes * MINUTE_MS;
/** Every chunk request is aborted this long before the publish time (so the last byte arrives before it or never). */
export const chunkDeadlineMs = (cfg) => cfg.chunkDeadlineSeconds * 1000;
/** Assumed upload speed (bytes/s) for the final-chunk estimate when no chunk was timed yet in this run. */
export const fallbackBps = (cfg) => (cfg.fallbackKbps * 1000) / 8;

/** Latest time (ms) a slot may have: now + maxAheadDays (D314). */
export const maxAheadMs = (nowMs, cfg) => nowMs + cfg.maxAheadDays * 24 * HOUR_MS;

/** D314 retry: a queued clip with no session whose time is too close to start an upload, or whose too-close time was
 *  already dropped (`reslot` saved on the item, or the 'slot-passed' reason from before D314). */
export const isRetry = (i, nowMs, cfg) => isPlain(i) && i.state === 'queued' && !i.session
  && (typeof i.publishAt === 'string' && i.publishAt ? slotTooClose(i.publishAt, nowMs, cfg) : (i.reslot === true || i.reason === 'slot-passed'));

/** Every time a queue item already holds (planned, sent to Google, or its open session's), in ms. */
export function itemTimes(i) {
  const out = [];
  for (const k of ['publishAt', 'sentPublishAt', 'sessionPublishAt']) { const v = ms(i?.[k]); if (v !== null && !out.includes(v)) out.push(v); }
  return out;
}

/**
 * The slots to give out now over a whole queue (items in queue order, any state; rule at the top). Pure.
 * channelTimes: the channel's scheduled posts and recently published videos (ms). channelLast: optional extra time.
 * Revalidation (Codex review 2026-11-13): a queued item that already has a slot but no upload session yet keeps it only
 * while it is still at least the current gap from every channel time and every other kept time (checked earliest
 * first, so of two clashing slots the earlier one stays). The channel may have gained a post at that time, or the gap
 * may have grown; then the item gets a new slot by the same rule as a new one (reval: true).
 * Returns [{ id, at: ms | null, retry, reval }] for every item that gets a new slot or must wait: `at` null = beyond
 * maxAheadDays (the item waits without a slot). Items not listed keep what they have.
 */
// ---------------------------------------------------------------- random-daily (D403)

/** Seeded 32-bit hash (FNV-1a) of the parts, for per-day and per-clip random streams. Pure. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** mulberry32: a small seeded RNG -> () => [0, 1). Pure given the seed. */
export function rngOf(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const zoneOf = (cfg) => cfg.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtCache = new Map();
const partsFmt = (tz) => {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return fmtCache.get(tz);
};
/** The local wall clock of t in the zone: { y, m (1-12), d, h, min }. */
export function zonedParts(t, tz) {
  const o = {}; for (const p of partsFmt(tz).formatToParts(new Date(t))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, min: Number(o.minute), s: Number(o.second) };
}
const offsetAt = (t, tz) => { const p = zonedParts(t, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000; };
/** UTC ms of a local wall time in the zone. A time that does not exist (DST spring gap) moves forward by the gap; a time
 *  that exists twice (autumn) is the first. */
export function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - offsetAt(guess, tz);
  const t2 = guess - offsetAt(t, tz);
  if (t2 !== t) { const back = guess - offsetAt(t2, tz); t = back === t2 ? Math.min(t, t2) : Math.max(t, t2); }
  return t;
}
/** 'YYYY-MM-DD' of the local day that holds t. */
export const localDayKey = (t, tz) => { const p = zonedParts(t, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const nextDayKey = (key) => { const [y, m, d] = key.split('-').map(Number); const n = new Date(Date.UTC(y, m - 1, d + 1)); return n.toISOString().slice(0, 10); };
/** The posting window of a local day in UTC ms: { start, end } (DST-safe: built from the wall times). */
export function dayWindow(key, cfg) {
  const tz = zoneOf(cfg); const [y, m, d] = key.split('-').map(Number);
  const a = hhmmMinutes(cfg.windowStart); const b = windowEndMinutes(cfg.windowEnd);
  return { start: zonedToUtc(y, m, d, Math.floor(a / 60), a % 60, tz), end: zonedToUtc(y, m, d, Math.floor(b / 60), b % 60, tz) };
}
/** How many posts the day gets (seeded; min..max). */
export const dayCount = (key, cfg) => cfg.postsPerDayMin + Math.floor(rngOf(hash32(cfg.seed, key, 'count'))() * (cfg.postsPerDayMax - cfg.postsPerDayMin + 1));
const MINUTE = 60 * 1000;
/** The day's candidate times (UTC ms, whole minutes), seeded: first `count` times spread over the window at least the gap
 *  apart (uniform among such spreads), then EXTRA single random times in the window to fall back on when one is taken. */
export function dayCandidates(key, cfg, count = dayCount(key, cfg), extra = 48) {
  const { start, end } = dayWindow(key, cfg);
  const r = rngOf(hash32(cfg.seed, key, 'times'));
  const gapMin = Math.ceil(cfg.minGapMinutes);
  // PT2: when the window reaches into the gap before the next day's window (00:00-24:00: no room at all), the day stops
  // a gap before the next day starts, so the last post of one day and the first of the next also keep the gap.
  const nextStart = dayWindow(nextDayKey(key), cfg).start;
  const over = Math.max(0, gapMin * MINUTE - (nextStart - end));
  const span = Math.max(0, Math.floor((end - over - start) / MINUTE));
  let n = count; while (n > 1 && (n - 1) * gapMin > span) n--;
  const free = span - (n - 1) * gapMin;
  const base = Array.from({ length: n }, () => Math.floor(r() * (free + 1))).sort((x, y) => x - y);
  const primary = base.map((b, k) => start + (b + k * gapMin) * MINUTE);
  const more = Array.from({ length: extra }, () => start + Math.floor(r() * (span + 1)) * MINUTE);
  return [...primary, ...more];
}

/**
 * random-daily slots (D403). taken: a slotter with every kept time. moving: items in queue order with their own floor.
 * For each local day from the first floor on, the day's picks are its seeded candidates, in candidate order, that are at
 * or after the floor, inside the cap and at least the gap from every taken time and every earlier pick, until the day has
 * its count (times already taken on that day count too). Items take the picks in time order; a retry with a later
 * floor takes the first pick at or after it. A day that cannot fit its count takes what fits. Pure.
 */
function planRandomDaily(moving, slots, nowMs, cfg, pickDay = null) {
  const cap = maxAheadMs(nowMs, cfg);
  const tz = zoneOf(cfg);
  const floorOf = (i) => {
    const retry = isRetry(i, nowMs, cfg);
    const next = retry && typeof i.nextAt === 'string' ? Date.parse(i.nextAt) : NaN;
    return floorFrom(Number.isFinite(next) && next > nowMs ? next : nowMs, cfg);
  };
  const floors = moving.map(floorOf);
  const minFloor = floors.length ? Math.min(...floors) : nowMs;
  const pool = []; // picks not yet given, ascending
  let key = localDayKey(minFloor, tz);
  const lastKey = localDayKey(cap, tz);
  const fillDay = () => {
    if (pickDay) { pool.push(...pickDay(key, minFloor, cap, slots)); key = nextDayKey(key); return; }
    // Codex round 1 (P2): every taken time on that local day counts (channel posts and queue items outside the window too).
    const have = slots.times().filter((t) => localDayKey(t, tz) === key).length;
    const want = dayCount(key, cfg) - have;
    const picks = [];
    if (want > 0) {
      for (const c of dayCandidates(key, cfg)) {
        if (picks.length >= want) break;
        if (c < minFloor || c > cap || slots.conflict(c) !== null || picks.some((p) => Math.abs(p - c) < cfg.minGapMinutes * MINUTE)) continue;
        picks.push(c); slots.add(c);
      }
    }
    pool.push(...picks.sort((a, b) => a - b));
    key = nextDayKey(key);
  };
  const out = [];
  moving.forEach((i, n) => {
    const f = floors[n];
    let k = pool.findIndex((t) => t >= f);
    while (k < 0 && key <= lastKey) { fillDay(); k = pool.findIndex((t) => t >= f); }
    const retry = isRetry(i, nowMs, cfg);
    if (k < 0) { out.push({ id: i.id, at: null, retry }); return; }
    out.push({ id: i.id, at: pool[k], retry }); pool.splice(k, 1);
  });
  return out;
}

/** random-daily: a kept slot must also be inside its day's window, and a day keeps at most its count (earliest first). */
function randomDailyKeeps(cfg) {
  const tz = zoneOf(cfg); const kept = new Map();
  return (t, slots) => {
    const key = localDayKey(t, tz); const { start, end } = dayWindow(key, cfg);
    if (t < start || t > end) return false;
    // Every taken time on that local day counts, inside the window or not (Codex round 1).
    if (!kept.has(key)) kept.set(key, slots.times().filter((x) => localDayKey(x, tz) === key).length);
    if (kept.get(key) >= dayCount(key, cfg)) return false;
    kept.set(key, kept.get(key) + 1);
    return true;
  };
}

// ---------------------------------------------------------------- custom (user 2026-11-20)

/** The day's custom times in UTC ms, ascending: its weekday's times, none on a skip date. DST-safe (wall times). */
export function customDayTimes(key, cfg) {
  if ((cfg.skipDates ?? []).includes(key)) return [];
  const [y, m, d] = key.split('-').map(Number);
  const wd = WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7];
  const tz = zoneOf(cfg);
  // Codex round 3: a time that does not exist that day (spring forward) is skipped; a repeated autumn time is the first.
  return (cfg.customTimes?.[wd] ?? []).flatMap((s) => {
    const n = hhmmMinutes(s); const h = Math.floor(n / 60); const mi = n % 60;
    let t = zonedToUtc(y, m, d, h, mi, tz);
    const same = (x) => { const q = zonedParts(x, tz); return q.y === y && q.m === m && q.d === d && q.h === h && q.min === mi; };
    if (same(t - HOUR_MS)) t -= HOUR_MS; // the repeated autumn hour: its first occurrence
    const p = zonedParts(t, tz);
    return p.y === y && p.m === m && p.d === d && p.h === h && p.min === mi ? [t] : [];
  }).sort((a, b) => a - b);
}
/** custom: every listed time of the day that is free (gap from channel posts and taken times), in order; a taken or too
 *  close time is skipped, never moved. */
const customPicks = (cfg) => (key, minFloor, cap, slots) => {
  const picks = [];
  for (const c of customDayTimes(key, cfg)) {
    if (c < minFloor || c > cap || slots.conflict(c) !== null) continue;
    picks.push(c); slots.add(c);
  }
  return picks;
};
/** custom: a kept slot must be one of its day's custom times. */
function customKeeps(cfg) {
  const tz = zoneOf(cfg);
  return (t) => customDayTimes(localDayKey(t, tz), cfg).includes(t);
}

// ---------------------------------------------------------------- grid-tiers (D434, user 2026-11-22)

/**
 * The tier's candidate times (UTC ms, ascending) in [fromMs, toMs]: every local hour of this PC's clock at minute
 * `offset`. DST-safe: a day of exactly 24 hours that starts at local 00:00 gets its 24 times by adding hours (one zone
 * lookup per day, so a year is about a thousand lookups, not tens of thousands); a day with a clock change goes hour by
 * hour through zonedToUtc: a time that does not exist (spring forward) is skipped, a repeated autumn time is the first.
 */
export function gridCandidates(fromMs, toMs, offset, cfg) {
  const tz = zoneOf(cfg); const out = [];
  if (!(toMs >= fromMs)) return out;
  let key = localDayKey(fromMs, tz); const lastKey = localDayKey(toMs, tz);
  while (key <= lastKey) {
    const [y, m, d] = key.split('-').map(Number);
    const nk = nextDayKey(key); const [y2, m2, d2] = nk.split('-').map(Number);
    const s = zonedToUtc(y, m, d, 0, 0, tz); const e = zonedToUtc(y2, m2, d2, 0, 0, tz);
    const p0 = zonedParts(s, tz);
    if (e - s === 24 * HOUR_MS && p0.h === 0 && p0.min === 0 && p0.d === d) {
      for (let h = 0; h < 24; h++) { const t = s + h * HOUR_MS + offset * MINUTE_MS; if (t >= fromMs && t <= toMs) out.push(t); }
    } else {
      for (let h = 0; h < 24; h++) {
        let t = zonedToUtc(y, m, d, h, offset, tz);
        const same = (x) => { const q = zonedParts(x, tz); return q.y === y && q.m === m && q.d === d && q.h === h && q.min === offset; };
        if (same(t - HOUR_MS)) t -= HOUR_MS;
        if (same(t) && t >= fromMs && t <= toMs && (!out.length || t > out[out.length - 1])) out.push(t);
      }
    }
    key = nk;
  }
  return out;
}

/**
 * grid-tiers slots. slots: the slotter with every kept time (its gap is gridGapMinutes). Each item, in queue order, gets
 * the earliest free candidate of tier 0 at or after its floor; only when tier 0 has none free in the whole window,
 * tier 1, and so on; none in any tier = waits (at null). The candidates are built once per pass. Per (tier, floor) a
 * cursor remembers where the last search ended (candidates before it were taken then, and taken times only grow), so a
 * pass over a big backlog is about O((candidates + items) x log taken), never a scan per clip from the start. Pure.
 */
function planGridTiers(moving, slots, nowMs, cfg) {
  const cap = maxAheadMs(nowMs, cfg);
  const floorOf = (i) => {
    const retry = isRetry(i, nowMs, cfg);
    const next = retry && typeof i.nextAt === 'string' ? Date.parse(i.nextAt) : NaN;
    return floorFrom(Number.isFinite(next) && next > nowMs ? next : nowMs, cfg);
  };
  const floors = moving.map(floorOf);
  if (!moving.length) return [];
  const start = Math.min(...floors);
  const tiers = cfg.tierOffsets.map((o) => gridCandidates(start, cap, o, cfg));
  const lowerBound = (a, v) => { let lo = 0; let hi = a.length; while (lo < hi) { const md = (lo + hi) >> 1; if (a[md] < v) lo = md + 1; else hi = md; } return lo; };
  const cursor = new Map();
  return moving.map((i, n) => {
    const f = floors[n]; const retry = isRetry(i, nowMs, cfg);
    for (let k = 0; k < tiers.length; k++) {
      const c = tiers[k]; const ck = `${k}:${f}`;
      let x = Math.max(cursor.get(ck) ?? 0, lowerBound(c, f));
      while (x < c.length && slots.conflict(c[x]) !== null) x++;
      cursor.set(ck, x);
      if (x < c.length) { slots.add(c[x]); return { id: i.id, at: c[x], retry }; }
    }
    return { id: i.id, at: null, retry };
  });
}

export function planQueueSlots({ items, channelLast = null, channelTimes = [], nowMs, cfg }) {
  const list = (items ?? []).filter(isPlain);
  const needs = (i) => i.state === 'queued' && (!i.publishAt || isRetry(i, nowMs, cfg));
  const held = (i) => i.state === 'queued' && !i.session && !needs(i) && ms(i.publishAt) !== null;
  const taken = [...(channelTimes ?? []), channelLast].filter((v) => Number.isFinite(v));
  for (const i of list) if (!needs(i) && !held(i)) taken.push(...itemTimes(i));
  const slots = createSlotter(taken, cfg);
  const reval = new Set();
  const keeps = cfg.placement === 'random-daily' ? randomDailyKeeps(cfg) : cfg.placement === 'custom' ? customKeeps(cfg) : null;
  for (const i of list.filter(held).sort((a, b) => ms(a.publishAt) - ms(b.publishAt))) {
    const t = ms(i.publishAt);
    if (slots.conflict(t) === null && (!keeps || keeps(t, slots))) { for (const x of itemTimes(i)) slots.add(x); continue; }
    reval.add(i.id);
    // Its other times (an old sent or session time) still count as taken.
    for (const x of itemTimes(i)) if (x !== t) slots.add(x);
  }
  const moving = list.filter((i) => needs(i) || reval.has(i.id));
  if (cfg.placement === 'random-daily') return planRandomDaily(moving, slots, nowMs, cfg).map((p) => ({ ...p, reval: reval.has(p.id) }));
  if (cfg.placement === 'custom') return planRandomDaily(moving, slots, nowMs, cfg, customPicks(cfg)).map((p) => ({ ...p, reval: reval.has(p.id) }));
  if (cfg.placement === 'grid-tiers') return planGridTiers(moving, slots, nowMs, cfg).map((p) => ({ ...p, reval: reval.has(p.id) }));
  const cap = maxAheadMs(nowMs, cfg);
  const gap = cfg.intervalHours * HOUR_MS;
  const out = [];
  for (const i of moving) {
    const retry = isRetry(i, nowMs, cfg);
    const next = retry && typeof i.nextAt === 'string' ? Date.parse(i.nextAt) : NaN;
    let floor = floorFrom(Number.isFinite(next) && next > nowMs ? next : nowMs, cfg);
    if (cfg.placement === 'after-last' && slots.latest() !== null) floor = Math.max(floor, alignUp(slots.latest() + gap, cfg));
    const at = slots.free(floor);
    const r = reval.has(i.id);
    if (at > cap) { out.push({ id: i.id, at: null, retry, reval: r }); continue; }
    out.push({ id: i.id, at, retry, reval: r }); slots.add(at);
  }
  return out;
}

/** The next `count` slots a new item would get after the queue's own (for the schedule preview). Pure. */
export function nextFreeSlots({ items = [], channelTimes = [], count, nowMs, cfg }) {
  const virtual = Array.from({ length: count }, (_, n) => ({ id: `next:${n}`, state: 'queued', publishAt: null, session: null }));
  const plan = planQueueSlots({ items: [...items, ...virtual], channelTimes, nowMs, cfg });
  const byId = new Map(plan.map((p) => [p.id, p.at]));
  return virtual.map((v) => byId.get(v.id) ?? null);
}

/** Channel post times saved by the chain's last read (for the preview): future scheduled posts and recently published
 *  ones (recentTimes, kept so a new post is never within the gap of one that just went public). */
export function savedChannelTimes(queueDoc, nowMs) {
  const s = queueDoc?.schedule;
  const fut = Array.isArray(s?.channelTimes) ? s.channelTimes.map(ms).filter((t) => t !== null && t > nowMs) : [];
  const recent = Array.isArray(s?.recentTimes) ? s.recentTimes.map(ms).filter((t) => t !== null) : [];
  const last = ms(s?.channelLast);
  const out = [...fut, ...recent];
  if (last !== null && last > nowMs && !out.includes(last)) out.push(last);
  return out.sort((x, y) => x - y);
}

/**
 * PT2: the check right before an upload session starts. -> the clashing time (ms) or null. A clash is any channel time
 * (saved read) or any other queue item's time less than the gap in use (never under HARD_GAP_MINUTES) from the item's slot.
 * Pure.
 */
export function slotClash({ item, items = [], channelTimes = [], cfg }) {
  const t = ms(item?.publishAt);
  if (t === null) return null;
  // D434: grid-tiers uses its own gap (the user's minimum); every other placement keeps the 60-minute floor.
  const gap = (cfg.placement === 'grid-tiers' ? cfg.intervalHours * 60 : Math.max(cfg.intervalHours * 60, HARD_GAP_MINUTES)) * MINUTE_MS;
  const others = [...channelTimes, ...items.filter((i) => isPlain(i) && i.id !== item.id).flatMap(itemTimes)];
  for (const x of others) if (Number.isFinite(x) && Math.abs(x - t) < gap) return x;
  return null;
}
