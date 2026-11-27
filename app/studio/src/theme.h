// SPDX-License-Identifier: GPL-3.0-or-later
// Studio themes (D285, D293): the whole look of the studio as data. A theme pack is data/themes/<id>.json (schema
// data/themes/theme.schema.json): colour tokens, type, geometry, motion and the optional design-system block. The
// built-in packs are embedded in the exe; a file with the same id in UJWALAM_THEMES_DIR, <exe>/themes, <app data>/themes
// or the repo's data/themes replaces the embedded one, and a new id there is a custom theme. A pack may leave any part
// out: it falls back to Violet Night (the embedded default).
//
// The QML studio reads the look through QmlTheme (qml_bridge.h), which wraps the functions below. The Qt Widgets parts
// that remain (the tray's list, file and colour dialogs) take the pack's colours and font through the app palette.
// Switching: theme::setCurrent(id) re-applies palette and font and emits notifier()->changed().
#pragma once

#include <QColor>
#include <QEasingCurve>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QPair>
#include <QString>
#include <QStringList>

class QApplication;

namespace theme {

enum class Radius { Small, Medium, Large };

struct Info {
	QString id, name, topic;
	bool dark = true;
	bool custom = false; // not one of the embedded packs
	QColor bg, panel, text, accent;
};

// Start: reads the pack named by UJWALAM_THEME, else "violet-night", and applies it. Call once before any window exists.
void apply(QApplication &app);
// Switch live. false (and nothing changes) when the id is unknown. Unknown ids fall back to violet-night only at start.
bool setCurrent(const QString &id);
QString currentId();
// The current pack's font family and dark flag, read from the pack in use. Cheap: the QML Theme reads them once per text
// binding (hundreds on a theme switch), where available() loads and parses every pack file on each call.
QString currentFamily();
bool currentDark();
QList<Info> available();

// "full" (decoration as the pack says), "reduced" or "performance" (High performance, 2026-11-10: no animation, the
// plainest drawing). Any theme can run in any mode.
void setEffects(const QString &mode);
QString effects();
bool performance();
// RareUI slice 0 (D384): how much decoration the Qt Quick studio may run. "plain" while on air (live or recording) or in
// High performance (performance), "calm" in reduced, else "full". Pure: mode is full | reduced | performance (anything
// else counts as full). Theme.fx in QML is fxLevel(effects(), the Store's live or recording state).
QString fxLevel(const QString &effectsMode, bool onAir);

// A colour token: bg panel field border text muted accent accentHi danger ok onAccent disabled
QColor color(const QString &token);
int radius(Radius size); // corner radius in px from the pack
qreal iconStroke();

// Motion from the pack.
int duration(const QString &which); // fast | normal | slow, in ms
QEasingCurve::Type easing();
// motion.spring (RareUI slice 0, D384): the shared exact spring, default 300 / 30 / 1.
struct Spring {
	qreal stiffness = 300, damping = 30, mass = 1;
};
Spring spring();
// The pack's optional design-system block (schema "system": space, type, elevation, ring, state, motion ms): the raw object,
// or empty. The QML studio's Theme merges it over its defaults (qml_bridge.cpp), so a pack may leave any part out.
QJsonObject systemBlock();

// Molten Stone (2026-11-27): the pack's texture block ({slices: {name: {margin, outset, tile}}, art: [names]}) and ambient
// block ({smoke, drip}), empty unless the pack's v2 parts are read. Pictures live at :/theme-tex/<id>/<name>.png.
QJsonObject textureBlock();
QJsonObject ambientBlock();
const QStringList &textureSlices();
const QStringList &textureArt();

// ---- Theme components (schema v2, D336, flag theme-components) ----
// The flag (Settings > Advanced / control page) switches the components block on or off; off, every pack draws the base
// look. A pack marked componentsAlways uses its components with the flag off too (D376).
void setComponents(bool on); // re-applies the current pack when the value changes
// The variant the current pack gives a component, or empty for the base look (flag off, or the key left out).
QString component(const QString &key);
// Every component key and its allowed variants (packProblem refuses anything else).
const QList<QPair<QString, QStringList>> &componentVariants();

// Emits changed() after a switch (theme, effects, components).
// LU2 (D324): the current pack file reloads when it changes on disk (directory watch, debounced). A valid file applies
// at once (changed()); an invalid one keeps the last good look and emits rejected() with the reason (the window shows
// it as a notification) plus a warning line in the log.
class Notifier : public QObject {
	Q_OBJECT
signals:
	void changed();
	void rejected(const QString &title, const QString &why);
};
Notifier *notifier();

// Problems with a theme pack file's text for the given id (JSON, id, required parts, colour tokens); empty = usable.
QString packProblem(const QByteArray &bytes, const QString &id);

// Probe actions (tests): theme:<id> | effects:<full|reduced|performance>[+<mode>...] | components:<on|off> | fonts:load
bool probeAction(const QString &action);

} // namespace theme
