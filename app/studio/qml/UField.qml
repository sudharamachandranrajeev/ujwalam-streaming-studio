// SPDX-License-Identifier: GPL-3.0-or-later
// A one-line text field in theme tokens (plan: Style). label is the accessible name when no placeholder says it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

TextField {
    id: f
    property string label: ""
    implicitHeight: 36
    leftPadding: Theme.sp.m
    rightPadding: Theme.sp.m
    color: Theme.c.text
    placeholderTextColor: Theme.c.muted
    selectionColor: Theme.c.accent
    selectedTextColor: Theme.c.onAccent
    font.family: Theme.family
    font.pixelSize: Theme.ty.body
    selectByMouse: true
    Accessible.name: label !== "" ? label : placeholderText
    background: Rectangle {
        radius: Theme.radiusSmall
        color: Theme.c.field
        border.width: f.activeFocus ? 2 : 1
        border.color: f.activeFocus ? Theme.c.accentHi : f.hovered ? Theme.c.muted : Theme.c.border
        opacity: f.enabled ? 1 : Theme.st.disabled
        Behavior on border.color { enabled: Theme.motion; ColorAnimation { duration: Theme.mo.fast } }
    }
}
