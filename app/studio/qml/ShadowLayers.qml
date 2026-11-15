// SPDX-License-Identifier: GPL-3.0-or-later
// Design after RareUI (MIT, Swapnil Kalambe). Rebuilt natively; not the original code.
// A soft shadow made of stacked translucent rounded rectangles (no MultiEffect, no ShaderEffect, nothing per frame): the
// look of a large soft drop shadow (RareUI's shadow-xl) for a card or a toast. Place it as the first child of the item
// that casts the shadow, or give it `target`. Static: the rectangles are made once and only change with size or colour.
// Not used by a screen yet.
//
//   ShadowLayers { target: card; blur: 24; offsetY: 10; opacity: 0.35 }
import QtQuick
import Ujwalam.Core

Item {
    id: shadow
    // The item to shadow (its size and position), or leave empty and size this item yourself.
    property Item target: null
    property real blur: 24          // how far the shadow spreads past the edge, px
    property real offsetX: 0
    property real offsetY: 10
    property real radius: Theme.radiusMedium
    property color color: "#000000" // a shadow is black in every theme; the strength is `strength`
    property real strength: 0.35    // alpha of the whole stack, 0 to 1
    property int steps: 8           // rectangles in the stack: more is smoother (4 to 16)

    x: (target ? target.x : 0) + offsetX
    y: (target ? target.y : 0) + offsetY
    width: target ? target.width : parent ? parent.width : 0
    height: target ? target.height : parent ? parent.height : 0
    z: target ? target.z - 1 : -1
    // Static and cheap, so it also draws in Theme.fx "plain"; it is off only when strength or blur is 0.
    visible: strength > 0 && blur > 0

    Repeater {
        model: Math.max(2, Math.min(16, shadow.steps))
        delegate: Rectangle {
            required property int index
            // Outer rectangles are larger and fainter; the alphas add up to about `strength` where they overlap.
            readonly property real f: (index + 1) / Math.max(2, Math.min(16, shadow.steps)) // 1/n .. 1
            readonly property real grow: shadow.blur * (1 - f)
            x: -grow
            y: -grow
            width: shadow.width + grow * 2
            height: shadow.height + grow * 2
            radius: shadow.radius + grow
            color: Qt.rgba(shadow.color.r, shadow.color.g, shadow.color.b,
                           shadow.strength * 2 / (Math.max(2, Math.min(16, shadow.steps)) + 1))
        }
    }
}
