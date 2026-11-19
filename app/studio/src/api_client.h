// SPDX-License-Identifier: GPL-3.0-or-later
// Client of the studio UI server (services/studio-ui/server.mjs), the same narrow API the web page uses.
// login(): GET /login?k=<one-time launch key> -> session cookie (HttpOnly, kept in this process only), then
// GET /ui/api/session -> CSRF value. Every POST carries Origin = the server origin, the CSRF header and JSON.
// Only 127.0.0.1 URLs are accepted. The host token and event-core tokens never reach this process (D40).
#pragma once

#include <QJsonObject>
#include <QJsonValue>
#include <QNetworkAccessManager>
#include <QObject>
#include <QUrl>
#include <functional>
#include <vector>

class ApiClient : public QObject {
	Q_OBJECT
public:
	// result: the parsed JSON body (object); ok false on transport error or HTTP status >= 400 (error text in err).
	using Done = std::function<void(bool ok, const QJsonObject &body, const QString &err)>;

	explicit ApiClient(QObject *parent = nullptr);
	// base must be http://127.0.0.1:<port>/ ; returns false (and does nothing) for anything else.
	bool setBase(const QUrl &base);
	void login(const QString &launchKey, Done done);
	void get(const QString &route, Done done);
	void post(const QString &route, const QJsonObject &body, Done done);
	// POST /ui/api/host {method, params}
	void host(const QString &method, const QJsonObject &params, Done done);
	bool loggedIn() const { return !csrf_.isEmpty(); }
	// Early start (2026-11-19): requests made before the login (the QML loads while the UI server is not up yet) wait and
	// are sent once the login succeeded, in their order. Off by default; a failed login leaves them unsent.
	void holdUntilLogin() { hold_ = !loggedIn(); }
	// login()'s error text when the server did not answer at all (not up yet): the caller may try again.
	static constexpr const char *kNoAnswer = "no answer from the UI server";

private:
	void finish(class QNetworkReply *r, Done done);
	void sendGet(const QString &route, Done done);
	void release();
	bool hold_ = false;
	std::vector<std::function<void()>> pending_;
	QNetworkAccessManager nam_;
	QUrl base_;
	QString origin_;
	QByteArray cookie_; // "name=value"
	QByteArray csrf_;
};
