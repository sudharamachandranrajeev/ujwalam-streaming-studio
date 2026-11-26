// SPDX-License-Identifier: GPL-3.0-or-later
// Every Theme.<name> a QML file reads exists on the Theme singleton (QmlTheme in app/studio/src/qml_bridge.h).
// 2026-11-26: Main.qml's closing card read Theme.radius, which does not exist ("Unable to assign [undefined] to double").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function themeMembers() {
	const h = readFileSync(join(root, 'app/studio/src/qml_bridge.h'), 'utf8');
	const start = h.indexOf('class QmlTheme');
	const end = h.indexOf('\n};', start);
	const body = h.slice(start, end);
	const names = new Set();
	for (const m of body.matchAll(/Q_PROPERTY\([^)]*?\b(\w+)\s+READ\b/g)) names.add(m[1]);
	for (const m of body.matchAll(/Q_INVOKABLE[^(]*?\b(\w+)\s*\(/g)) names.add(m[1]);
	return names;
}

test('every Theme.<member> used in QML exists on QmlTheme', () => {
	const names = themeMembers();
	assert.ok(names.has('radiusLarge') && names.has('c'), 'parsed the Theme members');
	const dir = join(root, 'app/studio/qml');
	const missing = [];
	for (const f of readdirSync(dir, { recursive: true })) {
		if (!String(f).endsWith('.qml')) continue;
		const lines = readFileSync(join(dir, String(f)), 'utf8').split('\n');
		lines.forEach((l, i) => {
			for (const m of l.matchAll(/(?<![\w.])Theme\.(\w+)/g))
				if (!names.has(m[1])) missing.push(`${f}:${i + 1} Theme.${m[1]}`);
		});
	}
	assert.deepEqual(missing, []);
});
