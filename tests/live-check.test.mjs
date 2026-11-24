// SPDX-License-Identifier: GPL-3.0-or-later
// tools/live-check.mjs: a live sink counts however old the log is, until it stops or the host exits; no installed
// host process = off air; a host that cannot be resolved, or whose own log cannot be read, = unknown (review rounds
// 1 and 2, 2026-11-18).
import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, hostExited, liveSinks, logForStart, stampSec } from '../tools/live-check.mjs';

const LIVE = '2026-11-18T19:20:00Z info: [host] sink yt-h live\n2026-11-18T19:20:01Z info: [host] sink rec-h live\n';
const never = () => { throw new Error('no log is read when no installed host runs'); };

test('no installed host: off air without reading any log; not checkable: unknown', () => {
  assert.equal(decide([], never).code, 0);
  assert.equal(decide(null, never).code, 2);
});

test('a running host with a live sink is live, whatever the log age', () => {
  const r = decide([1], () => LIVE);
  assert.equal(r.code, 1);
  assert.match(r.line, /yt-h, rec-h/);
  assert.deepEqual(liveSinks(`${LIVE}x [host] sink yt-h dropped\n`), ['yt-h', 'rec-h']);
  assert.equal(decide([1], () => `${LIVE}x [host] sink yt-h stopped\nx [host] sink rec-h failed\n`).code, 0);
});

test('the exit line: off air; a running host without a readable log: unknown', () => {
  assert.equal(hostExited(`${LIVE}x info: [host] exit 0\n`), true);
  assert.equal(decide([1], () => `${LIVE}x info: [host] exit 0\n`).code, 0);
  assert.equal(decide([1], () => null).code, 2);
});

test('each host reads the log named after its own start', () => {
  const start = Date.UTC(2026, 10, 18, 19, 15, 3) / 1000;
  const names = ['host-2026-11-18T19-15-04.log', 'host-2026-11-18T21-00-00.log', 'other.log'];
  assert.equal(logForStart(names, start), 'host-2026-11-18T19-15-04.log');
  assert.equal(logForStart(names, start + 3600), null);
});

test('the log name is UTC: a host started in summer time still finds its log (Astra review)', () => {
  // The process start comes from a local CreationDate stamp; the log name from hlog::utc_now.
  const start = Date.UTC(2026, 6, 18, 19, 15, 3) / 1000;
  assert.equal(logForStart(['host-2026-07-18T19-15-04.log'], start), 'host-2026-07-18T19-15-04.log');
  const local = new Date(start * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(local.getHours())}-${pad(local.getMinutes())}-${pad(local.getSeconds())}`;
  assert.equal(stampSec(stamp), start, 'the local CreationDate stamp reads back as the same instant');
});
