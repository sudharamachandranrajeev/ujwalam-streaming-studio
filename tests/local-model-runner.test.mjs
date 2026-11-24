// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T1: local model runner with a fake llama-server (no GPU in CI): start on a free 127.0.0.1 port, /health wait,
// withModel stops after the batch, idle stop, never while on air (fresh status), stop when a stream starts, GPU busy,
// CPU fallback after a failed GPU start, GPU layers from free VRAM, chatJson with images and typed errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, createModelRunner, LocalModelError, pickGpuLayers, serverArgs, loadConfig } from '../services/local-model/runner.mjs';
import { loadDefinitions } from '../services/flags/index.mjs';
import { loadItems } from '../services/studio-ui/downloads.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-llama-server.mjs');
const CFG = loadConfig();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelsDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-lm-'));
  mkdirSync(path.join(d, 'llama-server')); mkdirSync(path.join(d, 'qwen3-vl-4b'));
  for (const f of [['llama-server', CFG.serverExe], ['qwen3-vl-4b', CFG.model], ['qwen3-vl-4b', CFG.mmproj]]) writeFileSync(path.join(d, ...f), 'x');
  return d;
}
const items = [{ id: CFG.serverItem, dest: 'models/llama-server' }, { id: CFG.modelItem, dest: 'models/qwen3-vl-4b' }];

function runner(over = {}, env = {}) {
  const dir = modelsDir();
  const spawned = [];
  const r = createModelRunner({
    modelsDir: dir, items, isOn: () => true, status: async () => ({ live: false, recording: false }), gpuBusy: () => false, freeVram: () => 6000,
    config: { startTimeoutMs: 8000, watchMs: 50, idleMs: 150 },
    spawnServer: (exe, args) => { spawned.push(args); return spawn(process.execPath, [FAKE, ...args], { windowsHide: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }); },
    ...over,
  });
  return { r, spawned, dir, done: () => { r.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('config and pinned items: the runner config names the download items, both exist with the files it needs', () => {
  const all = loadItems();
  const srv = all.find((i) => i.id === CFG.serverItem); const mdl = all.find((i) => i.id === CFG.modelItem);
  assert.ok(srv && mdl);
  assert.ok(srv.files.some((f) => f.name === CFG.serverExe));
  assert.deepEqual([CFG.model, CFG.mmproj].filter((n) => !mdl.files.some((f) => f.name === n)), []);
});

test('flag local-ai-model is defined, on by default (user-requested), shown in Settings', () => {
  const d = loadDefinitions().find((x) => x.id === 'local-ai-model');
  assert.ok(d); assert.equal(d.default, true); assert.ok(d.onBy);
});

test('pickGpuLayers: all when VRAM fits, a share when partly, none when little or unknown; serverArgs local only', () => {
  const c = { ...CFG, gpuLayers: 'auto' };
  assert.equal(pickGpuLayers(c, 6000), 999);
  const part = pickGpuLayers(c, 2500);
  assert.ok(part > 0 && part < c.layers, String(part));
  assert.equal(pickGpuLayers(c, 1000), 0);
  assert.equal(pickGpuLayers(c, null), 0);
  assert.equal(pickGpuLayers({ ...c, gpuLayers: 12 }, null), 12);
  const a = serverArgs(c, { model: 'm', mmproj: 'p', port: 5, gpuLayers: 0 });
  assert.equal(a[a.indexOf('--host') + 1], '127.0.0.1');
  assert.ok(a.includes('--no-mmproj-offload'));
});

test('withModel: starts on a free 127.0.0.1 port, waits for /health, one call with an image returns JSON, stops after', async () => {
  const { r, spawned, done } = runner({}, { FAKE_LLAMA_HEALTH_DELAY_MS: '400' });
  try {
    const out = await r.withModel(async (m) => {
      assert.match(m.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(m.info.gpuLayers, 999);
      return chatJson({ url: m.url, prompt: 'x', images: [Buffer.from([0x89, 0x50, 0x4e, 0x47])], schema: { type: 'object' } });
    });
    assert.deepEqual(out, { ok: true, images: 1, layers: 999, format: 'json_schema' });
    assert.equal(spawned.length, 1);
    assert.equal(r.running(), false, 'stopped after the batch');
  } finally { done(); }
});

test('keep: the server stays for the next batch, then stops after idleMs', async () => {
  const { r, spawned, done } = runner();
  try {
    await r.withModel(async () => {}, { keep: true });
    assert.equal(r.running(), true);
    await r.withModel(async () => {}, { keep: true });
    assert.equal(spawned.length, 1, 'reused');
    await sleep(400);
    assert.equal(r.running(), false, 'idle stop');
  } finally { done(); }
});

test('never while on air: refused when live, recording, or unknown; nothing spawned', async () => {
  for (const status of [async () => ({ live: true }), async () => ({ recording: true }), async () => { throw new Error('no host'); }]) {
    const { r, spawned, done } = runner({ status });
    try {
      await assert.rejects(r.withModel(async () => {}), (e) => e instanceof LocalModelError && e.code === 'on-air');
      assert.equal(spawned.length, 0);
    } finally { done(); }
  }
});

test('off, files missing, GPU Whisper running: typed refusals', async () => {
  let x = runner({ isOn: () => false });
  try { await assert.rejects(x.r.withModel(async () => {}), { code: 'off' }); } finally { x.done(); }
  x = runner({ gpuBusy: () => true });
  try { await assert.rejects(x.r.withModel(async () => {}), { code: 'gpu-busy' }); assert.equal(x.spawned.length, 0); } finally { x.done(); }
  x = runner();
  try {
    rmSync(path.join(x.dir, 'qwen3-vl-4b', CFG.mmproj));
    await assert.rejects(x.r.withModel(async () => {}), { code: 'missing' });
  } finally { x.done(); }
});

test('a stream starting stops the server; the next use of the url fails with on-air', async () => {
  let live = false;
  const { r, done } = runner({ status: async () => ({ live }) });
  try {
    await assert.rejects(r.withModel(async (m) => {
      live = true;
      await sleep(300);
      assert.equal(r.running(), false, 'stopped by the watch');
      return m.url;
    }), { code: 'on-air' });
  } finally { done(); }
});

test('a GPU start that fails is tried once more on the CPU', async () => {
  const { r, spawned, done } = runner({}, { FAKE_LLAMA_GPU_FAIL: '1' });
  try {
    const layers = await r.withModel(async (m) => (await chatJson({ url: m.url, prompt: 'x' })).layers);
    assert.equal(layers, 0);
    assert.deepEqual(spawned.map((a) => a[a.indexOf('--n-gpu-layers') + 1]), ['999', '0']);
  } finally { done(); }
});

test('GPU busy unknown: runs on the CPU', async () => {
  const { r, spawned, done } = runner({ gpuBusy: () => null });
  try {
    await r.withModel(async () => {});
    assert.equal(spawned[0][spawned[0].indexOf('--n-gpu-layers') + 1], '0');
  } finally { done(); }
});

test('chatJson: not-local, http, bad-json, timeout, unreachable', async () => {
  await assert.rejects(chatJson({ url: 'http://10.0.0.1:8080', prompt: 'x' }), { code: 'not-local' });
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/500')) { res.writeHead(500); res.end(); return; }
    if (req.url.startsWith('/text')) { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: 'no json here' } }] })); return; }
    if (req.url.startsWith('/fenced')) { res.writeHead(200); res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"a":1}\n```' } }] })); return; }
    /* /slow: never answers */
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${srv.address().port}`;
  try {
    // the endpoint is <url>/v1/chat/completions; the test server routes on the first path part
    await assert.rejects(chatJson({ url: `${b}/500/`, prompt: 'x' }), { code: 'http' });
    await assert.rejects(chatJson({ url: `${b}/text/`, prompt: 'x' }), { code: 'bad-json' });
    assert.deepEqual(await chatJson({ url: `${b}/fenced/`, prompt: 'x' }), { a: 1 });
    await assert.rejects(chatJson({ url: `${b}/slow/`, prompt: 'x', timeoutMs: 200 }), { code: 'timeout' });
  } finally { srv.closeAllConnections(); srv.close(); }
  await assert.rejects(chatJson({ url: b, prompt: 'x' }), { code: 'unreachable' });
});
