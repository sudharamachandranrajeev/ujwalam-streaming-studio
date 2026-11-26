// SPDX-License-Identifier: GPL-3.0-or-later
// The scene menu (right-click on a scene; the widget's buildSceneMenu). Blank = right-click on empty space: only
// "Add scene". Rename and Duplicate need no flag; Make realism scene (a submenu: one row per look, D445, the user's own
// looks last, then "New look from a reference…", RL5) shows only while flag realism-look is on; Delete needs scene
// editing and is never offered for the active scene.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UMenu {
    id: menu
    objectName: "sceneMenu"
    required property var store
    property bool blank: false
    property string sceneId: ""

    readonly property bool has: sceneId !== ""
    readonly property bool active: sceneId === store.activeScene
    readonly property string lockTip: store.live ? "Not while live" : ""
    readonly property bool editable: has && !store.live
    readonly property string delTip: lockTip !== "" ? lockTip : !store.sceneEdit ? "Turn on scene editing in Settings > Editing"
                                   : active ? "Switch to another scene first" : ""

    UMenuItem { objectName: "sceneMenu:addscene"; text: "Add scene…"; enabled: !menu.store.live; tip: menu.lockTip; onTriggered: menu.store.addScene() }
    UMenuItem { objectName: "sceneMenu:add"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Add layer…"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.addLayer(menu.sceneId) }
    // MU2: the scene's music (mood, level, on). Works while live (it changes what the stream hears, never the picture).
    UMenuItem { objectName: "sceneMenu:music"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Music…"
                enabled: menu.has; onTriggered: menu.store.openSceneMusic(menu.sceneId) }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    UMenuItem { objectName: "sceneMenu:rename"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Rename…"; keys: "F2"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.edit.renameSceneWanted(menu.sceneId) }
    UMenuItem { objectName: "sceneMenu:duplicate"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Duplicate scene"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.edit.duplicateScene(menu.sceneId) }
    // D445: one row per look of the library; a click makes "<scene> <look name>" with that look (the original stays).
    UMenu {
        id: looksMenu
        objectName: "sceneMenu:realism"
        title: "Make realism scene"
        shown: !menu.blank && menu.store.realism
        enabled: menu.editable
        tip: menu.lockTip
        function make(look) { menu.store.edit.realismScene(menu.sceneId, look) }
        Instantiator {
            model: menu.store.looks
            delegate: UMenuItem {
                required property var modelData
                objectName: "lookMenu:" + modelData.id
                text: modelData.name
                tip: modelData.summary
                // not "menu" here: inside a MenuItem that name is the item's own menu (this submenu)
                onTriggered: looksMenu.make(modelData.id)
            }
            onObjectAdded: (index, object) => looksMenu.insertItem(index, object)
            onObjectRemoved: (index, object) => looksMenu.removeItem(object)
        }
        // RL5: a look of the user's own from a screenshot or short video (the rows above, own looks last)
        MenuSeparator {}
        UMenuItem {
            id: newLook
            objectName: "sceneMenu:newLook"
            text: "New look from a reference…"
            tip: "Measure the colour of a screenshot or short video you like and save it as a look of your own"
            onTriggered: menu.store.newLookFromReference()
        }
    }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    // the look rows for the tests' probe (read while the submenu is closed, so not by items(), which needs them shown);
    // makeLook(id) clicks one as a click on that row does
    function lookItems() {
        const out = [];
        for (let i = 0; i < looksMenu.count; i++) {
            const m = looksMenu.itemAt(i);
            if (m && m.objectName.startsWith("lookMenu:"))
                out.push({ id: m.objectName.slice(9), text: m.text, enabled: m.enabled && looksMenu.enabled, tip: m.tip });
        }
        return out;
    }
    function newLookRow() { return { text: newLook.text, enabled: newLook.enabled && looksMenu.enabled, shown: looksMenu.shown, tip: newLook.tip } }
    function newLookClick() {
        if (!looksMenu.shown || !looksMenu.enabled) return false;
        menu.close();
        newLook.triggered();
        return true;
    }
    function makeLook(id) {
        if (!looksMenu.shown || !looksMenu.enabled) return false;
        for (let i = 0; i < looksMenu.count; i++) {
            const m = looksMenu.itemAt(i);
            if (m && m.objectName === "lookMenu:" + id) { menu.close(); m.triggered(); return true; }
        }
        return false;
    }
    UMenuItem { objectName: "sceneMenu:delete"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Delete…"; keys: "Del"
                enabled: menu.editable && menu.store.sceneEdit && !menu.active; tip: menu.delTip; onTriggered: menu.store.deleteScene(menu.sceneId) }
}
