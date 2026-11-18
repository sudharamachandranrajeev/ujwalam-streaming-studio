// SPDX-License-Identifier: GPL-3.0-or-later
// Scene builder SB6 (D392): the local vision model adapter (services/scene-builder/vision.mjs) and the shared local
// address check (services/common/local-ai.mjs). No model runs here: a fake fetch answers like LM Studio's OpenAI-compatible
// server. The real model read is checked by hand on the user's references (evidence file).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { localAiUrl } from '../services/common/local-ai.mjs';
import { loadReference } from '../services/scene-builder/frames.mjs';
import { readFrames } from '../services/scene-builder/read.mjs';
import { answerToRead, DEFAULT_VISION_MODEL, jsonIn, MODEL_CONFIDENCE_CAP, rgbPng, visionAdapter, VISION_TTL_S } from '../services/scene-builder/vision.mjs';
import { main as cli } from '../services/scene-builder/cli.mjs';
import { layoutH, writePng } from './helpers/sb-fixtures.mjs';

let dir, ref;
before(async () => { dir = mkdtempSync(path.join(os.tmpdir(), 'ujw-sb6-')); ref = await loadReference(writePng(layoutH().canvas, dir, 'vision')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

const reply = (content, status = 200) => ({ status, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '' });

describe('local address', () => {
  test('only this PC is accepted', () => {
    assert.equal(localAiUrl('http://127.0.0.1:1234/v1/chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions');
    assert.ok(localAiUrl('http://localhost:1234/x'));
    assert.ok(localAiUrl('http://[::1]:1234/x'));
    for (const bad of ['http://192.168.1.5:1234/x', 'https://api.example.com/v1', 'http://user:pw@127.0.0.1/x', 'file:///c:/x', 'not a url', 'http://127.0.0.1.example.com/x']) assert.equal(localAiUrl(bad), null, bad);
  });
  test('no adapter is made for a remote address', () => {
    assert.throws(() => visionAdapter({ url: 'https://api.example.com/v1/chat/completions' }), /on this PC/);
    assert.throws(() => visionAdapter({ model: 'bad name with spaces' }), /model name/);
  });
});

describe('answer parsing', () => {
  test('JSON is found inside code fences and chatter', () => {
    assert.deepEqual(jsonIn('Sure:\n```json\n{"slots": []}\n```'), { slots: [] });
    assert.equal(jsonIn('no json here'), null);
    assert.equal(jsonIn('{broken'), null);
  });
  test('0-1000 boxes become fractions, clipped; duplicates, bad boxes and unknown roles are dropped; confidence capped', () => {
    const r = answerToRead({
      slots: [
        { role: 'game', bbox_2d: [250, 0, 1000, 1000], confidence: 0.99 },
        { role: 'game', bbox_2d: [0, 0, 100, 100], confidence: 0.9 },
        { role: 'camera', bbox_2d: [200, 260, 20, 40], confidence: 0.7 },
        { role: 'chat', bbox_2d: [0, 300, 240, 1200] },
        { role: 'alerts', bbox_2d: [1, 2, 3] },
        { role: 'screen', bbox_2d: [0, 0, 500, 500], confidence: 0.5 },
        { role: 'graphics', bbox_2d: [0, 0, 5, 5], confidence: 0.5 },
      ],
      font: 'Sans',
    });
    assert.deepEqual(r.slots.map((s) => s.role), ['game', 'camera', 'chat']);
    assert.deepEqual(r.slots[0].box, { x: 0.25, y: 0, w: 0.75, h: 1 });
    assert.equal(r.slots[0].confidence, MODEL_CONFIDENCE_CAP);
    assert.deepEqual(r.slots[1].box, { x: 0.02, y: 0.04, w: 0.18, h: 0.22 });
    assert.deepEqual(r.slots[2].box, { x: 0, y: 0.3, w: 0.24, h: 0.7 });
    assert.equal(r.slots[2].confidence, 0.5);
    assert.deepEqual(r.type, { family: 'sans' });
    assert.equal(answerToRead({ slots: [], font: 'comic' }).type, undefined);
  });
  test('the picture is a valid rgb PNG of the frame', () => {
    const rgb = Buffer.alloc(4 * 3 * 3, 200);
    const p = rgbPng(4, 3, rgb);
    assert.deepEqual([...p.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(p.readUInt32BE(16), 4); assert.equal(p.readUInt32BE(20), 3); assert.equal(p[25], 2);
    const idatLen = p.readUInt32BE(33);
    assert.equal(p.subarray(37, 41).toString('ascii'), 'IDAT');
    assert.equal(inflateSync(p.subarray(41, 41 + idatLen)).length, (4 * 3 + 1) * 3);
  });
});

describe('through the read hook', () => {
  test('one local request with the picture; the model camera replaces a weaker rules camera', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return reply('```json\n{"slots":[{"role":"camera","bbox_2d":[20,40,220,300],"confidence":0.8}],"font":"display"}\n```');
    };
    const rules = await readFrames(ref);
    const r = await readFrames(ref, { model: visionAdapter({ fetch }) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(calls[0].init.redirect, 'error');
    const b = calls[0].body;
    assert.equal(b.model, DEFAULT_VISION_MODEL);
    assert.equal(b.ttl, VISION_TTL_S);
    assert.equal(b.stream, false);
    const img = b.messages[1].content.find((c) => c.type === 'image_url').image_url.url;
    assert.match(img, /^data:image\/png;base64,/);
    assert.equal(Buffer.from(img.split(',')[1], 'base64').readUInt32BE(16), ref.frames[0].width);
    assert.equal(r.detector.model, 'lmstudio-qwen-qwen3-vl-4b');
    assert.equal(r.style.type.family, 'display');
    const cam = r.slots.filter((s) => s.role === 'camera');
    assert.equal(cam.length, 1);
    const ruleCam = rules.slots.find((s) => s.role === 'camera');
    if (!ruleCam || ruleCam.confidence < 0.8) assert.equal(cam[0].source, 'model');
    else assert.notEqual(cam[0].source, 'model');
  });
  test('server down, an error status or no JSON keeps the rules result with a note', async () => {
    const rules = await readFrames(ref);
    for (const fetch of [async () => { throw new Error('connect ECONNREFUSED'); }, async () => reply('', 404), async () => reply('I cannot see the picture')]) {
      const r = await readFrames(ref, { model: visionAdapter({ fetch }) });
      assert.deepEqual(r.slots, rules.slots);
      assert.equal(r.detector.model, null);
      assert.match(r.notes.at(-1), /model lmstudio-qwen-qwen3-vl-4b failed .*; rules result kept/);
    }
  });
});

describe('CLI --ai', () => {
  test('refused outside read, build and theme', async () => {
    const errs = [];
    const code = await cli(['import', 'x.json', '--project', 'p.json', '--ai'], () => {}, (s) => errs.push(s), { flagsOn: () => true });
    assert.equal(code, 1);
    assert.match(errs[0], /--ai is for read, build and theme/);
  });
  test('read --ai asks the model through the given fetch', async () => {
    const outs = [];
    let asked = 0;
    const aiFetch = async () => { asked++; return reply('{"slots":[],"font":null}'); };
    const code = await cli(['read', path.join(dir, 'vision.png'), '--ai'], (s) => outs.push(s), () => {}, { flagsOn: () => true, aiFetch });
    assert.equal(code, 0);
    assert.equal(asked, 1);
    assert.equal(JSON.parse(outs[0]).detector.model, 'lmstudio-qwen-qwen3-vl-4b');
  });
});
