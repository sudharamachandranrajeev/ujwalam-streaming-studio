// SPDX-License-Identifier: GPL-3.0-or-later
#include "motion.h"
#include "theme.h"

#include <QVariantAnimation>
#include <QWidget>

#ifdef Q_OS_WIN
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace motion {

namespace {
QString g_mode = QStringLiteral("system");
}

void setMode(const QString &m)
{
	g_mode = (m == QStringLiteral("on") || m == QStringLiteral("off")) ? m : QStringLiteral("system");
}

QString mode()
{
	return g_mode;
}

bool systemAnimations()
{
	// UJWALAM_REDUCE_MOTION=1 turns motion off; =0 turns it on even when Windows has animation effects off.
	const QString env = qEnvironmentVariable("UJWALAM_REDUCE_MOTION");
	if (env == QStringLiteral("1"))
		return false;
	if (env == QStringLiteral("0"))
		return true;
	if (theme::performance()) // High performance (2026-11-10): no animation at all
		return false;
	if (g_mode == QStringLiteral("off"))
		return false;
	if (g_mode == QStringLiteral("on"))
		return true;
#ifdef Q_OS_WIN
	BOOL on = TRUE;
	if (SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION, 0, &on, 0))
		return on != FALSE;
#endif
	return true;
}

bool enabled(const QWidget *w)
{
	return w && w->isVisible() && systemAnimations();
}

QVariantAnimation *run(QWidget *context, const QVariant &from, const QVariant &to, int ms, QEasingCurve::Type curve,
		       std::function<void(const QVariant &)> step, std::function<void()> done)
{
	if (!enabled(context) || ms <= 0) {
		step(to);
		if (done)
			done();
		return nullptr;
	}
	auto *a = new QVariantAnimation(context);
	a->setStartValue(from);
	a->setEndValue(to);
	// The call sites ask for the studio's standard timing (OutCubic, 180 ms); the theme pack decides what that means
	// (D293): its normal duration and its easing replace them, other durations scale with them.
	a->setDuration(curve == QEasingCurve::OutCubic ? int(ms * (theme::duration(QStringLiteral("normal")) / 180.0) + 0.5) : ms);
	a->setEasingCurve(curve == QEasingCurve::OutCubic ? theme::easing() : curve);
	QObject::connect(a, &QVariantAnimation::valueChanged, context, [step](const QVariant &v) { step(v); });
	QObject::connect(a, &QVariantAnimation::finished, context, [a, done]() {
		if (done)
			done();
		a->deleteLater();
	});
	a->start();
	return a;
}

} // namespace motion
