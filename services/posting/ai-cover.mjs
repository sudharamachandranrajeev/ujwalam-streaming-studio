// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T3: the cover with the AI hook. After the AI post text passed its checks (ai-text-check.mjs: privacy, screen names,
// no numbers, thumbTime inside the clip), the cover is the frame at thumbTime with the 2-4 word hook as big text, made by
// the RP6 renderer (services/clip/reel_cover.py -> reel_thumbnail.png_argv). Any failure keeps the plain frame.
// The cover is later sent by the YouTube client's thumbnails.set (youtube.mjs); real Google call UNVERIFIED.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ocrPython } from './ai-text.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COVER_MAX_BYTES = 2_000_000; // YouTube's thumbnails.set limit is 2 MB

/** Default cover maker: ({ ffmpeg, video, atSec, hook, out, python? }) -> Promise<boolean>. Never throws. */
export function makeHookCover({ ffmpeg, video, atSec, hook, out, python = ocrPython(), timeoutMs = 150_000, spawnFn = spawn }) {
  return new Promise((resolve) => {
    if (!python || typeof hook !== 'string' || !hook.trim() || !Number.isFinite(atSec)) return resolve(false);
    const wd = path.dirname(out);
    const args = ['-I', path.join(REPO, 'services', 'clip', 'reel_cover.py'), ffmpeg, video, atSec.toFixed(3), out, wd, ...hook.trim().split(/\s+/)];
    let p;
    try { p = spawnFn(python, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); } catch { return resolve(false); }
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => {
      clearTimeout(t);
      let ok = false;
      try { const s = statSync(out); ok = code === 0 && s.isFile() && s.size > 0 && s.size <= COVER_MAX_BYTES; } catch { /* missing */ }
      resolve(ok);
    });
  });
}
