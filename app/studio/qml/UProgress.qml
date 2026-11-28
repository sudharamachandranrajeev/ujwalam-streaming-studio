// SPDX-License-Identifier: GPL-3.0-or-later
// A progress bar (Molten Stone, 2026-11-27; every theme). kind "linear": a recessed track and a fill, in Molten Stone a
// molten fill with a drip hanging from its end; kind "processing" (the busy bar of long jobs, the reference's "spating"
// bar): the same track with a flowing fill and a small gear at the fill's end. value 0..1, or below 0 when the amount of
// work is unknown (a sweep while animations are on; a still third otherwise). label: an optional line above
// ("Processing: 60%"). Its height is the same in every theme: 8 px of track and 8 px kept under it for the drip, so a row
// never changes height when the theme changes. Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: pr
    property real value: 0
    property string kind: "linear"
    property string label: ""
    property color ink: Theme.c.accent
    property bool running: true
    readonly property real f: Math.max(0, Math.min(1, value))
    readonly property bool unknown: value < 0
    readonly property bool molten: fillTex.on // the pack's molten fill is drawn (Molten Stone, not plain)
    implicitWidth: 200
    implicitHeight: (label !== "" ? lab.implicitHeight + 4 : 0) + 8 + 8

    Text {
        id: lab
        visible: pr.label !== ""
        text: pr.label
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.caption
    }
    Item {
        id: track
        y: pr.label !== "" ? lab.implicitHeight + 4 : 0
        width: parent.width
        height: 8
        Rectangle { anchors.fill: parent; radius: 4; color: Theme.c.border; visible: !trackTex.on }
        UTexture { id: trackTex; surface: "track" }
        Item {
            id: fillBox
            height: parent.height
            visible: pr.unknown ? pr.running : pr.f > 0
            width: pr.unknown ? parent.width * 0.32 : Math.max(parent.height, parent.width * pr.f)
            Behavior on width { enabled: Theme.motion && !pr.unknown; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
            Rectangle { anchors.fill: parent; radius: 4; color: pr.ink; visible: !fillTex.on }
            UTexture { id: fillTex; surface: pr.ink === Theme.c.accent ? "fill" : "" } // a failure or a wait keeps its own colour
            SequentialAnimation on x {
                running: pr.unknown && pr.running && fillBox.visible && Theme.motion
                loops: Animation.Infinite
                NumberAnimation { from: 0; to: track.width * 0.68; duration: 1400; easing.type: Easing.InOutSine }
            }
        }
        UAmbient { // the drip hanging from the fill's end (linear), in the 8 px kept under the track
            visible: pr.kind === "linear" && pr.molten && !pr.unknown && pr.f > 0.02 && still !== ""
            kind: "drip"
            width: 6; height: 12
            x: fillBox.x + fillBox.width - 8
            y: 4
        }
        Image { // the gear at the fill's end (processing)
            visible: pr.kind === "processing" && fillBox.visible && source !== ""
            source: Theme.art.gear !== undefined ? Theme.art.gear : ""
            width: 14; height: 14
            x: Math.min(track.width - 14, fillBox.x + fillBox.width - 7)
            y: -3
        }
    }
}
