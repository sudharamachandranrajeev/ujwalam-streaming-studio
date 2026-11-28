// SPDX-License-Identifier: GPL-3.0-or-later
// Molten Stone (docs/plan/2026-11-27-molten-stone-theme.md). Part 1 (files, no Qt): the texture generator is
// deterministic and small, the pack's texture block matches what it paints, the schema and the loader refuse unknown
// surfaces, the painted faces keep the text contrast, the new controls follow the effect and loop rules (no effect items;
// the only loops are the ambient smoke and drips, built only when Theme.ambient allows them, and the busy swirl, a status
// light), and every new control has a real place in the studio. Part 2 (headless probe, never on screen; skipped when the
// studio shell is not built): with Molten Stone, full fx off air builds the ambient loop items; on air and High
// performance build none.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { ART, FACES, OUT_DIR, SLICES, render } from '../tools/theme-textures/molten-stone.mjs';
import { contrast } from '../services/studio-ui/theme-contrast.mjs';
import { createFakeHost } from '../services/studio-ui/backends.mjs';
import { createFlags } from '../services/flags/index.mjs';
import { createStudioServer } from '../services/studio-ui/server.mjs';
import { EXE, qtDir } from '../app/studio/tools/build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');
const pack = JSON.parse(text('data', 'themes', 'molten-stone.json'));
const QML = path.join(REPO, 'app', 'studio', 'qml');
const NEW = ['UTexture', 'UAmbient', 'UCheckbox', 'URadio', 'UBreadcrumbs', 'UPagination', 'USteps', 'UTipDrop', 'UAvatar', 'UTableHeader', 'USkeleton', 'UProgress', 'UEmptyState', 'UBusySwirl'];
const hex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const lift = (rgb) => rgb.map((v, i) => v + ([235, 232, 228][i] - v) * 0.08); // the top light the generator adds (8 percent)

describe('Molten Stone files', () => {
  test('the generator is deterministic: the committed pictures are exactly what it paints; 1x and 2x of each; under 1.5 MB', () => {
    const files = render();
    let total = 0;
    for (const [f, b] of files) {
      total += b.length;
      assert.ok(readFileSync(path.join(OUT_DIR, f)).equals(b), `${f} differs from the generator (run node tools/theme-textures/molten-stone.mjs)`);
    }
    for (const n of [...Object.keys(SLICES), ...Object.keys(ART)]) for (const f of [`${n}.png`, `${n}@2x.png`]) assert.ok(files.has(f), f);
    assert.deepEqual(readdirSync(OUT_DIR).sort(), [...files.keys()].sort(), 'no stray files in the texture folder');
    assert.ok(total < 1.5 * 1024 * 1024, `${total} bytes`);
  });

  test('the pack names every slice with the generator\'s margin and outset, and every picture it uses exists', () => {
    const sl = pack.texture.slices;
    assert.deepEqual(Object.keys(sl).sort(), Object.keys(SLICES).sort());
    for (const [n, s] of Object.entries(SLICES)) assert.deepEqual([sl[n].margin, sl[n].outset], [s.m, s.o], n);
    assert.deepEqual([...pack.texture.art].sort(), Object.keys(ART).sort());
    for (const n of [...Object.keys(sl), ...pack.texture.art]) assert.ok(existsSync(path.join(OUT_DIR, `${n}.png`)), n);
    assert.equal(pack.componentsAlways, true);
    assert.deepEqual(pack.ambient, { smoke: true, drip: true });
  });

  test('the schema refuses an unknown surface, picture or ambient part, and an outset as wide as the margin is refused by the loader', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(JSON.parse(text('data', 'themes', 'theme.schema.json')));
    assert.ok(validate(pack), JSON.stringify(validate.errors));
    const bad = (mut) => { const t = structuredClone(pack); mut(t); return validate(t); };
    assert.equal(bad((t) => { t.texture.slices.lava = { margin: 4, outset: 0 }; }), false);
    assert.equal(bad((t) => { t.texture.art.push('face'); }), false);
    assert.equal(bad((t) => { t.ambient.rain = true; }), false);
    assert.equal(bad((t) => { t.texture.slices.base.tile = 'mirror'; }), false);
    const cpp = text('app', 'studio', 'src', 'theme.cpp');
    assert.match(cpp, /outset"\)\)\.toInt\(\) >= s\.value\(QStringLiteral\("margin"\)\)\.toInt\(\)/, 'the loader refuses outset >= margin');
    assert.match(cpp, /if \(const QString why = textureProblem\(o\); !why\.isEmpty\(\)\)/, 'packProblem checks the texture block');
  });

  test('text on the painted faces keeps 4.5:1 (body and muted on cards, plates, rows and the slab; the title on the slab); a disabled label 3:1', () => {
    const c = pack.colors;
    for (const face of ['card', 'modal', 'plate', 'toast', 'buttonNormal'])
      for (const end of FACES[face])
        for (const shade of [end, lift(end)])
          for (const ink of ['text', 'muted']) {
            const r = contrast(c[ink], hex(shade));
            assert.ok(r >= 4.5, `${ink} on ${face} ${hex(shade)} = ${r.toFixed(2)}`);
          }
    for (const end of FACES.modal) assert.ok(contrast(c.accentHi, hex(lift(end))) >= 4.5, `the slab title on ${hex(lift(end))}`);
    for (const end of FACES.buttonDisabled) assert.ok(contrast(c.onAccent, hex(end)) >= 3, `the disabled label on ${hex(end)}`);
  });

  test('new controls: SPDX, LF, no effect items; loops only in UAmbient (inside a Loader gated by Theme.ambient), UProgress (the unknown-amount sweep, as before) and UBusySwirl (a status light)', () => {
    for (const n of NEW) {
      const src = text('app', 'studio', 'qml', `${n}.qml`);
      assert.ok(src.startsWith('// SPDX-License-Identifier: GPL-3.0-or-later\n'), n);
      assert.ok(!src.includes('\r'), `${n} uses LF`);
      const code = src.replace(/\/\/.*$/gm, '');
      assert.ok(!/MultiEffect|ShaderEffect/.test(code), `${n} uses no effect item`);
      const loops = (code.match(/Animation\.Infinite/g) ?? []).length;
      if (n === 'UAmbient') assert.equal(loops, 1);
      else if (n === 'UBusySwirl') assert.equal(loops, 2);
      else if (n === 'UProgress') assert.equal(loops, 1);
      else assert.equal(loops, 0, `${n} has no loop`);
      for (const m of code.matchAll(/duration:\s*(\d+)/g)) if (n !== 'UAmbient' && n !== 'UBusySwirl' && n !== 'UProgress') assert.ok(Number(m[1]) < 400, `${n}: ${m[0]}`);
    }
    const amb = text('app', 'studio', 'qml', 'UAmbient.qml');
    assert.match(amb, /readonly property bool moving: Theme\.ambient\[kind\] !== undefined && a\.visible && Window\.active/);
    assert.match(amb, /Loader \{\n\s+anchors\.fill: parent\n\s+active: a\.moving/);
    const cpp = text('app', 'studio', 'src', 'qml_bridge.cpp');
    assert.match(cpp, /if \(fx\(\) != QStringLiteral\("full"\) \|\| onAir_ \|\| !motion\(\)\)\n\t\treturn out;/, 'ambient only in full fx, off air, animations on');
    assert.match(cpp, /QVariantMap QmlTheme::tex\(\) const\n\{\n\tQVariantMap out;\n\tif \(fx\(\) == QStringLiteral\("plain"\)\)\n\t\treturn out;/, 'no painted surfaces in plain fx');
    const swirl = text('app', 'studio', 'qml', 'UBusySwirl.qml');
    assert.match(swirl, /readonly property bool turning: running && visible && Theme\.motion/);
  });

  test('every new control has a real place in the studio, and every new file is compiled in', () => {
    const files = readdirSync(QML).filter((f) => f.endsWith('.qml'));
    const uses = (n) => files.filter((f) => f !== `${n}.qml` && new RegExp(`\\b${n} \\{`).test(readFileSync(path.join(QML, f), 'utf8'))).map((f) => f.replace('.qml', ''));
    const outside = (n) => uses(n).filter((f) => !NEW.includes(f));
    for (const n of NEW) assert.ok(uses(n).length > 0, `${n} is used`);
    for (const n of ['UCheckbox', 'URadio', 'UBreadcrumbs', 'UPagination', 'USteps', 'UAvatar', 'UTableHeader', 'USkeleton', 'UProgress', 'UEmptyState', 'UBusySwirl', 'UTexture'])
      assert.ok(outside(n).length > 0, `${n} sits in a screen of the studio: ${uses(n)}`);
    const cm = text('app', 'studio', 'CMakeLists.txt');
    for (const n of NEW) assert.ok(cm.includes(`qml/${n}.qml`), `${n} in CMakeLists.txt`);
    assert.ok(cm.includes('data/theme-textures/*/*.png'), 'the pictures are embedded');
    assert.match(text('app', 'studio', 'qml', 'Main.qml'), /t\.background = tipBack\.createObject\(t\)/, 'the tooltip has the drop pointer');
  });

  test('no picture is a face or private: the empty-state astronaut has a closed visor and the avatar is a spiral (generator source)', () => {
    const src = text('tools', 'theme-textures', 'molten-stone.mjs');
    assert.match(src, /the visor: closed, reflective rose gold \(no face\)/);
    assert.match(src, /a stone disc with a rose-gold spiral in relief \(no face\)/);
    assert.ok(!/https?:\/\//.test(src.replace(/\/\/.*$/gm, '')), 'nothing is downloaded');
    for (const f of readdirSync(OUT_DIR)) assert.ok(statSync(path.join(OUT_DIR, f)).size < 200 * 1024, f);
  });
});

const PACKAGED = process.env.UJWALAM_STUDIO_TEST_EXE ? path.resolve(process.env.UJWALAM_STUDIO_TEST_EXE) : null;
const SHELL_EXE = PACKAGED ?? EXE;
const QT = PACKAGED ? null : qtDir();
const skip = !existsSync(SHELL_EXE) || (!PACKAGED && !QT) ? 'studio shell not built (npm run build:studio)' : false;

describe('Molten Stone in the studio window (headless probe)', { skip }, () => {
  const dirs = [];
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  async function probe({ actions = [], live = false, ms = 9000 } = {}) {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ujw-molten-'));
    dirs.push(dataDir);
    const fake = createFakeHost({ outputsReady: true });
    if (live) await fake.call('stream.start', {});
    const host = { describe: () => fake.describe(), call: (m, p) => fake.call(m, p) };
    const core = { describe: () => ({ available: false }), call: async () => null, confirm: async () => null };
    const key = 'm'.repeat(40);
    const srv = createStudioServer({ uiRoot: path.join(REPO, 'ui'), core, host, launchKey: key, dataDir, flags: createFlags({ dataDir }), authority: null, limits: { statusPollMs: 50 }, log: () => {} });
    const { port } = await srv.listen();
    try {
      const r = await new Promise((resolve) => {
        const child = spawn(SHELL_EXE, [], {
          windowsHide: true,
          env: { ...process.env, ...(QT ? { PATH: `${path.join(QT, 'bin')}${path.delimiter}${process.env.PATH}` } : {}), UJWALAM_HEADLESS: '1', UJWALAM_THEME: 'molten-stone',
            QT_QPA_FONTDIR: path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
            UJWALAM_UI_URL: `http://127.0.0.1:${port}/`, UJWALAM_UI_LAUNCH_KEY: key, UJWALAM_STUDIO_PROBE_MS: String(ms), UJWALAM_STUDIO_PROBE_ACTIONS: actions.join(',') },
        });
        let out = '', err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        const t = setTimeout(() => child.kill(), ms + 30_000);
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
      });
      assert.equal(r.code, 0, r.err);
      const m = /^studio probe: (.+)$/m.exec(r.out);
      assert.ok(m, `no probe line: ${r.out} ${r.err}`);
      assert.doesNotMatch(r.err, /\.qml:\d+.*(Error|TypeError|ReferenceError|Unable to assign|binding loop)/i, 'no QML errors');
      const p = JSON.parse(m[1]);
      return { p, s: p.state, ambient: p.tree.filter((n) => n.name === 'moltenAmbient').length, err: r.err };
    } finally { await srv.close(); }
  }
  const SHOW = ['settings-open', 'settings-page:Appearance', 'settings-reduce-effects:on'];

  test('full fx off air: the theme loads with no QML error; a checked switch on the Appearance page smokes', async () => {
    const r = await probe({ actions: ['settings-open', 'settings-page:Appearance'] });
    assert.equal(r.p.theme, 'molten-stone');
    assert.equal(r.s.fx, 'full');
    assert.ok(r.ambient > 0, 'the smoke loop exists in full fx off air');
  });

  test('on air: fx plain, no ambient loop exists', async () => {
    const r = await probe({ actions: SHOW, live: true });
    assert.equal(r.s.fx, 'plain');
    assert.equal(r.ambient, 0);
  });

  test('High performance: no ambient loop exists', async () => {
    const r = await probe({ actions: ['effects:performance', ...SHOW], ms: 11000 });
    assert.equal(r.s.fx, 'plain');
    assert.equal(r.ambient, 0);
  });
});
