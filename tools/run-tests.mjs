// SPDX-License-Identifier: GPL-3.0-or-later
// `npm test`: the node test files in two groups that run at the same time (D383).
//  - Files that start the studio exe (they import app/studio/tools/build.mjs) run at most STUDIO_AT_ONCE at a time:
//    each one starts software-drawn Qt windows, and with node's default (one file per core) up to 15 of them starved
//    each other until fixed probe deadlines passed (a QML probe test failed in five full CI runs in a row, 2026-11-14).
//  - Every other file runs beside them with the cores left over (availableParallelism - 1 - STUDIO_AT_ONCE), so both
//    groups together stay at node's default total (with the default for the other group as well, 19 files ran at once
//    and file and launcher tests timed out in full CI run 6, 2026-11-14).
// Each group's output is printed whole when it ends, then a short summary with the failing tests' names, so the
// CI's tail of the output always names them. Extra arguments go to both `node --test` runs.
// Usage: node tools/run-tests.mjs [node --test options]
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedUjwalamProcesses } from './ci.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUDIO_AT_ONCE = 4;
const STUDIO_MARK = /app\/studio\/tools\/build\.mjs/;

export function testFiles(root = ROOT) {
  const list = (dir) => readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${dir}/${f}`);
  return [...list('tests'), ...list('tests/outputs')];
}

/** Cores kept free beside both groups: with 11 other files at once on 16 cores, each full CI run timed out a different
 *  set of heavy files (event-core swaps, hard kills, soak, launcher restarts) that all pass alone (2026-11-20, 3 runs). */
export const SPARE_CORES = 2;

/** How many of the other files run at once: node's default total (cores - 1) minus the studio group, the spare
 *  cores and the cores other programs already keep busy (busyCores, measured at the start), at least 1. With ~50 %
 *  CPU from other apps on 16 cores, 9 files at once plus 4 studio files oversubscribed the machine: each full CI run
 *  failed a different single file that passes alone, and below-normal children (soak core, ffmpeg cover) were
 *  starved past their ceilings (2026-11-24, 3 runs). */
export function otherAtOnce(cores = os.availableParallelism(), busyCores = 0) {
  return Math.max(1, cores - 1 - STUDIO_AT_ONCE - SPARE_CORES - Math.round(busyCores));
}

const cpuTimes = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, all: 0 });

/** Cores busy with other programs right now: the machine's busy share over `ms`, times the core count. Measured
 *  before any test starts, so it is load from outside this run (other apps, Defender). */
export async function busyCoresNow(ms = 2000) {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  const all = b.all - a.all;
  if (all <= 0) return 0;
  return (1 - (b.idle - a.idle) / all) * os.cpus().length;
}

/** The tests/helpers files that start the studio exe themselves (they import the build tool). */
function studioHelpers(root) {
  let names = [];
  try { names = readdirSync(path.join(root, 'tests', 'helpers')).filter((f) => f.endsWith('.mjs')); } catch { return []; }
  return names.filter((f) => STUDIO_MARK.test(readFileSync(path.join(root, 'tests', 'helpers', f), 'utf8')));
}

/** Splits the files into { studio, other } by whether they start the studio exe, directly or through a helper
 *  (studio-qml-layout starts it through helpers/qml-probe.mjs; uncapped in the other group it timed out in full
 *  CI, 2026-11-20). */
export function splitFiles(files, root = ROOT) {
  const helpers = studioHelpers(root).map((h) => `helpers/${h}`);
  const starts = (text) => STUDIO_MARK.test(text) || helpers.some((h) => text.includes(h));
  const studio = [], other = [];
  for (const f of files) (starts(readFileSync(path.join(root, f), 'utf8')) ? studio : other).push(f);
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

/** Message when the user's installed Ujwalam runs (2026-11-24: a full `npm test` beside the open studio, 4 test studio
 *  windows plus the other files, made the user's app "extremely unresponsive"); else null. A failed check counts as
 *  running. UJWALAM_TESTS_BESIDE_APP=1 is the user's override. */
export function appGuard(find = installedUjwalamProcesses, env = process.env) {
  if (env.UJWALAM_TESTS_BESIDE_APP === '1') return null;
  const busy = find();
  if (busy === null) return 'run-tests: refused: could not check whether your installed Ujwalam is running. Set UJWALAM_TESTS_BESIDE_APP=1 to run anyway.';
  if (!busy.length) return null;
  return `run-tests: refused: your installed Ujwalam is running (${busy.map((b) => `${b.name} pid ${b.pid}`).join(', ')}). `
    + 'The full test run starts test studio windows and many files at once and slows the app. Close Ujwalam first, or run single files with node --test.';
}

async function main() {
  const extra = process.argv.slice(2);
  const refused = appGuard();
  if (refused) { process.stdout.write(`${refused}\n`); process.exitCode = 3; return; }
  const { studio, other } = splitFiles(testFiles());
  const base = ['--test', '--test-timeout=300000', ...extra];
  const busy = await busyCoresNow();
  const atOnce = otherAtOnce(os.availableParallelism(), busy);
  process.stdout.write(`run-tests: ${busy.toFixed(1)} core(s) busy with other programs; other files ${atOnce} at once\n`);
  const [o, s] = await Promise.all([
    run([...base, `--test-concurrency=${atOnce}`, ...other]),
    studio.length ? run([...base, `--test-concurrency=${STUDIO_AT_ONCE}`, ...studio]) : Promise.resolve({ code: 0, out: '' }),
  ]);
  process.stdout.write(o.out);
  process.stdout.write(s.out);
  const sum = [...summaryOf(`other files (${other.length}, ${atOnce} at once)`, o.out), ...summaryOf(`studio files (${studio.length}, ${STUDIO_AT_ONCE} at once)`, s.out)];
  process.stdout.write(`\nrun-tests:\n${sum.join('\n')}\n`);
  process.exitCode = o.code === 0 && s.code === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
