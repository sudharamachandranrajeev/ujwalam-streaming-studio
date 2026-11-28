// SPDX-License-Identifier: GPL-3.0-or-later
// Pagination (Molten Stone, 2026-11-27; every theme): PREV, page pebbles, NEXT; the current page lit in the accent (in
// Molten Stone a glowing rose-gold pebble). Pages are 0-based inside, 1-based on screen. Shows at most 7 pebbles (first,
// last and the ones around the current page, gaps as "..."). Fixed 30 px high, so a list never jumps when it appears.
// Not used: MultiEffect, ShaderEffect.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Item {
    id: pg
    property int page: 0
    property int pages: 1
    signal moved(int page)
    implicitHeight: 30
    implicitWidth: row.implicitWidth
    visible: pages > 1

    // The pebbles to show: page numbers, -1 for a gap.
    readonly property var marks: {
        const n = pages, c = page, out = [];
        if (n <= 7) { for (let i = 0; i < n; i++) out.push(i); return out; }
        const lo = Math.max(1, Math.min(c - 1, n - 5)), hi = Math.min(n - 2, Math.max(c + 1, 4));
        out.push(0);
        if (lo > 1) out.push(-1);
        for (let i = lo; i <= hi; i++) out.push(i);
        if (hi < n - 2) out.push(-1);
        out.push(n - 1);
        return out;
    }

    component Pebble: Item {
        id: pb
        property string label: ""
        property bool current: false
        property bool gap: false
        signal hit()
        implicitWidth: Math.max(26, t.implicitWidth + 16)
        implicitHeight: 26
        opacity: enabled ? 1 : Theme.st.disabled
        Rectangle { // the flat look (every theme; under the picture in Molten Stone)
            anchors.fill: parent
            visible: !pb.gap && !(pb.current ? lit.on : stone.on)
            radius: 13
            color: pb.current ? Theme.c.accent : ph.hovered ? Qt.lighter(Theme.c.field, 1.2) : Theme.c.field
            border.width: 1
            border.color: pb.current ? Theme.c.accentHi : Theme.c.border
        }
        UTexture { id: stone; surface: !pb.gap && !pb.current ? "plate" : "" }
        UTexture { id: lit; surface: pb.current ? "buttonNormal" : "" }
        Text {
            id: t
            anchors.centerIn: parent
            text: pb.label
            color: pb.current ? (lit.on ? Theme.c.accentHi : Theme.c.onAccent) : Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
            font.weight: pb.current ? Font.Bold : Font.DemiBold
            font.capitalization: Font.AllUppercase
        }
        HoverHandler { id: ph; enabled: !pb.gap && !pb.current; cursorShape: Qt.PointingHandCursor }
        TapHandler { enabled: !pb.gap && !pb.current && pb.enabled; onTapped: pb.hit() }
    }

    Row {
        id: row
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.sp.s + 2 // room for the lit pebble's glow (6 px each side, shared by neighbours)
        Pebble { objectName: "pagePrev"; label: "Prev"; enabled: pg.page > 0; onHit: pg.moved(pg.page - 1) }
        Repeater {
            model: pg.marks
            Pebble {
                required property int modelData
                objectName: "page:" + (modelData + 1)
                gap: modelData < 0
                label: modelData < 0 ? "..." : String(modelData + 1)
                current: modelData === pg.page
                onHit: pg.moved(modelData)
            }
        }
        Pebble { objectName: "pageNext"; label: "Next"; enabled: pg.page < pg.pages - 1; onHit: pg.moved(pg.page + 1) }
    }
}
