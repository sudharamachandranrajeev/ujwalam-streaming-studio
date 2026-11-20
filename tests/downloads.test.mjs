// SPDX-License-Identifier: GPL-3.0-or-later
// Download manager (2026-11-19): manifests, resume with Range, a bad checksum, cancel, pause, refused while live and
// paused when the stream starts, archive members. A local HTTP server on 127.0.0.1 stands in for the model hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDownloads, isReady, itemProblems, loadItems, MARKER } from '../services/studio-ui/downloads.mjs';
import { writeZip } from '../tools/package/zip.mjs';
import { safeRoot } from './helpers/data-root-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmp = (p) => mkdtempSync(path.join(os.tmpdir(), `ujw-dl-${p}-`));
const blob = (n, seed) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
const BIG = blob(600_000, 7);
const SMALL = blob(1234, 3);

/** files: { '/path': Buffer }; behaviour hooks per request. */
function server(files, { dropFirstAt = 0, ignoreRange = false, slow = 0 } = {}) {
  const seen = [];
  let dropped = false;
  const s = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range ?? null });
    if (req.url.startsWith('/moved/')) { res.writeHead(302, { Location: req.url.slice(6) }); res.end(); return; }
    const body = files[req.url];
    if (!body) { res.writeHead(404); res.end(); return; }
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    const from = m && !ignoreRange ? Number(m[1]) : 0;
    if (from >= body.length && m && !ignoreRange) { res.writeHead(416); res.end(); return; }
    res.writeHead(from ? 206 : 200, { 'Content-Length': body.length - from, ...(from ? { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
    const part = body.subarray(from);
    if (dropFirstAt && !dropped && part.length > dropFirstAt) { dropped = true; res.write(part.subarray(0, dropFirstAt)); setTimeout(() => res.destroy(), 20); return; }
    if (slow) { let i = 0; const t = setInterval(() => { if (res.destroyed) { clearInterval(t); return; } res.write(part.subarray(i, i + slow)); i += slow; if (i >= part.length) { clearInterval(t); res.end(); } }, 10); return; }
    res.end(part);
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ s, seen, base: `http://127.0.0.1:${s.address().port}` })));
}

const item = (base, over = {}) => ({
  id: 'test-model', name: 'Test model', purpose: 'For the test.', licence: 'MIT', checked: '2026-11-19', dest: 'models/test',
  files: [{ name: 'big.bin', url: `${base}/big.bin`, bytes: BIG.length, sha256: sha(BIG) }, { name: 'small.txt', url: `${base}/moved/small.txt`, bytes: SMALL.length, sha256: sha(SMALL) }],
  ...over,
});

function mgr(dataRoot, items, { live = () => false } = {}) {
  const out = [];
  const json = (res, code, body) => { res.code = code; res.body = body; };
  const d = createDownloads({ json, dataRoot: safeRoot(dataRoot), items, hostStatus: async () => ({ live: live(), recording: false }), retryDelays: [10, 10, 10], watchMs: 20, log: (s) => out.push(s) });
  const call = async (method, body) => { const res = {}; await d.handle(method, '/ui/api/downloads', res, body); return res; };
  return { d, call, out };
}

test('manifests: every item is complete and safe; the Face AI item equals data/models/face-ai.json', () => {
  const items = loadItems(REPO);
  assert.deepEqual(items.map((i) => i.id).sort(), ['face-ai-models', 'speech-captions']);
  for (const it of items) assert.deepEqual(itemProblems(it), [], it.id);
  const face = JSON.parse(readFileSync(path.join(REPO, 'data', 'models', 'face-ai.json'), 'utf8'));
  const want = face.models.flatMap((m) => [[m.file, m.bytes, m.sha256], ...(m.extra ?? []).map((x) => [x.file, x.bytes, x.sha256])]).sort();
  assert.deepEqual(items.find((i) => i.id === 'face-ai-models').files.map((f) => [f.name, f.bytes, f.sha256]).sort(), want);
  for (const f of items.find((i) => i.id === 'face-ai-models').files) assert.equal((f.archive ?? f).url, (face.models.find((m) => m.file === f.name || (m.extra ?? []).some((x) => x.file === f.name)).archive ?? face.models.find((m) => m.file === f.name)).url);
  // the speech model sits where services/clip/reel_captions.py model_path looks: <data root>/models/<reel-captions model>
  const cfg = JSON.parse(readFileSync(path.join(REPO, 'data', 'clip', 'reel-captions.json'), 'utf8'));
  assert.equal(items.find((i) => i.id === 'speech-captions').dest, `models/${cfg.model}`);
  assert.equal(items.find((i) => i.id === 'face-ai-models').dest, 'models/face', 'services/face/fetch_models.py: UJWALAM_MODELS_DIR/face');
  assert.ok(itemProblems({ ...items[0], dest: '../x' }).length && itemProblems({ ...items[0], files: [{ ...items[0].files[0], url: 'http://example.com/x' }] }).length);
});

test('download: a dropped connection resumes with Range, redirects are followed, every file is checked, then ready in the data root', async () => {
  const { s, seen, base } = await server({ '/big.bin': BIG, '/small.txt': SMALL }, { dropFirstAt: 200_000 });
  const root = tmp('ok');
  try {
    const it = item(base);
    const { d, call } = mgr(root, [it]);
    let r = await call('GET');
    assert.deepEqual([r.body.on, r.body.items[0].state, r.body.items[0].total], [true, 'missing', BIG.length + SMALL.length]);
    r = await call('POST', { id: it.id, action: 'start' });
    assert.equal(r.code, 200);
    await d.promise(it.id);
    r = await call('GET');
    assert.equal(r.body.items[0].state, 'ready', JSON.stringify(r.body.items[0]));
    assert.ok(seen.some((x) => x.url === '/big.bin' && /^bytes=\d+-$/.test(x.range ?? '')), 'the second try asked for the rest only');
    assert.deepEqual(readFileSync(path.join(root, 'models', 'test', 'big.bin')), BIG);
    assert.deepEqual(readFileSync(path.join(root, 'models', 'test', 'small.txt')), SMALL);
    const mk = JSON.parse(readFileSync(path.join(root, 'models', 'test', MARKER), 'utf8')).files;
    assert.deepEqual(Object.fromEntries(Object.entries(mk).map(([k, v]) => [k, [v.sha256, v.size, typeof v.mtimeMs]])),
      { 'big.bin': [sha(BIG), BIG.length, 'number'], 'small.txt': [sha(SMALL), SMALL.length, 'number'] });
    assert.ok(!existsSync(path.join(root, 'downloads', 'partial', it.id)), 'partial files removed');
    assert.ok(isReady(root, it));
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('download: a file that does not match its checksum is fetched once more, then the item fails in plain words and nothing is kept', async () => {
  const { s, seen, base } = await server({ '/big.bin': blob(BIG.length, 99), '/small.txt': SMALL });
  const root = tmp('sha');
  try {
    const it = item(base);
    const { d, call } = mgr(root, [it]);
    await call('POST', { id: it.id, action: 'start' });
    await d.promise(it.id);
    const v = (await call('GET')).body.items[0];
    assert.equal(v.state, 'failed');
    assert.match(v.message, /big\.bin did not match its checksum after two downloads; nothing was kept/);
    assert.equal(seen.filter((x) => x.url === '/big.bin').length, 2);
    assert.ok(!existsSync(path.join(root, 'models', 'test', 'big.bin')), 'never moved into place');
    assert.ok(!existsSync(path.join(root, 'downloads', 'partial', it.id, 'big.bin.part')), 'the bad file is deleted');
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('download: a server that ignores Range restarts the file and still ends right', async () => {
  const { s, base } = await server({ '/big.bin': BIG, '/small.txt': SMALL }, { dropFirstAt: 100_000, ignoreRange: true });
  const root = tmp('norange');
  try {
    const it = item(base);
    const { d, call } = mgr(root, [it]);
    await call('POST', { id: it.id, action: 'start' });
    await d.promise(it.id);
    const v = (await call('GET')).body.items[0];
    assert.equal(v.state, 'ready', JSON.stringify(v));
    assert.equal(v.done, v.total);
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('download: pause keeps the partial file and resume goes on from it; cancel deletes it', async () => {
  const { s, seen, base } = await server({ '/big.bin': BIG, '/small.txt': SMALL }, { slow: 20_000 });
  const root = tmp('pause');
  try {
    const it = item(base);
    const { d, call } = mgr(root, [it]);
    await call('POST', { id: it.id, action: 'start' });
    while (((await call('GET')).body.items[0].done ?? 0) < 100_000) await new Promise((r) => setTimeout(r, 20));
    let r = await call('POST', { id: it.id, action: 'pause' });
    assert.equal(r.body.item.state, 'paused');
    const kept = r.body.item.done;
    assert.ok(kept >= 100_000 && kept < BIG.length, String(kept));
    r = await call('GET');
    assert.equal(r.body.items[0].state, 'paused');
    await call('POST', { id: it.id, action: 'resume' });
    await new Promise((res) => setTimeout(res, 60));
    assert.match(seen.filter((x) => x.url === '/big.bin').at(-1).range ?? '', /^bytes=[1-9]\d*-$/, 'resumed with Range from the kept bytes');
    r = await call('POST', { id: it.id, action: 'cancel' });
    assert.equal(r.body.item.state, 'missing');
    assert.match(r.body.item.message, /Cancelled; the partial download was deleted/);
    assert.ok(!existsSync(path.join(root, 'downloads', 'partial', it.id)), 'partial folder deleted');
    assert.ok(!existsSync(path.join(root, 'models', 'test', 'big.bin')));
    void d;
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('never while live: a start is refused, a running download pauses itself when the stream starts, and the flag off refuses', async () => {
  const { s, base } = await server({ '/big.bin': BIG, '/small.txt': SMALL }, { slow: 10_000 });
  const root = tmp('live');
  try {
    let live = true;
    const it = item(base);
    const { d, call } = mgr(root, [it], { live: () => live });
    let r = await call('POST', { id: it.id, action: 'start' });
    assert.equal(r.code, 409);
    assert.equal(r.body.error, 'live');
    assert.match(r.body.message, /wait until the stream and the recording have stopped/);
    assert.ok(!existsSync(path.join(root, 'downloads')), 'nothing written');
    live = false;
    r = await call('POST', { id: it.id, action: 'start' });
    assert.equal(r.code, 200);
    await new Promise((res) => setTimeout(res, 80));
    live = true;
    await d.promise(it.id);
    const v = (await call('GET')).body.items[0];
    assert.equal(v.state, 'paused');
    assert.match(v.message, /Paused because the stream or a recording started/);
    // host status unknown counts as live (fail closed)
    const off = createDownloads({ json: (res, c, b) => { res.code = c; res.body = b; }, dataRoot: root, items: [it], hostStatus: async () => { throw new Error('no host'); } });
    const res = {};
    await off.handle('POST', '/ui/api/downloads', res, { id: it.id, action: 'resume' });
    assert.equal(res.code, 409);
    const flagOff = createDownloads({ json: (x, c, b) => { x.code = c; x.body = b; }, dataRoot: root, items: [it], isOn: () => false, hostStatus: async () => ({ live: false }) });
    const res2 = {};
    await flagOff.handle('POST', '/ui/api/downloads', res2, { id: it.id, action: 'resume' });
    assert.deepEqual([res2.code, res2.body.error], [409, 'off']);
    const res3 = {};
    await flagOff.handle('POST', '/ui/api/downloads', res3, { id: it.id, action: 'start', extra: 1 });
    assert.equal(res3.code, 400);
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('archive members: the archive is checked, then each member is checked and put in place', async () => {
  const root = tmp('zip');
  const src = tmp('zipsrc');
  try {
    const a = path.join(src, 'a.onnx');
    const b = path.join(src, 'b.data');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(a, BIG); writeFileSync(b, SMALL);
    const z = path.join(src, 'pack.zip');
    writeZip(z, [{ name: 'pack/a.onnx', file: a }, { name: 'pack/b.data', file: b }]);
    const zb = readFileSync(z);
    const { s, base } = await server({ '/pack.zip': zb });
    try {
      const archive = { url: `${base}/pack.zip`, bytes: zb.length, sha256: sha(zb) };
      const it = item(base, { files: [{ name: 'a.onnx', bytes: BIG.length, sha256: sha(BIG), archive: { ...archive, member: 'pack/a.onnx' } }, { name: 'b.data', bytes: SMALL.length, sha256: sha(SMALL), archive: { ...archive, member: 'pack/b.data' } }] });
      assert.deepEqual(itemProblems(it).filter((p) => !/^url of /.test(p)), [], 'only the test server\'s http URL differs from a real item');
      const { d, call } = mgr(root, [it]);
      assert.equal((await call('GET')).body.items[0].total, zb.length, 'the archive is counted once');
      await call('POST', { id: it.id, action: 'start' });
      await d.promise(it.id);
      assert.equal((await call('GET')).body.items[0].state, 'ready');
      assert.deepEqual(readFileSync(path.join(root, 'models', 'test', 'a.onnx')), BIG);
      assert.deepEqual(readdirSync(path.join(root, 'models', 'test')).sort(), [MARKER, 'a.onnx', 'b.data'].sort());
    } finally { s.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(src, { recursive: true, force: true }); }
});

test('guard: a test data root may never be the real %LOCALAPPDATA%\\Ujwalam', () => {
  assert.throws(() => safeRoot(path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Ujwalam', 'data')), /real Ujwalam folder/);
  assert.throws(() => safeRoot(path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Ujwalam')), /real Ujwalam folder/);
  assert.equal(safeRoot(path.join(os.tmpdir(), 'x')), path.join(os.tmpdir(), 'x'));
});

test('never while live: with 2 queued, the stream starting pauses the whole queue and the second is never requested', async () => {
  const OTHER = blob(300_000, 5);
  const { s, seen, base } = await server({ '/big.bin': BIG, '/small.txt': SMALL, '/other.bin': OTHER }, { slow: 10_000 });
  const root = tmp('queue');
  try {
    let live = false;
    const a = item(base);
    const b = item(base, { id: 'second-model', dest: 'models/second', files: [{ name: 'other.bin', url: `${base}/other.bin`, bytes: OTHER.length, sha256: sha(OTHER) }] });
    const { d, call } = mgr(root, [a, b], { live: () => live });
    assert.equal((await call('POST', { id: a.id, action: 'start' })).code, 200);
    assert.equal((await call('POST', { id: b.id, action: 'start' })).body.item.state, 'queued');
    await new Promise((r) => setTimeout(r, 80));
    live = true;
    await d.promise(a.id);
    await new Promise((r) => setTimeout(r, 150));
    const v = (await call('GET')).body.items;
    assert.deepEqual(v.map((x) => x.state), ['paused', 'paused']);
    assert.match(v[1].message, /Paused because the stream or a recording started/);
    assert.equal(seen.filter((x) => x.url === '/other.bin').length, 0, 'no request for the second download');
    // the next start is also checked: still live, refused
    assert.equal((await call('POST', { id: b.id, action: 'resume' })).code, 409);
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a finished part changed with the same length is checked again on resume and fetched again; a ready file changed in place is no longer ready', async () => {
  const { s, seen, base } = await server({ '/big.bin': BIG, '/small.txt': SMALL });
  const root = tmp('rehash');
  try {
    const it = item(base);
    const part = path.join(root, 'downloads', 'partial', it.id);
    mkdirSync(part, { recursive: true });
    writeFileSync(path.join(part, 'big.bin'), blob(BIG.length, 42)); // "finished" earlier, same length, wrong bytes
    const { d, call } = mgr(root, [it]);
    await call('POST', { id: it.id, action: 'start' });
    await d.promise(it.id);
    assert.equal((await call('GET')).body.items[0].state, 'ready');
    assert.equal(seen.filter((x) => x.url === '/big.bin').length, 1, 'fetched again');
    const f = path.join(root, 'models', 'test', 'big.bin');
    assert.deepEqual(readFileSync(f), BIG);
    assert.ok(isReady(root, it));
    const t0 = new Date(Date.now() + 5000);
    writeFileSync(f, blob(BIG.length, 43)); // same length, changed in place
    utimesSync(f, t0, t0);
    assert.equal(isReady(root, it), false);
    assert.equal((await call('GET')).body.items[0].state, 'missing');
  } finally { s.close(); rmSync(root, { recursive: true, force: true }); }
});