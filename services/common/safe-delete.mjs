// SPDX-License-Identifier: GPL-3.0-or-later
// Safe permanent delete of one file inside one folder (D375 posted clips, D403 processed recordings). Node stdlib only.
// Shared by services/posting/delete-uploaded.mjs and services/studio-ui/recording-cleanup.mjs; the steps are written
// once, here.
//   safeDeleteFile({ file, folder, expectSha?, hash?, beforeUnlink?, beforeDelete? })
//     -> { deleted: true, sha, id, size } | { deleted: false, reason }
// Deletes only when EVERY check passes, and keeps the file on any doubt:
//   1. the file is a regular file (no link), inside the folder by its real path (a junction or link that leads out is
//      refused), never a folder, never a UNC or device path;
//   2. it is opened once; its identity (device, file id, size, modified time) and, when asked, its sha256 are taken
//      through that one handle (expectSha must then match);
//   3. right before the move the path is looked up again (lstat) and its folder's real path resolved again: same
//      identity, still inside the folder;
//   4. it is moved by one atomic rename (same volume) under a random name into <folder>/.ujwalam-deleting/ (a rename that
//      Windows refuses because another program holds the file open is 'file-in-use'), checked again there through its
//      own handle (same identity, same sha256 when hashed) and only then unlinked;
//   5. on any mismatch it is put back by a hard link that fails if the path is taken (atomic no-replace) or, if that is
//      not possible, left in the holding folder (never deleted).
// Residual risks (docs/evidence/2026-11-13-auto-post-scheduled.md): a program that writes the holding folder and guesses
// the random name within microseconds; a crash between the rename and the unlink leaves the verified file in the
// holding folder (nothing is lost).
import { createHash, randomBytes } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

/** The holding folder inside the folder (not a YYYY-MM-DD folder, so the clips scan never reads it). */
export const HOLD_DIR_NAME = '.ujwalam-deleting';

const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const inside = (child, parent) => { const rel = path.relative(parent, child); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
/** A UNC, device or long-path form (\\server\share, \\?\, \\.\, //x): never used for a delete. */
const uncLike = (p) => /^[\\/]{2}/.test(p);

/** Is `file` a regular file inside `folder`, reached without any link? -> null (yes) or the reason it is not. */
export function checkInFolder(file, folder) {
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return 'no-source-file';
  if (typeof folder !== 'string' || !folder) return 'not-in-folder';
  if (uncLike(file) || uncLike(folder)) return 'unc-path';
  const lexical = path.resolve(file);
  if (!inside(lower(lexical), lower(path.resolve(folder)))) return 'not-in-folder';
  let st;
  try { st = lstatSync(lexical); } catch (e) { return e?.code === 'ENOENT' ? 'file-gone' : 'file-unreadable'; }
  if (st.isSymbolicLink()) return 'link';
  if (!st.isFile()) return 'not-a-file';
  let realFile; let realFolder;
  try { realFile = realpathSync.native(lexical); realFolder = realpathSync.native(path.resolve(folder)); } catch { return 'file-unreadable'; }
  if (!inside(lower(realFile), lower(realFolder))) return 'outside-folder';
  // A junction or link anywhere between the folder and the file changes the real path: refused as well.
  if (lower(path.relative(realFolder, realFile)) !== lower(path.relative(path.resolve(folder), lexical))) return 'link';
  return null;
}

/** Identity (and sha256 when hash) of the file, through one open handle. -> { sha: string|null, id: { dev, ino, size, mtimeNs } }. */
export async function hashWithIdentity(file, { hash = true } = {}) {
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat({ bigint: true });
    let sha = null;
    if (hash) {
      const h = createHash('sha256'); const buf = Buffer.allocUnsafe(1 << 20);
      for (let n; (n = (await fh.read(buf, 0, buf.length, null)).bytesRead) > 0;) h.update(n === buf.length ? buf : buf.subarray(0, n));
      sha = h.digest('hex');
    }
    const after = await fh.stat({ bigint: true });
    if (after.size !== st.size || after.mtimeNs !== st.mtimeNs) throw Object.assign(new Error('changed while hashed'), { code: 'file-changed' });
    return { sha, id: { dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs } };
  } finally { await fh.close(); }
}

/** Right before the move: the path still names the same file (lstat: same device, file id, size, modified time, not
 *  a link) and its folder still resolves inside the folder. -> null (go) or the reason to keep it. */
export function sameFileStill(file, folder, id) {
  let st;
  try { st = lstatSync(file, { bigint: true }); } catch (e) { return e?.code === 'ENOENT' ? 'file-gone' : 'file-unreadable'; }
  if (st.isSymbolicLink() || !st.isFile()) return 'file-changed';
  if (!id || id.ino === 0n || st.dev !== id.dev || st.ino !== id.ino || st.size !== id.size || st.mtimeNs !== id.mtimeNs) return 'file-changed';
  let realDir; let realFolder;
  try { realDir = realpathSync.native(path.dirname(path.resolve(file))); realFolder = realpathSync.native(path.resolve(folder)); } catch { return 'file-unreadable'; }
  if (uncLike(realDir) !== uncLike(realFolder)) return 'unc-path';
  const dirRel = lower(path.relative(realFolder, realDir));
  if (dirRel.startsWith('..') || path.isAbsolute(dirRel)) return 'outside-folder';
  if (dirRel !== lower(path.relative(path.resolve(folder), path.dirname(path.resolve(file))))) return 'link';
  return null;
}

/** The holding folder <folder real path>/.ujwalam-deleting: made if missing; must be a real folder (no link or
 *  junction) that resolves to itself inside the folder. Throws otherwise. */
export function holdingDir(folder) {
  const realFolder = realpathSync.native(path.resolve(folder));
  const dir = path.join(realFolder, HOLD_DIR_NAME);
  try { mkdirSync(dir); } catch (e) { if (e?.code !== 'EEXIST') throw e; }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('holding folder is not a plain folder');
  if (lower(realpathSync.native(dir)) !== lower(dir)) throw new Error('holding folder resolves elsewhere');
  return dir;
}

export const sameIdentity = (a, b) => !!a && !!b && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

/** A held file that failed its check goes back to its own path only when that is still free, in one atomic step that
 *  never replaces anything: a hard link held -> file fails with EEXIST when the path is taken; then the holding name is
 *  removed. If the link fails for any reason the file stays in the holding folder (never deleted). -> the keep reason. */
export function putBack(held, file, reason) {
  try { linkSync(held, file); } catch { return 'held-in-holding-folder'; }
  try { unlinkSync(held); } catch { /* both names are the same file: it is back at its path either way */ }
  return reason;
}

/** Windows refuses the rename of a file another program holds open without delete sharing. */
const IN_USE = new Set(['EBUSY', 'EPERM', 'EACCES']);

// expectId (Codex round 1, recordings): { size, dev, ino, mtimeNs } as strings, recorded when the file was processed;
// the file opened must be exactly that file, or it is kept ('file-changed-since-clipped').
// requireId: a null expectId is refused (Codex round 2). gate: a SYNCHRONOUS check called right before the rename, with no
// await in between; a reason it returns keeps the file.
export async function safeDeleteFile({ file, folder, expectSha = null, expectId = null, requireId = false, gate = null, hash = true, beforeUnlink = null, beforeDelete = null }) {
  const keep = (reason) => ({ deleted: false, reason });
  if (requireId && !expectId) return keep('no-identity');
  const where = checkInFolder(file, folder);
  if (where) return keep(where);
  let first;
  try { first = await hashWithIdentity(file, { hash }); } catch (e) { return keep(e?.code === 'file-changed' ? 'file-changed' : IN_USE.has(e?.code) ? 'file-in-use' : 'file-unreadable'); }
  if (expectSha !== null && first.sha !== expectSha) return keep('sha-mismatch');
  if (expectId !== null && !(expectId && ['size', 'dev', 'ino', 'mtimeNs'].every((k) => String(first.id[k]) === String(expectId[k])))) return keep('file-changed-since-clipped');
  if (typeof beforeUnlink === 'function') await beforeUnlink(); // test seam: what another program could do meanwhile
  const again = checkInFolder(file, folder) ?? sameFileStill(file, folder, first.id);
  if (again) return keep(again);
  let dir;
  try { dir = holdingDir(folder); } catch { return keep('hold-unsafe'); }
  const held = path.join(dir, `${process.pid}-${randomBytes(8).toString('hex')}-${path.basename(file)}`);
  if (typeof gate === 'function') { let why; try { why = gate(); } catch { why = 'state-unknown'; } if (why) return keep(why); }
  try { renameSync(file, held); } catch (e) { return keep(e?.code === 'ENOENT' ? 'file-gone' : IN_USE.has(e?.code) ? 'file-in-use' : 'delete-failed'); }
  if (typeof beforeDelete === 'function') await beforeDelete(held); // test seam
  let bad = null;
  try {
    const st = lstatSync(held, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) bad = 'file-changed';
    else { const h = await hashWithIdentity(held, { hash }); if ((hash && h.sha !== first.sha) || !sameIdentity(h.id, first.id)) bad = 'file-changed'; }
  } catch { bad = 'file-changed'; }
  if (bad) return keep(putBack(held, file, bad));
  try { unlinkSync(held); } catch { return keep(putBack(held, file, 'delete-failed')); }
  return { deleted: true, sha: first.sha, id: first.id, size: Number(first.id.size) };
}
