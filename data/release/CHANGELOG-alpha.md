# Ujwalam alpha changelog

One section per alpha build (`0.1.0-alpha.N`, D133). The packager copies the section for the build into the zip as `CHANGELOG-alpha.md`.

## 0.1.0-alpha.46 — 2026-11-26

- Realism looks on reels: Settings > Clips > Clip look > Realism look. Per reel type: Off (the default), one look, or Random from the looks you tick (a re-made reel keeps its look). A realism look replaces the reel style's colour, never both. Reels take about 6 to 11 times longer to make with a look (bloom and clarity cost the most); nothing changes on the live stream. Not yet tried on real stream reels.
- Your own look from a reference: right-click a scene > Make realism scene > New look from a reference…, or the same in Settings > Clips > Realism look. Pick a screenshot or short video; its colours are measured and saved as your own look (glow, grain and vignette come from the closest built-in look). Only the measured numbers are kept, never the picture or its name. Rename or delete your own looks there.

## 0.1.0-alpha.45 — 2026-11-26

- Scheduling manager: the long list of next posting times left Settings (Settings opens and scrolls fast again; Instagram Reels is easy to find). More > Scheduled posts… (or Settings > Open scheduling manager) opens a list like the task manager, in its own window or docked: posts by day, search, filter by place and state, Move, Remove, Upload now / Post now, Retry, Move this day with Undo, Remove all failed.
- Realism looks: right-click a scene > Make realism scene now offers seven looks (Filmic, Cinematic, Dark cinematic, Cold high-key, Gritty war, HDR vivid, Night neon). It makes a copy named after the look; your scene is never changed, and nothing is made while live. New bloom, clarity and lens colour fringe effects. Not yet tried on real gameplay.
- Studio no longer stalls: the task chip animates only while a task runs, task rows are kept between updates, and closing shows a "Closing Ujwalam…" card.
## 0.1.0-alpha.44 — 2026-11-25

- Studio window crash fixed: the window could close by itself and reopen after 2 s (four times in one hour of recording). The cause was the app's own slowness monitor reading something that had just been deleted. Your recording was never affected.
- Stream stats clock: shows the real stream or recording time, also after the window reopens (it used to start again from 0).
- Post style: titles with one emoji and #codm #shorts on Shorts; the description adds Featured, subscribe and Streamer lines and seven game hashtags; longer tag lists. An emoji after a sentence stays on its line.
- Your own tags: Settings > Posting & growth has a new "Your own tags" box (up to 15); they are added to every post, and the redo of scheduled posts keeps your own hashtags.
## 0.1.0-alpha.43 — 2026-11-25

- Instagram Reels auto-post: the same clips as your Shorts can also go to Instagram as Reels, on their own schedule, as many a day as Instagram allows. Settings > Posting > Instagram Reels: save your Meta app's App ID and App Secret (kept in Windows Credential Manager), then click Connect. Not yet tried against a real Instagram account.
- Post text names the game: every AI title now has CODM (or Call of Duty) in it; if the AI leaves it out, " | CODM" is added. Shorts get #CODM #codmshorts #Shorts, the long video #CODM #CallOfDutyMobile, and the game tags come first (codm, call of duty mobile, cod mobile, codm shorts, codm highlights). The "Highlight N from the stream on ..." line is replaced by the AI lines; your links stay.
- Stricter post text: no streak, multi-kill or squad wipe claim unless the clip maker counted the kills; no places, colours or objects the pictures cannot prove ("red truck", "desert"). The AI gets up to 3 tries per clip.
- Capture card sound: the capture card layer no longer opens its own sound when the mixer does not use it (your game sound comes from the card's separate audio input). Before, that unused copy kept falling behind and restarting every few seconds. When you add that layer's sound in the mixer, it opens then (a short picture gap).
- Long video colour: the long video is made in the normal colour format again (it came out in a format some players show wrong).
- AI post text on a new PC: one missing graphics-card file is now part of the download.

## 0.1.0-alpha.42 — 2026-11-24

- Clip music: the music is now set 8 dB under each clip's own game sound (measured per clip), never louder than your music level (new default -20 dB). It also turns down 8 dB more while someone talks in the game, with smooth 0.2 s / 0.3 s ramps. The start music stays full until the name ends and then fades out; the end music fades in earlier so its full ending is not cut short. Fades use a smooth S-curve, 1.5 s, by default. Settings > Clips > Clip look has Music under the game, Quieter when someone talks, Fade in, Fade out and Fade shape, each with what it does.
- Long highlights video: the numbered card at the start of each moment is now a K.O. card with no number. A big word says what happened (K.O., DOUBLE K.O., TRIPLE K.O., QUAD K.O., RAMPAGE, STREAK, WON), with a small line under it when it adds something ("streak · 5 kills"). Each moment gets one of five animations (slam in, slash wipe, glitch split, zoom punch, stamp), mixed so the same one never shows twice in a row; a re-made video draws the same ones. Settings > Clips > Clip look > Moment cards on the long video picks which animations are in the mix; untick all to show no cards.
- Loudness: every finished reel, montage and long video is now set to -14 LUFS (YouTube's playback level; YouTube turns loud videos down but never turns quiet ones up, so before this they played very quietly, about -29 LUFS). One fixed gain measured from the whole clip before it is made, then the same peak limiter as before, so peaks stay under -1 dBTP. Each clip's record says the level it reached. Settings > Clips > Clip look has Even out the loudness and the target level, with what could break (louder targets squeeze gunfire peaks harder).

- Captions: every reel and the long video now come with caption files (captions.srt and .vtt) next to them. Malayalam and Manglish lines use a Malayalam font. Off air, captions are made on the graphics card with a faster speech model; on air they stay on the processor so the stream is never slowed. The long highlights video also gets its captions uploaded to YouTube as a caption track (shorts and reels keep them burned in only). To allow that, sign in to YouTube once more: the sign-in now asks for caption permission.
- Task manager window: the task panel can open in its own window ("Open in own window"; Dock or X puts it back). Sort and filter by state, start time or category; each task has Stop, Pause, Resume and what to do at the next start (Run, Ask me, Just notify). Click a task to see its details and log. When tasks are waiting for you at start, a notice says how many; a click opens the window.
- Battle Royale: the end screen and the top bar of a Battle Royale match are now read, so the clip maker knows the placement, mode, map and your own kills of each match.
- Long video joins: the sound no longer has a tiny gap where two parts of a long video meet.
- Post text by the local AI: each post's title, description and tags are now written by the AI model on this PC from four pictures of the clip, what was said in it and what the clip maker found. A checker throws the text out (and keeps the old template text) when it has a wrong fact, a name seen on screen, a placeholder or anything over a platform limit. Never on air. Settings switch: AI post text.
- Cover picture: when the AI text is used, the cover is the moment the AI picked with its short hook line on top (2 lines at most). If that fails, the plain frame as before.
- Rewrite scheduled posts (off by default, command line only for now): posts this app uploaded that are still private and scheduled can get the new AI text. The old text is saved first and can be put back exactly. Videos that are public, edited by you, or due within 30 minutes are never touched.
- First start on a new PC: the shortcut now starts the studio. Before, it stopped without a word because the new PC had no profile file; the app now makes one from the example the first time.

## 0.1.0-alpha.41 — 2026-11-22

- Auto-post: up to 100 uploads a day, YouTube's own limit. The new "Hourly slots, a year ahead" schedule fills every hour (12:00, 13:00 ...) from today up to a year ahead, then the quarter past (12:15 ...), then the half hour, keeping each post 15 minutes from any other. It always counts from today. Slot minutes, the gap, how far ahead and how long one channel read is reused are on the Auto-post card, each with what it does and what it could break. Your saved schedule stays as it is until you pick the new one.
- Review reads: Battle Royale matches are no longer asked to pick a multiplayer mode; the wrong questions already listed are gone.

## 0.1.0-alpha.40 — 2026-11-22

- Settings no longer freezes the window. Opening it built every page and every button shadow at once (about 11 s measured); pages are now made when first shown and shadows when first on screen (well under 1 s). The download list no longer rebuilds every row each second, and the status check no longer redraws panels when nothing changed.
- When the window does stall for a quarter second or more, the log now says how long and what ran, so the next freeze can be traced.
- Top bar: every action keeps its words. My clips, Review reads and BeatDrop are one Clips menu. Icon buttons centre their icon.
- Auto-post card: the "uploads a day fit" number now counts the channel read before each upload, as the sender does (21 a day, not 24).

## 0.1.0-alpha.39 — 2026-11-22

- Auto-post: uploads run again. Before each upload Ujwalam reads the channel to keep new posts an hour away from scheduled ones; it stopped after 2000 videos, so on a bigger channel it waited forever. It now reads up to 10000.
- Clips: a free music pack (37 CC0 tracks, Settings > Downloads). Posts name the artist and track.
- Clips: music made on this PC when nothing fits (ACE-Step 1.5). Pick its folder once in Settings > Clips. Never while live.
- Countdown reel: the picture format is fixed, and a clip that breaks the flash limit is left out and replaced.

## 0.1.0-alpha.38 — 2026-11-22

- Top bar: buttons no longer sit on top of the Ujwalam name. When the window is too narrow for the full labels, the bar switches to icons.
- Help button: a clear drawn icon instead of a blurry question mark.
- Review reads: the picture for each read shows again. The installed app was missing its JPEG reader, so every picture failed without a word; if a picture still cannot be shown, the window now says so.

## 0.1.0-alpha.37 — 2026-11-22

- Long highlights video: one longer horizontal video per session from your best moments, posted like the other clips. It now shows captions word by word, numbered chapter cards, an enlarged kill feed after each medal and a drawn path of the enemy you tracked before the kill ("Long video teaching", on).
- BeatDrop montages: your moments cut on the beat of a song, with a cold open, an in-scene title, the drop, effects and an outro. The studio makes one after the clip job and shows a review card with one-click retakes. NCS songs are credited from their file names; a montage with a song that cannot be credited is not posted.
- Top 5 countdown reel (new, on): your five best vertical clips counted down, each after a rank card with a big number and the clip's name assembling, joined by quick slides. Made from the command line for now (`clipper countdown`); not posted on its own yet.
- Clip look: music from your own folder matched to each clip, name styles without blur (Lower third, Corner tag, Kinetic text), transition and sound-effect sets, and a random mix from the boxes you tick in Settings > Clips.
- Reel styles: named styles learned from example videos (cuts, pacing, zoom pulses, speed ramps), chosen in Settings > Clips > Reel styles.
- Posting: titles and descriptions from what happened in the clip, up to 24 posts a day with at least 60 minutes between them, a button to run posting now, and timing suggestions you can apply or undo.
- New fonts for titles and captions (Anton, Chakra Petch, Rajdhani; free licence).

## 0.1.0-alpha.36 — 2026-11-21

- Auto-post works: it now reads your profile, so the clips waiting with an unfilled channel handle or Discord link get it filled in and upload as scheduled posts. If a value is ever missing, the task bar names it instead of skipping in silence.
- Settings > Posting & growth > Auto-post: choose Random each day (3-6 posts at random times), Custom times (your own times for each weekday, with days off and a preview of the next 10 posts) or Fill gaps.
- "What gets posted" in the same card: switch each clip kind on or off, Upload automatically, and the daily maximum, without editing a file. The card and task bar say plainly when auto-post is on but nothing can upload (no rules, a rules mistake, not signed in).
- Your backlog of clips goes out shuffled, kinds mixed, parts of a split reel in order.
- Recordings are deleted once all their clips and the review are made ("Delete clipped recordings", on). Sessions you keep for labelling stay; Settings > Clips > Recordings lists them.
- One Setup file carries everything (no separate downloads to start); optional models come from Settings > Downloads with pause, resume and cancel, never while live.

## 0.1.0-alpha.35 — 2026-11-19

- Clip scanning is faster: the recording is decoded on the graphics card while you are off air (a 10-minute stretch took 260 s instead of 426 s, with exactly the same clips found). Going live stops it within two seconds, and an interrupted scan picks up where it stopped.
- Each mixer strip has a Tools window: noise suppression, gate, EQ, gain, compressor and limiter, with "Clean voice" and "Loud room" presets that change nothing until you click them.
- Ducking: music or game sound drops while your mic talks ("Duck music under my voice").
- "Add audio" can also add one app's sound, or a sound file or a folder playlist from your media folder.
- A mic, capture card or image that was missing when the studio started is picked up once it appears; strips wait for their device instead of vanishing; "Try again" retries at once.
- Ujwalam-Setup.exe installs and updates; every update backs up your settings first and rolls back as a whole if anything fails. The studio says when an update is available.
- Lighter when idle: the replay buffer runs only while live or recording, browser overlays draw at 30 fps, hidden previews stop drawing.
- The Transitions box fits the side column; the colour swatches wrap.
- The old widget studio is gone; the studio program is a third smaller.
- Faster start: the data folder's permissions are no longer rewritten at every start, last session's clip job waits a minute, and the clip and face workers start after the window (or at once when you go live or record). Each part now writes how long its start took.
- Scene music: right-click a scene > Music… to give it a mood and a level. It fades with the transition, keeps playing when the next scene has the same mood, and ducks under your voice. Off until you switch it on. Listen works only off air.
- Faster window: the studio starts alongside the engine, and dialogs you don't see at start are made the first time you open them.
- The studio and its preview windows sit under the pinned Ujwalam icon on the taskbar instead of opening a second button (may need a sign-out or an unpin and re-pin once).

## 0.1.0-alpha.34 — 2026-11-17

- Every sound gets a strip in the mixer, including the game capture's own sound. A sound that is not in the stream says so, with a one-click "Add to stream".
- "Add audio" in the mixer lists the sound on this PC: mics, the capture card's audio input, desktop and app sound, and layer sounds. Picking one adds it at once, also while live. The capture card's audio input is marked as the best choice for game sound (heard in the headphones at once). A sound you added can be removed with one click.
- Layers are back on the left, under the scenes, and get the larger share. The left column is wider so layer names fit. The right column holds the inspector, look, outputs, transitions, bots and stats, with its full height.
- The Go live window, the YouTube window with the presets and the other windows no longer open tiny.
- The status line at the bottom stays on one line; hover it to read the whole message.
- Opening Settings and switching the theme or the effects level no longer stalls the studio for seconds.

## 0.1.0-alpha.33 — 2026-11-16

- The main window now fits the screen size. On a small window the previews get the room; on a large one the scene list, layers and side panels get wider. The mixer grows and shrinks with the window height.
- On short windows (under 800 px tall) the stats cards get smaller, so the layers list keeps its space.
- The top bar no longer shifts when you go live: the LIVE and REC badges keep a fixed width and the bitrate shows 0.0 Mbps when offline.
- Notifications wait while the Go live window is open, so they never cover it.
- Greyed-out controls are easier to read.
- Text sizes, gaps and corners follow one set of sizes everywhere (main panels, settings, notifications and dialogs).

## 0.1.0-alpha.32 — 2026-11-16

- Go live asks how to go live on YouTube (when a YouTube output is on and you are signed in). Four ways:
  - Use an event on your channel: an upcoming or running event you made in YouTube Studio. Nothing new is made, and Ujwalam never deletes your event, even if the start fails.
  - Pick from your past streams: a new event copied from the one you pick.
  - New stream like the last one: a new event copied from your newest finished stream on that output.
  - Set up a new stream: type the title, description, privacy, category, tags and thumbnail. "Help me write it" fills them in with a local AI model (LM Studio's local server on this PC, started by you). It only works when nothing is live or recording; without the model it fills them from your last stream.
- Pick the quality per YouTube output (1080p, 1440p, 4K). Each quality uses its own stream key; a quality without a stored key is greyed with "Add the key". Your last choice is pre-selected. Twitch and Kick are not changed.
- Outputs panel as destination cards: "YouTube · landscape", "YouTube · portrait", "Twitch", "Kick", each with its quality, a plain status (Ready, Add the key, Live, Off, Problem) and a "Go live here" switch. Two cards that would send to the same stream are flagged. A line at the bottom says what Go live will start. The panel no longer jumps while saving. It is on by default.
- New look: "Ujwalam light" and "Ujwalam night" replace Soft light (if you used Soft, you get Ujwalam light). Softer shadows, clear focus rings, and the overlaps found in the old look are fixed (stats panel, drop-down boxes, the top bar on narrow windows, the portrait preview's buttons).

## 0.1.0-alpha.31 — 2026-11-15

- YouTube window: press "YouTube" next to Go live in the new studio window (switch "New studio window"). It is always on; there is no switch for it. Five tabs:
  - Presets: named YouTube setups. Each holds the size, bitrate and on/off of the landscape and portrait YouTube outputs, and their event templates. Pick one before a stream; during a stream it is used at the next Go live. A preset is refused while Twitch or Kick stream from the same encoder as YouTube, so they never change with it. Frame rate is not part of a preset.
  - Event: the template for each YouTube output, and its title, description, privacy, tags, category and thumbnail. While live, changes go to the running event. The toggle "New YouTube event at every Go live" (on) is here; it replaces the "YouTube events" switch of alpha.30.
  - Live: health, viewers and likes of the running YouTube events.
  - Chat: the live chat of each YouTube output, read every 15 seconds, and a box to send a message. Chat is only shown; it is never saved or logged.
  - Streams: your past and upcoming YouTube events, with End and Delete. An event that may be on air cannot be ended or deleted here; end the stream instead.
- If the YouTube sign-in cannot be read at Go live, nothing goes live and the reason is shown, instead of going live without the new event.

## 0.1.0-alpha.30 — 2026-11-15

- YouTube event for every stream, from a template (switch "YouTube events", off by default, Settings > Connections). Sign in with YouTube under Settings > Connections, then press "YouTube event" next to Go live and pick one of your earlier streams as the template for the landscape output and one for the portrait output. At each Go live, Ujwalam makes a new YouTube event for each YouTube output, copied from its template: title, description, privacy, category, tags, made-for-kids setting, latency, DVR and thumbnail, and links it to that output's stream key. If an event cannot be made, nothing goes live and the reason is shown. If the start fails, the new events are deleted again, unless an output may already be sending. Twitch and Kick are not changed.
- Stream settings without a restart: Save in Settings > Stream puts the new setup in use at once when nothing is live or recording. During a stream or recording they are used at the next Go live, and nothing running is stopped. If they cannot be put in use, Go live is refused with the reason instead of going live on the old setup.
- 2K and 4K YouTube without a separate switch: the bitrate follows the chosen size, and each quality keeps its own YouTube stream key.
- New studio window, switch "RareUI look" (Settings > Appearance, off by default): tabs and navigation in the new look.

## 0.1.0-alpha.29 — 2026-11-13

- YouTube in 2K: both YouTube outputs can now stream at 2560x1440 (landscape) and 1440x2560 (portrait) from the 1080p canvases, scaled up on the graphics card. Switch on "Stream above the canvas size" (Settings > Stream, FEATURES), then pick the sizes in Settings > Stream ("Output resolution", "Portrait output resolution"). Tested on this laptop at 24000 kbps each with Twitch and Kick at 1080p: no dropped or skipped frames. 4K portrait is in the list but too much for this laptop's video encoder together with the other outputs.
- Faster opening: the outputs and the replay buffer are now built once at the start instead of twice. About 2 seconds less from click to window.
- Realism scene (switch "Realism scene", off by default): right-click a scene, "Make realism scene". It makes a copy of the scene in which the game picture gets a film-style colour grade, light sharpening and a soft vignette. The original scene and the facecam stay as they are.
- New studio window (switch "New studio window"): Settings > Stream is now there too.

## 0.1.0-alpha.28 — 2026-11-13

- Ujwalam opens again. With Instagram Live switched on but no Instagram server address stored, the studio did not open at all. Now Instagram is left out of that start and the other outputs are ready. If the stream setup cannot be used at all, the studio opens for recording only, and the reason is in the log.
- The host watchdog, the audience counters and the reel length, hook and transition limits now ship in the install. They were missing from alpha.27, so the watchdog was off and the counters did not start.
- Settings > Stream > Edit output: Bitrate shows what the output really sends. Before, an output without its own bitrate showed 6000 kbps, although it streamed at the main canvas bitrate (17000 kbps on YouTube).
## 0.1.0-alpha.27 — 2026-11-13

- Battle Royale shorts: kills are read from your own on-screen kill text, knocks show in the short, and a chain of kills may be up to 30 s apart. After the stream, each live clip is cut again from the recording: every kill of its chain is in, and the running between kills is cut out.
- Montages no longer mix the victory or defeat screens of different matches. Montage story (switch "montage-story", off): a fast best-of intro, the title, then one match told in order.
- Reels open on one edited cover frame with a title, used as the thumbnail (switch "reel-thumbnail", on). New switches, all off: reel transitions (short cross fade between pieces), reel title card over a blurred copy, a calm music bed made on this PC, and self-learning, which shifts the mix of reel styles toward what gets more views, within limits.
- Auto-post now uploads every clip as a scheduled YouTube post from your clips folder, oldest first, placed around the posts already scheduled on your channel and never two at the same time (about 6 a day fit the free YouTube quota). Turn on "post-schedule" together with "auto-post": without it, clips wait and nothing is uploaded. Settings > Posting & growth > Auto-post sets the gap, how far ahead, and shows the next posting times. "Delete posted clips forever" (off) deletes a clip file only after YouTube has processed its upload.
- Growth numbers (switch "growth", off): your own YouTube view and subscriber numbers in a read-only window, stored on this PC.
- Host watchdog (switch "host-watchdog", off): if the video engine freezes (for example after a graphics driver reset), Ujwalam restarts it, keeps recording in a new file and, with stream recovery on, brings back the streams that were live.
- Clip renders that stall are retried on the processor, and a montage continues where it stopped.
- Settings: each group of switches has its own page with plain names, sorted A to Z.
- Soft theme (Settings > Appearance): raised plates, gentle shadows and a warm glow for what is on, with sharper text.

## 0.1.0-alpha.26 — 2026-11-11

- Mixer volume, mute and CUE (headphones) are now saved in your project and kept after a restart. Before, a lowered Game volume came back at full on the next start. Set it once again after installing.

## 0.1.0-alpha.25 — 2026-11-11

- Fixed a crash: switching an effect (for example a shadow) on or off for a layer that was selected in the preview could close the video engine. The same fault caused the crash on 10 November. The engine was also checked for related faults, and four were fixed: changing a layer's effects could flash the new copy for one frame; a scene could be deleted while a fade was still showing it; a stuck overlay helper could hang the engine; a shadow on a very small, large-source layer could make the layer disappear.
- Reels stay within the longest length per reel type (60 s by default) and are split into parts at clip boundaries when longer. Settings > Clips sets the shortest and longest length per type.
- Reel opening (switch "reel-hook", off): each reel opens on its best moment in the first seconds. Burned-in captions (switch "reel-captions", off) from local speech to text, shown only when the words are heard clearly.
- Instagram Live (switch "instagram-live", off; read when a stream starts): the vertical picture can go to Instagram with the key you paste for each broadcast.
- The desktop shortcut starts Ujwalam ready for a live stream; practice has its own shortcut.
## 0.1.0-alpha.24 — 2026-11-11

- Nine full studio themes (four reference designs and five reworked ones) using bundled open-licence fonts (Inter, Exo 2, Barlow). Switch "theme-components" (off) turns on their buttons, tabs, cards and edges; Settings > Appearance > Preview all components shows them. Every theme passes the contrast check.
- Live updates (switch "service-swap", off; read at start): the event core, the control page server and the studio window can be replaced with a new version while you stream, after one Apply now click on the control page. A video engine (host) update waits until every stream and recording has stopped, gets a trial start, and falls back to the previous version if it fails. Every update is checked against its release fingerprints and runs from a checked, read-only copy.
- Installing a new build while Ujwalam runs no longer touches the running files: the new version goes beside the old one and, with "service-swap" on, is handed to the running app's update queue. Otherwise it runs from the next start.
- Learning from your own streams (switches "learning-review" and "learning-train", off): after a stream, unsure reads can be confirmed with one click, and a game pack tune is proposed only when it reads held-out streams better; it never applies itself.
- Scene builder (switch "scene-builder", off, command line for now): build H and V scenes from a reference picture, make a theme from it, save a studio scene as a package, edit it, and make similar variants. Importing never changes existing scenes, layers or devices.
## 0.1.0-alpha.23 — 2026-11-10

- Live streams now record both the main (H) and vertical (V) picture, so kill montages and match reels are made in the background after a stream. The V recording uses the vertical stream's encoder; if YouTube V is off, only H is recorded.
- Record while live (Settings > Clips, on): Start stream also starts recording, and the recording stops when every stream has stopped. A recording you start or stop yourself is never taken over or stopped by this.
- Live clipping that cannot run (missing Python, ffmpeg, the clip worker, or a clipper that keeps crashing) now stops the readiness check with the reason and the fix. The task panel shows a "Live clips" row while live, and says why reels were not made.
- The layer selected in the layer list is the one that moves and resizes on the preview, even under other layers; a click on the preview selects that layer in the list. Dragging is smoother, and handles keep their size at 125 and 150 % display scaling.
- Settings > Preview: "Snap to preview edges and other layers", off by default. Hold Alt to turn snapping off for one drag.
- The app package now includes the posting rules, posting schedule, clip targets and stream options files (alpha.22 missed them, which caused the "auto-post-rules.json: file missing" notice). A build missing any data file the services read now fails.
- Task panel: a "Clear finished" button removes all done and failed tasks.
## 0.1.0-alpha.22 — 2026-11-10

- The background of the main and vertical scenes is now a blurred copy of your game capture, filling the whole screen behind every other layer. Your existing scenes are updated once when Ujwalam starts (a backup of the project is kept); your own layer moves and added layers stay as they are. If the capture card is not set up yet, the scene waits and is updated on a later start.

## 0.1.0-alpha.21 — 2026-11-10

- Correction: alpha.20 did not contain the round/match-end and match-type changes its notes listed (a merge mistake). They are in this build.
- Match reels show only your own kills: no loadout screen, no round intro and no teammate you watch after dying. A Search and Destroy reel that counts because of one strong round shows that round.
- Ujwalam also reads the match type from the post-match header, and counts your kills more accurately (one kill line is no longer counted twice in most cases).
- Match reel files say victory or defeat and your kill count.
- Impact-play reels (switch "impact-play-reels", off): a separate reel from the MVP animation through the impact-play camera to the results page, when the impact play is yours.
- Capture cards and cameras plugged in after Ujwalam starts: a layer for a device that is not connected is added and waits; it connects by itself when you plug the device in, and goes back to waiting when you unplug it. The stream and recording keep running.
- Layers: a delete button (asks first), move and resize on the preview with edge handles, crop with Alt+drag or the crop boxes, drag to reorder in the layer list. Every slider takes a click, a typed value and the arrow keys.
- Settings > Stream (switch "stream-settings", off): canvas, frame rate, encoder, bitrates and your stream outputs with add, edit and delete, checked against each platform's limits.
- Outputs panel in the main window (switch "outputs-panel", off): one switch per output; while live, "yes, on air" switches just that output on or off.
- Transitions per canvas with easing curves, "mirror main canvas" for the vertical canvas, and Force complete.
- Settings > Integrations (switch "integrations", off): Streamer.bot and Speaker.bot address, port and a test button; "Allow remote connections" stays off unless you turn it on, and then only on your home network with a pairing code.
- Settings > Connections (switch "platform-connect", off): sign in to YouTube or Twitch, or paste a stream key and server, from the app. Keys stay in Windows Credential Manager; only the last 4 characters are shown.
- Themes: four new themes, a theme picker in Settings, and a High performance mode for lighter memory use. Settings > Advanced no longer opens shifted.
- Data files (switches, posting rules, effect limits, themes) reload while Ujwalam runs; a broken file keeps the last good one.
## 0.1.0-alpha.20 — 2026-11-10

- Search and Destroy and other round modes are no longer split into one "match" per round: only the large end-of-match banner ends a match. Rounds are listed inside the match with your kills per round, so a multi-kill in one round can get a reel.
- Ujwalam reads the match type from the screen (Search and Destroy, Domination, Team Deathmatch, Control and more). When the screen does not show it clearly, the match type stays unknown instead of being guessed.
- Clips made right after a recorded stream now also include kill montages and match reels, after the short clips. A montage problem never stops the short clips.

## 0.1.0-alpha.19 — 2026-11-10

- Background work shows in a panel at the top right. Open it from the button next to My clips: each task shows its step in words, how far it is (for example frame 412 of 3148), time so far and time left, and a Stop button.
- Notices for started, finished and failed work appear at the top right.
- If a task makes no progress for 3 minutes, it says it may be stuck.

## 0.1.0-alpha.18 — 2026-11-10

- Clip making no longer freezes at the start. Since alpha.16 a clip job could stop before reading a single frame and stay at 0 % with no end.
- Finding matches in a recording now reads only the game area of your layout, so the top-3 and mode reading land in the right place.
- Your auto-post rules live in your own data folder and survive updates. `node services/posting/cli.mjs auto --init-rules` makes your copy. The Posts window shows where the file is and has a "Preview auto-post rules" button.
- A privacy policy for the YouTube sign-in (PRIVACY.md).
## 0.1.0-alpha.17 — 2026-11-10

- Windows behave normally: the studio opens on your main screen and comes to the front; preview windows also work with one screen and always fit fully on it.
- Match reels follow your rules: a win in the top 3, a loss in the top 2, more than 20 kills in Hardpoint, Domination or Control, more than 7 in TDM, a Search and Destroy win. A rule only counts when Ujwalam could read what it needs; each run's report says why a match did or did not get a reel.
- Captions start when the words start (they used to start up to several seconds early after a silence).
- Scheduled posting (switch "post-schedule"): a clip whose public time comes within 1 hour gets a new time about 1 h 15 min ahead, at least 1 hour from any other post; clips after it move to stay 6 hours apart. Nothing is scheduled more than 2 years ahead.
## 0.1.0-alpha.16 — 2026-11-09

- Nothing keeps running hidden after you close Ujwalam. Work still going (clip making, uploads) shows in the studio's task bar with time so far and time left, and a short notice when it starts.
- Closing the studio while work is still going asks: keep it running in the tray, stop it, or don't close. The tray icon lists each task with its progress and closes itself when everything is done.
- Closing never ends a stream or a recording. While live, "Stop all" in the tray stops only the background work.
- A clip job that is stopped ends completely, with every program it started.
- Scheduled YouTube posting (switch "post-schedule", off): each new clip is uploaded as private with a public time 6 hours after the last post already scheduled on your channel. If the channel can't be read in full, nothing uploads and the clip waits. An upload is cut off before its public time rather than going public early.
## 0.1.0-alpha.15 — 2026-11-09

- Ujwalam has its own icon: shortcuts, task bar, windows and the control page tab.
- Twitch works with a saved server address that starts with rtmp:// or rtmps:// (Kick stays rtmps://).
- YouTube sign-in opens the full Google page (it was cut short and Google refused it); the link is also printed to paste by hand.
- Commands run from the project folder use the installed app's settings and say which folder they used.
## 0.1.0-alpha.14 — 2026-11-09

- If clips can't be made on this PC (the clip maker's Python is missing; the download does not include Python), Ujwalam says so at start, in the control page and in the studio window, with how to fix it.
- "Ready to go live?" now fails when the sound state can't be read at all, instead of only warning.
## 0.1.0-alpha.13 — 2026-11-09

- Clips found while you play are at least 20 s long (they start a little earlier when needed).
- Auto-post preview (Posts > Preview auto-post rules, with the "posting" switch on; or `node services/posting/cli.mjs auto --preview`): shows what your rules would upload, where, with which title, and why anything is skipped. Nothing is uploaded.
## 0.1.0-alpha.12 — 2026-11-09

- Auto posting: if YouTube received a whole video but its answer got lost, the video is now recorded as posted instead of being retried and marked failed, and it is never uploaded twice.
- New end-to-end checks for auto posting and for clip making.
## 0.1.0-alpha.11 — 2026-11-09

- Live test kit (switch "live-test-kit", off): a strip under the top bar of the studio window says in plain words when game or mic sound is missing, when streams were restarted after a crash, and what happened to chat feedback.
- For the first 10 minutes live it reminds you to start your own Streamer.bot action "Ujwalam test stream" (it posts the feedback question and Speaker.bot reads the test announcement). Ujwalam itself never posts or speaks.
- When a stream ends, viewers' feedback replies are collected into your local feedback file, in the background.
- Fix: the readiness check and stream restart settings were missing from the install package.
## 0.1.0-alpha.10 — 2026-11-09

- Streams can restart by themselves after a host crash (switch "stream-recovery", off): only streams you started with "yes, on air", at most 2 times in 10 minutes, and never if you pressed Stop or End all.
- Stop and End all always win over a Start that is still on its way; if streams cannot be stopped, the control page says so.
- Clips made while you play use the same match filter as clips made after the recording.
## 0.1.0-alpha.9 — 2026-11-08

- Game audio no longer drops out at start (the capture card's sound could stop for a whole session). If game or mic sound stops anyway, Ujwalam says "Game audio missing" and restarts it.
- The studio window no longer closes when a clip job finishes. If it ever crashes, it writes a short report and reopens itself.
- The desktop shortcut starts Ujwalam with no black console window.
- "Ready to go live?" check before streaming (switch "readiness" in the control page): keys, disk, other streaming apps, bots, audio, GPU. "End all streams" stops every stream and keeps the recording.
- Kill montages use all your kills, streaks first; more kills make more montages.
- The clips folder holds only finished videos, one folder per day, with clear names (for example codm_montage_20261108-185824_kills-5_01_v.mp4). Working files stay in the app's own folder. Used live-clip saves are deleted after editing.
- Clips keep every sound track of the recording.
- Auto posting (switches "posting" and "auto-post", plus a rule): clips, montages and match reels upload privately to YouTube after a recording, never while live, with retries. The queue shows in the control page and Posts. Needs the YouTube sign-in set up first.
- Right-click a layer or scene to duplicate, rename or add; add new layers and scenes.
- Themes: Violet Night, Neon Arcade, Studio Light, Tactical, Retro Wave (Settings), with depth, shadow and glow.
- Welcome tour and hints, each with "don't show again"; bring them back in Settings > Help & tips.
- Face background removal and face tracking are built but stay switched off (switch "face-ai") until tested with your camera.
## 0.1.0-alpha.8 — 2026-11-08

- Look panel: select a layer to change its look: rounded corners, filters (sharpen, vignette, film grain, pixelate, posterize, black and white, sepia), camera (mirror, flip, circle or rounded shape with a ring), blend (opacity, add, multiply, screen and more, gradient fade) and shadow and glow. No hidden switch needed; while live, changes wait for Apply and "yes, on air".
- Settings has pages: Clips, Folders, Layer effects ("Show layer effects from the scene") and Advanced (animations: follow Windows, always or off; developer switches).
- Round Start stream, Record, Save clip and Mark moment buttons; slimmer toolbar with icons; scene cards.
- Task bar: long jobs (clip making, imports, uploads) show progress at the bottom without getting in the way, with a short note when they finish.
- Stats cards for the session, GPU, CPU and frame rate.
- Match filter: only matches where you are in the top 3 (or, once you set it, with enough kills) become clips. Matches it cannot read keep their clips.
- First stream scene follows your horizontal and vertical layouts (start once with a rebuild to pick it up).
## 0.1.0-alpha.7 — 2026-11-08

- New look: dark violet panels with rounded corners and a purple accent, after the reference video.
- The top bar fits the screen again (text was cut off at 125 % scaling). Rarely used tools are in the new More menu: Import Meld session, Feedback notes, Posts, Report a problem.
- The audio mixer sits under the previews as cards side by side. Frame stats and service status are in the bar at the bottom.
- The updater's `-ClipMaker` no longer saves clip choices you did not give.

## 0.1.0-alpha.6 — 2026-11-08

- New Settings in the studio window: what to do after you record and after you stream live: ask me each time, make clips when it stops, find the best moments while it runs and edit them into clips when it stops, or no clips.
- Choose where recordings are saved (used from the next start) and where finished clips are saved.
- The first start asks once how you want clips made. "Ask me each time" shows a "Make clips from it?" question after each recording, with "do this every time".
- New My clips button opens the clips folder. The Clips label says what is happening in plain words.
- The updater (`Install-Ujwalam.ps1`) can set the same choices and folders: `-ClipsWhenRecording`, `-ClipsWhenLive`, `-RecordingsFolder`, `-ClipsFolder`, `-ClipMaker`, and `-SettingsOnly` to change settings without installing.
- Clips are never made while you are live; a clip run that is going when a stream starts waits until it ends.

## 0.1.0-alpha.5 — 2026-11-08

- Fix: the H and V previews show inside the studio window; no separate preview windows open.
- One close: closing the studio window stops all of Ujwalam (previews, host, services). While live it first asks for the typed "yes, on air".
- Record works on a normal start: H and V are recorded to `.mkv` files (no stream target needed).
- New Save clip button (the last 60 s of H and V from the replay buffer) and Mark moment button (same as the marker hotkey, `Ctrl+Alt+Shift+M`).
- Shortcuts: "Ujwalam (alpha)" opens the capture devices (game capture, facecam, mic); the new "Ujwalam (alpha, LIVE)" also sets up the stream targets. Going live still needs Start stream and the typed "yes, on air".
- A start with devices rebuilds a scene project that was built without devices; the old one is kept in `projects/_old/`.

## 0.1.0-alpha.4 — 2026-11-08

- Fix: overlays and browser layers were off in alpha.3 when `ujwalam.json` named the `overlays` folder itself (as the 3 Nov install wrote it); that folder is now read as its parent.

## 0.1.0-alpha.3 — 2026-11-08

- The native studio window (Qt) opens by default instead of the browser; `Ujwalam.cmd --shell browser` opens the web control page. Closing the window does not stop a stream.
- Studio window: scenes and layers, an add-layer window, inspector, mixer with mute, CUE, volume and track routing, preview editing with snapping to other layers, undo/redo, feature flags. Panels behind flags stay off until switched on in the flags panel.
- Mixer track routing per sound (flag `mixer-routing`, off), saved to the project.

## 0.1.0-alpha.2 — 2026-11-03

- Live plan: YouTube H 1080p60 at 17 Mbps; YouTube V direct; one shared 1080p60 6000 kbps rung for Twitch and Kick.
- Live-test mode: `--sinks` picks destinations; `--twitch-bandwidth-test` sends Twitch a bandwidth test (received, not broadcast); `--test-stream-minutes N` and `--test-sink-minutes kick=2` arm a guard that stops every output on a failure, a destination not live for more than 10 s, or lost frames above 1 % (after 30 s) or 3 % in any 10 s window. A report is written to `logs/live-test-*.txt`.
- Scene presets: a brand file that is a video plays as a looping layer; a brand file missing from the profile becomes a transparent placeholder instead of failing the scene.
- Post-stream clip pipeline (flag `clip-pipeline`, off): not part of the live path.
## 0.1.0-alpha.1 — 2026-11-05

First Alpha 0 build: a portable zip with `Install-Ujwalam.ps1` (no admin).

- Control page on 127.0.0.1 plus native H and V preview windows (D132); one "Default" scene from the Default H and V presets.
- Real outputs with keys from Windows Credential Manager, only with `--live`; streaming starts only after the typed "yes, on air" on the control page.
- Recording to `.mkv` (crash-safe container).
- Replay buffer H and V (30 s), hotkeys: panic `Ctrl+Alt+P`, feedback `Ctrl+Alt+F`, marker `Ctrl+Alt+Shift+M`.
- Feedback captures and the post-stream feedback form; feature flags (all off).
- New in this build: crash recovery (the launcher restarts the host after an unexpected exit, at most 3 times in 5 minutes, reloads the project, starts a new recording file if one was running, and writes a marker); diagnostics bundle (`Ujwalam.cmd diag`, redacted); install, rollback and version folders under `%LOCALAPPDATA%\Ujwalam`.
- Needs: Windows 11 x64, Node.js 22.13 or newer on PATH, Microsoft Visual C++ 2015-2022 x64 runtime. The installer checks both and stops if one is missing; it installs nothing.
- Known limits: streams are not restarted automatically after a host crash (start them again from the control page); voice notes are not done; real hotkey key presses are UNVERIFIED.
