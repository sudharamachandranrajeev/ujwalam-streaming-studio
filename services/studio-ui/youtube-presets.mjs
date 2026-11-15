// SPDX-License-Identifier: GPL-3.0-or-later
// Named YouTube quality presets (D388 part A). A preset holds, for YouTube H and YouTube V, on/off, a size, a bitrate and
// the event template choice. Using a preset changes only those YouTube fields of the saved stream setup (through the same
// save + D387 apply path as Settings > Stream Save) and writes the two template choices (youtube-events.json). A preset
// never holds a key: a size only names the Credential Manager slot (D385), and only key presence (true/false) is shown.
// No feature flag. Never stops or reconfigures a live output: while anything is live the D387 pending path applies.
//
//   GET  /ui/api/youtube/presets            { presets, activeId, sizes, limits, keys, setupInUse }
//   POST /ui/api/youtube/preset/save {preset}   (no id = new)  -> { ok, preset, presets }
//   POST /ui/api/youtube/preset/delete {id}                    -> { ok, presets, activeId }
//   POST /ui/api/youtube/preset/use {id}                       -> { ok, activeId, appliesAt, detail?, missingKeys, events }
// Errors: { error: <code>, message: <plain sentence> }. Logs: counts and codes only, never a name, title or key.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadPlatforms } from '../outputs/validate.mjs';
import { PLATFORMS_DIR } from '../../app/host/lib/outputs-plan.mjs';
import { ID_RE, cleanTitle, readChoices, writeChoices } from '../platform-connect/youtube-events.mjs';
import { qualityKeyOf, readOptions, recommendedKbps } from './stream-setup.mjs';

export const PRESETS_FILE = 'youtube-presets.json';
export const MAX_PRESETS = 12;
export const OUTPUT_IDS = Object.freeze(['youtube-h', 'youtube-v']);
const PRESET_ID_RE = /^p-[0-9a-f]{8}$/;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k));

const MESSAGES = {
  'bad-params': 'That request was not understood.',
  'bad-preset': 'The preset is not valid.',
  'unknown-preset': 'That preset does not exist (it may have been deleted).',
  'too-many-presets': `At most ${MAX_PRESETS} presets; delete one first.`,
  refused: 'The stream settings were refused, so nothing was changed.',
  'youtube-output-missing': 'Settings > Stream has no YouTube output for this preset; add it there first.',
  'setup-unreadable': 'The stream settings file could not be read.',
  'no-data-dir': 'No data folder.',
};

/** A preset name: 1..40 plain characters (no control characters, no angle brackets). */
export function cleanName(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > 40 || /[<>]/.test(t) || /[\x00-\x1f\x7f]/.test(t)) return null;
  return t;
}

/** The size lists per output from the setup module's options: { 'youtube-h': [{ id, w, h }], 'youtube-v': [...] }.
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

function cleanOutput(o, output, sizes, limits) {
  if (!isPlain(o) || !onlyKeys(o, ['enabled', 'size', 'bitrateKbps', 'templateId', 'templateTitle', 'title'])) return null;
  if (typeof o.enabled !== 'boolean') return null;
  if (typeof o.size !== 'string' || !sizes[output].some((s) => s.id === o.size)) return null;
  const lim = limits[output][o.size];
  if (!Number.isInteger(o.bitrateKbps) || o.bitrateKbps < lim.min || o.bitrateKbps > lim.max) return null;
  const templateId = o.templateId ?? null;
  if (!(templateId === null || (typeof templateId === 'string' && ID_RE.test(templateId)))) return null;
  let templateTitle = null; let title = null;
  if (templateId !== null) {
    if (!(o.templateTitle === undefined || o.templateTitle === null || typeof o.templateTitle === 'string')) return null;
    templateTitle = typeof o.templateTitle === 'string' ? o.templateTitle.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100) : '';
    if (o.title !== undefined && o.title !== null) {
      title = cleanTitle(o.title);
      if (title === null) return null;
    }
  } else if ((o.templateTitle ?? null) !== null || (o.title ?? null) !== null) return null;
  return { enabled: o.enabled, size: o.size, bitrateKbps: o.bitrateKbps, templateId, templateTitle, title };
}

/** A checked preset ({ id?, name, outputs }) or null. Unknown keys are refused. */
export function cleanPreset(p, { sizes, limits, requireId = false }) {
  if (!isPlain(p) || !onlyKeys(p, ['id', 'name', 'outputs'])) return null;
  if (p.id !== undefined && !(typeof p.id === 'string' && PRESET_ID_RE.test(p.id))) return null;
  if (requireId && p.id === undefined) return null;
  const name = cleanName(p.name);
  if (!name || !isPlain(p.outputs) || !onlyKeys(p.outputs, OUTPUT_IDS) || !OUTPUT_IDS.every((k) => k in p.outputs)) return null;
  const outputs = {};
  for (const k of OUTPUT_IDS) {
    const c = cleanOutput(p.outputs[k], k, sizes, limits);
    if (!c) return null;
    outputs[k] = c;
  }
  return { ...(p.id ? { id: p.id } : {}), name, outputs };
}

/**
 * opts: { dataDir, json, settings: createSettingsRoutes(...) result (saveSetup, streamSettingsOn, ...),
 *         readSetup: (dataDir) => { exists, setup }, keyPresence: async () => Map<rowId, boolean> (Connections status rows),
 *         events: async () => the GET /ui/api/youtube/events body, log?, options?, platforms? }
 * Returns { handle(method, route, body, res) -> boolean (handled) }.
 */
export function createYoutubePresets(opts) {
  const { dataDir, json } = opts;
  const log = opts.log ?? (() => {});
  const options = opts.options ?? readOptions();
  const platforms = opts.platforms ?? loadPlatforms(PLATFORMS_DIR);
  const sizes = sizeLists(options);
  const limits = limitsFor(options, platforms);
  const file = path.join(dataDir, PRESETS_FILE);
  const fail = (res, status, code, extra = {}) => json(res, status, { error: code, message: MESSAGES[code] ?? 'Not done.', ...extra });

  function readStore() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      const presets = [];
      for (const p of Array.isArray(raw?.presets) ? raw.presets : []) {
        const c = cleanPreset(p, { sizes, limits, requireId: true });
        if (c && !presets.some((x) => x.id === c.id) && presets.length < MAX_PRESETS) presets.push(c);
      }
      return { presets, activeId: presets.some((p) => p.id === raw?.activeId) ? raw.activeId : null };
    } catch { return { presets: [], activeId: null }; }
  }
  function writeStore(store) {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, presets: store.presets, activeId: store.activeId }, null, 2)}\n`);
    renameSync(tmp, file);
  }

  // The setup output a logical YouTube output (youtube-h / youtube-v) stands for: the one with that id, else the first
  // YouTube output on that canvas.
  function targetOf(setup, logical) {
    const canvas = logical === 'youtube-v' ? 'V' : 'H';
    const list = setup.outputs.filter((o) => o.platform === 'youtube' && o.canvas === canvas);
    return list.find((o) => o.id === logical) ?? list[0] ?? null;
  }
  const loadSetup = () => { try { return opts.readSetup(dataDir); } catch { return null; } };

  // Credential Manager row of an output at a size (D385): <id> up to 1080p, <id>-1440p / <id>-2160p above (short side).
  function rowIdOf(outputId, size) {
    const q = qualityKeyOf(options, size.w, size.h);
    return q ? `${outputId}-${q.id}` : outputId;
  }
  async function presence() {
    try { const m = await opts.keyPresence?.(); return m instanceof Map ? m : new Map(); } catch { return new Map(); }
  }
  function keysView(setup, rows) {
    const out = {};
    for (const logical of OUTPUT_IDS) {
      const t = setup ? targetOf(setup, logical) : null;
      const id = t?.id ?? logical;
      out[logical] = Object.fromEntries(sizes[logical].map((s) => [s.id, rows.get(rowIdOf(id, s)) === true]));
    }
    return out;
  }

  /** The setup with the preset's YouTube H/V size, bitrate and enabled; everything else untouched (not even a copy of it
   *  differs). A YouTube H output with its own rung keeps it (output.video); without one it follows the main rung. */
  function applyToSetup(setup, preset) {
    const next = structuredClone(setup);
    for (const logical of OUTPUT_IDS) {
      const want = preset.outputs[logical];
      const t = targetOf(next, logical);
      if (!t) return { error: 'youtube-output-missing' };
      const s = sizes[logical].find((x) => x.id === want.size);
      t.enabled = want.enabled;
      if (logical === 'youtube-v') {
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

  async function handle(method, route, body, res) {
    if (!route.startsWith('/ui/api/youtube/preset')) return false;
    if (!dataDir) return fail(res, 409, 'no-data-dir'), true;
    if (route === '/ui/api/youtube/presets') {
      if (method !== 'GET') return json(res, 405, { error: 'method-not-allowed' }), true;
      const store = readStore();
      const r = loadSetup();
      const rows = await presence();
      return json(res, 200, { presets: store.presets, activeId: store.activeId, sizes: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, v.map((s) => s.id)])),
        limits, keys: keysView(r?.setup ?? null, rows), setupInUse: opts.settings?.streamSettingsOn?.() === true }), true;
    }
    if (route !== '/ui/api/youtube/preset/save' && route !== '/ui/api/youtube/preset/delete' && route !== '/ui/api/youtube/preset/use') return false;
    if (method !== 'POST') return json(res, 405, { error: 'method-not-allowed' }), true;
    if (!isPlain(body)) return fail(res, 400, 'bad-params'), true;

    if (route === '/ui/api/youtube/preset/save') {
      if (!onlyKeys(body, ['preset'])) return fail(res, 400, 'bad-params'), true;
      const c = cleanPreset(body.preset, { sizes, limits });
      if (!c) return fail(res, 400, 'bad-preset'), true;
      const store = readStore();
      let preset;
      if (c.id) {
        const i = store.presets.findIndex((p) => p.id === c.id);
        if (i < 0) return fail(res, 404, 'unknown-preset'), true;
        preset = c; store.presets[i] = preset;
      } else {
        if (store.presets.length >= MAX_PRESETS) return fail(res, 400, 'too-many-presets'), true;
        let id;
        do { id = `p-${randomBytes(4).toString('hex')}`; } while (store.presets.some((p) => p.id === id));
        preset = { id, ...c }; store.presets.push(preset);
      }
      writeStore(store);
      log(`[studio-ui] youtube-presets: saved (${store.presets.length} preset(s))`);
      return json(res, 200, { ok: true, preset, presets: store.presets }), true;
    }

    if (!onlyKeys(body, ['id']) || typeof body.id !== 'string' || !PRESET_ID_RE.test(body.id)) return fail(res, 400, 'bad-params'), true;
    const store = readStore();
    const preset = store.presets.find((p) => p.id === body.id);
    if (!preset) return fail(res, 404, 'unknown-preset'), true;

    if (route === '/ui/api/youtube/preset/delete') {
      store.presets = store.presets.filter((p) => p.id !== body.id);
      if (store.activeId === body.id) store.activeId = null;
      writeStore(store);
      log(`[studio-ui] youtube-presets: deleted (${store.presets.length} left)`);
      return json(res, 200, { ok: true, presets: store.presets, activeId: store.activeId }), true;
    }

    // ---- use ----
    const inUse = opts.settings?.streamSettingsOn?.() === true;
    let setup = null;
    if (inUse) {
      const r = loadSetup();
      if (!r) return fail(res, 409, 'setup-unreadable'), true;
      const a = applyToSetup(r.setup, preset);
      if (a.error) return fail(res, 409, a.error), true;
      setup = a.setup;
    }
    let saved = null;
    if (setup) {
      saved = await opts.settings.saveSetup(setup);
      if (!saved.ok) return fail(res, 422, 'refused', { problems: saved.problems }), true;
    }
    // The template choices (merged: other outputs kept). A preset without a template leaves that output's choice alone.
    const view0 = loadSetup();
    const choices = readChoices(dataDir);
    for (const logical of OUTPUT_IDS) {
      const want = preset.outputs[logical];
      const t = (saved?.setup ?? view0?.setup) ? targetOf(saved?.setup ?? view0.setup, logical) : null;
      if (want.templateId !== null) choices[t?.id ?? logical] = { templateId: want.templateId, templateTitle: want.templateTitle ?? '', title: want.title };
    }
    writeChoices(dataDir, choices);
    store.activeId = preset.id;
    writeStore(store);
    // Missing keys: sizes with no stored key (presence only).
    const rows = await presence();
    const base = saved?.setup ?? view0?.setup ?? null;
    const missingKeys = [];
    for (const logical of OUTPUT_IDS) {
      const want = preset.outputs[logical];
      if (!want.enabled) continue;
      const t = base ? targetOf(base, logical) : null;
      const s = sizes[logical].find((x) => x.id === want.size);
      if (rows.get(rowIdOf(t?.id ?? logical, s)) !== true) missingKeys.push(`${logical} ${want.size}`);
    }
    let events = null;
    try { events = await opts.events?.(); } catch { events = null; }
    log(`[studio-ui] youtube-presets: used (${saved ? saved.appliesAt : 'not-used'}, ${missingKeys.length} key(s) missing)`);
    const base200 = { ok: true, activeId: preset.id, missingKeys, events };
    if (!saved) {
      return json(res, 200, { ...base200, appliesAt: 'not-used', detail: 'The YouTube templates are set. The sizes and bitrates are not used, because Settings > Stream is off: turn it on there to stream with them.' }), true;
    }
    return json(res, 200, { ...base200, appliesAt: saved.appliesAt, ...(saved.applied ? {} : saved.detail ? { detail: saved.detail } : {}) }), true;
  }

  return { handle, readStore };
}
