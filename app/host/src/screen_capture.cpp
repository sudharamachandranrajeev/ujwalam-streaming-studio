// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-host: screen and window capture targets. See screen_capture.h.
#include "screen_capture.h"
#include "log.h"
#include "rpc_server.h"

#include <obs.h>

#include <regex>
#include <string>

namespace screencap {

bool available()
{
	return obs_source_get_display_name("monitor_capture") != nullptr &&
	       obs_source_get_display_name("window_capture") != nullptr;
}

bool valid_display_id(const std::string &s)
{
	if (s.empty() || s.size() > 127)
		return false;
	for (unsigned char ch : s)
		if (ch < 0x20 || ch > 0x7e)
			return false;
	return true;
}

bool valid_window_spec(const std::string &s)
{
	if (s.empty() || s.size() > 1024)
		return false;
	for (unsigned char ch : s)
		if (ch < 0x20 || ch == 0x7f)
			return false;
	size_t a = s.find(':');
	size_t b = a == std::string::npos ? a : s.find(':', a + 1);
	if (b == std::string::npos || s.find(':', b + 1) != std::string::npos)
		return false;
	return b + 1 < s.size(); // exe not empty
}

int window_priority(const std::string &m)
{
	if (m == "class")
		return 0; // WINDOW_PRIORITY_CLASS
	if (m == "title")
		return 1; // WINDOW_PRIORITY_TITLE
	if (m == "exe")
		return 2; // WINDOW_PRIORITY_EXE
	return -1;
}

// The string items of list property `name` as (label, value); disabled placeholder items are left out.
template <class F> static void each_item(obs_properties_t *props, const char *name, F f)
{
	obs_property_t *p = props ? obs_properties_get(props, name) : nullptr;
	if (!p || obs_property_list_format(p) != OBS_COMBO_FORMAT_STRING)
		return;
	size_t n = obs_property_list_item_count(p);
	for (size_t i = 0; i < n; i++) {
		if (obs_property_list_item_disabled(p, i))
			continue;
		const char *label = obs_property_list_item_name(p, i);
		const char *value = obs_property_list_item_string(p, i);
		if (value && *value)
			f(std::string(label ? label : ""), std::string(value));
	}
}

json::Value list_targets()
{
	if (!available())
		throw rpc::Error(rpc::UNAVAILABLE, "screen and window capture are not available (the win-capture module is not "
						   "loaded; the host starts it only with --allow-screen-capture)");
	json::Value displays = json::Value::array();
	json::Value windows = json::Value::array();

	obs_properties_t *mp = obs_get_source_properties("monitor_capture");
	static const std::regex size_re("([0-9]{1,5})x([0-9]{1,5}) @ ");
	each_item(mp, "monitor_id", [&](const std::string &label, const std::string &value) {
		if (value == "DUMMY" || !valid_display_id(value)) // an id a screen layer could not take is not offered
			return;
		json::Value d = json::Value::object();
		d.set("id", value);
		d.set("name", label);
		std::smatch m;
		int64_t w = 0, h = 0;
		if (std::regex_search(label, m, size_re)) {
			w = std::stoll(m[1].str());
			h = std::stoll(m[2].str());
		}
		d.set("width", w);
		d.set("height", h);
		displays.push(std::move(d));
	});
	obs_properties_destroy(mp);

	obs_properties_t *wp = obs_get_source_properties("window_capture");
	each_item(wp, "window", [&](const std::string &label, const std::string &value) {
		if (!valid_window_spec(value))
			return;
		// label "[exe]: title" (ms_fill_window_list)
		std::string exe, title = label;
		if (label.size() > 1 && label[0] == '[') {
			size_t e = label.find("]: ");
			if (e != std::string::npos) {
				exe = label.substr(1, e - 1);
				title = label.substr(e + 3);
			}
		}
		json::Value w = json::Value::object();
		w.set("id", value);
		w.set("title", title);
		w.set("exe", exe);
		windows.push(std::move(w));
	});
	obs_properties_destroy(wp);

	hlog::info("capture.listTargets: %zu displays, %zu windows", displays.size(), windows.size()); // counts only
	json::Value r = json::Value::object();
	r.set("displays", std::move(displays));
	r.set("windows", std::move(windows));
	return r;
}

} // namespace screencap
