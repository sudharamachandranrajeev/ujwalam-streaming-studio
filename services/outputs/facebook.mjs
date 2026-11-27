// SPDX-License-Identifier: GPL-3.0-or-later
// Facebook Live as an output (flag facebook-live, D447). Node stdlib only.
//
// addFacebook() adds the `facebook` sink (data/outputs/addons/facebook-live.json) to an O0 output config, fed from the H
// canvas. Compositor -> encoder pool -> delivery pool: the sink binds to a rung, it never owns an encoder. The shared H
// rung that already feeds Twitch/Kick is tried first and reused when the validator (data/platforms/facebook.json) reports
// no error and no warning other than UNVERIFIED_LIMIT / NOT_RECOMMENDED for it; otherwise the add-on's rung is added
// (GPU-scaled from the H canvas by the host). Audio stays the plan's one shared track. NVENC sessions are probed by the
// host at outputs.configure, never assumed. The plan holds Credential Manager target names only, never a URL or a key.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { loadPlatforms } from './validate.mjs';
import { addInstagram, loadAddon as loadAnyAddon, rungProblems, writeInstagramPlan } from './instagram.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FACEBOOK_ADDON_FILE = path.join(REPO, 'data', 'outputs', 'addons', 'facebook-live.json');
export const PLATFORMS_DIR = path.join(REPO, 'data', 'platforms');
export const FACEBOOK_FLAG = 'facebook-live';

let cache = null;
/** The add-on data (flag, sink, rung, target, preferPlatforms, file names). */
export function loadFacebookAddon(file = FACEBOOK_ADDON_FILE) {
  if (file === FACEBOOK_ADDON_FILE && cache) return cache;
  const a = loadAnyAddon(file);
  if (!Array.isArray(a.preferPlatforms)) throw new Error(`facebook add-on: "preferPlatforms" missing in ${file}`);
  if (file === FACEBOOK_ADDON_FILE) cache = a;
  return a;
}

/** Problems of the facebook sink bound to one rung (validator errors and warnings that block reuse). */
export const facebookRungProblems = (config, rungId, { platforms, addon = loadFacebookAddon() } = {}) => rungProblems(config, rungId, { platforms, addon });

/** The config with the facebook sink added: { config, rung, reused, why } (as addInstagram). */
export function addFacebook(config, { platforms = loadPlatforms(PLATFORMS_DIR), addon = loadFacebookAddon() } = {}) {
  return addInstagram(config, { platforms, addon, preferPlatforms: addon.preferPlatforms });
}

/** Writes <dataDir>/outputs/<planName>: basePlan plus the facebook sink, rung and target. -> { file, rung, reused, why } */
export function writeFacebookPlan(dataDir, basePlan, { platformsDir = PLATFORMS_DIR, addon = loadFacebookAddon() } = {}) {
  return writeInstagramPlan(dataDir, basePlan, { platformsDir, addon, preferPlatforms: addon.preferPlatforms });
}

/** True when a plan file names the facebook sink. */
export function planHasFacebook(file, { addon = loadFacebookAddon() } = {}) {
  try { return Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')).targets ?? {}, addon.sink.id); } catch { return false; }
}
