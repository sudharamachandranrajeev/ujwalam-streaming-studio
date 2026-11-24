// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T6 live voice marks. Node stdlib only.
//
// A marker phrase (data/clip/excitement.json phrases: adipoli, polich/pwolich, scene, super; Malayalam script,
// Manglish Latin spellings, English) heard in a line of a live transcript writes one host clip marker (source 'audio',
// note 'voice: marker phrase <id> forced|word'), at most one per phrase per live.minGapSec and one in total per
// live.anyGapSec. Post-stream, clip_signals.read_markers turns that note into a 'voice' marker (voice.phrase /
// voice.word), never a force-kept marker.audio. NOT WIRED: no live transcriber exists yet, so nothing calls heard().
// It only marks the moment: the host link it gets is the markers link (marker.add, mixer.list), which the host itself
// limits to those two methods (rpc_server.h Role::Markers). Nothing here can start, stop or change the stream.
//
// Matching is the same rule as services/clip/excitement.py match_phrases (tests keep both on the same samples):
// Latin as whole adjacent words after NFC and lower-casing, runs of 3+ equal letters folded; Malayalam at a word start
// (endings only where malayalamSuffix). forced: any Malayalam-script hit, or a Latin hit where forceLatin.
// The transcript text is only tested in memory: no text is kept, logged or sent (the note holds the phrase id only).
// Flag 'voice-excitement' (data/flags.json) is read on every line; off = no host call at all. Every failure is counted,
// never thrown.
//
//   const vm = createVoiceMarks({ flags, host });  vm.heard(text); vm.stats();

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FLAG = 'voice-excitement';
export const CONFIG_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'clip', 'excitement.json');
export const MAX_INFLIGHT = 2;

const lower = (s) => s.normalize('NFC').toLowerCase();
const latinWords = (s) => s.match(/[a-z0-9]+/g) ?? [];
// runs of 3+ equal letters fold to one and to two; runs of 2 are kept ('supper' is never 'super')
const wordForms = (w) => new Set([w, w.replace(/(.)\1{2,}/gu, '$1'), w.replace(/(.)\1{2,}/gu, '$1$1')]);
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

function malayalamHit(norm, m, suffix) {
  for (let i = norm.indexOf(m); i >= 0; i = norm.indexOf(m, i + 1)) {
    const j = i + m.length;
    if ((i === 0 || !WORD_CHAR.test(norm[i - 1])) && (suffix || j >= norm.length || !WORD_CHAR.test(norm[j]))) return true;
  }
  return false;
}

/** Reads data/clip/excitement.json; throws on a missing or bad value. */
export function loadVoiceConfig(file = CONFIG_FILE) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const items = j?.phrases?.items;
  if (!Array.isArray(items) || !items.length) throw new Error('voice-marks config: no phrases');
  for (const it of items) {
    if (typeof it?.id !== 'string' || !/^[a-z0-9-]+$/.test(it.id)) throw new Error('voice-marks config: bad phrase id');
  }
  const l = j.live ?? {};
  for (const k of ['minGapSec', 'anyGapSec', 'maxTextChars', 'hostTimeoutMs']) {
    if (typeof l[k] !== 'number' || !(l[k] >= 0)) throw new Error(`voice-marks config: bad live.${k}`);
  }
  return Object.freeze({ status: String(j.status ?? 'unknown'), items, live: Object.freeze({ ...l }) });
}

/** -> [{ id, latin: [[token]], malayalam: [string], forceLatin, malayalamSuffix }] */
export function compilePhrases(items) {
  return items.map((it) => ({
    id: it.id,
    latin: (it.latin ?? []).map((v) => latinWords(lower(v))).filter((t) => t.length),
    malayalam: (it.malayalam ?? []).map((v) => v.normalize('NFC')).filter(Boolean),
    forceLatin: it.forceLatin === true,
    malayalamSuffix: it.malayalamSuffix === true,
  }));
}

/** [{ id, forced }] in text, each id once, in config order (same rule as excitement.py match_detail). */
export function matchDetail(text, compiled) {
  if (typeof text !== 'string' || !text) return [];
  const norm = text.normalize('NFC');
  const forms = latinWords(lower(norm)).map(wordForms);
  const out = [];
  for (const p of compiled) {
    if (p.malayalam.some((m) => malayalamHit(norm, m, p.malayalamSuffix))) { out.push({ id: p.id, forced: true }); continue; }
    let hit = false;
    for (const toks of p.latin) {
      for (let i = 0; i + toks.length <= forms.length && !hit; i++) hit = toks.every((t, k) => forms[i + k].has(t));
      if (hit) break;
    }
    if (hit) out.push({ id: p.id, forced: p.forceLatin });
  }
  return out;
}

/** Phrase ids in text, each once, in config order. */
export const matchPhrases = (text, compiled) => matchDetail(text, compiled).map((x) => x.id);

/**
 * opts: { flags: { isOn(id) }, host: { addMarker(source, note) }, config?, now?() ms, log?(line) }.
 * Returns { heard(text, nowMs?) -> [ids marked], stats() }. Never throws after construction.
 */
export function createVoiceMarks(opts) {
  const { flags, host } = opts ?? {};
  if (!flags || typeof flags.isOn !== 'function') throw new Error('voice-marks: flags required');
  if (!host || typeof host.addMarker !== 'function') throw new Error('voice-marks: host required');
  const cfg = opts.config ?? loadVoiceConfig();
  const compiled = compilePhrases(cfg.items);
  const now = opts.now ?? (() => performance.now());
  const log = opts.log ?? (() => {});
  const gapMs = cfg.live.minGapSec * 1000, anyMs = cfg.live.anyGapSec * 1000;
  const last = new Map();
  let lastAny = -Infinity, inflight = 0;
  const st = { lines: 0, off: 0, matched: 0, suppressed: 0, written: 0, failures: 0, timeouts: 0, dropped: 0, errors: 0, byPhrase: {} };

  // Review fix 6: a host call that never answers frees its slot after hostTimeoutMs and counts as a failure.
  const timeoutMs = cfg.live.hostTimeoutMs;
  const setT = opts.setTimeout ?? setTimeout, clearT = opts.clearTimeout ?? clearTimeout;
  function write(id, forced) {
    if (inflight >= MAX_INFLIGHT) { st.dropped++; return; }
    inflight++;
    let p, timer;
    try { p = Promise.resolve(host.addMarker('audio', `voice: marker phrase ${id} ${forced ? 'forced' : 'word'}`)); } catch (e) { p = Promise.reject(e); }
    const limit = new Promise((_, rej) => { timer = setT(() => { st.timeouts++; rej(new Error('timeout')); }, timeoutMs); timer?.unref?.(); });
    Promise.race([p, limit]).then(() => { st.written++; }, () => { st.failures++; }).finally(() => { clearT(timer); inflight--; });
  }

  return {
    heard(text, nowMs) {
      try {
        st.lines++;
        let on = false;
        try { on = flags.isOn(FLAG) === true; } catch { on = false; }
        if (!on) { st.off++; return []; }
        const t = typeof nowMs === 'number' ? nowMs : now();
        const found = matchDetail(typeof text === 'string' ? text.slice(0, cfg.live.maxTextChars) : '', compiled);
        const marked = [];
        for (const { id, forced } of found) {
          st.matched++;
          st.byPhrase[id] = (st.byPhrase[id] ?? 0) + 1;
          if (t - (last.get(id) ?? -Infinity) < gapMs || t - lastAny < anyMs) { st.suppressed++; continue; }
          last.set(id, t);
          lastAny = t;
          write(id, forced);
          marked.push(id);
        }
        return marked;
      } catch {
        st.errors++;
        log('[voice-marks] error');
        return [];
      }
    },
    stats: () => ({ ...st, byPhrase: { ...st.byPhrase }, inflight, status: cfg.status }),
  };
}
