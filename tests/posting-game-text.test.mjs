// SPDX-License-Identifier: GPL-3.0-or-later
// The game in every AI post (user, 2026-11-25): game data, the title rule, tags, hashtags, the template's opening line.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { dropTemplateLead, gameHashtags, gameLines, gamePost, gameTags, gameTitle, gameTitleTags, postGames, resolveGame } from '../services/posting/game-text.mjs';
import { loadTemplates } from '../services/posting/index.mjs';

const tmp = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const templates = loadTemplates();

test('the committed game data: name, short name, tags per target, hashtags per target', () => {
  const g = gamePost('codm');
  assert.ok(g, 'data/games/codm/posting.json has a post block');
  assert.equal(g.short, 'CODM');
  const shortsTags = ['#CODM', '#CallOfDutyMobile', '#CODMShorts', '#CODMHighlights', '#MobileGaming', '#MobileFPS', '#GamingShorts'];
  assert.deepEqual(gameHashtags(g, 'youtube-shorts'), shortsTags);
  assert.deepEqual(gameHashtags(g, 'instagram-reels'), shortsTags, 'default for other targets');
  assert.deepEqual(gameHashtags(g, 'youtube-video'), ['#CODM', '#CallOfDutyMobile', '#CODMHighlights', '#MobileGaming', '#MobileFPS']);
  const st = gameTags(g, 'youtube-shorts', null, []);
  assert.deepEqual(st.slice(0, 5), ['codm', 'call of duty mobile', 'cod mobile', 'codm shorts', 'codm highlights']);
  assert.ok(st.includes('youtube shorts') && st.includes('mobile fps'));
  assert.ok(!gameTags(g, 'youtube-video', null, []).some((t) => /shorts/.test(t)), 'no shorts tag on a long video');
  // user's choice 2026-11-25: other games are named only on posts of that game
  for (const t of ['youtube-shorts', 'youtube-video', 'instagram-reels']) {
    const all = [...gameTags(g, t, 'mp', []), ...(gameHashtags(g, t) ?? []), gameLines(g, t, 'mp', (s) => s)].join(' ').toLowerCase();
    assert.ok(!/delta force|rainbow|siege/.test(all), `${t}: no other game named`);
  }
  assert.ok(postGames().includes('codm'));
});

test('2026-11-25 style: title hashtags on Shorts only and only when they fit; the game lines', () => {
  const g = gamePost('codm');
  assert.equal(gameTitleTags('CODM clutch 🔥', g, 'youtube-shorts', 100), 'CODM clutch 🔥 #codm #shorts');
  assert.equal(gameTitleTags('CODM clutch #shorts', g, 'youtube-shorts', 100), 'CODM clutch #shorts #codm', 'one already there is not repeated');
  assert.equal(gameTitleTags('CODM clutch', g, 'youtube-video', 100), 'CODM clutch', 'long video: none');
  assert.equal(gameTitleTags('CODM clutch', g, 'instagram-reels', 100), 'CODM clutch', 'Reels have no title');
  const long = `CODM ${'a'.repeat(85)}`;
  assert.equal(gameTitleTags(long, g, 'youtube-shorts', 100), long, 'does not fit: the title as it is');
  const fill = (s) => s.replace('{handles.youtube}', 'Chan');
  assert.equal(gameLines(g, 'youtube-shorts', 'mp', fill),
    '🎮 Featured: Call of Duty: Mobile (MP)\n🔴 Catch me live and subscribe for more CODM highlights\n🎥 Streamer: Chan');
  assert.equal(gameLines(g, 'youtube-shorts', null).split('\n').length, 2, 'no profile value: the streamer line is left out; no mode: no brackets');
  assert.ok(gameLines(g, 'youtube-shorts', null).startsWith('🎮 Featured: Call of Duty: Mobile\n'));
  assert.equal(gameLines(null, 'youtube-shorts', 'mp'), '');
  assert.deepEqual(gameTags(g, 'youtube-shorts', 'mp', []).filter((t) => / mp$|multiplayer/.test(t)), ['codm mp', 'codm multiplayer']);
});

test('title: the model\'s own mention is kept; else the short name is added when it fits; else null', () => {
  const g = gamePost('codm');
  assert.equal(gameTitle('Clutch in CODM ranked', g, 100), 'Clutch in CODM ranked');
  assert.equal(gameTitle('Call of Duty clutch', g, 100), 'Call of Duty clutch');
  assert.equal(gameTitle('Rapid fire clutch', g, 100), 'Rapid fire clutch | CODM');
  assert.equal(gameTitle('a'.repeat(95), g, 100), null);
  assert.equal(gameTitle('Rapid fire clutch', null, 100), 'Rapid fire clutch', 'no game data: unchanged');
});

test('tags: game tags first, the mode tag, then the rest, duplicates out in any case', () => {
  const g = gamePost('codm');
  const t = gameTags(g, 'youtube-shorts', 'br', ['CODM', 'clutch', 'Clutch']);
  assert.deepEqual(t.slice(-3), ['codm br', 'codm battle royale', 'clutch']);
  assert.equal(t[0], 'codm');
  assert.equal(new Set(t.map((x) => x.toLowerCase())).size, t.length, 'no duplicates');
  assert.deepEqual(gameTags(null, 'youtube-shorts', 'br', ['clutch', 'Clutch']), ['clutch'], 'no game: the rest only');
});

test('the template opening line is dropped, credits stay; a description with nothing else keeps it', () => {
  assert.equal(dropTemplateLead('Highlight 4 from the stream on 2026-11-12.\n\nLive on X\nCommunity: Y', templates), 'Live on X\nCommunity: Y');
  assert.equal(dropTemplateLead('Victory reel 1 from the stream on 2026-11-10.\n\nLive on X', templates), 'Live on X');
  assert.equal(dropTemplateLead('Stream highlight 2 (2026-11-11).\nLive on X\nCommunity: Y', templates), 'Live on X\nCommunity: Y');
  assert.equal(dropTemplateLead('Live on X\nCommunity: Y', templates), 'Live on X\nCommunity: Y');
  assert.equal(dropTemplateLead('Highlight 4 from the stream on 2026-11-12.', templates), 'Highlight 4 from the stream on 2026-11-12.');
  assert.equal(dropTemplateLead('My own words first.\n\nLive on X', templates), 'My own words first.\n\nLive on X');
});

test('resolveGame: the post\'s own game with data, else the one game with data, else null', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-gt-')); tmp.push(d);
  const put = (id) => { mkdirSync(path.join(d, id)); writeFileSync(path.join(d, id, 'posting.json'), JSON.stringify({ post: { name: `Game ${id}`, short: id.toUpperCase() } })); };
  assert.equal(resolveGame(null, { gamesDir: d }), null);
  put('one');
  assert.equal(resolveGame(null, { gamesDir: d }), 'one');
  assert.equal(resolveGame('other', { gamesDir: d }), 'one');
  put('two');
  assert.equal(resolveGame(null, { gamesDir: d }), null, 'two games and no game on the post: none is guessed');
  assert.equal(resolveGame('two', { gamesDir: d }), 'two');
});
