// SPDX-License-Identifier: GPL-3.0-or-later
// A settings card (the widget's QGroupBox): a small capital heading and its rows in a column, as wide as the page.
import QtQuick
import Ujwalam.Core

Rectangle {
    id: card
    property string title: ""
    default property alias content: body.data
    width: parent ? parent.width : 0
    readonly property real pad: Theme.sp.l
    // D432: the heading's own implicit height, not its height: a height bound to its effective visibility looped (a
    // binding loop on every hidden page, 20 at a time in the user's log, each one a layout pass more).
    implicitHeight: body.implicitHeight + (card.title !== "" ? head.implicitHeight + Theme.sp.s : 0) + pad * 2
    height: implicitHeight
    color: cardTex.on ? "transparent" : Theme.c.panel
    radius: Theme.radiusMedium
    border.width: cardTex.on ? 0 : 1
    border.color: Theme.c.border
    // Molten Stone (2026-11-27): a stone card with a fine wire rim and a second slab peeking behind it, kept inside the
    // card's box (cards sit in clipped scroll views); the flat panel elsewhere. Same size in every theme.
    UTexture { id: cardTex; surface: "card"; inset: true }
    Text {
        id: head
        x: card.pad
        y: card.pad
        width: card.width - card.pad * 2
        visible: card.title !== ""
        text: card.title
        color: Theme.c.muted
        elide: Text.ElideRight
        font.family: Theme.family
        font.pixelSize: Theme.ty.caption
        font.weight: Font.DemiBold
        font.letterSpacing: 0.6
    }
    Column {
        id: body
        x: card.pad
        y: card.pad + (card.title !== "" ? head.implicitHeight + Theme.sp.s : 0)
        width: card.width - card.pad * 2
        spacing: Theme.sp.m
    }
}
