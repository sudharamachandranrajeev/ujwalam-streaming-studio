// SPDX-License-Identifier: GPL-3.0-or-later
// UI server routes for the scene builder in the studio (plan Q4 row G; SB1-SB3, D339/D341; flag scene-builder). The
// command line (services/scene-builder/cli.mjs) needs the studio closed to add a scene; these routes add it while the
// studio runs, the way "Duplicate scene" does: the new scene goes to the host first, then into the project file.
// Kept out of server.mjs; server.mjs calls handle() for these routes. Every route answers 404 scene-builder-off while
// the flag is off.
//
//   GET  /ui/api/scene-builder          { references: [{ rel, kind }], available }  pictures and videos of the stream
//                                       assets folder (the only files it reads: never a path the page made up)
//   POST /ui/api/scene-builder/build {file}  read the reference, build the scene package for this project, plan it:
//                                       { name, diff, words, notes } (dry run: nothing written; words = the plan in
//                                       plain words for the studio window). Kept as the one build to add.
//   POST /ui/api/scene-builder/apply {}     add the last built scene: planned again against the project as it is now,
//                                       one new scene (H + V), existing scenes, layers, devices and settings unchanged
//                                       (the import rule); { ok, scene: { id, name }, saved }.
// Both POSTs are refused while live (live-locked) or without the host (host-unavailable).

import path from 'node:path';
import { listAssets } from './assets.mjs';
import { loadProject, saveProject } from '../project/store.mjs';
import { planScenePackage } from '../project/scene-package.mjs';
import { readReference as realRead } from '../scene-builder/read.mjs';
import { buildPackage as realBuild } from '../scene-builder/build.mjs';

export const SCENE_BUILDER_FLAG = 'scene-builder';

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
 * read(file) and build(read, project) are test seams (default: readReference, buildPackage).
 */
export function createSceneBuilderRoutes(opts) {
  const { flags, host, json } = opts;
  const read = opts.read ?? ((file) => realRead(file));
  const build = opts.build ?? ((r, project) => realBuild(r, project));
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

  async function buildRoute(res, body) {
    if (!isPlain(body) || Object.keys(body).some((k) => k !== 'file') || typeof body.file !== 'string' || body.file.length > 260) return json(res, 400, { error: 'bad-params' });
    const hit = listAssets(opts.assetsDir).find((a) => a.rel === body.file);
    if (!hit) return json(res, 409, { error: 'unknown-reference' });
    if (busy) return json(res, 409, { error: 'busy' });
    if (!(await offAir(res))) return undefined;
    busy = true;
    const task = opts.tasks?.start({ title: 'Reading the reference for a new scene', kind: 'scene-builder' });
    try {
      const r = await read(path.join(opts.assetsDir, ...hit.rel.split('/')));
      task?.update?.({ note: 'Building the scene' });
      const project = currentProject();
      const pkg = build(r, project);
      const { diff } = planScenePackage(project, pkg, { flags: flagMap() });
      last = { pkg, name: diff.adds.scenes[0].name, rel: hit.rel };
      task?.done?.();
      return json(res, 200, { name: last.name, diff, words: planWords(diff), notes:Array.isArray(r?.notes) ? r.notes.slice(0, 8) : [] });
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
      try {
        for (const c of plan.project.canvases) await host.call('scenes.create', { scene: { id, canvas: c.id.toUpperCase(), name: scene.name } });
        for (const l of scene.layers) await host.call('layers.addFromProject', { project: plan.project, scene: id, layer: l.id }); // bottom first
      } catch (e) {
        return json(res, 502, { error: 'host-error', detail: String(e?.message ?? e?.code ?? 'error').slice(0, 160) });
      }
      let saved = true;
      try { saveProject(projectFile(), plan.project); } catch { saved = false; }
      opts.projectSync.reload?.();
      last = null;
      opts.afterEdit?.(id);
      return json(res, 200, { ok: true, scene: { id, name: scene.name }, layers: scene.layers.length, saved });
    } finally { busy = false; }
  }

  /** true when the route was one of these (and answered). */
  async function handle(method, route, body, res) {
    if (route !== '/ui/api/scene-builder' && !route.startsWith('/ui/api/scene-builder/')) return false;
    if (!on()) return json(res, 404, { error: `${SCENE_BUILDER_FLAG}-off` }), true;
    if (method === 'GET' && route === '/ui/api/scene-builder') {
      const available = typeof projectFile() === 'string';
      return json(res, 200, { available, references: available ? listAssets(opts.assetsDir) : [], built: last ? { name: last.name, file: last.rel } : null }), true;
    }
    if (method !== 'POST') return false;
    if (typeof projectFile() !== 'string') return json(res, 409, { error: 'no-project-file' }), true;
    if (route === '/ui/api/scene-builder/build') return await buildRoute(res, body), true;
    if (route === '/ui/api/scene-builder/apply') return await applyRoute(res, body), true;
    return json(res, 404, { error: 'not-found' }), true;
  }

  return { handle };
}
