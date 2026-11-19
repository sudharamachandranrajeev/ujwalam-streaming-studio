// SPDX-License-Identifier: GPL-3.0-or-later
// Layout probe (D389): the studio walks the main window and every Settings page under the light and dark themes, at a small
// and a large window, and reports anything outside the area that clips it, text wider than its box with no elide, and
// controls or text drawn over each other. Zero issues is the rule; there is no allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runQmlProbe, skipReason } from './helpers/qml-probe.mjs';

const PAGES = ['Appearance', 'Help & tips', 'Stream', 'Transitions', 'Connections', 'Chat & bots', 'Editing', 'Preview', 'Clips', 'Posting & growth', 'Folders', 'Downloads', 'Advanced'];
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

// The main window alone at more sizes (C2), in the three states a streamer sees: offline, live, and the Go live chooser open.
const MAIN = ['layout-check:Main window'];
const WAIT = ['gl-wait', 'gl-wait', 'gl-wait']; // unknown action: only gives the answers time
const goLiveOptions = {
  signedIn: true,
  outputs: [
    { id: 'youtube-h', label: 'YouTube H', orientation: 'landscape', on: true, sizes: [{ size: '1080p', key: true, bitrateKbps: 12000 }, { size: '1440p', key: true, bitrateKbps: 24000 }], size: '1440p' },
    { id: 'youtube-v', label: 'YouTube V', orientation: 'portrait', on: true, sizes: [{ size: '1080p', key: true, bitrateKbps: 12000 }], size: '1080p' },
  ],
  existing: [{ id: 'ev-1', title: 'Ranked grind tonight', lifeCycle: 'upcoming', when: '2026-11-16T18:00:00Z', boundToOther: false }],
  past: [{ id: 'pb-1', title: 'Friday night stream', when: '2026-11-13T18:00:00Z' }],
  last: { 'youtube-h': { id: 'pb-1', title: 'Friday night stream', when: '2026-11-13T18:00:00Z' }, 'youtube-v': null },
  choice: null,
  setupInUse: true,
};
const answerGoLive = (url) => {
  if (url === '/ui/api/youtube/golive/options') return [200, goLiveOptions];
  if (url === '/ui/api/youtube/categories') return [200, { categories: [{ id: '20', title: 'Gaming' }] }];
  return null;
};
const STATES = {
  'offline': {},
  'live': { live: true },
  'Go live dialog open': { answer: answerGoLive, extra: ['yt-golive', ...WAIT, ...WAIT] },
};

for (const theme of ['ujwalam-light', 'ujwalam-night']) {
  for (const size of ['1100x680', '1280x720', '1920x1080', '2560x1440']) {
    for (const [state, o] of Object.entries(STATES)) {
      if (state === 'offline' && (size === '1100x680' || size === '1920x1080')) continue; // covered with the Settings pages above
      test(`main window, ${state}: no overlaps or cut-off text: ${theme} at ${size}`, { skip: skipReason, timeout: 120_000 }, async () => {
        const r = await runQmlProbe({ actions: [...(o.extra ?? []), ...MAIN.map((a) => a.replace('Main window', `Main window, ${state}`))], ms: 11000, live: o.live, answer: o.answer,
          env: { UJWALAM_THEME: theme, UJWALAM_STUDIO_PROBE_SIZE: size } });
        assert.ok(r.p, `no probe line: ${r.err.slice(-400)}`);
        assert.deepEqual(r.p.layout[0].size, size.split('x').map(Number));
        if (state === 'live') assert.equal(r.p.state.stats.note, 'On air', 'the studio is live');
        if (state === 'Go live dialog open') assert.equal(r.p.state.goLive.open, true, 'the chooser is open');
        const found = (r.p.layout ?? []).flatMap((l) => l.issues.map((i) => `${l.label}: ${i.kind} ${i.item} -- ${i.what}`));
        assert.deepEqual(found, []);
      });
    }
  }
}

// The frame (alpha.33 feedback: "keep layers at left and give more space to layers"): scenes above the layers in a left
// column that is wider than before, the layers getting the larger share; the side panels and the stats on the right; the
// previews between; nothing over the mixer.
for (const [size, leftW] of [['1100x680', 260], ['1280x720', 260], ['1600x900', 300], ['1920x1080', 340]]) {
  test(`frame: scenes above layers on the left (${leftW} px wide), side panels and stats on the right: ${size}`, { skip: skipReason, timeout: 120_000 }, async () => {
    const r = await runQmlProbe({ actions: ['layout-check:frame'], ms: 6000, env: { UJWALAM_STUDIO_PROBE_SIZE: size } });
    assert.ok(r.p, `no probe line: ${r.err.slice(-400)}`);
    const f = r.p.state.frame;
    const [sx, sy, sw, sh] = f.scenes, [lx, ly, lw, lh] = f.layers, [px, , pw] = f.previews, [dx, dy, dw] = f.side, [tx, ty] = f.stats, [, my] = f.mixer;
    assert.deepEqual([sw, lw], [leftW, leftW], 'one left column of that width');
    assert.equal(lx, sx, 'layers under the scenes, same column');
    assert.ok(ly >= sy + sh, 'layers below the scenes');
    assert.ok(lh > sh, `layers get the larger share (${lh} vs ${sh})`);
    assert.ok(sh >= 150, 'the scenes keep a usable minimum');
    assert.ok(ly + lh <= my, 'the layers end above the mixer');
    assert.ok(px >= sx + sw && px + pw <= dx, 'previews between the columns');
    assert.equal(dx, tx, 'side panels and stats share the right column');
    assert.ok(dy <= sy + 1, 'the side panels start at the top of the column (no room kept for layers there)');
    assert.ok(dw > 0 && ty < my, 'the stats sit above the mixer');
  });
}

test('the probe window takes the requested size and records a run', { skip: skipReason, timeout: 120_000 }, async () => {
  const r = await runQmlProbe({ actions: ['layout-check:x'], ms: 4000, env: { UJWALAM_STUDIO_PROBE_SIZE: '700x420' } });
  assert.equal(r.p.layout.length, 1);
  assert.deepEqual(r.p.layout[0].size, [700, 420]);
});
