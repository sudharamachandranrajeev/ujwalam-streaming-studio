// SPDX-License-Identifier: GPL-3.0-or-later
// A one-line text field in theme tokens (plan: Style). label is the accessible name when no placeholder says it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

TextField {
    id: f
    property string label: ""
    property bool error: false // Molten Stone (2026-11-27): the torn red-rimmed plate; every theme: a danger edge
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
        color: fieldTex.on ? "transparent" : Theme.c.field
        border.width: fieldTex.on && !f.activeFocus ? 0 : f.activeFocus ? 2 : 1
        border.color: f.error ? Theme.c.danger : f.activeFocus ? Theme.c.accentHi : f.hovered ? Theme.c.muted : Theme.c.border
        UTexture { id: fieldTex; surface: f.error ? "fieldError" : "field" } // a recessed dark input with a rose-gold rim (2 px outset)
        opacity: f.enabled ? 1 : Theme.st.disabled
        Behavior on border.color { enabled: Theme.motion; ColorAnimation { duration: Theme.mo.fast } }
    }
}
