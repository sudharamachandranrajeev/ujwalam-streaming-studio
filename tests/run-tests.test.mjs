// SPDX-License-Identifier: GPL-3.0-or-later
// tools/run-tests.mjs (D383): `npm test` runs every file once, the studio-starting files in their own capped group,
// and the end of its output names the failing tests.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { otherAtOnce, splitFiles, summaryOf, testFiles } from '../tools/run-tests.mjs';

test('every test file is in exactly one group; the studio files are the ones that start the studio exe', () => {
  const files = testFiles();
  const { studio, other } = splitFiles(files);
  assert.equal(studio.length + other.length, files.length);
  assert.equal(new Set([...studio, ...other]).size, files.length);
  assert.ok(files.includes('tests/run-tests.test.mjs'));
  assert.ok(other.includes('tests/run-tests.test.mjs'));
  for (const f of ['tests/studio-qml-themes.test.mjs', 'tests/studio-qml-shell.test.mjs', 'tests/studio-qml-tray.test.mjs']) assert.ok(studio.includes(f), f);
  assert.ok(files.some((f) => f.startsWith('tests/outputs/')), 'tests/outputs is included');
});

test('the split reads each file: a stub tree splits by the import of the studio build tool', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ujw-runtests-'));
  try {
    mkdirSync(path.join(root, 'tests', 'outputs'), { recursive: true });
    const tool = ['app', 'studio', 'tools', 'build.mjs'].join('/'); // kept out of this file's own text: it would join the studio group
    writeFileSync(path.join(root, 'tests', 'a.test.mjs'), `import { EXE } from '../${tool}';\n`);
    writeFileSync(path.join(root, 'tests', 'b.test.mjs'), "import assert from 'node:assert';\n");
    writeFileSync(path.join(root, 'tests', 'outputs', 'c.test.mjs'), '\n');
    writeFileSync(path.join(root, 'tests', 'notes.md'), '\n');
    const files = testFiles(root);
    assert.deepEqual(files, ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/outputs/c.test.mjs']);
    assert.deepEqual(splitFiles(files, root), { studio: ['tests/a.test.mjs'], other: ['tests/b.test.mjs', 'tests/outputs/c.test.mjs'] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('both groups together stay at node\'s default total: the other files get the cores the studio group leaves', () => {
  assert.equal(otherAtOnce(16), 11);
  assert.equal(otherAtOnce(4), 1);
  assert.equal(otherAtOnce(1), 1);
});

test('the summary repeats the counts and the failing tests\' names', () => {
  const out = ['✔ fine (1ms)', '✖ bad one (2ms)', 'ℹ tests 2', 'ℹ pass 1', 'ℹ fail 1', 'ℹ cancelled 0', '', '✖ failing tests:', '',
    'test at tests\\x.test.mjs:3:1', '✖ bad one (2ms)', '  AssertionError: no'].join('\n');
  assert.deepEqual(summaryOf('studio', out), ['studio: tests 2, pass 1, fail 1, cancelled 0', '  ✖ bad one (2ms)']);
  assert.deepEqual(summaryOf('other', ''), ['other: no counts (did it start?)']);
});
