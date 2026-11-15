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
import { ID_RE, cleanTitle, readChoices, withoutTemplate, writeChoices } from '../platform-connect/youtube-events.mjs';
import { OUTPUT_IDS, createYoutubeQuality } from './youtube-quality.mjs';

export { OUTPUT_IDS, limitsFor, sizeLists } from './youtube-quality.mjs';

export const PRESETS_FILE = 'youtube-presets.json';
export const MAX_PRESETS = 12;
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
 *         events: async () => the GET /ui/api/youtube/events body, log?, options?, platforms?,
 *         quality?: a shared createYoutubeQuality(...) (built from these opts when absent) }
 * Returns { handle(method, route, body, res) -> boolean (handled) }.
 */
export function createYoutubePresets(opts) {
  const { dataDir, json } = opts;
  const log = opts.log ?? (() => {});
  // The shared quality path (youtube-quality.mjs): sizes, limits, key presence, shared-rung refusal, saveSetup.
  const q = opts.quality ?? createYoutubeQuality(opts);
  const { sizes, limits } = q;
  // No data folder (a server built without one): the routes answer no-data-dir (handle), so no path is made.
  const file = dataDir ? path.join(dataDir, PRESETS_FILE) : null;
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
    writeFileSync(tmp, `${JSON.stringify({ version: 1, presets: store.presets, activeId: store.activeId }, null, 2)}
`);
    renameSync(tmp, file);
  }
  const { targetOf, loadSetup, presence, keysView } = q;

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
      const a = q.applyToSetup(r.setup, preset.outputs);
      if (a.error === 'shared-rung') return json(res, 409, { error: 'shared-rung', message: `${a.name} streams from the same encoder as YouTube, so a preset would change it too. Give ${a.name} its own size in Settings > Stream (Edit output), then use the preset.` }), true;
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
    let templates = 0;
    for (const logical of OUTPUT_IDS) {
      const want = preset.outputs[logical];
      const t = (saved?.setup ?? view0?.setup) ? targetOf(saved?.setup ?? view0.setup, logical) : null;
      const id = t?.id ?? logical;
      // D389: the Go live chooser's parts of the choice (size, event, new-event fields) are kept.
      if (want.templateId !== null) { choices[id] = { ...(withoutTemplate(choices[id]) ?? {}), templateId: want.templateId, templateTitle: want.templateTitle ?? '', title: want.title }; templates += 1; }
    }
    // A preset with a template picks "copy a past stream" as the Go live mode (D389); one without leaves the mode alone.
    writeChoices(dataDir, choices, templates ? { mode: 'copy' } : {});
    store.activeId = preset.id;
    writeStore(store);
    // Missing keys: sizes with no stored key (presence only).
    const rows = await presence();
    const base = saved?.setup ?? view0?.setup ?? null;
    const missingKeys = [];
    for (const logical of OUTPUT_IDS) {
      const want = preset.outputs[logical];
      if (!want.enabled) continue;
      if (!q.hasKey(rows, base, logical, want.size)) missingKeys.push(`${logical} ${want.size}`);
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
