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
    property real hold: 0  // 0..1, the peak-hold marker in the groove (B8, 2026-11-18); 0 = none
    property real mark: -1 // 0..1, a fixed tick in the groove (the mixer's 0 dB); < 0 = none
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
        color: trackTex.on ? "transparent" : Theme.c.field
        border.width: trackTex.on ? 0 : 1
        border.color: Theme.c.border
        opacity: s.enabled ? 1 : Theme.st.disabled
        UTexture { id: trackTex; surface: "track" } // Molten Stone (2026-11-27): a cracked stone groove
        Item { // the molten fill (Molten Stone), from the left to the handle; the flat fill below elsewhere
            visible: s.meter <= 0 && fillTex.on
            width: s.visualPosition * (parent.width - 16) + 8
            height: parent.height
            UTexture { id: fillTex; surface: s.meter <= 0 ? "fill" : "" }
        }
        Rectangle { // the filled part: from the left to the handle
            visible: s.meter <= 0 && !fillTex.on
            width: s.visualPosition * (parent.width - 16) + 8
            height: parent.height
            radius: 3
            color: Theme.c.accent
        }
        Rectangle { // level
            width: Math.max(0, Math.min(1, s.meter)) * parent.width
            height: parent.height
            radius: 3
            color: s.mark >= 0 ? (s.meter >= s.mark ? Theme.c.danger : Theme.c.ok) : (s.meter > 0.95 ? Theme.c.danger : Theme.c.ok)
            opacity: 0.85
        }
        Rectangle { // peak hold: where the level reached in the last moment
            objectName: s.objectName !== "" ? s.objectName + ":hold" : ""
            visible: s.hold > 0
            x: Math.max(0, Math.min(1, s.hold) * parent.width - width)
            width: 2
            height: parent.height
            color: s.mark >= 0 && s.hold >= s.mark ? Theme.c.danger : Theme.c.text
        }
        Rectangle { // the fixed tick (0 dB): above it the sound is made louder than it comes in
            objectName: s.objectName !== "" ? s.objectName + ":mark" : ""
            visible: s.mark >= 0
            x: s.mark * parent.width - width / 2 // the level's scale: a level at the tick is 0 dBFS
            y: -3
            width: 2
            height: parent.height + 6
            color: Theme.c.muted
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
