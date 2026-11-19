// SPDX-License-Identifier: GPL-3.0-or-later
// ujwalam-studio: the studio window, built in Qt Quick (D355; app/studio/qml). The only studio window since 2026-11-18,
// when the Qt Widgets window was removed.
// Started by the alpha launcher, which passes the UI server URL and its one-time launch key in the environment
// (UJWALAM_UI_URL, UJWALAM_UI_LAUNCH_KEY), never on argv. Both are read once and removed from the environment.
// Early start (2026-11-19): UJWALAM_STUDIO_EARLY=1 and no UJWALAM_UI_URL: started while the host starts; the URL's port
// comes later as the line "ui <port>" on the stdin pipe (see runQml). The key stays in the environment as before.
// Window rule (D316, replaces D219): a normal app window. It opens where Windows places it (the main display) and is
// activated when the user starts it. UJWALAM_HEADLESS=1 (tests): no window ever reaches the screen; it needs one of the
// two test modes below (anything else exits 64).
//   UJWALAM_STUDIO_PROBE_MS=N: the probe. The window is "shown" on the offscreen platform, the probe actions run, and
//     one line "studio probe: {json}" is printed at N ms or later (qml_studio.h).
//   UJWALAM_STUDIO_HIDDEN=1 (LU4 tests): a real native window that is never shown, so the host can embed its previews
//     into its hidden handles. UJWALAM_STUDIO_TEST_CLOSE_MS=N there: the user's close (exit 0) N ms after "ready", so a
//     test can check that a normal close still stops all; a file ujwalam-studio.test-close next to the exe (text: N)
//     does the same for that build only.
// LU4 studio swap (D346):
//   UJWALAM_STUDIO_CONTROL=1 (set by the launcher, which then gives a stdin pipe): one command per line on stdin.
//     "swap-close": close for an update (QmlStudio::swapClose, exit 75; no quit lock, the launcher keeps the host).
//     End of input is ignored (the launcher gone: the window stays, as before).
//   stdout lines the launcher waits for: "studio attach: ready" (logged in, window started) and
//     "studio attach: preview <h|v> embedded" (the host's preview sits in its slot again).
//   Headless only (tests): a file ujwalam-studio.test-crash next to the exe makes this build crash at start (its text
//     is the UJWALAM_STUDIO_TEST_CRASH kind), for the swap rollback test with a build that crashes.
#include "api_client.h"
#include "qml_studio.h"
#include "startup_clock.h"
#include "studio_log.h"
#include "taskbar_id.h"
#include "theme.h"

#include <QApplication>
#include <QElapsedTimer>
#include <QIcon>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QTimer>
#include <QUrl>
#include <algorithm>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#ifdef Q_OS_WIN
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

static QString takeEnv(const char *name)
{
	const QString v = qEnvironmentVariable(name);
	qunsetenv(name);
	return v;
}

#ifdef Q_OS_WIN
// Headless test builds only: the text of a marker file beside the exe, or empty (LU4 tests: ujwalam-studio.test-crash
// holds a crash kind, ujwalam-studio.test-close the ms after "ready" for a user close).
static QString testMarker(const wchar_t *name)
{
	wchar_t exe[MAX_PATH] = {};
	const DWORD n = GetModuleFileNameW(nullptr, exe, MAX_PATH);
	if (!n || n >= MAX_PATH)
		return QString();
	std::wstring f(exe, n);
	const size_t slash = f.find_last_of(L"\\/");
	f = (slash == std::wstring::npos ? std::wstring() : f.substr(0, slash + 1)) + name;
	HANDLE h = CreateFileW(f.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
	if (h == INVALID_HANDLE_VALUE)
		return QString();
	char buf[64] = {};
	DWORD got = 0;
	ReadFile(h, buf, sizeof(buf) - 1, &got, nullptr);
	CloseHandle(h);
	return QString::fromLatin1(buf, (int)got).trimmed();
}

// Reads the launcher's control lines from stdin on its own thread and hands each one to the Qt thread (LU4, D346).
// onEnd (optional): runs on the Qt thread once the input ends (the launcher gone). false: no stdin pipe.
static bool startControlReader(QApplication *app, std::function<void(const QString &)> onLine, std::function<void()> onEnd = {})
{
	HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
	if (in == nullptr || in == INVALID_HANDLE_VALUE || GetFileType(in) != FILE_TYPE_PIPE)
		return false;
	std::thread([in, app, onLine, onEnd]() {
		std::string line;
		char buf[256];
		DWORD got = 0;
		while (ReadFile(in, buf, sizeof(buf), &got, nullptr) && got > 0) {
			for (DWORD i = 0; i < got; i++) {
				if (buf[i] == '\n') {
					const QString l = QString::fromLatin1(line.data(), (int)line.size()).trimmed();
					line.clear();
					QMetaObject::invokeMethod(app, [onLine, l]() { onLine(l); }, Qt::QueuedConnection);
				} else if (line.size() < 200)
					line.push_back(buf[i]);
			}
		}
		if (onEnd)
			QMetaObject::invokeMethod(app, [onEnd]() { onEnd(); }, Qt::QueuedConnection);
	}).detach(); // end of input (the launcher gone) ends only this thread (and runs onEnd when given)
	return true;
}
#endif

// Logs in with the launcher's key and applies the saved theme and effects choice (settings.json ui.theme / ui.effects,
// D293) before any window shows, so it never flashes the default look; UJWALAM_THEME / UJWALAM_EFFECTS (tests) win.
// Then runs then(). A failed login exits 77. A server that does not answer yet (connection refused) is asked again every
// 100 ms for up to 10 s (early start, 2026-11-19); an answer that refuses the key is never retried.
static void loginThen(QApplication &app, ApiClient &api, const QString &key, int &code, std::function<void()> then, int triesLeft = 100)
{
	api.login(key, [&app, &api, &code, key, then, triesLeft](bool ok, const QJsonObject &, const QString &err) {
		if (!ok && triesLeft > 0 && err == QLatin1String(ApiClient::kNoAnswer)) {
			QTimer::singleShot(100, &app, [&app, &api, &code, key, then, triesLeft]() { loginThen(app, api, key, code, then, triesLeft - 1); });
			return;
		}
		startupclock::mark("login");
		if (!ok) {
			std::fprintf(stderr, "studio: login failed: %s\n", qPrintable(err));
			code = 77;
			QTimer::singleShot(0, &app, [&app]() { app.exit(77); });
			return;
		}
		api.get(QStringLiteral("ui/api/settings"), [then](bool okS, const QJsonObject &sb, const QString &) {
			startupclock::mark("settings");
			if (okS) {
				const QJsonObject ui = sb.value(QStringLiteral("settings")).toObject().value(QStringLiteral("ui")).toObject();
				if (qEnvironmentVariable("UJWALAM_THEME").isEmpty() && !ui.value(QStringLiteral("theme")).toString().isEmpty())
					theme::setCurrent(ui.value(QStringLiteral("theme")).toString());
				if (qEnvironmentVariable("UJWALAM_EFFECTS").isEmpty() && !ui.value(QStringLiteral("effects")).toString().isEmpty())
					theme::setEffects(ui.value(QStringLiteral("effects")).toString());
			}
			then();
		});
	});
}

// A probe action that types a secret into Settings > Connections (a test stream key, server address or app client ID,
// typed into a field the probe tree never lists) is listed in the probe line without its text: the probe output never
// holds what was typed. The action itself gets the whole text.
static QString shownProbeAction(const QString &a)
{
	for (const char *p : {"conn-key:", "conn-server:", "conn-twitch-client:"})
		if (a.startsWith(QLatin1String(p)))
			return QString::fromLatin1(p) + QStringLiteral("(hidden)");
	return a;
}

// The studio window for every mode: normal, hidden (LU4 tests) and probe (tests); the launcher's lines and the swap close.
static void afterReveal(QApplication &app, QmlStudio &studio, QmlStudio::Mode mode, int probeMs);

// early (UJWALAM_STUDIO_EARLY=1, 2026-11-19): started by the launcher while the host starts, before the UI server is
// up. Main.qml loads at once with nothing on screen (API requests wait for the login); the launcher's line
// "ui <port>" on stdin says the server listens; then the login, the saved theme and only then the window. No window
// is ever shown before that. End of input before the line (the launcher gone) exits 0.
static int runQml(QApplication &app, ApiClient &api, const QString &key, bool headless, bool hidden, bool early)
{
	QmlStudio studio(&api);
	int code = 0;
	const int probeMs = headless ? qEnvironmentVariableIntValue("UJWALAM_STUDIO_PROBE_MS") : 0;
	const QmlStudio::Mode mode = probeMs > 0 ? QmlStudio::Mode::Probe : hidden ? QmlStudio::Mode::Hidden : QmlStudio::Mode::Normal;
	bool loaded = false;
	auto fail = [&app, &code]() {
		code = 70;
		QTimer::singleShot(0, &app, [&app]() { app.exit(70); });
	};
	std::function<void()> afterLogin = [&]() {
		if (loaded)
			studio.reveal();
		else if (!studio.begin(mode))
			return fail();
		afterReveal(app, studio, mode, probeMs);
	};
	bool waiting = early;
#ifdef Q_OS_WIN
	const bool control = qEnvironmentVariable("UJWALAM_STUDIO_CONTROL") == QStringLiteral("1");
	if (control || early) {
		const bool piped = startControlReader(&app, [&](const QString &cmd) {
			if (cmd == QStringLiteral("swap-close") && control)
				studio.swapClose();
			static const QRegularExpression ui(QStringLiteral("^ui (\\d{1,5})$"));
			const QRegularExpressionMatch m = ui.match(cmd);
			if (waiting && m.hasMatch()) {
				waiting = false;
				if (!api.setBase(QUrl(QStringLiteral("http://127.0.0.1:%1/").arg(m.captured(1))))) {
					std::fprintf(stderr, "studio: bad UI server port from the launcher\n");
					code = 64;
					QTimer::singleShot(0, &app, [&app]() { app.exit(64); });
					return;
				}
				startupclock::mark("ui");
				loginThen(app, api, key, code, afterLogin);
			}
		}, [&]() {
			if (waiting) { // the launcher is gone before the UI server was up: nothing to show
				waiting = false;
				QTimer::singleShot(0, &app, [&app]() { app.exit(0); });
			}
		});
		if (early && !piped) {
			std::fprintf(stderr, "studio: UJWALAM_STUDIO_EARLY needs a stdin pipe from the launcher\n");
			return 64;
		}
	}
#else
	if (early) {
		std::fprintf(stderr, "studio: UJWALAM_STUDIO_EARLY is Windows only\n");
		return 64;
	}
#endif
	if (early) {
		api.holdUntilLogin();
		if (!studio.load(mode))
			return 70;
		loaded = true;
	} else
		loginThen(app, api, key, code, afterLogin);
	const int r = app.exec();
	qInfo("studio exiting with code %d", code ? code : r);
	return code ? code : r;
}

// After the window is placed: the probe's actions and its line (probe), the "ready" lines (hidden, normal).
static void afterReveal(QApplication &app, QmlStudio &studio, QmlStudio::Mode mode, int probeMs)
{
	{ // (the body of the old login callback, unchanged)
		if (mode == QmlStudio::Mode::Probe) {
			// Actions: the first at 2.5 s (after the first loads and a status poll), then 700 ms apart. Each one also waits
			// until no API request of the screens is on the way, and the probe is read at UJWALAM_STUDIO_PROBE_MS or later,
			// once every action ran (700 ms after the last) and the requests settled. Fixed times alone raced under load
			// (full CI, 2026-11-13): a page's first load or a Save's write was still on the way.
			// Read at the latest 15 s after UJWALAM_STUDIO_PROBE_MS (the tests stop the shell at 40 s), never after 60 s.
			struct Run {
				QStringList todo;
				QJsonArray actions;
				qint64 nextAt = 2500;
			};
			auto run = std::make_shared<Run>();
			for (const QString &a : qEnvironmentVariable("UJWALAM_STUDIO_PROBE_ACTIONS").split(QLatin1Char(','), Qt::SkipEmptyParts).mid(0, 60))
				run->todo.append(a.trimmed());
			const qint64 readAt = std::min(probeMs, 60000), lastAt = std::min<qint64>(readAt + 15000, 60000);
			auto clock = std::make_shared<QElapsedTimer>();
			clock->start();
			auto *tick = new QTimer(&app);
			tick->setInterval(50);
			QObject::connect(tick, &QTimer::timeout, &app, [&app, &studio, run, clock, tick, readAt, lastAt]() {
				const qint64 now = clock->elapsed();
				const bool idle = studio.probeIdle();
				if (!run->todo.isEmpty() && now < lastAt) {
					if (now >= run->nextAt && idle) {
						const QString a = run->todo.takeFirst();
						run->actions.append(QJsonObject{{QStringLiteral("action"), shownProbeAction(a)}, {QStringLiteral("done"), studio.probeAction(a)}});
						run->nextAt = clock->elapsed() + 700;
					}
					return;
				}
				if (now < lastAt && (now < readAt || now < run->nextAt || !idle))
					return;
				tick->stop();
				QJsonObject o = studio.probe();
				o.insert(QStringLiteral("actions"), run->actions);
#ifdef Q_OS_WIN
				o.insert(QStringLiteral("appUserModelId"), QString::fromStdWString(taskbarid::current())); // taskbar_id.h
#endif
				const QString shot = qEnvironmentVariable("UJWALAM_STUDIO_PROBE_SHOT");
				if (shot.endsWith(QStringLiteral(".png"), Qt::CaseInsensitive))
					o.insert(QStringLiteral("shot"), studio.shot(shot));
				std::printf("studio probe: %s\n", QJsonDocument(o).toJson(QJsonDocument::Compact).constData());
				std::fflush(stdout);
				app.exit(0);
			});
			tick->start();
			return;
		}
		if (mode == QmlStudio::Mode::Hidden) {
			std::printf("studio attach: ready (hidden)\n");
			std::fflush(stdout);
			// Tests: the user's close after this many ms (exit 0), to check that it still stops all (D280). The env var
			// reaches every window of a run; ujwalam-studio.test-close beside the exe (its text: the ms) only that build,
			// so a swap test can close the window on probation (Codex review of D346).
			int closeMs = qEnvironmentVariableIntValue("UJWALAM_STUDIO_TEST_CLOSE_MS");
#ifdef Q_OS_WIN
			if (closeMs <= 0)
				closeMs = testMarker(L"ujwalam-studio.test-close").toInt();
#endif
			if (closeMs > 0)
				QTimer::singleShot(closeMs, &app, [&studio]() { studio.close(); });
			return;
		}
		std::printf("studio attach: ready\n");
		std::fflush(stdout);
	}
}

int main(int argc, char **argv)
{
	startupclock::start(); // one "startup:" line in the studio log after the first frame and flags (startup_clock.h)
	const bool headless = qEnvironmentVariable("UJWALAM_HEADLESS") == QStringLiteral("1");
	const bool hidden = headless && qEnvironmentVariable("UJWALAM_STUDIO_HIDDEN") == QStringLiteral("1");
	const bool probe = headless && qEnvironmentVariableIntValue("UJWALAM_STUDIO_PROBE_MS") > 0;
	// Log file and crash report in <data dir>/logs when the launcher names it (studio_log.h, 2026-11-08 crash).
	const studiolog::Status logs = studiolog::install(qEnvironmentVariable("UJWALAM_STUDIO_VERSION", QStringLiteral("dev")));
	// Tests only: crash on purpose to prove the report is written. Never outside a headless run.
	if (headless && !qEnvironmentVariable("UJWALAM_STUDIO_TEST_CRASH").isEmpty()) {
		if (!logs.crash) {
			std::fprintf(stderr, "studio: UJWALAM_STUDIO_TEST_CRASH needs UJWALAM_STUDIO_LOG_DIR\n");
			return 65;
		}
		studiolog::testCrash(qEnvironmentVariable("UJWALAM_STUDIO_TEST_CRASH"));
		std::fprintf(stderr, "studio: unknown UJWALAM_STUDIO_TEST_CRASH kind\n");
		return 65;
	}
#ifdef Q_OS_WIN
	if (headless) { // a test build that crashes at start (LU4 swap rollback test)
		const QString kind = testMarker(L"ujwalam-studio.test-crash");
		if (!kind.isEmpty() && logs.crash) {
			std::printf("studio: test build crashing at start (%s)\n", qUtf8Printable(kind));
			std::fflush(stdout);
			studiolog::testCrash(kind);
		}
	}
#endif
	if (headless && !hidden && !probe) {
		std::fprintf(stderr, "studio: UJWALAM_HEADLESS=1 needs UJWALAM_STUDIO_PROBE_MS or UJWALAM_STUDIO_HIDDEN=1\n");
		return 64;
	}
#ifdef Q_OS_WIN
	// One taskbar button with the pinned shortcut (taskbar_id.h): before the first window.
	if (!taskbarid::applyProcess())
		std::fprintf(stderr, "studio: the taskbar id could not be set\n");
#endif
	// The probe "shows" its window so bindings and layouts run: always on the offscreen platform, never on a screen.
	if (probe)
		qputenv("QT_QPA_PLATFORM", "offscreen");
	QApplication app(argc, argv);
	startupclock::mark("app");
	if (logs.crash && !studiolog::reassert())
		qWarning("crash reporter: Qt start-up had replaced the unhandled-exception filter; ours is back on top");
	QApplication::setApplicationName(QStringLiteral("Ujwalam Studio"));
	{ // app icon for every window and dialog (res/png, embedded; the exe icon comes from res/ujwalam.rc)
		QIcon appIcon;
		for (const int n : {16, 24, 32, 48, 64, 256})
			appIcon.addFile(QStringLiteral(":/icon/ujwalam-%1.png").arg(n), QSize(n, n));
		QApplication::setWindowIcon(appIcon);
	}
	theme::apply(app);
	const QString url = takeEnv("UJWALAM_UI_URL");
	const QString key = takeEnv("UJWALAM_UI_LAUNCH_KEY");
	// Early start: no URL yet; the launcher sends the port on stdin once the UI server listens.
	const bool early = takeEnv("UJWALAM_STUDIO_EARLY") == QStringLiteral("1") && url.isEmpty();

	ApiClient api;
	if ((!early && !api.setBase(QUrl(url))) || key.size() < 32) {
		std::fprintf(stderr, "studio: start it from the launcher (npm run alpha -- --shell qt); no UI server URL or key\n");
		return 64;
	}
	return runQml(app, api, key, headless, hidden, early);
}
