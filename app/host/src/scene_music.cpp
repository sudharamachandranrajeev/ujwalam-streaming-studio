// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: scene music (MU2). See scene_music.h.
#include "scene_music.h"
#include "audio_tools.h"
#include "log.h"

#include <media-io/audio-io.h>
#include <util/platform.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <filesystem>
#include <mutex>
#include <regex>
#include <thread>

namespace fs = std::filesystem;

namespace scene_music {

namespace {

constexpr const char *kLevelFilter = "ujw:music:level";
constexpr uint32_t kStepMs = 5;

struct State {
	std::mutex m;
	std::condition_variable cv;
	std::thread th;
	bool stop = false;
	obs_weak_source_t *weak = nullptr; // the strip
	obs_source_t *level = nullptr;      // the level filter (a reference)
	// the next cue (guarded by m)
	bool pending = false;
	Target want;
	uint32_t want_out = 0, want_in = 0;
	bool busy = false;
	uint64_t gen = 0; // a new strip (attach / detach): a fade of the old one stops and writes nothing
	// what plays (written by the music thread under m)
	Target now;
	std::string file; // the bed opened on the source ("" none)
	bool playing = false;
	double level_mul = 0;
	uint64_t fades = 0;
	uint32_t last_out = 0, last_in = 0;
};
State &st()
{
	static State s;
	return s;
}

double mul_of(double db)
{
	return db <= kSilentDb ? 0.0 : std::pow(10.0, db / 20.0);
}
double db_of(double mul)
{
	return mul <= 0.00001 ? kSilentDb : 20.0 * std::log10(mul);
}

// The level filter "ujw_music_level": a gain that moves along a straight line (in amplitude) sample by sample, so a
// fade is smooth inside ffmpeg_source's audio blocks (about 85 ms each; a gain_filter would step once per block). The
// music thread sets a ramp {to, ms} and a new seq; the audio thread starts it from where the gain is at its next block.
struct Level {
	std::atomic<float> to{0.0f};
	std::atomic<uint32_t> ms{0};
	std::atomic<uint32_t> seq{0};
	std::atomic<uint32_t> done{0}; // the seq whose ramp has ended
	std::atomic<float> now{0.0f};  // the gain at the end of the last block
	// audio thread only
	uint32_t at_seq = 0;
	float from = 0.0f, tgt = 0.0f, cur = 0.0f;
	uint64_t n = 0, total = 0;
};

const char *level_name(void *)
{
	return "Ujwalam scene music level";
}
void *level_create(obs_data_t *, obs_source_t *)
{
	return new Level();
}
void level_destroy(void *p)
{
	delete static_cast<Level *>(p);
}
struct obs_audio_data *level_audio(void *p, struct obs_audio_data *a)
{
	auto *l = static_cast<Level *>(p);
	const uint32_t seq = l->seq.load(std::memory_order_acquire);
	if (seq != l->at_seq) {
		l->at_seq = seq;
		l->from = l->cur;
		l->tgt = l->to.load();
		const uint32_t rate = audio_output_get_sample_rate(obs_get_audio());
		l->total = (uint64_t)l->ms.load() * rate / 1000;
		l->n = 0;
	}
	const size_t ch = audio_output_get_channels(obs_get_audio());
	for (uint32_t i = 0; i < a->frames; i++) {
		if (l->n < l->total) {
			l->cur = l->from + (l->tgt - l->from) * (float)((double)l->n / (double)l->total);
			l->n++;
		} else {
			l->cur = l->tgt;
		}
		for (size_t c = 0; c < ch && c < MAX_AV_PLANES; c++)
			if (a->data[c])
				reinterpret_cast<float *>(a->data[c])[i] *= l->cur;
	}
	l->now.store(l->cur);
	if (l->n >= l->total)
		l->done.store(l->at_seq, std::memory_order_release);
	return a;
}

void register_level_type()
{
	static bool done = false;
	if (done)
		return;
	done = true;
	obs_source_info i = {};
	i.id = "ujw_music_level";
	i.type = OBS_SOURCE_TYPE_FILTER;
	i.output_flags = OBS_SOURCE_AUDIO | OBS_SOURCE_CAP_DISABLED;
	i.get_name = level_name;
	i.create = level_create;
	i.destroy = level_destroy;
	i.filter_audio = level_audio;
	obs_register_source(&i);
}

// Moves the level to `to` (amplitude) over ms and waits until the audio thread has finished that ramp (it starts at
// the next block). false: a newer cue, a new strip or stop came first (the gain then stays where it got to).
bool ramp(State &s, obs_source_t *fl, double to, uint32_t ms, uint64_t g)
{
	auto *l = static_cast<Level *>(obs_obj_get_data(fl));
	if (!l)
		return false;
	l->to.store((float)to);
	l->ms.store(ms);
	const uint32_t seq = l->seq.fetch_add(1) + 1;
	const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms + 1000);
	std::unique_lock<std::mutex> lk(s.m);
	for (;;) {
		if (s.gen != g)
			return false;
		s.level_mul = l->now.load();
		if (l->done.load(std::memory_order_acquire) == seq) {
			s.level_mul = to;
			return true;
		}
		if (std::chrono::steady_clock::now() > until) { // no audio came through in time (nothing decoded)
			s.level_mul = to;
			return true;
		}
		if (s.cv.wait_for(lk, std::chrono::milliseconds(kStepMs), [&] { return s.pending || s.stop || s.gen != g; }))
			return false;
	}
}

void open_bed(obs_source_t *src, const std::string &file, const std::string &opened)
{
	if (file == opened) { // ffmpeg_source does not reopen an unchanged local_file
		obs_source_media_restart(src);
		return;
	}
	const json::Value st = audio_tools::playback_settings(file, true);
	obs_data_t *d = obs_data_create_from_json(st.dump().c_str());
	obs_source_update(src, d);
	obs_data_release(d);
}

void run()
{
	State &s = st();
	for (;;) {
		Target t;
		uint32_t out = 0, in = 0;
		uint64_t g = 0;
		obs_source_t *src = nullptr, *fl = nullptr;
		{
			std::unique_lock<std::mutex> lk(s.m);
			s.busy = false;
			s.cv.notify_all();
			s.cv.wait(lk, [&] { return s.pending || s.stop; });
			if (s.stop)
				return;
			s.pending = false;
			s.busy = true;
			t = s.want;
			g = s.gen;
			out = s.want_out;
			in = s.want_in;
			src = s.weak ? obs_weak_source_get_source(s.weak) : nullptr;
			if (s.level)
				fl = obs_source_get_ref(s.level);
			s.fades++;
			s.last_out = out;
			s.last_in = in;
			s.now = t;
		}
		if (!src || !fl) {
			obs_source_release(src);
			obs_source_release(fl);
			continue;
		}
		std::string opened;
		bool playing;
		{
			std::lock_guard<std::mutex> lk(s.m);
			opened = s.file;
			playing = s.playing;
		}
		if (t.file.empty()) {
			if (ramp(s, fl, 0.0, out + in, g) && playing) {
				obs_source_media_stop(src);
				std::lock_guard<std::mutex> lk(s.m);
				if (s.gen == g)
					s.playing = false;
			}
		} else if (playing && t.file == opened) {
			ramp(s, fl, mul_of(t.db), out + in, g); // the same bed keeps playing
		} else {
			bool ok = !playing || ramp(s, fl, 0.0, out, g);
			if (ok) {
				open_bed(src, t.file, opened);
				bool same;
				{
					std::lock_guard<std::mutex> lk(s.m);
					same = s.gen == g;
					if (same) {
						s.file = t.file;
						s.playing = true;
					}
				}
				if (same)
					ramp(s, fl, mul_of(t.db), in, g);
			}
		}
		obs_source_release(fl);
		obs_source_release(src);
	}
}

void start_thread(State &s)
{
	if (!s.th.joinable()) {
		s.stop = false;
		s.th = std::thread(run);
	}
}

} // namespace

bool mood_ok(const std::string &mood)
{
	static const std::regex re("^[a-z][a-z0-9-]{0,31}$");
	return std::regex_match(mood, re);
}

std::string bed_file(const std::string &dir, const std::string &mood, std::string &why)
{
	if (!mood_ok(mood)) {
		why = "This scene's music mood is not valid.";
		return "";
	}
	if (dir.empty()) {
		why = "The music library folder is not set, so no music can play.";
		return "";
	}
	std::error_code ec;
	const fs::path root = fs::canonical(fs::u8path(dir), ec);
	if (ec || !fs::is_directory(root, ec)) {
		why = "The music library is not made yet. Make it off air, then the scene's music plays.";
		return "";
	}
	const fs::path f = fs::canonical(root / fs::u8path(mood + ".wav"), ec);
	if (ec || !fs::is_regular_file(f, ec)) {
		why = "The music for \"" + mood + "\" is not made yet. Make the music library off air, then it plays.";
		return "";
	}
	const fs::path rel = f.lexically_relative(root);
	if (rel.empty() || *rel.begin() == "..") {
		why = "The music for \"" + mood + "\" is outside the music library, so it is not played.";
		return "";
	}
	return f.u8string();
}

void attach(obs_source_t *src)
{
	State &s = st();
	detach();
	obs_source_t *fl = obs_source_get_filter_by_name(src, kLevelFilter);
	if (!fl) {
		register_level_type();
		fl = obs_source_create_private("ujw_music_level", kLevelFilter, nullptr); // starts at gain 0 (silent)
		if (!fl || !obs_obj_get_data(fl)) {
			obs_source_release(fl);
			hlog::warn("scene music: the level filter could not be made, the music strip stays silent");
			return;
		}
		// D399: the filter array changes on the graphics thread, between video ticks (waits; inline when there)
		struct Job {
			obs_source_t *src, *fl;
		} job{src, fl};
		obs_queue_task(
			OBS_TASK_GRAPHICS, [](void *p) { auto *j = static_cast<Job *>(p); obs_source_filter_add(j->src, j->fl); }, &job,
			true);
	}
	std::lock_guard<std::mutex> lk(s.m);
	s.gen++;
	s.weak = obs_source_get_weak_source(src);
	s.level = fl;
	s.file.clear();
	s.playing = false;
	s.level_mul = 0;
	s.now = Target{};
	s.pending = false;
	start_thread(s);
}

bool attached(obs_source_t *src)
{
	State &s = st();
	std::lock_guard<std::mutex> lk(s.m);
	return s.weak && src && obs_weak_source_references_source(s.weak, src);
}

void detach()
{
	State &s = st();
	{
		std::unique_lock<std::mutex> lk(s.m);
		s.gen++;
		s.pending = false;
		obs_weak_source_release(s.weak);
		s.weak = nullptr;
		if (s.level) {
			obs_source_release(s.level);
			s.level = nullptr;
		}
		s.file.clear();
		s.playing = false;
		s.level_mul = 0;
		s.now = Target{};
		s.cv.notify_all();
		// a fade in progress holds its own references; the new gen ends it at its next step without a write
	}
}

void cue(const Target &t, uint32_t out_ms, uint32_t in_ms)
{
	State &s = st();
	std::lock_guard<std::mutex> lk(s.m);
	if (!s.weak)
		return;
	s.want = t;
	s.want_out = out_ms;
	s.want_in = in_ms;
	s.pending = true;
	s.cv.notify_all();
}

json::Value status()
{
	State &s = st();
	std::lock_guard<std::mutex> lk(s.m);
	json::Value r = json::Value::object();
	r.set("attached", s.weak != nullptr);
	r.set("scene", s.now.scene);
	r.set("mood", s.now.mood);
	r.set("file", s.file.empty() ? std::string() : fs::u8path(s.file).filename().u8string());
	r.set("playing", s.playing);
	r.set("levelDb", db_of(s.level_mul));
	r.set("targetDb", s.now.file.empty() ? kSilentDb : s.now.db);
	r.set("reason", s.now.reason);
	r.set("fades", (uint64_t)s.fades);
	json::Value f = json::Value::object();
	f.set("outMs", (uint64_t)s.last_out);
	f.set("inMs", (uint64_t)s.last_in);
	r.set("lastFade", std::move(f));
	return r;
}

bool wait_idle(uint32_t timeout_ms)
{
	State &s = st();
	std::unique_lock<std::mutex> lk(s.m);
	return s.cv.wait_for(lk, std::chrono::milliseconds(timeout_ms), [&] { return !s.pending && !s.busy; });
}

void shutdown()
{
	State &s = st();
	{
		std::lock_guard<std::mutex> lk(s.m);
		s.stop = true;
		s.cv.notify_all();
	}
	if (s.th.joinable())
		s.th.join();
	detach();
}

} // namespace scene_music
