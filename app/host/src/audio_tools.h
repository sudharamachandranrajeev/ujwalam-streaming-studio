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
#pragma once

#include "json.h"

#include <obs.h>

#include <string>
#include <vector>

namespace audio_tools {

// Throws rpc::Error(INVALID_PARAMS) for a malformed `filters` value.
void check_filters(const json::Value &f, const std::string &what);
// Makes the source's tool filters match `f` (null or missing = none). Never recreates the source.
void apply_filters(obs_source_t *src, const json::Value &f);
// The tool filters on a source as {kind: {on, settings...}} (for tests and status).
json::Value read_filters(obs_source_t *src);

// AU1 app sound. check_exe throws for a bad {exe}; the result is the exe name.
std::string check_exe(const json::Value &app, const std::string &what);
json::Value app_settings(const std::string &exe);
// Running apps with a visible top-level window: [{exe, sound}] (exe names only, sorted, unique; sound = has an
// active audio session on the default render device). available = false when the system has no app capture.
json::Value list_apps();

// AU1 playback.
std::vector<std::string> folder_playlist(const std::string &dir); // audio files in the folder, by name; at most 500
json::Value playback_settings(const std::string &file, bool loop);
// Plays `files` in turn on `src` (a playlist with more than one file): the next one on media_ended; after the last,
// the first again when loop. A source with one file needs nothing (ffmpeg_source loops it).
void attach_playlist(obs_source_t *src, const std::vector<std::string> &files, bool loop);

// --test-hooks: peak and RMS (dBFS, channel 0) of the source's audio after its filters, over `ms` after `skip_ms`.
json::Value measure(obs_source_t *src, uint32_t skip_ms, uint32_t ms);

} // namespace audio_tools
