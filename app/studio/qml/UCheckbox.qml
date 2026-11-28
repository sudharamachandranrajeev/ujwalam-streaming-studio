// SPDX-License-Identifier: GPL-3.0-or-later
// A check box in theme tokens (Molten Stone, 2026-11-27; every theme): an empty dark square; checked, a sunken well with a
// big accent check mark. Same 24 px row height in every theme (no layout jump). A click acts at once (D332).
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

CheckBox {
    id: c
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

    indicator: Item {
        implicitWidth: 18
        implicitHeight: 18
        x: c.leftPadding
        y: (c.height - height) / 2
        opacity: c.enabled ? 1 : Theme.st.disabled
        Rectangle { // the square: dark when empty; a well (darker centre, a light lower lip) when checked
            anchors.fill: parent
            radius: Theme.radiusSmall
            color: c.checked ? Qt.darker(Theme.c.field, 1.25) : Theme.c.field
            border.width: 1
            border.color: c.checked ? Theme.c.accent : c.hovered ? Theme.c.muted : Theme.c.border
            Rectangle { // the lower lip of the well
                visible: c.checked
                anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: 2 }
                height: 1
                color: Qt.rgba(Theme.c.text.r, Theme.c.text.g, Theme.c.text.b, 0.18)
            }
        }
        Canvas { // the check mark, a little larger than the box like the reference; redrawn only on a change
            id: mark
            visible: c.checked
            x: -1; y: -3; width: 21; height: 21
            onPaint: {
                const g = getContext("2d");
                g.reset();
                g.strokeStyle = String(Theme.c.accent);
                g.lineWidth = 2.6;
                g.lineCap = "round";
                g.lineJoin = "round";
                g.beginPath(); g.moveTo(5, 11); g.lineTo(9, 15.5); g.lineTo(17, 4.5); g.stroke();
            }
            Connections { target: Theme; function onChanged() { mark.requestPaint() } }
            onVisibleChanged: requestPaint()
        }
        UFocusRing { active: c.visualFocus; radius: Theme.radiusSmall }
    }
    contentItem: Text {
        leftPadding: c.indicator.width + c.spacing
        text: c.text
        font: c.font
        color: c.enabled ? Theme.c.text : Theme.c.disabled
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
}
