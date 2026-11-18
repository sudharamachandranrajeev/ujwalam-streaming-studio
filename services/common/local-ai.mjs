// SPDX-License-Identifier: GPL-3.0-or-later
// Local AI server address (AGENTS.md: local models only). Every caller of an OpenAI-compatible model server (LM Studio's
// local server by default) passes the configured address through localAiUrl(): only http(s) on 127.0.0.1, localhost or
// ::1, with no user name or password, is accepted; anything else gives null and the caller does not call a model.

export const DEFAULT_AI_URL = 'http://127.0.0.1:1234/v1/chat/completions';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The address as a normalised href when it is on this PC, else null. */
export function localAiUrl(url) {
  let u = null;
  try { u = new URL(url); } catch { return null; }
  const local = (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password;
  return local ? u.href : null;
}
