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
- FX5 (pack download) and FX6 (ACE-Step) are not started and need the user's yes.

## Codex review fixes (2026-11-21)
Every item has a test. All runs were one file at a time on the CPU (libopenh264), with `UJWALAM_HEADLESS=1`, a temp `UJWALAM_DATA_ROOT` and the studio off air.

| Finding | Fix | Test (result) |
|---|---|---|
| P1 links in the music folder | `is_link`/`inside`: no symlinks, junctions or reparse points; resolved path checked right before each open | test_music_library SafetyTests.test_links_and_junctions_are_not_followed (junction and symlink made; only own.wav listed; render of an outside row refused) |
| P1 mix can clip | one 4x-oversampled `alimiter` at -4 dBFS (attack 20 ms, release 400 ms) after `amix`, one audio encode | test_reel_transition_sets test_coincident_peaks_stay_under_minus_1_dbtp: **-2.50 dBTP** after AAC (ffmpeg ebur128 true peak) |
| P2 beat sync after flash spacing | `reel_transition.respace` after every timing change (`_reel_timeline`) | RespaceTests (unit + clipper timeline) and test_rendered_flashes_after_beat_sync_trims: **1.5 flashes/s** from luminance |
| P2 captions forced hard cuts | `reel_captions.retime` onto the cross-faded timeline; live review and montage keep transitions, join sounds and beat sync | test_reel_captions TimelineTests.test_retime_onto_the_output_timeline |
| P2 short track left silence | `prefer_long` in match; `take()` loops whole bars with a beat crossfade | SafetyTests.test_short_track_loops_without_silence (12 s track under a 40 s reel, full-bed and drop: no 0.25 s window below a quarter of the median level) |
| P2 recaption dropped folder music | `_recaption_music`: stored plan rendered again, or made-here bed with `fallback`/`was` in render.json | TimelineTests.test_recaption_falls_back_when_the_folder_track_is_gone |
| P2 switches bypassed | look parts gated by `reel-music`, `reel-transitions`, `clip-look`; the first two now default ON | test_clip_look CodexReviewTests.test_each_part_obeys_its_own_switch; flags.test.mjs, studio-ui-flags-feedback.test.mjs |
| P2 resume re-picked | `_resume_row` keeps the stored row; no history update | CodexReviewTests.test_resume_keeps_the_stored_row_and_makes_no_pick |
| P2 full FFT / autocorrelation | 256-frame FFT batches, BPM-range lags only, mono decode, 20 s loudness guide | SafetyTests.test_analysis_of_a_240_s_track_stays_in_bounded_memory: **119 MB** peak (tracemalloc, bound 150 MB) |
| P3 cache key in whole seconds | path + size + `st_mtime_ns` + sha1 of the first and last 64 KiB | SafetyTests.test_cache_key_sees_a_same_second_change |

Re-run after the fixes (one file at a time): test_reel_transition_sets 14, test_music_library 15, test_clip_look 15, test_reel_captions 14 (2 skipped: fontTools not in the venv, as before), test_reel_music 12, test_reel_transition 9, test_reel_title 15, test_clip_montage 35, test_clip_live_montage 6, test_long_video 23, all pass. Node: flags 10, studio-ui-flags-feedback 16, learning-mix 26, user-settings-reel-transition 3, user-settings-clip-look 4, all pass.

Mix level note: the limiter acts only on peaks above -4 dBFS, so a reel's game sound keeps its level (test_reel_music ducking check: within 1 dB of the plain reel).

## Codex verify fixes (2026-11-21)
| Finding | Fix | Test (result) |
|---|---|---|
| Drop past the loop end gave a short or empty bed | `take()` maps a start past the loop end into the loop | test_music_library SafetyTests.test_short_track_loops_without_silence (late drop: 40 s bed, no gap) |
| Rows written only after all jobs; resume guessed decisions | row saved atomically after each reel; a file without its row is rendered again | test_clip_pipeline test_montage_writes_a_posting_run_folder + check_interrupted_run (pass) |

`test_clip_pipeline` also now expects the reel end to be shortened by the cross fade, because `reel-transitions` is ON by default.
Re-run (one file at a time): test_music_library 15, test_clip_pipeline 37, test_clip_look 15, test_clip_montage 35, test_clip_live_montage 6, test_clip_e2e 7, all pass.
Accepted residuals: the check-then-open race in the user's own music folder; a crafted cache-key collision (same-size edit in the middle of the file plus a restored mtime_ns). Both are in D411.
