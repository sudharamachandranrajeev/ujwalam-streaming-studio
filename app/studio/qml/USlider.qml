// SPDX-License-Identifier: GPL-3.0-or-later
// A themed slider. committed(value) fires once the user is done (released, or 300 ms after the last key), as the
// widget studio's ValueSlider (D330): a drag sends one change, not one per pixel.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Slider {
    id: s
    signal committed(real value)
    property real meter: 0 // 0..1, drawn in the groove (the channel's level)
    implicitHeight: 28
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    wheelEnabled: activeFocus // the wheel only with focus (D330): scrolling the page never moves a slider
    onPressedChanged: if (!pressed) s.committed(s.value)
    onMoved: if (!pressed) keyTimer.restart()
    Timer { id: keyTimer; interval: 300; onTriggered: s.committed(s.value) }
    background: Rectangle {
        x: s.leftPadding
        y: s.topPadding + s.availableHeight / 2 - height / 2
        width: s.availableWidth
        height: 6
        radius: 3
        color: Theme.c.field
        border.width: 1
        border.color: Theme.c.border
        opacity: s.enabled ? 1 : Theme.st.disabled
        Rectangle { // the filled part: from the left to the handle
            visible: s.meter <= 0
            width: s.visualPosition * (parent.width - 16) + 8
            height: parent.height
            radius: 3
            color: Theme.c.accent
        }
        Rectangle { // level
            width: Math.max(0, Math.min(1, s.meter)) * parent.width
            height: parent.height
            radius: 3
            color: s.meter > 0.95 ? Theme.c.danger : Theme.c.ok
            opacity: 0.85
        }
    }
    handle: Item {
        x: s.leftPadding + s.visualPosition * (s.availableWidth - width)
        y: s.topPadding + s.availableHeight / 2 - height / 2
        width: 18
        height: 18
        opacity: s.enabled ? 1 : Theme.st.disabled
        ShadowLayers { level: s.pressed ? 1 : 2; radius: 9 }
        Rectangle {
            anchors.fill: parent
            radius: 9
            color: s.pressed ? Theme.c.accentHi : Theme.c.accent
            border.width: 2
            border.color: Theme.c.panel
            scale: s.pressed && Theme.motion ? 0.92 : 1
            Behavior on scale { enabled: Theme.motion; NumberAnimation { duration: Theme.mo.fast; easing.type: Easing.OutCubic } }
        }
        UFocusRing { active: s.visualFocus; radius: 9 }
    }
}
