// SPDX-License-Identifier: GPL-3.0-or-later
// A radio button in theme tokens (Molten Stone, 2026-11-27; every theme): a round dark knob; the chosen one has an accent
// ring with a small check inside. Same 24 px row height in every theme. A click acts at once (D332).
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

RadioButton {
    id: r
    property string tip: ""
    implicitHeight: 24
    spacing: Theme.sp.s
    padding: 0
    hoverEnabled: true
    font.family: Theme.family
    font.pixelSize: Theme.ty.body
    Accessible.name: text
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500

    indicator: Rectangle {
        implicitWidth: 18
        implicitHeight: 18
        x: r.leftPadding
        y: (r.height - height) / 2
        radius: 9
        opacity: r.enabled ? 1 : Theme.st.disabled
        gradient: Gradient { // a round knob: lit from above
            GradientStop { position: 0; color: Qt.lighter(Theme.c.panel, 1.35) }
            GradientStop { position: 1; color: Qt.darker(Theme.c.field, 1.15) }
        }
        border.width: r.checked ? 2 : 1
        border.color: r.checked ? Theme.c.accent : r.hovered ? Theme.c.muted : Theme.c.border
        Canvas {
            id: tick
            anchors.fill: parent
            visible: r.checked
            onPaint: {
                const g = getContext("2d");
                g.reset();
                g.strokeStyle = String(Theme.c.accentHi);
                g.lineWidth = 1.8;
                g.lineCap = "round";
                g.lineJoin = "round";
                g.beginPath(); g.moveTo(5.5, 9.5); g.lineTo(8, 12); g.lineTo(12.5, 6.5); g.stroke();
            }
            Connections { target: Theme; function onChanged() { tick.requestPaint() } }
            onVisibleChanged: requestPaint()
        }
        UFocusRing { active: r.visualFocus; radius: 9 }
    }
    contentItem: Text {
        leftPadding: r.indicator.width + r.spacing
        text: r.text
        font: r.font
        color: r.enabled ? Theme.c.text : Theme.c.disabled
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
}
