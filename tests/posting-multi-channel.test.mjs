// SPDX-License-Identifier: GPL-3.0-or-later
// YM1-YM5 (plan docs/plan/2026-11-25-youtube-multi-account.md): several YouTube channels for auto-posting. Fakes only: no
// network, no Google, no Credential Manager (in-memory stores), temp data folders, placeholder channels.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { QUEUE_NAME, createPostChain, createUploadQueue, markPosted } from '../services/posting/auto-chain.mjs';
import { ACCOUNTS_NAME, MAIN, accountOf, dayCap, dealPool, loadChannelDefaults, readAccounts, readChannelState, refreshTargetFor, updateAccounts } from '../services/posting/accounts.mjs';
import { createPostStore, postId } from '../services/posting/index.mjs';
import { READONLY_SCOPE, REFRESH_TARGET, createYoutubeAuth } from '../services/posting/oauth.mjs';
import { exhaustedUntil } from '../services/posting/quota-budget.mjs';

const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ym-')); tmp.push(d); mkdirSync(path.join(d, 'posting'), { recursive: true }); writeFileSync(path.join(d, 'posting', 'schedule.json'), JSON.stringify({ placement: 'fill-gaps' })); return d; };
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const T0 = Date.parse('2026-11-08T10:00:00Z');
const RULES = { autoUpload: true, maxUploadsPerDay: 20, rules: [{ id: 'top', target: 'youtube-shorts', minScore: 5, maxPerDay: 20 }] };
const IDLE = { sinks: [{ id: 'yt', kind: 'stream', state: 'stopped' }] };
const A = 'ch-aaaaaa1'; const B = 'ch-bbbbbb2';

/** Draft posts (score 9) in a ledger plus their uploads.json rows. target per clip: 'youtube-shorts' unless named in videos. */
function env(clips, { videos = [] } = {}) {
  const dataDir = mk(); const entries = {}; const ids = {}; const rows = [];
  for (const [n, clip] of clips.entries()) {
    const target = videos.includes(clip) ? 'youtube-video' : 'youtube-shorts';
    const video = Buffer.from(`video-${clip}`.repeat(5));
    const sha = createHash('sha256').update(video).digest('hex');
    const dir = path.join(dataDir, 'posts', clip, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'v.mp4'), video);
    const stamp = `2026-11-08T0${Math.min(9, n)}:00:0${n % 10}.000Z`;
    writeFileSync(path.join(dir, 'post.json'), JSON.stringify({
      version: 1, title: `T ${clip}`, description: 'D', tags: ['g'], hashtags: ['#Shorts'], target, privacy: 'private', status: 'draft',
      source: { run: 'run1', clipId: clip, layout: 'v', startSec: 1, endSec: 3, score: 9, sha256: sha },
      video: { file: 'v.mp4', bytes: video.length }, limits: { status: 'unverified', ok: true, checks: [] }, unresolved: [], createdAt: stamp, updatedAt: stamp,
    }));
    entries[`${sha}:${target}`] = { sha256: sha, target, status: 'draft', dir, clipId: clip, createdAt: stamp, updatedAt: stamp };
    ids[clip] = postId({ sha256: sha, target });
    rows.push({ file: path.join(dir, 'v.mp4'), kind: 'short', label: 'x', seconds: 3, run: 'run1', recording: 'r', posted: [], addedAt: stamp });
  }
  const ledgerFile = path.join(dataDir, 'posting', 'ledger.json');
  writeFileSync(ledgerFile, JSON.stringify({ version: 1, entries }));
  mkdirSync(path.join(dataDir, 'clips'), { recursive: true });
  writeFileSync(path.join(dataDir, 'clips', 'uploads.json'), JSON.stringify({ version: 1, files: rows }));
  const rulesFile = path.join(dataDir, 'rules.json'); writeFileSync(rulesFile, JSON.stringify(RULES));
  const queue = () => createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME));
  return { dataDir, ids, rulesFile, ledgerFile, queue, store: () => createPostStore({ ledgerFile }) };
}

/** Fake YouTube for several channels: the Bearer token says which channel a request is for. */
function fakeYt({ limitFor = new Set() } = {}) {
  const inits = []; const sessions = new Map(); const byVideo = new Map(); let vid = 0;
  const tok = (o) => String(o.headers?.Authorization ?? '').replace(/^Bearer /, '');
  const fetchImpl = async (url, o = {}) => {
    const u = String(url);
    const api = /youtube\/v3\/(channels|playlistItems)\?/.exec(u);
    if (api) return { ok: true, status: 200, json: async () => (api[1] === 'channels' ? { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] } : { items: [] }) };
    if (u.includes('uploadType=resumable')) {
      const t = tok(o);
      if (limitFor.has(t)) return { ok: false, status: 403, headers: new Map(), text: async () => JSON.stringify({ error: { errors: [{ reason: 'uploadLimitExceeded' }] } }) };
      const s = `https://fake.invalid/session/${inits.length + 1}`;
      inits.push({ token: t, title: JSON.parse(o.body).snippet.title });
      sessions.set(s, { n: 0, token: t });
      return { ok: true, status: 200, headers: new Map([['location', s]]) };
    }
    const cr = o.headers?.['Content-Range'] ?? '';
    const ss = sessions.get(u);
    if (cr.startsWith('bytes */')) return { ok: false, status: 308, headers: new Map(ss?.n ? [['range', `bytes=0-${ss.n - 1}`]] : []) };
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    ss.n = Number(m[2]) + 1;
    if (ss.n >= Number(m[3])) { vid++; byVideo.set(`vid${vid}`, ss.token); return { ok: true, status: 200, headers: new Map(), json: async () => ({ id: `vid${vid}` }) }; }
    return { ok: false, status: 308, headers: new Map() };
  };
  return { fetchImpl, inits, tokenOf: (v) => byVideo.get(v) };
}
const auth = (token, { fail = false, signedIn = true } = {}) => ({
  status: async () => ({ signedIn, hasClient: true }),
  accessToken: async () => { if (fail) throw Object.assign(new Error('rejected'), { code: 'oauth-reauth-needed' }); return token; },
  grantedScopes: async () => [READONLY_SCOPE],
});
const AUTHS = () => ({ [MAIN]: auth('tok-main'), [A]: auth('tok-A'), [B]: auth('tok-B') });

function chain(e, { yt, auths = AUTHS(), clock = { t: T0 }, budget } = {}) {
  const c = createPostChain({ dataDir: e.dataDir, flags: { isOn: (id) => id !== 'post-delete-uploaded' }, rulesFile: e.rulesFile, auth: auths[MAIN], authFor: (acct) => auths[acct] ?? null,
    fetchImpl: yt.fetchImpl, now: () => clock.t, tickEveryMs: 0, profileFile: path.join(e.dataDir, 'none.json'), packageImpl: async () => ({ packaged: [], skipped: [] }), scanFolder: false,
    ...(budget ? { budget } : {}) });
  return { c, clock };
}
const addChannels = (dataDir, list) => updateAccounts(dataDir, (doc) => { for (const a of list) doc.accounts.push({ enabled: true, addedAt: '2026-11-26T00:00:00Z', shortsOnly: true, ...a }); });
const byAccount = (e) => { const out = {}; for (const i of e.queue().items()) { const k = String(accountOf(i)); out[k] = (out[k] ?? 0) + 1; } return out; };
const ticks = async (c, n) => { for (let k = 0; k < n; k++) await c.tick(IDLE); };

describe('YM1 accounts and migration', () => {
  test('a data folder from before YM1 reads as one channel, main, with the old token target', () => {
    const d = mk();
    assert.deepEqual(readAccounts(d).accounts, [{ id: MAIN, label: 'Main channel', enabled: true, addedAt: null }]);
    assert.equal(existsSync(path.join(d, 'posting', ACCOUNTS_NAME)), false, 'reading writes nothing');
    assert.equal(refreshTargetFor(MAIN), REFRESH_TARGET);
    assert.equal(refreshTargetFor(A), `${REFRESH_TARGET}/${A}`);
    assert.throws(() => refreshTargetFor('../x'), /not a channel id/);
    assert.equal(accountOf({ id: 'x' }), MAIN, 'an item without the field is main');
    assert.equal(accountOf({ id: 'x', account: null }), null, 'null = the pool');
  });

  test('an old queue item (no account field, its slot set) uploads on main at its own time; nothing is rewritten', async () => {
    const e = env(['a']);
    // the queue as an older build wrote it: no account field, a slot already given
    writeFileSync(path.join(e.dataDir, 'posting', QUEUE_NAME), JSON.stringify({ version: 1, note: null, items: { [e.ids.a]: { id: e.ids.a, state: 'queued', attempts: 0, nextAt: null, reason: null, videoId: null, session: null, publishAt: '2026-11-08T15:00:00.000Z', enqueuedAt: '2026-11-08T09:00:00.000Z', updatedAt: '2026-11-08T09:00:00.000Z' } } }));
    const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.tick(IDLE);
    const it = e.queue().get(e.ids.a);
    assert.deepEqual([it.state, it.sentPublishAt, Object.hasOwn(it, 'account')], ['done', '2026-11-08T15:00:00.000Z', false]);
    assert.deepEqual(yt.inits.map((x) => x.token), ['tok-main']);
    assert.equal(existsSync(path.join(e.dataDir, 'posting', ACCOUNTS_NAME)), false, 'no channel list is made for a single channel');
  });

  test('one channel only: every new clip goes to main and uploads as before', async () => {
    const e = env(['a', 'b', 'c']); const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.tick(IDLE);
    assert.deepEqual(byAccount(e), { main: 3 });
    assert.equal(yt.inits.length, 3, 'no one-per-pass limit with a single channel');
  });

  test('the defaults for new channels are data (3 to 6 a day, Shorts only)', () => {
    const d = loadChannelDefaults();
    assert.deepEqual([d.postsPerDay, d.shortsOnly], [{ min: 3, max: 6 }, true]);
  });
});

describe('YM2 one sign-in per channel', () => {
  test('two channels keep separate tokens; signing one out leaves the other', async () => {
    const vault = new Map();
    const store = (target) => ({ get: async () => vault.get(target) ?? null, set: async (v) => { vault.set(target, v); }, delete: async () => vault.delete(target) });
    const common = { clientIdStore: { get: async () => 'cid' }, clientSecretStore: { get: async () => 'secret' }, browserOpen: async () => {} };
    vault.set(refreshTargetFor(MAIN), 'refresh-main'); vault.set(refreshTargetFor(A), 'refresh-A');
    const main = createYoutubeAuth({ ...common, refreshStore: store(refreshTargetFor(MAIN)) });
    const a = createYoutubeAuth({ ...common, refreshStore: store(refreshTargetFor(A)) });
    await a.signOut();
    assert.deepEqual([(await main.status()).signedIn, (await a.status()).signedIn], [true, false]);
    assert.deepEqual([...vault.keys()], ['Ujwalam/posting/youtube-refresh']);
  });
});

describe('YM3/YM4 dealing in turn', () => {
  test('dealPool: main, A, B in turn; a full channel and a Shorts-only channel for a long video are skipped', () => {
    const pool = ['1', '2', '3', '4', '5', '6'].map((id) => ({ id, target: id === '4' ? 'youtube-video' : 'youtube-shorts' }));
    const r = dealPool({ pool, channels: [{ id: MAIN, room: Infinity }, { id: A, room: 2, shortsOnly: true }, { id: B, room: 1, shortsOnly: true }] });
    assert.deepEqual(r.assign, [['1', MAIN], ['2', A], ['3', B], ['4', MAIN], ['5', A], ['6', MAIN]]);
    assert.equal(r.turn, A);
    const none = dealPool({ pool, channels: [{ id: A, room: 0 }] });
    assert.deepEqual(none.assign, [], 'nothing fits: everything stays in the pool');
  });

  test('dayCap: a whole number in the range, the same all day, never past the maximum', () => {
    const acct = { id: A, postsPerDay: { min: 3, max: 6 } };
    const seen = new Set();
    for (let d = 1; d <= 28; d++) { const v = dayCap(acct, `2026-12-${String(d).padStart(2, '0')}`); assert.ok(v >= 3 && v <= 6); seen.add(v); }
    assert.ok(seen.size > 1, 'it changes between days');
    assert.equal(dayCap(acct, '2026-12-01'), dayCap(acct, '2026-12-01'));
    assert.equal(dayCap({ id: MAIN }, '2026-12-01'), null, 'main has no own count');
  });

  test('take turns with caps: each channel posts its own clips with its own token, never past its count, none twice', async () => {
    const e = env(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 2, max: 2 } }, { id: B, label: 'Channel B', postsPerDay: { min: 1, max: 1 } }]);
    const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.tick(IDLE);
    assert.deepEqual(byAccount(e), { main: 5, [A]: 2, [B]: 1 }, 'main, A, B, main, A, (B full) main, main, main');
    assert.equal(yt.inits.length, 3, 'several channels: one upload each per pass');
    await ticks(c, 6);
    const items = e.queue().items();
    assert.ok(items.every((i) => i.state === 'done'), 'all uploaded');
    assert.equal(yt.inits.length, 8, 'each clip uploaded once');
    assert.equal(new Set(yt.inits.map((x) => x.title)).size, 8, 'no clip twice');
    for (const i of items) assert.equal(yt.tokenOf(i.videoId), `tok-${accountOf(i) === MAIN ? 'main' : accountOf(i) === A ? 'A' : 'B'}`, 'uploaded with its own channel sign-in');
    // per-channel slots: the gap applies inside a channel, so A's first post may share main's first hour
    const first = (acct) => items.filter((i) => accountOf(i) === acct).map((i) => i.sentPublishAt).sort()[0];
    assert.equal(first(A), first(MAIN));
    const ledger = JSON.parse(readFileSync(e.ledgerFile, 'utf8')).entries;
    assert.equal(Object.values(ledger).filter((x) => x.account === A).length, 2, 'the ledger records the added channel');
    assert.equal(Object.values(ledger).filter((x) => x.account === MAIN).length, 0, "main's entries stay as before");
  });

  test('a long video never goes to a Shorts-only channel', async () => {
    const e = env(['a', 'b', 'c'], { videos: ['b'] });
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 5, max: 5 } }]);
    const rf = JSON.parse(readFileSync(e.rulesFile, 'utf8')); rf.rules.push({ id: 'long', target: 'youtube-video', minScore: 5, maxPerDay: 5 }); writeFileSync(e.rulesFile, JSON.stringify(rf));
    const { c } = chain(e, { yt: fakeYt() });
    await c.tick(IDLE);
    const b = e.queue().get(e.ids.b);
    assert.ok(b, 'the long video is queued');
    assert.equal(b.account, MAIN);
    assert.ok(e.queue().items().some((i) => i.account === A), 'A still takes the Shorts');
  });

  test("an added channel never uploads past today's count; the rest waits for tomorrow", async () => {
    const e = env(['a', 'b', 'c']);
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 1, max: 1 } }]);
    const yt = fakeYt(); const { c } = chain(e, { yt });
    await ticks(c, 1);
    // give A a second clip by hand (as if it had been dealt): its pass must still stop at 1 today
    const mainWaiting = e.queue().items().find((i) => accountOf(i) === MAIN && i.state === 'queued');
    e.queue().patch(mainWaiting.id, { account: A, publishAt: null });
    await ticks(c, 3);
    assert.equal(e.queue().items().filter((i) => accountOf(i) === A && i.state === 'done').length, 1);
    assert.equal(e.queue().get(mainWaiting.id).reason, 'channel-day-full');
  });
});

describe('YM5 failures stay with their channel', () => {
  test('a channel whose token fails is skipped; its clips go to the others', async () => {
    const e = env(['a', 'b', 'c', 'd', 'e', 'f']);
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 2, max: 2 } }, { id: B, label: 'Channel B', postsPerDay: { min: 2, max: 2 } }]);
    const auths = { ...AUTHS(), [A]: auth('tok-A', { fail: true }) };
    const yt = fakeYt(); const { c } = chain(e, { yt, auths });
    await c.tick(IDLE);
    assert.equal(readChannelState(e.dataDir).paused[A].reason, 'not-signed-in');
    assert.ok(yt.inits.some((x) => x.token === 'tok-main') && yt.inits.some((x) => x.token === 'tok-B'), 'main and B still post');
    await ticks(c, 8);
    assert.ok(e.queue().items().every((i) => i.state === 'done'), 'every clip went up on another channel');
    assert.ok(!yt.inits.some((x) => x.token === 'tok-A'));
    assert.equal(e.queue().items().filter((i) => accountOf(i) === A).length, 0);
  });

  test("YouTube's upload limit for one channel pauses only it until the next Pacific midnight; the project quota is not marked used", async () => {
    const e = env(['a', 'b', 'c', 'd']);
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 3, max: 3 } }]);
    const yt = fakeYt({ limitFor: new Set(['tok-A']) }); const { c } = chain(e, { yt });
    await ticks(c, 6);
    const p = readChannelState(e.dataDir).paused[A];
    assert.equal(p.reason, 'upload-limit');
    assert.equal(p.until, '2026-11-09T08:00:00.000Z', 'midnight in Los Angeles (PST)');
    assert.equal(exhaustedUntil(e.dataDir, T0), null, 'the shared quota stays open for the other channels');
    assert.ok(e.queue().items().every((i) => i.state === 'done' && accountOf(i) === MAIN), 'main took them all');
  });

  test('the quota is one budget for every channel: each upload is counted once, and when it is used up every channel waits', async () => {
    const e = env(['a', 'b', 'c', 'd', 'e', 'f']);
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 3, max: 3 } }, { id: B, label: 'Channel B', postsPerDay: { min: 3, max: 3 } }]);
    let used = 0; const LIMIT = 4;
    const budget = { meter: (f) => f, uploadBlock: () => (used >= LIMIT ? 'quota-day-used' : null), reserveUpload: () => { if (used >= LIMIT) return 'quota-day-used'; used++; return null; },
      readBlock: () => null, reserveScan: (u, f) => ({ fetch: f, done: () => {} }), reserveCaption: () => 'quota-day-used' };
    const yt = fakeYt(); const { c } = chain(e, { yt, budget });
    await ticks(c, 5);
    assert.deepEqual([used, yt.inits.length], [4, 4]);
    assert.equal(new Set(yt.inits.map((x) => x.token)).size, 3, 'all three channels used the one budget');
    const left = e.queue().items().filter((i) => i.state === 'queued');
    assert.equal(left.length, 2);
    assert.ok(left.every((i) => i.reason === 'quota-day-used'));
  });
});

describe('removing a channel', () => {
  test('its uploaded posts stay with it; its waiting clips go back to the pool and to the others', async () => {
    const e = env(['a', 'b', 'c', 'd']);
    addChannels(e.dataDir, [{ id: A, label: 'Channel A', postsPerDay: { min: 3, max: 3 } }]);
    const yt = fakeYt(); const { c } = chain(e, { yt });
    await c.tick(IDLE);
    const doneA = e.queue().items().filter((i) => accountOf(i) === A && i.state === 'done');
    const waitA = e.queue().items().filter((i) => accountOf(i) === A && i.state === 'queued');
    assert.deepEqual([doneA.length, waitA.length], [1, 1]);
    updateAccounts(e.dataDir, (doc) => { doc.accounts = doc.accounts.filter((a) => a.id !== A); });
    await ticks(c, 4);
    const after1 = e.queue().get(doneA[0].id);
    assert.deepEqual([after1.state, accountOf(after1), after1.videoId], ['done', A, doneA[0].videoId], 'the uploaded one is left alone');
    const moved = e.queue().get(waitA[0].id);
    assert.deepEqual([moved.state, accountOf(moved)], ['done', MAIN], 'the waiting one went to main');
    assert.equal(yt.inits.length, 4, 'nothing uploaded twice');
  });

  test('markPosted records the added channel on the uploads row', async () => {
    const e = env(['a']);
    const sha = JSON.parse(readFileSync(e.ledgerFile, 'utf8')).entries[Object.keys(JSON.parse(readFileSync(e.ledgerFile, 'utf8')).entries)[0]].sha256;
    await markPosted({ dataDir: e.dataDir, run: 'run1', sha256: sha, postIdValue: e.ids.a, videoId: 'vidX', at: '2026-11-08T10:00:00Z', account: A });
    const row = JSON.parse(readFileSync(path.join(e.dataDir, 'clips', 'uploads.json'), 'utf8')).files[0];
    assert.equal(row.posted[0].account, A);
  });
});
