// SPDX-License-Identifier: GPL-3.0-or-later
// tools/live-check.mjs: a live sink counts however old the log is, until it stops, the host exits or no installed
// host process runs (2026-11-18 review: a quiet log during a long stream read as off air).
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, hostExited, liveSinks } from '../tools/live-check.mjs';

const LIVE = '2026-11-18T19:20:00Z info: [host] sink yt-h live\n2026-11-18T19:20:01Z info: [host] sink rec-h live\n';
const never = () => { throw new Error('the host process is not checked when no sink is live'); };

test('no live sink: off air, the host process is not checked', () => {
  assert.equal(decide('', never).code, 0);
  assert.equal(decide(`${LIVE}x [host] sink yt-h stopped\nx [host] sink rec-h failed\n`, never).code, 0);
});

test('a live sink with the host running is live, whatever the log age', () => {
  const r = decide(LIVE, () => true);
  assert.equal(r.code, 1);
  assert.match(r.line, /yt-h, rec-h/);
  assert.deepEqual(liveSinks(`${LIVE}x [host] sink yt-h dropped\n`), ['yt-h', 'rec-h']);
});

test('the host exit line or no installed host process: off air', () => {
  assert.equal(hostExited(`${LIVE}x info: [host] exit 0\n`), true);
  assert.equal(decide(`${LIVE}x info: [host] exit 0\n`, never).code, 0);
  assert.equal(decide(LIVE, () => false).code, 0);
});

test('the host process cannot be checked: unknown', () => {
  assert.equal(decide(LIVE, () => null).code, 2);
});
