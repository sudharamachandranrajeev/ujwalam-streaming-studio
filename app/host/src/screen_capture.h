// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: screen and window capture layers (D390 proposed). Project layer types "screen" (libobs monitor_capture,
// the desktop duplicator on D3D11) and "window" (libobs window_capture) come from the win-capture module, which the host
// loads only with --allow-screen-capture (obs_runtime.h).
//
// capture.listTargets -> { displays: [{id, name, width, height}], windows: [{id, title, exe}] }
//   displays: id = the monitor_id value (the display's device interface path), name = OBS's label
//             "<monitor name>: <w>x<h> @ <x>,<y>" (+ " (Primary Monitor)"), width/height parsed from that label (0 when
//             it has none).
//   windows:  id = the OBS window spec "title:class:exe" (":" and "#" inside a part encoded as #3A / #22, as OBS
//             does), title and exe of the window (minimised windows are left out, as in OBS).
// Read from the property lists libobs builds for each source type (obs_get_source_properties: no source is created,
// nothing is captured). Window titles are personal data: never logged at info level, never written to a file.
#pragma once

#include "json.h"

namespace screencap {

// True when both monitor_capture and window_capture are registered (win-capture loaded).
bool available();
// The lists above. Throws rpc::Error(UNAVAILABLE) when the module is not loaded.
json::Value list_targets();
// A window spec as stored in a project layer (and as OBS stores it): 1..1024 characters, no control characters, three
// ":"-separated parts, the last (exe) not empty.
bool valid_window_spec(const std::string &s);
// match "title" | "class" | "exe" -> OBS window_priority (WINDOW_PRIORITY_TITLE 1, CLASS 0, EXE 2); -1 otherwise.
int window_priority(const std::string &match);

} // namespace screencap
