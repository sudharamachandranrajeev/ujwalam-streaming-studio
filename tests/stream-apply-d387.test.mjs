// SPDX-License-Identifier: GPL-3.0-or-later
// D387: a saved Settings > Stream setup applies without a restart. settings-routes.mjs over a fake host (outputs.status
// states, outputs.configure recorded): idle -> configured at once with the params the launcher would send; live or
// unreadable -> pending, never a configure; host CONFLICT -> pending; saves run one apply at a time; Start stream applies
// a pending setup once idle. No process, no platform, no Credential Manager read.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { planFile, readServerSchemes } from '../app/host/lib/outputs-plan.mjs';
import { createSettingsRoutes } from '../services/studio-ui/settings-routes.mjs';
import { LIVE_START_FILE, PENDING_FILE, livePlanFile, readLiveStart, writeLiveStart } from '../services/studio-ui/stream-apply.mjs';
import { seedSetup } from '../services/studio-ui/stream-setup.mjs';

const dirs = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'ujw-d387-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeHost() {
  const h = {
    states: { 'youtube-h': 'idle', 'youtube-v': 'idle', twitch: 'idle', kick: 'idle', record: 'idle' },
    statusFails: false, refuse: false, configureMs: 0, configures: [], inFlight: 0, maxInFlight: 0,
    async call(m, p) {
      if (m === 'outputs.status') {
        if (h.statusFails) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
        return { sinks: Object.entries(h.states).map(([id, state]) => ({ id, kind: id.startsWith('record') ? 'record' : 'stream', state })) };
      }
      if (m === 'outputs.configure') {
        h.inFlight += 1; h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
        try {
          await delay(h.configureMs);
          if (h.refuse) throw Object.assign(new Error('outputs are active; stop them before configuring'), { code: 'RPC_-32009' });
          h.configures.push(p);
          return { configured: true };
        } finally { h.inFlight -= 1; }
      }
      throw Object.assign(new Error('method-not-found'), { code: 'NO_METHOD' });
    },
  };
  return h;
}

function boot({ live = true, select = null, starting = () => false, schemesOf } = {}) {
  const dataDir = mk();
  const host = fakeHost();
  const paramsFile = path.join(dataDir, 'host', 'outputs-params.json');
  if (live !== null) writeLiveStart(dataDir, { live, planFile: path.join(dataDir, 'outputs', 'stream-setup-plan.json'), paramsFile, instagram: false, select, readSchemes: !!schemesOf });
  const routes = createSettingsRoutes({
    dataDir, host, flags: { isOn: (id) => id === 'stream-settings' },
    json: (res, status, body) => { res.status = status; res.body = body; },
    startGuard: { starting }, ...(schemesOf ? { schemesOf } : {}),
  });
  const save = async (setup) => { const res = {}; await routes.handle('POST', '/ui/api/stream/setup', { setup }, res); return res; };
  return { dataDir, host, routes, save, paramsFile };
}
const fourK = () => { const s = seedSetup(); s.video.output = '2160p'; s.video.bitrateKbps = 50000; return s; };
// What the launcher sends for this saved setup (stand-in host: no scheme read), planned independently of stream-apply.
const launcherParams = (dataDir) => planFile(livePlanFile({ dataDir, streamSettingsOn: true }), { allowLive: true }).params;

test('idle save: configured at once with the launcher\'s params; the host --outputs file follows; nothing pending', async () => {
  const c = boot();
  const r = await c.save(fourK());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.appliesAt, 'now');
  assert.equal(r.body.applied, true);
  assert.equal(c.host.configures.length, 1);
  const sent = c.host.configures[0];
  assert.deepEqual(sent, launcherParams(c.dataDir));
  assert.ok(sent.rungs.some((e) => e.id === 'h-main' && e.w === 3840 && e.h === 2160), '4K main rung');
  assert.deepEqual(r.body.outputs, sent.sinks.map((s) => s.id));
  assert.deepEqual(JSON.parse(readFileSync(c.paramsFile, 'utf8')), sent, 'a host restart builds the new graph too');
  assert.equal(c.routes.pendingSetup(), false);
  assert.equal(existsSync(path.join(c.dataDir, PENDING_FILE)), false);
  assert.equal(c.routes.planFileInEffect(), path.join(c.dataDir, 'outputs', 'stream-setup-plan.json'));
  assert.deepEqual(await c.routes.applyPendingBeforeStart(), { applied: false }, 'nothing pending');
  assert.equal(c.host.configures.length, 1);
});

test('live: pending, no configure, nothing stopped; Start stream applies it once idle, only once', async () => {
  const c = boot();
  c.host.states.twitch = 'live';
  const r = await c.save(fourK());
  assert.equal(r.body.appliesAt, 'next-go-live');
  assert.equal(r.body.applied, false);
  assert.equal(r.body.reason, 'busy');
  assert.match(r.body.detail, /was not stopped/);
  assert.equal(c.host.configures.length, 0);
  assert.equal(c.routes.pendingSetup(), true);
  assert.ok(existsSync(path.join(c.dataDir, PENDING_FILE)), 'pending survives the UI server');
  // Still live at Start stream (e.g. one more output switched on): still pending.
  assert.deepEqual(await c.routes.applyPendingBeforeStart(), { applied: false, error: 'busy', detail: r.body.detail });
  assert.equal(c.host.configures.length, 0);
  // All stopped: the next Start stream applies it first.
  c.host.states.twitch = 'stopped';
  assert.deepEqual(await c.routes.applyPendingBeforeStart(), { applied: true });
  assert.deepEqual(c.host.configures[0], launcherParams(c.dataDir));
  assert.equal(c.routes.pendingSetup(), false);
  assert.deepEqual(await c.routes.applyPendingBeforeStart(), { applied: false });
  assert.equal(c.host.configures.length, 1);
});

test('host configured but its outputs file not written: kept pending, the next Start stream applies it again (Codex review)', async () => {
  const c = boot();
  mkdirSync(c.paramsFile, { recursive: true }); // a folder where the file goes: the write fails
  const r = await c.save(fourK());
  assert.equal(r.body.appliesAt, 'now');
  assert.equal(c.host.configures.length, 1);
  assert.equal(c.routes.pendingSetup(), true, 'pending until the host file agrees');
  rmSync(c.paramsFile, { recursive: true, force: true });
  assert.deepEqual(await c.routes.applyPendingBeforeStart(), { applied: true });
  assert.equal(c.host.configures.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(c.paramsFile, 'utf8')), c.host.configures[1]);
  assert.equal(c.routes.pendingSetup(), false);
});

test('a new UI server process picks up a pending setup from its mark', async () => {
  const c = boot();
  c.host.states.record = 'live';
  assert.equal((await c.save(fourK())).body.appliesAt, 'next-go-live');
  const again = createSettingsRoutes({ dataDir: c.dataDir, host: c.host, flags: { isOn: () => true }, json: () => {} });
  assert.equal(again.pendingSetup(), true);
  c.host.states.record = 'stopped';
  assert.deepEqual(await again.applyPendingBeforeStart(), { applied: true });
  // The launcher's next start clears it (that start plans from the saved setup).
  c.host.states.record = 'live';
  await c.save(fourK());
  writeLiveStart(c.dataDir, { live: true });
  assert.equal(existsSync(path.join(c.dataDir, PENDING_FILE)), false);
});

test('host CONFLICT: pending, the plan file put back; unreadable state: no configure at all', async () => {
  const c = boot();
  c.host.refuse = true;
  const r = await c.save(fourK());
  assert.equal(r.body.appliesAt, 'next-go-live');
  assert.equal(r.body.reason, 'host-refused');
  assert.equal(existsSync(path.join(c.dataDir, 'outputs', 'stream-setup-plan.json')), false, 'the plan file the server reads is put back (none before)');
  assert.equal(c.routes.pendingSetup(), true);
  assert.equal(existsSync(c.paramsFile), false, 'host --outputs file untouched');
  const u = boot();
  u.host.statusFails = true;
  const r2 = await u.save(fourK());
  assert.equal(r2.body.appliesAt, 'next-go-live');
  assert.equal(r2.body.reason, 'unreadable');
  assert.equal(u.host.configures.length + u.host.maxInFlight, 0, 'never a configure');
  // A sink in a state the apply does not know counts as busy.
  const x = boot();
  x.host.states.kick = 'reconnecting';
  assert.equal((await x.save(fourK())).body.reason, 'busy');
  assert.equal(x.host.maxInFlight, 0);
});

test('a stream start in flight: pending, no configure', async () => {
  const c = boot({ starting: () => true });
  const r = await c.save(fourK());
  assert.equal(r.body.reason, 'starting');
  assert.equal(r.body.appliesAt, 'next-go-live');
  assert.equal(c.host.maxInFlight, 0);
});

test('concurrent saves: one apply at a time, the last saved setup wins', async () => {
  const c = boot();
  c.host.configureMs = 40;
  const a = fourK();
  const b = fourK(); b.video.output = '1440p'; b.video.bitrateKbps = 34000;
  const [ra, rb] = await Promise.all([c.save(a), c.save(b)]);
  assert.equal(ra.body.appliesAt, 'now');
  assert.equal(rb.body.appliesAt, 'now');
  assert.equal(c.host.maxInFlight, 1, 'never two configures at once');
  assert.equal(c.host.configures.length, 2);
  assert.equal(c.host.configures[1].rungs.find((e) => e.id === 'h-main').w, 2560);
  assert.deepEqual(JSON.parse(readFileSync(c.paramsFile, 'utf8')), c.host.configures[1]);
});

test('not a --live start, or a --sinks test start: saved for the next start, nothing configured or pending', async () => {
  for (const [opts, reason] of [[{ live: null }, 'not-live-start'], [{ live: false }, 'not-live-start'], [{ select: ['youtube-h'] }, 'test-start']]) {
    const c = boot(opts);
    const r = await c.save(fourK());
    assert.equal(r.status, 200);
    assert.equal(r.body.appliesAt, 'next-start', reason);
    assert.equal(r.body.reason, reason);
    assert.equal(c.host.maxInFlight, 0);
    assert.equal(c.routes.pendingSetup(), false);
  }
});

test('real host: the stored server-address schemes are read as at the launcher start', async () => {
  const seen = [];
  const c = boot({ schemesOf: async (file) => { seen.push(file); return readServerSchemes(file, async () => ({ present: true, scheme: 'rtmps' })); } });
  const r = await c.save(fourK());
  assert.equal(r.body.appliesAt, 'now');
  assert.deepEqual(seen, [path.join(c.dataDir, 'outputs', 'stream-setup-plan.json')]);
});

test('live-start facts: paths and flags only', () => {
  const d = mk();
  writeLiveStart(d, { live: true, planFile: 'a', paramsFile: 'b', instagram: true, select: null, bandwidthTest: false, readSchemes: true, key: 'x' });
  const f = readLiveStart(d);
  assert.deepEqual(Object.keys(f).sort(), ['$comment', 'bandwidthTest', 'instagram', 'live', 'paramsFile', 'planFile', 'readSchemes', 'select']);
  assert.ok(existsSync(path.join(d, LIVE_START_FILE)));
});
