// SPDX-License-Identifier: GPL-3.0-or-later
// Settings > Clips (the widget's Clips page, D284/D334/D350/D352/RP1): when to make clips, record while live, which matches
// get clips, and per reel type its length, its opening and the join between its pieces. Every control edits the dialog's
// draft; Save sends only what the widget window would send.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Column {
    id: cp
    required property var box
    width: parent ? parent.width : 0
    spacing: Theme.sp.m
    readonly property var d: box.draft
    readonly property var reelInfo: box.info.reelLengths || {}
    readonly property var hookInfo: box.info.reelHooks || {}
    readonly property var clipsState: box.info.clips || {}

    component Words: Text {
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: Theme.ty.body
    }
    component Quiet: Text {
        width: parent ? parent.width : 0
        wrapMode: Text.Wrap
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
    }

    UCard {
        title: "WHEN TO MAKE CLIPS"
        Repeater {
            model: [{ key: "recording", name: "settingsRecording", label: "When I record:" }, { key: "live", name: "settingsLive", label: "When I stream live:" }]
            delegate: Column {
                id: mr
                required property var modelData
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: mr.modelData.label }
                UCombo {
                    objectName: mr.modelData.name
                    width: Math.min(parent.width, 520)
                    label: mr.modelData.label
                    model: cp.box.modes.map(m => ({ value: m.value, text: mr.modelData.key === "live" ? m.live : m.rec }))
                    currentIndex: Math.max(0, cp.box.modes.findIndex(m => m.value === cp.d[mr.modelData.key]))
                    onChose: (v) => cp.box.set(mr.modelData.key, v)
                }
            }
        }
        Text {
            objectName: "settingsClipsUnavailable"
            visible: cp.clipsState.available === false
            width: parent.width
            wrapMode: Text.Wrap
            text: "Clips can't be made on this PC yet: " + (cp.clipsState.reason || "") + (cp.clipsState.fix ? ". " + cp.clipsState.fix : "")
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }

    // Spoken captions need the speech model (download manager, 2026-11-19): offered here while it is missing.
    UCard {
        title: "SPOKEN CAPTIONS"
        visible: captionsOffer.visible
        DownloadsList { id: captionsOffer; objectName: "captionsOffer"; only: "speech-captions" }
    }

    UCard {
        title: "WHILE I STREAM"
        USwitch {
            objectName: "settingsRecordLive"
            width: parent.width
            text: "Record while live"
            hint: "Records the stream (H and V) to your recordings folder so reels can be made after it ends. Uses about 10 GB per hour."
            checked: cp.d.recordLive === true
            onToggled: cp.box.set("recordLive", checked)
        }
    }

    UCard {
        title: "WHICH MATCHES GET CLIPS"
        USwitch {
            objectName: "settingsTop3"
            width: parent.width
            text: "Only make clips from matches where I finish in the top 3"
            checked: cp.d.top3 === true
            onToggled: cp.box.set("top3", checked)
        }
        Row {
            spacing: Theme.sp.m
            USwitch {
                objectName: "settingsKillsOn"
                wrap: false
                anchors.verticalCenter: parent.verticalCenter
                text: "...or where I get at least"
                checked: cp.d.killsOn === true
                onToggled: cp.box.set("killsOn", checked)
            }
            USpin {
                objectName: "settingsKills"
                anchors.verticalCenter: parent.verticalCenter
                label: "Kills"
                from: 1
                to: 99
                suffix: " kills"
                enabled: cp.d.killsOn === true
                value: cp.d.kills || 5
                onValueModified: cp.box.set("kills", value)
            }
        }
    }

    UCard {
        title: "REEL LENGTH"
        visible: (cp.reelInfo.types || []).length > 0
        Quiet {
            text: "A reel longer than its maximum is split into parts (part 1 of 2, part 2 of 2) between clips. The maximum is at most " +
                  (cp.reelInfo.limitMaxSec || 60) + " seconds for now."
        }
        Repeater {
            model: cp.reelInfo.types || []
            delegate: Column {
                id: rr
                required property var modelData
                readonly property var v: (cp.d.reel || {})[modelData.id] || { lo: 0, hi: 5 }
                readonly property int limit: cp.reelInfo.limitMaxSec || 60
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: rr.modelData.label }
                Row {
                    spacing: Theme.sp.s
                    Words { text: "Shortest"; anchors.verticalCenter: parent.verticalCenter }
                    USpin {
                        objectName: "reelMin_" + rr.modelData.id
                        label: rr.modelData.label + " shortest"
                        from: 0
                        to: rr.limit
                        suffix: " s"
                        value: rr.v.lo
                        onValueModified: cp.box.setIn("reel", rr.modelData.id, "lo", value)
                    }
                    Words { text: "Longest"; anchors.verticalCenter: parent.verticalCenter }
                    USpin {
                        objectName: "reelMax_" + rr.modelData.id
                        label: rr.modelData.label + " longest"
                        from: 5
                        to: rr.limit
                        suffix: " s"
                        value: rr.v.hi
                        onValueModified: cp.box.setIn("reel", rr.modelData.id, "hi", value)
                    }
                }
                Quiet { visible: !!rr.modelData.hint; text: rr.modelData.hint || "" }
            }
        }
        Text {
            objectName: "settingsReelError"
            visible: cp.box.reelError !== ""
            width: parent.width
            wrapMode: Text.Wrap
            text: cp.box.reelError
            color: Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        UButton {
            objectName: "settingsReelReset"
            text: "Reset to defaults"
            onClicked: {
                const m = {};
                for (const t of (cp.reelInfo.types || [])) m[t.id] = { lo: Math.round(t.defaultMinSec), hi: Math.round(t.defaultMaxSec) };
                cp.box.set("reel", m);
            }
        }
    }

    UCard {
        title: "REEL OPENING"
        visible: (cp.hookInfo.types || []).length > 0
        Quiet {
            text: "Opens each reel on its best moment (the best kill or the multi-kill) in the first seconds, then plays it in order. " +
                  "A short teaser of that moment plays first where the reel tells a story. The teaser counts toward the longest length. " +
                  "Works while the " + cp.box.flagLabel("reel-hook") + " switch is on."
        }
        Repeater {
            model: cp.hookInfo.types || []
            delegate: Column {
                id: hr
                required property var modelData
                readonly property var v: (cp.d.hooks || {})[modelData.id] || { on: true, sec: 2 }
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: hr.modelData.label }
                Quiet {
                    text: hr.modelData.strategy === "reorder" ? "The clip with the best moment moves to the front; a teaser only when that moment is deep inside it."
                                                              : "A teaser of the best moment plays first, then the reel from its start."
                }
                Row {
                    spacing: Theme.sp.m
                    USwitch {
                        objectName: "hookOn_" + hr.modelData.id
                        wrap: false
                        anchors.verticalCenter: parent.verticalCenter
                        text: "Open with the best moment"
                        Accessible.name: hr.modelData.label + " open with the best moment"
                        checked: hr.v.on === true
                        onToggled: cp.box.setIn("hooks", hr.modelData.id, "on", checked)
                    }
                    Words { text: "Teaser"; anchors.verticalCenter: parent.verticalCenter }
                    USpin {
                        objectName: "hookSec_" + hr.modelData.id
                        anchors.verticalCenter: parent.verticalCenter
                        label: hr.modelData.label + " teaser length"
                        from: cp.hookInfo.teaserMin || 1
                        to: cp.hookInfo.teaserMax || 3
                        suffix: " s"
                        enabled: hr.v.on === true
                        value: hr.v.sec
                        onValueModified: cp.box.setIn("hooks", hr.modelData.id, "sec", value)
                    }
                }
            }
        }
        UButton {
            objectName: "settingsHookReset"
            text: "Reset to defaults"
            onClicked: {
                const m = {};
                for (const t of (cp.hookInfo.types || [])) m[t.id] = { on: t.defaultOn !== false, sec: typeof t.defaultTeaserSec === "number" ? t.defaultTeaserSec : 2 };
                cp.box.set("hooks", m);
            }
        }
    }

    UCard {
        title: "REEL TRANSITION"
        visible: cp.box.transKinds().length > 0
        Quiet {
            text: "How one piece of a reel joins the next. A cross fade overlaps the two pieces, so each join makes the reel that much shorter. " +
                  "A reel with burned-in captions keeps the cut. Works while the " + cp.box.flagLabel("reel-transitions") + " switch is on."
        }
        Words { text: "Transition between pieces" }
        Row {
            spacing: Theme.sp.s
            UCombo {
                id: kind
                objectName: "settingsTransKind"
                width: 220
                label: "Transition between pieces"
                model: cp.box.transKinds().map(k => ({ value: k.id, text: k.label }))
                currentIndex: Math.max(0, cp.box.transKinds().findIndex(k => k.id === cp.d.transKind))
                onChose: (v) => cp.box.pickKind(v)
            }
            Words { text: "Length"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                readonly property var range: cp.box.kindRange(cp.d.transKind)
                objectName: "settingsTransMs"
                anchors.verticalCenter: parent.verticalCenter
                label: "Transition length"
                enabled: !!range
                from: range ? range.min : 0
                to: range ? range.max : 0
                stepSize: 50
                suffix: " ms"
                value: range ? cp.d.transMs : 0
                onValueModified: cp.box.set("transMs", value)
            }
        }
        Quiet {
            readonly property var k: cp.box.transKinds().find(x => x.id === cp.d.transKind)
            visible: !!k && !!k.about
            text: k && k.about ? k.about : ""
        }
    }

    // FX1-FX4 (D411) the clip look: per reel, one music mode, one transition set and one name style, picked from the
    // ticks below (seeded, never the same as the last reel while another tick is free). Saved with Save, like the rest.
    UCard {
        title: "CLIP LOOK"
        visible: !!cp.d.look
        Quiet {
            text: "Each clip gets its music, its transitions and the way your name shows from the styles you tick here. " +
                  "Untick every style of a part to switch that part off. \"Always use\" picks one style for every clip. " +
                  "When you're asked \"Make clips?\" you can still choose a style for that one recording."
        }
        USwitch {
            objectName: "lookRandomise"
            width: parent.width
            text: "Mix the ticked styles from clip to clip"
            hint: "Off: every clip uses the first ticked style of each part."
            checked: !!cp.d.look && cp.d.look.randomise === true
            onToggled: cp.box.setLook("", "randomise", checked)
        }
        Repeater {
            model: [{ g: "music", title: "Music" }, { g: "transitions", title: "Transitions" }, { g: "name", title: "Your name on screen" }]
            delegate: Column {
                id: lg
                required property var modelData
                readonly property var grp: cp.box.lookGroup(modelData.g)
                readonly property var val: cp.d.look ? cp.d.look[modelData.g] : ({})
                readonly property var ticked: (val || {})[grp.ticks] || []
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: lg.modelData.title; font.weight: Font.DemiBold }
                Repeater {
                    model: lg.grp.options
                    delegate: USwitch {
                        id: opt
                        required property var modelData
                        objectName: "lookTick_" + lg.modelData.g + "_" + modelData.id
                        width: parent.width
                        text: modelData.label
                        hint: modelData.about
                        checked: lg.ticked.includes(modelData.id)
                        onToggled: cp.box.tickLook(lg.modelData.g, modelData.id, checked)
                    }
                }
                Row {
                    spacing: Theme.sp.s
                    Words { text: "Always use"; anchors.verticalCenter: parent.verticalCenter }
                    UCombo {
                        objectName: "lookLock_" + lg.modelData.g
                        width: 260
                        label: lg.modelData.title + " always use"
                        enabled: lg.ticked.length > 0
                        model: [{ value: "", text: "Any ticked style" }].concat(lg.grp.options.filter(o => lg.ticked.includes(o.id)).map(o => ({ value: o.id, text: o.label })))
                        currentIndex: Math.max(0, model.findIndex(m => m.value === ((lg.val || {}).lock || "")))
                        onChose: (v) => cp.box.setLook(lg.modelData.g, "lock", v === "" ? null : v)
                    }
                }
            }
        }
        Words { text: "Music settings"; font.weight: Font.DemiBold }
        Words { text: "My music folder (tracks are picked to fit each clip; nothing is downloaded)" }
        UField {
            objectName: "lookMusicFolder"
            width: Math.min(parent.width, 520)
            label: "My music folder"
            placeholderText: "Like D:\\Music\\Clips (empty: music made on this PC)"
            text: cp.d.look ? cp.d.look.music.folder : ""
            onTextEdited: cp.box.setLook("music", "folder", text)
        }
        Row {
            spacing: Theme.sp.s
            Words { text: "Music level"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookMusicLevel"
                label: "Music level"
                from: ((cp.box.info.look || {}).levelDb || {}).min || -24
                to: ((cp.box.info.look || {}).levelDb || {}).max || -10
                suffix: " dB"
                value: cp.d.look ? cp.d.look.music.levelDb : -16
                onValueModified: cp.box.setLook("music", "levelDb", value)
            }
        }
        Words { text: "Transition settings"; font.weight: Font.DemiBold }
        USwitch {
            objectName: "lookSfx"
            width: parent.width
            text: "Sound on each join"
            hint: "A whoosh, hit or riser made on this PC, quieter than the game."
            checked: !!cp.d.look && cp.d.look.transitions.sfx === true
            onToggled: cp.box.setLook("transitions", "sfx", checked)
        }
        USwitch {
            objectName: "lookBeatSync"
            width: parent.width
            text: "Put joins on the beat"
            hint: "Moves a join up to a quarter second earlier so it lands on a beat of the music. Clips with captions keep their joins."
            checked: !!cp.d.look && cp.d.look.transitions.beatSync === true
            onToggled: cp.box.setLook("transitions", "beatSync", checked)
        }
        Words { text: "Name settings"; font.weight: Font.DemiBold }
        Row {
            spacing: Theme.sp.s
            Words { text: "Size"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookNameSize"
                label: "Name size"
                from: ((cp.box.info.look || {}).sizePct || {}).min || 60
                to: ((cp.box.info.look || {}).sizePct || {}).max || 160
                stepSize: 10
                suffix: " %"
                value: cp.d.look ? cp.d.look.name.sizePct : 100
                onValueModified: cp.box.setLook("name", "sizePct", value)
            }
            Words { text: "Shown for"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookNameSec"
                label: "Name shown for"
                from: ((cp.box.info.look || {}).durationSec || {}).min || 1
                to: ((cp.box.info.look || {}).durationSec || {}).max || 4
                suffix: " s"
                value: cp.d.look ? Math.round(cp.d.look.name.durationSec) : 2
                onValueModified: cp.box.setLook("name", "durationSec", value)
            }
        }
        UButton {
            objectName: "lookReset"
            text: "Reset to defaults"
            onClicked: { const d = Object.assign({}, cp.d); d.look = JSON.parse(JSON.stringify(cp.box.info.look.defaults)); cp.box.draft = d }
        }
    }

    // D403 Recordings Ujwalam made clips from: whether each is deleted once clipped, and Keep for labelling (one click,
    // saved at once; ui/api/recordings/keep). A kept recording is never deleted by Delete clipped recordings.
    property var recs: []
    property string recsInfo: "Loading..."
    property bool recsFlag: false
    function reasonText(r) {
        return r === null ? "deleted once it is not in use"
            : r === "kept-for-labelling" ? "kept for labelling"
            : r === "job-pending" ? "kept: a clip job for it is waiting or running"
            : r === "job-failed" ? "kept: its last clip job did not finish"
            : r === "reels-not-made" ? "kept: its reels were not made"
            : r === "long-video-not-made" ? "kept: its long highlights video was not made yet"
            : "kept (" + r + ")";
    }
    function loadRecs() {
        Api.get("ui/api/recordings/keep", (ok, b, err) => {
            if (!ok) { recsInfo = "The recordings list is not available: " + err; return }
            recsFlag = b.flag === true;
            recs = Array.isArray(b.sessions) ? b.sessions : [];
            recsInfo = b.keepUnreadable === true ? "Your Keep for labelling list could not be read, so every recording is kept."
                : recs.length === 0 ? "No recording has been made into clips yet." : "";
        });
    }
    function setRecKeep(name, keep) {
        Api.post("ui/api/recordings/keep", { name: name, keep: keep }, (ok, b, err) => {
            recsInfo = ok ? "" : "Not saved: " + err;
            loadRecs();
        });
    }
    Component.onCompleted: loadRecs()

    UCard {
        title: "RECORDINGS"
        Quiet {
            objectName: "recordingsAbout"
            text: (cp.recsFlag ? "Delete clipped recordings is on: " : "Delete clipped recordings is off; when it is on, ")
                + "a full recording (its H and V files) is deleted permanently once every clip from it is made and reviewed, never while you are live or recording. "
                + "Tick Keep for labelling to keep a recording you still want to label."
        }
        Quiet { objectName: "recordingsInfo"; visible: cp.recsInfo !== ""; text: cp.recsInfo }
        Repeater {
            model: cp.recs
            delegate: Item {
                id: rr
                required property var modelData
                width: parent.width
                height: 40
                Text {
                    anchors { left: parent.left; right: keepSw.left; rightMargin: Theme.sp.s; verticalCenter: parent.verticalCenter }
                    elide: Text.ElideRight
                    text: rr.modelData.name + (rr.modelData.hasV ? " (H and V)" : "") + "  -  " + cp.reasonText(rr.modelData.keep ? "kept-for-labelling" : rr.modelData.reason)
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
                USwitch {
                    id: keepSw
                    objectName: "recordingKeep:" + rr.modelData.name
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    text: "Keep for labelling"
                    checked: rr.modelData.keep === true
                    onToggled: cp.setRecKeep(rr.modelData.name, checked)
                }
            }
        }
    }
}
