// SPDX-License-Identifier: GPL-3.0-or-later
// The task manager window (D442, approved 2026-11-24): the task list in its own top-level window. Sort (state, start
// time, category) and filter (state, category) with words on every control; each task shows only the buttons its job
// offers (`controls` in the status snapshot): Stop, Pause, Resume and a "Next start" choice (Run / Ask me / Just notify).
// A click acts at once (no "are you sure", D332); the result shows in the list on the next status poll, and until it
// does that task's buttons wait (so a second click never lands on the old state). A job that cannot be paused says why in
// plain words; one that was asked to pause says "Pausing at the next safe point…". Clicking a task opens its details:
// stage, progress, current step, time spent and left, the parts running and the log tail (plain text, never rendered as
// rich text). "Dock", or closing the window, returns to the panel (TaskCenter.qml). A size column is left out: the status
// snapshot carries no size per task. Never shown in the hidden test mode (studioUnseen): the probe reads the same state.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Window {
    id: win
    objectName: "taskWindow"
    required property var taskCenter
    visible: taskCenter.windowOpen && !studioUnseen
    width: 1020
    height: 680
    minimumWidth: 780
    minimumHeight: 480
    title: "Ujwalam - Tasks"
    color: Theme.c.bg
    onClosing: (close) => { close.accepted = true; taskCenter.dockWindow() } // the window's own X: back to the panel

    // ---- sort and filter ----
    property string sortKey: "state"
    property string filterState: "all"
    property string filterCat: "all"
    property string selected: ""
    property string message: ""
    property int postsSent: 0
    property var lastPost: null
    property var pending: ({}) // task id -> { sig, at }: a click is on its way; the row waits for its list entry to change
    readonly property var sortModel: [{ value: "state", text: "State" }, { value: "start", text: "Start time (newest first)" }, { value: "category", text: "Category" }]
    readonly property var stateModel: [{ value: "all", text: "All" }, { value: "running", text: "Running" }, { value: "waiting", text: "Waiting" },
                                       { value: "failed", text: "Failed" }, { value: "done", text: "Done" }]
    readonly property var catModel: [{ value: "all", text: "All" }, { value: "clips", text: "Clips" }, { value: "reels", text: "Reels" },
                                     { value: "long-video", text: "Long video" }, { value: "posting", text: "Posting" }, { value: "learning", text: "Learning" },
                                     { value: "downloads", text: "Downloads" }, { value: "maintenance", text: "Maintenance" }]
    readonly property var stateRank: ({ running: 0, waiting: 1, failed: 2, done: 3 })

    function catText(c) { for (const m of catModel) if (m.value === c) return m.text; return String(c) }
    function stateText(r) {
        if (r.state === "done") return "Done";
        if (r.state === "failed") return "Failed";
        if (r.state === "waiting") return r.paused ? "Paused" : "Waiting";
        if (r.paused) return "Paused";
        return r.stalled ? "May be stuck" : "Running";
    }
    // The rows to show: filtered, then sorted (stable: ties keep the list's own order).
    readonly property var shown: {
        const rs = taskCenter.rows.filter(r => (filterState === "all" || r.state === filterState) && (filterCat === "all" || r.category === filterCat));
        const keyed = rs.map((r, i) => ({ r: r, i: i }));
        keyed.sort((a, b) => {
            let d = 0;
            if (sortKey === "state") d = (stateRank[a.r.state] ?? 9) - (stateRank[b.r.state] ?? 9);
            else if (sortKey === "category") d = a.r.category < b.r.category ? -1 : a.r.category > b.r.category ? 1 : 0;
            if (d === 0) d = b.r.startedAt - a.r.startedAt; // newer first
            return d !== 0 ? d : a.i - b.i;
        });
        return keyed.map(k => k.r);
    }
    readonly property var current: { for (const r of taskCenter.rows) if (r.id === selected) return r; return null }
    // GUI load (2026-11-25): the list and the details keep their items between polls (TaskCenter.syncIds). A new array as
    // a model built every row and its buttons again on each status poll while a task ran.
    property ListModel shownIds: ListModel {}
    onShownChanged: taskCenter.syncIds(shownIds, shown.map(r => r.id))
    Component.onCompleted: taskCenter.syncIds(shownIds, shown.map(r => r.id))
    property ListModel detailModel: ListModel {} // { k, v } of the clicked task
    property ListModel partsModel: ListModel {}  // { p } the parts it runs
    function syncList(model, list) { // same length: values set in place; the items stay
        for (let i = 0; i < list.length; i++) { if (i < model.count) model.set(i, list[i]); else model.append(list[i]) }
        while (model.count > list.length) model.remove(model.count - 1);
    }
    onCurrentChanged: { syncList(detailModel, detailFields(current)); syncList(partsModel, current ? current.parts.map(p => ({ p: p })) : []) }
    readonly property var nextChoices: [{ v: "run", t: "Run", tip: "At the next start this task runs again by itself" },
                                        { v: "ask", t: "Ask me", tip: "At the next start Ujwalam asks you first" },
                                        { v: "notify", t: "Just notify", tip: "At the next start the task waits and a notice tells you" }]

    // The buttons a row offers, from its `controls` only (the one list the shown buttons and the probe both read).
    function buttonsOf(r) {
        const c = r.controls, b = [];
        if (c.indexOf("stop") >= 0) b.push("stop");
        if (c.indexOf("pause") >= 0) b.push("pause");
        if (c.indexOf("resume") >= 0) b.push("resume");
        if (c.indexOf("next") >= 0 && r.nextStart !== "") b.push("next:run", "next:ask", "next:notify");
        return b;
    }
    // Plain words when there is no Pause button: asked to pause, or why it cannot be paused.
    function pauseNote(r) {
        if (r.pausing) return "Pausing at the next safe point…";
        if (r.paused) return "Paused. Press Resume to carry on.";
        if (!r.pausable && r.pauseReason !== "" && (r.state === "running" || r.state === "waiting")) return r.pauseReason;
        return "";
    }
    function sigOf(r) { return JSON.stringify([r.state, r.paused, r.pausing, r.nextStart, r.controls, r.stage, r.stageText]) }
    function busyOf(r) { const p = pending[r.id]; return p !== undefined && p.sig === sigOf(r) }
    function purgePending() {
        const keep = {}, now = Date.now();
        let any = false;
        for (const r of taskCenter.rows) {
            const p = pending[r.id];
            if (p !== undefined && p.sig === sigOf(r) && now - p.at < 10000) { keep[r.id] = p; any = true }
        }
        pending = keep;
        return any;
    }
    Connections {
        target: win.taskCenter
        function onRowsChanged() { win.purgePending() }
    }
    Timer { interval: 1000; repeat: true; running: Object.keys(win.pending).length > 0; onTriggered: win.purgePending() }

    // One click: op is stop, pause, resume or next (with nextStart run, ask or notify). Refused here (nothing sent) when
    // that job does not offer it now, or while the last click on it is still on its way.
    function control(id, op, nextStart) {
        const r = taskCenter.rows.find(x => x.id === id);
        if (!r || busyOf(r) || buttonsOf(r).indexOf(op === "next" ? "next:" + nextStart : op) < 0) return false;
        if (op === "next" && r.nextStart === nextStart) return false; // already chosen
        const body = op === "next" ? { id: id, op: op, nextStart: nextStart } : { id: id, op: op };
        const p = Object.assign({}, pending);
        p[id] = { sig: sigOf(r), at: Date.now() };
        pending = p;
        message = "";
        postsSent++;
        lastPost = body;
        Api.post("ui/api/tasks/control", body, (ok, b, err) => {
            if (ok) return;
            const q = Object.assign({}, pending);
            delete q[id];
            pending = q;
            message = (b && b.reason) ? String(b.reason) : "Could not do that: " + err;
        });
        return true;
    }
    function closeByUser() { return taskCenter.dockWindow() }

    function probeAction(a) {
        if (a.startsWith("tasks:sort:")) { sortKey = a.slice(11); sortBox.pick(sortKey); return true }
        if (a.startsWith("tasks:filter-state:")) { filterState = a.slice(19); stateBox.pick(filterState); return true }
        if (a.startsWith("tasks:filter-cat:")) { filterCat = a.slice(17); catBox.pick(filterCat); return true }
        if (a.startsWith("tasks:select:")) { selected = a.slice(13); return true }
        if (a.startsWith("tasks:ctl:")) { // tasks:ctl:<id>:<op>[:<nextStart>]
            const f = a.slice(10).split(":");
            return control(f[0], f[1], f[2]);
        }
        return false;
    }
    function detailFields(r) {
        if (!r) return [];
        const eta = String(r.l.eta || "").split(" · ");
        const f = [["State", stateText(r)], ["Category", catText(r.category)], ["Stage", r.l.stage], ["Progress", r.l.count],
                   ["Time spent", eta[0] || ""], ["Time left", eta.length > 1 ? eta[1] : ""], ["Last progress", r.l.last],
                   ["Note", r.note], ["Waiting for", r.question], ["Next start", nextText(r.nextStart)], ["Warning", r.l.warn]];
        return f.filter(x => x[1] !== undefined && x[1] !== "").map(x => ({ k: x[0], v: String(x[1]) }));
    }
    function nextText(n) { return n === "run" ? "Run by itself" : n === "ask" ? "Ask me" : n === "notify" ? "Just notify me" : "" }
    function probe() {
        const cur = current;
        return {
            open: taskCenter.windowOpen, visible: win.visible, sort: sortKey, filterState: filterState, filterCat: filterCat,
            sortText: sortBox.text, stateText: stateBox.text, catText: catBox.text, sizeColumn: false,
            ids: shown.map(r => r.id), message: message, postsSent: postsSent, lastPost: lastPost, selected: selected,
            rows: shown.map(r => ({ id: r.id, state: r.state, category: r.category, stateText: stateText(r), buttons: buttonsOf(r),
                                    busy: busyOf(r), note: pauseNote(r), nextStart: r.nextStart, question: r.question })),
            detail: cur ? { id: cur.id, title: cur.title, fields: detailFields(cur), parts: cur.parts, log: cur.logTail, logPlain: logText.textFormat === Text.PlainText,
                            stage: cur.l.stage, count: cur.l.count, eta: cur.l.eta, fraction: cur.l.fraction } : null
        };
    }

    Rectangle {
        anchors.fill: parent
        color: Theme.c.bg
        Column {
            anchors { fill: parent; margins: Theme.sp.l }
            spacing: Theme.sp.m
            // ---- the bar: sort, filter, dock ----
            Item {
                width: parent.width
                height: 36
                Row {
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    spacing: Theme.sp.m
                    Text { text: "Sort by"; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.small; anchors.verticalCenter: parent.verticalCenter }
                    UCombo {
                        id: sortBox
                        objectName: "taskSort"
                        label: "Sort by"
                        width: 210
                        model: win.sortModel
                        onChose: (v) => win.sortKey = v
                    }
                    Text { text: "Show"; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.small; anchors.verticalCenter: parent.verticalCenter }
                    UCombo {
                        id: stateBox
                        objectName: "taskFilterState"
                        label: "Show tasks that are"
                        width: 130
                        model: win.stateModel
                        onChose: (v) => win.filterState = v
                    }
                    Text { text: "Category"; color: Theme.c.muted; font.family: Theme.family; font.pixelSize: Theme.ty.small; anchors.verticalCenter: parent.verticalCenter }
                    UCombo {
                        id: catBox
                        objectName: "taskFilterCat"
                        label: "Category"
                        width: 160
                        model: win.catModel
                        onChose: (v) => win.filterCat = v
                    }
                }
                UButton {
                    objectName: "taskDock"
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    text: "Dock"
                    implicitHeight: 30
                    tip: "Close this window and go back to the small task panel"
                    focusPolicy: Qt.NoFocus
                    onClicked: win.taskCenter.dockWindow()
                }
            }
            Text {
                objectName: "taskMessage"
                visible: win.message !== ""
                width: parent.width
                text: win.message
                wrapMode: Text.Wrap
                color: Theme.c.danger
                font.family: Theme.family
                font.pixelSize: Theme.ty.small
            }
            Row {
                width: parent.width
                height: parent.height - 36 - parent.spacing - (win.message !== "" ? 24 : 0)
                spacing: Theme.sp.l
                // ---- the list ----
                Item {
                    width: Math.round(parent.width * 0.58)
                    height: parent.height
                    Text {
                        visible: win.shown.length === 0
                        text: win.taskCenter.rows.length === 0 ? "Nothing is running." : "No task matches this filter."
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.body
                    }
                    ListView {
                        id: list
                        objectName: "taskManagerRows"
                        anchors.fill: parent
                        clip: true
                        spacing: Theme.sp.s
                        model: win.shownIds
                        boundsBehavior: Flickable.StopAtBounds
                        ScrollBar.vertical: ScrollBar {}
                        delegate: Rectangle {
                            id: row
                            required property string rid
                            required property int index
                            objectName: "mgrRow:" + index
                            readonly property var r: win.taskCenter.rowOf(rid)
                            Component.onCompleted: win.taskCenter.rowsMade++
                            readonly property bool busy: win.busyOf(r)
                            readonly property var btns: win.buttonsOf(r)
                            readonly property string note: win.pauseNote(r)
                            width: ListView.view.width - Theme.sp.m
                            height: rowCol.implicitHeight + 20
                            radius: Theme.radiusMedium
                            color: win.selected === r.id ? Theme.c.panel : Theme.c.field
                            border.width: 1
                            border.color: win.selected === r.id ? Theme.c.accent : r.stalled ? Theme.c.danger : Theme.c.border
                            MouseArea { anchors.fill: parent; onClicked: win.selected = row.r.id }
                            Column {
                                id: rowCol
                                anchors { left: parent.left; right: parent.right; top: parent.top; margins: Theme.sp.m }
                                spacing: Theme.sp.xs
                                Item {
                                    width: parent.width
                                    height: Math.max(rowTitle.implicitHeight, 22)
                                    Text {
                                        id: rowTitle
                                        anchors { left: parent.left; right: rowState.left; rightMargin: Theme.sp.s }
                                        text: row.r.title
                                        wrapMode: Text.Wrap
                                        color: Theme.c.text
                                        font.family: Theme.family
                                        font.pixelSize: Theme.ty.body
                                        font.weight: Font.DemiBold
                                    }
                                    Text {
                                        id: rowState
                                        objectName: "mgrState"
                                        anchors.right: parent.right
                                        text: win.stateText(row.r)
                                        color: row.r.state === "failed" || row.r.stalled ? Theme.c.danger : row.r.state === "done" ? Theme.c.ok : Theme.c.muted
                                        font.family: Theme.family
                                        font.pixelSize: Theme.ty.caption
                                    }
                                }
                                Text {
                                    width: parent.width
                                    text: win.catText(row.r.category) + (row.r.l.stage !== "" ? " - " + row.r.l.stage : "")
                                    wrapMode: Text.Wrap
                                    color: Theme.c.muted
                                    font.family: Theme.family
                                    font.pixelSize: Theme.ty.caption
                                }
                                Rectangle { // progress bar (a sweep is not drawn here: the detail view has the words)
                                    visible: row.r.state === "running" || row.r.state === "waiting"
                                    width: parent.width
                                    height: 5
                                    radius: 2
                                    color: Theme.c.border
                                    Rectangle {
                                        height: parent.height
                                        radius: 2
                                        color: row.r.stalled ? Theme.c.danger : Theme.c.accent
                                        visible: row.r.state === "running" && row.r.l.fraction > 0
                                        width: Math.max(parent.height, parent.width * Math.max(0, Math.min(1, row.r.l.fraction)))
                                    }
                                }
                                Text {
                                    objectName: "mgrNote"
                                    visible: row.note !== ""
                                    width: parent.width
                                    text: row.note
                                    wrapMode: Text.Wrap
                                    color: row.r.pausing ? Theme.c.accentHi : Theme.c.muted
                                    font.family: Theme.family
                                    font.pixelSize: Theme.ty.caption
                                }
                                Text {
                                    visible: row.r.question !== ""
                                    width: parent.width
                                    text: row.r.question
                                    wrapMode: Text.Wrap
                                    color: Theme.c.text
                                    font.family: Theme.family
                                    font.pixelSize: Theme.ty.small
                                }
                                Flow { // the buttons this job offers, nothing else; they wait for the list to change after a click
                                    visible: row.btns.length > 0
                                    width: parent.width
                                    spacing: Theme.sp.s
                                    UButton {
                                        objectName: "mgrStop"
                                        visible: row.btns.indexOf("stop") >= 0
                                        enabled: !row.busy
                                        text: "Stop"
                                        kind: "danger"
                                        implicitHeight: 28
                                        focusPolicy: Qt.NoFocus
                                        tip: "Stop this task. Unfinished work is kept and starts again at the next start, as you chose below."
                                        onClicked: win.control(row.r.id, "stop")
                                    }
                                    UButton {
                                        objectName: "mgrPause"
                                        visible: row.btns.indexOf("pause") >= 0
                                        enabled: !row.busy
                                        text: "Pause"
                                        implicitHeight: 28
                                        focusPolicy: Qt.NoFocus
                                        tip: "Pause at the next safe point. Work done so far is kept."
                                        onClicked: win.control(row.r.id, "pause")
                                    }
                                    UButton {
                                        objectName: "mgrResume"
                                        visible: row.btns.indexOf("resume") >= 0
                                        enabled: !row.busy
                                        text: "Resume"
                                        kind: "primary"
                                        implicitHeight: 28
                                        focusPolicy: Qt.NoFocus
                                        tip: "Carry on from where it paused"
                                        onClicked: win.control(row.r.id, "resume")
                                    }
                                    Text {
                                        visible: row.btns.indexOf("next:run") >= 0
                                        height: 28
                                        verticalAlignment: Text.AlignVCenter
                                        text: "Next start:"
                                        color: Theme.c.muted
                                        font.family: Theme.family
                                        font.pixelSize: Theme.ty.caption
                                    }
                                    Repeater {
                                        model: win.nextChoices // a fixed model: the buttons are made once per row
                                        UButton {
                                            required property var modelData
                                            visible: row.btns.indexOf("next:run") >= 0
                                            objectName: "mgrNext:" + modelData.v
                                            enabled: !row.busy
                                            text: modelData.t
                                            kind: row.r.nextStart === modelData.v ? "primary" : "normal"
                                            implicitHeight: 28
                                            focusPolicy: Qt.NoFocus
                                            tip: modelData.tip
                                            onClicked: win.control(row.r.id, "next", modelData.v)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // ---- the details of the clicked task ----
                Rectangle {
                    objectName: "taskDetail"
                    width: parent.width - Math.round(parent.width * 0.58) - parent.spacing
                    height: parent.height
                    radius: Theme.radiusMedium
                    color: Theme.c.panel
                    border.width: 1
                    border.color: Theme.c.border
                    Text {
                        visible: win.current === null
                        anchors { left: parent.left; top: parent.top; margins: Theme.sp.l }
                        text: "Click a task to see its details."
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.body
                    }
                    Flickable {
                        visible: win.current !== null
                        anchors { fill: parent; margins: Theme.sp.l }
                        contentHeight: detCol.implicitHeight
                        clip: true
                        boundsBehavior: Flickable.StopAtBounds
                        ScrollBar.vertical: ScrollBar {}
                        Column {
                            id: detCol
                            width: parent.width - Theme.sp.m
                            spacing: Theme.sp.s
                            Text {
                                width: parent.width
                                text: win.current ? win.current.title : ""
                                wrapMode: Text.Wrap
                                color: Theme.c.text
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.body
                                font.weight: Font.DemiBold
                            }
                            Repeater {
                                model: win.detailModel
                                Row {
                                    required property string k
                                    required property string v
                                    width: detCol.width
                                    spacing: Theme.sp.m
                                    Text {
                                        width: 96
                                        text: k
                                        color: Theme.c.muted
                                        font.family: Theme.family
                                        font.pixelSize: Theme.ty.small
                                    }
                                    Text {
                                        width: parent.width - 96 - Theme.sp.m
                                        text: v
                                        textFormat: Text.PlainText
                                        wrapMode: Text.Wrap
                                        color: k === "Warning" ? Theme.c.danger : Theme.c.text
                                        font.family: Theme.family
                                        font.pixelSize: Theme.ty.small
                                    }
                                }
                            }
                            Text {
                                visible: win.current !== null && win.current.parts.length > 0
                                text: "Running now"
                                color: Theme.c.muted
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.small
                            }
                            Repeater {
                                model: win.partsModel
                                Text {
                                    required property string p
                                    width: detCol.width
                                    text: "- " + p
                                    textFormat: Text.PlainText
                                    elide: Text.ElideRight
                                    color: Theme.c.text
                                    font.family: Theme.family
                                    font.pixelSize: Theme.ty.small
                                }
                            }
                            Text {
                                visible: win.current !== null && win.current.logTail.length > 0
                                text: "Latest log lines"
                                color: Theme.c.muted
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.small
                            }
                            Text {
                                id: logText
                                objectName: "taskLog"
                                visible: win.current !== null && win.current.logTail.length > 0
                                width: detCol.width
                                text: win.current ? win.current.logTail.join("\n") : ""
                                textFormat: Text.PlainText // log lines are data: never read as HTML or rich text
                                wrapMode: Text.Wrap
                                color: Theme.c.muted
                                font.family: Theme.family
                                font.pixelSize: Theme.ty.caption
                            }
                        }
                    }
                }
            }
        }
    }
}
