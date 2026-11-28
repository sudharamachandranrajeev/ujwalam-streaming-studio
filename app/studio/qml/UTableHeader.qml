// SPDX-License-Identifier: GPL-3.0-or-later
// A compact table header (Molten Stone, 2026-11-27; every theme): a dark plate row 36 px high with caps column titles and
// sort arrows on the sortable ones; a click on a title asks the list to sort by it (sortBy(key)); the list decides the
// order. columns: [{ key, title, w }] where w is a share of the width (they need not add up to 1).
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import Ujwalam.Core

Item {
    id: th
    property var columns: []
    property string sortKey: ""
    property bool sortUp: true
    signal sortBy(string key)
    implicitHeight: 36
    readonly property real total: columns.reduce((n, c) => n + (c.w || 1), 0)

    Rectangle { anchors.fill: parent; radius: Theme.radiusMedium; color: Theme.c.panel; border.width: 1; border.color: Theme.c.border; visible: !plate.on }
    UTexture { id: plate; surface: "plate" }
    Row {
        anchors { fill: parent; leftMargin: Theme.sp.m; rightMargin: Theme.sp.m }
        Repeater {
            model: th.columns
            Item {
                id: col
                required property var modelData
                readonly property bool sortable: modelData.key !== undefined && modelData.key !== ""
                readonly property bool active: sortable && modelData.key === th.sortKey
                width: (parent.width) * (modelData.w || 1) / Math.max(0.001, th.total)
                height: parent.height
                objectName: "colHead:" + (modelData.key || modelData.title)
                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 4
                    Text {
                        text: col.modelData.title
                        color: col.active ? Theme.c.accentHi : Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.caption
                        font.weight: Font.Bold
                        font.capitalization: Font.AllUppercase
                        font.letterSpacing: 0.8
                    }
                    Canvas { // the sort arrows: both faint, the chosen one in the accent
                        id: arrows
                        visible: col.sortable
                        width: 7; height: 11
                        anchors.verticalCenter: parent.verticalCenter
                        readonly property string state2: (col.active ? (th.sortUp ? "u" : "d") : "") + Theme.c.accent
                        onState2Changed: requestPaint()
                        onPaint: {
                            const g = getContext("2d");
                            g.reset();
                            const tri = (up, on) => {
                                g.fillStyle = on ? String(Theme.c.accent) : String(Theme.c.muted);
                                g.globalAlpha = on ? 1 : 0.45;
                                g.beginPath();
                                if (up) { g.moveTo(0, 4.5); g.lineTo(3.5, 0); g.lineTo(7, 4.5); }
                                else { g.moveTo(0, 6.5); g.lineTo(3.5, 11); g.lineTo(7, 6.5); }
                                g.fill();
                            };
                            tri(true, col.active && th.sortUp);
                            tri(false, col.active && !th.sortUp);
                        }
                    }
                }
                TapHandler { enabled: col.sortable; onTapped: th.sortBy(col.modelData.key) }
                HoverHandler { enabled: col.sortable; cursorShape: Qt.PointingHandCursor }
            }
        }
    }
}
