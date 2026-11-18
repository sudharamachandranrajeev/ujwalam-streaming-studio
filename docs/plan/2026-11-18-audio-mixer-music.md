# 2026-11-18 Device re-detection, mixer fixes, audio tools, scene music, performance

User report and request (2026-11-18): "The audio mixer has a lot of bugs, and the whole app has layer and capture
issues: if a layer is not detected at start it fails to detect afterwards. Check the whole app code to see if it is
bloated; the app is getting too laggy and uses a lot of resources. The audio should at least have a basic add audio
track; add more audio layer mixing and editing features. Add in-app music for different scenes and transitions: coming
to the lobby, in the lobby, in a match." The user asked to be interviewed. Answers (same day):

- Mixer bugs seen: strips missing or doubled; meters wrong or dead.
- Music source: local AI music. Procedural now (the RP3 maker, extended with moods), ACE-Step 1.5 later (needs the
  install yes: Python 3.12 venv, about 5 GB). Music is made off air only, then played from files.
- Trigger: scene switch. Each scene has a mood; switching scene crossfades with the transition.
- Moods: starting soon = hype synthwave, lobby / just chatting = chill lofi, in match = low dark ambient that ducks under
  the voice, BRB = lofi, ending = calm outro. Each scene's mood, volume and on/off can be changed in the app.
- Audio tools: mic cleanup (noise suppression, gate, compressor/limiter, presets like "Clean voice"), ducking (music and
  game drop while the user talks), EQ and gain per strip. Add audio track is included in any case.
- Logs: read access to the installed app's logs granted (read only).

Requested features ship on by default with visible toggles (user, 2026-11-15).

## Findings so far

- Code review (2026-11-18): capture hot-plug works at host level, but (1) the alpha project build turns a role missing
  at start into a permanent transparent placeholder, (2) mic/desktop audio devices missing at load are dropped for good,
  (3) a capture that gives no picture stops retrying after about 75 s, (4) monitoring output, failed browser pages and
  missing media are never retried, (5) the studio does not reload scenes/layers/mixer after a host restart. Mixer: list
  not refreshed on device changes, strips rebuilt on every load, slider range -60..0 while the project allows +12, live
  only volume on layer sounds, game sound can be added twice, meters sampled without peak hold through a heavy 4 Hz call.
- Live log 2026-11-18 (stream 19:21–20:35 UTC): YouTube H dropped once at 20:23 and reconnected in 2.5 s; the capture
  card's sound restarted 183 times ("audio is lagging at max audio buffering"), mostly 20:28–20:39, the same window as
  agent builds and tests on the laptop (cause UNVERIFIED). Since then agents run `tools/live-check.mjs` first.

## Work

| Id | What | Done when | Owner |
|---|---|---|---|
| DV1 | Re-detect: placeholder roles rebind, audio devices re-matched, slow capture retry, `devices.rescan` + "Try again", monitoring / browser / media retry, studio reload after host restart | Node + QML probe tests; host tests on real devices; one stream with a device plugged in late | Opus |
| MX1 | Mixer fixes: stable strips, refresh on device change, -60..+12 dB, persisted volume, no doubled game sound, peak-hold meters on a light levels call | QML probe + route tests | Opus |
| AU1 | Add audio track: mic/line, desktop, one app's sound, an audio file or playlist | Route + host tests | after MX1 |
| AU2 | Per-strip tools: noise suppression, gate, compressor, limiter, gain, 3-band EQ (libobs filters), presets ("Clean voice") | Host recording measures each filter's effect | after MX1 |
| AU3 | Ducking: music and game drop while the mic talks (compressor sidechain) | Loopback measurement of the dip | after AU2 |
| MU1 | Music maker moods (synthwave, lofi, dark ambient, calm outro) on the RP3 procedural maker; library made off air | Generator tests, loudness target | after the transition merge |
| MU2 | Scene music: per-scene mood/volume/on, music strip in the mixer, crossfade with the transition, ducking under the voice in match | Host + route + QML tests; one real stream | after AU3 |
| PF1 | Performance: ranked causes from the code audit, measured off air, fixes one at a time with before/after numbers | Render lag and CPU before/after | after the audit |
