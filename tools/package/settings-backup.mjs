#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Settings backup for installs, updates and rollbacks (2026-11-18, setup installer). Install-Ujwalam.ps1 runs it with
// the Node.js the studio needs anyway; it only reads and copies, it never edits a setting.
//
//   node settings-backup.mjs backup  --data <data root> --from <ver|none> --to <ver> --reason update|repair|before-rollback [--keep 10]
//   node settings-backup.mjs restore --data <data root> --from <ver> --to <ver>    (rollback: the backup taken when <to> handed over to <from>)
//   node settings-backup.mjs verify  --data <data root> --backup <folder>          (after an install: every backed-up file is still there)
//
// What a backup holds (settings and project files, never media): every *.json and *.key file under the data root
// (projects and projects/_old, flags, settings, host config, bots, outputs, posting and clip records, ujwalam.json,
// profile.local.json), the projects' *.bak files, and a consistent copy of core/event-core.db (SQLite VACUUM INTO, safe
// while the studio runs). Skipped: logs, live state, diagnostics, feedback, the backups themselves, the API token file
// (core/api.json, made fresh at each start) and any file over 4 MiB. Stream keys stay in Windows Credential Manager: a
// backup lists only a hash of each target name under Ujwalam/ (never a secret, never the name) so a later check can
// say they are still there.
//
// Backups go to <data root>/backups/settings/<UTC time>-<reason>-<from>-to-<to>/ with backup.json; the newest `keep`
// are kept. A restore first takes a before-rollback backup of the current files, then copies the old ones back (each
// through a temp file and one rename). For the database it moves the current event-core.db-wal and -shm into that
// before-rollback backup (they belong to the newer database), so nothing is deleted.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/');

/** True for a data-root relative path that belongs in a settings backup (pure; tested). */
export function wanted(r, size = 0) {
  if (SKIP_FILES.includes(r) || size > MAX_FILE) return false;
  if (SKIP_DIRS.some((d) => r === d || r.startsWith(`${d}/`))) return false;
  if (/\.(json|key)$/i.test(r)) return true;
  return /^core\/projects\/.+\.bak$/i.test(r);
}

/** The data-root relative paths of every file a backup takes (the database is listed separately). */
export function settingsFiles(dataRoot) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      const r = rel(dataRoot, f);
      if (e.isDirectory()) { if (!SKIP_DIRS.includes(r)) walk(f); continue; }
      if (!e.isFile()) continue;
      let size = 0;
      try { size = statSync(f).size; } catch { continue; }
      if (wanted(r, size)) out.push(r);
    }
  };
  walk(dataRoot);
  return out.sort();
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

function snapshotDb(src, dest) {
  // A consistent copy even while event core writes (a reader's snapshot); the original is opened read-only.
  return import('node:sqlite').then(({ DatabaseSync }) => {
    const db = new DatabaseSync(src, { readOnly: true });
    try { db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); } finally { db.close(); }
  });
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

/** Keeps the newest `keep` backups; removes only folders that match the backup name pattern. Returns removed names. */
export function prune(dataRoot, keep = KEEP) {
  const old = listBackups(dataRoot).slice(Math.max(1, keep));
  for (const b of old) rmSync(b.dir, { recursive: true, force: true, maxRetries: 3 });
  return old.map((b) => b.name);
}

/**
 * Takes a backup. Returns { dir, files, db, credentials, bytes }. Throws when a file cannot be copied (the caller
 * stops the install: an update never goes ahead without its backup).
 */
export async function backup({ dataRoot, from, to, reason, keep = KEEP, now = () => new Date(), creds = credentialTargets }) {
  if (!REASONS.includes(reason)) throw new Error(`reason must be one of ${REASONS.join(', ')}`);
  if (!VERSION_RE.test(to) || !(from === 'none' || VERSION_RE.test(from))) throw new Error('from/to must be versions like 0.1.0-alpha.N');
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
    for (const r of settingsFiles(dataRoot)) {
      const src = path.join(dataRoot, ...r.split('/'));
      const dest = path.join(partial, 'files', ...r.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      try { copyFileSync(src, dest); } catch (e) { if (e.code === 'ENOENT') continue; throw e; } // removed meanwhile: not a setting any more
      const size = statSync(dest).size;
      bytes += size;
      files.push({ path: r, size, sha256: sha256(dest) });
    }
    let db = null;
    const dbFile = path.join(dataRoot, ...DB.split('/'));
    if (existsSync(dbFile)) {
      const dest = path.join(partial, 'files', ...DB.split('/'));
      mkdirSync(path.dirname(dest), { recursive: true });
      await snapshotDb(dbFile, dest);
      db = { path: DB, size: statSync(dest).size, sha256: sha256(dest) };
      bytes += db.size;
    }
    const credentials = creds();
    const info = { v: 1, at: now().toISOString(), reason, from, to, files, db, credentials };
    writeFileSync(path.join(partial, 'backup.json'), `${JSON.stringify(info, null, 2)}\n`);
    renameSync(partial, dir);
    const removed = prune(dataRoot, keep);
    return { dir, name, files: files.length, db: !!db, credentials: credentials ? credentials.length : null, bytes, removed };
  } catch (e) {
    rmSync(partial, { recursive: true, force: true, maxRetries: 3 });
    throw e;
  }
}

function replaceFile(src, dest) {
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.restore-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

/**
 * Rollback from version `from` back to `to`: finds the newest update backup taken when `to` was updated to `from`,
 * takes a before-rollback backup of the current files, then puts the backed-up files back. Returns
 * { restored, kept: before-rollback folder, source } or { restored: 0, reason } when there is no such backup.
 */
export async function restore({ dataRoot, from, to, now = () => new Date(), creds = credentialTargets }) {
  // The newest backup taken while `to` was the version in use, right before `from` took over: an update backup, or the
  // before-rollback backup of an earlier rollback (so rolling forward again brings the newer settings back).
  const src = listBackups(dataRoot).find((b) => b.reason !== 'install' && b.from === to && b.to === from);
  if (!src) return { restored: 0, reason: `no settings backup from the update ${to} -> ${from}` };
  const info = JSON.parse(readFileSync(path.join(src.dir, 'backup.json'), 'utf8'));
  const before = await backup({ dataRoot, from, to, reason: 'before-rollback', keep: Number.MAX_SAFE_INTEGER, now, creds });
  let restored = 0;
  for (const f of info.files) {
    if (typeof f.path !== 'string' || !wanted(f.path) || f.path.split('/').includes('..')) continue;
    const s = path.join(src.dir, 'files', ...f.path.split('/'));
    if (!existsSync(s) || sha256(s) !== f.sha256) throw new Error(`backup file changed or missing: ${f.path}`);
    replaceFile(s, path.join(dataRoot, ...f.path.split('/')));
    restored++;
  }
  if (info.db && info.db.path === DB) {
    const s = path.join(src.dir, 'files', ...DB.split('/'));
    if (!existsSync(s) || sha256(s) !== info.db.sha256) throw new Error('backup database changed or missing');
    const live = path.join(dataRoot, ...DB.split('/'));
    // The newer database's write-ahead log would be applied to the restored file: move it (and the index) aside.
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(live + ext)) {
        const keep = path.join(before.dir, 'files', ...`${DB}${ext}`.split('/'));
        mkdirSync(path.dirname(keep), { recursive: true });
        renameSync(live + ext, keep);
      }
    }
    replaceFile(s, live);
    restored++;
  }
  prune(dataRoot, KEEP);
  return { restored, kept: before.dir, source: src.dir };
}

/** After an install: every file in the backup is still in the data root, and every stream key name is still there. */
export function verify({ dataRoot, backupDir, creds = credentialTargets }) {
  const info = JSON.parse(readFileSync(path.join(backupDir, 'backup.json'), 'utf8'));
  const missing = info.files.filter((f) => !existsSync(path.join(dataRoot, ...f.path.split('/')))).map((f) => f.path);
  if (info.db && !existsSync(path.join(dataRoot, ...DB.split('/')))) missing.push(DB);
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
    const r = await backup({ dataRoot, from: a.from, to: a.to, reason: a.reason, keep: a.keep ? Number(a.keep) : KEEP });
    console.log(`settings backup: ${r.files} files${r.db ? ' and the event database' : ''} (${(r.bytes / 1024).toFixed(0)} KiB) in ${r.dir}`);
    if (r.credentials !== null) console.log(`stream keys and sign-ins in Windows Credential Manager: ${r.credentials} (names checked, never read)`);
    console.log(`backup-dir=${r.dir}`);
    return 0;
  }
  if (a._ === 'restore') {
    const r = await restore({ dataRoot, from: a.from, to: a.to });
    if (!r.source) { console.log(`settings: not restored (${r.reason}); your current settings stay as they are`); return 0; }
    console.log(`settings: ${r.restored} files put back from ${r.source}`);
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
