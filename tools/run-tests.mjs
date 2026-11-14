// SPDX-License-Identifier: GPL-3.0-or-later
// `npm test`: the node test files in two groups that run at the same time (D383).
//  - Files that start the studio exe (they import app/studio/tools/build.mjs) run at most STUDIO_AT_ONCE at a time:
//    each one starts software-drawn Qt windows, and with node's default (one file per core) up to 15 of them starved
//    each other until fixed probe deadlines passed (a QML probe test failed in five full CI runs in a row, 2026-11-14).
//  - Every other file runs at node's default concurrency.
// Each group's output is printed whole when it ends, then a short summary with the failing tests' names, so the
// CI's tail of the output always names them. Extra arguments go to both `node --test` runs.
// Usage: node tools/run-tests.mjs [node --test options]
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO_AT_ONCE = 4;
const STUDIO_MARK = /app\/studio\/tools\/build\.mjs/;

export function testFiles(root = ROOT) {
  const list = (dir) => readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${dir}/${f}`);
  return [...list('tests'), ...list('tests/outputs')];
}

/** Splits the files into { studio, other } by whether they start the studio exe. */
export function splitFiles(files, root = ROOT) {
  const studio = [], other = [];
  for (const f of files) (STUDIO_MARK.test(readFileSync(path.join(root, f), 'utf8')) ? studio : other).push(f);
  return { studio, other };
}

/** The lines worth repeating at the end: the counts and the names of failing tests. */
export function summaryOf(name, output) {
  const lines = output.split(/\r?\n/);
  const counts = lines.filter((l) => /^ℹ (tests|pass|fail|cancelled) /.test(l)).map((l) => l.slice(2));
  const at = lines.findIndex((l) => /^✖ failing tests:/.test(l));
  const failing = at < 0 ? [] : lines.slice(at + 1).filter((l) => /^✖ /.test(l)).map((l) => `  ${l}`);
  return [`${name}: ${counts.join(', ') || 'no counts (did it start?)'}`, ...failing];
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: 1, out: `${out}\n${e.message}\n` }));
  });
}

async function main() {
  const extra = process.argv.slice(2);
  const { studio, other } = splitFiles(testFiles());
  const base = ['--test', '--test-timeout=300000', ...extra];
  const [o, s] = await Promise.all([
    run([...base, ...other]),
    studio.length ? run([...base, `--test-concurrency=${STUDIO_AT_ONCE}`, ...studio]) : Promise.resolve({ code: 0, out: '' }),
  ]);
  process.stdout.write(o.out);
  process.stdout.write(s.out);
  const sum = [...summaryOf(`other files (${other.length})`, o.out), ...summaryOf(`studio files (${studio.length}, ${STUDIO_AT_ONCE} at once)`, s.out)];
  process.stdout.write(`\nrun-tests:\n${sum.join('\n')}\n`);
  process.exitCode = o.code === 0 && s.code === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
