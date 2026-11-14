// SPDX-License-Identifier: GPL-3.0-or-later
// Command palette (plan Q4): Ctrl+K opens a search box over every studio command: switch to a scene, go live or end the
// stream, start or stop recording, add a scene or a layer, open a Settings page. Type to filter, Up/Down to pick, Enter
// runs it, Escape closes. Each command calls the same Store function its button calls, so the same rules apply (a live
// change still asks through the confirm window). Its own window (Popup.Window), above the native previews.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Popup {
    id: pal
    objectName: "paletteBox"
    required property var store
    required property var settings     // the Settings dialog: its pages are commands too
    property var windows: ({})         // the More menu windows: {growth: GrowthWindow, ...}, each with show()
    // Hidden test mode (never on screen): drawn inside the never-shown window, not as a window of its own.
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: true
    x: parent ? Math.round((parent.width - width) / 2) : 0
    y: parent ? Math.round(parent.height * 0.12) : 0
    width: Math.min(560, parent ? parent.width - 40 : 560)
    padding: 12
    closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside

    property string query: ""
    property int index: 0

    // Every command: {text, words, run}. Built when the palette opens, so it shows the scenes and state of that moment.
    property var all: []
    function build() {
        const list = [];
        const s = store;
        const keys = s.flags["scene-hotkeys"] === true; // D382: Ctrl+1..9 for the first nine scenes
        (s.scenes || []).forEach((sc, i) =>
            list.push({ text: "Switch to scene: " + sc.name + (sc.id === s.activeScene ? " (on now)" : "") + (keys && i < 9 ? "   Ctrl+" + (i + 1) : ""),
                        words: "scene switch go to " + sc.name, run: () => s.activateScene(sc.id) }));
        list.push({ text: s.live ? "End the stream" : "Go live", words: "stream live start stop end broadcast", run: () => s.toggleStream() });
        list.push({ text: s.recording ? "Stop recording" : "Start recording", words: "record recording start stop", run: () => s.toggleRecord() });
        list.push({ text: "Add a scene", words: "new scene add create", run: () => s.addScene() });
        if (s.activeScene !== "")
            list.push({ text: "Add a layer to this scene", words: "new layer add source image video text browser", run: () => s.addLayer(s.activeScene) });
        if (s.flags["growth"] === true && windows.growth)
            list.push({ text: "Growth numbers", words: "growth youtube numbers views likes statistics analytics", run: () => windows.growth.show() });
        if (s.flags["learning-review"] === true && windows.review)
            list.push({ text: "Review reads", words: "review reads confirm correct unsure ocr banner mode learning", run: () => windows.review.show() });
        for (const g of settings.groups)
            for (const p of g.pages)
                list.push({ text: "Settings: " + p, words: "settings options preferences " + p + " " + (settings.pageWords[p] || ""),
                            run: () => s.settingsWanted(p) });
        all = list;
    }
    // Every typed word must be found in the command's words or its text (any order, any case).
    readonly property var shown: {
        const words = query.toLowerCase().split(/\s+/).filter(w => w !== "");
        return all.filter(c => {
            const hay = (c.text + " " + c.words).toLowerCase();
            return words.every(w => hay.includes(w));
        });
    }
    onShownChanged: index = 0

    function show() {
        if (opened) return true;
        build();
        query = "";
        field.text = "";
        index = 0;
        open();
        field.forceActiveFocus();
        return true;
    }
    function move(d) {
        if (shown.length === 0) return;
        index = (index + d + shown.length) % shown.length;
        list.positionViewAtIndex(index, ListView.Contain);
    }
    function runAt(i) {
        if (i < 0 || i >= shown.length) return false;
        const c = shown[i];
        close();
        c.run();
        return true;
    }

    // ---- probe (tests): palette-open, palette-type:<text>, palette-down, palette-up, palette-run, palette-close ----
    function probe() { return { open: opened, query: query, index: index, items: shown.map(c => c.text) } }
    function probeAction(a) {
        if (a === "palette-open") return show();
        if (!opened) return false;
        if (a.startsWith("palette-type:")) { field.text = decodeURIComponent(a.slice(13)); return true }
        if (a === "palette-down") { move(1); return shown.length > 0 }
        if (a === "palette-up") { move(-1); return shown.length > 0 }
        if (a === "palette-run") return runAt(index);
        if (a === "palette-close") { close(); return true }
        return false;
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    contentItem: Column {
        spacing: 8
        UField {
            id: field
            objectName: "paletteSearch"
            width: parent.width
            label: "Search commands"
            placeholderText: "Type a command or a scene name"
            onTextChanged: pal.query = text
            onAccepted: pal.runAt(pal.index)
            Keys.onDownPressed: pal.move(1)
            Keys.onUpPressed: pal.move(-1)
        }
        ListView {
            id: list
            objectName: "paletteList"
            width: parent.width
            height: Math.min(contentHeight, 360)
            clip: true
            model: pal.shown
            currentIndex: pal.index
            boundsBehavior: Flickable.StopAtBounds
            delegate: Rectangle {
                id: row
                required property var modelData
                required property int index
                objectName: "paletteItem:" + index
                width: ListView.view.width
                height: 34
                radius: Theme.radiusSmall
                color: index === pal.index ? Theme.c.accent : hover.hovered ? Theme.c.field : "transparent"
                property string text: modelData.text
                Text {
                    anchors { left: parent.left; right: parent.right; leftMargin: 10; rightMargin: 10; verticalCenter: parent.verticalCenter }
                    text: row.modelData.text
                    elide: Text.ElideRight
                    color: row.index === pal.index ? Theme.c.onAccent : Theme.c.text
                    font.family: Theme.family
                    font.pixelSize: 14
                }
                HoverHandler { id: hover }
                TapHandler { onTapped: pal.runAt(row.index) }
            }
        }
        Text {
            objectName: "paletteEmpty"
            visible: pal.shown.length === 0
            text: "No command matches \"" + pal.query + "\"."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
    }
}
