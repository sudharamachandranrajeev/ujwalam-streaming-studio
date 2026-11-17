// SPDX-License-Identifier: GPL-3.0-or-later
// New scene from a reference (plan Q4 row G, SB1-SB3, flag scene-builder): pick a picture or video from the stream
// assets folder, Build reads it and shows the new scene in plain words (a dry run: nothing written), "Add this scene"
// adds it with one click (D332): one new scene on H and V, every existing scene, layer, device and setting unchanged.
// Off air only. Server: services/studio-ui/scene-builder-routes.mjs. Its own window (Popup.Window).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "sceneBuilderDlg"
    required property var store
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: Math.min(620, parent ? parent.width - 40 : 620)
    implicitHeight: Math.min(520, parent ? parent.height - 40 : 520)
    title: "New scene from a reference"
    closePolicy: Popup.CloseOnEscape

    property var refs: []          // [{ value: rel, text }]
    property string info: ""
    property var words: []         // the built plan in plain words
    property string built: ""      // the built scene's name ("" = nothing to add)
    property bool busy: false
    property int gen: 0

    readonly property var errorWords: ({
        "live-locked": "Not while live: stop the stream first.",
        "host-unavailable": "The studio host is not running.",
        "no-project-file": "There is no project file to add the scene to.",
        "unknown-reference": "That file is no longer in the stream assets folder.",
        "nothing-built": "Build a scene first.",
        "busy": "Still working on the last one.",
        "build-failed": "Could not build a scene from that file",
        "host-error": "The host did not take the scene",
        "scene-builder-off": "The scene builder is off (Settings > Features)."
    })
    function said(b, err) {
        const code = b && b.error ? String(b.error) : "";
        const w = errorWords[code] || String(err);
        return b && b.detail ? w + " (" + b.detail + ")." : w;
    }

    function show() {
        gen++;
        busy = false;
        built = "";
        words = [];
        refs = [];
        info = "Reading the stream assets folder...";
        open();
        const g = gen;
        Api.get("ui/api/scene-builder", (ok, r, err) => {
            if (g !== gen) return;
            if (!ok) { info = said(r, err); return; }
            if (!r.available) { info = errorWords["no-project-file"]; return; }
            refs = (r.references || []).map(a => ({ value: a.rel, text: a.rel + (a.kind === "media" ? " (video)" : "") }));
            info = refs.length ? "Pick a picture or video of a layout you like, then press Build. Nothing changes until you press Add this scene."
                               : "No pictures or videos in the stream assets folder yet.";
        });
        return true;
    }
    onClosed: gen++

    function build() {
        if (busy || refCombo.value === undefined || refCombo.value === "") return false;
        if (store.live) { info = errorWords["live-locked"]; return false; }
        busy = true;
        built = "";
        words = [];
        info = "Reading " + refCombo.value + "...";
        const g = gen;
        Api.post("ui/api/scene-builder/build", { file: String(refCombo.value) }, (ok, r, err) => {
            if (g !== gen) return;
            busy = false;
            if (!ok) { info = said(r, err); return; }
            built = String(r.name || "");
            words = (r.words || []).concat((r.notes || []).map(n => "From the reference: " + n));
            info = "Dry run: nothing written yet.";
        });
        return true;
    }

    function add() {
        if (busy || built === "") return false;
        if (store.live) { info = errorWords["live-locked"]; return false; }
        busy = true;
        const g = gen;
        Api.post("ui/api/scene-builder/apply", {}, (ok, r, err) => {
            busy = false;
            store.loadScenes();
            store.edit.loadEdits(); // a structure edit clears the undo history
            if (!ok) { if (g === gen) info = said(r, err); return; }
            const name = r.scene ? r.scene.name : built;
            store.say("Scene added: " + name + (r.saved ? "" : ". Not saved to the project file: the change is live only."));
            if (g === gen) { built = ""; words = []; info = "Added \"" + name + "\" (" + (r.layers || 0) + " layers)."; }
        });
        return true;
    }

    // ---- probe (tests): sb-open, sb-pick:<rel>, sb-build, sb-add, sb-close ----
    function probe() { return { open: opened, info: info, refs: refs.map(r => r.value), words: words, built: built, busy: busy,
                                canAdd: addBtn.enabled, canBuild: buildBtn.enabled } }
    function probeAction(a) {
        if (a === "sb-open") return show();
        if (!opened) return false;
        if (a.startsWith("sb-pick:")) { const v = a.slice(8); if (!refs.some(r => r.value === v)) return false; refCombo.pick(v); return true }
        if (a === "sb-build") { if (!buildBtn.enabled) return false; buildBtn.clicked(); return true }
        if (a === "sb-add") { if (!addBtn.enabled) return false; addBtn.clicked(); return true }
        if (a === "sb-close") { close(); return true }
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
        Row {
            id: pickRow
            anchors { left: parent.left; right: parent.right; top: parent.top }
            spacing: 10
            UCombo {
                id: refCombo
                objectName: "sbRef"
                width: pickRow.width - buildBtn.width - pickRow.spacing
                model: dlg.refs
                enabled: !dlg.busy && dlg.refs.length > 0
                onChose: { dlg.built = ""; dlg.words = [] }
            }
            UButton {
                id: buildBtn
                objectName: "sbBuild"
                text: "Build"
                tip: "Read the file and show the new scene. Nothing is written."
                enabled: !dlg.busy && dlg.refs.length > 0 && !dlg.store.live
                onClicked: dlg.build()
            }
        }
        Text {
            id: infoText
            objectName: "sbInfo"
            anchors { left: parent.left; right: parent.right; top: pickRow.bottom; topMargin: 10 }
            text: dlg.info
            wrapMode: Text.Wrap
            color: Theme.c.text
            font.family: Theme.family
            font.pixelSize: 14
        }
        ListView {
            objectName: "sbWords"
            anchors { left: parent.left; right: parent.right; top: infoText.bottom; topMargin: 8; bottom: parent.bottom }
            clip: true
            model: dlg.words
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar {}
            delegate: Text {
                required property string modelData
                required property int index
                width: ListView.view.width
                topPadding: 3
                bottomPadding: 3
                wrapMode: Text.Wrap
                text: modelData
                color: index === 0 ? Theme.c.text : Theme.c.muted
                font.family: Theme.family
                font.pixelSize: 13
                font.weight: index === 0 ? Font.DemiBold : Font.Normal
            }
        }
    }
    footer: Item {
        implicitHeight: 60
        Text {
            objectName: "sbLiveNote"
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
                objectName: "sbClose"
                text: "Close"
                onClicked: dlg.close()
            }
            UButton {
                id: addBtn
                objectName: "sbAdd"
                text: "Add this scene"
                kind: "primary"
                tip: "Adds the new scene on H and V. Your other scenes, layers, devices and settings stay as they are."
                enabled: !dlg.busy && dlg.built !== "" && !dlg.store.live
                onClicked: dlg.add()
            }
        }
    }
}
