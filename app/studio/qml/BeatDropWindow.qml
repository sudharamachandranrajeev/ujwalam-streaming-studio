// SPDX-License-Identifier: GPL-3.0-or-later
// BeatDrop review (BD7b, D420, flag beatdrop): the newest BeatDrop montage with a strip of its pieces (a kill on the
// beat, a move, or a calm piece), what it did in plain words, a play button for the H and the V video, and one-click
// retakes ("Another take", "Slower intro", "More third person", and "Swap this clip" on a piece). A click makes a new
// take at once, no question; "Making a new take..." shows while it works, then the new take. Its own window.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "beatdropDlg"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(860, parent ? parent.width - 40 : 860)
    implicitHeight: Math.min(560, parent ? parent.height - 40 : 560)
    title: "BeatDrop montage"
    closePolicy: Popup.CloseOnEscape

    property var data: ({ run: null, made: false, busy: false, summary: [], blocks: [], total: 0, retakes: [], h: null, v: null, source: false })
    property bool loaded: false
    property string note: ""
    property int selected: -1          // the piece picked on the strip (for "Swap this clip")
    property int gen: 0
    readonly property bool busy: data.busy === true
    readonly property bool made: data.made === true
    readonly property bool canRetake: made && !busy && data.source === true  // the recording it came from is still there

    function show() {
        gen++;
        selected = -1;
        note = "";
        open();
        load();
        return true;
    }
    onClosed: gen++
    function load() {
        const g = gen;
        Api.get("ui/api/beatdrop", (ok, b, err) => {
            if (g !== gen) return;
            loaded = true;
            if (!ok) { note = "Not available: " + err; return; }
            const wasBusy = data.busy === true;
            data = b;
            if (selected >= (b.blocks || []).length) selected = -1;
            if (wasBusy && !b.busy) note = b.made ? "Your new take is ready." : "";
        });
    }
    function retake(op, piece) {
        if (!canRetake) return false;
        const b = { run: data.run, op: op };
        if (op === "swap") b.piece = piece;
        const g = gen;
        note = "Making a new take...";
        data = Object.assign({}, data, { busy: true });
        Api.post("ui/api/beatdrop/retake", b, (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) { note = "Could not start a new take: " + err; load(); }
        });
        return true;
    }
    function play(layout) {
        if (!made) return false;
        Api.post("ui/api/beatdrop/play", { run: data.run, layout: layout }, (ok, r, err) => {
            if (!ok) note = "Could not open the video: " + err;
        });
        return true;
    }
    function kindText(k) { return k === "kill" ? "Kill on the beat" : k === "move" ? "Move" : "Calm" }
    function kindColor(k) { return k === "kill" ? Theme.c.accent : k === "move" ? Theme.c.accentHi : Theme.c.field }

    // Looks again while a take is being made (the new take shows when it is done).
    Timer {
        interval: 3000
        repeat: true
        running: dlg.opened && dlg.busy
        onTriggered: dlg.load()
    }

    // ---- probe (tests): beatdrop-open, beatdrop-retake:<op>, beatdrop-swap:<piece>, beatdrop-close ----
    function probe() {
        return { open: opened, run: data.run, made: made, busy: busy, summary: data.summary, blocks: (data.blocks || []).length, selected: selected, note: note };
    }
    function probeAction(a) {
        if (a === "beatdrop-open") return show();
        if (!opened) return false;
        if (a.startsWith("beatdrop-retake:")) return retake(a.slice(16), 0);
        if (a.startsWith("beatdrop-swap:")) { const n = parseInt(a.slice(14), 10); return n >= 1 && retake("swap", n) }
        if (a === "beatdrop-close") { close(); return true }
        return false;
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
    contentItem: Item {
        // One fixed block of text for the state, so nothing jumps when it changes.
        Text {
            id: stateText
            objectName: "beatdropState"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            height: 40
            wrapMode: Text.Wrap
            elide: Text.ElideRight
            color: dlg.busy ? Theme.c.accent : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 14
            text: dlg.busy ? "Making a new take..."
                : dlg.note !== "" ? dlg.note
                : !dlg.loaded ? "Loading..."
                : !dlg.made ? "No BeatDrop montage yet. One is made after the clips of each stream or recording."
                : dlg.data.source !== true ? "The recording this montage came from was deleted, so no new takes can be made."
                : "Pick a piece on the strip to swap it, or tap a button for a new take."
        }
        // The song strip: one block per piece, as wide as it plays.
        Rectangle {
            id: strip
            objectName: "beatdropStrip"
            anchors { left: parent.left; right: parent.right; top: stateText.bottom; topMargin: 6 }
            height: 56
            radius: Theme.radiusSmall
            color: Theme.c.bg
            border.width: 1
            border.color: Theme.c.border
            clip: true
            Repeater {
                model: dlg.made ? dlg.data.blocks : []
                delegate: Rectangle {
                    id: blk
                    required property var modelData
                    objectName: "beatdropBlock:" + modelData.n
                    readonly property real pxPerSec: dlg.data.total > 0 ? (strip.width - 2) / dlg.data.total : 0
                    x: 1 + modelData.start * pxPerSec
                    y: 1
                    width: Math.max(3, modelData.length * pxPerSec - 2)
                    height: strip.height - 2
                    radius: 3
                    color: dlg.kindColor(modelData.kind)
                    border.width: dlg.selected === modelData.n ? 3 : 0
                    border.color: Theme.c.text
                    opacity: dlg.busy ? 0.6 : 1
                    HoverHandler { id: bh }
                    ToolTip.visible: bh.hovered
                    ToolTip.text: dlg.kindText(modelData.kind) + ", piece " + modelData.n
                    TapHandler { onTapped: dlg.selected = dlg.selected === blk.modelData.n ? -1 : blk.modelData.n }
                }
            }
        }
        // The key, in words (no colour-only meaning).
        Row {
            id: key
            anchors { left: parent.left; top: strip.bottom; topMargin: 6 }
            spacing: 14
            Repeater {
                model: ["kill", "move", "calm"]
                delegate: Row {
                    required property string modelData
                    spacing: 5
                    Rectangle { width: 12; height: 12; radius: 3; color: dlg.kindColor(parent.modelData); border.width: 1; border.color: Theme.c.border; anchors.verticalCenter: parent.verticalCenter }
                    Text { text: dlg.kindText(parent.modelData); color: Theme.c.muted; font.family: Theme.family; font.pixelSize: 12 }
                }
            }
        }
        ListView {
            id: lines
            objectName: "beatdropSummary"
            anchors { left: parent.left; right: parent.right; top: key.bottom; topMargin: 8; bottom: parent.bottom }
            clip: true
            model: dlg.made ? dlg.data.summary : [] // the engine's summary already ends with the retakes made
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Text {
                required property string modelData
                width: ListView.view.width - 12
                text: modelData
                wrapMode: Text.Wrap
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: 14
                bottomPadding: 3
            }
        }
    }
    footer: Item {
        implicitHeight: 112
        Flow {
            anchors { left: parent.left; right: closeBtn.left; leftMargin: 18; rightMargin: 10; top: parent.top; topMargin: 8 }
            spacing: 8
            UButton { objectName: "beatdropPlayH"; text: "Play H video"; enabled: dlg.made && dlg.data.h !== null; tip: "Open the wide video in your video player."; onClicked: dlg.play("h") }
            UButton { objectName: "beatdropPlayV"; text: "Play V video"; enabled: dlg.made && dlg.data.v !== null; tip: "Open the tall video in your video player."; onClicked: dlg.play("v") }
        }
        Flow {
            anchors { left: parent.left; right: closeBtn.left; leftMargin: 18; rightMargin: 10; bottom: parent.bottom; bottomMargin: 10 }
            spacing: 8
            UButton { objectName: "beatdropAnother"; text: "Another take"; kind: "primary"; enabled: dlg.canRetake; tip: "Make the montage again with different clips on the beats."; onClicked: dlg.retake("another-take", 0) }
            UButton { objectName: "beatdropSlower"; text: "Slower intro"; enabled: dlg.canRetake; tip: "Make the montage again with a slower start."; onClicked: dlg.retake("slower-intro", 0) }
            UButton { objectName: "beatdropThird"; text: "More third person"; enabled: dlg.canRetake; tip: "Make the montage again with more third-person shots."; onClicked: dlg.retake("more-third-person", 0) }
            UButton {
                objectName: "beatdropSwap"
                text: dlg.selected > 0 ? "Swap clip " + dlg.selected : "Swap this clip"
                enabled: dlg.canRetake && dlg.selected > 0
                tip: "Pick a piece on the strip first, then swap just that clip for another."
                onClicked: dlg.retake("swap", dlg.selected)
            }
        }
        UButton {
            id: closeBtn
            objectName: "beatdropClose"
            anchors { right: parent.right; rightMargin: 18; bottom: parent.bottom; bottomMargin: 10 }
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
