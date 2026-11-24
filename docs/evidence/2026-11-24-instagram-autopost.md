# Evidence: Instagram Reels autopost (D444, IP1–IP4)

Date: 2026-11-24. Branch: `feat/instagram-autopost`. Status: **UNVERIFIED** until the first real Reel is
posted from the user's own Meta app. No test contacted Meta or Instagram; no real post was made.

## What is built

- **IP1 sign-in and publishing** (`services/posting/instagram.mjs`, `services/posting/oauth.mjs`,
  `data/posting/instagram.json`): Facebook Login on a `http://localhost:<port>/` redirect (listener on
  127.0.0.1 and ::1), short-lived then long-lived token, renewal before expiry, IG account found through the
  linked Page. App ID, App Secret and token live in Windows Credential Manager only. Publish: limit check,
  REELS container (resumable), rupload of the file, status poll, `media_publish`. A retry resumes the same
  container; an unclear container read is retried, never re-posted. CLI: `node services/posting/cli.mjs
  instagram signin|status|signout|post --id <postId>`.
- **IP2 chain** (`services/posting/instagram-queue.mjs`, `services/posting/auto-chain.mjs`): every clip that
  goes to YouTube Shorts gets an Instagram job. No daily cap beyond Meta's 100 posts per moving 24 h; the
  auto-post gap applies; nothing posts while live. A clip file is deleted only after every target posted (or
  the Instagram job was dropped or failed for good).
- **IP3 UI** (`data/flags.json` flag `instagram-autopost`, `services/studio-ui/instagram-routes.mjs`,
  `services/studio-ui/server.mjs`, `app/studio/qml/SettingsPosting.qml`, `app/studio/qml/PostsWindow.qml`):
  Settings > Posting & growth > INSTAGRAM REELS card (switch, App ID, App Secret, Save app, Connect /
  Connect again, Drop Instagram queue, Disconnect, redirect address). Posts window: one Instagram line per
  clip (not queued / waiting with time / posting / posted / failed with plain reason / dropped) and a short
  tag in the list row.
- **IP4 docs**: `docs/plan/2026-11-24-instagram-setup-notes.md` (plain-English setup steps).

## Tests run (CPU only, fake Meta server in-process, 2026-11-24)

Each run as `node --test tests/<file>.test.mjs` from the worktree root:

| File | Pass | Fail |
|---|---|---|
| `posting-instagram` | 27 | 0 |
| `studio-ui-posting-instagram` | 3 | 0 |
| `studio-ui-posting` | 8 | 0 |
| `posting-e2e` (6 D444 chain tests added) | 69 | 0 |
| `posting-auto-chain` | 15 | 0 |
| `posting-auto-d375` | 51 | 0 |
| `posting-youtube-cli` | 7 | 0 |
| `posting-oauth` | 15 | 0 |
| `flags` | 9 | 1 |

`flags` fails 1 test until the D444 entry of the decisions file is merged into this branch (the flag cites
D444). Lint: `node tools/lint.mjs <changed files>`, 0 findings.

## Not tested

- QML probe tests written but **not run** (they start the studio): `tests/studio-qml-instagram.test.mjs`
  and the new Instagram test in `tests/studio-qml-posts.test.mjs`.
- Real Meta calls: sign-in, token exchange and renewal, container, rupload, status poll, publish. The Graph
  version (v24.0) and the Meta screen names in the setup notes are UNVERIFIED.
- Development mode without app review (UNVERIFIED until the first real post).
- Full CI (`npm run ci`) not run in this round.
