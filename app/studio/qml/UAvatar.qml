// SPDX-License-Identifier: GPL-3.0-or-later
// An account disc (Molten Stone, 2026-11-27; every theme): a round stone disc with a spiral in relief. Never a face, a
// name or a picture from the account (nothing private is drawn or committed). In Molten Stone the painted spiral disc;
// elsewhere a disc in the field colour with an accent spiral drawn once. `on` lights the rim (a connected account).
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: av
    property int size: 32
    property bool on: true
    implicitWidth: size
    implicitHeight: size
    opacity: on ? 1 : 0.55

    Image {
        anchors.fill: parent
        visible: source !== ""
        source: Theme.art.avatar !== undefined ? Theme.art.avatar : ""
        sourceSize: Qt.size(av.size, av.size)
        smooth: true
    }
    Canvas {
        id: sp
        anchors.fill: parent
        visible: Theme.art.avatar === undefined
        onPaint: {
            const g = getContext("2d"), r = width / 2;
            g.reset();
            g.fillStyle = String(Theme.c.field);
            g.beginPath(); g.arc(r, r, r - 1, 0, Math.PI * 2); g.fill();
            g.strokeStyle = String(Theme.c.border);
            g.lineWidth = 1; g.stroke();
            g.strokeStyle = String(Theme.c.accent);
            g.lineWidth = Math.max(1.2, width / 24);
            g.lineCap = "round";
            g.beginPath();
            for (let t = 0; t <= 4.2 * Math.PI; t += 0.15) {
                const rr = (r - 4) * t / (4.2 * Math.PI);
                const x = r + rr * Math.cos(t), y = r + rr * Math.sin(t);
                if (t === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
        }
        Connections { target: Theme; function onChanged() { sp.requestPaint() } }
        onVisibleChanged: requestPaint()
    }
    Rectangle { // the rim: accent when connected
        anchors.fill: parent
        radius: width / 2
        color: "transparent"
        border.width: 1
        border.color: av.on ? Theme.c.accent : Theme.c.border
    }
}
