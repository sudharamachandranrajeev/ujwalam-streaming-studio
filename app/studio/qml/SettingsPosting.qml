// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Posting & growth > Auto-post (the widget's autopost::Card, D375; plan Q3 slice 4): what uploads by itself, how
// many a day, how far apart and how far ahead, and the next posting times. Every automatic upload goes up scheduled
// (private until its publish time). It loads ui/api/posts/auto/settings and .../schedule when Settings opens (flag posting
// on); Save sends ui/api/posts/auto/settings only when the card changed (the server checks every value again). Moving or
// removing a queued clip acts on its own click (ui/api/posts/auto/queue/move|remove, D332). Not live-gated, like the widget.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: ap
    required property var box
    width: parent ? parent.width : 0
    spacing: Theme.sp.m

    readonly property var kindList: [
        { id: "short", text: "Short clips" }, { id: "montage", text: "Montages" },
        { id: "won-reel", text: "Won-round reels" }, { id: "impact-play", text: "Impact plays" }
    ]

    // ---- state ----
    property bool loaded: false
    property bool started: false          // the load is on its way or done (Settings starts it as soon as the flags are known)
    property int gen: 0                   // a newer load or reset drops older answers
    property var card: ({ autoUpload: true, kinds: [], minScore: 0, maxPerDay: 1, intervalHours: 1, maxAheadDays: 60, placement: "random-daily", quotaUnitsPerDay: 10000, postsPerDayMin: 3, postsPerDayMax: 6, windowStart: "09:00", windowEnd: "23:00", minGapMinutes: 90 })
    property string orig: ""              // the card as loaded, to see a change
    property var quota: ({})
    property int maxPerDayLimit: 100
    property string flagsText: ""
    property string timesInfo: "Loading..."
    property var times: []                // [{text, id, movable}]
    property string message: ""
    property string movingId: ""          // the clip whose new time is being typed
    property string moveText: ""

    readonly property bool active: box.ready && box.flagOn("posting")
    readonly property bool dirty: loaded && JSON.stringify(card) !== orig
    readonly property string problem: card.kinds.length === 0 ? "Choose at least one kind of clip to upload."
        : card.postsPerDayMin > card.postsPerDayMax ? "The fewest posts a day must not be more than the most."
        : minutesOf(card.windowEnd, 0) <= minutesOf(card.windowStart, 0) ? "The posting window must end after it starts." : ""
    readonly property bool blocksSave: dirty && problem !== ""
    readonly property string fit: {
        // Same sum as the server (quota-budget.mjs loadQuota): (quota - read reserve) / (upload + thumbnail units); 0 is
        // possible and is said plainly (the daily budget then stops every upload).
        const per = typeof quota.perUploadUnits === "number" ? quota.perUploadUnits : 0;
        const reserve = typeof quota.readReserveUnits === "number" ? quota.readReserveUnits : 0;
        const q = card.quotaUnitsPerDay;
        const n = per > 0 ? Math.max(0, Math.floor((q - reserve) / per)) : maxPerDayLimit;
        if (n === 0) return "No upload fits in a quota of " + q.toLocaleString(Qt.locale("en_US"), "f", 0) + " units a day (one upload needs "
            + (per + reserve).toLocaleString(Qt.locale("en_US"), "f", 0) + "): nothing uploads until the quota is raised.";
        return "About " + n + " uploads a day fit in the quota." + (card.maxPerDay > n ? " More than that a day stop at the quota and wait for the next day." : "");
    }

    onActiveChanged: { if (!active) reset(); else if (!started) load() }
    visible: active
    enabled: loaded

    readonly property var placements: ["random-daily", "fill-gaps", "after-last"]
    readonly property bool randomDaily: card.placement === "random-daily"
    // "HH:MM" <-> minutes after midnight (the window boxes count in minutes, 30-minute steps)
    function minutesOf(s, def) { const m = /^(\d{2}):(\d{2})$/.exec(String(s || "")); return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : def }
    function hhmm(n) { return two(Math.floor(n / 60)) + ":" + two(n % 60) }
    function clamp(n, lo, hi, def) { return Math.max(lo, Math.min(hi, typeof n === "number" && !isNaN(n) ? n : def)) }
    function round1(n) { return Math.round(n * 10) / 10 }
    function localTime(iso) {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? String(iso) : Qt.formatDateTime(d, "ddd d MMM, HH:mm");
    }
    function problemsText(arr) { return (arr || []).map(p => p.text).join("; ") }

    function reset() {
        gen++;
        started = false;
        loaded = false;
        card = ({ autoUpload: true, kinds: [], minScore: 0, maxPerDay: 1, intervalHours: 1, maxAheadDays: 60, placement: "random-daily", quotaUnitsPerDay: 10000, postsPerDayMin: 3, postsPerDayMax: 6, windowStart: "09:00", windowEnd: "23:00", minGapMinutes: 90 });
        orig = "";
        quota = ({});
        flagsText = "";
        timesInfo = "Loading...";
        times = [];
        message = "";
        movingId = "";
        moveText = "";
    }

    function load() {
        const g = ++gen;
        started = true;
        Api.get("ui/api/posts/auto/settings", (ok, b, err) => {
            if (g !== gen) return; // closed, or opened again, before the answer came
            if (!ok) { timesInfo = "Auto-post settings are not available: " + err; return }
            render(b);
            loadTimes(false);
        });
    }

    function render(b) {
        const c = b.card || ({}), fl = b.flags || ({});
        quota = b.quota || ({});
        const lim = (b.limits || ({})).maxPerDay;
        maxPerDayLimit = typeof lim === "number" ? lim : 100;
        const ks = Array.isArray(c.kinds) ? c.kinds : [];
        card = {
            autoUpload: c.autoUpload === true,
            kinds: kindList.map(k => k.id).filter(id => ks.includes(id)),
            minScore: round1(clamp(c.minScore, 0, 100, 0)),
            maxPerDay: clamp(c.maxPerDay, 1, maxPerDayLimit, 1),
            intervalHours: clamp(c.intervalHours, 1, 48, 1),
            maxAheadDays: clamp(c.maxAheadDays, 1, 730, 60),
            placement: placements.includes(c.placement) ? c.placement : "random-daily",
            quotaUnitsPerDay: clamp(c.quotaUnitsPerDay, 1000, 10000000, 10000),
            postsPerDayMin: clamp(c.postsPerDayMin, 1, 24, 3),
            postsPerDayMax: clamp(c.postsPerDayMax, 1, 24, 6),
            windowStart: hhmm(minutesOf(c.windowStart, 540)),
            windowEnd: hhmm(minutesOf(c.windowEnd, 1380)),
            minGapMinutes: clamp(c.minGapMinutes, 15, 1440, 90)
        };
        const off = [];
        if (fl.autoPost !== true) off.push("Auto post");
        if (fl.schedule !== true) off.push("Scheduled posting");
        let t = off.length === 0 ? "Auto post and Scheduled posting are on."
            : "Nothing uploads by itself until " + off.join(" and ") + (off.length > 1 ? " are" : " is") + " switched on below.";
        t += fl.deleteUploaded === true
            ? " Delete posted clips forever is on: each clip file is deleted permanently once YouTube has processed its upload."
            : " Posted clip files stay in the clips folder.";
        if (b.custom === true) t += " Your rules file was edited by hand; Save replaces it with these values.";
        const bad = String(b.error || "") + String(b.scheduleError || "");
        if (bad !== "") t += " Your saved settings could not be read (" + bad + "); the defaults are shown, and Save writes them again.";
        flagsText = t;
        orig = JSON.stringify(card);
        loaded = true;
    }

    function loadTimes(fresh) {
        const g = gen;
        Api.get("ui/api/posts/auto/schedule?count=10" + (fresh ? "&fresh=1" : ""), (ok, b, err) => {
            if (g !== gen) return;
            if (!ok) { timesInfo = "The posting times are not available: " + err; return }
            renderTimes(b);
        });
    }

    function renderTimes(b) {
        const err = b.error || "", live = b.liveError || "";
        let info;
        if (err === "schedule-read-incomplete")
            info = "The last channel read did not reach back far enough to see every scheduled post, so no time is given (nothing uploads until it does).";
        else if (err !== "")
            info = "The schedule settings are not valid, so no time is given.";
        else if (b.source === "none")
            info = "The channel has not been read yet; the times below may move once it is.";
        else
            info = "Channel read " + (b.channelReadAt ? localTime(b.channelReadAt) : "earlier") + ". Times are in your time zone; each post is at least "
                + (b.placement === "random-daily" ? (b.minGapMinutes || 0) + " min" : (b.intervalHours || 0) + " h") + " from the next.";
        if (live === "schedule-scope-missing") info += " Could not read the channel: sign in again so YouTube allows reading scheduled posts.";
        else if (live !== "") info += " Could not read the channel just now (" + live + ").";
        timesInfo = info;
        const rows = [];
        const queue = Array.isArray(b.queue) ? b.queue : [], channel = Array.isArray(b.channel) ? b.channel : [], next = Array.isArray(b.next) ? b.next : [];
        for (const q of queue) {
            const at = q.publishAt || "", st = q.state;
            const what = st === "done" ? "uploaded, scheduled" : st === "uploading" ? "uploading, scheduled" : "queued clip, scheduled";
            rows.push({ text: (at === "" ? "time not set yet" : localTime(at)) + "  -  " + what, id: q.id || "", movable: q.movable === true && at !== "" });
        }
        for (const c of channel) rows.push({ text: localTime(c) + "  -  already scheduled on the channel", id: "", movable: false });
        for (const n of next) rows.push({ text: localTime(n) + "  -  free: the next clip goes up Scheduled for this time", id: "", movable: false });
        if (rows.length === 0) rows.push({ text: "No posting times yet.", id: "", movable: false });
        times = rows;
    }

    // ---- changes ----
    function set(k, v) {
        if (!loaded) return false;
        const c = Object.assign({}, card);
        c[k] = v;
        card = c;
        return true;
    }
    function setKind(id, on) {
        if (!loaded || !kindList.some(k => k.id === id)) return false;
        const has = card.kinds.includes(id);
        if (has === on) return true;
        return set("kinds", kindList.map(k => k.id).filter(x => x === id ? on : card.kinds.includes(x)));
    }
    function setNum(k, n, lo, hi) { return set(k, k === "minScore" ? round1(clamp(n, lo, hi, lo)) : clamp(Math.round(n), lo, hi, lo)) }

    // What Save sends: nothing when the card did not change. The page goes with the Settings window right after Save, so
    // the answer only needs the store.
    function save() {
        if (!dirty) return;
        const body = JSON.parse(JSON.stringify(card));
        const store = box.store, g = gen;
        Api.post("ui/api/posts/auto/settings", { card: body }, (ok, b, err) => {
            if (ok) {
                if (g === gen) orig = JSON.stringify(body);
                return store.say("Auto-post settings saved; the next upload pass uses them.");
            }
            const why = problemsText(b && b.problems);
            store.say("Auto-post settings not saved: " + (why !== "" ? why : err));
        });
    }

    function move(id, at) {
        const g = gen;
        Api.post("ui/api/posts/auto/queue/move", { id: id, at: at }, (ok, b, err) => {
            if (g !== gen) return;
            message = ok ? "Moved to " + localTime(b.publishAt || "") + "." : "Not moved: " + ((b && b.text) ? b.text : err);
            if (ok) movingId = "";
            loadTimes(false);
        });
    }
    function remove(id) {
        const g = gen;
        Api.post("ui/api/posts/auto/queue/remove", { id: id }, (ok, b, err) => {
            if (g !== gen) return;
            message = ok ? "Taken out of the upload queue." : "Not removed: " + ((b && b.text) ? b.text : err);
            loadTimes(false);
        });
    }

    // The Move box takes the PC's own time on the hour, "2026-11-14 18:00" (the widget has a calendar window for it).
    function two(n) { return (n < 10 ? "0" : "") + n }
    function startMove(id) {
        const d = new Date(Date.now() + 3 * 3600 * 1000);
        movingId = id;
        moveText = d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + two(d.getHours()) + ":00";
    }
    function goMove() {
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2})(?::\d{2})?$/.exec(moveText.trim());
        if (!m) { message = "Not moved: type the new time like 2026-11-14 18:00 (your time zone, on the hour)."; return }
        const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), 0, 0);
        if (isNaN(d.getTime())) { message = "Not moved: that time does not exist."; return }
        move(movingId, d.toISOString().replace(/\.\d+Z$/, "Z"));
    }

    component Words: Text {
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.body
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
    // a label over its control; a Flow puts as many of them in a row as fit, so the page never needs sideways room
    component Field: Column {
        property string label: ""
        width: 250
        spacing: Theme.sp.xs
        Words { text: parent.label }
    }
    // a box that follows the page's value even after the user picked one (a picked value breaks a plain binding)
    component PickBox: UCombo {
        id: pb
        property int want: 0
        Binding { target: pb; property: "currentIndex"; value: pb.want }
    }
    component SpinBox2: USpin {
        id: sb
        property int want: 0
        Binding { target: sb; property: "value"; value: sb.want }
    }
    component KindToggle: UToggle {
        id: kt
        property bool want: false
        Binding { target: kt; property: "checked"; value: kt.want }
    }

    UCard {
        title: "AUTO-POST"
        Quiet {
            text: "Clips from your clips folder go up to YouTube by themselves, each as a scheduled post (with a few a day at random times the order is mixed, never two of the same kind in a row when another kind is waiting; otherwise oldest first): private until its publish time, then public. "
                + "Times are picked around the posts already scheduled on your channel, never two at the same time. Changes apply from the next upload pass when you click Save."
        }
        Quiet { objectName: "autopostFlags"; text: ap.flagsText }
        USwitch {
            id: upSw
            objectName: "autopostUpload"
            width: parent.width
            text: "Upload clips automatically"
            checked: ap.card.autoUpload
            onToggled: ap.set("autoUpload", checked)
            Binding { target: upSw; property: "checked"; value: ap.card.autoUpload }
        }
        Words { text: "What uploads:" }
        Flow {
            width: parent.width
            spacing: Theme.sp.s
            Repeater {
                model: ap.kindList
                delegate: KindToggle {
                    required property var modelData
                    objectName: "autopostKind_" + modelData.id
                    text: modelData.text
                    want: ap.card.kinds.includes(modelData.id)
                    onToggled: ap.setKind(modelData.id, checked)
                }
            }
        }
        Flow {
            width: parent.width
            spacing: Theme.sp.l
            Field {
                label: "Minimum clip score:"
                SpinBox2 {
                    objectName: "autopostScore"
                    label: "Minimum clip score"
                    from: 0
                    to: 1000
                    stepSize: 10
                    // tenths of a point: 3.0 is 30
                    textFromValue: (v) => (v / 10).toFixed(1)
                    valueFromText: (t) => Math.round(parseFloat(String(t).replace(",", ".")) * 10) || 0
                    want: Math.round(ap.card.minScore * 10)
                    onValueModified: ap.setNum("minScore", value / 10, 0, 100)
                }
                Quiet { text: "Short clips need at least this score. Montages, reels and impact plays have no clip score: choosing the kind is enough." }
            }
            Field {
                label: "Uploads at most:"
                SpinBox2 {
                    objectName: "autopostPerDay"
                    label: "Uploads at most"
                    suffix: " a day"
                    from: 1
                    to: ap.maxPerDayLimit
                    want: ap.card.maxPerDay
                    onValueModified: ap.setNum("maxPerDay", value, 1, ap.maxPerDayLimit)
                }
            }
            Field {
                label: "Time between posts:"
                SpinBox2 {
                    objectName: "autopostGap"
                    label: "Time between posts"
                    suffix: " h"
                    from: 1
                    to: 48
                    enabled: !ap.randomDaily
                    want: ap.card.intervalHours
                    onValueModified: ap.setNum("intervalHours", value, 1, 48)
                }
                Quiet { text: ap.randomDaily ? "Not used with a few a day at random times: the gap below is used instead." : "Every post, yours from Ujwalam or already on the channel, is at least this far from the next." }
            }
            Field {
                label: "Schedule up to:"
                SpinBox2 {
                    objectName: "autopostDays"
                    label: "Schedule up to"
                    suffix: " days"
                    from: 1
                    to: 730
                    want: ap.card.maxAheadDays
                    onValueModified: ap.setNum("maxAheadDays", value, 1, 730)
                }
                Quiet { text: "A clip whose next free time is further ahead waits until it fits." }
            }
            Field {
                label: "Where new posts go:"
                width: 330
                PickBox {
                    objectName: "autopostPlacement"
                    width: parent.width
                    label: "Where new posts go"
                    model: [{ value: "random-daily", text: "A few a day at random times" }, { value: "fill-gaps", text: "Fill the free times between posts" }, { value: "after-last", text: "Always after the last scheduled post" }]
                    want: Math.max(0, ap.placements.indexOf(ap.card.placement))
                    onChose: (v) => ap.set("placement", v)
                }
            }
            Field {
                label: "Posts a day, fewest:"
                SpinBox2 {
                    objectName: "autopostDayMin"
                    label: "Posts a day, fewest"
                    enabled: ap.randomDaily
                    from: 1
                    to: 24
                    want: ap.card.postsPerDayMin
                    onValueModified: ap.setNum("postsPerDayMin", value, 1, 24)
                }
                Quiet { text: "Each day gets a random number of posts between the fewest and the most." }
            }
            Field {
                label: "Posts a day, most:"
                SpinBox2 {
                    objectName: "autopostDayMax"
                    label: "Posts a day, most"
                    enabled: ap.randomDaily
                    from: 1
                    to: 24
                    want: ap.card.postsPerDayMax
                    onValueModified: ap.setNum("postsPerDayMax", value, 1, 24)
                }
                Quiet { text: "A day that has no room for that many takes what fits." }
            }
            Field {
                label: "Post from:"
                SpinBox2 {
                    objectName: "autopostWindowStart"
                    label: "Post from"
                    enabled: ap.randomDaily
                    from: 0
                    to: 1410
                    stepSize: 30
                    textFromValue: (v) => ap.hhmm(v)
                    valueFromText: (t) => ap.minutesOf(String(t).trim(), 540)
                    want: ap.minutesOf(ap.card.windowStart, 540)
                    onValueModified: ap.set("windowStart", ap.hhmm(value))
                }
                Quiet { text: "Your time zone. No post goes up before this time of day." }
            }
            Field {
                label: "Post until:"
                SpinBox2 {
                    objectName: "autopostWindowEnd"
                    label: "Post until"
                    enabled: ap.randomDaily
                    from: 30
                    to: 1439
                    stepSize: 30
                    textFromValue: (v) => ap.hhmm(v)
                    valueFromText: (t) => ap.minutesOf(String(t).trim(), 1380)
                    want: ap.minutesOf(ap.card.windowEnd, 1380)
                    onValueModified: ap.set("windowEnd", ap.hhmm(value))
                }
                Quiet { text: "No post goes up after this time of day." }
            }
            Field {
                label: "At least apart:"
                SpinBox2 {
                    objectName: "autopostGapMinutes"
                    label: "At least apart"
                    enabled: ap.randomDaily
                    suffix: " min"
                    from: 15
                    to: 1440
                    stepSize: 15
                    want: ap.card.minGapMinutes
                    onValueModified: ap.setNum("minGapMinutes", value, 15, 1440)
                }
                Quiet { text: "Every post, yours from Ujwalam or already on the channel, is at least this far from the next." }
            }
            Field {
                label: "YouTube quota:"
                width: 330
                SpinBox2 {
                    objectName: "autopostQuota"
                    label: "YouTube quota"
                    suffix: " units a day"
                    from: 1000
                    to: 10000000
                    stepSize: 1000
                    width: 200
                    want: ap.card.quotaUnitsPerDay
                    onValueModified: ap.setNum("quotaUnitsPerDay", value, 1000, 10000000)
                }
                Quiet { text: "Your YouTube Data API quota (Google Cloud Console > APIs & Services > Quotas). Raise it here after Google grants more." }
            }
        }
        Quiet { objectName: "autopostFit"; text: ap.fit }
        Text {
            objectName: "autopostProblem"
            visible: ap.problem !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: ap.problem
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }

    UCard {
        title: "NEXT POSTING TIMES"
        Quiet { objectName: "autopostTimesInfo"; text: ap.timesInfo }
        Repeater {
            model: ap.times
            delegate: Item {
                id: tr
                required property var modelData
                required property int index
                width: parent.width
                height: Math.max(label.implicitHeight, 34)
                Text {
                    id: label
                    objectName: "autopostTime:" + tr.index
                    anchors { left: parent.left; right: btns.left; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                    wrapMode: Text.Wrap
                    text: tr.modelData.text
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
                Row {
                    id: btns
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    spacing: Theme.sp.s
                    visible: tr.modelData.movable
                    UButton { objectName: "autopostMove:" + tr.modelData.id; text: "Move"; onClicked: ap.startMove(tr.modelData.id) }
                    UButton {
                        objectName: "autopostRemove:" + tr.modelData.id
                        text: "Remove"
                        tip: "Takes this clip out of the upload queue. Its post stays in the Posts window."
                        onClicked: ap.remove(tr.modelData.id)
                    }
                }
            }
        }
        Column {
            objectName: "autopostMoveBox"
            visible: ap.movingId !== ""
            width: parent.width
            spacing: Theme.sp.s
            Words { text: "New publish time (your time zone, on the hour):" }
            Row {
                spacing: Theme.sp.s
                UField {
                    objectName: "autopostMoveText"
                    width: 200
                    label: "New publish time"
                    text: ap.moveText
                    onTextEdited: ap.moveText = text
                }
                UButton { objectName: "autopostMoveGo"; text: "Move"; kind: "primary"; onClicked: ap.goMove() }
                UButton { objectName: "autopostMoveCancel"; text: "Cancel"; onClicked: ap.movingId = "" }
            }
        }
        UButton {
            objectName: "autopostRefresh"
            text: "Check the channel again"
            tip: "Reads the posts already scheduled on your channel (read only, at most every 10 minutes)."
            onClicked: ap.loadTimes(true)
        }
        Quiet { objectName: "autopostMsg"; text: ap.message }
    }

    // ---- probe (tests): the same names and values as the widget card's probe ----
    function probe() {
        return { loaded: loaded, card: JSON.parse(JSON.stringify(card)), dirty: dirty, fit: fit, flags: flagsText, problem: problem,
            timesInfo: timesInfo, times: times.map(t => t.text), message: message };
    }

    // ap-upload:<on|off> | ap-kind:<id>:<on|off> | ap-score:<n> | ap-perday:<n> | ap-gap:<h> | ap-days:<n> | ap-placement:<id>
    // | ap-daymin:<n> | ap-daymax:<n> | ap-gapmin:<n> | ap-window:<from min>:<until min> | ap-quota:<n> | ap-refresh | ap-move:<id>:<UTC time> | ap-remove:<id>
    function probeAction(p) {
        if (!loaded) return false;
        const a = p[0], arg = p[1];
        const on = (v) => v === "on" || v === "1";
        if (a === "ap-upload") return set("autoUpload", on(arg));
        if (a === "ap-kind" && p.length === 3) return setKind(arg, on(p[2]));
        const n = parseInt(arg, 10);
        if (a === "ap-score" && !isNaN(n)) return setNum("minScore", n, 0, 100);
        if (a === "ap-perday" && !isNaN(n)) return setNum("maxPerDay", n, 1, maxPerDayLimit);
        if (a === "ap-gap" && !isNaN(n)) return setNum("intervalHours", n, 1, 48);
        if (a === "ap-days" && !isNaN(n)) return setNum("maxAheadDays", n, 1, 730);
        if (a === "ap-quota" && !isNaN(n)) return setNum("quotaUnitsPerDay", n, 1000, 10000000);
        if (a === "ap-daymin" && !isNaN(n)) return setNum("postsPerDayMin", n, 1, 24);
        if (a === "ap-daymax" && !isNaN(n)) return setNum("postsPerDayMax", n, 1, 24);
        if (a === "ap-gapmin" && !isNaN(n)) return setNum("minGapMinutes", n, 15, 1440);
        if (a === "ap-window" && p.length >= 3) { // ap-window:<from minutes>:<until minutes>
            const s = parseInt(p[1], 10), e = parseInt(p[2], 10);
            if (isNaN(s) || isNaN(e)) return false;
            set("windowStart", hhmm(clamp(s, 0, 1439, 540)));
            return set("windowEnd", hhmm(clamp(e, 0, 1439, 1380)));
        }
        if (a === "ap-placement") {
            if (!placements.includes(arg)) return false;
            return set("placement", arg);
        }
        if (a === "ap-refresh") { loadTimes(true); return true }
        if (a === "ap-move" && p.length >= 3) { move(arg, p.slice(2).join(":")); return true } // the time has colons: the rest of the action
        if (a === "ap-remove" && arg) { remove(arg); return true }
        return false;
    }
}
