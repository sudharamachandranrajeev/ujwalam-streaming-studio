# 2026-11-22 Reel music: level under the game, voice duck, curved fades (D437)

Status: built and tested; the real check below is a measurement, not a listening test. Speech spans found by the
detector were not listened to (UNVERIFIED that each span is a voice).

## 1. Measurement of reels the app made (read-only)

Source: the 11 montage reels of run `alpha-20261122-115949` (local data folder, `clips/runs/.../montage/clips/M01..M11/montage-v.mp4`),
all rendered with music level -16. Tool: the shipped ffmpeg `ebur128` (momentary loudness every 0.1 s, then
percentiles), script kept outside the repo. "Music" windows = inside a music segment (1.5 s from its edges);
"game only" = outside every music segment (intro-outro reels only).

| reel | mode | whole reel I (LUFS) | music windows M50 / M90 | game-only M50 / M90 |
|---|---|---|---|---|
| M01 | drop | -16.2 | -16.4 / -14.3 | - |
| M02 | intro-outro | -17.1 | -18.2 / -13.8 | -39.9 / -35.3 |
| M03 | drop | -16.4 | -16.5 / -14.6 | - |
| M04 | intro-outro | -16.9 | -15.0 / -13.8 | -38.9 / -35.4 |
| M05 | full-bed | -16.6 | -18.6 / -12.8 | - |
| M06 | drop | -16.2 | -19.1 / -13.2 | - |
| M07 | full-bed | -16.1 | -16.1 / -14.9 | - |
| M08 | intro-outro | -20.1 | -14.6 / -13.5 | -35.7 / -24.6 |
| M09 | drop | -16.2 | -19.0 / -12.0 | - |
| M10 | intro-outro | -21.9 | -23.3 / -14.8 | -35.0 / -26.8 |
| M11 | drop | -16.2 | -16.2 / -14.3 | - |

Integrated loudness of game-only middle parts (8 s to 22 s): M02 -38.2, M04 -38.1, M08 -26.9, M10 -31.0 LUFS
(peaks -10 to -23 dBFS).

Finding: reels with music under the whole clip land at the music's own -16 LUFS: the music sets the loudness. The game
mix is 11 to 22 LU quieter than the music. The game duck (threshold 0.05, about -26 dBFS) seldom acts because the game
seldom goes above it. So -16 is not a safe absolute level for these recordings.

## 2. What was built

- `services/clip/music_library.py`: `fade_gain` (s-curve, equal-power, exponential, linear), `fades_of`, new fade
  placement in `plan` (start full until the title ends, then the fade; end fade-in earlier; fades share the room; none
  past the reel), `target_lufs` (min(user level, game - underGameDb)), `voice_envelope`, `render(..., voice)`.
- `services/clip/music_voice.py` (new): game audio of the reel's pieces at 48 kHz, its integrated loudness, speech
  spans from Silero VAD (shipped inside faster-whisper), all failure-safe.
- `services/clip/clipper.py`: `_music_level`, `_music(..., ffmpeg, src)`; the record keeps `targetLufs`, `level`,
  `voiceSpans`, `voiceDuck` so recaption renders the same bed.
- `services/clip/reel_music.py`: s-curve fades on the made-here bed.
- Data: `data/clip/music-library.json` `bed.fades`, `bed.level`, `bed.voice`; `data/clip/look.json` ranges and
  defaults (levelDb -20, underGameDb 8, voiceDuckDb 8, fadeInSec 1.5, fadeOutSec 1.5, fadeCurve s-curve).
- Settings > Clips > Clip look (`app/studio/qml/SettingsClips.qml`): five new controls with plain text; probe action
  `settings-look-music` in `SettingsDialog.qml`. Validation in `clip_look.py` and `user-settings.mjs` (shared cases).

## 3. Tests

| command | result |
|---|---|
| `python -I tests/py/test_music_library.py` | 24 tests OK (3 new: curves, placement incl. early drop, level and voice envelope) |
| `python -I tests/py/test_music_voice.py` (new) | 9 tests OK (real Silero VAD on a tone gives no speech) |
| `python -I tests/py/test_clip_look.py` | 17 OK (3 new shared cases) |
| `python -I tests/py/test_reel_music.py`, `test_music_gen.py`, `test_montage_music.py`, `test_clip_live_montage.py` | 13 (1 new: fade shape, old records linear), 22 (1 skip), 18, 6 OK |
| `node --test tests/user-settings-clip-look.test.mjs` | 8 pass |
| `node --test --test-name-pattern="Clip look|D437" tests/studio-qml-settings.test.mjs` (after `npm run build:studio`) | 2 pass |

## 4. Real check (one reel, before vs after)

Input: game-only part 6-30 s of reel M08 (its own game audio), its own track from the user's music folder. Bed mixed
under the game with the same sidechain duck as the render. Outputs in the agent scratchpad only.

- Game mix: -28.4 LUFS. Speech spans found: 4.29-5.02, 7.04-8.51, 11.36-15.74 s (UNVERIFIED by ear).
- Before (-16 LUFS, linear 0.15/0.4 s fades, no voice duck), full bed: music after duck -16.6 LUFS (12 LU over the
  game); inside speech the music was -18.2 / -21.1 / -17.9 LUFS against game -38.6 / -24.8 / -27.2.
- After (8 dB under the game, s-curve 1.5 s, voice duck 8 dB), full bed: music -37.5 LUFS (9 LU under the game,
  the voice duck takes the extra 1 dB); inside speech -46.6 / -49.5 / -46.3 LUFS, 12 to 22 LU under the game.
- Whole mix: before -16.4, after -28.7 LUFS. The reel is now as loud as its game sound, which is quiet (see D437 point 4).

## 5. Codex review (codex exec, read-only, medium)

1. Measurement from the raw pieces, not the final mix (speed ramps, crossfades): partly fixed. Speech spans now
   follow each piece's speed; ramps inside a piece are not followed (small timing error there). Loudness from the raw
   pieces is kept (the same source the captions use).
2. A span over a join could be shortened or dropped: fixed (`map_span` cuts at piece edges; test).
3. The made-here synth bed ignores the new level and voice duck: not changed (it is the last fallback, peak-set at
   -20 dB; it got the s-curve fades only). Open.
4. A name ending after the reel's middle: the start music is capped at half the reel and may fade before the name
   ends. Not changed: names last 1-4 s and reels are at least 8 s.
5. Drop earlier than the fade-in: fixed (fade-in shortened so the full end starts on the drop; test).
6. Recaption of an old made-here bed would get the new curve: fixed (records without `fade` keep straight ramps; test).

## 6. Open

- The game mix is quiet (-27 to -38 LUFS). Normalising it is a separate decision for the user.
- Listening test of the new fades and voice duck on real reels: UNVERIFIED.
