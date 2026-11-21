# BeatDrop BD1 moment finder, BD2 song map and the NCS montage music library (D414), 2026-11-21

Plan: `docs/plan/2026-11-21-beatdrop-montages.md` (D413). Branch `claude/beatdrop-bd1` (not merged, not pushed).
Decision: D414 in `docs/plan/2026-10-29-v1-decisions.md`.

## How it was tested

- The user's studio was open (off air) the whole time. Before each test run, `node tools/live-check.mjs` was run and
  its exit code was checked. No GPU or NVENC work ran; no full CI.
- Each test file ran on its own at BelowNormal priority, with `UJWALAM_HEADLESS=1` and a temporary
  `UJWALAM_DATA_ROOT`. Node: `--test-force-exit --test-timeout=180000`. Python: the repo's `.venv-gpu` interpreter, `-I`.
- Synthetic fixtures only (tests build the videos and tracks in temp folders). No real footage, clips-corpus file,
  reference video or real song was used. No install, no network.

## What was built

- **BD1** `services/clip/moments.py` with the game numbers as data in `data/games/codm/moments.json`
  (schema `data/schemas/moments.schema.json`): gunshots (1-6 kHz spectral flux confirmed by a muzzle flash within 2
  frames), hits and kills (from detector hits; kill time = first hit-marker frame), scope in/out, flicks, slides/jumps,
  third person. Each moment: `{kind, t, frame, strength, source, status: "unverified"}`. Refuses to run on air
  (unknown counts as on air), uses the guarded decode (frame, wall-clock and memory caps), BelowNormal, one job at a
  time (lock file), CPU only.
- **BD2** `services/clip/song_map.py`, numbers in `data/clip/song-map.json` (schema `data/schemas/song-map.schema.json`,
  example `tests/fixtures/song-map-example.json`): beat grid (tempo + phase least-squares fit on kick onsets, refined
  by a short-FFT flux maximum), downbeats, sections, drops, transients. JSON numbers only.
- **NCS library** `services/clip/montage_music.py`, `data/clip/montage-music.json`; studio route
  `services/studio-ui/montage-music.mjs` (GET/POST `/ui/api/montage-music`); setting `clips.montageMusic` in
  `services/studio-ui/user-settings.mjs` (on by default; folder on a local fixed drive; random seeded with no repeat of
  the last N, or a fixed track); per-track editable credits stored under the data root. Settings > Clips "Montage
  music" card in `app/studio/qml/SettingsClips.qml` / `SettingsDialog.qml`.
- **Fail closed in posting**: `services/posting/post-text.mjs` `musicCredit` / `creditMissing`. Packaging adds the
  credit lines to the description; a library track without a complete credit is skipped (`music-credit-missing`,
  plain-word reason naming Settings > Clips > Montage music); a song from elsewhere is `render-only`. Approve
  (`setStatus`) and `uploadVideo` check again; the auto chain treats `music-credit-missing` as permanent with a plain
  reason.

## Measured results

| File | Result | What it shows |
|---|---|---|
| tests/py/test_moments.py | 8/8 OK | Synthetic clip: gunshots at frames 15 and 36, kill 39, hit 39, scope in 75, scope out 105, flick 120, jump 150 all exact; third person 181 vs truth 180 (1 frame). No extra moments. On-air refusal, guard and schema shape. |
| tests/py/test_song_map.py | 7/7 OK | Track a (120 bpm): max beat error 1.30 ms, fit rms 0.0 ms, drops 16.309 s / 40.309 s vs truth 16.31 / 40.31. Track b (140 bpm): max error 1.60 ms, rms 0.19 ms, drop 6.976 s vs 6.977. Sections right. |
| tests/py/test_montage_music.py | 7/7 OK | Credits from tags and file names, edits kept across scans, seeded pick with no repeat of the last N, folder rules, credit checks. |
| tests/beatdrop-schemas.test.mjs | 3/3 OK | Shipped data files and the example match their schemas; bad files are refused. |
| tests/montage-music.test.mjs | 6/6 OK | Setting defaults and checks, route list/credit via real Python, packaging with credit, skip without credit, render only, approve and upload refuse once the credit is removed. |
| Existing tests re-run | all pass | posting-uploads 12, posting-pt1-text 5, posting-e2e 61, posting-youtube 9, posting-schedule 28, posting-pt2 10, posting-pt3 9, golive-routes 35, guide 14, learning-signals 10, stream-apply-d387 10, user-settings-clip-look 4, user-settings-reel-styles 2. |
| tests/studio-qml-settings.test.mjs | 22/22 OK | Headless QML probe (studio rebuilt on CPU): the Montage music card opens without QML errors, ON by default with a random song and 3; only the changed parts (on off, avoidLast 5) are sent at Save. The other 21 Settings cases still pass. |

Done when: BD1 within 2 frames (PASS, worst 1 frame); BD2 beat grid within 20 ms (PASS, worst 1.6 ms) and drop found
(PASS).

## UNVERIFIED

- Accuracy on real footage (BD1) and real NCS tracks (BD2): only synthetic fixtures were measured. Every moment keeps
  `status: "unverified"` and the numbers in `moments.json` are unverified until checked against labelled real clips.
- Detector weights from the clip pack are not used by BD1 yet (kills come from detector hits as listed).
- Content ID claims on NCS tracks: possible, not tested.
- The Montage music card was checked through the headless probe only, not by the user in the running studio.

## Codex review fixes (2026-11-21)

| Finding | Fix | Test (result) |
|---|---|---|
| P1 a folder-scanned montage had no music record and could post an uncredited or non-NCS song | The render's own record decides: `clip_publish.music_provenance` reads each render.json clip entry's `music` (none, made here, the D411 music folder, NCS) into the uploads.json row and a `<video>.music.json` sidecar; `clips-source.mjs` reads the sidecar when there is no row; `post-text.mjs musicOf` maps it. A montage with no record or an unknown one is not posted (`music-unknown`, plain reason); a music-folder song is render only; made-here music and no music post as before. `montage_music.music_record` is the record BD3 writes for an NCS song. | test_clip_output_layout.py 17/17 (new provenance + sidecar case); montage-music.test.mjs 8/8 (unknown refused, generated posts, user folder render only, folder scan with and without a sidecar). posting-e2e 61/61 and posting-uploads 12/12 with their montage fixtures marked as made-here music. |
| P1 song map CLI ran without a guard | `song_map` builds a `style_analyse.Guard` from `data/clip/song-map.json` `guard` (on air every 200 sound frames, 120 s, 1500 MB, 60000 frames) used through the decode and forced between every analysis step; GuardStop is not caught | test_song_map.py 9/9 (frame cap, going on air after the decode, wall clock) |
| P2 song map root optional, open unconstrained | `--root` required; `track_problem`: local fixed drive, no links (`reel_style.local_file_problem`), inside the folder, extension-named demuxer + `protocol_whitelist=file` (`style_analyse.audio_open_kw`: mp3, m4a/mp4 = mov, flac, wav, ogg/opus, aac; anything else refused) | test_song_map.py (track rules: missing folder, network path, removable drive, playlist file) |
| P2 tag reads used format detection | `read_tags` uses `style_analyse.safe_open_audio`; `scan`/`pick` refuse on air (unknown counts as on air); the studio list shows the saved credits with a plain note while live | test_montage_music.py 10/10 (playlist and text files give no tags; scan and pick refuse on air) |
| P2 credits keyed by file name | Records keyed by identity: size + SHA-256 of the first MB (bounded read). Same bytes elsewhere keep the credit; other bytes under the same name drop the typed credit and are marked for review (incomplete, so the gate blocks) | test_montage_music.py (credit follows the track, not the name) |
| P2 lock beside each output | One shared heavy-job lock: `HeavyJobLock` moved from detector_pass.py to clip_common.py (detector_pass re-exports it) and used by moments.py and song_map.py | test_moments.py 9/9 (both refuse while the lock is held, different output folders); test_clip_detector_pass.py 37/37 |

Also merged `claude/alpha0-d1` (6d703ed, fonts + manifest). `tests/package-alpha.test.mjs` "repo file set" passes: the new data files are under the shipped globs (`data/clip/*.json`, `data/games/<id>/*.json`); the schemas are read only by tests. Two Install-Ujwalam.ps1 cases of that file fail only because the test runner sets `UJWALAM_DATA_ROOT` (the installer then puts data there instead of `<install>\data`); not caused by this branch.

Other tests re-run after the fixes: analytics 12, learning-mix 26 (node) and 9 (python), posting-auto-d375 51, posting-backlog-order 5, posting-preview 12, posting-pt5-settings 11, posting-schedule 28, studio-ui-growth 7. All passed.

## Clips without a music record (2026-11-21, D414 item 6)

Rule for every kind that carries music (montage, won-match reel, impact play, live clip):

- A clip with a record: as above.
- A clip with no record (rendered before records were kept): made here and posted when the Clip look music folder is unset or empty and `<data>/clips/montage-music/history.json` does not exist (`legacyMadeHere` in `services/posting/post-text.mjs`, worked out once per posting run); otherwise held as `music-unknown` with "re-render to post: the song's source is not known".
- New renders always write a record (`musicRecords: 1` in render.json; plain variants `music: null`). A missing or unreadable record in such a render is `{source: unknown}` and is held.

| Test | Result |
|---|---|
| `tests/montage-music.test.mjs`: legacy, no folder and no pick history: montage, won-reel, impact-play and short all post | pass (10/10 in file) |
| same file: legacy with a music folder set: all four held as music-unknown with the plain reason; legacy with pick history: won-reel and impact-play held | pass |
| same file: `{source: unknown}` is held even when the legacy pass is true | pass |
| `tests/py/test_clip_output_layout.py`: a render with `musicRecords` whose clip has no record publishes `{source: unknown}` to the row and the sidecar; an unknown-shape record is unknown | pass (17/17) |
| posting-uploads 12, posting-e2e 61, posting-auto-d375 51 | pass |

## Codex verify fixes (2026-11-21, D414 item 7)

Fixed already (Codex verify of dc85dcb + 2e1883b): song-map guard, song-map open, library open.

| Finding | Fix | Test (result) |
|---|---|---|
| P1 legacy pass too wide | `music-provenance.json` `since`, written once (link, first writer wins) by posting, clipper main and publish; legacy only for clips older than it | `tests/montage-music.test.mjs` "the legacy pass covers only clips older than the provenance start": newer won-reel + impact play held with no folder and no history; older posted; start written once, never moved (pass, 11/11 in file) |
| P2 identity = first MiB | whole-file SHA-256, bounded (200 MB, 30 s), on-air check every 32 MiB, cache by path + size + mtime_ns | `tests/py/test_montage_music.py` same size and first MiB, other tail: other ids; cache hit reads nothing; changed mtime re-hashes; stops when a stream starts mid-file; over the size cap refused (pass, 11/11) |
| P2 lock race | temp + fsync + os.link; stale only on a dead or reused pid, or a torn record older than 60 s; stale lock moved aside and checked | `tests/py/test_moments.py` four processes start together: one WON, three BUSY; fresh torn lock busy; old torn lock taken; reused pid taken; no temp files left (pass, 10/10); detector_pass 37/37 |
| P1 run packaging skipped the gate | packageRun reads render.json records through the same gate; every package carries `source.music`; approve and upload refuse `music-unchecked` | `tests/posting.test.mjs` "packageRun music gate": folder song render-only, missing record music-unknown, made-here packaged with its check; approve and upload refuse a stripped package made after the start, an old one passes (pass, 18/18) |
| P1 sidecar forgery | sidecar bound to the video (size, SHA-256 of first and last MiB); mismatch or no binding = unknown | `tests/montage-music.test.mjs` folder scan: a sidecar on other bytes and an unbound one read as unknown (pass); `tests/py/test_clip_output_layout.py` sidecar carries the binding (pass, 18/18) |
| P2 long video legacy | long-video render.json: `musicRecords: 1`, `music: null` | `test_clip_output_layout.py` "every render writer keeps music records": all 4 render.json writers in clipper.py set musicRecords and the long video's clip entry has music (source check, pass) |

Re-run after the fixes, one file at a time, CPU only: analytics 12, cli-data-dir 3, learning-mix 26, learning-signals 10, posting-auto-chain 15, posting-auto-d375 51, posting-auto 14, posting-custom-schedule 15, posting-e2e 61, posting-live-check 8, posting-preview 12, posting-pt1-text 5, posting-pt2-hard-gap 10, posting-pt3-actions 9, posting-pt5-settings 11, posting-rules-in-data 8, posting-schedule 28, posting-uploads 12, posting-youtube-cli 6, posting-youtube 9, studio-ui-posting-auto 8, studio-ui-posting-queue 6, studio-ui-posting-youtube 11, studio-ui-posting 8; python long_video 23, learning_mix 9, song_map 9, clip_live_review_gate 6. All passed. Two e2e fixtures (a won-reel added after the first run) now carry a record: a clip made after the start without one is held, as intended.

## Second Codex verify fixes (2026-11-21, D414 item 8)

Codex verify of 6c3664f: items 1, 2, 4, 5 and 6 fixed. Two were left:

| Finding | Fix | Test (result) |
|---|---|---|
| P1 stale-lock recovery raced | OS-held lock (msvcrt.locking / fcntl.flock) on a persistent lock file; no staleness rules; owner text for display only | `tests/py/test_moments.py`: 4 processes start together, 1 WON and 3 BUSY; the lock file stays; a busy message names the holder's job and start; a killed holder's lock is free at once (pass, 10/10). detector_pass 37/37 (the lock file now stays after release), song_map 9/9 |
| P1 uploads row trusted without checking the video | rows carry the video binding (clip_publish.py); `trustedMusic` in clips-source.mjs, used by the folder scan and by packageUploads on uploads.json | `tests/montage-music.test.mjs` "an uploads row counts only while it still describes its video": a no-music won-reel row whose video was replaced by other bytes under the same name is held (music-unknown) from uploads.json and is unknown in the folder scan; a matching row keeps its record (pass, 12/12). `test_clip_output_layout.py`: rows are bound to their video (pass, 18/18) |

Re-run, one file at a time, CPU only: posting-e2e 61 (its fixture rows now carry the binding, as the publisher writes it), posting-uploads 12, posting 18, posting-auto-d375 51, posting-auto-chain 15, posting-backlog-order 5, posting-preview 12, analytics 12, learning-signals 10, learning_mix 9. All passed.

## Third Codex verify fixes (2026-11-21, D414 item 9)

Codex verify of 529f3ad: lock fixed. Two left:

| Finding | Fix | Test (result) |
|---|---|---|
| P1 old `montageMusic` survived the binding check | `trustedRow` drops every music field of an untrusted row; the sidecar alone decides | `tests/montage-music.test.mjs` "a replaced video never inherits the row's old credit": row with a credited NCS track, video replaced by folder-music bytes = render-only; no sidecar = music-unknown; another library track without credit = music-credit-missing; with its own credit = posted with that credit only (pass) |
| P2 scan hashed before the live check | auto-chain scanFolder returns before the scan while a stream or recording is active or the state is unknown; `videoBinding` cache by path + size + mtime_ns | same file: "bindings are cached ...": same file gives the cached result, a changed file is hashed again; a chain tick while recording or streaming does not scan, an idle tick does (pass, 14/14 in file) |

Re-run, one file at a time, CPU only: posting-e2e 61, posting-uploads 12, posting 18, posting-auto-chain 15, posting-auto-d375 51, posting-auto 14, posting-pt3-actions 9, posting-custom-schedule 15, posting-preview 12, posting-backlog-order 5, studio-ui-posting-auto 8, analytics 12. All passed. The Posts view preview scan (on the user's click) still hashes without a live check.

Residual (accepted, D414): the data folder is the user's own; whoever can write it can rewrite a video and its sidecar together.

Still UNVERIFIED: the Montage music card does not yet show the "file changed, check the credit" note (it shows the credit as incomplete). The legacy rule has not run against the user's real clips folder.
