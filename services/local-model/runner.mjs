// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T1: the local model runner. Ujwalam starts llama.cpp's llama-server with Qwen3-VL-4B (model + vision projector)
// itself, after a stream only, on a free port on 127.0.0.1, waits for /health, runs a batch of calls and stops it.
//
//   const r = createModelRunner({ isOn, status });
//   const out = await r.withModel(async (m) => chatJson({ url: m.url, prompt, images, schema }));
//
// Rules:
// - Never while live or recording (6 GB VRAM, D1): status() is read fresh before every start (D442: never a cached
//   value); unknown counts as on air. While the server runs, status is read every watchMs and the server is stopped
//   when a stream or recording starts; calls then fail with code 'on-air'.
// - One model in VRAM at a time: never starts while gpuBusy() says a GPU Whisper (turbo) job of Ujwalam runs.
// - GPU layers: 'auto' offloads every layer when the free VRAM covers vramNeedMiB, a share when at least minGpuMiB is
//   free, else none. A GPU start that fails (CUDA error, out of memory, early exit) is tried once more on the CPU.
// - Idle: withModel(fn) stops the server when the batch ends; withModel(fn, { keep: true }) leaves it for idleMs.
// - No console window (D191): windowsHide on every child; the server's output is kept in memory (last 64 KiB) only.
// - Only a 127.0.0.1 address is ever called (services/common/local-ai.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localAiUrl } from '../common/local-ai.mjs';
import { loadItems } from '../studio-ui/downloads.mjs';
import { decide, installedHosts, logForStart } from '../../tools/live-check.mjs';

export const FLAG = 'local-ai-model';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_FILE = path.join(REPO, 'data', 'ai', 'local-model.json');

/** A typed failure: code is one of off | on-air | gpu-busy | missing | start-failed | stopped | timeout | http |
 *  bad-json | unreachable | not-local. */
export class LocalModelError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalModelError'; this.code = code; }
}

export function loadConfig(file = CONFIG_FILE) { return JSON.parse(readFileSync(file, 'utf8')); }

/** Pure: GPU layers for the free VRAM (MiB, null = unknown). */
export function pickGpuLayers(cfg, freeMiB) {
  if (Number.isInteger(cfg.gpuLayers)) return cfg.gpuLayers;
  if (typeof freeMiB !== 'number' || !Number.isFinite(freeMiB) || freeMiB < cfg.minGpuMiB) return 0;
  if (freeMiB >= cfg.vramNeedMiB) return 999;
  return Math.max(0, Math.floor(cfg.layers * (freeMiB - 600) / (cfg.vramNeedMiB - 600))); // ~600 MiB: projector + buffers
}

/** Pure: the llama-server arguments. */
export function serverArgs(cfg, { model, mmproj, port, gpuLayers }) {
  return ['--model', model, '--mmproj', mmproj, '--host', '127.0.0.1', '--port', String(port), '--ctx-size', String(cfg.ctx),
    '--n-gpu-layers', String(gpuLayers), '--threads', String(cfg.threads), '--parallel', '1', '--no-webui',
    ...(gpuLayers === 0 ? ['--no-mmproj-offload'] : [])];
}

/** Free VRAM in MiB of the first NVIDIA GPU, or null. */
export function nvidiaFreeMiB() {
  const r = spawnSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const v = r.status === 0 ? Number.parseInt(r.stdout.split(/\r?\n/)[0], 10) : NaN;
  return Number.isFinite(v) ? v : null;
}

/** True when a Python process of Ujwalam (the installed app under %LOCALAPPDATA%\Ujwalam, or this checkout) uses the
 *  GPU: the clip worker's GPU Whisper. null when it cannot be told (counts as busy for the GPU; the CPU is used). */
export function ujwalamGpuPython({ base = process.env.LOCALAPPDATA, repo = REPO } = {}) {
  const r = spawnSync('nvidia-smi', ['--query-compute-apps=process_name', '--format=csv,noheader'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (r.status !== 0 || r.error) return null;
  const roots = [base && path.join(base, 'Ujwalam'), repo].filter(Boolean).map((p) => p.toLowerCase() + path.sep);
  return r.stdout.split(/\r?\n/).map((l) => l.trim().toLowerCase()).some((p) => /python[^\\/]*\.exe$/.test(p) && roots.some((x) => p.startsWith(x)));
}

/** On air now? true / false / null (unknown). The same rule as tools/live-check.mjs, read fresh each call. */
export async function liveCheckOnAir() {
  const base = process.env.LOCALAPPDATA;
  const dir = base ? path.join(base, 'Ujwalam', 'data', 'host', 'logs') : null;
  const { code } = decide(installedHosts(base), (start) => {
    try { const f = logForStart(readdirSync(dir), start); return f ? readFileSync(path.join(dir, f), 'utf8') : null; } catch { return null; }
  });
  return code === 0 ? false : code === 1 ? true : null;
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.unref();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * opts: { isOn: () => bool (the flag), status: async () => ({ live, recording }) (default: live-check rule),
 *   gpuBusy: () => bool|null, freeVram: () => MiB|null, modelsDir (default UJWALAM_MODELS_DIR), config, items
 *   (download items, for the paths), usable: async (paths) => bool, spawnServer: (exe, args) => ChildProcess (tests),
 *   fetchImpl, log }.
 */
export function createModelRunner(opts = {}) {
  const cfg = { ...loadConfig(), ...(opts.config ?? {}) };
  const log = opts.log ?? (() => {});
  const isOn = opts.isOn ?? (() => true);
  const onAir = opts.status
    ? async () => { try { const s = await opts.status(); return Boolean(s?.live || s?.recording); } catch { return null; } }
    : (opts.onAir ?? liveCheckOnAir);
  const gpuBusy = opts.gpuBusy ?? ujwalamGpuPython;
  const freeVram = opts.freeVram ?? nvidiaFreeMiB;
  const doFetch = opts.fetchImpl ?? fetch;
  const spawnServer = opts.spawnServer ?? ((exe, args) => spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  let proc = null; let url = null; let users = 0; let idle = null; let watch = null; let starting = null; let stopReason = null;
  let tail = ''; let info = null;

  const paths = () => {
    const dir = opts.modelsDir ?? process.env.UJWALAM_MODELS_DIR ?? path.join(REPO, 'models');
    const items = opts.items ?? loadItems();
    const dest = (id, fallback) => path.join(dir, ...((items.find((i) => i.id === id)?.dest ?? `models/${fallback}`).split('/').slice(1)));
    const srv = dest(cfg.serverItem, 'llama-server');
    const mdl = dest(cfg.modelItem, 'qwen3-vl-4b');
    return { exe: path.join(srv, cfg.serverExe), model: path.join(mdl, cfg.model), mmproj: path.join(mdl, cfg.mmproj) };
  };

  async function health(base, ms) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
    try { const r = await doFetch(`${base}/health`, { signal: ac.signal }); return r.status === 200; } catch { return false; } finally { clearTimeout(t); }
  }

  async function launch(p, gpuLayers) {
    const port = await freePort();
    const base = localAiUrl(`http://127.0.0.1:${port}/`)?.replace(/\/$/, '');
    if (!base) throw new LocalModelError('not-local', 'the model server address is not on this PC');
    const child = spawnServer(p.exe, serverArgs(cfg, { ...p, port, gpuLayers }));
    let exited = false;
    const keep = (d) => { tail = (tail + d.toString('utf8')).slice(-65536); };
    child.stdout?.on('data', keep); child.stderr?.on('data', keep);
    child.on('exit', () => { exited = true; if (proc === child) { proc = null; url = null; stopWatch(); } });
    child.on('error', (e) => { exited = true; keep(`spawn error: ${e.message}\n`); });
    const until = Date.now() + cfg.startTimeoutMs;
    while (Date.now() < until && !exited) {
      if (await health(base, 2000)) return { child, base };
      if (stopReason) break;
      await sleep(250);
    }
    killTree(child);
    return null;
  }

  function killTree(child) {
    if (!child || child.exitCode !== null) return;
    try { child.kill(); } catch { /* gone */ }
    if (process.platform === 'win32' && child.pid) {
      setTimeout(() => { if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }, 3000).unref();
    }
  }

  function stopWatch() { if (watch) { clearInterval(watch); watch = null; } }

  async function start() {
    if (proc) return;
    if (starting) return starting;
    starting = (async () => {
      if (!isOn()) throw new LocalModelError('off', 'The local AI model is switched off (Settings).');
      const air = await onAir();
      if (air !== false) throw new LocalModelError('on-air', 'The local AI model waits until the stream and the recording have stopped.');
      const p = paths();
      for (const f of [p.exe, p.model, p.mmproj]) if (!existsSync(f)) throw new LocalModelError('missing', `Not downloaded yet: ${path.basename(f)} (Settings > Downloads).`);
      if (opts.usable && !(await opts.usable(p))) throw new LocalModelError('missing', 'The local AI model files did not pass their check; download them again (Settings > Downloads).');
      const busy = gpuBusy();
      if (busy === true) throw new LocalModelError('gpu-busy', 'A speech model runs on the graphics card; the local AI model starts after it.');
      stopReason = null; tail = '';
      let layers = busy === null ? 0 : pickGpuLayers(cfg, freeVram());
      let got = await launch(p, layers);
      if (!got && layers > 0 && !stopReason) { log(`local-model: GPU start failed (${layers} layers); trying the CPU`); layers = 0; tail = ''; got = await launch(p, 0); }
      if (!got) throw new LocalModelError(stopReason ? 'stopped' : 'start-failed', stopReason ?? `The local AI model did not start: ${tail.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300)}`);
      // the stream may have started while the model loaded: read again before any call
      if ((await onAir()) !== false) { killTree(got.child); throw new LocalModelError('on-air', 'A stream or recording started; the local AI model was stopped.'); }
      proc = got.child; url = got.base; info = { gpuLayers: layers, port: Number(new URL(url).port), startedAt: Date.now() };
      log(`local-model: ready on ${url} (${layers ? `${layers} GPU layers` : 'CPU'})`);
      watch = setInterval(async () => {
        if ((await onAir()) !== false && proc) { stopReason = 'A stream or recording started; the local AI model was stopped.'; log('local-model: stopped (on air)'); stop(); }
      }, cfg.watchMs);
      watch.unref?.();
    })();
    try { await starting; } finally { starting = null; }
  }

  function stop() {
    stopWatch();
    if (idle) { clearTimeout(idle); idle = null; }
    const c = proc; proc = null; url = null; info = null;
    killTree(c);
  }

  async function withModel(fn, { keep = false } = {}) {
    if (idle) { clearTimeout(idle); idle = null; }
    users += 1;
    try {
      await start();
      const m = { get url() { if (!url) throw new LocalModelError(stopReason ? 'on-air' : 'stopped', stopReason ?? 'The local AI model stopped.'); return url; }, info: { ...info } };
      return await fn(m);
    } finally {
      users -= 1;
      if (users === 0 && proc) {
        if (keep) { idle = setTimeout(stop, cfg.idleMs); idle.unref?.(); } else stop();
      }
    }
  }

  return { withModel, start, stop, running: () => Boolean(proc), info: () => (info ? { ...info } : null), tail: () => tail, paths, config: cfg };
}

/**
 * One chat completion with images and a JSON answer. images: Buffers (PNG/JPEG) or { mime, base64 }. schema: a JSON
 * schema (sent as response_format json_schema, which llama-server turns into a grammar), or null for any JSON object.
 * Returns the parsed object; throws LocalModelError (timeout | http | bad-json | unreachable | not-local).
 */
export async function chatJson({ url, prompt, images = [], schema = null, system = null, timeoutMs = 120000, maxTokens = 1024, temperature = 0.2, fetchImpl = fetch }) {
  const base = localAiUrl(url);
  if (!base) throw new LocalModelError('not-local', 'the model server address is not on this PC');
  const endpoint = new URL('v1/chat/completions', base.endsWith('/') ? base : `${base}/`).href;
  const img = (x) => {
    const b64 = Buffer.isBuffer(x) ? x.toString('base64') : x.base64;
    const mime = Buffer.isBuffer(x) ? (x[0] === 0xff && x[1] === 0xd8 ? 'image/jpeg' : 'image/png') : x.mime;
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } };
  };
  const body = {
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: [...images.map(img), { type: 'text', text: prompt }] }],
    temperature, max_tokens: maxTokens, stream: false,
    response_format: schema ? { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } : { type: 'json_object' },
  };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
  } catch (e) {
    throw ac.signal.aborted ? new LocalModelError('timeout', `no answer within ${Math.round(timeoutMs / 1000)} s`) : new LocalModelError('unreachable', `the model server cannot be reached (${e.code ?? e.message})`);
  } finally { clearTimeout(t); }
  let text;
  try { text = await res.text(); } catch { throw new LocalModelError('unreachable', 'the answer was cut off'); }
  if (!res.ok) throw new LocalModelError('http', `the model server answered ${res.status}`);
  let content;
  try { content = JSON.parse(text)?.choices?.[0]?.message?.content; } catch { throw new LocalModelError('bad-json', 'the model server sent no JSON'); }
  if (typeof content !== 'string') throw new LocalModelError('bad-json', 'the answer has no text');
  const a = content.indexOf('{'), b = content.lastIndexOf('}');
  try { if (a < 0 || b <= a) throw new Error(); return JSON.parse(content.slice(a, b + 1)); } catch { throw new LocalModelError('bad-json', 'the model did not answer with a JSON object'); }
}
