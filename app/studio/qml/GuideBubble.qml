// SPDX-License-Identifier: GPL-3.0-or-later
// A rounded card with an arrow on one side (the widget's Bubble, coach.cpp): the tour card and the hint. The arrow room
// (arrow) is part of the item, so it is the card plus 2 * arrow each way. pointAt() places it next to a target and never
// over it: below, above, left, right (a wanted side first), clear of the previews (a native preview window covers
// anything drawn there); if nothing fits at full width, the roomiest side with a narrower card.
import QtQuick
import Ujwalam.Core

Item {
    id: bub
    readonly property int arrow: 10
    property int baseW: 380
    property string side: ""   // where the card sits next to its target: below | above | left | right | "" (no arrow)
    property real along: 0     // the arrow's place along that edge
    property bool shown: false
    default property alias content: col.data

    width: baseW
    height: col.implicitHeight + 24 + 2 * arrow
    visible: opacity > 0
    opacity: shown ? 1 : 0
    Behavior on opacity { enabled: Theme.motion; NumberAnimation { duration: bub.shown ? 220 : 160; easing.type: bub.shown ? Easing.OutCubic : Easing.InCubic } }

    // The card's height for a width (the text wraps): lays the column out at once.
    function sized(w) {
        width = w;
        col.forceLayout();
        return col.implicitHeight + 24 + 2 * arrow;
    }
    function inter(a, b) { return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height }
    // target, bounds: {x, y, width, height} in the parent's coordinates; avoid: such rects the card stays clear of.
    // Returns the card's rect.
    function pointAt(target, pref, bounds, avoid) {
        const gap = 4, w0 = baseW;
        const cx = target.x + target.width / 2, cy = target.y + target.height / 2;
        const rectFor = (s, w, h) => {
            const fx = (x) => Math.max(bounds.x, Math.min(x, bounds.x + bounds.width - w));
            const fy = (y) => Math.max(bounds.y, Math.min(y, bounds.y + bounds.height - h));
            if (s === "below") return { x: fx(cx - w / 2), y: target.y + target.height + gap, width: w, height: h };
            if (s === "above") return { x: fx(cx - w / 2), y: target.y - gap - h, width: w, height: h };
            if (s === "left") return { x: target.x - gap - w, y: fy(cy - h / 2), width: w, height: h };
            return { x: target.x + target.width + gap, y: fy(cy - h / 2), width: w, height: h };
        };
        const room = (s) => s === "below" ? bounds.y + bounds.height - target.y - target.height : s === "above" ? target.y - bounds.y
                          : s === "left" ? target.x - bounds.x : bounds.x + bounds.width - target.x - target.width;
        const fits = (r, useAvoid) => {
            if (r.x < bounds.x || r.y < bounds.y || r.x + r.width > bounds.x + bounds.width || r.y + r.height > bounds.y + bounds.height) return false;
            if (inter(r, target)) return false;
            if (useAvoid) {
                const inner = { x: r.x + arrow, y: r.y + arrow, width: r.width - 2 * arrow, height: r.height - 2 * arrow };
                for (const a of avoid) if (inter(inner, a)) return false;
            }
            return true;
        };
        let order = ["below", "above", "left", "right"];
        if (pref) order = [pref].concat(order.filter(s => s !== pref));
        const h0 = sized(w0);
        let pick = null, ps = "";
        for (const useAvoid of [true, false]) {
            for (const s of order) {
                const r = rectFor(s, w0, h0);
                if (fits(r, useAvoid)) { pick = r; ps = s; break }
            }
            if (pick) break;
        }
        if (!pick) { // nothing fits at full width: the roomiest side, a narrower card
            const by = order.slice().sort((a, b) => room(b) - room(a));
            for (const s of by) {
                const w = s === "left" || s === "right" ? Math.max(180, Math.min(w0, room(s) - gap - 1)) : Math.min(w0, bounds.width);
                const r = rectFor(s, w, sized(w));
                if (fits(r, false)) { pick = r; ps = s; break }
            }
            if (!pick) { // a target that fills the window: best effort, kept inside
                ps = by[0];
                const w = Math.min(w0, bounds.width);
                pick = rectFor(ps, w, sized(w));
                pick.x = Math.max(bounds.x, pick.x);
                pick.y = Math.max(bounds.y, pick.y);
            }
        }
        side = ps;
        const lo = arrow + 18;
        along = ps === "left" || ps === "right" ? Math.max(lo, Math.min(cy - pick.y, Math.max(lo, pick.height - arrow - 18)))
                                                : Math.max(lo, Math.min(cx - pick.x, Math.max(lo, pick.width - arrow - 18)));
        x = pick.x;
        y = pick.y;
        return pick;
    }

    Behavior on x { enabled: Theme.motion && bub.shown; NumberAnimation { duration: 280; easing.type: Easing.InOutCubic } }
    Behavior on y { enabled: Theme.motion && bub.shown; NumberAnimation { duration: 280; easing.type: Easing.InOutCubic } }

    // a soft shadow: a few faint rings (no blur effect)
    Repeater {
        model: 5
        Rectangle {
            required property int index
            readonly property int d: 5 - index
            x: bub.arrow - d; y: bub.arrow - d + 2
            width: bub.width - 2 * bub.arrow + 2 * d; height: bub.height - 2 * bub.arrow + 2 * d
            radius: 14 + d
            color: Qt.rgba(0, 0, 0, 0.055)
        }
    }
    // the arrow: a turned square under the card's edge
    Rectangle {
        visible: bub.side !== ""
        width: 16; height: 16; rotation: 45
        color: Theme.c.panel
        border.color: Theme.c.accent
        border.width: 1
        x: (bub.side === "right" ? bub.arrow : bub.side === "left" ? bub.width - bub.arrow : bub.along) - width / 2
        y: (bub.side === "below" ? bub.arrow : bub.side === "above" ? bub.height - bub.arrow : bub.along) - height / 2
    }
    Rectangle {
        id: card
        anchors { fill: parent; margins: bub.arrow }
        radius: 14
        color: Theme.c.panel
        border.color: Theme.c.accent
        border.width: 1
        // the arrow's join: the card's colour over the edge line where the arrow meets it
        Rectangle {
            visible: bub.side !== ""
            color: Theme.c.panel
            readonly property bool across: bub.side === "below" || bub.side === "above"
            width: across ? 20 : 2
            height: across ? 2 : 20
            x: across ? bub.along - bub.arrow - 10 : (bub.side === "right" ? 0 : card.width - 2)
            y: across ? (bub.side === "below" ? 0 : card.height - 2) : bub.along - bub.arrow - 10
        }
    }
    Column {
        id: col
        anchors { left: card.left; right: card.right; top: card.top; leftMargin: 16; rightMargin: 16; topMargin: 12 }
        spacing: 8
    }
}
