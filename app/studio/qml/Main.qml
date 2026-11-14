// SPDX-License-Identifier: GPL-3.0-or-later
// The Qt Quick studio window (D355, flag studio-qml; plan Q2): the on-air bar on top, scenes on the left, the H and V
// previews in the middle, layers on the right, the mixer below and a status line at the bottom. The frame uses anchors
// only, so it is placed in a window that is never shown too (hidden test mode: the previews embed there).
// qml_studio.cpp calls start() once the window is placed, and probeState() for the tests' probe.
import QtQuick
import QtQuick.Controls.Basic
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

    function start() { studioStore.start() }
    function probeState() {
        const s = studioStore.probeState();
        s.settings = settingsDlg.ready ? settingsDlg.probe() : null;
        s.flagsInSettings = settingsDlg.opened;
        s.flags = studioStore.flagList.map(f => ({ id: f.id, on: f.on === true }));
        s.motionMode = Theme.motionMode();
        s.motion = Theme.motion;
        s.effects = Theme.effects();
        const cols = {}; // what the QML items paint with
        for (const k in Theme.c) cols[k] = String(Theme.c[k]);
        s.themeColors = cols;
        s.themeDark = Theme.dark;
        s.themeFont = { family: Theme.family, installed: Qt.fontFamilies().indexOf(Theme.family) >= 0 };
        s.palette = cmdPalette.probe();
        s.growth = growthDlg.probe();
        s.review = reviewDlg.probe();
        s.alerts = alerts.probe();
        s.tasks = taskCenter.probe();
        s.tray = Object.assign(Tray.probe(), { closeAsked: closeDlg.asked, closeChoice: closeDlg.choice, stay: trayFlow.stay });
        s.windowShown = win.visible;
        return s;
    }
    // Probe actions the C++ side does not know (settings-*): the same names as the widget studio's probe.
    function probeAction(action) {
        if (String(action).startsWith("settings-") || String(action).startsWith("stream-") || String(action).startsWith("tr-") || String(action).startsWith("ap-") || String(action).startsWith("int-") || String(action).startsWith("conn-")) return settingsDlg.probeAction(String(action));
        if (String(action).startsWith("palette-")) return cmdPalette.probeAction(String(action));
        if (String(action).startsWith("growth-")) return growthDlg.probeAction(String(action));
        if (String(action).startsWith("review-")) return reviewDlg.probeAction(String(action));
        if (String(action).startsWith("scene-key:")) return sceneKey(parseInt(String(action).slice(10), 10));
        // Live controls (Q4 A), the widget probe's names: close, close-choice:<tray|stop|cancel>, tray:<click|open|stop>, tasks:*.
        if (action === "close") { Qt.callLater(win.close); return true } // as the window's X; the question opens on the next turn
        if (String(action).startsWith("close-choice:")) return closeDlg.choose(String(action).slice(13));
        if (String(action).startsWith("tray:")) return trayFlow.probeAction(String(action));
        if (String(action).startsWith("tasks:")) return taskCenter.probeAction(String(action));
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
        anchors { right: parent.right; top: alerts.bottom; bottom: mixer.top; margins: win.pad }
        width: 300
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
            text: (studioStore.fake ? "Host: test stand-in" : studioStore.hostUp ? "Host: running" : "Host: not running") +
                  "   ·   " + (studioStore.coreUp ? "Event core: running" : "Event core: not running") +
                  (studioStore.activeTasks > 0 ? "   ·   " + studioStore.activeTasks + (studioStore.activeTasks === 1 ? " task running" : " tasks running") : "")
            color: studioStore.hostUp ? Theme.c.muted : Theme.c.danger
            font.family: Theme.family
            font.pixelSize: 13
        }
    }

    ConfirmDialog { id: confirm; store: studioStore }
    AddLayerDialog { id: addLayerDlg; store: studioStore }
    AddSceneDialog { id: addSceneDlg; store: studioStore }
    SettingsDialog { id: settingsDlg; store: studioStore }
    CommandPalette { id: cmdPalette; store: studioStore; settings: settingsDlg; windows: ({ growth: growthDlg, review: reviewDlg }) }
    GrowthWindow { id: growthDlg; store: studioStore }
    ReviewWindow { id: reviewDlg; store: studioStore }
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
    TrayFlow { id: trayFlow; store: studioStore; window: win }

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
