// SPDX-License-Identifier: GPL-3.0-or-later
// D403 Backlog order (user 2026-11-19: "start by posting all the videos made so far in the clips. spread out randomly").
// With the random-daily placement the auto-post chain approves and queues clips in this order instead of oldest first:
//   - shuffled with the schedule's seed (each clip's place comes from hash(seed, clip id), so the order is the same on
//     every pass and a new clip slots in without moving the others);
//   - never two clips of the same kind back to back when another kind is waiting. The kind is the name part between the
//     game id and the time stamp (clip_names.py: <game>_<kind>_<stamp>_<label>_<nn>_<canvas>.mp4): short, montage,
//     won-reel, impact-play, long-highlights (D406);
//   - the parts of a split reel (label ends in -part-N-of-M) stay together, in part order, so they go out on
//     consecutive slots.
// Pure. Posts are store.list() views (id, kind, sourceName).
import { hash32 } from './schedule.mjs';

/** clip_names.py NAME_RE: game, kind, stamp, label, nn, canvas. */
const NAME = /^([a-z0-9-]+)_(short|montage|won-reel|impact-play|long-highlights)_(\d{8}-\d{6})_([a-z0-9-]+)_(\d{2,3})_(v|h|v-[a-z0-9-]+)\.mp4$/;
const PART = /^(.*)-part-(\d+)-of-(\d+)$/;

/** { kind, group, part } of a post: kind from its file name (else the post's own kind); group and part for a split reel. */
export function clipFacts(p) {
  const name = typeof p?.sourceName === 'string' ? p.sourceName.toLowerCase() : '';
  const m = NAME.exec(name);
  const kind = m ? m[2] : (typeof p?.kind === 'string' ? p.kind : 'short');
  const part = m ? PART.exec(m[4]) : null;
  if (!part) return { kind, group: null, part: null };
  return { kind, group: `${m[1]}_${m[2]}_${m[3]}_${part[1]}_of-${part[3]}_${m[6]}`, part: Number(part[2]) };
}

/** The posts in backlog order (rules above). prevKind: the kind of the clip queued last (so the first one differs). */
export function backlogOrder(posts, { seed = 0, prevKind = null } = {}) {
  const units = new Map();
  for (const p of posts ?? []) {
    const f = clipFacts(p);
    const key = f.group ? `g:${f.group}` : `p:${p.id}`;
    if (!units.has(key)) units.set(key, { key, kind: f.kind, rank: hash32(seed, key), posts: [] });
    units.get(key).posts.push({ p, part: f.part ?? 0 });
  }
  const rest = [...units.values()].sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : 1));
  for (const u of rest) u.posts.sort((a, b) => a.part - b.part || String(a.p.id).localeCompare(String(b.p.id)));
  const out = []; let last = prevKind;
  while (rest.length) {
    let k = rest.findIndex((u) => u.kind !== last);
    if (k < 0) k = 0; // only that kind is left
    const [u] = rest.splice(k, 1);
    for (const x of u.posts) out.push(x.p);
    last = u.kind;
  }
  return out;
}
