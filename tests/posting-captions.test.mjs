// SPDX-License-Identifier: GPL-3.0-or-later
// C1 (user 2026-11-24: long video captions "burned in and uploaded"; shorts and reels burned in only). The long
// highlights package carries <video>.srt as captions.srt; after the video's upload it goes up as a caption track
// (captions.insert, youtube.force-ssl, quota.json captionUnits). Fakes only: temp dirs, an injected fetch, no Google.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { sendCaptions } from '../services/posting/auto-chain.mjs';
import { CAPTION_UPLOAD_KINDS, createPostStore, packageUploads } from '../services/posting/index.mjs';
import { CAPTIONS_SCOPE } from '../services/posting/oauth.mjs';
import { createQuotaBudget, loadQuota } from '../services/posting/quota-budget.mjs';
import { CAPTION_TRACK, uploadCaptions } from '../services/posting/youtube.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-c1-')); tmp.push(d); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const SRT = '1\n00:00:01,000 --> 00:00:02,500\nnice shot\n\n';
const PROFILE = { handles: { youtube: '@example-channel' } };

function setup(rows) {
  const dataDir = mk(); const clips = mk();
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  const files = rows.map((r, i) => {
    const file = path.join(clips, r.name);
    writeFileSync(file, Buffer.from(`${r.name}-${i}`.repeat(8)));
    if (r.srt) writeFileSync(file.replace(/\.mp4$/, '.srt'), SRT);
    return { file, label: 'x', run: 'run1', recording: 'r', posted: [], addedAt: '2026-11-24T09:00:00.000Z', kind: r.kind, seconds: r.seconds };
  });
  mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files }));
  return { dataDir, ledgerFile: path.join(dataDir, 'posting', 'ledger.json') };
}

/** Fetch fake: records each request; answers with the given status and JSON body. */
function fakeFetch(status = 200, json = { id: 'cap1' }) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => json }; };
  return { f, calls };
}

describe('package: only the long video carries its caption file', () => {
  test('long highlights with <video>.srt -> captions.srt in the package; a short with one -> none (burned in only)', async () => {
    assert.deepEqual(CAPTION_UPLOAD_KINDS, ['long-highlights']);
    const e = setup([
      { name: 'codm_long-highlights_20261124-200000_kills-41_01_h.mp4', kind: 'long-highlights', seconds: 742, srt: true },
      { name: 'codm_short_20261124-185841_triple-kill_01_v.mp4', kind: 'short', seconds: 12, srt: true },
    ]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: process.execPath });
    assert.equal(r.packaged.length, 2);
    const store = createPostStore({ ledgerFile: e.ledgerFile, dataDir: e.dataDir });
    const byKind = Object.fromEntries(store.list().map((p) => [p.source?.kind ?? p.kind, p]));
    const long = byKind['long-highlights'];
    const short = byKind.short;
    assert.ok(long && short, JSON.stringify(Object.keys(byKind)));
    const sub = store.media(long.id, 'subtitles');
    assert.ok(sub, 'the long video package has its caption file');
    assert.equal(readFileSync(sub.file, 'utf8'), SRT);
    assert.equal(store.media(short.id, 'subtitles'), null, 'a short keeps its captions burned in only');
  });

  test('long highlights without a caption file -> no captions (the video still packages)', async () => {
    const e = setup([{ name: 'codm_long-highlights_20261124-210000_kills-12_01_h.mp4', kind: 'long-highlights', seconds: 600 }]);
    const r = await packageUploads({ dataDir: e.dataDir, ledgerFile: e.ledgerFile, profile: PROFILE, ffmpeg: process.execPath });
    assert.equal(r.packaged.length, 1);
    const store = createPostStore({ ledgerFile: e.ledgerFile, dataDir: e.dataDir });
    assert.equal(store.media(store.list()[0].id, 'subtitles'), null);
  });
});

describe('uploadCaptions (captions.insert, multipart)', () => {
  test('metadata then the .srt bytes, the track name and language, the bearer token', async () => {
    const d = mk(); const srt = path.join(d, 'c.srt'); writeFileSync(srt, SRT);
    const { f, calls } = fakeFetch();
    assert.deepEqual(await uploadCaptions({ videoId: 'vid1', accessToken: 'tok', srtPath: srt, fetchImpl: f }), { id: 'cap1' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.match(url, /^https:\/\/www\.googleapis\.com\/upload\/youtube\/v3\/captions\?uploadType=multipart&part=snippet$/);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
    const body = init.body.toString('utf8');
    assert.equal(String(init.body.length), init.headers['Content-Length']);
    const parts = body.split(`--${boundary}`);
    assert.equal(parts.length, 4, 'preamble, metadata, file, closing');
    const meta = JSON.parse(parts[1].split('\r\n\r\n')[1]);
    assert.deepEqual(meta, { snippet: { videoId: 'vid1', language: CAPTION_TRACK.language, name: CAPTION_TRACK.name, isDraft: false } });
    assert.ok(parts[2].endsWith(`\r\n\r\n${SRT}\r\n`));
    assert.equal(parts[3], '--\r\n');
  });

  test('403 without a quota reason -> captions-not-permitted; quotaExceeded -> quota-exceeded; 500 -> captions-failed', async () => {
    const d = mk(); const srt = path.join(d, 'c.srt'); writeFileSync(srt, SRT);
    const call = (status, json) => uploadCaptions({ videoId: 'v', accessToken: 't', srtPath: srt, fetchImpl: fakeFetch(status, json).f });
    await assert.rejects(call(403, { error: { errors: [{ reason: 'forbidden' }] } }), { code: 'captions-not-permitted' });
    await assert.rejects(call(403, { error: { errors: [{ reason: 'quotaExceeded' }] } }), { code: 'quota-exceeded' });
    await assert.rejects(call(500, null), { code: 'captions-failed' });
  });
});

describe('sendCaptions: after the upload, never instead of it', () => {
  const T0 = Date.parse('2026-11-24T18:00:00Z');
  const QUOTA = { quotaUnitsPerDay: 10000, perUploadUnits: 50, readReserveUnits: 100, captionUnits: 400 };
  const subStore = (file) => ({ media: (id, kind) => (kind === 'subtitles' && file ? { file } : null) });
  const auth = (scopes) => ({ grantedScopes: async () => scopes, accessToken: async () => 'tok' });

  test('no caption file -> null, nothing sent or charged', async () => {
    const b = createQuotaBudget({ dataDir: mk(), nowMs: () => T0, quota: () => QUOTA });
    const { f, calls } = fakeFetch();
    assert.equal(await sendCaptions({ store: subStore(null), id: 'p', videoId: 'v', auth: auth([CAPTIONS_SCOPE]), budget: b, fetchImpl: f }), null);
    assert.equal(calls.length, 0);
    assert.equal(b.state().units.n, 0);
  });

  test('without the force-ssl permission -> captions-scope-missing, nothing sent or charged', async () => {
    const d = mk(); const srt = path.join(d, 'c.srt'); writeFileSync(srt, SRT);
    const b = createQuotaBudget({ dataDir: mk(), nowMs: () => T0, quota: () => QUOTA });
    const { f, calls } = fakeFetch();
    assert.equal(await sendCaptions({ store: subStore(srt), id: 'p', videoId: 'v', auth: auth(['https://www.googleapis.com/auth/youtube.upload']), budget: b, fetchImpl: f }), 'captions-scope-missing');
    assert.equal(calls.length, 0);
    assert.equal(b.state().units.n, 0);
  });

  test('sent: captionUnits charged once; a day without room (never the read reserve) sends nothing', async () => {
    const d = mk(); const srt = path.join(d, 'c.srt'); writeFileSync(srt, SRT);
    const b = createQuotaBudget({ dataDir: mk(), nowMs: () => T0, quota: () => QUOTA });
    const { f, calls } = fakeFetch();
    assert.equal(await sendCaptions({ store: subStore(srt), id: 'p', videoId: 'v', auth: auth([CAPTIONS_SCOPE]), budget: b, fetchImpl: f }), 'sent');
    assert.equal(calls.length, 1);
    assert.equal(b.state().units.n, 400);
    b.chargeRead(10000 - 100 - 400 - 399); // 9101 used: 400 more would reach into the 100-unit read reserve
    assert.equal(await sendCaptions({ store: subStore(srt), id: 'p', videoId: 'v', auth: auth([CAPTIONS_SCOPE]), budget: b, fetchImpl: f }), 'quota-day-used');
    assert.equal(calls.length, 1);
  });

  test('the shipped quota file knows the captions.insert cost', () => {
    assert.equal(loadQuota(mk()).captionUnits, 400);
  });
});
