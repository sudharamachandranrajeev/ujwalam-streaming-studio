# Clip music, name display and transitions (plan, 2026-11-21)

Status: user request 2026-11-20, choices made in an interview the same day (memory note clip-music-name-fx). Queued
after the long highlights video (`claude/long-video`, which reuses `clip_montage.render_argv`; this work changes that
function, so it starts after that branch merges). Phases FX1–FX6 below.

## 1. The user's words and choices

"the clip start and end music and it's transition is very unpleasent, low quality and dated. need more options and
suggestions. The gamer Name display is extremely basic, and it's at the center bluring all gameplay behind. need more
options to set these up while making clips and a randomise these effects options in settings so that user can
customise everything according to the requirements"

| Area | Chosen | Not chosen |
|---|---|---|
| Music source | own music folder; free royalty-free pack via the download manager; local AI music (ACE-Step); and "find, generate and pick musics based on game clips" | — |
| Transitions + sound effects | Punchy gaming, Cinematic, Clean / minimal | Retro / VHS |
| Name display | Lower third, Corner tag, Kinetic text reveal | the current centre card over blur |
| Randomise | each clip picks from the user's ticks, no repeat of recent picks, any part lockable; position, colour, size, timing tunable | fixed per clip type; only inside reel styles |

## 2. What is there today (why it sounds and looks dated)

- Music (RP3, `services/clip/reel_music.py`, `data/clip/music.json`): a procedural lofi bed (sine electric piano,
  synth kick, noise snare and hats, crackle, one-pole low-pass), 72–86 BPM, 3 s at the start and 4 s at the end of a
  reel, about −20 dB, ducked by the game sound. One synthesis style; no real instruments; never matched to the clip.
- Transitions (RP1, `reel_transition.py`, `data/clip/transitions.json`): Cut or Cross fade 150–500 ms. No sound on
  the join.
- Title (RP4, `reel_title.py`, `data/clip/title.json`, render in `clip_montage.render_argv` ~:475): the brand in
  Exo 2 Bold, centred, 1.6 s, over a gblur sigma 18 copy of the whole frame darkened to 55 %. It hides the gameplay.
- Flags `reel-music`, `reel-title`, `reel-transitions` are off by default.

## 3. Design

### 3.1 One "clip look" pick per clip

New `services/clip/clip_look.py`: for each reel, one seeded pick (seed = reel id + source, as `reel_music.seed_for`)
of music mode + track, transition set, name style, from the user's ticks in `settings.json clips.look`. Weighted pick
with a seeded RNG and no-repeat-last-N (settled design decision "Pools"); the last picks live in
`<data>/clips/look-history.json`. A locked part always uses its one choice. The pick is written into the reel's
`render.json` (`look`) so a re-render gives the same reel and self-learning (RP5) can score each choice.

`settings.json clips.look` (checked in `user-settings.mjs` and in Python, same rules, as `reelTransition` today):

```json
{ "music":       { "sources": ["folder", "pack", "ai"], "modes": ["intro-outro", "drop", "full-bed"],
                   "folder": "<user-picked path>", "levelDb": -16, "lock": null },
  "transitions": { "styles": ["punchy", "cinematic", "clean"], "sfx": true, "beatSync": true, "lock": null },
  "name":        { "styles": ["lower-third", "corner-tag", "kinetic"], "position": "auto", "colour": "theme",
                   "sizePct": 100, "durationSec": 2.0, "logo": true, "lock": null } }
```

### 3.2 Name display (FX1): libass, no blur

Rendered as an ASS subtitle file burned by libass, the same path the captions already use (bundled fonts, no system
fonts, no new dependency). ASS gives per-letter timing (`\t`, `\move`, `\fad`, `\fscx`, `\frz`), vector shapes for bars
and badges (`\p1`), outlines and soft shadows on the text only. The game picture is never blurred or darkened.

| Style | Look | Default timing |
|---|---|---|
| Lower third | accent bar slides in from the left (~250 ms), name types on over it, optional logo square; slides out (~300 ms) | 2.0 s, bottom safe area |
| Corner tag | small rounded badge with name (and logo); pops in with a slight overshoot; stays the whole clip or 3 s | whole clip, top-left |
| Kinetic reveal | big letters one by one: slice-in, scale-punch or glitch-shift variants, shadow and outline, no box | 1.4 s, upper third |

Entrances < 600 ms, exits < 400 ms (overlay rule). "auto" position avoids the game HUD: per-game safe boxes in
`data/games/<id>/` (minimap, kill feed, buttons), else the V canvas safe area. Colour "theme" = the studio theme
accent; or a picked colour. The brand comes from the local profile as now (never committed). Captions move out of the
name's way for its time window. The RP4 centre card and its blur filter are removed (not chosen by the user).

### 3.3 Transitions and sound effects (FX2)

`data/clip/transitions.json` grows from kinds to **sets**; each set is a pool of joins plus its sound effects:

| Set | Joins (ffmpeg, LGPL build) | Sound on the join |
|---|---|---|
| Punchy gaming | zoom punch (scale + crop ramp over 6–8 frames), whip pan (`xfade` slideleft/right + `tmix` motion blur), short shake (`crop` jitter), RGB split (`rgbashift`), glitch slice | whoosh, impact hit; bass drop on the first kill |
| Cinematic | `xfade` fadeblack / smoothleft / circleopen, procedural light leak (colour gradient overlay, screen blend), speed ramp into slow motion on the big moment (`setpts`, audio `atempo`) | riser into the moment, low boom |
| Clean / minimal | fade 200 ms, soft slide, subtle zoom (≤ 4 %) | light whoosh or none |

- Sound effects: made on this PC (filtered-noise sweeps for whooshes and risers, pitched sine + noise transients for
  impacts and booms) and cached as WAV per set; no licence limits. Pack sound effects (FX5) join the pool if present.
- `beatSync`: with music on, each join is moved (by at most ±0.25 s, never cutting a kill) to the nearest beat.
- Flash safety: light leaks, glitches and RGB splits count as flashes; ≤ 3 flashes/s per reel, checked in the planner
  and measured from the rendered frames' luminance in the test (existing `fx test` method).
- A reel with burned-in captions keeps its joins (today it falls back to a hard cut; the captions are drawn after the
  joins, so this restriction is lifted and tested).

### 3.4 Music (FX3 folder + matching, FX5 pack, FX6 AI)

**Library** (`services/clip/music_library.py`, `<data>/music/library.json`): every track from the sources the user
ticked, analysed once off air with PyAV + numpy (both already pinned in the shipped Python runtime): BPM and beat grid
(onset envelope + autocorrelation), energy curve, the drop (largest sustained energy rise), loudness (EBU R128 via
ffmpeg `ebur128`), mood tag guessed from tempo + energy + brightness and editable by the user (phonk, trap, EDM,
cinematic, lo-fi, chill), licence note per track (folder tracks: the user's own statement; pack: from the pack list).

**Matching ("find, generate and pick musics based on game clips")**: each reel gets a target from its own facts:
energy from kill count, streak length, multi-kill spacing and loudness peaks; mood from the reel kind (win reel =
hype, impact play = punchy, montage = the montage story arc). Tracks are scored on mood, energy fit and length; the
pick is seeded and no-repeat-last-N. If no track fits well (score below a threshold) and the AI source is ticked, a
track is generated for that target (FX6), off air.

**Modes**:
- Intro + outro (as now, but a real track, cut on its beats with a short fade-out on a bar line).
- Drop on the big moment: the track's drop lands on the reel's strongest kill; the bed runs from the start, ducked.
- Full bed: the whole reel, ducked under game sound and voice.
Level −16 dB default (range −24 to −10), sidechain duck as now (game and speech stay on top).

**Free pack (FX5)**: `data/clip/music-packs.json` lists candidate sources with licence, URL and checked date; every
entry UNVERIFIED until the licence is read (CC0 or a licence that allows use in monetised videos without
attribution problems). Fetched through Settings > Downloads (pause, resume, cancel, never while live). Nothing is
bundled in the Setup. The first download needs the user's yes.

**Local AI music (FX6)**: ACE-Step (MIT licence per its repo; UNVERIFIED: version, model size, VRAM on 6 GB, Windows
support). Spike first: one 30 s track at a given tempo and mood, measure time, VRAM and quality. Runs only off air,
one heavy job, model unloaded after. The model download and any Python package are installs: ask the user first.

The procedural lofi stays only as a last fallback when no source has a track (and is labelled as such in Settings).

### 3.5 Settings > Clips "Clip look" (FX4)

One section with three cards (Music, Transitions, Name display). Each card: tick boxes for what may be picked, a lock
("always use") per card, the tunables (position, colour, size, length, level), and **Preview**: renders a 6 s sample
from the newest reel off air and plays it in the dialog. Plain words, Save / Discard, no layout jumps, toggles with
visible text. Music card shows the library (tracks, mood, BPM, licence note), "Choose folder…", "Rescan".

### 3.6 Flags

User-requested, so ON by default once each phase passes: `clip-look` (the pick and the new name styles),
`reel-transitions` and `reel-music` switch to the new behaviour and default ON with the new sets/sources. Each stays
a visible switch on the control page. `reel-title` is retired with the centre card (its id kept in the flag file as
retired so old settings files still load).

## 4. Phases

| Phase | Work | Done when (evidence in docs/evidence/) |
|---|---|---|
| FX1 | Name styles via ASS (3 styles, position auto/manual, colour, size, length), RP4 card removed | rendered frames of each style on H and V show no blur; entrance/exit timings measured; HUD boxes not covered |
| FX2 | Transition sets + procedural sound effects + beat sync + captions keep joins | flash rate ≤ 3/s measured per set; sample reels of each set; audio peaks below the game mix |
| FX3 | Music library from the user's folder, analysis, matching, three modes | BPM/drop checked against a hand-labelled set of tracks; picks differ per reel and never repeat the last N |
| FX4 | `clips.look` settings, pick + history, Settings card with Preview | settings round-trip tests; preview renders off air only; a locked part never varies |
| FX5 | Free pack list and download (user's yes on first download) | licence per track recorded; download pauses/resumes; nothing while live |
| FX6 | ACE-Step spike, then generation for unmatched targets (user's yes on install) | time, VRAM, quality numbers; never runs live; falls back cleanly |

FX1–FX4 need nothing from the user. FX5 and FX6 wait for the user's yes.

## 5. Open points (agent's defaults until the user says otherwise)

- Kinetic reveal position: upper third (keeps the crosshair area clear).
- Corner tag: whole clip, top-left, 70 % opacity after the first 2 s.
- Music level default −16 dB.
- Beat sync on.
