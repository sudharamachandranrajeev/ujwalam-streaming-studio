// SPDX-License-Identifier: GPL-3.0-or-later
// services/common/stat-cache.mjs (idle load, 2026-11-18): a file-derived value is read again only when the file changed.
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStatCache, statKey } from '../services/common/stat-cache.mjs';

test('stat cache: one read per change; a rename-replace, a size change and a deleted file are changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ujw-statcache-'));
  try {
    const file = path.join(dir, 'a.json');
    const cached = createStatCache();
    let reads = 0;
    const read = () => { reads++; return reads; };
    assert.equal(statKey(file), 'missing');
    assert.equal(cached(file, read), 1, 'missing file: read once');
    assert.equal(cached(file, read), 1, 'still missing: not read again');
    writeFileSync(file, '{"a":1}');
    assert.equal(cached(file, read), 2, 'appeared');
    assert.equal(cached(file, read), 2);
    assert.equal(cached(file, read), 2);
    writeFileSync(`${file}.tmp`, '{"a":1}');
    renameSync(`${file}.tmp`, file); // atomic replace with the same size
    assert.equal(cached(file, read), 3, 'replaced by rename');
    writeFileSync(file, '{"a":12}');
    assert.equal(cached(file, read), 4, 'rewritten with another size');
    rmSync(file);
    assert.equal(cached(file, read), 5, 'deleted');
    assert.equal(cached(file, read), 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stat cache: entries are per file', () => {
  const cached = createStatCache({ keyOf: () => 'same' });
  assert.equal(cached('x', () => 'x1'), 'x1');
  assert.equal(cached('y', () => 'y1'), 'y1');
  assert.equal(cached('x', () => 'x2'), 'x1');
});
