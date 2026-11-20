// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Downloads (download manager, 2026-11-19): the optional models the setup does not carry
// (data/downloads/*.json), each with what it is for, its size, its licence, a progress bar and Download / Pause /
// Resume / Cancel. Every row keeps its height whatever its state (no layout jumps). It asks the server when the page
// opens and once a second only while something downloads; no other polling. Never while live: the server refuses a
// start and pauses a running download itself; the row says so in plain words.
// `only` (an item id) shows that one item as a compact offer (Settings > Clips for captions, Editing for Face AI) and
// hides itself when the item is ready.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: dl
    property string only: ""
    property var items: []
    property bool on: true
    property string err: ""
    width: parent ? parent.width : 0
    spacing: Theme.sp.s
    readonly property var shown: only ? items.filter(i => i.id === only && i.state !== "ready") : items
    readonly property bool busy: items.some(i => i.state === "downloading" || i.state === "queued" || i.state === "verifying")
    visible: !only || shown.length > 0

    function mb(b) { return b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.max(0.1, b / 1048576).toFixed(b < 10485760 ? 1 : 0) + " MB" }
    function words(i) {
        if (i.message) return i.message;
        if (i.state === "ready") return "Downloaded and checked.";
        if (i.state === "queued") return "Waiting for the download before it to finish.";
        if (i.state === "downloading") return "Downloading: " + mb(i.done) + " of " + mb(i.total) + ".";
        if (i.state === "verifying") return "Checking the download…";
        if (i.state === "paused") return "Paused at " + mb(i.done) + " of " + mb(i.total) + ".";
        if (i.state === "failed") return "The download stopped.";
        return "Not downloaded (" + mb(i.total) + ").";
    }
    function load() {
        Api.get("ui/api/downloads", (ok, b, e) => {
            if (!ok) { dl.err = b && b.error === "downloads-off" ? "" : "Could not read the downloads: " + e; return; }
            dl.err = b.error ? "The downloads list has a problem: " + b.error : "";
            dl.on = b.on !== false;
            dl.items = b.items || [];
        });
    }
    function act(id, action) {
        Api.post("ui/api/downloads", { id: id, action: action }, (ok, b, e) => {
            if (!ok) dl.err = b && b.message ? b.message : "That did not work: " + e;
            else dl.err = "";
            dl.load();
        });
    }
    Component.onCompleted: load()
    onVisibleChanged: if (visible) load()
    Timer { interval: 1000; repeat: true; running: dl.busy && dl.visible; onTriggered: dl.load() }

    Text {
        objectName: "downloadsOff"
        visible: !dl.on && !dl.only
        width: parent.width
        wrapMode: Text.Wrap
        text: "The download manager is switched off: switch on Download manager in Settings > Advanced and click Save. Models already downloaded keep working."
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }

    Repeater {
        model: dl.shown
        delegate: Rectangle {
            id: row
            required property var modelData
            readonly property var it: modelData
            objectName: "download:" + it.id
            width: dl.width
            height: 132
            radius: 8
            color: Theme.c.field
            border.color: Theme.c.border
            Column {
                anchors.fill: parent
                anchors.margins: Theme.sp.s
                spacing: Theme.sp.xs
                Row {
                    width: parent.width
                    spacing: Theme.sp.s
                    Text {
                        width: parent.width - btns.width - Theme.sp.s
                        text: row.it.name + "  ·  " + dl.mb(row.it.total)
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.body
                        font.weight: Font.DemiBold
                    }
                    Row {
                        id: btns
                        spacing: Theme.sp.xs
                        readonly property string s: row.it.state
                        UButton {
                            objectName: "downloadGo:" + row.it.id
                            visible: btns.s === "missing" || btns.s === "paused" || btns.s === "failed"
                            kind: "primary"
                            enabled: dl.on
                            text: btns.s === "missing" ? "Download" : "Resume"
                            tip: "Downloads " + row.it.name + " (" + dl.mb(row.it.total) + "). Not while live or recording."
                            onClicked: dl.act(row.it.id, btns.s === "missing" ? "start" : "resume")
                        }
                        UButton {
                            objectName: "downloadPause:" + row.it.id
                            visible: btns.s === "downloading" || btns.s === "queued"
                            text: "Pause"
                            tip: "Stops for now and keeps what is downloaded; Resume goes on from there."
                            onClicked: dl.act(row.it.id, "pause")
                        }
                        UButton {
                            objectName: "downloadCancel:" + row.it.id
                            visible: btns.s !== "missing" && btns.s !== "ready"
                            text: "Cancel"
                            tip: "Stops and deletes the partial download."
                            onClicked: dl.act(row.it.id, "cancel")
                        }
                    }
                }
                Text {
                    width: parent.width
                    height: 34
                    text: row.it.purpose
                    wrapMode: Text.Wrap
                    maximumLineCount: 2
                    elide: Text.ElideRight
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
                Rectangle { // progress: always there, so the row never changes height
                    width: parent.width
                    height: 6
                    radius: 3
                    color: Theme.c.border
                    Rectangle {
                        width: row.it.total > 0 ? parent.width * Math.min(1, row.it.done / row.it.total) : 0
                        height: parent.height
                        radius: 3
                        color: row.it.state === "failed" ? Theme.c.danger : Theme.c.accent
                    }
                }
                Text {
                    objectName: "downloadState:" + row.it.id
                    width: parent.width
                    text: dl.words(row.it)
                    elide: Text.ElideRight
                    color: row.it.state === "failed" ? Theme.c.danger : Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
                Text {
                    width: parent.width
                    text: "Licence: " + row.it.licence + "  ·  checked " + row.it.checked
                    elide: Text.ElideRight
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
            }
        }
    }

    Text {
        objectName: "downloadsError"
        visible: dl.err !== ""
        width: parent.width
        wrapMode: Text.Wrap
        text: dl.err
        color: Theme.c.danger
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
}
