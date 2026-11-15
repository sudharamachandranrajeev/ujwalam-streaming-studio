// SPDX-License-Identifier: GPL-3.0-or-later
// The Qt Quick studio window (D355, flag studio-qml; plan Q2): the on-air bar on top, scenes on the left, the H and V
// previews in the middle, layers on the right, the mixer below and a status line at the bottom. The frame uses anchors
// only, so it is placed in a window that is never shown too (hidden test mode: the previews embed there).
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
        s.more = bar.moreProbe();
        s.youtubeEvents = ytEventsDlg.probe();
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
        return s;
    }
    // Probe actions the C++ side does not know (settings-*): the same names as the widget studio's probe.
    function probeAction(action) {
        if (String(action).startsWith("settings-") || String(action).startsWith("stream-") || String(action).startsWith("tr-") || String(action).startsWith("ap-") || String(action).startsWith("int-") || String(action).startsWith("conn-")) return settingsDlg.probeAction(String(action));
        if (action === "yte-golive") { studioStore.toggleStream(); return true } // Go live as the button does (the button needs the LIVE start)
        if (String(action).startsWith("yte-")) return ytEventsDlg.probeAction(String(action));
        if (String(action).startsWith("palette-")) return cmdPalette.probeAction(String(action));
        if (String(action).startsWith("growth-")) return growthDlg.probeAction(String(action));
        if (String(action).startsWith("review-")) return reviewDlg.probeAction(String(action));
        if (String(action).startsWith("feedback-")) return feedbackDlg.probeAction(String(action));
        if (String(action).startsWith("report-")) return reportDlg.probeAction(String(action));
        if (String(action).startsWith("import-")) return importDlg.probeAction(String(action));
        if (String(action).startsWith("posts-")) return postsDlg.probeAction(String(action));
        if (String(action).startsWith("sb-")) return sceneBuilderDlg.probeAction(String(action));
        if (String(action).startsWith("volume-type:")) return mixer.probeAction(String(action));
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
        onSettingsWanted: (page) => settingsDlg.openAt(page)
        onYoutubeEventsWanted: ytEventsDlg.show()
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

    readonly property int pad: 10

    OnAirBar {
        id: bar
        objectName: "onAirBar"
        store: studioStore
        taskCenter: taskCenter
        guide: guide
        windows: ({ youtubeEvents: ytEventsDlg, growth: growthDlg, feedback: feedbackDlg, report: reportDlg, importer: importDlg, posts: postsDlg, review: reviewDlg, sceneBuilder: sceneBuilderDlg })
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
        anchors { left: parent.left; top: alerts.bottom; bottom: mixer.top; margins: win.pad }
        width: 240
    }

    LayersPanel {
        id: layers
        objectName: "layersPanel"
        store: studioStore
        anchors { right: parent.right; top: alerts.bottom; bottom: side.top; margins: win.pad }
        width: 300
    }

    // Under the layers (the widget's right column): the inspector, Look, Outputs (flag outputs-panel) and Bots (flag
    // bot-manager). It scrolls past 60% of the column, so the layer list always keeps room.
    Flickable {
        id: side
        objectName: "sideColumn"
        anchors { right: parent.right; bottom: stats.top; rightMargin: win.pad; bottomMargin: win.pad }
        width: 300
        height: Math.min(sideCol.implicitHeight, Math.max(0, (stats.y - alerts.y - alerts.height) * 0.6))
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
        anchors { right: parent.right; bottom: mixer.top; rightMargin: win.pad; bottomMargin: win.pad }
        width: 300
        height: implicitHeight
    }

    PreviewArea {
        id: previews
        objectName: "previewArea"
        store: studioStore
        anchors { left: scenes.right; right: layers.left; top: alerts.bottom; bottom: mixer.top; margins: win.pad; topMargin: win.pad + 4 }
    }

    MixerPanel {
        id: mixer
        objectName: "mixerPanel"
        store: studioStore
        anchors { left: parent.left; right: parent.right; bottom: statusLine.top; margins: win.pad; bottomMargin: 4 }
        height: 190
    }

    Item {
        id: statusLine
        objectName: "statusLine"
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom; leftMargin: win.pad + 6; rightMargin: win.pad + 6 }
        height: 28
        // The shared tooltip opens as its own window (Qt 6.8), so a preview never covers it.
        Component.onCompleted: ToolTip.toolTip.popupType = studioHidden ? Popup.Item : Popup.Window // hidden mode: nothing on screen
        Text {
            objectName: "note"
            anchors { left: parent.left; right: health.left; rightMargin: 16; verticalCenter: parent.verticalCenter }
            text: studioStore.note
            elide: Text.ElideRight
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
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
            font.pixelSize: 13
        }
    }

    ConfirmDialog { id: confirm; store: studioStore }
    AddLayerDialog { id: addLayerDlg; store: studioStore }
    AddSceneDialog { id: addSceneDlg; store: studioStore }
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
    YoutubeEventsDialog { id: ytEventsDlg; store: studioStore }
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
        anchors { left: parent.left; right: parent.right; top: parent.top }
        topY: bar.y + bar.height + 6
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
