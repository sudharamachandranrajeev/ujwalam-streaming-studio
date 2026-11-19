// SPDX-License-Identifier: GPL-3.0-or-later
// The scene menu (right-click on a scene; the widget's buildSceneMenu). Blank = right-click on empty space: only
// "Add scene". Rename and Duplicate need no flag; Make realism scene shows only while flag realism-look is on; Delete
// needs scene editing and is never offered for the active scene.
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
    UMenuItem { objectName: "sceneMenu:realism"; visible: !menu.blank && menu.store.realism; height: visible ? implicitHeight : 0; text: "Make realism scene"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.edit.realismScene(menu.sceneId) }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    UMenuItem { objectName: "sceneMenu:delete"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Delete…"; keys: "Del"
                enabled: menu.editable && menu.store.sceneEdit && !menu.active; tip: menu.delTip; onTriggered: menu.store.deleteScene(menu.sceneId) }
}
