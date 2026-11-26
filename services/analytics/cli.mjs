// SPDX-License-Identifier: GPL-3.0-or-later
// AN1 Growth data CLI (D371, flag growth). Read only towards YouTube; writes only <data>/analytics/analytics.db.
//   node services/analytics/cli.mjs fetch [--force] [--data-dir <dir>]   read the numbers of every posted video
//   node services/analytics/cli.mjs show [--json] [--data-dir <dir>]     list them (latest, at 24 h, at 7 d)
//   node services/analytics/cli.mjs instagram fetch [--force]           read the insights of every posted Reel
//   node services/analytics/cli.mjs instagram show [--json]             list them (latest, at 48 h, at 7 d, score)
//   node services/analytics/cli.mjs instagram winners [--dry-run]       this week's Reels for YouTube (dry run: records nothing)
// Sign-in (with the statistics permission) is `node services/posting/cli.mjs youtube signin` with the growth flag on.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirNote, resolveCliDataDir } from '../event-core/config.mjs';
import { createFlags } from '../flags/index.mjs';
import { createYoutubeAuth } from '../posting/oauth.mjs';
import { LEDGER_NAME, createPostStore } from '../posting/index.mjs';
import { IG_FLAG, createInstagramAuth } from '../posting/instagram.mjs';
import { DB_NAME, GROWTH_FLAG, collect, openStore, summary } from './index.mjs';
import { IG_DB_NAME, collectInstagram, igSummary, openIgStore, reelScore, weeklyWinners } from './instagram.mjs';

export const EXIT_FLAG_OFF = 3;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) ? true : argv[++i]; } else out._.push(a);
  }
  return out;
}

const fmt = (s, k) => (s?.analytics?.[k] ?? s?.data?.[k] ?? '-');
const line = (label, s) => (s ? `${label} views ${fmt(s, 'views')}, avg viewed ${s.analytics?.averageViewPercentage ?? '-'} %, likes ${fmt(s, 'likes')}, shares ${s.analytics?.shares ?? '-'}, subs +${s.analytics?.subscribersGained ?? '-'}` : `${label} -`);

export async function main(argv, out = (s) => console.log(s), err = (s) => console.error(s), deps = {}) {
  const a = parseArgs(argv);
  const r = resolveCliDataDir({ dataDir: typeof a['data-dir'] === 'string' ? a['data-dir'] : undefined });
  if (r.source !== 'option') out(`growth: ${dataDirNote(r)}`);
  const dataDir = r.dir;
  if (a._[0] === 'instagram') return instagramCmd(a, dataDir, out, err, deps);
  if (!createFlags({ dataDir }).isOn(GROWTH_FLAG)) { err(`growth: the '${GROWTH_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  const sub = a._[0];
  try {
    if (sub === 'fetch') {
      const auth = (deps.createYoutubeAuth ?? createYoutubeAuth)({ browserOpen: async () => { throw new Error('sign-in runs from: node services/posting/cli.mjs youtube signin'); } });
      const res = await collect({ dataDir, auth, fetchImpl: deps.fetchImpl ?? fetch, now: deps.now, force: a.force === true });
      if (res.skipped) { out(`growth: fetched less than an hour ago (${res.lastFetchAt}); use --force to read again`); return 0; }
      out(`growth: ${res.videos} posted video(s), ${res.public} public, ${res.snapshots} snapshot(s) stored` +
        (res.analyticsMissing ? `, ${res.analyticsMissing} without statistics yet (YouTube fills them a day or two late)` : ''));
      return 0;
    }
    if (sub === 'show') {
      const store = openStore(path.join(dataDir, DB_NAME));
      try {
        const rows = summary(store);
        if (a.json === true) { out(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { out('growth: no posted videos stored yet (run: node services/analytics/cli.mjs fetch)'); return 0; }
        for (const v of rows) {
          out(`${v.videoId} ${v.kind ?? '-'} ${v.privacy ?? '-'}${v.publicAt ? ` since ${v.publicAt}` : ''}`);
          out(`  ${line('24 h:', v.at24h)}`);
          out(`  ${line('7 d: ', v.at7d)}`);
          out(`  ${line('now: ', v.latest)}`);
        }
        return 0;
      } finally { store.close(); }
    }
    err('usage: node services/analytics/cli.mjs fetch [--force] | show [--json]');
    return 2;
  } catch (e) {
    if (e?.code === 'analytics-scope-missing') { err('growth: reading statistics is not allowed yet -- with the growth flag on run: node services/posting/cli.mjs youtube signin'); return 1; }
    if (e?.code === 'oauth-no-client') { err('growth: no YouTube OAuth client set yet (see docs/plan/2026-11-12-growth-setup-notes.md)'); return 1; }
    if (e?.code === 'oauth-reauth-needed') { err('growth: not signed in -- run: node services/posting/cli.mjs youtube signin'); return 1; }
    err(`growth: ${e?.message ?? 'error'}`);
    return 1;
  }
}

const n = (m, k) => (Number.isFinite(m?.[k]) ? m[k] : '-');
const igLine = (label, s) => (s ? `${label} views ${n(s.metrics, 'views')}, reach ${n(s.metrics, 'reach')}, avg watch ${Number.isFinite(s.metrics?.ig_reels_avg_watch_time) ? `${(s.metrics.ig_reels_avg_watch_time / 1000).toFixed(1)} s` : '-'}, likes ${n(s.metrics, 'likes')}, comments ${n(s.metrics, 'comments')}, saves ${n(s.metrics, 'saved')}, shares ${n(s.metrics, 'shares')}` : `${label} -`);

/** Instagram winners (2026-11-26): fetch | show [--json] | winners [--dry-run] [--json]. Needs the instagram-autopost flag. */
async function instagramCmd(a, dataDir, out, err, deps) {
  if (!createFlags({ dataDir }).isOn(IG_FLAG)) { err(`instagram: the '${IG_FLAG}' feature flag is off (switch it on from the control page)`); return EXIT_FLAG_OFF; }
  const sub = a._[1];
  const posts = () => createPostStore({ ledgerFile: path.join(dataDir, 'posting', LEDGER_NAME), dataDir }).list();
  try {
    if (sub === 'fetch') {
      const auth = (deps.createInstagramAuth ?? createInstagramAuth)({ browserOpen: async () => { throw new Error('connect from: node services/posting/cli.mjs instagram connect'); } });
      const r = await collectInstagram({ dataDir, auth, posts: posts(), fetchImpl: deps.fetchImpl ?? fetch, endpoints: deps.endpoints, cfg: deps.cfg, now: deps.now, force: a.force === true });
      if (r.skipped) { out(`instagram: read less than an hour ago (${r.lastFetchAt}); use --force to read again`); return 0; }
      out(`instagram: ${r.reels} posted Reel(s), ${r.snapshots} snapshot(s) stored${r.failed ? `, ${r.failed} could not be read` : ''}${r.stopped ? ' (stopped: Instagram asked to slow down)' : ''}`);
      return 0;
    }
    if (sub === 'show') {
      const store = openIgStore(path.join(dataDir, IG_DB_NAME));
      try {
        const rows = igSummary(store);
        if (a.json === true) { out(JSON.stringify(rows, null, 2)); return 0; }
        if (!rows.length) { out('instagram: no posted Reels stored yet (run: node services/analytics/cli.mjs instagram fetch)'); return 0; }
        for (const r of rows) {
          out(`${r.mediaId} post ${r.postId ?? '-'} posted ${r.postedAt ?? '-'} length ${r.lengthSec ?? '-'} s score@48h ${r.at48h ? reelScore(r.at48h.metrics, r.lengthSec) : '-'}`);
          out(`  ${igLine('48 h:', r.at48h)}`); out(`  ${igLine('7 d: ', r.at7d)}`); out(`  ${igLine('now: ', r.latest)}`);
        }
        return 0;
      } finally { store.close(); }
    }
    if (sub === 'winners') {
      const res = weeklyWinners({ dataDir, posts: posts(), nowMs: (deps.now ?? Date.now)(), perWeek: deps.perWeek, dryRun: a['dry-run'] === true });
      if (a.json === true) { out(JSON.stringify(res, null, 2)); return 0; }
      out(`instagram winners, week of ${res.week}${res.dryRun ? ' (dry run: the window ending now, nothing recorded)' : res.ran ? ' (recorded now)' : ' (recorded earlier this week)'}`);
      if (!res.winners.length) out('  none');
      for (const w of res.winners) out(`  ${String(w.rank).padStart(2)}. ${w.postId} score ${w.score ?? '-'}`);
      for (const r of (res.ranked ?? []).filter((x) => !x.eligible)) out(`  -- ${r.postId} score ${r.score ?? '-'} not promoted: ${r.why}`);
      return 0;
    }
    err('usage: node services/analytics/cli.mjs instagram fetch [--force] | show [--json] | winners [--dry-run] [--json]');
    return 2;
  } catch (e) {
    if (e?.code === 'insights-scope-missing') { err('instagram: reading Reel numbers is not allowed yet -- click Connect again (Settings > Posting & growth > Instagram)'); return 1; }
    if (e?.code === 'reauth-needed' || e?.code === 'no-app') { err('instagram: not connected -- connect Instagram in Settings > Posting & growth'); return 1; }
    err(`instagram: ${e?.message ?? 'error'}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
