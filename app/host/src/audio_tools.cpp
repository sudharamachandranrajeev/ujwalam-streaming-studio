// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: mixer audio tools (AU1 app sound and playback, AU2 strip filters). See audio_tools.h.
#include "audio_tools.h"
#include "checks.h"
#include "log.h"
#include "rpc_server.h"

#include <windows.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <psapi.h>

#include <util/platform.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <regex>
#include <set>
#include <thread>

namespace fs = std::filesystem;
using rpc::Error;

namespace audio_tools {

namespace {

// A program file name: no path, no OBS window-spec separator ':' or escape '#'. Same as validate.mjs EXE_RE.
const char *const kExeRe = "^[^\\\\/:*?\"<>|#\\x00-\\x1f]{1,120}\\.[eE][xX][eE]$";

// One tool: its project key, libobs filter id, and project key -> libobs setting (with range and integer flag).
struct Param {
	const char *key, *obs;
	double lo, hi;
	bool integer;
};
struct Tool {
	const char *kind, *obs_id;
	std::vector<Param> params;
};

// Ranges: the filters' obs_properties limits in OBS 32.1.2 (plugins/obs-filters, checked 2026-11-18); the same table
// as services/project/audio-filters.mjs and data/schemas/project.schema.json. Order = processing order on the strip.
const std::vector<Tool> &tools()
{
	static const std::vector<Tool> t = {
		{"suppress", "noise_suppress_filter_v2", {}},
		{"gate",
		 "noise_gate_filter",
		 {{"closeDb", "close_threshold", -96, 0, false},
		  {"openDb", "open_threshold", -96, 0, false},
		  {"attackMs", "attack_time", 0, 10000, true},
		  {"holdMs", "hold_time", 0, 10000, true},
		  {"releaseMs", "release_time", 0, 10000, true}}},
		{"eq", "basic_eq_filter", {{"lowDb", "low", -20, 20, false}, {"midDb", "mid", -20, 20, false}, {"highDb", "high", -20, 20, false}}},
		{"gain", "gain_filter", {{"db", "db", -30, 30, false}}},
		// AU3: the user's values are kept in the filter's settings (ujw_*) and turned into the compressor's (duck_settings)
		{"duck",
		 "compressor_filter",
		 {{"amountDb", "ujw_amount", 3, 18, false},
		  {"attackMs", "ujw_attack", 1, 500, true},
		  {"releaseMs", "ujw_release", 1, 1000, true}}},
		{"compressor",
		 "compressor_filter",
		 {{"ratio", "ratio", 1, 32, false},
		  {"thresholdDb", "threshold", -60, 0, false},
		  {"attackMs", "attack_time", 1, 500, true},
		  {"releaseMs", "release_time", 1, 1000, true},
		  {"outputGainDb", "output_gain", -32, 32, false}}},
		{"limiter", "limiter_filter", {{"thresholdDb", "threshold", -60, 0, false}, {"releaseMs", "release_time", 1, 1000, true}}},
	};
	return t;
}

std::string filter_name(const char *kind)
{
	return std::string("ujw:tool:") + kind;
}

obs_data_t *tool_settings(const Tool &t, const json::Value &v)
{
	obs_data_t *d = obs_data_create();
	if (std::string(t.kind) == "suppress")
		obs_data_set_string(d, "method", "rnnoise");
	if (std::string(t.kind) == "compressor")
		obs_data_set_string(d, "sidechain_source", "none");
	for (auto &p : t.params) {
		const json::Value *x = v.find(p.key);
		if (p.integer)
			obs_data_set_int(d, p.obs, x->as_int());
		else
			obs_data_set_double(d, p.obs, x->as_double());
	}
	return d;
}

// AU3 duck as compressor settings. compressor_filter: gain = (1 - 1/ratio) * (threshold - envelope), envelope = the
// sidechain's peak follower. It starts at kDuckThresholdDb; at kDuckRefDb (a talking voice's peaks) the drop is
// amountDb: ratio = 1 / (1 - amount / (ref - threshold)). Same constants as services/project/audio-filters.mjs.
// The follower moves exponentially with the attack / release time as its time constant: going between the reference
// and the threshold (20 dB, a factor of 10) takes ln(10) time constants. So the user's attackMs / releaseMs ("the drop
// is there within", "the music is back within") are divided by ln(10) for the compressor.
constexpr double kDuckThresholdDb = -30, kDuckRefDb = -10;
const double kDuckSpan = std::log(std::pow(10.0, (kDuckRefDb - kDuckThresholdDb) / 20.0));

// Fills the duck settings, with the sidechain found through `resolve`. Returns whether the filter may run: switched
// on and its sound found (without a sidechain, compressor_filter would compress the strip on its own signal).
bool duck_settings(obs_data_t *d, const std::string &source, bool on, const DuckResolve &resolve)
{
	const double amount = obs_data_get_double(d, "ujw_amount");
	const double slope = std::min(amount / (kDuckRefDb - kDuckThresholdDb), 31.0 / 32.0);
	obs_data_set_double(d, "ratio", std::clamp(1.0 / (1.0 - slope), 1.0, 32.0));
	obs_data_set_double(d, "threshold", kDuckThresholdDb);
	obs_data_set_double(d, "output_gain", 0);
	obs_data_set_int(d, "attack_time", std::max<int64_t>(1, std::llround(obs_data_get_int(d, "ujw_attack") / kDuckSpan)));
	obs_data_set_int(d, "release_time", std::max<int64_t>(1, std::llround(obs_data_get_int(d, "ujw_release") / kDuckSpan)));
	obs_data_set_string(d, "ujw_duck_source", source.c_str());
	obs_data_set_bool(d, "ujw_on", on);
	std::string why;
	const std::string name = resolve ? resolve(source, why) : std::string();
	obs_data_set_string(d, "sidechain_source", name.empty() ? "none" : name.c_str());
	obs_data_set_string(d, "ujw_duck_why", name.empty() ? why.c_str() : "");
	return on && !name.empty();
}

// ---- AU3 duck binding (graphics thread only) ----
// compressor_filter finds its sidechain by name in its video tick (graphics thread): it publishes the weak reference,
// then adds its audio capture callback to that source. Until then it compresses the strip on its own signal. So a
// duck stays switched off while its sidechain changes and is switched on two ticks later (the compressor's tick ran in
// between), once the sound is still there by that name. Every change to a duck's sidechain runs on the graphics
// thread, so it never overlaps that tick. Binds made: filter uuid -> sidechain name; waiting: filters to switch on.
struct DuckWait {
	obs_weak_source_t *fl;
	std::string name;
	int ticks;
};
std::map<std::string, std::string> g_duck_bound;
std::vector<DuckWait> g_duck_wait;
bool g_duck_tick = false;
std::atomic<bool> g_duck_used{false}; // a duck was ever bound or waited for (read by shutdown_ducks off the graphics thread)

std::string sidechain_of(obs_source_t *fl)
{
	obs_data_t *d = obs_source_get_settings(fl);
	std::string s = obs_data_get_string(d, "sidechain_source");
	obs_data_release(d);
	return s;
}
bool duck_bound(obs_source_t *fl, const std::string &name)
{
	auto it = g_duck_bound.find(obs_source_get_uuid(fl));
	return it != g_duck_bound.end() && it->second == name && sidechain_of(fl) == name;
}
void duck_forget(obs_source_t *fl)
{
	const std::string id = obs_source_get_uuid(fl);
	g_duck_bound.erase(id);
	g_duck_wait.erase(std::remove_if(g_duck_wait.begin(), g_duck_wait.end(),
					 [&](DuckWait &w) {
						 if (!obs_weak_source_references_source(w.fl, fl))
							 return false;
						 obs_weak_source_release(w.fl);
						 return true;
					 }),
			  g_duck_wait.end());
}
void duck_set_sidechain(obs_source_t *fl, const char *name)
{
	obs_data_t *x = obs_data_create();
	obs_data_set_string(x, "sidechain_source", name);
	obs_source_update(fl, x);
	obs_data_release(x);
}

void duck_tick(void *, float)
{
	for (size_t i = 0; i < g_duck_wait.size();) {
		DuckWait &w = g_duck_wait[i];
		if (--w.ticks > 0) {
			i++;
			continue;
		}
		if (obs_source_t *fl = obs_weak_source_get_source(w.fl)) {
			obs_data_t *d = obs_source_get_settings(fl);
			obs_source_t *sc = obs_get_source_by_name(w.name.c_str());
			if (sc && obs_data_get_bool(d, "ujw_on") && w.name == obs_data_get_string(d, "sidechain_source")) {
				g_duck_bound[obs_source_get_uuid(fl)] = w.name;
				obs_source_set_enabled(fl, true);
			}
			obs_source_release(sc);
			obs_data_release(d);
			obs_source_release(fl);
		}
		obs_weak_source_release(w.fl);
		g_duck_wait.erase(g_duck_wait.begin() + (ptrdiff_t)i);
	}
}

// fl is switched off and its settings name `name`: make compressor_filter look the name up again (a "none" in between
// drops any old binding, e.g. a copied filter or a source re-made under the same name), and switch it on after.
void duck_wait(obs_source_t *fl, const std::string &name)
{
	duck_forget(fl);
	duck_set_sidechain(fl, "none");
	duck_set_sidechain(fl, name.c_str());
	g_duck_wait.push_back({obs_source_get_weak_source(fl), name, 2});
	if (!g_duck_tick) {
		obs_add_tick_callback(duck_tick, nullptr);
		g_duck_tick = true;
		g_duck_used = true;
	}
}

// Runs fn on the graphics thread and waits (inline when already there).
template <class F> void on_graphics(F &fn)
{
	obs_queue_task(OBS_TASK_GRAPHICS, [](void *p) { (*static_cast<F *>(p))(); }, &fn, true);
}
} // namespace

void check_filters(const json::Value &f, const std::string &what)
{
	if (!f.is_object())
		throw Error(rpc::INVALID_PARAMS, what + " must be an object");
	for (auto &m : f.members()) {
		auto t = std::find_if(tools().begin(), tools().end(), [&](const Tool &x) { return m.first == x.kind; });
		if (t == tools().end())
			throw Error(rpc::INVALID_PARAMS, what + ": unknown tool " + json::Value(m.first.substr(0, 32)).dump());
		const std::string w = what + "." + t->kind;
		if (!m.second.is_object())
			throw Error(rpc::INVALID_PARAMS, w + " must be an object");
		const bool duck = std::string(t->kind) == "duck";
		if (duck) {
			static const std::regex id_re("^[a-z][a-z0-9_-]{0,63}$");
			const json::Value *s = m.second.find("source");
			if (!s || !s->is_string() || !std::regex_match(s->as_string(), id_re))
				throw Error(rpc::INVALID_PARAMS, w + ": bad source");
		}
		for (auto &k : m.second.members()) {
			bool ok = k.first == "on" || (duck && k.first == "source");
			for (auto &p : t->params)
				ok = ok || k.first == p.key;
			if (!ok)
				throw Error(rpc::INVALID_PARAMS, w + ": unknown field " + json::Value(k.first.substr(0, 32)).dump());
		}
		const json::Value *on = m.second.find("on");
		if (!on || !on->is_bool())
			throw Error(rpc::INVALID_PARAMS, w + ": bad on");
		for (auto &p : t->params) {
			const json::Value *x = m.second.find(p.key);
			if (!x || !x->is_number() || !std::isfinite(x->as_double()) || x->as_double() < p.lo || x->as_double() > p.hi ||
			    (p.integer && !x->is_int()))
				throw Error(rpc::INVALID_PARAMS, w + ": bad " + p.key);
		}
		if (std::string(t->kind) == "gate" && m.second.find("closeDb")->as_double() > m.second.find("openDb")->as_double())
			throw Error(rpc::INVALID_PARAMS, w + ": closeDb must not be above openDb");
	}
}

namespace {

// True when every setting in `want` already has that value on the filter. noise_gate_filter's update closes the gate
// (and other filters reset their state), so an unchanged tool is never updated again.
bool same_settings(obs_data_t *have, obs_data_t *want)
{
	for (obs_data_item_t *it = obs_data_first(want); it; obs_data_item_next(&it)) {
		const char *k = obs_data_item_get_name(it);
		bool same = true;
		switch (obs_data_item_gettype(it)) {
		case OBS_DATA_STRING:
			same = std::string(obs_data_get_string(have, k)) == obs_data_item_get_string(it);
			break;
		case OBS_DATA_BOOLEAN:
			same = obs_data_get_bool(have, k) == obs_data_item_get_bool(it);
			break;
		case OBS_DATA_NUMBER:
			same = obs_data_get_double(have, k) == obs_data_item_get_double(it);
			break;
		default:
			break;
		}
		if (!same) {
			obs_data_item_release(&it);
			return false;
		}
	}
	return true;
}

// apply_filters on the graphics thread (see there).
void apply_now(obs_source_t *src, const json::Value &f, const DuckResolve &resolve)
{
	struct Step {
		obs_source_t *fl;  // a reference
		obs_data_t *want;  // settings to apply to a filter already on the strip (a reference), or null
		bool on, fresh;
		std::string duck;  // a duck that runs: its sidechain (switched on once bound)
	};
	std::vector<Step> keep;           // in processing order
	std::vector<obs_source_t *> drop; // tools to take off (a reference each)
	for (auto &t : tools()) {
		const std::string name = filter_name(t.kind);
		obs_source_t *have = obs_source_get_filter_by_name(src, name.c_str()); // a new reference or null
		const json::Value *v = f.is_object() ? f.find(t.kind) : nullptr;
		if (!v) {
			if (have)
				drop.push_back(have);
			continue;
		}
		obs_data_t *d = tool_settings(t, *v);
		Step k{have, nullptr, v->find("on")->as_bool(), false, {}};
		if (std::string(t.kind) == "duck") { // AU3: on only while its sound is there (else it would compress itself)
			k.on = duck_settings(d, v->find("source")->as_string(), k.on, resolve);
			if (k.on)
				k.duck = obs_data_get_string(d, "sidechain_source");
		}
		if (have) {
			obs_data_t *cur = obs_source_get_settings(have);
			if (!same_settings(cur, d))
				k.want = (obs_data_addref(d), d);
			obs_data_release(cur);
		} else {
			k.fl = obs_source_create_private(t.obs_id, name.c_str(), d);
			if (!k.fl || !obs_obj_get_data(k.fl)) {
				hlog::warn("audio tools: %s could not be created (%s not loaded?)", t.kind, t.obs_id);
				if (k.fl)
					obs_source_release(k.fl);
				obs_data_release(d);
				continue;
			}
			obs_source_set_enabled(k.fl, false); // joins the strip switched off; switched on with the others below
			k.fresh = true;
		}
		obs_data_release(d);
		// a duck whose sidechain is not bound yet waits switched off (else it would compress the strip on itself)
		if (!k.duck.empty() && (k.fresh || !duck_bound(k.fl, k.duck)))
			k.on = false;
		else
			k.duck.clear();
		keep.push_back(std::move(k));
	}
	// The audio thread may run a block between any two of these calls, so every step leaves a safe chain: removed tools
	// are switched off first (a boost that goes, before any limiter goes off), then tools going off, first to last (a
	// boost before its limiter); settings change after that, new tools join switched off, and tools going on are
	// switched on last to first (the limiter before the boost in front of it).
	for (auto *x : drop)
		obs_source_set_enabled(x, false);
	for (auto &k : keep)
		if (!k.on && obs_source_enabled(k.fl))
			obs_source_set_enabled(k.fl, false);
	for (auto &k : keep)
		if (k.want) {
			if (!k.on || sidechain_of(k.fl) != obs_data_get_string(k.want, "sidechain_source"))
				duck_forget(k.fl); // a duck's binding changes (no-op for other tools)
			obs_source_update(k.fl, k.want);
			obs_data_release(k.want);
		}
	for (auto *x : drop) {
		duck_forget(x);
		obs_source_filter_remove(src, x);
		obs_source_release(x);
	}
	for (auto &k : keep)
		if (k.fresh)
			obs_source_filter_add(src, k.fl);
	// libobs runs a source's audio filters from the last array entry to the first: the first tool in processing order
	// goes to the highest index of the tool filters (they sit at 0..n-1; other filters stay after them).
	const size_t n = keep.size();
	for (size_t i = 0; i < n; i++)
		obs_source_filter_set_index(src, keep[i].fl, n - 1 - i);
	for (size_t i = n; i > 0; i--)
		if (keep[i - 1].on && !obs_source_enabled(keep[i - 1].fl))
			obs_source_set_enabled(keep[i - 1].fl, true);
	for (auto &k : keep) {
		if (!k.duck.empty())
			duck_wait(k.fl, k.duck);
		obs_source_release(k.fl);
	}
}
} // namespace

void apply_filters(obs_source_t *src, const json::Value &f, const DuckResolve &resolve)
{
	if (!src)
		return;
	// libobs 32.1.2 walks a source's filter array without its filter mutex in the video tick (show/hide and
	// activate/deactivate in obs_source_video_tick): adding, removing or moving filters runs on the graphics thread,
	// between ticks, never next to that walk. The caller waits (obs_queue_task runs it inline when already there).
	struct Job {
		obs_source_t *src;
		const json::Value *f;
		const DuckResolve *resolve;
	} job{src, &f, &resolve};
	obs_queue_task(
		OBS_TASK_GRAPHICS, [](void *p) { auto *j = static_cast<Job *>(p); apply_now(j->src, *j->f, *j->resolve); }, &job,
		true);
}
json::Value read_filters(obs_source_t *src)
{
	json::Value r = json::Value::object();
	if (!src)
		return r;
	for (auto &t : tools()) {
		obs_source_t *have = obs_source_get_filter_by_name(src, filter_name(t.kind).c_str());
		if (!have)
			continue;
		json::Value o = json::Value::object();
		o.set("on", obs_source_enabled(have));
		obs_data_t *d = obs_source_get_settings(have);
		for (auto &p : t.params)
			o.set(p.key, p.integer ? json::Value((int64_t)obs_data_get_int(d, p.obs)) : json::Value(obs_data_get_double(d, p.obs)));
		if (std::string(t.kind) == "duck") { // what libobs runs (for tests): the derived compressor and its sidechain
			o.set("source", obs_data_get_string(d, "ujw_duck_source"));
			o.set("ratio", obs_data_get_double(d, "ratio"));
			o.set("thresholdDb", obs_data_get_double(d, "threshold"));
			o.set("sidechain", obs_data_get_string(d, "sidechain_source"));
			o.set("obsAttackMs", (int64_t)obs_data_get_int(d, "attack_time"));
			o.set("obsReleaseMs", (int64_t)obs_data_get_int(d, "release_time"));
		}
		obs_data_release(d);
		r.set(t.kind, std::move(o));
		obs_source_release(have);
	}
	// processing order as libobs holds it (for tests): tool kinds from first to last
	json::Value order = json::Value::array();
	struct Ctx {
		std::vector<std::string> names;
	} ctx;
	obs_source_enum_filters(
		src, [](obs_source_t *, obs_source_t *fl, void *p) { static_cast<Ctx *>(p)->names.push_back(obs_source_get_name(fl)); },
		&ctx);
	// obs_source_enum_filters walks from the last array entry (the first to run) to the first
	for (auto &nm : ctx.names)
		if (nm.rfind("ujw:tool:", 0) == 0)
			order.push(nm.substr(9));
	r.set("order", std::move(order));
	return r;
}

void refresh_duck(obs_source_t *src, const DuckResolve &resolve)
{
	if (!src)
		return;
	obs_source_t *fl = obs_source_get_filter_by_name(src, filter_name("duck").c_str());
	if (!fl)
		return;
	auto job = [&] {
		obs_data_t *cur = obs_source_get_settings(fl);
		obs_data_t *d = obs_data_create();
		obs_data_set_double(d, "ujw_amount", obs_data_get_double(cur, "ujw_amount"));
		obs_data_set_int(d, "ujw_attack", obs_data_get_int(cur, "ujw_attack"));
		obs_data_set_int(d, "ujw_release", obs_data_get_int(cur, "ujw_release"));
		const bool run = duck_settings(d, obs_data_get_string(cur, "ujw_duck_source"), obs_data_get_bool(cur, "ujw_on"), resolve);
		const std::string name = obs_data_get_string(d, "sidechain_source");
		if (run && duck_bound(fl, name)) { // the same sound, still bound: other values may change while it runs
			if (!same_settings(cur, d))
				obs_source_update(fl, d);
			if (!obs_source_enabled(fl))
				obs_source_set_enabled(fl, true);
		} else {
			obs_source_set_enabled(fl, false); // off before its sidechain changes or goes
			duck_forget(fl);
			if (!same_settings(cur, d))
				obs_source_update(fl, d);
			if (run)
				duck_wait(fl, name);
		}
		obs_data_release(d);
		obs_data_release(cur);
	};
	on_graphics(job);
	obs_source_release(fl);
}
void unbind_duck(obs_source_t *src, const std::string &name)
{
	if (!src)
		return;
	obs_source_t *fl = obs_source_get_filter_by_name(src, filter_name("duck").c_str());
	if (!fl)
		return;
	auto job = [&] {
		if (name.empty() || sidechain_of(fl) == name) {
			obs_source_set_enabled(fl, false);
			duck_forget(fl);
			duck_set_sidechain(fl, "none"); // compressor_filter removes its callback from the old source
		}
	};
	on_graphics(job);
	obs_source_release(fl);
}
void shutdown_ducks()
{
	auto job = [] {
		if (g_duck_tick)
			obs_remove_tick_callback(duck_tick, nullptr);
		g_duck_tick = false;
		for (auto &w : g_duck_wait)
			obs_weak_source_release(w.fl);
		g_duck_wait.clear();
		g_duck_bound.clear();
	};
	// No duck ever registered: nothing to undo. Without a running video thread (a failed main-video reset) nothing would
	// run a graphics task, and nothing ticks either: undo it here (obs_remove_tick_callback takes its own mutex).
	if (!g_duck_used.load())
		return;
	if (obs_get_video())
		on_graphics(job);
	else
		job();
}json::Value duck_status(obs_source_t *src)
{
	obs_source_t *fl = src ? obs_source_get_filter_by_name(src, filter_name("duck").c_str()) : nullptr;
	if (!fl)
		return json::Value();
	obs_data_t *d = obs_source_get_settings(fl);
	json::Value o = json::Value::object();
	const bool on = obs_data_get_bool(d, "ujw_on");
	o.set("on", on);
	// running, or bound and switched on within two ticks (duck_wait)
	o.set("active", on && std::string(obs_data_get_string(d, "sidechain_source")) != "none");
	o.set("source", obs_data_get_string(d, "ujw_duck_source"));
	o.set("reason", !on ? std::string("Switched off.") : std::string(obs_data_get_string(d, "ujw_duck_why")));
	obs_data_release(d);
	obs_source_release(fl);
	return o;
}

// ---- AU1 app sound ----

std::string check_exe(const json::Value &app, const std::string &what)
{
	chk::only_keys(app, {"exe"}, what + ".app");
	chk::require(app, {"exe"}, what + ".app");
	std::string exe = chk::get_str(app, "exe", "", 124, what + ".app");
	static const std::regex re(kExeRe); // no '#': OBS window specs encode it (#22, #3A)
	if (!std::regex_match(exe, re))
		throw Error(rpc::INVALID_PARAMS, what + ".app: bad exe");
	return exe;
}

json::Value app_settings(const std::string &exe)
{
	json::Value s = json::Value::object();
	// OBS window spec "title:class:executable"; check_exe refuses ':' and '#' (the spec's separator and escape). Empty title and class: with the
	// "executable" priority (2, WINDOW_PRIORITY_EXE) any window of that program matches.
	s.set("window", "::" + exe);
	s.set("priority", 2);
	return s;
}

namespace {

std::string narrow(const std::wstring &w)
{
	if (w.empty())
		return {};
	int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
	std::string s((size_t)n, '\0');
	WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
	return s;
}

// Full image path of a process that runs as this user in this session, or "" (another user's or session's process,
// or one that cannot be opened).
std::wstring own_image_of(DWORD pid)
{
	DWORD sess = 0, my_sess = 0;
	if (!ProcessIdToSessionId(pid, &sess) || !ProcessIdToSessionId(GetCurrentProcessId(), &my_sess) || sess != my_sess)
		return {};
	HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!h)
		return {};
	std::wstring r;
	auto user_sid = [](HANDLE proc, std::vector<char> &buf) -> PSID {
		HANDLE tok = nullptr;
		if (!OpenProcessToken(proc, TOKEN_QUERY, &tok))
			return nullptr;
		DWORD n = 0;
		GetTokenInformation(tok, TokenUser, nullptr, 0, &n);
		buf.resize(n ? n : 1);
		const bool ok = n && GetTokenInformation(tok, TokenUser, buf.data(), n, &n);
		CloseHandle(tok);
		return ok ? reinterpret_cast<TOKEN_USER *>(buf.data())->User.Sid : nullptr;
	};
	std::vector<char> a, b;
	PSID theirs = user_sid(h, a), mine = user_sid(GetCurrentProcess(), b);
	if (theirs && mine && EqualSid(theirs, mine)) {
		wchar_t buf[MAX_PATH * 2];
		DWORD n = (DWORD)(sizeof(buf) / sizeof(buf[0]));
		if (QueryFullProcessImageNameW(h, 0, buf, &n))
			r.assign(buf, n);
	}
	CloseHandle(h);
	return r;
}

std::string lower(std::string s)
{
	std::transform(s.begin(), s.end(), s.begin(), [](unsigned char ch) { return (char)std::tolower(ch); });
	return s;
}

struct AppScan {
	std::map<std::string, std::set<DWORD>> pids;         // lower-case exe -> pids
	std::map<std::string, std::set<std::wstring>> paths; // lower-case exe -> full image paths (lower case)
	std::map<std::string, std::string> shown;            // lower-case exe -> exe as Windows names it
};

// Programs with a visible top-level window, run by this user in this session (window titles are only tested for
// being there; never read).
AppScan scan_apps()
{
	AppScan ctx;
	EnumWindows(
		[](HWND w, LPARAM p) -> BOOL {
			if (!IsWindowVisible(w) || GetWindow(w, GW_OWNER) || (GetWindowLongW(w, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) ||
			    GetWindowTextLengthW(w) == 0)
				return TRUE;
			DWORD pid = 0;
			GetWindowThreadProcessId(w, &pid);
			if (!pid || pid == GetCurrentProcessId())
				return TRUE;
			const std::wstring img = own_image_of(pid);
			if (img.empty())
				return TRUE;
			auto *c = reinterpret_cast<AppScan *>(p);
			const std::string exe = narrow(fs::path(img).filename().wstring());
			const std::string k = lower(exe);
			std::wstring li = img;
			std::transform(li.begin(), li.end(), li.begin(), [](wchar_t ch) { return (wchar_t)towlower(ch); });
			c->pids[k].insert(pid);
			c->paths[k].insert(li);
			c->shown.emplace(k, exe);
			return TRUE;
		},
		(LPARAM)&ctx);
	return ctx;
}
// Process ids with an active audio session on the default render device (best effort; empty on any failure).
std::set<DWORD> sounding_pids()
{
	std::set<DWORD> out;
	const HRESULT ci = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
	IMMDeviceEnumerator *en = nullptr;
	IMMDevice *dev = nullptr;
	IAudioSessionManager2 *mgr = nullptr;
	IAudioSessionEnumerator *se = nullptr;
	if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void **)&en)) &&
	    SUCCEEDED(en->GetDefaultAudioEndpoint(eRender, eConsole, &dev)) &&
	    SUCCEEDED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void **)&mgr)) &&
	    SUCCEEDED(mgr->GetSessionEnumerator(&se))) {
		int n = 0;
		se->GetCount(&n);
		for (int i = 0; i < n; i++) {
			IAudioSessionControl *c = nullptr;
			IAudioSessionControl2 *c2 = nullptr;
			if (SUCCEEDED(se->GetSession(i, &c)) && SUCCEEDED(c->QueryInterface(__uuidof(IAudioSessionControl2), (void **)&c2))) {
				AudioSessionState st;
				DWORD pid = 0;
				if (SUCCEEDED(c2->GetState(&st)) && st == AudioSessionStateActive && SUCCEEDED(c2->GetProcessId(&pid)) && pid)
					out.insert(pid);
			}
			if (c2)
				c2->Release();
			if (c)
				c->Release();
		}
	}
	if (se)
		se->Release();
	if (mgr)
		mgr->Release();
	if (dev)
		dev->Release();
	if (en)
		en->Release();
	if (SUCCEEDED(ci))
		CoUninitialize();
	return out;
}

} // namespace

json::Value list_apps()
{
	const AppScan ctx = scan_apps();
	const std::set<DWORD> sound = sounding_pids();
	json::Value list = json::Value::array();
	static const std::regex re(kExeRe);
	for (auto &[k, pids] : ctx.pids) {
		const std::string &exe = ctx.shown.at(k);
		if (!std::regex_match(exe, re))
			continue;
		json::Value o = json::Value::object();
		o.set("exe", exe);
		o.set("sound", std::any_of(pids.begin(), pids.end(), [&](DWORD d) { return sound.count(d) > 0; }));
		// two different programs with this file name: OBS matches by name only, so either could go on air
		o.set("ambiguous", ctx.paths.at(k).size() > 1);
		list.push(std::move(o));
		if (list.size() >= 200)
			break;
	}
	json::Value r = json::Value::object();
	r.set("available", obs_source_get_display_name("wasapi_process_output_capture") != nullptr);
	r.set("apps", std::move(list));
	return r;
}

bool app_ambiguous(const std::string &exe)
{
	const AppScan ctx = scan_apps();
	auto it = ctx.paths.find(lower(exe));
	return it != ctx.paths.end() && it->second.size() > 1;
}
// ---- AU1 playback ----

namespace {

// True when `p` (canonical) lies inside the directory `root` (canonical).
bool inside(const fs::path &root, const fs::path &p)
{
	auto r = root.begin(), q = p.begin();
	for (; r != root.end(); ++r, ++q)
		if (q == p.end() || *q != *r)
			return false;
	return true;
}

// The file's real path when it is a regular file inside `root` after following every link, else "".
std::string real_inside(const std::string &file, const std::string &root)
{
	std::error_code ec;
	const fs::path rt = fs::canonical(fs::u8path(root), ec);
	if (ec)
		return {};
	const fs::path p = fs::canonical(fs::u8path(file), ec);
	if (ec || !inside(rt, p) || !fs::is_regular_file(p, ec))
		return {};
	return p.generic_u8string();
}

} // namespace

std::vector<std::string> folder_playlist(const std::string &dir, const std::string &root)
{
	static const std::set<std::string> ext = {".mp3", ".wav", ".ogg", ".opus", ".flac", ".m4a", ".aac", ".wma"};
	std::vector<std::string> out;
	std::error_code ec;
	for (auto it = fs::directory_iterator(fs::u8path(dir), ec); !ec && it != fs::directory_iterator(); it.increment(ec)) {
		std::string e = it->path().extension().u8string();
		std::transform(e.begin(), e.end(), e.begin(), [](unsigned char ch) { return (char)std::tolower(ch); });
		if (!ext.count(e))
			continue;
		// a link in the folder is followed only when its target is still inside the media folder
		const std::string real = real_inside(it->path().u8string(), root);
		if (real.empty())
			continue;
		out.push_back(real);
		if (out.size() >= 500)
			break;
	}
	std::sort(out.begin(), out.end());
	out.erase(std::unique(out.begin(), out.end()), out.end()); // a link to a file in the list is the same file
	return out;
}
json::Value playback_settings(const std::string &file, bool loop)
{
	json::Value st = json::Value::object();
	st.set("is_local_file", true);
	st.set("local_file", file);
	st.set("looping", loop);
	st.set("hw_decode", false);
	st.set("close_when_inactive", false);
	st.set("restart_on_activate", false);
	return st;
}

namespace {

// A folder playlist. Its state lives as long as the source or any queued step holds it; the weak reference is
// released with the last holder.
struct Playlist {
	obs_weak_source_t *weak = nullptr;
	std::vector<std::string> files;
	std::string root; // the media folder: every file is checked again against it when it is opened
	bool loop = true;
	// guarded by Worker::m
	size_t at = 0;
	bool queued = false, unavailable = false;
	// a next file is on its way: from the step being queued until the source has opened it (its "update" or
	// "media_restart" signal). An end in that time is the previous file's (each file's end counts once).
	bool opening = false;
	size_t silent_ends = 0; // files in a row that ended without one block of audio (missing, broken, not audio)
	std::atomic<bool> heard{false};
	Playlist() = default;
	Playlist(const Playlist &) = delete;
	Playlist &operator=(const Playlist &) = delete;
	~Playlist() { obs_weak_source_release(weak); }
};

// One thread for every playlist: it opens the next file (ffmpeg_source's update stops and joins the media thread that
// sent media_ended, so it never runs on that thread). Ends that arrive while a step is queued are dropped, so a list
// of broken files can never pile up work.
struct Worker {
	std::mutex m;
	std::condition_variable cv;
	std::deque<std::shared_ptr<Playlist>> q;
	std::map<obs_source_t *, std::shared_ptr<Playlist>> lists;
	std::thread th;
	bool stop = false;
};
Worker &worker()
{
	static Worker w;
	return w;
}

void on_audio(void *p, obs_source_t *, const struct audio_data *a, bool)
{
	if (a->frames)
		static_cast<Playlist *>(p)->heard = true;
}

// Worker::m held: the next step after the current file ended (or could not be opened).
void advance_locked(Worker &w, const std::shared_ptr<Playlist> &pl, bool heard)
{
	if (pl->unavailable || pl->queued)
		return;
	pl->silent_ends = heard ? 0 : pl->silent_ends + 1;
	if (pl->silent_ends >= pl->files.size()) {
		pl->unavailable = true; // one full pass and not one file played: stop instead of reopening them forever
		hlog::warn("audio playlist: none of its %zu files could be played; it stops", pl->files.size());
		return;
	}
	if (pl->at + 1 >= pl->files.size() && !pl->loop)
		return; // the last file of a playlist that does not loop
	pl->at = (pl->at + 1) % pl->files.size();
	pl->queued = true;
	pl->opening = true;
	w.q.push_back(pl);
	if (!w.th.joinable())
		w.th = std::thread([&w] {
			for (;;) {
				std::shared_ptr<Playlist> p;
				std::string next;
				{
					std::unique_lock<std::mutex> lk(w.m);
					w.cv.wait(lk, [&] { return w.stop || !w.q.empty(); });
					if (w.stop)
						return;
					p = w.q.front();
					w.q.pop_front();
					p->queued = false;
					next = p->files[p->at];
				}
				const std::string real = real_inside(next, p->root);
				if (real.empty()) { // gone, or now a link out of the media folder: skip it like a broken file
					std::lock_guard<std::mutex> lk(w.m);
					advance_locked(w, p, false);
					continue;
				}
				obs_source_t *s = obs_weak_source_get_source(p->weak);
				if (!s)
					continue;
				p->heard = false;
				obs_data_t *cur = obs_source_get_settings(s);
				const bool same = real == obs_data_get_string(cur, "local_file");
				obs_data_release(cur);
				if (same) { // ffmpeg_source does not reopen an unchanged file on update (e.g. the other files are gone)
					obs_source_media_restart(s);
				} else {
					obs_data_t *d = obs_data_create();
					obs_data_set_string(d, "local_file", real.c_str());
					obs_source_update(s, d); // the same source: its filters, volume, tracks and mixer strip stay
					obs_data_release(d);
				}
				obs_source_release(s);
			}
		});
	w.cv.notify_one();
}

void on_media_ended(void *, calldata_t *cd)
{
	obs_source_t *src = (obs_source_t *)calldata_ptr(cd, "source");
	Worker &w = worker();
	std::lock_guard<std::mutex> lk(w.m);
	auto it = w.lists.find(src);
	if (it == w.lists.end() || w.stop || it->second->opening)
		return;
	advance_locked(w, it->second, it->second->heard.exchange(false));
}

// The source opened the next file (deferred update ran, or the restart did): its own end counts from now. A broken or
// very short file can end before this signal (its media_ended fell in the opening window and was dropped, as the
// previous file's late end would be): the media state tells, so that end is counted here, once.
void on_opened(void *, calldata_t *cd)
{
	obs_source_t *src = (obs_source_t *)calldata_ptr(cd, "source");
	Worker &w = worker();
	std::lock_guard<std::mutex> lk(w.m);
	auto it = w.lists.find(src);
	if (it == w.lists.end() || it->second->queued || !it->second->opening || w.stop)
		return;
	it->second->opening = false;
	const enum obs_media_state st = obs_source_media_get_state(src);
	if (st == OBS_MEDIA_STATE_ENDED || st == OBS_MEDIA_STATE_ERROR)
		advance_locked(w, it->second, it->second->heard.exchange(false)); // queues again: a later media_ended is dropped
}

void on_destroy(void *, calldata_t *cd)
{
	obs_source_t *src = (obs_source_t *)calldata_ptr(cd, "source");
	Worker &w = worker();
	std::shared_ptr<Playlist> pl;
	{
		std::lock_guard<std::mutex> lk(w.m);
		auto it = w.lists.find(src);
		if (it == w.lists.end())
			return;
		pl = it->second;
		w.lists.erase(it);
	}
	obs_source_remove_audio_capture_callback(src, on_audio, pl.get());
} // a queued step keeps its own reference; the last one releases the weak source

} // namespace

void attach_playlist(obs_source_t *src, const std::vector<std::string> &files, bool loop, const std::string &root)
{
	if (!src || files.size() < 2)
		return;
	auto pl = std::make_shared<Playlist>();
	pl->weak = obs_source_get_weak_source(src);
	pl->files = files;
	pl->root = root;
	pl->loop = loop;
	Worker &w = worker();
	{
		std::lock_guard<std::mutex> lk(w.m);
		if (w.stop)
			return;
		w.lists[src] = pl;
	}
	obs_source_add_audio_capture_callback(src, on_audio, pl.get());
	signal_handler_t *sh = obs_source_get_signal_handler(src);
	signal_handler_connect(sh, "media_ended", on_media_ended, nullptr);
	signal_handler_connect(sh, "update", on_opened, nullptr);
	signal_handler_connect(sh, "media_restart", on_opened, nullptr);
	signal_handler_connect(sh, "destroy", on_destroy, nullptr);
	// The first file may have ended (or failed to open) before the signal was connected.
	const enum obs_media_state st = obs_source_media_get_state(src);
	if (st == OBS_MEDIA_STATE_ENDED || st == OBS_MEDIA_STATE_ERROR) {
		std::lock_guard<std::mutex> lk(w.m);
		if (!pl->opening) // media_ended has not counted this end already
			advance_locked(w, pl, pl->heard.exchange(false));
	}
}

json::Value playlist_status(obs_source_t *src)
{
	Worker &w = worker();
	std::lock_guard<std::mutex> lk(w.m);
	auto it = w.lists.find(src);
	if (it == w.lists.end())
		return json::Value();
	json::Value o = json::Value::object();
	o.set("files", (uint64_t)it->second->files.size());
	o.set("at", (uint64_t)it->second->at);
	o.set("state", it->second->unavailable ? "unavailable" : "playing");
	return o;
}

void shutdown_playlists()
{
	Worker &w = worker();
	{
		std::lock_guard<std::mutex> lk(w.m);
		w.stop = true;
		w.q.clear();
	}
	w.cv.notify_all();
	if (w.th.joinable())
		w.th.join();
}
// ---- test hooks: levels after the filters ----

json::Value measure(obs_source_t *src, uint32_t skip_ms, uint32_t ms, uint32_t bin_ms)
{
	struct Acc {
		std::mutex m;
		bool on = false;
		double peak = 0, sum = 0;
		uint64_t n = 0, start_ns = 0, bin_frames = 0;
		std::vector<double> bins; // peak per bin_ms, from the first counted frame
	} acc;
	acc.bin_frames = (uint64_t)audio_output_get_sample_rate(obs_get_audio()) * bin_ms / 1000;
	auto cb = [](void *p, obs_source_t *, const struct audio_data *a, bool muted) {
		auto *x = static_cast<Acc *>(p);
		std::lock_guard<std::mutex> lk(x->m);
		if (!x->on || !a->data[0])
			return;
		if (!x->n)
			x->start_ns = a->timestamp; // the audio clock: the same for every source, so two measures line up
		const float *f = reinterpret_cast<const float *>(a->data[0]);
		for (uint32_t i = 0; i < a->frames; i++) {
			const double v = muted ? 0.0 : std::fabs((double)f[i]); // muted audio is heard (and ducked on) as silence
			x->peak = std::max(x->peak, v);
			x->sum += v * v;
			if (x->bin_frames) {
				const size_t b = (size_t)((x->n + i) / x->bin_frames);
				if (b >= x->bins.size())
					x->bins.resize(b + 1, 0.0);
				x->bins[b] = std::max(x->bins[b], v);
			}
		}
		x->n += a->frames;
	};
	obs_source_add_audio_capture_callback(src, cb, &acc);
	std::this_thread::sleep_for(std::chrono::milliseconds(skip_ms));
	{
		std::lock_guard<std::mutex> lk(acc.m);
		acc.on = true;
	}
	std::this_thread::sleep_for(std::chrono::milliseconds(ms));
	obs_source_remove_audio_capture_callback(src, cb, &acc);
	std::lock_guard<std::mutex> lk(acc.m);
	auto db = [](double v) { return v > 0 ? 20.0 * std::log10(v) : -200.0; };
	json::Value r = json::Value::object();
	r.set("frames", (int64_t)acc.n);
	r.set("peakDb", db(acc.peak));
	r.set("rmsDb", acc.n ? db(std::sqrt(acc.sum / (double)acc.n)) : -200.0);
	if (bin_ms) {
		r.set("startMs", (double)acc.start_ns / 1e6);
		json::Value bins = json::Value::array();
		for (double v : acc.bins)
			bins.push(std::round(db(v) * 100) / 100);
		r.set("bins", std::move(bins));
	}
	return r;
}
} // namespace audio_tools
