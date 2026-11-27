// SPDX-License-Identifier: GPL-3.0-or-later
// Task panel and notifications (D287, reworked after the user's feedback of 2026-11-10; the widget's TaskBar,
// taskbar.cpp). The chip in the on-air bar ("2 tasks running"; quiet "Tasks" when only finished ones are listed; hidden
// when there are none; TaskChip.qml) opens a panel at the top right under the bar with every task in full: name, state,
// stage in plain words with its step, the count with a percent bar, elapsed and time left (measured, never guessed),
// when the last progress came, a "may be stuck" warning, Stop, Clear finished and an x for a finished row.
// Notifications appear at the top right when a long job starts and when a task finishes, fails or may be stuck; a click
// on one opens the panel. The lines come from the widget studio's C++ (TaskText = taskbar.h tasktime::*). Panel and
// notifications are their own windows so the native previews never cover them: frameless tool windows (FloatSurface.qml),
// not Popup.Window, since 2026-11-27 (a notification popup took every click meant for the panel's Start); hidden test
// mode draws them inside the window (studioUnseen).
// D442 (task manager window): "Open in own window" moves the list into its own top-level window (TaskWindow.qml: sort,
// filter, per-task Stop / Pause / Resume / Next start, a detail view); closing it or "Dock" returns to this panel. A
// notice "N tasks are waiting for you" at the start opens that window.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: center
    required property var store
    property int topY: 72          // just under the on-air bar (Main sets it)
    property int windowHeight: 900 // the panel grows up to the window's height, then its rows scroll (Main sets it)
    readonly property int gap: 14  // from the window's right edge
    height: 0

    // ---- model (the widget's TaskBar::update) ----
    property var all: []           // the status snapshot's tasks
    property var rows: []          // listed (not dismissed): {id, title, state, stalled, stop, finished, l: TaskText lines}
    property int running: 0
    property int waiting: 0
    property int stalled: 0
    property bool open: false
    property bool windowOpen: false  // the task manager window (TaskWindow.qml) is open; the panel is folded away meanwhile
    property bool windowMade: false
    property int waitNotices: 0
    property int pWaitSeen: 0
    property int toastsShown: 0
    property int toastClicks: 0
    property int startToasts: 0
    property int stopsSent: 0
    property string lastToast: ""
    property var toastLog: []
    property string chipTip: ""
    property var pLast: ({})       // id -> state seen last
    property var pDismissed: ({})
    property var pWarned: ({})
    property bool pFirst: true
    property int pToastSeq: 0

    readonly property int listed: rows.length
    readonly property bool anyFinished: rows.some(r => r.finished)
    // The words come from Store.taskWords, the same text the status bar shows (2026-11-27: they disagreed).
    readonly property string chipText: (store.taskWords !== "" ? store.taskWords : "Tasks") +
                                       (stalled > 0 ? " - " + stalled + " may be stuck" : "")

    function isLongJob(t) {
        const id = String(t.id || ""), k = String(t.kind || "");
        return !id.startsWith("ui-") || k === "upload" || k === "import";
    }
    function stoppable(t) { return (t.state === "running" || t.state === "waiting") && !String(t.id || "").startsWith("ui-") }

    function update(tasks, serverNow) {
        all = tasks;
        let r = 0, w = 0, st = 0;
        const lines = [], present = {}, last = pLast, warned = pWarned;
        for (const t of tasks) {
            const id = String(t.id || ""), s = String(t.state || ""), title = String(t.title || "");
            present[id] = true;
            const was = last[id] || "";
            const wasActive = was === "running" || was === "waiting";
            const finished = s === "done" || s === "failed";
            // A notification when a task we saw working finishes, or one that finished just before this poll (a quick action).
            const age = serverNow - (typeof t.updatedAt === "number" ? t.updatedAt : 0);
            if (finished && !pDismissed[id] && (wasActive || (was === "" && !pFirst && age >= 0 && age < 6000)))
                toast(s === "failed" ? "Failed: " + title : "Done: " + title, t.note ? String(t.note) : "", s === "failed");
            // A notification when a long job starts (one not seen before, after the first poll: no burst at window open).
            if (!finished && was === "" && !pFirst && isLongJob(t)) {
                startToasts++;
                toast("Started: " + title, "Click to see its progress.", false);
            }
            last[id] = s;
            const isStalled = s === "running" && t.stalled === true;
            // Once per stall (again only after progress came back): a notification that it may be stuck.
            if (isStalled && !warned[id]) {
                warned[id] = true;
                toast("May be stuck: " + title, TaskText.lines(t).warn + ". Click to see it or stop it.", true);
            } else if (!isStalled) delete warned[id];
            if (s === "running") { r++; st += isStalled ? 1 : 0; lines.push(title + " - " + TaskText.lines(t).text) }
            else if (s === "waiting") { w++; lines.push(title + " - waiting") }
        }
        for (const k of Object.keys(last)) if (!present[k]) delete last[k];
        for (const k of Object.keys(warned)) if (!present[k]) delete warned[k];
        const dis = {};
        for (const k of Object.keys(pDismissed)) if (present[k]) dis[k] = true;
        pDismissed = dis;
        pLast = last;
        pWarned = warned;
        pFirst = false;
        running = r; waiting = w; stalled = st;
        chipTip = lines.join("\n");
        rebuild();
    }
    // GUI load (2026-11-25): the lists keep their rows. A new rows array as a list model made the panel and the task
    // window destroy and build every row (buttons, texts) again on each status poll, and the tasks change on every poll
    // while one runs: 20 ms of each 22 ms status answer in the realistic probe, 300-600 ms on the laptop while it
    // recorded. The lists now show rowIds (ids in list order: moved, inserted and removed one by one, as the mixer
    // strips, B4) and each row reads its data from rowById, so a poll only changes texts that changed.
    property ListModel rowIds: ListModel {}
    property var rowById: ({})
    property int rowsMade: 0 // rows built by the panel and the task window (probe: a poll must not build them again)
    readonly property var emptyRow: ({ id: "", title: "", state: "", note: "", stalled: false, stop: false, finished: false,
        l: { text: "", stage: "", count: "", eta: "", last: "", warn: "", fraction: -1 }, category: "", controls: [], pausable: false,
        pauseReason: "", paused: false, pausing: false, again: false, nextStart: "", question: "", parts: [], logTail: [], startedAt: 0, stageText: "" })
    function rowOf(id) { const r = rowById[id]; return r !== undefined ? r : emptyRow }
    // Keeps a ListModel of { rid } in the order of ids: removes, inserts and moves only (shared with TaskWindow.qml).
    function syncIds(model, ids, then) {
        const want = {};
        for (const id of ids) want[id] = true;
        for (let i = model.count - 1; i >= 0; i--) if (!want[model.get(i).rid]) model.remove(i);
        if (then) then(); // the new data, before a new row's delegate reads it
        for (let i = 0; i < ids.length; i++) {
            let at = -1;
            for (let j = i; j < model.count; j++) if (model.get(j).rid === ids[i]) { at = j; break }
            if (at < 0) model.insert(i, { rid: ids[i] });
            else if (at !== i) model.move(at, i, 1);
        }
    }
    function rebuild() {
        const next = all.filter(t => !pDismissed[String(t.id || "")]).map(t => ({
            id: String(t.id || ""), title: String(t.title || ""), state: String(t.state || ""), note: t.note ? String(t.note) : "",
            stalled: t.state === "running" && t.stalled === true, stop: stoppable(t),
            finished: t.state === "done" || t.state === "failed", l: TaskText.lines(t),
            // D442 (the task manager window): what the job side reports for controls and details
            category: String(t.category || "maintenance"), controls: Array.isArray(t.controls) ? t.controls.map(String) : [],
            pausable: t.pausable === true, pauseReason: t.pauseReason ? String(t.pauseReason) : "", paused: t.paused === true,
            pausing: t.pausing === true, again: t.again === true && t.state === "failed", heldOnAir: t.heldOnAir === true, nextStart: typeof t.nextStart === "string" ? t.nextStart : "", question: t.question ? String(t.question) : "",
            parts: Array.isArray(t.parts) ? t.parts.map(String) : [], logTail: Array.isArray(t.logTail) ? t.logTail.map(String) : [],
            startedAt: typeof t.startedAt === "number" ? t.startedAt : 0, stageText: t.stageText ? String(t.stageText) : ""
        }));
        const by = {};
        for (const r of next) by[r.id] = r;
        syncIds(rowIds, next.map(r => r.id), () => { rowById = by });
        rows = next;
        if (open && rows.length === 0) open = false; // nothing left to show: the panel folds away with its button
    }
    function dismiss(id) {
        const d = Object.assign({}, pDismissed);
        d[id] = true;
        pDismissed = d;
        rebuild();
    }
    function dismissFirstFinished() {
        const r = rows.find(x => x.finished);
        if (r) dismiss(r.id);
    }
    // "Clear finished": every done or failed row goes; running and waiting ones stay (user, 2026-11-10).
    function clearFinished() {
        const d = Object.assign({}, pDismissed);
        let any = false;
        for (const r of rows) if (r.finished) { d[r.id] = true; any = true }
        if (!any) return;
        pDismissed = d;
        rebuild();
    }
    function toggle() { if (windowOpen) { raiseWindow(); return } setOpen(!open) }
    function setOpen(o) { open = o && rows.length > 0 && !windowOpen }

    // ---- the task manager window (D442): its own top-level window; Dock or closing it returns to the panel ----
    function openWindow() {
        windowMade = true;
        open = false;
        windowOpen = true;
        return true;
    }
    function dockWindow() {
        if (!windowOpen) return false;
        windowOpen = false;
        open = rows.length > 0;
        return true;
    }
    function raiseWindow() { if (winLoader.item && !studioUnseen) { winLoader.item.raise(); winLoader.item.requestActivate() } }
    // The start notice: "N tasks are waiting for you" once the first status shows jobs that wait for a choice (and again
    // only if more wait later). A click opens the task manager window.
    function checkWaiting() {
        const n = store.waitingForYou;
        if (n > pWaitSeen) {
            waitNotices++;
            toast(n === 1 ? "1 task is waiting for you" : n + " tasks are waiting for you", "Click to see them and choose what to do.", false, "window");
        }
        pWaitSeen = n;
    }

    // Stop (2026-11-10): the background jobs end (clip making, uploads; the same route as the tray's Stop all while
    // live); the studio and host stay. The click acts at once (D332).
    // A row's own buttons (2026-11-26, user: a paused job offered only Stop and could not be started). A job that waits
    // for the user (paused by them, or carried over from last time) shows Start / Resume; its Stop acts on that job only
    // (ui/api/tasks/control), never on every background job. Jobs without per-task controls keep the global Stop.
    property int controlsSent: 0
    function held(r) { return r.paused || (r.state === "waiting" && r.controls.indexOf("resume") >= 0) }
    function stateWord(r) {
        if (r.state === "done") return "Done";
        if (r.state === "failed") return "Failed";
        if (r.paused) return "Paused";
        if (r.heldOnAir) return "Paused while on air"; // 2026-11-26: carries on by itself after; only Stop is offered
        if (held(r)) return "Waiting for you";
        if (r.pausing) return "Pausing";
        if (r.state === "waiting") return "Waiting";
        return r.stalled ? "May be stuck" : "Running";
    }
    function control(id, op) {
        controlsSent++;
        Api.post("ui/api/tasks/control", { id: id, op: op }, (ok, b, err) => {
            if (!ok) store.say((b && b.reason) ? String(b.reason) : "Could not do that: " + err);
        });
        return true;
    }
    // 2026-11-27: a stopped or failed clip task keeps "Make clips again": the same job goes into the clip queue (ui/api/clips/again)
    function makeAgain(id) {
        controlsSent++;
        Api.post("ui/api/clips/again", { id: id }, (ok, b, err) => store.say(ok ? "Making clips again. It starts when nothing is recording or live."
            : (b && b.reason) ? String(b.reason) : "Could not queue it: " + err));
        return true;
    }
    function stopRow(r) { if (r.controls.indexOf("stop") >= 0) control(r.id, "stop"); else stopTasks() }
    function stopTasks() {
        stopsSent++;
        Api.post("ui/api/tasks/stop", {}, (ok, b, err) => store.say(ok ? "Stopping the background jobs..." : "Could not stop the tasks: " + err));
    }

    // ---- notifications: at most 3, each about 6 s (the x or a click closes it sooner) ----
    property bool hold: false // true while a modal dialog is open: the notifications wait behind it
    property ListModel toasts: ListModel {}
    function toast(title, note, failed, act) {
        if (toasts.count >= 3) toasts.remove(0);
        toasts.append({ uid: ++pToastSeq, title: title, note: note, failed: failed, act: act || "" });
        toastsShown++;
        lastToast = title;
        const log = toastLog.slice(-9);
        log.push(title);
        toastLog = log;
        if (act === "window" && pNoticeClick) { pNoticeClick = false; clickToast(pToastSeq) }
    }
    // Probe: tasks:notice-click clicks the "N tasks are waiting for you" notice itself (found by its action, not its
    // place in the stack), now if it is shown, else the moment it appears. tasks:toast-click clicked whatever toast was
    // first: under CI load the notice had closed (6 s) or been pushed out by preview "Done" toasts before the click, and
    // the click opened the panel instead (2026-11-24).
    property bool pNoticeClick: false
    function noticeClick() {
        for (let i = toasts.count - 1; i >= 0; i--) if (toasts.get(i).act === "window") { clickToast(toasts.get(i).uid); return true }
        pNoticeClick = true;
        return true;
    }
    function closeToast(uid) {
        for (let i = 0; i < toasts.count; i++) if (toasts.get(i).uid === uid) { toasts.remove(i); return }
    }
    function clickToast(uid) {
        toastClicks++;
        let act = "";
        for (let i = 0; i < toasts.count; i++) if (toasts.get(i).uid === uid) act = toasts.get(i).act;
        if (act === "window") openWindow(); else if (windowOpen) raiseWindow(); else setOpen(true);
        closeToast(uid);
    }
    // A short notification without a task (as the widget's TaskBar::notice).
    function notice(title, note, failed) { toast(title, note, failed) }

    Connections {
        target: center.store
        function onTasksChanged() { center.update(center.store.tasks, center.store.statusAt) }
        function onWaitingForYouChanged() { center.checkWaiting() }
    }
    Component.onCompleted: checkWaiting()

    // ---- probe: tasks:<open|close|dismiss|clear|toast-click|stop> (the widget probe's names) ----
    function probeAction(a) {
        if (a === "tasks:open" || a === "tasks:close") { setOpen(a === "tasks:open"); return true }
        if (a === "tasks:dismiss") { dismissFirstFinished(); return true }
        if (a === "tasks:clear") { clearFinished(); return true }
        if (a === "tasks:toast-click") { if (toasts.count > 0) clickToast(toasts.get(0).uid); return true }
        if (a === "tasks:notice-click") return noticeClick();
        if (a === "tasks:stop") { stopTasks(); return true }
        if (a === "tasks:window-open") return openWindow();
        if (a === "tasks:window-dock") return dockWindow();
        if (a === "tasks:window-close") return winLoader.item ? winLoader.item.closeByUser() : false; // the window's own close (X)
        return winLoader.item ? winLoader.item.probeAction(a) : false;
    }
    function probe() {
        const W = width;
        const toastPos = [];
        for (let i = 0; i < stackCol.children.length; i++) {
            const c = stackCol.children[i];
            if (!c.isToast) continue;
            const x = Math.round(stack.px), y = Math.round(stack.py + c.y), w = Math.round(c.width);
            toastPos.push({ x: x, y: y, width: w, right: W - (x + w) });
        }
        const o = {
            running: running, waiting: waiting, stalled: stalled, total: all.length, rows: rows.length, rowsMade: rowsMade,
            clearShown: anyFinished, chipHidden: rows.length === 0, chipQuiet: running + waiting === 0, chipText: chipText,
            chipTip: chipTip, chipInTopBar: true, panelOpen: open, toasts: toasts.count, toastsShown: toastsShown,
            toastClicks: toastClicks, lastToast: lastToast, toastLog: toastLog, startToasts: startToasts, stopsSent: stopsSent,
            windowWidth: W, topY: topY, toastPos: toastPos, windowOpen: windowOpen, windowMade: windowMade, waitNotices: waitNotices, waitingForYou: store.waitingForYou,
            manager: winLoader.item ? winLoader.item.probe() : null,
            ids: all.map(t => String(t.id || "")), titles: all.map(t => String(t.title || "")), times: all.map(t => TaskText.lines(t).text),
            detail: rows.map(r => ({ id: r.id, title: r.title, state: r.state, stage: r.l.stage, count: r.l.count, fraction: r.l.fraction,
                                     eta: r.l.eta, last: r.l.last, warn: r.l.warn, stalled: r.stalled, stop: r.stop }))
        };
        if (open) o.panel = { x: Math.round(panel.px), y: Math.round(panel.py), width: Math.round(panel.pw), right: W - Math.round(panel.px + panel.pw),
                              inWindow: panel.inWindow, opened: panel.opened };
        return o;
    }

    // ---- the task manager window: made on its first opening (start-up time), kept after ----
    Loader {
        id: winLoader
        active: center.windowMade
        sourceComponent: TaskWindow { taskCenter: center }
    }

    // ---- the panel ----
    // A tool window, not a Popup.Window (FloatSurface.qml: a notification popup opened after it took every click on Start).
    FloatSurface {
        id: panel
        objectName: "taskPanel"
        anchors.fill: parent
        shown: center.open
        readonly property int width_: 440 // wide enough that a task's lines are read in full (they wrap, never cut)
        pw: width_
        px: center.width - width_ - center.gap
        py: center.topY
        ph: Math.min(panelCol.implicitHeight + 2 * Theme.sp.m, center.windowHeight - center.topY - 40)
        Rectangle {
            anchors.fill: parent
            color: Theme.c.panel
            radius: Theme.radiusLarge
            border.width: 1
            border.color: Theme.c.border
        }
        Column {
            id: panelCol
            anchors { fill: parent; margins: Theme.sp.m }
            spacing: Theme.sp.s
            // Header (2026-11-26): title and count on one line, the buttons on their own line below. One right-anchored
            // Row with the count and three buttons was wider than the 440 px panel: it ran out past the panel's left
            // edge, over "TASKS" and outside the popup window, where "Clear finished" could not be clicked at all.
            Item {
                width: parent.width
                height: 22
                Text {
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    text: "TASKS"
                    color: Theme.c.muted
                    font.family: Theme.ty.displayFamily
                    font.pixelSize: Theme.ty.caption
                    font.weight: Font.Bold
                    font.letterSpacing: 1
                }
                Text {
                    objectName: "taskCount"
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    width: parent.width - 80
                    horizontalAlignment: Text.AlignRight
                    elide: Text.ElideLeft
                    text: center.listed ? center.running + " running, " + center.listed + " listed" : ""
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.caption
                }
            }
            Flow {
                width: parent.width
                layoutDirection: Qt.RightToLeft
                spacing: Theme.sp.s
                UButton {
                    objectName: "taskHide"
                    text: "Hide"
                    implicitHeight: 26
                    focusPolicy: Qt.NoFocus
                    onClicked: center.setOpen(false)
                }
                UButton {
                    objectName: "taskOwnWindow"
                    visible: center.listed > 0
                    text: "Open in own window"
                    implicitHeight: 26
                    tip: "Open the task list in its own window, with sorting, filters and a button for each task"
                    focusPolicy: Qt.NoFocus
                    onClicked: center.openWindow()
                }
                UButton {
                    objectName: "taskClear"
                    visible: center.anyFinished
                    text: "Clear finished"
                    implicitHeight: 26
                    tip: "Remove all finished and failed tasks from this list"
                    focusPolicy: Qt.NoFocus
                    onClicked: center.clearFinished()
                }
            }
            Text {
                visible: center.listed === 0
                text: "Nothing is running."
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
            }
            ListView {
                id: rowList
                objectName: "taskRows"
                width: parent.width
                height: Math.min(contentHeight, 520)
                clip: true
                spacing: Theme.sp.s
                model: center.rowIds
                boundsBehavior: Flickable.StopAtBounds
                delegate: Rectangle {
                    id: row
                    required property string rid
                    required property int index
                    readonly property var modelData: center.rowOf(rid)
                    Component.onCompleted: center.rowsMade++
                    objectName: "taskRow:" + index
                    width: ListView.view.width
                    height: rowCol.implicitHeight + 20
                    radius: Theme.radiusMedium
                    color: Theme.c.field
                    border.width: 1
                    border.color: row.modelData.stalled ? Theme.c.danger : Theme.c.border
                    readonly property string stateText: center.stateWord(modelData)
                    readonly property bool held: center.held(modelData)
                    Column {
                        id: rowCol
                        anchors { left: parent.left; right: parent.right; top: parent.top; margins: Theme.sp.m; leftMargin: Theme.sp.m }
                        spacing: Theme.sp.xs
                        Item {
                            width: parent.width
                            height: Math.max(titleText.implicitHeight, 22)
                            Text {
                                id: titleText
                                anchors { left: parent.left; right: rowState.left; rightMargin: Theme.sp.s }
                                text: row.modelData.title
                                wrapMode: Text.Wrap
                                color: Theme.c.text
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.body
                                font.weight: Font.DemiBold
                            }
                            Row {
                                id: rowState
                                anchors.right: parent.right
                                spacing: Theme.sp.s
                                Text {
                                    objectName: "taskState"
                                    text: row.stateText
                                    color: row.modelData.state === "failed" || row.modelData.stalled ? Theme.c.danger
                                         : row.modelData.state === "done" ? Theme.c.ok : Theme.c.muted
                                    font.family: Theme.family
                                    font.pixelSize: Theme.ty.caption
                                }
                                UButton {
                                    objectName: "taskClose"
                                    visible: row.modelData.finished
                                    text: "x"
                                    implicitHeight: 22
                                    leftPadding: Theme.sp.s
                                    rightPadding: Theme.sp.s
                                    tip: "Remove from the list"
                                    focusPolicy: Qt.NoFocus
                                    onClicked: center.dismiss(row.modelData.id)
                                }
                            }
                        }
                        // fixed texts, not a Repeater over a new array (that built them again on every poll)
                        Text {
                            visible: text !== ""
                            width: rowCol.width
                            text: row.modelData.l.stage
                            wrapMode: Text.Wrap
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small
                        }
                        Text {
                            visible: text !== ""
                            width: rowCol.width
                            text: row.modelData.l.count
                            wrapMode: Text.Wrap
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small
                        }
                        Rectangle { // progress: the fraction, a sweep when the amount of work is unknown
                            visible: row.modelData.state !== "done"
                            width: rowCol.width
                            height: 6
                            radius: 3
                            color: Theme.c.border
                            clip: true
                            readonly property real f: row.modelData.state === "waiting" ? 0 : row.modelData.l.fraction
                            readonly property color ink: row.modelData.state === "failed" ? Theme.c.danger
                                                       : row.modelData.state === "waiting" ? Theme.c.muted : Theme.c.accent
                            Rectangle {
                                id: fill
                                height: parent.height
                                radius: 3
                                color: parent.ink
                                visible: parent.f >= 0 && parent.f > 0
                                width: Math.max(parent.height, parent.width * Math.max(0, parent.f))
                                Behavior on width { enabled: Theme.motion; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
                            }
                            Rectangle {
                                id: sweep
                                height: parent.height
                                radius: 3
                                color: parent.ink
                                width: parent.width * 0.32
                                visible: parent.f < 0 && row.modelData.state === "running"
                                SequentialAnimation on x {
                                    running: sweep.visible && Theme.motion
                                    loops: Animation.Infinite
                                    NumberAnimation { from: 0; to: rowCol.width * 0.68; duration: 1400; easing.type: Easing.InOutSine }
                                }
                            }
                        }
                        Text {
                            visible: text !== ""
                            width: rowCol.width
                            text: row.modelData.l.eta
                            wrapMode: Text.Wrap
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.caption
                        }
                        Text {
                            visible: text !== ""
                            width: rowCol.width
                            text: row.modelData.l.last
                            wrapMode: Text.Wrap
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.caption
                        }
                        Text {
                            visible: text !== ""
                            width: rowCol.width
                            text: row.modelData.note
                            wrapMode: Text.Wrap
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.caption
                        }
                        Text {
                            objectName: "taskWarn"
                            visible: row.modelData.l.warn !== ""
                            width: rowCol.width
                            text: row.modelData.l.warn
                            wrapMode: Text.Wrap
                            color: Theme.c.danger
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.small
                            font.weight: Font.DemiBold
                        }
                        Flow {
                            visible: row.modelData.stop || row.held || row.modelData.again
                            width: rowCol.width
                            layoutDirection: Qt.RightToLeft
                            spacing: Theme.sp.s
                            UButton {
                                objectName: "taskAgain"
                                visible: row.modelData.again
                                text: "Make clips again"
                                kind: "primary"
                                implicitHeight: 28
                                focusPolicy: Qt.NoFocus
                                tip: "Queue this job again. It reuses what was already found and the clips already made."
                                onClicked: center.makeAgain(row.modelData.id)
                            }
                            UButton {
                                objectName: "taskStart"
                                visible: row.held
                                text: row.modelData.paused ? "Resume" : "Start"
                                kind: "primary"
                                implicitHeight: 28
                                focusPolicy: Qt.NoFocus
                                tip: row.modelData.paused ? "Carry on from where it paused" : "Start this task now"
                                onClicked: center.control(row.modelData.id, "resume")
                            }
                            UButton {
                                objectName: "taskStop"
                                // A held job is not running: Stop there would only throw its unfinished work away. That
                                // is in the task window ("Open in own window"), next to the other choices.
                                visible: row.modelData.stop && !row.held
                                text: "Stop"
                                kind: "danger"
                                implicitHeight: 28
                                focusPolicy: Qt.NoFocus
                                tip: row.modelData.controls.indexOf("stop") >= 0 ? "Stop this task. Unfinished work is kept and starts again at the next start."
                                     : "Stop the background jobs (clip making and uploads). Unfinished clip jobs run again at the next start."
                                onClicked: center.stopRow(row.modelData)
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- the notifications: stacked top-down at the top right under the bar; with the panel open, to its left ----
    // A tool window, not a Popup.Window (FloatSurface.qml): it appears by itself, and as the newest popup it took every
    // click meant for the task panel and the other popup windows (2026-11-27).
    FloatSurface {
        id: stack
        objectName: "taskToasts"
        anchors.fill: parent
        shown: center.toasts.count > 0 && !center.hold // a modal chooser (Go live) is not drawn over by a notification (D389 C2)
        pw: 360
        px: center.open ? Math.max(center.gap, panel.px - pw - 10) : center.width - pw - center.gap
        py: center.topY
        ph: Math.max(1, stackCol.implicitHeight)
        Column {
            id: stackCol
            width: parent.width
            spacing: Theme.sp.s
            Repeater {
                model: center.toasts
                delegate: Rectangle {
                    id: t
                    required property int uid
                    required property string title
                    required property string note
                    required property bool failed
                    required property string act
                    required property int index
                    readonly property bool isToast: true
                    objectName: "toast:" + index
                    width: 360
                    height: tCol.implicitHeight + 24
                    radius: Theme.radiusMedium
                    color: Theme.c.panel
                    border.width: 1
                    border.color: Theme.c.border
                    Rectangle { // the coloured edge: accent, danger for a failure
                        width: 4
                        radius: 2
                        anchors { left: parent.left; top: parent.top; bottom: parent.bottom; margins: Theme.sp.s }
                        color: t.failed ? Theme.c.danger : Theme.c.accent
                    }
                    Column {
                        id: tCol
                        anchors { left: parent.left; right: closeX.left; top: parent.top; leftMargin: Theme.sp.l; topMargin: Theme.sp.m; rightMargin: Theme.sp.s }
                        spacing: 3
                        Text {
                            objectName: "toastTitle"
                            width: parent.width
                            text: t.title
                            wrapMode: Text.Wrap
                            color: Theme.c.text
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.body
                            font.weight: Font.DemiBold
                        }
                        Text {
                            visible: t.note !== ""
                            width: parent.width
                            text: t.note
                            wrapMode: Text.Wrap
                            color: Theme.c.muted
                            font.family: Theme.family
                            font.pixelSize: Theme.ty.caption
                        }
                    }
                    TapHandler { onTapped: center.clickToast(t.uid) }
                    HoverHandler { id: th }
                    ToolTip.visible: th.hovered
                    ToolTip.text: "Show the task list"
                    ToolTip.delay: 500
                    UButton {
                        id: closeX
                        anchors { right: parent.right; top: parent.top; margins: Theme.sp.s }
                        text: "x"
                        implicitHeight: 22
                        leftPadding: Theme.sp.s
                        rightPadding: Theme.sp.s
                        tip: "Close"
                        focusPolicy: Qt.NoFocus
                        onClicked: center.closeToast(t.uid)
                    }
                    Timer { interval: 6000; running: true; onTriggered: center.closeToast(t.uid) }
                    opacity: 0
                    Component.onCompleted: opacity = 1
                    Behavior on opacity { enabled: Theme.motion; NumberAnimation { duration: 240; easing.type: Easing.OutCubic } }
                }
            }
        }
    }
}
