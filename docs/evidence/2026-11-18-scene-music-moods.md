# MU1 scene music moods: evidence (2026-11-18)

Plan: `docs/plan/2026-11-18-audio-mixer-music.md` row MU1. Built on the RP3 procedural maker idea
(`docs/evidence/2026-11-12-rp3-music-beds.md`, D363, D370); `services/clip/reel_music.py` is untouched, so the reel
output is unchanged.

Status: **built, tests pass; nobody has listened yet. Whether each mood sounds like its name is UNVERIFIED until the
user listens.** Tempo, keys, chords, levels and loudness targets are proposals (`status: proposed` in each manifest).
Not wired into scenes or the mixer (that is MU2, after the mixer fixes).

## What was built

- `services/clip/scene_music.py`: the generator and the CLI. Plain Python plus numpy (already in `.venv-gpu`; no new
  dependency, no model, no download). Instruments: electric piano, saw pad, sine bass, 8th-note pulse bass, 16th
  arpeggio, drone, bell, kick, snare, clap, hats, vinyl crackle. Reverb and low-pass run over the whole loop in the
  frequency domain.
- `data/music/moods/*.json`: one manifest per mood (tempo range, keys, chord types, progressions, instruments with
  level and density, drum pattern, swing, low-pass, reverb, loudness target and tolerance, peak ceiling, duration,
  version, `why`). `data/schemas/music-mood.schema.json`: the schema. The code names no mood.
- Format: WAV PCM 16-bit, 48 kHz, stereo, the same container RP3 writes (no codec, so nothing to license; libobs
  `ffmpeg_source` plays WAV). About 11.5 MB per minute: a library of the five beds is about 180 MB (not committed;
  `*.wav` and `*.m4a` are gitignored).
- Seamless loop: every note is added into a ring (what runs past the end wraps to the start) and the reverb and
  low-pass are circular, so the last sample is followed by the first like any two neighbours. Bars are whole numbers
  of samples (16th = `round(48000 * 15 / bpm)`).
- Loudness: integrated LUFS, ITU-R BS.1770-4 (K-weighting, 400 ms blocks, -70 LUFS and -10 LU gates), measured in
  numpy over the final 16-bit samples. RP3 has no own measurement (its ffmpeg ebur128 use is for clip ranking), so the
  meter is new and was cross-checked against `ffmpeg ebur128` (below). A tanh soft limit keeps the peak under the
  manifest ceiling (-1 dBFS) and the gain is re-measured after it.
- Determinism: all choices come from `random.Random(seed)` and `numpy.random.default_rng(seed)`; a mood's seed is
  `seed_for("scene-music", baseSeed, moodId)` (reel_music's hash).
- CLI: `python services/clip/scene_music.py --out <folder> [--mood id ...] [--seed N] [--duration SEC]`
  (run without `-I`; it needs its own folder on the path). It writes `<mood>.wav` and `index.json` (file, mood,
  mood version, seed, duration, bpm, key, progression, bars, target and measured LUFS, peak, seam numbers, SHA-256,
  bytes). It refuses to write inside the repo. It refuses unless `node tools/live-check.mjs` says off air (exit 0);
  live (exit 1) and unknown (exit 2, or node or the script missing) both refuse with exit code 3. It lowers its own
  priority. Child process uses `child_kwargs(**NO_WINDOW)`.

## Measured (full library, seed 1, made with the CLI, 2026-11-18, off air per live-check)

Generation took 7 min 6 s for the five beds on this laptop, CPU, below normal priority, one process.

| Mood | Length | BPM / key (MIDI) / progression | Target LUFS | Measured LUFS (own meter) | ffmpeg ebur128 I | Sample peak | Seam step | Ref step (p99.9) | Seam ratio |
|---|---|---|---|---|---|---|---|---|---|
| starting-soon | 177.8 s (80 bars) | 108 / 50 / i-VI-III-VII | -20 | -20.0 | -20.0 | -6.5 dBFS | 176 | 1738 | 0.101 |
| lobby | 180.0 s (60 bars) | 80 / 58 / ii-V-I-vi | -23 | -23.0 | -23.0 | -8.5 dBFS | 12 | 296 | 0.041 |
| in-match | 227.8 s (56 bars) | 59 / 40 / i-isus2-VI-v | -30 | -30.0 | -30.0 | -21.0 dBFS | 16 | 75 | 0.213 |
| brb | 180.7 s (64 bars) | 85 / 62 / ii-V-I-IV | -23 | -23.0 | -23.0 | -8.2 dBFS | 71 | 436 | 0.163 |
| ending | 176.0 s (44 bars) | 60 / 60 / I-iii-IV-V | -24 | -24.0 | -24.0 | -11.6 dBFS | 44 | 705 | 0.062 |

Seam step = the largest channel difference (16-bit units) between the last sample and the first. Ref step = the 99.9th
percentile of all neighbouring steps in the bed. Ratio <= 1 means the seam is smoother than 99.9 percent of the places
inside the bed, so no click. All five are far below 1.

The `in-match` bed is the quietest: 6 to 7 LU under lobby, brb and ending and 10 LU under starting-soon, before the
later duck (AU3).

## Tests

Run with `.venv-gpu\Scripts\python.exe -I -m unittest discover -s tests/py -t tests/py -p test_scene_music.py`, that one
file only, after `node tools/live-check.mjs` said off air. The test process ran at normal priority; the CLI lowers its own.

| Test | Result |
|---|---|
| `tests/py/test_scene_music.py` (21 tests, 87 s) | OK |
| manifests: five moods load and validate; file name must equal id; ten bad manifests refused (missing field, unknown property, out-of-range, min above max, unknown drum pattern or instrument, undefined chord type, bad version, drum instrument without drums); in-match at least 3 LU under the rest | pass |
| meter: 1 kHz sine at -20 dBFS peak reads -20 LUFS within 0.3; 6 dB gain moves 6.02 LU; silence is -70; the seam check flags a synthetic click | pass |
| beds (2 bars, a few seconds each): same seed gives identical bytes, another seed another bed; WAV is 2 channels, 16 bit, 48 kHz; seam ratio <= 1 for all five, read back from the file; loudness re-measured from the written file within each manifest's tolerance (1 LU) and equal to the recorded value; peak under the ceiling | pass |
| CLI: refuses while live (exit 3, nothing created); refuses when the check cannot tell; refuses to write inside the repo; unknown mood is an error; off air writes the WAVs plus `index.json` with matching SHA-256 and a second run gives an identical index | pass (live check faked) |

Not run: the full `npm run ci`, the full Python suite, any GPU test (rules for this task). Not done: listening, a
real playback through libobs `ffmpeg_source` (MU2).

## Files

Created: `services/clip/scene_music.py`, `data/music/moods/{starting-soon,lobby,in-match,brb,ending}.json`,
`data/schemas/music-mood.schema.json`, `tests/py/test_scene_music.py`, this file.
