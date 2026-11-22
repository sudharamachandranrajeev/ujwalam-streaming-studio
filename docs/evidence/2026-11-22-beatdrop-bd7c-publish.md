# BeatDrop BD7c (publish and post a BeatDrop montage): evidence, 2026-11-22

Decision: D419. Plan: `docs/plan/2026-11-21-beatdrop-montages.md` section 7 (BD7, publish part).
Branch: `claude/beatdrop-bd7c` (from `claude/alpha0-d1` at 12601ee). Status: data tests only; a real BeatDrop render
published and posted is UNVERIFIED (BD7a wires `clipper beatdrop` to validate and publish; done after the merge).

## What was built

- `services/clip/clip_publish.py`:
  - A BeatDrop render (`DIR/beatdrop/render.json`, tool `clipper.beatdrop`, clip id `B…`) publishes as kind `montage`,
    label `kills-N` from the plan's own count (`beatdrop.stats.kills` when it has no pieces), canvas `h` or `v` from
    the layout (`beatdrop-h`, `beatdrop-v`). Each row records its render file name (`source`).
  - **A retake is a new video.** Published bytes are never replaced. A new render of the same id and layout gets a new
    file in the clips folder; every earlier take gets `supersededBy: <newest file>` in `uploads.json`. The last take
    stays current even when its file is gone (posting deletes a file once it is uploaded), so an earlier take never
    becomes postable again, and a posted-and-removed render is never published again (same render = same `source`).
  - **Repair on every BeatDrop publish:** every take still on disk is listed in `uploads.json`, every earlier take is
    marked superseded and the current one cleared of any old mark, so a publish that stopped between `published.json`
    and `uploads.json` is repaired by the next publish of that folder. `published.json` keeps rows of removed files.
  - A name a listed video had (since removed) is never given to a new video (`uploads.json` would match it to the old
    row and its posted record).
  - **One writer of `uploads.json` at a time** across processes (`uploads_lock`): `<uploads.json>.lock` created
    exclusively with the writer's token, released only while it holds that token; a lock older than 30 s is removed
    only by the holder of `<lock>.takeover` (exclusive), so no writer removes a lock another has just taken. Busy past
    10 s: an error, nothing written. An unreadable or odd-shaped `uploads.json` is never replaced (its posted records
    would be lost and every clip posted again).
  - Tidy sees the `montage` and `beatdrop` sub-runs.
- `services/clip/clipper.py` `cmd_validate`: each file is checked against its own frame (`files[].frame`, the V file is
  9:16) and a clip without captions is accepted.
- `services/posting/index.mjs` `packageUploads`: a superseded row is skipped (reason `superseded`).
- `services/posting/youtube.mjs`: `uploadPost` refuses a superseded source (`superseded`, permanent) or an unreadable
  list (`uploads-unreadable`, retried) before it gets a token; `uploadVideo` refuses a source changed in place.
- `services/posting/auto-chain.mjs`: `superseded` is a permanent failure with plain text; `markPosted` hashes first,
  then takes the same lock (`withUploadsLock`) and patches only matching rows of a fresh read; it waits without blocking
  past the 30 s stale limit, so a dead writer's lock never leaves an upload unmarked.

## Tests (2026-11-22, worktree bd7c)

```
python -I -m unittest discover -s tests/py -t tests/py -p test_beatdrop_publish.py
Ran 8 tests ... OK
(also test_clip_output_layout 18, test_long_video 23, test_reel_own_kills_impact_play 22, test_reel_length 24,
 test_montage_music 18, test_learning_mix 9: all OK)
node --test tests/posting*.test.mjs tests/montage-music.test.mjs tests/learning-signals.test.mjs
tests 371, pass 370, fail 0 (1 skip, as before)
node tools/ci.mjs --quick: 9/9 passed (pre-commit, every commit)
```

`test_beatdrop_publish.py` covers: names; both files reach `uploads.json` with the music record and sidecar; a retake is
a new video and supersedes the earlier ones (three takes); repair after a stopped publish; a removed earlier take is
still superseded; a removed newest take stays current and its render is not published again; a pre-BD7c row without a
source; the lock (busy, stale takeover, dead takeover) and an unreadable list left unchanged; a user-folder song marked
for the posting gate; per-file frame in validate; tidy. Node: lock (one writer, stale takeover, dead takeover),
`sourceReplaced`, `uploadPost` superseded / uploads-unreadable, superseded rows not packaged.

## Codex review (codex exec, read-only, medium effort)

First review and 12 verify rounds on `git diff 12601ee HEAD -- services`. The first design replaced published bytes in
place; Codex showed it races an upload in progress, so it became "a retake is a new video, earlier takes superseded".
Later rounds: interrupted publishes repaired, `markPosted` re-reads before it writes, the cross-process lock (token,
serialized stale takeover, bounded waits), removed takes superseded, no reuse of a removed video's name, the last take
stays current after posting removes its file, a removed pre-BD7c row never blocks a retake.

Accepted residuals (each round told Codex not to re-report them):
- A take already uploading or uploaded when a retake is published may still finish and post; the retake can post too.
- A publish killed between its `published.json` and `uploads.json` writes (or an `uploads.json` write that failed and
  was reported) leaves the earlier take postable until the next publish of that folder.
- A writer holding the lock over 30 s (writes are well under a second) can lose it; a process dying inside the
  milliseconds of a takeover plus two more contenders can admit two writers.
- Two publishes of the same run folder at once are not supported (`published.json` is read-change-write); the studio
  runs clip jobs one at a time through one queue (`services/studio-ui/record-clips.mjs`).
- Pre-existing, not BeatDrop: a non-BeatDrop publish does not repair an interrupted `uploads.json` write.

## Files

Changed: `services/clip/clip_publish.py`, `services/clip/clipper.py`, `services/posting/index.mjs`,
`services/posting/youtube.mjs`, `services/posting/auto-chain.mjs`, `tests/posting-youtube.test.mjs`,
`tests/montage-music.test.mjs`, `docs/plan/2026-10-29-v1-decisions.md`.
Created: `tests/py/test_beatdrop_publish.py`, this file.
