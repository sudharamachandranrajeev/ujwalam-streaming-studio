// SPDX-License-Identifier: GPL-3.0-or-later
// D388 A: named YouTube quality presets (services/studio-ui/youtube-presets.mjs). A fake host (outputs.status states,
// outputs.configure recorded) like the D387 test, a temp data folder, a fake key-presence map: no process, no platform,
// no Credential Manager, no network.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { planFile } from '../app/host/lib/outputs-plan.mjs';
import { CHOICES_FILE, readChoices } from '../services/platform-connect/youtube-events.mjs';
import { createSettingsRoutes } from '../services/studio-ui/settings-routes.mjs';
import { PENDING_FILE, livePlanFile, writeLiveStart } from '../services/studio-ui/stream-apply.mjs';
import { SETUP_FILE, seedSetup, writeSetup } from '../services/studio-ui/stream-setup.mjs';
import { MAX_PRESETS, PRESETS_FILE, createYoutubePresets } from '../services/studio-ui/youtube-presets.mjs';

const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-ytp-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function fakeHost() {
  const h = {
    states: { 'youtube-h': 'idle', 'youtube-v': 'idle', twitch: 'idle', kick: 'idle', record: 'idle' },
    calls: [], configures: [],
    async call(m, p) {
      h.calls.push(m);
      if (m === 'outputs.status') return { sinks: Object.entries(h.states).map(([id, state]) => ({ id, kind: id.startsWith('record') ? 'record' : 'stream', state })) };
      if (m === 'outputs.configure') { h.configures.push(p); return { configured: true }; }
      throw Object.assign(new Error('method-not-found'), { code: 'NO_METHOD' });
    },
  };
  return h;
}

const EVENTS_BODY = { signedIn: true, outputs: [{ id: 'youtube-h', label: 'YouTube H', canvas: 'H', quality: '1080p', choice: null }] };
const readSetupFile = (d) => { const { $comment, ...s } = JSON.parse(readFileSync(path.join(d, SETUP_FILE), 'utf8')); return s; };

function boot({ flagOn = true, keys } = {}) {
  const dataDir = mk();
  const host = fakeHost();
  writeLiveStart(dataDir, { live: true, planFile: path.join(dataDir, 'outputs', 'stream-setup-plan.json'), paramsFile: path.join(dataDir, 'host', 'outputs-params.json'), instagram: false, select: null, readSchemes: false });
  assert.ok(writeSetup(dataDir, seedSetup(), { upscale: true }).ok);
  const rows = keys ?? new Map([['youtube-h', true], ['youtube-v', true], ['youtube-h-1440p', true], ['youtube-v-1440p', true], ['youtube-h-2160p', true], ['youtube-v-2160p', true]]);
  const settings = createSettingsRoutes({
    dataDir, host, flags: { isOn: (id) => flagOn && id === 'stream-settings' },
    json: (res, status, body) => { res.status = status; res.body = body; }, startGuard: { starting: () => false },
  });
  const logs = [];
  const presets = createYoutubePresets({
    dataDir, settings, json: (res, status, body) => { res.status = status; res.body = body; }, log: (l) => logs.push(l),
    readSetup: (d) => ({ exists: true, setup: readSetupFile(d) }),
    keyPresence: async () => rows, events: async () => EVENTS_BODY,
  });
  const call = async (method, route, body) => { const res = {}; const handled = await presets.handle(method, route, body, res); return { handled, status: res.status, body: res.body }; };
  return { dataDir, host, settings, presets, call, setupNow: () => readSetupFile(dataDir), rows, logs };
}
const outs = (h = {}, v = {}) => ({
  'youtube-h': { enabled: true, size: '2160p', bitrateKbps: 50000, templateId: 'tplH0001', templateTitle: 'Ranked', title: null, ...h },
  'youtube-v': { enabled: true, size: '1440p', bitrateKbps: 20000, templateId: 'tplV0001', templateTitle: 'Vertical', title: null, ...v },
});
const preset = (over = {}) => ({ name: '4K ranked', outputs: outs(), ...over });
const launcherParams = (dataDir) => planFile(livePlanFile({ dataDir, streamSettingsOn: true }), { allowLive: true }).params;
const save = (c, p) => c.call('POST', '/ui/api/youtube/preset/save', { preset: p });

describe('store validation', () => {
  const bad = {
    'empty name': preset({ name: '  ' }), 'name 41 chars': preset({ name: 'x'.repeat(41) }), 'angle brackets': preset({ name: '<b>x</b>' }),
    'control char': preset({ name: 'a\u0007b' }), 'name not a string': preset({ name: 5 }),
    'unknown H size': preset({ outputs: outs({ size: '720p' }) }), 'V portrait id': preset({ outputs: outs({}, { size: '1440x2560' }) }),
    'bitrate over the platform limit': preset({ outputs: outs({ bitrateKbps: 50001 }) }), 'bitrate zero': preset({ outputs: outs({ bitrateKbps: 0 }) }),
    'bitrate fraction': preset({ outputs: outs({ bitrateKbps: 17000.5 }) }), 'bitrate string': preset({ outputs: outs({ bitrateKbps: '17000' }) }),
    'enabled not boolean': preset({ outputs: outs({ enabled: 1 }) }), 'bad template id': preset({ outputs: outs({ templateId: 'bad id!' }) }),
    'title with angle bracket': preset({ outputs: outs({ title: 'a<b' }) }), 'template title without template': preset({ outputs: outs({ templateId: null, templateTitle: 'x' }) }),
    'unknown preset key': { ...preset(), extra: 1 }, 'unknown output key': preset({ outputs: outs({ key: 'x' }) }),
    'unknown output': preset({ outputs: { ...outs(), 'youtube-x': outs()['youtube-h'] } }), 'V missing': preset({ outputs: { 'youtube-h': outs()['youtube-h'] } }),
    'bad id': { id: 'p-nothex!!', ...preset() }, 'not an object': 'x',
  };
  for (const [name, p] of Object.entries(bad)) {
    test(`refused: ${name}`, async () => {
      const c = boot();
      const r = await save(c, p);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, 'bad-preset');
      assert.equal(existsSync(path.join(c.dataDir, PRESETS_FILE)), false, 'nothing written');
    });
  }
  test('a bitrate at the platform maximum is accepted, from data/platforms (not hardcoded here)', async () => {
    const c = boot();
    const g = await c.call('GET', '/ui/api/youtube/presets');
    const lim = g.body.limits['youtube-h']['2160p'];
    assert.ok(lim.max >= 50000 && lim.min >= 1 && lim.default >= lim.min && lim.default <= lim.max);
    const r = await save(c, preset({ outputs: outs({ bitrateKbps: lim.max }) }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await save(c, preset({ outputs: outs({ bitrateKbps: lim.max + 1 }) }))).status, 400);
  });
  test('save body with another key, and bad methods and bodies', async () => {
    const c = boot();
    assert.equal((await c.call('POST', '/ui/api/youtube/preset/save', { preset: preset(), x: 1 })).status, 400);
    assert.equal((await c.call('POST', '/ui/api/youtube/preset/save', null)).status, 400);
    assert.equal((await c.call('POST', '/ui/api/youtube/preset/save', [])).status, 400);
    assert.equal((await c.call('GET', '/ui/api/youtube/preset/save')).status, 405);
    assert.equal((await c.call('POST', '/ui/api/youtube/presets', {})).status, 405);
    assert.equal((await c.call('GET', '/ui/api/other')).handled, false);
  });
});

describe('save, delete, active', () => {
  test('no data folder: built without a crash; every preset route answers 409 no-data-dir', async () => {
    const out = {};
    const p = createYoutubePresets({ dataDir: undefined, settings: {}, json: (res, status, body) => { res.status = status; res.body = body; }, readSetup: () => ({ exists: false }), keyPresence: async () => new Map(), events: async () => EVENTS_BODY });
    assert.equal(await p.handle('GET', '/ui/api/youtube/presets', null, out), true);
    assert.deepEqual([out.status, out.body.error], [409, 'no-data-dir']);
    assert.equal(await p.handle('GET', '/ui/api/youtube/account', null, {}), false, 'not a preset route');
  });
  test('new preset gets a p-<8 hex> id; update keeps it; unknown id 404; delete clears activeId', async () => {
    const c = boot();
    const r = await save(c, preset());
    assert.equal(r.status, 200);
    assert.match(r.body.preset.id, /^p-[0-9a-f]{8}$/);
    assert.equal(r.body.preset.outputs['youtube-h'].size, '2160p');
    const id = r.body.preset.id;
    const u = await save(c, { id, ...preset({ name: 'Renamed' }) });
    assert.equal(u.status, 200);
    assert.equal(u.body.presets.length, 1);
    assert.equal(u.body.presets[0].name, 'Renamed');
    assert.equal((await save(c, { id: 'p-00000000', ...preset() })).status, 404);
    await c.call('POST', '/ui/api/youtube/preset/use', { id });
    assert.equal((await c.call('GET', '/ui/api/youtube/presets')).body.activeId, id);
    const d = await c.call('POST', '/ui/api/youtube/preset/delete', { id });
    assert.equal(d.status, 200);
    assert.deepEqual([d.body.presets, d.body.activeId], [[], null]);
    assert.equal((await c.call('POST', '/ui/api/youtube/preset/delete', { id })).status, 404);
    assert.equal(JSON.parse(readFileSync(path.join(c.dataDir, PRESETS_FILE), 'utf8')).version, 1);
    assert.equal(existsSync(path.join(c.dataDir, `${PRESETS_FILE}.tmp`)), false, 'atomic: no tmp left');
  });
  test(`at most ${MAX_PRESETS} presets; an update at the limit is still allowed`, async () => {
    const c = boot();
    let last;
    for (let i = 0; i < MAX_PRESETS; i++) last = await save(c, preset({ name: `P${i}` }));
    assert.equal(last.status, 200);
    const r = await save(c, preset({ name: 'one too many' }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'too-many-presets');
    assert.equal((await save(c, { id: last.body.preset.id, ...preset({ name: 'edit' }) })).status, 200);
    assert.equal((await c.call('GET', '/ui/api/youtube/presets')).body.presets.length, MAX_PRESETS);
  });
  test('a hand-edited store: invalid presets are dropped, an unknown activeId is cleared, a corrupt file reads empty', async () => {
    const c = boot();
    const good = (await save(c, preset())).body.preset;
    const f = path.join(c.dataDir, PRESETS_FILE);
    writeFileSync(f, JSON.stringify({ version: 1, activeId: 'p-ffffffff', presets: [good, { id: 'p-11111111', name: '', outputs: {} }, { ...good, extra: 1 }] }));
    const g = (await c.call('GET', '/ui/api/youtube/presets')).body;
    assert.deepEqual(g.presets, [good]);
    assert.equal(g.activeId, null);
    writeFileSync(f, '{nope');
    assert.deepEqual((await c.call('GET', '/ui/api/youtube/presets')).body.presets, []);
  });
  test('GET: sizes per output from the setup lists, limits, key presence as booleans only, setupInUse', async () => {
    const keys = new Map([['youtube-h', true], ['youtube-h-2160p', false], ['youtube-v-1440p', true]]);
    const c = boot({ keys });
    const g = (await c.call('GET', '/ui/api/youtube/presets')).body;
    assert.deepEqual(g.sizes['youtube-h'], ['1080p', '1440p', '2160p']);
    assert.deepEqual(g.sizes['youtube-v'], ['1080p', '1440p', '2160p']);
    assert.deepEqual(g.keys['youtube-h'], { '1080p': true, '1440p': false, '2160p': false });
    assert.deepEqual(g.keys['youtube-v'], { '1080p': false, '1440p': true, '2160p': false });
    for (const o of Object.values(g.keys)) for (const v of Object.values(o)) assert.equal(typeof v, 'boolean');
    assert.equal(g.setupInUse, true);
    assert.equal((await boot({ flagOn: false }).call('GET', '/ui/api/youtube/presets')).body.setupInUse, false);
  });
});

describe('use', () => {
  test('idle: only the YouTube H/V size, bitrate and enabled change; configure runs once with the launcher params; templates written', async () => {
    const c = boot();
    const before = c.setupNow();
    // A choice for another output must survive the merge.
    writeFileSync(path.join(c.dataDir, CHOICES_FILE), JSON.stringify({ version: 1, outputs: { twitch: { templateId: 'keepme1', templateTitle: 'Keep', title: null } } }));
    const p = (await save(c, preset({ outputs: outs({}, { enabled: false }) }))).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.activeId, p.id);
    assert.equal(r.body.appliesAt, 'now');
    assert.deepEqual(r.body.missingKeys, []);
    assert.deepEqual(r.body.events, EVENTS_BODY);
    const after = c.setupNow();
    const expected = structuredClone(before);
    expected.video.output = '2160p'; expected.video.bitrateKbps = 50000;
    expected.video.portraitOutput = '1440x2560'; expected.video.portraitBitrateKbps = 20000;
    expected.outputs.find((o) => o.id === 'youtube-v').enabled = false;
    assert.deepEqual(after, expected, 'nothing but the YouTube fields differs');
    for (const id of ['twitch', 'kick']) assert.equal(JSON.stringify(after.outputs.find((o) => o.id === id)), JSON.stringify(before.outputs.find((o) => o.id === id)), `${id} byte-identical`);
    assert.equal(after.video.fps, before.video.fps);
    assert.equal(after.canvasMode, before.canvasMode);
    assert.equal(c.host.configures.length, 1);
    assert.deepEqual(c.host.configures[0], launcherParams(c.dataDir));
    assert.ok(c.host.configures[0].rungs.some((e) => e.id === 'h-main' && e.w === 3840 && e.h === 2160));
    assert.ok(!c.host.calls.includes('stream.stop') && !c.host.calls.includes('stream.start'));
    const ch = readChoices(c.dataDir);
    assert.deepEqual(ch['youtube-h'], { templateId: 'tplH0001', templateTitle: 'Ranked', title: null });
    assert.deepEqual(ch['youtube-v'], { templateId: 'tplV0001', templateTitle: 'Vertical', title: null });
    assert.equal(ch.twitch.templateId, 'keepme1', 'other outputs kept');
  });
  test('a YouTube H output with its own rung keeps the main rung untouched', async () => {
    const c = boot();
    const s = c.setupNow();
    s.outputs.find((o) => o.id === 'youtube-h').video = { output: '1080p', bitrateKbps: 17000 };
    s.video.bitrateKbps = 6000; delete s.outputs.find((o) => o.id === 'kick').video; // Kick follows the main rung, so the recording's rung still feeds a stream
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const before = c.setupNow();
    const p = (await save(c, preset())).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.body.appliesAt, 'now', JSON.stringify(r.body));
    const after = c.setupNow();
    assert.deepEqual(after.outputs.find((o) => o.id === 'youtube-h').video, { output: '2160p', bitrateKbps: 50000 });
    assert.equal(after.video.output, before.video.output);
    assert.equal(after.video.bitrateKbps, before.video.bitrateKbps);
  });
  test('another stream output sharing the YouTube rung: 409 shared-rung, nothing written, no host call', async () => {
    const c = boot();
    const s = c.setupNow();
    s.outputs.find((o) => o.id === 'twitch').name = 'Twitch';
    delete s.outputs.find((o) => o.id === 'twitch').video; s.video.bitrateKbps = 6000;
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const raw = readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8');
    const p = (await save(c, preset())).body.preset;
    const callsBefore = c.host.calls.length;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'shared-rung');
    assert.equal(r.body.message, 'Twitch streams from the same encoder as YouTube, so a preset would change it too. Give Twitch its own size in Settings > Stream (Edit output), then use the preset.');
    assert.equal(readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8'), raw);
    assert.equal(existsSync(path.join(c.dataDir, CHOICES_FILE)), false);
    assert.equal(c.host.calls.length, callsBefore);
    assert.equal(c.host.configures.length, 0);
    assert.equal((await c.call('GET', '/ui/api/youtube/presets')).body.activeId, null);
  });
  test('a switched-off output sharing the YouTube rung also refuses (it would stream at the new size once switched on)', async () => {
    const c = boot();
    const s = c.setupNow();
    const tw = s.outputs.find((o) => o.id === 'twitch');
    tw.name = 'Twitch'; tw.enabled = false;
    delete tw.video; s.video.bitrateKbps = 6000;
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const raw = readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8');
    const p = (await save(c, preset())).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'shared-rung');
    assert.equal(readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8'), raw);
    assert.equal(c.host.configures.length, 0);
  });
  test('live: saved and pending, nothing stopped, no configure; the template choices are still written', async () => {
    const c = boot();
    c.host.states.twitch = 'live';
    const p = (await save(c, preset())).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.appliesAt, 'next-go-live');
    assert.match(r.body.detail, /was not stopped/);
    assert.equal(c.host.configures.length, 0);
    assert.ok(!c.host.calls.includes('outputs.configure') && !c.host.calls.includes('stream.stop') && !c.host.calls.includes('stream.start'));
    assert.equal(c.setupNow().video.output, '2160p', 'saved for the next go-live');
    assert.equal(c.settings.pendingSetup(), true);
    assert.ok(existsSync(path.join(c.dataDir, PENDING_FILE)));
    assert.equal(readChoices(c.dataDir)['youtube-h'].templateId, 'tplH0001');
    // Start stream applies it once idle.
    c.host.states.twitch = 'stopped';
    assert.deepEqual(await c.settings.applyPendingBeforeStart(), { applied: true });
    assert.deepEqual(c.host.configures[0], launcherParams(c.dataDir));
  });
  test('missingKeys: sizes with no stored key, per enabled output; presence only', async () => {
    const c = boot({ keys: new Map([['youtube-h', true], ['youtube-v', true], ['youtube-v-1440p', true]]) });
    const p = (await save(c, preset())).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.missingKeys, ['youtube-h 2160p']);
    const q = (await save(c, preset({ name: 'H off', outputs: outs({ enabled: false }, { size: '2160p', bitrateKbps: 30000 }) }))).body.preset;
    const r2 = await c.call('POST', '/ui/api/youtube/preset/use', { id: q.id });
    assert.deepEqual(r2.body.missingKeys, ['youtube-v 2160p'], 'a switched-off output is not listed');
  });
  test('Settings > Stream off: templates written, the setup is not touched, appliesAt not-used', async () => {
    const c = boot({ flagOn: false });
    const raw = readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8');
    const p = (await save(c, preset())).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.appliesAt, 'not-used');
    assert.equal(r.body.detail, 'The YouTube templates are set. The sizes and bitrates are not used, because Settings > Stream is off: turn it on there to stream with them.');
    assert.equal(r.body.activeId, p.id);
    assert.ok(Array.isArray(r.body.missingKeys));
    assert.deepEqual(r.body.events, EVENTS_BODY);
    assert.equal(readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8'), raw, 'setup file byte-identical');
    assert.equal(c.host.calls.length, 0, 'the host is not called');
    assert.equal(readChoices(c.dataDir)['youtube-v'].templateId, 'tplV0001');
  });
  test('no YouTube output in the setup: 409, nothing written, no template choice', async () => {
    const c = boot();
    const s = c.setupNow();
    s.outputs = s.outputs.filter((o) => o.platform !== 'youtube');
    assert.ok(writeSetup(c.dataDir, s, { upscale: true }).ok);
    const raw = readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8');
    const p = (await save(c, preset())).body.preset;
    const r = await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'youtube-output-missing');
    assert.equal(readFileSync(path.join(c.dataDir, SETUP_FILE), 'utf8'), raw);
    assert.equal(existsSync(path.join(c.dataDir, CHOICES_FILE)), false);
    assert.equal(c.host.configures.length, 0);
  });
  test('a preset without a template leaves the existing choice alone', async () => {
    const c = boot();
    writeFileSync(path.join(c.dataDir, CHOICES_FILE), JSON.stringify({ version: 1, outputs: { 'youtube-h': { templateId: 'old00001', templateTitle: 'Old', title: null } } }));
    const p = (await save(c, preset({ outputs: outs({ templateId: null, templateTitle: null }, { templateId: null, templateTitle: null }) }))).body.preset;
    assert.equal((await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id })).status, 200);
    assert.equal(readChoices(c.dataDir)['youtube-h'].templateId, 'old00001');
    assert.equal(readChoices(c.dataDir)['youtube-v'], undefined);
  });
  test('bad bodies and unknown ids', async () => {
    const c = boot();
    for (const b of [null, [], {}, { id: 5 }, { id: 'nope' }, { id: 'p-0123abcd', x: 1 }]) assert.equal((await c.call('POST', '/ui/api/youtube/preset/use', b)).status, 400, JSON.stringify(b));
    assert.equal((await c.call('POST', '/ui/api/youtube/preset/use', { id: 'p-0123abcd' })).status, 404);
    for (const b of [{}, { id: 'zz' }, { id: 'p-0123abcd', x: 1 }]) assert.equal((await c.call('POST', '/ui/api/youtube/preset/delete', b)).status, 400);
    assert.equal((await c.call('GET', '/ui/api/youtube/preset/use')).status, 405);
  });
  test('logs carry counts and codes only: no preset name, template title or key', async () => {
    const c = boot();
    const p = (await save(c, preset({ name: 'SecretNameZZ' }))).body.preset;
    await c.call('POST', '/ui/api/youtube/preset/use', { id: p.id });
    const text = c.logs.join('\n');
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, /SecretNameZZ|Ranked|Vertical|tplH0001/);
  });
});
