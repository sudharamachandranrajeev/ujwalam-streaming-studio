// SPDX-License-Identifier: GPL-3.0-or-later
// Task panel and notifications (D287, reworked after the user's feedback of 2026-11-10; the widget's TaskBar,
// taskbar.cpp). The chip in the on-air bar ("2 tasks running"; quiet "Tasks" when only finished ones are listed; hidden
// when there are none; TaskChip.qml) opens a panel at the top right under the bar with every task in full: name, state,
// stage in plain words with its step, the count with a percent bar, elapsed and time left (measured, never guessed),
// when the last progress came, a "may be stuck" warning, Stop, Clear finished and an x for a finished row.
// Notifications appear at the top right when a long job starts and when a task finishes, fails or may be stuck; a click
// on one opens the panel. The lines come from the widget studio's C++ (TaskText = taskbar.h tasktime::*). Panel and
// notifications are their own windows (Popup.Window) so the native previews never cover them; hidden test mode draws
// them inside the window (studioUnseen).
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
    readonly property string chipText: (running > 0 ? (running === 1 ? "1 task running" : running + " tasks running")
                                        : waiting > 0 ? (waiting === 1 ? "1 task waiting" : waiting + " tasks waiting") : "Tasks") +
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
    function rebuild() {
        rows = all.filter(t => !pDismissed[String(t.id || "")]).map(t => ({
            id: String(t.id || ""), title: String(t.title || ""), state: String(t.state || ""), note: t.note ? String(t.note) : "",
            stalled: t.state === "running" && t.stalled === true, stop: stoppable(t),
            finished: t.state === "done" || t.state === "failed", l: TaskText.lines(t)
        }));
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
    function toggle() { setOpen(!open) }
    function setOpen(o) { open = o && rows.length > 0 }

    // Stop (2026-11-10): the background jobs end (clip making, uploads; the same route as the tray's Stop all while
    // live); the studio and host stay. The click acts at once (D332).
    function stopTasks() {
        stopsSent++;
        Api.post("ui/api/tasks/stop", {}, (ok, b, err) => store.say(ok ? "Stopping the background jobs..." : "Could not stop the tasks: " + err));
    }

    // ---- notifications: at most 3, each about 6 s (the x or a click closes it sooner) ----
    property ListModel toasts: ListModel {}
    function toast(title, note, failed) {
        if (toasts.count >= 3) toasts.remove(0);
        toasts.append({ uid: ++pToastSeq, title: title, note: note, failed: failed });
        toastsShown++;
        lastToast = title;
        const log = toastLog.slice(-9);
        log.push(title);
        toastLog = log;
    }
    function closeToast(uid) {
        for (let i = 0; i < toasts.count; i++) if (toasts.get(i).uid === uid) { toasts.remove(i); return }
    }
    function clickToast(uid) {
        toastClicks++;
        setOpen(true);
        closeToast(uid);
    }
    // A short notification without a task (as the widget's TaskBar::notice).
    function notice(title, note, failed) { toast(title, note, failed) }

    Connections {
        target: center.store
        function onTasksChanged() { center.update(center.store.tasks, center.store.statusAt) }
    }

    // ---- probe: tasks:<open|close|dismiss|clear|toast-click|stop> (the widget probe's names) ----
    function probeAction(a) {
        if (a === "tasks:open" || a === "tasks:close") { setOpen(a === "tasks:open"); return true }
        if (a === "tasks:dismiss") { dismissFirstFinished(); return true }
        if (a === "tasks:clear") { clearFinished(); return true }
        if (a === "tasks:toast-click") { if (toasts.count > 0) clickToast(toasts.get(0).uid); return true }
        if (a === "tasks:stop") { stopTasks(); return true }
        return false;
    }
    function probe() {
        const W = width;
        const toastPos = [];
        for (let i = 0; i < stackCol.children.length; i++) {
            const c = stackCol.children[i];
            if (!c.isToast) continue;
            const x = Math.round(stack.x), y = Math.round(stack.y + c.y), w = Math.round(c.width);
            toastPos.push({ x: x, y: y, width: w, right: W - (x + w) });
        }
        const o = {
            running: running, waiting: waiting, stalled: stalled, total: all.length, rows: rows.length,
            clearShown: anyFinished, chipHidden: rows.length === 0, chipQuiet: running + waiting === 0, chipText: chipText,
            chipTip: chipTip, chipInTopBar: true, panelOpen: open, toasts: toasts.count, toastsShown: toastsShown,
            toastClicks: toastClicks, lastToast: lastToast, toastLog: toastLog, startToasts: startToasts, stopsSent: stopsSent,
            windowWidth: W, topY: topY, toastPos: toastPos,
            ids: all.map(t => String(t.id || "")), titles: all.map(t => String(t.title || "")), times: all.map(t => TaskText.lines(t).text),
            detail: rows.map(r => ({ id: r.id, title: r.title, state: r.state, stage: r.l.stage, count: r.l.count, fraction: r.l.fraction,
                                     eta: r.l.eta, last: r.l.last, warn: r.l.warn, stalled: r.stalled, stop: r.stop }))
        };
        if (open) o.panel = { x: Math.round(panel.x), y: Math.round(panel.y), width: Math.round(panel.width), right: W - Math.round(panel.x + panel.width) };
        return o;
    }

    // ---- the panel ----
    Popup {
        id: panel
        objectName: "taskPanel"
        popupType: studioUnseen ? Popup.Item : Popup.Window
        visible: center.open
        modal: false
        focus: false
        closePolicy: Popup.NoAutoClose
        width: 440 // wide enough that a task's lines are read in full (they wrap, never cut)
        x: center.width - width - center.gap
        y: center.topY
        height: Math.min(implicitHeight, center.windowHeight - center.topY - 40)
        padding: Theme.sp.m
        onClosed: center.open = false
        background: Rectangle {
            color: Theme.c.panel
            radius: Theme.radiusLarge
            border.width: 1
            border.color: Theme.c.border
        }
        contentItem: Column {
            spacing: Theme.sp.s
            Item {
                width: parent.width
                height: 28
                Text {
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    text: "TASKS"
                    color: Theme.c.muted
                    font.family: Theme.ty.displayFamily
                    font.pixelSize: Theme.ty.caption
                    font.weight: Font.Bold
                    font.letterSpacing: 1
                }
                Row {
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    spacing: Theme.sp.s
                    Text {
                        objectName: "taskCount"
                        anchors.verticalCenter: parent.verticalCenter
                        text: center.listed ? center.running + " running, " + center.listed + " listed" : ""
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.caption
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
                    UButton {
                        objectName: "taskHide"
                        text: "Hide"
                        implicitHeight: 26
                        focusPolicy: Qt.NoFocus
                        onClicked: center.setOpen(false)
                    }
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
                model: center.rows
                boundsBehavior: Flickable.StopAtBounds
                delegate: Rectangle {
                    id: row
                    required property var modelData
                    required property int index
                    objectName: "taskRow:" + index
                    width: ListView.view.width
                    height: rowCol.implicitHeight + 20
                    radius: Theme.radiusMedium
                    color: Theme.c.field
                    border.width: 1
                    border.color: row.modelData.stalled ? Theme.c.danger : Theme.c.border
                    readonly property string stateText: modelData.state === "done" ? "Done" : modelData.state === "failed" ? "Failed"
                                                      : modelData.state === "waiting" ? "Waiting" : modelData.stalled ? "May be stuck" : "Running"
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
                        Repeater {
                            model: [row.modelData.l.stage, row.modelData.l.count]
                            Text {
                                required property var modelData
                                visible: modelData !== ""
                                width: rowCol.width
                                text: modelData
                                wrapMode: Text.Wrap
                                color: Theme.c.text
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.small
                            }
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
                        Repeater {
                            model: [row.modelData.l.eta, row.modelData.l.last, row.modelData.note]
                            Text {
                                required property var modelData
                                visible: modelData !== ""
                                width: rowCol.width
                                text: modelData
                                wrapMode: Text.Wrap
                                color: Theme.c.muted
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.caption
                            }
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
                        Item {
                            visible: row.modelData.stop
                            width: rowCol.width
                            height: visible ? 30 : 0
                            UButton {
                                objectName: "taskStop"
                                anchors.right: parent.right
                                text: "Stop"
                                kind: "danger"
                                implicitHeight: 28
                                focusPolicy: Qt.NoFocus
                                tip: "Stop the background jobs (clip making and uploads). Unfinished clip jobs run again at the next start."
                                onClicked: center.stopTasks()
                            }
                        }
                    }
                }
            }
        }
    }

    // ---- the notifications: stacked top-down at the top right under the bar; with the panel open, to its left ----
    Popup {
        id: stack
        objectName: "taskToasts"
        popupType: studioUnseen ? Popup.Item : Popup.Window
        visible: center.toasts.count > 0
        modal: false
        focus: false
        closePolicy: Popup.NoAutoClose
        padding: 0
        width: 360
        x: center.open ? Math.max(center.gap, panel.x - width - 10) : center.width - width - center.gap
        y: center.topY
        background: Item {}
        contentItem: Column {
            id: stackCol
            spacing: Theme.sp.s
            Repeater {
                model: center.toasts
                delegate: Rectangle {
                    id: t
                    required property int uid
                    required property string title
                    required property string note
                    required property bool failed
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
