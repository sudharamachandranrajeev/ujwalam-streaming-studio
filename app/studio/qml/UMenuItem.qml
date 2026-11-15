// SPDX-License-Identifier: GPL-3.0-or-later
// One row of a context menu in theme tokens: the words on the left, its key on the right, a tip when it is greyed.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

MenuItem {
    id: it
    property string keys: ""
    property string tip: ""
    implicitWidth: 240
    implicitHeight: 34
    leftPadding: Theme.sp.m
    rightPadding: Theme.sp.m
    hoverEnabled: true
    font.family: Theme.family
    font.pixelSize: Theme.ty.body
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 300
    contentItem: Item {
        Text {
            anchors { left: parent.left; verticalCenter: parent.verticalCenter }
            text: it.text
            font: it.font
            color: it.enabled ? Theme.c.text : Theme.c.disabled
        }
        Text {
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            text: it.keys
            font.family: Theme.family
            font.pixelSize: Theme.ty.caption
            color: Theme.c.muted
        }
    }
    background: Rectangle {
        radius: Theme.radiusSmall
        color: it.highlighted && it.enabled ? Theme.c.field : "transparent"
    }
}
