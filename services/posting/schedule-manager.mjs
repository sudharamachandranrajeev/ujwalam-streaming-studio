// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduling manager (SM1-SM4, plan docs/plan/2026-11-25-scheduling-manager.md): one flat list of every scheduled post for
// the studio's scheduling manager window, read from the same files the Settings card used (the upload queue, the saved
// channel times and the Instagram queue). No posting logic of its own; moving, removing and retrying use the existing
// routes. Node stdlib only.
//   scheduleManagerView(dataDir, { posts, nowMs, brief, channel }) -> { error, source, channelReadAt, counts, nextAt, channels, rows }
//   Row: { key, id, channel, channelText, platform, target, targetText, kind, title, state, stateText, reasonText, at, movable,
//          removable, retryable, postable, postText }
//   state: waiting | uploading | scheduled | held | failed | channel   (Instagram: waiting | posting | failed)
//   SM5 (YM6): `channel` is the local id of the YouTube channel the row goes to ('main', 'ch-...'; '' = not given to a
//   channel yet, and every Instagram row); channelText is its label. `channels` lists the channels ([{ id, label }]);
//   opts.channel ('' = all) keeps only that channel's rows (counts and nextAt follow the filter).
//   Instagram winners: every row has igScore (the clip's 48 h Instagram score or null); nextWeekToYoutube lists the
//   Reels a weekly run would send to YouTube now ([{ id, title, score, rank }], a preview; nothing is recorded).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { IG_DB_NAME, igScores, openIgStore, weeklyWinners } from '../analytics/instagram.mjs';
import { QUEUE_NAME, createUploadQueue, reasonText, shownPublishAt } from './auto-chain.mjs';
import { schedulePreview } from './auto-settings.mjs';
import { createInstagramQueue, IG_QUEUE_NAME, igReasonText } from './instagram-queue.mjs';
import { MAIN, accountOf, channelLabel, readAccounts } from './accounts.mjs';

export const TARGET_TEXT = Object.freeze({ 'youtube-shorts': 'YouTube Shorts', 'youtube-video': 'YouTube video', 'instagram-reels': 'Instagram Reels' });
const ms = (s) => { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; };
const clean = (s, n = 140) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n) : '');

const YT_STATE = Object.freeze({ queued: 'waiting', uploading: 'uploading', done: 'scheduled', failed: 'failed' });
const YT_TEXT = Object.freeze({ waiting: 'Waiting to upload', uploading: 'Uploading to YouTube', scheduled: 'Uploaded, goes public at its time', failed: 'Failed', held: 'Held for Instagram test' });
const IG_STATE = Object.freeze({ waiting: 'waiting', posting: 'posting', failed: 'failed' });
const IG_TEXT = Object.freeze({ waiting: 'Waiting to post', posting: 'Posting now', failed: 'Failed' });

export function scheduleManagerView(dataDir, { posts = [], nowMs = Date.now(), brief = false, channel = '', winnersPerWeek } = {}) {
  const pv = schedulePreview(dataDir, { nowMs, count: 0 });
  let accounts; try { accounts = readAccounts(dataDir).accounts; } catch { accounts = [{ id: MAIN, label: 'Main channel' }]; }
  const chText = (id) => (id === '' ? '' : channelLabel(accounts, id));
  const byId = new Map(posts.map((p) => [p.id, p]));
  const rows = [];
  const queue = createUploadQueue(path.join(dataDir, 'posting', QUEUE_NAME), () => nowMs);
  for (const i of queue.items()) {
    // hold.mjs: an uploaded video taken off its schedule (private, no publish time) is listed as held, without a time
    const state = i.state === 'done' && typeof i.heldAt === 'string' ? 'held' : YT_STATE[i.state];
    if (!state) continue; // removed items are not listed
    const at = shownPublishAt(i);
    if (state === 'scheduled' && !(ms(at) > nowMs)) continue; // already public: history, not a schedule
    const p = byId.get(i.id);
    const reason = state === 'failed' || state === 'waiting' ? reasonText(i.reason) : state === 'held' ? reasonText('held-instagram-test') : null;
    const ch = accountOf(i) ?? '';
    rows.push({
      key: `yt:${i.id}`, id: i.id, channel: ch, channelText: ch === '' ? channelLabel(accounts, null) : chText(ch), platform: 'youtube', target: p?.target === 'youtube-video' ? 'youtube-video' : 'youtube-shorts',
      kind: clean(p?.kind, 40), title: clean(p?.title) || clean(p?.clipId) || 'Clip', state, stateText: YT_TEXT[state],
      reasonText: reason ? clean(reason, 200) : '', at: at ?? null,
      movable: i.state === 'queued' && !i.session && typeof at === 'string', removable: i.state === 'queued' || i.state === 'failed',
      retryable: i.state === 'failed', postable: i.state === 'queued', postText: 'Upload now',
    });
  }
  let igQueue = null;
  try { igQueue = createInstagramQueue(path.join(dataDir, 'posting', IG_QUEUE_NAME)); } catch { igQueue = null; }
  for (const i of igQueue ? igQueue.items() : []) {
    const state = IG_STATE[i.state];
    if (!state) continue; // done or dropped
    const p = byId.get(i.id);
    rows.push({
      key: `ig:${i.id}`, id: i.id, channel: '', channelText: '', platform: 'instagram', target: 'instagram-reels', kind: clean(p?.kind, 40),
      title: clean(p?.title) || clean(p?.clipId) || 'Clip', state, stateText: IG_TEXT[state],
      reasonText: i.reason ? clean(igReasonText(i.reason), 200) : '', at: i.dueAt ?? null,
      movable: false, removable: false, retryable: i.state === 'failed', postable: i.state === 'waiting', postText: 'Post now',
    });
  }
  for (const c of pv.channel) {
    rows.push({ key: `ch:${c}`, id: '', channel: MAIN, channelText: chText(MAIN), platform: 'youtube', target: 'youtube-video', kind: '', title: 'Already scheduled on your channel', state: 'channel',
      stateText: 'On the channel', reasonText: '', at: c, movable: false, removable: false, retryable: false, postable: false, postText: '' });
  }
  // Instagram winners (2026-11-26): the 48 h Instagram score of each row's clip, and the Reels the next weekly run would
  // send to YouTube (a preview, nothing recorded). Read only; no store yet = no scores.
  let nextWeek = [];
  if (existsSync(path.join(dataDir, IG_DB_NAME))) {
    let s = null;
    try {
      s = openIgStore(path.join(dataDir, IG_DB_NAME));
      const scores = igScores(s);
      for (const r of rows) r.igScore = Object.hasOwn(scores, r.id) ? scores[r.id] : null;
      nextWeek = weeklyWinners({ dataDir, posts, nowMs, perWeek: winnersPerWeek, dryRun: true, store: s }).winners
        .map((w) => ({ id: w.postId, title: clean(w.title) || clean(w.clipId) || 'Clip', score: w.score, rank: w.rank }));
    } catch { nextWeek = []; } finally { s?.close(); }
  }
  for (const r of rows) if (!Object.hasOwn(r, 'igScore')) r.igScore = null;
  if (typeof channel === 'string' && channel) { const keep = rows.filter((r) => r.channel === channel); rows.length = 0; rows.push(...keep); }
  const times = rows.filter((r) => r.state !== 'failed').map((r) => ms(r.at)).filter((t) => t !== null && t > nowMs).sort((a, b) => a - b);
  const count = (s) => rows.filter((r) => r.state === s).length;
  const out = {
    error: pv.error, source: pv.source, channelReadAt: pv.channelReadAt,
    counts: { total: rows.length, waiting: count('waiting'), uploading: count('uploading'), scheduled: count('scheduled'), failed: count('failed'), channel: count('channel'), posting: count('posting'), held: count('held') },
    nextAt: times.length ? new Date(times[0]).toISOString() : null,
    channels: accounts.map((a) => ({ id: a.id, label: a.label })),
    nextWeekToYoutube: nextWeek,
  };
  if (!brief) out.rows = rows;
  return out;
}
