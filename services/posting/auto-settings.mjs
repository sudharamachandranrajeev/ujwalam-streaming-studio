// SPDX-License-Identifier: GPL-3.0-or-later
// D375 Auto-post settings without hand-editing JSON. The posting engine's settings API: the studio's Settings > Posting &
// growth > Auto-post card (services/studio-ui/server.mjs, a thin layer) calls these; another local app could call them
// the same way. Node stdlib only. Writes only the user's own files in the data dir, atomically:
//   <data>/posting/auto-post-rules.json   the rules (validated by validateRules in auto-post.mjs)
//   <data>/posting/schedule.json          intervalHours, maxAheadDays, placement, quotaUnitsPerDay (checkUserSchedule)
// Both are read again on the next pass (rules: a live source; schedule: loaded per pass), so nothing needs a restart.
//   readAutoPostSettings(dataDir)              -> { exists, custom, card, defaults, kinds, schedule, quota, limits }
//   saveAutoPostSettings(dataDir, body)        -> { ok: true, settings } | { ok: false, problems: [{ key, text }] }
//   The card: { autoUpload, kinds[], minScore, maxPerDay, intervalHours, maxAheadDays, placement, quotaUnitsPerDay,
//   postsPerDayMin, postsPerDayMax, windowStart, windowEnd, minGapMinutes } (the last five: placement random-daily, D403).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AutoPostError, MAX_PER_DAY, NOTICE_TEXT, RULE_KINDS, rankerMinScore, rulesFileFor, userRulesFile, validateRules } from './auto-post.mjs';
import { DEFAULT_SCHEDULE, HARD_GAP_MINUTES, HOUR_MS, PLACEMENTS, USER_LIMITS, ScheduleError, alignUp, checkUserSchedule, floorFrom, itemTimes, loadScheduleConfig, maxAheadMs, nextFreeSlots, savedChannelTimes, toIso, userScheduleFile } from './schedule.mjs';
import { QUEUE_NAME, createUploadQueue, withScheduleLock } from './auto-chain.mjs';
import { READONLY_SCOPE } from './oauth.mjs';
import { readChannelSchedule } from './schedule-read.mjs';
import { ensureScheduleSeed } from './schedule-seed.mjs';
import { DEFAULT_QUOTA, createQuotaBudget, loadQuota } from './quota-budget.mjs';

export { DEFAULT_QUOTA, loadQuota };

/** The two rules the card writes: one per YouTube target (the target is chosen by length and aspect, limits.json). */
export const CARD_RULES = Object.freeze([{ id: 'auto-shorts', target: 'youtube-shorts' }, { id: 'auto-videos', target: 'youtube-video' }]);
/** The schedule settings the card shows and saves (D375, D403); the seed is never on the card (made once, kept). */
export const CARD_SCHEDULE_KEYS = Object.freeze(['intervalHours', 'maxAheadDays', 'placement', 'quotaUnitsPerDay', 'postsPerDayMin', 'postsPerDayMax', 'windowStart', 'windowEnd', 'minGapMinutes', 'customTimes', 'skipDates']);
export const KIND_LABELS = Object.freeze({ short: 'Short clips', montage: 'Montages', 'won-reel': 'Won-round reels', 'impact-play': 'Impact plays', 'long-highlights': 'Long highlights videos' });
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The user's own schedule settings as saved (only the known keys), or {} when there is no file or it is unreadable. */
export function readUserSchedule(dataDir) {
  const j = readJson(userScheduleFile(dataDir));
  return isPlain(j) ? checkUserSchedule(j).values : {};
}

/** The quota for the card: the user's own when it can be read; with a broken user settings file the shipped numbers plus
 *  `error` (the card shows it and can save a fix; the chain's budget blocks every upload and read meanwhile). */
export function cardQuota(dataDir) {
  try { return { ...loadQuota(dataDir), error: null }; } catch (e) { return { ...loadQuota(null), error: e?.message ?? 'quota settings could not be read' }; }
}

/** What the card shows when the user has no rules file yet (D375): upload on, every kind, the ranker's own floor as the
 *  minimum score (every clip the ranker keeps; the best go first inside the daily cap), as many a day as the quota fits
 *  (at least 1 in the field: with a quota that fits none, the daily budget still stops every upload, quota-budget.mjs). */
export function defaultCard(dataDir) {
  const q = cardQuota(dataDir);
  let cfg; // a broken user file is reported by readAutoPostSettings; the defaults still come from the shipped one
  try { cfg = scheduleConfigFor(dataDir); } catch { cfg = loadScheduleConfig(DEFAULT_SCHEDULE); }
  return { autoUpload: true, kinds: [...RULE_KINDS], minScore: rankerMinScore() ?? 0, maxPerDay: Math.max(1, q.uploadsPerDayFit),
    intervalHours: cfg.placement === 'random-daily' || cfg.placement === 'custom' ? userOr(dataDir, 'intervalHours', cfg) : cfg.intervalHours, maxAheadDays: cfg.maxAheadDays, placement: cfg.placement, quotaUnitsPerDay: q.quotaUnitsPerDay,
    postsPerDayMin: cfg.postsPerDayMin, postsPerDayMax: cfg.postsPerDayMax, windowStart: cfg.windowStart, windowEnd: cfg.windowEnd, minGapMinutes: cfg.minGapMinutes, customTimes: cfg.customTimes ?? {}, skipDates: cfg.skipDates ?? [] };
}

/** intervalHours as saved or shipped (random-daily replaces the one in use by minGapMinutes; the card still shows the
 *  fill-gaps value so switching back keeps it). */
function userOr(dataDir, k, cfg) {
  const u = typeof dataDir === 'string' ? readUserSchedule(dataDir) : {};
  if (u[k] !== undefined) return u[k];
  try { return readJson(DEFAULT_SCHEDULE)?.[k] ?? cfg[k]; } catch { return cfg[k]; }
}

/** The schedule settings in use: the shipped file plus the user's own (throws ScheduleError when either is bad). */
export const scheduleConfigFor = (dataDir) => loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: typeof dataDir === 'string' ? userScheduleFile(dataDir) : null });

/** The rules file the card writes. Pure. */
export function rulesFromCard(card) {
  return {
    $comment: 'Written by Settings > Posting & growth > Auto-post (D375). You can still edit it by hand; the card then says it has your own rules and Save replaces them.',
    version: '0.2.0',
    autoUpload: card.autoUpload === true,
    maxUploadsPerDay: card.maxPerDay,
    rules: CARD_RULES.map((r) => ({ id: r.id, target: r.target, minScore: card.minScore, kinds: [...card.kinds], maxPerDay: card.maxPerDay })),
  };
}

/** The card values held in a rules doc. custom = the doc is not the card's own shape (Save would replace it). Pure. */
export function cardFromRules(doc) {
  const v = validateRules(doc);
  const own = v.rules.length === CARD_RULES.length && CARD_RULES.every((c, i) => v.rules[i].id === c.id && v.rules[i].target === c.target)
    && v.rules.every((r) => r.minScore === v.rules[0].minScore && r.maxPerDay === v.rules[0].maxPerDay && !r.layouts && r.kinds.join() === v.rules[0].kinds.join());
  const first = v.rules[0];
  return {
    custom: !own,
    card: { autoUpload: v.autoUpload, kinds: first ? [...first.kinds] : [], minScore: first ? first.minScore : null, maxPerDay: v.maxUploadsPerDay ?? (first ? first.maxPerDay : null) },
  };
}

/** Checks the card's values. -> { card, problems }. Pure (the ranges are data: USER_LIMITS, RULE_KINDS, MAX_PER_DAY). */
export function checkCard(body) {
  const problems = [];
  const c = isPlain(body) ? body : {};
  const add = (key, text) => problems.push({ key, text });
  if (typeof c.autoUpload !== 'boolean') add('autoUpload', 'upload automatically must be on or off');
  const kinds = Array.isArray(c.kinds) ? [...new Set(c.kinds)] : null;
  if (!kinds || !kinds.length || !kinds.every((k) => RULE_KINDS.includes(k))) add('kinds', `choose at least one of ${RULE_KINDS.map((k) => KIND_LABELS[k]).join(', ')}`);
  if (!Number.isFinite(c.minScore) || c.minScore < 0 || c.minScore > 100) add('minScore', 'the minimum clip score must be a number from 0 to 100');
  if (!Number.isInteger(c.maxPerDay) || c.maxPerDay < 1 || c.maxPerDay > MAX_PER_DAY) add('maxPerDay', `uploads per day must be a whole number from 1 to ${MAX_PER_DAY}`);
  const sched = {};
  for (const k of CARD_SCHEDULE_KEYS) if (c[k] !== undefined) sched[k] = c[k];
  const s = checkUserSchedule(sched, { strict: true });
  problems.push(...s.problems);
  return { card: { autoUpload: c.autoUpload === true, kinds: kinds ?? [], minScore: c.minScore, maxPerDay: c.maxPerDay, ...s.values }, problems };
}

/** Everything the card needs. Never throws for a bad user file: it says so (error) and shows the defaults. */
export function readAutoPostSettings(dataDir) {
  const defaults = defaultCard(dataDir);
  const rulesFile = userRulesFile(dataDir);
  const exists = existsSync(rulesFile);
  let card = { ...defaults }; let custom = false; let error = null;
  if (exists) {
    try {
      const r = cardFromRules(readJson(rulesFile) ?? (() => { throw new AutoPostError('bad-rules', 'rules file: not valid JSON'); })());
      custom = r.custom;
      card = { ...defaults, ...Object.fromEntries(Object.entries(r.card).filter(([, v]) => v !== null)) };
    } catch (e) { error = e?.message ?? 'rules file could not be read'; }
  }
  let scheduleError = null;
  try { scheduleConfigFor(dataDir); } catch (e) { scheduleError = e instanceof ScheduleError ? e.message : 'schedule settings could not be read'; }
  const quota = cardQuota(dataDir);
  return {
    exists, custom, error, scheduleError, card, defaults,
    kinds: RULE_KINDS.map((id) => ({ id, label: KIND_LABELS[id] ?? id })),
    quota,
    limits: { maxPerDay: MAX_PER_DAY, minScore: { min: 0, max: 100 }, ...USER_LIMITS, placements: PLACEMENTS },
  };
}

/**
 * Saves the card in one click (D332): the rules file and the user's schedule settings, each written atomically after
 * every value was checked. Nothing is written when any value is wrong. body: { card } (the card's values) or
 * { doc } (a whole rules file, checked with validateRules; the schedule is left as it is).
 */
export function saveAutoPostSettings(dataDir, body) {
  if (!isPlain(body)) return { ok: false, problems: [{ key: null, text: 'nothing to save' }] };
  if (body.doc !== undefined) {
    try { validateRules(body.doc); } catch (e) { return { ok: false, problems: [{ key: 'doc', text: e?.message ?? 'rules file not valid' }] }; }
    writeJsonAtomic(userRulesFile(dataDir), body.doc);
    return { ok: true, settings: readAutoPostSettings(dataDir) };
  }
  const { card, problems } = checkCard(body.card);
  if (problems.length) return { ok: false, problems };
  // keepRules (user 2026-11-20): the rules file is the user's own shape; "What gets posted" edits it (saveRulesEdit), so the
  // card writes only the schedule and never replaces those rules.
  const keepRules = body.keepRules === true;
  // Codex round 3: an existing rules file that cannot be read or checked is never replaced, unless the user clicked Reset.
  if (!keepRules && body.resetRules !== true && existsSync(userRulesFile(dataDir))) {
    let why = null;
    try { validateRules(JSON.parse(readFileSync(userRulesFile(dataDir), 'utf8'))); } catch (e) { why = e instanceof AutoPostError ? e.message : 'not valid JSON'; }
    if (why) return { ok: false, problems: [{ key: 'rules-file', text: `Your rules file has a problem: ${why}; fix it or reset it` }] };
  }
  const doc = keepRules ? null : rulesFromCard(card);
  if (doc) validateRules(doc); // the card's own shape always passes; checked again so a bad file can never be written
  const sched = { ...readUserSchedule(dataDir) };
  for (const k of CARD_SCHEDULE_KEYS) if (card[k] !== undefined) sched[k] = card[k];
  writeJsonAtomic(userScheduleFile(dataDir), {
    $comment: 'Your posting schedule (Settings > Posting & growth > Auto-post, D375). Replaces the shipped values in data/posting/schedule.json and data/posting/quota.json.',
    ...sched,
  });
  if (doc) writeJsonAtomic(userRulesFile(dataDir), doc);
  ensureScheduleSeed(dataDir); // D403: the random plan's seed, made once
  return { ok: true, settings: readAutoPostSettings(dataDir) };
}

// ---------------------------------------------------------------- "What gets posted" (user 2026-11-20)

const TARGET_LABELS = Object.freeze({ 'youtube-shorts': 'YouTube Shorts', 'youtube-video': 'YouTube videos' });

/** The rules for the editor, read from the file in use (the user's, else the shipped template), unchanged. Never throws:
 *  a bad file gives error and no rules. notice: the plain-words line when nothing would upload because of the rules. */
export function readRulesEditor(dataDir) {
  const file = rulesFileFor(dataDir);
  const own = file === userRulesFile(dataDir);
  let raw = null; let v = null; let error = null;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); v = validateRules(raw); } catch (e) { error = e instanceof AutoPostError ? e.message : 'rules file: missing or not valid JSON'; }
  const rules = v ? v.rules.map((r) => ({ id: r.id, target: r.target, targetLabel: TARGET_LABELS[r.target] ?? r.target, kinds: [...r.kinds], maxPerDay: r.maxPerDay, minScore: r.minScore })) : [];
  return {
    own, error,
    autoUpload: v ? v.autoUpload : false,
    maxUploadsPerDay: v?.maxUploadsPerDay ?? null,
    rules,
    notice: error ? NOTICE_TEXT['bad-rules'] : !rules.length ? NOTICE_TEXT['no-rules'] : null,
    kinds: RULE_KINDS.map((id) => ({ id, label: KIND_LABELS[id] ?? id })),
    limits: { maxPerDay: MAX_PER_DAY },
  };
}

/** Checks an editor save: { autoUpload, maxUploadsPerDay, rules: [{ id, kinds, maxPerDay }] }. -> problems. Pure. */
export function checkRulesEdit(e) {
  const problems = []; const add = (key, text) => problems.push({ key, text });
  if (!isPlain(e) || Object.keys(e).some((k) => !['autoUpload', 'maxUploadsPerDay', 'rules'].includes(k))) return [{ key: null, text: 'nothing to save' }];
  if (typeof e.autoUpload !== 'boolean') add('autoUpload', 'upload automatically must be on or off');
  if (!Number.isInteger(e.maxUploadsPerDay) || e.maxUploadsPerDay < 1 || e.maxUploadsPerDay > MAX_PER_DAY) add('maxUploadsPerDay', `uploads per day must be a whole number from 1 to ${MAX_PER_DAY}`);
  if (!Array.isArray(e.rules) || e.rules.length > 50) { add('rules', 'rules must be a list'); return problems; }
  const seen = new Set();
  for (const r of e.rules) {
    if (!isPlain(r) || Object.keys(r).some((k) => !['id', 'kinds', 'maxPerDay'].includes(k)) || typeof r.id !== 'string' || seen.has(r.id)) { add('rules', 'a rule is not valid'); continue; }
    seen.add(r.id);
    if (!Array.isArray(r.kinds) || !r.kinds.length || new Set(r.kinds).size !== r.kinds.length || !r.kinds.every((k) => RULE_KINDS.includes(k))) add(`rule:${r.id}`, `choose at least one of ${RULE_KINDS.map((k) => KIND_LABELS[k]).join(', ')}`);
    if (!Number.isInteger(r.maxPerDay) || r.maxPerDay < 1 || r.maxPerDay > MAX_PER_DAY) add(`rule:${r.id}`, `posts per day must be a whole number from 1 to ${MAX_PER_DAY}`);
  }
  return problems;
}

/** Saves the editor (one click, D332): only the given fields of the given rules change; every other key and every rule
 *  not listed stay as they are. Written atomically to the user's file after validateRules; nothing is written on a problem. */
export function saveRulesEdit(dataDir, edit) {
  const problems = checkRulesEdit(edit);
  if (problems.length) return { ok: false, problems };
  const file = rulesFileFor(dataDir);
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); validateRules(doc); } catch (e) { return { ok: false, problems: [{ key: 'doc', text: `the rules file in use has a mistake, fix it by hand first (${e instanceof AutoPostError ? e.message : 'not valid JSON'})` }] }; }
  const ids = new Set(doc.rules.map((r) => r.id));
  const unknown = edit.rules.filter((r) => !ids.has(r.id));
  if (unknown.length) return { ok: false, problems: [{ key: 'rules', text: `no rule named ${unknown.map((r) => r.id).join(', ')}` }] };
  const byId = new Map(edit.rules.map((r) => [r.id, r]));
  const next = { ...doc, autoUpload: edit.autoUpload, maxUploadsPerDay: edit.maxUploadsPerDay,
    rules: doc.rules.map((r) => (byId.has(r.id) ? { ...r, kinds: [...byId.get(r.id).kinds], maxPerDay: byId.get(r.id).maxPerDay } : r)) };
  validateRules(next);
  writeJsonAtomic(userRulesFile(dataDir), next);
  return { ok: true, rules: readRulesEditor(dataDir) };
}

// ---------------------------------------------------------------- schedule preview and queue edits (D375)

const queueOf = (dataDir) => createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
const ms = (v) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const SCHEDULE_REASONS = new Set(['slot-passed', 'not-signed-in', 'no-oauth-client']);

/**
 * What the card's "Next posting times" list shows. channel = { times: [ms], recent: [ms], readAt } from a fresh read,
 * or null to use the times the chain saved at its last read. -> { channel: [iso], queue: [{ id, state, publishAt,
 * reason }], next: [iso], intervalHours, placement, maxAheadDays, channelReadAt, source: 'live'|'saved'|'none', error }.
 */
export function schedulePreview(dataDir, { nowMs = Date.now(), count = 10, channel = null } = {}) {
  let cfg;
  try { cfg = scheduleConfigFor(dataDir); } catch (e) { return { error: e instanceof ScheduleError ? e.code : 'schedule-config-bad', channel: [], queue: [], next: [] }; }
  const q = queueOf(dataDir);
  const doc = { items: Object.fromEntries(q.items().map((i) => [i.id, i])), schedule: q.schedule() };
  const items = Object.values(doc.items);
  const channelTimes = channel
    ? [...(channel.times ?? []).filter((t) => t > nowMs), ...(channel.recent ?? [])].sort((a, b) => a - b)
    : savedChannelTimes(doc, nowMs);
  const truncated = channel ? channel.truncated === true : doc.schedule?.truncated === true;
  const n = Math.max(0, Math.min(50, Math.trunc(count) || 0));
  const next = truncated ? [] : nextFreeSlots({ items, channelTimes, count: n, nowMs, cfg }).filter((t) => t !== null).map(toIso);
  const shown = (i) => (i.state === 'done' ? (i.sentPublishAt ?? null) : (i.publishAt ?? null));
  return {
    error: truncated ? 'schedule-read-incomplete' : null,
    channel: channelTimes.filter((t) => t > nowMs).map(toIso),
    queue: items.filter((i) => i.state === 'queued' || i.state === 'uploading' || (i.state === 'done' && ms(shown(i)) > nowMs))
      .map((i) => ({ id: i.id, state: i.state, publishAt: shown(i), reason: i.reason ?? null, movable: i.state === 'queued' && !i.session }))
      .sort((a, b) => (ms(a.publishAt) ?? Infinity) - (ms(b.publishAt) ?? Infinity)),
    next, intervalHours: cfg.intervalHours, placement: cfg.placement, maxAheadDays: cfg.maxAheadDays, minGapMinutes: cfg.minGapMinutes,
    channelReadAt: channel ? (channel.readAt ?? toIso(nowMs)) : (doc.schedule?.readAt ?? null),
    source: channel ? 'live' : doc.schedule ? 'saved' : 'none',
  };
}

/**
 * Moves one queued, not-yet-uploaded clip to another time (the card's "Move"). The time must be on the schedule grid,
 * at least the lead time from now, not past the days-ahead limit, and at least the gap away from every other post (the
 * channel's saved times and every other time in the queue). -> { ok: true, item } | { ok: false, code, text }.
 */
export function moveQueueItem(dataDir, id, at, { nowMs = Date.now() } = {}) {
  const no = (code, text) => ({ ok: false, code, text });
  let cfg;
  try { cfg = scheduleConfigFor(dataDir); } catch { return no('schedule-config-bad', 'the schedule settings are not valid'); }
  const q = queueOf(dataDir);
  const it = q.get(id);
  if (!it) return no('unknown', 'that clip is not in the upload queue');
  if (it.state !== 'queued' || it.session) return no('not-movable', 'only a clip that has not started uploading can be moved');
  const t = typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/.test(at) ? ms(at) : null;
  if (t === null) return no('bad-time', 'the time is not valid (UTC, e.g. 2026-11-14T18:00:00Z)');
  if (alignUp(t, cfg) !== t) return no('off-grid', `pick a time on the ${cfg.alignMinutes}-minute grid`);
  if (t < floorFrom(nowMs, cfg)) return no('too-soon', 'that time is too soon for the upload to finish first');
  if (t > maxAheadMs(nowMs, cfg)) return no('too-far', `that time is more than ${cfg.maxAheadDays} days ahead`);
  const doc = { schedule: q.schedule() };
  const others = q.items().filter((i) => i.id !== id).flatMap(itemTimes);
  const gap = cfg.intervalHours * HOUR_MS;
  if ([...savedChannelTimes(doc, nowMs), ...others].some((x) => Math.abs(x - t) < gap)) return no('taken', `another post is less than ${cfg.intervalHours} h from that time`);
  const item = q.patch(id, { publishAt: toIso(t), slotAt: toIso(nowMs), reslot: null, movedByUser: true,
    ...(typeof it.reason === 'string' && (it.reason.startsWith('schedule-') || SCHEDULE_REASONS.has(it.reason)) ? { reason: null, nextAt: null } : {}) });
  return { ok: true, item };
}

/** Takes one clip that has not been uploaded out of the queue (the card's "Remove"); it is never queued again by itself.
 *  The package stays (Posts view). -> { ok: true, item } | { ok: false, code, text }. */
export function removeQueueItem(dataDir, id) {
  const q = queueOf(dataDir);
  const it = q.get(id);
  if (!it) return { ok: false, code: 'unknown', text: 'that clip is not in the upload queue' };
  if (it.state !== 'queued' && it.state !== 'failed') return { ok: false, code: 'not-removable', text: 'only a clip that is waiting to upload can be removed' };
  return { ok: true, item: q.patch(id, { state: 'removed', publishAt: null, session: null, sessionPublishAt: null, reslot: null, nextAt: null, reason: 'removed-by-user' }) };
}

/** PT3 (D408) per-clip "Schedule next free slot": puts one approved clip in the upload queue at the next free time the
 *  planner gives (the one hard rule: never within 60 min of any other scheduled time). Local file only; the chain's next
 *  pass uploads it as private with that publish time. -> { ok: true, item } | { ok: false, code, text }. */
export function scheduleNextFree(dataDir, id, { nowMs = Date.now() } = {}) {
  const no = (code, text) => ({ ok: false, code, text });
  let cfg;
  try { cfg = scheduleConfigFor(dataDir); } catch { return no('schedule-config-bad', 'the schedule settings are not valid'); }
  const q = queueOf(dataDir);
  const cur = q.get(id);
  if (cur && cur.state !== 'removed' && !(cur.state === 'queued' && !cur.session)) return no('not-movable', 'that clip is already uploading or uploaded');
  const items = q.items().filter((i) => i.id !== id);
  const [t] = nextFreeSlots({ items, channelTimes: savedChannelTimes({ schedule: q.schedule() }, nowMs), count: 1, nowMs, cfg });
  if (t === null || t === undefined) return no('no-free-slot', `no free time in the next ${cfg.maxAheadDays} days`);
  if (!cur) q.add(id);
  const item = q.patch(id, { state: 'queued', publishAt: toIso(t), slotAt: toIso(nowMs), reslot: null, movedByUser: true, reason: null, nextAt: null, ...(cur?.state === 'removed' ? { attempts: 0 } : {}) });
  return { ok: true, item };
}

/** PT3 "Post now (public)": the time of a scheduled or recent post within the hard gap of now, or null (free). */
export function publicNowClash(dataDir, id, { nowMs = Date.now() } = {}) {
  const gap = HARD_GAP_MINUTES * 60 * 1000;
  const q = queueOf(dataDir);
  const times = [...savedChannelTimes({ schedule: q.schedule() }, nowMs - gap), ...q.items().filter((i) => i.id !== id).flatMap(itemTimes)];
  return times.find((x) => Number.isFinite(x) && Math.abs(x - nowMs) < gap) ?? null;
}

/**
 * PT3 "Post now (public)", Codex review 2026-11-21 (D409): the check and the reservation, in the chain's schedule lock.
 * Right before: a fresh, complete channel read (failed, quota-refused or truncated = refused, nothing sent); no clash
 * with any channel time or queue time within the gap of the window [now, now + estimated upload time] (estimate:
 * the video's bytes at half cfg.fallbackKbps); no other public post being sent. On success the post is recorded in the
 * queue as 'public-uploading' (publishAt = now), so the chain starts no new session until it ends and every planner
 * counts its time as taken. -> { ok: true, prev } | { ok: false, code, text, at? }.
 * opts: { dataDir, id, auth, fetchImpl, nowMs, videoBytes, lockOpts? }
 */
export async function reservePublicNow({ dataDir, id, auth, fetchImpl = fetch, nowMs = Date.now(), videoBytes = 0, lockOpts }) {
  const no = (code, text, at) => ({ ok: false, code, text, ...(at !== undefined ? { at: toIso(at) } : {}) });
  let cfg;
  try { cfg = scheduleConfigFor(dataDir); } catch { return no('schedule-config-bad', 'the schedule settings are not valid'); }
  try {
    return await withScheduleLock(dataDir, async () => {
      const q = queueOf(dataDir);
      const cur = q.get(id);
      if (cur && cur.state !== 'removed' && cur.state !== 'failed') return no('in-queue', 'this clip is in the upload queue; remove it there first');
      if (q.items().some((i) => i.state === 'public-uploading' || i.state === 'uploading')) return no('upload-in-progress', 'another upload is running; try again when it ends');
      let read;
      try { read = await readChannelForPreview({ dataDir, auth, fetchImpl, nowMs }); } catch (e) {
        const code = e?.code === 'oauth-no-client' ? 'youtube-no-client' : e?.code === 'oauth-reauth-needed' ? 'youtube-not-signed-in' : String(e?.code ?? 'schedule-read-failed');
        return no(code, 'could not read the scheduled posts on the channel just now; nothing was sent');
      }
      if (read.truncated) return no('schedule-read-incomplete', 'could not read every upload on the channel (raise maxPages); nothing was sent');
      q.setSchedule({ channelLast: null, channelTimes: read.times.map(toIso), recentTimes: read.recent.map(toIso), count: read.times.length, scanned: null, truncated: false, readAt: toIso(nowMs) });
      const gap = Math.max(HARD_GAP_MINUTES * 60 * 1000, cfg.intervalHours * HOUR_MS);
      const kbps = Math.max(1, (cfg.fallbackKbps ?? 1000) / 2);
      const est = Math.ceil((Math.max(0, videoBytes) * 8) / (kbps * 1000)) * 1000;
      const times = [...read.times, ...read.recent, ...q.items().filter((i) => i.id !== id).flatMap(itemTimes)];
      const hit = times.find((x) => Number.isFinite(x) && x > nowMs - gap && x < nowMs + est + gap);
      if (hit !== undefined) return no('too-close', `another post is at ${toIso(hit)}, less than 60 min from this one`, hit);
      const prev = cur ? { ...cur } : null;
      if (!cur) q.add(id);
      q.patch(id, { state: 'public-uploading', publishAt: toIso(nowMs), sentPublishAt: null, session: null, reason: null, nextAt: null, pid: process.pid });
      return { ok: true, prev };
    }, lockOpts);
  } catch (e) {
    if (e?.code === 'schedule-busy') return no('schedule-busy', 'another post is being scheduled right now; try again in a moment');
    throw e;
  }
}

/** Ends a "Post now (public)" reservation: sent -> 'public-done' with the time it went up as a taken time (both the
 *  start and the end stay taken); not sent -> the queue item goes back to what it was (or 'removed'). */
export function finishPublicNow(dataDir, id, { ok, videoId = null, nowMs = Date.now(), prev = null }) {
  const q = queueOf(dataDir);
  if (ok) return q.patch(id, { state: 'public-done', videoId, sentPublishAt: toIso(nowMs), pid: null });
  if (prev) return q.patch(id, { ...prev, pid: null });
  return q.patch(id, { state: 'removed', publishAt: null, sentPublishAt: null, reason: 'public-not-sent', pid: null });
}

/** A fresh read of the channel's schedule for the card (read-only; needs the readonly sign-in scope). Its calls count
 *  in the daily quota budget (quota-budget.mjs); a read that may not fit is not made. Throws ScheduleError
 *  ('schedule-scope-missing', 'schedule-read-failed', 'quota-day-used', ...) or the auth error. -> the schedulePreview channel. */
export async function readChannelForPreview({ dataDir, auth, fetchImpl = fetch, nowMs = Date.now() }) {
  const cfg = scheduleConfigFor(dataDir);
  const budget = createQuotaBudget({ dataDir, nowMs: () => nowMs });
  const scopes = typeof auth.grantedScopes === 'function' ? await auth.grantedScopes() : null;
  if (!Array.isArray(scopes) || !scopes.includes(READONLY_SCOPE)) throw new ScheduleError('schedule-scope-missing', 'sign in again to allow reading scheduled posts');
  const accessToken = await auth.accessToken();
  // The whole read's units are reserved before the first request; unused ones are given back.
  let scan;
  try { scan = budget.reserveScan(1 + 2 * cfg.maxPages, fetchImpl); } catch (e) {
    throw new ScheduleError(String(e?.code ?? 'quota-unreadable'), "today's YouTube quota does not leave room for a schedule read");
  }
  let read;
  try { read = await readChannelSchedule({ accessToken, fetchImpl: scan.fetch, nowMs, cfg }); } finally { scan.done(); }
  return { times: read.times ?? [], recent: read.recent ?? [], truncated: read.truncated === true, readAt: toIso(nowMs) };
}
