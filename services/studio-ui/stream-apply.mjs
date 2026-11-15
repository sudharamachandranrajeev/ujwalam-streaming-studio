// SPDX-License-Identifier: GPL-3.0-or-later
// D387: a saved Settings > Stream setup applies without a restart. One place for the live plan the launcher configures
// at start (livePlanFile, planLive) and the runtime apply the UI server runs after a Save (createStreamApply).
//
// The launcher writes <dataDir>/outputs/live-start.json at every start (writeLiveStart): whether this start is a --live
// start, the plan file the UI server was given, the host's --outputs params file, whether the Instagram add-on is in the
// plan, a --sinks test selection and whether server-address schemes are read (real host). It holds file paths and
// flags only, never a key or an address. The runtime apply plans exactly as the launcher does from these facts, then
// calls host outputs.configure, only when every output is idle; the host itself refuses (CONFLICT) while one is active.
// An apply that cannot run now leaves the setup pending (<dataDir>/stream-setup-pending.json, cleared by the launcher at
// the next start because that start plans from the saved setup anyway); Start stream applies it first while idle.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planFile, readServerSchemes } from '../../app/host/lib/outputs-plan.mjs';
import { INSTAGRAM_FLAG, loadAddon as instagramAddon, writeInstagramPlan } from '../outputs/instagram.mjs';
import { readSetup, setupProblems, writePlanFile } from './stream-setup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ALPHA_LIVE_PLAN = path.join(REPO, 'data', 'outputs', 'alpha-live.json');
export const LIVE_START_FILE = path.join('outputs', 'live-start.json'); // under the UI data dir
export const PENDING_FILE = 'stream-setup-pending.json'; // under the UI data dir
// Sink states with nothing running; any other state (or active: true) counts as busy (fail closed).
const IDLE_STATES = new Set(['idle', 'stopped', 'failed']);

/** The --live plan file (D327 OS1/OS2). With the `stream-settings` flag on and a saved Settings > Stream setup, the plan
 *  generated from it (<dataDir>/outputs/stream-setup-plan.json, recording "alpha.mkv" on the main H rung like
 *  alpha-live.json); otherwise alpha-live.json. A setup with problems throws (the start stops; the user fixes Settings). */
export function livePlanFile({ dataDir, streamSettingsOn, instagramOn = false, upscale = true }) {
  const base = baseLivePlanFile({ dataDir, streamSettingsOn, upscale });
  // IG1 (D351, flag instagram-live): the plan in effect plus the instagram sink on the V canvas, written to
  // <dataDir>/outputs/live-plan-instagram.json (target names only). A plan that cannot take it stops the start.
  if (!instagramOn) return base;
  try { return writeInstagramPlan(dataDir, base).file; } catch (e) { throw new Error(`Instagram Live (flag ${INSTAGRAM_FLAG}) cannot be added to the live plan: ${e.message}`); }
}

function baseLivePlanFile({ dataDir, streamSettingsOn, upscale }) {
  if (!streamSettingsOn) return ALPHA_LIVE_PLAN;
  const { exists, setup } = readSetup(dataDir);
  if (!exists) return ALPHA_LIVE_PLAN;
  const problems = setupProblems(setup, { upscale });
  if (problems.length) throw new Error(`Settings > Stream has problems: ${problems.map((p) => p.message).join('; ')}`);
  return writePlanFile(dataDir, setup, { recordName: 'alpha.mkv', upscale });
}

/** The schemes of the stored server addresses a live plan names (only the scheme; the value is dropped at once). */
export async function credentialSchemes(file, { select } = {}) {
  const [{ createCredentialStore }, { credentialFacts }] = await Promise.all([import('../event-core/streamerbot/credential.mjs'), import('./readiness.mjs')]);
  return readServerSchemes(file, (ref) => credentialFacts(createCredentialStore(ref), { scheme: true }), select ? { select } : {});
}

/** The planned graph of a live plan file, as the host gets it (outputs.configure params in .params). Real host: the
 *  stored server addresses' schemes choose "auto" transports (readSchemes); a stand-in host reads nothing. */
export async function planLive(file, { select, readSchemes = false, schemesOf = credentialSchemes } = {}) {
  const schemes = readSchemes ? await schemesOf(file, { select }) : undefined;
  return planFile(file, { allowLive: true, ...(select ? { select } : {}), ...(schemes ? { schemes } : {}) });
}

const writeJsonAtomic = (f, value) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(`${f}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${f}.tmp`, f);
};

/** Written by the launcher at every start (paths and flags only); also clears a pending setup (this start plans from
 *  the saved setup). facts: { live, planFile, paramsFile, instagram, select, bandwidthTest, readSchemes }. */
export function writeLiveStart(dataDir, facts) {
  const body = {
    $comment: 'Written by the launcher at every start (D387): the facts the runtime Settings > Stream apply needs. Paths and flags only.',
    live: facts.live === true,
    planFile: typeof facts.planFile === 'string' ? facts.planFile : null,
    paramsFile: typeof facts.paramsFile === 'string' ? facts.paramsFile : null,
    instagram: facts.instagram === true,
    select: Array.isArray(facts.select) ? facts.select : null,
    bandwidthTest: facts.bandwidthTest === true,
    readSchemes: facts.readSchemes === true,
  };
  writeJsonAtomic(path.join(dataDir, LIVE_START_FILE), body);
  try { rmSync(path.join(dataDir, PENDING_FILE), { force: true }); } catch { /* reported as pending; harmless */ }
  return body;
}

/** The start facts, or null (no launcher start, or unreadable: no runtime apply). */
export function readLiveStart(dataDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(dataDir, LIVE_START_FILE), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}

/** Plain text for each reason an apply did not run now. */
export const APPLY_TEXT = Object.freeze({
  'not-live-start': 'Ujwalam was not started for streaming. The new setup is used at the next start.',
  'test-start': 'This start streams to a chosen set of outputs (test run). The new setup is used at the next start of Ujwalam.',
  busy: 'A stream or recording is running and was not stopped. The new setup is used the next time you go live.',
  starting: 'A stream is starting. The new setup is used the next time you go live.',
  unreadable: 'The output state could not be read, so nothing was changed now. The new setup is used the next time you go live.',
  'plan-refused': 'The new setup could not be built into outputs. It is tried again when you go live.',
  'host-refused': 'The video engine did not take the new setup now. It is tried again when you go live.',
});
// Reasons after which the setup waits for the next go-live (pending); the others wait for the next start.
const PENDING_REASONS = new Set(['busy', 'starting', 'unreadable', 'plan-refused', 'host-refused']);

/**
 * The runtime apply. opts: { dataDir, host: { call(method, params) }, starting?: () => bool (a stream start in flight),
 * schemesOf?: (file, { select }) => schemes (tests), log? }. Applies run one at a time.
 * apply({ checkStarting }) -> { applied: true, planFile, sinks, dropped } | { applied: false, error, detail, pending }.
 */
export function createStreamApply(opts) {
  const { dataDir, host } = opts;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const starting = typeof opts.starting === 'function' ? opts.starting : () => false;
  const pendingFile = path.join(dataDir, PENDING_FILE);
  let pending = existsSync(pendingFile);
  let chain = Promise.resolve();
  const serial = (fn) => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

  function markPending(error) {
    pending = true;
    try { writeJsonAtomic(pendingFile, { $comment: 'A saved Settings > Stream setup not applied yet (D387). Applied at Start stream while idle; cleared at the next start of Ujwalam.', reason: error }); } catch (e) { log(`[studio-ui] WARNING: the pending stream setup mark could not be written (${String(e?.code ?? 'error').slice(0, 40)})`); }
  }
  function clearPending() {
    pending = false;
    try { rmSync(pendingFile, { force: true }); } catch { /* the next start clears it */ }
  }
  const refuse = (error, extra = {}) => {
    const p = PENDING_REASONS.has(error);
    if (p) markPending(error);
    return { applied: false, error, detail: APPLY_TEXT[error], pending: p, ...extra };
  };

  async function idle() {
    let st;
    try { st = await host.call('outputs.status', {}); } catch { return 'unreadable'; }
    if (!st || !Array.isArray(st.sinks)) return 'unreadable';
    const busy = st.sinks.some((s) => !s || typeof s !== 'object' || s.active === true || !IDLE_STATES.has(s.state));
    return busy ? 'busy' : null;
  }

  // Plan files the apply rewrites, kept so a refused apply puts them back (the UI server reads the plan file).
  const planFiles = () => [path.join(dataDir, 'outputs', 'stream-setup-plan.json'), path.join(dataDir, 'outputs', instagramAddon().planName)];
  const snapshot = () => planFiles().map((f) => [f, existsSync(f) ? readFileSync(f) : null]);
  const restore = (snap) => {
    for (const [f, body] of snap) {
      try { if (body === null) rmSync(f, { force: true }); else { writeFileSync(`${f}.tmp`, body); renameSync(`${f}.tmp`, f); } } catch { /* the next start rewrites it */ }
    }
  };

  async function applyOnce({ checkStarting }) {
    const facts = readLiveStart(dataDir);
    if (!facts || facts.live !== true) return refuse('not-live-start');
    if (Array.isArray(facts.select) || facts.bandwidthTest === true) return refuse('test-start');
    if (checkStarting && starting()) return refuse('starting');
    const why = await idle();
    if (why) return refuse(why);
    if (checkStarting && starting()) return refuse('starting');
    const snap = snapshot();
    let file, planned;
    try {
      file = livePlanFile({ dataDir, streamSettingsOn: true, instagramOn: facts.instagram === true, upscale: true });
      planned = await planLive(file, { readSchemes: facts.readSchemes === true, ...(opts.schemesOf ? { schemesOf: opts.schemesOf } : {}) });
    } catch (e) {
      restore(snap);
      return refuse('plan-refused', { reason: String(e?.message ?? 'error').slice(0, 300) });
    }
    try {
      await host.call('outputs.configure', planned.params);
    } catch (e) {
      restore(snap);
      return refuse('host-refused', { code: String(e?.code ?? 'error').slice(0, 40) });
    }
    // The host's --outputs file follows, so a host restart after a crash builds the new graph too.
    // Codex review of D387: if either file is not written, the setup stays pending (the next Go live applies it again and
    // retries the writes), so a host restart and the UI never keep disagreeing about the graph in use.
    let persisted = true;
    if (typeof facts.paramsFile === 'string' && facts.paramsFile) {
      try { writeJsonAtomic(facts.paramsFile, planned.params); } catch (e) { persisted = false; log(`[studio-ui] WARNING: the host outputs file was not updated (${String(e?.code ?? 'error').slice(0, 40)}); kept pending, applied again at the next Go live`); }
    }
    try { writeJsonAtomic(path.join(dataDir, LIVE_START_FILE), { ...facts, planFile: file }); } catch { persisted = false; log('[studio-ui] WARNING: live-start.json was not updated; kept pending, applied again at the next Go live'); }
    if (persisted) clearPending(); else markPending('persist-failed');
    log(`[studio-ui] Settings > Stream applied without a restart (D387): ${planned.params.sinks.map((s) => s.id).join(', ')}`);
    return { applied: true, planFile: file, sinks: planned.params.sinks.map((s) => s.id), dropped: planned.dropped ?? [] };
  }

  return {
    /** After a Save: apply now (refused while a stream start is in flight). */
    apply: () => serial(() => applyOnce({ checkStarting: true })),
    /** Before Start stream (called inside that start): a pending setup is applied while every output is idle. */
    applyPending: () => serial(async () => {
      if (!pending) return { applied: false, pending: false };
      return applyOnce({ checkStarting: false });
    }),
    pending: () => pending,
    /** The live plan file the host runs now (after an apply this start), or null: the launcher's --live-plan holds. */
    planFileInEffect: () => { const f = readLiveStart(dataDir); return f?.live === true && typeof f.planFile === 'string' ? f.planFile : null; },
  };
}
