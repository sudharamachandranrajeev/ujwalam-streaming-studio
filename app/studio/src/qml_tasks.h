// SPDX-License-Identifier: GPL-3.0-or-later
// The QML studio's tasks and tray (plan Q4, checklist A): the same words and the same tray as the widget studio, shared
// from C++ rather than written again in QML.
//   TaskText (QmlTaskText): the task panel's lines for one task (taskbar.h tasktime::*: elapsed and time left, stage,
//   count, last progress, the "may be stuck" warning), so a QML row reads exactly what a widget row reads.
//   Tray (QmlTray): the widget studio's TrayKeeper (tray.h): icon with tooltip, the task list, Open Ujwalam, Stop all and
//   quit, the "all finished" countdown. Hidden and probe modes are unseen: no icon, notification or list on a screen.
#pragma once

#include <QObject>
#include <QVariant>
#include <QVariantMap>

class TrayKeeper;

class QmlTaskText : public QObject {
	Q_OBJECT
public:
	explicit QmlTaskText(QObject *parent = nullptr) : QObject(parent) {}
	// {text, stage, count, eta, last, warn, fraction} for one task of the status snapshot (a JS object).
	Q_INVOKABLE QVariantMap lines(const QVariant &task) const;
};

class QmlTray : public QObject {
	Q_OBJECT
	Q_PROPERTY(bool active READ active NOTIFY activeChanged)
public:
	QmlTray(bool unseen, QObject *parent = nullptr);
	bool active() const;
	Q_INVOKABLE void begin(const QVariant &tasks);  // the window was closed into the tray
	Q_INVOKABLE void end();                         // the window is back (or the studio ends)
	Q_INVOKABLE void update(const QVariant &tasks); // every status poll while active
	Q_INVOKABLE void showList();                    // a click on the icon (or a probe)
	Q_INVOKABLE bool stillFinished(int countdown) const;
	Q_INVOKABLE QVariantMap probe() const;
	// In the tray the window is hidden: the app must not end on its last window (the widget's enterTray / leaveTray).
	Q_INVOKABLE void setQuitOnLastWindowClosed(bool on);

signals:
	void activeChanged();
	void openRequested();
	void stopAllRequested();
	void allFinished(int countdown);

private:
	TrayKeeper *keeper_;
};
