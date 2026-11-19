// SPDX-License-Identifier: GPL-3.0-or-later
// Start-up clock (2026-11-19, start-up time): monotonic marks for each host start phase, logged once as
//   startup: main 30, obs-startup 80, video 700, audio 710, modules 2100, obs 2150, overlay 2600, ready 3100 ms since
//   the host process started
// (the launcher and the studio print the same kind of line; services/studio-ui/startup-clock.mjs parses all three).
// Cumulative from the process creation time, so the exe and DLL load before main() is counted too.
#pragma once
#include "log.h"

#include <chrono>
#include <string>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace startupclock {
struct State {
	std::chrono::steady_clock::time_point t0{};
	long long base = 0; // ms from process creation to start()
	std::string marks;
	bool started = false, logged = false;
};
inline State &state()
{
	static State s;
	return s;
}
inline void start()
{
	State &s = state();
	s.t0 = std::chrono::steady_clock::now();
	s.started = true;
	FILETIME created, exited, kernel, user, now;
	if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {
		GetSystemTimePreciseAsFileTime(&now);
		const auto v = [](const FILETIME &f) { return ((long long)f.dwHighDateTime << 32) | f.dwLowDateTime; };
		const long long d = (v(now) - v(created)) / 10000;
		if (d >= 0 && d < 600000)
			s.base = d;
	}
}
inline void mark(const char *name)
{
	State &s = state();
	if (!s.started || s.logged)
		return;
	const long long ms =
		s.base + std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - s.t0).count();
	if (!s.marks.empty())
		s.marks += ", ";
	s.marks += std::string(name) + " " + std::to_string(ms);
}
inline void finish(const char *name)
{
	State &s = state();
	if (!s.started || s.logged)
		return;
	mark(name);
	s.logged = true;
	hlog::info("startup: %s ms since the host process started", s.marks.c_str());
}
} // namespace startupclock
