// SPDX-License-Identifier: GPL-3.0-or-later
// D403 The random-daily schedule's seed. The plan (how many posts each day, at which times, and the backlog order) comes
// from one seeded RNG, so it is the same on every pass and after a restart. The seed is made once, at random, and saved
// in the user's own schedule settings (<data>/posting/schedule.json, key seed); nothing else in that file changes.
// Node stdlib only. Writes atomically (temp file + rename).
import { randomInt } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { userScheduleFile } from './schedule.mjs';

/** The saved seed, or a new one saved now. A user file that cannot be read is left alone (the schedule then refuses it
 *  anyway, fail closed) and null is returned. */
export function ensureScheduleSeed(dataDir, { make = () => randomInt(0, 2147483647) } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) return null;
  const file = userScheduleFile(dataDir);
  let j = {};
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e?.code !== 'ENOENT') return null; j = {}; }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return null;
  if (Number.isInteger(j.seed) && j.seed >= 0 && j.seed <= 2147483647) return j.seed;
  const seed = make();
  const out = { ...(j.$comment ? {} : { $comment: 'Your posting schedule (Settings > Posting & growth > Auto-post, D375, D403). Replaces the shipped values in data/posting/schedule.json and data/posting/quota.json.' }), ...j, seed };
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, file);
  return seed;
}
