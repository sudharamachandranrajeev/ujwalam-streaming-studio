// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T3: the default cover maker's argument handling (no real Python, no ffmpeg).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeHookCover } from '../services/posting/ai-cover.mjs';

const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-t3-'));
const out = path.join(d, 'cover.jpg');
const fake = (code, write) => (cmd, args, o) => {
  const p = new EventEmitter(); p.kill = () => {}; fake.last = { cmd, args, o };
  setImmediate(() => { if (write) writeFileSync(out, write); p.emit('close', code); });
  return p;
};
const base = { ffmpeg: 'f', video: 'v', atSec: 1, hook: 'A B', out, python: 'py' };

test('passes words as separate args, hidden window, isolated python; true on exit 0 with a file', async () => {
  const ok = await makeHookCover({ ...base, ffmpeg: 'ff', video: 'v.mp4', atSec: 2.5, hook: 'NO  WAY', spawnFn: fake(0, 'x') });
  assert.equal(ok, true);
  const { cmd, args, o } = fake.last;
  assert.equal(cmd, 'py'); assert.equal(args[0], '-I'); assert.equal(o.windowsHide, true);
  assert.deepEqual(args.slice(-2), ['NO', 'WAY']); assert.equal(args[4], '2.500');
});

test('false on non-zero exit, missing file, oversize, no python, bad hook or time, spawn throw', async () => {
  assert.equal(await makeHookCover({ ...base, spawnFn: fake(1, 'x') }), false);
  rmSync(out, { force: true });
  assert.equal(await makeHookCover({ ...base, spawnFn: fake(0, null) }), false);
  assert.equal(await makeHookCover({ ...base, spawnFn: fake(0, Buffer.alloc(2_000_001)) }), false);
  assert.equal(await makeHookCover({ ...base, python: null }), false);
  assert.equal(await makeHookCover({ ...base, hook: ' ' }), false);
  assert.equal(await makeHookCover({ ...base, atSec: NaN }), false);
  assert.equal(await makeHookCover({ ...base, spawnFn: () => { throw new Error('x'); } }), false);
  rmSync(d, { recursive: true, force: true });
});
