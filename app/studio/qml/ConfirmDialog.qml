// SPDX-License-Identifier: GPL-3.0-or-later
// A held action (D332): the server holds one only when it cannot act on the click alone (the readiness check found
// problems: "Go live anyway", logged; or a rule or remote request waits for the user's click). Allow sends only the
// pending id; Cancel drops it. No phrase. Cancel is the default, so Enter never goes live past problems.
// Its own window (Popup.Window), so the native previews never cover it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "confirmBox"
    required property var store
    property var pending: ({})
    readonly property bool anyway: !!pending.readiness && pending.readiness.ok === false
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    implicitWidth: Math.min(560, parent ? parent.width - 80 : 560)
    title: anyway ? "Not started" : "Approve this action"
    closePolicy: Popup.CloseOnEscape

    function ask(p) { pending = p || {}; open(); cancelBtn.forceActiveFocus() }
    onRejected: store.answer(pending.pendingId, false)

    // Molten Stone (2026-11-27): a cracked stone slab (the modal picture, kept inside the dialog's own window) with smoke
    // rising from its top corners off air; the title in the accent caps. Other themes: the flat panel as before.
    background: Item {
        Rectangle {
            anchors.fill: parent
            visible: !slab.on
            color: Theme.c.panel
            radius: Theme.radiusLarge
            border.width: 1
            border.color: dlg.anyway ? Theme.c.danger : Theme.c.border
        }
        UTexture { id: slab; surface: "modal"; inset: true }
        Rectangle { // the problem state keeps its red edge on the slab
            visible: slab.on && dlg.anyway
            anchors { fill: parent; margins: 12 }
            radius: 14
            color: "transparent"
            border.width: 1.5
            border.color: Theme.c.danger
        }
        UAmbient { visible: slab.on && still !== ""; kind: "smoke"; x: 14; y: 6; width: 30; height: 44; strength: 0.7 }
        UAmbient { visible: slab.on && still !== ""; kind: "smoke"; x: parent.width - 44; y: 6; width: 30; height: 44; strength: 0.7 }
    }
    header: Text {
        text: dlg.title
        padding: Theme.sp.l
        bottomPadding: Theme.sp.s
        font.capitalization: slab.on ? Font.AllUppercase : Font.MixedCase
        color: slab.on ? Theme.c.accentHi : Theme.c.text
        font.family: Theme.ty.displayFamily
        font.pixelSize: Theme.ty.subtitle
        font.weight: Font.DemiBold
    }
    contentItem: Text {
        text: dlg.pending.summary || ""
        wrapMode: Text.Wrap
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.body
        lineHeight: 1.2
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.m
            UButton {
                id: cancelBtn
                objectName: "confirmCancel"
                text: "Cancel"
                onClicked: dlg.reject()
            }
            UButton {
                objectName: "confirmOk"
                text: dlg.anyway ? "Go live anyway" : "Allow"
                kind: dlg.anyway ? "danger" : "primary"
                onClicked: { dlg.close(); dlg.store.answer(dlg.pending.pendingId, true) }
            }
        }
    }
}
