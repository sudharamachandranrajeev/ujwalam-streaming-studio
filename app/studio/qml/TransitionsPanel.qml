// SPDX-License-Identifier: GPL-3.0-or-later
// The Transitions box (flag transitions, D242, D391, D394): per canvas (H and V) a cut, a fade, a slide, a swipe, a wipe, a
// colour fade or a stinger (a built-in one picked by name, or a video from the stream assets folder), each with its own
// fields and a duration. Saved into the project file; the UI server applies it to the host on the next status poll, off air
// and on air (D332: a click acts). A type the engine does not include is shown off, with the reason. Settings > Transitions
// holds the easings and the mirror. Every row is always there (a row that does not belong to the chosen type is switched
// off, not hidden), so the box never changes height when the type changes.
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
        wrapMode: Text.Wrap
    }
    component Note: Text {
        color: Theme.c.muted
        font.family: Theme.family
        font.pixelSize: Theme.ty.small
        wrapMode: Text.Wrap
    }

    property var info: ({})
    property string kind: "cut"
    readonly property var kinds: info.kinds || []
    readonly property var wipes: info.wipes || []
    readonly property var presets: info.stingers || []
    readonly property var swatches: [{ name: "Black", hex: "#000000" }, { name: "White", hex: "#ffffff" }, { name: "Magenta", hex: "#ff2bd6" }, { name: "Cyan", hex: "#18e0ff" }]
    readonly property var sidesText: ({ left: "Left", right: "Right", up: "Up", down: "Down" })
    readonly property bool usesMs: ["fade", "slide", "swipe", "wipe", "fadeColor"].indexOf(kind) >= 0
    readonly property bool isStinger: kind === "stinger"

    // The numeric limits come from the server (the project validator's table), never from a copy here. fallback: before the answer.
    function range(name, end, fallback) {
        const r = info.ranges && info.ranges[name];
        return Array.isArray(r) && typeof r[end] === "number" ? r[end] : fallback;
    }
    function kindInfo(id) { for (const k of kinds) if (k.id === id) return k; return ({ id: id, label: id, help: "", available: true }) }
    readonly property var cur: kindInfo(kind)

    // Read when the box comes on (the flag), and after each Apply.
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
    function stingerChoices() {
        const m = presets.map(p => ({ value: "preset:" + p.id, text: p.label + (p.default ? " (default)" : "") }));
        for (const v of (info.videos || [])) m.push({ value: "file:" + v, text: "Your video: " + v });
        return m;
    }
    // Shows the chosen canvas's saved transition in the form (every field, so a type picked next starts from what was saved or a plain default).
    function render() {
        const t = saved(canvasBox.value);
        kind = t.type || "cut";
        msBox.value = typeof t.durationMs === "number" && t.durationMs > 0 ? t.durationMs : (t.type === "fade" ? 500 : 600);
        pointBox.value = typeof t.pointMs === "number" ? t.pointMs : 0;
        audioBox.checked = t.audio !== false;
        const f = t.file && typeof t.file.rel === "string" ? t.file : null;
        if (f) {
            const m = /^transitions\/stingers\/([a-z0-9-]+)-[hv]\.webm$/.exec(f.rel);
            stingerBox.pick(f.base === "data" && m ? "preset:" + m[1] : "file:" + f.rel);
        } else {
            const d = presets.find(p => p.default === true) || presets[0];
            if (d) stingerBox.pick("preset:" + d.id);
        }
        dirBox.pick(t.direction || "left");
        swipeInBox.checked = t.swipeIn === true;
        if (!wipeBox.pick(t.pattern || "")) wipeBox.currentIndex = 0;
        softBox.value = typeof t.softness === "number" ? t.softness : 0.03;
        invertBox.checked = t.invert === true;
        colorBox.text = typeof t.color === "string" ? t.color : "#ff2bd6";
        pctBox.value = typeof t.pointPct === "number" ? t.pointPct : 50;
    }
    function setKind(id) {
        if (!kindInfo(id).available) return false;
        kind = id;
        return true;
    }
    readonly property bool builtIn: isStinger && String(stingerBox.value || "").indexOf("preset:") === 0
    // What Apply sends; null (with a plain note) when a field cannot be sent.
    function body() {
        const b = { canvas: canvasBox.value, type: kind };
        if (usesMs) b.durationMs = msBox.value;
        if (kind === "slide" || kind === "swipe") b.direction = dirBox.value;
        if (kind === "swipe") b.swipeIn = swipeInBox.checked;
        if (kind === "wipe") { b.pattern = wipeBox.value; b.softness = softBox.value; b.invert = invertBox.checked }
        if (kind === "fadeColor") {
            const c = colorBox.text.trim();
            if (!/^#[0-9a-fA-F]{6}$/.test(c)) { store.say("The colour needs six digits after the #, like #ff2bd6."); return null }
            b.color = c.toLowerCase();
            b.pointPct = pctBox.value;
        }
        if (isStinger) {
            const v = String(stingerBox.value || "");
            if (v === "") { store.say("Pick a stinger: a built-in one or a video from the stream assets folder."); return null }
            if (v.indexOf("preset:") === 0) b.preset = v.slice(7);
            else { b.file = v.slice(5); b.pointMs = pointBox.value }
            if (!audioBox.checked) b.audio = false;
        }
        return b;
    }
    function apply() {
        if (!cur.available) return store.say("Not done: " + cur.reason);
        const b = body();
        if (!b) return;
        Api.post("ui/api/project/transition", b, (ok, r, err) => {
            store.say(ok ? "Transition saved; the host follows within a few seconds." : "Not done: " + err);
            load();
        });
    }

    // ---- probe (tests): trbox-canvas:<h|v>, trbox-type:<id>, trbox-ms:<n>, trbox-stinger:<preset:id|file:rel>, trbox-file:<rel>,
    // trbox-point:<n>, trbox-audio:<on|off>, trbox-dir:<left|right|up|down>, trbox-swipein:<on|off>, trbox-pattern:<id>,
    // trbox-softness:<0-1>, trbox-invert:<on|off>, trbox-color:<#rrggbb>, trbox-pct:<n>, trbox-apply. Each acts as the
    // user would and is refused when that control is off.
    function probe() {
        return { shown: visible, enabled: form.enabled, canvas: canvasBox.value ?? "", type: kind,
                 ms: msBox.value, msOn: msBox.enabled, file: stingerBox.value ?? "", videos: (info.videos || []).length, stingers: presets.length,
                 point: pointBox.value, pointOn: pointBox.enabled, audio: audioBox.checked, stingerOn: stingerBox.enabled, available: info.available === true,
                 dir: dirBox.value ?? "", dirOn: dirBox.enabled, swipeIn: swipeInBox.checked, swipeInOn: swipeInBox.enabled,
                 pattern: wipeBox.value ?? "", patternOn: wipeBox.enabled, softness: softBox.value, softnessOn: softBox.enabled,
                 invert: invertBox.checked, invertOn: invertBox.enabled, color: colorBox.text, colorOn: colorBox.enabled, pct: pctBox.value,
                 pctOn: pctBox.enabled, help: helpText.text, reasons: reasonText.text,
                 kinds: kinds.map(k => ({ id: k.id, available: k.available === true, on: kind === k.id })), wipes: wipes.length,
                 wipesOff: wipes.filter(w => w.available !== true).length };
    }
    function probeAction(a) {
        const i = a.indexOf(":");
        const k = i > 0 ? a.slice(0, i) : a, v = i > 0 ? a.slice(i + 1) : "";
        if (!visible || !form.enabled) return false;
        const choose = (box, val) => { if (!box.enabled || !box.pick(val)) return false; box.chose(val); return true };
        const num = (box) => { const n = Number(v); if (!box.enabled || !Number.isInteger(n)) return false; box.value = n; return box.value === n };
        const sw = (box) => { if (!box.enabled || (v !== "on" && v !== "off")) return false; box.checked = v === "on"; return true };
        switch (k) {
        case "trbox-canvas": return choose(canvasBox, v) && true;
        case "trbox-type": { const ok = setKind(v); return ok }
        case "trbox-stinger": return choose(stingerBox, v);
        case "trbox-file": return choose(stingerBox, "file:" + v);
        case "trbox-ms": return num(msBox);
        case "trbox-point": return num(pointBox);
        case "trbox-audio": return sw(audioBox);
        case "trbox-dir": return choose(dirBox, v);
        case "trbox-swipein": return sw(swipeInBox);
        case "trbox-pattern": return choose(wipeBox, v);
        case "trbox-softness": { const n = Number(v); if (!softBox.enabled || !isFinite(n)) return false; softBox.commit(n); return true }
        case "trbox-invert": return sw(invertBox);
        case "trbox-color": if (!colorBox.enabled) return false; colorBox.text = v; return true;
        case "trbox-pct": { const n = Number(v); if (!pctBox.enabled || !isFinite(n)) return false; pctBox.commit(n); return true }
        case "trbox-apply": applyBtn.clicked(); return true;
        }
        return false;
    }

    Grid {
        id: form
        anchors { left: parent.left; right: parent.right; top: parent.top }
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
            model: [{ value: "h", text: "H (landscape)" }, { value: "v", text: "V (portrait)" }]
            onChose: panel.render()
        }

        FormLabel { text: "Type" }
        Flow {
            id: kindFlow
            width: form.fieldW
            spacing: 6
            Repeater {
                model: panel.kinds
                UToggle {
                    required property var modelData
                    objectName: "trKind:" + modelData.id
                    checkable: false
                    checked: panel.kind === modelData.id
                    enabled: modelData.available === true
                    text: modelData.label
                    tip: modelData.available === true ? modelData.help : (modelData.reason || "")
                    onClicked: panel.setKind(modelData.id)
                }
            }
        }
        // what the chosen type does, then why any type is switched off: two fixed-height lines, so nothing below moves
        Item { width: 90; height: 1 }
        Column {
            width: form.fieldW
            spacing: 2
            Note { id: helpText; objectName: "trHelp"; width: parent.width; height: Math.ceil(font.pixelSize * 1.3) * 3; text: panel.cur.help || ""; elide: Text.ElideRight; maximumLineCount: 3 }
            Note { id: reasonText; objectName: "trReasons"; width: parent.width; height: Math.ceil(font.pixelSize * 1.3) * 2; maximumLineCount: 2; elide: Text.ElideRight
                   text: panel.kinds.filter(k => k.available !== true).map(k => k.label + ": " + k.reason).join(" ") }
        }

        FormLabel { text: "Duration" }
        USpin {
            id: msBox
            objectName: "trBoxMs"
            label: "Duration"
            from: panel.range("durationMs", 0, 0)
            to: panel.range("durationMs", 1, 10000)
            stepSize: 50
            suffix: " ms"
            enabled: panel.usesMs
        }

        FormLabel { text: "Stinger" }
        UCombo {
            id: stingerBox
            objectName: "trBoxFile"
            label: "Stinger"
            width: form.fieldW
            enabled: panel.isStinger
            model: panel.stingerChoices()
        }
        FormLabel { text: "Switch at" }
        USpin {
            id: pointBox
            objectName: "trBoxPoint"
            label: "Switch at"
            from: panel.range("pointMs", 0, 0)
            to: panel.range("pointMs", 1, 10000)
            stepSize: 50
            suffix: " ms"
            enabled: panel.isStinger && !panel.builtIn
        }
        Item { width: 90; height: 1 }
        USwitch {
            id: audioBox
            objectName: "trBoxAudio"
            width: form.fieldW
            text: "Play the stinger's sound"
            hint: "A built-in stinger has no sound."
            checked: true
            enabled: panel.isStinger && !panel.builtIn
        }

        FormLabel { text: "Direction" }
        UCombo {
            id: dirBox
            objectName: "trBoxDir"
            label: "Direction"
            width: form.fieldW
            enabled: panel.kind === "slide" || panel.kind === "swipe"
            model: (panel.info.directions || ["left", "right", "up", "down"]).map(d => ({ value: d, text: "Moves " + (panel.sidesText[d] || d).toLowerCase() }))
        }
        Item { width: 90; height: 1 }
        USwitch {
            id: swipeInBox
            objectName: "trBoxSwipeIn"
            width: form.fieldW
            text: "Swipe in"
            hint: "On: the new scene swipes in over the old one. Off: the old scene swipes away."
            enabled: panel.kind === "swipe"
        }

        FormLabel { text: "Pattern" }
        UCombo {
            id: wipeBox
            objectName: "trBoxPattern"
            label: "Wipe pattern"
            width: form.fieldW
            enabled: panel.kind === "wipe"
            // a pattern the engine does not ship is not in the list (it could only be refused)
            model: panel.wipes.filter(w => w.available === true).map(w => ({ value: w.id, text: w.label }))
        }
        FormLabel { text: "Softness" }
        UValueSlider {
            id: softBox
            objectName: "trBoxSoftness"
            width: form.fieldW
            label: "Wipe softness"
            from: panel.range("softness", 0, 0)
            to: panel.range("softness", 1, 1)
            stepSize: 0.05
            decimals: 2
            enabled: panel.kind === "wipe"
            onCommitted: (v) => value = v
        }
        Item { width: 90; height: 1 }
        USwitch {
            id: invertBox
            objectName: "trBoxInvert"
            width: form.fieldW
            text: "Invert the pattern"
            hint: "On: the pattern plays the other way round."
            enabled: panel.kind === "wipe"
        }

        FormLabel { text: "Colour" }
        Row {
            width: form.fieldW
            spacing: 6
            enabled: panel.kind === "fadeColor"
            opacity: enabled ? 1 : Theme.st.disabled
            Rectangle {
                width: 36; height: 36; radius: Theme.radiusSmall
                color: /^#[0-9a-fA-F]{6}$/.test(colorBox.text) ? colorBox.text : "transparent"
                border.width: 1; border.color: Theme.c.border
            }
            UField {
                id: colorBox
                objectName: "trBoxColor"
                label: "Fade colour"
                width: 96
                maximumLength: 7
                text: "#ff2bd6"
                enabled: parent.enabled
            }
            Repeater {
                model: panel.swatches
                UToggle {
                    required property var modelData
                    objectName: "trSwatch:" + modelData.name
                    checkable: false
                    checked: colorBox.text.toLowerCase() === modelData.hex
                    text: modelData.name
                    tip: "Use " + modelData.hex
                    enabled: parent.enabled
                    onClicked: colorBox.text = modelData.hex
                }
            }
        }
        FormLabel { text: "Colour at" }
        UValueSlider {
            id: pctBox
            objectName: "trBoxPct"
            width: form.fieldW
            label: "Point of full colour"
            from: panel.range("pointPct", 0, 1)
            to: panel.range("pointPct", 1, 99)
            stepSize: 5
            decimals: 0
            unit: " %"
            enabled: panel.kind === "fadeColor"
            onCommitted: (v) => value = v
        }

        Item { width: 90; height: 1 }
        UButton {
            id: applyBtn
            objectName: "trBoxApply"
            text: "Apply transition"
            enabled: panel.cur.available !== false
            onClicked: panel.apply()
        }
    }
}
