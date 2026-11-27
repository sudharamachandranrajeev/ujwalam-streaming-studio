// SPDX-License-Identifier: GPL-3.0-or-later
#include "theme.h"

#include <QApplication>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QFileSystemWatcher>
#include <QFont>
#include <QFontDatabase>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QPalette>
#include <QRegularExpression>
#include <QSet>
#include <QStandardPaths>
#include <QStyleFactory>
#include <QTimer>

#include <algorithm>
#include <cmath>

namespace theme {

namespace {

const QString kDefaultId = QStringLiteral("violet-night");

struct Data {
	QString id, name, topic;
	bool dark = true;
	bool custom = false;
	QJsonObject src; // the accepted pack JSON this look was parsed from (D336: a flag switch parses it again)
	QHash<QString, QColor> colors;
	QString family;
	QStringList fallbacks;
	qreal base = 10, letterSpacing = 0;
	int rs = 6, rm = 8, rl = 16;
	int fast = 120, normal = 180, slow = 260;
	QString easing = QStringLiteral("outCubic");
	qreal stroke = 2.0;
	// Schema v2 (D336): read only while the flag theme-components is on; never inherited from the default pack.
	QHash<QString, QString> comp; // "button.shape" -> "pill"; booleans as "true" / "false"
	// D376: the pack's components apply without the flag (a pack built only for them); text hinting.
	bool componentsAlways = false;
	QString hinting = QStringLiteral("default");
	bool valid = false;
};

Data g_cur;
QString g_effects = QStringLiteral("full");
bool g_components = false; // the flag theme-components (D336)
Notifier *g_notifier = nullptr;

QStringList searchDirs()
{
	QStringList d;
	const QString env = qEnvironmentVariable("UJWALAM_THEMES_DIR");
	if (!env.isEmpty())
		d << env;
	d << QCoreApplication::applicationDirPath() + QStringLiteral("/themes");
	const QString appData = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
	if (!appData.isEmpty())
		d << appData + QStringLiteral("/themes");
	// A build inside the repo (out/studio/build): the repo's data/themes, so an edited pack shows without a rebuild.
	QDir up(QCoreApplication::applicationDirPath());
	for (int i = 0; i < 5 && up.cdUp(); i++)
		if (QDir(up.filePath(QStringLiteral("data/themes"))).exists()) {
			d << up.filePath(QStringLiteral("data/themes"));
			break;
		}
	return d;
}

// Bundled open-licence fonts (SIL OFL 1.1, D344): data/fonts beside the app (package: <root>/data/fonts, studio exe in
// <root>/studio), or UJWALAM_FONTS_DIR. Loaded for this process only with addApplicationFont; never installed into Windows.
QStringList g_bundledFamilies;
bool g_fontsLoaded = false;

void loadBundledFonts()
{
	if (g_fontsLoaded) // once per process: every call would register the same files again (Codex review)
		return;
	g_fontsLoaded = true;
	QStringList dirs;
	const QString env = qEnvironmentVariable("UJWALAM_FONTS_DIR");
	if (!env.isEmpty())
		dirs << env;
	dirs << QCoreApplication::applicationDirPath() + QStringLiteral("/fonts");
	QDir up(QCoreApplication::applicationDirPath());
	for (int i = 0; i < 5 && up.cdUp(); i++)
		if (QDir(up.filePath(QStringLiteral("data/fonts"))).exists()) {
			dirs << up.filePath(QStringLiteral("data/fonts"));
			break;
		}
	QSet<QString> seen;
	for (const QString &d : dirs)
		for (const QFileInfo &fi : QDir(d).entryInfoList({QStringLiteral("*.ttf")}, QDir::Files, QDir::Name)) {
			if (seen.contains(fi.fileName()))
				continue;
			seen.insert(fi.fileName());
			const int id = QFontDatabase::addApplicationFont(fi.absoluteFilePath());
			if (id >= 0)
				for (const QString &fam : QFontDatabase::applicationFontFamilies(id))
					if (!g_bundledFamilies.contains(fam))
						g_bundledFamilies << fam;
		}
}

QJsonObject readJson(const QString &path)
{
	QFile f(path);
	if (!f.open(QIODevice::ReadOnly))
		return {};
	QJsonParseError err;
	const QJsonDocument doc = QJsonDocument::fromJson(f.readAll(), &err);
	return err.error == QJsonParseError::NoError && doc.isObject() ? doc.object() : QJsonObject();
}

bool validId(const QString &id)
{
	static const QRegularExpression re(QStringLiteral("^[a-z0-9]+(-[a-z0-9]+)*$"));
	return id.size() <= 40 && re.match(id).hasMatch();
}

QJsonObject packJson(const QString &id, bool *custom = nullptr)
{
	if (!validId(id))
		return {};
	for (const QString &dir : searchDirs()) {
		const QJsonObject o = readJson(dir + QLatin1Char('/') + id + QStringLiteral(".json"));
		if (!o.isEmpty() && o.value(QStringLiteral("id")).toString() == id) {
			if (custom)
				*custom = !QFile::exists(QStringLiteral(":/themes/") + id + QStringLiteral(".json"));
			return o;
		}
	}
	const QJsonObject o = readJson(QStringLiteral(":/themes/") + id + QStringLiteral(".json"));
	if (custom)
		*custom = false;
	return o;
}

QColor col(const QJsonValue &v, const QColor &fallback)
{
	const QString s = v.toString();
	if (s.startsWith(QLatin1Char('#'))) {
		const QColor c(s);
		if (c.isValid())
			return c;
	}
	return fallback;
}
qreal num(const QJsonValue &v, qreal fallback, qreal lo, qreal hi)
{
	return v.isDouble() ? std::clamp(v.toDouble(), lo, hi) : fallback;
}
int inum(const QJsonValue &v, int fallback, int lo, int hi)
{
	return v.isDouble() ? std::clamp(int(std::lround(v.toDouble())), lo, hi) : fallback;
}
QString str(const QJsonValue &v, const QString &fallback)
{
	return v.isString() && !v.toString().isEmpty() ? v.toString() : fallback;
}
bool boolean(const QJsonValue &v, bool fallback)
{
	return v.isBool() ? v.toBool() : fallback;
}

const QStringList kColorKeys = {QStringLiteral("bg"),     QStringLiteral("panel"),    QStringLiteral("field"),   QStringLiteral("border"),
				QStringLiteral("text"),   QStringLiteral("muted"),    QStringLiteral("accent"),  QStringLiteral("accentHi"),
				QStringLiteral("danger"), QStringLiteral("ok"),       QStringLiteral("onAccent"), QStringLiteral("disabled")};

// ---- Components block (schema v2, D336) ----
const QStringList kBool = {QStringLiteral("true"), QStringLiteral("false")};

// Empty when the pack's components block is usable (or absent); else why not. Unknown keys and variants are refused,
// so a typo never silently falls back to the base look.
QString componentsProblem(const QJsonObject &pack)
{
	if (!pack.contains(QStringLiteral("components")))
		return {};
	const QJsonValue cv = pack.value(QStringLiteral("components"));
	if (!cv.isObject())
		return QStringLiteral("components must be an object");
	const QJsonObject c = cv.toObject();
	auto variants = [](const QString &key) -> const QStringList * {
		for (const auto &kv : componentVariants())
			if (kv.first == key)
				return &kv.second;
		return nullptr;
	};
	auto check = [&](const QString &key, const QJsonValue &v) -> QString {
		if (key == QStringLiteral("toast.maxVisible")) // RareUI slice 0: a whole number 1 to 5 (not a variant list)
			return (v.isDouble() && v.toDouble() >= 1 && v.toDouble() <= 5 && v.toDouble() == std::floor(v.toDouble()))
				? QString() : QStringLiteral("components.toast.maxVisible must be a whole number from 1 to 5");
		const QStringList *allowed = variants(key);
		if (!allowed)
			return QStringLiteral("components.%1 is not a known component").arg(key);
		if (*allowed == kBool)
			return v.isBool() ? QString() : QStringLiteral("components.%1 must be true or false").arg(key);
		if (!v.isString() || !allowed->contains(v.toString()))
			return QStringLiteral("components.%1 must be one of %2").arg(key, allowed->join(QStringLiteral(", ")));
		return {};
	};
	for (auto it = c.begin(); it != c.end(); ++it) {
		const QString k = it.key();
		if (k == QStringLiteral("button") || k == QStringLiteral("slider") || k == QStringLiteral("toast") || k == QStringLiteral("text")) {
			if (!it.value().isObject())
				return QStringLiteral("components.%1 must be an object").arg(k);
			const QJsonObject sub = it.value().toObject();
			for (auto s = sub.begin(); s != sub.end(); ++s)
				if (const QString why = check(k + QLatin1Char('.') + s.key(), s.value()); !why.isEmpty())
					return why;
			continue;
		}
		if (const QString why = check(k, it.value()); !why.isEmpty())
			return why;
	}
	return {};
}

// The components block applies: the flag is on, or the pack is built only from components (componentsAlways, D376).
bool compOn()
{
	return g_components || g_cur.componentsAlways;
}

QHash<QString, QString> readComponents(const QJsonObject &pack)
{
	QHash<QString, QString> out;
	const QJsonObject c = pack.value(QStringLiteral("components")).toObject();
	auto put = [&](const QString &key, const QJsonValue &v) {
		if (v.isBool())
			out.insert(key, v.toBool() ? QStringLiteral("true") : QStringLiteral("false"));
		else if (v.isString())
			out.insert(key, v.toString());
	};
	for (auto it = c.begin(); it != c.end(); ++it) {
		if (it.value().isObject()) {
			const QJsonObject sub = it.value().toObject();
			for (auto s = sub.begin(); s != sub.end(); ++s)
				put(it.key() + QLatin1Char('.') + s.key(), s.value());
		} else
			put(it.key(), it.value());
	}
	return out;
}

// Merge a pack over a base (the default pack); with no base the values only have to parse.
Data parse(const QJsonObject &o, const Data *base)
{
	Data d = base ? *base : Data();
	// Schema v2 parts (D336) apply only with the flag on AND a components block in this pack: a pack without one looks
	// exactly as it does with the flag off, whatever other v2 fields it carries (Codex review of T1).
	// D376: a pack marked componentsAlways uses them with the flag off too.
	const bool always = boolean(o.value(QStringLiteral("componentsAlways")), false);
	const bool v2 = (g_components || always) && o.contains(QStringLiteral("components"));
	d.componentsAlways = always;
	d.id = str(o.value(QStringLiteral("id")), d.id);
	d.name = str(o.value(QStringLiteral("name")), d.name.isEmpty() ? d.id : d.name);
	d.topic = str(o.value(QStringLiteral("topic")), d.topic);
	d.dark = boolean(o.value(QStringLiteral("dark")), d.dark);
	const QJsonObject c = o.value(QStringLiteral("colors")).toObject();
	for (const QString &k : kColorKeys)
		d.colors[k] = col(c.value(k), d.colors.value(k));
	const QJsonObject t = o.value(QStringLiteral("typography")).toObject();
	d.family = str(t.value(QStringLiteral("family")), d.family);
	if (t.value(QStringLiteral("fallbacks")).isArray()) {
		d.fallbacks.clear();
		for (const QJsonValue &v : t.value(QStringLiteral("fallbacks")).toArray())
			if (v.isString())
				d.fallbacks << v.toString();
	}
	d.base = num(t.value(QStringLiteral("baseSize")), d.base, 8, 14);
	d.letterSpacing = num(t.value(QStringLiteral("letterSpacing")), d.letterSpacing, -0.5, 2);
	// The pack's own hinting, never inherited (D376).
	d.hinting = str(t.value(QStringLiteral("hinting")), QStringLiteral("default"));
	const QJsonObject rad = o.value(QStringLiteral("geometry")).toObject().value(QStringLiteral("radius")).toObject();
	d.rs = inum(rad.value(QStringLiteral("small")), d.rs, 0, 40);
	d.rm = inum(rad.value(QStringLiteral("medium")), d.rm, 0, 40);
	d.rl = inum(rad.value(QStringLiteral("large")), d.rl, 0, 40);
	const QJsonObject m = o.value(QStringLiteral("motion")).toObject();
	d.fast = inum(m.value(QStringLiteral("fastMs")), d.fast, 0, 400);
	d.normal = inum(m.value(QStringLiteral("normalMs")), d.normal, 0, 600);
	d.slow = inum(m.value(QStringLiteral("slowMs")), d.slow, 0, 600);
	d.easing = str(m.value(QStringLiteral("easing")), d.easing);
	d.stroke = num(o.value(QStringLiteral("icons")).toObject().value(QStringLiteral("stroke")), d.stroke, 1.2, 3);
	// Schema v2 (D336): the pack's own parts only (never the default pack's), and only when v2 (above).
	d.comp.clear();
	if (v2) {
		d.comp = readComponents(o);
		const QJsonValue body = t.value(QStringLiteral("scale")).toObject().value(QStringLiteral("body"));
		if (body.isDouble()) // the type scale's body size is the app font's size
			d.base = std::clamp(body.toDouble(), 8.0, 14.0);
	}
	d.valid = d.colors.value(QStringLiteral("bg")).isValid() && !d.family.isEmpty();
	return d;
}

const Data &defaultData()
{
	static const Data d = parse(readJson(QStringLiteral(":/themes/") + kDefaultId + QStringLiteral(".json")), nullptr);
	return d;
}

// ---- LU2: live reload of the current pack (D324) ----
QFileSystemWatcher *g_watch = nullptr;
QTimer *g_reloadTimer = nullptr;
int g_reloadTries = 0; // retries of a pack file that could not be read (reloadCurrent)
QByteArray g_fileHash; // content hash of the pack file the current look came from (empty: embedded)

QString packFile(const QString &id)
{
	if (!validId(id))
		return {};
	for (const QString &dir : searchDirs()) {
		const QString p = dir + QLatin1Char('/') + id + QStringLiteral(".json");
		if (QFile::exists(p))
			return p;
	}
	return {};
}

QByteArray readBytes(const QString &path, bool *ok)
{
	QFile f(path);
	*ok = f.open(QIODevice::ReadOnly);
	return *ok ? f.readAll() : QByteArray();
}

QByteArray hashOf(const QByteArray &b)
{
	return QCryptographicHash::hash(b, QCryptographicHash::Sha256);
}

void rememberFile(const QString &id)
{
	const QString p = packFile(id);
	bool ok = false;
	const QByteArray b = p.isEmpty() ? QByteArray() : readBytes(p, &ok);
	g_fileHash = ok ? hashOf(b) : QByteArray();
	if (g_watch && ok && !g_watch->files().contains(p))
		g_watch->addPath(p);
}

// A pack's JSON made into the look (merged over the default pack). The JSON is kept with the look, so a flag switch
// parses the accepted version again, never a newer file on disk that live reload refused (D336).
Data fromJson(const QJsonObject &o, bool custom)
{
	if (o.isEmpty())
		return Data();
	if (const QString why = componentsProblem(o); !why.isEmpty()) { // D336: an unknown variant makes the pack unusable
		qWarning("theme: %s not usable: %s", qPrintable(o.value(QStringLiteral("id")).toString()), qPrintable(why));
		return Data();
	}
	Data d = parse(o, &defaultData());
	d.src = o;
	d.custom = custom;
	return d;
}

// The saved id of the pack that Ujwalam Light replaced (D389): the old Soft look is gone, its saved choice opens the light pack.
QString migratedId(const QString &id)
{
	return id == QStringLiteral("soft") ? QStringLiteral("ujwalam-light") : id;
}

Data load(const QString &idIn)
{
	const QString id = migratedId(idIn);
	bool custom = false;
	const QJsonObject o = packJson(id, &custom); // before fromJson: argument order is unspecified
	return fromJson(o, custom);
}

// The app palette: what the remaining Qt Widgets parts (the tray's list and menu, file and colour dialogs) draw with.
void applyPalette(QApplication &app, const Data &d)
{
	const auto c = [&](const char *k) { return d.colors.value(QLatin1String(k)); };
	QPalette p;
	p.setColor(QPalette::Window, c("bg"));
	p.setColor(QPalette::WindowText, c("text"));
	p.setColor(QPalette::Base, c("panel"));
	p.setColor(QPalette::AlternateBase, c("field"));
	p.setColor(QPalette::Text, c("text"));
	p.setColor(QPalette::Button, c("field"));
	p.setColor(QPalette::ButtonText, c("text"));
	p.setColor(QPalette::ToolTipBase, c("field"));
	p.setColor(QPalette::ToolTipText, c("text"));
	p.setColor(QPalette::PlaceholderText, c("muted"));
	p.setColor(QPalette::Highlight, c("accent"));
	p.setColor(QPalette::HighlightedText, c("onAccent"));
	p.setColor(QPalette::Link, c("accentHi"));
	for (auto role : {QPalette::WindowText, QPalette::Text, QPalette::ButtonText})
		p.setColor(QPalette::Disabled, role, c("disabled"));
	app.setPalette(p);
}

void applyFont(QApplication &app, const Data &d)
{
	QFont f;
	QStringList fam{d.family};
	fam << d.fallbacks;
	f.setFamilies(fam);
	f.setPointSizeF(d.base);
	f.setLetterSpacing(QFont::AbsoluteSpacing, d.letterSpacing);
	// D376: "full" keeps stems on the pixel grid (DirectWrite GDI-classic ClearType at any display scale).
	f.setHintingPreference(d.hinting == QStringLiteral("full")       ? QFont::PreferFullHinting
			       : d.hinting == QStringLiteral("vertical") ? QFont::PreferVerticalHinting
			       : d.hinting == QStringLiteral("none")     ? QFont::PreferNoHinting
									 : QFont::PreferDefaultHinting);
	app.setFont(f);
}

void applyAll(QApplication &app)
{
	applyPalette(app, g_cur);
	applyFont(app, g_cur);
	emit notifier()->changed();
}

// The current pack's file changed (or a file appeared in a theme folder): apply a valid new version, keep the look
// on an invalid one. A file that fails to parse less than 300 ms after it was written is retried (still being saved).
void reloadCurrent()
{
	if (!g_cur.valid)
		return;
	// A file that is missing (between delete and rename) or cannot be opened (a scanner or the saving program holds it)
	// is tried again a few times: no further file event may come, and that version would never be seen (a broken
	// save went unreported under load, 2026-11-14). An embedded-only pack just runs out of tries.
	const auto again = []() {
		if (++g_reloadTries <= 10)
			g_reloadTimer->start(300);
	};
	const QString p = packFile(g_cur.id);
	if (p.isEmpty())
		return again();
	if (g_watch && !g_watch->files().contains(p))
		g_watch->addPath(p); // a save through rename replaced the watched file
	bool ok = false;
	const QByteArray b = readBytes(p, &ok);
	if (!ok)
		return again();
	g_reloadTries = 0;
	const QByteArray h = hashOf(b);
	if (h == g_fileHash)
		return;
	const QString why = packProblem(b, g_cur.id);
	if (!why.isEmpty()) {
		const qint64 age = QFileInfo(p).lastModified().msecsTo(QDateTime::currentDateTime());
		if (age >= 0 && age < 300) {
			g_reloadTimer->start(300);
			return;
		}
		g_fileHash = h; // reported once per version of the file
		qWarning("theme: %s.json not applied, the last good look stays: %s", qPrintable(g_cur.id), qPrintable(why));
		emit notifier()->rejected(QStringLiteral("Theme not applied: the file has a problem"),
					  QStringLiteral("%1.json: %2. The last good look stays.").arg(g_cur.id, why));
		return;
	}
	Data d = load(g_cur.id);
	if (!d.valid)
		return;
	g_fileHash = h;
	g_cur = d;
	qInfo("theme: %s.json changed on disk; applied", qPrintable(g_cur.id));
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
}

void startWatch()
{
	if (g_watch)
		return;
	g_watch = new QFileSystemWatcher(qApp);
	g_reloadTimer = new QTimer(qApp);
	g_reloadTimer->setSingleShot(true);
	QObject::connect(g_reloadTimer, &QTimer::timeout, qApp, []() { reloadCurrent(); });
	const auto kick = [](const QString &) { g_reloadTries = 0; g_reloadTimer->start(200); }; // a new event: new tries
	QObject::connect(g_watch, &QFileSystemWatcher::fileChanged, qApp, kick);
	QObject::connect(g_watch, &QFileSystemWatcher::directoryChanged, qApp, kick);
	for (const QString &dir : searchDirs())
		if (QDir(dir).exists())
			g_watch->addPath(dir);
}

} // namespace

Notifier *notifier()
{
	if (!g_notifier)
		g_notifier = new Notifier();
	return g_notifier;
}

void apply(QApplication &app)
{
	app.setStyle(QStyleFactory::create(QStringLiteral("Fusion")));
	QString id = qEnvironmentVariable("UJWALAM_THEME");
	if (id.isEmpty())
		id = kDefaultId;
	loadBundledFonts();
	g_cur = load(id);
	if (!g_cur.valid)
		g_cur = load(kDefaultId);
	if (!g_cur.valid) // the embedded default is missing: Fusion's own look
		return;
	const QString fx = qEnvironmentVariable("UJWALAM_EFFECTS");
	if (fx == QStringLiteral("reduced") || fx == QStringLiteral("full") || fx == QStringLiteral("performance"))
		g_effects = fx;
	applyPalette(app, g_cur);
	applyFont(app, g_cur);
	startWatch();
	rememberFile(g_cur.id);
}

// ---- Texture and ambient blocks (Molten Stone, 2026-11-27) ----
// Painted 9-slice pictures per surface class and a few plain pictures, embedded from data/theme-textures/<id>/ as
// :/theme-tex/<id>/<name>.png (with @2x twins). The names are a closed list like the components: a typo is refused.
const QStringList &textureSlices()
{
	static const QStringList v = {QStringLiteral("base"), QStringLiteral("raised"), QStringLiteral("inset"), QStringLiteral("pressed"),
				      QStringLiteral("buttonNormal"), QStringLiteral("buttonPressed"), QStringLiteral("buttonDisabled"),
				      QStringLiteral("field"), QStringLiteral("fieldError"), QStringLiteral("track"), QStringLiteral("fill"),
				      QStringLiteral("card"), QStringLiteral("plate"), QStringLiteral("modal"), QStringLiteral("toast")};
	return v;
}

const QStringList &textureArt()
{
	static const QStringList v = {QStringLiteral("smoke"), QStringLiteral("drip"), QStringLiteral("empty"), QStringLiteral("avatar"),
				      QStringLiteral("spinner"), QStringLiteral("gear")};
	return v;
}

namespace {
bool wholeIn(const QJsonValue &v, int lo, int hi)
{
	return v.isDouble() && v.toDouble() == std::floor(v.toDouble()) && v.toDouble() >= lo && v.toDouble() <= hi;
}

// Empty when the texture and ambient blocks are usable (or absent); else why not.
QString textureProblem(const QJsonObject &pack)
{
	if (pack.contains(QStringLiteral("texture"))) {
		if (!pack.value(QStringLiteral("texture")).isObject())
			return QStringLiteral("texture must be an object");
		const QJsonObject t = pack.value(QStringLiteral("texture")).toObject();
		for (auto it = t.begin(); it != t.end(); ++it)
			if (it.key() != QStringLiteral("slices") && it.key() != QStringLiteral("art"))
				return QStringLiteral("texture.%1 is not known").arg(it.key());
		const QJsonObject sl = t.value(QStringLiteral("slices")).toObject();
		for (auto it = sl.begin(); it != sl.end(); ++it) {
			if (!textureSlices().contains(it.key()))
				return QStringLiteral("texture.slices.%1 is not a known surface").arg(it.key());
			const QJsonObject s = it.value().toObject();
			for (auto k = s.begin(); k != s.end(); ++k)
				if (k.key() != QStringLiteral("margin") && k.key() != QStringLiteral("outset") && k.key() != QStringLiteral("tile"))
					return QStringLiteral("texture.slices.%1.%2 is not known").arg(it.key(), k.key());
			if (!wholeIn(s.value(QStringLiteral("margin")), 1, 48) || !wholeIn(s.value(QStringLiteral("outset")), 0, 16)
			    || s.value(QStringLiteral("outset")).toInt() >= s.value(QStringLiteral("margin")).toInt())
				return QStringLiteral("texture.slices.%1 needs a margin 1 to 48 and an outset 0 to 16, smaller than the margin").arg(it.key());
			const QString tile = s.value(QStringLiteral("tile")).toString(QStringLiteral("round"));
			if (tile != QStringLiteral("round") && tile != QStringLiteral("repeat") && tile != QStringLiteral("stretch"))
				return QStringLiteral("texture.slices.%1.tile must be round, repeat or stretch").arg(it.key());
		}
		for (const QJsonValue &a : t.value(QStringLiteral("art")).toArray())
			if (!textureArt().contains(a.toString()))
				return QStringLiteral("texture.art: %1 is not a known picture").arg(a.toString());
	}
	if (pack.contains(QStringLiteral("ambient"))) {
		const QJsonObject a = pack.value(QStringLiteral("ambient")).toObject();
		for (auto it = a.begin(); it != a.end(); ++it)
			if ((it.key() != QStringLiteral("smoke") && it.key() != QStringLiteral("drip")) || !it.value().isBool())
				return QStringLiteral("ambient.%1 must be smoke or drip, true or false").arg(it.key());
	}
	return {};
}
} // namespace
QString packProblem(const QByteArray &bytes, const QString &id)
{
	QJsonParseError err;
	const QJsonDocument doc = QJsonDocument::fromJson(bytes, &err);
	if (err.error != QJsonParseError::NoError)
		return QStringLiteral("not valid JSON (at character %1)").arg(err.offset);
	if (!doc.isObject())
		return QStringLiteral("not a JSON object");
	const QJsonObject o = doc.object();
	if (o.value(QStringLiteral("id")).toString() != id)
		return QStringLiteral("its id must be %1").arg(id);
	// The parts the schema (data/themes/theme.schema.json) requires.
	for (const char *k : {"name", "topic", "version", "dark", "colors", "typography", "geometry", "depth", "motion", "background", "icons"})
		if (!o.contains(QLatin1String(k)))
			return QStringLiteral("%1 is missing").arg(QLatin1String(k));
	if (!o.value(QStringLiteral("colors")).isObject())
		return QStringLiteral("colors must be an object");
	static const QRegularExpression hex(QStringLiteral("^#[0-9a-fA-F]{6}$"));
	const QJsonObject c = o.value(QStringLiteral("colors")).toObject();
	for (const QString &k : kColorKeys)
		if (!hex.match(c.value(k).toString()).hasMatch())
			return QStringLiteral("colors.%1 must be a colour like #1a2b3c").arg(k);
	if (const QString why = textureProblem(o); !why.isEmpty())
		return why;
	return componentsProblem(o); // D336: unknown components or variants are refused
}

const QList<QPair<QString, QStringList>> &componentVariants()
{
	static const QList<QPair<QString, QStringList>> v = {
		{QStringLiteral("button.shape"), {QStringLiteral("rounded"), QStringLiteral("pill"), QStringLiteral("sharp")}},
		{QStringLiteral("button.style"),
		 {QStringLiteral("solid"), QStringLiteral("soft"), QStringLiteral("metal"), QStringLiteral("bezel"), QStringLiteral("neumorph"), QStringLiteral("raised"),
		  QStringLiteral("glass"), QStringLiteral("premium"), QStringLiteral("pixel"), QStringLiteral("liquid")}}, // glass .. liquid: RareUI slice 0, accepted and not drawn yet
		{QStringLiteral("button.secondary"), {QStringLiteral("outline"), QStringLiteral("tinted"), QStringLiteral("ghost")}},
		{QStringLiteral("button.caps"), kBool},
		{QStringLiteral("tabs"), {QStringLiteral("pill"), QStringLiteral("underline"), QStringLiteral("segmented"), QStringLiteral("boxed"), QStringLiteral("slide"), QStringLiteral("avatar"), QStringLiteral("dock")}},
		{QStringLiteral("input"), {QStringLiteral("outline"), QStringLiteral("filled"), QStringLiteral("inset"), QStringLiteral("underline"), QStringLiteral("soft")}},
		{QStringLiteral("focus"), {QStringLiteral("border"), QStringLiteral("ring"), QStringLiteral("glow")}},
		{QStringLiteral("switch"), {QStringLiteral("plain"), QStringLiteral("labelled"), QStringLiteral("bezel"), QStringLiteral("knob")}},
		{QStringLiteral("slider.track"), {QStringLiteral("thin"), QStringLiteral("thick"), QStringLiteral("inset")}},
		{QStringLiteral("slider.handle"), {QStringLiteral("round"), QStringLiteral("sphere"), QStringLiteral("bar")}},
		{QStringLiteral("slider.valueBubble"), kBool},
		{QStringLiteral("sectionHeader"), {QStringLiteral("plain"), QStringLiteral("rule"), QStringLiteral("caps"), QStringLiteral("bracket")}},
		{QStringLiteral("card"), {QStringLiteral("flat"), QStringLiteral("raised"), QStringLiteral("neumorph"), QStringLiteral("framed"), QStringLiteral("soft"), QStringLiteral("tilt"), QStringLiteral("shatter")}},
		{QStringLiteral("list"), {QStringLiteral("plain"), QStringLiteral("plates")}},
		{QStringLiteral("chip"), {QStringLiteral("pill"), QStringLiteral("bracket")}},
		{QStringLiteral("density"), {QStringLiteral("compact"), QStringLiteral("normal"), QStringLiteral("airy")}},
		// RareUI slice 0 (D384): accepted and kept, not drawn yet.
		{QStringLiteral("tooltip"), {QStringLiteral("plain"), QStringLiteral("liquid")}},
		{QStringLiteral("toast.style"), {QStringLiteral("plain"), QStringLiteral("stack"), QStringLiteral("bubble")}},
		{QStringLiteral("toast.richColors"), kBool},
		{QStringLiteral("toast.position"), {QStringLiteral("top-right"), QStringLiteral("top-left"), QStringLiteral("bottom-right"), QStringLiteral("bottom-left")}},
		{QStringLiteral("toast.swipe"), kBool},
		{QStringLiteral("spinner"), {QStringLiteral("ring"), QStringLiteral("bars"), QStringLiteral("dots")}},
		{QStringLiteral("text.entrance"), {QStringLiteral("none"), QStringLiteral("vapor"), QStringLiteral("scatter")}},
		{QStringLiteral("text.hover"), {QStringLiteral("none"), QStringLiteral("magnet"), QStringLiteral("bounce")}},
		{QStringLiteral("help"), {QStringLiteral("plain"), QStringLiteral("book")}},
		{QStringLiteral("clips"), {QStringLiteral("grid"), QStringLiteral("expand")}},
	};
	return v;
}

void setComponents(bool on)
{
	if (on == g_components)
		return;
	g_components = on;
	if (!g_cur.valid)
		return;
	const Data d = fromJson(g_cur.src, g_cur.custom); // the accepted pack parsed again with or without its v2 parts
	if (!d.valid)
		return;
	g_cur = d;
	qInfo("theme: components %s", on ? "on" : "off");
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
}

QString component(const QString &key)
{
	return compOn() ? g_cur.comp.value(key) : QString();
}

bool setCurrent(const QString &id)
{
	if (id == g_cur.id && g_cur.valid)
		return true;
	Data d = load(id);
	if (!d.valid)
		return false;
	g_cur = d;
	rememberFile(id);
	applyAll(*qobject_cast<QApplication *>(QCoreApplication::instance()));
	return true;
}

QString currentId()
{
	return g_cur.id;
}

QString currentFamily()
{
	return g_cur.valid ? g_cur.family : QStringLiteral("Inter");
}

bool currentDark()
{
	return g_cur.valid ? g_cur.dark : true;
}

void setEffects(const QString &mode)
{
	const QString m = (mode == QStringLiteral("reduced") || mode == QStringLiteral("performance")) ? mode : QStringLiteral("full");
	if (m == g_effects)
		return;
	g_effects = m;
	emit notifier()->changed();
}

QString effects()
{
	return g_effects;
}

bool performance()
{
	return g_effects == QStringLiteral("performance");
}

QString fxLevel(const QString &effectsMode, bool onAir)
{
	if (onAir || effectsMode == QStringLiteral("performance"))
		return QStringLiteral("plain");
	if (effectsMode == QStringLiteral("reduced"))
		return QStringLiteral("calm");
	return QStringLiteral("full");
}

QList<Info> available()
{
	QStringList ids;
	for (const QString &f : QDir(QStringLiteral(":/themes")).entryList({QStringLiteral("*.json")}))
		ids << f.left(f.size() - 5);
	for (const QString &dir : searchDirs())
		for (const QString &f : QDir(dir).entryList({QStringLiteral("*.json")}))
			if (!f.endsWith(QStringLiteral(".schema.json")) && !ids.contains(f.left(f.size() - 5)))
				ids << f.left(f.size() - 5);
	// Name order, then the default first; the two designed packs are put in front below (D389).
	ids.sort();
	ids.removeAll(kDefaultId);
	ids.prepend(kDefaultId);
	// The two designed packs first (D389): Ujwalam Light, then Ujwalam Night, then the default and the rest.
	if (ids.removeAll(QStringLiteral("ujwalam-night")))
		ids.prepend(QStringLiteral("ujwalam-night"));
	if (ids.removeAll(QStringLiteral("ujwalam-light")))
		ids.prepend(QStringLiteral("ujwalam-light"));
	QList<Info> out;
	for (const QString &id : ids) {
		const Data d = load(id);
		if (!d.valid)
			continue;
		Info i;
		i.id = d.id;
		i.name = d.name;
		i.topic = d.topic;
		i.dark = d.dark;
		i.custom = d.custom;
		i.bg = d.colors.value(QStringLiteral("bg"));
		i.panel = d.colors.value(QStringLiteral("panel"));
		i.text = d.colors.value(QStringLiteral("text"));
		i.accent = d.colors.value(QStringLiteral("accent"));
		out << i;
	}
	return out;
}

QColor color(const QString &token)
{
	return g_cur.colors.value(token, QColor());
}

int radius(Radius size)
{
	return size == Radius::Small ? g_cur.rs : size == Radius::Large ? g_cur.rl : g_cur.rm;
}

qreal iconStroke()
{
	return g_cur.stroke;
}

int duration(const QString &which)
{
	return which == QStringLiteral("fast") ? g_cur.fast : which == QStringLiteral("slow") ? g_cur.slow : g_cur.normal;
}

QEasingCurve::Type easing()
{
	static const QHash<QString, QEasingCurve::Type> m{
		{QStringLiteral("linear"), QEasingCurve::Linear},     {QStringLiteral("outQuad"), QEasingCurve::OutQuad},
		{QStringLiteral("outCubic"), QEasingCurve::OutCubic}, {QStringLiteral("outExpo"), QEasingCurve::OutExpo},
		{QStringLiteral("outBack"), QEasingCurve::OutBack},   {QStringLiteral("inOutQuad"), QEasingCurve::InOutQuad},
		{QStringLiteral("inOutCubic"), QEasingCurve::InOutCubic}};
	return m.value(g_cur.easing, QEasingCurve::OutCubic);
}

Spring spring()
{
	Spring sp; // 300 / 30 / 1 unless the pack's motion.spring says otherwise (schema limits applied again here)
	const QJsonObject o = g_cur.src.value(QStringLiteral("motion")).toObject().value(QStringLiteral("spring")).toObject();
	sp.stiffness = std::clamp(o.value(QStringLiteral("stiffness")).toDouble(sp.stiffness), 1.0, 2000.0);
	sp.damping = std::clamp(o.value(QStringLiteral("damping")).toDouble(sp.damping), 0.0, 200.0);
	sp.mass = std::clamp(o.value(QStringLiteral("mass")).toDouble(sp.mass), 0.1, 10.0);
	return sp;
}

QJsonObject systemBlock()
{
	return g_cur.src.value(QStringLiteral("system")).toObject();
}

// Read with the other v2 parts (the flag theme-components, or componentsAlways).
QJsonObject textureBlock()
{
	return compOn() ? g_cur.src.value(QStringLiteral("texture")).toObject() : QJsonObject();
}

QJsonObject ambientBlock()
{
	return compOn() ? g_cur.src.value(QStringLiteral("ambient")).toObject() : QJsonObject();
}

bool probeAction(const QString &action)
{
	if (action.startsWith(QStringLiteral("theme:")))
		return setCurrent(action.mid(6));
	if (action == QStringLiteral("fonts:load")) { // (tests) a second load must register nothing
		loadBundledFonts();
		return true;
	}
	if (action == QStringLiteral("components:on") || action == QStringLiteral("components:off")) { // D336 (tests)
		setComponents(action.endsWith(QStringLiteral("on")));
		return true;
	}
	if (action.startsWith(QStringLiteral("effects:"))) {
		// "effects:a+b" applies a then b in the same event-loop turn (a quick toggle, before deferred deletes run)
		const QStringList modes = action.mid(8).split(QLatin1Char('+'));
		for (const QString &m : modes)
			if (m != QStringLiteral("full") && m != QStringLiteral("reduced") && m != QStringLiteral("performance"))
				return false;
		for (const QString &m : modes)
			setEffects(m);
		return true;
	}
	return false;
}

} // namespace theme
