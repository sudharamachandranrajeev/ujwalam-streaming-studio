// SPDX-License-Identifier: GPL-3.0-or-later
// A painted surface (Molten Stone, 2026-11-27): the pack's 9-slice picture for one surface class (Theme.tex), filling the
// parent and reaching `outset` px past its edges for the glow or shadow (inside the room the layout reserves). Drawn only
// when the pack ships that picture, Theme.fx is not "plain" and the parent is big enough for the picture's corners (a
// smaller parent would overlap the corners: then nothing is drawn and the caller's flat fill shows). inset: true keeps the
// whole picture inside the parent (a window or popup clips anything outside it): the face sits outset px in from the edges. Middle spans are
// tiled whole ("round"), never stretched, so cracks and wire rims keep their shape. A still image: nothing here moves.
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

BorderImage {
    id: t
    property string surface: ""
    property bool inset: false
    readonly property var spec: surface !== "" ? Theme.tex[surface] : undefined
    readonly property real ow: parent ? parent.width : 0
    readonly property real oh: parent ? parent.height : 0
    readonly property real grow: spec !== undefined && !inset ? spec.o : 0
    readonly property bool on: spec !== undefined && ow + 2 * grow >= 2 * spec.m && oh + 2 * grow >= 2 * spec.m
    visible: on
    x: -grow
    y: -grow
    width: on ? ow + 2 * grow : 0
    height: on ? oh + 2 * grow : 0
    source: on ? spec.src : ""
    border.left: on ? spec.m : 0
    border.right: on ? spec.m : 0
    border.top: on ? spec.m : 0
    border.bottom: on ? spec.m : 0
    horizontalTileMode: on && spec.tile === "stretch" ? BorderImage.Stretch : on && spec.tile === "repeat" ? BorderImage.Repeat : BorderImage.Round
    verticalTileMode: horizontalTileMode
    smooth: true
    cache: true
}
