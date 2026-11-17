# Test stream on alpha.33 (2026-11-17)

The user said "start stream test" and started the stream from the studio themselves (Go live, then Record). The
installed alpha.33 was used. Source: the host log `host-2026-11-17T15-43-44.log` in the install's data folder (not
committed). Times are UTC. No key, ingest URL, chat text or viewer name is recorded here.

## Per destination

| Output | Connected | Frames sent | Lagged (render) | Retries / disconnects | Stopped |
|---|---|---|---|---|---|
| youtube-h | 16:11:18.0 (0.5 s) | 82,507 | 2,060 (2.5%) | 0 | 16:34:14, code 0 |
| youtube-v | 16:11:18.0 (0.5 s) | 82,502 | 2,060 (2.5%) | 0 | 16:34:14, code 0 |
| twitch | 16:11:18.9 (1.2 s) | 82,501 | 2,060 (2.5%) | 0 | 16:34:14, code 0 |
| kick | 16:11:19.2 (1.6 s) | 82,381 | 2,060 (2.5%) | 0 | 16:34:14, code 0 |
| record (H, mkv) | 16:11:17.7 | 82,541 | 2,060 (2.5%) | - | 16:34:14, code 0, 5.9 GB |
| record-v (V, mkv) | 16:11:17.7 | 82,536 | 2,060 (2.5%) | - | 16:34:14, code 0, 3.0 GB |

- Length: 22 min 57 s. 82,500 frames in 1,377 s is 60 fps on every output.
- Encoders: NVENC H.264 for `h-main`, `v-main` and `h-twitch`, plus one AAC encoder (shared audio, as designed).
- Skipped frames due to encoding lag over the stream: 2,572 of 82,517 (3.1%).

## Findings

1. **Frame loss without streaming too (high).**
   - The replay buffer before the stream (15:43 to 16:09) lost 4.4% of frames to rendering lag and skipped 5.0 to 5.6% to encoding lag.
   - After the stream (16:34 to 16:36) the figures were 2.3% and 3.2 to 3.4%.
   - So the loss comes from the scene load itself (about 20 browser layers, 4 duplicate layers, two capture devices, H and V canvases at 60 fps) on the 6 GB laptop GPU, not from the four outputs.
   - Next: profile the render cost per layer (browser layers first) and find the cause before the next stream. UNVERIFIED which layer costs most.
2. **Game capture layer's own sound (medium).**
   - `lyr-29fe9907` (the capture card video layer) logged 207 "audio is lagging ... at max audio buffering. Restarting source audio" warnings. One was 1.5 s, at 16:17:03.
   - That sound is in no stream mix (mixers 0). The Game channel the viewers hear is the capture card's WASAPI input (`aud-game`, track 1). That matches D221/D222.
   - The restarts still cost audio-thread work. Next: turn off the capture layer's own audio capture, or let the mixer's new strips show it plainly (alpha.34).
3. **Bots not running (medium).**
   - Streamer.bot and Speaker.bot were not started. The readiness check warned about both.
   - As a result: no feedback question in chat, no spoken announcement, no Kick alerts.
   - The `test-broadcast` flag was off, so the test note was not shown.
4. **Studio look.**
   - The Go live chooser and the YouTube presets window opened tiny.
   - The readiness warnings drew over the mixer's off-mix line.
   - Both are fixed on `claude/mixer-layout` (commit 39bb5bc).

## Not checked

- Whether the recordings play with sound (the user checks).
- What viewers saw and heard: no viewer feedback was collected, because the bots were off.
