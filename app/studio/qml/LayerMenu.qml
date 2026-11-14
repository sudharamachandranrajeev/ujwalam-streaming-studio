// SPDX-License-Identifier: GPL-3.0-or-later
// The layer menu (right-click on a layer; the widget's buildLayerMenu). Blank = right-click on empty space: only
// "Add layer". Greyed items say why in a tip ("Not while live"). Every item calls EditOps, as its key does.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UMenu {
    id: menu
    objectName: "layerMenu"
    required property var store
    property bool blank: false

    readonly property var l: store.selectedLayer
    readonly property bool has: l !== null
    readonly property bool hasPlacement: has && l.placement !== undefined
    readonly property int at: store.layers.findIndex(x => x.id === store.selected) // host order: bottom first
    readonly property int n: store.layers.length
    readonly property string lockTip: store.live ? "Not while live" : ""
    readonly property bool editable: has && !store.live

    UMenuItem { objectName: "layerMenu:add"; text: "Add layer…"; enabled: !menu.store.live && menu.store.activeScene !== ""; tip: menu.lockTip
                onTriggered: menu.store.addLayer("") }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    UMenuItem { objectName: "layerMenu:duplicate"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Duplicate"; keys: "Ctrl+D"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.edit.duplicateLayer() }
    UMenuItem { objectName: "layerMenu:rename"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Rename…"; keys: "F2"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.edit.renameLayerWanted() }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    UMenuItem { objectName: "layerMenu:visible"; visible: !menu.blank; height: visible ? implicitHeight : 0
                text: menu.l && menu.l.visible ? "Hide" : "Show"; enabled: menu.has; onTriggered: menu.store.edit.toggleVisible() }
    UMenuItem { objectName: "layerMenu:up"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Move up"
                enabled: menu.has && menu.at >= 0 && menu.at < menu.n - 1; onTriggered: menu.store.edit.moveTo(menu.at + 1) }
    UMenuItem { objectName: "layerMenu:down"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Move down"
                enabled: menu.has && menu.at > 0; onTriggered: menu.store.edit.moveTo(menu.at - 1) }
    UMenuItem { objectName: "layerMenu:top"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Move to top"
                enabled: menu.has && menu.at >= 0 && menu.at < menu.n - 1; onTriggered: menu.store.edit.moveTo(menu.n - 1) }
    UMenuItem { objectName: "layerMenu:bottom"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Move to bottom"
                enabled: menu.has && menu.at > 0; onTriggered: menu.store.edit.moveTo(0) }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    UMenuItem { objectName: "layerMenu:copylook"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Copy look"; keys: "Ctrl+Shift+C"
                enabled: menu.hasPlacement; onTriggered: menu.store.edit.copyLook() }
    UMenuItem { objectName: "layerMenu:pastelook"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Paste look"; keys: "Ctrl+Shift+V"
                enabled: menu.hasPlacement && menu.store.edit.hasLookClip; tip: menu.store.edit.hasLookClip ? "" : "Copy a look first"
                onTriggered: menu.store.edit.pasteLook() }
    MenuSeparator { visible: !menu.blank; height: visible ? implicitHeight : 0 }
    UMenuItem { objectName: "layerMenu:delete"; visible: !menu.blank; height: visible ? implicitHeight : 0; text: "Delete…"; keys: "Del"
                enabled: menu.editable; tip: menu.lockTip; onTriggered: menu.store.deleteLayer() } // no flag (D330)
}
