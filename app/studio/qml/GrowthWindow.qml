// SPDX-License-Identifier: GPL-3.0-or-later
// Growth numbers (AN1b, D372, flag growth; QML twin of the widget openGrowth, plan Q4): the user's own YouTube numbers
// for the videos Ujwalam posted, read only. Refresh asks the server to read YouTube again (at most once an hour unless
// "Refresh now" is used); nothing is posted or changed on YouTube. A column header click sorts by it. Its own window
// (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "growthDlg"
    required property var store
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(1360, parent ? parent.width - 40 : 1360)
    implicitHeight: Math.min(560, parent ? parent.height - 40 : 560)
    title: "Growth numbers"
    closePolicy: Popup.CloseOnEscape

    property string info: "Loading..."
    property string fetched: ""
    property var videos: []          // rows: [title, kind, public since, views, likes, avg %, shares, subs, 24 h, 7 d]
    property bool busy: false
    property bool signedIn: false
    property bool on: true
    property bool forceShown: false
    property string note: ""         // the result line of the last Refresh, shown once the list is read again
    property int sortCol: -1
    property bool sortUp: true
    property int gen: 0              // a close or a new open drops the answers of the old one

    readonly property var heads: ["Video", "Kind", "Public since", "Views", "Likes", "Avg viewed %", "Shares", "Subs gained", "After 24 hours", "After 7 days"]
    readonly property var widths: [0, 120, 150, 70, 60, 100, 64, 92, 250, 250] // column 0 takes the rest
    readonly property bool canRefresh: !busy && signedIn && on

    readonly property var rows: {
        const r = videos.slice();
        if (sortCol < 0) return r;
        const key = (row) => row.sort[sortCol];
        r.sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return sortUp ? c : -c; });
        return r;
    }

    function show() {
        gen++;
        info = "Loading...";
        fetched = "";
        videos = [];
        note = "";
        forceShown = false;
        busy = true;
        open();
        load();
        return true;
    }
    onClosed: gen++

    function local(iso, fmt) {
        const t = new Date(iso);
        return iso && !isNaN(t.getTime()) ? Qt.formatDateTime(t, fmt) : "";
    }
    function kindName(k) {
        return ({ montage: "Montage", "won-reel": "Won-round reel", "impact-play": "Impact play", "long-highlights": "Long highlights", clip: "Clip", short: "Clip" })[k] || (k ? k : "-");
    }
    // A number, or "-" when YouTube has not given it yet (sorts below every number).
    function num(x, decimals) { return typeof x === "number" ? String(decimals ? Number(x.toFixed(decimals)) : Math.trunc(x)) : "-" }
    function sortNum(x) { return typeof x === "number" ? x : -1 }
    function checkpoint(c) {
        if (!c || Object.keys(c).length === 0) return "not reached yet";
        const n = (k, d) => typeof c[k] === "number" ? c[k].toFixed(d || 0) : "-";
        return n("views") + " views, " + n("likes") + " likes, " + n("avgViewedPct", 1) + "% viewed, +" + n("subs") + " subs";
    }
    function fail(err) {
        err = String(err || "");
        if (err.indexOf("growth-off") >= 0)
            return "Growth numbers are switched off. Switch on \"Growth numbers\" in Settings > Posting & growth and click Save.";
        if (err.indexOf("analytics-scope-missing") >= 0)
            return "YouTube is signed in but does not yet allow reading statistics. Sign in again so it asks for that permission (steps: Settings > Posting & growth, and docs/plan/2026-11-12-growth-setup-notes.md).";
        if (err.indexOf("youtube-not-signed-in") >= 0 || err.indexOf("youtube-no-client") >= 0)
            return "Not signed in to YouTube. Set up the sign-in first (Settings > Posting & growth, and docs/plan/2026-11-12-growth-setup-notes.md).";
        if (err.indexOf("refresh-in-progress") >= 0)
            return "A read is already running.";
        return "Could not read your numbers (" + err + "). Nothing was changed.";
    }

    function load() {
        const g = gen;
        Api.get("ui/api/growth", (ok, r, err) => {
            if (g !== gen) return;
            on = !(!ok && String(err).indexOf("growth-off") >= 0);
            if (!ok) {
                videos = [];
                fetched = "";
                signedIn = false;
                info = fail(err);
                note = "";
                busy = false;
                return;
            }
            signedIn = r.signedIn === true;
            const nextAt = r.nextAllowedAt || "";
            const vids = r.videos || [];
            const last = r.lastFetchAt || "";
            fetched = last === "" ? "Not read from YouTube yet."
                    : "Last read from YouTube: " + local(last, "d MMM yyyy HH:mm") + "." + (nextAt === "" ? "" : " Refresh is allowed again at " + local(nextAt, "HH:mm") + ".");
            if (!signedIn)
                info = "Not signed in to YouTube, so numbers cannot be read yet. Set up the sign-in (Settings > Posting & growth, and docs/plan/2026-11-12-growth-setup-notes.md)." +
                       (vids.length === 0 ? "" : " The numbers below are from the last read.");
            else if (vids.length === 0)
                info = "No posted videos yet. Upload a clip to YouTube from the Posts window, then click Refresh. YouTube shows the full statistics a day or two after a video goes public.";
            else
                info = vids.length + " posted video(s). Read only: nothing is posted or changed on YouTube. Click a column to sort.";
            if (note !== "") { info = note; note = ""; }
            videos = vids.map(o => {
                const lt = o.latest || {};
                const pub = o.publicAt || "";
                const cells = [o.title || o.videoId || "", kindName(o.kind || ""), pub === "" ? "not public yet" : local(pub, "d MMM yyyy HH:mm"),
                               num(lt.views), num(lt.likes), num(lt.avgViewedPct, 1), num(lt.shares), num(lt.subs), checkpoint(o.at24h), checkpoint(o.at7d)];
                const sort = cells.slice();
                sort[2] = pub; // by time, not by the shown text
                [3, 4, 5, 6, 7].forEach((c, i) => sort[c] = sortNum([lt.views, lt.likes, lt.avgViewedPct, lt.shares, lt.subs][i]));
                return { cells: cells, sort: sort };
            });
            busy = r.busy === true;
        });
    }
    function refresh(force) {
        if (!canRefresh) return false;
        busy = true;
        info = "Reading your numbers from YouTube...";
        const g = gen;
        Api.post("ui/api/growth/refresh", force ? { force: true } : {}, (ok, r, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) note = fail(err);
            else if (typeof r.skipped === "string") {
                forceShown = true;
                note = "Read less than an hour ago, so nothing new was fetched. Use \"Refresh now\" to read again anyway.";
            } else {
                const miss = r.analyticsMissing || 0;
                note = "Done: " + (r.snapshots || 0) + " video(s) read, " + (r["public"] || 0) + " public" +
                       (miss > 0 ? ", " + miss + " without statistics yet (YouTube fills them a day or two late)" : "") + ".";
            }
            load();
        });
        return true;
    }
    function sortBy(c) {
        if (sortCol === c) sortUp = !sortUp;
        else { sortCol = c; sortUp = true; }
    }

    // ---- probe (tests): growth-open, growth-refresh, growth-force, growth-sort:<column>, growth-close ----
    function probe() {
        return { open: opened, info: info, fetched: fetched, rows: rows.length, cells: rows.map(r => r.cells),
                 refreshEnabled: canRefresh, forceVisible: forceShown };
    }
    function probeAction(a) {
        if (a === "growth-open") return show();
        if (!opened) return false;
        if (a === "growth-refresh") return refresh(false);
        if (a === "growth-force") return forceShown && refresh(true);
        if (a.startsWith("growth-sort:")) { const c = parseInt(a.slice(12), 10); if (!(c >= 0 && c < heads.length)) return false; sortBy(c); return true }
        if (a === "growth-close") { close(); return true }
        return false;
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    // Anchors, not one Column: a table height taken from its own place in a Column relayouts it forever (the window hung).
    contentItem: Item {
      Column {
        id: top
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: 8
        Text {
            objectName: "growthInfo"
            width: parent.width
            text: dlg.info
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        Text {
            objectName: "growthFetched"
            width: parent.width
            visible: text !== ""
            text: dlg.fetched
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        // Header row: a click sorts by that column (again: the other way round).
        Row {
            id: headRow
            width: parent.width
            Repeater {
                model: dlg.heads
                delegate: Rectangle {
                    required property string modelData
                    required property int index
                    objectName: "growthHead:" + index
                    width: index === 0 ? headRow.width - dlg.widths.reduce((s, w) => s + w, 0) : dlg.widths[index]
                    height: 30
                    color: Theme.c.field
                    border.width: 1
                    border.color: Theme.c.border
                    Accessible.role: Accessible.ColumnHeader
                    Accessible.name: modelData
                    Text {
                        anchors { fill: parent; leftMargin: 6; rightMargin: 6 }
                        verticalAlignment: Text.AlignVCenter
                        horizontalAlignment: index >= 3 && index <= 7 ? Text.AlignRight : Text.AlignLeft
                        text: parent.modelData + (dlg.sortCol === parent.index ? (dlg.sortUp ? "  ▲" : "  ▼") : "")
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 13
                        font.weight: Font.DemiBold
                    }
                    TapHandler { onTapped: dlg.sortBy(parent.index) }
                }
            }
        }
      }
        ListView {
            id: table
            objectName: "growthTable"
            anchors { left: parent.left; right: parent.right; top: top.bottom; bottom: parent.bottom }
            clip: true
            model: dlg.rows
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Row {
                id: line
                required property var modelData
                required property int index
                width: table.width
                Repeater {
                    model: line.modelData.cells
                    delegate: Text {
                        required property string modelData
                        required property int index
                        width: index === 0 ? headRow.width - dlg.widths.reduce((s, w) => s + w, 0) : dlg.widths[index]
                        height: 28
                        leftPadding: 6
                        rightPadding: 6
                        verticalAlignment: Text.AlignVCenter
                        horizontalAlignment: index >= 3 && index <= 7 ? Text.AlignRight : Text.AlignLeft
                        text: modelData
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 13
                    }
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Row {
            anchors { left: parent.left; leftMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "growthRefresh"
                text: "Refresh"
                tip: "Read your numbers from YouTube again. Allowed once an hour."
                enabled: dlg.canRefresh
                onClicked: dlg.refresh(false)
            }
            UButton {
                objectName: "growthForce"
                text: "Refresh now"
                tip: "Read again even if it was read less than an hour ago. Uses a little of YouTube's daily allowance."
                visible: dlg.forceShown
                enabled: dlg.canRefresh
                onClicked: dlg.refresh(true)
            }
        }
        UButton {
            objectName: "growthClose"
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
