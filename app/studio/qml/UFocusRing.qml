// SPDX-License-Identifier: GPL-3.0-or-later
// The keyboard focus ring of the design system (D389): a clear outline just outside its parent (Theme.ring: width, offset, and
// the strength of the soft halo behind it), in the accentHi colour, which the contrast check pairs with every surface at 3:1
// or better. Put it inside a control's background (or any item) and bind `active` to visualFocus; it draws nothing otherwise.
// No animation: a ring that fades in is a ring that is late for a keyboard user.
//
//   UFocusRing { active: control.visualFocus; radius: Theme.radiusMedium }
import QtQuick
import Ujwalam.Core

Item {
    id: ring
    property bool active: false
    property bool layoutIgnore: true // meant to reach past its parent (the layout probe skips it)
    property real radius: Theme.radiusMedium
    readonly property real gap: Theme.ring.offset
    readonly property real w: Theme.ring.width
    visible: active
    anchors.fill: parent
    // The halo: a wider, faint band behind the ring.
    Rectangle {
        anchors.fill: parent
        anchors.margins: -(ring.gap + ring.w + 2)
        radius: ring.radius + ring.gap + ring.w + 2
        color: "transparent"
        border.width: 3
        border.color: Qt.rgba(Theme.c.accentHi.r, Theme.c.accentHi.g, Theme.c.accentHi.b, Theme.ring.alpha * 0.35)
    }
    Rectangle {
        anchors.fill: parent
        anchors.margins: -(ring.gap + ring.w)
        radius: ring.radius + ring.gap + ring.w
        color: "transparent"
        border.width: ring.w
        border.color: Theme.c.accentHi
    }
}
