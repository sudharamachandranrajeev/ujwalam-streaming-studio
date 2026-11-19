// SPDX-License-Identifier: GPL-3.0-or-later
// A scene's Music row (MU2, plan 2026-11-18-audio-mixer-music): music on or off in this scene, its mood, its level, and
// a Listen button (off air only: it plays the bed on this PC's speakers, never in the stream). Every change is sent at
// once and heard at once, also on air; switching scenes fades the music with the transition. The first time music is
// switched on the mixer gets one "Music" strip (with "Duck music under my voice" when a microphone is in the mixer).
// Moods are the MU1 beds made off air; a mood whose music is not made yet says so. Opened from the scene menu
// ("Music…"). Its own window (Popup.Window), so the native previews never cover it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "sceneMusicBox"
    required property var store
    property string scene: ""
    property string sceneName: ""
    property var moods: []        // [{id, title, status, made}]
    property var music: ({ on: false, mood: "lobby", volumeDb: 0 })
    property var range: [-40, 0]
    property var now: null        // host music.status
    property string previewing: ""
    property string message: ""
    property bool busy: false
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: 560
    implicitHeight: 520
    title: "Music: " + sceneName
    closePolicy: Popup.CloseOnEscape

    // info: the GET /ui/api/music answer; fallbackMood: the default for a scene that never had music.
    function ask(info, sceneId, fallbackMood) {
        scene = sceneId;
        const sc = (info.scenes || []).find(s => s.id === sceneId) || { name: sceneId, music: null };
        sceneName = sc.name;
        moods = info.moods || [];
        range = info.volumeDb || [-40, 0];
        music = sc.music ? JSON.parse(JSON.stringify(sc.music)) : { on: false, mood: fallbackMood, volumeDb: 0 };
        now = info.now || null;
        previewing = info.previewing || "";
        message = "";
        busy = false;
        open();
    }
    function moodOf(id) { return moods.find(m => m.id === id) }
    function status() {
        if (message !== "") return message;
        const m = moodOf(music.mood);
        if (!music.on) return "Music is off in this scene. Switch it on to play a mood when this scene is shown.";
        if (m && !m.made) return "The music for \"" + m.title + "\" is not made yet, so this scene plays nothing. Make the music library off air.";
        if (now && now.scene === scene && now.reason) return now.reason;
        return "Plays when this scene is shown and fades with the scene transition. Heard at once, also on air.";
    }
    function send(patch) {
        if (busy) { message = "The last change is still on its way."; return; }
        busy = true;
        message = "";
        const before = music;
        const next = Object.assign(JSON.parse(JSON.stringify(music)), patch);
        music = next; // shown at once; set back when refused
        store.setSceneMusic(scene, next, (ok, why, b) => {
            busy = false;
            if (!ok) music = before;
            else if (b && b.now) now = b.now;
            message = why;
        });
    }
    function listen() {
        const want = previewing === music.mood ? null : music.mood;
        store.previewSceneMusic(want, (ok, why) => {
            if (ok) previewing = want || "";
            message = why;
        });
    }

    // Probe (tests): music-on, music-off, music-mood:<id>, music-volume:<dB>, music-listen
    function probeAction(a) {
        if (!opened) return false;
        if (a === "music-on") { send({ on: true }); return true }
        if (a === "music-off") { send({ on: false }); return true }
        if (a.startsWith("music-mood:")) { const id = a.slice(11); if (!moodOf(id)) return false; send({ mood: id }); return true }
        if (a.startsWith("music-volume:")) { const v = Number(a.slice(13)); if (!(v >= range[0] && v <= range[1])) return false; send({ volumeDb: v }); return true }
        if (a === "music-listen") { if (store.live) return false; listen(); return true }
        return false;
    }
    function probe() { return { open: opened, scene: scene, music: music, moods: moods.map(m => m.id), made: moods.filter(m => m.made).map(m => m.id), status: status(), previewing: previewing, listenEnabled: !store.live } }

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
    contentItem: Column {
        spacing: Theme.sp.m
        Text {
            objectName: "sceneMusicStatus"
            width: parent.width
            height: 40 // one fixed height: a message never moves the row
            text: dlg.status()
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
            color: dlg.message !== "" ? Theme.c.danger : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        USwitch {
            objectName: "sceneMusicOn"
            width: parent.width
            text: "Music in this scene"
            hint: "Plays the chosen mood while this scene is shown; switching scenes fades it with the transition."
            checked: dlg.music.on === true
            enabled: !dlg.busy
            onClicked: dlg.send({ on: checked })
        }
        Text {
            text: "Mood"
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: Theme.ty.body
        }
        Flow {
            width: parent.width
            spacing: Theme.sp.s
            Repeater {
                model: dlg.moods
                delegate: UButton {
                    required property var modelData
                    objectName: "sceneMusicMood:" + modelData.id
                    text: (dlg.music.mood === modelData.id ? "✓ " : "") + modelData.title + (modelData.made ? "" : " (not made yet)")
                    tip: modelData.made ? "Use this mood in this scene" : "This mood's music is not made yet: make the music library off air"
                    enabled: !dlg.busy && dlg.music.on === true
                    onClicked: dlg.send({ mood: modelData.id })
                }
            }
        }
        UValueSlider {
            objectName: "sceneMusicVolume"
            width: parent.width
            enabled: dlg.music.on === true && !dlg.busy // shown while off: nothing moves
            from: dlg.range[0]
            to: dlg.range[1]
            stepSize: 1
            decimals: 0
            label: "Music level in this scene"
            unit: " dB"
            value: Number(dlg.music.volumeDb)
            onCommitted: (v) => dlg.send({ volumeDb: Math.round(v) })
        }
        UButton {
            objectName: "sceneMusicListen"
            text: dlg.previewing !== "" && dlg.previewing === dlg.music.mood ? "Stop listening" : "Listen"
            tip: dlg.store.live ? "Only off air: listening plays on this PC's speakers" : "Plays this mood on this PC's speakers, not in the stream"
            enabled: !dlg.store.live && dlg.moodOf(dlg.music.mood) !== undefined && dlg.moodOf(dlg.music.mood).made === true
            onClicked: dlg.listen()
        }
    }
    footer: Item {
        implicitHeight: 64
        UButton {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            objectName: "sceneMusicClose"
            text: "Close"
            onClicked: { if (dlg.previewing !== "") dlg.store.previewSceneMusic(null, () => {}); dlg.previewing = ""; dlg.close() }
        }
    }
}
