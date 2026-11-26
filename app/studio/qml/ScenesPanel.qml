// SPDX-License-Identifier: GPL-3.0-or-later
// Scenes (plan Q2): one card per scene, the active one marked in words and colour. A click switches to it (scene
// switches stay instant while live, server HOST_CALLS). Add is the + in the heading; each other scene's card has its own
// delete button (the active scene is never deleted: switch first). Plan Q4: right-click opens the scene menu
// (SceneMenu.qml: Add scene, Add layer, Rename, Duplicate scene, Make realism scene, Delete; on empty space only Add
// scene); F2 renames and Del deletes the scene last clicked or focused.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    required property var store
    title: "Scenes"

    // The scene the keys and the menu act on: the last one clicked, right-clicked or focused (not always the active one).
    property string current: ""
    readonly property var keyNames: ["F2", "Del"]
    function handleKey(name) {
        if (name === "F2") store.edit.renameSceneWanted(current);
        else if (name === "Del") { if (current !== "") store.deleteScene(current) }
        else return false;
        return true;
    }
    function openMenu(blank, id, x, y) {
        menu.blank = blank;
        menu.sceneId = blank ? "" : id;
        menu.popup(list, x, y);
    }
    // Probe (tests): select-scene:<id> (the current scene only, no switch), scene-menu:show | blank | <item id> |
    // realism:<look id> (a row of the Make realism scene submenu), newlook (its New look from a reference…), scene-key:<keys>.
    function probeAction(a) {
        if (a.startsWith("select-scene:")) {
            const id = a.slice(13);
            if (!store.scenes.some(s => s.id === id)) return false;
            current = id;
            return true;
        }
        if (a === "scene-menu:show" || a === "scene-menu:blank") { openMenu(a === "scene-menu:blank", current, 20, 20); return true }
        if (a === "scene-menu:newlook") {
            menu.close();
            openMenu(false, current, 20, 20);
            return menu.newLookClick();
        }
        if (a.startsWith("scene-menu:realism:")) {
            menu.close();
            openMenu(false, current, 20, 20);
            return menu.makeLook(a.slice(19));
        }
        if (a.startsWith("scene-menu:")) {
            menu.close(); // each action opens the menu afresh for the scene selected now, as the widget builds it
            openMenu(false, current, 20, 20);
            return menu.trigger(a.slice(11));
        }
        if (a.startsWith("scene-key:")) return handleKey(a.slice(10));
        return false;
    }
    function probe() {
        return { menu: { open: menu.opened, blank: menu.blank, scene: menu.sceneId, items: menu.items(), looks: menu.lookItems(), newLook: menu.newLookRow() }, keys: keyNames, current: current };
    }
    SceneMenu { id: menu; store: panel.store }

    tools: [
        UIconButton {
            objectName: "addScene"
            iconName: "plus"
            tip: panel.store.live ? "Add scene (not while live)" : "Add scene"
            onClicked: panel.store.addScene()
        }
    ]

    ListView {
        id: list
        objectName: "sceneList"
        anchors.fill: parent
        clip: true
        spacing: Theme.sp.s
        model: panel.store.scenes
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Scenes"
        Keys.onPressed: (ev) => {
            const k = ev.key === Qt.Key_F2 ? "F2" : ev.key === Qt.Key_Delete ? "Del" : "";
            if (k !== "" && panel.handleKey(k)) ev.accepted = true;
        }
        TapHandler { // right-click: the scene under the pointer, or empty space (only Add scene)
            acceptedButtons: Qt.RightButton
            onTapped: (pt) => {
                const row = list.indexAt(pt.position.x + list.contentX, pt.position.y + list.contentY);
                if (row >= 0) panel.current = panel.store.scenes[row].id;
                list.forceActiveFocus();
                panel.openMenu(row < 0, row >= 0 ? panel.current : "", pt.position.x, pt.position.y);
            }
        }
        delegate: ItemDelegate {
            id: card
            required property var modelData
            required property int index
            readonly property bool active: modelData.id === panel.store.activeScene
            objectName: "scene:" + modelData.id
            width: ListView.view.width - 4
            height: 52
            hoverEnabled: true
            Accessible.name: modelData.name + (active ? ", active" : "")
            focusPolicy: Qt.StrongFocus
            onActiveFocusChanged: if (activeFocus) panel.current = modelData.id
            onClicked: { panel.current = modelData.id; if (!active) panel.store.activateScene(modelData.id) }
            background: Rectangle {
                radius: Theme.radiusMedium
                color: card.active ? Qt.alpha(Theme.c.accent, 0.18) : card.hovered ? Theme.c.field : "transparent"
                border.width: card.active ? 1 : 0
                border.color: Theme.c.accent
            }
            contentItem: Item {
                UIconButton {
                    id: del
                    objectName: "deleteScene:" + card.modelData.id
                    visible: !card.active && (card.hovered || card.visualFocus || del.hovered || del.visualFocus)
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    iconName: "trash"
                    iconToken: "danger"
                    // Enabled even when it cannot delete: the click says why in the status line (a disabled button
                    // shows no tooltip).
                    tip: panel.store.live ? "Delete scene (not while live)"
                       : !panel.store.sceneEdit ? "Delete scene (turn on scene editing in Settings > Editing first)"
                       : "Delete “" + card.modelData.name + "”"
                    onClicked: panel.store.deleteScene(card.modelData.id)
                }
                Text {
                    id: nameText
                    anchors { left: parent.left; right: del.visible ? del.left : parent.right; rightMargin: del.visible ? 4 : 0; top: parent.top; topMargin: 2 }
                    text: card.modelData.name
                    elide: Text.ElideRight
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.body
                    font.weight: card.active ? Font.DemiBold : Font.Normal
                }
                Text {
                    anchors { left: parent.left; right: parent.right; top: nameText.bottom; topMargin: 2 }
                    text: (card.active ? "Active  ·  " : "") + card.modelData.canvases.map(c => c.toUpperCase()).join(" + ")
                    elide: Text.ElideRight
                    color: card.active ? Theme.c.accentHi : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.caption
                }
            }
        }
    }
    Text {
        anchors.centerIn: parent
        visible: panel.store.scenes.length === 0
        text: panel.store.hostUp ? "No scenes in this project" : "Waiting for the host..."
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
}
