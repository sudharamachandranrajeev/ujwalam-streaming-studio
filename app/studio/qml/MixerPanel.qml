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
        if (a.startsWith("mixer-stream:") || a.startsWith("mixer-remove:")) {
            const it = strip(a.slice(13));
            const btn = it ? (a.startsWith("mixer-stream:") ? it.streamBtn : it.removeBtn) : null;
            if (!btn || !btn.visible) return false;
            btn.clicked();
            return true;
        }
        return false;
    }

    function level(db) { return typeof db === "number" ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0 }

    ListView {
        id: list
        objectName: "mixerStrips"
        anchors.fill: parent
        orientation: ListView.Horizontal
        clip: true
        spacing: Theme.sp.m
        model: panel.strips
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.horizontal: ScrollBar { policy: ScrollBar.AsNeeded }
        Accessible.role: Accessible.List
        Accessible.name: "Audio mixer"
        delegate: Rectangle {
            id: strip
            required property var modelData
            readonly property string sid: modelData.id
            property alias volBox: vol
            property alias streamBtn: addStream
            property alias removeBtn: remove
            readonly property bool owned: typeof modelData.audioSource === "string" // a project audio source: removable
            readonly property bool inStream: panel.store.inStream(modelData)
            readonly property bool routable: panel.store.routing && owned
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
                text: strip.modelData.name
                maximumLineCount: 1
                elide: Text.ElideRight
                color: Theme.c.text
                font.family: Theme.family
                font.pixelSize: Theme.ty.body
                font.weight: Font.DemiBold
                ToolTip.visible: nameHover.hovered && truncated
                ToolTip.text: strip.modelData.name
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
                    tip: "Remove " + strip.modelData.name + " from the mixer"
                    onClicked: panel.store.removeAudio(strip.modelData.audioSource, strip.modelData.name)
                }
                UToggle {
                    objectName: "cue:" + strip.sid
                    text: "CUE"
                    checked: strip.modelData.cue === true
                    tip: strip.modelData.cueDelayed ? "Hear this in the headphones. This channel has video: its headphone sound is delayed to match the picture."
                                                    : "Hear this in the headphones"
                    onClicked: panel.store.setCue(strip.sid, checked)
                }
                UToggle {
                    objectName: "mute:" + strip.sid
                    text: checked ? "Muted" : "Mute"
                    onToken: "danger"
                    checked: strip.modelData.muted === true
                    tip: checked ? "Unmute: the stream and the recording hear it again" : "Mute: the stream and the recording do not hear it"
                    onClicked: panel.store.setMute(strip.sid, checked)
                }
            }
            // One row under the name, the same place in every state: not in the stream (with Add to stream), or the
            // track buttons (routing on), or "In the stream".
            Item {
                id: middle
                anchors { left: parent.left; right: parent.right; top: buttons.bottom; leftMargin: Theme.sp.m; rightMargin: Theme.sp.s; topMargin: Theme.sp.s }
                height: 28
                Text {
                    objectName: "streamState:" + strip.sid
                    visible: !strip.routable || !strip.inStream
                    anchors { left: parent.left; right: addStream.visible ? addStream.left : parent.right; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                    text: strip.inStream ? "In the stream" : "Not in the stream"
                    elide: Text.ElideRight
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                    font.weight: strip.inStream ? Font.Normal : Font.DemiBold
                }
                UButton {
                    id: addStream
                    objectName: "addToStream:" + strip.sid
                    visible: !strip.inStream
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    height: 28
                    kind: "primary"
                    text: "Add to stream"
                    tip: strip.modelData.cueDelayed ? "Put this sound in the stream and the recording. Its headphone sound (CUE) comes a little late, because it comes with video."
                                                    : "Put this sound in the stream and the recording"
                    onClicked: panel.store.addToStream(strip.sid)
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
                            checked: (strip.modelData.tracks || []).includes(modelData.id)
                            tip: index === 0 ? "Track 1: what the stream and the recording hear" : "Not used by the outputs yet"
                            onClicked: {
                                const on = strip.modelData.tracks || [];
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
                from: -60
                to: 0
                stepSize: 1
                decimals: 0
                unit: "dB"
                value: Math.max(-60, Math.min(0, typeof strip.modelData.volumeDb === "number" ? strip.modelData.volumeDb : 0))
                meter: panel.level(panel.store.peaks[strip.sid])
                label: "Volume of " + strip.modelData.name
                onCommitted: (v) => panel.store.setVolume(strip.sid, v)
            }
        }
    }
    Text {
        anchors.centerIn: list
        visible: panel.strips.length === 0
        text: "No sound yet. Click Add audio to add a mic, the capture card's audio or desktop sound."
        width: Math.min(implicitWidth, list.width - 2 * Theme.sp.m)
        wrapMode: Text.Wrap
        horizontalAlignment: Text.AlignHCenter
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }
}
