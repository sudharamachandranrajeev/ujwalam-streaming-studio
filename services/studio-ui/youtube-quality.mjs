// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube quality (size + bitrate per YouTube output), shared by the D388 presets (youtube-presets.mjs) and the D389 Go
// live chooser (golive-routes.mjs). One path for both: sizes from the stream options, bitrate limits and defaults from
// data/platforms (never hardcoded), key presence from the Connections status rows (true/false only, D385 slots), the
// shared-rung refusal (a change that would move Twitch/Kick too is refused) and the one save path settings.saveSetup
// (same checks, same D387 apply). Never holds a key. Builds no file path (a server without a data folder still starts).

import { loadPlatforms } from '../outputs/validate.mjs';
import { PLATFORMS_DIR } from '../../app/host/lib/outputs-plan.mjs';
import { portraitOf, qualityKeyOf, readOptions, recommendedKbps } from './stream-setup.mjs';

export const OUTPUT_IDS = Object.freeze(['youtube-h', 'youtube-v']);

/** The size lists per output from the setup module's options: { 'youtube-h': [{ id, setupId, w, h }], 'youtube-v': [...] }.
 *  Sizes are 1080p / 1440p / 2160p by the short side; V maps to the portrait list (1080x1920 ...). */
export function sizeLists(options) {
  const h = options.resolutions.filter((r) => Math.min(r.w, r.h) >= 1080).map((r) => ({ id: r.id, w: r.w, h: r.h }));
  const v = (options.portraitResolutions ?? []).filter((r) => Math.min(r.w, r.h) >= 1080).map((r) => ({ id: `${Math.min(r.w, r.h)}p`, setupId: r.id, w: r.w, h: r.h }));
  return { 'youtube-h': h.map((r) => ({ ...r, setupId: r.id })), 'youtube-v': v };
}

/** Bitrate limits per output and size, from data/platforms (never hardcoded): { min, max, default }. */
export function limitsFor(options, platforms) {
  const vb = platforms?.youtube?.videoBitrateKbps ?? {};
  const max = Number.isInteger(vb.max?.value) ? vb.max.value : options.videoBitrateKbps.max;
  const min = Number.isInteger(vb.min?.value) ? vb.min.value : options.videoBitrateKbps.min;
  const rec = recommendedKbps(platforms);
  const fps = 60;
  const out = {};
  for (const [output, list] of Object.entries(sizeLists(options))) {
    out[output] = {};
    for (const s of list) {
      const def = rec[`${s.id}${fps}`] ?? Math.min(max, Math.max(min, 17000));
      out[output][s.id] = { min, max, default: Math.min(max, Math.max(min, def)) };
    }
  }
  return out;
}

/**
 * opts: { dataDir, settings: createSettingsRoutes(...) result (saveSetup, streamSettingsOn), readSetup: (dataDir) => { setup },
 *         keyPresence: async () => Map<rowId, boolean>, options?, platforms? }
 */
export function createYoutubeQuality(opts) {
  const options = opts.options ?? readOptions();
  const platforms = opts.platforms ?? loadPlatforms(PLATFORMS_DIR);
  const sizes = sizeLists(options);
  const limits = limitsFor(options, platforms);

  /** The setup output a logical YouTube output (youtube-h / youtube-v) stands for: the one with that id, else the first
   *  YouTube output on that canvas. */
  function targetOf(setup, logical) {
    const canvas = logical === 'youtube-v' ? 'V' : 'H';
    const list = (setup?.outputs ?? []).filter((o) => o.platform === 'youtube' && o.canvas === canvas);
    return list.find((o) => o.id === logical) ?? list[0] ?? null;
  }
  const loadSetup = () => { try { return opts.readSetup(opts.dataDir); } catch { return null; } };
  const inUse = () => opts.settings?.streamSettingsOn?.() === true;

  /** Credential Manager row of an output at a size (D385): <id> up to 1080p, <id>-1440p / <id>-2160p above (short side). */
  function rowIdOf(outputId, size) {
    const q = qualityKeyOf(options, size.w, size.h);
    return q ? `${outputId}-${q.id}` : outputId;
  }
  const sizeOf = (logical, id) => sizes[logical]?.find((x) => x.id === id) ?? null;
  async function presence() {
    try { const m = await opts.keyPresence?.(); return m instanceof Map ? m : new Map(); } catch { return new Map(); }
  }
  /** Is a key stored for that output at that size (presence only)? */
  const hasKey = (rows, setup, logical, sizeId) => {
    const s = sizeOf(logical, sizeId);
    const t = setup ? targetOf(setup, logical) : null;
    return !!s && rows.get(rowIdOf(t?.id ?? logical, s)) === true;
  };
  function keysView(setup, rows) {
    const out = {};
    for (const logical of OUTPUT_IDS) out[logical] = Object.fromEntries(sizes[logical].map((s) => [s.id, hasKey(rows, setup, logical, s.id)]));
    return out;
  }
  /** The size id an output streams at in the setup (its own rung, the portrait rung or the main rung), or null. */
  function currentSize(setup, logical) {
    if (!setup?.video) return null;
    if (logical === 'youtube-v') { const p = portraitOf(options, setup.video); return p ? sizes['youtube-v'].find((x) => x.w === p.w && x.h === p.h)?.id ?? null : null; }
    const t = targetOf(setup, logical);
    const id = t?.video ? t.video.output : setup.video.output;
    return sizes['youtube-h'].find((x) => x.setupId === id)?.id ?? null;
  }

  /**
   * The setup with the wanted YouTube size, bitrate and (when given) enabled per listed output; everything else untouched
   * (not even a copy of it differs). wants: { 'youtube-h'?: { size, bitrateKbps, enabled? }, 'youtube-v'?: {...} }.
   * A YouTube H output with its own rung keeps it (output.video); without one it follows the main rung.
   * -> { setup } | { error: 'youtube-output-missing' } | { error: 'shared-rung', name }
   */
  function applyToSetup(setup, wants) {
    const next = structuredClone(setup);
    for (const logical of OUTPUT_IDS) {
      const want = wants[logical];
      if (!want) continue;
      const t = targetOf(next, logical);
      if (!t) return { error: 'youtube-output-missing' };
      const s = sizeOf(logical, want.size);
      if (typeof want.enabled === 'boolean') t.enabled = want.enabled;
      // The rung this change would move: another stream output on it (Twitch, Kick, ...) would change too, also one that
      // is switched off now (it would stream with the changed values once switched on again; Codex review of D388).
      const portrait = logical === 'youtube-v';
      const own = !portrait && t.video;
      if (!own) {
        const cur = portrait ? portraitOf(options, setup.video) : sizes['youtube-h'].find((x) => x.setupId === setup.video.output);
        const curKbps = portrait ? setup.video.portraitBitrateKbps : setup.video.bitrateKbps;
        const changes = !cur || cur.w !== s.w || cur.h !== s.h || curKbps !== want.bitrateKbps;
        const sharer = changes ? next.outputs.find((o) => o !== t && o.platform !== 'youtube' && o.canvas === (portrait ? 'V' : 'H') && (portrait || !o.video)) : null;
        if (sharer) return { error: 'shared-rung', name: sharer.name };
      }
      if (portrait) {
        next.video.portraitOutput = s.setupId;
        next.video.portraitBitrateKbps = want.bitrateKbps;
      } else if (t.video) {
        t.video = { ...t.video, output: s.setupId, bitrateKbps: want.bitrateKbps };
      } else {
        next.video.output = s.setupId;
        next.video.bitrateKbps = want.bitrateKbps;
      }
    }
    return { setup: next };
  }

  /**
   * Applies wants through the one save path. Stream settings off: nothing is touched ({ used: false }).
   * -> { used: false } | { used: true, saved } | { error: 'setup-unreadable'|'youtube-output-missing'|'refused'|'shared-rung', name?, problems? }
   */
  async function apply(wants) {
    if (!inUse()) return { used: false };
    const r = loadSetup();
    if (!r) return { error: 'setup-unreadable' };
    const a = applyToSetup(r.setup, wants);
    if (a.error) return a;
    const saved = await opts.settings.saveSetup(a.setup);
    if (!saved.ok) return { error: 'refused', problems: saved.problems };
    return { used: true, saved };
  }

  return { options, sizes, limits, targetOf, loadSetup, inUse, rowIdOf, sizeOf, presence, hasKey, keysView, currentSize, applyToSetup, apply };
}
