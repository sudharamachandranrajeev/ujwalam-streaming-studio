// SPDX-License-Identifier: GPL-3.0-or-later
// The live alert strip (flag live-test-kit, D305 proposed; the widget's updateAlerts): plain-words lines from the status
// snapshot ("alerts"): a sound source that stopped, a stream restarted (or not) after a host crash, the Streamer.bot
// test-action reminder, the viewer feedback result. At most 8 lines, each cut at 400 characters. The worst level colours
// the edge (danger for an error, accent for a warning, the border colour for information). Hidden while there is
// nothing to say (the server sends no alerts with the flag off). Plain text only: nothing in an alert is markup.
import QtQuick
import Ujwalam.Core

Rectangle {
    id: strip
    required property var store

    readonly property var lines: {
        const out = [];
        for (const a of (Array.isArray(store.alerts) ? store.alerts : [])) {
            const t = a && a.text !== undefined ? String(a.text).slice(0, 400) : "";
            if (t === "") continue;
            out.push({ text: t, level: a.level === "error" ? 2 : a.level === "warn" ? 1 : 0 });
            if (out.length >= 8) break;
        }
        return out;
    }
    readonly property int worst: lines.reduce((w, l) => Math.max(w, l.level), 0)
    readonly property string level: lines.length === 0 ? "" : worst === 2 ? "error" : worst === 1 ? "warn" : "info"
    readonly property string text: lines.map(l => l.text).join("\n")

    visible: lines.length > 0
    height: visible ? label.implicitHeight + 12 : 0
    color: Theme.c.panel
    radius: 6
    border.width: 1
    border.color: worst === 2 ? Theme.c.danger : worst === 1 ? Theme.c.accent : Theme.c.border

    Text {
        id: label
        objectName: "alertText"
        anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; leftMargin: 10; rightMargin: 10 }
        text: strip.text
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 13
        lineHeight: 1.15
    }

    function probe() { return { shown: visible, text: text, level: level } }
}
