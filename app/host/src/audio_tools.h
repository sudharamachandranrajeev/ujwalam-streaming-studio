// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: mixer audio tools (plan 2026-11-18-audio-mixer-music, AU1 and AU2).
//
// AU1 extra sounds, built by model.cpp as separate global sources like a device's:
//   app      one app's sound: wasapi_process_output_capture matched by program file name only (window priority
//            "executable"); a window title is never stored or sent (titles can hold private names).
//   playback an audio file (ffmpeg_source, looping) or a folder played in turn (a playlist: the next file on
//            media_ended, through obs_source_update on the same source; never a rebuild).
//
// AU2 strip tools: libobs audio filters on the source a project audio entry is bound to, named "ujw:tool:<kind>",
// in the fixed order suppress -> gate -> eq -> gain -> compressor -> limiter. apply_filters() changes them in place
// (obs_source_update / enabled / filter add or remove): the source is never rebuilt, its audio never stops.
// Ranges: services/project/audio-filters.mjs (the filters' obs_properties limits, OBS 32.1.2).
//
// AU3 duck: tool "duck" is a compressor_filter whose sidechain_source is the libobs name of another project sound,
// found through a DuckResolve from the sound's audio source id. While that sound is not there (or is a layer's sound,
// whose private source has no name to find), the filter is disabled and keeps the plain reason: compressor_filter
// would otherwise compress the strip on its own signal. refresh_duck() re-finds the sound after a mixer change.
#pragma once

#include "json.h"

#include <obs.h>

#include <functional>
#include <string>
#include <vector>

namespace audio_tools {

// Throws rpc::Error(INVALID_PARAMS) for a malformed `filters` value.
void check_filters(const json::Value &f, const std::string &what);
// AU3: the libobs name of the source bound to project sound `audio` (to use as a sidechain), or "" with a plain
// reason in `why`.
using DuckResolve = std::function<std::string(const std::string &audio, std::string &why)>;

// Makes the source's tool filters match `f` (null or missing = none). Never recreates the source. Runs the filter
// list changes on the graphics thread and waits for them; only changed settings are sent to a filter.
void apply_filters(obs_source_t *src, const json::Value &f, const DuckResolve &resolve);
// AU3: finds the duck tool's sound again (after the mixer changed). Runs on the graphics thread (where
// compressor_filter binds its sidechain) and waits. A duck whose sidechain changes is switched off first and switched
// on again only after compressor_filter has bound the new one (two video ticks later).
void refresh_duck(obs_source_t *src, const DuckResolve &resolve);
// AU3: before the source named `name` is retired (removed, or parked for a new one of the same name): a duck on `src`
// that uses it is switched off and let go of it ("none"), on the graphics thread. refresh_duck binds it again.
void unbind_duck(obs_source_t *src, const std::string &name);
// Ends the duck binding work (before obs_shutdown).
void shutdown_ducks();
// AU3: {on (the user's switch), active (its sound is found: ducking, or bound within two ticks), source, reason
// ("" when active)}, or null without a duck tool.
json::Value duck_status(obs_source_t *src);
// The tool filters on a source as {kind: {on, settings...}} (for tests and status).
json::Value read_filters(obs_source_t *src);

// AU1 app sound. check_exe throws for a bad {exe}; the result is the exe name.
std::string check_exe(const json::Value &app, const std::string &what);
json::Value app_settings(const std::string &exe);
// Running apps with a visible top-level window: [{exe, sound, ambiguous}] (exe names only, sorted, unique; sound =
// has an active audio session on the default render device; ambiguous = two different programs of this name run).
// Only this user's programs in this session. available = false when the system has no app capture.
json::Value list_apps();
// Two different programs (paths) named `exe` run now: OBS matches by name only, so either could go on air.
bool app_ambiguous(const std::string &exe);

// AU1 playback.
// Audio files in the folder, by name, at most 500, as real paths; a link whose target is not inside `root` (the
// media folder) is left out.
std::vector<std::string> folder_playlist(const std::string &dir, const std::string &root);
json::Value playback_settings(const std::string &file, bool loop);
// Plays `files` in turn on `src` (a playlist with more than one file): the next one on media_ended; after the last,
// the first again when loop. A source with one file needs nothing (ffmpeg_source loops it). Each file is checked
// against `root` again when it is opened. After one full pass in which no file gave audio, the playlist stops
// ("unavailable").
void attach_playlist(obs_source_t *src, const std::vector<std::string> &files, bool loop, const std::string &root);
// {files, at, state: "playing" | "unavailable"} of the source's playlist, or null.
json::Value playlist_status(obs_source_t *src);
// Stops the playlist thread (before obs_shutdown).
void shutdown_playlists();

// --test-hooks: peak and RMS (dBFS, channel 0) of the source's audio after its filters, over `ms` after `skip_ms`.
// bin_ms > 0 adds bins (peak dBFS per bin_ms) and startMs (the audio clock of the first frame). Muted audio counts as
// silence.
json::Value measure(obs_source_t *src, uint32_t skip_ms, uint32_t ms, uint32_t bin_ms = 0);

} // namespace audio_tools
