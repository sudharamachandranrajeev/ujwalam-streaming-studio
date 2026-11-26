// SPDX-License-Identifier: GPL-3.0-or-later
// P16a packager CLI. Behind the feature flag `posting` (off by default; exit 3 while off). Local files only.
//   node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]
// Writes <run>/posts/<clipId>/<target>/ and the ledger <data-dir>/posting/ledger.json. Prints counts only (no text).
// The data dir is --data-dir, else paths.event_core_data from data/profile.local.json (same as the studio).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDirNote, resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { MIX_FLAG, appliedKindShares } from '../learning/mix.mjs';
import { LEDGER_NAME, POSTING_FLAG, PostingError, createPostStore, findFfmpeg, packageRun } from './index.mjs';
import { ANALYTICS_SCOPE, CAPTIONS_SCOPE, READONLY_SCOPE, SCOPE, createYoutubeAuth, joinScopes } from './oauth.mjs';
import { UploadError } from './youtube.mjs';
import { IG_FLAG, InstagramError, createInstagramAuth } from './instagram.mjs';
import { queueInstagramNow } from './instagram-queue.mjs';
import { REWRITE_FLAG, runRewrite, runUndo } from './rewrite.mjs';
import { runHold } from './hold.mjs';
import { AI_TEXT_FLAG } from './ai-text.mjs';
import { createQuotaBudget } from './quota-budget.mjs';
import { FLAG as LOCAL_MODEL_FLAG, createModelRunner } from '../local-model/runner.mjs';
import { SCHEDULE_FLAG } from './schedule.mjs';
import { GROWTH_FLAG } from '../analytics/index.mjs';
import { requestRunNow, streamOnly } from './auto-chain.mjs';
import { scheduleNextFree } from './auto-settings.mjs';
import { AUTO_FLAG, AUTO_LOG_NAME, AutoPostError, createAutoLog, describeMode, initUserRules, loadRules, planAuto, rankerMinScore, rulesFileFor, runAuto } from './auto-post.mjs';
import { formatPreview, previewRules } from './preview.mjs';
import { HostClient } from '../../app/host/lib/client.mjs';
import { resolveConfig as resolveHostConfig } from '../../app/host/lib/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXIT_FLAG_OFF = 3;

/** Opens a URL in the system's default browser. Windows only (this project targets Windows). No shell: `cmd /c start`
 *  split the URL at its first '&', so Google got only client_id and refused the sign-in ("Required parameter is
 *  missing: response_type", 2026-11-09). rundll32's URL handler takes the whole URL as one argument. The URL is
 *  also printed, so it can be pasted into a browser by hand. It comes from authUrl() (our own query-string
 *  builder), never from user-typed text. */
export function defaultBrowserOpen(url, { spawnImpl = spawn, log = (s) => console.log(s) } = {}) {
  log(`If no browser opens, paste this into the browser signed in to the right account (Google for YouTube, Facebook for Instagram):\n${url}`);
  return new Promise((resolve, reject) => {
    const p = spawnImpl('rundll32', ['url.dll,FileProtocolHandler', url], { windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`could not open a browser (exit ${code})`))));
  });
}

/** Discovery files a running host may have written: the studio's (<event-core data dir>/host.json, where
 *  services/studio-ui/launch.mjs puts it) and the host config's own (app/host/lib/config.mjs, standalone host). */
export function hostDiscoveryCandidates(dataDir, hostCfg = resolveHostConfig({})) {
  const out = [];
  for (const f of [typeof dataDir === 'string' && dataDir ? path.join(dataDir, 'host.json') : null, hostCfg?.discovery]) {
    if (f && !out.some((x) => path.resolve(x).toLowerCase() === path.resolve(f).toLowerCase())) out.push(f);
  }
  return out;
}

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown: treat as running (fail closed)
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/** Live-refusal check for `youtube upload` and `auto --run`: asks every running host if any sink is active.
 *  No discovery file, or only stale ones (their pid is gone), means no host runs: nothing is live. A running host
 *  whose state cannot be read (no host token in this shell, host not answering) throws, so the caller refuses: an
 *  upload must never proceed on a guess about whether a stream is live. (2026-11-06 stream-day mock run: this used
 *  to look only at the standalone host's discovery file, so a studio session's live outputs read as "nothing live".) */
export function outputsStatusFor(dataDir, { hostCfg, token = process.env.UJWALAM_HOST_TOKEN, alive = pidAlive } = {}) {
  return async () => {
    const sinks = [];
    for (const f of hostDiscoveryCandidates(dataDir, hostCfg ?? resolveHostConfig({}))) {
      if (!existsSync(f)) continue;
      let d;
      try { d = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error('host discovery file unreadable'); }
      if (!alive(d?.pid)) continue;
      const client = HostClient.fromDiscovery(f, token || undefined);
      const st = await client.call('outputs.status');
      sinks.push(...(Array.isArray(st?.sinks) ? st.sinks : [null]));
    }
    return { sinks };
  };
}


function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

/** The data dir for this run (--data-dir, else the installed app's, else the profile's); says which one it used. */
function cliDataDir(a, out) {
  const r = resolveCliDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
  if (r.source !== 'option') out(`posting: ${dataDirNote(r)}`); // an explicit --data-dir needs no echo
  return r.dir;
}

export async function main(argv, out = (s) => console.log(s), err = (s) => console.error(s), deps = {}) {
  const a = parseArgs(argv);
  if (a._[0] === 'youtube') return youtubeMain(a, out, err, deps);
  if (a._[0] === 'instagram') return instagramMain(a, out, err, deps);
  if (a._[0] === 'auto') return autoMain(a, out, err, deps);
  if (a._[0] !== 'package' || typeof a.run !== 'string') {
    err('usage: node services/posting/cli.mjs package --run <clip run folder> [--data-dir DIR] [--profile FILE] [--ffmpeg FILE] [--targets a,b]\n       node services/posting/cli.mjs youtube signin|status|signout\n       node services/posting/cli.mjs youtube upload --id <post id> [--data-dir DIR]\n       node services/posting/cli.mjs auto [--run | --preview [--json]] [--data-dir DIR] [--rules FILE]\n       node services/posting/cli.mjs auto --init-rules [--data-dir DIR]');
    return 2;
  }
  try {
    const dataDir = cliDataDir(a, out);
    if (!createFlags({ dataDir }).isOn(POSTING_FLAG)) { err(`posting: the '${POSTING_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
    const profileFile = typeof a.profile === 'string' ? a.profile : path.join(REPO, 'data', 'profile.local.json');
    let profile = {};
    if (existsSync(profileFile)) profile = JSON.parse(readFileSync(profileFile, 'utf8'));
    else out('posting: no local profile; {handles.x} and {links.x} placeholders stay unresolved and are flagged');
    const r = await packageRun({
      runDir: a.run, ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), profile, dataDir,
      ffmpeg: typeof a.ffmpeg === 'string' ? a.ffmpeg : undefined,
      targets: typeof a.targets === 'string' ? a.targets.split(',').filter(Boolean) : undefined,
    });
    const why = {};
    for (const s of r.skipped) why[s.reason] = (why[s.reason] ?? 0) + 1;
    const flagged = r.packaged.filter((p) => !p.limitsOk || p.unresolved.length).length;
    out(`posting: packaged ${r.packaged.length} (${flagged} flagged for review), skipped ${r.skipped.length} ${JSON.stringify(why)}`);
    return 0;
  } catch (e) {
    err(`posting: ${e instanceof PostingError ? e.message : (e?.message ?? 'error')}`);
    return 1;
  }
}

/** `auto` (dry-run listing, read-only) and `auto --run` (post-stream; needs flags `posting` and `auto-post`).
 *  Review-first stays the default: with no rules, or a flag off, nothing happens. */
async function autoMain(a, out, err, deps) {
  try {
    const dataDir = cliDataDir(a, out);
    const flags = createFlags({ dataDir });
    const flagOn = flags.isOn(POSTING_FLAG) && flags.isOn(AUTO_FLAG);
    if (a['init-rules'] === true) {
      const r = initUserRules(dataDir);
      out(r.created ? `auto-post: created your rules file from the template (no rules yet): ${r.path}` : `auto-post: your rules file already exists, left as it is: ${r.path}`);
      return 0;
    }
    const rulesFile = rulesFileFor(dataDir, typeof a.rules === 'string' ? a.rules : undefined);
    const rules = deps.rules ?? loadRules(rulesFile);
    const store = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME) });
    const logFile = path.join(dataDir, 'posting', AUTO_LOG_NAME);
    const mode = describeMode({ flagOn, rules });
    if (a.preview === true) {
      // Read-only: never opens a browser or auth, never uploads. Live state is read from the local host only (127.0.0.1).
      const profileFile = typeof a.profile === 'string' ? a.profile : path.join(REPO, 'data', 'profile.local.json');
      let profile = {};
      try { if (existsSync(profileFile)) profile = JSON.parse(readFileSync(profileFile, 'utf8')); } catch { /* placeholders stay unresolved and are shown */ }
      const r = await previewRules({
        dataDir, rules, rulesFile, profile, flagOn, log: createAutoLog(logFile).list(), now: deps.now, scheduleOn: flags.isOn(SCHEDULE_FLAG),
        outputsStatus: streamOnly(deps.outputsStatus ?? outputsStatusFor(dataDir)),
      });
      out(a.json === true ? JSON.stringify(r, null, 2) : formatPreview(r));
      return 0;
    }
    if (a.run !== true) {
      const plan = planAuto({ posts: store.list(), rules: rules.rules, autoUpload: rules.autoUpload, log: createAutoLog(logFile).list(), now: (deps.now ?? (() => new Date()))(), maxUploadsPerDay: rules.maxUploadsPerDay ?? null, unscoredFloor: rankerMinScore(), youtubeSource: rules.youtubeSource ?? null });
      out(`auto-post (dry run): ${mode.enabled ? 'on' : 'off'} (flags posting+auto-post: ${flagOn}), ${mode.ruleCount} rule(s), autoUpload ${mode.autoUpload}, uploads scheduled`);
      out(`rules file: ${rulesFile}`);
      for (const s of plan) out(`  ${s.action} ${s.id} rule ${s.ruleId}: ${s.reason}`);
      return 0;
    }
    if (!flagOn) { err(`auto-post: the '${POSTING_FLAG}' and '${AUTO_FLAG}' feature flags must both be on`); return EXIT_FLAG_OFF; }
    if (!rules.rules.length) { out('auto-post: no rules; nothing to do'); return 0; }
    // D375: this command only approves. Automatic uploads always go up with a publish time, and only the studio's
    // background queue gives one out (post-schedule), so nothing is uploaded here.
    if (rules.autoUpload) out(flags.isOn(SCHEDULE_FLAG) ? 'auto-post: approved clips are uploaded by the studio queue, each with a publish time'
      : 'auto-post: approved clips wait for scheduled posting (flag post-schedule); automatic uploads always have a publish time');
    // D300: only stream sinks block (a local recording does not); an unreadable state still refuses.
    const outputsStatus = streamOnly(deps.outputsStatus ?? outputsStatusFor(dataDir));
    let kindShares = null; // RP5 (D373): the learned kind order only with the flag self-learning on and a mix in use
    if (flags.isOn(MIX_FLAG)) { try { kindShares = appliedKindShares(dataDir); } catch { kindShares = null; } }
    const r = await runAuto({
      store, rules, outputsStatus, logFile, now: deps.now, kindShares, unscoredFloor: rankerMinScore(),
    });
    if (r.refused) { err(`auto-post: refused (${r.refused}); nothing approved or uploaded`); return 1; }
    const n = {}; for (const e of r.done) n[e.action] = (n[e.action] ?? 0) + 1;
    out(`auto-post: ${JSON.stringify(n)}`);
    return 0;
  } catch (e) {
    err(`auto-post: ${e instanceof AutoPostError || e instanceof PostingError ? e.message : (e?.message ?? 'error')}`);
    return 1;
  }
}

/** `youtube signin|status|signout|upload`. Always behind the posting flag -- same gate as `package`. */
async function youtubeMain(a, out, err, deps) {
  const dataDir = cliDataDir(a, out);
  const flags = createFlags({ dataDir });
  if (!flags.isOn(POSTING_FLAG)) { err(`posting: the '${POSTING_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  // post-schedule on: also ask for read access, to see the channel's scheduled posts (D310 proposed).
  const scheduled = flags.isOn(SCHEDULE_FLAG);
  // growth on: also ask to read the channel's analytics and each video's public state (AN1, D371).
  const growth = flags.isOn(GROWTH_FLAG);
  // C1 (user yes 2026-11-24): also the permission to add caption files to the long highlights video
  const scope = joinScopes(SCOPE, CAPTIONS_SCOPE, (scheduled || growth) && READONLY_SCOPE, growth && ANALYTICS_SCOPE);
  const auth = (deps.createYoutubeAuth ?? createYoutubeAuth)({ browserOpen: deps.browserOpen ?? defaultBrowserOpen, scope });
  const sub = a._[1];
  try {
    if (sub === 'signin') {
      const r = await auth.signIn();
      out(`youtube: signed in (scope: ${r.scope})`);
      if (!String(r.scope ?? '').split(/\s+/).includes(CAPTIONS_SCOPE)) out('youtube: adding captions was not allowed, so long videos go up without their caption track; sign in again and allow it');
      if (scheduled && !String(r.scope ?? '').split(/\s+/).includes(READONLY_SCOPE)) out('youtube: reading scheduled posts was not allowed, so scheduled posting waits; sign in again and allow it');
      if (growth && !String(r.scope ?? '').split(/\s+/).includes(ANALYTICS_SCOPE)) out('youtube: reading statistics was not allowed, so the Growth section waits; sign in again and allow it');
      return 0;
    }
    if (sub === 'status') { const s = await auth.status(); out(`youtube: signed in: ${s.signedIn}, OAuth client set: ${s.hasClient}`); return 0; }
    if (sub === 'signout') { await auth.signOut(); out('youtube: signed out'); return 0; }
    if (sub === 'rewrite' || sub === 'rewrite-undo') {
      // D443 T4: new AI text for scheduled, not yet public videos in Ujwalam's own list; undo puts the saved original back.
      // The rewrite switch (flag post-rewrite-scheduled, off by default) must be on; undo works without it.
      const only = typeof a.only === 'string' ? a.only.split(',').filter(Boolean) : null;
      const budget = deps.budget ?? createQuotaBudget({ dataDir });
      const store = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), dataDir });
      const common = { dataDir, store, auth: deps.auth ?? auth, budget, flags, fetchImpl: deps.fetchImpl, only, outputsStatus: deps.outputsStatus ? streamOnly(deps.outputsStatus) : undefined };
      let r;
      if (sub === 'rewrite') {
        const runner = deps.runner ?? createModelRunner({ isOn: () => flags.isOn(LOCAL_MODEL_FLAG) });
        const profileFile = typeof a.profile === 'string' ? a.profile : path.join(REPO, 'data', 'profile.local.json');
        let profile = {};
        try { if (existsSync(profileFile)) profile = JSON.parse(readFileSync(profileFile, 'utf8')); } catch { /* a line needing it is left out */ }
        r = await runRewrite({ ...common, profile, ffmpeg: deps.ffmpeg ?? findFfmpeg(typeof a.ffmpeg === 'string' ? a.ffmpeg : undefined), aiDeps: { runner, isOn: () => flags.isOn(AI_TEXT_FLAG), ...(deps.aiDeps ?? {}) } });
      } else r = await runUndo({ ...common, force: a.force === true });
      if (r.refused) { err(`youtube: ${sub} refused (${r.refused}); nothing was changed${r.refused === 'flag-off' ? ` (switch '${REWRITE_FLAG}' on first)` : ''}`); return 1; }
      const done = r.rewritten ?? r.restored;
      const why = {}; for (const s of r.skipped) why[s.why] = (why[s.why] ?? 0) + 1;
      out(`youtube: ${sub}: ${done.length} ${sub === 'rewrite' ? 'rewritten' : 'restored'}, ${r.skipped.length} skipped ${JSON.stringify(why)}${r.stopped ? `; stopped (${r.stopped}), ${r.left} left for another day` : ''}`);
      return 0;
    }
    if (sub === 'hold') {
      // 2026-11-26: take every private, future-scheduled video in Ujwalam's list off its schedule (stays private).
      const only = typeof a.only === 'string' ? a.only.split(',').filter(Boolean) : null;
      const store = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), dataDir });
      const dryRun = a['dry-run'] === true;
      const r = await runHold({ dataDir, store, auth: deps.auth ?? auth, budget: dryRun ? null : (deps.budget ?? createQuotaBudget({ dataDir })), fetchImpl: deps.fetchImpl, only, dryRun,
        nowMs: deps.nowMs, outputsStatus: deps.outputsStatus ? streamOnly(deps.outputsStatus) : undefined });
      if (r.refused) { err(`youtube: hold refused (${r.refused}); nothing was changed`); return 1; }
      if (dryRun) { out(`youtube: hold (dry run): ${r.candidates} scheduled video(s) would be held${r.otherChannel ? ` (${r.otherChannel} on an added channel, skipped)` : ''}; nothing was sent`); return 0; }
      const why = {}; for (const s of r.skipped) why[s.why] = (why[s.why] ?? 0) + 1;
      out(`youtube: hold: ${r.held.length} held, ${r.skipped.length} skipped ${JSON.stringify(why)}${r.stopped ? `; stopped (${r.stopped}), ${r.left} left for another day` : ''}`);
      return 0;
    }
    if (sub === 'upload') {
      if (typeof a.id !== 'string') { err('usage: node services/posting/cli.mjs youtube upload --id <post id> [--data-dir DIR]'); return 2; }
      const ledgerFile = path.join(dataDir, 'posting', LEDGER_NAME);
      const store = createPostStore({ ledgerFile, dataDir });
      // D409 (second Codex review, 2026-11-21): nothing is sent from here. No video goes up without a checked publish
      // time, so the clip is queued at the next free time (an hour or more from any other post) and the studio's
      // auto-post chain uploads it: one schedule-lock hold, a fresh channel read, the 60-min check, the budget gate.
      const post = store.get(a.id);
      if (!post) throw new UploadError('unknown-post', `unknown post id ${a.id}`);
      if (post.status === 'uploaded') throw new UploadError('already-uploaded', `already uploaded as ${post.videoId}`);
      if (post.status !== 'approved') throw new UploadError('not-approved', 'only approved packages can be uploaded');
      const r = scheduleNextFree(dataDir, a.id);
      if (!r.ok) { err(`youtube: not queued (${r.code}): ${r.text}`); return 1; }
      requestRunNow(dataDir);
      out(`youtube: queued ${a.id}; goes public ${r.item.publishAt}. The studio's auto-post queue uploads it as private when no stream is live (auto-post must be on).`);
      return 0;
    }
    err('usage: node services/posting/cli.mjs youtube signin|status|signout|upload --id <post id>|rewrite [--only ids]|rewrite-undo [--only ids] [--force]|hold [--dry-run] [--only ids]');
    return 2;
  } catch (e) {
    if (e?.code === 'oauth-no-client') { err('youtube: no OAuth client set yet (see docs/plan/2026-11-03-p16b-youtube-private-upload-plan.md: "Needs from the user")'); return 1; }
    if (e?.code === 'oauth-reauth-needed') { err('youtube: not signed in (or sign-in expired) -- run: node services/posting/cli.mjs youtube signin'); return 1; }
    if (e instanceof UploadError) { err(`youtube: ${e.message}`); return 1; }
    err(`youtube: ${e?.message ?? 'error'}`);
    return 1;
  }
}

/** D444 `instagram signin|status|signout|post --id <post id>`. Behind the posting flag. The Meta app id and secret are
 *  saved from Settings > Posting & growth (never on a command line, where other programs could read them). `post` sends
 *  nothing itself: it puts the clip first in the Instagram queue and asks the studio's auto-post chain (the one sender)
 *  to run now; the chain posts it when no stream is live, the gap allows it and Instagram's 24-hour limit has room. */
async function instagramMain(a, out, err, deps) {
  const dataDir = cliDataDir(a, out);
  const flags = createFlags({ dataDir });
  if (!flags.isOn(POSTING_FLAG)) { err(`posting: the '${POSTING_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  const auth = (deps.createInstagramAuth ?? createInstagramAuth)({ browserOpen: deps.browserOpen ?? defaultBrowserOpen });
  const sub = a._[1];
  try {
    if (sub === 'signin') { const r = await auth.signIn(); out(`instagram: connected${r.username ? ` as @${r.username}` : ''}; the sign-in lasts until ${new Date(r.expiresAt).toISOString().slice(0, 10)} and renews itself`); return 0; }
    if (sub === 'status') {
      const s = await auth.status();
      out(`instagram: app saved: ${s.hasApp}, connected: ${s.connected}${s.connected ? ` (until ${s.expiresAt.slice(0, 10)})` : ''}, '${IG_FLAG}' flag: ${flags.isOn(IG_FLAG) ? 'on' : 'off'}`);
      return 0;
    }
    if (sub === 'signout') { await auth.signOut(); out('instagram: disconnected'); return 0; }
    if (sub === 'post') {
      const id = typeof a.id === 'string' ? a.id : a._[2];
      if (typeof id !== 'string') { err('usage: node services/posting/cli.mjs instagram post --id <post id> [--data-dir DIR]'); return 2; }
      const store = createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), dataDir });
      const post = store.get(id);
      if (!post) { err(`instagram: unknown post id ${id}`); return 1; }
      if (post.status !== 'approved' && post.status !== 'uploaded') { err('instagram: only approved packages are posted'); return 1; }
      queueInstagramNow(dataDir, id);
      requestRunNow(dataDir);
      out(`instagram: ${id} is next in the Instagram queue. The studio posts it when no stream is live (auto-post and '${IG_FLAG}' must be on).`);
      return 0;
    }
    err('usage: node services/posting/cli.mjs instagram signin|status|signout|post --id <post id>');
    return 2;
  } catch (e) {
    if (e?.code === 'no-app') { err('instagram: the Meta app id and secret are not saved yet (Settings > Posting & growth > Instagram)'); return 1; }
    if (e instanceof InstagramError) { err(`instagram: ${e.message}`); return 1; }
    err(`instagram: ${e?.message ?? 'error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
