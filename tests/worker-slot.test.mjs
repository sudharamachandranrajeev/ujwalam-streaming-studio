// SPDX-License-Identifier: GPL-3.0-or-later
// services/studio-ui/worker-slot.mjs (idle load 2026-11-18, Codex review): no second worker while the first is still
// stopping, and no crash restart after a switch-off.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createWorkerSlot } from '../services/studio-ui/worker-slot.mjs';

function rig() {
  const started = []; const ended = []; const timers = [];
  const start = () => { const c = new EventEmitter(); started.push(c); return c; };
  const slot = createWorkerSlot({
    end: (c) => { c.endedOnPurpose = true; ended.push(c); },
    setTimer: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { slot, start, started, ended, timers, fire };
}

test('worker slot: a switch-off keeps the stopping worker until it exits; no second one starts meanwhile', () => {
  const { slot, start, started, ended } = rig();
  const a = slot.launch(start);
  assert.ok(a);
  assert.equal(slot.stop(), true);
  assert.deepEqual(ended, [a]);
  assert.equal(slot.active(), null);
  assert.equal(slot.ending(), a);
  assert.equal(slot.busy(), true, 'still stopping');
  assert.equal(slot.launch(start), null, 're-enable while the old one is saving: nothing starts');
  assert.equal(started.length, 1);
  a.emit('exit', 0);
  assert.equal(slot.busy(), false);
  assert.ok(slot.launch(start), 'after the exit the next sync may start a new one');
  assert.equal(started.length, 2);
});

test('worker slot: a crash restart is cancelled by a switch-off, and an old generation never schedules one', () => {
  const { slot, start, timers, fire } = rig();
  let crash = null;
  const restarted = [];
  const a = slot.launch(start, (code, g) => { crash = { code, g }; slot.retry(g, () => restarted.push(g)); });
  a.emit('exit', 1);
  assert.deepEqual(crash, { code: 1, g: 0 });
  assert.equal(timers.length, 1);
  assert.equal(slot.busy(), true, 'a restart is pending');
  slot.stop(); // switched off while the restart waits
  assert.equal(timers[0].cleared, true);
  fire();
  assert.deepEqual(restarted, [], 'the cancelled restart did not run');
  assert.equal(slot.retry(0, () => restarted.push('late')), false, 'a callback from the old generation cannot schedule one');
  // Off and on again: the new worker's crash restarts in the new generation.
  const b = slot.launch(start, (code, g) => slot.retry(g, () => restarted.push(g)));
  b.emit('exit', 2);
  fire();
  assert.deepEqual(restarted, [1]);
});

test('worker slot: an exit after stop() is not a crash', () => {
  const { slot, start } = rig();
  let crashed = false;
  const a = slot.launch(start, () => { crashed = true; });
  slot.stop();
  a.emit('exit', 1);
  assert.equal(crashed, false);
});
