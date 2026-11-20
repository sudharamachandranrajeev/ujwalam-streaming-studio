// SPDX-License-Identifier: GPL-3.0-or-later
// D375 Delete a clip file after it is posted (flag post-delete-uploaded, off by default; user 2026-11-13: "delete the
// file permanently", not the Recycle Bin). Node stdlib only.
//   deleteUploadedFile({ flagOn, status, item, ledgerEntry, file, folder, logFile, nowMs }) -> { deleted, reason }
// Deletes only when EVERY check passes, and keeps the file on any doubt:
//   1. the flag is on;
//   2. YouTube answered and says the upload finished processing (videos.list status.uploadStatus == 'processed');
//   3. the ledger has this exact video as uploaded (status 'uploaded', same videoId and sha256) with the publish time
//      Google got, the same as the queue item's sentPublishAt;
//   4. the file is the one that was uploaded: the post's source file (post.json source.file), a regular file (no link),
//      inside the clips folder by its real path (a junction or link that leads out is refused), never a folder, and its
//      sha256 equals the uploaded video's;
// then it is unlinked and one line { file (name only), videoId, at } is appended to <data>/posting/deleted.jsonl.
// Race (Codex review 2026-11-13): the file is opened once and hashed through that handle; its identity (device, file id,
// size, modified time) is taken from the same handle. Right before the unlink the path is looked up again (lstat) and
// its folder's real path resolved again; the unlink happens only if the identity is unchanged and the folder still
// resolves inside the clips folder. Node has no unlink-by-handle, so a swap in the few microseconds between that last
// check and the unlink is still possible (residual risk, documented in docs/evidence/2026-11-13-auto-post-scheduled.md).
// Codex re-review: that last step no longer unlinks the clip's own path. The file is moved by one atomic rename (same
// volume) under a random name into <clips folder>/.ujwalam-deleting/, checked again there through its own handle (same
// file id, size, modified time and sha256) and only then unlinked; on any mismatch it is put back by a hard link that
// fails if the path is taken (atomic no-replace, Codex 3rd review) or, if that is not possible, left in the holding
// folder (never deleted). What remains: a
// program that writes the holding folder and guesses the random name within microseconds; and a crash between the
// rename and the unlink leaves the verified file in the holding folder (nothing is lost).
// D403: the file steps (folder check, one-handle hash and identity, re-check, holding folder, put-back) live in
// services/common/safe-delete.mjs, shared with the recording cleanup; this file keeps the YouTube and ledger checks.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { HOLD_DIR_NAME, checkInFolder, hashWithIdentity, holdingDir, safeDeleteFile, sameFileStill } from '../common/safe-delete.mjs';

export { HOLD_DIR_NAME, checkInFolder, hashWithIdentity, holdingDir, sameFileStill };
export const DELETE_FLAG = 'post-delete-uploaded';
export const DELETED_LOG_NAME = 'deleted.jsonl';
/** Reasons that will not change by waiting: the file is kept and not checked again. Every other reason is checked again. */
export const FINAL_KEEP = new Set(['upload-failed', 'upload-rejected', 'not-in-folder', 'outside-folder', 'link', 'not-a-file', 'sha-mismatch', 'no-source-file', 'file-gone', 'unc-path', 'held-in-holding-folder']);

/** The status check's verdict: 'processed' (may delete), 'final' (failed/rejected: keep for good), else null (ask again). */
export function statusVerdict(status) {
  if (!status || status.found !== true) return null;
  if (status.uploadStatus === 'processed') return 'processed';
  if (status.uploadStatus === 'failed' || status.uploadStatus === 'rejected' || status.uploadStatus === 'deleted') return 'final';
  return null;
}

export async function deleteUploadedFile({ flagOn, status, item, ledgerEntry, file, folder, logFile, nowMs = Date.now(), beforeUnlink = null, beforeDelete = null }) {
  const keep = (reason) => ({ deleted: false, reason });
  if (flagOn !== true) return keep('flag-off');
  const v = statusVerdict(status);
  if (v === 'final') return keep(status.uploadStatus === 'rejected' ? 'upload-rejected' : 'upload-failed');
  if (v !== 'processed') return keep(status?.found === false ? 'video-not-found' : 'still-processing');
  if (!item || typeof item.videoId !== 'string' || !item.videoId || typeof item.sha !== 'string' || !item.sha) return keep('not-recorded');
  if (typeof item.sentPublishAt !== 'string' || !item.sentPublishAt) return keep('no-publish-time');
  if (!ledgerEntry || ledgerEntry.status !== 'uploaded' || ledgerEntry.videoId !== item.videoId || ledgerEntry.sha256 !== item.sha) return keep('not-recorded');
  if (ledgerEntry.publishAt !== item.sentPublishAt) return keep('no-publish-time');
  // The file steps (shared, services/common/safe-delete.mjs): in the clips folder, the same bytes as the upload.
  const r = await safeDeleteFile({ file, folder, expectSha: item.sha, hash: true, beforeUnlink, beforeDelete });
  if (!r.deleted) return keep(r.reason);
  const at = new Date(nowMs).toISOString();
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${JSON.stringify({ file: path.basename(file), videoId: item.videoId, at })}\n`);
  } catch { /* the deletion happened; the queue item records it as well */ }
  return { deleted: true, reason: null, at };
}