// SPDX-License-Identifier: GPL-3.0-or-later
// D443 T2: AI post text. For each post draft: 3-4 frames of the clip (ffmpeg, no console window), the streamer's own
// speech (a transcript.json or captions .srt beside the clip, if any) and the detector facts go to the local model in
// one json_schema call; the answer is checked (ai-text-check.mjs) and used only when every rule passes. Chat text is
// never an input. The model runs once per batch: withAiText() holds one runner.withModel() for the whole packaging pass.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
export async function grabFrames(ffmpeg, file, seconds, cfg, tmpRoot = os.tmpdir(), width = cfg.frames.width) {
  const dir = mkdtempSync(path.join(tmpRoot, 'ujw-aitext-'));
  try {
    const len = Number.isFinite(seconds) && seconds > 1 ? seconds : 20;
    const out = [];
    for (let i = 0; i < cfg.frames.at.length; i++) {
      const f = path.join(dir, `f${i}.jpg`);
      if (await oneFrame(ffmpeg, file, Math.max(0, Math.min(len - 0.2, len * cfg.frames.at[i])), width, f)) out.push(readFileSync(f));
    }
    return out;
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ } }
}

export const VOCAB_FILE = path.join(REPO, 'data', 'posting', 'ai-text-vocab.json');
const tokens = (s) => String(s).toLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []; // same words as the checker

/** Words allowed in the text even when they are on screen: the vocab file plus the labels of every game pack
 *  (data/games/<id>/events.json and screens.json: label, name, id, title values). -> Set<string> */
export function loadVocab({ file = VOCAB_FILE, gamesDir = path.join(REPO, 'data', 'games') } = {}) {
  const out = new Set();
  try { for (const w of JSON.parse(readFileSync(file, 'utf8')).words ?? []) for (const t of tokens(w)) out.add(t); } catch { /* none */ }
  const walk = (n) => {
    if (Array.isArray(n)) n.forEach(walk);
    else if (isPlain(n)) for (const [k, v] of Object.entries(n)) { if (typeof v === 'string' && ['label', 'name', 'id', 'title'].includes(k)) tokens(v).forEach((t) => out.add(t)); else walk(v); }
  };
  try {
    for (const g of readdirSync(gamesDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of ['events.json', 'screens.json']) { try { walk(JSON.parse(readFileSync(path.join(gamesDir, g.name, f), 'utf8'))); } catch { /* none */ } }
    }
  } catch { /* none */ }
  return out;
}

/** The Python with the OCR packages: UJWALAM_OCR_PYTHON, else a dev venv or the bundled runtime in the repo. null if none. */
export function ocrPython(root = REPO) {
  if (process.env.UJWALAM_OCR_PYTHON && existsSync(process.env.UJWALAM_OCR_PYTHON)) return process.env.UJWALAM_OCR_PYTHON;
  for (const rel of [['.venv-gpu', 'Scripts', 'python.exe'], ['.venv', 'Scripts', 'python.exe'], ['runtime', 'python', 'python.exe']]) {
    const p = path.join(root, ...rel);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * The words on screen in some frames (the repo's RapidOCR, services/clip/ocr_words.py), lowercase, 3+ chars.
 * Throws (code ocr-unavailable) when OCR cannot run: the caller fails closed.
 */
export async function ocrWords(frames, { python = ocrPython(), tmpRoot = os.tmpdir(), timeoutMs = 120000 } = {}) {
  if (!python) throw new LocalModelError('ocr-unavailable', 'no Python with the OCR packages');
  const dir = mkdtempSync(path.join(tmpRoot, 'ujw-ocr-'));
  try {
    const files = frames.map((b, i) => { const f = path.join(dir, `o${i}.jpg`); writeFileSync(f, b); return f; });
    const out = await new Promise((resolve, reject) => {
      let p; let buf = '';
      try { p = spawn(python, ['-I', path.join(REPO, 'services', 'clip', 'ocr_words.py'), ...files], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { return reject(e); }
      try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
      const t = setTimeout(() => { p.kill(); reject(new Error('timeout')); }, timeoutMs);
      p.stdout.on('data', (d) => { buf += d; });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(buf) : reject(new Error(`exit ${code}`)); });
    });
    const j = JSON.parse(out.trim().split(/\r?\n/).pop());
    if (!Array.isArray(j.words)) throw new Error('no words');
    return new Set(j.words.filter((w) => typeof w === 'string').map((w) => w.toLowerCase()));
  } catch (e) {
    throw e instanceof LocalModelError ? e : new LocalModelError('ocr-unavailable', `OCR could not run (${String(e?.message ?? e).slice(0, 80)})`);
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
  const vocab = deps.vocab ?? loadVocab();
  let opening = null; let release = null; let done = null;
  const open = () => (opening ??= new Promise((resolveOpen) => {
    done = Promise.resolve(deps.runner.withModel((m) => new Promise((rel) => { release = rel; resolveOpen({ m }); }))).catch((e) => resolveOpen({ err: e }));
  }));
  const fail = (code, detail) => { stats.rejected += 1; stats.rejects[code] = (stats.rejects[code] ?? 0) + 1; return { ok: false, code, detail }; };
  const gen = async ({ file, seconds, facts = {}, kind, limits, ffmpeg, cover = true }) => {
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
    // screen names: OCR of larger frames of the same clip; if OCR cannot run, nothing is accepted (template text)
    let screenWords;
    try {
      const big = await (deps.grab ?? grabFrames)(ffmpeg, file, seconds, cfg, deps.tmpRoot, cfg.ocr.width);
      screenWords = await (deps.ocr ?? ocrWords)(big, { python: deps.ocrPython, tmpRoot: deps.tmpRoot, timeoutMs: cfg.ocr.timeoutMs });
    } catch (e) { return fail('ocr-unavailable', String(e?.message ?? '').slice(0, 120)); }
    const r = checkAiText({ answer, facts, seconds, limits, cfg, profileTerms: terms, screenWords, vocab, cover });
    if (!r.ok) { deps.onReject?.(r, answer); return fail(r.code, r.detail); }
    return r;
  };
  gen.stats = stats;
  gen.version = cfg.version;
  try { return await fn(gen, null, stats); } finally { try { release?.(); await done; } catch { /* the model stops itself */ } }
}
