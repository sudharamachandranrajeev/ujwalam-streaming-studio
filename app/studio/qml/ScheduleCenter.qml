// SPDX-License-Identifier: GPL-3.0-or-later
// Scheduling manager (SM1-SM4, plan docs/plan/2026-11-25-scheduling-manager.md; user 2026-11-25: the NEXT POSTING TIMES list
// made Settings slow). Every scheduled post in one list, like the task manager: a panel under the on-air bar (More >
// Scheduled posts, or the button in Settings > Posting & growth) and "Open in own window" / "Dock" (ScheduleWindow.qml, the
// task manager's pattern, D442). The list is a virtualised ListView over the ids in order (day headers and posts), each row
// reads its data from rowById, so a refresh only changes texts that changed (the task panel's rule, 2026-11-25). The
// schedule is read only while the manager is open: one read on opening, one after each action, and one every 30 s.
// Actions reuse the posting routes, one click each, no typed confirmation (D332): Move and Remove (auto/queue/move|remove),
// Upload now / Retry (posts/queue/retry), Instagram Post now / Retry (posts/schedule/instagram-now). Bulk: move a day's
// posts (with Undo) and remove every failed one. Every row carries `channel` and `channelText` (SM5, YM6):
// with more than one YouTube channel the list shows each row's channel and filters by it (sched:channel:<id|all>).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: sc
    required property var store
    property int topY: 72
    property int windowHeight: 900
    readonly property int gap: 14
    height: 0

    // ---- state ----
    property bool open: false
    property bool windowOpen: false
    property bool windowMade: false
    readonly property bool watching: open || windowOpen
    readonly property bool available: store.flags["posting"] === true
    property var all: []               // every decorated row, as the server sent them
    property var byKey: ({})
    property var counts: ({ total: 0, waiting: 0, uploading: 0, scheduled: 0, failed: 0, channel: 0, posting: 0 })
    property string info: ""           // read problems and the channel read, in plain words
    property bool loaded: false
    property bool loading: false
    property bool again: false
    property int reads: 0
    property real applyMs: 0
    property int rowsMade: 0           // rows and day headers built by the list (probe: a read must not build them again)
    property string search: ""
    property string fTarget: "all"
    property string fState: "all"
    property string fChannel: "all"
    property var channels: []          // [{ id, label }] from the server; the filter shows with more than one
    readonly property bool multiChannel: channels.length > 1
    readonly property var channelModel: [{ value: "all", text: "All channels" }].concat(channels.map(c => ({ value: c.id, text: c.label })))
    property string sortDir: "asc"
    property string message: ""
    property var moving: ({ mode: "", key: "", day: "" })
    property string moveText: ""
    property var busy: ({})            // row key -> true while its click is on its way
    property bool bulkBusy: false
    property var undoList: []          // [{ id, at }]: the last bulk move, to put back
    property var sent: ({})            // route -> clicks that reached the server (probe)
    property var lastPost: null
    property var groups: []            // [{ day, text, count }] of what is shown
    property var shownKeys: []
    property int shownRows: 0
    property ListModel rowIds: ListModel {}
    property var rowById: ({})
    readonly property var emptyRow: ({ key: "", head: false, title: "", targetText: "", stateText: "", reasonText: "", hhmm: "", whenText: "", state: "", btn: ({ move: false, remove: false, now: false, retry: false }), postText: "", text: "", count: 0, day: "" })
    function rowOf(k) { const r = rowById[k]; return r !== undefined ? r : emptyRow }

    readonly property var targetModel: [{ value: "all", text: "All places" }, { value: "youtube-shorts", text: "YouTube Shorts" },
                                        { value: "youtube-video", text: "YouTube video" }, { value: "instagram-reels", text: "Instagram Reels" }]
    readonly property var stateModel: [{ value: "all", text: "All" }, { value: "waiting", text: "Waiting" }, { value: "uploading", text: "Uploading or posting" },
                                       { value: "scheduled", text: "Uploaded, scheduled" }, { value: "failed", text: "Failed" }, { value: "channel", text: "On your channel" }]
    readonly property var sortModel: [{ value: "asc", text: "Earliest first" }, { value: "desc", text: "Latest first" }]
    readonly property var dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    readonly property var mon: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    readonly property string summaryText: !loaded ? "Loading..." : counts.total === 0 ? "No scheduled posts."
        : counts.total + (counts.total === 1 ? " scheduled post" : " scheduled posts") + (counts.failed > 0 ? ", " + counts.failed + " failed" : "")
    readonly property bool filtered: search.trim() !== "" || fTarget !== "all" || fState !== "all" || fChannel !== "all"
    readonly property int failedRemovable: all.filter(r => r.state === "failed" && r.removable).length

    function two(n) { return (n < 10 ? "0" : "") + n }
    function dayOf(d) { return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()) }
    function clockOf(d) { return two(d.getHours()) + ":" + two(d.getMinutes()) }
    function whenOf(d) { return dow[d.getDay()] + " " + d.getDate() + " " + mon[d.getMonth()] + ", " + clockOf(d) }
    function dayText(key) {
        if (key === "none") return "No time yet";
        const p = key.split("-"), d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
        const now = new Date(), t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diff = Math.round((d.getTime() - t0.getTime()) / 86400000);
        return (diff === 0 ? "Today, " : diff === 1 ? "Tomorrow, " : "") + dow[d.getDay()] + " " + d.getDate() + " " + mon[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? " " + d.getFullYear() : "");
    }
    // One row as the list shows it: the time in this PC's zone, plain words, what it can do, and the text the search reads.
    function decorate(r, sig) {
        const t = r.at ? Date.parse(r.at) : NaN;
        const d = isNaN(t) ? null : new Date(t);
        let tt = "";
        for (const m of targetModel) if (m.value === r.target) tt = m.text;
        const o = Object.assign({}, r, { sig: sig, head: false, ms: d ? t : Infinity, day: d ? dayOf(d) : "none", hhmm: d ? clockOf(d) : "no time",
            whenText: d ? whenOf(d) : "time not set yet", targetText: tt || String(r.target), stateKey: r.state === "posting" ? "uploading" : r.state,
            btn: { move: r.movable === true, remove: r.removable === true, now: r.postable === true, retry: r.retryable === true } });
        o.hay = (o.title + " " + o.targetText + " " + o.stateText + " " + o.reasonText + " " + o.whenText + " " + (o.kind || "") + " " + (o.channelText || "")).toLowerCase();
        return o;
    }

    // ---- reading ----
    function load() {
        if (loading) { again = true; return }
        loading = true;
        reads++;
        Api.get("ui/api/posts/schedule/list", (ok, b, err) => {
            loading = false;
            if (!ok) info = "The scheduled posts are not available: " + err;
            else apply(b);
            if (again) { again = false; load() }
        });
    }
    function apply(b) {
        const t0 = Date.now();
        const prev = byKey, next = {}, list = [];
        for (const r of (Array.isArray(b.rows) ? b.rows : [])) {
            const sig = JSON.stringify(r), old = prev[r.key];
            const o = old !== undefined && old.sig === sig ? old : decorate(r, sig); // an unchanged row keeps its object
            next[r.key] = o;
            list.push(o);
        }
        byKey = next;
        all = list;
        counts = b.counts || counts;
        const chs = Array.isArray(b.channels) ? b.channels : [];
        if (JSON.stringify(chs) !== JSON.stringify(channels)) channels = chs;
        if (fChannel !== "all" && !chs.some(c => c.id === fChannel)) fChannel = "all"; // a removed channel's filter ends
        info = b.error === "schedule-read-incomplete" ? "The last channel read did not reach back far enough to see every post already scheduled on your channel."
            : b.error ? "The schedule settings are not valid, so some times may be missing."
            : b.source === "none" ? "Your channel has not been read yet, so posts already scheduled there are not listed." : "";
        loaded = true;
        refilter();
        applyMs = Date.now() - t0;
    }
    // Filter, sort, group by day; then the ListModel gets only the removes, inserts and moves that really changed.
    function refilter() {
        const q = search.trim().toLowerCase();
        const rows = all.filter(r => (fTarget === "all" || r.target === fTarget) && (fState === "all" || r.stateKey === fState) && (fChannel === "all" || r.channel === fChannel) && (q === "" || r.hay.indexOf(q) >= 0));
        const dir = sortDir === "desc" ? -1 : 1;
        const keyed = rows.map((r, i) => ({ r: r, i: i }));
        keyed.sort((a, b) => {
            const x = a.r.ms, y = b.r.ms;
            if (x === y) return a.i - b.i;
            if (x === Infinity) return 1;
            if (y === Infinity) return -1;
            return x < y ? -dir : dir;
        });
        const ids = [], grp = [], heads = {}, data = Object.assign({}, byKey);
        let cur = null;
        for (const k of keyed) {
            const r = k.r;
            if (cur === null || cur.day !== r.day) {
                cur = { day: r.day, text: dayText(r.day), count: 0, movable: 0 };
                grp.push(cur);
                ids.push("day:" + r.day);
            }
            cur.count++;
            if (r.btn.move) cur.movable++;
            ids.push(r.key);
        }
        for (const g of grp) {
            const old = rowById["day:" + g.day];
            data["day:" + g.day] = old && old.head && old.text === g.text && old.count === g.count && old.movable === g.movable ? old
                : { key: "day:" + g.day, head: true, day: g.day, text: g.text, count: g.count, movable: g.movable };
        }
        syncIds(rowIds, ids, () => { rowById = data });
        groups = grp.map(g => ({ day: g.day, text: g.text, count: g.count }));
        shownKeys = ids.filter(k => k.indexOf("day:") !== 0);
        shownRows = shownKeys.length;
    }
    // Keeps a ListModel of { rid } in the order of ids: removes, inserts and moves only (as TaskCenter.syncIds).
    function syncIds(model, ids, then) {
        const want = {};
        for (const id of ids) want[id] = true;
        for (let i = model.count - 1; i >= 0; i--) if (!want[model.get(i).rid]) model.remove(i);
        if (then) then();
        for (let i = 0; i < ids.length; i++) {
            if (i < model.count && model.get(i).rid === ids[i]) continue;
            let at = -1;
            for (let j = i + 1; j < model.count; j++) if (model.get(j).rid === ids[i]) { at = j; break }
            if (at < 0) model.insert(i, { rid: ids[i] });
            else model.move(at, i, 1);
        }
    }
    onSearchChanged: refilter()
    onFTargetChanged: refilter()
    onFStateChanged: refilter()
    onFChannelChanged: refilter()
    onSortDirChanged: refilter()
    onWatchingChanged: if (watching) load()
    Timer { interval: 30000; repeat: true; running: sc.watching; onTriggered: sc.load() }

    // ---- opening, the window ----
    function toggle() { if (windowOpen) { raiseWindow(); return } open = !open && available }
    function openPanel() { if (!available) return false; if (windowOpen) { raiseWindow(); return true } open = true; return true }
    function openWindow() { if (!available) return false; windowMade = true; open = false; windowOpen = true; return true }
    function dockWindow() { if (!windowOpen) return false; windowOpen = false; open = true; return true }
    function raiseWindow() { if (winLoader.item && !studioUnseen) { winLoader.item.raise(); winLoader.item.requestActivate() } }
    // The Settings button: Settings is modal over the main window, so a panel there could not be clicked; its own window can.
    function openFromSettings() { if (!available) return false; return openWindow() }
    onAvailableChanged: if (!available) { open = false; windowOpen = false }

    // ---- actions: one click, one request ----
    function errText(b, err) { return (b && b.text) ? b.text : (b && b.error === "stream-live") || err === "stream-live" ? "a stream is live or starting. Try again after it ends." : (b && b.error) ? b.error : err }
    function post(route, body, done) {
        const s = Object.assign({}, sent);
        s[route] = (s[route] || 0) + 1;
        sent = s;
        lastPost = { route: route, body: body };
        Api.post(route, body, done);
    }
    function setBusy(k, on) { const b = Object.assign({}, busy); if (on) b[k] = true; else delete b[k]; busy = b }
    function canAct(k) { return !bulkBusy && !busy[k] && byKey[k] !== undefined }
    function localIso(d) { return d.toISOString().replace(/\.\d+Z$/, "Z") }

    function startMove(k) {
        const r = byKey[k];
        if (!r || !r.btn.move || bulkBusy) return false;
        const d = new Date(r.ms);
        moving = { mode: "row", key: k, day: "" };
        moveText = dayOf(d) + " " + clockOf(d);
        return true;
    }
    function startDayMove(day) {
        if (bulkBusy || !all.some(r => r.day === day && r.btn.move)) return false;
        const p = day.split("-"), d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + 1);
        moving = { mode: "day", key: "", day: day };
        moveText = dayOf(d);
        return true;
    }
    function cancelMove() { moving = { mode: "", key: "", day: "" } }
    function goMove() {
        if (moving.mode === "row") {
            const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2})(?::(\d{2}))?$/.exec(moveText.trim());
            if (!m) { message = "Not moved: type the new time like 2026-11-14 18:00 (your time zone)."; return false }
            const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4], 10), m[5] ? parseInt(m[5], 10) : 0, 0);
            if (isNaN(d.getTime())) { message = "Not moved: that time does not exist."; return false }
            return moveRow(moving.key, localIso(d));
        }
        if (moving.mode === "day") return moveDay(moving.day, moveText.trim());
        return false;
    }
    function moveRow(k, iso) {
        if (!canAct(k)) return false;
        const r = byKey[k];
        if (!r.btn.move) return false;
        setBusy(k, true);
        post("ui/api/posts/auto/queue/move", { id: r.id, at: iso }, (ok, b, err) => {
            setBusy(k, false);
            message = ok ? "Moved to " + whenOf(new Date(b.publishAt || iso)) + "." : "Not moved: " + errText(b, err);
            if (ok) cancelMove();
            load();
        });
        return true;
    }
    function removeRow(k) {
        if (!canAct(k) || !byKey[k].btn.remove) return false;
        setBusy(k, true);
        post("ui/api/posts/auto/queue/remove", { id: byKey[k].id }, (ok, b, err) => {
            setBusy(k, false);
            message = ok ? "Taken out of the upload queue. The post stays in the Posts window." : "Not removed: " + errText(b, err);
            load();
        });
        return true;
    }
    // Upload now (YouTube) / Post now (Instagram) for a waiting post, and Retry for a failed one: the same two routes.
    function nowRow(k, retry) {
        if (!canAct(k)) return false;
        const r = byKey[k];
        if (retry ? !r.btn.retry : !r.btn.now) return false;
        setBusy(k, true);
        const route = r.platform === "instagram" ? "ui/api/posts/schedule/instagram-now" : "ui/api/posts/queue/retry";
        post(route, { id: r.id }, (ok, b, err) => {
            setBusy(k, false);
            message = ok ? (retry ? "Trying again: it goes up within half a minute." : r.platform === "instagram" ? "Posting to Instagram within half a minute." : "Uploading now. It still goes public at its time.")
                : (retry ? "Not retried: " : "Not started: ") + errText(b, err);
            load();
        });
        return true;
    }
    // Bulk: every movable post of a day goes to another day, same clock time, one request each, in an order that never
    // lands on a post of the same move. The old times are kept for Undo.
    function moveDay(day, dateText) {
        if (bulkBusy) return false;
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
        if (!m) { message = "Not moved: type the new day like 2026-11-14."; return false }
        const target = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        if (isNaN(target.getTime())) { message = "Not moved: that day does not exist."; return false }
        const rows = all.filter(r => r.day === day && r.btn.move).sort((a, b) => a.ms - b.ms);
        if (rows.length === 0) return false;
        const p = day.split("-"), src = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10));
        if (target.getTime() > src.getTime()) rows.reverse();
        const jobs = rows.map(r => { const d = new Date(r.ms); return { key: r.key, id: r.id, old: r.at, at: localIso(new Date(target.getFullYear(), target.getMonth(), target.getDate(), d.getHours(), d.getMinutes(), 0)) } });
        bulkBusy = true;
        cancelMove();
        const moved = [];
        let failed = 0, why = "", i = 0;
        const step = () => {
            if (i >= jobs.length) {
                bulkBusy = false;
                undoList = moved.slice().reverse();
                message = (moved.length > 0 ? "Moved " + moved.length + (moved.length === 1 ? " post" : " posts") + " to " + dayText(dayOf(target)) + "." : "Nothing was moved.")
                    + (failed > 0 ? " " + failed + " could not move: " + why : "");
                load();
                return;
            }
            const j = jobs[i++];
            post("ui/api/posts/auto/queue/move", { id: j.id, at: j.at }, (ok, b, err) => {
                if (ok) moved.push({ id: j.id, at: j.old });
                else { failed++; if (why === "") why = errText(b, err) }
                step();
            });
        };
        step();
        return true;
    }
    function undoMove() {
        if (bulkBusy || undoList.length === 0) return false;
        const jobs = undoList;
        bulkBusy = true;
        undoList = [];
        let back = 0, failed = 0, i = 0;
        const step = () => {
            if (i >= jobs.length) {
                bulkBusy = false;
                message = back > 0 ? "Put " + back + (back === 1 ? " post" : " posts") + " back." + (failed > 0 ? " " + failed + " could not be put back." : "") : "Nothing could be put back.";
                load();
                return;
            }
            const j = jobs[i++];
            post("ui/api/posts/auto/queue/move", { id: j.id, at: j.at }, (ok) => { if (ok) back++; else failed++; step() });
        };
        step();
        return true;
    }
    function removeFailed() {
        if (bulkBusy) return false;
        const rows = all.filter(r => r.state === "failed" && r.removable);
        if (rows.length === 0) return false;
        bulkBusy = true;
        let n = 0, failed = 0, i = 0;
        const step = () => {
            if (i >= rows.length) {
                bulkBusy = false;
                message = "Took " + n + (n === 1 ? " failed post" : " failed posts") + " out of the upload queue. They stay in the Posts window." + (failed > 0 ? " " + failed + " could not be removed." : "");
                load();
                return;
            }
            const r = rows[i++];
            post("ui/api/posts/auto/queue/remove", { id: r.id }, (ok) => { if (ok) n++; else failed++; step() });
        };
        step();
        return true;
    }

    // ---- probe (tests): sched:<open|close|window-open|window-dock|window-close|refresh|search:<text>|target:<id>|state:<id>|sort:<asc|desc>
    //      |move:<key>:<UTC time>|remove:<key>|now:<key>|retry:<key>|moveday:<day>:<new day>|removefailed|undo|startmove:<key>|moveto:<text>|gomove> ----
    function probeAction(a) {
        if (a === "sched:open") return openPanel();
        if (a === "sched:close") { open = false; return true }
        if (a === "sched:window-open") return openWindow();
        if (a === "sched:window-dock") return dockWindow();
        if (a === "sched:window-close") return winLoader.item ? winLoader.item.closeByUser() : false;
        if (a === "sched:refresh") { load(); return true }
        if (a.startsWith("sched:search:")) { search = decodeURIComponent(a.slice(13)); return true }
        if (a.startsWith("sched:target:")) { fTarget = a.slice(13); return true }
        if (a.startsWith("sched:state:")) { fState = a.slice(12); return true }
        if (a.startsWith("sched:channel:")) { const c = a.slice(14); if (c !== "all" && !channels.some(x => x.id === c)) return false; fChannel = c; return true }
        if (a.startsWith("sched:sort:")) { sortDir = a.slice(11); return true }
        const f = a.split(":"); // keys are "yt:<id>" / "ig:<id>"
        if (a.startsWith("sched:move:") && f.length >= 5) return moveRow(f[2] + ":" + f[3], f.slice(4).join(":"));
        if (a.startsWith("sched:remove:") && f.length === 4) return removeRow(f[2] + ":" + f[3]);
        if (a.startsWith("sched:now:") && f.length === 4) return nowRow(f[2] + ":" + f[3], false);
        if (a.startsWith("sched:retry:") && f.length === 4) return nowRow(f[2] + ":" + f[3], true);
        if (a.startsWith("sched:startmove:") && f.length === 4) return startMove(f[2] + ":" + f[3]);
        if (a.startsWith("sched:moveto:")) { moveText = decodeURIComponent(a.slice(13)); return true }
        if (a === "sched:gomove") return goMove();
        if (a.startsWith("sched:moveday:") && f.length === 4) return moveDay(f[2], f[3]);
        if (a === "sched:removefailed") return removeFailed();
        if (a === "sched:undo") return undoMove();
        return false;
    }
    function probe() {
        return {
            available: available, open: open, windowOpen: windowOpen, windowMade: windowMade, watching: watching, loaded: loaded, reads: reads, applyMs: applyMs,
            rowsMade: rowsMade, total: all.length, shownRows: shownRows, shownKeys: shownKeys, groups: groups, counts: counts, info: info, summary: summaryText,
            search: search, fTarget: fTarget, fState: fState, fChannel: fChannel, channels: channels, multiChannel: multiChannel, sortDir: sortDir, message: message, sent: sent, lastPost: lastPost, undoCount: undoList.length,
            moving: moving, moveText: moveText, bulkBusy: bulkBusy, failedRemovable: failedRemovable, modelCount: rowIds.count,
            window: winLoader.item ? { visible: winLoader.item.visible } : null,
            rows: shownKeys.slice(0, 40).map(k => { const r = byKey[k]; return { key: k, id: r.id, target: r.target, targetText: r.targetText, title: r.title, state: r.state, stateText: r.stateText,
                                                reasonText: r.reasonText, hhmm: r.hhmm, day: r.day, channel: r.channel, channelText: r.channelText || "", buttons: Object.keys(r.btn).filter(x => r.btn[x]), busy: busy[k] === true } })
        };
    }

    // ---- the window: made on its first opening, kept after ----
    Loader {
        id: winLoader
        active: sc.windowMade
        sourceComponent: ScheduleWindow { center: sc }
    }

    // ---- the panel ----
    Popup {
        id: panel
        objectName: "schedulePanel"
        popupType: studioUnseen ? Popup.Item : Popup.Window
        visible: sc.open && sc.available
        modal: false
        focus: false
        closePolicy: Popup.NoAutoClose
        width: Math.min(720, sc.width - 2 * sc.gap)
        x: sc.width - width - sc.gap
        y: sc.topY
        height: Math.max(240, Math.min(620, sc.windowHeight - sc.topY - 40))
        padding: Theme.sp.m
        onClosed: sc.open = false
        background: Rectangle {
            color: Theme.c.panel
            radius: Theme.radiusLarge
            border.width: 1
            border.color: Theme.c.border
        }
        contentItem: Loader {
            active: panel.visible
            sourceComponent: ScheduleView { center: sc; inWindow: false }
        }
    }
}
