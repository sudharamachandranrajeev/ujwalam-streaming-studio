// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke or a molten drip (Molten Stone, 2026-11-27) from the pack's still pictures (Theme.art). It moves only while
// Theme.ambient names it (full fx, animations on, never on air: qml_bridge.cpp) and this item is visible in an active
// window; otherwise it is the still picture (the user's decision: on air the smoke and drips stand still), or nothing when
// the pack has no such picture (every other theme). The loop item exists only while it may move (a Loader), so on air,
// in calm and in High performance there is no loop at all. It never takes room or input: the caller places it inside a
// margin the layout already reserves. Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: a
    property string kind: "smoke" // smoke | drip
    property real strength: 1     // opacity of the picture
    readonly property string still: Theme.art[kind] !== undefined ? Theme.art[kind] : ""
    readonly property bool moving: Theme.ambient[kind] !== undefined && a.visible && Window.active
    enabled: false
    visible: still !== ""
    implicitWidth: kind === "drip" ? 12 : 48
    implicitHeight: kind === "drip" ? 28 : 72

    Image { // the still picture
        anchors.fill: parent
        visible: !a.moving
        source: a.visible ? a.still : ""
        opacity: a.strength * 0.8
        fillMode: Image.PreserveAspectFit
        smooth: true
    }
    Loader {
        anchors.fill: parent
        active: a.moving
        sourceComponent: Item {
            Image {
                id: img
                objectName: "moltenAmbient"
                property bool loop: true // read by the probe
                width: parent.width
                height: parent.height
                source: a.still
                fillMode: Image.PreserveAspectFit
                smooth: true
                // Smoke rises and fades; a drip stretches down and falls back. Slow, few frames of change: cheap.
                SequentialAnimation {
                    running: true
                    loops: Animation.Infinite
                    ParallelAnimation {
                        NumberAnimation { target: img; property: "y"; from: a.kind === "drip" ? -6 : 4; to: a.kind === "drip" ? 0 : -6; duration: 2600; easing.type: Easing.InOutSine }
                        NumberAnimation { target: img; property: "opacity"; from: a.strength * (a.kind === "drip" ? 0.55 : 0.25); to: a.strength * 0.85; duration: 1300; easing.type: Easing.OutQuad }
                    }
                    ParallelAnimation {
                        NumberAnimation { target: img; property: "y"; to: a.kind === "drip" ? -6 : 4; duration: 2600; easing.type: Easing.InOutSine }
                        NumberAnimation { target: img; property: "opacity"; to: a.strength * (a.kind === "drip" ? 0.55 : 0.25); duration: 2600; easing.type: Easing.InQuad }
                    }
                }
            }
        }
    }
}
