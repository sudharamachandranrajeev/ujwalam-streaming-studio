// SPDX-License-Identifier: GPL-3.0-or-later
// Task lines and the tray's progress bar (D287, D311 proposed). The studio's task panel is QML (TaskCenter.qml); it reads
// a task's lines through QmlTaskText (qml_tasks.h), which wraps tasktime::* below, so the panel, the close question and
// the tray say the same words. The tasks come from the UI server's status snapshot (tasks[]; services/studio-ui/tasks.mjs);
// the stall limits are in data/studio/tasks.json.
#pragma once

#include <QJsonObject>
#include <QPointer>
#include <QString>
#include <QWidget>

class QVariantAnimation;

namespace tasktime {
// "2:13 elapsed · about 4 min left" from a task's elapsedMs / etaMs (services/studio-ui/tasks.mjs, D311 proposed);
// "estimating time left" while the rate is being measured, "time left unknown" when the amount of work is unknown.
// Shared by the task panel, the close question and the tray.
QString text(const QJsonObject &t);
QString duration(double ms); // m:ss, or h:mm:ss
// 0..1, or -1 when the amount of work is unknown
double fraction(const QJsonObject &t);
// The panel's lines for one task (also in the probe, so tests read what the user reads).
QString stageLine(const QJsonObject &t); // "Step 1 of 5: Reading the game screen"
QString countLine(const QJsonObject &t); // "Frame 412 of 3,148 (13%)"
QString etaLine(const QJsonObject &t);   // "About 4 min left in this step" / "Estimating time left..."
QString lastLine(const QJsonObject &t);  // "Last progress 12 s ago" / "No progress yet (started 3:10 ago)"
QString stallLine(const QJsonObject &t); // "No progress for 5 min - it may be stuck", or empty
QString ago(double ms);                  // "12 s", "5 min", "1 h 4 min"
} // namespace tasktime

// A thin progress bar whose value glides to its target (220 ms, OutCubic); fraction < 0 = unknown, shown as a sweep.
class SmoothBar : public QWidget {
public:
	explicit SmoothBar(int height, QWidget *parent = nullptr);
	void setProgress(const QString &state, double fraction);
	QSize sizeHint() const override { return {120, h_}; }

protected:
	void paintEvent(QPaintEvent *) override;
	void showEvent(QShowEvent *) override;
	void hideEvent(QHideEvent *) override;

private:
	void sync();
	int h_;
	QString state_ = QStringLiteral("running");
	double value_ = 0, target_ = 0, phase_ = 0;
	bool indeterminate_ = false;
	// glide_ deletes itself when it ends (motion::run): a QPointer, never a raw pointer. A raw one here was the
	// 2026-11-08 studio crash (stop() on the freed animation at the next status poll).
	QPointer<QVariantAnimation> glide_;
	QVariantAnimation *sweep_ = nullptr; // owned: deleted only by sync()
};
