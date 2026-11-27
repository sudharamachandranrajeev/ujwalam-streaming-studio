// SPDX-License-Identifier: GPL-3.0-or-later
// Web theme (Q5, flag `web-theme`): generator over every shipped theme pack, and the UI server's /css/tokens.css
// (flag off = the static file, flag on = the chosen theme, switching, broken theme, no path traversal).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFlags } from '../services/flags/index.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { contrast } from '../services/studio-ui/theme-contrast.mjs';
import { writeSettings } from '../services/studio-ui/user-settings.mjs';
import { COLOR_KEYS, DEFAULT_THEME_ID, loadPack, packProblems, TOKEN_NAMES, tokensCss, tokensCssFor, tokensFromPack } from '../services/studio-ui/web-theme.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');
const THEMES = path.join(ROOT, 'data', 'themes');
const STATIC = readFileSync(path.join(UI, 'css', 'tokens.css'), 'utf8');
const packs = readdirSync(THEMES).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => JSON.parse(readFileSync(path.join(THEMES, f), 'utf8')));
const KEY = 'k'.repeat(48);

describe('generator over the shipped themes', () => {
  test('there are 12 packs', () => assert.equal(packs.length, 12)); // Molten Stone added 2026-11-27
  for (const p of packs) {
    test(`${p.id}: valid CSS, every variable present, colours equal the pack`, () => {
      assert.deepEqual(packProblems(p), []);
      const css = tokensCss(p);
      assert.match(css, /^\/\* SPDX-License-Identifier: GPL-3\.0-or-later \*\/\n/);
      assert.match(css, /:root \{\n[\s\S]*\n\}\n$/);
      assert.equal(css.split('{').length, 2); assert.equal(css.split('}').length, 2); // one rule, nothing smuggled in
      const decls = Object.fromEntries([...css.matchAll(/^ {2}(--[a-z0-9-]+): ([^;]+);$/gm)].map((m) => [m[1], m[2]]));
      for (const n of TOKEN_NAMES) assert.ok(decls[n], `${n} present`);
      for (const m of STATIC.matchAll(/^ {2}(--[a-z0-9-]+):/gm)) assert.ok(decls[m[1]], `static variable ${m[1]} kept`);
      const c = p.colors;
      const eq = (name, key) => assert.equal(decls[name], c[key].toLowerCase(), name);
      eq('--color-bg', 'bg'); eq('--color-surface', 'panel'); eq('--color-surface-2', 'field'); eq('--color-border', 'border');
      eq('--color-text', 'text'); eq('--color-text-dim', 'muted'); eq('--color-accent', 'accent'); eq('--color-accent-text', 'onAccent');
      eq('--color-live', 'danger'); eq('--color-ok', 'ok'); eq('--color-accent-hi', 'accentHi'); eq('--color-disabled', 'disabled');
      eq('--color-live-text', 'onAccent'); eq('--color-tab-on-bg', 'accent'); eq('--color-tab-on-text', 'onAccent');
      assert.match(css, new RegExp(`color-scheme: ${p.dark ? 'dark' : 'light'};`));
      assert.ok(decls['--font-ui'].startsWith(p.typography.family.includes(' ') ? `"${p.typography.family}"` : p.typography.family));
      assert.equal(decls['--radius'], `${p.geometry.radius.medium}px`);
      assert.ok(parseInt(decls['--anim-in'], 10) < 600 && parseInt(decls['--anim-out'], 10) < 400);
      // text that app.css puts on the warn and blocked pills stays readable
      const v = tokensFromPack(p);
      for (const k of ['--color-warn', '--color-blocked']) assert.ok(contrast(v[k], c.onAccent) >= 4.5, `${p.id} ${k} contrast ${contrast(v[k], c.onAccent).toFixed(2)}`);
      for (const n of TOKEN_NAMES) if (n.includes('color') && !n.includes('scrim')) assert.match(v[n], /^#[0-9a-f]{6}$/, n);
    });
  }
  test('the same pack gives the same text', () => assert.equal(tokensCss(packs[0]), tokensCss(structuredClone(packs[0]))));
  test('a bad pack is refused, and a font name cannot carry CSS', () => {
    const p = structuredClone(packs[0]);
    assert.throws(() => tokensCss({ ...p, colors: { ...p.colors, bg: 'red' } }), /colors\.bg/);
    assert.throws(() => tokensCss({ ...p, typography: { ...p.typography, family: 'x; } body { display: none' } }), /typography\.family/);
    assert.throws(() => tokensCss({ ...p, typography: { ...p.typography, fallbacks: ['a"b'] } }), /typography\.fallbacks/);
    assert.throws(() => tokensCss(null));
    assert.ok(COLOR_KEYS.every((k) => packProblems({ ...p, colors: { ...p.colors, [k]: undefined } }).includes(`colors.${k}`)));
  });
  test('no web font file is linked', () => {
    for (const p of packs) assert.ok(!/url\(|@font-face|@import|\.ttf|\.woff/i.test(tokensCss(p)));
  });
  test('loadPack: ids that are not plain theme ids find nothing', () => {
    for (const id of ['../theme.schema', '..\\x', 'a/b', 'A', '', 'x'.repeat(41), null, undefined, 5, 'violet-night.json', 'violet--night']) assert.equal(loadPack(id, [THEMES]), null, String(id));
    assert.equal(loadPack('violet-night', [THEMES]).id, 'violet-night');
    assert.ok(tokensCssFor(undefined, [THEMES]).includes('violet-night'), 'no choice = the studio default');
    assert.equal(DEFAULT_THEME_ID, 'violet-night');
  });
});

function raw(port, { url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}

describe('server /css/tokens.css', () => {
  let dataDir, custom, srv, port, cookie, flags;
  const tokens = async () => raw(port, { url: '/css/tokens.css', headers: { cookie } });
  const choose = (id) => writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ui: { theme: id } }));
  before(async () => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-webtheme-'));
    custom = path.join(dataDir, 'custom-themes'); mkdirSync(custom);
    // a user's own theme (a copy with a new background), a broken file and a file whose id differs from its name
    const mine = structuredClone(packs.find((p) => p.id === 'ujwalam-light')); mine.id = 'my-own'; mine.colors.bg = '#123456';
    writeFileSync(path.join(custom, 'my-own.json'), JSON.stringify(mine));
    writeFileSync(path.join(custom, 'broken-one.json'), '{ "id": "broken-one", "colors": ');
    writeFileSync(path.join(custom, 'wrong-id.json'), JSON.stringify({ ...mine, id: 'something-else' }));
    flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: async (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    srv = createStudioServer({ uiRoot: UI, core, host, launchKey: KEY, dataDir, flags, themeDirs: [custom, THEMES], limits: { statusPollMs: 50 } });
    ({ port } = await srv.listen());
    cookie = (await raw(port, { url: `/login?k=${KEY}` })).headers['set-cookie'][0].split(';')[0];
  });
  after(() => { srv.close(); rmSync(dataDir, { recursive: true, force: true }); });

  test('the flag is registered, off by default, with a plain label', () => {
    const f = flags.list().find((x) => x.id === 'web-theme');
    assert.ok(f); assert.equal(f.on, false); assert.equal(f.label, 'Web page theme');
  });
  test('flag off: the static file, byte for byte, whatever the saved theme', async () => {
    assert.equal(flags.isOn('web-theme'), false);
    writeSettings(dataDir, { ui: { theme: 'soft' } });
    const r = await tokens();
    assert.equal(r.status, 200); assert.equal(r.text, STATIC); assert.match(r.headers['content-type'], /text\/css/);
  });
  test('flag on: the theme the user chose; switching changes the answer without a restart', async () => {
    flags.set('web-theme', true);
    writeSettings(dataDir, { ui: { theme: 'soft' } });
    const soft = await tokens(); // an old saved Soft opens Ujwalam Light (D389)
    assert.equal(soft.status, 200); assert.equal(soft.text, tokensCss(packs.find((p) => p.id === 'ujwalam-light'))); assert.notEqual(soft.text, STATIC);
    assert.equal(soft.headers['cache-control'], 'no-store');
    writeSettings(dataDir, { ui: { theme: 'tactical' } });
    const tac = await tokens();
    assert.equal(tac.text, tokensCss(packs.find((p) => p.id === 'tactical'))); assert.notEqual(tac.text, soft.text);
  });
  test('no saved choice: the studio default; a custom theme file in a user folder is used', async () => {
    rmSync(path.join(dataDir, 'settings.json'), { force: true });
    assert.equal((await tokens()).text, tokensCss(packs.find((p) => p.id === DEFAULT_THEME_ID)));
    choose('my-own');
    assert.match((await tokens()).text, /--color-bg: #123456;/);
  });
  test('missing, broken or mismatched theme: falls back to the static file', async () => {
    for (const id of ['no-such-theme', 'broken-one', 'wrong-id']) { choose(id); assert.equal((await tokens()).text, STATIC, id); }
  });
  test('a theme id cannot reach another file', async () => {
    // (the settings reader drops an id that is not a plain theme id, so the page gets the studio default, never another file)
    const dflt = tokensCss(packs.find((p) => p.id === DEFAULT_THEME_ID));
    for (const id of ['../theme.schema', '../../package', 'a/../b', 'C:\\x', '.hidden']) { choose(id); assert.equal((await tokens()).text, dflt, id); }
    for (const u of ['/css/../../package.json', '/css//tokens.css', '/css/tokens.css%00.css']) {
      const r = await raw(port, { url: u, headers: { cookie } });
      assert.ok([400, 404].includes(r.status), `${u} -> ${r.status}`);
    }
  });
  test('flag off again: the static file at once; other files are never changed by the flag', async () => {
    choose('soft');
    flags.set('web-theme', true);
    assert.equal((await raw(port, { url: '/css/app.css', headers: { cookie } })).text, readFileSync(path.join(UI, 'css', 'app.css'), 'utf8'));
    flags.set('web-theme', false);
    assert.equal((await tokens()).text, STATIC);
  });
});
