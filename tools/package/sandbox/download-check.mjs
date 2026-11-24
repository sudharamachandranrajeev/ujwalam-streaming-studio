// SPDX-License-Identifier: GPL-3.0-or-later
// Runs INSIDE Windows Sandbox (tools/package/sandbox/in-sandbox.ps1) with the installed build's own Node.js
// (runtime\node\node.exe). Downloads one item from the installed build's data/downloads catalogue with the installed
// download manager (services/studio-ui/downloads.mjs, the code behind Settings > Downloads) from the real host into
// the installed data root, with one pause and resume part way (HTTP Range on the real server), then runs the
// before-first-use check. The host status is a stub that says off air: the Sandbox has no stream.
//   node download-check.mjs --install <version folder> --data <data root> --id <item id> [--timeout-s 900]
// Prints one JSON line { ok, id, bytes, seconds, pausedAt, states, ready, verified, error? }; exit 0 only when ok.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const out = { ok: false, id: args.id ?? null, states: [] };
const done = (code) => { console.log(JSON.stringify(out)); process.exit(code); };

try {
  if (!args.install || !args.data || !args.id) throw new Error('usage: --install <dir> --data <dir> --id <item>');
  const mod = await import(pathToFileURL(path.join(args.install, 'services', 'studio-ui', 'downloads.mjs')).href);
  const items = mod.loadItems(args.install);
  const it = items.find((x) => x.id === args.id);
  if (!it) throw new Error(`no item ${args.id} in ${args.install}\\data\\downloads`);
  out.bytes = mod.itemBytes(it);
  const dl = mod.createDownloads({
    json: () => {}, dataRoot: args.data, now: Date.now, items,
    log: (m) => out.states.push(`log: ${m}`),
    hostStatus: async () => ({ live: false, recording: false, outputs: [] }),
  });
  const state = () => dl.list().find((x) => x.id === args.id);
  const t0 = Date.now();
  const limit = Number(args['timeout-s'] ?? 900) * 1000;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let r = await dl.act(args.id, 'start');
  out.states.push(`start: ${r[0]} ${r[1].item?.state}`);
  // Pause once a quarter of the bytes are in (real Range resume), then resume.
  while (Date.now() - t0 < limit) {
    const s = state();
    if (s.state === 'ready' || s.state === 'failed') break;
    if (out.pausedAt !== undefined && (s.state === 'paused' || s.state === 'missing')) break; // stopped after the resume
    if (out.pausedAt === undefined && s.done >= out.bytes / 4) {
      out.pausedAt = s.done;
      r = await dl.act(args.id, 'pause');
      out.states.push(`pause: ${r[0]} ${r[1].item?.state} at ${s.done}`);
      await wait(2000);
      r = await dl.act(args.id, 'resume');
      out.states.push(`resume: ${r[0]} ${r[1].item?.state}`);
    }
    await wait(500);
  }
  await dl.promise(args.id)?.catch(() => {});
  const last = state();
  out.states.push(`end: ${last.state}${last.message ? ` (${last.message})` : ''}`);
  out.seconds = (Date.now() - t0) / 1000;
  out.ready = dl.ready(args.id);
  out.verified = await dl.verified(args.id);
  out.ok = out.ready && out.verified && out.pausedAt !== undefined;
  done(out.ok ? 0 : 1);
} catch (e) {
  out.error = e.message;
  done(1);
}
