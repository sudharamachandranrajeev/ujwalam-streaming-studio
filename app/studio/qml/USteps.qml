// SPDX-License-Identifier: GPL-3.0-or-later
// A step process (Molten Stone, 2026-11-27; every theme): spheres joined by links, the current step larger and lit in the
// accent, a caption "STEP 3: VERIFICATION" in the accent, and optionally a tip bubble with a drop pointer above the current
// step (with a smoke wisp in Molten Stone). Its height is fixed by `tip` being set or not, never by the step, so nothing
// moves when the step changes. Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: st
    property var steps: []     // labels
    property int current: 0
    property string tip: ""    // the bubble above the current step ("" = no bubble and no room kept for it)
    readonly property real bubbleH: tip !== "" ? 34 : 0
    implicitHeight: bubbleH + 28 + 20
    implicitWidth: Math.max(240, steps.length * 56)

    readonly property real gapW: steps.length > 1 ? (width - 24) / (steps.length - 1) : 0
    function cx(i) { return 12 + i * gapW }

    Repeater { // the links: cracked stone in Molten Stone (the track picture), a line elsewhere
        model: Math.max(0, st.steps.length - 1)
        Item {
            required property int index
            x: st.cx(index) + 8
            y: st.bubbleH + 14 - 3
            width: st.gapW - 16
            height: 6
            Rectangle { anchors.fill: parent; radius: 3; visible: !link.on; color: index < st.current ? Theme.c.accent : Theme.c.border }
            UTexture { id: link; surface: index < st.current ? "fill" : "track" }
        }
    }
    Repeater {
        model: st.steps
        Item {
            id: s
            required property string modelData
            required property int index
            readonly property bool cur: index === st.current
            readonly property real d: cur ? 20 : 14
            objectName: "step:" + index
            x: st.cx(index) - d / 2
            y: st.bubbleH + 14 - d / 2
            width: d
            height: d
            Rectangle { // the glow ring of the current step, inside the room the links leave
                visible: s.cur && Theme.fx !== "plain"
                anchors.centerIn: parent
                width: s.d + 8; height: width; radius: width / 2
                color: Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 0.22)
            }
            Rectangle { // a glossy sphere
                anchors.fill: parent
                radius: width / 2
                gradient: Gradient {
                    GradientStop { position: 0; color: s.cur ? Theme.c.accentHi : s.index < st.current ? Qt.lighter(Theme.c.accent, 1.1) : Qt.lighter(Theme.c.panel, 1.6) }
                    GradientStop { position: 1; color: s.cur || s.index < st.current ? Qt.darker(Theme.c.accent, 1.35) : Qt.darker(Theme.c.panel, 1.1) }
                }
                border.width: 1
                border.color: s.cur ? Theme.c.accentHi : Theme.c.border
            }
        }
    }
    Text { // the caption under the spheres
        objectName: "stepCaption"
        y: st.bubbleH + 30
        width: parent.width
        horizontalAlignment: Text.AlignHCenter
        text: st.steps.length ? "Step " + (st.current + 1) + ": " + st.steps[Math.max(0, Math.min(st.current, st.steps.length - 1))] : ""
        color: Theme.c.accentHi
        font.family: Theme.family
        font.pixelSize: Theme.ty.caption
        font.weight: Font.Bold
        font.capitalization: Font.AllUppercase
        font.letterSpacing: 1
    }
    Item { // the tip bubble with its drop pointer, and a smoke wisp above it
        visible: st.tip !== ""
        readonly property real bw: Math.min(st.width, bubbleText.implicitWidth + 20)
        x: Math.max(0, Math.min(st.width - bw, st.cx(st.current) - bw / 2))
        y: 0
        width: bw
        height: 26
        UAmbient { kind: "smoke"; width: 20; height: 30; x: parent.width - 18; y: -18; strength: 0.6 }
        Rectangle { anchors.fill: parent; radius: 13; color: Theme.c.field; border.width: 1; border.color: Theme.c.accent; visible: !bubbleTex.on }
        UTexture { id: bubbleTex; surface: "plate" }
        Text { id: bubbleText; anchors.centerIn: parent; text: st.tip; color: Theme.c.text; font.family: Theme.family; font.pixelSize: Theme.ty.caption }
        UTipDrop { x: st.cx(st.current) - parent.x - width / 2; y: parent.height - 1 }
    }
}
