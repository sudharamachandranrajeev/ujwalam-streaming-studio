// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: shader scene transitions. See shader_transition.h.
#include "shader_transition.h"
#include "log.h"
#include "ujw_effects.h" // generated: ujw_tr_*_effect

#include <obs.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <mutex>

namespace shadertr {

const char *const ID = "ujw_shader_transition";

namespace {

struct Style {
	const char *id;
	const char *src;
	const char *file;
};

const Style STYLES[] = {
	{"blurZoom", ujw_tr_blur_zoom_effect, "ujw_tr_blur_zoom.effect"},
	{"lightLeak", ujw_tr_light_leak_effect, "ujw_tr_light_leak.effect"},
	{"motionSwipe", ujw_tr_motion_swipe_effect, "ujw_tr_motion_swipe.effect"},
	{"glitch", ujw_tr_glitch_effect, "ujw_tr_glitch.effect"},
	{"heartbeat", ujw_tr_heartbeat_effect, "ujw_tr_heartbeat.effect"},
	{"pop", ujw_tr_pop_effect, "ujw_tr_pop.effect"},
};
const char *const STYLE_IDS[] = {"blurZoom", "lightLeak", "motionSwipe", "glitch", "heartbeat", "pop"};

const Style *find_style(const char *id)
{
	for (auto &s : STYLES)
		if (id && std::strcmp(s.id, id) == 0)
			return &s;
	return nullptr;
}

struct Tr {
	obs_source_t *self = nullptr;
	gs_effect_t *effect = nullptr;
	gs_eparam_t *p_a = nullptr, *p_b = nullptr, *p_t = nullptr, *p_size = nullptr, *p_dir = nullptr;
	float dir_x = 1.0f, dir_y = 0.0f;
};

const char *tr_name(void *)
{
	return "Ujwalam shader transition";
}

void *tr_create(obs_data_t *s, obs_source_t *src)
{
	const char *id = obs_data_get_string(s, "style");
	const Style *st = find_style(id);
	if (!st) {
		hlog::warn("shader transition: unknown style %s", id ? id : "(none)");
		return nullptr;
	}
	char *err = nullptr;
	obs_enter_graphics();
	gs_effect_t *e = gs_effect_create(st->src, st->file, &err);
	obs_leave_graphics();
	if (!e) {
		// nullptr: libobs keeps an invalid source; Studio sees it (obs_obj_invalid) and falls back to a fade
		hlog::error("transition shader %s did not compile: %s", st->file, err ? err : "(no message)");
		bfree(err);
		return nullptr;
	}
	bfree(err);
	auto *t = new Tr();
	t->self = src;
	t->effect = e;
	t->p_a = gs_effect_get_param_by_name(e, "tex_a");
	t->p_b = gs_effect_get_param_by_name(e, "tex_b");
	t->p_t = gs_effect_get_param_by_name(e, "t");
	t->p_size = gs_effect_get_param_by_name(e, "size");
	t->p_dir = gs_effect_get_param_by_name(e, "dir");
	t->dir_x = (float)std::clamp(obs_data_get_double(s, "dir_x"), -1.0, 1.0);
	t->dir_y = (float)std::clamp(obs_data_get_double(s, "dir_y"), -1.0, 1.0);
	return t;
}

void tr_destroy(void *data)
{
	auto *t = static_cast<Tr *>(data);
	obs_enter_graphics();
	gs_effect_destroy(t->effect);
	obs_leave_graphics();
	delete t;
}

void tr_defaults(obs_data_t *s)
{
	obs_data_set_default_double(s, "dir_x", -1.0);
	obs_data_set_default_double(s, "dir_y", 0.0);
}

// One texture only (the first scene of a canvas, or a scene with nothing in it): draw it as it is, never black.
void draw_plain(gs_texture_t *tex, uint32_t cx, uint32_t cy)
{
	gs_effect_t *def = obs_get_base_effect(OBS_EFFECT_DEFAULT);
	gs_eparam_t *img = gs_effect_get_param_by_name(def, "image");
	gs_effect_set_texture_srgb(img, tex);
	while (gs_effect_loop(def, "Draw"))
		gs_draw_sprite(tex, 0, cx, cy);
}

void tr_callback(void *data, gs_texture_t *a, gs_texture_t *b, float time, uint32_t cx, uint32_t cy)
{
	auto *t = static_cast<Tr *>(data);
	if (!a && !b)
		return;
	const bool previous = gs_framebuffer_srgb_enabled();
	gs_enable_framebuffer_srgb(true);
	if (!a || !b) {
		draw_plain(a ? a : b, cx, cy);
	} else {
		// as obs-transitions transition-fade.c: nonlinear values in an sRGB canvas
		if (gs_get_color_space() == GS_CS_SRGB) {
			gs_effect_set_texture(t->p_a, a);
			gs_effect_set_texture(t->p_b, b);
		} else {
			gs_effect_set_texture_srgb(t->p_a, a);
			gs_effect_set_texture_srgb(t->p_b, b);
		}
		gs_effect_set_float(t->p_t, std::clamp(time, 0.0f, 1.0f));
		if (t->p_size) {
			struct vec2 v;
			vec2_set(&v, (float)cx, (float)cy);
			gs_effect_set_vec2(t->p_size, &v);
		}
		if (t->p_dir) {
			struct vec2 v;
			vec2_set(&v, t->dir_x, t->dir_y);
			gs_effect_set_vec2(t->p_dir, &v);
		}
		while (gs_effect_loop(t->effect, "Draw"))
			gs_draw_sprite(nullptr, 0, cx, cy);
	}
	gs_enable_framebuffer_srgb(previous);
}

void tr_render(void *data, gs_effect_t *)
{
	auto *t = static_cast<Tr *>(data);
	const bool previous = gs_set_linear_srgb(true);
	obs_transition_video_render2(t->self, tr_callback, nullptr);
	gs_set_linear_srgb(previous);
}

// Equal-power audio crossfade: no dip in loudness halfway (the fade transition's linear one dips about 3 dB).
float mix_a(void *, float t)
{
	return std::cos(std::clamp(t, 0.0f, 1.0f) * 1.5707963f);
}

float mix_b(void *, float t)
{
	return std::sin(std::clamp(t, 0.0f, 1.0f) * 1.5707963f);
}

bool tr_audio(void *data, uint64_t *ts_out, struct obs_source_audio_mix *audio, uint32_t mixers, size_t channels,
	      size_t sample_rate)
{
	auto *t = static_cast<Tr *>(data);
	return obs_transition_audio_render(t->self, ts_out, audio, mixers, channels, sample_rate, mix_a, mix_b);
}

enum gs_color_space tr_space(void *data, size_t count, const enum gs_color_space *preferred)
{
	auto *t = static_cast<Tr *>(data);
	const enum gs_color_space ts = obs_transition_video_get_color_space(t->self);
	enum gs_color_space space = ts;
	for (size_t i = 0; i < count; ++i) {
		space = preferred[i];
		if (space == ts)
			break;
	}
	return space;
}

} // namespace

bool is_style(const std::string &type)
{
	return find_style(type.c_str()) != nullptr;
}

const char *const *styles(int *count)
{
	*count = (int)(sizeof(STYLE_IDS) / sizeof(STYLE_IDS[0]));
	return STYLE_IDS;
}

void register_type()
{
	struct obs_source_info i = {};
	i.id = ID;
	i.type = OBS_SOURCE_TYPE_TRANSITION;
	i.get_name = tr_name;
	i.create = tr_create;
	i.destroy = tr_destroy;
	i.get_defaults = tr_defaults;
	i.video_render = tr_render;
	i.audio_render = tr_audio;
	i.video_get_color_space = tr_space;
	obs_register_source(&i);
	hlog::info("transition source type registered: %s", ID);
}

} // namespace shadertr
