// SPDX-License-Identifier: GPL-3.0-or-later
// Download manager (single-file setup, 2026-11-19; the user: "any downloadable needs to have a download manager within
// the app"). The setup carries everything the studio needs to stream, record and make clips; what it does not carry
// (big optional models) is listed in data/downloads/*.json and fetched here, on the user's click only.
//
//   GET  /ui/api/downloads                       { on, items: [{ id, name, purpose, neededBy, bytes, licence, checked,
//                                                   state, done, total, message }] }
//   POST /ui/api/downloads  { id, action }       action start | pause | resume | cancel; 200 { item } | 409 { error, message }
//
// state: missing | queued | downloading | verifying | paused | ready | failed. One download at a time, at low priority
// for the network (64 KiB reads, no parallel files). Each file goes to <data root>\downloads\partial\<id>\<file>.part
// and resumes from there with an HTTP Range request; a server that ignores Range restarts the file. When a file is
// complete its size and SHA-256 must match the manifest, else it is deleted and fetched once more, then the item
// fails with a plain message. Network errors retry 3 times (2 s, 6 s, 18 s). Cancel stops and deletes the partial
// files; Pause keeps them. Finished files move into <data root>\<dest> (never the install folder), with a
// .ujwalam-download.json marker listing what was checked.
// Never while live: start and resume are refused while the stream or the recording runs (or when that cannot be read),
// and a running download pauses itself when either starts (checked every 2 s; the download is never on the stream's
// path). Only https URLs, except http on 127.0.0.1 (tests).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntry, readZip } from '../../tools/package/zip.mjs';

export const ROUTE = '/ui/api/downloads';
export const FLAG = 'download-manager';
export const MARKER = '.ujwalam-download.json';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SAFE_DEST = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

/** Pure: one manifest item checked; returns a list of problems (empty = fine). */
export function itemProblems(it) {
  const p = [];
  if (!it || typeof it !== 'object') return ['not an object'];
  if (!ID_RE.test(it.id ?? '')) p.push('id');
  for (const k of ['name', 'purpose', 'licence', 'checked']) if (typeof it[k] !== 'string' || !it[k].trim()) p.push(k);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(it.checked ?? '')) p.push('checked (YYYY-MM-DD)');
  if (!SAFE_DEST.test(it.dest ?? '') || String(it.dest).split('/').includes('..')) p.push('dest');
  if (!Array.isArray(it.files) || !it.files.length) p.push('files');
  for (const f of it.files ?? []) {
    const src = f.archive ?? f;
    if (!SAFE_NAME.test(f.name ?? '')) p.push(`file name ${f.name}`);
    if (!/^https:\/\//.test(src.url ?? '')) p.push(`url of ${f.name}`);
    if (!Number.isInteger(src.bytes) || src.bytes <= 0) p.push(`bytes of ${f.name}`);
    if (!SHA_RE.test(src.sha256 ?? '')) p.push(`sha256 of ${f.name}`);
    if (f.archive) {
      if (typeof f.archive.member !== 'string' || !Number.isInteger(f.bytes) || !SHA_RE.test(f.sha256 ?? '')) p.push(`archive member of ${f.name}`);
    }
  }
  return p;
}

/** Reads data/downloads/*.json (each { items: [...] }); throws on a bad item (fail closed). */
export function loadItems(repo = REPO) {
  const dir = path.join(repo, 'data', 'downloads');
  const out = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^[a-z0-9-]+\.json$/.test(n)).sort(); } catch { return out; }
  for (const n of names) {
    const j = JSON.parse(readFileSync(path.join(dir, n), 'utf8'));
    for (const it of j.items ?? []) {
      const bad = itemProblems(it);
      if (bad.length) throw new Error(`data/downloads/${n}: item ${it?.id}: bad ${bad.join(', ')}`);
      if (out.some((x) => x.id === it.id)) throw new Error(`data/downloads/${n}: duplicate id ${it.id}`);
      out.push(it);
    }
  }
  return out;
}

export const itemBytes = (it) => it.files.reduce((s, f) => s + (f.archive ? 0 : f.bytes), 0)
  + [...new Map(it.files.filter((f) => f.archive).map((f) => [f.archive.url, f.archive.bytes])).values()].reduce((s, b) => s + b, 0);

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

const sizeOf = (f) => { try { return statSync(f).size; } catch { return -1; } };

/** True when every file of the item is in dest with its size and the marker lists the same SHA-256s (cheap: no hashing). */
export function isReady(dataRoot, it) {
  const dest = path.join(dataRoot, ...it.dest.split('/'));
  let m;
  try { m = JSON.parse(readFileSync(path.join(dest, MARKER), 'utf8')); } catch { return false; }
  return it.files.every((f) => m.files?.[f.name] === f.sha256 && sizeOf(path.join(dest, f.name)) === f.bytes);
}

function allowedUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && x.hostname === '127.0.0.1');
  } catch { return false; }
}

/**
 * Fetches url into file from its current size (Range). onBytes(n) is called as bytes arrive. Resolves with the final
 * size; rejects with e.code 'aborted' on signal, 'http' on a bad status. Follows up to 5 redirects (https only).
 */
export function fetchTo(url, file, { signal, onBytes = () => {}, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    if (!allowedUrl(url)) { reject(Object.assign(new Error(`refused URL ${url}`), { code: 'url' })); return; }
    const have = Math.max(0, sizeOf(file));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Ujwalam-download-manager', ...(have ? { Range: `bytes=${have}-` } : {}) }, signal }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) { reject(Object.assign(new Error('too many redirects'), { code: 'http' })); return; }
        fetchTo(new URL(res.headers.location, url).href, file, { signal, onBytes, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode === 416 && have) { res.resume(); resolve(have); return; } // already complete
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); reject(Object.assign(new Error(`the server answered ${res.statusCode}`), { code: 'http', status: res.statusCode })); return; }
      const append = res.statusCode === 206 && have > 0;
      if (!append && have) onBytes(-have); // the server ignored Range: start the file again
      const out = createWriteStream(file, { flags: append ? 'a' : 'w', highWaterMark: 1 << 16 });
      res.on('data', (d) => onBytes(d.length));
      res.pipe(out);
      const fail = (e) => { out.destroy(); reject(e?.name === 'AbortError' || signal?.aborted ? Object.assign(new Error('aborted'), { code: 'aborted' }) : e); };
      res.on('error', fail);
      res.on('aborted', () => fail(Object.assign(new Error('the connection dropped'), { code: 'net' })));
      out.on('error', fail);
      out.on('finish', () => resolve(sizeOf(file)));
    });
    req.on('error', (e) => reject(e?.name === 'AbortError' || signal?.aborted ? Object.assign(new Error('aborted'), { code: 'aborted' }) : e));
  });
}

/**
 * opts: { json, log, dataRoot, repo, items (tests), hostStatus: async () => host.status, isOn: () => flag, now,
 *         retryDelays (tests), watchMs (tests) }.
 * Returns { handle(method, route, res, body) -> Promise<boolean>, list(), run(id) (tests: the running promise) }.
 */
export function createDownloads(opts) {
  const { json, dataRoot } = opts;
  const log = opts.log ?? (() => {});
  const isOn = opts.isOn ?? (() => true);
  const delays = opts.retryDelays ?? [2000, 6000, 18000];
  const watchMs = opts.watchMs ?? 2000;
  let items;
  let loadError = null;
  try { items = opts.items ?? loadItems(opts.repo ?? REPO); } catch (e) { items = []; loadError = e.message; log(`downloads: ${e.message}`); }
  const st = new Map(); // id -> { state, done, total, message, ctrl, promise }
  const queue = [];
  let running = null;

  const partialDir = (it) => path.join(dataRoot, 'downloads', 'partial', it.id);
  const destDir = (it) => path.join(dataRoot, ...it.dest.split('/'));
  const sources = (it) => { // what is fetched: plain files, and each archive once
    const m = new Map();
    for (const f of it.files) {
      const s = f.archive ?? f;
      if (!m.has(s.url)) m.set(s.url, { url: s.url, bytes: s.bytes, sha256: s.sha256, name: f.archive ? `archive-${s.sha256.slice(0, 12)}.zip` : f.name });
    }
    return [...m.values()];
  };
  const partialBytes = (it) => sources(it).reduce((s, x) => s + Math.max(0, Math.min(x.bytes, sizeOf(path.join(partialDir(it), `${x.name}.part`)))) + (sizeOf(path.join(partialDir(it), x.name)) === x.bytes ? x.bytes : 0), 0);

  function view(it) {
    const s = st.get(it.id);
    const total = itemBytes(it);
    const ready = !s?.state || s.state === 'ready' ? isReady(dataRoot, it) : false;
    const state = s?.state && s.state !== 'ready' ? s.state : ready ? 'ready' : partialBytes(it) > 0 ? 'paused' : 'missing';
    return {
      id: it.id, name: it.name, purpose: it.purpose, neededBy: it.neededBy ?? null, bytes: total, licence: it.licence, checked: it.checked,
      state, done: state === 'ready' ? total : s?.done ?? partialBytes(it), total, message: s?.message ?? null,
    };
  }
  const list = () => items.map(view);

  async function onAir() {
    try {
      const hs = await opts.hostStatus();
      return !hs || hs.live === true || hs.recording === true || hs.starting === true;
    } catch { return true; }
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { code: 'aborted' })); }, { once: true });
  });

  async function fetchSource(it, s, src, ctrl) {
    const dir = partialDir(it);
    const done = path.join(dir, src.name);
    if (sizeOf(done) === src.bytes) return done; // fetched and checked in an earlier run
    const part = path.join(dir, `${src.name}.part`);
    for (let pass = 0; pass < 2; pass++) { // a checksum miss: delete and fetch once more
      let tries = 0;
      for (;;) {
        try {
          if (sizeOf(part) > src.bytes) rmSync(part, { force: true });
          if (sizeOf(part) < src.bytes) await fetchTo(src.url, part, { signal: ctrl.signal, onBytes: (n) => { s.done += n; } });
          break;
        } catch (e) {
          if (e.code === 'aborted' || e.code === 'url' || (e.code === 'http' && e.status && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
          if (tries >= delays.length) throw e;
          s.message = `Connection problem (${e.message}); trying again in ${Math.round(delays[tries] / 1000)} s.`;
          await sleep(delays[tries++], ctrl.signal);
          s.message = null;
        }
      }
      s.state = 'verifying';
      const ok = sizeOf(part) === src.bytes && (await sha256File(part)) === src.sha256;
      if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { code: 'aborted' });
      if (ok) { renameSync(part, done); s.state = 'downloading'; return done; }
      s.done -= Math.max(0, sizeOf(part));
      rmSync(part, { force: true });
      s.state = 'downloading';
      log(`downloads: ${it.id}/${src.name} did not match its checksum (pass ${pass + 1})`);
    }
    throw Object.assign(new Error(`${src.name} did not match its checksum after two downloads; nothing was kept. Try again later.`), { code: 'sha' });
  }

  async function install(it, got) {
    const dest = destDir(it);
    mkdirSync(dest, { recursive: true });
    const marker = { id: it.id, checked: new Date(opts.now?.() ?? Date.now()).toISOString(), files: {} };
    for (const f of it.files) {
      const target = path.join(dest, f.name);
      if (f.archive) {
        const zip = got.get(f.archive.url);
        const e = readZip(zip).find((x) => x.name === f.archive.member);
        if (!e) throw Object.assign(new Error(`${f.name} is not in the downloaded archive`), { code: 'sha' });
        const data = extractEntry(zip, e);
        if (data.length !== f.bytes || createHash('sha256').update(data).digest('hex') !== f.sha256) throw Object.assign(new Error(`${f.name} in the archive did not match its checksum`), { code: 'sha' });
        writeFileSync(`${target}.new`, data);
        renameSync(`${target}.new`, target);
      } else {
        rmSync(target, { force: true });
        renameSync(got.get(f.url), target);
      }
      marker.files[f.name] = f.sha256;
    }
    writeFileSync(path.join(dest, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    rmSync(partialDir(it), { recursive: true, force: true });
  }

  async function runOne(it) {
    const s = st.get(it.id);
    const ctrl = new AbortController();
    s.ctrl = ctrl;
    s.state = 'downloading';
    s.message = null;
    s.done = partialBytes(it);
    s.total = itemBytes(it);
    mkdirSync(partialDir(it), { recursive: true });
    // Live or recording starts: pause (the partial files stay; the user resumes after the stream).
    const watch = setInterval(async () => { if (await onAir() && !ctrl.signal.aborted) { s.why = 'live'; ctrl.abort(); } }, watchMs);
    try {
      const got = new Map();
      for (const src of sources(it)) got.set(src.url, await fetchSource(it, s, src, ctrl));
      s.state = 'verifying';
      await install(it, got);
      s.state = 'ready';
      s.message = null;
      log(`downloads: ${it.id} ready`);
    } catch (e) {
      if (e.code === 'aborted') {
        if (s.why === 'cancel') {
          rmSync(partialDir(it), { recursive: true, force: true });
          s.state = 'missing'; s.done = 0; s.message = 'Cancelled; the partial download was deleted.';
        } else {
          s.state = 'paused';
          s.message = s.why === 'live' ? 'Paused because the stream or a recording started. Resume it when you are off air.' : 'Paused.';
        }
      } else {
        s.state = 'failed';
        s.message = e.code === 'sha' ? e.message : `The download stopped: ${e.message}. Click Resume to try again; what is already downloaded is kept.`;
        log(`downloads: ${it.id} failed (${e.code ?? ''} ${e.message})`);
      }
    } finally {
      clearInterval(watch);
      s.ctrl = null;
      s.why = null;
    }
  }

  function pump() {
    if (running || !queue.length) return;
    const it = queue.shift();
    running = it.id;
    const p = runOne(it).finally(() => { running = null; pump(); });
    st.get(it.id).promise = p;
  }

  async function act(id, action) {
    const it = items.find((x) => x.id === id);
    if (!it) return [404, { error: 'unknown', message: 'There is no such download.' }];
    const s = st.get(id) ?? { state: null, done: 0, total: itemBytes(it), message: null };
    st.set(id, s);
    const cur = view(it).state;
    if (action === 'start' || action === 'resume') {
      if (!isOn()) return [409, { error: 'off', message: 'The download manager is switched off (Settings > Advanced).' }];
      if (cur === 'ready') return [200, { item: view(it) }];
      if (['queued', 'downloading', 'verifying'].includes(cur)) return [200, { item: view(it) }];
      if (await onAir()) return [409, { error: 'live', message: 'Downloads wait until the stream and the recording have stopped, so they never slow the stream down.' }];
      s.state = 'queued'; s.message = null;
      queue.push(it);
      pump();
      return [200, { item: view(it) }];
    }
    if (action === 'pause' || action === 'cancel') {
      const q = queue.indexOf(it);
      if (q >= 0) queue.splice(q, 1);
      if (s.ctrl) { s.why = action; s.ctrl.abort(); await s.promise?.catch(() => {}); } else if (action === 'cancel') {
        rmSync(partialDir(it), { recursive: true, force: true });
        s.state = cur === 'ready' ? null : 'missing'; s.done = 0; s.message = cur === 'ready' ? null : 'Cancelled; the partial download was deleted.';
      } else if (cur === 'queued') { s.state = 'paused'; s.message = 'Paused.'; }
      return [200, { item: view(it) }];
    }
    return [400, { error: 'bad-action', message: 'Unknown action.' }];
  }

  async function handle(method, route, res, body) {
    if (route !== ROUTE) return false;
    if (method === 'GET') { json(res, 200, { on: isOn(), items: list(), ...(loadError ? { error: loadError } : {}) }); return true; }
    if (method !== 'POST') return false;
    if (!body || typeof body.id !== 'string' || typeof body.action !== 'string' || Object.keys(body).some((k) => k !== 'id' && k !== 'action')) { json(res, 400, { error: 'bad-params' }); return true; }
    const [code, out] = await act(body.id, body.action);
    json(res, code, out);
    return true;
  }

  return { handle, list, act, promise: (id) => st.get(id)?.promise, ready: (id) => { const it = items.find((x) => x.id === id); return !!it && isReady(dataRoot, it); } };
}

