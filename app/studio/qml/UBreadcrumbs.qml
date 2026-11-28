// SPDX-License-Identifier: GPL-3.0-or-later
// Breadcrumbs (Molten Stone, 2026-11-27; every theme): small beads joined by short thin lines, the first bead lit in the accent,
// labels between them ("Settings > Appearance"). A label before the last one is a link: picked(index). Fixed 22 px high.
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: bc
    property var path: []          // labels, first to last
    property bool links: true      // false: the labels are only a trail (no hover, no click)
    signal picked(int index)
    implicitHeight: 22
    implicitWidth: row.implicitWidth + 3

    Row {
        id: row
        // x 3: the first bead's 14 px glow ring reaches 3 px past its 8 px bead; start the row there so the ring stays
        // inside this item (a clipped parent would otherwise cut it: studio-qml-layout found -3,4 in Settings).
        x: 3
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.sp.s
        Repeater {
            model: bc.path
            Row {
                id: crumb
                required property string modelData
                required property int index
                readonly property bool last: index === bc.path.length - 1
                spacing: Theme.sp.s
                Rectangle { // the thin line into this bead (never under a label: no line crosses text)
                    visible: crumb.index > 0
                    anchors.verticalCenter: parent.verticalCenter
                    width: 10; height: 1
                    color: Theme.c.border
                }
                Rectangle { // the bead
                    anchors.verticalCenter: parent.verticalCenter
                    width: 8; height: 8; radius: 4
                    color: crumb.index === 0 ? Theme.c.accent : Qt.lighter(Theme.c.panel, 1.4)
                    border.width: 1
                    border.color: crumb.index === 0 ? Theme.c.accentHi : Theme.c.border
                    Rectangle { // the glow of the first bead: a soft ring inside the row's spacing, never past it
                        visible: crumb.index === 0 && Theme.fx !== "plain"
                        anchors.centerIn: parent
                        width: 14; height: 14; radius: 7
                        color: "transparent"
                        border.width: 3
                        border.color: Qt.rgba(Theme.c.accent.r, Theme.c.accent.g, Theme.c.accent.b, 0.25)
                    }
                }
                Text {
                    objectName: "crumb:" + crumb.modelData
                    anchors.verticalCenter: parent.verticalCenter
                    text: crumb.modelData
                    color: crumb.last ? Theme.c.text : crumbTap.hovered ? Theme.c.accentHi : Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                    font.weight: crumb.last ? Font.DemiBold : Font.Normal
                    HoverHandler { id: crumbTap; enabled: bc.links && !crumb.last; cursorShape: Qt.PointingHandCursor }
                    TapHandler { enabled: bc.links && !crumb.last; onTapped: bc.picked(crumb.index) }
                }
                Text {
                    visible: !crumb.last
                    anchors.verticalCenter: parent.verticalCenter
                    text: ">"
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
            }
        }
    }
}
