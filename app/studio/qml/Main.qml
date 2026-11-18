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
        if (String(action).startsWith("inspector-")) return inspector.probeAction(String(action));
        if (String(action).startsWith("look:") || String(action).startsWith("look-") || String(action).startsWith("adv-")) return lookPanel.probeAction(String(action));
        if (String(action).startsWith("outputs-")) return outputsPanel.probeAction(String(action));
        if (String(action).startsWith("bots-")) return botsPanel.probeAction(String(action));
        if (String(action).startsWith("trbox-")) return transitionsPanel.probeAction(String(action));
        if (String(action).startsWith("guide-settings:")) return settingsDlg.guideProbe(String(action).slice(15));
        if (String(action).startsWith("guide-")) return guide.probeAction(String(action));
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
        onSettingsWanted: (page) => settingsDlg.openAt(page)
        onYoutubeEventsWanted: ytWin.show("presets")
        onGoLiveWanted: (options) => goLiveDlg.ask(options)
        onConnectionsWanted: (output) => settingsDlg.openConnections(output)
    }
    Connections {
        target: studioStore.edit
        function onRenameWanted(kind, id, current) { renameDlg.ask(kind, id, current) }
    }

    // Tasks still running and not live: ask first (the widget closeEvent): keep them in the tray, stop them, or keep the
    // window. Live: the window closes as before.
    onClosing: (close) => {
        if (!closeConfirmed && studioStore.activeTasks > 0 && !studioStore.live) {
            close.accepted = false;
            closeDlg.open();
            return;
        }
        if (Tray.active) Tray.end();
        Qt.callLater(Qt.quit); // a hidden test window is no "last visible window": quit explicitly (exit 0)
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
        guide: guide
        windows: ({ youtube: ytWin, growth: growthDlg, feedback: feedbackDlg, report: reportDlg, importer: importDlg, posts: postsDlg, review: reviewDlg, sceneBuilder: sceneBuilderDlg })
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
                  (studioStore.activeTasks > 0 ? "   ·   " + studioStore.activeTasks + (studioStore.activeTasks === 1 ? " task running" : " tasks running") : "")
            color: studioStore.uiUp && studioStore.hostUp ? Theme.c.muted : Theme.c.danger
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
    }

    ConfirmDialog { id: confirm; store: studioStore }
    AddLayerDialog { id: addLayerDlg; store: studioStore }
    AddSceneDialog { id: addSceneDlg; store: studioStore; onScenarioRequested: scenarioDlg.show() }
    ScenarioWindow { id: scenarioDlg; store: studioStore }
    AddAudioDialog { id: addAudioDlg; store: studioStore }
    NameDialog { id: renameDlg; store: studioStore }
    SettingsDialog {
        id: settingsDlg
        store: studioStore
        onGuideSaved: (part) => guide.takeChoices(part)
        onReplayTour: Qt.callLater(guide.replayWelcome) // the tour points at the main window: Settings closes first
    }
    CommandPalette { id: cmdPalette; store: studioStore; settings: settingsDlg; windows: ({ growth: growthDlg, review: reviewDlg, feedback: feedbackDlg, report: reportDlg, importer: importDlg, posts: postsDlg }) }
    GrowthWindow { id: growthDlg; store: studioStore }
    ReviewWindow { id: reviewDlg; store: studioStore }
    FeedbackWindow { id: feedbackDlg; store: studioStore }
    ReportDialog { id: reportDlg; store: studioStore }
    ImportWindow { id: importDlg; store: studioStore }
    SceneBuilderWindow { id: sceneBuilderDlg; store: studioStore }
    YoutubeWindow { id: ytWin; store: studioStore }
    GoLiveDialog { id: goLiveDlg; store: studioStore }
    PostsWindow { id: postsDlg; store: studioStore }
    ClipsAsk { id: clipsAskDlg; store: studioStore }
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
        onSettingsChanged: settingsDlg.guideFrom(guide)
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
