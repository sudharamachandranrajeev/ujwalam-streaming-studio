// SPDX-License-Identifier: GPL-3.0-or-later
// D375 daily YouTube budget (Codex reviews 2026-11-13). Counters in the SQLite file <data>/posting/quota-day.sqlite
// (node:sqlite, stdlib), one row per (kind, day):
//   uploads: upload attempts in a UTC day (every upload start or resume counts), checked against the rules'
//            maxUploadsPerDay; the approvals cap (planAuto) uses the same UTC day.
//   units:   quota units used in a Pacific day (Google resets the quota at midnight Pacific time): an upload attempt
//            counts insert + thumbnail units (quota.json), every API read (schedule reads, status checks for the
//            delete) 1 unit.
// Admission: an upload may start only while units + one upload <= quotaUnitsPerDay - readReserveUnits; reads may use the
// whole quota. The "uploads a day fit" number counts each upload as its own units plus the day's channel reads at their
// worst (1 + 2 x maxPages each): one read per readReuseMinutes period, never more than one per upload (D434; with
// readReuseMinutes 0 a read before every upload session, D409), so a fit of 0 never uploads. After YouTube's quotaExceeded nothing uploads before the next Pacific midnight (quota-model.json
// exhaustedUntil), and under the fallback the day's earlier bucket-model uploads are recounted at insertUnits each.
// Every check and its charge run in ONE transaction (BEGIN IMMEDIATE ... COMMIT, busy timeout BUSY_WAIT_MS), so the
// chain and the studio server never lose a charge or both pass the same last slot. SQLite's file lock is held by the OS
// and released when the holding process ends in any way (no stale lock file to take over). Every exception path rolls
// back and closes the connection. Busy past BUSY_WAIT_MS blocks ('quota-busy', fail closed).
// Reads are reserved BEFORE they are sent: meter() reserves 1 unit per request; reserveScan() reserves a whole schedule
// read up front on its Pacific day and gives back what it did not use TO THAT DAY; a request sent after midnight Pacific
// reserves 1 unit on the new day first.
// Fail closed: a bad quota file, an unreadable or invalid user schedule file, a database that cannot be opened, and any
// counter row that breaks the shape (CHECK constraints in the table, and the same check on every read) block uploads
// and reads. The old counter file quota-day.json (bb4b11c) is read once when the database is new: a valid one carries
// today's counts over; an invalid or unreadable one blocks until it is fixed or removed. It is left in place.
//   loadQuota(dataDir, file?) -> { quotaUnitsPerDay, perUploadUnits, readReserveUnits, uploadsPerDayFit, userSet }
//   createQuotaBudget({ dataDir, nowMs?, quota?, busyWaitMs? }) -> { state(), uploadBlock(maxPerDay),
//     reserveUpload(maxPerDay), readBlock(units), reserveRead(units), refundRead(units, day), reserveScan(units, fetchImpl),
//     meter(fetchImpl), chargeUpload(), chargeRead(units), reserveCaption() }
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { MAX_PER_DAY } from './auto-post.mjs';
import { DEFAULT_SCHEDULE, checkUserSchedule, loadScheduleConfig, userScheduleFile } from './schedule.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_QUOTA = path.join(REPO, 'data', 'posting', 'quota.json');
export const QUOTA_DAY_NAME = 'quota-day.sqlite';
export const LEGACY_DAY_NAME = 'quota-day.json';
/** PT2 (D408): the quota model fallback state, written when YouTube answers quotaExceeded under the bucket model. */
export const QUOTA_MODEL_NAME = 'quota-model.json';
export const QUOTA_MODELS = Object.freeze(['upload-bucket', 'unit-sum']);
/** Plain words for the Settings quota line and the task bar. */
export const QUOTA_MODEL_TEXT = Object.freeze({
  'upload-bucket': "Uploads use YouTube's own upload allowance (up to 100 a day); each one still costs 50 quota units for its cover picture.",
  'unit-sum': 'Uploads are counted the old way: 1,650 quota units each, plus the channel reads, so only a few a day fit in 10,000 units.',
  fallback: 'YouTube said the upload quota was used up, so uploads wait for tomorrow and are counted the old way (1,650 units each) until then.',
});
export const BUSY_WAIT_MS = 3 * 1000;
/** Rows older than this many days are dropped (only today's rows count; a few days are kept for diagnosis). */
const KEEP_DAYS = 8;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export class QuotaError extends Error {
  constructor(code, message) { super(message ?? code); this.name = 'QuotaError'; this.code = code; }
}

/** The user's own quota (schedule settings file): absent = none (shipped value); unreadable or invalid = throws. */
function userQuota(dataDir) {
  if (typeof dataDir !== 'string') return {};
  let raw;
  try { raw = readFileSync(userScheduleFile(dataDir), 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return {};
    throw new QuotaError('quota-unreadable', 'your schedule settings file could not be read');
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new QuotaError('quota-unreadable', 'your schedule settings file is not valid JSON'); }
  if (!isPlain(j)) throw new QuotaError('quota-unreadable', 'your schedule settings file is not an object');
  const c = checkUserSchedule(j);
  if (c.problems.length) throw new QuotaError('quota-unreadable', `your schedule settings are not valid: ${c.problems.map((p) => p.text).join('; ')}`);
  return c.values;
}

/**
 * The quota numbers (data/posting/quota.json, quotaUnitsPerDay from the user's schedule settings when set) and how many
 * uploads a day fit: floor((quota - read reserve) / (insert + thumbnail)). 0 when not even one fits: then nothing
 * uploads until the quota is raised. Throws when the data file or an existing user settings file is bad.
 */
export function loadQuota(dataDir, file = DEFAULT_QUOTA, { nowMs = Date.now() } = {}) {
  const j = readJson(file);
  const n = (k) => { const v = j?.[k]; if (!Number.isFinite(v) || v < 0) throw new QuotaError('quota-unreadable', `quota setting ${k} is not valid`); return v; };
  const user = userQuota(dataDir);
  const quota = user.quotaUnitsPerDay ?? n('quotaUnitsPerDay');
  // PT2: a file without a model is the old unit sum (D375).
  const shipped = j?.model ?? 'unit-sum';
  if (!QUOTA_MODELS.includes(shipped)) throw new QuotaError('quota-unreadable', 'quota setting model is not valid');
  const fb = shipped === 'upload-bucket' ? quotaFallback(dataDir, nowMs) : null;
  const model = fb ? 'unit-sum' : shipped;
  const reserve = n('readReserveUnits');
  const thumb = n('thumbnailUnits');
  const insert = model === 'upload-bucket' ? (Number.isFinite(j?.insertUnits) && j.insertUnits >= 0 ? j.insertUnits : null) : n('insertUnits');
  const perUpload = model === 'upload-bucket' ? thumb : insert + thumb;
  const bucket = model === 'upload-bucket' ? Math.floor(n('uploadBucketPerDay')) : null;
  // D434: one complete channel read (1 + 2 x maxPages units at its worst, the amount reserved before it) serves every
  // upload session while it is younger than readReuseMinutes, so a day pays at most ceil(1440 / readReuseMinutes) reads
  // (and never more reads than uploads). readReuseMinutes 0 = a read before every session (D409): one read per upload.
  const { readUnits, readReuseMinutes } = readModel(dataDir);
  const readsPerDayMax = readReuseMinutes > 0 ? Math.ceil(1440 / readReuseMinutes) : null;
  const fit = uploadsFit({ quota, reserve, perUpload, readUnits, readsPerDayMax, cap: bucket === null ? MAX_PER_DAY : Math.min(bucket, MAX_PER_DAY) });
  const ex = exhaustedUntil(dataDir, nowMs);
  // C1: captions.insert units (the long video's caption track); null = not known, the track is skipped (fail closed)
  const caption = Number.isFinite(j?.captionUnits) && j.captionUnits >= 0 ? j.captionUnits : null;
  // D443 T4: videos.update units (the scheduled-post rewrite); null = not known, no rewrite runs (fail closed)
  const update = Number.isFinite(j?.updateUnits) && j.updateUnits >= 0 ? j.updateUnits : null;
  return { quotaUnitsPerDay: quota, perUploadUnits: perUpload, captionUnits: caption, updateUnits: update, readUnitsPerRead: readUnits, readReuseMinutes, readsPerDayMax, insertUnits: insert, readReserveUnits: reserve, uploadsPerDayFit: fit, maxPerDay: MAX_PER_DAY, userSet: user.quotaUnitsPerDay !== undefined,
    model, uploadsCap: bucket, fallback: fb, exhaustedUntil: ex, modelText: fb ? QUOTA_MODEL_TEXT.fallback : QUOTA_MODEL_TEXT[model] };
}

/** The most uploads n (0..cap) a day with n x perUpload + reads(n) x readUnits <= quota - reserve, where reads(n) = n
 *  (readsPerDayMax null: a read per upload) or min(n, readsPerDayMax). The Settings card does the same sum. Pure. */
export function uploadsFit({ quota, reserve, perUpload, readUnits, readsPerDayMax = null, cap }) {
  const room = quota - reserve;
  let n = 0;
  while (n < cap) {
    const m = n + 1;
    const reads = readsPerDayMax === null ? m : Math.min(m, readsPerDayMax);
    if (m * perUpload + reads * readUnits > room) break;
    n = m;
  }
  return n;
}

/** The units one channel schedule read may use at most (1 + 2 x maxPages) and readReuseMinutes (the user's schedule
 *  settings, else the shipped file). Throws QuotaError when neither gives a valid maxPages. */
export function readModel(dataDir) {
  let cfg = null;
  try { cfg = loadScheduleConfig(DEFAULT_SCHEDULE, { userFile: typeof dataDir === 'string' ? userScheduleFile(dataDir) : null }); } catch { cfg = readJson(DEFAULT_SCHEDULE); }
  const p = cfg?.maxPages;
  if (!Number.isInteger(p) || p < 1) throw new QuotaError('quota-unreadable', 'schedule setting maxPages is not valid');
  const r = cfg?.readReuseMinutes;
  return { readUnits: 1 + 2 * p, readReuseMinutes: Number.isInteger(r) && r >= 0 && r <= 1440 ? r : 0 };
}
/** The units one channel schedule read may use at most: 1 + 2 x maxPages. */
export const readUnitsPerSession = (dataDir) => readModel(dataDir).readUnits;

/** The first moment of the next Pacific day after t (ms): Google resets the quota at midnight Pacific time. */
export function nextPacificMidnight(t) {
  const day = pacificDay(t);
  let hi = t + 3600e3;
  while (pacificDay(hi) === day) hi += 3600e3;
  let lo = hi - 3600e3; // lo is still `day` (or t itself)
  if (lo < t) lo = t;
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (pacificDay(mid) === day) lo = mid; else hi = mid; }
  return hi;
}

/** Codex review 2026-11-21: after YouTube's quotaExceeded nothing uploads before this time (ms; the next Pacific
 *  midnight after the answer), or null. Never throws. */
export function exhaustedUntil(dataDir, nowMs = Date.now()) {
  if (typeof dataDir !== 'string') return null;
  const j = readJson(path.join(dataDir, 'posting', QUOTA_MODEL_NAME));
  const t = typeof j?.exhaustedUntil === 'string' ? Date.parse(j.exhaustedUntil) : NaN;
  return Number.isFinite(t) && t > nowMs ? t : null;
}

/** PT2: the active quotaExceeded fallback ({ since, until }: Pacific days) or null. It ends after `until`. Never throws. */
export function quotaFallback(dataDir, nowMs = Date.now()) {
  if (typeof dataDir !== 'string') return null;
  const j = readJson(path.join(dataDir, 'posting', QUOTA_MODEL_NAME));
  if (!isPlain(j) || j.model !== 'unit-sum' || typeof j.until !== 'string' || !DAY_RE.test(j.until)) return null;
  return pacificDay(nowMs) <= j.until ? { since: j.since ?? null, until: j.until } : null;
}

/** PT2: YouTube answered quotaExceeded: nothing uploads before the next Pacific midnight (exhaustedUntil, persisted),
 *  and under the bucket model the count goes the old way for today and fallbackDays more Pacific days, then the bucket
 *  is tried again. Codex review 2026-11-21: a repeated answer while a fallback is active never moves `until` further
 *  out (only exhaustedUntil is set again, to the same or the next midnight). -> the saved state. */
export function recordQuotaExceeded(dataDir, nowMs = Date.now(), file = DEFAULT_QUOTA) {
  const fd = readJson(file)?.fallbackDays;
  const days = Number.isInteger(fd) && fd >= 0 && fd <= 30 ? fd : 1;
  const today = pacificDay(nowMs);
  const active = quotaFallback(dataDir, nowMs);
  const prev = readJson(path.join(dataDir, 'posting', QUOTA_MODEL_NAME));
  let since = today; let until;
  if (active) { since = active.since ?? today; until = active.until; } else {
    const [y, m, d] = today.split('-').map(Number);
    until = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  }
  const state = { model: 'unit-sum', since, until, at: new Date(nowMs).toISOString(), reason: 'quotaExceeded',
    exhaustedUntil: new Date(nextPacificMidnight(nowMs)).toISOString(), answers: (active && Number.isInteger(prev?.answers) ? prev.answers : 0) + 1 };
  const f = path.join(dataDir, 'posting', QUOTA_MODEL_NAME);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${f}.tmp`, f);
  return state;
}

export const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
/** YYYY-MM-DD in Pacific time (the YouTube quota day); UTC if the runtime has no time zone data. */
export function pacificDay(t) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  } catch { return utcDay(t); }
}

/** A YouTube Data API read (GET on /youtube/v3/, not an upload URL): 1 quota unit. */
export const isApiRead = (url, init) => {
  const u = String(url);
  return /^https:\/\/www\.googleapis\.com\/youtube\/v3\//.test(u) && String(init?.method ?? 'GET').toUpperCase() === 'GET';
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['uploads', 'units']);
const validCounter = (c) => isPlain(c) && typeof c.day === 'string' && DAY_RE.test(c.day) && Number.isSafeInteger(c.n) && c.n >= 0;

/** Parses the OLD counter file's text (quota-day.json). Throws QuotaError('quota-unreadable') unless it is exactly the
 *  expected shape; a valid counter from another day counts 0. */
export function parseCounters(raw, { utc, pacific }) {
  let j;
  try { j = JSON.parse(raw); } catch { throw new QuotaError('quota-unreadable', 'the old quota counter file (quota-day.json) is not valid JSON'); }
  if (!isPlain(j) || !validCounter(j.uploads) || !validCounter(j.units)) throw new QuotaError('quota-unreadable', 'the old quota counter file (quota-day.json) is not valid');
  return { uploads: { day: utc, n: j.uploads.day === utc ? j.uploads.n : 0 }, units: { day: pacific, n: j.units.day === pacific ? j.units.n : 0 } };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS counter (
  kind TEXT NOT NULL CHECK (kind IN ('uploads', 'units')),
  day TEXT NOT NULL CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  n INTEGER NOT NULL CHECK (n >= 0),
  PRIMARY KEY (kind, day)
) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;

/** SQLite busy/locked (primary result codes 5 and 6, also inside extended codes). */
const isBusy = (e) => [5, 6].includes(Number(e?.errcode) & 0xff) || /database is locked|database table is locked/i.test(String(e?.message));
const asQuotaError = (e) => (e instanceof QuotaError ? e
  : isBusy(e) ? new QuotaError('quota-busy', 'the quota counter stayed locked')
  : new QuotaError('quota-unreadable', `the quota counter database could not be used: ${e?.message ?? e}`));

export function createQuotaBudget({ dataDir, nowMs = () => Date.now(), quota = null, busyWaitMs = BUSY_WAIT_MS }) {
  const file = path.join(dataDir, 'posting', QUOTA_DAY_NAME);
  const legacyFile = path.join(dataDir, 'posting', LEGACY_DAY_NAME);
  const getQuota = quota ?? (() => loadQuota(dataDir, DEFAULT_QUOTA, { nowMs: nowMs() }));

  /** Every counter row must have the table's shape (the CHECK constraints may be missing from a replaced file). */
  function checkRows(db) {
    for (const r of db.prepare('SELECT kind, day, n, typeof(n) AS t FROM counter').all()) {
      if (!KINDS.has(r.kind) || typeof r.day !== 'string' || !DAY_RE.test(r.day) || r.t !== 'integer' || !Number.isSafeInteger(r.n) || r.n < 0) {
        throw new QuotaError('quota-unreadable', 'the quota counter database has a row that is not valid');
      }
    }
  }
  const count = (db, kind, day) => db.prepare('SELECT n FROM counter WHERE kind = ? AND day = ?').get(kind, day)?.n ?? 0;
  const add = (db, kind, day, n) => {
    if (n > 0) db.prepare('INSERT INTO counter (kind, day, n) VALUES (?, ?, ?) ON CONFLICT (kind, day) DO UPDATE SET n = n + excluded.n').run(kind, day, n);
  };

  /** Once per database: carries a valid old quota-day.json over; an invalid or unreadable one throws (fail closed). */
  function migrateLegacy(db, days) {
    if (db.prepare("SELECT value FROM meta WHERE key = 'legacy-json'").get()) return;
    let raw = null;
    try { raw = readFileSync(legacyFile, 'utf8'); } catch (e) {
      if (e?.code !== 'ENOENT') throw new QuotaError('quota-unreadable', 'the old quota counter file (quota-day.json) could not be read');
    }
    if (raw !== null) {
      const old = parseCounters(raw, days);
      add(db, 'uploads', old.uploads.day, old.uploads.n);
      add(db, 'units', old.units.day, old.units.n);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('legacy-json', ?)").run(raw === null ? 'none' : 'carried-over');
  }

  /**
   * Runs fn(db, days) inside BEGIN IMMEDIATE ... COMMIT on a fresh connection. Any throw (open, busy, schema, row check,
   * fn, commit) rolls back and closes, and comes out as a QuotaError ('quota-busy' or 'quota-unreadable').
   */
  function tx(fn) {
    let db = null;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      db = new DatabaseSync(file, { timeout: busyWaitMs });
      db.exec('BEGIN IMMEDIATE');
      try {
        const t = nowMs(); const days = { utc: utcDay(t), pacific: pacificDay(t) };
        db.exec(SCHEMA);
        migrateLegacy(db, days);
        checkRows(db);
        db.prepare('DELETE FROM counter WHERE day < ?').run(utcDay(t - KEEP_DAYS * 86400000));
        db.prepare("DELETE FROM meta WHERE key LIKE 'bucket-uploads:%' AND substr(key, 16) < ?").run(utcDay(t - KEEP_DAYS * 86400000));
        const r = fn(db, days);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* no transaction left (SQLite rolled it back itself) */ }
        throw e;
      }
    } catch (e) {
      throw asQuotaError(e);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  }
  // Codex review 2026-11-21: uploads charged under the bucket model on each Pacific day (meta 'bucket-uploads:<day>'),
  // so a quotaExceeded fallback can recount them at the unit-sum cost the same day.
  const bucketKey = (day) => `bucket-uploads:${day}`;
  const bucketCount = (db, day) => {
    const v = db.prepare('SELECT value FROM meta WHERE key = ?').get(bucketKey(day))?.value;
    if (v === undefined) return 0;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new QuotaError('quota-unreadable', 'the quota counter database has a row that is not valid');
    return n;
  };
  const snapshot = (db, d) => ({ uploads: { day: d.utc, n: count(db, 'uploads', d.utc) }, units: { day: d.pacific, n: count(db, 'units', d.pacific) }, bucketUploads: { day: d.pacific, n: bucketCount(db, d.pacific) } });

  /** Today's counters. Throws QuotaError when the database cannot be used or holds a row that is not valid. */
  const state = () => tx((db, d) => { const { uploads, units } = snapshot(db, d); return { uploads, units }; });

  /** One transaction: getQuota, today's counters, decide(s, q) -> reason (nothing charged) | null (charge(db, d, q) runs). */
  const step = (decide, charge) => {
    try {
      return tx((db, d) => {
        const q = getQuota(); const s = snapshot(db, d);
        const why = decide(s, q);
        if (!why) charge(db, d, q);
        return why;
      });
    } catch (e) { return e.code === 'quota-busy' ? 'quota-busy' : 'quota-unreadable'; }
  };
  const uploadWhy = (s, q, maxPerDay) => {
    // YouTube said quotaExceeded: nothing starts before the next Pacific midnight (no attempt is used meanwhile).
    if (Number.isFinite(q.exhaustedUntil) && q.exhaustedUntil > nowMs()) return 'quota-exceeded';
    if (Number.isInteger(maxPerDay) && s.uploads.n >= maxPerDay) return 'daily-cap-reached';
    if (Number.isInteger(q.uploadsCap) && s.uploads.n >= q.uploadsCap) return 'quota-day-used'; // PT2 upload bucket (counted per UTC day)
    // Under the fallback, today's earlier bucket-model uploads also cost their insert units (recounted the old way).
    const recount = q.fallback && Number.isFinite(q.insertUnits) ? (s.bucketUploads?.n ?? 0) * q.insertUnits : 0;
    if (s.units.n + recount + q.perUploadUnits > q.quotaUnitsPerDay - q.readReserveUnits) return 'quota-day-used';
    return null;
  };
  const readWhy = (s, q, units) => (s.units.n + units > q.quotaUnitsPerDay ? 'quota-day-used' : null);
  // C1: a write that is not an upload (the caption track): after quotaExceeded nothing; never into the read reserve.
  const writeWhy = (s, q, units) => {
    if (Number.isFinite(q.exhaustedUntil) && q.exhaustedUntil > nowMs()) return 'quota-exceeded';
    return s.units.n + units > q.quotaUnitsPerDay - q.readReserveUnits ? 'quota-day-used' : null;
  };
  const peek = (decide) => step(decide, () => {});
  const refuse = (why) => { throw Object.assign(new Error(why), { code: why }); };
  const chargeUploadRow = (db, d, q) => {
    add(db, 'uploads', d.utc, 1); add(db, 'units', d.pacific, q.perUploadUnits);
    if (q.model === 'upload-bucket') {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(bucketKey(d.pacific), String(bucketCount(db, d.pacific) + 1));
    }
  };
  /** Reserves `units` of reads on the current Pacific day. -> { why, day } (day = the day charged, null when refused). */
  const reserveReadOn = (units) => {
    let day = null;
    const why = step((s, q) => readWhy(s, q, units), (db, d) => { add(db, 'units', d.pacific, units); day = d.pacific; });
    return { why, day };
  };

  const budget = {
    file,
    state,
    /** Read-only check: null (an upload could start now) or why not. Nothing is charged. */
    uploadBlock: (maxPerDay = null) => peek((s, q) => uploadWhy(s, q, maxPerDay)),
    /** Check and charge one upload attempt in one transaction: null (charged, go) or why not (nothing charged). */
    reserveUpload: (maxPerDay = null) => step((s, q) => uploadWhy(s, q, maxPerDay), chargeUploadRow),
    /** C1: check and charge one caption track (quota.json captionUnits) in one transaction: null (charged) or why not. */
    reserveCaption: () => step((s, q) => (Number.isFinite(q.captionUnits) ? writeWhy(s, q, q.captionUnits) : 'quota-unreadable'),
      (db, d, q) => add(db, 'units', d.pacific, q.captionUnits)),
    /** D443 T4: check and charge one videos.update (quota.json updateUnits) like a caption track: never into the read reserve. */
    reserveUpdate: () => step((s, q) => (Number.isFinite(q.updateUnits) ? writeWhy(s, q, q.updateUnits) : 'quota-unreadable'),
      (db, d, q) => add(db, 'units', d.pacific, q.updateUnits)),
    /** Read-only: how many more writes of `units` fit today before the read reserve -> { fit, why }. */
    writeRoom(units) {
      let fit = 0;
      const why = peek((s, q) => { const w = writeWhy(s, q, units); if (!w) fit = Math.max(0, Math.floor((q.quotaUnitsPerDay - q.readReserveUnits - s.units.n) / Math.max(1, units))); return w; });
      return { fit, why };
    },
    /** Read-only check for `units` of reads. */
    readBlock: (units = 1) => peek((s, q) => readWhy(s, q, units)),
    /** Check and charge `units` of reads in one transaction: null (charged) or why not (nothing charged). */
    reserveRead: (units = 1) => reserveReadOn(units).why,
    /** Gives back `units` reserved on Pacific day `day` and not used: to that day only (never below 0). A missing or
     *  malformed day refunds nothing ('quota-unreadable'): an unbound refund could free units on the wrong day. */
    refundRead(units, day) {
      if (!(units > 0)) return null;
      if (typeof day !== 'string' || !DAY_RE.test(day)) return 'quota-unreadable';
      return step(() => null, (db) => {
        db.prepare("UPDATE counter SET n = max(0, n - ?) WHERE kind = 'units' AND day = ?").run(units, day);
      });
    },
    /** fetch that reserves 1 unit before each Data API read is sent; refused (rejects, nothing sent) over budget. */
    meter: (fetchImpl) => async (url, init) => {
      if (isApiRead(url, init)) { const why = budget.reserveRead(1); if (why) refuse(why); }
      return fetchImpl(url, init);
    },
    /** Reserves `units` up front on the current Pacific day for one multi-call read. -> { fetch, done() }: fetch spends
     *  the reservation (at most `units` reads; refuses past it, nothing sent). A read sent after midnight Pacific
     *  reserves 1 unit on the new day before it is sent. done() gives back the unused part to the reservation's day.
     *  Throws (code = reason) when it does not fit. */
    reserveScan(units, fetchImpl) {
      const r = reserveReadOn(units);
      if (r.why) refuse(r.why);
      const day = r.day;
      let calls = 0; let usedOnDay = 0; let closed = false;
      return {
        day,
        fetch: async (url, init) => {
          if (isApiRead(url, init)) {
            if (closed || calls >= units) refuse('quota-day-used');
            if (pacificDay(nowMs()) === day) usedOnDay += 1;
            else { const why = budget.reserveRead(1); if (why) refuse(why); }
            calls += 1;
          }
          return fetchImpl(url, init);
        },
        done() { if (!closed) { closed = true; budget.refundRead(units - usedOnDay, day); } },
      };
    },
    /** Unconditional charges (tests and repairs). Throw on an unusable counter database. */
    chargeUpload() { const why = step(() => null, chargeUploadRow); if (why) refuse(why); },
    chargeRead(units = 1) { const why = step(() => null, (db, d) => add(db, 'units', d.pacific, units)); if (why) refuse(why); },
  };
  return budget;
}
