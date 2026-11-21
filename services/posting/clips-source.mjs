// SPDX-License-Identifier: GPL-3.0-or-later
// D375 The clips folder as the source of automatic posts (user 2026-11-13: every finished video in the clips folder is
// a candidate). The clips folder is the clipper's --publish folder (record-clips.mjs: clipsFolder(dataDir), the user's
// setting folders.clips, else <data>/clips), laid out as <clips>/<YYYY-MM-DD>/<name>.mp4 (clip_names.py).
//   scanClipsFolder({ dataDir, folder?, probeSeconds? }) -> { folder, rows: [uploads.json-shaped rows], unknown: n }
// Each video file whose name follows clip_names.py becomes one row: the uploads.json row for the same file when there is
// one (matched by full path, then by file name: the folder may have moved), else a row built from the name (kind, label,
// seconds from ffprobe, run 'clips-folder'). packageUploads({ rows }) then packages the ones that have no package yet
// (same-bytes files are skipped by the ledger). Reads only; never changes a file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { clipsFolder } from '../studio-ui/user-settings.mjs';
import { clipTimeMs, readProvenanceSince } from './post-text.mjs';

/** clip_names.py NAME_RE (keep the two in step). */
export const CLIP_NAME = /^([a-z0-9-]+)_(short|montage|won-reel|impact-play|long-highlights)_(\d{8}-\d{6})_([a-z0-9-]+)_(\d{2,3})_(v|h|v-[a-z0-9-]+)\.mp4$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const FOLDER_RUN = 'clips-folder';
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const realFile = (p) => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
const realDir = (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const norm = (p) => path.resolve(p).toLowerCase();

/** Length in seconds from ffprobe (FFPROBE or PATH; hidden window, D191), or null. */
export function ffprobeSeconds(file) {
  const r = spawnSync(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const v = Number(String(r.stdout ?? '').trim());
  return r.status === 0 && Number.isFinite(v) && v > 0 ? Number(v.toFixed(3)) : null;
}

/** clip_publish.py video_binding: size + SHA-256 of the first and last MiB of the video, or null. */
const BIND_BYTES = 1 << 20;
export function videoBinding(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const part = (at) => { const buf = Buffer.alloc(Math.min(BIND_BYTES, size - at)); readSync(fd, buf, 0, buf.length, at); return createHash('sha256').update(buf).digest('hex'); };
    return { size, head: part(0), tail: part(Math.max(0, size - BIND_BYTES)) };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
/**
 * clip_publish.py write_music_sidecar: <video>.music.json { version, music, video } -> the music record, or null (no
 * sidecar). Codex verify (D414): the sidecar is bound to its video (size + first and last MiB); a sidecar that is
 * unreadable, unbound or bound to other bytes gives { source: 'unknown' } (held). Residual: whoever can write the data
 * folder can rewrite both, the same trust as uploads.json.
 */
export const MUSIC_SIDECAR = '.music.json';
export function musicSidecar(file) {
  const p = `${file}${MUSIC_SIDECAR}`;
  if (!realFile(p)) return null;
  const unknown = { source: 'unknown' };
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!isPlain(j?.music) || !isPlain(j?.video)) return unknown;
    const v = videoBinding(file);
    return v && v.size === j.video.size && v.head === j.video.head && v.tail === j.video.tail ? j.music : unknown;
  } catch { return unknown; }
}

/**
 * Codex verify (D414): the music record for an existing uploads.json row and its file. The row is trusted only while
 * its video binding (clip_publish.py video_binding, written with the row) matches the file. A row whose binding does
 * not match, or that has none while the file is newer than the provenance start, is ignored: the sidecar decides, and
 * no valid sidecar is unknown (held). A row with no binding on an older file keeps its record (legacy rule after).
 */
export function trustedMusic(row, file, sinceMs) {
  const fromSidecar = () => musicSidecar(file) ?? { source: 'unknown' };
  if (isPlain(row.video)) {
    const v = videoBinding(file);
    return v && v.size === row.video.size && v.head === row.video.head && v.tail === row.video.tail ? row.music : fromSidecar();
  }
  const t = clipTimeMs(file);
  if (Number.isFinite(sinceMs) && (t === null || Math.floor(t) > sinceMs)) return fromSidecar();
  return row.music === undefined ? musicSidecar(file) ?? undefined : row.music;
}

export function scanClipsFolder({ dataDir, folder = clipsFolder(dataDir), probeSeconds = ffprobeSeconds } = {}) {
  let known = [];
  try { const j = JSON.parse(readFileSync(path.join(dataDir, 'clips', 'uploads.json'), 'utf8')); if (Array.isArray(j?.files)) known = j.files.filter((r) => isPlain(r) && typeof r.file === 'string'); } catch { /* none yet */ }
  const byPath = new Map(known.map((r) => [norm(r.file), r]));
  const byName = new Map(known.map((r) => [path.basename(r.file).toLowerCase(), r]));
  const rows = []; let unknown = 0;
  if (!realDir(folder)) return { folder, rows, unknown };
  const since = readProvenanceSince(dataDir);
  for (const day of readdirSync(folder).filter((d) => DAY.test(d)).sort()) {
    const dir = path.join(folder, day);
    if (!realDir(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const m = CLIP_NAME.exec(name);
      if (!m) { if (name.toLowerCase().endsWith('.mp4')) unknown++; continue; }
      if (!realFile(file)) continue;
      const row = byPath.get(norm(file)) ?? byName.get(name.toLowerCase());
      if (row) { const { music: _m, ...rest } = row; const mu = trustedMusic(row, file, since); rows.push({ ...rest, file, ...(mu !== undefined ? { music: mu } : {}) }); continue; }
      // D414 (Codex BD review): the music record the publish step wrote next to the video; none = unknown (a montage
      // with unknown music is not posted, services/posting/post-text.mjs musicOf)
      const music = musicSidecar(file);
      rows.push({ file, kind: m[2], label: m[4], seconds: probeSeconds(file), run: FOLDER_RUN, posted: [], ...(music ? { music } : {}) });
    }
  }
  return { folder, rows, unknown };
}
