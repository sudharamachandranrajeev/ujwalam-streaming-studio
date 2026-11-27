// SPDX-License-Identifier: GPL-3.0-or-later
// Go live window: the Facebook and Instagram cards (D447; docs/plan/2026-11-27-facebook-live-ig-live-x-posting.md
// sections 1 and 2). Routes (studio UI server; POSTs pass its Origin + CSRF checks first):
//   GET  /ui/api/golive/extras                  -> { facebook: {...}, instagram: {...} } (presence and names only)
//   POST /ui/api/golive/extras                  { facebook?: bool, instagram?: bool } -> ticks for the next Go live
//   GET  /ui/api/golive/facebook/pages          -> { pages: [{ id, name, canLive }] }
//   POST /ui/api/golive/facebook/page           { pageId } -> the Page live videos go to (its token: Credential Manager)
//   POST /ui/api/golive/instagram/open          -> opens instagram.com in the browser (Live Producer: + > Live)
//   POST /ui/api/golive/instagram/paste         { text } | { server, key } -> stored for this stream only
//   POST /ui/api/golive/instagram/clear         -> deletes the pasted address and key
// Hooks the server calls around stream.start / stream.stop (beforeStart, startFailed, streamEnded). Each action runs
// on its own click (D332). No pasted value, server address, key or token is ever in a response, a log line or a file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { systemBrowserOpen } from '../platform-connect/index.mjs';
import { createCredentialStore } from '../event-core/streamerbot/credential.mjs';
import { createFacebookLive, facebookText, FacebookLiveError } from '../posting/facebook-live.mjs';
import { keyFreshness, loadAddon as instagramAddon, noteKeySaved } from '../outputs/instagram.mjs';
import { loadFacebookAddon } from '../outputs/facebook.mjs';
import { parseInstagramPaste, PasteError } from '../outputs/stream-url.mjs';

export const EXTRAS_FILE = path.join('outputs', 'golive-extras.json'); // ticks only (booleans)
/** Where Instagram Live Producer starts: instagram.com, then + (Create) > Live (Instagram help, checked 2026-11-27). */
export const INSTAGRAM_PRODUCER_URL = 'https://www.instagram.com/';
const ROUTES = new Set(['/ui/api/golive/extras', '/ui/api/golive/facebook/pages', '/ui/api/golive/facebook/page', '/ui/api/golive/instagram/open', '/ui/api/golive/instagram/paste', '/ui/api/golive/instagram/clear']);

export function readExtras(dataDir) {
  try {
    const j = JSON.parse(readFileSync(path.join(dataDir, EXTRAS_FILE), 'utf8'));
    return { facebook: j?.facebook === true, instagram: j?.instagram === true };
  } catch { return { facebook: false, instagram: false }; }
}
export function writeExtras(dataDir, v) {
  const f = path.join(dataDir, EXTRAS_FILE);
  mkdirSync(path.dirname(f), { recursive: true });
  const body = { facebook: v.facebook === true, instagram: v.instagram === true };
  writeFileSync(`${f}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(`${f}.tmp`, f);
  return body;
}

/**
 * The sinks a stream.start sends, with the Facebook and Instagram ticks applied. Pure.
 * sinks: the start's list, or null (= every planned stream sink). planned: stream sink ids the host has configured.
 * -> { sinks: string[] | null, facebook: bool, instagram: bool } (facebook / instagram: that sink is in this start)
 */
export function applyExtras(sinks, planned, ticks, ids = { facebook: 'facebook', instagram: 'instagram' }) {
  const has = (id) => Array.isArray(planned) && planned.includes(id);
  const want = { facebook: ticks.facebook === true && has(ids.facebook), instagram: ticks.instagram === true && has(ids.instagram) };
  const extra = new Set([ids.facebook, ids.instagram]);
  const base = Array.isArray(sinks) ? sinks : (Array.isArray(planned) ? planned : null);
  if (base === null) return { sinks: null, ...want };
  const out = base.filter((s) => !extra.has(s));
  if (want.instagram) out.push(ids.instagram);
  if (want.facebook) out.push(ids.facebook);
  // every planned sink still in (nothing taken out): keep "all" as it was
  if (!Array.isArray(sinks) && out.length === base.length) return { sinks: null, ...want };
  return { sinks: out, ...want };
}

/**
 * opts: { dataDir, facebookOn(), instagramOn(), log?, facebook? (createFacebookLive seam), igServerStore?, igKeyStore?,
 *         browserOpen?, outputLive?(id) -> 'idle'|'live'|... , templateText?() -> { title, description } }
 */
export function createLiveExtras(opts) {
  const log = opts.log ?? (() => {});
  const fbAddon = loadFacebookAddon();
  const igAddon = instagramAddon();
  let fb = opts.facebook ?? null;
  const facebook = () => (fb ??= createFacebookLive({ dataDir: opts.dataDir }));
  const igServer = opts.igServerStore ?? createCredentialStore(igAddon.target.serverRef);
  const igKey = opts.igKeyStore ?? createCredentialStore(igAddon.target.keyRef);
  const browserOpen = opts.browserOpen ?? systemBrowserOpen;
  const fbOn = () => opts.facebookOn() === true;
  const igOn = () => opts.instagramOn() === true;
  let fbMade = null; // the live video id of the start on its way (not secret)

  async function view() {
    const ticks = readExtras(opts.dataDir);
    let st = null; let fbErr = null;
    if (fbOn()) { try { st = await facebook().status(); } catch (e) { fbErr = facebookText(e?.code); } }
    let liveStatus = null;
    if (fbOn() && st?.page && facebook().readState().live.length) { try { liveStatus = await facebook().liveStatus(); } catch { liveStatus = null; } }
    let ig = null;
    if (igOn()) { try { ig = keyFreshness(opts.dataDir); } catch { ig = null; } }
    return {
      facebook: {
        available: fbOn(), on: fbOn() && ticks.facebook, connected: st?.connected ?? false, scopesOk: st?.scopesOk ?? null,
        missing: st?.missing ?? [], page: st?.page ?? null, liveStatus, error: fbErr,
        text: !fbOn() ? 'Facebook Live is switched off (Settings > Stream, Facebook Live).'
          : !st?.connected ? facebookText('not-connected')
            : st.scopesOk === false ? facebookText('reauth-needed')
              : !st.page ? facebookText('no-page')
                : `Goes live on your Page "${st.page.name}". The stream address and key are fetched for you at Go live.`,
      },
      instagram: {
        available: igOn(), on: igOn() && ticks.instagram, pasted: !!ig && ig.fresh === true, state: ig?.state ?? 'not-pasted',
        text: !igOn() ? 'Instagram Live is switched off (Settings > Stream, Instagram Live).'
          : ig?.fresh ? 'Stream URL and key are set for this stream. After you go live here, also click "Go live" in Instagram Live Producer.'
            : 'Click "Set up Instagram Live". On instagram.com click + (Create), then Live; copy the stream URL and stream key and paste them here.',
      },
    };
  }

  async function handle(method, route, body, res, json) {
    if (!ROUTES.has(route)) return false;
    if (method === 'GET' && route === '/ui/api/golive/extras') { json(res, 200, await view()); return true; }
    if (method === 'GET' && route === '/ui/api/golive/facebook/pages') {
      if (!fbOn()) { json(res, 404, { error: 'facebook-live-off' }); return true; }
      try { json(res, 200, { pages: await facebook().listPages() }); } catch (e) { json(res, 409, { error: e?.code ?? 'error', text: facebookText(e?.code) }); }
      return true;
    }
    if (method !== 'POST') return false;
    const b = body && typeof body === 'object' ? body : {};
    if (route === '/ui/api/golive/extras') {
      const cur = readExtras(opts.dataDir);
      const next = { facebook: typeof b.facebook === 'boolean' ? b.facebook && fbOn() : cur.facebook, instagram: typeof b.instagram === 'boolean' ? b.instagram && igOn() : cur.instagram };
      writeExtras(opts.dataDir, next);
      json(res, 200, await view());
      return true;
    }
    if (route === '/ui/api/golive/facebook/page') {
      if (!fbOn()) { json(res, 404, { error: 'facebook-live-off' }); return true; }
      try { const p = await facebook().choosePage(String(b.pageId ?? '')); log(`[studio-ui] facebook-live: Page picked`); json(res, 200, { page: { id: p.pageId, name: p.name } }); } catch (e) { json(res, 409, { error: e?.code ?? 'error', text: facebookText(e?.code) }); }
      return true;
    }
    if (!igOn()) { json(res, 404, { error: 'instagram-live-off' }); return true; }
    if (route === '/ui/api/golive/instagram/open') {
      try { await browserOpen(INSTAGRAM_PRODUCER_URL); json(res, 200, { opened: true }); } catch { json(res, 200, { opened: false, url: INSTAGRAM_PRODUCER_URL }); }
      return true;
    }
    const live = async () => { try { return (await opts.outputLive?.(igAddon.sink.id)) ?? 'idle'; } catch { return 'unknown'; } };
    if (route === '/ui/api/golive/instagram/paste') {
      let v;
      try { v = parseInstagramPaste(typeof b.text === 'string' ? b.text : { server: b.server, key: b.key }); } catch (e) {
        json(res, 400, { error: e instanceof PasteError ? e.code : 'bad-paste', text: e instanceof PasteError ? e.message : 'That paste could not be read.' }); return true;
      }
      if ((await live()) !== 'idle') { v = null; json(res, 409, { error: 'output-live', text: 'Instagram is live now. Stop it before pasting a new stream key.' }); return true; }
      try {
        const old = await igKey.get().catch(() => null);
        const sameKey = old !== null && old === v.key;
        await igServer.set(v.server);
        await igKey.set(v.key);
        noteKeySaved(opts.dataDir, { sameKey });
      } catch { v = null; json(res, 500, { error: 'store-failed', text: 'The stream key could not be saved in Windows Credential Manager.' }); return true; }
      v = null;
      const cur = readExtras(opts.dataDir);
      writeExtras(opts.dataDir, { ...cur, instagram: true }); // a paste means "Instagram in this stream"
      log('[studio-ui] instagram-live: stream URL and key pasted (Go live card)');
      json(res, 200, await view());
      return true;
    }
    if (route === '/ui/api/golive/instagram/clear') {
      if ((await live()) !== 'idle') { json(res, 409, { error: 'output-live', text: 'Instagram is live now.' }); return true; }
      await clearInstagram();
      json(res, 200, await view());
      return true;
    }
    return false;
  }

  async function clearInstagram() { await Promise.allSettled([igServer.delete(), igKey.delete()]); }

  /**
   * Before a stream.start goes to the host. sinks: the start's list or null; planned: configured stream sink ids.
   * -> { ok: true, sinks } | { ok: false, reason, detail }. Makes the Facebook live video when Facebook is in the start.
   */
  async function beforeStart({ sinks, planned }) {
    const ticks = readExtras(opts.dataDir);
    const r = applyExtras(sinks, planned, { facebook: fbOn() && ticks.facebook, instagram: igOn() && ticks.instagram }, { facebook: fbAddon.sink.id, instagram: igAddon.sink.id });
    if (r.instagram) {
      let f = null; try { f = keyFreshness(opts.dataDir); } catch { f = null; }
      if (!f?.fresh) return { ok: false, reason: 'instagram-key-missing', detail: 'Instagram is ticked, but no new stream URL and key are pasted for this stream. Press Go live, click "Set up Instagram Live" in the Instagram card and paste them, or untick Instagram.' };
    }
    fbMade = null;
    if (r.facebook) {
      const t = (() => { try { return opts.templateText?.() ?? {}; } catch { return {}; } })();
      try {
        const made = await facebook().startLive({ title: t.title, description: t.description });
        fbMade = made.id;
        log('[studio-ui] facebook-live: live video made for this start');
      } catch (e) {
        const code = e instanceof FacebookLiveError ? e.code : 'graph-error';
        log(`[studio-ui] facebook-live: start refused (${String(code).slice(0, 40)})`);
        return { ok: false, reason: 'facebook-live-failed', detail: `Facebook: ${facebookText(code)} Nothing went live. Untick Facebook to go live without it.` };
      }
    }
    return { ok: true, sinks: r.sinks };
  }

  /** The start did not go through (refused, stopped meanwhile or failed at the host): its Facebook live video ends. */
  async function startFailed() {
    if (!fbMade) return;
    fbMade = null;
    try { await facebook().stopLive(); } catch { /* ended at the next start (left-over) */ }
  }
  /** The start was accepted: nothing to undo any more. */
  const startAccepted = () => { fbMade = null; };

  /** Every stream stopped (Stop stream, End all): the Facebook live video ends; Instagram's one-time key is deleted. */
  async function streamEnded() {
    if (fbOn()) { try { const r = await facebook().stopLive(); if (r.ended || r.failed) log(`[studio-ui] facebook-live: ${r.ended} live video(s) ended, ${r.failed} not`); } catch { /* left-over at the next start */ } }
    if (igOn()) await clearInstagram();
  }

  return { handle, beforeStart, startFailed, startAccepted, streamEnded, view };
}
