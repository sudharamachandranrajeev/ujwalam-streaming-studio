// SPDX-License-Identifier: GPL-3.0-or-later
// Design after RareUI (MIT, Swapnil Kalambe), Loading Spinner: with the flag rareui-look on, a spinner (style ring, bars or
// dots from the pack's components.spinner) replaces the breathing dot while a task runs. It is a status light, so it runs
// at its normal rate on air too; it exists only while a task runs (a Loader), and not with the flag off.
// The task button in the on-air bar (the widget's TaskChip): a slowly pulsing dot while something runs, "2 tasks
// running" (or a quiet "Tasks" when only finished ones are listed), a red dot and edge when a task may be stuck. Hidden
// while no task is listed. A click opens or closes the task panel (TaskCenter.qml).
// GUI load (2026-11-25): the spinner and the breathing dot move in steps from one 8 Hz timer, not with animations that
// run every frame. A frame animation redrew the whole studio window at about 60 frames per second for as long as a task
// was listed, also a paused one waiting for days (measured: 1876 frames in 30 s against 164 with no task). They move
// only while a task really runs; a waiting or paused task shows a still dot.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: chip
    required property var center
    readonly property bool active: center.running + center.waiting > 0
    readonly property bool moving: center.running > 0 && visible // the spinner or the breath moves only while a task works
    property int step: 0 // 8 steps a second (stepper below)
    Timer {
        id: stepper
        objectName: "taskStepper"
        interval: 125
        repeat: true
        running: chip.moving && (spin.active || Theme.motion)
        onTriggered: chip.step = (chip.step + 1) % 576 // 72 s: whole rounds of the ring and bars (1 s), the dots (0.9 s) and the breath (1.6 s)
        onRunningChanged: if (!running) chip.step = 0
    }
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

    // The RareUI spinner (item 14): present only while a task runs and the flag is on; 1 s a turn, linear.
    Loader {
        id: spin
        x: 7
        anchors.verticalCenter: parent.verticalCenter
        width: 14
        height: 14
        active: Theme.rareui && chip.moving && chip.center.stalled === 0
        sourceComponent: Theme.spinnerStyle === "bars" ? barsC : Theme.spinnerStyle === "dots" ? dotsC : ringC
    }
    Component {
        id: ringC
        Canvas { // a track ring and an arc of about 49 degrees (plan: viewBox 18, r 7.25, stroke 2), repainted on a theme change
            id: ring
            objectName: "taskSpinner"
            property string style: "ring" // read by the probe
            property bool loop: true
            anchors.fill: parent
            onPaint: {
                const c = getContext("2d");
                c.reset();
                const k = width / 18, r = 7.25 * k, cx = 9 * k;
                c.lineWidth = 2 * k;
                c.lineCap = "round";
                c.strokeStyle = String(Theme.c.border);
                c.beginPath(); c.arc(cx, cx, r, 0, Math.PI * 2); c.stroke();
                c.strokeStyle = String(Theme.c.accentHi);
                c.beginPath(); c.arc(cx, cx, r, 0, 49 * Math.PI / 180); c.stroke();
            }
            Connections { target: Theme; function onChanged() { ring.requestPaint() } }
            rotation: (chip.step % 8) * 45 // a turn a second in 8 steps (the picture is only rotated, never painted again)
        }
    }
    Component {
        id: barsC
        Item { // eight bars that fade round (Sonner's bars), one step every 125 ms
            id: bars
            objectName: "taskSpinner"
            property string style: "bars"
            property bool loop: true
            readonly property real phase: chip.step % 8 // one bar a step, a round a second (as before)
            Repeater {
                model: 8
                Rectangle {
                    required property int index
                    x: 6.5
                    y: 0
                    width: 1.6
                    height: 4
                    radius: 0.8
                    color: Theme.c.accentHi
                    opacity: 0.15 + 0.85 * (1 - ((bars.phase - index) % 8 + 8) % 8 / 8)
                    transform: Rotation { origin.x: 0.8; origin.y: 7; angle: index * 45 }
                }
            }
        }
    }
    Component {
        id: dotsC
        Item { // three dots that rise and fall in turn
            id: dots
            objectName: "taskSpinner"
            property string style: "dots"
            property bool loop: true
            readonly property real phase: (chip.step * 0.125 / 0.9 * 3) % 3 // a round in 0.9 s, as before
            Repeater {
                model: 3
                Rectangle {
                    required property int index
                    width: 3.4
                    height: 3.4
                    radius: 1.7
                    x: 0.8 + index * 4.6
                    y: 5.3 - 2.5 * Math.max(0, 1 - Math.abs(((dots.phase - index + 4.5) % 3) - 1.5) * 1.4)
                    color: Theme.c.accentHi
                }
            }
        }
    }
    Rectangle {
        id: dot
        visible: !spin.active
        x: 10
        anchors.verticalCenter: parent.verticalCenter
        width: 8
        height: 8
        radius: 4
        color: chip.center.stalled > 0 ? Theme.c.danger : chip.active ? Theme.c.accentHi : Theme.c.muted
        // a slow breath while a task works (1.6 s from full to faint and back, in the stepper's steps)
        opacity: chip.moving && Theme.motion ? 0.675 + 0.325 * Math.cos(2 * Math.PI * (chip.step * 0.125) / 1.6) : 1
    }
    Text {
        id: label
        x: 24
        anchors.verticalCenter: parent.verticalCenter
        text: chip.text
        color: chip.active ? Theme.c.text : Theme.c.muted
        font.family: Theme.ty.displayFamily
        font.pixelSize: Theme.ty.small
        font.weight: chip.active ? Font.DemiBold : Font.Medium
    }
    HoverHandler { id: hov; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: chip.center.toggle() }
    ToolTip.visible: hov.hovered
    ToolTip.text: center.chipTip !== "" ? center.chipTip : "Show the task list"
    ToolTip.delay: 500
}
