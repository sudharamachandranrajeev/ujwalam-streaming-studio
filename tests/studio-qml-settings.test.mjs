// SPDX-License-Identifier: GPL-3.0-or-later
// Settings in the QML studio (plan Q3, D355): the QML twins of the widget studio's Settings tests
// (studio-qt-shell.test.mjs, studio-qt-themes.test.mjs), with the same probe actions (settings-open, settings-page:<title>,
// settings-flag:<id>:on, settings-save ...). Headless probe (UJWALAM_HEADLESS=1, offscreen, never on a screen) against a
// real UI server and the fake host; the settings land in the test's own data folder. Skipped when the shell is not built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;
const DEFS = JSON.parse(readFileSync(new URL('../data/flags.json', import.meta.url), 'utf8')).flags;

function runShell(env) {
  return new Promise((resolve) => {
    const child = spawn(SHELL_EXE, [], {
      windowsHide: true,
      env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', ...env },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 40_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

describe('QML studio Settings (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  // refuse(method, url, body) → true: a server in front answers 400 bad-settings (an older server), else passes it on.
  async function probe(actions = [], ms = 6000, env = {}, prepare = null, refuse = null) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-qml-set-')); dirs.push(dataDir);
    if (prepare) prepare(dataDir);
    const flags = createFlags({ dataDir });
    const fake = createFakeHost({ outputsReady: true });
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 's'.repeat(40);
    const srv = createStudioServer({ uiRoot: UI, core, host: fake, launchKey: key, dataDir, flags, authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    let { port } = await srv.listen();
    const front = refuse ? await frontOf(port, refuse) : null;
    if (front) port = front.address().port;
    try {
      const r = await runShell({ UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms),
        UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(','), ...env });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError)/, 'no QML errors');
      const p = JSON.parse(m[1]);
      const file = path.join(dataDir, 'settings.json');
      return { p, s: p.state, flags, dataDir, saved: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null, out: r.out };
    } finally { front?.close(); srv.close(); }
  }
  function frontOf(port, refuse) {
    const s = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (refuse(req.method, req.url, body.toString('utf8'))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"error":"bad-settings"}');
        }
        const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${port}`, // the server checks both
          ...(req.headers.origin ? { origin: `http://127.0.0.1:${port}` } : {}) } }, (u) => {
          res.writeHead(u.statusCode, u.headers);
          u.pipe(res);
        });
        up.on('error', () => res.destroy());
        up.end(body);
      });
    });
    return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
  }
  const node = (p, name) => p.tree.find((n) => n.name === name);
  const done = (p) => p.actions.map((a) => [a.action, a.done]);

  test('nav groups General / Live / Studio / Clips, the pages in them, Advanced last; each flag on its own page, A-Z, plain words only', async () => {
    const { p, s } = await probe(['settings-open', 'settings-section:Advanced']);
    assert.deepEqual(done(p), [['settings-open', true], ['settings-section:Advanced', true]]);
    assert.deepEqual(s.settings.navGroups, ['GENERAL', 'LIVE', 'STUDIO', 'CLIPS'], 'headings are not pages');
    assert.deepEqual(s.settings.sections, ['Appearance', 'Help & tips', 'Stream', 'Transitions', 'Connections', 'Chat & bots', 'Editing', 'Preview', 'Clips', 'Posting & growth', 'Folders', 'Downloads', 'Advanced']); // Downloads: D404 download manager
    assert.equal(s.settings.motionChoices, 3, 'Follow Windows / Always on / Off');
    assert.equal(s.settings.motion, 'system');
    assert.equal(s.flagsInSettings, true);
    const rows = s.settings.flagRows;
    assert.equal(rows.length, s.flags.length, 'a row for every flag the server lists');
    for (const r of rows) {
      const f = { ...DEFS.find((x) => x.id === r.id), ...s.flags.find((x) => x.id === r.id) };
      assert.equal(r.on, f.on, r.id);
      assert.equal(r.label, f.label, r.id);
      assert.equal(r.summary, f.summary, `${r.id}: its plain summary is shown`);
      assert.equal(r.page, f.page, r.id);
      assert.doesNotMatch(`${r.label} ${r.summary}`, /\bD\d{2,}\b|[\\/][\w.-]+\.(json|mjs|cpp|md)\b/, `${r.id}: no decision numbers or file paths`);
      if (r.page === 'advanced') assert.equal(r.visible, true, r.id);
    }
    const byPage = (pg) => rows.filter((r) => r.page === pg).map((r) => r.label);
    for (const pg of new Set(rows.map((r) => r.page))) {
      const labels = byPage(pg);
      assert.deepEqual(labels, [...labels].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())), `${pg}: A-Z by name`);
    }
    assert.ok(byPage('advanced').length >= 1 && byPage('clips').length >= 10 && byPage('editing').includes('Layer effects'));
    assert.equal(s.settings.dirty, false, 'nothing changed yet');
    // the window itself: every flag switch shows its label and no flag id or description
    const sw = p.tree.filter((n) => n.name.startsWith('flag:'));
    assert.equal(sw.length, rows.length);
    for (const n of sw) assert.equal(n.text, rows.find((r) => `flag:${r.id}` === n.name).label);
  });

  test('the Settings button opens the window on Clips; the search box narrows the list and picks a shown page', async () => {
    const { p, s } = await probe(['click:settingsBtn', 'settings-search:snap', 'settings-search:zzqq', 'settings-search:'], 7000);
    assert.deepEqual(done(p).map((x) => x[1]), [true, true, true, true]);
    assert.equal(s.settings.query, '');
    assert.equal(s.settings.shownPages.length, 13, 'an empty search shows every page');
    const q = await probe(['click:settingsBtn', 'settings-search:snap'], 6000);
    assert.deepEqual(q.s.settings.shownPages, ['Preview']);
    assert.equal(q.s.settings.page, 'Preview', 'the page follows the search');
    const f = await probe(['click:settingsBtn', 'settings-search:reel hook'], 6000);
    assert.ok(f.s.settings.shownPages.includes('Clips'), 'a feature row\'s words find its page');
    const none = await probe(['click:settingsBtn', 'settings-search:zzqq'], 6000);
    assert.deepEqual(none.s.settings.shownPages, []);
    assert.equal(node(none.p, 'settingsNothing').visible, true);
  });

  test('no sideways scrolling: every page is as wide as its view; the window has its full size', async () => {
    const { p, s } = await probe(['settings-open', 'settings-page:Clips'], 6000);
    assert.ok(s.settings.size[0] >= 900 && s.settings.size[1] >= 700, `Settings is ${s.settings.size} (a window popup sized only to its footer is a regression)`);
    const page = node(p, 'settingsPage:Clips');
    const title = node(p, 'settingsTitle:Clips');
    assert.ok(page && title, 'the Clips page is in the tree');
    const [px, , pw] = page.rect;
    for (const n of p.tree.filter((x) => x.visible && x.rect && x.rect[2] > 0 && /^(reelMin_|reelMax_|hookOn_|settings(Recording|Live|RecordLive|Top3|TransKind))/.test(x.name)))
      assert.ok(n.rect[0] + n.rect[2] <= px + pw + 1, `${n.name} ends inside the page (${n.rect} vs ${page.rect})`);
  });

  test('layer effects on turns flag layer-effects on at Save, no phrase; animations Off is saved as ui.motion', async () => {
    const { p, s, flags, saved } = await probe(['settings-open', 'settings-flag:layer-effects:on', 'settings-motion:off', 'settings-save'], 12000); // the flags POST lands after Save: slower under CI load
    assert.deepEqual(done(p), [['settings-open', true], ['settings-flag:layer-effects:on', true], ['settings-motion:off', true], ['settings-save', true]]);
    assert.equal(flags.isOn('layer-effects'), true, 'applied on Save through the flags route');
    assert.equal(saved.ui.motion, 'off');
    assert.equal(s.motionMode, 'off');
    assert.equal(s.motion, false, 'no animation while the choice is Off');
    assert.equal(s.flagsInSettings, false, 'the window closed on Save');
  });

  test('a real click on a flag switch changes the draft only; Save applies it', async () => {
    const draft = await probe(['settings-open', 'settings-page:Editing', 'click:flag:layer-effects'], 6000);
    assert.equal(draft.s.settings.flagRows.find((r) => r.id === 'layer-effects').on, true);
    assert.equal(draft.s.settings.dirty, true);
    assert.equal(draft.flags.isOn('layer-effects'), false, 'nothing applied before Save');
    const saved = await probe(['settings-open', 'settings-page:Editing', 'click:flag:layer-effects', 'click:settingsSave'], 11000);
    assert.equal(saved.flags.isOn('layer-effects'), true);
  });

  test('Settings > Clips: reel length rows show the defaults, Save sends the changed type, a shortest over the longest blocks Save', async () => {
    const a = await probe(['settings-open', 'settings-page:Clips', 'settings-reel:montage:10:30', 'settings-save'], 8000);
    assert.deepEqual(done(a.p), [['settings-open', true], ['settings-page:Clips', true], ['settings-reel:montage:10:30', true], ['settings-save', true]]);
    assert.deepEqual(a.saved.clips.reelLengths, { montage: { minSec: 10, maxSec: 30 } });
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(Object.keys(q.s.settings.reelLengths.rows).sort(), ['impact-play', 'live-clip', 'match-reel', 'montage', 'short']);
    assert.deepEqual(q.s.settings.reelLengths.rows.montage, { min: 20, max: 60, maxLimit: 60 });
    assert.equal(q.s.settings.reelLengths.error, '');
    assert.equal(node(q.p, 'reelMin_montage').value, 20, 'the box shows the value');
    const r = await probe(['settings-open', 'settings-page:Clips', 'settings-reel:montage:50:40', 'settings-save'], 8000);
    assert.deepEqual(done(r.p).map((x) => x[1]), [true, true, true, false], 'Save refused');
    assert.match(r.s.settings.reelLengths.error, /montage: the shortest \(50 s\) is longer than the longest \(40 s\)/);
    assert.equal(r.s.settings.dirty, true, 'Settings stayed open with the edit');
    assert.equal(r.saved, null, 'nothing saved');
  });

  test('Settings > Clips: reel opening rows show on and 2 s per type, Save sends only the changed type', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(Object.keys(q.s.settings.reelHooks).sort(), ['impact-play', 'live-clip', 'match-reel', 'montage']);
    assert.deepEqual(q.s.settings.reelHooks.montage, { on: true, teaserSec: 2, teaserEnabled: true, min: 1, max: 3 });
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-hook:match-reel:0:3', 'settings-save'], 8000);
    assert.deepEqual(done(p.p).map((x) => x[1]), [true, true, true, true]);
    assert.deepEqual(p.saved.clips.reelHooks, { 'match-reel': { on: false, teaserSec: 3 } });
  });

  test('Settings > Clips: Transition between pieces shows Cross fade 250 ms (150-500); Save sends the choice; Cut saves no length', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(q.s.settings.reelTransition, { kind: 'fade', label: 'Cross fade', ms: 250, msEnabled: true, min: 150, max: 500 });
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-transition:fade:400', 'settings-save'], 8000);
    assert.deepEqual(p.saved.clips.reelTransition, { kind: 'fade', ms: 400 });
    const c = await probe(['settings-open', 'settings-page:Clips', 'settings-transition:cut:0', 'settings-save'], 8000);
    assert.deepEqual(c.saved.clips.reelTransition, { kind: 'cut', ms: 0 });
  });

  test('Settings > Clips: Clip look shows every style ticked and mixing on; ticks, locks and mixing are saved at Save (D411)', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.equal(q.s.settings.look.randomise, true);
    assert.deepEqual(q.s.settings.look.transitions.styles, ['punchy', 'cinematic', 'clean']);
    assert.deepEqual(q.s.settings.look.name.styles, ['lower-third', 'corner-tag', 'kinetic']);
    assert.equal(q.saved, null, 'nothing saved by looking');
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-look-tick:transitions:punchy:off', 'settings-look-lock:name:corner-tag',
      'settings-look-random:off', 'settings-look-tick:music:drop:off', 'settings-save'], 9000);
    const l = p.saved.clips.look;
    assert.equal(l.randomise, false);
    assert.deepEqual(l.transitions.styles, ['cinematic', 'clean']);
    assert.equal(l.name.lock, 'corner-tag');
    assert.deepEqual(l.music.modes, ['intro-outro', 'full-bed']);
    assert.equal(l.music.levelDb, -20);
    assert.equal(l.music.underGameDb, 8);
    assert.equal(l.music.fadeCurve, 's-curve');
    const u = await probe(['settings-open', 'settings-page:Clips', 'settings-look-lock:name:kinetic', 'settings-look-tick:name:kinetic:off', 'settings-save'], 9000);
    assert.equal(u.saved.clips.look.name.lock, null, 'unticking the locked style clears the lock');
  });

  test('Settings > Clips: music under the game, voice duck and fades show their defaults and are saved at Save (D437)', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    const m = q.s.settings.look.music;
    assert.deepEqual([m.levelDb, m.underGameDb, m.voiceDuckDb, m.fadeInSec, m.fadeOutSec, m.fadeCurve], [-20, 8, 8, 1.5, 1.5, 's-curve']);
    assert.equal(q.saved, null, 'nothing saved by looking');
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-look-music:underGameDb:10', 'settings-look-music:voiceDuckDb:0',
      'settings-look-music:fadeInSec:2.5', 'settings-look-music:fadeOutSec:0.8', 'settings-look-music:fadeCurve:equal-power', 'settings-save'], 9000);
    const s = p.saved.clips.look.music;
    assert.deepEqual([s.underGameDb, s.voiceDuckDb, s.fadeInSec, s.fadeOutSec, s.fadeCurve], [10, 0, 2.5, 0.8, 'equal-power']);
  });

  test('Settings > Clips: K.O. card styles and the loudness target show their defaults and are saved at Save (D439, D440)', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    const l = q.s.settings.look;
    assert.deepEqual(l.cards.styles, ['slam', 'slash', 'glitch', 'zoom-punch', 'stamp']);
    assert.equal(l.music.loudnessLufs, -14);
    assert.equal(q.saved, null, 'nothing saved by looking');
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-look-tick:cards:glitch:off', 'settings-look-tick:cards:slash:off',
      'settings-look-music:loudnessLufs:-16', 'settings-save'], 9000);
    assert.deepEqual(p.saved.clips.look.cards.styles, ['slam', 'zoom-punch', 'stamp']);
    assert.equal(p.saved.clips.look.music.loudnessLufs, -16);
    const o = await probe(['settings-open', 'settings-page:Clips', 'settings-look-music:loudnessLufs:off', 'settings-save'], 9000);
    assert.equal(o.saved.clips.look.music.loudnessLufs, null);
  });

  test('Settings > Clips: Reel styles opens without QML errors; the style per reel type and the mix are saved at Save (RS3, D412)', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.equal(q.saved, null, 'nothing saved by looking');
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-reel-style:reel:fast-warm', 'settings-reel-style:montage:none',
      'settings-reel-style-pool:calm:on', 'settings-save'], 9000);
    assert.deepEqual(p.saved.clips.reelStyles, { byType: { reel: 'fast-warm', montage: null }, pool: ['calm'] });
  });

  test('Settings > Clips: Realism look is off for every reel type; one look, random ticks and off are saved at Save (RL4, D445)', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    const off = { mode: 'off', look: null, ticks: [] };
    assert.deepEqual(q.s.settings.realismLooks.value, { byType: { reel: off, impact: off, montage: off } });
    assert.equal(q.s.settings.realismLooks.looks[0], 'filmic');
    assert.equal(q.s.settings.realismLooks.looks.length, 7);
    assert.equal(node(q.p, 'realismMode_reel')?.visible, true, 'one choice per reel type');
    assert.equal(node(q.p, 'realismMode_montage')?.visible, true);
    assert.match(node(q.p, 'realismHint').text, /replaces the reel style's colour/);
    assert.equal(q.s.settings.dirty, false);
    assert.equal(q.saved, null, 'nothing saved by looking');
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-realism:reel:one:cinematic', 'settings-realism:impact:random',
      'settings-realism-tick:impact:night-neon:on', 'settings-realism-tick:impact:filmic:on', 'settings-realism-tick:impact:night-neon:off',
      'settings-realism-tick:impact:gritty-war:on', 'settings-save'], 9000);
    assert.deepEqual(p.saved.clips.realismLooks, { byType: { reel: { mode: 'one', look: 'cinematic', ticks: [] },
      impact: { mode: 'random', look: null, ticks: ['filmic', 'gritty-war'] } } }, 'only the changed types, ticks in library order');
    const r = await probe(['settings-open', 'settings-page:Clips', 'settings-realism:reel:off', 'settings-save'], 9000, {}, (d) => writeFileSync(
      path.join(d, 'settings.json'), JSON.stringify({ clips: { realismLooks: { byType: { reel: { mode: 'one', look: 'filmic', ticks: [] } } } } })));
    assert.equal(r.saved.clips.realismLooks.byType.reel.mode, 'off');
  });

  test('Settings > Clips: Montage music is on by default with a random song; only the changed parts are saved at Save (D414)', async () => {
    const q = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(q.s.settings.montageMusic, { on: true, folder: '', mode: 'random', fixedTrack: null, avoidLast: 3 });
    assert.equal(node(q.p, 'montageMusicOn').checked, true);
    assert.equal(q.saved, null, 'nothing saved by looking');
    const p = await probe(['settings-open', 'settings-page:Clips', 'settings-montage:avoidLast:5', 'settings-montage:on:off', 'settings-save'], 9000);
    assert.deepEqual(p.saved.clips.montageMusic, { on: false, avoidLast: 5 });
  });

  test('Settings > Clips: Record while live is a switch row with its explanation, on by default; off is saved at Save', async () => {
    const p = await probe(['settings-open', 'settings-page:Clips']);
    assert.deepEqual(p.s.settings.recordLive, { on: true, text: 'Record while live', visible: true,
      hint: 'Records the stream (H and V) to your recordings folder so reels can be made after it ends. Uses about 10 GB per hour.' });
    assert.equal(node(p.p, 'settingsRecordLive').checked, true);
    assert.equal(p.s.settings.dirty, false);
    const draft = await probe(['settings-open', 'click:settingsRecordLive']);
    assert.deepEqual([draft.s.settings.recordLive.on, draft.s.settings.dirty], [false, true], 'a draft until Save (D332)');
    const saved = await probe(['settings-open', 'settings-record-live:off', 'settings-save'], 8000);
    assert.equal(saved.saved.clips.recordLive, false);
  });

  test('Settings > Appearance: a theme card click previews it, Save stores ui.theme and ui.effects', async () => {
    const p = await probe(['settings-open', 'settings-page:Appearance', 'click:themeCard:retro-wave', 'settings-reduce-effects:on', 'settings-save'], 22000);
    assert.deepEqual(done(p.p).map((x) => x[1]), [true, true, true, true, true]);
    assert.equal(p.p.theme, 'retro-wave');
    assert.equal(p.saved.ui.theme, 'retro-wave');
    assert.equal(p.saved.ui.effects, 'reduced');
  });

  test('Settings > Appearance: Cancel, then Discard in the unsaved-changes question, puts the old look back and saves nothing', async () => {
    const p = await probe(['settings-open', 'settings-theme:neon-arcade', 'settings-reduce-effects:on', 'settings-cancel', 'settings-unsaved:discard'], 9000);
    assert.equal(p.p.actions.every((a) => a.done), true, JSON.stringify(p.p.actions));
    assert.equal(p.p.theme, 'violet-night');
    assert.equal(p.s.effects, 'full');
    assert.equal(p.saved, null);
    assert.equal(p.s.flagsInSettings, false);
  });

  test('unsaved question: Cancel keeps Settings open with the edit; Save changes saves it', async () => {
    const k = await probe(['settings-open', 'settings-snap:on', 'settings-cancel', 'settings-unsaved:cancel']);
    assert.deepEqual([k.s.flagsInSettings, k.s.settings.dirty, k.s.settings.unsavedOpen], [true, true, false]);
    const s = await probe(['settings-open', 'settings-snap:on', 'settings-cancel', 'settings-unsaved:save'], 8000);
    assert.equal(s.saved.ui.snap, true);
    assert.equal(s.s.flagsInSettings, false);
  });

  test('High performance: turning it off gives back the Reduce effects choice the user had; it saves ui.effects "performance"', async () => {
    const b = await probe(['settings-open', 'settings-reduce-effects:on', 'settings-performance:on', 'settings-performance:off']);
    assert.equal(b.s.settings.effects, 'reduced');
    const p = await probe(['settings-open', 'settings-performance:on', 'settings-save'], 13000);
    assert.equal(p.saved.ui.effects, 'performance');
  });

  test('Folders: a typed folder is saved; Default saves none', async () => {
    const dir = path.join(os.tmpdir(), 'ujw-recordings');
    const p = await probe(['settings-open', 'settings-page:Folders', `type:folderRecordings=${dir}`, 'settings-save'], 8000);
    assert.equal(p.saved.folders.recordings, dir);
    assert.equal(p.saved.folders.clips, null);
  });

  test('Save sends what the widget sends: the reel keys and other ui keys only when they changed', async () => {
    const p = await probe(['settings-open', 'settings-snap:on', 'settings-save'], 8000);
    for (const k of ['reelLengths', 'reelHooks', 'reelTransition']) assert.equal(p.saved.clips[k], undefined, k);
    assert.deepEqual([typeof p.saved.clips.recording, typeof p.saved.clips.live], ['string', 'string'], 'both modes, always');
    assert.deepEqual(p.saved.ui, { snap: true });
  });

  // ---- twins of studio-qt-shell's Settings tests (preview snap, motion, match filter) ----
  test('Settings > Preview: snap is off by default with its words; on is a draft (nothing written) until Save; off again saves false', async () => {
    const d = await probe(['settings-open', 'settings-page:Preview', 'settings-snap:on']);
    const sw = node(d.p, 'settingsSnap');
    assert.equal(sw.text, 'Snap to preview edges and other layers');
    assert.deepEqual([d.s.settings.snap, d.s.settings.dirty], [true, true], 'a draft until Save');
    assert.equal(d.saved, null, 'nothing written before Save');
    const def = await probe(['settings-open', 'settings-page:Preview']);
    assert.deepEqual([def.s.settings.snap, def.s.settings.dirty, node(def.p, 'settingsSnap').checked], [false, false, false], 'off unless the user turns it on');
    const back = await probe(['settings-open', 'settings-snap:off', 'settings-save'], 8000, {}, (dir) => writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ui: { snap: true } })));
    assert.equal(back.saved.ui.snap, false, 'and off again');
  });

  test('motion: settings.json ui.motion is read at start; UJWALAM_REDUCE_MOTION still overrides it', async () => {
    const prep = (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { motion: 'off' } }));
    const off = await probe([], 4500, {}, prep);
    assert.deepEqual([off.s.motionMode, off.s.motion], ['off', false]);
    const env = await probe([], 4500, { UJWALAM_REDUCE_MOTION: '0' }, prep);
    assert.deepEqual([env.s.motionMode, env.s.motion], ['off', true], 'the environment wins');
    const on = await probe([], 4500, { UJWALAM_REDUCE_MOTION: '' }, (d) => writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ ui: { motion: 'on' } })));
    assert.deepEqual([on.s.motionMode, on.s.motion], ['on', true]);
  });

  test('Settings > Clips: the match filter is saved through the settings route, with a plain note', async () => {
    const p = await probe(['settings-open', 'settings-page:Clips', 'click:settingsTop3', 'click:settingsKillsOn', 'settings-save'], 9000);
    assert.ok(p.p.actions.every((a) => a.done), JSON.stringify(p.p.actions));
    const gate = p.saved.clips.matchGate;
    assert.equal(gate.top3, false, 'top 3 switched off');
    assert.equal(typeof gate.minKills, 'number', 'the kills box is on');
    assert.match(p.s.note, /^Settings saved\.$/);
    assert.doesNotMatch(p.s.note, /HTTP 400|bad-settings/);
  });
  test('Settings > Clips: an older server that refuses the match filter gives plain words; the other settings are saved again without it', async () => {
    const old = (m, url, body) => m === 'POST' && url.startsWith('/ui/api/settings') && body.includes('"matchGate"');
    const both = await probe(['settings-open', 'settings-page:Preview', 'settings-snap:on', 'settings-page:Clips', 'click:settingsTop3', 'settings-save'], 10000, {}, null, old);
    assert.ok(both.p.actions.every((a) => a.done), JSON.stringify(both.p.actions));
    assert.equal(both.s.note, 'Settings saved, except the match filter: this version of Ujwalam does not support it yet.');
    assert.equal(both.saved.ui.snap, true, 'the snap switch was saved');
    assert.notEqual(both.saved.clips?.matchGate?.top3, false, 'the refused match filter change did not land');
  });
  // D432: a Settings open must not block the window for seconds. Before the fix the open itself took 3.6 s and the
  // settings answer 3.4 s on the GUI thread (every page and every shadow built at once). The lag monitor (lag_monitor.h)
  // names each piece of GUI-thread work; the budgets leave room for a loaded CI machine.
  test('opening Settings and switching pages stays inside the GUI-thread budget (lag monitor)', async () => {
    const { p } = await probe(['settings-open', 'settings-page:Appearance', 'settings-page:Downloads', 'settings-page:Clips'], 8000);
    assert.equal(p.lag.on, true, 'the lag monitor runs');
    const w = (k) => (p.lag.work[k] || { maxMs: 0 }).maxMs;
    assert.ok(w('probe settings-open') < 1500, `the open: ${w('probe settings-open')} ms`);
    assert.ok(w('ui/api/settings') < 1500, `the settings answer: ${w('ui/api/settings')} ms`);
    for (const pg of ['Appearance', 'Downloads', 'Clips']) assert.ok(w(`probe settings-page:${pg}`) < 1000, `${pg}: ${w(`probe settings-page:${pg}`)} ms`);
  });
});
