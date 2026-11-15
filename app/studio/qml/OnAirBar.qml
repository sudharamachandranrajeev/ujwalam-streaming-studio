// SPDX-License-Identifier: GPL-3.0-or-later
// The on-air bar (plan Q2): LIVE state with its timer, the stream bitrate, recording with its timer, dropped frames and
// load, and the two labelled controls. Go live and Record use the widget studio's paths (store.hostAction: one click,
// D332; the server holds an action only for readiness problems).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Rectangle {
    id: bar
    required property var store
    property var taskCenter: null // TaskCenter.qml: the task chip opens its panel
    property var guide: null      // Guide.qml: the ? button opens its help panel
    property var windows: ({})    // the More menu's windows (Main.qml): importer, feedback, posts, growth, report
    color: Theme.c.panel
    border.width: 1
    border.color: Theme.c.border
    radius: Theme.radiusLarge

    // Timers tick every second between the 2 s status polls.
    property real now: Date.now()
    property real stamp: Date.now()
    Connections { target: bar.store; function onOnAirChanged() { bar.stamp = Date.now(); bar.now = bar.stamp } }
    Timer { interval: 1000; repeat: true; running: bar.store.live || bar.store.recording; onTriggered: bar.now = Date.now() }

    function clock(ms) {
        if (typeof ms !== "number" || ms < 0) return "0:00:00";
        const t = Math.floor((ms + (now - stamp)) / 1000);
        const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
        return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    // ---- probe (tests): more-open, more:<item id> (import, feedback, posts, growth, report) ----
    function moreProbe() { return { open: moreMenu.opened, items: moreMenu.items() } }
    function moreAction(a) {
        if (a === "more-open") { moreBtn.clicked(); return true }
        if (a.startsWith("more:")) return moreMenu.opened && moreMenu.trigger(a.slice(5));
        return false;
    }

    readonly property bool reviewShown: store.flags["learning-review"] === true && store.reviewCount > 0
    readonly property var oa: store.onAir || {}
    readonly property string mbps: typeof oa.kbps === "number" && oa.kbps > 0 ? (oa.kbps / 1000).toFixed(1) + " Mbps" : ""
    readonly property string sinkTip: Array.isArray(oa.sinks) ? oa.sinks.map(s => (s.platform || s.id) + ": " + s.state +
        (typeof s.kbps === "number" && s.kbps > 0 ? ", " + (s.kbps / 1000).toFixed(1) + " Mbps" : "")).join("\n") : ""

    Text {
        id: brand
        anchors { left: parent.left; leftMargin: 16; verticalCenter: parent.verticalCenter }
        text: "Ujwalam"
        color: Theme.c.text
        font.family: "Barlow"
        font.pixelSize: 20
        font.weight: Font.Bold
    }
    Text {
        id: sceneName
        objectName: "barScene"
        anchors { left: brand.right; leftMargin: 14; verticalCenter: parent.verticalCenter }
        width: Math.max(0, chips.x - x - 16)
        elide: Text.ElideRight
        text: bar.store.activeSceneObj ? bar.store.activeSceneObj.name : ""
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: 14
    }

    Row {
        id: chips
        anchors { right: controls.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
        spacing: 8
        TaskChip {
            objectName: "taskChip"
            visible: bar.taskCenter !== null && bar.taskCenter.listed > 0
            center: bar.taskCenter
        }
        UChip {
            objectName: "chipLive"
            on: bar.store.live
            text: bar.store.live ? "LIVE  " + bar.clock(bar.oa.liveForMs) : "Offline"
            tip: bar.store.live ? bar.sinkTip : "Not streaming"
        }
        UChip {
            objectName: "chipBitrate"
            visible: bar.store.live && bar.mbps !== ""
            text: bar.mbps
            tip: bar.sinkTip
        }
        UChip {
            objectName: "chipRec"
            on: bar.store.recording
            text: bar.store.recording ? "REC  " + bar.clock(bar.oa.recordForMs) : "Not recording"
        }
        // Clips from finished recordings and streams (D283, D284), in plain words; the tip has the modes, folder and why.
        UChip {
            objectName: "chipClips"
            text: bar.store.clipsText
            tip: bar.store.clipsTip
            on: (bar.store.clips.asks || []).length > 0
            token: "accent"
        }
        UButton {
            objectName: "clipsFolderBtn"
            text: "My clips"
            iconName: "folder"
            tip: "Open the folder with your finished clips."
            onClicked: bar.store.openClipsFolder()
        }
        // LL3 (D340, flag learning-review): beside My clips, only with the flag on and something to review. Optional.
        UButton {
            objectName: "reviewBtn"
            visible: bar.reviewShown
            text: "Review reads (" + bar.store.reviewCount + ")"
            iconName: "clip"
            tip: "Optional: confirm or correct what the clip maker was not sure of. Nothing waits for it."
            onClicked: if (bar.windows.review) bar.windows.review.show()
        }
        // The stats chip is gone: the stats cards under the side column show the same numbers (D287, as the widget).
    }

    Row {
        id: controls
        anchors { right: parent.right; rightMargin: 12; verticalCenter: parent.verticalCenter }
        spacing: 8
        // RareUI slice 2 (D384, Floating Navigation; design after RareUI, MIT, Swapnil Kalambe): More, ? and Settings (the
        // bar's navigation; it has no mode switches, the rest are actions) sit in a pill dock when the pack's components.tabs
        // is "dock". A disc follows the hovered button (a spring in "full", a jump in "calm"). "plain" (on air, High
        // performance) and the flag off: the row as it was.
        Item {
            id: dock
            objectName: "tabLook:dock"
            readonly property string look: Theme.rareui && Theme.fx !== "plain" && Theme.tabsStyle === "dock" ? "dock" : ""
            readonly property bool full: Theme.fx === "full" && Theme.motion
            readonly property bool loop: false // read by the probe: a spring that stops at rest, not a loop
            readonly property int pad: look === "dock" ? 4 : 0
            property Item hoverBtn: null
            width: dockRow.width + 2 * pad
            height: dockRow.height + 2 * pad
            // Left and right move the focus along the dock and wrap.
            Keys.onPressed: (e) => {
                if (look !== "dock" || (e.key !== Qt.Key_Left && e.key !== Qt.Key_Right)) return;
                const it = [moreBtn, helpBtn, settingsBtn];
                const i = it.findIndex(x => x.activeFocus);
                if (i < 0) return;
                it[(i + (e.key === Qt.Key_Right ? 1 : it.length - 1)) % it.length].forceActiveFocus(Qt.TabFocusReason);
                e.accepted = true;
            }
            Loader {
                anchors.fill: parent
                active: dock.look === "dock"
                sourceComponent: Rectangle {
                    radius: height / 2
                    color: Theme.c.field
                    border.width: 1
                    border.color: Theme.c.border
                    NavPill {
                        host: parent
                        target: dock.hoverBtn
                        animate: dock.full
                        fill: Theme.c.text
                        fillOpacity: 0.10
                        stiffness: 400
                        damping: 25
                        mass: 1
                    }
                }
            }
            Row {
                id: dockRow
                x: dock.pad
                y: dock.pad
                spacing: 8
        // More (the widget's More menu, same order and tips): the flag-gated items show only with their flag on.
        UButton {
            id: moreBtn
            objectName: "moreBtn"
            bare: dock.look === "dock"
            onHoveredChanged: if (hovered) dock.hoverBtn = moreBtn; else if (dock.hoverBtn === moreBtn) dock.hoverBtn = null
            text: "More"
            iconName: "more"
            onClicked: moreMenu.popup(moreBtn, 0, moreBtn.height + 4)
            UMenu {
                id: moreMenu
                objectName: "moreMenu"
                readonly property var f: bar.store.flags || ({})
                UMenuItem { objectName: "moreMenu:import"; text: "Import Meld session…"
                            tip: "Make a new project file from the Meld session, check it against the host, then load it."
                            onTriggered: bar.windows.importer.show() }
                UMenuItem { objectName: "moreMenu:scenebuilder"; text: "New scene from a reference…"; visible: moreMenu.f["scene-builder"] === true; height: visible ? implicitHeight : 0
                            tip: "Build a new H + V scene from a picture or video in your stream assets folder. Your other scenes stay as they are."
                            onTriggered: bar.windows.sceneBuilder.show() }
                UMenuItem { objectName: "moreMenu:feedback"; text: "Feedback notes…"
                            tip: "Add a note to each feedback moment (feedback hotkey while streaming)."
                            onTriggered: bar.windows.feedback.show() }
                UMenuItem { objectName: "moreMenu:posts"; text: "Posts…"; visible: moreMenu.f["posting"] === true; height: visible ? implicitHeight : 0
                            tip: "Review clip packages. Nothing is uploaded until you click Upload."
                            onTriggered: bar.windows.posts.show() }
                UMenuItem { objectName: "moreMenu:growth"; text: "Growth numbers…"; visible: moreMenu.f["growth"] === true; height: visible ? implicitHeight : 0
                            tip: "Your own YouTube numbers for the videos Ujwalam posted. Read only."
                            onTriggered: bar.windows.growth.show() }
                UMenuItem { objectName: "moreMenu:report"; text: "Report a problem…"; visible: moreMenu.f["report-button"] === true; height: visible ? implicitHeight : 0
                            tip: "Opens a prefilled GitHub issue in your browser; you review it before submitting."
                            onTriggered: bar.windows.report.show() }
            }
        }
        // Help (the widget's ? button): how clips are made, how posting works, and the welcome tour.
        UButton {
            id: helpBtn
            objectName: "helpBtn"
            bare: dock.look === "dock"
            onHoveredChanged: if (hovered) dock.hoverBtn = helpBtn; else if (dock.hoverBtn === helpBtn) dock.hoverBtn = null
            text: "?"
            implicitWidth: 34
            leftPadding: 0
            rightPadding: 0
            tip: "Help: how clips are made, how posting works, and the welcome tour."
            onClicked: if (bar.guide) bar.guide.toggleHelp()
        }
        UButton {
            id: settingsBtn
            objectName: "settingsBtn"
            bare: dock.look === "dock"
            onHoveredChanged: if (hovered) dock.hoverBtn = settingsBtn; else if (dock.hoverBtn === settingsBtn) dock.hoverBtn = null
            text: "Settings"
            iconName: "gear"
            onClicked: bar.store.settingsWanted("")
        }
            }
        }
        // Clipping (D281): save the replay buffer now; mark a moment for the post-stream clipper. One click each (D332).
        UButton {
            objectName: "clipBtn"
            text: "Save clip"
            iconName: "clip"
            tip: "Save the last 60 seconds of H and V as clip files (replay buffer)."
            onClicked: bar.store.saveClip()
        }
        UButton {
            objectName: "markBtn"
            text: "Mark moment"
            iconName: "flag"
            tip: "Mark this moment for the clipper (same as the marker hotkey, Ctrl+Alt+Shift+M by default)."
            onClicked: bar.store.markMoment()
        }
        UButton {
            objectName: "recordBtn"
            text: bar.store.recording ? "Stop recording" : "Record"
            iconName: bar.store.recording ? "stop" : "record"
            kind: bar.store.recording ? "danger" : "normal"
            enabled: bar.store.canRecord && !bar.store.actionBusy
            tip: enabled ? (bar.store.recording ? "Stop recording." : "Start recording to a file.") : "No recording output is set up in this start."
            onClicked: bar.store.toggleRecord()
        }
        UButton {
            objectName: "streamBtn"
            text: bar.store.live ? "End stream" : "Go live"
            iconName: bar.store.live ? "stop" : "play"
            kind: bar.store.live ? "danger" : "primary"
            enabled: bar.store.canStream && !bar.store.actionBusy
            // Say why the button is off (D281): no stream target unless Ujwalam was started for live.
            tip: enabled ? (bar.store.live ? "Stop the stream." : "Go live.")
                         : "Streaming needs the LIVE start: the \"Ujwalam (alpha)\" shortcut (not the practice one), or Ujwalam.cmd --live."
            onClicked: bar.store.toggleStream()
        }
    }
}
