// SPDX-License-Identifier: GPL-3.0-or-later
// RL5 (D445): New look from a reference. The user picks a screenshot or a short video of a look they like and gives it
// a name; Make look measures its colour and saves a realism look of their own (POST ui/api/looks, op from-reference).
// Opened from the scene menu (Make realism scene > New look from a reference…) and from Settings > Clips > Realism
// look. One click makes the look; nothing from the file is copied, kept or posted. Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "lookRefBox"
    required property var store
    property bool busy: false
    property string said: ""        // what the last Make look said (saved or why not)
    property bool failed: false
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    implicitWidth: 560
    title: "New look from a reference"
    closePolicy: Popup.CloseOnEscape

    function show() {
        said = "";
        failed = false;
        open();
        file.forceActiveFocus();
    }
    function make() {
        const p = file.text.trim();
        if (p === "" || busy) return false;
        busy = true;
        said = "Measuring the colour…";
        failed = false;
        store.makeLookFromReference(p, name.text.trim(), (ok, b, err) => {
            busy = false;
            failed = !ok;
            said = ok ? "Saved as \u201c" + b.look.name + "\u201d. Its colour comes from your file; glow, grain, vignette and detail start from " + ((b.basedOn || {}).name || "the nearest built-in look") + ". It is in Make realism scene and in Settings > Clips > Realism look."
                        : "Not made: " + ((b && b.detail) || err);
            if (ok) name.text = "";
        });
        return true;
    }
    function probe() { return { open: dlg.opened, busy: busy, result: said, failed: failed, file: file.text, name: name.text } }

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
            objectName: "lookRefHint"
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
            text: "Pick a screenshot or a short video of a look you like (another game, a film, a screenshot of a game filter). Ujwalam measures its colour: the colour cast, brightness and contrast, kept gentle so faces and the game's on-screen info stay readable. Glow, grain, vignette and detail start from the built-in look whose colour is nearest. Nothing from your file is copied, kept or posted; only the measured numbers are saved."
        }
        Text { text: "Picture or video"; color: Theme.c.text; font.family: Theme.family; font.pixelSize: Theme.ty.body }
        Row {
            width: parent.width
            spacing: Theme.sp.s
            UField {
                id: file
                objectName: "lookRefFile"
                width: parent.width - browse.width - parent.spacing
                label: "Picture or video file"
                placeholderText: "Full path, like D:\\Pictures\\snow map.png"
                maximumLength: 1024
            }
            UButton {
                id: browse
                objectName: "lookRefBrowse"
                text: "Browse…"
                onClicked: { if (picker.item) picker.item.open(); else picker.active = true }
            }
        }
        Loader {
            id: picker
            active: false
            source: "LookFilePicker.qml"
            onLoaded: item.open()
            Connections {
                target: picker.item
                function onChosen(f) { file.text = f }
            }
        }
        Text { text: "Name of the look"; color: Theme.c.text; font.family: Theme.family; font.pixelSize: Theme.ty.body }
        UField {
            id: name
            objectName: "lookRefName"
            width: parent.width
            label: "Name of the look"
            placeholderText: "My look"
            maximumLength: 24
            onAccepted: dlg.make()
        }
        Text {
            objectName: "lookRefResult"
            visible: dlg.said !== ""
            width: parent.width
            wrapMode: Text.WordWrap
            color: dlg.failed ? Theme.c.danger : Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
            text: dlg.said
        }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.m
            UButton {
                objectName: "lookRefClose"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "lookRefMake"
                text: dlg.busy ? "Making…" : "Make look"
                kind: "primary"
                enabled: !dlg.busy && file.text.trim() !== ""
                onClicked: dlg.make()
            }
        }
    }
}
