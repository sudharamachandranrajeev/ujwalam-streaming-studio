// SPDX-License-Identifier: GPL-3.0-or-later
// Builds a new scene in the host from the project document (scene.duplicate, scene.realism, the scene builder).
//
// Bug 2026-11-26 (realism scenes gone after a restart): the host could create the scene and then refuse one layer
// (an overlay copy has no overlay URL until the next full project load), and the route returned before saving. The
// studio then showed a scene that was never in the project file. Now:
// - a layer the host lists as unavailable (-32004) is skipped and counted: it is in the saved file and shows after the
//   next start, when the launcher loads the whole project with every overlay URL;
// - any other refusal removes the half-built scene from the host again, so nothing shows that is not saved.

import { isHostError } from './backends.mjs';
import { overlayParams } from '../../app/host/lib/project.mjs';

export const HOST_UNAVAILABLE = -32004;
// The studio's host client (backends.mjs rpc) reports a host error code as the string `RPC_<code>`; app/host/lib/client.mjs
// keeps the number. Both mean the same refusal (bug 2026-11-26: only the number was checked, so alpha.48 still undid
// every realism scene that copies an overlay).
const isUnavailable = (e) => isHostError(e, HOST_UNAVAILABLE);

/** addLayerParams(host, { project, scene, layer }) -> the layers.addFromProject params plus browserUrls / relayScope, so a
 *  layer added live (an overlay copy) gets its page URL now, not after the next start. The ports come from the host's own
 *  overlay.status. When the overlay server is not running (or the call fails) the params go as they are: the host then
 *  lists an overlay layer as unavailable (-32004) and it shows after the next start. */
export async function addLayerParams(host, p) {
  return { ...p, ...(await overlayExtra(host, p.project)) };
}

/** overlayExtra(host, project) -> { browserUrls?, relayScope? } once per operation; {} (logged) when overlay.status fails.
 *  Loops that add several layers of one document call this once and spread it into every layers.addFromProject. */
export async function overlayExtra(host, project) {
  try { return await overlayParams(host, project); } catch (e) {
    console.log(`[studio] overlay URLs not sent with the layer add (shows after the next start): ${e?.message ?? e}`);
    return {};
  }
}

/** createSceneInHost(host, { project, scene, canvases }) -> { later: [layerId], notes: [string] }; throws the host's error after undoing. */
export async function createSceneInHost(host, { project, scene, canvases }) {
  let created = false;
  try {
    for (const canvas of canvases) {
      await host.call('scenes.create', { scene: { id: scene.id, canvas, name: scene.name } });
      created = true;
    }
    const later = [];
    const notes = [];
    const extra = await overlayExtra(host, project); // one overlay.status per scene
    for (const l of scene.layers) { // bottom first
      try {
        const a = await host.call('layers.addFromProject', { project, scene: scene.id, layer: l.id, ...extra });
        if (typeof a?.note === 'string' && !notes.includes(a.note)) notes.push(a.note.slice(0, 200));
      } catch (e) {
        if (!isUnavailable(e)) throw e;
        later.push(l.id);
      }
    }
    return { later, notes };
  } catch (e) {
    if (created) { try { await host.call('scenes.remove', { scene: scene.id }); } catch { /* the error below is what the user sees */ } }
    throw e;
  }
}
