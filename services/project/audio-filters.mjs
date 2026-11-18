// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer strip tools (AU2, plan 2026-11-18-audio-mixer-music): the libobs audio filters a project audio source carries in
// `filters`. One table for the validator (validate.mjs), the studio's sliders and the host's ranges (app/host/src/
// audio_filters.cpp). Every range is the filter's own obs_properties limit in OBS 32.1.2 (plugins/obs-filters, checked
// 2026-11-18): noise-gate-filter.c VOL_MIN/VOL_MAX and add_int 0..10000; compressor-filter.c MIN/MAX_RATIO,
// MIN/MAX_THRESHOLD_DB, MIN_ATK_RLS_MS..MAX_ATK_MS / MAX_RLS_MS, MIN/MAX_OUTPUT_GAIN_DB; limiter-filter.c; gain-filter.c
// slider -30..30; eq-filter.c sliders -20..20. Noise suppression is RNNoise (noise_suppress_filter_v2, method rnnoise),
// which has no level setting.
//
// Processing order on a strip (fixed, not data): suppress -> gate -> eq -> gain -> duck -> compressor -> limiter. Each
// tool is { on: boolean, ...its values }; a tool left out is not on the strip. All values of a present tool are
// required, so a saved project always says exactly what plays.
//
// AU3 duck ("Duck under: <mic>"): a compressor_filter whose sidechain is another project sound (`source`, its audio
// source id; never a device name: the host finds the source). The strip drops by about amountDb while that sound is at
// DUCK_REF_DB, and starts dropping once it passes DUCK_THRESHOLD_DB. The host turns ducking off with a plain reason
// while that sound is not in the mixer (or is a layer's sound) and on again when it is back. attackMs: the drop is there
// within it; releaseMs: the strip is back within it (the host divides both by ln(10) for compressor_filter's time
// constants; the ranges are compressor_filter's own limits).

export const FILTER_ORDER = Object.freeze(['suppress', 'gate', 'eq', 'gain', 'duck', 'compressor', 'limiter']);
export const DUCK_THRESHOLD_DB = -30;
export const DUCK_REF_DB = -10;
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,63}$/; // the project id pattern (validate.mjs ID_RE)

/** key -> [min, max, step, 'int'?, default]. Defaults are the filters' own obs defaults. */
export const FILTER_RANGES = Object.freeze({
  suppress: Object.freeze({}),
  gate: Object.freeze({
    closeDb: [-96, 0, 1, null, -32], openDb: [-96, 0, 1, null, -26],
    attackMs: [0, 10000, 1, 'int', 25], holdMs: [0, 10000, 1, 'int', 200], releaseMs: [0, 10000, 1, 'int', 150],
  }),
  eq: Object.freeze({ lowDb: [-20, 20, 0.1, null, 0], midDb: [-20, 20, 0.1, null, 0], highDb: [-20, 20, 0.1, null, 0] }),
  gain: Object.freeze({ db: [-30, 30, 0.1, null, 0] }),
  compressor: Object.freeze({
    ratio: [1, 32, 0.5, null, 10], thresholdDb: [-60, 0, 0.1, null, -18],
    attackMs: [1, 500, 1, 'int', 6], releaseMs: [1, 1000, 1, 'int', 60], outputGainDb: [-32, 32, 0.1, null, 0],
  }),
  limiter: Object.freeze({ thresholdDb: [-60, 0, 0.1, null, -6], releaseMs: [1, 1000, 1, 'int', 60] }),
  // amount: 3..18 dB keeps the derived ratio inside compressor_filter's 1..32 (18 dB over 20 dB = ratio 10)
  duck: Object.freeze({ amountDb: [3, 18, 1, null, 12], attackMs: [1, 500, 1, 'int', 10], releaseMs: [1, 1000, 1, 'int', 400] }),
});

/** Tool fields that are not numbers: duck.source (a project audio source id). */
export const FILTER_REFS = Object.freeze({ duck: Object.freeze(['source']) });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Problems of a `filters` value as [{ path, message }] (path relative to `p`). */
export function filtersProblems(f, p) {
  const out = [];
  if (!isObj(f)) return [{ path: p, message: 'must be an object' }];
  for (const [k, t] of Object.entries(f)) {
    const tp = `${p}.${k}`;
    if (!Object.hasOwn(FILTER_RANGES, k)) { out.push({ path: tp, message: 'unknown tool' }); continue; }
    if (!isObj(t)) { out.push({ path: tp, message: 'must be an object' }); continue; }
    const refs = FILTER_REFS[k] ?? [];
    const keys = ['on', ...refs, ...Object.keys(FILTER_RANGES[k])];
    for (const x of Object.keys(t)) if (!keys.includes(x)) out.push({ path: `${tp}.${x}`, message: 'unknown property' });
    for (const x of keys) if (!(x in t)) out.push({ path: `${tp}.${x}`, message: 'required' });
    if ('on' in t && typeof t.on !== 'boolean') out.push({ path: `${tp}.on`, message: 'must be a boolean' });
    for (const x of refs) if (x in t && (typeof t[x] !== 'string' || !SOURCE_RE.test(t[x]))) out.push({ path: `${tp}.${x}`, message: 'must be a project sound id' });
    for (const [x, [min, max, , kind]] of Object.entries(FILTER_RANGES[k])) {
      if (!(x in t)) continue;
      const v = t[x];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (kind === 'int' && !Number.isInteger(v)))
        out.push({ path: `${tp}.${x}`, message: `must be ${kind === 'int' ? 'an integer' : 'a number'} from ${min} to ${max}` });
    }
    // the gate closes below where it opens (noise_gate_filter has no check; a close level above the open level chatters)
    if (k === 'gate' && typeof t.closeDb === 'number' && typeof t.openDb === 'number' && t.closeDb > t.openDb)
      out.push({ path: `${tp}.closeDb`, message: 'must not be above openDb' });
  }
  return out;
}

/** A tool with its obs defaults and `on`. */
export function defaultTool(kind, on = true) {
  const t = { on };
  for (const [x, r] of Object.entries(FILTER_RANGES[kind])) t[x] = r[4];
  return t;
}
