// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T2: the AI post text checker (pure): schema, platform limits, privacy (placeholder terms only), facts, kept lines.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkAiText, findTerm, keepsParts, killClaims, resultClass, termsOfProfile } from '../services/posting/ai-text-check.mjs';
import { loadLimits } from '../services/posting/index.mjs';
import { loadAiTextConfig, loadProfileTerms } from '../services/posting/ai-text.mjs';

const cfg = loadAiTextConfig();
const limits = loadLimits().targets['youtube-shorts'];
const good = () => ({
  title: 'Insane clutch with the last bullet',
  description: 'Everything goes wrong, then everything goes right.\nWatch the finish.',
  tags: ['cod mobile', 'clutch', 'highlights', 'gaming', 'shooter'],
  thumbHook: 'LAST BULLET',
  thumbTime: 4.5,
  factsSeen: { kills: null, result: null, mode: null, medal: null },
});
const run = (answer, extra = {}) => checkAiText({ answer, facts: {}, seconds: 12, limits, cfg, profileTerms: [], ...extra });
const withAns = (o) => ({ ...good(), ...o });
const reject = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); };

test('a good answer passes and keeps the shape', () => {
  const r = run(good());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.factsSource, null);
  assert.equal(r.text.tags.length, 5);
});

test('schema: not an object, missing or wrong-typed fields, factsSeen types', () => {
  reject(run(null), 'schema');
  reject(run('x'), 'schema');
  for (const k of ['title', 'description', 'tags', 'thumbHook', 'thumbTime', 'factsSeen']) { const a = good(); delete a[k]; reject(run(a), 'schema'); }
  reject(run(withAns({ title: 5 })), 'schema');
  reject(run(withAns({ tags: 'a,b' })), 'schema');
  reject(run(withAns({ thumbTime: 'soon' })), 'schema');
  reject(run(withAns({ factsSeen: { kills: 'three', result: null, mode: null, medal: null } })), 'schema');
  reject(run(withAns({ factsSeen: { kills: 3.5, result: null, mode: null, medal: null } })), 'schema');
});

test('shape: description 2-4 lines, 5-12 tags, hook 2-4 words, thumbTime inside the clip', () => {
  assert.equal(run(withAns({ description: 'one line only' })).ok, true); // 1 line is enough (minLines 1)
  // extra lines beyond the maximum are dropped, not rejected
  const trimmed = run(withAns({ description: 'a\nb\nc\nd\ne' }));
  assert.equal(trimmed.ok, true, JSON.stringify(trimmed));
  assert.equal(trimmed.text.description.split('\n').length, 4);
  reject(run(withAns({ tags: ['a', 'b', 'c'] })), 'tags');
  reject(run(withAns({ tags: Array.from({ length: 13 }, (_, i) => `tag${String.fromCharCode(97 + i)}`) })), 'tags');
  reject(run(withAns({ tags: ['a'.repeat(31), 'b', 'c', 'd', 'e'] })), 'tags');
  reject(run(withAns({ thumbHook: 'WOW' })), 'hook');
  reject(run(withAns({ thumbHook: 'ONE TWO THREE FOUR FIVE' })), 'hook');
  reject(run(withAns({ thumbTime: 99 })), 'thumb-time');
  reject(run(withAns({ thumbTime: -1 })), 'thumb-time');
});

test('platform limits come from limits.json: title chars, description bytes, tags total, forbidden < >', () => {
  const max = limits.fields.title.max;
  reject(run(withAns({ title: 'x'.repeat(max + 1) })), 'length');
  assert.equal(run(withAns({ title: 'x'.repeat(max) })).ok, true);
  const dmax = limits.fields.description.max;
  assert.equal(limits.fields.description.unit, 'utf8-bytes');
  const small = { ...limits, fields: { ...limits.fields, description: { ...limits.fields.description, max: 20 } } };
  reject(checkAiText({ answer: good(), facts: {}, seconds: 12, limits: small, cfg }), 'length');
  assert.ok(dmax > 20);
  const tags = { ...limits, fields: { ...limits.fields, tags: { ...limits.fields.tags, max: 10 } } };
  reject(checkAiText({ answer: good(), facts: {}, seconds: 12, limits: tags, cfg }), 'length');
  reject(run(withAns({ title: 'Big <b>play</b>' })), 'markup');
  reject(run(withAns({ description: 'a > b\nsecond line' })), 'markup');
  reject(run(withAns({ title: 'bad\u0007title' })), 'control');
  reject(run(withAns({ title: 'zero\u200bwidth' })), 'control');
});

test('hashtags, mentions, curly braces other than {handles.x} / {links.x}, web addresses', () => {
  reject(run(withAns({ title: 'Big play #shorts' })), 'hashtag');
  reject(run(withAns({ tags: ['#gaming', 'b', 'c', 'd', 'e'] })), 'hashtag');
  reject(run(withAns({ description: 'thanks @someone\nsecond line' })), 'mention');
  reject(run(withAns({ title: 'Clip {n} today' })), 'placeholder');
  reject(run(withAns({ title: '{profile.name} plays' })), 'placeholder');
  assert.equal(run(withAns({ description: 'Live on {handles.youtube}\nCommunity: {links.discord}' })).ok, true);
  reject(run(withAns({ description: 'see https://example.org/x\nsecond line' })), 'url');
  reject(run(withAns({ description: 'visit example.com\nsecond line' })), 'url');
  reject(run(withAns({ description: 'go to www.example\nsecond line' })), 'url');
});

test('privacy: profile terms, in any separator or case form, are rejected; placeholders pass; chat terms too', () => {
  const profile = { streamer: { name: 'Alex Example', brand: 'ExampleBrand', variants: ['Ex-Brand', 'ex_brand'] }, channels: { youtube_handle: '@examplechan', twitch: 'examplechan_tv' },
    games: { codm: { ign: 'ExampleIGN', variants: ['Ex1gn'], clan_tag: 'XMP' } }, paths: { clips_corpus: 'C:\\secret\\place' }, private_terms: [] };
  const terms = termsOfProfile(profile);
  assert.ok(terms.includes('ExampleBrand') && terms.includes('examplechan') && terms.includes('XMP'));
  assert.ok(!terms.some((t) => /secret/.test(t)), 'paths are not terms');
  reject(run(withAns({ title: 'Example Brand takes the win' }), { profileTerms: terms }), 'privacy');
  reject(run(withAns({ title: 'ex-brand again' }), { profileTerms: terms }), 'privacy');
  reject(run(withAns({ description: 'EXAMPLE_IGN is back\nsecond line' }), { profileTerms: terms }), 'privacy');
  reject(run(withAns({ tags: ['examplechan', 'b', 'c', 'd', 'e'] }), { profileTerms: terms }), 'privacy');
  reject(run(withAns({ title: 'Thanks viewer_one' }), { forbidTerms: ['viewer_one'] }), 'privacy');
  // a short term only as a whole word: "XMP" in "XMPLE" is not a hit, as a word it is
  assert.equal(findTerm('the xmple thing', ['XMP']), null);
  assert.equal(findTerm('the xmp thing', ['XMP']), 'XMP');
  // via the placeholders it passes
  const ok = run(withAns({ description: 'Live on {handles.youtube}\nCommunity: {links.discord}' }), { profileTerms: terms });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // nothing in data/ carries real terms: the real profile loads to a list (empty when missing) and a normal text passes
  assert.ok(Array.isArray(loadProfileTerms('definitely/missing.json')));
  assert.equal(run(good(), { profileTerms: loadProfileTerms() }).ok, true);
});

test('facts: kill counts must equal the detector facts', () => {
  const facts = { kills: '3', killsText: '3 KILLS', result: 'VICTORY' };
  assert.equal(run(withAns({ title: '3 kills in a flash' }), { facts }).ok, true);
  assert.equal(run(withAns({ title: 'Three kills in a row' }), { facts }).ok, true);
  assert.equal(run(withAns({ title: 'a 3-kill streak' }), { facts }).factsSource, 'detector');
  reject(run(withAns({ title: '5 kills in a flash' }), { facts }), 'fact-kills');
  reject(run(withAns({ title: 'Five kills in a row' }), { facts }), 'fact-kills');
  reject(run(withAns({ title: '7x kill streak' }), { facts }), 'fact-kills');
  // the model's own count does not override the detector's
  reject(run(withAns({ title: '5 kills', factsSeen: { kills: 5, result: null, mode: null, medal: null } }), { facts }), 'fact-kills');
  assert.deepEqual(killClaims('4 kills, five-kill, 12 frags, nothing about 9 pm'), [4, 12, 5]);
});

test('facts: no detector kills -> any kill claim is fact-unverified, whatever factsSeen says', () => {
  const seen = (kills) => ({ kills, result: null, mode: null, medal: null });
  for (const k of [4, null, 3]) reject(run(withAns({ title: '4 kills and a clean finish', factsSeen: seen(k) })), 'fact-unverified');
  assert.equal(run(withAns({ title: 'A clean finish', factsSeen: seen(4) })).factsSource, null);
});

test('facts: multi-kill words count as kill claims', () => {
  assert.deepEqual(killClaims('a double kill, triple-kill, quad kills, penta kill, quadruple kill'), [2, 3, 4, 5, 4]);
  reject(run(withAns({ title: 'Triple kill madness' })), 'fact-unverified');
  const facts = { kills: '3', killsText: '3 KILLS' };
  assert.equal(run(withAns({ title: 'Triple kill madness' }), { facts }).factsSource, 'detector');
  reject(run(withAns({ title: 'Penta kill madness' }), { facts }), 'fact-kills');
});

test('facts: result claims must match the detector result; none = fact-unverified, factsSeen never accepts', () => {
  const v = { result: 'VICTORY' };
  assert.equal(run(withAns({ title: 'The victory we needed' }), { facts: v }).factsSource, 'detector');
  reject(run(withAns({ title: 'A painful defeat' }), { facts: v }), 'fact-result');
  reject(run(withAns({ title: 'Win and loss in one match' }), { facts: v }), 'fact-result');
  reject(run(withAns({ title: 'We won it' })), 'fact-unverified'); // no facts at all
  const seen = { kills: null, result: 'victory', mode: null, medal: null };
  reject(run(withAns({ title: 'We won it', factsSeen: seen })), 'fact-unverified');
  reject(run(withAns({ title: 'We lost it', factsSeen: seen })), 'fact-unverified');
  // detector result that is not a win/loss word: no claim can be checked
  reject(run(withAns({ title: 'The win' }), { facts: { result: 'RANK 3' } }), 'fact-result');
  assert.equal(resultClass('DEFEAT'), 'loss'); assert.equal(resultClass('MATCH WON'), 'win'); assert.equal(resultClass('RANK 3'), null);
});

test('screen names: a word on screen and not in the vocab rejects; vocab words and absent words pass', () => {
  const vocab = new Set(['clutch', 'finish']);
  const ans = withAns({ title: 'Clutch finish by zorblax' });
  reject(run(ans, { screenWords: new Set(['zorblax']), vocab }), 'screen-name');
  reject(run(ans, { screenWords: new Set(['zorblax']) }), 'screen-name'); // no vocab = nothing allowed
  assert.equal(run(ans, { screenWords: new Set(['clutch', 'finish']), vocab }).ok, true); // on screen but allowed
  assert.equal(run(ans, { screenWords: new Set(['other']), vocab }).ok, true); // not on screen
  assert.equal(run(ans, { screenWords: new Set(), vocab }).ok, true);
  assert.equal(run(ans).ok, true); // screenWords undefined = not checked (pure tests)
  reject(run(withAns({ description: 'Watch ZORBLAX go\nsecond line' }), { screenWords: new Set(['zorblax']), vocab }), 'screen-name');
});

test('screen names: a name made of common words is caught in its joined form, written with or without a space', () => {
  // OCR of "Clutch_Finish" gives clutch, finish and the joined clutchfinish (services/clip/ocr_words.py)
  const vocab = new Set(['clutch', 'finish', 'what']);
  const screenWords = new Set(['clutch', 'finish', 'clutchfinish']);
  reject(run(withAns({ title: 'What a ClutchFinish' }), { screenWords, vocab }), 'screen-name');
  reject(run(withAns({ title: 'What a Clutch Finish' }), { screenWords, vocab }), 'screen-name');
  assert.equal(run(withAns({ title: 'What a finish' }), { screenWords, vocab }).ok, true);
  // a name in another script is a word too
  reject(run(withAns({ title: 'Clutch by ശക്തൻ' }), { screenWords: new Set(['ശക്തൻ']), vocab }), 'screen-name');
});

test('facts: no invented numbers (years, ranks, other counts); the fact itself may repeat', () => {
  reject(run(withAns({ description: 'Best clip of 2026\nsecond line' })), 'fact-number');
  reject(run(withAns({ title: 'Top 10 plays' })), 'fact-number');
  const facts = { kills: '3', killsText: '3 KILLS' };
  // rule 2: any other digit in title/description is rejected, even a fact number
  reject(run(withAns({ title: '3 kills', description: '3 in a row\nsecond line' }), { facts }), 'fact-number');
  reject(run(withAns({ title: '3 kills', description: '4 in a row\nsecond line' }), { facts }), 'fact-number');
});

test('numbers rule 1: claim-context numbers (rank, place, top, N/M, xN, win) must be a fact number', () => {
  const facts = { kills: '3', placement: 1, teams: 12 };
  reject(run(withAns({ title: 'Rank 7 reached' }), { facts }), 'fact-number');
  reject(run(withAns({ title: 'Top 5 finish' }), { facts }), 'fact-number');
  reject(run(withAns({ description: '2nd place again\nsecond line' }), { facts }), 'fact-number');
  reject(run(withAns({ description: 'Squad 9/12 alive\nsecond line' }), { facts }), 'fact-number');
  reject(run(withAns({ title: 'x4 multiplier' }), { facts }), 'fact-number');
  assert.equal(run(withAns({ title: 'Top 3 finish' }), { facts }).ok, true);
  assert.equal(run(withAns({ description: '1st place, nobody close\nsecond line' }), { facts }).ok, true);
  assert.equal(run(withAns({ title: 'Rank 1 reached' }), { facts }).ok, true);
  // no fact numbers at all: the model's own numbers never count
  reject(run(withAns({ title: 'Top 3 finish' })), 'fact-number');
});

test('numbers rule 3: a tag with a non-fact number is dropped alone; the post stays and tagsDropped counts them', () => {
  const r = run(withAns({ tags: ['codm2026', 'clutch', 'top10', 'highlights', 'gaming', 'shooter', 'fps'] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.tagsDropped, 2);
  assert.deepEqual(r.text.tags, ['clutch', 'highlights', 'gaming', 'shooter', 'fps']);
  // a tag whose number is a fact stays
  const k = run(withAns({ tags: ['3kills', 'clutch', 'highlights', 'gaming', 'shooter', 'fps'] }), { facts: { kills: '3' } });
  assert.equal(k.tagsDropped, 0); assert.ok(k.text.tags.includes('3kills'));
  assert.equal(run(good()).tagsDropped, 0);
});

test('credit and link lines the template adds must survive', () => {
  const credit = 'Music: Artist - Title\nhttps://example.org/track';
  assert.equal(keepsParts(`AI line\nsecond\n\nLive on x\n\n${credit}`, ['Live on x', credit]), null);
  assert.equal(keepsParts('AI line\nsecond', ['Live on x']), 'Live on x');
  assert.equal(keepsParts('AI line\nsecond\n\nLive on x', ['Live on x', credit]), credit);
  assert.equal(keepsParts('anything', [null, '', '  ']), null);
});

test('the checked config file is the one the prompt uses (versioned, placeholders known)', () => {
  const j = JSON.parse(readFileSync(new URL('../data/posting/ai-text.json', import.meta.url), 'utf8'));
  assert.match(j.version, /^\d+\.\d+\.\d+$/);
  const names = new Set([...j.prompt.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  for (const n of names) assert.ok(['language', 'tone', 'kind', 'seconds', 'facts', 'transcript', 'tagMin', 'tagMax', 'descMin', 'descMax', 'hookMin', 'hookMax'].includes(n), n);
  assert.doesNotMatch(JSON.stringify(j), /handles\./);
});
