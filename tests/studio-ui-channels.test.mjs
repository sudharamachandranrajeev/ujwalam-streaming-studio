// SPDX-License-Identifier: GPL-3.0-or-later
// YM6 YouTube channels routes (Settings > Posting & growth) and SM5 (the scheduling manager's channel per row and filter).
// Fakes only: temp dirs, an in-memory token vault instead of Credential Manager, a fake Google, placeholder channels.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { QUEUE_NAME, createUploadQueue } from '../services/posting/auto-chain.mjs';
import { readAccounts, refreshTargetFor } from '../services/posting/accounts.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const KEY = 'k'.repeat(48);
const NOW = Date.parse('2026-11-13T10:00:00Z');
const A = 'ch-aaaaaa1'; const B = 'ch-bbbbbb2';
const tmpDirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ym6-')); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function raw(port, { method = 'GET', url = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host: `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) h['content-length'] = Buffer.byteLength(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, text: buf.toString('utf8'), json: () => JSON.parse(buf.toString('utf8')), headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Fake Google: a vault of refresh tokens by Credential Manager target; channels.list answers by token. */
function fakeGoogle() {
  const vault = new Map([[refreshTargetFor('main'), 'refresh-main']]);
  const channelOfToken = new Map([['tok-main', { id: 'UC-placeholder-main', title: 'Placeholder main' }]]);
  let nextSignIn = { id: 'UC-placeholder-a', title: 'Placeholder A' };
  const auths = new Map();
  const authFor = (id) => {
    if (!auths.has(id)) {
      const target = refreshTargetFor(id);
      auths.set(id, {
        signIn: async () => { vault.set(target, `refresh-${id}`); channelOfToken.set(`tok-${id}`, nextSignIn); return { scope: 'x' }; },
        accessToken: async () => { if (!vault.has(target)) throw Object.assign(new Error('no'), { code: 'oauth-reauth-needed' }); return `tok-${id}`; },
        status: async () => ({ signedIn: vault.has(target), hasClient: true }),
        signOut: async () => vault.delete(target),
      });
    }
    return auths.get(id);
  };
  const calls = [];
  const fetchImpl = async (url, o = {}) => {
    calls.push(String(url));
    const tok = String(o.headers?.Authorization ?? '').replace(/^Bearer /, '');
    const ch = channelOfToken.get(tok);
    return { ok: true, status: 200, json: async () => ({ items: ch ? [{ id: ch.id, snippet: { title: ch.title, customUrl: `@${ch.title.replace(/\s/g, '')}` } }] : [] }) };
  };
  return { vault, authFor, fetchImpl, calls, setNext: (c) => { nextSignIn = c; } };
}

async function boot() {
  const dataDir = mk();
  mkdirSync(path.join(dataDir, 'posting'), { recursive: true });
  writeFileSync(path.join(dataDir, 'flags.local.json'), JSON.stringify({ flags: { posting: true } }));
  const g = fakeGoogle();
  const ids = [A, B, 'ch-cccccc3'];
  const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
  const srv = createStudioServer({ uiRoot: UI, core, host: createFakeHost(), launchKey: KEY, dataDir, feedbackDir: mk(), limits: { statusPollMs: 50 }, now: () => NOW,
    youtube: { auth: { status: async () => ({ signedIn: false, hasClient: false }) }, outputsStatus: async () => ({ sinks: [] }) },
    channels: { authFor: g.authFor, fetchImpl: g.fetchImpl, newId: () => ids.shift() } });
  const { port } = await srv.listen();
  const lr = await raw(port, { url: `/login?k=${KEY}` });
  const cookie = lr.headers['set-cookie'][0].split(';')[0];
  const csrf = (await raw(port, { url: '/ui/api/session', headers: { cookie } })).json().csrf;
  const post = (route, body) => raw(port, { method: 'POST', url: route, body: JSON.stringify(body), headers: { cookie, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-ujwalam-csrf': csrf } });
  const get = (url) => raw(port, { url, headers: { cookie } });
  const settle = async () => { for (let k = 0; k < 100; k++) { const v = (await get('/ui/api/posts/channels')).json(); if (!v.adding) return v; await new Promise((r) => setTimeout(r, 10)); } throw new Error('add never finished'); };
  return { srv, post, get, settle, dataDir, g };
}

describe('YM6 YouTube channels routes', () => {
  test('an old data folder lists the main channel only, signed in as before', async () => {
    const b = await boot();
    try {
      const v = (await b.get('/ui/api/posts/channels')).json();
      assert.deepEqual(v.channels.map((c) => [c.id, c.label, c.main, c.enabled, c.signedIn, c.statusText]), [['main', 'Main channel', true, true, true, 'Signed in, posting on']]);
      assert.deepEqual(v.limits, { postsPerDayLimit: 20, maxChannels: 6 });
      assert.doesNotMatch(JSON.stringify(v), /refresh-|tok-/, 'no token reaches the page');
    } finally { await b.srv.close(); }
  });

  test('Add channel: one click signs in, reads the channel, adds it with 3-6 a day and Shorts only; the same channel twice is refused', async () => {
    const b = await boot();
    try {
      const r = await b.post('/ui/api/posts/channels/add', { label: 'Second' });
      assert.equal(r.status, 202);
      let v = await b.settle();
      assert.equal(v.lastError, null);
      const a = v.channels.find((c) => c.id === A);
      assert.deepEqual([a.label, a.signedIn, a.enabled, a.postsPerDay, a.shortsOnly, a.main], ['Second', true, true, { min: 3, max: 6 }, true, false]);
      assert.ok(a.todayCap >= 3 && a.todayCap <= 6);
      const doc = readAccounts(b.dataDir);
      assert.equal(doc.accounts.find((x) => x.id === A).channelId, 'UC-placeholder-a', 'the channel id stays in the local file');
      assert.equal(doc.accounts[0].channelId, 'UC-placeholder-main', "main's id is learned once to refuse duplicates");
      // the same channel again (e.g. the same Brand Account picked twice)
      b.g.setNext({ id: 'UC-placeholder-a', title: 'Placeholder A' });
      await b.post('/ui/api/posts/channels/add', {});
      v = await b.settle();
      assert.match(v.lastError, /already in the list/);
      assert.equal(v.channels.length, 2);
      assert.equal(b.g.vault.has(refreshTargetFor(B)), false, "the refused channel's new sign-in is removed again");
      // the main channel itself is refused too
      b.g.setNext({ id: 'UC-placeholder-main', title: 'Placeholder main' });
      await b.post('/ui/api/posts/channels/add', {});
      v = await b.settle();
      assert.match(v.lastError, /already in the list/);
      assert.ok(b.g.calls.every((u) => u.startsWith('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true')), 'only channels.list');
    } finally { await b.srv.close(); }
  });

  test('posting on/off, the posts-a-day range and the label; bad values are refused in plain words', async () => {
    const b = await boot();
    try {
      await b.post('/ui/api/posts/channels/add', {}); await b.settle();
      let r = await b.post('/ui/api/posts/channels/set', { id: A, enabled: false, min: 2, max: 4, label: 'Clips two' });
      assert.equal(r.status, 200);
      const a = r.json().channels.find((c) => c.id === A);
      assert.deepEqual([a.enabled, a.postsPerDay, a.label, a.statusText], [false, { min: 2, max: 4 }, 'Clips two', 'Posting off']);
      r = await b.post('/ui/api/posts/channels/set', { id: A, min: 5, max: 3 });
      assert.deepEqual([r.status, r.json().error], [400, 'bad-value']);
      r = await b.post('/ui/api/posts/channels/set', { id: A, max: 21 });
      assert.equal(r.status, 400);
      r = await b.post('/ui/api/posts/channels/set', { id: 'main', min: 1, max: 2 });
      assert.match(r.json().text, /Uploads per day/);
      r = await b.post('/ui/api/posts/channels/set', { id: 'main', enabled: false });
      assert.equal(r.json().channels[0].enabled, false, 'main can be switched off');
      r = await b.post('/ui/api/posts/channels/set', { id: 'ch-zzzzzz9', enabled: true });
      assert.equal(r.status, 404);
    } finally { await b.srv.close(); }
  });

  test('Remove signs the channel out and takes it off the list; the main channel stays', async () => {
    const b = await boot();
    try {
      await b.post('/ui/api/posts/channels/add', {}); await b.settle();
      const q = createUploadQueue(path.join(b.dataDir, 'posting', QUEUE_NAME), () => NOW);
      q.add('p1'); q.patch('p1', { account: A, state: 'done', videoId: 'v1' });
      const r = await b.post('/ui/api/posts/channels/remove', { id: A });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json().channels.map((c) => c.id), ['main']);
      assert.equal(b.g.vault.has(refreshTargetFor(A)), false);
      assert.equal(b.g.vault.has(refreshTargetFor('main')), true, "main's sign-in stays");
      assert.equal(q.get('p1').account, A, 'its uploaded post is left alone');
      const m = await b.post('/ui/api/posts/channels/remove', { id: 'main' });
      assert.equal(m.status, 400);
    } finally { await b.srv.close(); }
  });
});

describe('SM5 the scheduling manager with two channels', () => {
  test('each row names its channel; the list filters by channel', async () => {
    const b = await boot();
    try {
      await b.post('/ui/api/posts/channels/add', { label: 'Second' }); await b.settle();
      const q = createUploadQueue(path.join(b.dataDir, 'posting', QUEUE_NAME), () => NOW);
      for (const id of ['m1', 'a1', 'p1']) q.add(id);
      q.patch('m1', { account: 'main', publishAt: '2026-11-14T12:00:00.000Z' });
      q.patch('a1', { account: A, publishAt: '2026-11-14T12:00:00.000Z' });
      const all = (await b.get('/ui/api/posts/schedule/list')).json();
      const by = Object.fromEntries(all.rows.map((r) => [r.id, [r.channel, r.channelText]]));
      assert.deepEqual(by, { m1: ['main', 'Main channel'], a1: [A, 'Second'], p1: ['', 'Not given to a channel yet'] });
      assert.deepEqual(all.channels, [{ id: 'main', label: 'Main channel' }, { id: A, label: 'Second' }]);
      const onlyA = (await b.get(`/ui/api/posts/schedule/list?channel=${A}`)).json();
      assert.deepEqual([onlyA.rows.map((r) => r.id), onlyA.counts.total], [['a1'], 1]);
      const junk = (await b.get('/ui/api/posts/schedule/list?channel=../x')).json();
      assert.equal(junk.rows.length, 3, 'a malformed filter is ignored');
    } finally { await b.srv.close(); }
  });
});
