// SPDX-License-Identifier: GPL-3.0-or-later
#include "taskbar.h"
#include "motion.h"
#include "theme.h"

#include <QPainter>
#include <QPointer>
#include <QVariantAnimation>
#include <algorithm>
#include <cmath>

namespace {
QColor stateColour(const QString &s)
{
	if (s == QStringLiteral("done"))
		return theme::color(QStringLiteral("ok"));
	if (s == QStringLiteral("failed"))
		return theme::color(QStringLiteral("danger"));
	if (s == QStringLiteral("waiting"))
		return theme::color(QStringLiteral("muted"));
	return theme::color(QStringLiteral("accent"));
}
QString str(const QJsonObject &t, const char *k)
{
	return t.value(QLatin1String(k)).toString();
}
bool isRunning(const QJsonObject &t)
{
	return str(t, "state") == QStringLiteral("running");
}
QString plural(const QString &unit)
{
	if (unit == QStringLiteral("MB"))
		return unit;
	if (unit.endsWith(QLatin1Char('s')) || unit.endsWith(QStringLiteral("ch")))
		return unit + QStringLiteral("es");
	return unit + QLatin1Char('s');
}
} // namespace

// ---- tasktime ----

double tasktime::fraction(const QJsonObject &t)
{
	if (str(t, "state") == QStringLiteral("done"))
		return 1.0;
	if (t.value(QStringLiteral("measured")) == QJsonValue(false)) // a step that reports no progress (publish, montage)
		return -1.0;
	const QJsonValue p = t.value(QStringLiteral("progress"));
	if (p.isDouble())
		return std::clamp(p.toDouble(), 0.0, 1.0);
	const double total = t.value(QStringLiteral("total")).toDouble(-1);
	if (total <= 0 || t.value(QStringLiteral("done")).isNull())
		return -1.0;
	return std::clamp(t.value(QStringLiteral("done")).toDouble() / total, 0.0, 1.0);
}

QString tasktime::duration(double ms)
{
	const qint64 s = qint64(std::max(0.0, ms) / 1000.0);
	const qint64 h = s / 3600, m = (s % 3600) / 60, sec = s % 60;
	if (h > 0)
		return QStringLiteral("%1:%2:%3").arg(h).arg(m, 2, 10, QLatin1Char('0')).arg(sec, 2, 10, QLatin1Char('0'));
	return QStringLiteral("%1:%2").arg(m).arg(sec, 2, 10, QLatin1Char('0'));
}

QString tasktime::ago(double ms)
{
	const qint64 s = qint64(std::max(0.0, ms) / 1000.0);
	if (s < 60)
		return QStringLiteral("%1 s").arg(s);
	if (s < 3600)
		return QStringLiteral("%1 min").arg(s / 60);
	return QStringLiteral("%1 h %2 min").arg(s / 3600).arg((s % 3600) / 60);
}

namespace {
// "about 4 min left" / "less than a minute left" from etaMs, or empty when unknown.
QString leftText(const QJsonObject &t)
{
	const QJsonValue eta = t.value(QStringLiteral("etaMs"));
	if (!eta.isDouble())
		return QString();
	const double sec = eta.toDouble() / 1000.0;
	if (sec < 60)
		return QStringLiteral("less than a minute left");
	if (sec < 3600)
		return QStringLiteral("about %1 min left").arg(qint64(std::ceil(sec / 60.0)));
	return QStringLiteral("about %1 h %2 min left").arg(qint64(sec / 3600)).arg(qint64(std::fmod(sec, 3600.0) / 60.0));
}
} // namespace

QString tasktime::text(const QJsonObject &t)
{
	const QString st = str(t, "state");
	const QJsonValue el = t.value(QStringLiteral("elapsedMs"));
	QString out = el.isDouble() ? QStringLiteral("%1 elapsed").arg(duration(el.toDouble())) : QString();
	if (st == QStringLiteral("done") || st == QStringLiteral("failed"))
		return el.isDouble() ? QStringLiteral("took %1").arg(duration(el.toDouble())) : QString();
	QString left;
	if (st == QStringLiteral("waiting"))
		left = QStringLiteral("waiting its turn");
	else {
		const QString l = leftText(t);
		if (!l.isEmpty())
			left = (str(t, "stage").isEmpty() ? QString() : QStringLiteral("this step: ")) + l;
		else // never a guessed number: the rate is being measured, or the amount of work is not known
			left = fraction(t) >= 0 ? QStringLiteral("estimating time left") : QStringLiteral("time left unknown");
		if (t.value(QStringLiteral("stalled")).toBool(false))
			left += QStringLiteral(" · no progress for %1").arg(ago(t.value(QStringLiteral("silentMs")).toDouble()));
	}
	return out.isEmpty() ? left : out + QStringLiteral(" · ") + left;
}

QString tasktime::stageLine(const QJsonObject &t)
{
	if (!isRunning(t))
		return QString();
	QString words = str(t, "stageText");
	if (words.isEmpty())
		words = QStringLiteral("Working");
	const QJsonObject step = t.value(QStringLiteral("step")).toObject();
	const int i = step.value(QStringLiteral("index")).toInt(0), n = step.value(QStringLiteral("count")).toInt(0);
	if (i > 0 && n > 1)
		return QStringLiteral("Step %1 of %2: %3").arg(i).arg(n).arg(words);
	return words;
}

QString tasktime::countLine(const QJsonObject &t)
{
	if (!isRunning(t))
		return QString();
	const double f = fraction(t);
	if (f < 0)
		return QStringLiteral("Working; how much is left is not known for this step");
	const int pct = int(std::floor(f * 100));
	const QString unit = str(t, "unit");
	const QJsonValue d = t.value(QStringLiteral("done")), n = t.value(QStringLiteral("total"));
	if (unit.isEmpty() || !d.isDouble() || !n.isDouble())
		return QStringLiteral("%1% done").arg(pct);
	return QStringLiteral("%1 of %2 %3 (%4%)").arg(qint64(d.toDouble())).arg(qint64(n.toDouble())).arg(plural(unit)).arg(pct);
}

QString tasktime::etaLine(const QJsonObject &t)
{
	const QString st = str(t, "state");
	const QJsonValue el = t.value(QStringLiteral("elapsedMs"));
	const QString elapsed = el.isDouble() ? QStringLiteral("Elapsed %1").arg(duration(el.toDouble())) : QString();
	QString left;
	if (st == QStringLiteral("done") || st == QStringLiteral("failed"))
		return el.isDouble() ? QStringLiteral("Took %1").arg(duration(el.toDouble())) : QString();
	if (st == QStringLiteral("waiting"))
		left = QStringLiteral("Waiting its turn");
	else {
		QString l = leftText(t);
		if (!l.isEmpty()) {
			l[0] = l[0].toUpper();
			left = str(t, "stage").isEmpty() ? l : l + QStringLiteral(" in this step");
		} else
			left = fraction(t) >= 0 ? QStringLiteral("Estimating time left...") : QStringLiteral("Time left unknown");
	}
	return elapsed.isEmpty() ? left : elapsed + QStringLiteral(" · ") + left;
}

QString tasktime::lastLine(const QJsonObject &t)
{
	if (!isRunning(t))
		return QString();
	const QJsonValue s = t.value(QStringLiteral("silentMs"));
	if (!s.isDouble())
		return QString();
	if (t.value(QStringLiteral("progressAt")).isDouble())
		return QStringLiteral("Last progress %1 ago").arg(ago(s.toDouble()));
	return QStringLiteral("No progress yet (started %1 ago)").arg(ago(s.toDouble()));
}

QString tasktime::stallLine(const QJsonObject &t)
{
	if (!isRunning(t) || !t.value(QStringLiteral("stalled")).toBool(false))
		return QString();
	return QStringLiteral("No progress for %1 - it may be stuck").arg(ago(t.value(QStringLiteral("silentMs")).toDouble()));
}

// ---- SmoothBar ----

SmoothBar::SmoothBar(int height, QWidget *parent) : QWidget(parent), h_(height)
{
	setFixedHeight(height);
	setAttribute(Qt::WA_TransparentForMouseEvents);
}

void SmoothBar::setProgress(const QString &state, double fraction)
{
	state_ = state;
	indeterminate_ = fraction < 0 && state == QStringLiteral("running");
	target_ = fraction < 0 ? 0.0 : fraction;
	if (glide_) { // still gliding (a QPointer: null once the animation ended and deleted itself)
		glide_->stop();
		glide_->deleteLater();
	}
	glide_ = motion::run(this, value_, target_, 220, QEasingCurve::OutCubic, [this](const QVariant &v) {
		value_ = v.toDouble();
		update();
	});
	sync();
	update();
}

void SmoothBar::sync()
{
	const bool want = indeterminate_ && isVisible() && motion::systemAnimations();
	if (want && !sweep_) {
		sweep_ = new QVariantAnimation(this);
		sweep_->setStartValue(0.0);
		sweep_->setEndValue(1.0);
		sweep_->setDuration(1400);
		sweep_->setLoopCount(-1);
		sweep_->setEasingCurve(QEasingCurve::InOutSine);
		connect(sweep_, &QVariantAnimation::valueChanged, this, [this](const QVariant &v) {
			phase_ = v.toDouble();
			update();
		});
		sweep_->start();
	} else if (!want && sweep_) {
		sweep_->stop();
		sweep_->deleteLater();
		sweep_ = nullptr;
	}
}

void SmoothBar::showEvent(QShowEvent *)
{
	sync();
}
void SmoothBar::hideEvent(QHideEvent *)
{
	sync();
}

void SmoothBar::paintEvent(QPaintEvent *)
{
	QPainter p(this);
	p.setRenderHint(QPainter::Antialiasing);
	const QRectF r(rect());
	const qreal rad = r.height() / 2;
	p.setPen(Qt::NoPen);
	p.setBrush(theme::color(QStringLiteral("border")));
	p.drawRoundedRect(r, rad, rad);
	p.setBrush(stateColour(state_));
	if (indeterminate_) {
		const qreal w = r.width() * 0.32, x = (r.width() - w) * phase_;
		p.setClipRect(r);
		p.drawRoundedRect(QRectF(x, 0, w, r.height()), rad, rad);
		return;
	}
	if (value_ <= 0.0)
		return;
	p.drawRoundedRect(QRectF(0, 0, std::max<qreal>(r.height(), r.width() * value_), r.height()), rad, rad);
}
