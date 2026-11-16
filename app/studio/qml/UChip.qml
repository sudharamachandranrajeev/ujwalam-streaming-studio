// SPDX-License-Identifier: GPL-3.0-or-later
// A status chip: plain text on the field colour; "on" fills it (LIVE, recording) in the given token colour.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: c
    property string text: ""
    property bool on: false
    property string token: "danger"
    property string tip: ""
    property int minWidth: 0 // a chip whose words change (LIVE and its clock) keeps one width, so the bar never shifts
    implicitWidth: Math.max(minWidth, label.implicitWidth + Theme.sp.l * 1.25)
    implicitHeight: 28
    radius: height / 2
    color: on ? Theme.c[token] : Theme.c.field
    border.width: on ? 0 : 1
    border.color: Theme.c.border
    Accessible.role: Accessible.StaticText
    Accessible.name: text
    Text {
        id: label
        anchors.centerIn: parent
        text: c.text
        color: c.on ? Theme.c.onAccent : Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
        font.weight: c.on ? Font.Bold : Font.Medium
    }
    HoverHandler { id: hov }
    ToolTip.visible: c.tip !== "" && hov.hovered
    ToolTip.text: c.tip
    ToolTip.delay: 500
}
