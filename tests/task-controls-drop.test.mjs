// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listTaskControls } from '../services/studio-ui/tasks.mjs';

test('listTaskControls reports an invalid control file to onBad before it removes it (no silent drop)', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-tc-'));
  try {
    const dir = path.join(d, 'clips', 'control'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'job-1~1-1.json'), '{not json');
    const bad = [];
    const r = listTaskControls(d, (nm) => bad.push(nm));
    assert.deepEqual(r.reqs, []);
    assert.deepEqual(bad, ['job-1~1-1.json']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
