// SPDX-License-Identifier: GPL-3.0-or-later
// Layers of the active scene (plan Q2), top layer first. Each row: a real eye icon that shows or hides the layer (its
// own button, with a tooltip and an accessible name), the name in full width, and a second line when a capture
// layer's device is waiting or connecting (D329, the host's sentence as the tooltip). A click selects the layer; the
// preview's mouse then edits it (D335 F8). H and V switch the canvas when the scene has both. Add and Delete sit in the
// heading (one place, plan Q2); Del deletes the selected layer too. Neither needs a flag, only "not live" (D330).
// Plan Q4: Undo and Redo of layer edits sit in the heading; right-click opens the layer menu (LayerMenu.qml); keys on the
// list: Ctrl+D duplicate, F2 rename, Del delete, Ctrl+Shift+C / V copy and paste a look; press and drag a row to reorder.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    required property var store
    title: "Layers"

    // Probe (tests): select-layer:<id>, layer-menu:show | blank | <item id>, layer-key:<keys>, layer-drag:<fromRow>:<toRow>.
    function probeAction(a) {
        if (a.startsWith("select-layer:")) {
            const id = a.slice(13);
            if (!store.layers.some(l => l.id === id)) return false;
            store.select(id);
            return true;
        }
        if (a === "layer-menu:show" || a === "layer-menu:blank") { openMenu(a === "layer-menu:blank", 20, 20); return true }
        if (a.startsWith("layer-menu:")) {
            menu.close(); // each action opens the menu afresh for the layer selected now, as the widget builds it
            openMenu(false, 20, 20);
            return menu.trigger(a.slice(11));
        }
        if (a.startsWith("layer-key:")) return handleKey(a.slice(10));
        if (a.startsWith("layer-drag:")) {
            const p = a.slice(11).split(":").map(Number);
            return dragRow(p[0], p[1]);
        }
        return false;
    }
    function probe() {
        return { menu: { open: menu.opened, blank: menu.blank, items: menu.items() }, keys: keyNames, undoTip: undoBtn.tip, redoTip: redoBtn.tip };
    }

    LayerMenu { id: menu; store: panel.store }
    function openMenu(blank, x, y) {
        menu.blank = blank;
        menu.popup(list, x, y);
    }

    // The keys of the list, by name: one table drives the real key events and the tests' layer-key: probe.
    readonly property var keyNames: ["Ctrl+D", "F2", "Del", "Ctrl+Shift+C", "Ctrl+Shift+V"]
    function handleKey(name) {
        const e = store.edit;
        if (name === "Ctrl+D") e.duplicateLayer();
        else if (name === "F2") e.renameLayerWanted();
        else if (name === "Del") store.deleteLayer();
        else if (name === "Ctrl+Shift+C") e.copyLook();
        else if (name === "Ctrl+Shift+V") e.pasteLook();
        else return false;
        return true;
    }
    function nameOfKey(ev) {
        const c = (ev.modifiers & Qt.ControlModifier) !== 0, s = (ev.modifiers & Qt.ShiftModifier) !== 0;
        if (ev.key === Qt.Key_D && c && !s) return "Ctrl+D";
        if (ev.key === Qt.Key_F2) return "F2";
        if (ev.key === Qt.Key_Delete) return "Del";
        if (ev.key === Qt.Key_C && c && s) return "Ctrl+Shift+C";
        if (ev.key === Qt.Key_V && c && s) return "Ctrl+Shift+V";
        return "";
    }

    // Reorder by drag (D330): the rows are top first, the host order bottom first. gap = the place between rows the
    // pointer is at (0 = above the first row); the row ends where it was once taken out of its old place.
    property int dragFrom: -1
    property int dragGap: -1
    function gapAt(y) { // y in the list's own coordinates
        const n = list.count;
        for (let r = 0; r < n; r++) {
            const it = list.itemAtIndex(r);
            if (it && y < it.y - list.contentY + it.height / 2) return r;
        }
        return n;
    }
    function gapY(gap) {
        const n = list.count;
        if (n === 0) return 0;
        const it = list.itemAtIndex(Math.min(gap, n - 1));
        if (!it) return 0;
        return gap < n ? it.y - list.contentY - 1 : it.y - list.contentY + it.height + 1;
    }
    // Row `from` ends at row `to` (rows top first): the move the widget list asks for when a drag ends.
    function dragRow(from, to) {
        const n = store.layers.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return false;
        const id = store.layers.slice().reverse()[from].id;
        store.select(id); // the move acts on the selected layer; a press selects it first
        store.edit.moveTo(n - 1 - to);
        return true;
    }

    tools: [
        UIconButton {
            id: undoBtn
            objectName: "undoBtn"
            iconName: "undo"
            enabled: panel.store.edit.canUndo
            tip: panel.store.live ? "Undo (not while live)" : panel.store.edit.nextUndo !== "" ? "Undo: " + panel.store.edit.nextUndo : "Undo (Ctrl+Z)"
            onClicked: panel.store.edit.undoRedo(true)
        },
        UIconButton {
            id: redoBtn
            objectName: "redoBtn"
            iconName: "redo"
            enabled: panel.store.edit.canRedo
            tip: panel.store.live ? "Redo (not while live)" : panel.store.edit.nextRedo !== "" ? "Redo: " + panel.store.edit.nextRedo : "Redo (Ctrl+Y)"
            onClicked: panel.store.edit.undoRedo(false)
        },
        UToggle {
            objectName: "canvasH"
            visible: panel.store.bothCanvases
            text: "H"
            checked: panel.store.canvas === "h"
            tip: "Layers of the horizontal canvas"
            onClicked: { checked = Qt.binding(() => panel.store.canvas === "h"); panel.store.showCanvas("h") }
        },
        UToggle {
            objectName: "canvasV"
            visible: panel.store.bothCanvases
            text: "V"
            checked: panel.store.canvas === "v"
            tip: "Layers of the vertical canvas"
            onClicked: { checked = Qt.binding(() => panel.store.canvas === "v"); panel.store.showCanvas("v") }
        },
        UIconButton {
            objectName: "addLayer"
            iconName: "plus"
            tip: panel.store.live ? "Add layer (not while live)" : "Add layer"
            onClicked: panel.store.addLayer("")
        },
        UIconButton {
            objectName: "deleteLayer"
            iconName: "trash"
            iconToken: "danger"
            enabled: panel.store.selectedLayer !== null
            tip: panel.store.live ? "Delete layer (not while live)" : "Delete the selected layer (Del)"
            onClicked: panel.store.deleteLayer()
        }
    ]

    ListView {
        id: list
        objectName: "layerList"
        anchors.fill: parent
        clip: true
        spacing: 2
        model: panel.store.layers.slice().reverse()
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Layers"
        // from a focused row too: unhandled keys reach the list
        Keys.onPressed: (ev) => { const k = panel.nameOfKey(ev); if (k !== "" && panel.handleKey(k)) ev.accepted = true }
        TapHandler { // right-click: the layer under the pointer (it becomes the selected one), or empty space
            acceptedButtons: Qt.RightButton
            onTapped: (pt) => {
                const row = list.indexAt(pt.position.x + list.contentX, pt.position.y + list.contentY);
                if (row >= 0) panel.store.select(list.model[row].id);
                list.forceActiveFocus();
                panel.openMenu(row < 0, pt.position.x, pt.position.y);
            }
        }
        Rectangle { // the place the dragged row will land
            visible: panel.dragFrom >= 0
            x: 4
            width: list.width - 12
            height: 2
            y: panel.dragGap >= 0 ? panel.gapY(panel.dragGap) : 0
            color: Theme.c.accentHi
            z: 5
        }
        delegate: ItemDelegate {
            id: row
            required property var modelData
            required property int index
            readonly property bool sel: modelData.id === panel.store.selected
            readonly property var dev: modelData.device || {}
            readonly property bool waiting: dev.state === "waiting"
            readonly property bool connecting: dev.state === "connecting"
            objectName: "layer:" + modelData.id
            width: ListView.view.width - 4
            height: waiting || connecting ? 48 : 36
            hoverEnabled: true
            Accessible.name: modelData.name + (modelData.visible ? "" : ", hidden") + (sel ? ", selected" : "")
            focusPolicy: Qt.StrongFocus
            onClicked: panel.store.select(modelData.id)
            DragHandler {
                id: drag
                target: null
                xAxis.enabled: false
                acceptedButtons: Qt.LeftButton
                onActiveChanged: {
                    if (active) {
                        panel.dragFrom = row.index;
                        panel.store.select(row.modelData.id);
                        list.interactive = false;
                    } else {
                        const y = list.mapFromItem(row, 0, centroid.position.y).y;
                        const from = panel.dragFrom, gap = panel.gapAt(y);
                        const inside = y > -4 && y < list.height + 4;
                        panel.dragFrom = -1;
                        panel.dragGap = -1;
                        list.interactive = true;
                        const to = gap > from ? gap - 1 : gap; // the row it ends at once taken out of its old place
                        if (inside && to !== from) panel.dragRow(from, to);
                    }
                }
                onCentroidChanged: if (active) panel.dragGap = panel.gapAt(list.mapFromItem(row, 0, centroid.position.y).y)
            }
            ToolTip.visible: (waiting || connecting) && hovered && !!dev.message
            ToolTip.text: dev.message || ""
            ToolTip.delay: 500
            background: Rectangle {
                radius: Theme.radiusSmall
                color: row.sel ? Qt.alpha(Theme.c.accent, 0.2) : row.hovered ? Theme.c.field : "transparent"
                border.width: row.sel ? 1 : 0
                border.color: Theme.c.accent
            }
            contentItem: Item {
                UIconButton {
                    id: eye
                    objectName: "eye:" + row.modelData.id
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    iconName: row.modelData.visible ? "eye" : "eye-off"
                    iconToken: row.modelData.visible ? "text" : "muted"
                    tip: row.modelData.visible ? "Hide this layer" : "Show this layer"
                    onClicked: panel.store.setVisible(row.modelData.id, !row.modelData.visible)
                }
                Text {
                    id: name
                    anchors { left: eye.right; leftMargin: 8; right: parent.right; top: parent.top; topMargin: row.waiting || row.connecting ? 4 : 0 }
                    height: row.waiting || row.connecting ? implicitHeight : parent.height
                    verticalAlignment: Text.AlignVCenter
                    text: row.modelData.name
                    elide: Text.ElideRight
                    color: row.modelData.visible && !row.waiting ? Theme.c.text : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 14
                }
                Text {
                    visible: row.waiting || row.connecting
                    anchors { left: name.left; right: parent.right; top: name.bottom; topMargin: 1 }
                    text: row.waiting ? "Waiting for the device" : "Connecting to the device"
                    elide: Text.ElideRight
                    color: row.waiting ? Theme.c.danger : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 12
                }
            }
        }
    }
    Text {
        anchors.centerIn: parent
        visible: panel.store.layers.length === 0 && panel.store.activeScene !== ""
        text: "This scene has no layers"
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 13
    }
}
