// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: scene music (MU2, plan 2026-11-18-audio-mixer-music).
//
// The project's one Music strip (audio.sources[] { music: {} }) is an ffmpeg_source built like an AU1 playback sound,
// with the AU2/AU3 strip tools on it (so "Duck music under my voice" works on it). Its bed follows the active scene's
// music { on, mood, volumeDb }: the file <bases.music>/<mood>.wav from the MU1 library (made off air, never on the
// live path). A missing bed plays nothing and keeps a plain reason.
//
// Level: one host filter "ujw_music_level" named "ujw:music:level" sits after the tool filters in the array, so libobs
// runs it first (filters run from the last array entry to the first): fades and the scene's volumeDb happen before the
// duck and the limiter. It is added on the graphics thread (D399: the 32.1.2 video tick walks the filter array without
// its lock). It ramps its gain sample by sample (ffmpeg_source hands audio over in blocks of about 85 ms, so a
// gain_filter changed from outside would step once per block). The music thread only stores {to, ms, seq} in atomics;
// no settings update, no list change.
//
// Fades run on one music thread, never on the video or RPC thread. A scene switch fades out until the scene changes
// (fade: half the duration; stinger: its switch point) and in after it; a cut uses kCutFadeMs so there is no click.
// The same bed in the next scene keeps playing and only its level moves. One strip has one source, so a change of bed
// is a fade out then in (not an overlap).
#pragma once

#include "json.h"

#include <obs.h>

#include <cstdint>
#include <string>

namespace scene_music {

constexpr uint32_t kCutFadeMs = 50;  // a cut: 25 ms out, 25 ms in
constexpr uint32_t kEditFadeMs = 300; // a change of the active scene's music settings
constexpr double kSilentDb = -100;

bool mood_ok(const std::string &mood);

struct Target {
	std::string file;   // absolute bed file; empty = silence
	double db = 0;      // scene level
	std::string mood;   // for the status
	std::string reason; // plain words when nothing plays ("" when it plays)
	std::string scene;
};

// The music strip's source (one per project). Adds the level filter at silence on the graphics thread and waits.
void attach(obs_source_t *src);
// Before the strip's source goes (project reload, strip removed): stops the fades and lets the source go.
void detach();
bool attached(obs_source_t *src);
// Plays `t`: out_ms of fade before the bed changes, in_ms after it. A newer cue replaces one still fading.
void cue(const Target &t, uint32_t out_ms, uint32_t in_ms);
// {attached, scene, mood, file (name only), playing, levelDb, reason, fades (count), lastFade {outMs, inMs}}
json::Value status();
// Waits until no fade is running (tests); false after timeout_ms.
bool wait_idle(uint32_t timeout_ms);
// Ends the music thread (before obs_shutdown).
// Listen (MU2): plays `file` once on the monitoring device only (in no track), off air only: refused while any
// output holds the gate or is active. monitor false opens no audio device (tests). false + why when refused.
bool preview_start(const std::string &file, const std::string &mood, bool monitor, std::string &why);
void preview_stop();
std::string previewing(); // the mood being listened to, "" none
// The on-air gate: an output that may go on air holds it (a sink while wanted, a replay/probe start while starting).
// Taking it silences a preview at once (atomics only: never waits on file or device work).
void hold(bool on);
struct Hold {
	Hold() { hold(true); }
	~Hold() { hold(false); }
	Hold(const Hold &) = delete;
	Hold &operator=(const Hold &) = delete;
};
void test_preview_delay(uint32_t ms); // --test-hooks: a slow preview open

void shutdown();

// The bed file of `mood` in the library folder `dir`: "" with a plain reason when it is not there.
std::string bed_file(const std::string &dir, const std::string &mood, std::string &why);

} // namespace scene_music
