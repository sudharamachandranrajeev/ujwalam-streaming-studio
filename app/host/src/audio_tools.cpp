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
		for (auto &k : m.second.members()) {
			bool ok = k.first == "on";
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
	}
}

void apply_filters(obs_source_t *src, const json::Value &f)
{
	if (!src)
		return;
	std::vector<obs_source_t *> present; // in processing order (a reference each)
	for (auto &t : tools()) {
		const std::string name = filter_name(t.kind);
		obs_source_t *have = obs_source_get_filter_by_name(src, name.c_str()); // a new reference or null
		const json::Value *v = f.is_object() ? f.find(t.kind) : nullptr;
		if (!v) {
			if (have) {
				obs_source_filter_remove(src, have);
				obs_source_release(have);
			}
			continue;
		}
		obs_data_t *d = tool_settings(t, *v);
		if (have) {
			obs_source_update(have, d);
		} else {
			have = obs_source_create_private(t.obs_id, name.c_str(), d);
			if (!have || !obs_obj_get_data(have)) {
				hlog::warn("audio tools: %s could not be created (%s not loaded?)", t.kind, t.obs_id);
				if (have)
					obs_source_release(have);
				obs_data_release(d);
				continue;
			}
			obs_source_filter_add(src, have);
		}
		obs_data_release(d);
		obs_source_set_enabled(have, v->find("on")->as_bool());
		present.push_back(have);
	}
	// libobs runs a source's audio filters from the last array entry to the first: the first tool in processing order
	// goes to the highest index of the tool filters (they sit at 0..n-1; other filters stay after them).
	const size_t n = present.size();
	for (size_t i = 0; i < n; i++)
		obs_source_filter_set_index(src, present[i], n - 1 - i);
	for (auto *x : present)
		obs_source_release(x);
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

// ---- AU1 app sound ----

std::string check_exe(const json::Value &app, const std::string &what)
{
	chk::only_keys(app, {"exe"}, what + ".app");
	chk::require(app, {"exe"}, what + ".app");
	std::string exe = chk::get_str(app, "exe", "", 124, what + ".app");
	static const std::regex re("^[^\\\\/:*?\"<>|\\x00-\\x1f]{1,120}\\.[eE][xX][eE]$");
	if (!std::regex_match(exe, re))
		throw Error(rpc::INVALID_PARAMS, what + ".app: bad exe");
	return exe;
}

json::Value app_settings(const std::string &exe)
{
	json::Value s = json::Value::object();
	// OBS window spec "title:class:executable"; an exe name holds no ':' or '#'. Empty title and class: with the
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

std::string exe_of(DWORD pid)
{
	HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
	if (!h)
		return {};
	wchar_t buf[MAX_PATH * 2];
	DWORD n = (DWORD)(sizeof(buf) / sizeof(buf[0]));
	std::string r;
	if (QueryFullProcessImageNameW(h, 0, buf, &n))
		r = narrow(fs::path(std::wstring(buf, n)).filename().wstring());
	CloseHandle(h);
	return r;
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
	struct Ctx {
		std::map<std::string, std::set<DWORD>> apps; // lower-case exe -> pids
		std::map<std::string, std::string> shown;    // lower-case exe -> exe as Windows names it
	} ctx;
	EnumWindows(
		[](HWND w, LPARAM p) -> BOOL {
			if (!IsWindowVisible(w) || GetWindow(w, GW_OWNER) || (GetWindowLongW(w, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) ||
			    GetWindowTextLengthW(w) == 0) // the title is only tested for being there; never read
				return TRUE;
			DWORD pid = 0;
			GetWindowThreadProcessId(w, &pid);
			if (!pid || pid == GetCurrentProcessId())
				return TRUE;
			std::string exe = exe_of(pid);
			if (exe.empty())
				return TRUE;
			auto *c = reinterpret_cast<Ctx *>(p);
			std::string k = exe;
			std::transform(k.begin(), k.end(), k.begin(), [](unsigned char ch) { return (char)std::tolower(ch); });
			c->apps[k].insert(pid);
			c->shown.emplace(k, exe);
			return TRUE;
		},
		(LPARAM)&ctx);
	const std::set<DWORD> sound = sounding_pids();
	json::Value list = json::Value::array();
	static const std::regex re("^[^\\\\/:*?\"<>|\\x00-\\x1f]{1,120}\\.[eE][xX][eE]$");
	for (auto &[k, pids] : ctx.apps) {
		const std::string &exe = ctx.shown[k];
		if (!std::regex_match(exe, re))
			continue;
		json::Value o = json::Value::object();
		o.set("exe", exe);
		o.set("sound", std::any_of(pids.begin(), pids.end(), [&](DWORD d) { return sound.count(d) > 0; }));
		list.push(std::move(o));
		if (list.size() >= 200)
			break;
	}
	json::Value r = json::Value::object();
	r.set("available", obs_source_get_display_name("wasapi_process_output_capture") != nullptr);
	r.set("apps", std::move(list));
	return r;
}

// ---- AU1 playback ----

std::vector<std::string> folder_playlist(const std::string &dir)
{
	static const std::set<std::string> ext = {".mp3", ".wav", ".ogg", ".opus", ".flac", ".m4a", ".aac", ".wma"};
	std::vector<std::string> out;
	std::error_code ec;
	for (auto it = fs::directory_iterator(fs::u8path(dir), ec); !ec && it != fs::directory_iterator(); it.increment(ec)) {
		if (!it->is_regular_file(ec))
			continue;
		std::string e = it->path().extension().u8string();
		std::transform(e.begin(), e.end(), e.begin(), [](unsigned char ch) { return (char)std::tolower(ch); });
		if (ext.count(e))
			out.push_back(it->path().generic_u8string());
		if (out.size() >= 500)
			break;
	}
	std::sort(out.begin(), out.end());
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

struct Playlist {
	obs_weak_source_t *weak = nullptr;
	std::vector<std::string> files;
	bool loop = true;
	size_t at = 0;
};
std::mutex g_pl_mutex;
std::map<obs_source_t *, std::shared_ptr<Playlist>> g_playlists;

void on_media_ended(void *, calldata_t *cd)
{
	obs_source_t *src = (obs_source_t *)calldata_ptr(cd, "source");
	std::shared_ptr<Playlist> pl;
	std::string next;
	{
		std::lock_guard<std::mutex> lk(g_pl_mutex);
		auto it = g_playlists.find(src);
		if (it == g_playlists.end())
			return;
		pl = it->second;
		if (pl->at + 1 >= pl->files.size() && !pl->loop)
			return; // the last file of a playlist that does not loop
		pl->at = (pl->at + 1) % pl->files.size();
		next = pl->files[pl->at];
	}
	// Not on the media thread that sent the signal: ffmpeg_source's update stops and joins that thread.
	obs_weak_source_t *w = pl->weak;
	obs_weak_source_addref(w);
	std::thread([w, next] {
		obs_source_t *s = obs_weak_source_get_source(w);
		obs_weak_source_release(w);
		if (!s)
			return;
		obs_data_t *d = obs_data_create();
		obs_data_set_string(d, "local_file", next.c_str());
		obs_source_update(s, d); // the same source: its filters, volume, tracks and mixer strip stay
		obs_data_release(d);
		obs_source_release(s);
	}).detach();
}

void on_destroy(void *, calldata_t *cd)
{
	obs_source_t *src = (obs_source_t *)calldata_ptr(cd, "source");
	std::shared_ptr<Playlist> pl;
	{
		std::lock_guard<std::mutex> lk(g_pl_mutex);
		auto it = g_playlists.find(src);
		if (it == g_playlists.end())
			return;
		pl = it->second;
		g_playlists.erase(it);
	}
	obs_weak_source_release(pl->weak);
}

} // namespace

void attach_playlist(obs_source_t *src, const std::vector<std::string> &files, bool loop)
{
	if (!src || files.size() < 2)
		return;
	auto pl = std::make_shared<Playlist>();
	pl->weak = obs_source_get_weak_source(src);
	pl->files = files;
	pl->loop = loop;
	{
		std::lock_guard<std::mutex> lk(g_pl_mutex);
		g_playlists[src] = pl;
	}
	signal_handler_t *sh = obs_source_get_signal_handler(src);
	signal_handler_connect(sh, "media_ended", on_media_ended, nullptr);
	signal_handler_connect(sh, "destroy", on_destroy, nullptr);
}

// ---- test hooks: levels after the filters ----

json::Value measure(obs_source_t *src, uint32_t skip_ms, uint32_t ms)
{
	struct Acc {
		std::mutex m;
		bool on = false;
		double peak = 0, sum = 0;
		uint64_t n = 0;
	} acc;
	auto cb = [](void *p, obs_source_t *, const struct audio_data *a, bool) {
		auto *x = static_cast<Acc *>(p);
		std::lock_guard<std::mutex> lk(x->m);
		if (!x->on || !a->data[0])
			return;
		const float *f = reinterpret_cast<const float *>(a->data[0]);
		for (uint32_t i = 0; i < a->frames; i++) {
			const double v = std::fabs((double)f[i]);
			x->peak = std::max(x->peak, v);
			x->sum += v * v;
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
	return r;
}

} // namespace audio_tools
