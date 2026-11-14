// SPDX-License-Identifier: GPL-3.0-or-later
#include "qml_tasks.h"
#include "taskbar.h"
#include "tray.h"

#include <QApplication>
#include <QJSValue>
#include <QJsonArray>
#include <QJsonObject>
#include <QStyle>

namespace {
// A JS value from QML (a QJSValue inside the QVariant, or an already converted map or list) as JSON.
QJsonValue json(const QVariant &v)
{
	if (v.metaType().id() == qMetaTypeId<QJSValue>())
		return QJsonValue::fromVariant(v.value<QJSValue>().toVariant(QJSValue::ConvertJSObjects));
	return QJsonValue::fromVariant(v);
}
} // namespace

QVariantMap QmlTaskText::lines(const QVariant &task) const
{
	const QJsonObject t = json(task).toObject();
	return {{QStringLiteral("text"), tasktime::text(t)},       {QStringLiteral("stage"), tasktime::stageLine(t)},
		{QStringLiteral("count"), tasktime::countLine(t)}, {QStringLiteral("eta"), tasktime::etaLine(t)},
		{QStringLiteral("last"), tasktime::lastLine(t)},   {QStringLiteral("warn"), tasktime::stallLine(t)},
		{QStringLiteral("fraction"), tasktime::fraction(t)}};
}

QmlTray::QmlTray(bool unseen, QObject *parent) : QObject(parent)
{
	// The app icon main() set from the embedded PNGs, else a standard one (as the widget window).
	QIcon ico = QApplication::windowIcon();
	if (ico.isNull())
		ico = QApplication::style()->standardIcon(QStyle::SP_ComputerIcon);
	keeper_ = new TrayKeeper(ico, this);
	keeper_->setUnseen(unseen);
	connect(keeper_, &TrayKeeper::openRequested, this, &QmlTray::openRequested);
	connect(keeper_, &TrayKeeper::stopAllRequested, this, &QmlTray::stopAllRequested);
	connect(keeper_, &TrayKeeper::allFinished, this, &QmlTray::allFinished);
}

bool QmlTray::active() const { return keeper_->active(); }

void QmlTray::begin(const QVariant &tasks)
{
	keeper_->begin(json(tasks).toArray());
	emit activeChanged();
}

void QmlTray::end()
{
	const bool was = keeper_->active();
	keeper_->end();
	if (was)
		emit activeChanged();
}

void QmlTray::update(const QVariant &tasks) { keeper_->update(json(tasks).toArray()); }

void QmlTray::showList() { keeper_->showList(); }

bool QmlTray::stillFinished(int countdown) const { return keeper_->stillFinished(countdown); }

QVariantMap QmlTray::probe() const { return keeper_->probe().toVariantMap(); }

void QmlTray::setQuitOnLastWindowClosed(bool on) { QGuiApplication::setQuitOnLastWindowClosed(on); }
