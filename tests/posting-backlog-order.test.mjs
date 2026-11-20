// SPDX-License-Identifier: GPL-3.0-or-later
// D403 backlog order: seeded shuffle, no two of the same kind back to back while another kind waits, split reels in
// part order on consecutive places, every date folder. Pure.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { backlogOrder, clipFacts } from '../services/posting/backlog-order.mjs';
import { planAuto } from '../services/posting/auto-post.mjs';

const KINDS = ['short', 'montage', 'won-reel', 'impact-play'];
let n = 0;
const post = (kind, day, label = `kills-${n}`, stamp = null) => {
  n++;
  const name = `codm_${kind}_${day.replace(/-/g, '')}-${stamp ?? `1${String(n % 100000).padStart(5, '0')}`}_${label}_01_v.mp4`;
  return { id: `id${n}.youtube-shorts`, kind, sourceName: name, target: 'youtube-shorts', status: 'draft', madeAt: `${day}T10:00:00`, score: null, limits: { ok: true }, unresolved: [] };
};

function backlog() {
  n = 0; const out = [];
  for (let d = 0; d < 65; d++) {
    const day = new Date(Date.UTC(2026, 8, 1 + d)).toISOString().slice(0, 10);
    for (let k = 0; k < 3; k++) out.push(post(KINDS[(d + k) % 4] === 'impact-play' && k ? 'short' : KINDS[(d * 3 + k) % 4], day));
  }
  // two split reels (3 parts and 2 parts)
  for (let p = 1; p <= 3; p++) out.push(post('montage', '2026-09-05', `kills-12-part-${p}-of-3`, '213000'));
  for (let p = 1; p <= 2; p++) out.push(post('won-reel', '2026-10-01', `victory-part-${p}-of-2`, '220000'));
  return [...out.slice(0, 193), ...out.slice(-5)]; // 198, both split reels included
}

describe('backlog order (D403)', () => {
  test('kind and parts come from the file name', () => {
    assert.deepEqual(clipFacts({ sourceName: 'codm_montage_20261109-100000_kills-12-part-2-of-3_01_v.mp4' }),
      { kind: 'montage', group: 'codm_montage_20261109-100000_kills-12_of-3_v', part: 2 });
    assert.deepEqual(clipFacts({ sourceName: 'codm_won-reel_20261109-100000_victory_01_v-full-crop.mp4' }), { kind: 'won-reel', group: null, part: null });
    assert.equal(clipFacts({ kind: 'short' }).kind, 'short');
  });

  test('198 clips over 65 days: every clip once, shuffled (days mixed), stable for a seed, no same kind back to back', () => {
    const posts = backlog();
    assert.equal(posts.length, 198);
    const a = backlogOrder(posts, { seed: 20261119 });
    assert.deepEqual(new Set(a.map((p) => p.id)), new Set(posts.map((p) => p.id)));
    assert.equal(a.length, posts.length);
    assert.deepEqual(backlogOrder([...posts].reverse(), { seed: 20261119 }).map((p) => p.id), a.map((p) => p.id), 'input order does not matter');
    assert.notDeepEqual(backlogOrder(posts, { seed: 1 }).map((p) => p.id), a.map((p) => p.id));
    // shuffled: the first 20 come from many different days
    assert.ok(new Set(a.slice(0, 20).map((p) => p.madeAt.slice(0, 10))).size >= 12);
    // kinds: a repeat only inside a split reel (or when one kind is all that is left)
    const facts = a.map(clipFacts);
    for (let k = 1; k < a.length; k++) {
      if (facts[k].kind !== facts[k - 1].kind) continue;
      const sameGroup = facts[k].group && facts[k].group === facts[k - 1].group;
      const onlyThisLeft = facts.slice(k).every((f) => f.kind === facts[k].kind);
      assert.ok(sameGroup || onlyThisLeft, `same kind back to back at ${k}`);
    }
  });

  test('split reels keep their part order on consecutive places, and a new clip does not move the others', () => {
    const posts = backlog();
    const a = backlogOrder(posts, { seed: 5 });
    for (const [label, parts] of [['kills-12', 3], ['victory', 2]]) {
      const at = a.map((p, k) => (p.sourceName.includes(`${label}-part-`) ? k : -1)).filter((k) => k >= 0);
      assert.equal(at.length, parts);
      assert.deepEqual(at, Array.from({ length: parts }, (_, k) => at[0] + k), 'consecutive');
      assert.deepEqual(at.map((k) => clipFacts(a[k]).part), Array.from({ length: parts }, (_, k) => k + 1), 'in part order');
    }
    const extra = post('short', '2026-11-19');
    const b = backlogOrder([...posts, extra], { seed: 5 }).filter((p) => p.id !== extra.id).map((p) => p.id);
    // the relative order of the others only changes where the kind rule had to step around the new clip
    let same = 0; for (let k = 0; k < b.length; k++) if (b[k] === a[k].id) same++;
    assert.ok(same >= b.length * 0.5, `${same} of ${b.length} kept their place`);
  });

  test('prevKind: the first clip differs from the one queued last', () => {
    const posts = backlog();
    for (const k of KINDS) assert.notEqual(clipFacts(backlogOrder(posts, { seed: 9, prevKind: k })[0]).kind, k);
  });

  test('planAuto takes the order (approvals follow it); without it oldest first as before', () => {
    const posts = backlog().slice(0, 30);
    const rules = [{ id: 'r', target: 'youtube-shorts', minScore: 0, kinds: KINDS, maxPerDay: 5 }];
    const order = (ps) => backlogOrder(ps, { seed: 3 });
    const plan = planAuto({ posts, rules, autoUpload: false, log: [], now: new Date('2026-11-20T10:00:00Z'), unscoredFloor: 3, order });
    const approved = plan.filter((p) => p.action === 'approve').map((p) => p.id);
    assert.deepEqual(approved, order(posts).map((p) => p.id).slice(0, 5));
    const old = planAuto({ posts, rules, autoUpload: false, log: [], now: new Date('2026-11-20T10:00:00Z'), unscoredFloor: 3 });
    assert.deepEqual(old.filter((p) => p.action === 'approve').map((p) => p.id), posts.slice(0, 5).map((p) => p.id));
  });
});
