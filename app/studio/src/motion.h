// SPDX-License-Identifier: GPL-3.0-or-later
// Motion helpers (D287): the user's animation choice and short eased animations for the widgets that remain (the tray's
// progress bar). The QML studio reads the same choice through Theme (qml_bridge.cpp). Every animation is started by a
// change and ends by itself. Motion is skipped (final state at once) when Windows "animation effects" are off
// (SPI_GETCLIENTAREAANIMATION), when UJWALAM_REDUCE_MOTION=1, or when the widget is not shown (headless probe).
#pragma once

#include <QEasingCurve>
#include <QString>
#include <QVariant>
#include <functional>

class QVariantAnimation;
class QWidget;

namespace motion {

bool systemAnimations();           // UJWALAM_REDUCE_MOTION, else the user's choice (setMode), else the Windows setting

// The user's choice from Settings > Advanced > Animations (settings.json ui.motion, D290): "system" (follow Windows,
// the default), "on" or "off". Anything else counts as "system". UJWALAM_REDUCE_MOTION still overrides it.
void setMode(const QString &mode);
QString mode();
bool enabled(const QWidget *w);    // systemAnimations() and w is visible

// One-shot animation of a value from..to (qreal, QPointF, QColor ...). Parent owns it and it deletes itself when done.
// When motion is off, step(to) and done() run at once. Returns the animation (nullptr when skipped).
QVariantAnimation *run(QWidget *context, const QVariant &from, const QVariant &to, int ms, QEasingCurve::Type curve,
		       std::function<void(const QVariant &)> step, std::function<void()> done = {});

} // namespace motion
