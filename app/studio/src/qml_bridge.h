// SPDX-License-Identifier: GPL-3.0-or-later
// The QML studio's view of the C++ core (D355, docs/plan/2026-11-11-qml-studio-plan.md). The QML screens call the same
// studio UI server routes as the widget studio, through the same ApiClient (127.0.0.1 only, session cookie and CSRF
// kept in C++); they read the theme from the same packs (theme.h), draw the same icons (icons.h), and embed the host's
// previews with the same preview.open call into a native child window placed over a QML item.
#pragma once

#include <QJSValue>
#include <QPointer>
#include <QQuickImageProvider>
#include <QQuickItem>
#include <QRasterWindow>
#include <QTimer>
#include <QVariantMap>

class ApiClient;
class QJSEngine;
class QQuickItem;

// Api: get / post / host with a JS callback (ok, body, err). Bodies cross as plain JS objects.
class QmlApi : public QObject {
	Q_OBJECT
public:
	QmlApi(ApiClient *api, QJSEngine *engine, QObject *parent = nullptr);
	Q_INVOKABLE void get(const QString &route, const QJSValue &done);
	Q_INVOKABLE void post(const QString &route, const QJSValue &body, const QJSValue &done);
	Q_INVOKABLE void host(const QString &method, const QJSValue &params, const QJSValue &done);
	// One line on stdout for the launcher and tests (the widget studio's printf lines, same text).
	Q_INVOKABLE void log(const QString &line);
	// Settings > Folders "Choose...": the Windows folder picker (no Qt Quick Dialogs module to ship). "" when cancelled.
	Q_INVOKABLE QString chooseFolder(const QString &title, const QString &start) const;
	// YouTube window (D388) "Choose thumbnail": the Windows file picker for a PNG or JPEG. "" when cancelled or in test mode
	// (UJWALAM_HEADLESS=1: no dialog ever opens).
	Q_INVOKABLE QString chooseImage(const QString &title) const;
	// Settings > Chat & bots "Copy pairing code": puts the text on the system clipboard (the widget's QClipboard call).
	Q_INVOKABLE void copyText(const QString &text) const;
	// Report a problem: opens an https://github.com/ link in the browser (the widget report()'s check); anything else is
	// refused. "opened", "refused", "failed", or "headless" (test mode: checked, never opened).
	Q_INVOKABLE QString openLink(const QString &url) const;
	// The Look panel (D290): the effect types from fx_types.h, as {type, label, group, params: [{key, label, colour, lo, hi,
	// def, step, dec, cdef}]}. The same table the widget studio builds its Look cards from.
	Q_INVOKABLE QVariantList fxTypes() const;
	// A Look colour swatch: the system colour picker (the widget's QColorDialog). "#rrggbb", or "" when cancelled or in
	// test mode (UJWALAM_HEADLESS=1: no dialog ever opens).
	Q_INVOKABLE QString chooseColour(const QString &start) const;
	// Tips and tours (guide, D294): where the named parts of the window are on screen, in window coordinates. Every
	// visible item under root with one of these object names, at least 6 px each way, cut to what a clipping parent (a
	// scrolling column) shows; their union. An empty rect when none is on screen (a tour step then is skipped).
	Q_INVOKABLE QRectF itemRect(QQuickItem *root, const QStringList &names) const;
	// UJWALAM_GUIDE_HINT_MS (tests): how long a hint stays, in ms; 0 when not set (a hint then uses its own time).
	Q_INVOKABLE int guideHintMs() const;
	// Requests sent and not answered yet (the headless probe waits for 0 before its next action and before it reads).
	int inFlight() const { return inFlight_; }

private:
	void reply(const QString &what, QJSValue done, bool ok, const QJsonObject &body, const QString &err);
	ApiClient *api_;
	QJSEngine *engine_;
	int inFlight_ = 0;
};

// Theme: the current pack's tokens, read through theme.h (so a pack that leaves a part out falls back the same way).
class QmlTheme : public QObject {
	Q_OBJECT
	Q_PROPERTY(QString id READ id NOTIFY changed)
	Q_PROPERTY(bool dark READ dark NOTIFY changed)
	Q_PROPERTY(QVariantMap c READ colors NOTIFY changed)
	Q_PROPERTY(QString family READ family NOTIFY changed)
	Q_PROPERTY(int radiusSmall READ radiusSmall NOTIFY changed)
	Q_PROPERTY(int radiusMedium READ radiusMedium NOTIFY changed)
	Q_PROPERTY(int radiusLarge READ radiusLarge NOTIFY changed)
	Q_PROPERTY(int fast READ fast NOTIFY changed)
	Q_PROPERTY(int normal READ normal NOTIFY changed)
	Q_PROPERTY(bool motion READ motion NOTIFY changed)
	// RareUI slice 0 (D384): "full" | "calm" | "plain" (theme::fxLevel of the effects level and onAir). Notifies on fxChanged
	// (a theme or effects switch, or onAir flipping) so a flip does not rebind every colour.
	Q_PROPERTY(QString fx READ fx NOTIFY fxChanged)
	// motion.spring of the pack: {stiffness, damping, mass}, default 300 / 30 / 1 (USpring.qml reads it).
	Q_PROPERTY(QVariantMap spring READ spring NOTIFY changed)
	// True while a stream or recording runs; the Store sets it from its live and recording state.
	Q_PROPERTY(bool onAir READ onAir WRITE setOnAir NOTIFY fxChanged)
	// RareUI slice 1 (D384): the flag rareui-look (the Store sets it), the pack's button style (components.button.style) and
	// spinner style (components.spinner, "ring" when the pack names none) as the studio may use them. Both are empty
	// or the plain defaults unless the flag is on and the pack's components are read (flag theme-components).
	Q_PROPERTY(bool rareui READ rareui WRITE setRareui NOTIFY lookChanged)
	Q_PROPERTY(QString buttonStyle READ buttonStyle NOTIFY lookChanged)
	Q_PROPERTY(QString spinnerStyle READ spinnerStyle NOTIFY lookChanged)
	// RareUI slice 2 (D384): the pack's tab style (components.tabs; the studio draws slide, dock and avatar), same gating as buttonStyle.
	Q_PROPERTY(QString tabsStyle READ tabsStyle NOTIFY lookChanged)
	// The design system (D389, schema "system"): every group is a map of numbers, merged over built-in defaults so a pack may
	// leave a part out. sp = spacing scale (xs s m l xl xxl, px), ty = type scale (caption small body subtitle title display,
	// px; displayFamily the heading family), elev = elevation levels e0..e4 (each: keyBlur keyY keyAlpha ambBlur ambAlpha),
	// ring = focus ring (width offset alpha), st = state overlay strengths (hover pressed disabled, 0..1), mo = motion in
	// ms (fast normal slow enter exit; enter < 600, exit < 400).
	Q_PROPERTY(QVariantMap sp READ sp NOTIFY changed)
	Q_PROPERTY(QVariantMap ty READ ty NOTIFY changed)
	Q_PROPERTY(QVariantMap elev READ elev NOTIFY changed)
	Q_PROPERTY(QVariantMap ring READ ring NOTIFY changed)
	Q_PROPERTY(QVariantMap st READ st NOTIFY changed)
	Q_PROPERTY(QVariantMap mo READ mo NOTIFY changed)
	// Molten Stone (2026-11-27): painted surfaces. tex = {surface: {src, m, o, tile}} for each 9-slice picture the pack ships
	// (empty in plain fx: on air and High performance draw flat fills); art = {name: src} for its plain pictures (same rule);
	// ambient = {smoke, drip: src} only in full fx with animations on, never on air. Notifies on fxChanged (a theme switch too).
	Q_PROPERTY(QVariantMap tex READ tex NOTIFY fxChanged)
	Q_PROPERTY(QVariantMap art READ art NOTIFY fxChanged)
	Q_PROPERTY(QVariantMap ambient READ ambient NOTIFY fxChanged)
public:
	explicit QmlTheme(QObject *parent = nullptr);
	QString id() const;
	bool dark() const;
	QVariantMap colors() const;
	QString family() const;
	int radiusSmall() const;
	int radiusMedium() const;
	int radiusLarge() const;
	int fast() const;
	int normal() const;
	bool motion() const;
	QString fx() const;
	QVariantMap spring() const;
	QVariantMap sp() const;
	QVariantMap ty() const;
	QVariantMap elev() const;
	QVariantMap ring() const;
	QVariantMap st() const;
	QVariantMap mo() const;
	QVariantMap tex() const;
	QVariantMap art() const;
	QVariantMap ambient() const;
	bool onAir() const { return onAir_; }
	void setOnAir(bool on);
	bool rareui() const { return rareui_; }
	void setRareui(bool on);
	QString buttonStyle() const;
	QString spinnerStyle() const;
	QString tabsStyle() const;
	// Reads the pack's components block (theme::setComponents); the Store calls it with theme-components and rareui-look both on.
	Q_INVOKABLE void setComponentsOn(bool on);
	// "image://icon/<name>/<rrggbb>/<px>" for an icon in a token colour.
	Q_INVOKABLE QString icon(const QString &name, const QString &token, int px = 18) const;
	Q_INVOKABLE bool setCurrent(const QString &id);
	Q_INVOKABLE void setEffects(const QString &mode);
	// Settings > Appearance (Q3): the packs to choose from [{id, name, topic, dark, accent, bg, panel, text}], the
	// effects level now (full | reduced | performance) and the animation choice (system | on | off, motion.h).
	Q_INVOKABLE QVariantList themes() const;
	Q_INVOKABLE QString effects() const;
	Q_INVOKABLE void setMotionMode(const QString &mode);
	Q_INVOKABLE QString motionMode() const;
signals:
	void changed();
	void fxChanged();
	void lookChanged();
	// A pack file that changed on disk and was refused (LU2): the last good look stays; the window says why (a toast).
	void rejected(const QString &title, const QString &why);
private:
	bool onAir_ = false;
	bool rareui_ = false;
};

class IconProvider : public QQuickImageProvider {
public:
	IconProvider();
	QPixmap requestPixmap(const QString &id, QSize *size, const QSize &requested) override;
};

// The dark surface under a host preview: a native child window of the QML window (the host's preview window becomes
// its child, as it did with the widget studio's PreviewSlot).
class PreviewSurface : public QRasterWindow {
public:
	explicit PreviewSurface(QWindow *parent);

protected:
	void paintEvent(QPaintEvent *) override;
};

// PreviewView: a QML item that holds one host preview (canvas "h" or "v"). It keeps a native child window over its own
// rectangle and asks the host to draw the preview in it (preview.open with the window handle and the size in device
// pixels), again after a resize, a move or a host restart (reembed()).
class PreviewView : public QQuickItem {
	Q_OBJECT
	Q_PROPERTY(QString canvas READ canvas WRITE setCanvas NOTIFY canvasChanged)
	Q_PROPERTY(QString message READ message NOTIFY messageChanged)
	Q_PROPERTY(bool embedded READ embedded NOTIFY embeddedChanged)
public:
	explicit PreviewView(QQuickItem *parent = nullptr);
	~PreviewView() override;
	static void setApi(ApiClient *api);
	QString canvas() const { return canvas_; }
	void setCanvas(const QString &c);
	QString message() const { return message_; }
	bool embedded() const { return embedded_; }
	Q_INVOKABLE void reembed();

signals:
	void canvasChanged();
	void messageChanged();
	void embeddedChanged();

protected:
	void geometryChange(const QRectF &now, const QRectF &before) override;
	void itemChange(ItemChange change, const ItemChangeData &value) override;

private:
	void schedule();
	void place();
	void embed();
	void setMessage(const QString &m);
	QString canvas_;
	QString message_;
	bool embedded_ = false, busy_ = false, again_ = false;
	QRect placed_;
	QSize sent_;
	QPointer<PreviewSurface> surface_;
	QTimer debounce_, track_;
};
