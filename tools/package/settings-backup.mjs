#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Settings backup for installs, updates and rollbacks (2026-11-18, setup installer). Install-Ujwalam.ps1 runs it with
// the Node.js the studio needs anyway; a backup only reads and copies, it never edits a setting.
//
//   node settings-backup.mjs backup  --data <data root> --from <ver|none> --to <ver> --reason update|repair|install
//                                    [--keep 10] [--pin-from <ver> --pin-to <ver>]
//   node settings-backup.mjs restore --data <data root> --from <ver> --to <ver>    (rollback: the backup taken when <to> handed over to <from>)
//   node settings-backup.mjs verify  --data <data root> --backup <folder>          (after an install: every backed-up file is still there)
//   exit codes: 0 done, 1 failed (nothing changed, or an interrupted change undone), 3 restore: no snapshot for that rollback
//
// What a backup holds (settings and project files, never media): every *.json and *.key file under the data root
// (projects and projects/_old, flags, settings, host config, bots, outputs, posting and clip records, ujwalam.json,
// profile.local.json), the projects' *.bak files, and a consistent copy of core/event-core.db (SQLite VACUUM INTO, safe
// while the studio runs). Skipped: logs, live state, diagnostics, feedback, the backups themselves, the API token file
// (core/api.json, made fresh at each start). A settings file over 4 MiB is not copied and is named in the output (it
// stays as it is on a rollback). A folder that cannot be read stops the backup (it could hold settings). Stream keys
// stay in Windows Credential Manager: a backup lists only a hash of each target name under Ujwalam/ (never a secret,
// never the name) so a later check can say they are still there. Files are read with Node's shared-delete open, so a
// backup never blocks the running studio from replacing a file.
//
// Backups go to <data root>/backups/settings/<UTC time>-<reason>-<from>-to-<to>/ with backup.json. The newest `keep` are
// kept, and always the newest snapshot a rollback or a roll-forward of the current pair needs (the pin), however many
// repairs came after it (Codex review 2026-11-18).
//
// A restore (rollback) is all or nothing (Codex review 2026-11-18):
//   1. the whole snapshot is checked first (every file's SHA-256); a bad snapshot changes nothing;
//   2. the event database is checkpointed (its write-ahead log folded into the file) and closed, so no committed row
//      lives only in event-core.db-wal;
//   3. a before-rollback backup of the current files is taken (it is what a roll-forward restores);
//   4. the snapshot is copied into a staging folder next to the backups and checked again;
//   5. each file is swapped in with one rename, the current one moved aside first, following a journal. Any error undoes
//      the swaps done so far; an interrupted restore (power loss) is undone by the next backup or restore run.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KEEP = 10;
export const MAX_FILE = 4 * 1024 * 1024;
export const DB = 'core/event-core.db';
// Folders (data-root relative, '/' separators) that never go into a settings backup.
export const SKIP_DIRS = Object.freeze(['backups', 'diag', 'feedback', 'core/logs', 'host/logs', 'core/live', 'host/live', 'core/live-clips']);
export const SKIP_FILES = Object.freeze(['core/api.json']);
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+$/;
const REASONS = ['update', 'repair', 'before-rollback', 'install'];
const NAME_RE = /^(\d{8}T\d{6}(?:\d{3})?Z)-(update|repair|before-rollback|install)-(none|[0-9.]+-alpha\.\d+)-to-([0-9.]+-alpha\.\d+)$/;
const RESTORE_RE = /^\.restore-\d+-\d+$/;

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');
const abs = (root, r) => path.join(root, ...r.split('/'));
const safeRel = (r) => typeof r === 'string' && r !== '' && !r.split('/').some((p) => p === '..' || p === '' || p.includes(':') || p.includes('\\'));

/** The settings file kind and place, ignoring size (pure; tested). */
function settingsKind(r) {
  if (SKIP_FILES.includes(r)) return false;
  if (SKIP_DIRS.some((d) => r === d || r.startsWith(`${d}/`))) return false;
  if (/\.(json|key)$/i.test(r)) return true;
  return /^core\/projects\/.+\.bak$/i.test(r);
}

/** True for a data-root relative path that belongs in a settings backup (pure; tested). */
export function wanted(r, size = 0) {
  return settingsKind(r) && size <= MAX_FILE;
}

/**
 * The data-root relative paths a backup takes (the database is listed separately), the settings files left out
 * ({ path, why }) and the folders that could not be read.
 */
export function scanSettings(dataRoot) {
  const files = [];
  const skipped = [];
  const unreadable = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) {
      if (dir === dataRoot && e.code === 'ENOENT') return;
      unreadable.push(`${rel(dataRoot, dir) || '.'} (${e.code ?? e.message})`);
      return;
    }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      const r = rel(dataRoot, f);
      if (e.isDirectory()) { if (!SKIP_DIRS.includes(r) && !(r.startsWith('backups/'))) walk(f); continue; }
      if (!e.isFile() || !settingsKind(r)) continue;
      let size;
      try { size = statSync(f).size; } catch (err) { unreadable.push(`${r} (${err.code ?? err.message})`); continue; }
      if (size > MAX_FILE) skipped.push({ path: r, why: `${(size / 1048576).toFixed(1)} MiB, over the 4 MiB limit` });
      else files.push(r);
    }
  };
  walk(dataRoot);
  return { files: files.sort(), skipped, unreadable };
}

/** The data-root relative paths of every file a backup takes (the database is listed separately). */
export function settingsFiles(dataRoot) {
  return scanSettings(dataRoot).files;
}

/**
 * The target names under Ujwalam/ in Windows Credential Manager, each as a SHA-256 of the name (a name can hold a
 * channel name, so it is never written down; never a secret); null when unknown.
 */
export function credentialTargets({ run = spawnSync } = {}) {
  if (process.platform !== 'win32') return null;
  try {
    const r = run('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    const names = new Set([...r.stdout.matchAll(/target=(Ujwalam\/[^\s]+)/gi)].map((m) => m[1]));
    return [...names].map((n) => createHash('sha256').update(n).digest('hex')).sort();
  } catch { return null; }
}

async function sqlite() { return (await import('node:sqlite')).DatabaseSync; }

async function snapshotDb(src, dest) {
  // A consistent copy even while event core writes (a reader's snapshot, the write-ahead log included); the original
  // is opened read-only.
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(src, { readOnly: true });
  try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
}

/** Folds the write-ahead log into event-core.db and closes it (a rollback runs only while Ujwalam is closed). */
async function checkpointDb(file) {
  const DatabaseSync = await sqlite();
  const db = new DatabaseSync(file);
  try {
    const r = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (r && r.busy) throw new Error('the event database is in use (is Ujwalam still running?)');
  } finally { db.close(); }
  const wal = `${file}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) throw new Error('the event database log could not be folded in (is Ujwalam still running?)');
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');

/** Backup folders, newest first: [{ name, dir, at, reason, from, to }]. */
export function listBackups(dataRoot) {
  const base = path.join(dataRoot, 'backups', 'settings');
  let names = [];
  try { names = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
  return names.map((name) => { const m = NAME_RE.exec(name); return m && { name, dir: path.join(base, name), at: m[1], reason: m[2], from: m[3], to: m[4] }; })
    .filter((b) => b && existsSync(path.join(b.dir, 'backup.json')))
    .sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
}

/** The snapshot a switch from `from` back to `to` restores: taken while `to` was in use, right before `from` took over. */
export function findSnapshot(dataRoot, from, to) {
  return listBackups(dataRoot).find((b) => b.reason !== 'install' && b.from === to && b.to === from) ?? null;
}

/**
 * Keeps the newest `keep` backups and the snapshot each pin needs ({ from, to }: the pair a later rollback or
 * roll-forward switches between; the newest non-install backup taken from `from` to `to`). Removes only folders that
 * match the backup name pattern. Returns the removed names.
 */
export function prune(dataRoot, keep = KEEP, pins = []) {
  const all = listBackups(dataRoot);
  const pinned = new Set(pins.filter((p) => p && p.from && p.to).map((p) => all.find((b) => b.reason !== 'install' && b.from === p.from && b.to === p.to)?.name).filter(Boolean));
  const old = all.slice(Math.max(1, keep)).filter((b) => !pinned.has(b.name));
  for (const b of old) rmSync(b.dir, { recursive: true, force: true, maxRetries: 3 });
  return old.map((b) => b.name);
}

/** Copies through Node's own open (shares delete: the studio can still rename over the source meanwhile). */
function copyShared(src, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src));
}

/**
 * Undoes a restore that was interrupted (its journal is still "swapping"), or removes the staging folder of one that
 * finished. Runs at the start of every backup and restore. Returns the number of folders handled.
 */
export function recover(dataRoot) {
  const base = path.join(dataRoot, 'backups', 'settings');
  let names = [];
  try { names = readdirSync(base).filter((n) => RESTORE_RE.test(n)); } catch { return 0; }
  for (const n of names) {
    const dir = path.join(base, n);
    let j = null;
    try { j = JSON.parse(readFileSync(path.join(dir, 'journal.json'), 'utf8')); } catch { /* staged only: nothing swapped */ }
    if (j && j.state === 'swapping') undoSwaps(dataRoot, dir, j.items);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
  return names.length;
}

// Puts back every file a restore moved aside (items: { path, hadOld }), newest first; a file the restore added is removed.
function undoSwaps(dataRoot, dir, items) {
  for (const it of [...items].reverse()) {
    if (!safeRel(it.path)) continue;
    const live = abs(dataRoot, it.path);
    const old = abs(path.join(dir, 'old'), it.path);
    if (it.hadOld) { if (existsSync(old)) renameSync(old, live); } else if (it.swapped) rmSync(live, { force: true });
  }
}

/**
 * Takes a backup. Returns { dir, files, db, credentials, bytes, skipped, removed }. Throws when a file cannot be copied
 * or a folder cannot be read (the caller stops the install: an update never goes ahead without its backup).
 */
export async function backup({ dataRoot, from, to, reason, keep = KEEP, pins = [], now = () => new Date(), creds = credentialTargets }) {
  if (!REASONS.includes(reason)) throw new Error(`reason must be one of ${REASONS.join(', ')}`);
  if (!VERSION_RE.test(to) || !(from === 'none' || VERSION_RE.test(from))) throw new Error('from/to must be versions like 0.1.0-alpha.N');
  recover(dataRoot);
  const scan = scanSettings(dataRoot);
  if (scan.unreadable.length) throw new Error(`cannot read ${scan.unreadable.slice(0, 5).join(', ')}: they could hold settings`);
  const base = path.join(dataRoot, 'backups', 'settings');
  let name = `${stamp(now())}-${reason}-${from}-to-${to}`;
  for (let i = 2; existsSync(path.join(base, name)); i++) name = `${stamp(new Date(now().getTime() + i))}-${reason}-${from}-to-${to}`;
  const dir = path.join(base, name);
  const partial = `${dir}.partial`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  const files = [];
  let bytes = 0;
  try {
    for (const r of scan.files) {
      const dest = abs(path.join(partial, 'files'), r);
      try { copyShared(abs(dataRoot, r), dest); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } // removed meanwhile: not a setting any more
      const size = statSync(dest).size;
      bytes += size;
      files.push({ path: r, size, sha256: sha256(dest) });
    }
    let db = null;
    const dbFile = abs(dataRoot, DB);
    if (existsSync(dbFile)) {
      const dest = abs(path.join(partial, 'files'), DB);
      mkdirSync(path.dirname(dest), { recursive: true });
      await snapshotDb(dbFile, dest);
      db = { path: DB, size: statSync(dest).size, sha256: sha256(dest) };
      bytes += db.size;
    }
    const credentials = creds();
    const info = { v: 1, at: now().toISOString(), reason, from, to, files, db, credentials, skipped: scan.skipped };
    writeFileSync(path.join(partial, 'backup.json'), `${JSON.stringify(info, null, 2)}\n`);
    renameSync(partial, dir);
    const removed = prune(dataRoot, keep, pins);
    return { dir, name, files: files.length, db: !!db, credentials: credentials ? credentials.length : null, bytes, skipped: scan.skipped, removed };
  } catch (e) {
    rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
    throw e;
  }
}

/**
 * Rollback from version `from` back to `to` (all or nothing; see the top of the file). Returns
 * { restored, kept: before-rollback folder, source } or { restored: 0, missing: true, reason } when there is no snapshot
 * (nothing changed). Throws when the snapshot is damaged or a step fails (nothing changed, or every swap undone).
 */
export async function restore({ dataRoot, from, to, now = () => new Date(), creds = credentialTargets, failAt = null }) {
  recover(dataRoot);
  const src = findSnapshot(dataRoot, from, to);
  if (!src) return { restored: 0, missing: true, reason: `no settings snapshot from the update ${to} -> ${from}` };
  const info = JSON.parse(readFileSync(path.join(src.dir, 'backup.json'), 'utf8'));
  // 1. The whole snapshot first.
  const items = [];
  for (const f of info.files ?? []) {
    if (!safeRel(f.path) || !settingsKind(f.path)) throw new Error(`backup lists a path it may not restore: ${f.path}`);
    items.push(f);
  }
  if (info.db) {
    if (info.db.path !== DB) throw new Error(`backup lists a database it may not restore: ${info.db.path}`);
    items.push(info.db);
  }
  for (const f of items) {
    const s = abs(path.join(src.dir, 'files'), f.path);
    if (!existsSync(s) || sha256(s) !== f.sha256) throw new Error(`backup file changed or missing: ${f.path}`);
  }
  // 2. The current database: its log folded in, closed.
  const liveDb = abs(dataRoot, DB);
  if (info.db && existsSync(liveDb)) await checkpointDb(liveDb);
  // 3. Before-rollback backup (taken now: the roll-forward snapshot; pinned so later backups never evict it).
  const before = await backup({ dataRoot, from, to, reason: 'before-rollback', keep: Number.MAX_SAFE_INTEGER, now, creds });
  // 4. Stage.
  const stage = path.join(dataRoot, 'backups', 'settings', `.restore-${process.pid}-${now().getTime()}`);
  mkdirSync(stage);
  const journalFile = path.join(stage, 'journal.json');
  try {
    for (const f of items) {
      const dest = abs(path.join(stage, 'new'), f.path);
      copyShared(abs(path.join(src.dir, 'files'), f.path), dest);
      if (sha256(dest) !== f.sha256) throw new Error(`staged copy differs: ${f.path}`);
    }
  } catch (e) { rmSync(stage, { recursive: true, force: true, maxRetries: 3 }); throw e; }
  // The database's -wal and -shm (empty after the checkpoint) move aside with it: they belong to the newer file.
  const extra = info.db ? [`${DB}-wal`, `${DB}-shm`].filter((r) => existsSync(abs(dataRoot, r))) : [];
  const plan = [...items.map((f) => ({ path: f.path, hadOld: existsSync(abs(dataRoot, f.path)), replace: true })),
    ...extra.map((r) => ({ path: r, hadOld: true, replace: false }))];
  const journal = { v: 1, state: 'swapping', items: plan.map((p) => ({ path: p.path, hadOld: p.hadOld, swapped: false })) };
  const save = () => writeFileSync(journalFile, `${JSON.stringify(journal)}\n`);
  save();
  // 5. Swap, one rename per file; any error undoes the swaps done so far.
  try {
    plan.forEach((p, i) => {
      if (failAt === i) throw new Error('test: failure during the swap');
      const live = abs(dataRoot, p.path);
      if (p.hadOld) { const old = abs(path.join(stage, 'old'), p.path); mkdirSync(path.dirname(old), { recursive: true }); renameSync(live, old); }
      journal.items[i].swapped = true;
      save();
      if (p.replace) { mkdirSync(path.dirname(live), { recursive: true }); renameSync(abs(path.join(stage, 'new'), p.path), live); }
    });
  } catch (e) {
    undoSwaps(dataRoot, stage, journal.items.filter((x) => x.swapped));
    rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(`settings were not put back, everything stays as it was (${e.message})`);
  }
  journal.state = 'done';
  save();
  rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
  prune(dataRoot, KEEP, [{ from, to }]);
  return { restored: items.length, kept: before.dir, source: src.dir, skipped: info.skipped ?? [] };
}

/** After an install: every file in the backup is still in the data root, and every stream key name is still there. */
export function verify({ dataRoot, backupDir, creds = credentialTargets }) {
  const info = JSON.parse(readFileSync(path.join(backupDir, 'backup.json'), 'utf8'));
  const missing = info.files.filter((f) => !existsSync(abs(dataRoot, f.path))).map((f) => f.path);
  if (info.db && !existsSync(abs(dataRoot, DB))) missing.push(DB);
  const now = Array.isArray(info.credentials) ? creds() : null;
  const credsGone = now ? info.credentials.filter((t) => !now.includes(t)).length : 0;
  return { files: info.files.length + (info.db ? 1 : 0), missing, credentials: Array.isArray(info.credentials) ? info.credentials.length : null, credentialsGone: credsGone };
}

function args(argv) {
  const o = { _: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`);
    o[argv[i].slice(2)] = argv[++i];
  }
  return o;
}

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  if (!a.data) throw new Error('--data is required');
  const dataRoot = path.resolve(a.data);
  if (a._ === 'backup') {
    const pins = a['pin-from'] && a['pin-to'] ? [{ from: a['pin-from'], to: a['pin-to'] }] : [];
    const r = await backup({ dataRoot, from: a.from, to: a.to, reason: a.reason, keep: a.keep ? Number(a.keep) : KEEP, pins });
    console.log(`settings backup: ${r.files} files${r.db ? ' and the event database' : ''} (${(r.bytes / 1024).toFixed(0)} KiB) in ${r.dir}`);
    for (const s of r.skipped) console.log(`settings: NOT in the backup: ${s.path} (${s.why}); it stays as it is, a rollback does not change it`);
    if (r.credentials !== null) console.log(`stream keys and sign-ins in Windows Credential Manager: ${r.credentials} (names checked, never read)`);
    console.log(`backup-dir=${r.dir}`);
    return 0;
  }
  if (a._ === 'restore') {
    const r = await restore({ dataRoot, from: a.from, to: a.to });
    if (r.missing) { console.log(`settings: ${r.reason}; nothing was changed`); return 3; }
    console.log(`settings: ${r.restored} files put back from ${r.source}`);
    for (const s of r.skipped) console.log(`settings: ${s.path} was not in that backup (${s.why}); it stays as it is`);
    console.log(`settings: the newer copies are kept in ${r.kept}`);
    return 0;
  }
  if (a._ === 'verify') {
    const r = verify({ dataRoot, backupDir: path.resolve(a.backup) });
    if (r.missing.length) { console.log(`settings: ${r.missing.length} of ${r.files} files are missing after the install: ${r.missing.slice(0, 10).join(', ')}`); return 1; }
    console.log(`settings kept: all ${r.files} files are in place${r.credentials !== null ? `; stream keys and sign-ins: ${r.credentials - r.credentialsGone} of ${r.credentials} still in Credential Manager` : ''}`);
    return r.credentialsGone ? 1 : 0;
  }
  throw new Error('usage: settings-backup.mjs backup|restore|verify --data <dir> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.log(`settings: FAILED: ${e.message}`); process.exit(1); });
}
