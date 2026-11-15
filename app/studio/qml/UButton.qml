// SPDX-License-Identifier: GPL-3.0-or-later
// Design after RareUI (MIT, Swapnil Kalambe). Rebuilt natively; not the original code. Covers the button styles soft,
// neumorph, premium, pixel and glass (RareUI slice 1, D384).
// A labelled button in theme tokens (plan: Style). kind: "normal" | "primary" (accent fill) | "danger" (danger fill,
// for the controls that are on: LIVE, recording). An optional icon from the shared icon set (icons.cpp) sits before
// the label.
//
// RareUI looks: drawn only when the flag rareui-look is on, the pack names the style (components.button.style, which
// needs the flag theme-components) and Theme.fx is not "plain". Colours come from Theme tokens only. Theme.fx "full" adds
// the motion (spring, glow, sweep, slide); "calm" keeps the styled look still (a hover is a plain colour change); "plain"
// (on air, High performance) is the plain look, and a hover or press is a colour change under 100 ms. Everything that
// moves lives in a Loader, so in "plain" nothing of it exists. Not used: MultiEffect, ShaderEffect.
// Look limits: premium and pixel are drawn for normal and primary buttons only (a danger button keeps the plain look);
// pixel only for a normal button. Hover letter-spacing growth of the soft look is left out (it would move the layout).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Button {
    id: b
    property string kind: "normal"
    property string iconName: ""
    property string tip: ""
    // The style drawn now ("" = the plain look).
    readonly property string look: {
        if (!Theme.rareui || Theme.fx === "plain") return "";
        const s = Theme.buttonStyle;
        if (s === "soft" || s === "neumorph" || s === "glass") return s;
        if (s === "premium") return kind === "danger" ? "" : s;
        if (s === "pixel") return kind === "normal" ? s : "";
        return "";
    }
    // Motion allowed: Theme.fx "full" and the animations switch (High performance and the system setting turn it off).
    readonly property bool full: Theme.fx === "full" && Theme.motion
    readonly property real rad: look === "" ? Theme.radiusMedium : look === "pixel" ? 8 : height / 2
    readonly property color fill: kind === "primary" ? Theme.c.accent : kind === "danger" ? Theme.c.danger : Theme.c.field
    // Soft and pixel turn to the accent (or the danger colour) under the pointer.
    readonly property color hotFill: kind === "danger" ? Theme.c.danger : Theme.c.accent
    readonly property bool lit: (look === "soft" || look === "pixel") && hovered && enabled
    readonly property color ink: (lit || look === "premium") ? Theme.c.onAccent : kind === "normal" ? Theme.c.text : Theme.c.onAccent
    // Where the pixel block and arrow are (0 rest, 1 hover); the premium gradient slide (0 rest, 2/3 hover).
    readonly property real px: full && look === "pixel" ? pixelSpring.value : 0
    readonly property real slide: full && look === "premium" && hovered ? 2 / 3 : 0
    readonly property real blockRest: Math.max(16, height - 6)
    // Colour changes under the pointer: the studio's fast time, and under 100 ms once the RareUI flag is on.
    readonly property int colorMs: Theme.rareui ? Math.min(Theme.fast, 90) : Theme.fast

    implicitHeight: 34
    leftPadding: look === "pixel" ? 14 + blockRest : 14
    rightPadding: 14
    font.family: look === "pixel" ? "Barlow" : Theme.family // bundled OFL only (D384 Q7)
    font.pixelSize: 14
    font.weight: kind === "normal" ? Font.Normal : Font.DemiBold
    font.letterSpacing: look === "soft" || look === "glass" ? 0.5 : 0
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    ToolTip.visible: tip !== "" && hovered
    ToolTip.text: tip
    ToolTip.delay: 500
    // Hover grows the soft and glass looks, a press sinks them (the plan's 1.05 / 0.98 / 0.95 / 0.975); only in "full".
    scale: !full ? 1 : look === "glass" ? (down ? 0.95 : hovered ? 1.05 : 1)
         : look === "soft" ? (down ? 0.98 : hovered ? 1.05 : 1)
         : look === "neumorph" ? (down ? 0.975 : 1)
         : look === "pixel" ? (down ? 0.98 : 1) : 1
    Behavior on scale { enabled: b.full; NumberAnimation { duration: 160; easing.type: Easing.OutQuad } }

    USpring { // the pixel block and arrow (plan: stiffness 400, damping 30)
        id: pixelSpring
        to: b.look === "pixel" && b.hovered && b.enabled ? 1 : 0
        stiffness: 400
        damping: 30
    }
    USpring { // the pixel arrow turn (plan: stiffness 300, damping 20)
        id: arrowSpring
        to: pixelSpring.to
        stiffness: 300
        damping: 20
    }

    contentItem: Item {
        implicitWidth: row.implicitWidth
        implicitHeight: row.implicitHeight
        Row {
            id: row
            x: -b.px * b.blockRest // the pixel label slides left as the block grows (plan)
            anchors.verticalCenter: parent.verticalCenter
            spacing: 8
            Canvas { // the premium crown (plan: viewBox 36 by 24, 23 px wide), drawn once
                id: crown
                visible: b.look === "premium"
                width: visible ? 17 : 0
                height: 12
                anchors.verticalCenter: parent.verticalCenter
                onPaint: {
                    const c = getContext("2d");
                    c.reset();
                    c.fillStyle = String(b.ink);
                    const k = width / 36;
                    c.beginPath();
                    c.moveTo(18 * k, 0); c.lineTo(26 * k, 12 * k); c.lineTo(36 * k, 4 * k); c.lineTo(32 * k, 24 * k);
                    c.lineTo(4 * k, 24 * k); c.lineTo(0, 4 * k); c.lineTo(10 * k, 12 * k); c.closePath();
                    c.fill();
                }
                Connections { target: b; function onInkChanged() { crown.requestPaint() } }
                onVisibleChanged: requestPaint()
            }
            Image {
                visible: b.iconName !== ""
                anchors.verticalCenter: parent.verticalCenter
                source: b.iconName !== "" ? Theme.icon(b.iconName, b.enabled ? b.ink.toString() : Theme.c.disabled.toString(), 16) : ""
                width: 16
                height: 16
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: b.text
                font: b.font
                color: b.enabled ? b.ink : Theme.c.disabled
                Behavior on color { enabled: b.look === "pixel" && b.full; ColorAnimation { duration: 200 } }
            }
        }
    }

    background: Item {
        id: bg
        objectName: "ubuttonBg"
        property string look: b.look // read by the probe
        opacity: b.enabled ? 1 : 0.6

        // Everything a look paints. Not created in "plain" or with the flag off.
        Loader {
            id: deco
            anchors.fill: parent
            active: b.look !== ""
            sourceComponent: b.look === "soft" ? softC : b.look === "neumorph" ? neuC : b.look === "premium" ? premiumC
                           : b.look === "pixel" ? pixelC : b.look === "glass" ? glassC : null
        }
        // The plain look; with a RareUI look it only keeps the focus ring.
        Rectangle {
            anchors.fill: parent
            radius: b.rad
            color: b.look !== "" ? "transparent" : !b.enabled ? Theme.c.field : b.down ? Qt.darker(b.fill, 1.15) : b.hovered ? Qt.lighter(b.fill, 1.12) : b.fill
            border.width: b.look !== "" ? (b.visualFocus ? 1 : 0) : (b.kind === "normal" || b.visualFocus ? 1 : 0)
            border.color: b.visualFocus ? Theme.c.accentHi : Theme.c.border
            Behavior on color { enabled: Theme.motion; ColorAnimation { duration: b.colorMs } }
        }
    }

    // ---- soft: a pill with a light and a dark shadow; under the pointer it turns accent and glows (plan item 11) ----
    Component {
        id: softC
        Item {
            ShadowLayers { offsetX: -3; offsetY: -3; blur: 6; radius: b.rad; color: Theme.c.text; strength: b.lit ? 0.05 : 0.08 }
            ShadowLayers { offsetX: 3; offsetY: 3; blur: 6; radius: b.rad; color: "#000000"; strength: b.lit ? 0.18 : 0.32 }
            ShadowLayers { // the glow
                offsetY: 0; blur: 14; radius: b.rad; color: b.hotFill
                strength: b.lit ? 0.55 : 0
                Behavior on strength { enabled: b.full; NumberAnimation { duration: 200 } }
            }
            Rectangle {
                anchors.fill: parent
                radius: b.rad
                color: b.lit ? b.hotFill : b.fill
                border.width: 1
                border.color: Qt.rgba(b.ink.r, b.ink.g, b.ink.b, 0.12)
                Behavior on color { enabled: b.full; ColorAnimation { duration: 200 } }
            }
        }
    }

    // ---- neumorph: an embossed face; a press sinks it and flattens the shadows (plan item 6) ----
    Component {
        id: neuC
        Item {
            id: nc
            readonly property color face: b.kind === "normal" ? Theme.c.panel : b.fill
            readonly property real hi: b.kind === "normal" ? 1.06 : 1.0 // a filled button keeps its label contrast: a flat face
            readonly property real lo: b.kind === "normal" ? 1.08 : 1.0
            property real sink: b.down ? 1 : 0
            Behavior on sink { enabled: b.full; NumberAnimation { duration: 250 } }
            ShadowLayers { offsetX: -3; offsetY: -3; blur: 8; radius: b.rad; color: Theme.c.text; strength: 0.10 * (1 - nc.sink) }
            ShadowLayers { offsetX: 3; offsetY: 3; blur: 8; radius: b.rad; color: "#000000"; strength: 0.40 * (1 - nc.sink) }
            Rectangle {
                anchors.fill: parent
                radius: b.rad
                gradient: Gradient {
                    GradientStop { position: 0; color: nc.sink > 0.5 ? Qt.darker(nc.face, nc.lo) : Qt.lighter(nc.face, nc.hi) }
                    GradientStop { position: 1; color: nc.sink > 0.5 ? Qt.lighter(nc.face, nc.hi) : Qt.darker(nc.face, nc.lo) }
                }
                border.width: 1
                border.color: Qt.rgba(Theme.c.text.r, Theme.c.text.g, Theme.c.text.b, 0.08)
            }
        }
    }

    // ---- premium: an accent gradient that slides under the pointer, a crown before the label (plan item 8) ----
    Component {
        id: premiumC
        Item {
            id: pr
            // The accent in four shades (darker when the label is light, lighter when it is dark), repeated twice, 300 percent wide
            // in the source; here a window of a third of that strip, moved by b.slide.
            readonly property bool darkInk: (Theme.c.onAccent.r * 0.2126 + Theme.c.onAccent.g * 0.7152 + Theme.c.onAccent.b * 0.0722) > 0.5
            readonly property var steps: darkInk ? [0, 0.12, 0.24, 0.34] : [0, 0.08, 0.16, 0.24]
            function shade(i) {
                const a = Theme.c.accent, k = steps[((i % 4) + 4) % 4];
                const t = darkInk ? 0 : 1;
                return Qt.rgba(a.r + (t - a.r) * k, a.g + (t - a.g) * k, a.b + (t - a.b) * k, 1);
            }
            function strip(t) { // t 0..1 over eight shades
                const u = Math.max(0, Math.min(0.9999, t)) * 7, i = Math.floor(u), f = u - i;
                const p = shade(i), q = shade(i + 1);
                return Qt.rgba(p.r + (q.r - p.r) * f, p.g + (q.g - p.g) * f, p.b + (q.b - p.b) * f, 1);
            }
            ShadowLayers { offsetY: 6; blur: 8; radius: b.rad; color: Theme.c.accent; strength: 0.25 }
            Rectangle {
                anchors.fill: parent
                radius: b.rad
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0.0; color: pr.strip(b.slide + 0 / 5 / 3) }
                    GradientStop { position: 0.2; color: pr.strip(b.slide + 1 / 5 / 3) }
                    GradientStop { position: 0.4; color: pr.strip(b.slide + 2 / 5 / 3) }
                    GradientStop { position: 0.6; color: pr.strip(b.slide + 3 / 5 / 3) }
                    GradientStop { position: 0.8; color: pr.strip(b.slide + 4 / 5 / 3) }
                    GradientStop { position: 1.0; color: pr.strip(b.slide + 5 / 5 / 3) }
                }
            }
        }
    }

    // ---- pixel: a block with a pixel arrow grows across the button under the pointer (plan item 10) ----
    Component {
        id: pixelC
        Item {
            ShadowLayers { offsetY: b.hovered ? 3 : 1; blur: b.hovered ? 6 : 3; radius: b.rad; color: "#000000"; strength: 0.25 }
            Rectangle {
                anchors.fill: parent
                radius: b.rad
                color: b.fill
                border.width: 1
                border.color: Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 0.55)
            }
            Rectangle { // the block (plan: inset 4, radius 4, 55 px at rest, 97 percent wide on hover; here 3 px inset)
                id: blk
                x: 3
                y: 3
                height: parent.height - 6
                width: b.blockRest + b.px * Math.max(0, (parent.width - 6) * 0.97 - b.blockRest)
                radius: 4
                color: Theme.c.accent
                Item { // the arrow: five 5 by 5 squares of a 16 by 34 box (plan), scaled to the block, turning 180 degrees
                    id: arrow
                    readonly property real s: (blk.height * 0.6) / 34
                    width: 16 * s
                    height: 34 * s
                    x: (b.blockRest - 6 - width) / 2 + 3
                    y: (blk.height - height) / 2
                    rotation: b.full ? arrowSpring.value * 180 : 0
                    Repeater {
                        model: [[7, 6], [11, 10], [15, 14], [11, 18], [7, 22]]
                        Rectangle {
                            required property var modelData
                            x: (modelData[0] - 5) * arrow.s
                            y: modelData[1] * arrow.s
                            width: 5 * arrow.s
                            height: 5 * arrow.s
                            color: Theme.c.onAccent
                        }
                    }
                }
            }
        }
    }

    // ---- glass: a pill with gloss lines; in "full" a light band sweeps across it now and then (plan item 3) ----
    Component {
        id: glassC
        Item {
            ShadowLayers { offsetY: 0; blur: 10; radius: b.rad; color: "#000000"; strength: b.hovered ? 0.30 : 0.18 }
            Rectangle {
                id: gface
                anchors.fill: parent
                radius: b.rad
                color: b.hovered ? Qt.darker(b.fill, 1.1) : b.fill
                border.width: 1
                border.color: Qt.rgba(b.ink.r, b.ink.g, b.ink.b, 0.15)
            }
            Rectangle { // the top gloss line, bright in the middle
                x: b.rad * 0.6; y: 1; width: parent.width - b.rad * 1.2; height: 1
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0; color: "transparent" }
                    GradientStop { position: 0.5; color: Qt.rgba(b.ink.r, b.ink.g, b.ink.b, 0.20) }
                    GradientStop { position: 1; color: "transparent" }
                }
            }
            Rectangle { // the bottom gloss line
                x: b.rad * 0.6; y: parent.height - 2; width: parent.width - b.rad * 1.2; height: 1
                gradient: Gradient {
                    orientation: Gradient.Horizontal
                    GradientStop { position: 0; color: "transparent" }
                    GradientStop { position: 0.5; color: Qt.rgba(b.ink.r, b.ink.g, b.ink.b, 0.06) }
                    GradientStop { position: 1; color: "transparent" }
                }
            }
            Loader { // the sweep: only in "full" (a loop; nothing exists in calm or plain)
                active: b.full
                anchors.fill: parent
                anchors.margins: b.rad * 0.29 // the corners of this box sit inside the pill's rounding
                sourceComponent: Item {
                    clip: true
                    Rectangle {
                        id: band
                        objectName: "rareLoop"
                        property bool loop: true // read by the probe
                        y: 0
                        width: parent.width * 0.5
                        height: parent.height
                        transform: Matrix4x4 { matrix: Qt.matrix4x4(1, -0.364, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) } // skew X by -20 degrees
                        gradient: Gradient {
                            orientation: Gradient.Horizontal
                            GradientStop { position: 0; color: "transparent" }
                            GradientStop { position: 0.5; color: Qt.rgba(b.ink.r, b.ink.g, b.ink.b, b.kind === "normal" ? 0.12 : 0.03) } // fainter on a filled button, so its label keeps the contrast
                            GradientStop { position: 1; color: "transparent" }
                        }
                        SequentialAnimation on x {
                            running: b.visible
                            loops: Animation.Infinite
                            NumberAnimation { from: -band.width; to: band.parent.width + band.width; duration: 2500 }
                            PauseAnimation { duration: 3000 }
                        }
                    }
                }
            }
        }
    }
}
