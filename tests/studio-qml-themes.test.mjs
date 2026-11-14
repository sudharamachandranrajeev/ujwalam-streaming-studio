// SPDX-License-Identifier: GPL-3.0-or-later
// Themes in the QML studio (plan Q4, twin of studio-qt-themes and studio-qt-theme-reload): every theme pack draws the
// 1600x900 window with its own colours and no QML error, the saved theme and effects apply at start, an unknown saved
// theme leaves Violet Night, a theme and the effects switch live (probe actions), a custom pack in UJWALAM_THEMES_DIR
// is used, and the pack in use reloads when its file changes (a broken file keeps the last good look). Headless probe
// (UJWALAM_HEADLESS=1, offscreen, never on a screen). Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';
import { writeViaRename } from '../tools/soak/stage.mjs';
import { readReference } from '../services/scene-builder/read.mjs';
import { themeFromRead, writeThemePack } from '../services/scene-builder/theme.mjs';
import { stylePanels, writePng } from './helpers/sb-fixtures.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(REPO, 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const THEMES = readdirSync(path.join(REPO, 'data', 'themes')).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => f.replace(/\.json$/, ''));
const pack = (id) => JSON.parse(readFileSync(path.join(REPO, 'data', 'themes', `${id}.json`), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

function startShell(env) {
  const child = spawn(SHELL_EXE, [], {
    windowsHide: true,
    env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_STUDIO_QML: '1',
      // The offscreen platform sees system fonts (Soft's Segoe UI) only through the Windows font folder, as on a desktop.
      QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), ...env },
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => {
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
  return done;
}

describe('QML studio themes (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = (p) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  // during(): runs while the shell is up (the reload test edits the pack file then).
  async function probe({ actions = [], ms = Math.max(5000, 3000 + actions.length * 700), prepare = null, env = {}, during = null } = {}) {
    const dataDir = tmp('ujw-qmlth-');
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'q'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {}, watchData: false });
    const { port } = await srv.listen();
    try {
      const running = startShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env });
      // A failed step still waits for the shell to end: it holds its log file open until then (EPERM on cleanup).
      if (during) await during().catch(async (e) => { await running; throw e; });
      const r = await running;
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, dataDir };
    } finally { await srv.close(); }
  }

  for (const id of THEMES) {
    test(`theme ${id}: a 1600x900 shot, the window paints with the pack's colours, no QML error`, async () => {
      const shot = path.join(tmp('ujw-qmlth-shot-'), `${id}.png`);
      const want = pack(id);
      const { p, s } = await probe({ env: { UJWALAM_THEME: id, UJWALAM_STUDIO_PROBE_SHOT: shot } });
      assert.equal(p.theme, id);
      assert.equal(p.shot, true);
      assert.deepEqual(pngSize(shot), [1600, 900]);
      for (const t of ['bg', 'panel', 'text', 'accent', 'danger'])
        assert.equal(s.themeColors[t].toLowerCase(), want.colors[t].toLowerCase(), `${id} ${t}`);
      assert.equal(s.themeDark, want.dark !== false);
      assert.ok(s.themeFont.family, 'a font family');
      assert.equal(s.themeFont.installed, true, `${s.themeFont.family} is a family Qt really has (bundled or system)`);
    });
  }

  test('the saved theme and effects (settings.json ui.theme / ui.effects) apply before the window shows', async () => {
    const { p, s } = await probe({ prepare: (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { theme: 'tactical', effects: 'reduced' } })) });
    assert.equal(p.theme, 'tactical');
    assert.equal(s.effects, 'reduced');
    assert.equal(s.themeColors.accent.toLowerCase(), pack('tactical').colors.accent.toLowerCase());
  });

  test('an unknown saved theme leaves the default, Violet Night, with full effects', async () => {
    const { p, s } = await probe({ prepare: (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { theme: 'no-such-theme' } })) });
    assert.equal(p.theme, 'violet-night');
    assert.equal(s.effects, 'full');
  });

  test('probe actions switch the theme live (the QML colours follow); an unknown id or effects mode is refused', async () => {
    const { p, s } = await probe({ actions: ['theme:neon-arcade', 'theme:nope', 'effects:reduced', 'effects:bogus'] });
    assert.deepEqual(p.actions.map((a) => [a.action, a.done]), [['theme:neon-arcade', true], ['theme:nope', false], ['effects:reduced', true], ['effects:bogus', false]]);
    assert.equal(p.theme, 'neon-arcade');
    assert.equal(s.effects, 'reduced');
    assert.equal(s.themeColors.accent.toLowerCase(), pack('neon-arcade').colors.accent.toLowerCase(), 'Theme.c changed with the theme');
  });

  test('High performance switches live and keeps through a theme switch', async () => {
    const { p, s } = await probe({ actions: ['theme:teal-grid', 'effects:performance', 'theme:sand-teal'] });
    assert.ok(p.actions.every((a) => a.done), JSON.stringify(p.actions));
    assert.deepEqual([p.theme, s.effects, s.motion], ['sand-teal', 'performance', false], 'flat mode: no animation');
  });

  test('a custom theme file in UJWALAM_THEMES_DIR is used; a broken one is not listed', async () => {
    const dir = tmp('ujw-qmlth-custom-');
    const base = pack('tactical');
    writeFileSync(path.join(dir, 'my-theme.json'), JSON.stringify({ ...base, id: 'my-theme', name: 'My Theme', colors: { ...base.colors, accent: '#ff8800' } }));
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const { p, s } = await probe({ actions: ['settings-open', 'settings-page:Appearance'], env: { UJWALAM_THEMES_DIR: dir, UJWALAM_THEME: 'my-theme' } });
    assert.equal(p.theme, 'my-theme');
    assert.equal(s.themeColors.accent.toLowerCase(), '#ff8800');
    const cards = p.tree.filter((n) => /^themeCard:/.test(n.name)).map((n) => n.name.slice(10));
    assert.ok(cards.includes('my-theme'), cards.join(','));
    assert.ok(!cards.includes('broken'), cards.join(','));
  });

  // Twin of scene-builder-theme's headless Qt probe: a pack the scene builder made from a reference picture (SB4) loads
  // as a custom theme with its own colours. Component variants are widget stylesheet features (not in the QML style).
  test('a scene-builder pack (SB4, from a drawn reference) loads as a custom theme with its colours, no QML error', async () => {
    const themes = tmp('ujw-qmlth-sb4-');
    const { pack: made } = themeFromRead(await readReference(writePng(stylePanels({ glow: true }).canvas, tmp('ujw-qmlth-ref-'), 'glow')), { name: 'Sb4 Probe' });
    writeThemePack(made, themes);
    const { p, s } = await probe({ actions: ['settings-open', 'settings-page:Appearance'], env: { UJWALAM_THEMES_DIR: themes, UJWALAM_THEME: made.id } });
    assert.equal(p.theme, made.id);
    for (const t of ['bg', 'panel', 'text', 'accent']) assert.equal(s.themeColors[t].toLowerCase(), made.colors[t].toLowerCase(), t);
    assert.ok(p.tree.some((n) => n.name === `themeCard:${made.id}`), 'listed in Settings > Appearance');
  });

  test('the pack in use reloads when its file changes: valid applies live, broken keeps the last good look, a fix applies again', async () => {
    const themes = tmp('ujw-qmlth-reload-');
    const file = path.join(themes, 'lu-reload.json');
    const write = (accent) => { const p = pack('violet-night'); p.id = 'lu-reload'; p.name = 'Reload test'; p.colors.accent = accent; writeViaRename(file, `${JSON.stringify(p, null, 2)}\n`); };
    write('#112233');
    // Each step waits until the studio's log says it has seen the one before (fixed sleeps lost the race under full-CI
    // load twice on 2026-11-14: the broken file was replaced before the busy window read it). The log is flushed per line.
    const logs = tmp('ujw-qmlth-log-');
    const logText = () => readdirSync(logs).filter((f) => f.startsWith('studio-')).map((f) => readFileSync(path.join(logs, f), 'utf8')).join('');
    const count = (re) => (logText().match(re) ?? []).length;
    const until = async (cond, ms, what) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error(`studio log: no ${what}:\n${logText()}`); await sleep(100); } };
    const applied = /lu-reload\.json changed on disk; applied/g;
    const { p, s } = await probe({
      ms: 22000,
      env: { UJWALAM_THEMES_DIR: themes, UJWALAM_THEME: 'lu-reload', UJWALAM_STUDIO_LOG_DIR: logs },
      during: async () => {
        await sleep(3000);
        write('#445566');
        await until(() => count(applied) >= 1, 6000, 'reload of the first change');
        const good = readFileSync(file, 'utf8');
        writeViaRename(file, good.slice(0, Math.floor(good.length / 2)));
        await until(() => count(/lu-reload\.json not applied/g) >= 1, 6000, 'refusal of the broken file');
        write('#778899');
        await until(() => count(applied) >= 2, 6000, 'reload of the fix');
      },
    });
    assert.equal(p.theme, 'lu-reload');
    assert.equal(s.themeColors.accent.toLowerCase(), '#778899', 'the QML colours follow the reloaded pack');
    assert.deepEqual(s.tasks.toastLog.filter((x) => /^Theme not applied/.test(x)), ['Theme not applied: the file has a problem'], 'the refused file is said once, in a notification');
  });
});
