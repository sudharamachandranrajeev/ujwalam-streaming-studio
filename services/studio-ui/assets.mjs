// SPDX-License-Identifier: GPL-3.0-or-later
// The user's stream assets folder (D241) as a list for the add-layer form: still images and videos only, relative
// paths with forward slashes (pathRef rel under base "media"). Plain files only (no links), at most `max` entries and
// `depth` folders deep; hidden names (leading dot) are skipped. Node stdlib only.

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { IMAGE_EXT } from '../project/index.mjs';

export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);

/** [{ rel, kind: 'image' | 'media' }] sorted by rel; [] when the folder cannot be read. */
export function listAssets(dir, { max = 500, depth = 4 } = {}) {
  const out = [];
  const walk = (abs, rel, d) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (d < depth) walk(path.join(abs, e.name), r, d + 1); continue; }
      if (!e.isFile() || r.length > 260) continue; // links and others; pathRef rel is at most 260 characters
      const ext = path.extname(e.name).toLowerCase();
      if (IMAGE_EXT.has(ext)) out.push({ rel: r, kind: 'image' });
      else if (VIDEO_EXT.has(ext)) out.push({ rel: r, kind: 'media' });
    }
  };
  if (typeof dir === 'string' && dir) walk(dir, '', 0);
  return out;
}

// AU1 (plan 2026-11-18): sound files for "Add audio > A sound file or playlist". Same rules as listAssets.
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.opus', '.flac', '.m4a', '.aac', '.wma']);

/** { files: [rel], folders: [{ rel, count }] }: audio files, and folders (the base itself as rel '.') holding at least
 *  one audio file directly (a folder plays as a playlist of the files in it, by name, as the host does). */
export function listAudio(dir, { max = 500, depth = 4 } = {}) {
  const files = [];
  const folders = new Map();
  const walk = (abs, rel, d) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= max) return;
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (d < depth) walk(path.join(abs, e.name), r, d + 1); continue; }
      if (!e.isFile() || r.length > 260 || !AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;
      files.push(r);
      const key = rel || '.';
      folders.set(key, (folders.get(key) ?? 0) + 1);
    }
  };
  if (typeof dir === 'string' && dir) walk(dir, '', 0);
  return { files, folders: [...folders].filter(([rel]) => rel !== '.').map(([rel, count]) => ({ rel, count })) };
}