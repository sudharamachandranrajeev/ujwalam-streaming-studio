// SPDX-License-Identifier: GPL-3.0-or-later
// The Outputs panel (D327 OS3, flag outputs-panel; the widget's streampages::OutputsPanel): one row per stream output
// with its switch, and Virtual Camera (not in this host build: shown, switched off). Offline the switch is the saved
// choice of what Start stream starts; live it starts or stops that one output on the click (D332). + opens Settings >
// Stream. Read on every flag read, as the widget does. Height follows the rows, so the layers list above keeps the rest.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    objectName: "outputsPanel"
    required property var store
    title: "Outputs"
    visible: store.flags["outputs-panel"] === true
    implicitHeight: visible ? rows.implicitHeight + 56 : 0

    property var panelData: ({})
    property var outputs: []   // the row list: replaced only when the ids change, so the switches keep their place
    property var byId: ({})    // every read: the states the switches follow
    property bool busy: false
    readonly property bool live: panelData.live === true

    Connections {
        target: panel.store
        function onFlagsRead() { if (panel.visible) panel.refresh() }
    }

    function refresh() {
        if (busy) return;
        busy = true;
        Api.get("ui/api/outputs/panel", (ok, b, err) => {
            busy = false;
            if (!ok) { if (!panelData.outputs) store.say("Outputs not available: " + err); return; }
            const list = Array.isArray(b.outputs) ? b.outputs : [];
            const ids = list.map(o => o.id).join("\n");
            if (!panelData.outputs || ids !== (panelData.outputs || []).map(o => o.id).join("\n")) outputs = list;
            const m = {};
            for (const o of list) m[o.id] = o;
            byId = m;
            panelData = b;
        });
    }
    // Offline: the saved choice. Live: what the host is doing for that output.
    function isOn(o) {
        if (!o) return false;
        return live ? (o.state === "live" || o.state === "starting" || o.state === "retrying") : o.enabled === true;
    }
    function canSwitch(o) { return !!o && o.inPlan === true && (!live || (typeof o.state === "string" && o.state !== "")) }
    function tipFor(o) {
        if (!o || o.inPlan !== true) return "Portrait outputs need Main + portrait canvas (Settings > Stream).";
        return live ? "Live: switching starts or stops this output only, at once." : "Whether Start stream starts this output.";
    }
    function toggle(id, on) {
        Api.post("ui/api/outputs/toggle", { id: id, on: on }, (ok, b, err) => {
            if (!ok) store.say("Output not switched: " + (b && b.detail ? b.detail : err));
            else if (b.verdict === "confirm") store.confirmNeeded(b.pending);
            panelData = ({}); // the next read shows the real state (a refused or unconfirmed switch goes back)
            refresh();
        });
    }
    function badge(p) { return p === "youtube" ? "YT" : p === "twitch" ? "TW" : String(p || "?").charAt(0).toUpperCase() }

    // ---- probe (tests): outputs-toggle:<id>:<on|off>, outputs-add ----
    function probe() {
        const r = [];
        for (let i = 0; i < rowRep.count; i++) {
            const it = rowRep.itemAt(i);
            if (it) r.push({ id: it.oid, on: it.sw.checked, enabled: it.sw.enabled });
        }
        return { shown: visible, rows: r, live: live, virtualCamera: vcSwitch.enabled };
    }
    function probeAction(a) {
        if (!visible) return false;
        if (a === "outputs-add") { addBtn.clicked(); return true }
        const p = a.split(":");
        if (p.length !== 3 || p[0] !== "outputs-toggle") return false;
        for (let i = 0; i < rowRep.count; i++) {
            const it = rowRep.itemAt(i);
            if (!it || it.oid !== p[1]) continue;
            const on = p[2] === "on";
            if (!it.sw.enabled || it.sw.checked === on) return false;
            it.sw.toggle();
            it.sw.toggled();
            return true;
        }
        return false;
    }

    tools: UIconButton {
        id: addBtn
        objectName: "outputsAdd"
        iconName: "plus"
        tip: "Add an output (Settings > Stream)"
        onClicked: panel.store.settingsWanted("Stream")
    }

    Column {
        id: rows
        anchors { left: parent.left; right: parent.right; top: parent.top }
        spacing: 6
        Repeater {
            id: rowRep
            model: panel.outputs
            delegate: Item {
                id: row
                required property var modelData
                readonly property string oid: modelData.id
                readonly property var o: panel.byId[oid] || modelData
                property alias sw: sw
                objectName: "outputRow:" + oid
                width: rows.width
                height: Math.max(badgeBox.height, sw.implicitHeight)
                // On the row, so the reason also shows when the switch is off (a disabled switch gets no hover).
                HoverHandler { id: rowHover }
                ToolTip.visible: rowHover.hovered
                ToolTip.text: panel.tipFor(row.o)
                ToolTip.delay: 500
                Rectangle {
                    id: badgeBox
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    width: 30; height: 22
                    radius: Theme.radiusSmall
                    color: Theme.c.field
                    border.width: 1
                    border.color: Theme.c.border
                    Text {
                        anchors.centerIn: parent
                        text: panel.badge(row.o.platform)
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 11
                        font.weight: Font.Bold
                    }
                }
                USwitch {
                    id: sw
                    objectName: "outputSwitch:" + row.oid
                    anchors { left: badgeBox.right; right: parent.right; leftMargin: 8; verticalCenter: parent.verticalCenter }
                    text: row.o.name || row.oid
                    hint: row.o.summary || ""
                    checked: panel.isOn(row.o)
                    enabled: panel.canSwitch(row.o)
                    // A click: send it, then follow the server again (the read decides what the switch shows).
                    onToggled: { const on = checked; checked = Qt.binding(() => panel.isOn(row.o)); panel.toggle(row.oid, on); }
                }
            }
        }
        // Virtual Camera: not in this host build (no virtual camera method); shown, switched off.
        Item {
            width: rows.width
            height: vcSwitch.implicitHeight
            visible: panel.panelData.outputs !== undefined
            HoverHandler { id: vcHover }
            ToolTip.visible: vcHover.hovered && ToolTip.text !== ""
            ToolTip.text: (panel.panelData.virtualCamera || {}).reason || ""
            ToolTip.delay: 500
            Rectangle {
                id: vcBadge
                anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                width: 30; height: 22
                radius: Theme.radiusSmall
                color: Theme.c.field
                border.width: 1
                border.color: Theme.c.border
                Text { anchors.centerIn: parent; text: "VC"; color: Theme.c.text; font.family: Theme.family; font.pixelSize: 11; font.weight: Font.Bold }
            }
            USwitch {
                id: vcSwitch
                objectName: "virtualCameraSwitch"
                anchors { left: vcBadge.right; right: parent.right; leftMargin: 8; verticalCenter: parent.verticalCenter }
                text: "Virtual Camera"
                hint: "Not available in this build"
                checked: false
                enabled: (panel.panelData.virtualCamera || {}).available === true
            }
        }
    }
}
