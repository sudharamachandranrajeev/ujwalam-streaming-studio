// SPDX-License-Identifier: GPL-3.0-or-later
#include "qml_studio.h"
#include "api_client.h"
#include "main_window.h"
#include "qml_bridge.h"
#include "qml_tasks.h"
#include "theme.h"

#include <QCoreApplication>
#include <QDir>
#include <QGuiApplication>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMetaMethod>
#include <QQmlApplicationEngine>
#include <QtQml/qqml.h>
#include <QQmlContext>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSet>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QSGRendererInterface>
#include <QWheelEvent>
#include <cstdio>

QmlStudio::QmlStudio(ApiClient *api, QObject *parent) : QObject(parent), api_(api) {}

QmlStudio::~QmlStudio()
{
	engine_.reset(); // the window and its preview surfaces go first; then the bridge objects they call
}

bool QmlStudio::begin(Mode mode)
{
	// Our own style on Basic, driven only by theme tokens (plan: Style). Basic needs no native style plugin.
	QQuickStyle::setStyle(QStringLiteral("Basic"));
	// Off screen (tests) the scene graph draws in software: no GPU, nothing reaches a screen. On screen: the default
	// (Direct3D 11 on Windows).
	if (mode == Mode::Probe)
		QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
	engine_ = std::make_unique<QQmlApplicationEngine>();
	// The packaged studio keeps the Qt Quick imports beside the exe (studio/qml); a dev build finds the kit's own.
	engine_->addImportPath(QCoreApplication::applicationDirPath() + QStringLiteral("/qml"));
	qapi_ = new QmlApi(api_, engine_.get(), this);
	theme_ = new QmlTheme(this);
	PreviewView::setApi(api_);
	qmlRegisterSingletonInstance("Ujwalam.Core", 1, 0, "Api", qapi_);
	qmlRegisterSingletonInstance("Ujwalam.Core", 1, 0, "Theme", theme_);
	qmlRegisterType<PreviewView>("Ujwalam.Core", 1, 0, "PreviewView");
	// The task panel's words and the tray come from the widget studio's C++ (taskbar.h, tray.h). Only a normal window
	// may put a tray icon or a notification on the screen; hidden and probe modes run the same tray unseen.
	qmlRegisterSingletonInstance("Ujwalam.Core", 1, 0, "TaskText", new QmlTaskText(this));
	qmlRegisterSingletonInstance("Ujwalam.Core", 1, 0, "Tray", new QmlTray(mode != Mode::Normal, this));
	engine_->addImageProvider(QStringLiteral("icon"), new IconProvider()); // the engine owns it
	engine_->rootContext()->setContextProperty(QStringLiteral("studioHidden"), mode == Mode::Hidden);
	// Never on a screen (hidden or probe): popups that sit at the window's edges (the task panel and notifications) are
	// drawn inside the window, since an offscreen screen is smaller than the window and would push a popup window inward.
	engine_->rootContext()->setContextProperty(QStringLiteral("studioUnseen"), mode != Mode::Normal);
	engine_->loadFromModule("Ujwalam.Studio", "Main");
	const QList<QObject *> roots = engine_->rootObjects();
	win_ = roots.isEmpty() ? nullptr : qobject_cast<QQuickWindow *>(roots.first());
	if (!win_) {
		std::fprintf(stderr, "studio: the QML window did not load (see the studio log)\n");
		return false;
	}
	switch (mode) {
	case Mode::Normal: // a normal window on the main display, activated like any app the user starts (D316)
		win_->show();
		win_->raise();
		win_->requestActivate();
		break;
	case Mode::Hidden: // a native handle without a show: the host's headless rule needs a hidden top-level parent
		win_->setFlag(Qt::WindowDoesNotAcceptFocus, true);
		win_->resize(1600, 900);
		win_->create();
		break;
	case Mode::Probe: // the offscreen platform: "shown" so bindings and layouts run, never on a screen
		win_->resize(1600, 900);
		win_->show();
		break;
	}
	QMetaObject::invokeMethod(win_, "start");
	return true;
}

void QmlStudio::swapClose()
{
	std::printf("studio swap: closing for an update (host and outputs keep running)\n");
	std::fflush(stdout);
	QCoreApplication::exit(MainWindow::kSwapExitCode);
}

void QmlStudio::close()
{
	if (win_)
		win_->close(); // onClosing in Main.qml asks about running tasks, as the widget closeEvent does
}

namespace {
QJsonValue jsonOf(const QVariant &v)
{
	if (v.metaType().id() == qMetaTypeId<QJSValue>())
		return QJsonValue::fromVariant(v.value<QJSValue>().toVariant(QJSValue::ConvertJSObjects));
	return QJsonValue::fromVariant(v);
}

// The QObject children and, for an item, its visual children (a list's delegates and a window's content are reached
// through either, depending on how they were made); each object once. A popup or dialog is no item: its header,
// content and footer are reached through those properties (the same names a window's content item uses).
QList<QObject *> kids(const QObject *o)
{
	QList<QObject *> k = o->children();
	if (const auto *it = qobject_cast<const QQuickItem *>(o))
		for (QQuickItem *c : it->childItems())
			if (!k.contains(c))
				k.append(c);
	if (const auto *w = qobject_cast<const QQuickWindow *>(o); w && !k.contains(w->contentItem()))
		k.append(w->contentItem());
	if (!qobject_cast<const QQuickItem *>(o)) // an item's own content item is among its child items already
		for (const char *p : {"header", "contentItem", "footer"})
			if (QObject *c = o->property(p).value<QObject *>(); c && !k.contains(c))
				k.append(c);
	return k;
}

void collect(const QObject *o, QJsonArray &out, QSet<const QObject *> &seen)
{
	for (const QObject *c : kids(o)) {
		if (seen.contains(c))
			continue;
		seen.insert(c);
		if (!c->objectName().isEmpty() && out.size() < 2000) {
			QJsonObject n;
			n.insert(QStringLiteral("name"), c->objectName());
			n.insert(QStringLiteral("type"), QString::fromLatin1(c->metaObject()->className()).section(QLatin1Char('_'), 0, 0));
			for (const char *p : {"text", "checked", "enabled", "value", "visible", "opened", "toolTipText"}) {
				const QVariant v = c->property(p);
				if (v.isValid())
					n.insert(QLatin1String(p), jsonOf(v));
			}
			if (const auto *it = qobject_cast<const QQuickItem *>(c)) {
				const QRectF r = it->mapRectToScene(it->boundingRect());
				n.insert(QStringLiteral("rect"), QJsonArray{qRound(r.x()), qRound(r.y()), qRound(r.width()), qRound(r.height())});
			}
			out.append(n);
		}
		collect(c, out, seen);
	}
}

// Each object once, as in collect(): a popup and its item reach each other, so a walk without the set never ends.
QObject *findNamed(QObject *root, const QString &name, QSet<const QObject *> &seen)
{
	if (!root || seen.contains(root))
		return nullptr;
	seen.insert(root);
	if (root->objectName() == name)
		return root;
	for (QObject *c : kids(root))
		if (QObject *f = findNamed(c, name, seen))
			return f;
	return nullptr;
}

QObject *findNamed(QObject *root, const QString &name)
{
	QSet<const QObject *> seen;
	return findNamed(root, name, seen);
}
} // namespace

QJsonObject QmlStudio::probe() const
{
	QJsonObject o;
	o.insert(QStringLiteral("ui"), QStringLiteral("qml"));
	o.insert(QStringLiteral("theme"), theme::currentId());
	if (!win_)
		return o;
	QJsonArray tree;
	QSet<const QObject *> seen;
	collect(win_, tree, seen);
	o.insert(QStringLiteral("tree"), tree);
	QVariant state;
	if (QMetaObject::invokeMethod(win_, "probeState", Q_RETURN_ARG(QVariant, state)))
		o.insert(QStringLiteral("state"), jsonOf(state));
	o.insert(QStringLiteral("size"), QJsonArray{win_->width(), win_->height()});
	return o;
}

bool QmlStudio::probeAction(const QString &action)
{
	if (action.startsWith(QStringLiteral("theme:")) || action.startsWith(QStringLiteral("effects:")))
		return theme::probeAction(action);
	if (action.startsWith(QStringLiteral("type:"))) { // type:<objectName>=<text>: a text field's whole text, as typed
		const qsizetype eq = action.indexOf(QLatin1Char('='));
		QObject *t = eq > 5 ? findNamed(win_, action.mid(5, eq - 5)) : nullptr;
		return t && t->property("enabled").toBool() && t->setProperty("text", action.mid(eq + 1));
	}
	if (action.startsWith(QStringLiteral("wheel:"))) { // wheel:<notches>:<focus|nofocus>:<objectName>: mouse wheel over its centre
		const QStringList p = action.split(QLatin1Char(':'));
		auto *item = p.size() >= 4 ? qobject_cast<QQuickItem *>(findNamed(win_, p.mid(3).join(QLatin1Char(':')))) : nullptr;
		if (!item || !item->isVisible() || !item->isEnabled())
			return false;
		if (p[2] == QStringLiteral("focus")) { // as a click on it would: the window active, the item with focus
			win_->requestActivate();
			QCoreApplication::processEvents();
			item->forceActiveFocus();
		}
		const QPointF at = item->mapToScene(QPointF(item->width() / 2, item->height() / 2));
		QWheelEvent ev(at, win_->mapToGlobal(at), QPoint(), QPoint(0, 120 * p[1].toInt()), Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
		QCoreApplication::sendEvent(win_, &ev);
		return true;
	}
	if (action.startsWith(QStringLiteral("drag:"))) {
		// drag:<from>[~<to>]:<objectName>: a real left press at a fraction of the item's track, an optional hold and drag to
		// the second fraction, then the release (the shared slider's click jump and its one change on release, D330).
		const QStringList p = action.split(QLatin1Char(':'));
		auto *item = p.size() >= 3 ? qobject_cast<QQuickItem *>(findNamed(win_, p.mid(2).join(QLatin1Char(':')))) : nullptr;
		if (!item || !item->isVisible() || !item->isEnabled())
			return false;
		const QStringList f = p[1].split(QLatin1Char('~'));
		auto at = [item](double frac) { // on a Slider the handle's centre at that position; else the width
			double x = frac * item->width();
			const auto *h = item->property("handle").value<QQuickItem *>();
			const QVariant avail = item->property("availableWidth");
			if (h && avail.isValid())
				x = item->property("leftPadding").toDouble() + h->width() / 2 + frac * (avail.toDouble() - h->width());
			return item->mapToScene(QPointF(x, item->height() / 2));
		};
		auto send = [this](QEvent::Type t, QPointF pos, Qt::MouseButton b, Qt::MouseButtons bs) {
			QMouseEvent ev(t, pos, pos, win_->mapToGlobal(pos), b, bs, Qt::NoModifier);
			QCoreApplication::sendEvent(win_, &ev);
			QCoreApplication::processEvents();
		};
		QPointF pos = at(f[0].toDouble());
		send(QEvent::MouseButtonPress, pos, Qt::LeftButton, Qt::LeftButton);
		if (f.size() > 1) {
			const QPointF end = at(f[1].toDouble());
			for (int i = 1; i <= 8; i++) // held: several moves, as a hand drags
				send(QEvent::MouseMove, pos + (end - pos) * (i / 8.0), Qt::NoButton, Qt::LeftButton);
			pos = end;
		}
		send(QEvent::MouseButtonRelease, pos, Qt::LeftButton, Qt::NoButton);
		return true;
	}
	if (action.startsWith(QStringLiteral("key:"))) { // key:<Right|Left|Up|Down|PageUp|PageDown>:<objectName>: focus, then the key
		const QStringList p = action.split(QLatin1Char(':'));
		static const QHash<QString, int> keys{{QStringLiteral("Right"), Qt::Key_Right}, {QStringLiteral("Left"), Qt::Key_Left},
			{QStringLiteral("Up"), Qt::Key_Up}, {QStringLiteral("Down"), Qt::Key_Down}, {QStringLiteral("PageUp"), Qt::Key_PageUp},
			{QStringLiteral("PageDown"), Qt::Key_PageDown}};
		auto *item = p.size() >= 3 ? qobject_cast<QQuickItem *>(findNamed(win_, p.mid(2).join(QLatin1Char(':')))) : nullptr;
		if (!item || !item->isVisible() || !item->isEnabled() || !keys.contains(p[1]))
			return false;
		win_->requestActivate();
		QCoreApplication::processEvents();
		item->forceActiveFocus();
		for (QEvent::Type t : {QEvent::KeyPress, QEvent::KeyRelease}) {
			QKeyEvent ev(t, keys.value(p[1]), Qt::NoModifier);
			QCoreApplication::sendEvent(win_, &ev);
		}
		return true;
	}
	if (!action.startsWith(QStringLiteral("click:"))) {
		// settings-*and other window actions live in Main.qml (probeAction), named as on the widget studio.
		QVariant done;
		return win_ && QMetaObject::invokeMethod(win_, "probeAction", Q_RETURN_ARG(QVariant, done), Q_ARG(QVariant, action)) && done.toBool();
	}
	QObject *t = findNamed(win_, action.mid(6));
	if (!t || !t->property("enabled").toBool())
		return false;
	// A Qt Quick Controls button: click() toggles a checkable one and emits clicked, as a real click does.
	if (t->metaObject()->indexOfMethod("click()") >= 0)
		return QMetaObject::invokeMethod(t, "click");
	return t->metaObject()->indexOfSignal("clicked()") >= 0 && QMetaObject::invokeMethod(t, "clicked");
}

bool QmlStudio::probeIdle() const { return !qapi_ || qapi_->inFlight() == 0; }

bool QmlStudio::shot(const QString &png) const
{
	return win_ && win_->grabWindow().save(png, "PNG");
}
