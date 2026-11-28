// SPDX-License-Identifier: GPL-3.0-or-later
// A switch with its words beside it (the widget's Switch row, N2): the track says ON or OFF, so the state reads as words,
// not only as a colour (UI feel feedback). text is the label; hint (optional) is a muted line under it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Switch {
    id: s
    property string hint: ""
    // false: the words keep their own width (a switch inside a row, with no width given); true: they wrap to the width
    property bool wrap: true
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    spacing: Theme.sp.m
    padding: 0
    font.family: Theme.family
    font.pixelSize: Theme.ty.body
    Accessible.name: text
    indicator: Rectangle {
        x: s.leftPadding
        y: s.topPadding + 2
        implicitWidth: 54
        implicitHeight: 26
        radius: 13
        color: s.checked ? Theme.c.accent : Theme.c.field
        border.width: s.checked ? 0 : 1
        border.color: s.hovered ? Theme.c.muted : Theme.c.border
        opacity: s.enabled ? 1 : Theme.st.disabled
        Behavior on color { enabled: Theme.motion; ColorAnimation { duration: Theme.mo.normal } }
        UFocusRing { active: s.visualFocus; radius: 13 }
        Text {
            anchors { verticalCenter: parent.verticalCenter; left: s.checked ? parent.left : undefined; right: s.checked ? undefined : parent.right; leftMargin: 8; rightMargin: 7 }
            text: s.checked ? "ON" : "OFF"
            color: s.checked ? Theme.c.onAccent : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 10
            font.weight: Font.Bold
        }
        UAmbient { // Molten Stone (2026-11-27): smoke rising from the knob when on: 10 x 12 over the knob's top, starting at the
            // switch's own top edge (the track sits 2 px down), so it never reaches past the switch's box
            visible: s.checked && still !== ""
            kind: "smoke"
            width: 10; height: 12
            x: parent.width - 18
            y: -2
            strength: 0.7
        }
        Rectangle { // the knob, with a small key shadow of its own
            id: knob
            width: 20
            height: 20
            radius: 10
            y: 3
            x: s.checked ? parent.width - width - 3 : 3
            color: s.checked ? Theme.c.onAccent : Theme.c.muted
            ShadowLayers { level: 1; radius: 10 }
            Behavior on x { enabled: Theme.motion; NumberAnimation { duration: Theme.mo.normal; easing.type: Easing.OutCubic } }
        }
    }
    contentItem: Column {
        leftPadding: s.indicator.width + s.spacing
        spacing: 2
        Text {
            width: s.wrap ? Math.max(0, s.availableWidth - parent.leftPadding) : implicitWidth
            text: s.text
            wrapMode: Text.Wrap
            color: s.enabled ? Theme.c.text : Theme.c.disabled
            font: s.font
        }
        Text {
            visible: s.hint !== ""
            width: s.wrap ? Math.max(0, s.availableWidth - parent.leftPadding) : implicitWidth
            text: s.hint
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }
}
