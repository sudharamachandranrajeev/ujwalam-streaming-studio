// SPDX-License-Identifier: GPL-3.0-or-later
// Mixer strip tools (AU2, plan 2026-11-18-audio-mixer-music): the libobs audio filters a project audio source carries in
// `filters`. One table for the validator (validate.mjs), the studio's sliders and the host's ranges (app/host/src/
// audio_filters.cpp). Every range is the filter's own obs_properties limit in OBS 32.1.2 (plugins/obs-filters, checked
// 2026-11-18): noise-gate-filter.c VOL_MIN/VOL_MAX and add_int 0..10000; compressor-filter.c MIN/MAX_RATIO,
// MIN/MAX_THRESHOLD_DB, MIN_ATK_RLS_MS..MAX_ATK_MS / MAX_RLS_MS, MIN/MAX_OUTPUT_GAIN_DB; limiter-filter.c; gain-filter.c
// slider -30..30; eq-filter.c sliders -20..20. Noise suppression is RNNoise (noise_suppress_filter_v2, method rnnoise),
// which has no level setting.
//
// Processing order on a strip (fixed, not data): suppress -> gate -> eq -> gain -> compressor -> limiter. Each tool is
// { on: boolean, ...its values }; a tool left out is not on the strip. All values of a present tool are required, so a
// saved project always says exactly what plays.

export const FILTER_ORDER = Object.freeze(['suppress', 'gate', 'eq', 'gain', 'compressor', 'limiter']);

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
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Problems of a `filters` value as [{ path, message }] (path relative to `p`). */
export function filtersProblems(f, p) {
  const out = [];
  if (!isObj(f)) return [{ path: p, message: 'must be an object' }];
  for (const [k, t] of Object.entries(f)) {
    const tp = `${p}.${k}`;
    if (!Object.hasOwn(FILTER_RANGES, k)) { out.push({ path: tp, message: 'unknown tool' }); continue; }
    if (!isObj(t)) { out.push({ path: tp, message: 'must be an object' }); continue; }
    const keys = ['on', ...Object.keys(FILTER_RANGES[k])];
    for (const x of Object.keys(t)) if (!keys.includes(x)) out.push({ path: `${tp}.${x}`, message: 'unknown property' });
    for (const x of keys) if (!(x in t)) out.push({ path: `${tp}.${x}`, message: 'required' });
    if ('on' in t && typeof t.on !== 'boolean') out.push({ path: `${tp}.on`, message: 'must be a boolean' });
    for (const [x, [min, max, , kind]] of Object.entries(FILTER_RANGES[k])) {
      if (!(x in t)) continue;
      const v = t[x];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (kind === 'int' && !Number.isInteger(v)))
        out.push({ path: `${tp}.${x}`, message: `must be ${kind === 'int' ? 'an integer' : 'a number'} from ${min} to ${max}` });
    }
  }
  return out;
}

/** A tool with its obs defaults and `on`. */
export function defaultTool(kind, on = true) {
  const t = { on };
  for (const [x, r] of Object.entries(FILTER_RANGES[kind])) t[x] = r[4];
  return t;
}
