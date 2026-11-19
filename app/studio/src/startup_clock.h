// SPDX-License-Identifier: GPL-3.0-or-later
// Start-up clock (2026-11-19, start-up time): monotonic marks for each studio start phase, logged once as
//   startup: app 50, login 85, settings 90, engine 90, qml 1050, shown 1210, frame 1450, status 1500, flags 1520 ms since
//   the studio process started
// (the launcher and the host print the same kind of line; services/studio-ui/startup-clock.mjs parses all three).
// Times are cumulative from the process creation time (Windows), so the exe and DLL load before main() is counted too.
#pragma once
#include <QElapsedTimer>
#include <QString>
#include <QStringList>
#include <QtGlobal>
#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#endif

namespace startupclock {
struct State {
	QElapsedTimer t;
	qint64 base = 0; // ms from process creation to t.start()
	QStringList marks, seen;
	int ends = 0;
	bool logged = false;
};
inline State &state()
{
	static State s;
	return s;
}
// First call in main(): starts the clock and measures how long the process ran before it.
inline void start()
{
	State &s = state();
	s.t.start();
#ifdef Q_OS_WIN
	FILETIME created, exited, kernel, user, now;
	if (GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) {
		GetSystemTimePreciseAsFileTime(&now);
		const auto v = [](const FILETIME &f) { return (qint64(f.dwHighDateTime) << 32) | f.dwLowDateTime; };
		const qint64 d = (v(now) - v(created)) / 10000; // 100 ns units to ms
		if (d >= 0 && d < 600000)
			s.base = d;
	}
#endif
}
inline void mark(const char *name)
{
	State &s = state();
	if (!s.logged && s.t.isValid())
		s.marks.append(QStringLiteral("%1 %2").arg(QLatin1String(name)).arg(s.base + s.t.elapsed()));
}
// A last mark: the line is written once both ends are in (the first frame on screen and the first flags answer, which
// follows the first status answer), whichever comes later (once per process).
inline void finish(const char *name)
{
	State &s = state();
	if (s.logged || !s.t.isValid())
		return;
	mark(name);
	if (++s.ends < 2)
		return;
	s.logged = true;
	qInfo("startup: %s ms since the studio process started", qPrintable(s.marks.join(QStringLiteral(", "))));
}
// The first time only (a poll repeats every 2 s).
inline bool once(const char *name)
{
	State &s = state();
	const QString n = QLatin1String(name);
	if (s.seen.contains(n))
		return false;
	s.seen.append(n);
	return true;
}
inline void markOnce(const char *name)
{
	if (once(name))
		mark(name);
}
inline void finishOnce(const char *name)
{
	if (once(name))
		finish(name);
}
} // namespace startupclock
