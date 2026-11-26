// SPDX-License-Identifier: GPL-3.0-or-later
// D444 IP3: Settings > Posting & growth > Instagram. Routes (studio UI server; POSTs pass its Origin + CSRF checks first):
//   GET  /ui/api/posts/instagram             -> { hasApp, connected, username, expiresAt, redirectUri, flagOn, connecting,
//                                                lastError, queue: { waiting, posting, done, failed, nextAt, lastPostedAt, reasonText } }
//   POST /ui/api/posts/instagram/app         { appId?, appSecret? } -> saved to Windows Credential Manager only; never echoed
//   POST /ui/api/posts/instagram/connect     -> opens the Facebook Login page in the browser; the answer comes later (GET)
//   POST /ui/api/posts/instagram/disconnect  -> removes the saved sign-in
//   POST /ui/api/posts/instagram/drop        -> "Drop Instagram queue": jobs not posted yet are dropped; their clip files
//                                                are no longer kept for Instagram (the delete flag may then delete them)
// The app secret and the token never reach the page; the page gets presence, the @name and the expiry date.
// Each action runs on its own click (D332): no typed phrase, no "are you sure".
import { systemBrowserOpen } from '../platform-connect/index.mjs';
import { IG_FLAG, createInstagramAuth, loadIgConfig, redirectUriFor } from '../posting/instagram.mjs';
import { createInstagramPoster } from '../posting/instagram-queue.mjs';

const PLAIN_ERR = {
  'no-app': 'Save the App ID and App Secret first.',
  'no-fb-page': 'Facebook shared no Page with Ujwalam. Click Connect again; in the Facebook window click "Edit previous settings" (or "Choose what you allow") and tick your Facebook Page and your Instagram account.',
  'no-ig-account': 'None of the Facebook Pages shared with Ujwalam has an Instagram professional account linked. In the Instagram app: Edit profile > Page > connect the Page; or in Meta Business Suite > Settings > Instagram accounts, add the account to the same business as the Page. Then click Connect again and tick the Page and the Instagram account.',
  'permission-declined': 'A permission was left out in the Facebook window. Click Connect again and allow everything it asks for.',
  'state-mismatch': 'The sign-in answer did not match; click Connect again.',
  'oauth-timeout': 'No answer from Facebook within 3 minutes; click Connect again.',
  'oauth-denied': 'The sign-in was not allowed in the browser.',
  'oauth-listener-failed': 'The sign-in could not start: another program uses the redirect port.',
  'bad-app-id': 'The App ID is a number of 5 to 25 digits.',
  'bad-app-secret': 'The App Secret is 16 to 64 letters and digits.',
};
// What Facebook shared (counts and permission names only, never Page or account names) follows the advice, so the user
// sees which link is missing.
const SEEN = new Set(['no-fb-page', 'no-ig-account', 'permission-declined']);
export const plainError = (code, detail) => {
  const text = PLAIN_ERR[code] ?? `Instagram sign-in failed (${String(code ?? 'error').slice(0, 40)})`;
  return SEEN.has(code) && typeof detail === 'string' && /^Facebook shared \d+ Page\(s\)(; not allowed: [a-z_, ]+)?$/.test(detail) ? `${text} (${detail}.)` : text;
};

/** opts: { dataDir, flags, auth? (test seam), browserOpen? } */
export function createInstagramRoutes(opts) {
  let auth = opts.auth ?? null;
  const getAuth = () => (auth ??= createInstagramAuth({ browserOpen: opts.browserOpen ?? systemBrowserOpen }));
  let connecting = null; let lastError = null;
  const poster = () => (typeof opts.dataDir === 'string' ? createInstagramPoster({ dataDir: opts.dataDir, flags: opts.flags ?? { isOn: () => false }, auth: getAuth(), liveBlock: async () => null }) : null);
  const view = async () => {
    let st = { hasApp: false, connected: false, username: null, expiresAt: null };
    try { st = await getAuth().status(); } catch { lastError ??= 'The saved Instagram sign-in could not be read.'; }
    let redirectUri = null; try { redirectUri = redirectUriFor(loadIgConfig()); } catch { /* shown as unknown */ }
    let queue = null;
    try { queue = poster()?.summary() ?? null; } catch { queue = null; }
    return { ...st, redirectUri, flagOn: !!opts.flags && opts.flags.isOn(IG_FLAG), connecting: connecting !== null, lastError, queue };
  };
  return {
    async handle(method, route, body, res, json) {
      if (!route.startsWith('/ui/api/posts/instagram')) return false;
      if (method === 'GET' && route === '/ui/api/posts/instagram') { json(res, 200, await view()); return true; }
      if (method !== 'POST') return false;
      if (route === '/ui/api/posts/instagram/app') {
        const appId = typeof body?.appId === 'string' ? body.appId.trim() : '';
        const appSecret = typeof body?.appSecret === 'string' ? body.appSecret.trim() : '';
        if (!appId && !appSecret) { json(res, 400, { error: 'empty', text: 'Type the App ID and App Secret first.' }); return true; }
        try { await getAuth().setApp({ appId, appSecret }); } catch (e) { json(res, 400, { error: e?.code ?? 'error', text: plainError(e?.code) }); return true; }
        lastError = null;
        json(res, 200, await view()); return true;
      }
      if (route === '/ui/api/posts/instagram/connect') {
        if (connecting) { json(res, 200, await view()); return true; }
        lastError = null;
        connecting = getAuth().signIn().then(() => { lastError = null; }, (e) => { lastError = plainError(e?.code, e?.message); }).finally(() => { connecting = null; });
        json(res, 202, await view()); return true;
      }
      if (route === '/ui/api/posts/instagram/drop') {
        const p = poster();
        if (!p) { json(res, 503, { error: 'no-data-dir', text: 'The data folder is not known.' }); return true; }
        const dropped = p.dropQueue();
        json(res, 200, { ...(await view()), dropped }); return true;
      }
      if (route === '/ui/api/posts/instagram/disconnect') {
        try { await getAuth().signOut(); } catch { json(res, 502, { error: 'disconnect-failed', text: 'The saved sign-in could not be removed.' }); return true; }
        json(res, 200, await view()); return true;
      }
      return false;
    },
  };
}
