// SPDX-License-Identifier: GPL-3.0-or-later
// UI server routes for devices that arrive after the start (user bug report 2026-11-18: "if a layer is not detected at
// start it fails to detect afterwards").
//
//   connectable()  -> [{ role, layers: [layer id] }]   preset capture placeholders (rebind-roles.mjs) whose device is
//                     listed now; ids only (the status snapshot carries no names). refresh() recomputes it: the server
//                     calls it when host.status devices.seq moves (a device plugged in or out) and once at the start.
//   POST /ui/api/devices/connect {role?}   one click (D332): those placeholders become the capture layers (in place, same
//                     ids and placements; nothing else changes). Allowed while live: a placeholder is transparent, and the
//                     host already binds capture layers to arriving devices while live (D329). Order as for structure edits
//                     (D240): pending edits written -> file read -> pure change -> host -> the same change on a fresh read
//                     saved (projectSync.update). A host failure puts the placeholders back and saves nothing; a failed
//                     save (or a project that changed meanwhile) puts them back too and says so (not-saved, changed, or
//                     not-saved-live when the host would not take them back).
//   POST /ui/api/devices/rescan {}         "Try again" (host devices.rescan): every capture layer without a picture is
//                     activated again at once, device sounds whose device is back are built, missing media files are
//                     looked for again. No project change.
// Device names and endpoint ids are never logged.

import { existsSync, readFileSync } from 'node:fs';
import { loadProject } from '../project/store.mjs';
import { loadDevicePresets, matchRoles } from '../project/device-roles.mjs';
import { placeholderRoles, rebindPlaceholders } from '../project/rebind-roles.mjs';
import { upgradePresets } from './alpha.mjs';

export const DEVICE_ROUTES = Object.freeze(['/ui/api/devices/connect', '/ui/api/devices/rescan']);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export const DEVICE_ERROR_TEXT = Object.freeze({
  'no-project-file': 'No project file is open, so nothing can be connected.',
  'project-unreadable': 'The project file could not be read.',
  'host-unavailable': 'The studio host is not reachable.',
  'devices-off': 'This start of Ujwalam has devices switched off.',
  'nothing-to-connect': 'No waiting layer has its device connected right now. Plug the device in, then try again.',
  'bad-params': 'That request was not understood.',
  busy: 'A device change is still on its way; try again in a moment.',
  invalid: 'The project would not be valid with that change.',
  changed: 'The project changed while connecting, so nothing was connected. Try again.',
  'not-saved': 'The project file could not be saved, so the change was undone. Nothing changed.',
  'not-saved-live': 'The project file could not be saved and the change could not be undone: it is live until Ujwalam restarts.',
});

/** opts: { host, json, projectSync, profileFile?, presetsDir, flags?, afterEdit?(), log? } */
export function createDeviceRoutes(opts) {
  const { host, json } = opts;
  const log = opts.log ?? (() => {});
  let busy = false;
  let state = { roles: [] };
  let refreshing = null;
  let again = false; // a refresh was asked for while one ran

  const presets = () => upgradePresets(opts.presetsDir);
  const flagState = () => {
    const f = opts.flags;
    if (!f || typeof f.ids !== 'function') return {};
    return Object.fromEntries(f.ids().map((id) => [id, f.isOn(id)]));
  };
  function readDoc() {
    const file = opts.projectSync?.status?.().file;
    if (typeof file !== 'string') return { error: 'no-project-file' };
    opts.projectSync.reload();
    try { return { file, doc: loadProject(file).project }; } catch { return { error: 'project-unreadable' }; }
  }
  // The roles' devices from a fresh list (never opened). null when the host lists none (started without devices).
  async function bindingsFor(roles) {
    let list;
    try { list = await host.call('devices.list', {}); } catch { return null; }
    let overrides = {};
    try { if (opts.profileFile && existsSync(opts.profileFile)) overrides = JSON.parse(readFileSync(opts.profileFile, 'utf8'))?.devices?.roles ?? {}; } catch { overrides = {}; }
    let devPresets = [];
    try { devPresets = opts.presetsDir && existsSync(opts.presetsDir) ? loadDevicePresets(opts.presetsDir) : []; } catch { devPresets = []; }
    return matchRoles({ list, presets: devPresets, overrides, roles });
  }

  async function compute() {
    const r = readDoc();
    if (r.error) return { roles: [] };
    const ph = placeholderRoles(r.doc, presets());
    if (!ph.length) return { roles: [] };
    const b = await bindingsFor(ph.map((x) => x.role));
    if (!b) return { roles: [] };
    return { roles: ph.filter((x) => b.bound[x.role]).map((x) => ({ role: x.role, layers: x.layers.map((l) => l.layer) })) };
  }

  async function connect(res, body) {
    if (!isPlain(body) || Object.keys(body).some((k) => k !== 'role') || (body.role !== undefined && !['game-capture', 'facecam'].includes(body.role))) return refuse(res, 'bad-params', 400);
    const r = readDoc();
    if (r.error) return refuse(res, r.error);
    const { file, doc } = r;
    const P = presets();
    const ph = placeholderRoles(doc, P).filter((x) => body.role === undefined || x.role === body.role);
    if (!ph.length) return refuse(res, 'nothing-to-connect');
    const bindings = await bindingsFor(ph.map((x) => x.role));
    if (!bindings) return refuse(res, 'devices-off');
    const x = rebindPlaceholders(doc, { presets: P, bindings, flags: flagState() });
    if (x.error) return refuse(res, x.error, 409, x.errors?.map((e) => `${e.path}: ${e.message}`).join('; ').slice(0, 300));
    if (x.unchanged) return refuse(res, 'nothing-to-connect');
    // Host: the placeholders go, the capture layers come in their place (the real layer before its copies), then the
    // project order. Any failure puts the old placeholders back from the unchanged document.
    const removed = [];
    const added = [];
    // Undo on the host: the new layers go, the placeholders come back from the unchanged document. true when every call
    // was taken.
    async function undoHost() {
      let ok = true;
      for (const a of [...added].reverse()) { try { await host.call('layers.remove', a); } catch { ok = false; } }
      for (const m of removed) { try { await host.call('layers.addFromProject', { project: doc, scene: m.scene, layer: m.layer }); } catch { ok = false; } }
      for (const scene of new Set(removed.map((m) => m.scene))) { try { await host.call('layers.orderFromProject', { project: doc, scene }); } catch { ok = false; } }
      return ok;
    }
    try {
      for (const rb of x.rebound) for (const lid of rb.layers) {
        const scene = doc.scenes.find((s) => s.layers.some((l) => l.id === lid)).id;
        await host.call('layers.remove', { scene, layer: lid });
        removed.push({ scene, layer: lid });
      }
      const order = (lid) => (x.rebound.some((rb) => rb.real === lid) ? 0 : 1);
      for (const { scene, layer } of [...removed].sort((a, b) => order(a.layer) - order(b.layer))) {
        await host.call('layers.addFromProject', { project: x.project, scene, layer });
        added.push({ scene, layer });
      }
      for (const scene of new Set(removed.map((m) => m.scene))) await host.call('layers.orderFromProject', { project: x.project, scene });
    } catch (e) {
      await undoHost();
      return json(res, 502, { error: 'host-error', detail: String(e?.message ?? e?.code ?? 'error').slice(0, 200) });
    }
    // The file: the same change made again on a fresh copy (Codex review 2026-11-18, P2), so a mixer or structure edit
    // saved while the host calls ran is kept. The fresh copy must rebind exactly the same layers, or the host and the file
    // would disagree: then the host change is undone.
    const same = (r) => r.rebound.length === x.rebound.length && r.rebound.every((a) => x.rebound.some((b) => b.role === a.role && b.real === a.real
      && b.device === a.device && b.layers.length === a.layers.length && a.layers.every((l) => b.layers.includes(l))));
    // the project devices the first change made, under the same ids (the host's new layers name them)
    const made = x.rebound.map((rb) => rb.device).filter((id) => !(doc.devices ?? []).some((d) => d.id === id));
    let k = 0;
    const idFn = (prefix) => made[k++] ?? `${prefix}-again-${k}`;
    const w = opts.projectSync.update((fresh) => {
      const r = rebindPlaceholders(fresh, { presets: P, bindings, flags: flagState(), idFn });
      if (r.error) return { error: 'changed' };
      if (r.unchanged || !same(r)) return { error: 'changed' };
      return r;
    });
    if (w.error) {
      const undone = await undoHost();
      opts.afterEdit?.();
      state = await compute().catch(() => ({ roles: [] }));
      return refuse(res, !undone ? 'not-saved-live' : w.error === 'changed' ? 'changed' : 'not-saved', w.error === 'changed' && undone ? 409 : 500);
    }
    log(`[studio-ui] devices: connected ${x.rebound.map((rb) => `${rb.role} (${rb.layers.length} layer(s))`).join(', ')}`);
    opts.afterEdit?.();
    state = await compute().catch(() => ({ roles: [] }));
    return json(res, 200, { ok: true, connected: x.rebound.map((rb) => ({ role: rb.role, layers: rb.layers })), saved: true });
  }

  async function rescan(res, body) {
    if (!isPlain(body) || Object.keys(body).length) return refuse(res, 'bad-params', 400);
    let out;
    try { out = await host.call('devices.rescan', {}); } catch (e) {
      const m = String(e?.message ?? '');
      if (/disabled|forbidden/i.test(m)) return refuse(res, 'devices-off');
      return json(res, 502, { error: 'host-error', detail: m.slice(0, 200) || 'error' });
    }
    opts.afterEdit?.();
    state = await compute().catch(() => ({ roles: [] }));
    return json(res, 200, { ok: true, retried: Number(out?.retried ?? 0), audio: Number(out?.audio ?? 0), media: Number(out?.media ?? 0), connectable: state.roles.map((x) => x.role) });
  }

  const refuse = (res, code, status = 409, detail) => json(res, status, { error: code, text: DEVICE_ERROR_TEXT[code] ?? code, ...(detail ? { detail } : {}) });

  return {
    connectable: () => state.roles,
    /** Recompute the connectable roles (a device came or went, or the start). One at a time; never throws. A call while
     *  one runs asks for one more pass after it (Codex review 2026-11-18, P3: a device that arrived mid-pass was missed
     *  until the next event); the promise settles when no pass is wanted any more. */
    refresh() {
      if (refreshing) { again = true; return refreshing; }
      const run = async () => {
        do {
          again = false;
          try { state = await compute(); } catch { /* keep the last state */ }
        } while (again);
      };
      refreshing = run().finally(() => { refreshing = null; });
      return refreshing;
    },
    async handle(method, route, body, res) {
      if (method !== 'POST' || !DEVICE_ROUTES.includes(route)) return false;
      if (busy) { refuse(res, 'busy'); return true; }
      busy = true;
      try { if (route === '/ui/api/devices/connect') await connect(res, body); else await rescan(res, body); } finally { busy = false; }
      return true;
    },
  };
}
