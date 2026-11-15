// SPDX-License-Identifier: GPL-3.0-or-later
// A small checkable button with its word on it (CUE, Mute, track names): the state is the fill, not only a shade of
// colour, so it reads at a glance (UI feel feedback: toggles with visible text).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Button {
    id: t
    checkable: true
    property string onToken: "accent"
    property string tip: ""
    implicitHeight: 30
    leftPadding: Theme.sp.m
    rightPadding: Theme.sp.m
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    font.family: Theme.family
    font.pixelSize: Theme.ty.small
    font.weight: Font.DemiBold
    Accessible.name: text
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500
    contentItem: Text {
        text: t.text
        font: t.font
        color: t.checked ? Theme.c.onAccent : t.enabled ? Theme.c.text : Theme.c.disabled
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    background: Rectangle {
        radius: Theme.radiusSmall
        readonly property color base: t.checked ? Theme.c[t.onToken] : Theme.c.field
        readonly property color ink: t.checked ? Theme.c.onAccent : Theme.c.text
        color: t.down ? Qt.tint(base, Qt.rgba(ink.r, ink.g, ink.b, Theme.st.pressed))
             : t.hovered ? Qt.tint(base, Qt.rgba(ink.r, ink.g, ink.b, Theme.st.hover)) : base
        border.width: t.checked ? 0 : 1
        border.color: t.hovered ? Theme.c.muted : Theme.c.border
        opacity: t.enabled ? 1 : Theme.st.disabled
        Behavior on color { enabled: Theme.motion; ColorAnimation { duration: Theme.mo.fast } }
        UFocusRing { active: t.visualFocus; radius: Theme.radiusSmall }
    }
}
