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
        // Finished features with their own toggle (2026-11-26; stored in settings.json, switchable while live)
        FeatureSwitch {
            box: cp.box; fid: "live-clips"
            text: "Save kill streaks while I stream"
            hint: "Watches the game while you are live or recording and saves each kill streak from the replay buffer, so it can become a clip after the stream. Uses some GPU while live."
        }
    }

    UCard {
        title: "AFTER EACH STREAM OR RECORDING"
        objectName: "settingsAfterEach"
        FeatureSwitch {
            box: cp.box; fid: "beatdrop"
            text: "BeatDrop montage after each stream"
            hint: "After the clips of each stream or recording are made, a montage cut to the music's beat is made too: kills on the beats, the best kill on the drop. Review it in More > BeatDrop montage. Runs only when nothing is live or recording."
        }
        FeatureSwitch {
            box: cp.box; fid: "long-highlights-video"
            text: "Long highlights video after each recording"
            hint: "Makes one 8-20 minute video of the best moments from each recorded session, after its clips. Runs only when nothing is live or recording."
        }
        FeatureSwitch {
            box: cp.box; fid: "delete-processed-recordings"
            text: "Delete a recording once all its clips are made"
            hint: "Permanently deletes a full recording from your recordings folder once every clip and video from it is made and reviewed. Frees disk space; the recording cannot be brought back."
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
        // D439: the K.O. cards of the long highlights video (clips.look.cards.styles; no tick = no cards)
        Words { text: "Moment cards on the long video"; font.weight: Font.DemiBold }
        Words {
            objectName: "lookCardsHint"
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "At the start of each moment of the long highlights video a big word says what happened (K.O., DOUBLE K.O., STREAK, WON). Each moment gets one of the animations you tick, mixed so the same one never shows twice in a row. Untick all of them to show no cards. Changes the next long video; a video already made stays as it is."
        }
        Repeater {
            model: cp.box.lookGroup("cards").options
            delegate: USwitch {
                required property var modelData
                readonly property var ticked: cp.d.look && cp.d.look.cards ? (cp.d.look.cards.styles || []) : []
                objectName: "lookTick_cards_" + modelData.id
                width: parent.width
                text: modelData.label
                hint: modelData.about
                checked: ticked.includes(modelData.id)
                onToggled: cp.box.tickLook("cards", modelData.id, checked)
            }
        }        Words { text: "Music settings"; font.weight: Font.DemiBold }
        USwitch {
            objectName: "lookMusicPack"
            readonly property var srcs: cp.d.look ? (cp.d.look.music.sources || []) : []
            width: parent.width
            text: "Use the free music pack"
            hint: (cp.box.info.look || {}).packReady === true
                  ? "37 free tracks (CC0, Free Music Archive). Posts name the artist and track."
                  : "Not downloaded yet: get it in Settings > Downloads. Until then clips use your folder or music made on this PC."
            checked: srcs.includes("pack")
            onToggled: cp.box.setLook("music", "sources", ((cp.box.info.look || {}).sources || []).map(s => s.id).filter(x => x === "pack" ? checked : srcs.includes(x)))
        }
        USwitch {
            objectName: "lookMusicAi"
            readonly property var srcs: cp.d.look ? (cp.d.look.music.sources || []) : []
            width: parent.width
            text: "Make music on this PC when nothing fits"
            hint: (cp.box.info.look || {}).aiReady === true
                  ? "Make music on this PC when nothing fits. Takes about 10 s per clip, never while live."
                  : "Not set up on this PC: the AI music program is not installed. Clips use your folder, the pack or the simple made-here music."
            enabled: (cp.box.info.look || {}).aiReady === true
            checked: srcs.includes("ai")
            onToggled: cp.box.setLook("music", "sources", ((cp.box.info.look || {}).sources || []).map(s => s.id).filter(x => x === "ai" ? checked : srcs.includes(x)))
        }
        Row {
            visible: (cp.box.info.look || {}).aiReady !== true
            spacing: Theme.sp.s
            UButton {
                objectName: "lookMusicAiFolder"
                text: "Choose folder…"
                onClicked: { if (aiPicker.item) aiPicker.item.open(); else aiPicker.active = true }
            }
            Words {
                anchors.verticalCenter: parent.verticalCenter
                text: cp.d.look && cp.d.look.music.aiRuntime ? "Chosen: " + cp.d.look.music.aiRuntime + " (Save, then this page checks it)"
                                                              : "Pick the folder where ACE-Step 1.5 is installed."
            }
            Loader {
                id: aiPicker
                active: false
                source: "AiFolderPicker.qml"
                onLoaded: item.open()
                Connections {
                    target: aiPicker.item
                    function onChosen(folder) { cp.box.setLook("music", "aiRuntime", folder) }
                }
            }
        }
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
                value: cp.d.look ? cp.d.look.music.levelDb : -20
                onValueModified: cp.box.setLook("music", "levelDb", value)
            }
        }
        Words {
            objectName: "lookMusicLevelHint"
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "The loudest the music may ever be. Lower is quieter. Above -16 dB the music can cover the game; -20 dB is the safe start."
        }
        // D437: the music under the game, the voice duck and the fades (clips.look.music)
        Row {
            spacing: Theme.sp.s
            Words { text: "Music under the game"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookMusicUnderGame"
                label: "Music under the game"
                from: ((cp.box.info.look || {}).underGameDb || {}).min || 0
                to: ((cp.box.info.look || {}).underGameDb || {}).max || 20
                suffix: " dB"
                value: cp.d.look && cp.d.look.music.underGameDb !== undefined ? cp.d.look.music.underGameDb : 8
                onValueModified: cp.box.setLook("music", "underGameDb", value)
            }
        }
        Words {
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "Each clip's game sound is measured and the music is set this much quieter than it. Higher keeps the game clearer; 0 makes the music as loud as the game and can cover it."
        }
        Row {
            spacing: Theme.sp.s
            Words { text: "Quieter when someone talks"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookVoiceDuck"
                label: "Quieter when someone talks"
                from: ((cp.box.info.look || {}).voiceDuckDb || {}).min || 0
                to: ((cp.box.info.look || {}).voiceDuckDb || {}).max || 20
                suffix: " dB"
                value: cp.d.look && cp.d.look.music.voiceDuckDb !== undefined ? cp.d.look.music.voiceDuckDb : 8
                onValueModified: cp.box.setLook("music", "voiceDuckDb", value)
            }
        }
        Words {
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "Turns the music down this much more while a voice is heard in the game sound, then back up. 0 turns it off. Very high values can make the music pump on and off."
        }
        Row {
            spacing: Theme.sp.s
            Words { text: "Fade in"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookFadeIn"
                label: "Music fade in"
                from: Math.round((((cp.box.info.look || {}).fadeSec || {}).min || 0.1) * 10)
                to: Math.round((((cp.box.info.look || {}).fadeSec || {}).max || 4) * 10)
                textFromValue: (v) => (v / 10).toFixed(1) + " s"
                valueFromText: (t) => Math.round((parseFloat(String(t).replace(/[^0-9.]/g, "")) || 0) * 10)
                value: Math.round((cp.d.look && cp.d.look.music.fadeInSec !== undefined ? cp.d.look.music.fadeInSec : 1.5) * 10)
                onValueModified: cp.box.setLook("music", "fadeInSec", value / 10)
            }
            Words { text: "Fade out"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookFadeOut"
                label: "Music fade out"
                from: Math.round((((cp.box.info.look || {}).fadeSec || {}).min || 0.1) * 10)
                to: Math.round((((cp.box.info.look || {}).fadeSec || {}).max || 4) * 10)
                textFromValue: (v) => (v / 10).toFixed(1) + " s"
                valueFromText: (t) => Math.round((parseFloat(String(t).replace(/[^0-9.]/g, "")) || 0) * 10)
                value: Math.round((cp.d.look && cp.d.look.music.fadeOutSec !== undefined ? cp.d.look.music.fadeOutSec : 1.5) * 10)
                onValueModified: cp.box.setLook("music", "fadeOutSec", value / 10)
            }
        }
        UCombo {
            objectName: "lookFadeCurve"
            width: Math.min(parent.width, 520)
            label: "Fade shape"
            model: [{ value: "s-curve", text: "Smooth S-curve (slow start and end, recommended)" },
                    { value: "equal-power", text: "Equal power (stays loud longer, then drops)" },
                    { value: "exponential", text: "Even to the ear (steady steps in loudness)" },
                    { value: "linear", text: "Straight line (the old, more abrupt fade)" }]
            currentIndex: Math.max(0, model.findIndex(m => m.value === (cp.d.look && cp.d.look.music.fadeCurve ? cp.d.look.music.fadeCurve : "s-curve")))
            onChose: (v) => cp.box.setLook("music", "fadeCurve", v)
        }
        Words {
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "Fade out: after the name at the start, the music stays full until the name ends, then fades out over this time. Fade in: the end music starts this much earlier and rises to full, so the full ending is never cut short. Long fades on a short clip are shortened so they fit."
        }
        // D440: the loudness every finished reel, montage and long video is set to (clips.look.music.loudnessLufs)
        USwitch {
            objectName: "lookLoudnessOn"
            width: parent.width
            text: "Even out the loudness of finished videos"
            hint: "On: each reel, montage and long video is turned up (or down) to the level below, measured over the whole video. Off: the sound stays as recorded (often very quiet)."
            checked: !!cp.d.look && cp.d.look.music.loudnessLufs !== null && cp.d.look.music.loudnessLufs !== undefined
            onToggled: cp.box.setLook("music", "loudnessLufs", checked ? -14 : null)
        }
        Row {
            spacing: Theme.sp.s
            visible: !!cp.d.look && cp.d.look.music.loudnessLufs !== null && cp.d.look.music.loudnessLufs !== undefined
            Words { text: "Loudness"; anchors.verticalCenter: parent.verticalCenter }
            USpin {
                objectName: "lookLoudness"
                label: "Loudness of finished videos"
                from: ((cp.box.info.look || {}).loudnessLufs || {}).min || -24
                to: ((cp.box.info.look || {}).loudnessLufs || {}).max || -9
                suffix: " LUFS"
                value: cp.d.look && typeof cp.d.look.music.loudnessLufs === "number" ? cp.d.look.music.loudnessLufs : -14
                onValueModified: cp.box.setLook("music", "loudnessLufs", value)
            }
        }
        Words {
            objectName: "lookLoudnessHint"
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "-14 is YouTube's playback level: YouTube turns louder videos down but never turns quiet ones up, so a quiet video stays quiet. Higher numbers are louder. What could break: the louder the target, the harder gunfire and other peaks are squeezed by the limiter, which can sound flat or pumping; the check after each video is written to its record."
        }        Words { text: "Transition settings"; font.weight: Font.DemiBold }
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
        // RL4 (D445): the studio's realism looks on reels, per reel type: Off, one look, or Random from the ticked looks
        // (a seeded pick: the same reel always draws the same look). In the dialog draft, saved with Save.
        Words { text: "Realism look"; font.weight: Font.DemiBold }
        Words {
            objectName: "realismHint"
            width: parent.width
            wrapMode: Text.WordWrap
            color: Theme.c.muted
            text: "Gives reels the colour, glow, detail, grain and vignette of a realism look, the same looks as Make realism scene. A realism look replaces the reel style's colour on that reel (never both); the style's pace, joins and zooms stay. Reels are made after the stream, so this never slows your live stream."
        }
        Repeater {
            model: [{ t: "reel", title: "Reels" }, { t: "impact", title: "Impact plays" }, { t: "montage", title: "Kill montages" }]
            delegate: Column {
                id: rl
                required property var modelData
                readonly property var v: ((cp.d.realismLooks || {}).byType || {})[modelData.t] || { mode: "off", look: null, ticks: [] }
                readonly property var looks: cp.box.realismLooks
                width: parent.width
                spacing: Theme.sp.xs
                Row {
                    spacing: Theme.sp.s
                    Words { width: 140; text: rl.modelData.title; anchors.verticalCenter: parent.verticalCenter }
                    UCombo {
                        objectName: "realismMode_" + rl.modelData.t
                        width: 300
                        label: rl.modelData.title + " realism look"
                        model: [{ value: "off", text: "Off" }, { value: "random", text: "Random from the looks I tick" }]
                            .concat(rl.looks.map(l => ({ value: "one:" + l.id, text: l.name })))
                        currentIndex: Math.max(0, model.findIndex(m => m.value === (rl.v.mode === "one" ? "one:" + rl.v.look : rl.v.mode)))
                        onChose: (x) => x.startsWith("one:") ? cp.box.setRealism(rl.modelData.t, "one", x.slice(4)) : cp.box.setRealism(rl.modelData.t, x, null)
                    }
                }
                Quiet {
                    visible: rl.v.mode === "one"
                    text: (rl.looks.find(l => l.id === rl.v.look) || { summary: "This look is not installed any more: the reels are made without a realism look." }).summary
                }
                Repeater {
                    model: rl.v.mode === "random" ? rl.looks : []
                    delegate: USwitch {
                        required property var modelData
                        objectName: "realismTick_" + rl.modelData.t + "_" + modelData.id
                        width: parent.width
                        text: modelData.name
                        hint: modelData.summary
                        checked: rl.v.ticks.includes(modelData.id)
                        onToggled: cp.box.tickRealism(rl.modelData.t, modelData.id, checked)
                    }
                }
                Quiet {
                    visible: rl.v.mode === "random" && rl.v.ticks.length === 0
                    text: "Tick at least one look, or these reels are made without a realism look."
                }
            }
        }
        // RL5 (D445): looks of the user's own, made from a screenshot or short video; rename and delete here (one click each)
        Words { text: "Your own looks"; font.weight: Font.DemiBold }
        Quiet {
            objectName: "ownLooksHint"
            width: parent.width
            wrapMode: Text.WordWrap
            text: "Make a look from a screenshot or short video you like: its colour is measured, and glow, grain, vignette and detail start from the nearest built-in look. Nothing from the file is kept. Your looks show in Make realism scene and in the lists above."
        }
        UButton {
            objectName: "realismNewLook"
            text: "New look from a reference…"
            onClicked: cp.box.store.newLookFromReference()
        }
        Quiet {
            objectName: "ownLooksNone"
            visible: !cp.box.realismLooks.some(l => l.own === true)
            text: "No looks of your own yet."
        }
        Repeater {
            model: cp.box.realismLooks.filter(l => l.own === true)
            delegate: Row {
                id: ol
                required property var modelData
                spacing: Theme.sp.s
                UField {
                    id: olName
                    objectName: "ownLookName_" + ol.modelData.id
                    width: 220
                    label: "Name of " + ol.modelData.name
                    text: ol.modelData.name
                    maximumLength: 24
                    onAccepted: if (text.trim() !== "" && text.trim() !== ol.modelData.name) cp.box.store.renameLook(ol.modelData.id, text.trim())
                }
                UButton {
                    objectName: "ownLookRename_" + ol.modelData.id
                    text: "Rename"
                    enabled: olName.text.trim() !== "" && olName.text.trim() !== ol.modelData.name
                    onClicked: cp.box.store.renameLook(ol.modelData.id, olName.text.trim())
                }
                UButton {
                    objectName: "ownLookDelete_" + ol.modelData.id
                    text: "Delete"
                    tip: "Removes this look. Reels set to it are made without a realism look; scenes made with it lose its colour."
                    onClicked: cp.box.store.deleteLook(ol.modelData.id)
                }
            }
        }
        UButton {
            objectName: "lookReset"
            text: "Reset to defaults"
            onClicked: { const d = Object.assign({}, cp.d); d.look = JSON.parse(JSON.stringify(cp.box.info.look.defaults)); cp.box.draft = d }
        }
    }

    // RS3 (D412) reel styles: example reels the user likes (path only, never copied) are analysed off air into numbers;
    // the style per reel type and "join the mix" are in the dialog draft (Save); a style's sliders have their own
    // Save / Discard (they change the style, not the settings file). Progress shows in the task area and here.
    property var rsInfo: ({ flag: false, styles: [] })
    property string rsNote: ""
    property var rsTune: ({})  // style id -> the slider values not saved yet
    property string rsPreview: ""
    function rsLoad() {
        Api.get("ui/api/reel-styles", (ok, b, err) => {
            if (!ok) { rsNote = "Reel styles are not available: " + err; return }
            rsInfo = b;
            const j = b.job;
            rsNote = b.problem ? "Could not read your styles: " + b.problem
                : j && j.state === "running" ? (j.op === "analyse" ? "Analysing: " : "Previewing: ") + j.note
                : j && j.state === "failed" ? j.note : rsNote;
            if (j && j.state === "done" && j.previewFile) rsPreview = j.previewFile;
            rsPoll.running = !!(j && j.state === "running");
        });
    }
    function rsPost(body, then) {
        Api.post("ui/api/reel-styles", body, (ok, b, err) => {
            rsNote = ok ? "" : "Not done: " + err;
            if (ok && then) then(b);
            rsLoad();
        });
    }
    function rsValue(st, k) { const t = rsTune[st.id]; return t && k in t ? t[k] : (k in st.tune ? st.tune[k] : st.values[k]) }
    function rsSet(id, k, v) { const all = Object.assign({}, rsTune), t = Object.assign({}, all[id] || {}); t[k] = v; all[id] = t; rsTune = all }
    function rsDrop(id) { const all = Object.assign({}, rsTune); delete all[id]; rsTune = all }
    function rsByType(t) { return ((cp.d.reelStyles || {}).byType || {})[t] || "" }
    Timer { id: rsPoll; interval: 2000; repeat: true; onTriggered: cp.rsLoad() }

    UCard {
        title: "REEL STYLES"
        visible: cp.rsInfo.flag === true
        Quiet {
            text: "Add a few reels whose look you like. Ujwalam measures them (pace, joins, zooms, slow motion, where text sits, " +
                  "colour and music energy) and rebuilds that look on your clips with its own effects. The videos stay where they are: " +
                  "only their path is kept. Analysing and previews run after the stream, never while you're live."
        }
        Quiet { objectName: "reelStylesNote"; visible: text !== ""; text: cp.rsNote; color: Theme.c.text }
        Repeater {
            model: [{ t: "reel", title: "Reels" }, { t: "impact", title: "Impact plays" }, { t: "montage", title: "Kill montages" }]
            delegate: Row {
                required property var modelData
                spacing: Theme.sp.s
                Words { width: 140; text: modelData.title + " use"; anchors.verticalCenter: parent.verticalCenter }
                UCombo {
                    objectName: "reelStyleFor_" + modelData.t
                    width: 260
                    label: modelData.title + " style"
                    model: [{ value: "", text: "No style (as now)" }].concat((cp.rsInfo.styles || []).filter(s => s.analysed).map(s => ({ value: s.id, text: s.name })))
                    currentIndex: Math.max(0, model.findIndex(m => m.value === cp.rsByType(modelData.t)))
                    onChose: (v) => cp.box.setReelStyle(modelData.t, v)
                }
            }
        }
        Repeater {
            model: cp.rsInfo.styles || []
            delegate: Column {
                id: sty
                required property var modelData
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: sty.modelData.name; font.weight: Font.DemiBold }
                Quiet { text: sty.modelData.examples.length + " example" + (sty.modelData.examples.length === 1 ? "" : "s") + ": " + sty.modelData.examples.map(e => e.name).join(", ") }
                Quiet { objectName: "reelStyleSummary_" + sty.modelData.id; text: sty.modelData.problem ? sty.modelData.problem : sty.modelData.analysed ? "Measured: " + sty.modelData.summary : "Not analysed yet." }
                Quiet {
                    visible: sty.modelData.omitted.length > 0
                    text: "Left out: " + sty.modelData.omitted.map(o => o.part + " (" + o.reason + ")").join("; ")
                }
                Row {
                    spacing: Theme.sp.s
                    UButton {
                        objectName: "reelStyleAnalyse_" + sty.modelData.id
                        text: sty.modelData.analysed ? "Analyse again" : "Analyse"
                        onClicked: cp.rsPost({ op: "analyse", id: sty.modelData.id })
                    }
                    USwitch {
                        objectName: "reelStylePool_" + sty.modelData.id
                        visible: sty.modelData.analysed
                        text: "Join the mix"
                        hint: "With \"Mix the ticked styles\" on, clips also pick this style now and then."
                        checked: ((cp.d.reelStyles || {}).pool || []).includes(sty.modelData.id)
                        onToggled: cp.box.poolReelStyle(sty.modelData.id, checked)
                    }
                }
                Repeater {
                    model: sty.modelData.analysed ? [
                        { k: "shotSec", text: "Seconds per shot", fmt: v => v.toFixed(1) + " s" },
                        { k: "lutStrength", text: "Colour strength", fmt: v => Math.round(v * 100) + " %" },
                        { k: "zoomScale", text: "Zoom pulse size (left = off)", fmt: v => v <= 1.0 ? "off" : "+" + Math.round((v - 1) * 100) + " %" },
                        { k: "rampFactor", text: "Slow motion speed (right = off)", fmt: v => v >= 1.0 ? "off" : Math.round(v * 100) + " %" },
                        { k: "musicEnergy", text: "Music energy", fmt: v => Math.round(v * 100) + " %" }
                    ].filter(x => typeof cp.rsValue(sty.modelData, x.k) === "number") : []
                    delegate: Row {
                        required property var modelData
                        readonly property var range: (cp.rsInfo.tune || {})[modelData.k] || { min: 0, max: 1 }
                        spacing: Theme.sp.s
                        Words { width: 220; text: modelData.text; anchors.verticalCenter: parent.verticalCenter }
                        USlider {
                            objectName: "reelStyleTune_" + sty.modelData.id + "_" + modelData.k
                            width: 200
                            from: range.min
                            to: range.max
                            value: cp.rsValue(sty.modelData, modelData.k)
                            onCommitted: (v) => cp.rsSet(sty.modelData.id, modelData.k, Math.round(v * 100) / 100)
                        }
                        Words { width: 70; text: modelData.fmt(cp.rsValue(sty.modelData, modelData.k)); anchors.verticalCenter: parent.verticalCenter }
                    }
                }
                Row {
                    visible: !!cp.rsTune[sty.modelData.id]
                    spacing: Theme.sp.s
                    UButton {
                        objectName: "reelStyleSave_" + sty.modelData.id
                        text: "Save"
                        onClicked: cp.rsPost({ op: "tune", id: sty.modelData.id, tune: Object.assign({}, sty.modelData.tune, cp.rsTune[sty.modelData.id]) }, () => cp.rsDrop(sty.modelData.id))
                    }
                    UButton { objectName: "reelStyleDiscard_" + sty.modelData.id; text: "Discard"; onClicked: cp.rsDrop(sty.modelData.id) }
                }
                Row {
                    visible: sty.modelData.analysed
                    spacing: Theme.sp.s
                    UField {
                        id: pvSrc
                        objectName: "reelStylePreviewSrc_" + sty.modelData.id
                        width: Math.min(sty.width - 200, 420)
                        label: "One of your clips"
                        placeholderText: "Full path of one of your clips, like D:\\Clips\\reel.mp4"
                    }
                    UButton {
                        objectName: "reelStylePreview_" + sty.modelData.id
                        text: "Preview on my clip"
                        enabled: pvSrc.text.trim() !== ""
                        onClicked: cp.rsPost({ op: "preview", id: sty.modelData.id, src: pvSrc.text.trim() })
                    }
                }
            }
        }
        Words { text: "Add a style"; font.weight: Font.DemiBold }
        UField { id: rsName; objectName: "reelStyleName"; width: Math.min(parent.width, 360); label: "Style name"; placeholderText: "Like Fast and warm" }
        UField {
            id: rsPaths
            objectName: "reelStylePaths"
            width: Math.min(parent.width, 520)
            label: "Example videos"
            placeholderText: "Full paths, separated by ;  like D:\\Examples\\a.mp4; D:\\Examples\\b.mp4"
        }
        UButton {
            objectName: "reelStyleAdd"
            text: "Add style"
            enabled: rsName.text.trim() !== "" && rsPaths.text.trim() !== ""
            onClicked: cp.rsPost({ op: "create", name: rsName.text.trim(), paths: rsPaths.text.split(";").map(p => p.trim()).filter(p => p !== "") },
                                 () => { rsName.text = ""; rsPaths.text = "" })
        }
        Quiet { visible: cp.rsPreview !== ""; text: "Preview saved: " + cp.rsPreview + " (colour and zoom pulses; pace, joins and music show on a whole reel)." }
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
    Component.onCompleted: { loadRecs(); rsLoad(); mmLoad() }

    // D414 montage music: the user's NCS library. The switch, folder, random or fixed and "not again for" are in the dialog
    // draft (Save / Discard); a track's credit has its own Save / Discard (it changes the credit file, not the settings).
    property var mmInfo: ({ tracks: [], folderProblem: null })
    property string mmNote: ""
    property var mmEdit: ({})  // track id -> the credit fields not saved yet
    readonly property var mm: cp.d.montageMusic || null
    function mmLoad() {
        Api.get("ui/api/montage-music", (ok, b, err) => {
            if (!ok) { mmNote = "Montage music is not available: " + err; return }
            mmInfo = b;
            mmNote = b.problem ? "Could not read the folder: " + b.problem : b.folderProblem ? "Music folder: " + b.folderProblem : "";
        });
    }
    function mmField(tr, k) { const e = mmEdit[tr.id]; return e && k in e ? e[k] : (tr[k] || "") }
    function mmSet(id, k, v) { const all = Object.assign({}, mmEdit), e = Object.assign({}, all[id] || {}); e[k] = v; all[id] = e; mmEdit = all }
    function mmDrop(id) { const all = Object.assign({}, mmEdit); delete all[id]; mmEdit = all }
    function mmSave(tr) {
        const c = { artist: mmField(tr, "artist"), title: mmField(tr, "title"), line: mmField(tr, "line"), link: mmField(tr, "link") };
        Api.post("ui/api/montage-music", { op: "credit", id: tr.id, credit: c }, (ok, b, err) => {
            mmNote = ok ? "" : "Credit not saved: " + err;
            if (ok) mmDrop(tr.id);
            mmLoad();
        });
    }

    UCard {
        title: "MONTAGE MUSIC"
        visible: !!cp.mm
        Quiet {
            text: "Kill montages are cut to a song from your NCS (NoCopyrightSounds) folder. Each post gets the song's credit " +
                  "(artist and title) in its description; a montage whose song has no credit is never posted. " +
                  "A montage with a song from anywhere else is made but never posted on its own."
        }
        USwitch {
            objectName: "montageMusicOn"
            width: parent.width
            text: "Use my NCS music for montages"
            hint: "Off: montages use the music from Clip look."
            checked: !!cp.mm && cp.mm.on === true
            onToggled: cp.box.setMontage("on", checked)
        }
        UField {
            objectName: "montageMusicFolder"
            width: Math.min(parent.width, 520)
            label: "NCS music folder"
            placeholderText: "Like D:\\Music\\NCS (a folder on this PC)"
            enabled: !!cp.mm && cp.mm.on
            text: cp.mm ? cp.mm.folder : ""
            onTextEdited: cp.box.setMontage("folder", text)
        }
        Flow {  // wraps on a narrow window so nothing is cut off
            width: parent.width
            spacing: Theme.sp.s
            UCombo {
                objectName: "montageMusicMode"
                width: 220
                label: "Song choice"
                enabled: !!cp.mm && cp.mm.on
                model: [{ value: "random", text: "A random song" }, { value: "fixed", text: "Always one song" }]
                currentIndex: cp.mm && cp.mm.mode === "fixed" ? 1 : 0
                onChose: (v) => cp.box.setMontage("mode", v)
            }
            UCombo {
                objectName: "montageMusicTrack"
                width: 300
                label: "The song"
                enabled: !!cp.mm && cp.mm.on && cp.mm.mode === "fixed"
                model: [{ value: "", text: "Pick a song" }].concat((cp.mmInfo.tracks || []).filter(x => !x.missing).map(x => ({ value: x.id, text: x.file })))
                currentIndex: Math.max(0, model.findIndex(m => cp.mm && m.value === cp.mm.fixedTrack))
                onChose: (v) => cp.box.setMontage("fixedTrack", v || null)
            }
            USpin {
                objectName: "montageMusicAvoid"
                label: "Not again for"
                enabled: !!cp.mm && cp.mm.on && cp.mm.mode === "random"
                from: ((cp.box.info.montageMusic || {}).avoidLast || {}).min || 0
                to: ((cp.box.info.montageMusic || {}).avoidLast || {}).max || 20
                suffix: " montages"
                value: cp.mm ? cp.mm.avoidLast : 3
                onValueModified: cp.box.setMontage("avoidLast", value)
            }
        }
        Quiet { objectName: "montageMusicNote"; visible: text !== ""; text: cp.mmNote; color: Theme.c.text }
        Quiet { text: (cp.mmInfo.tracks || []).length ? "Song credits (read from the file's tags or name; fix any that are wrong):" : "Save a folder to see its songs here." }
        Repeater {
            model: cp.mmInfo.tracks || []
            delegate: Column {
                id: tr
                required property var modelData
                width: parent.width
                spacing: Theme.sp.xs
                Words { text: tr.modelData.file + (tr.modelData.missing ? " (file not in the folder now)" : ""); font.weight: Font.DemiBold }
                Quiet {
                    objectName: "montageCreditState_" + tr.modelData.id
                    text: tr.modelData.complete ? "Credit ready." : "No full credit yet: montages with this song are not posted until the artist and title are filled in."
                }
                Row {
                    spacing: Theme.sp.s
                    UField { objectName: "montageArtist_" + tr.modelData.id; width: 200; label: "Artist"; text: cp.mmField(tr.modelData, "artist"); onTextEdited: cp.mmSet(tr.modelData.id, "artist", text) }
                    UField { objectName: "montageTitle_" + tr.modelData.id; width: 240; label: "Song title"; text: cp.mmField(tr.modelData, "title"); onTextEdited: cp.mmSet(tr.modelData.id, "title", text) }
                }
                Row {
                    spacing: Theme.sp.s
                    UField { width: 240; label: "Credit line"; text: cp.mmField(tr.modelData, "line"); onTextEdited: cp.mmSet(tr.modelData.id, "line", text) }
                    UField { width: 200; label: "Link (optional)"; placeholderText: "https://"; text: cp.mmField(tr.modelData, "link"); onTextEdited: cp.mmSet(tr.modelData.id, "link", text) }
                }
                Row {
                    spacing: Theme.sp.s
                    opacity: cp.mmEdit[tr.modelData.id] ? 1 : 0  // kept in the layout so nothing jumps
                    enabled: !!cp.mmEdit[tr.modelData.id]
                    UButton { objectName: "montageCreditSave_" + tr.modelData.id; text: "Save credit"; onClicked: cp.mmSave(tr.modelData) }
                    UButton { text: "Discard"; onClicked: cp.mmDrop(tr.modelData.id) }
                }
            }
        }
    }

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
