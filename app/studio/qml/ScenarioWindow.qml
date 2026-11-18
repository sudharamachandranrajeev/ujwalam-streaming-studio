// SPDX-License-Identifier: GPL-3.0-or-later
// Add scene > "From a scenario..." (D390): a grid of scenario cards (gameplay, lobby, screen or app share, starting
// soon, BRB, ending), each with a tiny drawing of the H and the V scene. Pick a card and the plan shows in plain words
// (a dry run: nothing written); "Add scene" adds it with one click (D332): one new scene on H and V, every existing
// scene, layer, device and setting unchanged. Screen share asks for a window (default) or a whole screen to show; with
// none picked the scene gets a place to fill in. Off air only. Server: scene-builder-routes.mjs (/ui/api/scene-templates).
// Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "scenarioDlg"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(640, parent ? parent.width - 40 : 640)
    implicitHeight: Math.min(690, parent ? parent.height - 40 : 690)
    title: "Add a scene for a scenario"
    closePolicy: Popup.CloseOnEscape

    property var templates: []     // [{ id, label, description, needsScreen, preview: { h, v } }]
    property string selected: ""
    property string kind: "window" // what a screen share shows: "window" | "screen"
    property var targets: ({ available: false, displays: [], windows: [] })
    property string targetId: ""
    property string info: ""
    property var words: []
    property string built: ""      // the planned scene's name ("" = nothing to add)
    property bool busy: false
    property int gen: 0

    readonly property var selectedCard: { for (let i = 0; i < templates.length; i++) if (templates[i].id === selected) return templates[i]; return null }
    readonly property bool needsScreen: selectedCard !== null && selectedCard.needsScreen === true
    readonly property var targetList: kind === "window"
        ? targets.windows.map(w => ({ value: w.id, text: (w.title !== "" ? w.title : w.id) + (w.exe !== "" ? "  (" + w.exe + ")" : "") }))
        : targets.displays.map(d => ({ value: d.id, text: d.name + (d.width && d.height ? "  (" + d.width + " x " + d.height + ")" : "") }))

    readonly property var errorWords: ({
        "live-locked": "Not while live: stop the stream first.",
        "host-unavailable": "The studio host is not running.",
        "no-project-file": "There is no project file to add the scene to.",
        "unknown-template": "That scenario is not available any more.",
        "unknown-target": "That window or screen is gone. Pick another.",
        "nothing-built": "Pick a scenario first.",
        "busy": "Still working on the last one.",
        "build-failed": "Could not plan that scene",
        "host-error": "The host did not take the scene"
    })
    function said(b, err) {
        const code = b && b.error ? String(b.error) : "";
        const w = errorWords[code] || String(err);
        return b && b.detail ? w + " (" + b.detail + ")." : w;
    }

    function show() {
        gen++;
        busy = false;
        selected = "";
        built = "";
        words = [];
        kind = "window";
        targetId = "";
        info = "Reading the scenarios...";
        open();
        const g = gen;
        Api.get("ui/api/scene-templates", (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) { info = said(r, err); return; }
            templates = r.templates || [];
            info = "Pick a scenario. Nothing changes until you press Add scene.";
        });
        Api.get("ui/api/scene-templates/targets", (ok, r) => {
            if (g !== gen || !ok) return;
            targets = { available: r.available === true, displays: r.displays || [], windows: r.windows || [] };
        });
        return true;
    }
    onClosed: gen++

    function pick(id) {
        if (busy || store.live) return false;
        if (!templates.some(t => t.id === id)) return false;
        selected = id;
        const first = targetList;
        targetId = first.length ? String(first[0].value) : "";
        plan();
        return true;
    }
    function setKind(k) {
        if (k !== "window" && k !== "screen") return false;
        kind = k;
        const list = targetList;
        targetId = list.length ? String(list[0].value) : "";
        if (selected !== "") plan();
        return true;
    }
    function setTarget(id) {
        if (!targetList.some(t => String(t.value) === id)) return false;
        targetId = id;
        plan();
        return true;
    }

    function plan() {
        if (busy || selected === "") return false;
        if (store.live) { info = errorWords["live-locked"]; return false; }
        busy = true;
        built = "";
        words = [];
        info = "Planning...";
        const body = { template: selected };
        if (needsScreen && targetId !== "") body.bind = { screen: { kind: kind, target: targetId } };
        const g = gen;
        Api.post("ui/api/scene-templates/build", body, (ok, r, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) { info = said(r, err); return; }
            built = String(r.name || "");
            words = r.words || [];
            info = "Here is what will be added. Nothing is written yet.";
        });
        return true;
    }

    function add() {
        if (busy || built === "") return false;
        if (store.live) { info = errorWords["live-locked"]; return false; }
        busy = true;
        const g = gen;
        Api.post("ui/api/scene-templates/apply", {}, (ok, r, err) => {
            busy = false;
            store.loadScenes();
            store.edit.loadEdits(); // a structure edit clears the undo history
            if (!ok) { if (g === gen) info = said(r, err); return; }
            const name = r.scene ? r.scene.name : built;
            store.say("Scene added: " + name + (r.saved ? "" : ". Not saved to the project file: the change is live only."));
            if (g === gen) { built = ""; words = []; selected = ""; info = "Added \"" + name + "\" (" + (r.layers || 0) + " layers). Pick another scenario to add more."; }
        });
        return true;
    }

    // ---- probe (tests): scn-open, scn-pick:<id>, scn-kind:<window|screen>, scn-target:<id>, scn-add, scn-close ----
    function probe() { return { open: opened, info: info, cards: templates.map(t => t.id), labels: templates.map(t => t.label), selected: selected,
                                needsScreen: needsScreen, kind: kind, targetsAvailable: targets.available, targetList: targetList.map(t => t.text), targetId: targetId,
                                words: words, built: built, busy: busy, canAdd: addBtn.enabled } }
    function probeAction(a) {
        if (a === "scn-open") return show();
        if (!opened) return false;
        if (a.startsWith("scn-pick:")) return pick(a.slice(9));
        if (a.startsWith("scn-kind:")) return setKind(a.slice(9));
        if (a.startsWith("scn-target:")) return setTarget(a.slice(11));
        if (a === "scn-add") { if (!addBtn.enabled) return false; addBtn.clicked(); return true }
        if (a === "scn-close") { close(); return true }
        return false;
    }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: 18
        bottomPadding: 6
        color: Theme.c.text
        font.family: Theme.family
        font.pixelSize: 18
        font.weight: Font.DemiBold
    }
    contentItem: Item {
        // the cards: a fixed grid, three to a row, so nothing moves when one is picked
        Flow {
            id: grid
            objectName: "scenarioGrid"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            spacing: 10
            readonly property real cardW: Math.floor((width - 2 * spacing) / 3)
            Repeater {
                model: dlg.templates
                delegate: Rectangle {
                    id: card
                    required property var modelData
                    objectName: "scenarioCard:" + modelData.id
                    width: grid.cardW
                    height: 150
                    radius: Theme.radiusSmall
                    color: Theme.c.field
                    border.width: dlg.selected === modelData.id ? 2 : 1
                    border.color: dlg.selected === modelData.id ? Theme.c.accentHi : cardHover.hovered ? Theme.c.muted : Theme.c.border
                    opacity: dlg.store.live ? Theme.st.disabled : 1
                    Accessible.role: Accessible.Button
                    Accessible.name: modelData.label
                    Accessible.description: modelData.description
                    function roleColor(role) {
                        if (role === "game" || role === "screen") return Theme.c.accent;
                        if (role === "camera") return Theme.c.accentHi;
                        if (role === "chat") return Theme.c.muted;
                        if (role === "graphics") return Theme.c.text;
                        return Theme.c.border;
                    }
                    Row {
                        id: drawings
                        anchors { top: parent.top; topMargin: 10; horizontalCenter: parent.horizontalCenter }
                        spacing: 12
                        // H: 16:9, V: 9:16, drawn from the template's own boxes
                        Rectangle {
                            width: 88; height: 50
                            color: Theme.c.panel; border.width: 1; border.color: Theme.c.border
                            Repeater {
                                model: card.modelData.preview.h
                                delegate: Rectangle {
                                    required property var modelData
                                    x: modelData.box.x * 88; y: modelData.box.y * 50
                                    width: Math.max(2, modelData.box.w * 88); height: Math.max(2, modelData.box.h * 50)
                                    color: card.roleColor(modelData.role)
                                    opacity: modelData.role === "game" || modelData.role === "screen" ? 0.55 : 0.9
                                    border.width: 1; border.color: Theme.c.panel
                                }
                            }
                        }
                        Rectangle {
                            width: 28; height: 50
                            color: Theme.c.panel; border.width: 1; border.color: Theme.c.border
                            Repeater {
                                model: card.modelData.preview.v
                                delegate: Rectangle {
                                    required property var modelData
                                    x: modelData.box.x * 28; y: modelData.box.y * 50
                                    width: Math.max(2, modelData.box.w * 28); height: Math.max(2, modelData.box.h * 50)
                                    color: card.roleColor(modelData.role)
                                    opacity: modelData.role === "game" || modelData.role === "screen" ? 0.55 : 0.9
                                    border.width: 1; border.color: Theme.c.panel
                                }
                            }
                        }
                    }
                    Text {
                        id: cardTitle
                        anchors { left: parent.left; right: parent.right; top: drawings.bottom; topMargin: 8; leftMargin: 10; rightMargin: 10 }
                        text: card.modelData.label
                        elide: Text.ElideRight
                        color: Theme.c.text
                        font.family: Theme.family
                        font.pixelSize: 14
                        font.weight: Font.DemiBold
                    }
                    Text {
                        anchors { left: parent.left; right: parent.right; top: cardTitle.bottom; topMargin: 2; bottom: parent.bottom; leftMargin: 10; rightMargin: 10; bottomMargin: 6 }
                        text: card.modelData.description
                        wrapMode: Text.Wrap
                        elide: Text.ElideRight
                        maximumLineCount: 3
                        color: Theme.c.muted
                        font.family: Theme.family
                        font.pixelSize: 11
                    }
                    HoverHandler { id: cardHover }
                    TapHandler { enabled: !dlg.busy && !dlg.store.live; onTapped: dlg.pick(card.modelData.id) }
                }
            }
        }
        // what a screen share shows: its row keeps its space when hidden, so the plan below never jumps
        Item {
            id: pickRow
            objectName: "scenarioPicker"
            anchors { left: parent.left; right: parent.right; top: grid.bottom; topMargin: 10 }
            height: 38
            Row {
                visible: dlg.needsScreen
                anchors.fill: parent
                spacing: 8
                UButton {
                    objectName: "scenarioKindWindow"
                    text: "A window"
                    kind: dlg.kind === "window" ? "primary" : "normal"
                    tip: "Show one app or window. This is the usual choice."
                    enabled: !dlg.busy && !dlg.store.live
                    onClicked: dlg.setKind("window")
                }
                UButton {
                    objectName: "scenarioKindScreen"
                    text: "Whole screen"
                    kind: dlg.kind === "screen" ? "primary" : "normal"
                    tip: "Show everything on one of your screens."
                    enabled: !dlg.busy && !dlg.store.live
                    onClicked: dlg.setKind("screen")
                }
                UCombo {
                    id: targetCombo
                    objectName: "scenarioTarget"
                    width: pickRow.width - 2 * 100 - 3 * 8 - 40
                    visible: dlg.targets.available && dlg.targetList.length > 0
                    model: dlg.targetList
                    enabled: !dlg.busy && !dlg.store.live
                    onChose: (v) => dlg.setTarget(String(v))
                    Connections {
                        target: dlg
                        function onTargetIdChanged() { targetCombo.pick(dlg.targetId) }
                        function onKindChanged() { targetCombo.pick(dlg.targetId) }
                    }
                }
                Text {
                    objectName: "scenarioNoTargets"
                    visible: !targetCombo.visible
                    anchors.verticalCenter: parent.verticalCenter
                    width: pickRow.width - 2 * 100 - 3 * 8 - 40
                    wrapMode: Text.Wrap
                    text: dlg.targets.available ? "Nothing to pick here right now. The scene gets a place to fill in."
                                                : "The list of windows and screens is not available yet. The scene gets a place to fill in."
                    color: Theme.c.muted
                    font.family: Theme.family
                    font.pixelSize: 12
                }
            }
        }
        Text {
            id: infoText
            objectName: "scenarioInfo"
            anchors { left: parent.left; right: parent.right; top: pickRow.bottom; topMargin: 6 }
            height: 20
            elide: Text.ElideRight
            text: dlg.info
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 13
        }
        ListView {
            objectName: "scenarioWords"
            anchors { left: parent.left; right: parent.right; top: infoText.bottom; topMargin: 4; bottom: parent.bottom }
            clip: true
            model: dlg.words
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Text {
                required property string modelData
                required property int index
                width: ListView.view.width
                topPadding: 2
                bottomPadding: 2
                wrapMode: Text.Wrap
                text: modelData
                color: index === 0 ? Theme.c.text : Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 12
                font.weight: index === 0 ? Font.DemiBold : Font.Normal
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Text {
            objectName: "scenarioLiveNote"
            anchors { left: parent.left; leftMargin: 18; verticalCenter: parent.verticalCenter }
            visible: dlg.store.live
            text: "Off air only."
            color: Theme.c.muted
            font.family: Theme.family
            font.pixelSize: 13
        }
        Row {
            anchors { right: parent.right; rightMargin: 18; verticalCenter: parent.verticalCenter }
            spacing: 10
            UButton {
                objectName: "scenarioClose"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                id: addBtn
                objectName: "scenarioAdd"
                text: "Add scene"
                kind: "primary"
                tip: "Adds the new scene on H and V. Your other scenes, layers, devices and settings stay as they are."
                enabled: !dlg.busy && dlg.built !== "" && !dlg.store.live
                onClicked: dlg.add()
            }
        }
    }
}
