// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T6 live voice marks. Node stdlib only.
//
// A marker phrase (data/clip/excitement.json phrases: adipoli, polich/pwolich, scene, super; Malayalam script,
// Manglish Latin spellings, English) heard in a line of a live transcript writes one host clip marker (source 'audio',
// note 'voice: marker phrase <id>'), at most one per phrase per live.minGapSec and one in total per live.anyGapSec.
// It only marks the moment: the host link it gets is the markers link (marker.add, mixer.list), which the host itself
// limits to those two methods (rpc_server.h Role::Markers). Nothing here can start, stop or change the stream.
//
// Matching is the same rule as services/clip/excitement.py match_phrases (tests keep both on the same samples):
// Latin as whole adjacent words after lower-casing, NFC and folding repeated letters; Malayalam as part of a word.
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

const fold = (s) => s.normalize('NFC').toLowerCase().replace(/(.)\1+/gu, '$1');
const latinWords = (s) => s.match(/[a-z0-9]+/g) ?? [];

/** Reads data/clip/excitement.json; throws on a missing or bad value. */
export function loadVoiceConfig(file = CONFIG_FILE) {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const items = j?.phrases?.items;
  if (!Array.isArray(items) || !items.length) throw new Error('voice-marks config: no phrases');
  for (const it of items) {
    if (typeof it?.id !== 'string' || !/^[a-z0-9-]+$/.test(it.id)) throw new Error('voice-marks config: bad phrase id');
  }
  const l = j.live ?? {};
  for (const k of ['minGapSec', 'anyGapSec', 'maxTextChars']) {
    if (typeof l[k] !== 'number' || !(l[k] >= 0)) throw new Error(`voice-marks config: bad live.${k}`);
  }
  return Object.freeze({ status: String(j.status ?? 'unknown'), items, live: Object.freeze({ ...l }) });
}

/** -> [{ id, latin: [[token]], malayalam: [string] }] */
export function compilePhrases(items) {
  return items.map((it) => ({
    id: it.id,
    latin: (it.latin ?? []).map((v) => latinWords(fold(v))).filter((t) => t.length),
    malayalam: (it.malayalam ?? []).map((v) => v.normalize('NFC')).filter(Boolean),
  }));
}

/** Phrase ids in text, each once, in config order. */
export function matchPhrases(text, compiled) {
  if (typeof text !== 'string' || !text) return [];
  const norm = text.normalize('NFC');
  const words = latinWords(fold(norm));
  const out = [];
  for (const p of compiled) {
    let hit = p.malayalam.some((m) => norm.includes(m));
    for (const toks of p.latin) {
      if (hit) break;
      for (let i = 0; i + toks.length <= words.length && !hit; i++) hit = toks.every((t, k) => words[i + k] === t);
    }
    if (hit) out.push(p.id);
  }
  return out;
}

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
  const st = { lines: 0, off: 0, matched: 0, suppressed: 0, written: 0, failures: 0, dropped: 0, errors: 0, byPhrase: {} };

  function write(id) {
    if (inflight >= MAX_INFLIGHT) { st.dropped++; return; }
    inflight++;
    let p;
    try { p = Promise.resolve(host.addMarker('audio', `voice: marker phrase ${id}`)); } catch (e) { p = Promise.reject(e); }
    p.then(() => { st.written++; }, () => { st.failures++; }).finally(() => { inflight--; });
  }

  return {
    heard(text, nowMs) {
      try {
        st.lines++;
        let on = false;
        try { on = flags.isOn(FLAG) === true; } catch { on = false; }
        if (!on) { st.off++; return []; }
        const t = typeof nowMs === 'number' ? nowMs : now();
        const ids = matchPhrases(typeof text === 'string' ? text.slice(0, cfg.live.maxTextChars) : '', compiled);
        const marked = [];
        for (const id of ids) {
          st.matched++;
          st.byPhrase[id] = (st.byPhrase[id] ?? 0) + 1;
          if (t - (last.get(id) ?? -Infinity) < gapMs || t - lastAny < anyMs) { st.suppressed++; continue; }
          last.set(id, t);
          lastAny = t;
          write(id);
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
