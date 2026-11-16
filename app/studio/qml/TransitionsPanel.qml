// SPDX-License-Identifier: GPL-3.0-or-later
// The Transitions box (flag transitions, D242; the widget's TRANSITIONS box: loadTransitions, renderTransition,
// applyTransition): per canvas a cut, a fade with its length, or a stinger video from the stream assets folder with the
// moment the scene switches and whether its sound plays. Saved into the project file; the UI server applies it to the host
// on the next status poll. Settings > Transitions holds the easings and the mirror; a stinger is set only here. Nothing
// changes while live (the server refuses it too).
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

UPanel {
    id: panel
    objectName: "transitionsPanel"
    required property var store
    title: "Transitions"
    visible: store.flags["transitions"] === true
    implicitHeight: visible ? form.implicitHeight + 56 : 0

    component FormLabel: Text {
        width: 90
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
        elide: Text.ElideRight
    }

    property var info: ({})
    readonly property bool editable: !store.live

    // As the widget: read when the box comes on (the flag), and after each Apply.
    onVisibleChanged: if (visible) load()
    function load() {
        Api.get("ui/api/project/transitions", (ok, b, err) => {
            if (!ok) return store.say("Transitions unavailable: " + err);
            info = b;
            if (b.available !== true) store.say("Transitions need a loaded project file.");
            render();
        });
    }
    function saved(canvas) {
        for (const c of (info.canvases || [])) if (c.id === canvas) return c.transition || ({});
        return ({});
    }
    // Shows the chosen canvas's saved transition in the form.
    function render() {
        const t = saved(canvasBox.value);
        typeBox.pick(t.type || "cut");
        msBox.value = typeof t.durationMs === "number" ? t.durationMs : 0;
        pointBox.value = typeof t.pointMs === "number" ? t.pointMs : 0;
        audioBox.checked = t.audio !== false;
        const rel = t.file && typeof t.file.rel === "string" ? t.file.rel : "";
        if (rel !== "") fileBox.pick(rel);
    }
    function apply() {
        if (store.live) return store.say("Live: transitions cannot be changed.");
        const type = typeBox.value;
        const b = { canvas: canvasBox.value, type: type };
        if (type === "fade") b.durationMs = msBox.value;
        if (type === "stinger") {
            if (!fileBox.value) return store.say("A stinger needs a video from the stream assets folder.");
            b.file = fileBox.value;
            b.pointMs = pointBox.value;
            if (!audioBox.checked) b.audio = false;
        }
        Api.post("ui/api/project/transition", b, (ok, r, err) => {
            store.say(ok ? "Transition saved; the host follows within a few seconds." : "Not done: " + err);
            load();
        });
    }

    // ---- probe (tests): trbox-canvas:<h|v>, trbox-type:<cut|fade|stinger>, trbox-ms:<n>, trbox-file:<rel>,
    // trbox-point:<n>, trbox-audio:<on|off>, trbox-apply. Each acts as the user would and is refused when that control is off.
    function probe() {
        return { shown: visible, enabled: form.enabled, canvas: canvasBox.value ?? "", type: typeBox.value ?? "",
                 ms: msBox.value, msOn: msBox.enabled, file: fileBox.value ?? "", videos: (info.videos || []).length,
                 point: pointBox.value, audio: audioBox.checked, stingerOn: fileBox.enabled, available: info.available === true };
    }
    function probeAction(a) {
        const i = a.indexOf(":");
        const k = i > 0 ? a.slice(0, i) : a, v = i > 0 ? a.slice(i + 1) : "";
        if (!visible || !form.enabled) return false;
        const choose = (box, val) => { if (!box.enabled || !box.pick(val)) return false; box.chose(val); return true };
        const num = (box) => { const n = Number(v); if (!box.enabled || !Number.isInteger(n)) return false; box.value = n; return box.value === n };
        switch (k) {
        case "trbox-canvas": return choose(canvasBox, v);
        case "trbox-type": return choose(typeBox, v);
        case "trbox-file": return choose(fileBox, v);
        case "trbox-ms": return num(msBox);
        case "trbox-point": return num(pointBox);
        case "trbox-audio": if (!audioBox.enabled || (v !== "on" && v !== "off")) return false; audioBox.checked = v === "on"; return true;
        case "trbox-apply": applyBtn.clicked(); return true;
        }
        return false;
    }

    Grid {
        id: form
        anchors { left: parent.left; right: parent.right; top: parent.top }
        enabled: panel.editable
        columns: 2
        columnSpacing: 10
        rowSpacing: 6
        verticalItemAlignment: Grid.AlignVCenter
        readonly property real fieldW: Math.max(120, width - 90 - columnSpacing)

        FormLabel { text: "Canvas" }
        UCombo {
            id: canvasBox
            objectName: "trBoxCanvas"
            label: "Canvas"
            width: form.fieldW
            model: [{ value: "h", text: "H" }, { value: "v", text: "V" }]
            onChose: panel.render()
        }
        FormLabel { text: "Type" }
        UCombo {
            id: typeBox
            objectName: "trBoxType"
            label: "Type"
            width: form.fieldW
            model: [{ value: "cut", text: "cut" }, { value: "fade", text: "fade" }, { value: "stinger", text: "stinger" }]
        }
        FormLabel { text: "Duration" }
        USpin {
            id: msBox
            objectName: "trBoxMs"
            label: "Duration"
            from: 0
            to: 10000
            suffix: " ms"
            enabled: typeBox.value === "fade"
        }
        FormLabel { text: "Video" }
        UCombo {
            id: fileBox
            objectName: "trBoxFile"
            label: "Video"
            width: form.fieldW
            enabled: typeBox.value === "stinger"
            model: (panel.info.videos || []).map(x => ({ value: x, text: x }))
        }
        FormLabel { text: "Switch at" }
        USpin {
            id: pointBox
            objectName: "trBoxPoint"
            label: "Switch at"
            from: 0
            to: 10000
            suffix: " ms"
            enabled: typeBox.value === "stinger"
        }
        Item { width: 90; height: 1 }
        USwitch {
            id: audioBox
            objectName: "trBoxAudio"
            width: form.fieldW
            text: "Play the video's sound"
            checked: true
            enabled: typeBox.value === "stinger"
        }
        Item { width: 90; height: 1 }
        UButton {
            id: applyBtn
            objectName: "trBoxApply"
            text: "Apply transition"
            onClicked: panel.apply()
        }
    }
}
