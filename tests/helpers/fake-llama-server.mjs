// SPDX-License-Identifier: GPL-3.0-or-later
// A stand-in for llama-server (D443 T1 tests): parses --port and --n-gpu-layers, answers /health and
// /v1/chat/completions on 127.0.0.1. FAKE_LLAMA_GPU_FAIL=1: exits at once when GPU layers > 0 (a CUDA start that
// fails). FAKE_LLAMA_HEALTH_DELAY_MS: /health answers 503 until then. FAKE_LLAMA_REPLY: the message content.
// FAKE_LLAMA_REPLIES: a JSON array of message contents, one per request in turn (the last one repeats).
import http from 'node:http';

const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const port = Number(arg('--port'));
const layers = Number(arg('--n-gpu-layers'));
if (process.env.FAKE_LLAMA_GPU_FAIL === '1' && layers > 0) { process.stderr.write('CUDA error: out of memory\n'); process.exit(1); }
const t0 = Date.now();
const delay = Number(process.env.FAKE_LLAMA_HEALTH_DELAY_MS ?? 0);
const replies = process.env.FAKE_LLAMA_REPLIES ? JSON.parse(process.env.FAKE_LLAMA_REPLIES) : null;
let asked = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(Date.now() - t0 >= delay ? 200 : 503); res.end('{}'); return; }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const j = JSON.parse(b);
      const images = j.messages.at(-1).content.filter((c) => c.type === 'image_url').length;
      const content = replies ? replies[Math.min(asked++, replies.length - 1)] : process.env.FAKE_LLAMA_REPLY ?? JSON.stringify({ ok: true, images, layers, format: j.response_format?.type });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1', () => process.stdout.write(`listening ${port} layers ${layers}\n`));
