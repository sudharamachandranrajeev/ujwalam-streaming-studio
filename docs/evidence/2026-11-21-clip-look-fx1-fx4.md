# Clip look FX1-FX4: evidence (2026-11-21, D411)

Branch `claude/clip-look`. Plan: `docs/plan/2026-11-21-clip-music-name-transitions.md`. All runs were made while the studio was open and off air (`tools/live-check.mjs` exit 0 before each run). Render tests used the CPU encoder (libopenh264) on tiny synthetic clips at BelowNormal priority. No NVENC or GPU was used, and each run had its own temp data folder. The QML probe draws in software on the offscreen platform.

## Commits
- 3e12b92 FX1: clip look pick per reel
- 5f6db52 FX2: name styles through libass, no blur, RP4 centre card retired
- 7be50f9 FX3: transition sets, join sounds, flash spacing, beat sync
- a614920 FX4: music library
- (this commit) the Settings > Clips > Clip look card, the per-clip choice in "Make clips?", D411 and this file

## Test results (one file at a time, `UJWALAM_HEADLESS=1`)
| File | Result |
|---|---|
| tests/py/test_clip_look.py | 13 pass: pick determinism, no repeat, locks, empty ticks, env override, shared fixture cases |
| tests/py/test_reel_title.py | 15 pass: ASS has no blur or darkening, entrance and exit times measured |
| tests/py/test_reel_transition_sets.py | 10 pass: flash rate from rendered luminance, one audio stream |
| tests/py/test_music_library.py | 11 pass: tempo, drop and mood on synthetic tones, match and no repeat, modes, level by ffmpeg ebur128, one audio stream, clipper wiring |
| tests/py/test_reel_music.py | 12 pass |
| tests/py/test_reel_transition.py | 9 pass |
| tests/py/test_clip_montage.py | 35 pass |
| tests/py/test_clip_live_montage.py | 6 pass |
| tests/py/test_long_video.py | 23 pass |
| tests/user-settings-clip-look.test.mjs | 4 pass: same shared cases as Python, round trip, one-clip choice |
| tests/user-settings-{reel-transition,reel-hook,match-gate,reel-length,theme}.test.mjs | 3/4/4/6/4 pass |
| tests/record-clips.test.mjs | 33 pass (new: the choice reaches the clipper as UJWALAM_CLIP_LOOK, nothing saved) |
| tests/studio-ui-server.test.mjs | 40 pass (new: answer with look accepted, bad look refused) |
| tests/studio-qml-clips.test.mjs | 6 pass (new: per-recording style goes with the answer) |
| tests/studio-qml-settings.test.mjs | 20 pass (new: Clip look card ticks, locks, mixing saved; unticking a locked style clears the lock) |

## Measured values
- Name entrance/exit (s): lower third 0.250/0.267, corner tag 0.233/0.217, kinetic 0.233/0.250. The limits are under 0.6 s for entrances and under 0.4 s for exits.
- Flashes per second measured from rendered luminance: punchy 1.0, cinematic 1.5, clean 0.0, all-flash stress 1.5. An unplanned dense control measured over 3, which shows the check catches a breach.
- Music bed loudness, measured again with ffmpeg ebur128: hype full-bed -16.0, calm drop -16.0, hype intro-outro -16.0, calm full-bed at -22 target -22.0 LUFS.
- Synthetic 128 BPM track: tempo within 2 BPM, drop within 2 beats of 12 s.
- Rendered reel with bed, join sounds and game sound: 1 video and 1 audio stream (audio encoded once).

## Unverified
- The look on real footage and NVENC renders (only the CPU encoder was tested).
- The mood guess on real music.
- HUD avoidance for corner and lower-third positions.
- The theme colour (it uses the accent from title.json, not the live theme), and the logo (not drawn yet).
- Clips with captions keep hard cuts and get no beat sync.
- FX5 (pack download) and FX6 (ACE-Step) are not started and need the user's yes.
