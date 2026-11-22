// SPDX-License-Identifier: GPL-3.0-or-later
// GUI-thread lag monitor (D432). A 16 ms timer on the GUI thread measures how late each tick comes: a late tick means
// the event loop was blocked (a long QML callback, a page being built, a big binding pass). Work that may block marks
// itself (lagmon::Scope: the API reply callbacks, the probe actions), so a gap names what ran in it. Gaps of 250 ms or
// more go to the studio log with those names, so a freeze on the user's laptop leaves a measured line; the probe line
// carries the whole report (tests: an event-loop lag budget).
#pragma once

#include <QCoreApplication>
#include <QElapsedTimer>
#include <QEvent>
#include <QQmlContext>
#include <QUrl>
#include <QtQml/qqml.h>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QTimer>
#include <algorithm>
#include <vector>

namespace lagmon {

struct Mark {
	qint64 start = 0, end = 0; // ms on the monitor's clock
	QString what;
};

struct Work {
	int count = 0;
	double totalMs = 0, maxMs = 0;
};

struct State {
	QElapsedTimer clock;
	qint64 lastTick = -1;
	qint64 maxGap = 0;
	int over50 = 0, over100 = 0, over250 = 0, over1000 = 0;
	QJsonArray worst;           // up to 12 of the largest gaps
	std::vector<Mark> recent;   // a ring of the last marks (what ran)
	QHash<QString, Work> work;  // per mark name: count, total and largest time
	bool started = false;
};

inline State &state()
{
	static State s;
	return s;
}

inline qint64 now()
{
	State &s = state();
	if (!s.clock.isValid())
		s.clock.start();
	return s.clock.elapsed();
}

// The marks that overlap [from, to], longest first, as "name 123ms".
inline QString during(qint64 from, qint64 to)
{
	std::vector<Mark> hit;
	for (const Mark &m : state().recent)
		if (m.end >= from && m.start <= to)
			hit.push_back(m);
	std::sort(hit.begin(), hit.end(), [](const Mark &a, const Mark &b) { return (a.end - a.start) > (b.end - b.start); });
	QStringList parts;
	for (size_t i = 0; i < hit.size() && i < 4; ++i)
		parts << QStringLiteral("%1 %2ms").arg(hit[i].what).arg(hit[i].end - hit[i].start);
	return parts.isEmpty() ? QStringLiteral("(no marked work: bindings, layout, paint or timers)") : parts.join(QStringLiteral(", "));
}

inline void record(const QString &what, qint64 start, qint64 end)
{
	State &s = state();
	s.recent.push_back({start, end, what});
	if (s.recent.size() > 48)
		s.recent.erase(s.recent.begin(), s.recent.begin() + 16);
	Work &w = s.work[what];
	w.count++;
	const double ms = double(end - start);
	w.totalMs += ms;
	w.maxMs = std::max(w.maxMs, ms);
}

// A piece of GUI-thread work, timed from construction to destruction.
class Scope {
public:
	explicit Scope(QString what) : what_(std::move(what)), start_(now()) {}
	~Scope() { record(what_, start_, now()); }
	Scope(const Scope &) = delete;
	Scope &operator=(const Scope &) = delete;

private:
	QString what_;
	qint64 start_;
};

// The outermost event the GUI thread delivers, timed (TimedApplication::notify): a gap with no other mark is named by
// the event that held the thread ("event UpdateRequest QQuickWindowQmlImpl": polish, sync and render of a frame;
// "event MetaCall ..." a queued call; "event Timer ..." a timer, which includes QML Timer handlers).
inline int &depth()
{
	static int d = 0;
	return d;
}

template <class Base>
class TimedApplication : public Base {
public:
	using Base::Base;
	bool notify(QObject *receiver, QEvent *e) override
	{
		if (depth() > 0 || !state().started)
			return Base::notify(receiver, e);
		depth()++;
		const qint64 t0 = now();
		const bool r = Base::notify(receiver, e);
		const qint64 t1 = now();
		depth()--;
		if (t1 - t0 >= 20) {
			const char *cls = receiver ? receiver->metaObject()->className() : "?";
			// a QML object (a Timer, a popup window) also names its file
			const QQmlContext *ctx = receiver ? qmlContext(receiver) : nullptr;
			const QString file = ctx ? ctx->baseUrl().fileName() : QString();
			record(QStringLiteral("event %1 %2%3").arg(int(e->type())).arg(QLatin1String(cls), file.isEmpty() ? QString() : QStringLiteral(" ") + file), t0, t1);
		}
		return r;
	}
};

inline void tick()
{
	State &s = state();
	const qint64 t = now();
	if (s.lastTick >= 0) {
		const qint64 gap = t - s.lastTick - 16; // the interval itself is not lag
		if (gap > 50) {
			s.over50++;
			if (gap > 100)
				s.over100++;
			if (gap > 250)
				s.over250++;
			if (gap > 1000)
				s.over1000++;
			s.maxGap = std::max(s.maxGap, gap);
			const QString what = during(s.lastTick, t);
			if (gap > 100) {
				QJsonObject g{{QStringLiteral("at"), double(s.lastTick)}, {QStringLiteral("ms"), double(gap)}, {QStringLiteral("what"), what}};
				s.worst.append(g);
				// keep the 12 largest
				if (s.worst.size() > 12) {
					int least = 0;
					for (int i = 1; i < s.worst.size(); ++i)
						if (s.worst[i].toObject().value(QStringLiteral("ms")).toDouble() < s.worst[least].toObject().value(QStringLiteral("ms")).toDouble())
							least = i;
					s.worst.removeAt(least);
				}
			}
			if (gap >= 250)
				qWarning("studio: GUI thread blocked %lld ms (%s)", gap, qUtf8Printable(what));
		}
	}
	s.lastTick = now();
}

// Starts the monitor once (the GUI thread, after the QApplication exists). UJWALAM_LAG_MONITOR=0 turns it off.
inline void start()
{
	State &s = state();
	if (s.started || qEnvironmentVariable("UJWALAM_LAG_MONITOR") == QStringLiteral("0"))
		return;
	s.started = true;
	now();
	auto *t = new QTimer(QCoreApplication::instance());
	t->setTimerType(Qt::PreciseTimer);
	t->setInterval(16);
	QObject::connect(t, &QTimer::timeout, t, &tick);
	t->start();
}

inline QJsonObject report()
{
	State &s = state();
	QJsonObject work;
	for (auto it = s.work.cbegin(); it != s.work.cend(); ++it)
		if (it->maxMs >= 5)
			work.insert(it.key(), QJsonObject{{QStringLiteral("n"), it->count}, {QStringLiteral("totalMs"), it->totalMs}, {QStringLiteral("maxMs"), it->maxMs}});
	return {{QStringLiteral("on"), s.started},  {QStringLiteral("maxGapMs"), double(s.maxGap)}, {QStringLiteral("over50"), s.over50},
		{QStringLiteral("over100"), s.over100}, {QStringLiteral("over250"), s.over250},        {QStringLiteral("over1000"), s.over1000},
		{QStringLiteral("worst"), s.worst},     {QStringLiteral("work"), work}};
}

} // namespace lagmon
