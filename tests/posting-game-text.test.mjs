// SPDX-License-Identifier: GPL-3.0-or-later
// The game in every AI post (user, 2026-11-25): game data, the title rule, tags, hashtags, the template's opening line.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { dropTemplateLead, gameHashtags, gamePost, gameTags, gameTitle, postGames, resolveGame } from '../services/posting/game-text.mjs';
import { loadTemplates } from '../services/posting/index.mjs';

const tmp = [];
after(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const templates = loadTemplates();

test('the committed game data: name, short name, tags per target, hashtags per target', () => {
  const g = gamePost('codm');
  assert.ok(g, 'data/games/codm/posting.json has a post block');
  assert.equal(g.short, 'CODM');
  assert.deepEqual(gameHashtags(g, 'youtube-shorts'), ['#CODM', '#codmshorts', '#Shorts']);
  assert.deepEqual(gameHashtags(g, 'instagram-reels'), ['#CODM', '#codmshorts', '#Shorts'], 'default for other targets');
  assert.deepEqual(gameHashtags(g, 'youtube-video'), ['#CODM', '#CallOfDutyMobile']);
  assert.deepEqual(gameTags(g, 'youtube-shorts', null, []), ['codm', 'call of duty mobile', 'cod mobile', 'codm shorts', 'codm highlights']);
  assert.ok(!gameTags(g, 'youtube-video', null, []).includes('codm shorts'), 'no shorts tag on a long video');
  assert.ok(postGames().includes('codm'));
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
  assert.deepEqual(gameTags(g, 'youtube-shorts', 'br', ['CODM', 'clutch', 'Clutch']),
    ['codm', 'call of duty mobile', 'cod mobile', 'codm shorts', 'codm highlights', 'codm battle royale', 'clutch']);
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
