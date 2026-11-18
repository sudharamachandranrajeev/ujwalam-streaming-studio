// SPDX-License-Identifier: GPL-3.0-or-later
// Add scene (the widget's AddSceneDialog): a name; the scene is made on every canvas of the project. The window only
// builds the scene.add body; Store.structureEdit sends it. Its own window (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "addSceneBox"
    required property var store
    property var canvases: []
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    implicitWidth: 440
    title: "Add scene"
    closePolicy: Popup.CloseOnEscape

    function ask(list) {
        canvases = Array.isArray(list) ? list : [];
        name.text = "";
        store.addOpen = true;
        open();
        name.forceActiveFocus();
    }
    onClosed: store.addOpen = false
    signal scenarioRequested()
    // "From a scenario...": this window closes and the scenario window (ScenarioWindow.qml) opens
    function openScenarios() { close(); scenarioRequested() }

    function send() {
        const n = name.text.trim();
        if (n === "") return;
        close();
        store.structureEdit({ op: "scene.add", name: n.slice(0, 80) });
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
            text: "Scene name"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.body
        }
        UField {
            id: name
            objectName: "addSceneName"
            width: parent.width
            label: "Scene name"
            maximumLength: 80
            placeholderText: "For example: Starting soon"
            onAccepted: dlg.send()
        }
        Text {
            objectName: "addSceneWhere"
            width: parent.width
            wrapMode: Text.Wrap
            text: "The scene is made on every canvas of the project: " +
                  (dlg.canvases.length ? dlg.canvases.map(c => String(c).toUpperCase()).join(" + ") : "H") + "."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }
    footer: Item {
        implicitHeight: 64
        UButton {
            anchors { left: parent.left; leftMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            objectName: "addSceneScenario"
            text: "From a scenario…"
            tip: "Gameplay, lobby, screen share, starting soon, BRB or ending: a ready layout for H and V."
            onClicked: dlg.openScenarios()
        }
        Row {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.m
            UButton {
                objectName: "addSceneCancel"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "addSceneOk"
                text: "Add scene"
                kind: "primary"
                enabled: name.text.trim() !== ""
                onClicked: dlg.send()
            }
        }
    }
}
