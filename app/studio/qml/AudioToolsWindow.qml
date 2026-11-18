// SPDX-License-Identifier: GPL-3.0-or-later
// A mixer strip's Tools (AU2, plan 2026-11-18-audio-mixer-music): noise suppression, noise gate, tone (3-band EQ), gain,
// compressor and limiter, the libobs audio filters on that sound. Each tool is a switch that says what it does, with its
// sliders always shown (greyed while off, so nothing moves). Every change is sent at once and heard at once, also on
// air; the host changes the filter in place and never restarts the sound. Presets ("Clean voice", "Loud room") come
// from data/audio-tools/presets.json and are offered here, never applied on their own. Ranges are the filters' own
// limits (services/project/audio-filters.mjs). Its own window (Popup.Window), so the native previews never cover it.
import QtQuick
import QtQuick.Controls.Basic
import Ujwalam.Core

Dialog {
    id: dlg
    objectName: "audioToolsBox"
    required property var store
    property string audio: ""
    property string name: ""
    property var ranges: ({})
    property var presets: []
    property var filters: ({})   // the strip's tools as saved: { kind: { on, ...values } }
    property string message: ""
    property bool busy: false
    popupType: studioHidden ? Popup.Item : Popup.Window
    modal: false
    anchors.centerIn: parent
    implicitWidth: 620
    implicitHeight: 680
    title: "Tools: " + name
    closePolicy: Popup.CloseOnEscape

    // Plain words for each tool and value (streamer-friendly: what the switch does, not the filter's name only).
    readonly property var spec: [
        { kind: "suppress", title: "Noise suppression", what: "Takes out steady background noise: fans, hum, hiss.", params: [] },
        { kind: "gate", title: "Noise gate", what: "Mutes the sound between words, while it is quieter than the open level.",
          params: [{ key: "openDb", label: "Opens above", unit: " dB" }, { key: "closeDb", label: "Closes below", unit: " dB" },
                   { key: "attackMs", label: "Opens in", unit: " ms" }, { key: "holdMs", label: "Stays open for", unit: " ms" },
                   { key: "releaseMs", label: "Closes over", unit: " ms" }] },
        { kind: "eq", title: "Tone (bass, middle, treble)", what: "Turns the low, middle and high sounds up or down.",
          params: [{ key: "lowDb", label: "Bass", unit: " dB" }, { key: "midDb", label: "Middle", unit: " dB" }, { key: "highDb", label: "Treble", unit: " dB" }] },
        { kind: "gain", title: "Gain", what: "Makes the sound louder or quieter before the tools below.",
          params: [{ key: "db", label: "Gain", unit: " dB" }] },
        { kind: "compressor", title: "Compressor", what: "Evens out loud and quiet parts: what goes above the threshold is turned down.",
          params: [{ key: "thresholdDb", label: "Threshold", unit: " dB" }, { key: "ratio", label: "Ratio", unit: " : 1" },
                   { key: "attackMs", label: "Reacts in", unit: " ms" }, { key: "releaseMs", label: "Lets go over", unit: " ms" },
                   { key: "outputGainDb", label: "Make-up gain", unit: " dB" }] },
        { kind: "limiter", title: "Limiter", what: "A hard ceiling: the sound never goes above it, so it never clips.",
          params: [{ key: "thresholdDb", label: "Ceiling", unit: " dB" }, { key: "releaseMs", label: "Lets go over", unit: " ms" }] }
    ]

    // info: the GET /ui/api/audio/tools answer.
    function ask(info, audioId, label) {
        audio = audioId;
        name = label;
        ranges = info.ranges || {};
        presets = info.presets || [];
        filters = (info.filters && info.filters[audioId]) ? JSON.parse(JSON.stringify(info.filters[audioId])) : {};
        message = "";
        busy = false;
        open();
    }
    function rangeOf(kind, key) { const r = (ranges[kind] || {})[key]; return r ? r : [0, 1, 0.1, null, 0] }
    // A tool as shown: the saved one, else its defaults (off).
    function toolOf(kind) {
        if (filters[kind]) return filters[kind];
        const t = { on: false };
        for (const k in (ranges[kind] || {})) t[k] = ranges[kind][k][4];
        return t;
    }
    function send(next, done) {
        if (busy) { message = "The last change is still on its way."; return; }
        busy = true;
        message = "";
        const before = filters;
        filters = next; // shown at once; set back when refused
        store.setAudioTools(audio, Object.keys(next).length ? next : null, (ok, why) => {
            busy = false;
            if (!ok) { filters = before; message = why; }
            else message = why;
            if (done) done(ok);
        });
    }
    function setTool(kind, patch) {
        const next = JSON.parse(JSON.stringify(filters));
        next[kind] = Object.assign(JSON.parse(JSON.stringify(toolOf(kind))), patch);
        // the gate closes at or below where it opens: moving one level past the other takes the other along
        const g = next[kind];
        if (kind === "gate" && g.closeDb > g.openDb) {
            if ("closeDb" in patch) g.openDb = g.closeDb; else g.closeDb = g.openDb;
        }
        send(next);
    }
    function usePreset(p) { send(JSON.parse(JSON.stringify(p.filters))) }
    function clearAll() { send({}) }

    // Probe (tests): tools-toggle:<kind>, tools-set:<kind>:<key>:<value>, tools-preset:<id>, tools-clear.
    function probeAction(a) {
        if (!opened) return false;
        if (a.startsWith("tools-toggle:")) { const k = a.slice(13); if (!spec.some(s => s.kind === k)) return false; setTool(k, { on: !toolOf(k).on }); return true }
        if (a.startsWith("tools-set:")) {
            const p = a.slice(10).split(":");
            if (p.length !== 3 || !(ranges[p[0]] || {})[p[1]]) return false;
            setTool(p[0], { [p[1]]: Number(p[2]) });
            return true;
        }
        if (a.startsWith("tools-preset:")) { const p = presets.find(x => x.id === a.slice(13)); if (!p) return false; usePreset(p); return true }
        if (a === "tools-clear") { clearAll(); return true }
        return false;
    }
    function probe() { return { open: opened, audio: audio, name: name, filters: filters, message: message, presets: presets.map(p => p.name), tools: spec.map(s => s.title) } }

    background: Rectangle {
        color: Theme.c.panel
        radius: Theme.radiusLarge
        border.width: 1
        border.color: Theme.c.border
    }
    header: Text {
        text: dlg.title
        padding: Theme.sp.l
        bottomPadding: Theme.sp.s
        elide: Text.ElideRight
        color: Theme.c.text
        font.family: Theme.ty.displayFamily
        font.pixelSize: Theme.ty.subtitle
        font.weight: Font.DemiBold
    }
    contentItem: Item {
        Text {
            id: about
            objectName: "audioToolsAbout"
            anchors { left: parent.left; right: parent.right; top: parent.top }
            height: 36 // one fixed height: a message never moves the tools
            text: dlg.message !== "" ? dlg.message : "Each change is heard at once, also on air. The tools run top to bottom."
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
            color: dlg.message !== "" ? Theme.c.danger : Theme.c.muted
            font.family: Theme.family
            font.pixelSize: Theme.ty.small
        }
        Row {
            id: presetRow
            anchors { left: parent.left; top: about.bottom; topMargin: Theme.sp.s }
            spacing: Theme.sp.s
            Repeater {
                model: dlg.presets
                delegate: UButton {
                    required property var modelData
                    objectName: "toolsPreset:" + modelData.id
                    text: "Use " + modelData.name
                    tip: modelData.text
                    enabled: !dlg.busy
                    onClicked: dlg.usePreset(modelData)
                }
            }
            UButton {
                objectName: "toolsClear"
                text: "All tools off"
                tip: "Takes every tool off this sound"
                enabled: !dlg.busy
                onClicked: dlg.clearAll()
            }
        }
        Flickable {
            anchors { left: parent.left; right: parent.right; top: presetRow.bottom; topMargin: Theme.sp.m; bottom: parent.bottom }
            clip: true
            contentHeight: col.height
            boundsBehavior: Flickable.StopAtBounds
            ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
            Column {
                id: col
                width: parent.width - 12
                spacing: Theme.sp.m
                Repeater {
                    model: dlg.spec
                    delegate: Rectangle {
                        id: card
                        required property var modelData
                        readonly property var tool: dlg.toolOf(modelData.kind)
                        objectName: "toolCard:" + modelData.kind
                        width: col.width
                        height: inner.height + 2 * Theme.sp.m
                        radius: Theme.radiusMedium
                        color: Theme.c.field
                        border.width: 1
                        border.color: tool.on ? Theme.c.accent : Theme.c.border
                        Column {
                            id: inner
                            x: Theme.sp.m
                            y: Theme.sp.m
                            width: card.width - 2 * Theme.sp.m
                            spacing: Theme.sp.s
                            USwitch {
                                objectName: "toolOn:" + card.modelData.kind
                                width: inner.width
                                text: card.modelData.title
                                hint: card.modelData.what
                                checked: card.tool.on === true
                                enabled: !dlg.busy
                                onClicked: dlg.setTool(card.modelData.kind, { on: checked })
                            }
                            Repeater {
                                model: card.modelData.params
                                delegate: UValueSlider {
                                    required property var modelData
                                    readonly property var r: dlg.rangeOf(card.modelData.kind, modelData.key)
                                    objectName: "toolValue:" + card.modelData.kind + ":" + modelData.key
                                    width: inner.width
                                    enabled: card.tool.on === true && !dlg.busy // shown while off: nothing moves
                                    from: r[0]
                                    to: r[1]
                                    stepSize: r[2]
                                    decimals: r[3] === "int" ? 0 : 1
                                    label: modelData.label
                                    unit: modelData.unit
                                    value: Number(card.tool[modelData.key])
                                    onCommitted: (v) => dlg.setTool(card.modelData.kind, { [modelData.key]: r[3] === "int" ? Math.round(v) : v })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    footer: Item {
        implicitHeight: 64
        UButton {
            anchors { right: parent.right; rightMargin: Theme.sp.l; verticalCenter: parent.verticalCenter }
            objectName: "audioToolsClose"
            text: "Close"
            onClicked: dlg.close()
        }
    }
}
