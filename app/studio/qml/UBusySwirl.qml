// SPDX-License-Identifier: GPL-3.0-or-later
// The busy swirl (Molten Stone, 2026-11-27; every theme): a stone disc with a spiral that turns, and a small gear beside
// it, while `running`. In Molten Stone the painted spiral disc and gear; elsewhere an accent arc. It turns only while
// running, visible and animations are on (High performance and the system setting stop it: then a still disc). Like the
// task chip's spinner it is a status light, so it may turn on air. Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: sw
    property bool running: true
    property int size: 20
    objectName: "busySwirl"
    readonly property bool turning: running && visible && Theme.motion
    property bool loop: turning // read by the probe
    implicitWidth: size + (gear.visible ? 12 : 0)
    implicitHeight: size

    Item {
        id: disc
        width: sw.size
        height: sw.size
        Image {
            anchors.fill: parent
            visible: source !== ""
            source: Theme.art.spinner !== undefined ? Theme.art.spinner : ""
            sourceSize: Qt.size(sw.size, sw.size)
            smooth: true
        }
        Canvas {
            id: arc
            anchors.fill: parent
            visible: Theme.art.spinner === undefined
            onPaint: {
                const g = getContext("2d"), r = width / 2;
                g.reset();
                g.lineWidth = 2;
                g.strokeStyle = String(Theme.c.border);
                g.beginPath(); g.arc(r, r, r - 2, 0, Math.PI * 2); g.stroke();
                g.strokeStyle = String(Theme.c.accent);
                g.lineCap = "round";
                g.beginPath(); g.arc(r, r, r - 2, 0, Math.PI * 1.2); g.stroke();
            }
            Connections { target: Theme; function onChanged() { arc.requestPaint() } }
        }
        RotationAnimator on rotation {
            running: sw.turning
            loops: Animation.Infinite
            from: 0; to: 360
            duration: 1600
        }
    }
    Image {
        id: gear
        x: sw.size - 2
        y: sw.size - 12
        width: 12; height: 12
        visible: source !== ""
        source: Theme.art.gear !== undefined ? Theme.art.gear : ""
        RotationAnimator on rotation {
            running: sw.turning && gear.visible
            loops: Animation.Infinite
            from: 360; to: 0
            duration: 2400
        }
    }
}
