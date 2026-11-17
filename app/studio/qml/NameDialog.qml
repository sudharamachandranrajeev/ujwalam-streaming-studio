// SPDX-License-Identifier: GPL-3.0-or-later
// Rename a layer or a scene (the widget asks with a one-line input box in layerRename and sceneRename): one name box,
// filled with the current name. Enter or Rename sends it; an empty or unchanged name does nothing. Its own window
// (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "renameBox"
    required property var store
    property string kind: "layer"
    property string target: ""
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    implicitWidth: 440
    title: kind === "scene" ? "Rename scene" : "Rename layer"
    closePolicy: Popup.CloseOnEscape

    function ask(k, id, current) {
        kind = k;
        target = id;
        name.text = current;
        open();
        name.forceActiveFocus();
        name.selectAll();
    }
    function send() {
        const n = name.text.trim();
        const k = kind, id = target;
        close();
        if (k === "scene") store.edit.renameScene(id, n);
        else store.edit.renameLayer(id, n);
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: Theme.sp.l
        bottomPadding: Theme.sp.s
        color: Theme.c.text
        font.family: Theme.ty.displayFamily
        font.pixelSize: Theme.ty.subtitle
        font.weight: Font.DemiBold
    }
    contentItem: Column {
        spacing: Theme.sp.s
        Text {
            text: dlg.kind === "scene" ? "Scene name" : "Layer name"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.body
        }
        UField {
            id: name
            objectName: "renameName"
            width: parent.width
            label: dlg.kind === "scene" ? "Scene name" : "Layer name"
            maximumLength: 80
            onAccepted: dlg.send()
        }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.m
            UButton {
                objectName: "renameCancel"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "renameOk"
                text: "Rename"
                kind: "primary"
                enabled: name.text.trim() !== ""
                onClicked: dlg.send()
            }
        }
    }
}
