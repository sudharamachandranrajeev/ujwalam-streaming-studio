// SPDX-License-Identifier: GPL-3.0-or-later
// Single-file setup (2026-11-19): Ujwalam-Setup-<version>.exe = the setup program (app/setup) + the package zip + a
// 160-byte trailer that app/setup/src/setup.cpp (readEmbedded) checks before it unpacks anything. Little-endian:
//   0 "UJWSETUP"  8 u32 format (1)  12 u32 0  16 u64 stub size (= zip offset)  24 u64 zip size
//   32 SHA-256 of the zip  64 SHA-256 of the stub  96 version (56 bytes, NUL-padded)  152 "UJWPKG01"
// The whole file's SHA-256 goes into <exe>.sha256 next to it. Only the newest KEEP setups stay in the folder; older
// ones (and their .sha256) are deleted, and each deletion is logged.
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export const TRAILER = 160;
export const KEEP = 2;
const SETUP_RE = /^Ujwalam-Setup-(\d{1,6}\.\d{1,6}\.\d{1,6}-alpha\.\d{1,6})\.exe$/;

export function setupName(version) { return `Ujwalam-Setup-${version}.exe`; }

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest()));
  });
}

export function trailer({ stubSize, zipSize, zipSha, stubSha, version }) {
  const t = Buffer.alloc(TRAILER);
  t.write('UJWSETUP', 0, 'latin1');
  t.writeUInt32LE(1, 8);
  t.writeBigUInt64LE(BigInt(stubSize), 16);
  t.writeBigUInt64LE(BigInt(zipSize), 24);
  zipSha.copy(t, 32);
  stubSha.copy(t, 64);
  if (Buffer.byteLength(version) > 55) throw new Error(`version too long for the setup trailer: ${version}`);
  t.write(version, 96, 'latin1');
  t.write('UJWPKG01', 152, 'latin1');
  return t;
}

/** Reads the trailer of a single-file setup: { version, stubSize, zipSize, zipSha, stubSha } or null (pure file read). */
export function readTrailer(file) {
  const size = statSync(file).size;
  if (size <= TRAILER) return null;
  const t = Buffer.alloc(TRAILER);
  const fd = openSync(file, 'r');
  try { readSync(fd, t, 0, TRAILER, size - TRAILER); } finally { closeSync(fd); }
  if (t.toString('latin1', 0, 8) !== 'UJWSETUP' || t.toString('latin1', 152, 160) !== 'UJWPKG01' || t.readUInt32LE(8) !== 1) return null;
  const stubSize = Number(t.readBigUInt64LE(16));
  const zipSize = Number(t.readBigUInt64LE(24));
  if (stubSize + zipSize + TRAILER !== size) return null;
  return { version: t.toString('latin1', 96, 152).replace(/\0+$/, ''), stubSize, zipSize, zipSha: t.toString('hex', 32, 64), stubSha: t.toString('hex', 64, 96) };
}

/** The setups in dir newest first by version: [{ version, file }]. */
export function setupsIn(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  const cmp = (a, b) => { const p = (v) => v.split(/[.-]/).filter((x) => x !== 'alpha').map(Number); const x = p(a); const y = p(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  return names.map((n) => SETUP_RE.exec(n)).filter(Boolean).map((m) => ({ version: m[1], file: path.join(dir, m[0]) })).sort((a, b) => cmp(b.version, a.version));
}

/** Deletes all but the newest `keep` setups (and their .sha256); returns the deleted paths. A file in use stays (logged). */
export function pruneSetups(dir, { keep = KEEP, log = () => {} } = {}) {
  const deleted = [];
  for (const { file } of setupsIn(dir).slice(keep)) {
    for (const f of [file, `${file}.sha256`]) {
      if (!existsSync(f)) continue;
      try { rmSync(f); deleted.push(f); log(`deleted old setup ${path.basename(f)} (keeping the newest ${keep})`); } catch (e) { log(`could not delete ${path.basename(f)} (${e.code ?? e.message}); left in place`); }
    }
  }
  return deleted;
}

// setup.cpp kSingleMark: the program copy in front of the package says it was built as a single file, so a copy whose
// trailer cannot be read is refused as damaged at any size (Codex review 2026-11-20).
export const SINGLE_MARK = Buffer.from('UJWSINGLE:0\0', 'latin1');

/** A copy of the program with the single-file mark set; throws unless the mark is there exactly once. */
export function markSingle(prog) {
  const at = prog.indexOf(SINGLE_MARK);
  if (at < 0 || prog.indexOf(SINGLE_MARK, at + 1) >= 0) throw new Error(`setup program: the single-file mark ${SINGLE_MARK.toString('latin1', 0, 11)} must be in it exactly once`);
  const b = Buffer.from(prog);
  b[at + SINGLE_MARK.length - 2] = 0x31; // '1'
  return b;
}

/**
 * Writes <outDir>/Ujwalam-Setup-<version>.exe from stub (with the single-file mark set) + zip (temp file, then one rename), its .sha256, and prunes.
 * Returns { file, bytes, sha256, deleted }.
 */
export async function buildSingleSetup({ stub, zip, version, outDir, keep = KEEP, log = () => {} }) {
  const dest = path.join(outDir, setupName(version));
  const tmp = `${dest}.${process.pid}.new`;
  const prog = markSingle(readFileSync(stub));
  const stubSha = createHash('sha256').update(prog).digest();
  const zipSha = await hashFile(zip);
  const stubSize = prog.length;
  const zipSize = statSync(zip).size;
  try {
    const out = createWriteStream(tmp, { flags: 'wx' });
    await pipeline(async function* () {
      yield prog;
      for await (const c of createReadStream(zip, { highWaterMark: 1 << 20 })) yield c;
      yield trailer({ stubSize, zipSize, zipSha, stubSha, version });
    }, out);
    renameSync(tmp, dest);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
  const sha = (await hashFile(dest)).toString('hex');
  writeFileSync(`${dest}.sha256`, `${sha}  ${path.basename(dest)}\n`);
  const bytes = statSync(dest).size;
  log(`wrote ${dest} (${(bytes / 1048576).toFixed(1)} MiB, sha256 ${sha})`);
  const deleted = pruneSetups(outDir, { keep, log });
  return { file: dest, bytes, sha256: sha, deleted };
}
