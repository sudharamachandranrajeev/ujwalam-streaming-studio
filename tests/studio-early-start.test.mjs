// SPDX-License-Identifier: GPL-3.0-or-later
// Early studio start (2026-11-19, start-up time phase 3): the launcher starts the Qt studio while the event core and the
// host start. The studio loads its QML with nothing on screen, waits for "ui <port>" on its stdin pipe, logs in (asking
// again while the server does not answer yet), applies the saved theme and only then places its window. Requests the
// QML makes before the login wait for it. Headless only: the studio runs with UJWALAM_STUDIO_HIDDEN=1 (never on screen).
// The tests with the real exe are skipped when the studio is not built (npm run build:studio) or no Qt kit is configured.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { earlyShellSpawnSpec, earlyStudioOn, earlyUiLine } from '../services/studio-ui/launch.mjs';
import { killChildTree } from '../services/common/kill-tree.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = process.platform !== 'win32' ? 'Windows only' : !existsSync(EXE) || !qtDir() ? 'studio shell not built (npm run build:studio)' : false;
const KEY = 'a'.repeat(64);

test('early spawn spec: the key by env only, no URL, the early switch on, every token stripped', () => {
  const env = { PATH: 'C:\\x', UJWALAM_HOST_TOKEN: 't', UJWALAM_UI_LAUNCH_KEY: 'old', UJWALAM_UI_URL: 'http://127.0.0.1:1/' };
  const s = earlyShellSpawnSpec({ launchKey: KEY, exe: 'C:\\s.exe', qtBin: 'C:\\qt\\bin', logsDir: 'C:\\logs', env, exists: () => true });
  assert.equal(s.cmd, 'C:\\s.exe');
  assert.equal(s.env.UJWALAM_UI_LAUNCH_KEY, KEY);
  assert.equal(s.env.UJWALAM_STUDIO_EARLY, '1');
  assert.equal(s.env.UJWALAM_UI_URL, undefined);
  assert.equal(s.env.UJWALAM_HOST_TOKEN, undefined);
  assert.equal(s.env.UJWALAM_STUDIO_LOG_DIR, 'C:\\logs');
  assert.match(s.env.PATH, /^C:\\qt\\bin;/);
  assert.equal(earlyShellSpawnSpec({ launchKey: KEY, exe: 'C:\\s.exe', env, exists: () => false }), null);
  assert.equal(earlyUiLine(4321), 'ui 4321\n');
  assert.doesNotMatch(earlyUiLine(4321), /a{8}/, 'no key in the line');
});

test('early start: Windows, a studio to start, the service-swap flag off, not switched off', () => {
  const p = { exe: 'x' };
  assert.equal(earlyStudioOn({ shellPaths: p, swapOn: false, platform: 'win32', env: {} }), true);
  assert.equal(earlyStudioOn({ shellPaths: p, swapOn: true, platform: 'win32', env: {} }), false, 'the swap slot starts the window as before');
  assert.equal(earlyStudioOn({ shellPaths: null, swapOn: false, platform: 'win32', env: {} }), false);
  assert.equal(earlyStudioOn({ shellPaths: p, swapOn: false, platform: 'linux', env: {} }), false);
  assert.equal(earlyStudioOn({ shellPaths: p, swapOn: false, platform: 'win32', env: { UJWALAM_STUDIO_EARLY: '0' } }), false);
});

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// A stand-in UI server: the one-time key logs in once (302 + cookie), the session gives a CSRF value, every other
// route answers {} and records whether it carried the session cookie.
function fakeUi(port) {
  const seen = [];
  let used = false;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cookie = /(^|;\s*)s=good/.test(req.headers.cookie ?? '');
    if (u.pathname === '/login') {
      seen.push({ path: '/login' });
      if (u.searchParams.get('k') === KEY && !used) { used = true; res.writeHead(302, { 'Set-Cookie': 's=good; HttpOnly', Location: '/' }); return res.end(); }
      res.writeHead(403); return res.end();
    }
    seen.push({ path: u.pathname, cookie });
    res.writeHead(cookie ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(u.pathname === '/ui/api/session' ? { csrf: 'c'.repeat(32) } : {}));
  });
  return { seen, listen: () => new Promise((r) => srv.listen(port, '127.0.0.1', r)), close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

function startStudio(dir, extra = {}, key = KEY) {
  const spec = earlyShellSpawnSpec({ launchKey: key, exe: EXE, qtBin: path.join(qtDir(), 'bin'), logsDir: dir, env: { ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_HIDDEN: '1', ...extra } });
  const c = spawn(spec.cmd, [], { stdio: ['pipe', 'pipe', 'pipe'], env: spec.env, windowsHide: true });
  const st = { c, out: '' };
  c.stdout.on('data', (d) => { st.out += d; });
  c.stderr.on('data', (d) => { st.out += d; });
  st.until = async (re, ms) => { for (let i = 0; i < ms / 50 && !re.test(st.out); i++) await sleep(50); return re.test(st.out); };
  st.exited = new Promise((r) => c.once('exit', (code) => r(code)));
  return st;
}

test('real studio: the UI server comes up 3 s late; the window is placed only after the login, and no request goes out before it', { skip, timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'early-late-'));
  const port = await freePort();
  const ui = fakeUi(port);
  const st = startStudio(dir);
  t.after(async () => { killChildTree(st.c); await ui.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });
  await sleep(3000); // the QML loads meanwhile; nothing is up yet
  assert.doesNotMatch(st.out, /studio attach: ready/, 'no window before the server is up');
  assert.equal(st.c.exitCode, null, st.out);
  st.c.stdin.write(earlyUiLine(port)); // the port first: the studio asks again until the server answers
  await sleep(600);
  await ui.listen();
  assert.ok(await st.until(/studio attach: ready \(hidden\)/, 20_000), st.out);
  assert.equal(ui.seen[0].path, '/login', 'the login is the first request');
  assert.equal(ui.seen.filter((s) => s.path === '/login').length, 1, 'one login, the key used once');
  const noCookie = ui.seen.filter((s) => s.path !== '/login' && !s.cookie);
  assert.deepEqual(noCookie, [], 'every request waited for the session');
  // End of input after the window is placed changes nothing (as before: the window stays).
  st.c.stdin.end();
  await sleep(1000);
  assert.equal(st.c.exitCode, null, 'the window stays after the pipe ends');
});

test('real studio: the launcher gone before the UI server was up (end of input) ends the early studio, nothing shown', { skip, timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'early-eof-'));
  const st = startStudio(dir);
  t.after(() => { killChildTree(st.c); rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });
  await sleep(1500);
  st.c.stdin.end();
  const code = await Promise.race([st.exited, sleep(20_000).then(() => 'timeout')]);
  assert.equal(code, 0, st.out);
  assert.doesNotMatch(st.out, /studio attach: ready/);
});

test('real studio: a refused key is never retried (exit 77)', { skip, timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'early-refused-'));
  const port = await freePort();
  const ui = fakeUi(port);
  await ui.listen();
  const st = startStudio(dir, {}, 'b'.repeat(64));
  t.after(async () => { killChildTree(st.c); await ui.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10 }); });
  st.c.stdin.write(earlyUiLine(port));
  const code = await Promise.race([st.exited, sleep(20_000).then(() => 'timeout')]);
  assert.equal(code, 77, st.out);
  assert.equal(ui.seen.filter((s) => s.path === '/login').length, 1, 'asked once');
  assert.doesNotMatch(st.out, /studio attach: ready/);
});

// The launcher with the fake host and the swap flag off (early start on): a studio crash after it was adopted reopens
// the window as before (D311 relaunch), and a crash before it was adopted starts it again the old way.
function startLauncher(root, env = {}) {
  const dataDir = path.join(root, 'core');
  mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, [path.join(REPO, 'services', 'studio-ui', 'launch.mjs'), '--mock', '--fake-host', '--stop-on-stdin', '--data-dir', dataDir,
    '--feedback-dir', path.join(root, 'feedback'), '--profile', path.join(REPO, 'tests', 'fixtures', 'project', 'profile.fixture.json')], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_HIDDEN: '1', UJWALAM_HOST_EXE: path.join(root, 'no-host.exe'), UJWALAM_OBS_RUNTIME: root, UJWALAM_HOST_DATA: path.join(root, 'host'), ...env },
  });
  const st = { child, out: '', dataDir };
  child.stdout.on('data', (d) => { st.out += d; });
  child.stderr.on('data', (d) => { st.out += d; });
  st.until = async (re, ms) => { for (let i = 0; i < ms / 50 && !re.test(st.out); i++) await sleep(50); return re.test(st.out); };
  st.exits = () => { try { return readFileSync(path.join(dataDir, 'logs', 'studio-exits.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return st;
}

// The studio processes the launcher started (by exe path and parent pid).
function studioPids(parentPid) {
  const ps = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" | Where-Object { $_.ExecutablePath -eq '${EXE.replace(/'/g, "''")}' } | ForEach-Object { $_.ProcessId }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  return out.split(/\s+/).filter(Boolean).map(Number);
}

test('launcher: the early studio is adopted (logged in after the UI server); a crash then reopens it as before', { skip, timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'early-launch-'));
  const st = startLauncher(root);
  t.after(() => { killChildTree(st.child); rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
  assert.ok(await st.until(/Qt studio shell started/, 60_000), st.out.slice(-3000));
  assert.match(st.out, /startup: [^\n]*studio-early \d+/, 'the studio was started early');
  // The adopted studio gets the port on its pipe, logs in and places its window only then.
  assert.ok(await st.until(/window: studio attach: ready \(hidden\)/, 30_000), st.out.slice(-3000));
  assert.ok(st.out.indexOf('UI at http') < st.out.indexOf('window: studio attach: ready'), 'the window after the UI server');
  const pids = studioPids(st.child.pid);
  assert.equal(pids.length, 1, `one studio: ${pids}`);
  execFileSync('taskkill.exe', ['/F', '/PID', String(pids[0])], { windowsHide: true });
  assert.ok(await st.until(/Qt shell ended unexpectedly[^\n]*Reopening the window in 2 s/, 20_000), st.out.slice(-3000));
  let again = [];
  for (let i = 0; i < 100 && !(again.length === 1 && again[0] !== pids[0]); i++) { again = studioPids(st.child.pid); await sleep(100); }
  assert.ok(again.length === 1 && again[0] !== pids[0], `a new studio: ${again}`);
  const exits = st.exits();
  assert.equal(exits.length, 1, JSON.stringify(exits));
  assert.equal(exits[0].early, undefined, 'the adopted window\'s exit is a normal watched one');
  st.child.stdin.end();
  assert.equal(await new Promise((r) => st.child.once('exit', r)), 0);
});

test('launcher: an early studio that crashes before the UI server is up is started again the old way; repeated crashes stop as before', { skip, timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'early-crash-'));
  const st = startLauncher(root, { UJWALAM_STUDIO_TEST_CRASH: 'av' }); // every studio of this run crashes at start
  t.after(() => { killChildTree(st.child); rmSync(root, { recursive: true, force: true, maxRetries: 10 }); });
  const code = await Promise.race([new Promise((r) => st.child.once('exit', r)), sleep(150_000).then(() => 'timeout')]);
  assert.equal(code, 0, st.out.slice(-3000));
  assert.match(st.out, /the early studio ended before the UI server was up/);
  assert.match(st.out, /NOT reopened \(more than 3 crashes/);
  assert.match(st.out, /nothing is live: stopping Ujwalam/);
  const exits = st.exits();
  assert.equal(exits.filter((e) => e.early === true).length, 1, JSON.stringify(exits));
  assert.equal(exits.filter((e) => e.early === undefined).length, 4, 'the started-again window and 3 reopened ones, as before');
});
