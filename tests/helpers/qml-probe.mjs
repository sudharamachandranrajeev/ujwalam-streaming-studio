// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the Qt Quick studio headless (UJWALAM_HEADLESS=1, offscreen platform: no window ever appears) against a fake host and a
// real studio server on a loopback port, and returns the probe line it prints. Shared by the layout and look tests (D389).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../../services/studio-ui/backends.mjs';
import { createFlags } from '../../services/flags/index.mjs';
import { createStudioServer } from '../../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = path.join(REPO, 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
export const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
export const skipReason = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

function startShell(env, killMs) {
  const child = spawn(SHELL_EXE, [], {
    windowsHide: true,
    env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1',
      QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\Windows', 'Fonts'), ...env },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill(), killMs);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// A loopback stand-in in front of the studio server: answer(url, body) returns [status, object] for a route it fakes, or nothing to pass
// the request through. Lets a test open the Go live chooser without a real YouTube sign-in. Returns the port to give the shell.
async function standIn(upstream, answer) {
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      let body = {};
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { /* not JSON */ }
      const a = answer(new URL(req.url, 'http://x').pathname, body);
      if (a) { res.writeHead(a[0], { 'content-type': 'application/json' }); return res.end(JSON.stringify(a[1])); }
      const headers = { ...req.headers, host: `127.0.0.1:${upstream}` };
      if (headers.origin) headers.origin = `http://127.0.0.1:${upstream}`;
      const up = http.request({ host: '127.0.0.1', port: upstream, path: req.url, method: req.method, headers }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      up.end(raw);
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return { port: proxy.address().port, close: () => new Promise((r) => proxy.close(r)) };
}

// actions: the probe's action list; env: more environment (UJWALAM_THEME, UJWALAM_STUDIO_PROBE_SIZE, UJWALAM_STUDIO_PROBE_SHOT ...).
// live: the fake host is already streaming (stream.start) when the studio opens; answer: see standIn.
export async function runQmlProbe({ actions = [], ms = Math.max(5000, 3000 + actions.length * 700), env = {}, killMs = 90_000, prepare = null, live = false, answer = null } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qmlprobe-'));
  try {
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost(live ? { outputsReady: true } : {});
    if (live) await fake.call('stream.start', {});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'q'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {}, watchData: false });
    const { port: upstream } = await srv.listen();
    const front = answer ? await standIn(upstream, answer) : null;
    const port = front ? front.port : upstream;
    try {
      const r = await startShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env }, killMs);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      if (!m) throw new Error(`no probe line (exit ${r.code}): ${r.out} ${r.err}`);
      return { p: JSON.parse(m[1]), err: r.err, code: r.code };
    } finally { if (front) await front.close(); await srv.close(); }
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}
