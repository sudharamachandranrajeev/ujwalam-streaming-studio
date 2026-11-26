// SPDX-License-Identifier: GPL-3.0-or-later
// D444 IP3: the Instagram section's routes (services/studio-ui/instagram-routes.mjs), with a fake auth. Never Meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInstagramRoutes, plainError } from '../services/studio-ui/instagram-routes.mjs';

const call = async (r, method, route, body = null) => {
  let out = null;
  const handled = await r.handle(method, route, body, {}, (_res, code, j) => { out = { code, j }; });
  return handled ? out : null;
};

test('status, save app, connect, disconnect: the secret is never echoed; the redirect URI is shown', async () => {
  const saved = {}; let connected = false; let signIns = 0;
  const auth = {
    status: async () => ({ hasApp: !!(saved.appId && saved.appSecret), connected, username: connected ? 'placeholder_account' : null, expiresAt: null }),
    setApp: async ({ appId, appSecret }) => { if (appId) saved.appId = appId; if (appSecret) saved.appSecret = appSecret; },
    signIn: async () => { signIns++; connected = true; return {}; },
    signOut: async () => { connected = false; },
  };
  const r = createInstagramRoutes({ dataDir: mkdtempSync(path.join(tmpdir(), 'ujw-igr-')), flags: { isOn: () => true }, auth });
  let s = await call(r, 'GET', '/ui/api/posts/instagram');
  assert.equal(s.code, 200); assert.equal(s.j.hasApp, false); assert.equal(s.j.flagOn, true);
  assert.match(s.j.redirectUri, /^http:\/\/localhost:\d+\/$/);
  assert.equal(s.j.queue.waiting, 0);
  assert.equal((await call(r, 'POST', '/ui/api/posts/instagram/app', {})).code, 400);
  s = await call(r, 'POST', '/ui/api/posts/instagram/app', { appId: '1234567', appSecret: 'fakeappsecret0123456' }); // lint-allow: secret (a fake test app secret, not a credential)
  assert.equal(s.code, 200); assert.equal(s.j.hasApp, true);
  assert.doesNotMatch(JSON.stringify(s.j), /fakeappsecret/);
  s = await call(r, 'POST', '/ui/api/posts/instagram/connect');
  assert.equal(s.code, 202);
  await new Promise((res) => setImmediate(res));
  s = await call(r, 'GET', '/ui/api/posts/instagram');
  assert.equal(s.j.connected, true); assert.equal(s.j.username, 'placeholder_account'); assert.equal(s.j.connecting, false); assert.equal(signIns, 1);
  s = await call(r, 'POST', '/ui/api/posts/instagram/disconnect');
  assert.equal(s.j.connected, false);
  assert.equal(await call(r, 'GET', '/ui/api/posts/other'), null);
});

test('a failed Connect is said in plain words', async () => {
  const auth = { status: async () => ({ hasApp: true, connected: false }), signIn: async () => { throw Object.assign(new Error('x'), { code: 'no-ig-account' }); } };
  const r = createInstagramRoutes({ dataDir: mkdtempSync(path.join(tmpdir(), 'ujw-igr-')), flags: { isOn: () => true }, auth });
  await call(r, 'POST', '/ui/api/posts/instagram/connect');
  await new Promise((res) => setImmediate(res));
  const s = await call(r, 'GET', '/ui/api/posts/instagram');
  assert.match(s.j.lastError, /has an Instagram professional account linked/);
});

test('Drop Instagram queue: one click drops every job not posted yet; posted ones stay', async () => {
  const { queueInstagramNow, readInstagramStates, createInstagramQueue, IG_QUEUE_NAME } = await import('../services/posting/instagram-queue.mjs');
  const d = mkdtempSync(path.join(tmpdir(), 'ujw-igr-'));
  queueInstagramNow(d, 'a'); queueInstagramNow(d, 'b');
  createInstagramQueue(path.join(d, 'posting', IG_QUEUE_NAME)).patch('b', { state: 'done', postedAt: new Date().toISOString() });
  const r = createInstagramRoutes({ dataDir: d, flags: { isOn: () => true }, auth: { status: async () => ({ hasApp: true, connected: true }) } });
  const s = await call(r, 'POST', '/ui/api/posts/instagram/drop');
  assert.equal(s.code, 200); assert.equal(s.j.dropped, 1); assert.equal(s.j.queue.dropped, 1);
  assert.equal(readInstagramStates(d).a.state, 'dropped'); assert.equal(readInstagramStates(d).b.state, 'done');
});

test('Connect errors add what Facebook shared (counts and permission names only); any other text is dropped', () => {
  assert.match(plainError('no-ig-account', 'Facebook shared 2 Page(s)'), /\(Facebook shared 2 Page\(s\)\.\)$/);
  assert.match(plainError('permission-declined', 'Facebook shared 0 Page(s); not allowed: business_management'), /not allowed: business_management\.\)$/);
  assert.doesNotMatch(plainError('no-ig-account', 'Page My Real Name'), /Real Name/);
  assert.doesNotMatch(plainError('no-app', 'Facebook shared 1 Page(s)'), /shared/);
});
