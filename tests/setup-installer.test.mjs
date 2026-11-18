// SPDX-License-Identifier: GPL-3.0-or-later
// Setup installer (2026-11-18): settings safety across install, update, repair, rollback and uninstall; Ujwalam-Setup.exe
// end to end; the studio's "Update available" route. Everything runs in temp folders with an install-root override,
// never against the user's install; no window (windowsHide, Setup --quiet), no device, no stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SETUP_EXE } from '../app/setup/tools/build.mjs';
import { backup, listBackups, prune, restore, settingsFiles, verify, wanted } from '../tools/package/settings-backup.mjs';
import { writeZip } from '../tools/package/zip.mjs';
import { cmpVersion, createSetupUpdate, newestPackage } from '../services/studio-ui/setup-update.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICO = path.join(REPO, 'app', 'studio', 'res', 'ujwalam.ico');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-setup-${p}-`));
const noCreds = () => null;
const A = '0.1.0-alpha.1';
const B = '0.1.0-alpha.2';

// ---- a user's data folder: one file of every kind of setting, plus things a settings backup must leave out ----------

const SETTINGS = {
  'core/settings.json': { clips: { recording: 'on', live: 'while' }, folders: { recordings: 'E:\\Rec' } },
  'core/flags.local.json': { 'service-swap': true },
  'core/host-config.json': { video: { fps: 60 } },
  'core/stream-setup.json': { outputs: ['yt-h', 'yt-v'] },
  'core/connections.json': { twitch: { present: true } },
  'core/integrations.json': { streamerbot: { port: 8080 } },
  'core/system.json': { gpu: 'nvidia' },
  'core/projects/alpha.json': { version: 3, scenes: [{ id: 's1', name: 'Main' }] },
  'core/projects/_old/alpha.d391.json': { version: 2 },
  'core/outputs/rungs.json': { rungs: 2 },
  'core/posting/queue.json': { items: [] },
  'core/clips/s1/clip-1.json': { start: 10 },
  'host/outputs-params.json': { bitrate: 17000 },
  'host/obs-config/global.json': { a: 1 },
  'bots/streamerbot.json': { path: 'C:\\bots\\sb.exe' },
  'ujwalam.json': { overlayRoot: 'C:\\overlays', updateFolder: 'C:\\build\\out\\dist' },
  'profile.local.json': { brand: '<placeholder>' },
};
const OTHER = { // never in a settings backup, never touched by an install
  'core/projects/alpha.json.bak': 'project backup', // in: the projects' .bak files
  'core/pseudo.key': 'k1', // in: *.key
  'core/api.json': '{"port":1}', // out: the API file is made fresh at each start
  'core/logs/core.log': 'log', 'host/logs/host.log': 'log', 'core/live/state.json': '{}', 'feedback/2026-11-18.md': 'x', 'diag/d.zip': 'x',
  'core/clips/s1/clip-1.mp4': 'video', 'host/recordings/r.mkv': 'video',
};

function writeData(dataRoot, overrides = {}) {
  for (const [r, v] of Object.entries({ ...SETTINGS, ...overrides })) {
    const f = path.join(dataRoot, ...r.split('/'));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(v, null, 2));
  }
  for (const [r, v] of Object.entries(OTHER)) {
    const f = path.join(dataRoot, ...r.split('/'));
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, v);
  }
  const db = new DatabaseSync(path.join(dataRoot, 'core', 'event-core.db'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, what TEXT); PRAGMA user_version=5; INSERT INTO audit (what) VALUES ('a-1'), ('a-2');");
  return db; // left open: the studio holds it while running (WAL with -wal/-shm present)
}

/** Every file under dataRoot as { rel: sha256 } (the backups folder left out). */
function snapshot(dataRoot) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      const r = path.relative(dataRoot, f).split(path.sep).join('/');
      if (r === 'backups') continue;
      if (e.isDirectory()) walk(f);
      else if (!/event-core\.db(-wal|-shm)?$/.test(r)) out[r] = sha(readFileSync(f));
    }
  };
  walk(dataRoot);
  return out;
}

function dbRows(dataRoot) {
  const db = new DatabaseSync(path.join(dataRoot, 'core', 'event-core.db'), { readOnly: true });
  try { return { rows: db.prepare('SELECT what FROM audit ORDER BY id').all().map((r) => r.what), version: db.prepare('PRAGMA user_version').get().user_version }; } finally { db.close(); }
}

// ---- settings-backup.mjs ---------------------------------------------------------------------------------------------

test('settings backup: what is in (every setting, project, .bak and .key) and what is out (logs, live state, media, API token, big files)', () => {
  for (const r of Object.keys(SETTINGS)) assert.ok(wanted(r), r);
  for (const r of ['core/projects/alpha.json.bak', 'core/pseudo.key']) assert.ok(wanted(r), r);
  for (const r of ['core/api.json', 'core/logs/core.log', 'core/logs/x.json', 'host/logs/a.json', 'core/live/state.json', 'host/live/x.json', 'core/live-clips/x.json',
    'feedback/a.json', 'diag/a.json', 'backups/settings/x/backup.json', 'core/clips/s1/clip-1.mp4', 'host/recordings/r.mkv', 'core/event-core.db']) assert.ok(!wanted(r), r);
  assert.ok(!wanted('core/settings.json', 5 * 1024 * 1024), 'over 4 MiB');
  const d = tmp('files');
  try {
    writeData(d).close();
    assert.deepEqual(settingsFiles(d), [...Object.keys(SETTINGS), 'core/projects/alpha.json.bak', 'core/pseudo.key'].sort());
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('settings backup: update A -> B keeps every file; rollback B -> A puts A\'s settings and database back and keeps B\'s copies; rolling forward brings B\'s back; nothing deleted', async () => {
  const d = tmp('roundtrip');
  let db;
  try {
    db = writeData(d);
    const before = snapshot(d);
    let t = Date.parse('2026-11-18T10:00:00Z');
    const now = () => new Date(t += 1000);
    const b1 = await backup({ dataRoot: d, from: A, to: B, reason: 'update', now, creds: () => ['h1', 'h2'] });
    assert.equal(b1.files, Object.keys(SETTINGS).length + 2);
    assert.equal(b1.db, true, 'database snapshot taken while it is open in WAL mode');
    assert.equal(b1.credentials, 2);
    assert.deepEqual(snapshot(d), before, 'a backup changes nothing in the data folder');
    const info = JSON.parse(readFileSync(path.join(b1.dir, 'backup.json'), 'utf8'));
    assert.deepEqual(info.credentials, ['h1', 'h2'], 'only hashes of the target names');
    assert.ok(!existsSync(path.join(b1.dir, 'files', 'core', 'api.json')) && !existsSync(path.join(b1.dir, 'files', 'host', 'recordings')));
    assert.deepEqual(verify({ dataRoot: d, backupDir: b1.dir, creds: () => ['h1', 'h2'] }), { files: b1.files + 1, missing: [], credentials: 2, credentialsGone: 0 });
    assert.equal(verify({ dataRoot: d, backupDir: b1.dir, creds: () => ['h1'] }).credentialsGone, 1, 'a stream key name that went away is reported');

    // B runs: it migrates the project, changes a setting, adds a file and writes the database (schema 6).
    writeFileSync(path.join(d, 'core', 'projects', 'alpha.json'), JSON.stringify({ version: 4, scenes: [] }));
    writeFileSync(path.join(d, 'core', 'settings.json'), JSON.stringify({ clips: { recording: 'off' }, newInB: 1 }));
    writeFileSync(path.join(d, 'core', 'b-only.json'), '{"b":1}');
    db.exec("INSERT INTO audit (what) VALUES ('b-1'); PRAGMA user_version=6;");
    const bState = snapshot(d);
    db.close(); db = null; // a rollback never runs while Ujwalam runs

    const r = await restore({ dataRoot: d, from: B, to: A, now, creds: noCreds });
    assert.equal(r.source, b1.dir);
    assert.equal(r.restored, b1.files + 1);
    const back = snapshot(d);
    for (const k of Object.keys(before)) assert.equal(back[k], before[k], `${k} is A's again`);
    assert.equal(back['core/b-only.json'], bState['core/b-only.json'], 'a file only B wrote stays');
    assert.deepEqual(dbRows(d), { rows: ['a-1', 'a-2'], version: 5 }, 'A\'s database (A refuses a newer schema)');
    const kept = path.join(r.kept, 'files');
    assert.equal(sha(readFileSync(path.join(kept, 'core', 'settings.json'))), bState['core/settings.json'], 'B\'s settings kept in the before-rollback backup');

    // Roll forward again (B -> A -> B): the before-rollback backup brings B's settings and database back.
    const f = await restore({ dataRoot: d, from: A, to: B, now, creds: noCreds });
    assert.equal(f.source, r.kept);
    const fwd = snapshot(d);
    for (const k of ['core/settings.json', 'core/projects/alpha.json']) assert.equal(fwd[k], bState[k], k);
    assert.deepEqual(dbRows(d), { rows: ['a-1', 'a-2', 'b-1'], version: 6 });

    const none = await restore({ dataRoot: d, from: '0.1.0-alpha.9', to: '0.1.0-alpha.8', now, creds: noCreds });
    assert.equal(none.source, undefined, 'no matching backup: nothing restored');
    // Tampered backup: refused. The one a B -> A rollback uses now is the newest A -> B one (the roll-forward's
    // before-rollback backup), not b1.
    const next = listBackups(d).find((b) => b.from === A && b.to === B);
    assert.notEqual(next.dir, b1.dir);
    writeFileSync(path.join(next.dir, 'files', 'core', 'settings.json'), 'tampered');
    await assert.rejects(restore({ dataRoot: d, from: B, to: A, now, creds: noCreds }), /backup file changed or missing/);
  } finally { db?.close(); rmSync(d, { recursive: true, force: true, maxRetries: 3 }); }
});

test('settings backup: keeps the newest N (only folders it made), refuses bad versions and reasons', async () => {
  const d = tmp('prune');
  try {
    writeData(d).close();
    mkdirSync(path.join(d, 'backups', 'settings', 'my-own-folder'), { recursive: true });
    let t = Date.parse('2026-11-18T10:00:00Z');
    const now = () => new Date(t += 1000);
    for (let i = 0; i < 5; i++) await backup({ dataRoot: d, from: A, to: B, reason: 'update', keep: 3, now, creds: noCreds });
    assert.equal(listBackups(d).length, 3);
    assert.ok(existsSync(path.join(d, 'backups', 'settings', 'my-own-folder')), 'a folder it did not make is never removed');
    assert.deepEqual(prune(d, 1).length, 2);
    await assert.rejects(backup({ dataRoot: d, from: A, to: '1.0', reason: 'update', creds: noCreds }), /versions/);
    await assert.rejects(backup({ dataRoot: d, from: A, to: B, reason: 'whatever', creds: noCreds }), /reason/);
    assert.ok(!readdirSync(path.join(d, 'backups', 'settings')).some((n) => n.endsWith('.partial')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ---- Install-Ujwalam.ps1 on fake packages ------------------------------------------------------------------------------

function fakePackage(dir, version) {
  mkdirSync(path.join(dir, 'tools', 'package'), { recursive: true });
  copyFileSync(path.join(REPO, 'tools', 'package', 'Install-Ujwalam.ps1'), path.join(dir, 'Install-Ujwalam.ps1'));
  copyFileSync(path.join(REPO, 'tools', 'package', 'Ujwalam.cmd'), path.join(dir, 'Ujwalam.cmd'));
  copyFileSync(path.join(REPO, 'tools', 'package', 'settings-backup.mjs'), path.join(dir, 'tools', 'package', 'settings-backup.mjs'));
  writeFileSync(path.join(dir, 'ujwalam-start.exe'), 'stand-in\n');
  copyFileSync(ICO, path.join(dir, 'ujwalam.ico'));
  writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version, nodeMin: '22.13.0' }));
  writeFileSync(path.join(dir, 'tools', 'package', 'run-installed.mjs'), `console.log('fake ${version}');\n`);
  const rels = ['Install-Ujwalam.ps1', 'Ujwalam.cmd', 'ujwalam-start.exe', 'ujwalam.ico', 'release.json', 'tools/package/run-installed.mjs', 'tools/package/settings-backup.mjs'];
  writeFileSync(path.join(dir, 'SHA256SUMS.txt'), rels.map((r) => `${sha(readFileSync(path.join(dir, r)))}  ${r}\n`).join(''));
  return { dir, rels };
}

function ps(script, root, ...args) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallRoot', root, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const shortcutDirs = (root) => ['-StartMenuDir', path.join(root, 'start'), '-DesktopDir', path.join(root, 'desk')];

test('Install-Ujwalam.ps1: install A, write settings, update to B (backup first, nothing lost), roll back (A\'s settings back, B\'s kept), repair, uninstall keeping data', {
  skip: process.platform !== 'win32' && 'Windows only', timeout: 300_000,
}, (tc) => {
  const t = tmp('ps1');
  const ir = path.join(t, 'Ujwalam');
  const data = path.join(ir, 'data');
  try {
    const pa = fakePackage(path.join(t, 'pkg-a'), A);
    let r = ps(path.join(pa.dir, 'Install-Ujwalam.ps1'), ir, ...shortcutDirs(t));
    if (r.code === 6) { tc.skip(`prerequisites missing: ${r.out}`); return; }
    assert.equal(r.code, 0, r.out);
    assert.equal(listBackups(data).length, 0, 'a first install over an empty data folder takes no backup');

    writeData(data).close();
    const before = snapshot(data);
    const pb = fakePackage(path.join(t, 'pkg-b'), B);
    r = ps(path.join(pb.dir, 'Install-Ujwalam.ps1'), ir, '-NoShortcuts');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /settings backup: 19 files and the event database/);
    assert.match(r.out, /settings kept: all 20 files are in place/);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), B);
    assert.deepEqual(snapshot(data), before, 'the update changed nothing in the data folder');
    const [ub] = listBackups(data);
    assert.deepEqual([ub.reason, ub.from, ub.to], ['update', A, B]);

    // B changes settings; then the user rolls back.
    writeFileSync(path.join(data, 'core', 'settings.json'), '{"fromB":true}');
    r = ps(path.join(ir, B, 'Install-Ujwalam.ps1'), ir, '-Rollback');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /settings: 20 files put back/);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), A);
    assert.deepEqual(snapshot(data), before, 'A\'s settings are back');
    const br = listBackups(data).find((b) => b.reason === 'before-rollback');
    assert.equal(readFileSync(path.join(br.dir, 'files', 'core', 'settings.json'), 'utf8'), '{"fromB":true}', 'B\'s settings kept');

    // Rollback refused while Ujwalam runs (a program under the install root), settings and pointers untouched.
    const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', path.join(ir, A, 'marker')], { windowsHide: true, stdio: 'ignore' });
    try {
      r = ps(path.join(ir, A, 'Install-Ujwalam.ps1'), ir, '-Rollback');
      assert.equal(r.code, 12, r.out);
      assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), A);
      r = ps(path.join(ir, A, 'Install-Ujwalam.ps1'), ir, '-Uninstall', '-NoShortcuts');
      assert.equal(r.code, 11, r.out);
      assert.ok(existsSync(path.join(ir, A, 'release.json')), 'nothing removed');
    } finally { running.kill(); }

    // Repair: intact = no copy; a damaged file = the version folder is replaced from the package, settings untouched.
    r = ps(path.join(pa.dir, 'Install-Ujwalam.ps1'), ir, '-Repair', '-NoShortcuts');
    assert.equal(r.code, 0, r.out);
    writeFileSync(path.join(ir, A, 'tools', 'package', 'run-installed.mjs'), 'damaged\n');
    r = ps(path.join(pa.dir, 'Install-Ujwalam.ps1'), ir, '-Repair', '-NoShortcuts');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(ir, A, 'tools', 'package', 'run-installed.mjs'), 'utf8'), `console.log('fake ${A}');\n`);
    assert.ok(listBackups(data).some((b) => b.reason === 'repair'), 'a repair takes a backup too');
    assert.deepEqual(snapshot(data), before);

    // Uninstall keeps the data folder by default; shortcuts and program files go.
    r = ps(path.join(ir, A, 'Install-Ujwalam.ps1'), ir, '-Uninstall', ...shortcutDirs(t));
    assert.equal(r.code, 0, r.out);
    for (const f of [A, B, 'current.txt', 'previous.txt', 'Ujwalam.cmd', 'ujwalam-start.exe', 'ujwalam.ico']) assert.ok(!existsSync(path.join(ir, f)), f);
    for (const d of ['start', 'desk']) assert.deepEqual(readdirSync(path.join(t, d)).filter((n) => /^Ujwalam/.test(n)), [], d);
    assert.deepEqual(snapshot(data), before, 'data kept');
    assert.equal(dbRows(data).rows.length, 2);

    // Reinstall over the kept data: everything is still there (a backup, reason install, first).
    r = ps(path.join(pb.dir, 'Install-Ujwalam.ps1'), ir, '-NoShortcuts');
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(snapshot(data), before);
    assert.equal(listBackups(data)[0].reason, 'install');

    // Uninstall -DeleteData removes the data folder too, and the root when nothing else is in it.
    r = ps(path.join(t, 'pkg-b', 'Install-Ujwalam.ps1'), ir, '-Uninstall', '-DeleteData', '-NoShortcuts');
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(ir), r.out);
    r = ps(path.join(t, 'pkg-b', 'Install-Ujwalam.ps1'), ir, '-DeleteData');
    assert.equal(r.code, 2, '-DeleteData only with -Uninstall');
  } finally { rmSync(t, { recursive: true, force: true, maxRetries: 5 }); }
});

// ---- Ujwalam-Setup.exe end to end ---------------------------------------------------------------------------------------

function packageZip(dist, version, { tamper = false } = {}) {
  const stage = path.join(dist, `stage-${version}`);
  const { dir, rels } = fakePackage(stage, version);
  const top = `ujwalam-${version}-win64`;
  const zip = path.join(dist, `${top}.zip`);
  writeZip(zip, [...rels, 'SHA256SUMS.txt'].map((r) => ({ name: `${top}/${r}`, file: path.join(dir, ...r.split('/')) })));
  rmSync(stage, { recursive: true, force: true });
  writeFileSync(`${zip}.sha256`, `${tamper ? '0'.repeat(64) : sha(readFileSync(zip))}  ${path.basename(zip)}\n`);
  return zip;
}

function setup(...args) {
  const r = spawnSync(SETUP_EXE, ['--quiet', ...args], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('Ujwalam-Setup.exe --quiet: install from the zip next to it, update, refuses a bad checksum and an older package, rollback, uninstall keeping data', {
  skip: (process.platform !== 'win32' || !existsSync(SETUP_EXE)) && 'Ujwalam-Setup.exe not built (npm run build:setup)', timeout: 600_000,
}, () => {
  const t = tmp('exe');
  const ir = path.join(t, 'Ujwalam');
  const dist = path.join(t, 'dist');
  const data = path.join(ir, 'data');
  try {
    mkdirSync(dist);
    const za = packageZip(dist, A);
    let r = setup('--install', '--package', za, '--install-root', ir, '--start-menu', path.join(t, 'start'), '--desktop', path.join(t, 'desk'));
    if (r.code === 6) return; // prerequisites (Node, VC++ runtime) missing on this machine
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /package checksum ok/);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), A);
    assert.equal(JSON.parse(readFileSync(path.join(data, 'ujwalam.json'), 'utf8')).updateFolder, dist, 'the update folder is remembered');
    assert.ok(!readdirSync(ir).some((n) => n.startsWith('.setup-')), 'unpack folder removed');
    assert.ok(existsSync(path.join(t, 'start', 'Ujwalam (alpha).lnk')));

    // Setup rewrites ujwalam.json's updateFolder (same value) on every install: compared by content, the rest by bytes.
    writeData(data, { 'ujwalam.json': { overlayRoot: 'C:\\overlays', updateFolder: dist } }).close();
    const snap = () => { const s = snapshot(data); delete s['ujwalam.json']; return s; };
    const cfgOk = () => assert.deepEqual(JSON.parse(readFileSync(path.join(data, 'ujwalam.json'), 'utf8')), { overlayRoot: 'C:\\overlays', updateFolder: dist });
    const before = snap();
    // B in the build folder: --update with no --package finds it through data\ujwalam.json's updateFolder.
    const zb = packageZip(dist, B);
    r = setup('--update', '--install-root', ir, '--no-shortcuts');
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), B);
    assert.deepEqual(snap(), before, 'nothing lost in the update'); cfgOk();
    assert.equal(listBackups(data)[0].reason, 'update');

    r = setup('--update', '--install-root', ir, '--package', za);
    assert.equal(r.code, 26, r.out);
    rmSync(zb); rmSync(`${zb}.sha256`);
    const bad = packageZip(dist, '0.1.0-alpha.3', { tamper: true });
    r = setup('--update', '--install-root', ir, '--package', bad);
    assert.equal(r.code, 21, r.out);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), B, 'nothing changed');
    r = setup('--update', '--install-root', ir, '--package', path.join(dist, 'ujwalam-0.1.0-alpha.7-win64.zip'));
    assert.equal(r.code, 21, 'no zip / no checksum file');

    writeFileSync(path.join(data, 'core', 'settings.json'), '{"fromB":true}');
    r = setup('--rollback', '--install-root', ir);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(path.join(ir, 'current.txt'), 'utf8').trim(), A);
    assert.deepEqual(snap(), before, 'A\'s settings back after the rollback'); cfgOk();

    r = setup('--uninstall', '--install-root', ir, '--start-menu', path.join(t, 'start'), '--desktop', path.join(t, 'desk'));
    assert.equal(r.code, 0, r.out);
    assert.ok(!existsSync(path.join(ir, 'current.txt')) && !existsSync(path.join(ir, A)));
    assert.ok(!existsSync(path.join(t, 'start', 'Ujwalam (alpha).lnk')));
    assert.deepEqual(snap(), before, 'data kept'); cfgOk();
    r = setup('--uninstall', '--install-root', ir);
    assert.equal(r.code, 24, 'nothing installed');
    r = setup('--delete-data', '--install', '--install-root', ir);
    assert.equal(r.code, 23, '--delete-data only with --uninstall');
  } finally { rmSync(t, { recursive: true, force: true, maxRetries: 5 }); }
});

test('Ujwalam-Setup.exe: version info and icon (Defender: no unnamed exe), asInvoker, only Windows DLLs', { skip: !existsSync(SETUP_EXE) && 'not built' }, async () => {
  const { peInfo } = await import('../tools/package/pe.mjs');
  const pe = peInfo(readFileSync(SETUP_EXE));
  assert.deepEqual(pe.imports.map((n) => n.toLowerCase()).sort(), ['bcrypt.dll', 'comctl32.dll', 'gdi32.dll', 'kernel32.dll', 'shell32.dll', 'user32.dll']);
  const b = readFileSync(SETUP_EXE);
  const u16 = (s) => Buffer.from(s, 'utf16le');
  for (const s of ['Ujwalam-Setup.exe', 'GPL-3.0-or-later', 'Ujwalam project']) assert.ok(b.includes(u16(s)), s);
  assert.ok(b.includes(Buffer.from('level="asInvoker"')), 'manifest: never asks for admin rights');
  assert.ok(statSync(SETUP_EXE).size < 2 * 1024 * 1024);
});

// ---- the studio's Update available route -----------------------------------------------------------------------------

function fakeRes() {
  return { code: 0, body: null };
}

test('Update available route: newest verified package only, refused while live or recording or unknown, one install at a time, plain result', async () => {
  const t = tmp('route');
  try {
    const ir = path.join(t, 'Ujwalam');
    const installDir = path.join(ir, A);
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, 'release.json'), JSON.stringify({ version: A }));
    writeFileSync(path.join(ir, 'current.txt'), `${A}\r\n`);
    const dist = path.join(t, 'dist');
    mkdirSync(dist);
    assert.equal(cmpVersion('0.1.0-alpha.10', '0.1.0-alpha.9'), 1);
    assert.equal(newestPackage(dist), null);

    const json = (res, code, body) => { res.code = code; res.body = body; };
    let status = { live: false, recording: false };
    const spawned = [];
    let exitWith = null;
    const spawnImpl = (exe, args, o) => {
      spawned.push({ exe, args, o });
      const handlers = {};
      const c = { pid: undefined, stdout: { on() {} }, stderr: { on() {} }, on: (ev, fn) => { handlers[ev] = fn; } };
      exitWith = (code) => handlers.exit(code);
      return c;
    };
    const su = createSetupUpdate({ json, installDir, updateDir: dist, hostStatus: async () => { if (status === 'fail') throw new Error('x'); return status; }, spawnImpl });
    const get = async (fresh) => { const res = fakeRes(); assert.equal(await su.handle('GET', '/ui/api/setup/update', res, new URL(`http://x/ui/api/setup/update${fresh ? '?fresh=1' : ''}`)), true); return res.body; };
    const post = async () => { const res = fakeRes(); await su.handle('POST', '/ui/api/setup/update', res, null); return res; };
    assert.equal(await su.handle('GET', '/ui/api/other', fakeRes(), null), false);

    assert.equal((await get()).reason, 'no-package');
    const zipFile = (v) => { const z = path.join(dist, `ujwalam-${v}-win64.zip`); writeFileSync(z, `zip ${v}`); writeFileSync(`${z}.sha256`, `${sha(Buffer.from(`zip ${v}`))}  x\n`); return z; };
    zipFile(A);
    assert.equal((await get()).reason, 'up-to-date');
    const zb = zipFile(B);
    assert.equal((await get()).reason, 'no-setup', 'no Ujwalam-Setup.exe next to the package or in the install root');
    writeFileSync(path.join(dist, 'Ujwalam-Setup.exe'), 'stand-in');
    let s = await get();
    assert.deepEqual([s.available, s.latest, s.current, s.zip], [true, { version: B, verified: true }, A, undefined]);
    writeFileSync(`${zb}.sha256`, `${'0'.repeat(64)}  x\n`);
    assert.equal((await get(true)).reason, 'not-verified', 'a checksum mismatch is never offered');
    writeFileSync(`${zb}.sha256`, `${sha(Buffer.from(`zip ${B}`))}\n`);

    status = { live: true, recording: false };
    let r = await post();
    assert.deepEqual([r.code, r.body.error], [409, 'live']);
    status = { live: false, recording: true };
    assert.equal((await post()).body.error, 'live');
    status = 'fail';
    assert.equal((await post()).body.error, 'live', 'unknown on-air state: refused');
    assert.equal(spawned.length, 0);

    status = { live: false, recording: false };
    r = await post();
    assert.deepEqual([r.code, r.body], [202, { started: true, version: B }]);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].exe, path.join(dist, 'Ujwalam-Setup.exe'));
    assert.deepEqual(spawned[0].args, ['--update', '--quiet', '--next-start', '--package', zb, '--install-root', ir]);
    assert.equal(spawned[0].o.windowsHide, true);
    assert.equal((await post()).body.error, 'busy', 'one install at a time');
    assert.equal((await get()).installing, B);
    exitWith(13);
    s = await get();
    assert.deepEqual([s.installing, s.last.ok, s.last.code], [null, false, 13]);
    assert.match(s.last.message, /settings could not be backed up/);
    await post();
    exitWith(0);
    assert.match((await get()).last.message, /0\.1\.0-alpha\.2 is installed\. Close the studio and open Ujwalam again/);

    const checkout = createSetupUpdate({ json, installDir: path.join(t, 'checkout'), updateDir: dist, hostStatus: async () => status, spawnImpl });
    const res = fakeRes();
    await checkout.handle('GET', '/ui/api/setup/update', res, null);
    assert.equal(res.body.reason, 'not-installed');
  } finally { rmSync(t, { recursive: true, force: true }); }
});
