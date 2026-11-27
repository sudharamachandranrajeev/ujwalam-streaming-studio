// SPDX-License-Identifier: GPL-3.0-or-later
// The Qt Quick studio window (D355, flag studio-qml; plan Q2): the on-air bar on top; the left column with the scenes
// above and the layers below (the layers get the larger share, user feedback on alpha.33); the H and V previews in the
// middle; the right column with the side panels (inspector, Look, outputs, transitions, bots) above the stream stats;
// the mixer below and a status line at the bottom. The frame uses anchors only, so it is placed in a window that is
// never shown too (hidden test mode: the previews embed there).
// qml_studio.cpp calls start() once the window is placed, and probeState() for the tests' probe.
import QtQuick
import QtQuick.Controls.Basic
import QtQml.Models
import Ujwalam.Core

ApplicationWindow {
    id: win
    title: "Ujwalam Studio"
    width: 1600
    height: 900
    minimumWidth: 1100
    minimumHeight: 680
    color: Theme.c.bg
    font.family: Theme.family

    property bool closeConfirmed: false

    function start() { studioStore.start(); guide.start() }
    function probeState() {
        const s = studioStore.probeState();
        s.lazyMade = lazyMade(); // first: the reads below make every dialog
        s.settings = settingsDlg.ready ? settingsDlg.probe() : null;
        s.flagsInSettings = settingsDlg.opened;
        s.flags = studioStore.flagList.map(f => ({ id: f.id, on: f.on === true }));
        s.motionMode = Theme.motionMode();
        s.motion = Theme.motion;
        s.effects = Theme.effects();
        s.fx = Theme.fx; // RareUI slice 1 (D384): plain on air or in High performance, calm in reduced, else full
        s.rareui = Theme.rareui;
        s.buttonStyle = Theme.buttonStyle;
        s.spinnerStyle = Theme.spinnerStyle;
        s.tabsStyle = Theme.tabsStyle; // RareUI slice 2 (D384)
        const cols = {}; // what the QML items paint with
        for (const k in Theme.c) cols[k] = String(Theme.c[k]);
        s.themeColors = cols;
        s.themeDark = Theme.dark;
        s.themeFont = { family: Theme.family, installed: Qt.fontFamilies().indexOf(Theme.family) >= 0 };
        s.palette = cmdPalette.probe();
        s.growth = growthDlg.probe();
        s.review = reviewDlg.probe();
        s.feedback = feedbackDlg.probe();
        s.report = reportDlg.probe();
        s["import"] = importDlg.probe();
        s.posts = postsDlg.probe();
        s.sceneBuilder = sceneBuilderDlg.probe();
        s.scenarios = scenarioDlg.probe();
        s.more = bar.moreProbe();
        s.youtube = ytWin.probe();
        s.goLive = goLiveDlg.probe();
        s.clips = { text: studioStore.clipsText, tip: studioStore.clipsTip, asks: (studioStore.clips.asks || []).length, ask: clipsAskDlg.probe(),
                    reviewShown: studioStore.flags["learning-review"] === true && studioStore.reviewCount > 0, reviewCount: studioStore.reviewCount };
        s.alerts = alerts.probe();
        s.tasks = taskCenter.probe();
        s.schedule = scheduleCenter.probe();
        s.tray = Object.assign(Tray.probe(), { closeAsked: closeDlg.asked, closeChoice: closeDlg.choice, stay: trayFlow.stay });
        s.windowShown = win.visible;
        s.edit = studioStore.edit.probe();
        s.layerPanel = layers.probe();
        s.scenePanel = scenes.probe();
        s.windowKeys = studioStore.edit.windowKeys;
        s.inspector = inspector.probe();
        s.look = lookPanel.probe();
        s.outputsPanel = outputsPanel.probe();
        s.botsPanel = botsPanel.probe();
        s.transitionsBox = transitionsPanel.probe();
        s.guide = guide.probe();
        s.stats = stats.probe();
        s.addAudio = addAudioDlg.probe();
        s.audioTools = audioToolsDlg.probe();
        s.sceneMusic = sceneMusicDlg.probe();
        s.lookRef = lookRefDlg.made ? lookRefDlg.probe() : { open: false }; // RL5 (made on first use only)
        // The frame (alpha.33 layout): each panel's x, y, width, height in window pixels.
        const at = (it) => { const p = it.mapToItem(win.contentItem, 0, 0); return [Math.round(p.x), Math.round(p.y), Math.round(it.width), Math.round(it.height)] };
        s.frame = { scenes: at(scenes), layers: at(layers), side: at(side), stats: at(stats), previews: at(previews), mixer: at(mixer) };
        return s;
    }
    // Probe actions the C++ side does not know (settings-*): the same names as the widget studio's probe.
    function probeAction(action) {
        if (String(action).startsWith("settings-") || String(action).startsWith("stream-") || String(action).startsWith("tr-") || String(action).startsWith("ap-") || String(action).startsWith("int-") || String(action).startsWith("conn-")) return settingsDlg.probeAction(String(action));
        if (action === "yt-golive") { studioStore.toggleStream(); return true } // Go live as the button does (the button needs the LIVE start)
        if (String(action).startsWith("yt-")) return ytWin.probeAction(String(action));
        if (String(action).startsWith("gl-")) return goLiveDlg.probeAction(String(action));
        if (String(action).startsWith("palette-")) return cmdPalette.probeAction(String(action));
        if (String(action).startsWith("growth-")) return growthDlg.probeAction(String(action));
        if (String(action).startsWith("review-")) return reviewDlg.probeAction(String(action));
        if (String(action).startsWith("beatdrop-")) return beatdropDlg.probeAction(String(action));
        if (String(action).startsWith("feedback-")) return feedbackDlg.probeAction(String(action));
        if (String(action).startsWith("report-")) return reportDlg.probeAction(String(action));
        if (String(action).startsWith("import-")) return importDlg.probeAction(String(action));
        if (String(action).startsWith("posts-")) return postsDlg.probeAction(String(action));
        if (String(action).startsWith("sb-")) return sceneBuilderDlg.probeAction(String(action));
        if (action === "scn-from-add-scene") { addSceneDlg.ask(["h", "v"]); addSceneDlg.openScenarios(); return true }
        if (String(action).startsWith("scn-")) return scenarioDlg.probeAction(String(action));
        if (String(action).startsWith("volume-type:") || String(action).startsWith("mixer-")) return mixer.probeAction(String(action));
        if (action === "add-audio-open") { studioStore.openAddAudio(); return true }
        if (String(action).startsWith("add-audio-")) return addAudioDlg.probeAction(String(action));
        if (String(action).startsWith("tools-")) return audioToolsDlg.probeAction(String(action));
        if (action === "lookref-open") { studioStore.newLookFromReference(); return true } // RL5, as the menu entries do
        if (String(action).startsWith("scene-music-open:")) { studioStore.openSceneMusic(String(action).slice(17)); return true }
        if (String(action).startsWith("music-")) return sceneMusicDlg.probeAction(String(action));
        if (String(action).startsWith("inspector-")) return inspector.probeAction(String(action));
        if (String(action).startsWith("look:") || String(action).startsWith("look-") || String(action).startsWith("adv-")) return lookPanel.probeAction(String(action));
        if (String(action).startsWith("outputs-")) return outputsPanel.probeAction(String(action));
        if (String(action).startsWith("bots-")) return botsPanel.probeAction(String(action));
        if (String(action).startsWith("trbox-")) return transitionsPanel.probeAction(String(action));
        if (String(action).startsWith("guide-settings:")) return settingsDlg.guideProbe(String(action).slice(15));
        if (String(action).startsWith("guide-")) return guide.probeAction(String(action));
        if (action === "clips-open" || String(action).startsWith("clips:")) return bar.moreAction(String(action)); // the Clips menu (D433); before the clips- ask probe
        if (action === "clips-folder") { studioStore.openClipsFolder(); return true } // the My clips button
        if (action === "clips-review") { if (!bar.reviewShown) return false; reviewDlg.show(); return true } // Review reads (N) beside My clips
        if (String(action).startsWith("clips-")) return clipsAskDlg.probeAction(String(action));
        if (action === "more-open" || String(action).startsWith("more:")) return bar.moreAction(String(action));
        if (String(action).startsWith("scene-hotkey:")) return sceneKey(parseInt(String(action).slice(13), 10)); // Ctrl+N (D382); scene-key: is the scene list's F2 / Del
        // Live controls (Q4 A), the widget probe's names: close, close-choice:<tray|stop|cancel>, tray:<click|open|stop>, tasks:*.
        if (action === "close") { Qt.callLater(win.close); return true } // as the window's X; the question opens on the next turn
        if (String(action).startsWith("close-choice:")) return closeDlg.choose(String(action).slice(13));
        if (String(action).startsWith("tray:")) return trayFlow.probeAction(String(action));
        if (String(action).startsWith("tasks:")) return taskCenter.probeAction(String(action));
        if (String(action).startsWith("sched:")) return scheduleCenter.probeAction(String(action));
        // Editing (plan Q4): the layer and scene menus, their keys, reorder and the window keys (undo, redo, arrows).
        if (String(action).startsWith("select-layer:") || String(action).startsWith("layer-")) return layers.probeAction(String(action));
        if (String(action).startsWith("select-scene:") || String(action).startsWith("scene-")) return scenes.probeAction(String(action));
        if (String(action).startsWith("key:")) { // key:<keys>[:<times>]: presses made at once (they add up, as held arrow keys do)
            const p = String(action).slice(4).split(":");
            let done = false;
            for (let i = 0; i < (Number(p[1]) || 1); i++) done = studioStore.edit.windowKey(p[0]);
            return done;
        }
        return false;
    }

    // Scene keys (D382, flag scene-hotkeys): Ctrl+1..9 = the 1st..9th scene of the list, the same as a click on it.
    readonly property bool sceneKeysOn: studioStore.flags["scene-hotkeys"] === true
    function sceneKey(n) {
        if (!sceneKeysOn || !(n >= 1 && n <= 9) || n > studioStore.scenes.length) return false;
        studioStore.activateScene(studioStore.scenes[n - 1].id);
        return true;
    }

    Store {
        id: studioStore
        paused: win.visibility === Window.Minimized
        onConfirmNeeded: (pending) => confirm.ask(pending)
        onAddLayerReady: (sceneId, sceneName) => addLayerDlg.ask(sceneId, sceneName)
        onAddSceneReady: (canvases) => addSceneDlg.ask(canvases)
        onAddAudioReady: (choices) => addAudioDlg.ask(choices)
        onAudioToolsReady: (info, audio, name) => audioToolsDlg.ask(info, audio, name)
        onSceneMusicReady: (info, scene, mood) => sceneMusicDlg.ask(info, scene, mood)
        onSettingsWanted: (page) => settingsDlg.openAt(page)
        onYoutubeEventsWanted: ytWin.show("presets")
        onGoLiveWanted: (options) => goLiveDlg.ask(options)
        onConnectionsWanted: (output) => settingsDlg.openConnections(output)
        onLookFromReferenceWanted: lookRefDlg.show()
    }
    Connections {
        target: studioStore.edit
        function onRenameWanted(kind, id, current) { renameDlg.ask(kind, id, current) }
    }

    // Tasks still running and not live: ask first (the widget closeEvent): keep them in the tray, stop them, or keep the
    // window. Live: the window closes as before.
    onClosing: (close) => {
        if (closingText !== "") { close.accepted = false; return } // already closing: a second click changes nothing
        if (!closeConfirmed && studioStore.activeTasks > 0 && !studioStore.live) {
            close.accepted = false;
            closeDlg.open();
            return;
        }
        close.accepted = false; // the window stays up and says what happens until the studio has quit
        beginClose();
    }
    // Close feedback (2026-11-25, user report: after the X and the close question the window looked frozen, "can't tell
    // if closing, running or not responding"). The window first shows what closing does, waits until that picture is on
    // screen (one frame, at most 250 ms), then quits; it stays on screen while the studio ends, the launcher then stops
    // the tasks and the host (which saves a recording). Quit explicitly: a hidden test window is no "last visible window".
    property string closingText: ""
    property double closingAt: 0
    function closingWhat() {
        const n = studioStore.activeTasks;
        const parts = [];
        if (studioStore.live) parts.push("ending the stream");
        if (studioStore.recording) parts.push("saving the recording");
        if (n > 0) parts.push("stopping " + (n === 1 ? "1 task" : n + " tasks"));
        return parts.length ? parts.join(", ") : "closing the services";
    }
    function beginClose() {
        closingText = closingWhat();
        closingAt = Date.now();
        if (Tray.active) Tray.end();
        Api.log("studio closing: " + closingText);
        closeWait.start();
    }
    function quitNow(why) {
        if (closeWait.done) return;
        closeWait.done = true;
        closeWait.stop();
        Api.log("studio closing: shown after " + (Date.now() - closingAt) + " ms (" + why + "), quitting");
        Qt.quit();
    }
    Timer { // the picture did not come within 250 ms (a busy screen): quit anyway, closing comes first
        id: closeWait
        property bool done: false
        interval: 250
        onTriggered: win.quitNow("timeout")
    }
    Connections { // the first frame with the closing card is on screen
        target: win
        enabled: win.closingText !== "" && !closeWait.done
        function onFrameSwapped() { if (Date.now() > win.closingAt) Qt.callLater(win.quitNow, "frame") }
    }

    // Layout (D389 C2): one gap from the spacing scale, and column and mixer sizes that follow the window, so a small window
    // gives the previews the room and a large one gives the side panels more. The frame only reflows when the window is resized.
    // The left column is wider than the scenes alone needed, so layer names fit (alpha.33 feedback). In it the scenes take
    // about 38% of the height (never less than sceneMinH: a heading and two scene cards) and the layers the rest.
    readonly property int pad: Theme.sp.m
    readonly property int leftW: width >= 1800 ? 340 : width >= 1400 ? 300 : 260
    readonly property int sceneMinH: 150
    readonly property int leftColH: Math.max(0, mixer.y - win.pad - (alerts.y + alerts.height + win.pad))
    readonly property int scenesH: Math.min(Math.max(sceneMinH, Math.round(leftColH * 0.38)), Math.max(0, leftColH - win.pad - sceneMinH))
    readonly property int rightW: width >= 1800 ? 360 : width >= 1400 ? 320 : 280
    readonly property bool shortWindow: height < 800
    // Each strip has three rows (name and buttons, stream state or tracks, volume); the shortest mixer still fits them.
    readonly property int mixerH: height >= 1000 ? 232 : shortWindow ? 192 : 208

    OnAirBar {
        id: bar
        objectName: "onAirBar"
        store: studioStore
        taskCenter: taskCenter
        scheduleCenter: scheduleCenter
        guide: guide
        windows: ({ youtube: ytWin, growth: growthDlg, feedback: feedbackDlg, report: reportDlg, importer: importDlg, posts: postsDlg, review: reviewDlg, beatdrop: beatdropDlg, sceneBuilder: sceneBuilderDlg, fromRecording: fromRecordingDlg })
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: win.pad }
        height: 56
    }

    AlertStrip {
        id: alerts
        objectName: "alertBar"
        store: studioStore
        anchors { left: parent.left; right: parent.right; top: bar.bottom; leftMargin: win.pad; rightMargin: win.pad; topMargin: visible ? win.pad : 0 }
    }

    ScenesPanel {
        id: scenes
        objectName: "scenesPanel"
        store: studioStore
        anchors { left: parent.left; top: alerts.bottom; leftMargin: win.pad; topMargin: win.pad }
        width: win.leftW
        height: win.scenesH
    }

    // Under the scenes, down to the mixer: the larger share of the left column.
    LayersPanel {
        id: layers
        objectName: "layersPanel"
        store: studioStore
        anchors { left: parent.left; top: scenes.bottom; bottom: mixer.top; leftMargin: win.pad; topMargin: win.pad; bottomMargin: win.pad }
        width: win.leftW
    }

    // The right column, from the top down to the stats: the inspector, Look, Outputs (flag outputs-panel), Transitions and
    // Bots (flag bot-manager). It scrolls when they are taller than the column.
    Flickable {
        id: side
        objectName: "sideColumn"
        anchors { right: parent.right; top: alerts.bottom; rightMargin: win.pad; topMargin: win.pad }
        width: win.rightW
        height: Math.min(sideCol.implicitHeight, Math.max(0, stats.y - win.pad - y))
        contentHeight: sideCol.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
        Column {
            id: sideCol
            width: side.width
            spacing: win.pad
            InspectorPanel { id: inspector; store: studioStore; width: parent.width; height: implicitHeight }
            LookPanel { id: lookPanel; store: studioStore; width: parent.width; height: implicitHeight }
            OutputsPanel { id: outputsPanel; store: studioStore; width: parent.width; height: implicitHeight }
            TransitionsPanel { id: transitionsPanel; store: studioStore; width: parent.width; height: implicitHeight }
            BotsPanel { id: botsPanel; store: studioStore; width: parent.width; height: implicitHeight }
        }
    }

    // Stream stats (the widget's StatsCards, D287): session clock, FPS, GPU and CPU with their last 3 minutes; always in view.
    StatsPanel {
        id: stats
        store: studioStore
        compact: win.shortWindow
        anchors { right: parent.right; bottom: mixer.top; rightMargin: win.pad; bottomMargin: win.pad }
        width: win.rightW
        height: implicitHeight
    }

    PreviewArea {
        id: previews
        objectName: "previewArea"
        store: studioStore
        anchors { left: scenes.right; right: side.left; top: alerts.bottom; bottom: mixer.top; margins: win.pad }
    }

    MixerPanel {
        id: mixer
        objectName: "mixerPanel"
        store: studioStore
        anchors { left: parent.left; right: parent.right; bottom: statusLine.top; margins: win.pad; bottomMargin: Theme.sp.xs }
        height: win.mixerH
    }

    Item {
        id: statusLine
        objectName: "statusLine"
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom; leftMargin: win.pad + Theme.sp.s; rightMargin: win.pad + Theme.sp.s }
        height: 28
        // The shared tooltip opens as its own window (Qt 6.8), so a preview never covers it.
        Component.onCompleted: ToolTip.toolTip.popupType = studioHidden ? Popup.Item : Popup.Window // hidden mode: nothing on screen
        Text {
            objectName: "note"
            anchors { left: parent.left; right: health.left; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            // One line always: a note with several lines (the go-live check's warnings) is joined, never drawn upwards
            // over the mixer (alpha.33 feedback); the full note is in the tooltip.
            readonly property string full: studioStore.note
            text: full.split("\n").map(s => s.trim()).filter(s => s !== "").join("   ·   ")
            maximumLineCount: 1
            wrapMode: Text.NoWrap
            elide: Text.ElideRight
            ToolTip.visible: noteHover.hovered && truncated
            ToolTip.text: full
            HoverHandler { id: noteHover }
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Text {
            id: health
            objectName: "health"
            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
            // The UI server not answering is said as such, not as a host that stopped (the host may still be streaming).
            text: !studioStore.uiUp ? "UI server: not reachable (the host and your outputs may still be running)" :
                  (studioStore.fake ? "Host: test stand-in" : studioStore.hostUp ? "Host: running" : "Host: not running") +
                  "   ·   " + (studioStore.coreUp ? "Event core: running" : "Event core: not running") +
                  (studioStore.taskWords !== "" ? "   ·   " + studioStore.taskWords : "")
            color: studioStore.uiUp && studioStore.hostUp ? Theme.c.muted : Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }

    ConfirmDialog { id: confirm; store: studioStore }
    // Dialogs and windows not on screen at start are made on their first use (LazyDialog, start-up time 2026-11-19); the
    // calls on them are the same as before.
    LazyDialog { id: addLayerDlg; sourceComponent: Component { AddLayerDialog { store: studioStore } } }
    LazyDialog { id: addSceneDlg; sourceComponent: Component { AddSceneDialog { store: studioStore; onScenarioRequested: scenarioDlg.show() } } }
    LazyDialog { id: scenarioDlg; sourceComponent: Component { ScenarioWindow { store: studioStore } } }
    LazyDialog { id: addAudioDlg; sourceComponent: Component { AddAudioDialog { store: studioStore } } }
    LazyDialog { id: audioToolsDlg; sourceComponent: Component { AudioToolsWindow { store: studioStore } } }
    LazyDialog { id: sceneMusicDlg; sourceComponent: Component { SceneMusicWindow { store: studioStore } } }
    LazyDialog { id: renameDlg; sourceComponent: Component { NameDialog { store: studioStore } } }
    // The guide's choices reach Settings when they change; a Settings made later gets the last ones (guideSent).
    property bool guideSent: false
    function guideItem() { return guide }
    LazyDialog {
        id: settingsDlg
        sourceComponent: Component {
            SettingsDialog {
                store: studioStore
                // win.guideItem(): inside this component "guide" is the dialog's own property, not the Guide below.
                onGuideSaved: (part) => win.guideItem().takeChoices(part)
                onReplayTour: Qt.callLater(win.guideItem().replayWelcome) // the tour points at the main window: Settings closes first
            }
        }
        onLoaded: if (win.guideSent) item.guideFrom(guide)
    }
    LazyDialog { id: cmdPalette; sourceComponent: Component { CommandPalette { store: studioStore; settings: settingsDlg.get(); windows: ({ growth: growthDlg, review: reviewDlg, feedback: feedbackDlg, report: reportDlg, importer: importDlg, posts: postsDlg }) } } }
    LazyDialog { id: growthDlg; sourceComponent: Component { GrowthWindow { store: studioStore } } }
    LazyDialog { id: beatdropDlg; sourceComponent: Component { BeatDropWindow { store: studioStore } } }
    LazyDialog { id: reviewDlg; sourceComponent: Component { ReviewWindow { store: studioStore } } }
    LazyDialog { id: feedbackDlg; sourceComponent: Component { FeedbackWindow { store: studioStore } } }
    LazyDialog { id: reportDlg; sourceComponent: Component { ReportDialog { store: studioStore } } }
    LazyDialog { id: importDlg; sourceComponent: Component { ImportWindow { store: studioStore } } }
    LazyDialog { id: sceneBuilderDlg; sourceComponent: Component { SceneBuilderWindow { store: studioStore } } }
    LazyDialog { id: ytWin; sourceComponent: Component { YoutubeWindow { store: studioStore } } }
    LazyDialog { id: goLiveDlg; sourceComponent: Component { GoLiveDialog { store: studioStore } } }
    LazyDialog { id: postsDlg; sourceComponent: Component { PostsWindow { store: studioStore } } }
    LazyDialog { id: fromRecordingDlg; sourceComponent: Component { ClipsFromRecording { store: studioStore } } }
    LazyDialog { id: clipsAskDlg; sourceComponent: Component { ClipsAsk { store: studioStore } } }
    LazyDialog { id: lookRefDlg; sourceComponent: Component { LookReferenceDialog { store: studioStore } } } // RL5
    // Probe (tests): which of them were made before the probe was read (the probe itself makes them all).
    function lazyMade() {
        const all = { addLayer: addLayerDlg, addScene: addSceneDlg, scenario: scenarioDlg, addAudio: addAudioDlg, audioTools: audioToolsDlg,
                      sceneMusic: sceneMusicDlg, rename: renameDlg, settings: settingsDlg, palette: cmdPalette, growth: growthDlg, review: reviewDlg, beatdrop: beatdropDlg,
                      feedback: feedbackDlg, report: reportDlg, importer: importDlg, sceneBuilder: sceneBuilderDlg, youtube: ytWin, goLive: goLiveDlg,
                      posts: postsDlg, clipsAsk: clipsAskDlg, lookRef: lookRefDlg };
        return Object.keys(all).filter(k => all[k].made);
    }
    Connections {
        target: studioStore
        function onClipsAsk(ask) { clipsAskDlg.put(ask) }
    }
    Shortcut {
        sequence: "Ctrl+K"
        onActivated: cmdPalette.show()
    }
    Instantiator {
        model: 9
        delegate: Shortcut {
            required property int index
            sequence: "Ctrl+" + (index + 1)
            enabled: win.sceneKeysOn
            onActivated: win.sceneKey(index + 1)
        }
    }

    // Task panel and notifications (under the on-air bar, at the right) and the tray (Q4 A).
    TaskCenter {
        id: taskCenter
        objectName: "taskCenter"
        store: studioStore
        hold: goLiveDlg.opened
        anchors { left: parent.left; right: parent.right; top: parent.top }
        topY: bar.y + bar.height + Theme.sp.s
        windowHeight: win.height
    }
    // Scheduling manager (SM1-SM4): panel under the bar and its own window; reads the schedule only while open.
    ScheduleCenter {
        id: scheduleCenter
        objectName: "scheduleCenter"
        store: studioStore
        anchors { left: parent.left; right: parent.right; top: parent.top }
        topY: bar.y + bar.height + Theme.sp.s
        windowHeight: win.height
    }
    Connections {
        target: studioStore
        function onScheduleWanted() { scheduleCenter.openFromSettings() }
    }
    // A theme pack that changed on disk and was refused (LU2): the last good look stays, a notification says why.
    Connections {
        target: Theme
        function onRejected(title, why) { taskCenter.notice(title, why, true) }
    }
    TrayFlow { id: trayFlow; store: studioStore; window: win }
    // Undo, redo and the arrow-key nudge (plan Q4; one table in EditOps). A text box keeps its own Ctrl+Z and arrows.
    readonly property bool typing: !!win.activeFocusItem && win.activeFocusItem.cursorPosition !== undefined
    // Arrows (review of track B): a window Shortcut would take them from every slider, list and combo box. They nudge only
    // while preview editing is on and the focused item does not use arrows itself (a text box, slider, list or combo).
    readonly property bool arrowsFree: {
        const f = win.activeFocusItem;
        return studioStore.previewEditing === true && (!f || (f.cursorPosition === undefined && f.stepSize === undefined && f.currentIndex === undefined));
    }
    Instantiator {
        model: studioStore.edit.windowKeys
        delegate: Shortcut {
            required property string modelData
            sequence: modelData
            enabled: modelData.indexOf("Ctrl+") === 0 ? !win.typing : win.arrowsFree
            onActivated: studioStore.edit.windowKey(modelData)
        }
    }

    // Tips, tours and help (D294): over everything in the window, under the popups; the dimming lets clicks through.
    Guide {
        id: guide
        store: studioStore
        root: win.contentItem
        unseen: studioUnseen
        anchors.fill: parent
        z: 50
        onSettingsChanged: { win.guideSent = true; if (settingsDlg.item) settingsDlg.item.guideFrom(guide) }
    }

    // The closing card (see beginClose): over everything in the window, it takes every click so nothing starts while closing.
    Rectangle {
        objectName: "closingCard"
        visible: win.closingText !== ""
        anchors.fill: parent
        z: 1000
        color: Qt.rgba(0, 0, 0, 0.55)
        MouseArea { anchors.fill: parent; hoverEnabled: true; acceptedButtons: Qt.AllButtons; onWheel: (w) => w.accepted = true }
        Rectangle {
            anchors.centerIn: parent
            width: Math.min(parent.width - 2 * Theme.sp.l, 460)
            height: closingCol.implicitHeight + 2 * Theme.sp.l
            radius: Theme.radiusLarge
            color: Theme.c.panel
            border.color: Theme.c.border
            Column {
                id: closingCol
                anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: Theme.sp.l }
                spacing: Theme.sp.s
                Text {
                    width: parent.width
                    text: "Closing Ujwalam…"
                    color: Theme.c.text
                    font.family: Theme.ty.displayFamily
                    font.pixelSize: Theme.ty.title
                    font.weight: Font.DemiBold
                }
                Text {
                    objectName: "closingText"
                    width: parent.width
                    text: win.closingText.charAt(0).toUpperCase() + win.closingText.slice(1) + "."
                    wrapMode: Text.Wrap
                    color: Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.body
                }
                Text {
                    width: parent.width
                    text: "The window goes away by itself in a few seconds. Do not switch off the computer yet."
                    wrapMode: Text.Wrap
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: Theme.ty.small
                }
            }
        }
    }

    CloseDialog {
        id: closeDlg
        store: studioStore
        onKeepInTray: Qt.callLater(trayFlow.enter)
        onStopAndClose: {
            Api.log("studio close: stop tasks (" + studioStore.activeTasks + ")");
            win.closeConfirmed = true;
            win.close();
        }
    }
}
