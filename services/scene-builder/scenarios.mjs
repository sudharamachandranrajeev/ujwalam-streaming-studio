// SPDX-License-Identifier: GPL-3.0-or-later
// Scenario scenes (D390): "gameplay, lobby, screen share, starting soon, BRB, ending" as data
// (data/scene-templates/<id>.json, schema data/schemas/scene-template.schema.json). A template gives the slot boxes of
// the H scene and of the V scene explicitly; this adapter turns each canvas into the scene builder's reference-read
// shape (confidence 1: the user chose the scenario) and lets buildPackage (SB3) link the slots to the user's own
// sources, with placeholders where nothing matches. The result is one scene package with an H and a V preset, applied
// by the existing importer: a NEW scene, existing scenes, layers, devices and settings unchanged.
//
//   listTemplates(dir?)                         -> templates, in card order
//   templatePreview(template)                   -> { id, label, description, needsScreen, preview: { h: [{ role, box }], v: [...] } }
//   buildScenario(template, project, { rules, bind, text, now }) -> scene package
//     bind.screen: see sources.mjs (a layer id, or { create: { type, source, content? } } for a picked window / screen).
//     text: replaces the message on a holding screen (graphics slot), up to 80 characters.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage, loadBuildRules } from './build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATES_DIR = path.join(REPO, 'data', 'scene-templates');
const ROLES = ['game', 'camera', 'chat', 'alerts', 'screen', 'graphics'];
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const DEFAULT_SIZE = { h: { width: 1920, height: 1080 }, v: { width: 1080, height: 1920 } };

/** Problems with a template's shape (plain words; [] when usable). The JSON schema is the full check (tests). */
export function templateProblems(t) {
  const p = [];
  if (!t || typeof t !== 'object') return ['template must be an object'];
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) p.push('id must be a short lowercase id');
  for (const k of ['label', 'description', 'sceneName']) if (typeof t[k] !== 'string' || !t[k].trim()) p.push(`${k} must be text`);
  for (const c of ['h', 'v']) {
    const slots = t.slots?.[c];
    if (!Array.isArray(slots) || !slots.length) { p.push(`slots.${c} must list at least one slot`); continue; }
    const seen = new Set();
    for (const s of slots) {
      const b = s?.box;
      if (!ROLES.includes(s?.role)) { p.push(`${c}: unknown role "${s?.role}"`); continue; }
      if (!b || ['x', 'y', 'w', 'h'].some((k) => typeof b[k] !== 'number' || b[k] < 0 || b[k] > 1) || b.x + b.w > 1 + 1e-9 || b.y + b.h > 1 + 1e-9) p.push(`${c}: the ${s.role} box must sit inside the canvas`);
      if (s.text !== undefined && (s.role !== 'graphics' || typeof s.text !== 'string' || !s.text || s.text.length > 80)) p.push(`${c}: text is for a graphics slot, 1 to 80 characters`);
      if (s.role !== 'graphics') { if (seen.has(s.role)) p.push(`${c}: more than one ${s.role} slot`); seen.add(s.role); }
    }
  }
  return p;
}

export function listTemplates(dir = TEMPLATES_DIR) {
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const bad = templateProblems(t);
    if (bad.length) throw new Error(`scene template ${f}: ${bad[0]}`);
    out.push(t);
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function templatePreview(t) {
  const pick = (slots) => slots.map((s) => ({ role: s.role, box: { ...s.box } }));
  return { id: t.id, label: t.label, description: t.description, needsScreen: t.needsScreen === true, preview: { h: pick(t.slots.h), v: pick(t.slots.v) } };
}

/** The reference-read shape for one canvas of a template (what buildPackage reads). */
export function templateRead(t, canvas, size = DEFAULT_SIZE[canvas], text = null) {
  return {
    schemaVersion: 1,
    tool: 'scene-builder/reference-read',
    reference: { name: t.id, kind: 'image', width: size.width, height: size.height, rotation: 0, durationS: null, frameTimesS: [0], analysisWidth: size.width, analysisHeight: size.height },
    canvas: canvas.toUpperCase(),
    detector: { rulesVersion: t.version, model: null },
    style: { cornerRadius: { class: 'medium' }, glow: { used: false } },
    slots: t.slots[canvas].map((s) => ({
      role: s.role, box: { ...s.box }, confidence: 1, evidence: [`scenario template ${t.id}`], source: 'rules',
      ...(s.role === 'graphics' && (text ?? s.text) ? { text: String(text ?? s.text).slice(0, 80) } : {}),
    })),
    notes: [],
  };
}

export function buildScenario(t, project, { rules = loadBuildRules(), bind = {}, text = null, now = new Date() } = {}) {
  const bad = templateProblems(t);
  if (bad.length) throw new Error(`not a usable scene template: ${bad[0]}`);
  if (text !== null && (typeof text !== 'string' || !text.trim() || text.length > 80)) throw new Error('the message must be 1 to 80 characters');
  const sizes = Object.fromEntries(project.canvases.map((c) => [c.id, { width: c.width, height: c.height }]));
  const presets = [], placeholders = [], notCarried = [], warnings = new Set();
  const bindings = { links: {}, roles: {} };
  let first = null;
  for (const canvas of ['h', 'v']) {
    if (!sizes[canvas]) { warnings.add(`the project has no ${canvas.toUpperCase()} canvas; no ${canvas.toUpperCase()} scene is built`); continue; }
    // each canvas is built from its own read, so its boxes are the template's, never derived by the H <-> V rule;
    // only the preset of that canvas is kept (the other one the builder derives is dropped)
    const pkg = buildPackage(templateRead(t, canvas, sizes[canvas], text), project, { rules, bind, now });
    first ??= pkg;
    presets.push(pkg.presets.find((p) => p.params.canvas === canvas));
    placeholders.push(...pkg.placeholders.filter((p) => p.canvas === canvas));
    notCarried.push(...pkg.notCarried.filter((n) => n.canvas === canvas));
    Object.assign(bindings.links, pkg.bindings.links);
    Object.assign(bindings.roles, pkg.bindings.roles);
    for (const w of pkg.warnings) if (!/has no game slot/.test(w)) warnings.add(w);
  }
  if (!first) throw new Error('the project has no H or V canvas');
  const digest = createHash('sha256').update(JSON.stringify({ t, presets, bind, text })).digest('hex').slice(0, 10);
  const id = `sc-${t.id}-${digest}`;
  const name = t.sceneName;
  return {
    ...first,
    id,
    name,
    created: now.toISOString(),
    builder: { tool: 'scene-builder/scenario', version: first.builder.version, rulesVersion: rules.version, template: t.id, templateVersion: t.version },
    reference: { name: t.id, kind: 'image', canvas: 'H', width: DEFAULT_SIZE.h.width, height: DEFAULT_SIZE.h.height },
    bindings,
    presets: presets.map((p) => ({ ...p, id: `${id}-${p.params.canvas}`, name: `${name} (${p.params.canvas.toUpperCase()})`, params: { ...p.params, sceneName: name } })),
    placeholders,
    notCarried,
    warnings: [...warnings],
  };
}
