// SPDX-License-Identifier: GPL-3.0-or-later
// One surface per panel (plan: Style): the panel colour, one border, a heading row with optional tools on the right.
// Anchors only (no layout), so the frame is placed even in a window that is never shown (hidden test mode).
import QtQuick
import Ujwalam.Core

Rectangle {
    id: p
    property string title: ""
    default property alias content: body.data
    property alias tools: toolRow.data
    color: Theme.c.panel
    radius: Theme.radiusLarge
    border.width: 1
    border.color: Theme.c.border
    // A panel rests on the window at elevation 1 (nothing in "plain").
    ShadowLayers { level: 1; radius: p.radius }

    Item {
        id: head
        anchors { left: parent.left; right: parent.right; top: parent.top; leftMargin: Theme.sp.l; rightMargin: Theme.sp.m; topMargin: Theme.sp.s }
        height: p.title !== "" ? 32 : 0
        visible: p.title !== ""
        Text {
            anchors { left: parent.left; right: toolRow.left; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
            elide: Text.ElideRight
            text: p.title
            color: Theme.c.text
            font.family: Theme.ty.displayFamily
            font.pixelSize: Theme.ty.subtitle
            font.weight: Font.DemiBold
        }
        Row {
            id: toolRow
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.xs
        }
    }
    Item {
        id: body
        anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: parent.bottom; margins: Theme.sp.m; topMargin: p.title !== "" ? Theme.sp.xs : Theme.sp.m }
    }
}
