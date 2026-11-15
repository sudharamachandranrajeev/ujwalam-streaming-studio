// SPDX-License-Identifier: GPL-3.0-or-later
// RareUI redesign, slice 0 (D384): no visual change. The theme schema accepts the new optional keys and still accepts
// every shipped theme unchanged, the C++ component list matches the schema's variants (a pack using a new variant is
// not refused by the studio), the flag rareui-look exists and is off, the new QML helpers exist, carry the credit line
// and are in the build list, the Theme.fx mapping and the spring defaults are in place, and the MIT notice is written.
// Pure file and schema checks: no Qt, no build, no window.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { DEFAULT_FLAGS_FILE, FLAG_PAGES, loadDefinitions } from '../services/flags/index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');
const schema = JSON.parse(text('data', 'themes', 'theme.schema.json'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const packs = readdirSync(path.join(REPO, 'data', 'themes')).filter((f) => f.endsWith('.json') && f !== 'theme.schema.json').map((f) => JSON.parse(text('data', 'themes', f)));
const ok = (mut) => { const t = structuredClone(packs.find((p) => p.id === 'violet-night')); mut(t); return validate(t); };

describe('theme schema additions (all optional, no version bump)', () => {
  test('every shipped theme still validates unchanged and the schema is still version 2', () => {
    assert.ok(packs.length >= 5);
    for (const t of packs) assert.ok(validate(t), `${t.id}: ${JSON.stringify(validate.errors)}`);
    assert.match(schema.title, /schema v2/);
  });

  test('none of the new keys is required', () => {
    assert.ok(!schema.required.includes('components'));
    assert.ok(!schema.properties.colors.required.some((k) => k === 'warn' || k === 'info'));
    assert.ok(!schema.properties.motion.required.some((k) => ['spring', 'enterMs', 'exitMs', 'loopMs'].includes(k)));
    assert.ok(!schema.properties.background.required.includes('animated'));
  });

  test('a theme using every new key validates', () => {
    assert.equal(ok((t) => {
      t.colors.warn = '#e0a030'; t.colors.info = '#4aa3ff';
      t.typography.display = 'Georgia'; t.typography.mono = 'Consolas';
      t.motion.spring = { stiffness: 300, damping: 30, mass: 1 };
      t.motion.enterMs = 350; t.motion.exitMs = 300; t.motion.loopMs = 0;
      t.background.animated = 'waves';
      t.components = {
        button: { style: 'glass' }, tabs: 'slide', tooltip: 'liquid', spinner: 'ring', help: 'book', clips: 'expand', card: 'tilt',
        toast: { style: 'stack', richColors: true, position: 'bottom-right', maxVisible: 3, swipe: true },
        text: { entrance: 'vapor', hover: 'magnet' },
      };
    }), true, JSON.stringify(validate.errors));
    for (const style of ['glass', 'premium', 'pixel', 'liquid']) assert.equal(ok((t) => { t.components = { button: { style } }; }), true, style);
    for (const tabs of ['slide', 'avatar', 'dock']) assert.equal(ok((t) => { t.components = { tabs }; }), true, tabs);
    for (const card of ['tilt', 'shatter']) assert.equal(ok((t) => { t.components = { card }; }), true, card);
    assert.equal(ok((t) => { t.motion.spring = { stiffness: 200 }; }), true, 'a spring part may be left out');
  });

  test('bad values for the new keys are refused', () => {
    assert.equal(ok((t) => { t.colors.warn = 'orange'; }), false);
    assert.equal(ok((t) => { t.motion.enterMs = 601; }), false, 'entrance limit 600');
    assert.equal(ok((t) => { t.motion.exitMs = 401; }), false, 'exit limit 400');
    assert.equal(ok((t) => { t.motion.spring = { stiffness: 300, wobble: 1 }; }), false);
    assert.equal(ok((t) => { t.motion.spring = { mass: 0 }; }), false);
    assert.equal(ok((t) => { t.background.animated = 'fire'; }), false);
    assert.equal(ok((t) => { t.components = { tooltip: 'neon' }; }), false);
    assert.equal(ok((t) => { t.components = { toast: { maxVisible: 6 } }; }), false);
    assert.equal(ok((t) => { t.components = { toast: { position: 'middle' } }; }), false);
    assert.equal(ok((t) => { t.components = { toast: { extra: 1 } }; }), false);
    assert.equal(ok((t) => { t.components = { text: { entrance: 'explode' } }; }), false);
    assert.equal(ok((t) => { t.components = { spinner: 'wheel' }; }), false);
    assert.equal(ok((t) => { t.typography.display = ''; }), false);
    assert.equal(ok((t) => { t.newKey = 1; }), false, 'unknown top-level keys are still refused');
  });

  test('the studio (theme.cpp) lists every component variant the schema does, so no valid pack is refused', () => {
    const cpp = text('app', 'studio', 'src', 'theme.cpp');
    const block = cpp.slice(cpp.indexOf('componentVariants()\n{'), cpp.indexOf('void setComponents')).split('\n').join(' ');
    const want = [];
    for (const [k, v] of Object.entries(schema.properties.components.properties)) {
      if (v.enum) want.push([k, v.enum]);
      else if (v.type === 'object') for (const [sk, sv] of Object.entries(v.properties)) if (sv.enum) want.push([`${k}.${sk}`, sv.enum]);
    }
    assert.ok(want.length >= 20, `${want.length} enumerated component keys`);
    for (const [key, variants] of want) {
      const m = block.match(new RegExp(`QStringLiteral\\("${key.replace('.', '\\.')}"\\),\\s*\\{([^}]*)\\}`));
      assert.ok(m, `${key} is listed in componentVariants()`);
      for (const v of variants) assert.ok(m[1].includes(`"${v}"`), `${key}: ${v}`);
    }
    assert.ok(cpp.includes('toast.maxVisible'), 'the toast count is checked as a number');
    assert.ok(cpp.includes('k == QStringLiteral("toast")') && cpp.includes('k == QStringLiteral("text")'), 'toast and text are object blocks');
  });
});

describe('feature flag rareui-look', () => {
  test('registered, off by default, on the appearance page', () => {
    const d = loadDefinitions(DEFAULT_FLAGS_FILE).find((f) => f.id === 'rareui-look');
    assert.ok(d, 'rareui-look is in data/flags.json');
    assert.equal(d.default, false);
    assert.equal(d.page, 'appearance');
    assert.ok(FLAG_PAGES.includes(d.page));
    assert.match(d.description, /plain look while a stream or recording runs/);
  });
});

describe('Theme.fx, the spring and the shadow helper', () => {
  test('theme.cpp maps effects and on-air state: on air or performance = plain, reduced = calm, else full', () => {
    const cpp = text('app', 'studio', 'src', 'theme.cpp');
    const fn = cpp.slice(cpp.indexOf('QString fxLevel('), cpp.indexOf('QList<Info> available()'));
    assert.match(fn, /onAir \|\| effectsMode == QStringLiteral\("performance"\)\)\s*return QStringLiteral\("plain"\)/);
    assert.match(fn, /"reduced"\)\)?\s*\)?\s*return QStringLiteral\("calm"\)/);
    assert.match(fn, /return QStringLiteral\("full"\)/);
  });

  test('QmlTheme exposes fx, onAir and spring, and the Store sets onAir from live or recording', () => {
    const h = text('app', 'studio', 'src', 'qml_bridge.h');
    assert.match(h, /Q_PROPERTY\(QString fx READ fx NOTIFY fxChanged\)/);
    assert.match(h, /Q_PROPERTY\(bool onAir READ onAir WRITE setOnAir NOTIFY fxChanged\)/);
    assert.match(h, /Q_PROPERTY\(QVariantMap spring READ spring NOTIFY changed\)/);
    const store = text('app', 'studio', 'qml', 'Store.qml');
    assert.match(store, /readonly property bool onAirNow: live \|\| recording/);
    assert.match(store, /onOnAirNowChanged: Theme\.onAir = onAirNow/);
  });

  test('theme.h keeps the spring defaults 300 / 30 / 1', () => {
    assert.match(text('app', 'studio', 'src', 'theme.h'), /qreal stiffness = 300, damping = 30, mass = 1;/);
  });

  test('USpring.qml and ShadowLayers.qml exist, carry the credit and SPDX lines, and are in the build list', () => {
    const cmake = text('app', 'studio', 'CMakeLists.txt');
    for (const f of ['USpring.qml', 'ShadowLayers.qml']) {
      const src = text('app', 'studio', 'qml', f);
      assert.ok(src.startsWith('// SPDX-License-Identifier: GPL-3.0-or-later\n'), f);
      assert.ok(src.includes('Design after RareUI (MIT, Swapnil Kalambe)'), f);
      assert.ok(!src.includes('\r'), `${f} uses LF`);
      assert.ok(!/MultiEffect|ShaderEffect/.test(src.replace(/\/\/.*$/gm, '')), `${f} uses no effect item`);
      assert.ok(cmake.includes(`qml/${f}`), `${f} in CMakeLists.txt`);
    }
    const sp = text('app', 'studio', 'qml', 'USpring.qml');
    assert.match(sp, /FrameAnimation/);
    assert.match(sp, /Theme\.spring\.stiffness/);
    assert.match(sp, /Theme\.fx === "plain"/);
  });

  test('the spring maths of USpring.qml settles on its target (same equation, run here)', () => {
    const settle = (k, c, m, x0, to) => {
      let x = x0, v = 0, t = 0;
      for (; t < 5; t += 1 / 240) {
        v += ((-k * (x - to) - c * v) / m) / 240;
        x += v / 240;
        if (Math.abs(v) < 0.01 && Math.abs(x - to) < 0.001) return { t, x };
      }
      return { t, x };
    };
    const r = settle(300, 30, 1, 0, 1);
    assert.ok(r.t < 2, `rests in ${r.t.toFixed(2)} s`);
    assert.ok(Math.abs(r.x - 1) < 0.002);
    const src = text('app', 'studio', 'qml', 'USpring.qml');
    assert.ok(src.includes('const a = (-k * (x - to) - c * v) / m'), 'the QML uses the same equation');
    assert.ok(src.includes('const h = 1 / 240'));
  });
});

describe('credit', () => {
  test('the RareUI MIT notice is in docs/third-party-notices.md and Sonner is marked unverified', () => {
    const n = text('docs', 'third-party-notices.md');
    assert.match(n, /Copyright \(c\) 2025 Swapnil Kalambe \(RareUI\)/);
    assert.match(n, /Permission is hereby granted, free of charge/);
    assert.match(n, /Sonner[^\n]*UNVERIFIED/);
  });
});
