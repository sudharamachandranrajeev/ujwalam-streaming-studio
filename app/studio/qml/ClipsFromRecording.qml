// SPDX-License-Identifier: GPL-3.0-or-later
// Clips menu > "Make clips from a recording..." (2026-11-27). Recent recordings that have no finished clips (a stopped or failed
// run counts as not finished), newest first. One click on "Make clips" queues the job in the same clip queue as every other
// (ui/api/clips/make); it starts when nothing is recording or live and reuses what an earlier run already found. Not modal.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "clipsFromRecording"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(560, parent ? parent.width - 40 : 560)
    implicitHeight: Math.min(480, parent ? parent.height - 40 : 480)
    title: "Make clips from a recording"
    closePolicy: Popup.CloseOnEscape

    property var items: []
    property string info: "Loading..."
    property var asked: ({})   // names already queued from this window
    function show() {
        info = "Loading...";
        items = [];
        asked = ({});
        open();
        store.loadClipRecordings((list, err) => {
            items = list;
            info = err !== "" ? "Could not read your recordings: " + err
                : list.length === 0 ? "Every recent recording already has clips, or there is no recording yet." : "";
        });
        return true;
    }
    function when(ms) { return Qt.formatDateTime(new Date(ms), "ddd d MMM, hh:mm") }
    function make(name) {
        if (asked[name]) return false;
        const m = Object.assign({}, asked); m[name] = true; asked = m;
        store.makeClipsFrom(name, (ok) => { if (!ok) { const k = Object.assign({}, dlg.asked); delete k[name]; dlg.asked = k } });
        return true;
    }

    // ---- probe (tests): clips-recording-make:<name> ----
    function probe() { return { open: opened, info: info, names: items.map(x => x.name), asked: Object.keys(asked) } }
    function probeAction(a) {
        if (!a.startsWith("clips-recording-make:") || !opened) return false;
        return make(a.slice(21));
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Column {
        spacing: 10
        Text {
            width: parent.width
            text: "Pick a recording. Ujwalam finds the best moments in it and makes clips. Work already done is reused."
            wrapMode: Text.Wrap
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Text {
            visible: dlg.info !== ""
            width: parent.width
            text: dlg.info
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        ListView {
            id: list
            width: parent.width
            height: Math.max(0, dlg.implicitHeight - 190)
            clip: true
            spacing: 6
            model: dlg.items
            delegate: Rectangle {
                id: row
                required property var modelData
                width: list.width
                height: 48
                radius: Theme.radiusMedium
                color: Theme.c.field
                border.width: 1
                border.color: Theme.c.border
                Column {
                    anchors { left: parent.left; leftMargin: 12; right: go.left; rightMargin: 8; verticalCenter: parent.verticalCenter }
                    Text {
                        width: parent.width
                        text: dlg.when(row.modelData.at)
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 14
                    }
                    Text {
                        width: parent.width
                        text: row.modelData.sizeMb + " MB" + (row.modelData.hasV ? ", with the portrait (V) recording" : ", horizontal only")
                        elide: Text.ElideRight
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 12
                    }
                }
                UButton {
                    id: go
                    objectName: "clipsRecordingMake:" + row.modelData.name
                    anchors { right: parent.right; rightMargin: 10; verticalCenter: parent.verticalCenter }
                    enabled: !dlg.asked[row.modelData.name]
                    text: dlg.asked[row.modelData.name] ? "Queued" : "Make clips"
                    kind: "primary"
                    implicitHeight: 28
                    focusPolicy: Qt.NoFocus
                    onClicked: dlg.make(row.modelData.name)
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        UButton { objectName: "clipsRecordingClose"; anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter } text: "Close"; onClicked: dlg.close() }
    }
}
