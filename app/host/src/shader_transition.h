// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: shader scene transitions (2026-11-28). One libobs transition type, ujw_shader_transition, draws the
// switch with one of the styles below (data/effects/ujw_tr_*.effect, embedded at build time). Studio starts it in
// OBS_TRANSITION_MODE_MANUAL and the easer (transition_ease.h) drives its time, so every style takes an easing curve.
// Settings: style (a project type id below), dir_x/dir_y (motionSwipe: where the old scene goes, uv units).
// A style whose shader does not compile makes create fail (the source comes back invalid): Studio then runs a fade
// instead, never a black frame. Audio crossfades like the fade transition.
#pragma once

#include <string>

namespace shadertr {

extern const char *const ID; // "ujw_shader_transition"

// True when type is one of the shader styles: blurZoom, lightLeak, motionSwipe, glitch, heartbeat, pop.
bool is_style(const std::string &type);
// The style ids in the order transitions.types lists them.
const char *const *styles(int *count);
void register_type();

} // namespace shadertr
