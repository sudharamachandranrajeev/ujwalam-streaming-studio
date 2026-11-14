// SPDX-License-Identifier: GPL-3.0-or-later
// The task button in the on-air bar (the widget's TaskChip): a slowly pulsing dot while something runs, "2 tasks
// running" (or a quiet "Tasks" when only finished ones are listed), a red dot and edge when a task may be stuck. Hidden
// while no task is listed. A click opens or closes the task panel (TaskCenter.qml).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: chip
    required property var center
    readonly property bool active: center.running + center.waiting > 0
    readonly property string text: center.chipText
    visible: center.listed > 0
    implicitWidth: label.implicitWidth + 36
    implicitHeight: 26
    radius: height / 2
    color: hov.hovered ? Theme.c.border : Theme.c.field
    border.width: 1
    border.color: center.stalled > 0 ? Theme.c.danger : active ? Theme.c.accent : Theme.c.border
    Accessible.role: Accessible.Button
    Accessible.name: text

    Rectangle {
        id: dot
        x: 10
        anchors.verticalCenter: parent.verticalCenter
        width: 8
        height: 8
        radius: 4
        color: chip.center.stalled > 0 ? Theme.c.danger : chip.active ? Theme.c.accentHi : Theme.c.muted
        SequentialAnimation on opacity { // a slow breath while something runs
            running: chip.active && chip.visible && Theme.motion
            loops: Animation.Infinite
            NumberAnimation { from: 1; to: 0.35; duration: 800; easing.type: Easing.InOutSine }
            NumberAnimation { from: 0.35; to: 1; duration: 800; easing.type: Easing.InOutSine }
            onStopped: dot.opacity = 1
        }
    }
    Text {
        id: label
        x: 24
        anchors.verticalCenter: parent.verticalCenter
        text: chip.text
        color: chip.active ? Theme.c.text : Theme.c.muted
        font.family: "Barlow"
        font.pixelSize: 13
        font.weight: chip.active ? Font.DemiBold : Font.Medium
    }
    HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: chip.center.toggle() }
    ToolTip.visible: hov.hovered
    ToolTip.text: center.chipTip !== "" ? center.chipTip : "Show the task list"
    ToolTip.delay: 500
}
