// SPDX-License-Identifier: GPL-3.0-or-later
// Stream address helpers for per-broadcast platforms (Facebook Live, Instagram Live). Pure, Node stdlib only.
//
// A full stream URL such as rtmps://<ingest host>:443/rtmp/<key> is split into the server address (everything up to and
// including the last "/" of the path) and the key (the last path part plus any "?..." ending, which Facebook and
// Instagram keys carry and need). The server address must pass the host's rule (validLiveUrl: rtmps, a DNS name, no
// user, query or fragment), so a key can never ride in the server part. Nothing here logs or keeps a value; error
// messages never quote the input.
import { validLiveUrl } from '../../app/host/lib/outputs-plan.mjs';

const KEY_RE = /^[\x21-\x7e]{8,1000}$/; // printable ASCII, no spaces (the host reads printable ASCII up to 1023 chars)

export class PasteError extends Error {
  constructor(code, message) { super(message); this.name = 'PasteError'; this.code = code; }
}

/** rtmps://host[:port]/path/<key> -> { server, key }. Throws PasteError. */
export function splitStreamUrl(full, { transport = 'rtmps' } = {}) {
  if (typeof full !== 'string') throw new PasteError('not-text', 'Paste the stream URL as text.');
  const s = full.trim();
  if (!/^rtmps?:\/\//i.test(s)) throw new PasteError('not-rtmp', 'That does not look like a stream address. It should start with rtmps://');
  if (!s.toLowerCase().startsWith(`${transport}://`)) throw new PasteError('not-rtmps', `The stream address must start with ${transport}:// (a secure address).`);
  const afterHost = s.indexOf('/', transport.length + 3);
  if (afterHost < 0) throw new PasteError('no-key', 'The stream address has no stream key at its end.');
  const q = s.indexOf('?');
  const pathEnd = q < 0 ? s.length : q;
  const cut = s.lastIndexOf('/', pathEnd - 1);
  if (cut < afterHost || cut === pathEnd - 1) throw new PasteError('no-key', 'The stream address has no stream key at its end.');
  const server = s.slice(0, cut + 1);
  const key = s.slice(cut + 1);
  checkServer(server, transport);
  checkKey(key);
  return { server, key };
}

function checkServer(server, transport) {
  if (!validLiveUrl(server, transport)) throw new PasteError('bad-server', `The server address is not a valid ${transport}:// address.`);
}
function checkKey(key) {
  if (!KEY_RE.test(key)) throw new PasteError('bad-key', 'The stream key looks wrong: it should be one piece of text with no spaces.');
}

/**
 * Instagram Live Producer paste. Accepts, in one box or two:
 *   - the stream URL alone, with the key on its end (rtmps://host:443/rtmp/<key>);
 *   - the stream URL and the stream key on separate lines (or separated by spaces), in either order;
 *   - server and key given separately ({ server, key }).
 * -> { server, key }. Throws PasteError with plain words.
 */
export function parseInstagramPaste(input) {
  let server = null; let key = null;
  if (input && typeof input === 'object') {
    const t = (v) => (typeof v === 'string' ? v.trim() : '');
    server = t(input.server); key = t(input.key);
    if (server && !key) return parseInstagramPaste(server);
    if (!server && key) return parseInstagramPaste(key);
  } else if (typeof input === 'string') {
    const parts = input.split(/\s+/).map((x) => x.trim()).filter(Boolean);
    if (!parts.length) throw new PasteError('empty', 'Paste the stream URL and stream key from Instagram Live Producer.');
    const urls = parts.filter((p) => /^rtmps?:\/\//i.test(p));
    const rest = parts.filter((p) => !/^rtmps?:\/\//i.test(p));
    if (urls.length !== 1 || rest.length > 1) throw new PasteError('unclear', 'Paste one stream URL and one stream key (copy both from Instagram Live Producer).');
    server = urls[0]; key = rest[0] ?? '';
    if (!key) return splitStreamUrl(server);
  } else {
    throw new PasteError('empty', 'Paste the stream URL and stream key from Instagram Live Producer.');
  }
  if (!/^rtmps?:\/\//i.test(server)) throw new PasteError('not-rtmp', 'The stream URL should start with rtmps://');
  if (!server.toLowerCase().startsWith('rtmps://')) throw new PasteError('not-rtmps', 'The stream URL must start with rtmps:// (a secure address).');
  if (!server.endsWith('/')) server += '/';
  // A URL that already ends in a key plus a separate key: refuse rather than guess which one is meant.
  checkServer(server, 'rtmps');
  checkKey(key);
  return { server, key };
}
