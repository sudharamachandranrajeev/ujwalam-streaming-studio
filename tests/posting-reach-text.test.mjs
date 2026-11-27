// SPDX-License-Identifier: GPL-3.0-or-later
// Reach text library: hook-first drafts, slots, hashtag core + rotation, limits, light AI adaptation. Placeholders only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadLibrary, keepsDraftTitle, reachDraft } from '../services/posting/reach-text.mjs';
import { draftBlock } from '../services/posting/ai-text.mjs';
import { aiPost, checkLimits, loadLimits, loadTemplates } from '../services/posting/index.mjs';

const lib = loadLibrary();
const game = { name: 'GAME NAME', short: 'GAME', modeNames: { mp: 'MODE' }, hashtags: { default: ['#Game1', '#Game2', '#Game3', '#Game4'] } };
const profile = { handles: { youtube: 'YT-HANDLE', twitch: 'TW-HANDLE' }, links: { discord: 'COMMUNITY-LINK' } };
const facts = { killsText: '9 KILLS', kills: '9', mode: 'mp' };
const base = { library: lib, target: 'youtube-shorts', kind: 'montage', facts, game, profile, seed: 's1' };

test('library: every platform kind has titles, captions and a core hashtag rule; no real names', () => {
  assert.ok(lib);
  for (const [pid, p] of Object.entries(lib.platforms)) {
    assert.ok(p.hashtags.recommendedMax <= 5, pid);
    for (const [kid, k] of Object.entries(p.kinds)) assert.ok(k.titles.length && k.captions.length, `${pid}/${kid}`);
  }
  assert.ok(Object.keys(lib.platforms['youtube-shorts'].kinds).length >= 8);
  assert.ok(!/@\w|discord\.gg|https?:/i.test(JSON.stringify(lib)));
});

test('draft: hook title, caption, CTA, live lines, 3-4 hashtags with the core ones first', () => {
  const d = reachDraft(base);
  assert.ok(d.title.length > 5 && !/\{/.test(d.title + d.description));
  assert.ok(d.description.includes('Live on YT-HANDLE') && d.description.includes('Community: COMMUNITY-LINK'));
  assert.deepEqual(d.hashtags.slice(0, 3), ['#Shorts', '#Game1', '#Montage']);
  assert.ok(d.hashtags.length >= 3 && d.hashtags.length <= 4);
  assert.deepEqual(reachDraft(base), d, 'same seed, same text');
});

test('slots: a line whose fact or profile value is missing is never used', () => {
  for (let i = 0; i < 30; i++) {
    const d = reachDraft({ ...base, kind: 'short', seed: `x${i}`, facts: { killsText: '3 KILLS', kills: '3' }, profile: {} });
    assert.ok(!/\{|undefined|weapon|map/.test(d.title + d.description), d.title);
    assert.ok(!d.description.includes('Live on YT'), 'no handle, no live line'); assert.ok(!d.description.includes('Community:'));
  }
  assert.equal(reachDraft({ ...base, game: null, kind: 'fail' }), null, 'no game: every fail line needs {game}');
  assert.equal(reachDraft({ ...base, target: 'x' }), null, 'x is planned, data only');
});

test('hashtags rotate: no repeat of the last picks while fresh ones exist; core always kept', () => {
  const seenPool = new Set(); let recent = [];
  for (let i = 0; i < 6; i++) {
    const d = reachDraft({ ...base, seed: `p${i}`, recent });
    assert.ok(d.hashtags.includes('#Shorts') && d.hashtags.includes('#Game1') && d.hashtags.includes('#Montage'));
    const pick = d.hashtags.filter((t) => !['#Shorts', '#Game1', '#Montage'].includes(t));
    assert.ok(pick.every((t) => !recent.slice(-4).includes(`h:${t.toLowerCase()}`)), `repeat in ${pick}`);
    pick.forEach((t) => seenPool.add(t));
    recent = [...recent, ...d.used];
  }
  assert.ok(seenPool.size >= 4, 'the pool rotates');
});

test('title limit and Instagram hashtag count', () => {
  const d = reachDraft({ ...base, titleMax: 36 });
  assert.ok(Array.from(d.title).length <= 36);
  assert.equal(reachDraft({ ...base, titleMax: 3 }), null);
  const ig = reachDraft({ ...base, target: 'instagram-reels' });
  assert.ok(ig.hashtags.length >= 3 && ig.hashtags.length <= 5);
});

test('the draft passes the platform limits', () => {
  const limits = loadLimits();
  for (const target of ['youtube-shorts', 'instagram-reels']) {
    for (const kind of ['short', 'montage', 'won-reel', 'impact-play']) {
      const d = reachDraft({ ...base, target, kind, facts: { ...facts, result: 'VICTORY' } });
      const post = { title: d.title, description: d.description, tags: ['a'], hashtags: d.hashtags, target };
      assert.equal(checkLimits(post, limits).ok, true, `${target}/${kind}`);
    }
  }
});

test('light AI adaptation: a rephrase that keeps the structure stays, a rewrite is replaced; tags and CTA kept', () => {
  const d = reachDraft(base);
  assert.equal(keepsDraftTitle(d.title, d.title), true);
  assert.equal(keepsDraftTitle('completely unrelated words here', d.title), false);
  assert.match(draftBlock({ title: d.title, lead: d.lead }), /Draft to adapt lightly/);
  assert.equal(draftBlock(null), '');
  const templates = loadTemplates(); const limits = loadLimits();
  const tpl = templates.targets['youtube-shorts'];
  const ai = { title: 'Totally different words about nothing', description: 'Short AI line here.', tags: ['codm', 'clip', 'fps', 'mobile', 'live'], thumbHook: 'WOW', thumbTime: 1, factsSeen: {} };
  const r = aiPost({ ai, tpl, ctx: { profile, n: 1, date: '2026-01-01' }, post: { hashtags: ['#old'], tags: [] }, music: { use: 'none' }, limits, target: 'youtube-shorts', titleMax: 100, kind: 'montage', seed: 's', prefs: null, game: null, mode: 'mp', templates, reach: d });
  assert.equal(r.post.title, d.title);
  assert.deepEqual(r.post.hashtags, d.hashtags);
  assert.ok(r.post.description.includes(d.cta) && r.post.description.includes('Live on YT-HANDLE') && r.post.description.startsWith('Short AI line here.'));
});
