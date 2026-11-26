// SPDX-License-Identifier: GPL-3.0-or-later
// Click diagnostics (2026-11-26, user report on alpha.48: "clicked Start - nothing, the UI freezes, job not started").
//
// The GUI-thread lag monitor (lag_monitor.h) showed no block while the user saw a freeze, and the task-control request
// never reached the UI server. These lines prove where a click dies on the user's laptop:
//   "click: win32 press ..."   Windows delivered the button message to a studio window (native event filter).
//   "click: qt press ..."      Qt turned it into a mouse event for a window (application event filter).
//   "click: no release ..."    a press whose release never came within 2 s (a lost grab or capture).
//   "click: capture ..."       at a press, the mouse capture of this thread's input state belongs to a window of another
//                              process (the host's embedded preview windows share the studio's input state).
//   "api: POST <route> ..."    a POST request sent, answered or failed, with the time it took (api_client.cpp).
// Win32 press without a Qt press: Qt dropped it. No win32 press at all: Windows never delivered it to the studio.
// Text only: window object names, class names, routes and times. No tokens, no bodies, no chat text, no titles.
// Rate limited: at most kBurst lines per kWindowMs per kind; the count left out is reported on the next line.
#pragma once

#include <QAbstractNativeEventFilter>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QEvent>
#include <QMouseEvent>
#include <QObject>
#include <QPointer>
#include <QString>
#include <QTimer>
#include <QWindow>

#ifdef Q_OS_WIN
#ifndef NOMINMAX
#define NOMINMAX // std::min / std::max in the files that include this
#endif
#include <windows.h>
#endif

namespace clickdiag {

constexpr int kBurst = 30;
constexpr qint64 kWindowMs = 60000;
constexpr qint64 kNoReleaseMs = 2000;

inline qint64 now()
{
	static QElapsedTimer t;
	if (!t.isValid())
		t.start();
	return t.elapsed();
}

// A per-kind token window. Returns false when the line is to be left out; *dropped gets the count left out before it.
struct Limit {
	qint64 since = -1;
	int used = 0, dropped = 0;
	bool take(int *droppedBefore)
	{
		const qint64 t = now();
		if (since < 0 || t - since >= kWindowMs) {
			since = t;
			used = 0;
		}
		if (used >= kBurst) {
			dropped++;
			return false;
		}
		used++;
		*droppedBefore = dropped;
		dropped = 0;
		return true;
	}
};

inline Limit &limit(int kind)
{
	static Limit l[4];
	return l[kind & 3];
}
enum Kind { Native = 0, Qt = 1, Api = 2, Other = 3 };

inline void line(Kind k, const QString &text)
{
	int dropped = 0;
	if (!limit(k).take(&dropped))
		return;
	if (dropped)
		qInfo("%s (%d similar lines left out)", qUtf8Printable(text), dropped);
	else
		qInfo("%s", qUtf8Printable(text));
}

inline QString nameOf(const QObject *o)
{
	if (!o)
		return QStringLiteral("?");
	const QString n = o->objectName();
	const QString c = QLatin1String(o->metaObject()->className());
	return n.isEmpty() ? c : n + QStringLiteral(" (") + c + QStringLiteral(")");
}

#ifdef Q_OS_WIN
inline QString hwndText(HWND h)
{
	if (!h)
		return QStringLiteral("none");
	wchar_t cls[64] = {};
	GetClassNameW(h, cls, 63);
	DWORD pid = 0;
	GetWindowThreadProcessId(h, &pid);
	return QStringLiteral("0x%1 %2%3")
		.arg(quintptr(h), 0, 16)
		.arg(QString::fromWCharArray(cls))
		.arg(pid == GetCurrentProcessId() ? QString() : QStringLiteral(" other-process"));
}

// At a press: who holds capture, focus and activation in this thread's input state. A capture or active window in another
// process means the input state is shared with that process (attached input queues).
inline void inputState(const char *at)
{
	GUITHREADINFO gi = {sizeof(gi)};
	if (!GetGUIThreadInfo(GetCurrentThreadId(), &gi))
		return;
	auto foreign = [](HWND h) {
		DWORD pid = 0;
		return h && GetWindowThreadProcessId(h, &pid) && pid != GetCurrentProcessId();
	};
	if (foreign(gi.hwndCapture) || foreign(gi.hwndActive) || foreign(gi.hwndFocus))
		line(Other, QStringLiteral("click: capture/focus at %1 held outside the studio: capture %2, active %3, focus %4")
				    .arg(QLatin1String(at), hwndText(gi.hwndCapture), hwndText(gi.hwndActive), hwndText(gi.hwndFocus)));
}
#endif

class Filter : public QObject, public QAbstractNativeEventFilter {
public:
	explicit Filter(QObject *parent) : QObject(parent) {}

	bool eventFilter(QObject *o, QEvent *e) override
	{
		const QEvent::Type t = e->type();
		if ((t == QEvent::MouseButtonPress || t == QEvent::MouseButtonRelease) && o && o->isWindowType()) {
			const auto *me = static_cast<QMouseEvent *>(e);
			const bool press = t == QEvent::MouseButtonPress;
			line(Qt, QStringLiteral("click: qt %1 %2 button %3 in %4")
					 .arg(press ? QStringLiteral("press") : QStringLiteral("release"))
					 .arg(nameOf(o))
					 .arg(int(me->button()))
					 .arg(nameOf(static_cast<QWindow *>(o)->focusObject())));
			if (press) {
				const int seq = ++pressSeq_;
				const QString who = nameOf(o);
				const qint64 at = now();
				QTimer::singleShot(kNoReleaseMs, this, [this, seq, who, at]() {
					if (releasedSeq_ < seq)
						line(Other, QStringLiteral("click: no release %1 ms after the press in %2").arg(now() - at).arg(who));
				});
			} else
				releasedSeq_ = pressSeq_;
		}
		return false;
	}

	bool nativeEventFilter(const QByteArray &type, void *message, qintptr *) override
	{
#ifdef Q_OS_WIN
		if (type != "windows_generic_MSG")
			return false;
		const MSG *m = static_cast<const MSG *>(message);
		const char *what = nullptr;
		switch (m->message) {
		case WM_LBUTTONDOWN: what = "press left"; break;
		case WM_LBUTTONUP: what = "release left"; break;
		case WM_RBUTTONDOWN: what = "press right"; break;
		case WM_NCLBUTTONDOWN: what = "press frame"; break;
		default: return false;
		}
		line(Native, QStringLiteral("click: win32 %1 %2").arg(QLatin1String(what), hwndText(m->hwnd)));
		if (m->message != WM_LBUTTONUP)
			inputState(what);
#else
		Q_UNUSED(type);
		Q_UNUSED(message);
#endif
		return false;
	}

private:
	int pressSeq_ = 0, releasedSeq_ = 0;
};

// Installs both filters once (GUI thread, after the application exists). UJWALAM_CLICK_DIAG=0 turns them off.
inline void start()
{
	static bool started = false;
	if (started || qEnvironmentVariable("UJWALAM_CLICK_DIAG") == QStringLiteral("0") || !QCoreApplication::instance())
		return;
	started = true;
	auto *f = new Filter(QCoreApplication::instance());
	QCoreApplication::instance()->installEventFilter(f);
	QCoreApplication::instance()->installNativeEventFilter(f);
	qInfo("click: diagnostics on (presses, releases, POST requests; rate limited)");
}

} // namespace clickdiag
