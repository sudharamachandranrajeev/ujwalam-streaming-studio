// SPDX-License-Identifier: GPL-3.0-or-later
// UI server routes for the scene builder in the studio (plan Q4 row G; SB1-SB3, D339/D341; flag scene-builder). The
// command line (services/scene-builder/cli.mjs) needs the studio closed to add a scene; these routes add it while the
// studio runs, the way "Duplicate scene" does: the new scene goes to the host first, then into the project file.
// Kept out of server.mjs; server.mjs calls handle() for these routes. Every route answers 404 scene-builder-off while
// the flag is off.
//
//   GET  /ui/api/scene-builder          { references: [{ rel, kind }], available }  pictures and videos of the stream
//                                       assets folder (the only files it reads: never a path the page made up)
//                                       ai: { available, on, reason?, model } (D394 proposed, SB6): whether the local vision model
//                                       (LM Studio on this PC, D392) answers; `on` is the toggle's default (true when it answers)
//   POST /ui/api/scene-builder/build {file, ai?}  read the reference, build the scene package for this project, plan it:
//                                       { name, diff, words, notes, detector } (dry run: nothing written; words = the plan in
//                                       plain words for the studio window). Kept as the one build to add. ai true asks the
//                                       local vision model as well; never while recording (6 GB VRAM, D1/D392): the rules
//                                       result is built and detector.skipped says why. detector: { used: 'rules'|'model',
//                                       model, asked, skipped? }.
//   POST /ui/api/scene-builder/apply {}     add the last built scene: planned again against the project as it is now,
//                                       one new scene (H + V), existing scenes, layers, devices and settings unchanged
//                                       (the import rule); { ok, scene: { id, name }, saved }.
//
// Scenarios (D390; no flag: the picker needs none). Same build / apply machinery, a template instead of a picture:
//   GET  /ui/api/scene-templates            { templates: [{ id, label, description, needsScreen, preview: { h, v } }] }
//   GET  /ui/api/scene-templates/targets    { available, displays: [{ id, name, width, height }], windows: [{ id, title, exe }] }
//                                           read only, from the host (capture.listTargets); available false without it
//   POST /ui/api/scene-templates/build {template, text?, bind?: { screen: { kind: 'window'|'screen', target: <id> } }}
//                                           dry run as above; the target id is looked up in the host's list again (a
//                                           target the page made up is refused: unknown-target). bind only for a
//                                           template that needs a screen. text: the message of a holding screen.
//   POST /ui/api/scene-templates/apply {}   the same one-click apply as the builder's (one new H + V scene)
// Both POSTs are refused while live (live-locked) or without the host (host-unavailable).

import path from 'node:path';
import { listAssets } from './assets.mjs';
import { loadProject, saveProject } from '../project/store.mjs';
import { createSceneInHost } from './scene-layers.mjs';
import { planScenePackage } from '../project/scene-package.mjs';
import { readReference as realRead } from '../scene-builder/read.mjs';
import { buildPackage as realBuild } from '../scene-builder/build.mjs';
import { buildScenario as realScenario, listTemplates, templatePreview } from '../scene-builder/scenarios.mjs';
import { DEFAULT_VISION_MODEL, visionAdapter } from '../scene-builder/vision.mjs';
import { DEFAULT_AI_URL, localAiUrl } from '../common/local-ai.mjs';

export const SCENE_BUILDER_FLAG = 'scene-builder';
const TEMPLATES_ROUTE = '/ui/api/scene-templates';

/** The plan in plain words for the studio window (diffText is the command line's terse form). */
export function planWords(diff) {
  const s = diff.adds.scenes[0];
  const lines = [`Adds one new scene "${s.name}" (${s.canvases.map((c) => c.toUpperCase()).join(' and ')}, ${s.layers} layers). Your other scenes, layers, devices and settings stay as they are.`];
  for (const l of diff.adds.layers) {
    const what = l.placeholder ? `a placeholder to fill in (${l.placeholder})`
      : l.shows?.layer ? `shows your layer "${l.shows.name ?? l.shows.layer}"`
        : l.shows?.capture ? `shows ${l.shows.capture === 'window' ? 'the window' : 'the screen'} you picked`
        : l.shows?.device ? `uses your device ${l.shows.device}`
          : l.shows?.overlay ? `overlay ${l.shows.overlay}` : l.type;
    lines.push(`${l.canvas.toUpperCase()}: ${l.name ?? l.key}: ${what}`);
  }
  for (const p of diff.placeholders) lines.push(`To set up later: ${p.role}${p.canvas ? ` on ${p.canvas.toUpperCase()}` : ''} (${p.reason})`);
  for (const n of diff.notCarried) lines.push(`Not on ${n.canvas.toUpperCase()}: ${n.count} ${n.role} (${n.reason})`);
  for (const w of diff.warnings) lines.push(`Note: ${w}`);
  return lines;
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * opts: { flags, host, json, projectSync, assetsDir, tasks, afterEdit(sceneId), read?, build? }
 * read(file) and build(read, project) are test seams (default: readReference, buildPackage); templates() and
 * scenario(template, project, { bind, text }) likewise (default: listTemplates, buildScenario).
 */
export function createSceneBuilderRoutes(opts) {
  const { flags, host, json } = opts;
  const read = opts.read ?? ((file, o) => realRead(file, o));
  const build = opts.build ?? ((r, project) => realBuild(r, project));
  const templates = opts.templates ?? (() => listTemplates());
  const scenario = opts.scenario ?? ((t, project, o) => realScenario(t, project, o));
  const on = () => !!flags && flags.isOn(SCENE_BUILDER_FLAG);
  const flagMap = () => Object.fromEntries((flags?.list?.() ?? []).map((f) => [f.id, f.on === true]));
  const projectFile = () => opts.projectSync?.status?.().file;
  let last = null; // { pkg, name, rel }: the build the Add button adds
  let busy = false;

  async function offAir(res) {
    let hs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    if (!hs || hs.live !== false) { json(res, 409, { error: hs ? 'live-locked' : 'host-unavailable' }); return false; }
    return true;
  }
  function currentProject() {
    opts.projectSync.flush?.();
    return loadProject(projectFile()).project;
  }

  // D394 (proposed, SB6): does the local vision model answer? GET /v1/models only lists the models; it loads nothing.
  // Never while live or recording (6 GB VRAM, D1/D392). Every answer carries a plain reason when it is not available.
  async function aiStatus(hs) {
    const out = (available, reason) => ({ available, on: available, model: DEFAULT_VISION_MODEL, ...(reason ? { reason } : {}) });
    if (hs?.live === true) return out(false, 'The AI read is off while you are live: the graphics card is needed for the stream.');
    if (hs?.recording === true) return out(false, 'The AI read is off while you are recording: the graphics card is needed for the recording.');
    const href = localAiUrl(DEFAULT_AI_URL);
    if (!href) return out(false, 'No local AI address is set.');
    try {
      const r = await (opts.aiFetch ?? globalThis.fetch)(new URL('/v1/models', href), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(1500) });
      if (r.status !== 200) { try { await r.text(); } catch { /* not used */ } return out(false, 'LM Studio did not give a list of models. Start its local server, then look again.'); }
      const list = (await r.json())?.data;
      if (Array.isArray(list) && list.length > 0 && !list.some((m) => m?.id === DEFAULT_VISION_MODEL)) return out(false, `LM Studio answers, but the picture model ${DEFAULT_VISION_MODEL} is not installed in it.`);
      return out(true);
    } catch { return out(false, 'LM Studio is not answering on this PC (127.0.0.1:1234). Start it and switch on its local server to use the AI read.'); }
  }
  async function status() {
    let hs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    return aiStatus(hs);
  }

  async function buildRoute(res, body) {
    if (!isPlain(body) || Object.keys(body).some((k) => !['file', 'ai'].includes(k)) || typeof body.file !== 'string' || body.file.length > 260 || (body.ai !== undefined && typeof body.ai !== 'boolean')) return json(res, 400, { error: 'bad-params' });
    const hit = listAssets(opts.assetsDir).find((a) => a.rel === body.file);
    if (!hit) return json(res, 409, { error: 'unknown-reference' });
    if (busy) return json(res, 409, { error: 'busy' });
    let hs = null;
    try { hs = await host.call('host.status', {}); } catch { hs = null; }
    if (!hs || hs.live !== false) return json(res, 409, { error: hs ? 'live-locked' : 'host-unavailable' });
    // The AI read is asked for only when the page says so AND the card is free; otherwise the rules result is built and says why.
    let model = null, skipped = null;
    if (body.ai === true) {
      const st = await aiStatus(hs);
      if (!st.available) skipped = st.reason;
      else { try { model = visionAdapter({ ...(opts.aiFetch ? { fetch: opts.aiFetch } : {}) }); } catch { skipped = 'The local AI address is not on this PC.'; } }
    }
    busy = true;
    const task = opts.tasks?.start({ title: 'Reading the reference for a new scene', kind: 'scene-builder' });
    try {
      const r = await read(path.join(opts.assetsDir, ...hit.rel.split('/')), model ? { model } : {});
      task?.update?.({ note: 'Building the scene' });
      const project = currentProject();
      const pkg = build(r, project);
      const { diff } = planScenePackage(project, pkg, { flags: flagMap() });
      last = { pkg, name: diff.adds.scenes[0].name, rel: hit.rel };
      task?.done?.();
      const used = typeof r?.detector?.model === 'string' && r.detector.model ? 'model' : 'rules';
      return json(res, 200, { name: last.name, diff, words: planWords(diff), notes: Array.isArray(r?.notes) ? r.notes.slice(0, 8) : [],
        detector: { used, model: used === 'model' ? r.detector.model : null, asked: body.ai === true, ...(skipped ? { skipped } : {}) } });
    } catch (e) {
      task?.fail?.('Could not build a scene from it');
      return json(res, 422, { error: 'build-failed', detail: String(e?.message ?? 'error').slice(0, 200) });
    } finally { busy = false; }
  }

  async function applyRoute(res, body) {
    if (!isPlain(body) || Object.keys(body).length) return json(res, 400, { error: 'bad-params' });
    if (!last) return json(res, 409, { error: 'nothing-built' });
    if (busy) return json(res, 409, { error: 'busy' });
    if (!(await offAir(res))) return undefined;
    busy = true;
    try {
      opts.projectSync.reload?.();
      let doc;
      try { doc = loadProject(projectFile()).project; } catch { return json(res, 409, { error: 'project-unreadable' }); }
      let plan;
      try { plan = planScenePackage(doc, last.pkg, { flags: flagMap() }); } catch (e) { return json(res, 409, { error: 'plan-failed', detail: String(e?.message ?? 'error').slice(0, 200) }); }
      const id = plan.diff.adds.scenes[0].id;
      const scene = plan.project.scenes.find((s) => s.id === id);
      let later = [];
      try {
        // a layer the host cannot show yet is saved and shows after the next start; any other refusal undoes the scene
        later = (await createSceneInHost(host, { project: plan.project, scene, canvases: plan.project.canvases.map((c) => c.id.toUpperCase()) })).later;
      } catch (e) {
        return json(res, 502, { error: 'host-error', detail: String(e?.message ?? e?.code ?? 'error').slice(0, 160) });
      }
      let saved = true;
      try { saveProject(projectFile(), plan.project); } catch { saved = false; }
      opts.projectSync.reload?.();
      last = null;
      opts.afterEdit?.(id);
      return json(res, 200, { ok: true, scene: { id, name: scene.name }, layers: scene.layers.length, ...(later.length ? { later: later.length } : {}), saved });
    } finally { busy = false; }
  }

  // ---- scenarios ----
  const short = (v, n) => String(v ?? '').slice(0, n);
  async function targets() {
    try {
      const r = await host.call('capture.listTargets', {});
      const displays = (Array.isArray(r?.displays) ? r.displays : []).filter((d) => d && typeof d.id === 'string' && d.id).slice(0, 16)
        .map((d) => ({ id: short(d.id, 128), name: short(d.name || d.id, 120), width: Number.isInteger(d.width) ? d.width : null, height: Number.isInteger(d.height) ? d.height : null }));
      const windows = (Array.isArray(r?.windows) ? r.windows : []).filter((w) => w && typeof w.id === 'string' && w.id).slice(0, 200)
        .map((w) => ({ id: short(w.id, 512), title: short(w.title, 160), exe: short(w.exe, 120) }));
      return { available: true, displays, windows };
    } catch { return { available: false, displays: [], windows: [] }; }
  }
  async function scenarioBuild(res, body) {
    const okBind = (b) => isPlain(b) && Object.keys(b).length === 1 && isPlain(b.screen) && Object.keys(b.screen).sort().join() === 'kind,target'
      && ['window', 'screen'].includes(b.screen.kind) && typeof b.screen.target === 'string' && b.screen.target.length > 0 && b.screen.target.length <= 512;
    if (!isPlain(body) || Object.keys(body).some((k) => !['template', 'text', 'bind'].includes(k)) || typeof body.template !== 'string'
      || (body.text !== undefined && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 80)) || (body.bind !== undefined && !okBind(body.bind))) return json(res, 400, { error: 'bad-params' });
    const t = templates().find((x) => x.id === body.template);
    if (!t) return json(res, 409, { error: 'unknown-template' });
    if (body.bind && t.needsScreen !== true) return json(res, 400, { error: 'bad-params' });
    if (busy) return json(res, 409, { error: 'busy' });
    if (!(await offAir(res))) return undefined;
    busy = true;
    try {
      const o = {};
      if (body.text !== undefined) o.text = body.text;
      if (body.bind) {
        const list = await targets();
        const { kind, target } = body.bind.screen;
        if (kind === 'window') {
          const w = list.windows.find((x) => x.id === target);
          if (!w) return json(res, 409, { error: 'unknown-target' });
          o.bind = { screen: { create: { type: 'window', source: { window: w.id, match: 'title', cursor: true } } } };
        } else {
          const d = list.displays.find((x) => x.id === target);
          if (!d) return json(res, 409, { error: 'unknown-target' });
          o.bind = { screen: { create: { type: 'screen', source: { display: d.id, cursor: true }, ...(d.width && d.height ? { content: { width: d.width, height: d.height } } : {}) } } };
        }
      }
      const project = currentProject();
      const pkg = scenario(t, project, o);
      const { diff } = planScenePackage(project, pkg, { flags: flagMap() });
      last = { pkg, name: diff.adds.scenes[0].name, rel: `scenario:${t.id}` };
      return json(res, 200, { name: last.name, template: t.id, diff, words: planWords(diff), notes: [] });
    } catch (e) {
      return json(res, 422, { error: 'build-failed', detail: String(e?.message ?? 'error').slice(0, 200) });
    } finally { busy = false; }
  }
  async function scenarioHandle(method, route, body, res) {
    if (method === 'GET' && route === TEMPLATES_ROUTE) {
      try { return json(res, 200, { templates: templates().map(templatePreview) }); } catch { return json(res, 500, { error: 'templates-unreadable' }); }
    }
    if (method === 'GET' && route === `${TEMPLATES_ROUTE}/targets`) return json(res, 200, await targets());
    if (method !== 'POST') return json(res, 404, { error: 'not-found' });
    if (typeof projectFile() !== 'string') return json(res, 409, { error: 'no-project-file' });
    if (route === `${TEMPLATES_ROUTE}/build`) return scenarioBuild(res, body);
    if (route === `${TEMPLATES_ROUTE}/apply`) return applyRoute(res, body);
    return json(res, 404, { error: 'not-found' });
  }

  /** true when the route was one of these (and answered). */
  async function handle(method, route, body, res) {
    if (route === TEMPLATES_ROUTE || route.startsWith(`${TEMPLATES_ROUTE}/`)) return await scenarioHandle(method, route, body, res), true;
    if (route !== '/ui/api/scene-builder' && !route.startsWith('/ui/api/scene-builder/')) return false;
    if (!on()) return json(res, 404, { error: `${SCENE_BUILDER_FLAG}-off` }), true;
    if (method === 'GET' && route === '/ui/api/scene-builder') {
      const available = typeof projectFile() === 'string';
      return json(res, 200, { available, references: available ? listAssets(opts.assetsDir) : [], built: last ? { name: last.name, file: last.rel } : null, ai: await status() }), true;
    }
    if (method !== 'POST') return false;
    if (typeof projectFile() !== 'string') return json(res, 409, { error: 'no-project-file' }), true;
    if (route === '/ui/api/scene-builder/build') return await buildRoute(res, body), true;
    if (route === '/ui/api/scene-builder/apply') return await applyRoute(res, body), true;
    return json(res, 404, { error: 'not-found' }), true;
  }

  return { handle };
}
