// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB6 (D392): a local vision model as the adapter of the read hook (read.mjs `opts.model`). The model runs
// in LM Studio on this PC (OpenAI-compatible server, `qwen/qwen3-vl-4b` by default); the address must be local
// (services/local-ai.mjs), nothing else is ever called. One picture goes out: the middle sampled frame of the reference,
// as a PNG, plus the rules' slot list as plain text. The answer is parsed here into the hook's shape; read.mjs checks the
// shape again and merges it (a model slot replaces a rules slot only with a higher confidence).
//
// Coordinates: the model is asked for bbox_2d [x1, y1, x2, y2] on a 0-1000 scale of the picture (Qwen3-VL's grounding
// scale), turned here into box fractions and clipped to the frame. Confidence is the model's own figure, capped at
// MODEL_CONFIDENCE_CAP so a sure rules slot is not replaced on a guess (calibration UNVERIFIED).
// Loading: LM Studio loads the named model on the first request and unloads it after `ttl` seconds idle (UNVERIFIED for
// every LM Studio version). Callers decide when a call is allowed (never while live or recording: 6 GB VRAM, D1).
// Privacy: the picture is the user's own reference file and goes to the local server only; nothing is logged.

import { crc32, deflateSync } from 'node:zlib';
import { DEFAULT_AI_URL, localAiUrl } from '../local-ai.mjs';

export const DEFAULT_VISION_MODEL = 'qwen/qwen3-vl-4b';
export const VISION_TTL_S = 120;
export const VISION_TIMEOUT_MS = 90_000;
export const MODEL_CONFIDENCE_CAP = 0.85;
const ROLES = new Set(['game', 'camera', 'chat', 'alerts', 'graphics']); // the read schema's roles (layout.mjs)
const FAMILIES = new Set(['sans', 'serif', 'mono', 'display', 'script']);
const MAX_GRAPHICS = 6;

const PROMPT = [
  'You look at one picture of a live stream layout. Find these areas:',
  '- game: the gameplay video',
  "- camera: the streamer's webcam or face cam",
  '- chat: a box of chat messages',
  '- alerts: a follower/subscriber alert box or banner',
  '- graphics: other panels, logos, labels or frames (at most 6)',
  'Leave out an area that is not in the picture. At most one game, camera, chat and alerts.',
  'Answer with one JSON object only, no other text:',
  '{"slots": [{"role": "game", "bbox_2d": [x1, y1, x2, y2], "confidence": 0.0}], "font": "sans"}',
  'bbox_2d is on a 0-1000 scale of the picture width and height. confidence is 0..1.',
  'font is the look of the overlay text: sans, serif, mono, display, script, or null.',
].join('\n');

/** An rgb24 frame as a PNG (colour type 2, 8 bit). */
export function rgbPng(width, height, rgb) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = width * 3, raw = Buffer.alloc((row + 1) * height);
  for (let j = 0; j < height; j++) rgb.copy(raw, j * (row + 1) + 1, j * row, (j + 1) * row);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The first JSON object in a model's text (code fences and chatter around it allowed), or null. */
export function jsonIn(text) {
  if (typeof text !== 'string') return null;
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clip = (v) => Math.min(1, Math.max(0, v));

/** A model's parsed answer -> the hook's { slots, type } (bad entries dropped). */
export function answerToRead(answer) {
  const slots = [];
  let graphics = 0;
  const seen = new Set();
  for (const s of Array.isArray(answer?.slots) ? answer.slots : []) {
    if (!s || !ROLES.has(s.role) || (s.role !== 'graphics' && seen.has(s.role))) continue;
    if (s.role === 'graphics' && graphics >= MAX_GRAPHICS) continue;
    const bb = Array.isArray(s.bbox_2d) && s.bbox_2d.length === 4 ? s.bbox_2d.map(num) : null;
    if (!bb || bb.some((v) => v === null)) continue;
    const x1 = clip(Math.min(bb[0], bb[2]) / 1000), x2 = clip(Math.max(bb[0], bb[2]) / 1000);
    const y1 = clip(Math.min(bb[1], bb[3]) / 1000), y2 = clip(Math.max(bb[1], bb[3]) / 1000);
    if (x2 - x1 < 0.01 || y2 - y1 < 0.01) continue;
    const c = num(s.confidence);
    const r4 = (v) => Math.round(v * 10000) / 10000;
    slots.push({
      role: s.role,
      box: { x: r4(x1), y: r4(y1), w: r4(Math.min(x2 - x1, 1 - r4(x1))), h: r4(Math.min(y2 - y1, 1 - r4(y1))) },
      confidence: Math.min(MODEL_CONFIDENCE_CAP, clip(c ?? 0.5)),
      evidence: ['local vision model'],
    });
    if (s.role === 'graphics') graphics++; else seen.add(s.role);
  }
  const font = typeof answer?.font === 'string' ? answer.font.toLowerCase() : null;
  return { slots, ...(FAMILIES.has(font) ? { type: { family: font } } : {}) };
}

/**
 * The read hook's adapter for a local vision model. opts: { url, model, fetch, timeoutMs, signal }.
 * Throws when the address is not on this PC (no adapter is made, so no call can happen).
 */
export function visionAdapter({ url = DEFAULT_AI_URL, model = DEFAULT_VISION_MODEL, fetch = globalThis.fetch, timeoutMs = VISION_TIMEOUT_MS, signal = null } = {}) {
  const href = localAiUrl(url);
  if (!href) throw new Error('vision model: the server address must be on this PC (127.0.0.1, localhost or ::1)');
  if (typeof model !== 'string' || !/^[\w.:/@-]{1,200}$/.test(model)) throw new Error('vision model: bad model name');
  return {
    id: `lmstudio-${model.replace(/[^a-z0-9._-]/gi, '-').slice(0, 70)}`,
    local: true,
    async analyze({ canvas, frames, rules }) {
      const f = frames[Math.floor(frames.length / 2)];
      const picture = rgbPng(f.width, f.height, f.rgb).toString('base64');
      const found = (rules?.slots ?? []).map((s) => `${s.role} at x ${s.box.x.toFixed(2)} y ${s.box.y.toFixed(2)} w ${s.box.w.toFixed(2)} h ${s.box.h.toFixed(2)}`);
      const text = `Picture ${f.width}x${f.height} (${canvas === 'V' ? 'portrait' : 'landscape'}). A simple detector found: ${found.length ? found.join('; ') : 'nothing'}. Check and correct it.`;
      const body = {
        model,
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${picture}` } }] },
        ],
        temperature: 0, max_tokens: 800, stream: false, ttl: VISION_TTL_S,
      };
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
      const r = await fetch(href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any(signals) });
      if (r.status !== 200) { try { await r.text(); } catch { /* not used */ } throw new Error(`server answered ${r.status}`); }
      const answer = jsonIn((await r.json())?.choices?.[0]?.message?.content);
      if (!answer) throw new Error('no JSON in the answer');
      return answerToRead(answer);
    },
  };
}
