// SPDX-License-Identifier: GPL-3.0-or-later
// The mixer (plan Q2): one strip per sound with its full name, CUE (hear it in the headphones), Mute, the track
// buttons when routing is on (D273), the level and the volume. Volume, mute and CUE are saved into the project (D358).
// Every sound the host meters has a strip (alpha.33 feedback: the game capture's sound had none). A sound that is not
// in the stream mix says so on its strip, with one "Add to stream" button. "Add audio" in the heading adds a mic, the
// capture card's audio input, desktop sound or a layer's sound; the bin on a strip removes it from the mixer (D393
// proposed; one click each, no question, also while live). Each strip keeps the same rows in the same places whatever
// its state, so nothing moves when a button is clicked.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    required property var store
    title: "Audio mixer"

    // B4 (2026-11-18): the strips are keyed by id (store.mixerIds); a refresh changes a strip's row, never the strip.
    readonly property var strips: store.mixer

    tools: [
        UButton {
            objectName: "addAudio"
            text: "Add audio"
            iconName: "plus"
            height: 28
            tip: "Add a sound: a mic, the capture card's audio, desktop sound or a layer's sound"
            onClicked: panel.store.openAddAudio()
        }
    ]

    // ---- probe (tests): volume-type:<strip id>:<dB> (typed into the real box, then Enter);
    // mixer-stream:<strip id> and mixer-remove:<strip id> (the strip's own buttons) ----
    function probeAction(a) {
        const strip = (sid) => {
            for (let k = 0; k < list.count; k++) {
                const it = list.itemAtIndex(k);
                if (it && it.sid === sid) return it;
            }
            return null;
        };
        if (a.startsWith("volume-type:")) {
            const i = a.lastIndexOf(":"), it = strip(a.slice(12, i));
            return it ? it.volBox.typeValue(a.slice(i + 1)) : false;
        }
        if (a.startsWith("mixer-stream:") || a.startsWith("mixer-remove:") || a.startsWith("mixer-retry:")) {
            const it = strip(a.slice(a.indexOf(":") + 1));
            const btn = it ? (a.startsWith("mixer-stream:") ? it.streamBtn : a.startsWith("mixer-retry:") ? it.retryBtn : it.removeBtn) : null;
            if (!btn || !btn.visible) return false;
            btn.clicked();
            return true;
        }
        return false;
    }

    // The fader and the level share one scale, -60..+12 dB (B5, 2026-11-18), so the 0 dB tick is where a full-scale
    // level ends: a level past it is red.
    readonly property real minDb: -60
    readonly property real maxDb: 12
    readonly property real zeroAt: -minDb / (maxDb - minDb)
    function level(db) { return typeof db === "number" ? Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb))) : 0 }

    ListView {
        id: list
        objectName: "mixerStrips"
        anchors.fill: parent
        orientation: ListView.Horizontal
        clip: true
        spacing: Theme.sp.m
        model: panel.store.mixerIds
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.horizontal: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Audio mixer"
        delegate: Rectangle {
            id: strip
            required property string sid
            readonly property var row: panel.store.mixerById[sid] || ({ id: sid, name: "" })
            property alias volBox: vol
            property alias streamBtn: addStream
            property alias removeBtn: remove
            property alias retryBtn: retry
            readonly property bool owned: typeof row.audioSource === "string" // a project audio source: removable
            // A2: a project device sound whose device is not connected (or did not open): says so, with Try again
            readonly property bool waiting: row.waiting === true
            // B7: the same device's sound is in the mix already through another channel
            readonly property string sameAs: typeof row.sameAs === "string" ? row.sameAs : ""
            readonly property bool inStream: !waiting && panel.store.inStream(row)
            readonly property bool routable: panel.store.routing && owned && !waiting
            // B8: a peak-hold marker that stays 1.5 s on the highest level, then follows the level
            readonly property real lvl: panel.level(panel.store.peaks[sid])
            property real holdLvl: 0
            property double holdAt: 0
            onLvlChanged: {
                const now = Date.now();
                if (lvl >= holdLvl || now - holdAt > 1500) { holdLvl = lvl; holdAt = now; }
            }
            Component.onCompleted: panel.store.pStripsMade++
            objectName: "strip:" + sid
            width: 300
            height: ListView.view.height - 12
            radius: Theme.radiusMedium
            color: Theme.c.field
            border.width: 1
            border.color: inStream ? Theme.c.border : Theme.c.accent // a warning edge, as the alert strip draws one

            Text {
                id: label
                objectName: "stripName:" + strip.sid
                anchors { left: parent.left; right: buttons.left; verticalCenter: buttons.verticalCenter; leftMargin: Theme.sp.m; rightMargin: Theme.sp.s }
                text: strip.row.name
                maximumLineCount: 1
                elide: Text.ElideRight
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: Theme.ty.body
                font.weight: Font.DemiBold
                ToolTip.visible: nameHover.hovered && truncated
                ToolTip.text: strip.row.name
                HoverHandler { id: nameHover }
            }
            Row {
                id: buttons
                anchors { right: parent.right; top: parent.top; margins: Theme.sp.s }
                spacing: Theme.sp.s
                UIconButton {
                    id: remove
                    objectName: "removeAudio:" + strip.sid
                    visible: strip.owned
                    iconName: "trash"
                    size: 30
                    tip: "Remove " + strip.row.name + " from the mixer"
                    onClicked: panel.store.removeAudio(strip.row.audioSource, strip.row.name)
                }
                UToggle {
                    objectName: "cue:" + strip.sid
                    text: "CUE"
                    enabled: !strip.waiting
                    checked: strip.row.cue === true
                    tip: strip.row.cueDelayed ? "Hear this in the headphones. This channel has video: its headphone sound is delayed to match the picture."
                                                    : "Hear this in the headphones"
                    onClicked: panel.store.setCue(strip.sid, checked)
                }
                UToggle {
                    objectName: "mute:" + strip.sid
                    text: checked ? "Muted" : "Mute"
                    onToken: "danger"
                    enabled: !strip.waiting
                    checked: strip.row.muted === true
                    tip: checked ? "Unmute: the stream and the recording hear it again" : "Mute: the stream and the recording do not hear it"
                    onClicked: panel.store.setMute(strip.sid, checked)
                }
            }
            // One row under the name, the same place in every state: not in the stream (with Add to stream), or the
            // track buttons (routing on), or "In the stream"; waiting for its device (with Try again, A2/A3), or already in
            // the mix through another channel of the same device (B7, no Add to stream: it would be heard twice).
            Item {
                id: middle
                anchors { left: parent.left; right: parent.right; top: buttons.bottom; leftMargin: Theme.sp.m; rightMargin: Theme.sp.s; topMargin: Theme.sp.s }
                height: 28
                Text {
                    objectName: "streamState:" + strip.sid
                    visible: !strip.routable || !strip.inStream
                    anchors { left: parent.left; right: addStream.visible ? addStream.left : retry.visible ? retry.left : parent.right; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                    text: strip.waiting ? (strip.row.message || "Waiting for its device.")
                        : strip.sameAs !== "" ? "Already in the mix as " + strip.sameAs
                        : strip.inStream ? "In the stream" : "Not in the stream"
                    elide: Text.ElideRight
                    ToolTip.visible: stateHover.hovered && truncated
                    ToolTip.text: text
                    HoverHandler { id: stateHover }
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                    font.weight: strip.inStream ? Font.Normal : Font.DemiBold
                }
                UButton {
                    id: addStream
                    objectName: "addToStream:" + strip.sid
                    visible: !strip.inStream && !strip.waiting && strip.sameAs === ""
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    height: 28
                    kind: "primary"
                    text: "Add to stream"
                    tip: strip.row.cueDelayed ? "Put this sound in the stream and the recording. Its headphone sound (CUE) comes a little late, because it comes with video."
                                                    : "Put this sound in the stream and the recording"
                    onClicked: panel.store.addToStream(strip.sid)
                }
                UButton {
                    id: retry
                    objectName: "retryAudio:" + strip.sid
                    visible: strip.waiting
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    height: 28
                    text: "Try again"
                    tip: "Look for this device again now (Ujwalam also does it by itself when a device is plugged in)"
                    onClicked: panel.store.rescanDevices()
                }
                Row {
                    id: trackRow
                    visible: strip.routable && strip.inStream
                    anchors { left: parent.left; verticalCenter: parent.verticalCenter }
                    spacing: Theme.sp.xs
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: "Tracks"
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.caption
                    }
                    Repeater {
                        model: trackRow.visible ? panel.store.tracks : []
                        UToggle {
                            required property var modelData
                            required property int index
                            objectName: "track:" + strip.sid + ":" + modelData.id
                            text: modelData.name
                            height: 28
                            checked: (strip.row.tracks || []).includes(modelData.id)
                            tip: index === 0 ? "Track 1: what the stream and the recording hear" : "Not used by the outputs yet"
                            onClicked: {
                                const on = strip.row.tracks || [];
                                const tid = modelData.id, want = checked;
                                // keep the project's track order
                                panel.store.setTracks(strip.sid, panel.store.tracks.map(t => t.id).filter(x => x === tid ? want : on.includes(x)));
                            }
                        }
                    }
                }
            }
            // The shared slider (D330): click, drag, typed dB + Enter, the wheel only with focus; one send per change.
            UValueSlider {
                id: vol
                objectName: "vol:" + strip.sid
                anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: Theme.sp.m }
                // -60..+12 dB with a 0 dB tick; at the bottom it is Off (no volume: the host answers null). B5, 2026-11-18.
                from: panel.minDb
                to: panel.maxDb
                stepSize: 1
                decimals: 0
                unit: "dB"
                fromText: "Off"
                enabled: !strip.waiting
                value: Math.max(panel.minDb, Math.min(panel.maxDb, typeof strip.row.volumeDb === "number" ? strip.row.volumeDb : panel.minDb))
                meter: strip.lvl
                hold: strip.holdLvl
                mark: panel.zeroAt
                label: "Volume of " + strip.row.name
                onCommitted: (v) => panel.store.setVolume(strip.sid, v <= panel.minDb ? -100 : v)
            }
        }
    }
    Text {
        anchors.centerIn: list
        visible: panel.store.mixerIds.count === 0
        text: "No sound yet. Click Add audio to add a mic, the capture card's audio or desktop sound."
        width: Math.min(implicitWidth, list.width - 2 * Theme.sp.m)
        wrapMode: Text.Wrap
        horizontalAlignment: Text.AlignHCenter
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
}
