// SPDX-License-Identifier: GPL-3.0-or-later
// Several YouTube channels for auto-posting (YM1-YM5, plan docs/plan/2026-11-25-youtube-multi-account.md). Node stdlib only.
//   <data>/posting/accounts.json   the channel list (written by the studio's Settings > Posting & growth > YouTube channels):
//     { version: 1, accounts: [{ id, label, enabled, addedAt, channelId?, title?, handle?, postsPerDay?: { min, max },
//       shortsOnly? }] }. Channel ids, handles and labels live only in this local file, never in the repo.
//   <data>/posting/channel-state.json  what the posting chain learns while it runs (written by the chain only):
//     { version: 1, turn: <account id | null>, paused: { <id>: { until, reason } } }.
// YM1 migration: no accounts.json (every install before YM1) reads as one channel, `main`, posting on, with today's
// rules. A queue item without an `account` field reads as `main` (accountOf), so nothing already queued or scheduled
// changes. A NEW queue item starts in the pool (account null) and is dealt to a channel by the chain (dealPool).
// YM2: each channel has its own refresh token in Windows Credential Manager: `main` keeps the old target
// (Ujwalam/posting/youtube-refresh), an added channel uses Ujwalam/posting/youtube-refresh/<id>. The OAuth client (id and
// secret) is shared, so all channels share one Google Cloud project and its one daily quota (YM5).
// YM4 pick rule (user 2026-11-25: "take turns"): clips are dealt main, A, B, main, A, B... in queue order; a channel that
// reached its count for the day, is off, paused or not signed in is skipped; an added channel takes Shorts only.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REFRESH_TARGET } from './oauth.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_CHANNELS = path.join(REPO, 'data', 'posting', 'channels.json');
export const ACCOUNTS_NAME = 'accounts.json';
export const CHANNEL_STATE_NAME = 'channel-state.json';
export const MAIN = 'main';
export const ID_RE = /^ch-[a-z0-9]{6,12}$/;
const DAY_MS = 24 * 3600 * 1000;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const clean = (s, n = 80) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');

function writeJsonAtomic(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
}

/** The shipped defaults (data/posting/channels.json). Throws when the file is missing or not valid (fail closed). */
export function loadChannelDefaults(file = DEFAULT_CHANNELS) {
  const j = readJson(file);
  const n = j?.newChannel;
  const lim = j?.postsPerDayLimit; const max = j?.maxChannels;
  const ok = isPlain(n) && Number.isInteger(n.postsPerDayMin) && Number.isInteger(n.postsPerDayMax) && n.postsPerDayMin >= 1
    && n.postsPerDayMin <= n.postsPerDayMax && Number.isInteger(lim) && n.postsPerDayMax <= lim && Number.isInteger(max) && max >= 1;
  if (!ok) throw Object.assign(new Error('data/posting/channels.json is not valid'), { code: 'channels-config-bad' });
  return { postsPerDay: { min: n.postsPerDayMin, max: n.postsPerDayMax }, shortsOnly: n.shortsOnly !== false, postsPerDayLimit: lim, maxChannels: max };
}

/** The Credential Manager target of a channel's refresh token. `main` keeps the target used before YM1. */
export function refreshTargetFor(id) {
  if (id === MAIN) return REFRESH_TARGET;
  if (!ID_RE.test(String(id))) throw Object.assign(new Error('not a channel id'), { code: 'bad-channel-id' });
  return `${REFRESH_TARGET}/${id}`;
}

export const newChannelId = (rand = randomBytes) => `ch-${rand(5).toString('hex')}`;

const MAIN_DEFAULT = Object.freeze({ id: MAIN, label: 'Main channel', enabled: true, addedAt: null });

function cleanAccount(a) {
  if (!isPlain(a)) return null;
  const id = a.id === MAIN ? MAIN : ID_RE.test(String(a.id)) ? a.id : null;
  if (!id) return null;
  const out = { id, label: clean(a.label) || (id === MAIN ? MAIN_DEFAULT.label : 'YouTube channel'), enabled: a.enabled !== false,
    addedAt: typeof a.addedAt === 'string' ? a.addedAt : null };
  for (const k of ['channelId', 'title', 'handle']) if (typeof a[k] === 'string' && a[k]) out[k] = clean(a[k], 120);
  const p = a.postsPerDay;
  if (isPlain(p) && Number.isInteger(p.min) && Number.isInteger(p.max) && p.min >= 1 && p.min <= p.max) out.postsPerDay = { min: p.min, max: p.max };
  if (id !== MAIN) out.shortsOnly = a.shortsOnly !== false;
  return out;
}

/** The channel list. No file (every install before YM1) = main only. `main` is always there and always first. */
export function readAccounts(dataDir) {
  const j = readJson(path.join(dataDir, 'posting', ACCOUNTS_NAME));
  const list = (isPlain(j) && Array.isArray(j.accounts) ? j.accounts : []).map(cleanAccount).filter(Boolean);
  const seen = new Set(); const accounts = [];
  for (const a of list) { if (seen.has(a.id)) continue; seen.add(a.id); accounts.push(a); }
  const main = accounts.find((a) => a.id === MAIN) ?? { ...MAIN_DEFAULT };
  return { version: 1, accounts: [main, ...accounts.filter((a) => a.id !== MAIN)] };
}

/** Read-change-write of the channel list (the studio server is its only writer). fn(doc) changes doc in place. */
export function updateAccounts(dataDir, fn) {
  const doc = readAccounts(dataDir);
  const r = fn(doc);
  writeJsonAtomic(path.join(dataDir, 'posting', ACCOUNTS_NAME), { version: 1, accounts: doc.accounts.map(cleanAccount).filter(Boolean) });
  return r;
}

/** The chain's own state (turn, pauses). Written by the posting chain only; the studio reads it. */
export function readChannelState(dataDir) {
  const j = readJson(path.join(dataDir, 'posting', CHANNEL_STATE_NAME));
  const paused = {};
  if (isPlain(j?.paused)) for (const [id, p] of Object.entries(j.paused)) if (isPlain(p) && typeof p.until === 'string' && Number.isFinite(Date.parse(p.until))) paused[id] = { until: p.until, reason: clean(p.reason, 40) };
  return { version: 1, turn: typeof j?.turn === 'string' ? j.turn : null, paused };
}
export function writeChannelState(dataDir, s) { writeJsonAtomic(path.join(dataDir, 'posting', CHANNEL_STATE_NAME), s); }
/** The pause of a channel that still holds at nowMs, or null. */
export function pausedNow(state, id, nowMs) {
  const p = state?.paused?.[id];
  return p && Date.parse(p.until) > nowMs ? p : null;
}

/** YM1: a queue item's channel. No field (made before YM1) = main; null = in the pool, not given to a channel yet. */
export const accountOf = (item) => (item?.account === undefined ? MAIN : item.account);

export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const nextUtcMidnight = (ms) => (Math.floor(ms / DAY_MS) + 1) * DAY_MS;

/** YM3: the channel's number of uploads for this UTC day: a whole number in its postsPerDay range, picked from the
 *  channel id and the day (the same all day, different between days and channels). null = no own count (main). Pure. */
export function dayCap(account, day) {
  const p = account?.postsPerDay;
  if (!isPlain(p) || !Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min > p.max) return null;
  const h = createHash('sha256').update(`${account.id}:${day}`).digest().readUInt32BE(0);
  return p.min + (h % (p.max - p.min + 1));
}

/** Uploads a channel finished in the UTC day of nowMs (doneAt), plus the one uploading now. Pure. */
export function doneToday(items, id, nowMs) {
  const day = utcDay(nowMs);
  return items.filter((i) => accountOf(i) === id && (i.state === 'uploading' || (i.state === 'done' && typeof i.doneAt === 'string' && i.doneAt.slice(0, 10) === day))).length;
}
/** Items given to a channel that are still waiting (queued). Pure. */
export const waitingOf = (items, id) => items.filter((i) => accountOf(i) === id && i.state === 'queued').length;

/**
 * YM4: deals the pool (in queue order) to the channels in turn. channels: [{ id, room (number | Infinity), shortsOnly }]
 * in list order (main first), only the ones that may take a clip now. A channel with no room left is skipped; a
 * shorts-only channel skips anything but youtube-shorts. A clip no channel can take stays in the pool. turn: the id of
 * the channel whose turn it is (null = the first). -> { assign: [[itemId, channelId]], turn }. Pure.
 */
export function dealPool({ pool, channels, turn = null }) {
  const ch = channels.map((c) => ({ ...c }));
  const assign = [];
  if (!ch.length) return { assign, turn };
  let at = Math.max(0, ch.findIndex((c) => c.id === turn));
  for (const it of pool) {
    for (let k = 0; k < ch.length; k++) {
      const n = (at + k) % ch.length; const c = ch[n];
      if (!(c.room > 0)) continue;
      if (c.shortsOnly && it.target !== 'youtube-shorts') continue;
      assign.push([it.id, c.id]); c.room -= 1; at = (n + 1) % ch.length;
      break;
    }
  }
  return { assign, turn: ch[at].id };
}

/** A label to show for a channel id ('' = the pool). */
export function channelLabel(accounts, id) {
  if (id === null || id === '') return 'Not given to a channel yet';
  const a = accounts.find((x) => x.id === id);
  return a ? a.label : 'Removed channel';
}
