// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T2: AI post text. For each post draft: 3-4 frames of the clip (ffmpeg, no console window), the streamer's own
// speech (a transcript.json or captions .srt beside the clip, if any) and the detector facts go to the local model in
// one json_schema call; the answer is checked (ai-text-check.mjs) and used only when every rule passes. Chat text is
// never an input. The model runs once per batch: withAiText() holds one runner.withModel() for the whole packaging pass.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatJson, LocalModelError } from '../local-model/runner.mjs';
import { checkAiText, termsOfProfile } from './ai-text-check.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AI_TEXT_FLAG = 'ai-post-text';
export const AI_TEXT_FILE = path.join(REPO, 'data', 'posting', 'ai-text.json');
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function loadAiTextConfig(file = AI_TEXT_FILE) { return JSON.parse(readFileSync(file, 'utf8')); }

/** Terms of the local profile that must not appear in post text; [] when the file is missing or unreadable. */
export function loadProfileTerms(file = path.join(REPO, 'data', 'profile.local.json')) {
  try { return termsOfProfile(JSON.parse(readFileSync(file, 'utf8'))); } catch { return []; }
}

/** The JSON schema of the model's answer (sent as response_format json_schema; the checker still checks every rule). */
export function answerSchema(cfg) {
  const nul = (type) => ({ type: [type, 'null'] });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'description', 'tags', 'thumbHook', 'thumbTime', 'factsSeen'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' }, minItems: cfg.answer.tags.min, maxItems: cfg.answer.tags.max },
      thumbHook: { type: 'string' },
      thumbTime: { type: 'number' },
      factsSeen: {
        type: 'object', additionalProperties: false, required: ['kills', 'result', 'mode', 'medal'],
        properties: { kills: nul('integer'), result: nul('string'), mode: nul('string'), medal: nul('string') },
      },
    },
  };
}

const srtText = (s) => s.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l)).join(' ');
const jsonText = (j) => {
  if (typeof j === 'string') return j;
  if (Array.isArray(j)) return j.map(jsonText).join(' ');
  if (isPlain(j)) { if (typeof j.text === 'string') return j.text; if (Array.isArray(j.segments)) return j.segments.map(jsonText).join(' '); }
  return '';
};

/** The streamer's speech beside the clip: <clip>.transcript.json, transcript.json, <clip>.srt or captions.srt. '' if none. */
export function transcriptFor(file, maxChars = 1500) {
  const dir = path.dirname(file);
  const base = file.slice(0, file.length - path.extname(file).length);
  const tries = [[`${base}.transcript.json`, 'json'], [path.join(dir, 'transcript.json'), 'json'], [`${base}.srt`, 'srt'], [path.join(dir, 'captions.srt'), 'srt']];
  for (const [f, kind] of tries) {
    try {
      if (!existsSync(f) || statSync(f).size > 4_000_000) continue;
      const raw = readFileSync(f, 'utf8');
      const text = (kind === 'json' ? jsonText(JSON.parse(raw)) : srtText(raw)).replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, maxChars);
    } catch { /* unreadable: next */ }
  }
  return '';
}

/** One JPEG frame (width px) at `atSec`; resolves true on success. CPU, one thread, no console window. */
function oneFrame(ffmpeg, video, atSec, width, out) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-nostdin', '-y', '-threads', '1', '-ss', atSec.toFixed(3), '-i', video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '4', out];
    let p;
    try { p = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true }); } catch { return resolve(false); }
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
    const t = setTimeout(() => p.kill(), 60_000);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (code) => { clearTimeout(t); resolve(code === 0 && existsSync(out)); });
  });
}

/** 3-4 frames spread over the clip. -> Buffer[] (those that could be taken). */
export async function grabFrames(ffmpeg, file, seconds, cfg, tmpRoot = os.tmpdir()) {
  const dir = mkdtempSync(path.join(tmpRoot, 'ujw-aitext-'));
  try {
    const len = Number.isFinite(seconds) && seconds > 1 ? seconds : 20;
    const out = [];
    for (let i = 0; i < cfg.frames.at.length; i++) {
      const f = path.join(dir, `f${i}.jpg`);
      if (await oneFrame(ffmpeg, file, Math.max(0, Math.min(len - 0.2, len * cfg.frames.at[i])), cfg.frames.width, f)) out.push(readFileSync(f));
    }
    return out;
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ } }
}

const factsLine = (f) => {
  const l = [];
  if (f.killsText) l.push(`kills: ${f.killsText}`);
  if (f.result) l.push(`result: ${f.result}`);
  if (f.mode) l.push(`mode: ${f.mode}`);
  if (f.medal) l.push(`medal: ${f.medal}`);
  return l.length ? l.join('\n') : '(none)';
};

export function buildPrompt(cfg, { kind, seconds, facts, transcript }) {
  const v = {
    language: cfg.language, tone: cfg.tone, kind: String(kind), seconds: Number.isFinite(seconds) ? String(Math.round(seconds)) : 'unknown',
    facts: factsLine(facts ?? {}), transcript: transcript || '', tagMin: cfg.answer.tags.min, tagMax: cfg.answer.tags.max,
    descMin: cfg.answer.description.minLines, descMax: cfg.answer.description.maxLines, hookMin: cfg.answer.thumbHook.minWords, hookMax: cfg.answer.thumbHook.maxWords,
  };
  return cfg.prompt.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(v, k) ? String(v[k]) : m));
}

/**
 * The batch. deps: { runner (createModelRunner), isOn: () => bool (flag ai-post-text), cfg?, profileTerms?: string[],
 *   tmpRoot?, grab? (tests) }. fn(gen | null, why | null, stats) runs with a generator; why is the reason there is none.
 * The model starts at the first gen() call (nothing to draft = no start) and stops when fn ends: one withModel() per
 * batch. gen({ file, seconds, facts, kind, limits, ffmpeg }) -> { ok: true, text, factsSource } | { ok: false, code }.
 */
export async function withAiText(deps, fn) {
  const stats = { used: 0, rejected: 0, rejects: {} };
  let on = false;
  try { on = Boolean(deps?.isOn?.()); } catch { on = false; }
  if (!on || !deps?.runner) return fn(null, 'flag-off', stats);
  const cfg = deps.cfg ?? loadAiTextConfig();
  const terms = deps.profileTerms ?? loadProfileTerms();
  let opening = null; let release = null; let done = null;
  const open = () => (opening ??= new Promise((resolveOpen) => {
    done = Promise.resolve(deps.runner.withModel((m) => new Promise((rel) => { release = rel; resolveOpen({ m }); }))).catch((e) => resolveOpen({ err: e }));
  }));
  const fail = (code, detail) => { stats.rejected += 1; stats.rejects[code] = (stats.rejects[code] ?? 0) + 1; return { ok: false, code, detail }; };
  const gen = async ({ file, seconds, facts = {}, kind, limits, ffmpeg }) => {
    const h = await open();
    if (h.err) return fail(h.err instanceof LocalModelError ? h.err.code : 'error', String(h.err?.message ?? '').slice(0, 120));
    let frames;
    try { frames = await (deps.grab ?? grabFrames)(ffmpeg, file, seconds, cfg, deps.tmpRoot); } catch { frames = []; }
    if (!frames.length) return fail('no-frames', 'no frame could be taken from the clip');
    let answer;
    try {
      answer = await chatJson({ url: h.m.url, system: cfg.system, prompt: buildPrompt(cfg, { kind, seconds, facts, transcript: transcriptFor(file, cfg.transcriptMaxChars) }),
        images: frames, schema: answerSchema(cfg), timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxTokens, temperature: cfg.temperature });
    } catch (e) { return fail(e instanceof LocalModelError ? e.code : 'error', String(e?.message ?? '').slice(0, 120)); }
    const r = checkAiText({ answer, facts, seconds, limits, cfg, profileTerms: terms });
    if (!r.ok) return fail(r.code, r.detail);
    return r;
  };
  gen.stats = stats;
  gen.version = cfg.version;
  try { return await fn(gen, null, stats); } finally { try { release?.(); await done; } catch { /* the model stops itself */ } }
}
