# BeatDrop montages, long-video teaching overlays and countdown reels (plan, 2026-11-21)

Status: APPROVED 2026-11-21 (D413; answers to section 6 recorded there). User request 2026-11-21 with seven reference videos in the user's local
`_data` folder (`video reference`, outside the repo, never copied, committed or uploaded). Builds on the reel styles
library (RS1-RS4, D412), the clip look (FX1-FX4, D411), the long highlights video and the CODM game pack.

## 1. What the references show (studied 2026-11-21)

Method: every reference decoded off air at BelowNormal priority (4 frames/s, 1 frame/s for the long one), scene
changes from ffmpeg `scene > 0.25`, music onsets and tempo from the mono sound track (spectral flux), contact sheets
read by eye. Frames stayed in the session scratch folder; nothing went into the repo.

### 1.1 Reference 1: long-video workflow (CODM, 2560x1440, 7.9 min, teaching video)

- Captions word by word, bottom centre, white bold with the newest word in cyan; always on.
- Chapter cards: a numbered, slightly tilted label ("<TECHNIQUE> 1") on a blue gradient with a large ring graphic;
  the card animates in and out between chapters. A dial graphic ("STRAFE SPEED") recurs as a theme across chapters.
- Movement drawn on the ground: a glowing curve (cyan, red or blue) traces where the player or enemy strafes,
  drawn on in step with the action. This is the "pointing out enemy movement" part.
- Callout cards: perk and attachment screenshots inside a framed box with a glowing border; a zoomed HUD crop
  ("<MAP NAME>") as a punch-in; lobby and training-range B-roll between gameplay.
- Pace: about 30 cuts a minute, median shot 1.3 s.

### 1.2 Reference 2: in-reel font, effect and transition (CODM, 1080x1920, 42 s, countdown reel)

- Format: a ranked countdown (#5 to #1), each entry = rank card, gameplay, commentary.
- Rank card: huge chunky numeral ("#5"), a different bright colour per rank, the weapon render, and the weapon name in
  a heavy yellow display font with a dark outline. The name letters fly in scattered and assemble in about 0.5 s.
- A loadout screenshot pops in over gameplay inside a cyan frame (scale-in), then out.
- Whip transitions with directional motion blur between card, gameplay and the presenter's face-cam.
- A red-bordered callout box for notes ("NERFS: ..."); a small fixed credit line near the bottom.
- Median shot 1.6 s.

### 1.3 BeatDrop montages (5 references, 16:9, 2.5-3.1 min each)

All five are sniper montages from PC/console Call of Duty, not CODM (their HUDs are the PC games'). The edit
language carries over; the camera tools differ (see section 3).

Measured (scene detector counts flashes and whip frames as cuts, so cut counts are an upper bound):

| Ref | Length | Cuts/min | Median shot | 10-90 % shot | Tempo | Cuts within 50 ms of a music onset |
|---|---|---|---|---|---|---|
| 1 (mkv) | 188 s | 90 | 0.30 s | 0.02-1.67 s | 67 (134) bpm | 59 % |
| 1 (webm) | 170 s | 88 | 0.40 s | 0.02-1.66 s | 120 bpm | 72 % |
| 2 (mkv) | 158 s | 116 | 0.12 s | 0.02-1.34 s | 85 bpm | 44 % |
| 2 (webm) | 152 s | 53 | 0.67 s | 0.02-2.85 s | 103 bpm | 82 % |
| 3 (webm) | 186 s | 90 | 0.37 s | 0.03-1.53 s | 81 bpm | 62 % |

Chance level for "within 50 ms of an onset" at about 4 onsets a second is about 40 %, so four of the five are cut
clearly on the music (60-82 %). The two `(1)` files and the two `(2)` files are different edits (different lengths,
grades and intros), so there are five references.

Structure shared by all five:

1. **Cold open, 15-25 s, no kills:** slow cinematic shots (a map fly-through, a mask/goggle POV, character close-ups,
   a car or lobby scene), cut on downbeats only.
2. **Title:** "<editor> presents" and the song title as large 3D-looking text placed inside the scene, so the camera
   moves past it, with a glow. One reference uses glossy chrome text.
3. **First drop:** the first kill lands exactly on the drop. From here every gunshot, hit and kill is on a beat.
4. **Body:** first-person kills (mostly scoped) alternating with third-person shots of the player's own character
   (running, sliding, aiming, the kill seen from outside), slow-motion enemy ragdolls with blood particles, quick
   flicks timed to beats.
5. **Breakdowns:** when the song calms, cinematic third-person shots and letterbox bars return.
6. **Outro:** a hero pose of the character in third person, held and faded to black and white, then credits
   ("clips by / edited by") and a logo sting.

Effects seen across them: zoom-through-the-scope transition (the camera pushes into the scope lens and the next clip
starts inside it); whip pans with motion blur; white or coloured flash on impacts; RGB split and glitch; shake on
shots; speed ramps (fast, then slow motion on the kill); heavy colour grades with bloom (teal-white, blue-purple, pink,
warm orange, saturated pink); kinetic lyric text in one reference; letterbox in cinematic sections.

## 2. The two options the user named

**Option 1: Ujwalam finds every moment and sets everything up to the final detail.** The user picks a song (or lets
Ujwalam pick from the music library) and the recordings or matches; Ujwalam builds the whole montage: song map, cold
open, title, drop, beat-locked kills, transitions, grade, outro and credits; it renders a preview and the user
accepts it, asks for another take, or changes any part. This is the default.

**Option 2: CODM replay recording for third-person and first-person switches.** Useful, with one unknown. CODM has
Match Replay in the global version (turned on in Settings > Basic > Match Replay, opened from the profile's History
tab or the match stats; source: a third-party guide, not checked in game). Whether its viewer offers a third-person or free camera is not documented anywhere I could find
(UNVERIFIED). Two facts help either way:

- CODM Battle Royale lets the player choose third person (TPP) or first person (FPP), so BR matches give real
  third-person footage of the user's own character without any replay.
- If Match Replay has a third-person or free camera, the capture card records the replay playback like any other
  game screen, and Ujwalam can line the replay up with the original first-person recording (match timer and kill
  feed read by OCR, which the CODM pack already does) and cut between the two on a beat.

If the replay is first-person only, the TPP/FPP switch cannot come from real footage in MP; Ujwalam then uses
BR third-person clips, lobby and loadout footage of the character, and a "camera pull-out" transition (zoom out with
blur) instead. It never fakes a third-person view.

## 3. CODM-specific intro elements

The user wants the intro to look like CODM: its characters, fonts and effects.

- **Characters:** recorded from the game itself, never from other people's videos: the operator in the loadout or
  lobby screen (the user turns the operator, Ujwalam records through the capture card), the BR plane and drop, the
  match-start screen, MVP and Impact Play screens (already detected by M1/M2). Ujwalam keeps a small "intro shots"
  bin per character skin, gathered during normal play by the capture plan (T1 coverage), and asks for a short guided
  capture once (section 5, BD6).
- **Fonts:** CODM's own font files are not ours to ship. Ujwalam uses free, open-licence (OFL) display fonts that
  look close (heavy condensed sans for titles, a clean sans for captions); the download needs the user's yes, and the
  licence goes in `docs/licence-headers.md`.
- **Effects:** built from Ujwalam's own effects to match the CODM look: HUD-style corner brackets and scan lines,
  orange and cyan accents, a medal-style pop for the title, the game's own kill and medal sounds where they are in
  the recording.

## 4. Hard limits (unchanged)

Flash at most 3 per second per canvas (the BeatDrop references go above this; Ujwalam's versions are re-spaced or
use colour pulses instead); overlay entrances under 600 ms and exits under 400 ms; audio encoded once with the D411
limiter; off air only for analysis and rendering (record-clips rule); BelowNormal, one heavy job; no network, no
installs, no font or music downloads without the user's yes; no auto-posting of montages with a commercial song
(see 6.2). References and recordings stay local.

## 5. Phases

### BD1 Moment finder (Option 1 core)
From a recording (H canvas, or the clean capture-card track if one is recorded, see 6.1), find and time each moment
to the frame:
- **Gunshots:** sharp transients in the game sound (spectral flux in the 1-6 kHz band) confirmed by a muzzle flash
  (brightness spike near the weapon area) within 2 frames.
- **Hits and kills:** existing CODM detectors (M4 "+N points", M5/B1 kill feed, M3 medals, X1 streak card, B2 kill
  counter, N1 killcam); the kill time = the first frame the hit marker or "+N" appears.
- **Scope in and out:** the scope's dark ring and centre brightness (sniper and ADS).
- **Movement:** flicks (a burst of sideways camera motion from optical flow at low resolution), slides and jumps
  (vertical flow pattern), sprint.
- **Character and lobby shots, BR third person:** screen type from the existing screen detectors plus a TPP test
  (character body visible in the lower middle).
- Each moment gets a strength score; detector values follow AGENTS.md (evidence, status unverified until checked on
  the user's footage; event weights proposed from footage and approved by the user).

### BD2 Song map
For the chosen track: beat grid and downbeats (from the existing `music_library` analysis, extended with a tempo
and phase fit), sections (intro, build, drop, breakdown, second drop, outro) from energy and novelty, the drop
times, and the strong transients a gunshot can land on. Shown as a coloured strip in the preview.

### BD3 Beat-locked edit planner
- Fill the song map with moments: cold open with cinematic and lobby shots, the title on the intro's last bars, the
  best kill exactly on the first drop, then kills and gunshots on beats, flicks and slides on off-beats, breakdowns
  with third-person and slow motion, a hero shot and credits on the outro.
- Retiming: each piece is speed-ramped (the `speed-ramp` core function from RS2) so its gunshot or kill frame lands
  on the target beat within one frame (16.7 ms at 60 fps), never stretched beyond 0.5x-2x.
- Game sound: ducked under the music; the gunshot and kill sounds are kept as short cut-outs on their beats (one
  audio encode).
- Target numbers come from a chosen reel style (RS1 analysis of the BeatDrop references: median shot, cut rate,
  share on the beat) so a new reference changes the edit without code.

### BD4 BeatDrop effects (core functions, each with manifest, preset and tags)
`scope-zoom-transition` (push into the scope lens, next clip starts inside it), `whip-pan` (directional blur and
offset, 6-10 frames), `impact-flash` (within the flash limit, otherwise a colour pulse), `rgb-split`, `shot-shake`,
`letterbox`, `ragdoll-slowmo` (slow motion and a short zoom on a kill, from `speed-ramp` and `zoom-pulse`), `bloom-grade`
(glow plus a LUT from the reel style). All tunable, all inside the flash and timing limits, all with flash-rate tests.

### BD5 Intro and title builder
- "<channel> presents" and the song title as large extruded-looking text with glow (rendered as layered 2D text
  with depth, light sweep and shadow; no 3D engine).
- Pinned in the scene: the text is fixed to a wall or the ground by tracking that flat area through the shot
  (OpenCV feature tracking and a homography at low resolution), so the camera moves past it as in the references.
- Brand name from `data/profile.local.json` only; committed files use placeholders.
- Credits and a logo sting at the end; kinetic lyric text optional (only when the user supplies lyrics).

### BD6 Guided capture for intro shots and third person
A short guided session in the studio (off air): "turn your operator slowly", "open the BR plane", "open the last
match's replay and switch camera" with the capture card recording and Ujwalam labelling each shot. If Match Replay
has a third-person or free camera, Ujwalam lines replay footage up with the original match (match timer and kill
feed OCR, then sound) and offers TPP/FPP switches on beats. Needs the user at the console; never runs during a
stream.

### BD7 Review and "final detail"
A preview with the song strip, each moment as a block, and a plain-word list ("kill on the first drop at 0:24",
"6 kills on beats", "2 third-person shots"). One click each for "another take", "slower intro", "more third person",
"swap this clip"; everything else automatic. Renders H (16:9) and a V (9:16) version cut from the same plan with the
V framing rules.

### LV1 Long-video teaching overlays (reference 1)
For the long highlights video: word-by-word captions with the current word in an accent colour (extends
`clip_captions`), numbered chapter cards with a theme graphic, callout cards that frame a screenshot or a HUD crop with
a glowing border, and movement paths drawn on the ground: Ujwalam proposes a path from tracking (the user's own
movement from optical flow, an enemy from the red name tag and hit marker positions) and draws it on in step with the
action; the user can drag the path in the review before rendering. Enemy tracking accuracy is UNVERIFIED until checked
on the user's footage.

### RR1 Countdown reel template (reference 2)
A "Top 5" reel type: rank cards (big numeral, a colour per rank, item render or a still from the clip, name letters
assembling in 0.5 s), a loadout screenshot pop-in with a coloured frame, whip transitions, an optional face-cam
segment when the face-cam layer was recorded, a red callout box for notes. Items and order come from the
user's clips (best weapons, best plays) or the user's list.

## 6. Data and choices needed from the user

6.1 **Clean gameplay recording.** The clips corpus holds vertical cut-outs only. BeatDrop needs full-frame 16:9
gameplay without overlays. Proposed: record the capture-card source clean as a second recording track whenever the
stream records (a setting, ON when the user says yes). Disk use about 4-6 GB an hour at the current quality (to be
measured).

6.2 **Music.** The references use commercial songs. A montage with a commercial song gets a Content ID claim on
YouTube (blocked, muted or monetised by the owner). Proposed: montages with a song from the user's own folder are
rendered but never auto-posted; the user posts them by hand. Free-licence and AI music (D411 FX5/FX6) can be
auto-posted.

6.3 **Fonts.** Yes or no to downloading two or three OFL display fonts (named before download, with licences).

6.4 **Match Replay check.** Please open one Match Replay in CODM and tell me which camera buttons it shows
(first person only, third person, free camera, other players). That decides BD6.
Answered by the user 2026-11-21: third-person view yes; FPP/TPP switch during playback yes; HUD can be hidden (clean
frame) yes; slow motion yes, 0.5x selectable. Free camera and other players not asked (UNVERIFIED). BD6 is go: the
replay is recorded from the capture card with the HUD hidden; alignment to the original match uses sound and the match
timer shown before the HUD is hidden; 0.5x playback is recorded as native slow motion (retimed to 1x where the beat
plan needs real time).

6.5 **Option order.** Proposed order: BD1-BD3 (moments, song map, beat-locked edit) and BD4 first, then BD5, BD7,
LV1, RR1, and BD6 when 6.4 is answered.

## 7. Done when (evidence in docs/evidence/)

| Phase | Done when |
|---|---|
| BD1 | gunshot, kill, scope and flick times within 2 frames on hand-labelled stretches of the user's footage (labels with timestamps only), precision and recall reported per moment type |
| BD2 | beat grid within 20 ms and drops found on 5 tracks with hand-marked drops |
| BD3 | a rendered montage measures back: at least 80 % of kills within one frame of a beat, first kill on the first drop, flash limit held |
| BD4 | each effect in the registry with presets, flash-rate test passing, timing limits held |
| BD5 | pinned title stays within 3 px of its tracked plane on fixtures; brand from the local profile only |
| BD6 | replay and original lined up within 2 frames on one real match (needs the user) |
| BD7 | one-click retakes change only what they name; H and V renders from one plan |
| LV1 | captions and chapter cards on the long video; a drawn path follows a tracked target on fixtures |
| RR1 | a Top 5 reel renders from the user's clips with rank cards inside the timing limits |

A feature is done only after the user has posted or watched a real one with no high-severity feedback.
