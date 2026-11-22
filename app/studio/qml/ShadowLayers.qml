// SPDX-License-Identifier: GPL-3.0-or-later
// Design after RareUI (MIT, Swapnil Kalambe). Rebuilt natively; not the original code.
// Elevation as real layered soft shadows (D389): stacked translucent rounded rectangles, no MultiEffect, no ShaderEffect,
// nothing per frame (the rectangles are made once and only change with size or colour). The fall-off follows a bell curve
// (the shape of a blurred edge) and the alphas are worked out so the layers add up to that curve where they overlap, which
// removes the visible bands a linear stack has. Place it as the first child of the item that casts the shadow, or give it
// `target`.
//
//   ShadowLayers { level: 2 }                         // a theme elevation e2: a tight key shadow plus a wide ambient one
//   ShadowLayers { blur: 24; offsetY: 10; strength: 0.35 }   // one explicit shadow (level 0)
//
// `level` 1..4 reads Theme.elev (pack data, system.elevation): the key shadow (blur, offset down, alpha) and the ambient
// shadow (wider, fainter, no offset). Level 0 draws the single explicit shadow. In Theme.fx "plain" (on air or High
// performance) an elevation level draws nothing: a plain surface is a fill and a 1 px edge, nothing soft.
import QtQuick
import Ujwalam.Core

Item {
    id: shadow
    // The item to shadow (its size and position), or leave empty and size this item yourself.
    property Item target: null
    property int level: 0           // 0 = the explicit values below; 1..4 = the theme's elevation level
    property real blur: 24          // how far the shadow spreads past the edge, px
    property real offsetX: 0
    property real offsetY: 10
    property real radius: Theme.radiusMedium
    property color color: "#000000" // a shadow is black in every theme; the strength is `strength`
    property real strength: 0.35    // alpha of the whole stack at the item's edge, 0 to 1
    property int steps: 14          // rectangles per stack: more is smoother (4 to 24)
    // When true the level also draws in "plain" (never use it for decoration that moves).
    property bool plainToo: false
    // Decoration that is meant to reach past its parent: the layout probe skips it (D389).
    property bool layoutIgnore: true

    readonly property var lv: level > 0 ? Theme.elev["e" + Math.min(4, level)] : null
    readonly property real keyBlur: lv ? lv.keyBlur : blur
    readonly property real keyY: lv ? lv.keyY : offsetY
    readonly property real keyAlpha: lv ? lv.keyAlpha : strength
    readonly property real ambBlur: lv ? lv.ambBlur : 0
    readonly property real ambAlpha: lv ? lv.ambAlpha : 0

    x: (target ? target.x : 0) + (level > 0 ? 0 : offsetX)
    y: (target ? target.y : 0)
    width: target ? target.width : parent ? parent.width : 0
    height: target ? target.height : parent ? parent.height : 0
    z: target ? target.z - 1 : -1
    visible: (keyAlpha > 0 || ambAlpha > 0) && (level === 0 || plainToo || Theme.fx !== "plain")
    // D432 (freeze on Settings, 2026-11-22): the rectangles are made the first time this shadow is really on screen
    // (visible here and in every parent), then kept. Every button and switch has shadows, and a shadow is 14 to 28
    // rectangles: making them for the hidden Settings pages too blocked the window for seconds. Once made they stay, so
    // a hover or a press that hides and shows a shadow does not build it again.
    property bool made: false
    onVisibleChanged: if (visible) made = true
    Component.onCompleted: if (visible) made = true

    // One stack: n rectangles, outermost first, grown by up to `spread` past the edge, with alphas that compose to
    // a * exp(-(3 t)^2 / 2), t = distance / spread (t = 0 at the edge).
    component Stack: Item {
        id: st
        property real spread: 20
        property real a: 0.2
        property real dy: 0
        readonly property int n: Math.max(4, Math.min(24, shadow.steps))
        // Target alpha at the middle of ring i (ring 0 is the outermost).
        function ringAlpha(i) {
            const t = 1 - (i + 0.5) / n;      // 1 at the outside .. 0 at the edge
            return st.a * Math.exp(-0.5 * 9 * t * t) ;
        }
        // Layer alpha so that rings i..n-1 composed (over) give ringAlpha(i): 1 - (1 - A_i) / (1 - A_{i-1})
        function layerAlpha(i) {
            const cur = ringAlpha(i), prev = i === 0 ? 0 : ringAlpha(i - 1);
            return Math.max(0, Math.min(0.95, 1 - (1 - cur) / (1 - prev)));
        }
        y: dy
        width: parent.width
        height: parent.height
        Repeater {
            model: shadow.made && st.spread > 0 && st.a > 0 ? st.n : 0
            delegate: Rectangle {
                required property int index
                readonly property real grow: st.spread * (1 - index / st.n)
                x: -grow
                y: -grow
                width: st.width + grow * 2
                height: st.height + grow * 2
                radius: shadow.radius + grow
                color: Qt.rgba(shadow.color.r, shadow.color.g, shadow.color.b, st.layerAlpha(index))
            }
        }
    }

    Stack { spread: shadow.ambBlur; a: shadow.ambAlpha; dy: 0; visible: shadow.ambAlpha > 0 }
    Stack { spread: shadow.keyBlur; a: shadow.keyAlpha; dy: shadow.keyY }
}
