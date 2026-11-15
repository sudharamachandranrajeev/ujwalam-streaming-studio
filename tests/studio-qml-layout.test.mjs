// SPDX-License-Identifier: GPL-3.0-or-later
// Layout probe (D389): the studio walks the main window and every Settings page under the light and dark themes, at a small
// and a large window, and reports anything outside the area that clips it, text wider than its box with no elide, and
// controls or text drawn over each other. Zero issues is the rule; there is no allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runQmlProbe, skipReason } from './helpers/qml-probe.mjs';

const PAGES = ['Appearance', 'Help & tips', 'Stream', 'Transitions', 'Connections', 'Chat & bots', 'Editing', 'Preview', 'Clips', 'Posting & growth', 'Folders', 'Advanced'];
const ACTIONS = ['layout-check:Main window', 'settings-open', ...PAGES.flatMap((p) => [`settings-page:${p}`, `layout-check:${p}`])];

for (const theme of ['ujwalam-light', 'ujwalam-night']) {
  for (const size of ['1100x680', '1920x1080']) {
    test(`layout has no overlaps or cut-off text: ${theme} at ${size}`, { skip: skipReason, timeout: 120_000 }, async () => {
      const r = await runQmlProbe({ actions: ACTIONS, ms: 12000, env: { UJWALAM_THEME: theme, UJWALAM_STUDIO_PROBE_SIZE: size } });
      assert.ok(r.p, `no probe line: ${r.err.slice(-400)}`);
      assert.deepEqual(r.p.actions.filter((a) => !a.done).map((a) => a.action), []);
      const runs = r.p.layout ?? [];
      assert.equal(runs.length, PAGES.length + 1, 'every page was checked');
      const found = runs.flatMap((l) => l.issues.map((i) => `${l.label}: ${i.kind} ${i.item} -- ${i.what}`));
      assert.deepEqual(found, []);
    });
  }
}

test('the probe window takes the requested size and records a run', { skip: skipReason, timeout: 120_000 }, async () => {
  const r = await runQmlProbe({ actions: ['layout-check:x'], ms: 4000, env: { UJWALAM_STUDIO_PROBE_SIZE: '700x420' } });
  assert.equal(r.p.layout.length, 1);
  assert.deepEqual(r.p.layout[0].size, [700, 420]);
});
