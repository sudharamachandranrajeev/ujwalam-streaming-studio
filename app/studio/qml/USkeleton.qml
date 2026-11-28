// SPDX-License-Identifier: GPL-3.0-or-later
// Skeleton rows while a list loads (Molten Stone, 2026-11-27; every theme): faint bars with a tiny diamond bullet and a
// small accent mark at the right, 28 px a row. Still (no shimmer loop): it shows for a moment and must cost nothing.
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Column {
    id: sk
    property int rows: 4
    objectName: "skeleton"
    spacing: 4
    Repeater {
        model: sk.rows
        Item {
            required property int index
            width: sk.width
            height: 28
            Rectangle { // the diamond bullet
                width: 6; height: 6; rotation: 45
                x: 6; anchors.verticalCenter: parent.verticalCenter
                color: Qt.rgba(Theme.c.muted.r, Theme.c.muted.g, Theme.c.muted.b, 0.45)
            }
            Rectangle { // the bar; widths vary by row so it reads as text
                x: 20; anchors.verticalCenter: parent.verticalCenter
                width: Math.max(40, (parent.width - 52) * [0.82, 0.64, 0.74, 0.55][index % 4])
                height: 10; radius: 5
                color: Qt.rgba(Theme.c.muted.r, Theme.c.muted.g, Theme.c.muted.b, 0.18)
            }
            Image { // the small gear at the right (the pack's picture), else a short accent bar
                anchors { right: parent.right; rightMargin: 6; verticalCenter: parent.verticalCenter }
                source: Theme.art.gear !== undefined ? Theme.art.gear : ""
                visible: source !== ""
                width: 14; height: 14
                opacity: 0.7
            }
            Rectangle {
                visible: Theme.art.gear === undefined
                anchors { right: parent.right; rightMargin: 6; verticalCenter: parent.verticalCenter }
                width: 12; height: 4; radius: 2
                color: Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 0.5)
            }
        }
    }
}
