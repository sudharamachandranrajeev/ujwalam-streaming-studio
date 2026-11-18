// SPDX-License-Identifier: GPL-3.0-or-later
// Add audio (the mixer's heading button; D393 proposed, alpha.33 feedback "add option to add available audio channels"):
// one list of what can be added now, in three groups: inputs (mics, the capture card's audio, line-in), desktop and app
// sound (an output device), and layer sounds that have no mixer entry yet. The capture card's audio input is marked as
// the one for game sound (D221/D222: it is heard in the headphones at once; a capture layer's own sound comes late,
// because libobs holds it back to match the picture). Pick one, then Add (or double-click): it is added and put in the
// stream at once, with no question. A refusal stays in the window. Its own window (Popup.Window), so the native previews
// never cover it.
// AU1 (plan 2026-11-18): also one app's sound (listed by program name only, never a window title) and music from the
// stream assets folder: one file on repeat, or a folder played as a playlist.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "addAudioBox"
    required property var store
    property var rows: []
    property string pick: ""
    property string message: ""
    property bool devicesOff: false
    property bool mediaFolder: true
    property bool busy: false
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    anchors.centerIn: parent
    implicitWidth: 560
    implicitHeight: 440
    title: "Add audio"
    closePolicy: Popup.CloseOnEscape

    readonly property var pickRow: rows.find(r => r.key === pick) || null

    // choices: the GET /ui/api/audio/choices answer.
    function ask(choices) {
        const out = [];
        for (const i of choices.inputs || [])
            out.push({ key: i.key, label: i.name, group: "Inputs: mics, capture card audio, line-in", note: i.recommended ? "Best for game sound: heard in the headphones at once" : "" });
        for (const o of choices.outputs || [])
            out.push({ key: o.key, label: o.name, group: "Desktop and app sound", note: "What this PC plays on this device" });
        for (const l of choices.layers || [])
            out.push({ key: l.key, label: l.name, group: "Layer sounds", note: l.cueDelayed ? "Its headphone sound (CUE) comes a little late: it comes with video" : "" });
        // AU1: one app's sound (by program name only) and sound files / folder playlists from the media folder
        for (const a of choices.apps || [])
            out.push({ key: a.key, label: a.name, group: "One app's sound", note: a.sound ? "Playing sound now. Only this app is heard, not the rest of the PC" : "Only this app is heard, not the rest of the PC" });
        for (const f of choices.folders || [])
            out.push({ key: f.key, label: f.name, group: "Music: a folder as a playlist", note: f.count + (f.count === 1 ? " sound file" : " sound files") + ", played in turn and repeated" });
        for (const f of choices.files || [])
            out.push({ key: f.key, label: f.name, group: "Music: one sound file", note: "Plays on repeat" });
        mediaFolder = choices.mediaFolder !== false;
        rows = out;
        devicesOff = choices.devicesOff === true;
        message = "";
        busy = false;
        pick = out.length ? out[0].key : "";
        open();
    }
    function send() {
        if (!pickRow || busy) { if (!pickRow) message = "Pick a sound first."; return; }
        busy = true;
        message = "";
        store.addAudio(pick, (ok, why) => {
            busy = false;
            if (ok) close();
            else message = why;
        });
    }
    // Probe (tests): add-audio-pick:<index>, add-audio-send.
    function probeAction(a) {
        if (a.startsWith("add-audio-pick:")) { const i = Number(a.slice(15)); if (!(i >= 0 && i < rows.length)) return false; pick = rows[i].key; return true }
        if (a === "add-audio-send") { if (!opened) return false; send(); return true }
        return false;
    }
    function probe() { return { open: opened, rows: rows.map(r => ({ label: r.label, group: r.group, note: r.note })), pick: rows.findIndex(r => r.key === pick), message: message, devicesOff: devicesOff } }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: Theme.sp.l
        bottomPadding: Theme.sp.s
        elide: Text.ElideRight
        color: Theme.c.text
        font.family: Theme.ty.displayFamily
        font.pixelSize: Theme.ty.subtitle
        font.weight: Font.DemiBold
    }
    contentItem: Item {
        Text {
            id: about
            objectName: "addAudioAbout"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            text: dlg.message !== "" ? dlg.message
                : dlg.devicesOff ? "Devices are switched off in this start of Ujwalam, so only layer sounds and music files are listed."
                : "Pick a sound. It goes into the stream and the recording at once. Music comes from your stream assets folder"
                  + (dlg.mediaFolder ? "." : " (none is set).")
            wrapMode: Text.Wrap
            color: dlg.message !== "" ? Theme.c.danger : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        ListView {
            id: choiceList
            objectName: "addAudioChoices"
            anchors { left: parent.left; right: parent.right; top: about.bottom; topMargin: Theme.sp.m; bottom: parent.bottom }
            clip: true
            spacing: 2
            model: dlg.rows
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Accessible.role: Accessible.List
            Accessible.name: "Sounds to add"
            section.property: "group"
            section.delegate: Text {
                required property string section
                width: ListView.view.width
                height: 28
                verticalAlignment: Text.AlignBottom
                bottomPadding: 4
                text: section
                elide: Text.ElideRight
                color: Theme.c.muted
                font.family: Theme.family
                font.pixelSize: Theme.ty.caption
                font.weight: Font.DemiBold
            }
            delegate: ItemDelegate {
                id: cd
                required property var modelData
                required property int index
                readonly property bool cur: modelData.key === dlg.pick
                objectName: "audioChoice:" + index
                width: ListView.view.width - 4
                height: modelData.note !== "" ? 46 : 32
                hoverEnabled: true
                Accessible.name: modelData.label + (modelData.note !== "" ? ", " + modelData.note : "")
                onClicked: dlg.pick = modelData.key
                onDoubleClicked: { dlg.pick = modelData.key; dlg.send() }
                background: Rectangle {
                    radius: Theme.radiusSmall
                    color: cd.cur ? Qt.alpha(Theme.c.accent, 0.2) : cd.hovered ? Theme.c.field : "transparent"
                    border.width: cd.cur || cd.visualFocus ? 1 : 0
                    border.color: cd.visualFocus ? Theme.c.accentHi : Theme.c.accent
                }
                contentItem: Item {
                    Text {
                        id: nameText
                        anchors { left: parent.left; right: parent.right; top: parent.top; topMargin: cd.modelData.note !== "" ? 2 : 0; bottom: cd.modelData.note !== "" ? undefined : parent.bottom }
                        text: cd.modelData.label
                        verticalAlignment: Text.AlignVCenter
                        elide: Text.ElideMiddle
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.body
                    }
                    Text {
                        visible: cd.modelData.note !== ""
                        anchors { left: parent.left; right: parent.right; top: nameText.bottom; topMargin: 2 }
                        text: cd.modelData.note
                        elide: Text.ElideRight
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: Theme.ty.caption
                    }
                }
            }
        }
        Text {
            anchors.centerIn: choiceList
            width: choiceList.width
            visible: dlg.rows.length === 0
            text: "Nothing new to add: every connected sound is in the mixer already."
            wrapMode: Text.Wrap
            horizontalAlignment: Text.AlignHCenter
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }
    footer: Item {
        implicitHeight: 64
        Row {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            spacing: Theme.sp.m
            UButton {
                objectName: "addAudioClose"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                objectName: "addAudioOk"
                text: "Add"
                kind: "primary"
                enabled: !!dlg.pickRow && !dlg.busy
                onClicked: dlg.send()
            }
        }
    }
}
